// Federated learning, the browser side (docs/future/federated.md, item 6): automatic and user
// labels (ml/fl/labels.js), the deployment record (ml/fl/deployment.js), the browser's
// FederatedRounds client (ml/fl/rounds.js), one round's update (client.js roundUpdate),
// the panel's words in 8 languages (web/fl-i18n.js), and the label-noise simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkModel } from '../model.js';
import { checkHead } from '../fl/head.js';
import { decodeUpdate } from '../fl/codec.js';
import { roundUpdate } from '../fl/client.js';
import { aggregateRound } from '../fl/aggregate.js';
import { rng } from '../lib/rng.js';
import { simulate, makeWorld } from '../fl/simulate.js';
import { scanEntry, observation, autoLabel, finalLabel, labelledExamples, dueForRecheck, signals, sparseFeatures, poolLiquidity, threatFlagged, DEFAULT_LABELING, LABEL_SELECTORS } from '../fl/labels.js';
import { checkDeployment } from '../fl/deployment.js';
import { commitmentFor, revealData, commitData, SELECTORS, roundsClient, keccakHex } from '../fl/rounds.js';
import { selectorOf } from '../../src/keccak.js';
import { FL_TEXT, FL_LANGS, flText, fill } from '../../web/fl-i18n.js';

const MODEL = checkModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
const HEAD = checkHead(MODEL, JSON.parse(readFileSync(new URL('../fl/head.json', import.meta.url), 'utf8')));
const DAY = 86_400_000; const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const base = (o = {}) => ({ ...scanEntry({ chain: 'bsc', chainId: 56, address: '0x' + 'ab'.repeat(20), features: { r_level: 1, o_size: 0 }, sim: { stage: 'done', pair: '0x' + 'cd'.repeat(20) }, liquidity: '1000', flagged: false, at: T0 }), ...o });
const obs = (days, o) => observation({ at: T0 + days * DAY, ...o });

test('scan entry: sparse features, scan-time pool, liquidity and flag; nothing else', () => {
  const e = base();
  assert.deepEqual(e.f, { r_level: 1 });
  assert.equal(e.id, `bsc:0x${'ab'.repeat(20)}`);
  assert.equal(e.sim0, 'done');
  assert.equal(e.liq0, '1000');
  assert.equal(e.flag0, false);
  assert.deepEqual(sparseFeatures({ a: 1.23456789, b: 0, c: NaN }), { a: 1.23457 });
});

test('automatic labels: pulled liquidity, confirmed twice 12 h apart, used only after the delay', () => {
  const e = base({ obs: [obs(1, { sim: { stage: 'done' }, liquidity: '50' })] });
  assert.deepEqual(signals(e, e.obs[0]), ['liquidity-pulled']);
  let a = autoLabel(e, T0 + 5 * DAY);
  assert.equal(a.label, null);
  assert.equal(a.why, 'confirming');
  e.obs.push(obs(1.25, { sim: { stage: 'done' }, liquidity: '40' }));
  assert.equal(autoLabel(e, T0 + 5 * DAY).why, 'confirming', '6 h apart is not enough');
  e.obs.push(obs(2, { sim: { stage: 'no-liquidity' }, liquidity: '0' }));
  a = autoLabel(e, T0 + 2.1 * DAY);
  assert.equal(a.label, null);
  assert.equal(a.why, 'delay', 'confirmed but younger than minDelayDays');
  a = autoLabel(e, T0 + DEFAULT_LABELING.minDelayDays * DAY + 1);
  assert.deepEqual([a.label, a.source], [1, 'liquidity-pulled']);
  // liquidity back in the latest reading: the signal is not used
  e.obs.push(obs(3.5, { sim: { stage: 'done' }, liquidity: '900' }));
  assert.equal(autoLabel(e, T0 + 4 * DAY).label, null);
  assert.equal(autoLabel(e, T0 + 4 * DAY).why, 'mixed');
});

