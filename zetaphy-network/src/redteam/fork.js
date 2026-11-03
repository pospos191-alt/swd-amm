// The red team's local fork (docs/future/red-team.md): every attack runs HERE, never on a live chain.
//
// Two backends with one interface ("a world"):
//   - createFork({ source, … }): an in-memory EVM (EthereumJS, the EVM the contract tests use) whose state is read
//     lazily from a source at one block and never written back: a JSON-RPC endpoint (rpcSource: eth_getCode /
//     eth_getStorageAt / eth_getBalance / eth_getTransactionCount at the fork block, read only) or any object with
//     the same four reads (the tests fork their in-memory chain). Every write stays in this process. Snapshots
//     nest (snapshot / revert), so a search tries thousands of sequences on one fork.
//   - anvilWorld({ url }): a local anvil (127.0.0.1 / localhost only) the caller started with --fork-url; the same
//     calls through anvil_impersonateAccount / evm_snapshot / anvil_setBalance.
// Safety: a source must be a TESTNET (TESTNET_CHAIN_IDS) or a local chain; anything else is refused before the
// first read. Nothing here signs or broadcasts a transaction.
import { keccak256, getAddress } from 'ethers';

/** ZETAPHY testnet, anvil / hardhat local chains. Nothing else may be forked (never mainnet, never real money). */
export const TESTNET_CHAIN_IDS = Object.freeze([77390, 31337, 1337]);
export const TX_GAS = 30_000_000n;
const EMPTY_CODE_HASH = keccak256('0x');
const hex = (v) => '0x' + BigInt(v).toString(16);
const lower = (a) => getAddress(a).toLowerCase();

export function checkTestnet(chainId) {
  const id = Number(chainId);
  if (!TESTNET_CHAIN_IDS.includes(id)) throw new Error(`chain ${chainId} is not a testnet the red team may fork (allowed: ${TESTNET_CHAIN_IDS.join(', ')}); it never touches mainnet or real money`);
  return id;
}

let lib = null;
/** EthereumJS (dev dependencies of zetaphy-network: `npm i` with dev deps). */
export async function loadEvmLib() {
  if (lib) return lib;
  try {
    const [{ EVM }, { Common, Chain, Hardfork }, util] = await Promise.all([import('@ethereumjs/evm'), import('@ethereumjs/common'), import('@ethereumjs/util')]);
    lib = { EVM, Common, Chain, Hardfork, ...util };
    return lib;
  } catch {
    throw new Error('the EthereumJS EVM is not installed: run `npm i` (with dev dependencies) in zetaphy-network');
  }
}

// ------------------------------------------------------------------------------------------- sources

/** A source with nothing in it (a fresh local chain: deploy everything yourself). */
export const emptySource = (chainId = 31337, blockNumber = 0, timestamp = 1_800_000_000) => ({
  chainId, blockNumber, timestamp,
  getBalance: async () => '0x0', getNonce: async () => '0x0', getCode: async () => '0x', getStorage: async () => '0x0',
});

/** Read-only JSON-RPC source at one block. Refuses a chain that is not a testnet. */
export async function rpcSource(url, { block = 'latest', fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  let n = 0;
  const send = async (method, params = []) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }), signal: ctl.signal });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } finally { clearTimeout(t); }
  };
  const chainId = checkTestnet(BigInt(await send('eth_chainId')));
  const b = await send('eth_getBlockByNumber', [block === 'latest' ? 'latest' : hex(block), false]);
  if (!b) throw new Error(`block ${block} not found`);
  const tag = b.number;
  return {
    chainId, blockNumber: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)),
    getBalance: (a) => send('eth_getBalance', [a, tag]),
    getNonce: (a) => send('eth_getTransactionCount', [a, tag]),
    getCode: (a) => send('eth_getCode', [a, tag]),
    getStorage: (a, slot) => send('eth_getStorageAt', [a, slot, tag]),
  };
}

// ------------------------------------------------------------------------------------------- the lazy, journaled state

/**
 * A state manager for the EthereumJS EVM: reads fall through to the source (once, cached), writes go to a local
 * overlay with a journal, so checkpoint / commit / revert nest exactly (the EVM's own sub-call reverts included).
 */
