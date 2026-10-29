// Test helper: a tiny in-memory ZETAPHY-like chain with the real SignalBoard
// contract (zetaphy-network/artifacts/SignalBoard.json), answering the JSON-RPC
// calls the browser's chain board makes: reads, eth_getLogs, signed raw
// transactions (checked like a node: signature, chain id, nonce, balance for gas)
// and the testnet faucet (zetaphy_faucet: 10 ZETAPHY once per address).
// Every transaction is mined in its own block at once (instant finality, as CometBFT).
import { readFileSync } from 'node:fs';
import { EVM } from '@ethereumjs/evm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { LegacyTransaction } from '@ethereumjs/tx';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { keccak256 } from '../../src/keccak.js';

const ART = JSON.parse(readFileSync(new URL('../../../zetaphy-network/artifacts/SignalBoard.json', import.meta.url), 'utf8'));
const DEPLOYER = Address.fromString('0x1111111111111111111111111111111111111111');
const ERRORS = Object.fromEntries(['NoTopic()', 'PayloadSize()', 'BadExpiry()', 'RateLimited()'].map((e) => [bytesToHex(keccak256(new TextEncoder().encode(e)).subarray(0, 4)), e.slice(0, -2)]));
const hexN = (n) => '0x' + BigInt(n).toString(16);

export async function createSignalDevnet({ chainId = 77390, gasPrice = 1_000_000_000n, faucetWei = 10n * 10n ** 18n, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun }) });
  const sm = evm.stateManager;
  const common = Common.custom({ chainId });
  let number = 1n;
  let skew = 0;
  const now = () => BigInt(clock() + skew);
  const block = () => ({ header: { number, timestamp: now(), coinbase: Address.zero(), difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, cliqueSigner: () => Address.zero(), getBlobGasPrice: () => 0n } });
  const logs = [];
  const receipts = new Map();
  const fauceted = new Set();
  const sent = [];

  await sm.putAccount(DEPLOYER, new Account(0n, 10n ** 24n));
  const d = await evm.runCall({ caller: DEPLOYER, data: hexToBytes(ART.bytecode), gasLimit: 10_000_000n, block: block() });
  if (d.execResult.exceptionError) throw new Error('SignalBoard deploy failed');
  const board = d.createdAddress.toString();
  number++;

  const calldataGas = (data) => data.reduce((s, b) => s + (b ? 16n : 4n), 0n);
  const revertName = (ret) => ERRORS[bytesToHex(ret).slice(0, 10)] ?? 'revert';

  async function exec(caller, to, data, gasLimit, { commit }) {
    evm.journal.cleanJournal();
    await sm.checkpoint();
    const r = await evm.runCall({ caller, to, data, gasLimit, gasPrice, block: block() });
    if (commit) await sm.commit(); else await sm.revert();
    return r;
  }

  const rpc = {
    board, calls: [], sent,
    advance(seconds) { skew += seconds; },
    async call(method, params = []) {
      this.calls.push(method);
      switch (method) {
        case 'eth_chainId': return hexN(chainId);
        case 'eth_blockNumber': return hexN(number - 1n);
        case 'eth_gasPrice': return hexN(gasPrice);
        case 'eth_getBalance': return hexN((await sm.getAccount(Address.fromString(params[0])))?.balance ?? 0n);
        case 'eth_getTransactionCount': return hexN((await sm.getAccount(Address.fromString(params[0])))?.nonce ?? 0n);
        case 'zetaphy_faucet': {
          const a = Address.fromString(params[0]);
          if (fauceted.has(a.toString())) throw new Error('faucet: already given today');
          fauceted.add(a.toString());
          const acct = (await sm.getAccount(a)) ?? new Account();
          acct.balance += faucetWei;
          await sm.putAccount(a, acct);
          return { amount: faucetWei.toString() };
        }
        case 'eth_call':
        case 'eth_estimateGas': {
          const { from, to, data } = params[0];
          const bytes = hexToBytes(data ?? '0x');
          const r = await exec(Address.fromString(from ?? '0x2222222222222222222222222222222222222222'), Address.fromString(to), bytes, 10_000_000n, { commit: false });
          if (r.execResult.exceptionError) throw new Error(`execution reverted: ${revertName(r.execResult.returnValue)}`);
          return method === 'eth_call' ? bytesToHex(r.execResult.returnValue) : hexN(21000n + calldataGas(bytes) + r.execResult.executionGasUsed);
        }
        case 'eth_sendRawTransaction': {
          const tx = LegacyTransaction.fromSerializedTx(hexToBytes(params[0]), { common });
          if (!tx.verifySignature()) throw new Error('invalid signature');
          const from = tx.getSenderAddress();
          const acct = (await sm.getAccount(from)) ?? new Account();
          if (tx.nonce !== acct.nonce) throw new Error(`invalid nonce: have ${acct.nonce}, got ${tx.nonce}`);
          if (tx.gasPrice < gasPrice) throw new Error('gas price below the minimum');
          if (acct.balance < tx.gasLimit * tx.gasPrice) throw new Error('insufficient funds for gas * price + value');
          const intrinsic = 21000n + calldataGas(tx.data);
          const r = await exec(from, tx.to, tx.data, tx.gasLimit - intrinsic, { commit: true });
          const used = intrinsic + r.execResult.executionGasUsed;
          const after = (await sm.getAccount(from)) ?? new Account();
          after.nonce = acct.nonce + 1n;
          after.balance = acct.balance - used * tx.gasPrice;
          await sm.putAccount(from, after);
          const hash = bytesToHex(tx.hash());
          const ok = !r.execResult.exceptionError;
          if (ok) for (const [i, [addr, topics, data]] of (r.execResult.logs ?? []).entries()) {
            logs.push({ address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data), blockNumber: hexN(number), transactionHash: hash, logIndex: hexN(i) });
          }
          receipts.set(hash, { transactionHash: hash, status: ok ? '0x1' : '0x0', blockNumber: hexN(number), gasUsed: hexN(used), error: ok ? null : revertName(r.execResult.returnValue) });
          sent.push({ hash, from: from.toString(), bytes: tx.data.length, ok, gasUsed: used });
          number++;
          return hash;
        }
        case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
        case 'eth_getLogs': {
          const f = params[0];
          const lo = BigInt(f.fromBlock ?? 0), hi = f.toBlock && f.toBlock !== 'latest' ? BigInt(f.toBlock) : number;
          return logs.filter((l) => (!f.address || l.address.toLowerCase() === f.address.toLowerCase())
            && BigInt(l.blockNumber) >= lo && BigInt(l.blockNumber) <= hi
            && (f.topics ?? []).every((t, i) => t == null || l.topics[i]?.toLowerCase() === String(t).toLowerCase()));
        }
        default: throw new Error(`unsupported ${method}`);
      }
    },
  };
  return rpc;
}
