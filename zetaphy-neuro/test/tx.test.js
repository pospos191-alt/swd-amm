// Transaction checks (src/tx.js): log decoding, the scam-pattern rules, and a full read
// against the local chain (a stand-in RPC answers the transaction and receipt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLogs, analyzeTx, readTransaction, isTxHash, lookalike, UNLIMITED } from '../src/tx.js';
import { explain, explainPath } from '../src/explain.js';
import { createLocalChain } from './helpers/local-chain.js';

const ME = '0x1111111111111111111111111111111111111111';
const ADDR = (n) => '0x' + String(n).repeat(40).slice(0, 40);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const T_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
const MAX = (2n ** 256n - 1n);
const ids = (a) => a.findings.map((f) => `${f.id}:${f.severity}`);

test('tx hash format and look-alike addresses', () => {
  assert.ok(isTxHash('0x' + 'ab'.repeat(32)));
  assert.ok(!isTxHash('0x' + 'ab'.repeat(20)));
  assert.ok(lookalike('0xabcd000000000000000000000000000000001234', '0xabcdffffffffffffffffffffffffffffffff1234'));
  assert.ok(!lookalike('0xabcd000000000000000000000000000000001234', '0xabcd000000000000000000000000000000001234'));
  assert.ok(!lookalike('0xabcd000000000000000000000000000000001234', '0xabce000000000000000000000000000000001234'));
});

test('logs: token and NFT transfers, approvals (unlimited), approve-all', () => {
  const tok = ADDR(5);
  const ev = decodeLogs([
    { address: tok, topics: [T_TRANSFER, topic(ME), topic(ADDR(2))], data: '0x' + word(1000) },
    { address: tok, topics: [T_TRANSFER, topic(ME), topic(ADDR(2)), '0x' + word(7)], data: '0x' },
    { address: tok, topics: [T_APPROVAL, topic(ME), topic(ADDR(3))], data: '0x' + word(MAX) },
    { address: tok, topics: [T_ALL, topic(ME), topic(ADDR(4))], data: '0x' + word(1) },
    { address: tok, topics: ['0x' + 'ee'.repeat(32)], data: '0x' },
  ]);
  assert.deepEqual(ev.map((e) => e.kind), ['token', 'nft', 'approve', 'approveAll']);
  assert.equal(ev[0].amount, 1000n);
  assert.equal(ev[1].id, '7');
  assert.equal(ev[2].unlimited, true);
  assert.equal(ev[3].approved, true);
});