class ForkState {
  constructor(L, source, common) {
    this.L = L;
    this.source = source;
    this.common = common;
    this.origin = { acct: new Map(), storage: new Map() }; // what the source said (never changes)
    this.local = { acct: new Map(), code: new Map(), storage: new Map(), cleared: new Map() };
    this.journal = [];
    this.marks = [];
    const self = this;
    this.originalStorageCache = {
      map: new Map(),
      async get(address, key) {
        const k = `${address.toString()}:${L.bytesToHex(key)}`;
        if (!this.map.has(k)) this.map.set(k, await self.getContractStorage(address, key));
        return this.map.get(k);
      },
      put() {}, clear() { this.map.clear(); },
    };
  }

  _set(kind, key, value) {
    const m = this.local[kind];
    this.journal.push([kind, key, m.has(key), m.get(key)]);
    m.set(key, value);
  }

  async _origin(addr) {
    let o = this.origin.acct.get(addr);
    if (!o) {
      const [bal, nonce, code] = await Promise.all([this.source.getBalance(addr), this.source.getNonce(addr), this.source.getCode(addr)]);
      o = { balance: BigInt(bal ?? 0), nonce: BigInt(nonce ?? 0), code: this.L.hexToBytes(code && code !== '0x' ? code : '0x') };
      this.origin.acct.set(addr, o);
    }
    return o;
  }

  async getAccount(address) {
    const a = address.toString();
    if (this.local.acct.has(a)) {
      const v = this.local.acct.get(a);
      return v ? this.L.Account.fromRlpSerializedAccount(v) : undefined;
    }
    const o = await this._origin(a);
    if (o.balance === 0n && o.nonce === 0n && o.code.length === 0) return undefined;
    return this.L.Account.fromAccountData({ balance: o.balance, nonce: o.nonce, codeHash: this.L.hexToBytes(keccak256(o.code)) });
  }
  async putAccount(address, account) { this._set('acct', address.toString(), account ? account.serialize() : null); }
  async deleteAccount(address) {
    const a = address.toString();
    this._set('acct', a, null);
    this._set('code', a, new Uint8Array(0));
    this._set('cleared', a, true);
  }
  async modifyAccountFields(address, f) {
    const acc = (await this.getAccount(address)) ?? new this.L.Account();
    acc.nonce = f.nonce ?? acc.nonce;
    acc.balance = f.balance ?? acc.balance;
    acc.storageRoot = f.storageRoot ?? acc.storageRoot;
    acc.codeHash = f.codeHash ?? acc.codeHash;
    await this.putAccount(address, acc);
  }
  async accountExists(address) { return (await this.getAccount(address)) !== undefined; }
  async getContractCode(address) {
    const a = address.toString();
    if (this.local.code.has(a)) return this.local.code.get(a);
    return (await this._origin(a)).code;
  }
  async getContractCodeSize(address) { return (await this.getContractCode(address)).length; }
  async putContractCode(address, value) {
    const a = address.toString();
    this._set('code', a, value);
    const acc = (await this.getAccount(address)) ?? new this.L.Account();
    acc.codeHash = this.L.hexToBytes(keccak256(value));
    await this.putAccount(address, acc);
  }
  async getContractStorage(address, key) {
    const a = address.toString();
    const k = `${a}:${this.L.bytesToHex(key)}`;
    if (this.local.storage.has(k)) return this.local.storage.get(k);
    if (this.local.cleared.get(a)) return new Uint8Array(0);
    if (!this.origin.storage.has(k)) {
      const v = BigInt((await this.source.getStorage(a, this.L.bytesToHex(key))) ?? 0);
      this.origin.storage.set(k, v === 0n ? new Uint8Array(0) : this.L.bigIntToBytes(v));
    }
    return this.origin.storage.get(k);
  }
  async putContractStorage(address, key, value) {
    const v = this.L.unpadBytes(value);
    this._set('storage', `${address.toString()}:${this.L.bytesToHex(key)}`, v);
  }
  async clearContractStorage(address) {
    const a = address.toString();
    this._set('cleared', a, true);
    for (const k of [...this.local.storage.keys()]) if (k.startsWith(`${a}:`)) this._set('storage', k, new Uint8Array(0));
  }
  async checkpoint() { this.marks.push(this.journal.length); }
  async commit() { this.marks.pop(); }
  async revert() {
    const to = this.marks.pop() ?? 0;
    while (this.journal.length > to) {
      const [kind, key, had, prev] = this.journal.pop();
      if (had) this.local[kind].set(key, prev); else this.local[kind].delete(key);
    }
  }
  async flush() {}
  async getStateRoot() { return new Uint8Array(32); }
  async setStateRoot() {}
  async hasStateRoot() { return true; }
  getAppliedKey(address) { return this.L.hexToBytes(keccak256(address)); }
  shallowCopy() { return this; }
  clearCaches() {}
  async dumpStorage() { return {}; }
}

