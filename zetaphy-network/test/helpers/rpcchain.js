// An in-memory chain behind a real ethers provider: signed transactions (Wallet + Contract),
// receipts with logs, eth_getLogs, block numbers and a clock the test controls. Used to test the
// command-line paths (deploy-useful-work, the useful-work feeder, the detector loop, the arena
// runners) end to end with real signing, without a node.
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex, setLengthLeft } from '@ethereumjs/util';
import { JsonRpcApiProvider, Network, Transaction, Wallet, keccak256, toBeHex, getAddress, ContractFactory, Contract } from 'ethers';
import { readFileSync } from 'node:fs';

export const ZETA = 10n ** 18n;

/** Serves a chain's JSON-RPC over HTTP on 127.0.0.1:port (for scripts run as child processes). Returns { url, close }. */
export async function serveRpc(chain, port) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const one = async (p) => { try { return { jsonrpc: '2.0', id: p.id, result: await chain.handle(p.method, p.params ?? []) }; } catch (e) { return { jsonrpc: '2.0', id: p.id, error: e.rpc ?? { code: -32000, message: e.message } }; } };
      const q = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q)));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
const hex = (n) => '0x' + BigInt(n).toString(16);
const ZERO32 = '0x' + '00'.repeat(32);

/**
 * @param opts.chainId  default 77390 (the testnet's id: commands that refuse other chains accept it)
 * @param opts.accounts number of funded wallets (deterministic keys)
 */