test('rules: approvals to a wallet, unlimited approvals, approve-all, poisoning, drainer bait', () => {
  const base = { found: true, status: true, from: ME, to: ADDR(5), value: 0n, native: 'ETH', method: { selector: '0x095ea7b3', sig: 'approve(address,uint256)' } };
  const ap = (spender, amount) => ({ kind: 'approve', token: ADDR(5), owner: ME, spender, amount, unlimited: amount >= UNLIMITED });
  // approval to a plain wallet: high, whatever the amount
  assert.ok(ids(analyzeTx({ ...base, events: [ap(ADDR(3), 5n)], code: { [ADDR(3)]: false } })).includes('tx-approve-wallet:high'));
  // unlimited approval to a contract Neuro does not flag: medium
  const u = analyzeTx({ ...base, events: [ap(ADDR(3), MAX)], code: { [ADDR(3)]: true }, levels: { [ADDR(3)]: 'info' } });
  assert.equal(u.level, 'medium');
  assert.ok(ids(u).includes('tx-approve-unlimited:medium'));
  // limited approval to an ordinary contract: nothing to flag
  assert.equal(analyzeTx({ ...base, events: [ap(ADDR(3), 5n)], code: { [ADDR(3)]: true } }).level, 'info');
  // approval to a contract Neuro rates high
  assert.ok(ids(analyzeTx({ ...base, events: [ap(ADDR(3), 5n)], code: { [ADDR(3)]: true }, levels: { [ADDR(3)]: 'high' } })).includes('tx-approve-risky:high'));
  // approve all NFTs: high to a wallet, medium to a contract
  const all = (code) => analyzeTx({ ...base, events: [{ kind: 'approveAll', token: ADDR(5), owner: ME, operator: ADDR(4), approved: true }], code: { [ADDR(4)]: code } });
  assert.ok(ids(all(false)).includes('tx-approve-all-wallet:high'));
  assert.ok(ids(all(true)).includes('tx-approve-all:medium'));
  // someone else's approval in the same transaction is not the sender's risk
  assert.equal(analyzeTx({ ...base, events: [{ ...ap(ADDR(3), MAX), owner: ADDR(9) }], code: { [ADDR(3)]: false } }).level, 'info');
  // 0-amount transfer and a look-alike of the sender: address poisoning
  const fake = '0x1111' + 'a'.repeat(32) + '1111';
  const p = analyzeTx({ ...base, events: [{ kind: 'token', token: ADDR(5), from: ME, to: fake, amount: 0n }] });
  assert.ok(ids(p).includes('tx-zero-transfer:high'));
  assert.ok(ids(p).includes('tx-lookalike:high'));
  // money to a "claim" function of a contract: drainer bait
  const bait = analyzeTx({ ...base, value: 10n ** 17n, method: { selector: '0x4e71d92d', sig: 'claim()' }, events: [], code: { [ADDR(5)]: true } });
  assert.ok(ids(bait).includes('tx-bait-payable:medium'));
  // a failed, plain transfer of coins to a wallet: nothing risky
  const plain = analyzeTx({ ...base, status: false, value: 5n, method: null, events: [], code: { [ADDR(5)]: false } });
  assert.deepEqual(ids(plain).filter((x) => !x.startsWith('tx-summary')), ['tx-failed:info', 'tx-nothing-found:info']);
  assert.deepEqual(ids(analyzeTx({ found: false })), ['tx-not-found:info']);
});

test('read a real transaction on the local chain: unlimited approval to a wallet, then a call to a risky token', async () => {
  const chain = await createLocalChain();
  const scam = (await chain.deploy('ScamToken')).toLowerCase();
  const spender = ADDR(3);
  const hash = '0x' + '12'.repeat(32);
  const txs = {
    [hash]: {
      tx: { hash, from: ME, to: scam, value: '0x0', input: '0x095ea7b3' + word(spender) + word(MAX), blockNumber: '0x10' },
      rc: { status: '0x1', contractAddress: null, logs: [{ address: scam, topics: [T_APPROVAL, topic(ME), topic(spender)], data: '0x' + word(MAX) }] },
    },
  };
  const rpc = {
    async call(method, params) {
      if (method === 'eth_getTransactionByHash') return txs[params[0]]?.tx ?? null;
      if (method === 'eth_getTransactionReceipt') return txs[params[0]]?.rc ?? null;
      return chain.rpc.call(method, params);
    },
  };
  const r = await readTransaction('eth', hash, { rpc });
  assert.equal(r.kind, 'tx');
  assert.equal(r.method.sig, 'approve(address,uint256)');
  assert.ok(ids(r.analysis).includes('tx-approve-wallet:high'), ids(r.analysis).join(' '));
  assert.ok(ids(r.analysis).includes('tx-to-risky:high'));
  assert.equal(r.analysis.level, 'high');
  assert.equal(r.path[0].kind, 'call');
  assert.equal(r.path[1].kind, 'approve');
  assert.ok(r.path[1].symbol, 'token symbol read for the path');
  assert.match(r.reportHash, /^[0-9a-f]{64}$/);
  // every finding and path line has wording in every language
  for (const lang of ['en', 'th', 'zh']) {
    for (const l of explain(r, lang).lines) assert.ok(l.text && !l.text.startsWith('tx-'), `${lang} ${l.id}`);
    for (const l of explainPath(r, lang)) assert.ok(l && !l.startsWith('path-'), `${lang} path`);
  }
  // unknown transaction
  const none = await readTransaction('eth', '0x' + '34'.repeat(32), { rpc });
  assert.deepEqual(ids(none.analysis), ['tx-not-found:info']);
  await assert.rejects(readTransaction('sol', hash, { rpc }), /EVM chains/);
  await assert.rejects(readTransaction('eth', '0x12', { rpc }), /invalid transaction hash/);
});
