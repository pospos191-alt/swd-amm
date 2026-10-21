// A JSON-RPC node for the browser test, run in Node on @ethereumjs/evm: the
// real contracts, one block per transaction, logs and receipts, eth_getLogs
// with the testnet node's limits (2000 blocks per query), eth_call with revert
// data. The test's mock wallet sends through send(); the page reads through
// handle() (a Playwright route). Not a full node: just what the site uses.
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface, keccak256, getAddress, toBeHex } from 'ethers';

export const ZETA = 10n ** 18n;
const hx = (n) => '0x' + BigInt(n).toString(16);

export async function createShim({ chainId = 77390, fund = [] } = {}) {
  const common = Common.custom({ chainId, networkId: chainId }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const blockchain = { async getBlock(n) { return { hash: () => hexToBytes(keccak256(toBeHex(BigInt(n), 32))) }; }, shallowCopy() { return this; } };
  const evm = await EVM.create({ common, blockchain });
  const sm = evm.stateManager;
  for (const a of fund) await sm.putAccount(Address.fromString(a), new Account(0n, 1_000_000n * ZETA));
  let number = 100n;
  let offset = 0n;
  const logs = [];
  const receipts = new Map();
  let nonce = 0;
  const now = () => BigInt(Math.floor(Date.now() / 1000)) + offset;
  const block = () => ({ header: { number, timestamp: now(), coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32),
    gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } });

  async function run(from, to, data, value) {
    return evm.runCall({ caller: Address.fromString(from), origin: Address.fromString(from), to: to ? Address.fromString(to) : undefined,
      data: hexToBytes(data || '0x'), value: BigInt(value ?? 0), gasLimit: 15_000_000n, block: block() });
  }

  /** A transaction: mined at once in its own block. Returns the tx hash (a reverted tx gets status 0). */
  async function send({ from, to, data = '0x', value = 0n }) {
    number += 1n;
    const r = await run(from, to, data, value);
    const hash = keccak256(toBeHex(BigInt(++nonce), 32) + 'ab');
    const failed = !!r.execResult.exceptionError;
    const txLogs = failed ? [] : (r.execResult.logs ?? []).map(([addr, topics, d], i) => ({
      address: getAddress(bytesToHex(addr)), topics: topics.map(bytesToHex), data: bytesToHex(d),
      blockNumber: hx(number), transactionHash: hash, logIndex: hx(i), blockHash: keccak256(toBeHex(number, 32)), removed: false,
    }));
    logs.push(...txLogs);
    receipts.set(hash, { transactionHash: hash, status: failed ? '0x0' : '0x1', blockNumber: hx(number), logs: txLogs, from, to: to ?? null,
      contractAddress: r.createdAddress ? getAddress(r.createdAddress.toString()) : null, gasUsed: hx(r.execResult.executionGasUsed),
      revertData: failed ? bytesToHex(r.execResult.returnValue) : undefined });
    return hash;
  }

  function matchTopics(log, topics = []) {
    return topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(log.topics[i]?.toLowerCase()) : log.topics[i]?.toLowerCase() === t.toLowerCase()));
  }
  const blockArg = (b) => (b === undefined || b === 'latest' || b === 'pending' ? number : b === 'earliest' ? 0n : BigInt(b));

  const methods = {
    eth_chainId: () => hx(chainId),
    net_version: () => String(chainId),
    eth_blockNumber: () => hx(number),
    eth_gasPrice: () => '0x0',
    eth_estimateGas: () => hx(3_000_000),
    eth_getCode: async ([a]) => bytesToHex(await sm.getContractCode(Address.fromString(a))),
    eth_getBalance: async ([a]) => hx((await sm.getAccount(Address.fromString(a)))?.balance ?? 0n),
    eth_getTransactionReceipt: ([h]) => receipts.get(h) ?? null,
    async eth_call([c]) {
      await sm.checkpoint();
      try {
        const r = await run(c.from ?? '0x' + '00'.repeat(19) + '01', c.to, c.data ?? c.input, c.value);
        if (r.execResult.exceptionError) throw Object.assign(new Error('execution reverted'), { code: 3, data: bytesToHex(r.execResult.returnValue) });
        return bytesToHex(r.execResult.returnValue);
      } finally { await sm.revert(); }
    },
    eth_getLogs([f]) {
      const from = blockArg(f.fromBlock ?? 'latest'), to = blockArg(f.toBlock ?? 'latest');
      if (to - from + 1n > 2000n) throw Object.assign(new Error('block range too large; max 2000'), { code: -32000 });
      const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase()) : null;
      const out = logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to && (!addrs || addrs.includes(l.address.toLowerCase())) && matchTopics(l, f.topics));
      if (out.length > 2000) throw Object.assign(new Error('query returned more than 2000 results'), { code: -32005 });
      return out;
    },
  };

  return {
    stats: { calls: {} },
    /** One JSON-RPC request (object or batch) -> response. */
    async handle(req) {
      if (Array.isArray(req)) return Promise.all(req.map((r) => this.handle(r)));
      this.stats.calls[req.method] = (this.stats.calls[req.method] ?? 0) + 1;
      const m = methods[req.method];
      if (!m) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method ${req.method} not supported` } };
      try {
        return { jsonrpc: '2.0', id: req.id, result: await m(req.params ?? []) };
      } catch (e) {
        return { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32000, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      }
    },
    send,
    receipt: (h) => receipts.get(h),
    balance: async (a) => (await sm.getAccount(Address.fromString(a)))?.balance ?? 0n,
    blockNumber: () => number,
    advance(seconds) { offset += BigInt(seconds); },
    mine(n) { number += BigInt(n); },
    /** Deploys an artifact; returns { address, iface, send(from, fn, args, value), call(fn, args) }. */
    async deploy(art, args, from) {
      const iface = new Interface(art.abi);
      const h = await send({ from, data: art.bytecode + iface.encodeDeploy(args).slice(2) });
      const r = receipts.get(h);
      if (r.status !== '0x1') throw new Error(`deploy ${art.contractName} failed`);
      return this.at(r.contractAddress, iface);
    },
    at(address, iface) {
      return {
        address, iface,
        async send(from, fn, args = [], value = 0n) {
          const h = await send({ from, to: address, data: iface.encodeFunctionData(fn, args), value });
          const r = receipts.get(h);
          if (r.status !== '0x1') throw new Error(`${fn} reverted ${r.revertData}`);
          return r;
        },
        async call(fn, args = []) {
          const out = iface.decodeFunctionResult(fn, await methods.eth_call([{ to: address, data: iface.encodeFunctionData(fn, args) }]));
          return out.length === 1 ? out[0] : out;
        },
      };
    },
  };
}