export async function createRpcChain({ chainId = 77390, accounts = 8, time = 1_800_000_000 } = {}) {
  const common = Common.custom({ chainId: BigInt(chainId) }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const blockHash = (n) => keccak256(toBeHex(BigInt(n), 32));
  const blockchain = { async getBlock(n) { const h = hexToBytes(blockHash(n)); return { hash: () => h }; }, shallowCopy() { return this; } };
  const evm = await EVM.create({ common, blockchain });
  const sm = evm.stateManager;
  let number = 10n;
  let now = BigInt(time);
  const blockTimes = new Map([[number, now]]);
  const receipts = new Map();
  const txs = new Map();
  const logs = [];
  const header = () => ({ number, timestamp: now, coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n });

  const wallets = [];
  for (let i = 0; i < accounts; i++) {
    const w = new Wallet(keccak256(new TextEncoder().encode(`rpcchain wallet ${i}`)));
    await sm.putAccount(Address.fromString(w.address), new Account(0n, 1_000_000n * ZETA));
    wallets.push(w);
  }

  const revertError = (ret) => Object.assign(new Error('execution reverted'), { rpc: { code: 3, message: 'execution reverted', data: ret } });

  async function simulate({ from, to, data, value }) {
    await sm.checkpoint();
    try {
      const r = await evm.runCall({ caller: Address.fromString(from ?? '0x' + '00'.repeat(20)), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data ?? '0x'), value: BigInt(value ?? 0), gasLimit: 25_000_000n, block: { header: header() } });
      return r;
    } finally {
      await sm.revert();
    }
  }

  function mineBlock() { number += 1n; now += 5n; blockTimes.set(number, now); }

  async function sendRaw(raw) {
    const tx = Transaction.from(raw);
    if (tx.chainId !== BigInt(chainId)) throw new Error(`wrong chain id ${tx.chainId}`);
    const from = Address.fromString(tx.from);
    const acct = (await sm.getAccount(from)) ?? new Account();
    if (acct.nonce !== BigInt(tx.nonce)) throw new Error(`nonce ${tx.nonce}, expected ${acct.nonce}`);
    if (acct.balance < tx.value) throw new Error('insufficient funds');
    mineBlock();
    const r = await evm.runCall({ caller: from, to: tx.to ? Address.fromString(tx.to) : undefined, data: hexToBytes(tx.data), value: tx.value, gasLimit: tx.gasLimit, block: { header: header() } });
    // a failed top-level call still uses the nonce
    const after = (await sm.getAccount(from)) ?? new Account();
    if (after.nonce !== BigInt(tx.nonce) + 1n) { after.nonce = BigInt(tx.nonce) + 1n; await sm.putAccount(from, after); }
    const hash = tx.hash;
    const bh = blockHash(number);
    const ok = !r.execResult.exceptionError;
    const theLogs = ok ? (r.execResult.logs ?? []).map(([a, topics, d], i) => ({
      address: getAddress(bytesToHex(a)), topics: topics.map(bytesToHex), data: bytesToHex(d), blockNumber: hex(number), blockHash: bh,
      transactionHash: hash, transactionIndex: '0x0', logIndex: hex(i), removed: false,
    })) : [];
    logs.push(...theLogs);
    receipts.set(hash, {
      transactionHash: hash, transactionIndex: '0x0', blockHash: bh, blockNumber: hex(number), from: tx.from, to: tx.to,
      contractAddress: !tx.to && ok ? getAddress(r.createdAddress.toString()) : null, cumulativeGasUsed: hex(r.execResult.executionGasUsed + 21000n),
      gasUsed: hex(r.execResult.executionGasUsed + 21000n), effectiveGasPrice: '0x0', logs: theLogs, logsBloom: '0x' + '00'.repeat(256),
      status: ok ? '0x1' : '0x0', type: hex(tx.type ?? 2),
    });
    txs.set(hash, { tx, block: number });
    return hash;
  }

  const blockOf = (tag) => (tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized' || tag == null ? number : tag === 'earliest' ? 0n : BigInt(tag));

  async function handle(method, params) {
    switch (method) {
      case 'eth_chainId': return hex(chainId);
      case 'net_version': return String(chainId);
      case 'eth_blockNumber': return hex(number);
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x0';
      case 'eth_getBlockByNumber': case 'eth_getBlockByHash': {
        const n = method === 'eth_getBlockByHash' ? [...blockTimes.keys()].find((k) => blockHash(k) === params[0]) : blockOf(params[0]);
        if (n == null || n > number) return null;
        return {
          number: hex(n), hash: blockHash(n), parentHash: n > 0n ? blockHash(n - 1n) : ZERO32, timestamp: hex(blockTimes.get(n) ?? now), nonce: '0x0000000000000000',
          difficulty: '0x0', gasLimit: hex(30_000_000n), gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', baseFeePerGas: '0x0',
          transactions: await Promise.all([...txs.entries()].filter(([, v]) => v.block === n).map(([h]) => (params[1] ? handle('eth_getTransactionByHash', [h]) : h))), stateRoot: ZERO32, receiptsRoot: ZERO32, logsBloom: '0x' + '00'.repeat(256),
        };
      }
      case 'eth_getTransactionCount': return hex((await sm.getAccount(Address.fromString(params[0])))?.nonce ?? 0n);
      case 'eth_getBalance': return hex((await sm.getAccount(Address.fromString(params[0])))?.balance ?? 0n);
      case 'eth_getCode': return bytesToHex(await sm.getContractCode(Address.fromString(params[0])));
      case 'eth_getStorageAt': return bytesToHex(setLengthLeft(await sm.getContractStorage(Address.fromString(params[0]), setLengthLeft(hexToBytes(toBeHex(BigInt(params[1]))), 32)), 32));
      case 'eth_call': {
        const r = await simulate(params[0]);
        if (r.execResult.exceptionError) throw revertError(bytesToHex(r.execResult.returnValue));
        return bytesToHex(r.execResult.returnValue);
      }
      case 'eth_estimateGas': {
        const r = await simulate(params[0]);
        if (r.execResult.exceptionError) throw revertError(bytesToHex(r.execResult.returnValue));
        return hex(r.execResult.executionGasUsed * 2n + 100_000n);
      }
      case 'eth_sendRawTransaction': return sendRaw(params[0]);
      case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
      case 'eth_getTransactionByHash': {
        const t = txs.get(params[0]);
        if (!t) return null;
        const j = t.tx.toJSON();
        return { ...j, hash: t.tx.hash, from: t.tx.from, blockNumber: hex(t.block), blockHash: blockHash(t.block), transactionIndex: '0x0', nonce: hex(t.tx.nonce), gas: hex(t.tx.gasLimit), value: hex(t.tx.value), input: t.tx.data, type: hex(t.tx.type), chainId: hex(chainId), gasPrice: '0x0', maxFeePerGas: hex(t.tx.maxFeePerGas ?? 0n), maxPriorityFeePerGas: hex(t.tx.maxPriorityFeePerGas ?? 0n), v: hex(t.tx.signature.v), r: t.tx.signature.r, s: t.tx.signature.s, yParity: hex(t.tx.signature.yParity), accessList: [] };
      }
      case 'eth_getLogs': {
        const f = params[0] ?? {};
        const from = blockOf(f.fromBlock ?? 'earliest'); const to = blockOf(f.toBlock ?? 'latest');
        const addrs = f.address ? [].concat(f.address).map((a) => a.toLowerCase()) : null;
        return logs.filter((l) => {
          const b = BigInt(l.blockNumber);
          if (b < from || b > to) return false;
          if (addrs && !addrs.includes(l.address.toLowerCase())) return false;
          return (f.topics ?? []).every((t, i) => t == null || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase()) : t.toLowerCase() === l.topics[i]?.toLowerCase()));
        });
      }
      default: throw Object.assign(new Error(`not supported: ${method}`), { rpc: { code: -32601, message: `not supported: ${method}` } });
    }
  }

  class MemoryProvider extends JsonRpcApiProvider {
    constructor() { super(new Network('memory', chainId), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 10 }); }
    async _send(payload) {
      const one = async (p) => {
        try { return { id: p.id, result: await handle(p.method, p.params ?? []) }; } catch (e) { return { id: p.id, error: e.rpc ?? { code: -32000, message: e.message } }; }
      };
      return Array.isArray(payload) ? Promise.all(payload.map(one)) : [await one(payload)];
    }
  }
  const provider = new MemoryProvider();
  const signers = wallets.map((w) => w.connect(provider));

  return {
    provider, signers, evm, sm, chainId,
    /** JSON-RPC handler (method, params) -> result, e.g. for a fake HTTP node. */
    handle,
    advance(seconds) { now += BigInt(seconds); mineBlock(); },
    mine(n = 1) { for (let i = 0; i < n; i++) mineBlock(); },
    now: () => now,
    blockNumber: () => number,
    async fund(address, wei) { const a = Address.fromString(address); const acc = (await sm.getAccount(a)) ?? new Account(); acc.balance = BigInt(wei); await sm.putAccount(a, acc); },
    /** Deploys an artifact of zetaphy-network with a signer; returns an ethers Contract. */
    async deploy(name, args = [], signer = signers[0], value = 0n) {
      const art = JSON.parse(readFileSync(new URL(`../../artifacts/${name}.json`, import.meta.url), 'utf8'));
      const c = await new ContractFactory(art.abi, art.bytecode, signer).deploy(...args, { value });
      await c.waitForDeployment();
      return c;
    },
    at(name, address, runner = provider) {
      const art = JSON.parse(readFileSync(new URL(`../../artifacts/${name}.json`, import.meta.url), 'utf8'));
      return new Contract(address, art.abi, runner);
    },
  };
}
