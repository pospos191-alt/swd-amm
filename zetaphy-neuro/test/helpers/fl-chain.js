// Test helper: an in-memory EVM chain (ZETAPHY testnet chain id 77390) running the
// real compiled FederatedRounds (zetaphy-network/artifacts/FederatedRounds.json), behind
// a JSON-RPC interface: read calls for the browser panel and the aggregator (ethers
// JsonRpcProvider, batches included), eth_sendTransaction from unlocked test accounts
// (what a browser wallet does after the user confirms), receipts and logs.
// No network, no keys.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { keccak256 } from '../../src/keccak.js';

export const CHAIN_ID = 77390;
const ART = JSON.parse(readFileSync(new URL('../../../zetaphy-network/artifacts/FederatedRounds.json', import.meta.url), 'utf8'));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const qty = (v) => '0x' + BigInt(v).toString(16);
const enc = new TextEncoder();
const hashOf = (s) => '0x' + Array.from(keccak256(enc.encode(s)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{accounts: string[], gov: string}} o  unlocked accounts (0x addresses) and the contract's governance
 */
export async function createFlChain({ accounts, gov }) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const sm = evm.stateManager;
  for (const a of [...accounts, gov]) await sm.putAccount(Address.fromString(a), new Account(0n, 10n ** 24n));
  const unlocked = new Set([...accounts, gov].map((a) => a.toLowerCase()));
  let number = 100n;
  const time = () => 1_800_000_000n + number * 6n;
  const block = (n = number) => ({ header: { number: n, timestamp: time(), coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32),
    gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } });
  const logs = [];
  const receipts = new Map();
  const sent = []; // every transaction: { from, to, data }
  let txCount = 0;

  /** A transaction in its own new block. */
  async function sendTx({ from, to, data }) {
    if (!unlocked.has(String(from).toLowerCase())) throw new Error(`unknown account ${from}`);
    number += 1n;
    const hash = hashOf(`tx-${txCount++}-${from}-${data}`);
    const r = await evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data ?? '0x'), gasLimit: 15_000_000n, block: block() });
    const ok = !r.execResult.exceptionError;
    const blockHash = hashOf(`block-${number}`);
    const txLogs = ok ? (r.execResult.logs ?? []).map(([addr, topics, d], i) => ({
      address: bytesToHex(addr).toLowerCase(), topics: topics.map(bytesToHex), data: bytesToHex(d), blockNumber: qty(number), blockHash,
      transactionHash: hash, transactionIndex: '0x0', logIndex: qty(i), removed: false,
    })) : [];
    logs.push(...txLogs);
    sent.push({ from, to, data, ok });
    receipts.set(hash, { transactionHash: hash, blockNumber: qty(number), blockHash, status: ok ? '0x1' : '0x0', logs: txLogs, from, to: to ?? null,
      contractAddress: r.createdAddress ? r.createdAddress.toString() : null, gasUsed: qty(r.execResult.executionGasUsed ?? 0n), cumulativeGasUsed: '0x0', transactionIndex: '0x0', type: '0x0', logsBloom: '0x' + '00'.repeat(256), effectiveGasPrice: '0x0' });
    return { hash, ok, created: r.createdAddress?.toString() ?? null, error: r.execResult.exceptionError?.error };
  }

  async function ethCall({ to, data, from }) {
    await sm.checkpoint();
    try {
      // as a node: on the state after the head block, in the context of the next block
      const r = await evm.runCall({ caller: Address.fromString(from ?? accounts[0]), to: Address.fromString(to), data: hexToBytes(data ?? '0x'), gasLimit: 30_000_000n, block: block(number + 1n) });
      if (r.execResult.exceptionError) throw Object.assign(new Error('execution reverted'), { data: bytesToHex(r.execResult.returnValue) });
      return bytesToHex(r.execResult.returnValue);
    } finally { await sm.revert(); }
  }

  function getLogs({ address, topics = [], fromBlock = '0x0', toBlock = 'latest' }) {
    const n = (b) => (b === 'latest' || b == null ? number : BigInt(b));
    const lo = n(fromBlock); const hi = n(toBlock);
    const addrs = address == null ? null : [].concat(address).map((a) => a.toLowerCase());
    return logs.filter((l) => {
      const b = BigInt(l.blockNumber);
      if (b < lo || b > hi) return false;
      if (addrs && !addrs.includes(l.address)) return false;
      return topics.every((t, i) => t == null || [].concat(t).map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase()));
    });
  }

  /** One JSON-RPC method. */
  async function request(method, params = []) {
    switch (method) {
      case 'eth_chainId': return qty(CHAIN_ID);
      case 'net_version': return String(CHAIN_ID);
      case 'eth_blockNumber': return qty(number);
      case 'eth_gasPrice': return '0x0';
      case 'eth_call': return ethCall(params[0]);
      case 'eth_getLogs': return getLogs(params[0] ?? {});
      case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
      case 'eth_getBlockByNumber': {
        const b = params[0] === 'latest' ? number : BigInt(params[0]);
        return { number: qty(b), hash: hashOf(`block-${b}`), parentHash: hashOf(`block-${b - 1n}`), timestamp: qty(1_800_000_000n + b * 6n), transactions: [], gasLimit: qty(30_000_000n), gasUsed: '0x0', baseFeePerGas: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000' };
      }
      case 'eth_sendTransaction': {
        const out = await sendTx(params[0]);
        if (!out.ok) throw new Error(`execution reverted (${out.error})`);
        return out.hash;
      }
      default: throw new Error(`unsupported ${method}`);
    }
  }

  /** Deploys FederatedRounds (closed: paused) from `gov`. */
  async function deployRounds({ start, commitBlocks, revealBlocks, maxPerRound }) {
    const args = word(BigInt(gov)) + word(start) + word(commitBlocks) + word(revealBlocks) + word(maxPerRound);
    const out = await sendTx({ from: gov, data: ART.bytecode + args });
    if (!out.ok) throw new Error(`deploy failed: ${out.error}`);
    return out.created.toLowerCase();
  }

  /** JSON-RPC over HTTP (single and batch requests), for ethers in another process. */
  function serve(port) {
    return new Promise((resolve) => {
      const srv = createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const one = async ({ id, method, params }) => {
          try { return { jsonrpc: '2.0', id, result: await request(method, params) }; } catch (e) { return { jsonrpc: '2.0', id, error: { code: 3, message: e.message, data: e.data } }; }
        };
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        const out = Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      }).listen(port, () => resolve(srv));
    });
  }

  return {
    request, sendTx, deployRounds, serve, logs, sent,
    blockNumber: () => number,
    mine(n = 1) { number += BigInt(n); },
    abi: ART.abi,
  };
}
