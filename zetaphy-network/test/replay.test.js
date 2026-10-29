// Parametric hack insurance (item 32): the deterministic forensic replay (src/replay.js). Here the "fork" is the
// in-memory EVM rebuilt from the same deterministic setup (the state before the exploit), the "chain" is a second
// copy where a scripted fixture exploit ran (helpers/ReplayKit.sol: a vault whose sweep() has no owner check).
// The anvil path (fork of a live RPC, the pinned foundry) is scripts/insurance-replay-e2e.js, run by
// .github/workflows/insurance-replay.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, toBeHex } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { replayKit } from './helpers/replaykit.js';
import { canonicalJson, reportHash, targetKeyOf, evidenceHashOf, runReplay, checkReport, requestOf, voteDecision, tokensMoved, normalizeRequest, TRANSFER_TOPIC } from '../src/replay.js';

const NATIVE_ASSET = '0x' + '5a'.repeat(20); // stands for WZETAPHY in the price stub
const VAULT = new Interface(replayKit().ToyVault.abi);
const DAY = 86400;

/** The state before the exploit (deterministic: the same addresses and balances every time). */
async function setup() {
  const k = replayKit();
  const c = await createChain(['gov', 'holder', 'attacker', 'user', 'w1', 'w2']);
  const a = (n) => c.acct[n].toString();
  const token = await c.deployRaw(k.ReplayToken, [6], 'gov');
  const other = await c.deployRaw(k.ReplayToken, [18], 'gov');
  const vault = await c.deployRaw(k.ToyVault, [], 'gov');
  await c.transfer('gov', vault.address, 50n * ZETA);
  await token.send('gov', 'mint', [vault.address, 2_000_000n]);   // 2 RPL (6 decimals)
  await other.send('gov', 'mint', [vault.address, 5n * ZETA]);
  const oracle = await c.deployRaw(k.PriceStub, [], 'gov');
  await oracle.send('gov', 'set', [NATIVE_ASSET, 2n * ZETA]);      // the native coin: $2
  await oracle.send('gov', 'set', [token.address, 3n * ZETA]);     // RPL: $3, so 1.5 native per RPL
  const runners = await c.deployRaw(k.RunnersStub, [], 'gov');
  const ins = await c.deploy('HackInsurance', [runners.address, 2, 1, a('gov')], 'gov');
  await ins.send('gov', 'deposit', [], 1000n * ZETA);
  const target = await ins.call('targetKey', [1n, vault.address]);
  await ins.send('gov', 'setTarget', [target, true, 300n * ZETA]);
  await ins.send('holder', 'buyCover', [target, 500n * ZETA, 30 * DAY], await ins.call('premiumOf', [500n * ZETA, 30 * DAY]));
  return { c, a, token, other, vault, oracle, ins, target };
}

/** The chain where the incident happened: setup, the exploit's transactions (recorded as an RPC would show them), noise. */
async function incident() {
  const s = await setup();
  const { c, a, token, other, vault } = s;
  const txs = [], blocks = {};
  const rec = async (from, to, data, value = 0n) => {
    const block = c.blockNumber(), timestamp = c.now();
    const r = await c.rawTx(from, to, data, value);
    const hash = keccak256(toBeHex(block, 32));
    blocks[block] = { hash: keccak256(toBeHex(block + 1000n, 32)), timestamp };
    const t = { hash, from: c.acct[from]?.toString() ?? from, to, input: data, value: toBeHex(value), gas: '0x1000000', gasPrice: '0x0', blockNumber: block, transactionIndex: 0, status: r.ok, timestamp, baseFeePerGas: '0x0', miner: '0x' + '00'.repeat(20) };
    txs.push(t);
    return t;
  };
  const fork = c.blockNumber() - 1n;
  blocks[fork] = { hash: keccak256(toBeHex(fork + 1000n, 32)), timestamp: c.now() };
  c.advance(60);
  const t1 = await rec('attacker', vault.address, VAULT.encodeFunctionData('sweep', [token.address, a('attacker')]));
  c.advance(12);
  await rec('user', a('w1'), '0x', ZETA);                                   // noise: not part of the claim, not replayed
  c.advance(12);
  const at = c.now();                                                        // time-dependent: works only at its own timestamp
  const t2 = await rec('attacker', vault.address, VAULT.encodeFunctionData('sweepAt', ['0x' + '00'.repeat(20), a('attacker'), at, at]));
  c.advance(12);
  const t3 = await rec('attacker', vault.address, VAULT.encodeFunctionData('sweep', [other.address, a('attacker')]));
  c.mine(20);
  const source = {
    chainId: async () => 1n,
    blockNumber: async () => c.blockNumber(),
    block: async (n) => blocks[BigInt(n)] ?? { hash: keccak256(toBeHex(BigInt(n) + 1000n, 32)), timestamp: 0n },
    tx: async (h) => txs.find((t) => t.hash === h) ?? null,
  };
  return { ...s, source, exploit: [t1, t2, t3], from: t1.blockNumber, to: t3.blockNumber };
}