test('automatic labels: sell failure; a ThreatRegistry flag only when it was not there at scan time', () => {
  const sell = base({ obs: [obs(1, { sim: { stage: 'sell-failed' } }), obs(2, { sim: { stage: 'sell-failed' } })] });
  assert.deepEqual([autoLabel(sell, T0 + 4 * DAY).label, autoLabel(sell, T0 + 4 * DAY).source], [1, 'sell-failed']);
  const flagged = base({ obs: [obs(1, { sim: { stage: 'done' }, liquidity: '1000', flagged: true }), obs(2, { sim: { stage: 'done' }, liquidity: '1000', flagged: true })] });
  assert.equal(autoLabel(flagged, T0 + 4 * DAY).source, 'threat-flagged');
  const known = { ...flagged, flag0: true };
  assert.equal(autoLabel(known, T0 + 4 * DAY).label, null, 'flagged already when scanned: not an outcome');
  // a flag cleared on appeal before the latest reading: no label
  flagged.obs.push(obs(3, { sim: { stage: 'done' }, liquidity: '1000', flagged: false }));
  assert.equal(autoLabel(flagged, T0 + 4 * DAY).label, null);
});

test('automatic labels: "traded normally" (0) only after 30 days of clean readings, never after a positive signal', () => {
  const ok = (d) => obs(d, { sim: { stage: 'done', sellTax: 2 }, liquidity: '800', flagged: false });
  const e = base({ obs: [ok(5), ok(20)] });
  assert.equal(autoLabel(e, T0 + 25 * DAY).why, 'too-early');
  e.obs.push(ok(31), ok(32));
  assert.deepEqual([autoLabel(e, T0 + 33 * DAY).label, autoLabel(e, T0 + 33 * DAY).source], [0, 'traded-normally']);
  const taxed = base({ obs: [ok(31), obs(32, { sim: { stage: 'done', sellTax: 40 }, liquidity: '800' })] });
  assert.equal(autoLabel(taxed, T0 + 33 * DAY).label, null, 'a high sell tax is not normal trading');
  const thin = base({ obs: [ok(31), obs(32, { sim: { stage: 'done', sellTax: 1 }, liquidity: '300' })] });
  assert.equal(autoLabel(thin, T0 + 33 * DAY).label, null, 'lost half its pool');
  const once = base({ obs: [obs(2, { sim: { stage: 'sell-failed' } }), ok(31), ok(32)] });
  assert.equal(autoLabel(once, T0 + 33 * DAY).why, 'mixed');
  // a scan the simulator could not trade at all (no pool / no override) never becomes "normal"
  const noSim = base({ sim0: null, liq0: null, obs: [obs(31, { sim: { stage: 'no-override' } }), obs(32, { sim: { stage: 'no-override' } })] });
  assert.equal(autoLabel(noSim, T0 + 33 * DAY).label, null);
});

test('final label: the user\'s answer, the automatic one, and a conflict drops the example', () => {
  const pulled = base({ obs: [obs(1, { liquidity: '1' }), obs(2, { liquidity: '1' })] });
  const now = T0 + 4 * DAY;
  assert.deepEqual(finalLabel(pulled, now).label, 1);
  assert.equal(finalLabel(pulled, now).from, 'auto');
  assert.deepEqual(finalLabel({ ...pulled, user: 1 }, now).from, 'both');
  const c = finalLabel({ ...pulled, user: 0 }, now);
  assert.equal(c.label, null);
  assert.equal(c.conflict, true);
  assert.deepEqual(finalLabel(base({ user: 0 }), now).label, 0);
  const rows = labelledExamples([base({ user: 1 }), base({ user: null }), { ...pulled, user: 0 }, pulled], now);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.y === 1 && r.f.r_level === 1));
});

test('re-check schedule: due after 12 h, not when settled at 0, not after the window', () => {
  const fresh = base({ obs: [] });
  assert.equal(dueForRecheck([fresh], T0 + 6 * HOUR).length, 0);
  assert.equal(dueForRecheck([fresh], T0 + 13 * HOUR).length, 1);
  const ok = (d) => obs(d, { sim: { stage: 'done', sellTax: 0 }, liquidity: '1000', flagged: false });
  assert.equal(dueForRecheck([base({ obs: [ok(31), ok(32)] })], T0 + 40 * DAY).length, 0, 'settled');
  assert.equal(dueForRecheck([base({ obs: [] })], T0 + 70 * DAY).length, 0, 'too old');
});

