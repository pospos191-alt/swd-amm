// The mock multi-chain: in-memory EVM-shaped, Solana-shaped and Cosmos-shaped chains that answer the same
// `send(method, params)` the sentinels use against free public endpoints (rpc.js). Public RPCs are often blocked
// from CI and sandboxes, so every detector, sentinel and the end-to-end simulation run on this (and on fixtures
// recorded from it or from a live endpoint: rpc.js recordingRpc / fixtureRpc). Nothing here pretends to execute
// EVM code: a block is a list of transactions with the receipts (logs) a node would return for them.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { TOPICS, FLASH_TOPICS } from './detectors.js';
import { toHex } from './evidence.js';

const hexN = (n) => '0x' + BigInt(n).toString(16);
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const t32 = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const lower = (a) => String(a ?? '').toLowerCase();
const FLASH_BY_NAME = Object.fromEntries(Object.entries(FLASH_TOPICS).map(([t, n]) => [n, t]));

/** Deterministic 20-byte address from a label (mock accounts: never a real key). */
export const mockAddress = (label) => toHex(keccak_256(new TextEncoder().encode(`immune.mock.${label}`))).slice(0, 42);
const mockHash = (label) => toHex(keccak_256(new TextEncoder().encode(`immune.mock.tx.${label}`)));

// ---------------------------------------------------------------- log builders (what a node returns)

export const log = {
  transfer: (token, from, to, value) => ({ address: lower(token), topics: [TOPICS.transfer, t32(from), t32(to)], data: '0x' + w(value) }),
  approval: (token, owner, spender, value) => ({ address: lower(token), topics: [TOPICS.approval, t32(owner), t32(spender)], data: '0x' + w(value) }),
  approvalForAll: (nft, owner, operator, on = true) => ({ address: lower(nft), topics: [TOPICS.approvalForAll, t32(owner), t32(operator)], data: '0x' + w(on ? 1 : 0) }),
  sync: (pool, r0, r1) => ({ address: lower(pool), topics: [TOPICS.sync], data: '0x' + w(r0) + w(r1) }),
  flash: (lender, kind = 'aave-v3', receiver = lender) => ({ address: lower(lender), topics: [FLASH_BY_NAME[kind], t32(receiver)], data: '0x' + w(0) }),
};

// ---------------------------------------------------------------- EVM

export class MockEvmChain {
  /** @param o { id, head (first block number), time (unix s), blockTime (s) } */
  constructor({ id, head = 1000, time = 1_800_000_000, blockTime = 2 } = {}) {
    Object.assign(this, { id: Number(id), blockTime });
    this.blocks = new Map();
    this.codes = new Map();
    this.headNumber = head - 1;
    this.time = time;
    this.n = 0;
  }

  setCode(address, code) { this.codes.set(lower(address), lower(code)); }

  /**
   * Mines one block. txs: [{ from, to?, value?, logs?: [], deploy?: code (a contract creation: address derived),
   *   contractAddress?, status? }]. Returns the block's { number, timestamp, txs: [{hash, contractAddress}] }.
   */
  mine(txs = []) {
    const number = ++this.headNumber;
    this.time += this.blockTime;
    const transactions = []; const receipts = [];
    for (const [i, t] of txs.entries()) {
      const hash = t.hash ?? mockHash(`${this.id}.${number}.${i}.${this.n++}`);
      let contractAddress = null;
      if (t.deploy) {
        contractAddress = lower(t.contractAddress ?? mockAddress(`${this.id}.${hash}`));
        this.setCode(contractAddress, t.deploy);
      }
      const tx = { hash, from: lower(t.from), to: t.deploy ? null : lower(t.to), value: hexN(t.value ?? 0), input: t.input ?? '0x', blockNumber: hexN(number), transactionIndex: hexN(i) };
      const logs = (t.logs ?? []).map((l, j) => ({ ...l, address: lower(l.address), topics: l.topics.map(lower), data: lower(l.data), logIndex: hexN(j), transactionHash: hash, blockNumber: hexN(number) }));
      transactions.push(tx);
      receipts.push({ transactionHash: hash, from: tx.from, to: tx.to, contractAddress, status: t.status ?? '0x1', logs, blockNumber: hexN(number) });
    }
    this.blocks.set(number, { number: hexN(number), timestamp: hexN(Math.floor(this.time)), hash: mockHash(`${this.id}.block.${number}`), transactions, receipts });
    return { number, timestamp: Math.floor(this.time), txs: receipts.map((r) => ({ hash: r.transactionHash, contractAddress: r.contractAddress })) };
  }

  /** Empty blocks (time passes). */
  idle(n = 1) { for (let i = 0; i < n; i++) this.mine([]); }