/** A fork engine on the in-memory EVM: the setup again, then the original transactions at their own timestamps. */
function memEngine({ keepTime = true } = {}) {
  let s = null;
  return {
    started: 0,
    async start() { s = await setup(); this.started++; return { hash: null }; },
    snapshot: async () => 'setup',
    async revert() { s = await setup(); },
    balance: (addr) => s.c.balance(Address.fromString(addr)),
    call: (to, data) => s.c.rawCallHex(to, data).catch(() => null),
    async replay(txs) {
      const out = [];
      for (const t of txs) { if (keepTime) s.c.setTime(t.timestamp); const r = await s.c.rawTx(t.from, t.to, t.input, BigInt(t.value)); out.push({ status: r.ok, logs: r.logs }); }
      return out;
    },
  };
}

const request = (i, extra = {}) => ({ chainId: 1, target: i.vault.address, txHashes: i.exploit.map((t) => t.hash), fromBlock: i.from, toBlock: i.to, ...extra });

test('canonical JSON: sorted keys, integers as strings, the same bytes whatever the key order; refuses floats and non-ASCII', () => {
  const x = { b: [1, 2n, { z: true, a: null }], a: 'x' };
  const y = { a: 'x', b: [1, 2n, { a: null, z: true }] };
  assert.equal(canonicalJson(x), '{"a":"x","b":["1","2",{"a":null,"z":true}]}');
  assert.equal(canonicalJson(x), canonicalJson(y));
  assert.equal(reportHash(x), reportHash(y));
  assert.equal(canonicalJson(JSON.parse(canonicalJson(x))), canonicalJson(x), 'a report read back from its file has the same bytes');
  assert.throws(() => canonicalJson({ a: 1.5 }), /safe integer/);
  assert.throws(() => canonicalJson({ a: 'ü' }), /ASCII/);
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
});

test('target key and evidence hash are exactly what HackInsurance computes', async () => {
  const s = await setup();
  const txs = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
  assert.equal(targetKeyOf(1, s.vault.address), s.target);
  assert.equal(evidenceHashOf(1, s.target, txs, 7, 9), await s.ins.call('evidenceHash', [s.target, txs, 7, 9]));
  assert.throws(() => normalizeRequest({ chainId: 1, target: s.vault.address, txHashes: [txs[0], txs[0]], fromBlock: 1, toBlock: 2 }), /twice/);
  assert.throws(() => normalizeRequest({ chainId: 1, target: s.vault.address, txHashes: txs, fromBlock: 3, toBlock: 2 }), /fromBlock/);
  assert.throws(() => normalizeRequest({ chainId: 1, target: s.vault.address, txHashes: Array.from({ length: 17 }, (_, i) => keccak256(toBeHex(i))), fromBlock: 1, toBlock: 2 }), /1 to 16/);
});

test('replay: loss = native + priced tokens moved out of the target; unpriced tokens listed; two runs give the same bytes and hash', async () => {
  const i = await incident();
  const req = request(i, { prices: { [i.token.address]: (3n * ZETA) / 2n } });
  const a = await runReplay(req, { source: i.source, engine: memEngine(), confirmations: 12 });
  const b = await runReplay({ ...req, prices: { [i.token.address.toUpperCase().replace('0X', '0x')]: ((3n * ZETA) / 2n).toString() } }, { source: i.source, engine: memEngine(), confirmations: 12 });
  assert.equal(canonicalJson(a.report), canonicalJson(b.report), 'the same bytes');
  assert.equal(a.hash, b.hash);
  assert.equal(a.loss, 50n * ZETA + 3n * ZETA, '50 native + 2 RPL x 1.5');
  const r = a.report;
  assert.equal(r.matchesOriginal, true, 'the time-dependent sweep replays at its original timestamp');
  const drift = await runReplay(req, { source: i.source, engine: memEngine({ keepTime: false }), confirmations: 12 });
  assert.equal(drift.report.matchesOriginal, false, 'replayed at another time it reverts, and the report says so');
  assert.notEqual(drift.hash, a.hash);
  assert.deepEqual(r.assets.map((x) => x.asset), ['native', ...[i.token.address, i.other.address].map((x) => x.toLowerCase()).sort()], 'tokens found from the Transfer logs');
  assert.deepEqual(r.unpriced, [i.other.address.toLowerCase()], 'no price: listed, counts zero');
  assert.equal(r.assets.find((x) => x.asset === i.token.address.toLowerCase()).delta, '-2000000');
  assert.equal(r.evidenceHash, await i.ins.call('evidenceHash', [i.target, req.txHashes, i.from, i.to]));
  assert.equal(r.txs.length, 3, 'only the claimed transactions (the noise in between is not replayed)');
  assert.ok(!JSON.stringify(r).includes('"time"') && !('createdAt' in r), 'no wall clock in the report');
  // recompute from the report alone
  const again = await runReplay(requestOf(r), { source: i.source, engine: memEngine(), confirmations: 12 });
  assert.equal(again.hash, a.hash, 'requestOf(report) reproduces it');
  const chk = checkReport(JSON.parse(JSON.stringify(r)));
  assert.equal(chk.ok, true);
  assert.equal(chk.hash, a.hash, 'the hash survives a round trip through the file');
});