test('chain reads for labels: the pool\'s native side and ThreatRegistry views', async () => {
  const W = '0x' + 'ee'.repeat(20); const TOK = '0x' + '11'.repeat(20); const PAIR = '0x' + '22'.repeat(20); const REG = '0x' + '33'.repeat(20);
  const w = (v) => BigInt(v).toString(16).padStart(64, '0');
  const answers = { [LABEL_SELECTORS.GET_RESERVES]: '0x' + w(500) + w(7) + w(0), [LABEL_SELECTORS.TOKEN0]: '0x' + '0'.repeat(24) + TOK.slice(2) };
  const call = async (m, [{ to, data }]) => { assert.equal(m, 'eth_call'); if (to === PAIR) return answers[data]; if (to === REG) return data.startsWith(LABEL_SELECTORS.IS_FLAGGED) ? '0x' + w(1) + w(1) : '0x' + w(0) + w(0); throw new Error('x'); };
  assert.equal(await poolLiquidity(call, PAIR, W), '7', 'token0 is the token: the native coin is reserve1');
  answers[LABEL_SELECTORS.TOKEN0] = '0x' + '0'.repeat(24) + W.slice(2);
  assert.equal(await poolLiquidity(call, PAIR, W), '500');
  assert.equal(await poolLiquidity(call, 'nope', W), null);
  assert.equal(await threatFlagged(call, REG, { chainId: 56, address: TOK }), false);
  assert.equal(await threatFlagged(call, REG, { chainId: 56, address: TOK, fingerprint: 'fp1:' + 'aa'.repeat(32) }), true);
  assert.equal(await threatFlagged(call, null, { chainId: 56, address: TOK }), null);
  assert.equal(LABEL_SELECTORS.IS_ADDRESS_FLAGGED, '0x' + selectorOf('isAddressFlagged(uint256,address)'));
  assert.equal(LABEL_SELECTORS.IS_FLAGGED, '0x' + selectorOf('isFlagged(bytes32)'));
});