/**
 * An in-memory fork. `source` is read lazily at its block; `block` is the environment every transaction runs in
 * (default: the block after the source's, 12 s later).
 */
export async function createFork({ source = emptySource(), block } = {}) {
  const L = await loadEvmLib();
  const chainId = checkTestnet(source.chainId);
  const common = L.Common.custom({ chainId, networkId: chainId, name: `fork-${chainId}` }, { baseChain: L.Chain.Mainnet, hardfork: L.Hardfork.Cancun });
  const state = new ForkState(L, source, common);
  const evm = await L.EVM.create({ common, stateManager: state });
  const env = { number: BigInt(block?.number ?? BigInt(source.blockNumber) + 1n), timestamp: BigInt(block?.timestamp ?? BigInt(source.timestamp) + 12n) };
  const blk = () => ({ header: { number: env.number, timestamp: env.timestamp, coinbase: L.Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32),
    gasLimit: TX_GAS, baseFeePerGas: 0n, cliqueSigner: () => L.Address.zero(), getBlobGasPrice: () => 0n } });
  const A = (a) => L.Address.fromString(lower(a));
  let tracer = null;
  evm.events.on('step', (ev, next) => { try { tracer?.(ev); } finally { next?.(); } });

  const world = {
    kind: 'memory',
    chainId,
    forkBlock: Number(source.blockNumber),
    env,
    /** A transaction from any address (a local fork needs no key): { ok, returnHex, logs, created, gas }. */
    async tx(from, to, data = '0x', value = 0n) {
      state.originalStorageCache.clear();
      const r = await evm.runCall({ caller: A(from), origin: A(from), to: to ? A(to) : undefined, data: L.hexToBytes(data), value: BigInt(value), gasLimit: TX_GAS, block: blk() });
      const err = r.execResult.exceptionError;
      return {
        ok: !err,
        returnHex: L.bytesToHex(r.execResult.returnValue),
        logs: err ? [] : (r.execResult.logs ?? []).map(([address, topics, d]) => ({ address: L.bytesToHex(address), topics: topics.map(L.bytesToHex), data: L.bytesToHex(d) })),
        created: !err && r.createdAddress ? lower(r.createdAddress.toString()) : null,
        gas: r.execResult.executionGasUsed,
      };
    },
    /** eth_call: the state change is thrown away. Returns 0x… or null on revert. */
    async call(to, data, from = '0x000000000000000000000000000000000000c0de') {
      await state.checkpoint();
      try {
        const r = await evm.runCall({ caller: A(from), to: A(to), data: L.hexToBytes(data), gasLimit: TX_GAS, block: blk() });
        return r.execResult.exceptionError ? null : L.bytesToHex(r.execResult.returnValue);
      } finally { await state.revert(); }
    },
    async balance(a) { return (await state.getAccount(A(a)))?.balance ?? 0n; },
    async nonce(a) { return (await state.getAccount(A(a)))?.nonce ?? 0n; },
    async code(a) { return L.bytesToHex(await state.getContractCode(A(a))); },
    async codeHash(a) { const c = await state.getContractCode(A(a)); return c.length ? keccak256(c) : EMPTY_CODE_HASH; },
    async storage(a, slot) { return L.bytesToHex(await state.getContractStorage(A(a), L.setLengthLeft(L.bigIntToBytes(BigInt(slot)), 32))); },
    async setBalance(a, wei) { await state.modifyAccountFields(A(a), { balance: BigInt(wei) }); },
    /** Deploys raw init code from `from`: the new address (throws when it reverts). */
    async deploy(from, initcode, value = 0n) {
      const r = await world.tx(from, null, initcode, value);
      if (!r.ok || !r.created) throw new Error('deploy failed');
      return r.created;
    },
    /** Moves to a later block (`blocks` blocks, `seconds` later): every following transaction runs there. */
    advance(seconds = 12, blocks = 1) { env.number += BigInt(blocks); env.timestamp += BigInt(seconds); },
    async snapshot() { await state.checkpoint(); return state.marks.length; },
    async revert(id) { while (state.marks.length >= id) await state.revert(); },
    /** Calls `fn(stepEvent)` on every EVM step while `body` runs (reentrancy and call-graph detectors). */
    async traced(fn, body) { tracer = fn; try { return await body(); } finally { tracer = null; } },
    async stop() {},
  };
  return world;
}