test('replay: on-chain prices from a ZetaphyOracle at the fork state; the pricing is part of the report (another pricing, another hash)', async () => {
  const i = await incident();
  const explicit = await runReplay(request(i, { prices: { [i.token.address]: (3n * ZETA) / 2n } }), { source: i.source, engine: memEngine() });
  const onchain = await runReplay(request(i, { oracle: { address: i.oracle.address, nativeAsset: NATIVE_ASSET } }), { source: i.source, engine: memEngine() });
  assert.equal(onchain.loss, explicit.loss, '$3 / $2 = 1.5 native per RPL either way');
  assert.equal(onchain.report.assets.find((x) => x.asset === i.token.address.toLowerCase()).price.source, 'oracle');
  assert.deepEqual(onchain.report.unpriced, [i.other.address.toLowerCase()], 'the oracle does not know it: unpriced');
  assert.notEqual(onchain.hash, explicit.hash, 'the pricing inputs are in the report');
  const none = await runReplay(request(i), { source: i.source, engine: memEngine() });
  assert.equal(none.loss, 50n * ZETA, 'without prices only the native coin counts');
});

test('replay refuses: transactions outside the block range, a range too close to the head, the wrong chain', async () => {
  const i = await incident();
  await assert.rejects(runReplay(request(i, { toBlock: i.to - 1n }), { source: i.source, engine: memEngine() }), /outside/);
  await assert.rejects(runReplay(request(i), { source: i.source, engine: memEngine(), confirmations: 1000 }), /behind the head/);
  await assert.rejects(runReplay(request(i, { chainId: 77390 }), { source: i.source, engine: memEngine() }), /not 77390/);
  await assert.rejects(runReplay(request(i, { txHashes: ['0x' + 'ee'.repeat(32)] }), { source: i.source, engine: memEngine() }), /not on chain/);
});

test('a tampered report is caught: its hash changes, and evidence that does not match is reported', async () => {
  const i = await incident();
  const { report, hash } = await runReplay(request(i), { source: i.source, engine: memEngine() });
  const t = JSON.parse(JSON.stringify(report));
  t.loss = (BigInt(t.loss) + 1n).toString();
  assert.notEqual(checkReport(t).hash, hash);
  const e = JSON.parse(JSON.stringify(report));
  e.toBlock = String(BigInt(e.toBlock) + 1n);
  assert.match(checkReport(e).problems.join(';'), /evidenceHash/);
  assert.deepEqual(tokensMoved([{ logs: [{ address: i.token.address, topics: [TRANSFER_TOPIC, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)], data: '0x' }] }], i.vault.address), [], 'transfers not touching the target are ignored');
});

test('committee: runners recompute and approve a claim that restates their report; a claim with another loss is rejected', async () => {
  const i = await incident();
  const { report, hash, loss } = await runReplay(request(i), { source: i.source, engine: memEngine() });
  const { c, ins } = i;
  const file = async (claimLoss) => {
    await ins.send('holder', 'fileClaim', [0, report.txHashes, i.from, i.to, hash, claimLoss, 'neuro-forensic:replay.json'], ZETA);
    return (await ins.call('claimCount')) - 1n;
  };
  const decide = async (id) => {
    const k = await ins.call('claims', [id]);
    const cv = await ins.call('covers', [k.coverId]);
    const mine = await runReplay(requestOf(report), { source: i.source, engine: memEngine() }); // each runner's own replay
    return voteDecision({ claim: k, cover: cv, insuranceChainId: 1n, report: mine.report, hash: mine.hash });
  };
  const id = await file(loss);
  for (const w of ['w1', 'w2']) {
    const d = await decide(id);
    assert.equal(d.approve, true, d.reasons.join('; '));
    await ins.send(w, 'vote', [id, d.approve, d.reportHash, d.loss]);
  }
  assert.equal((await ins.call('claims', [id])).state, 2n, 'Approved');
  // overturn that one through governance so the cover can carry a second (wrong) claim
  await ins.send('user', 'dispute', [id, 'test'], 5n * ZETA);
  await ins.send('gov', 'resolveDispute', [id, false]);
  const bad = await file(loss + 1n);
  const d = await decide(bad);
  assert.equal(d.approve, false);
  assert.match(d.reasons.join('; '), /loss .* differs/);
  for (const w of ['w1', 'w2']) await ins.send(w, 'vote', [bad, d.approve, d.reportHash, d.loss]);
  assert.equal((await ins.call('claims', [bad])).state, 3n, 'Rejected');
  // the cover's end is checked against the transactions' own timestamps
  const late = voteDecision({ claim: await ins.call('claims', [bad]), cover: { target: i.target, end: 1n }, insuranceChainId: 1n, report, hash });
  assert.match(late.reasons.join('; '), /after the cover's end/);
  c.advance(1);
});