test('deployment record: the committed file is a valid record (deployed on 77390, or "not deployed yet"); bad records are refused', () => {
  const d = checkDeployment(JSON.parse(readFileSync(new URL('../fl/deployment.json', import.meta.url), 'utf8')));
  assert.equal(d.chainId, 77390);
  assert.match(d.rpc, /^https:\/\//);
  if (d.deployed) assert.match(d.rounds, /^0x[0-9a-fA-F]{40}$/);
  else assert.equal(d.rounds, null);
  assert.equal(checkDeployment({ ...d, rounds: null }).deployed, false);
  const ok = { ...d, rounds: '0x' + '12'.repeat(20) };
  assert.equal(checkDeployment(ok).deployed, true);
  assert.throws(() => checkDeployment({ ...ok, rounds: '0x12' }), /rounds/);
  assert.throws(() => checkDeployment({ ...ok, rpc: 'javascript:alert(1)' }), /rpc/);
  assert.throws(() => checkDeployment({ ...ok, format: 'x' }), /not a Neuro/);
});

test('browser FederatedRounds client: selectors, commitment and calldata layout', async () => {
  assert.equal(SELECTORS.commit, selectorOf('commit(uint256,bytes32)'));
  const payload = Uint8Array.from([1, 2, 3]);
  const salt = '0x' + '5'.repeat(64);
  const sender = '0x' + 'ab'.repeat(20);
  const inner = keccakHex(payload).slice(2) + '5'.repeat(64) + '0'.repeat(24) + 'ab'.repeat(20);
  assert.equal(commitmentFor(payload, salt, sender), keccakHex(Uint8Array.from(inner.match(/../g), (x) => parseInt(x, 16))));
  const d = revealData(2, salt, payload);
  assert.equal(d.length, 2 + 8 + 64 * 5);
  assert.ok(d.endsWith('010203' + '0'.repeat(58)));
  assert.equal(commitData(1, salt).length, 2 + 8 + 128);
  assert.throws(() => commitmentFor(payload, '0x12', sender), /bytes32/);
  assert.throws(() => roundsClient(async () => '0x', 'nope'), /address/);
  // status() from raw words
  const w = (v) => BigInt(v).toString(16).padStart(64, '0');
  const views = { phaseAt: w(2) + w(2), paused: w(0), start: w(100), commitBlocks: w(50), revealBlocks: w(50), maxPerRound: w(9), commits: w(4), reveals: w(1), commitmentOf: w(7), revealed: w(0) };
  const bySel = Object.fromEntries(Object.entries(SELECTORS).map(([k, v]) => [v, k]));
  const req = async (m, p) => (m === 'eth_blockNumber' ? '0x' + (360).toString(16) : '0x' + views[bySel[p[0].data.slice(2, 10)]]);
  const s = await roundsClient(req, '0x' + '99'.repeat(20)).status(sender);
  assert.deepEqual([s.round, s.phase, s.paused, s.commits, s.reveals, s.committed, s.revealed, s.blocksLeft], [2n, 2, false, 4n, 1n, true, false, 40n]);
});

test('one round\'s update from stored labels: the round\'s head hash, clip and noise; accepted by the aggregator', () => {
  const R = rng('round-update');
  const rows = [...MODEL.check.slice(0, 3).map((r) => ({ f: sparseFeatures(r.f), y: 1 })), { f: sparseFeatures(MODEL.check[3].f), y: 0 }];
  const subs = [];
  for (let i = 0; i < 20; i++) {
    const u = roundUpdate(MODEL, HEAD, rows, { round: 4, uniform: R.float });
    assert.equal(u.dim, HEAD.dim);
    assert.equal(u.n, 4);
    subs.push({ sender: `0x${(i + 1).toString(16).padStart(40, '0')}`, bytes: u.bytes });
  }
  const back = decodeUpdate(subs[0].bytes);
  assert.equal(back.headHash, HEAD.hash);
  assert.equal(back.round, 4);
  assert.deepEqual([back.clip, back.z], [1, 2]);
  const res = aggregateRound(subs, { headHash: HEAD.hash, round: 4, dim: HEAD.dim, clip: 1, z: 2 }, { minUpdates: 20 });
  assert.equal(res.accepted.length, 20);
  assert.throws(() => roundUpdate(MODEL, HEAD, [], { round: 1 }), /no labelled/);
  assert.throws(() => roundUpdate(MODEL, { ...HEAD, hash: undefined }, rows, { round: 1 }), /hash/);
});

test('panel words: the same keys and placeholders in all 8 languages', () => {
  assert.deepEqual(FL_LANGS, ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th']);
  const keys = Object.keys(FL_TEXT.en).sort();
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const l of FL_LANGS) {
    assert.deepEqual(Object.keys(FL_TEXT[l]).sort(), keys, l);
    for (const k of keys) {
      assert.ok(FL_TEXT[l][k].trim().length, `${l}.${k}`);
      assert.equal(ph(FL_TEXT[l][k]), ph(FL_TEXT.en[k]), `${l}.${k} placeholders`);
    }
  }
  assert.equal(flText('id').title, FL_TEXT.en.title, 'other languages fall back to English');
  assert.equal(fill('a {x} b', { x: 1 }), 'a 1 b');
  // every reason code labels.js can return has words
  for (const w of ['no-observation', 'delay', 'confirming', 'mixed', 'too-early', 'few-observations']) assert.ok(FL_TEXT.en[`w_${w.replace(/-/g, '_')}`], w);
  for (const s of ['sell-failed', 'liquidity-pulled', 'threat-flagged', 'traded-normally']) assert.ok(FL_TEXT.en[`src_${s.replace(/-/g, '_')}`], s);
});

test('simulation: symmetric label noise costs little; many missed scams (automatic "traded normally" wrong) undo the gain', () => {
  const world = makeWorld();
  const mild = simulate({ world, rounds: 30, labelNoise: { fp: 0.1, fn: 0.1 } });
  const missed = simulate({ world, rounds: 30, labelNoise: { fp: 0.1, fn: 0.3 } });
  assert.ok(mild.after.auc > mild.before.auc + 0.03 && mild.after.acc > mild.before.acc + 0.05, `mild noise AUC ${mild.after.auc}, accuracy ${mild.after.acc}`);
  // scores pushed down: accuracy falls BELOW the untouched model's, and the canary gate does not catch it
  assert.ok(missed.after.acc < missed.before.acc, `missed-scam noise accuracy ${missed.before.acc} -> ${missed.after.acc}`);
  assert.ok(missed.after.auc < mild.after.auc - 0.03, `missed-scam noise AUC ${missed.after.auc} vs ${mild.after.auc}`);
});