// ------------------------------------------------------------------------------------------- anvil

/** A world on a LOCAL anvil the caller started (anvil --fork-url <testnet rpc> --fork-block-number N). */
export async function anvilWorld({ url = 'http://127.0.0.1:8545', fetchImpl = globalThis.fetch } = {}) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('the red team only drives a LOCAL anvil (127.0.0.1 / localhost)');
  let n = 0;
  const send = async (method, params = []) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpc: j.error });
    return j.result;
  };
  const chainId = checkTestnet(BigInt(await send('eth_chainId')));
  const head = await send('eth_getBlockByNumber', ['latest', false]);
  const world = {
    kind: 'anvil',
    chainId,
    forkBlock: Number(BigInt(head.number)),
    env: { number: BigInt(head.number) + 1n, timestamp: BigInt(head.timestamp) + 12n },
    async tx(from, to, data = '0x', value = 0n) {
      const f = lower(from);
      await send('anvil_impersonateAccount', [f]);
      try {
        const tx = { from: f, data, value: hex(value), gas: hex(TX_GAS), gasPrice: '0x0' };
        if (to) tx.to = lower(to);
        let h;
        try { h = await send('eth_sendTransaction', [tx]); } catch (e) { return { ok: false, returnHex: '0x', logs: [], created: null, gas: 0n, error: e.message }; }
        await send('evm_mine');
        const rc = await send('eth_getTransactionReceipt', [h]);
        const ok = BigInt(rc.status) === 1n;
        return { ok, returnHex: '0x', logs: ok ? rc.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })) : [],
          created: ok && rc.contractAddress ? rc.contractAddress.toLowerCase() : null, gas: BigInt(rc.gasUsed) };
      } finally { await send('anvil_stopImpersonatingAccount', [f]); }
    },
    async call(to, data, from = '0x000000000000000000000000000000000000c0de') {
      try { return await send('eth_call', [{ from, to, data }, 'latest']); } catch { return null; }
    },
    balance: async (a) => BigInt(await send('eth_getBalance', [lower(a), 'latest'])),
    nonce: async (a) => BigInt(await send('eth_getTransactionCount', [lower(a), 'latest'])),
    code: (a) => send('eth_getCode', [lower(a), 'latest']),
    async codeHash(a) { return keccak256(await world.code(a)); },
    storage: (a, slot) => send('eth_getStorageAt', [lower(a), hex(slot), 'latest']),
    setBalance: (a, wei) => send('anvil_setBalance', [lower(a), hex(wei)]),
    async deploy(from, initcode, value = 0n) {
      const r = await world.tx(from, null, initcode, value);
      if (!r.ok || !r.created) throw new Error('deploy failed');
      return r.created;
    },
    snapshot: () => send('evm_snapshot'),
    async revert(id) { if (!(await send('evm_revert', [id]))) throw new Error('anvil refused to revert'); },
    async traced(_fn, body) { return body(); },
    async stop() {},
  };
  // gas costs nothing on the fork (every world runs with base fee 0, like the in-memory one)
  await send('anvil_setNextBlockBaseFeePerGas', ['0x0']).catch(() => {});
  return world;
}