  rpc() {
    const stats = { requests: 0, errors: 0, rotations: 0 };
    const send = async (method, params = []) => {
      stats.requests++;
      switch (method) {
        case 'eth_chainId': return hexN(this.id);
        case 'eth_blockNumber': return hexN(this.headNumber);
        case 'eth_getBlockByNumber': {
          const b = this.blocks.get(Number(BigInt(params[0])));
          if (!b) return null;
          const { receipts: _r, ...rest } = b;
          return params[1] ? rest : { ...rest, transactions: rest.transactions.map((t) => t.hash) };
        }
        case 'eth_getBlockReceipts': return this.blocks.get(Number(BigInt(params[0])))?.receipts ?? null;
        case 'eth_getTransactionReceipt': {
          for (const b of this.blocks.values()) { const r = b.receipts.find((x) => x.transactionHash === lower(params[0])); if (r) return r; }
          return null;
        }
        case 'eth_getCode': return this.codes.get(lower(params[0])) ?? '0x';
        default: stats.errors++; throw new Error(`mock: ${method} not served`);
      }
    };
    return { send, batch: (cs) => Promise.all(cs.map((c) => send(c.method, c.params).catch((e) => e))), stats };
  }
}

// ---------------------------------------------------------------- Solana (getSlot / getBlock jsonParsed)

export class MockSolanaChain {
  constructor({ id = 1399811151, slot = 300_000_000, time = 1_800_000_000 } = {}) {
    Object.assign(this, { id, slotNow: slot - 1, time });
    this.blocks = new Map();
    this.n = 0;
  }
  /** One slot. ixs: [{ type: 'approve' | 'setAuthority', owner, delegate | newAuthority, account }] each its own transaction. */
  mine(ixs = []) {
    const slot = ++this.slotNow;
    this.time += 0.4;
    const transactions = ixs.map((ix) => ({
      meta: { err: null, innerInstructions: [] },
      transaction: { signatures: [`mocksig${slot}x${this.n++}`], message: { instructions: [{ program: 'spl-token', parsed: ix.type === 'approve'
        ? { type: 'approve', info: { source: ix.account, delegate: ix.delegate, owner: ix.owner, amount: '18446744073709551615' } }
        : { type: 'setAuthority', info: { account: ix.account, authorityType: 'accountOwner', newAuthority: ix.newAuthority, authority: ix.owner } } }] } },
    }));
    this.blocks.set(slot, { blockTime: Math.floor(this.time), transactions });
    return slot;
  }
  rpc() {
    const send = async (method, params = []) => {
      if (method === 'getSlot') return this.slotNow;
      if (method === 'getBlock') { const b = this.blocks.get(Number(params[0])); if (!b) throw new Error('Slot was skipped'); return b; }
      throw new Error(`mock: ${method} not served`);
    };
    return { send, stats: {} };
  }
}

// ---------------------------------------------------------------- Cosmos / CosmWasm (the lcdClient pseudo-methods)

export class MockCosmosChain {
  constructor({ id = 9875, height = 5_000_000, time = 1_800_000_000 } = {}) {
    Object.assign(this, { id, heightNow: height - 1, time });
    this.txs = new Map();
    this.codeInfo = new Map();
    this.n = 0;
  }
  storeCode(codeId, checksumHex) { this.codeInfo.set(String(codeId), { code_id: String(codeId), data_hash: checksumHex.toUpperCase().replace(/^0X/, '') }); }
  /** One height. items: [{ instantiate: { contract, codeId } } | { grant: { granter, grantee, msg } }] */
  mine(items = []) {
    const h = ++this.heightNow;
    this.time += 2;
    const ts = new Date(this.time * 1000).toISOString();
    this.txs.set(h, items.map((it) => {
      const txhash = `MOCKTX${h}X${this.n++}`;
      if (it.instantiate) return { txhash, code: 0, timestamp: ts, events: [{ type: 'instantiate', attributes: [{ key: '_contract_address', value: it.instantiate.contract }, { key: 'code_id', value: String(it.instantiate.codeId) }] }], tx: { body: { messages: [] } } };
      return { txhash, code: 0, timestamp: ts, events: [], tx: { body: { messages: [{ '@type': '/cosmos.authz.v1beta1.MsgGrant', granter: it.grant.granter, grantee: it.grant.grantee,
        grant: { authorization: { '@type': '/cosmos.authz.v1beta1.GenericAuthorization', msg: it.grant.msg ?? '/cosmos.bank.v1beta1.MsgSend' } } }] } } };
    }));
    return h;
  }
  rpc() {
    const send = async (method, params = []) => {
      if (method === 'cosmos_latestHeight') return String(this.heightNow);
      if (method === 'cosmos_txsAt') return this.txs.get(Number(params[0])) ?? [];
      if (method === 'wasm_codeInfo') { const c = this.codeInfo.get(String(params[0])); return c ? { ...c, data_hash: c.data_hash } : null; }
      throw new Error(`mock: ${method} not served`);
    };
    return { send, stats: {} };
  }
}

/** A mock multi-chain: { chains: { key: MockEvmChain | MockSolanaChain | MockCosmosChain }, rpcFor(key) }. */
export function mockMultiChain(specs) {
  const chains = {};
  for (const s of specs) chains[s.key] = s.kind === 'solana' ? new MockSolanaChain(s) : s.kind === 'cosmwasm' ? new MockCosmosChain(s) : new MockEvmChain(s);
  return { chains, rpcFor: (k) => chains[k].rpc() };
}
