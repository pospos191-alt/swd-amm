// Federated learning for Neuro's model (ml/fl/): head, privacy, wire format,
// robust aggregation, the canary gate, and simulated honest vs poisoned clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkModel, probability } from '../model.js';
import { scoreReport } from '../combine.js';
import { rng } from '../lib/rng.js';
import { zeroHead, checkHead, sealHead, applyDelta, headInputs, headProbability, headDim, DEFAULT_HEAD_FEATURES } from '../fl/head.js';
import { rhoPerRound, epsilonOf, rhoFor, roundsAllowed, clipL2, l2, privatize, gaussian, cryptoUniform, PrivacyLedger, DEFAULT_PRIVACY } from '../fl/dp.js';
import { encodeUpdate, decodeUpdate, toBase64, fromBase64, signText, HEADER } from '../fl/codec.js';
import { aggregateRound, trimmedMean, coordMedian, plainMean, rejectReason, boundedInfluence } from '../fl/aggregate.js';
import { localDelta, makeExample, clientUpdate } from '../fl/client.js';
import { gateHead } from '../fl/gate.js';
import { simulate, makeWorld } from '../fl/simulate.js';
import { currentManifest } from '../fl/manifest.js';

const MODEL = checkModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
const EVASIONS = readFileSync(new URL('../data/redteam/evasions.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const GAPS = new Set(JSON.parse(readFileSync(new URL('../data/redteam/known-gaps.json', import.meta.url), 'utf8')).gaps.map((g) => g.id));
const HASH = 'cd'.repeat(32);

test('a zero head is exactly the committed model', async () => {
  const head = await sealHead(zeroHead(MODEL));
  checkHead(MODEL, head);
  assert.equal(head.dim, headDim(MODEL));
  assert.equal(head.dim, 2 + DEFAULT_HEAD_FEATURES.length);
  for (const r of [...MODEL.check, ...EVASIONS]) assert.equal(headProbability(MODEL, head, r.f), probability(MODEL, r.f));
  const committed = JSON.parse(readFileSync(new URL('../fl/head.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, head, 'ml/fl/head.json is the sealed zero head for ml/model.json');
});

test('head inputs: bias, GBDT margin, clamped named features, optional tree leaves', () => {
  const h = zeroHead(MODEL, { features: ['r_level', 'o_size'], clampX: 2 });
  const phi = headInputs(MODEL, h, { r_level: 3, o_size: -10 });
  assert.equal(phi.length, 4);
  assert.equal(phi[0], 1);
  assert.equal(phi[2], 2); // clamped
  assert.equal(phi[3], -2);
  const hl = zeroHead(MODEL, { features: [], leaves: true });
  const p2 = headInputs(MODEL, hl, MODEL.check[0].f);
  assert.equal(p2.length, 2 + MODEL.trees.length);
  const sum = MODEL.base + p2.slice(2).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - p2[1]) < 1e-9, 'leaf values add up to the margin');
  assert.throws(() => headInputs(MODEL, zeroHead(MODEL, { features: ['nope'] }), {}), /not in the model/);
});

test('combine: a head changes p only for its own model; zero head = no head', async () => {
  const head = await sealHead(zeroHead(MODEL));
  const report = { analysis: { level: 'info', findings: [] } };
  const a = scoreReport(MODEL, report);
  const b = scoreReport(MODEL, report, { head });
  assert.equal(b.p, a.p);
  assert.equal(b.head, head.id);
  const raised = { ...head, theta: head.theta.map((w, i) => (i === 0 ? 3 : w)) };
  assert.ok(scoreReport(MODEL, report, { head: raised }).p > a.p);
  assert.throws(() => scoreReport(MODEL, report, { head: { ...head, model: 'nml-other' } }), /head is for model/);
  assert.throws(() => scoreReport(MODEL, report, { head: { ...head, theta: head.theta.map(() => 10) } }), /trust region/);
});

test('trust region: applyDelta never leaves ||theta|| <= maxNorm', () => {
  let h = zeroHead(MODEL, { maxNorm: 2 });
  const R = rng('tr');
  for (let i = 0; i < 20; i++) h = applyDelta(h, Array.from({ length: h.dim }, () => (R.float() - 0.5) * 5));
  assert.ok(l2(h.theta) <= 2 + 1e-9);
  assert.equal(h.round, 20);
  checkHead(MODEL, h);
});

test('sealHead: same weights -> same hash; any weight change -> another', async () => {
  const a = await sealHead(zeroHead(MODEL));
  const b = await sealHead(zeroHead(MODEL));
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.id, 'nfh-' + a.hash.slice(0, 12));
  const c = await sealHead({ ...a, theta: a.theta.map((w, i) => (i === 3 ? 1e-6 : w)) });
  assert.notEqual(c.hash, a.hash);
});

test('privacy accounting: zCDP of the local Gaussian mechanism', () => {
  assert.equal(rhoPerRound(2), 0.5);
  assert.equal(rhoPerRound(0), Infinity);
  assert.ok(Math.abs(epsilonOf(0.5, 1e-5) - (0.5 + 2 * Math.sqrt(0.5 * Math.log(1e5)))) < 1e-12);
  assert.ok(Math.abs(epsilonOf(0.5) - 5.298) < 1e-3);
  for (const eps of [1, 5.3, 16]) assert.ok(Math.abs(epsilonOf(rhoFor(eps)) - eps) < 1e-9);
  assert.equal(roundsAllowed(2, 16), 6);
  assert.equal(roundsAllowed(2, 5), 0);
  const L = new PrivacyLedger({ epsBudget: 16 });
  for (let r = 0; r < 6; r++) L.record(r, 2);
  assert.equal(L.refuse(6, 2), 'privacy budget used up');
  assert.equal(L.refuse(3, 2), 'already submitted for this round');
  assert.throws(() => L.record(6, 2));
  assert.ok(L.epsilon <= 16);
  const back = new PrivacyLedger(JSON.parse(JSON.stringify(L)));
  assert.equal(back.rho, L.rho);
});

test('clip + noise: norm bounded before noise, noise has std z x C', () => {
  const v = Float64Array.from({ length: 50 }, (_, i) => i);
  assert.ok(Math.abs(l2(clipL2(v, 1)) - 1) < 1e-12);
  assert.deepEqual([...clipL2([0.1, 0.2], 1)], [0.1, 0.2]);
  const R = rng('noise');
  const zeros = new Float64Array(20000);
  const out = privatize(zeros, { clip: 0.5, z: 2 }, R.float);
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length);
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
  const g = gaussian(cryptoUniform());
  for (let i = 0; i < 1000; i++) assert.ok(Number.isFinite(g()));
  const u = cryptoUniform();
  for (let i = 0; i < 1000; i++) { const x = u(); assert.ok(x > 0 && x < 1); }
});

test('local update: learns from labels, is clipped and noised', () => {
  const head = zeroHead(MODEL);
  const scam = MODEL.check.find((r) => r.p < 0.5) ?? MODEL.check[0];
  const ex = Array.from({ length: 4 }, () => makeExample(MODEL, head, scam.f, 1));
  const d = localDelta(MODEL, head, ex);
  const after = applyDelta(head, d);
  assert.ok(headProbability(MODEL, after, scam.f) > headProbability(MODEL, head, scam.f), 'a "this was a trap" label raises the score');
  assert.equal(l2(localDelta(MODEL, head, [])), 0);
  assert.throws(() => makeExample(MODEL, head, scam.f, 2));
  const R = rng('cu');
  const u = clientUpdate(MODEL, head, ex, { privacy: { clip: 1, z: 0 }, uniform: R.float });
  assert.ok(l2(u) <= 1 + 1e-12);
  const noisy = clientUpdate(MODEL, head, ex, { uniform: R.float });
  assert.equal(noisy.length, head.dim);
  assert.equal(DEFAULT_PRIVACY.z, 2);
});

test('wire format: round trip, fixed point, refuses malformed bytes', () => {
  const values = [0.5, -1.25, 1e-7, 3000, -3000];
  const b = encodeUpdate({ headHash: HASH, round: 7, clip: 1, z: 2, values });
  assert.equal(b.length, HEADER + 4 * values.length);
  const u = decodeUpdate(b);
  assert.equal(u.headHash, HASH);
  assert.equal(u.round, 7);
  assert.equal(u.clip, 1);
  assert.equal(u.z, 2);
  assert.deepEqual([...u.values], [0.5, -1.25, 0, 2147.483647, -2147.483647]);
  assert.deepEqual(fromBase64(toBase64(b)), b);
  assert.deepEqual(encodeUpdate({ headHash: HASH, round: 7, clip: 1, z: 2, values: u.values }), encodeUpdate({ headHash: HASH, round: 7, clip: 1, z: 2, values: u.values }));
  assert.throws(() => decodeUpdate(b.slice(0, b.length - 1)), /length/);
  assert.throws(() => decodeUpdate(Uint8Array.from([1, 2, 3])), /not a Neuro/);
  assert.throws(() => encodeUpdate({ headHash: 'xx', round: 1, clip: 1, z: 1, values: [1] }));
  assert.throws(() => encodeUpdate({ headHash: HASH, round: 1, clip: 1, z: 1, values: [NaN] }));
  assert.throws(() => encodeUpdate({ headHash: HASH, round: -1, clip: 1, z: 1, values: [1] }));
  assert.match(signText('ab'), /^Neuro federated update v1\nsha256:ab$/);
});

test('robust statistics', () => {
  const vs = [[1, 10], [2, 20], [3, 30], [4, 40], [100, -1000]];
  assert.deepEqual([...plainMean(vs)], [22, -180]);
  assert.deepEqual([...coordMedian(vs)], [3, 20]);
  assert.deepEqual([...trimmedMean(vs, 0.2)], [3, 20]);
  assert.deepEqual([...coordMedian([[1], [3]])], [2]);
  assert.throws(() => trimmedMean(vs, 0.6));
});

test('aggregation: shape checks, one update per sender, order does not matter', () => {
  const round = { headHash: HASH, round: 3, dim: 4, clip: 1, z: 1 };
  const R = rng('agg');
  const ok = (k) => ({ sender: `0x${k}`, bytes: encodeUpdate({ ...round, values: privatize([0.3, -0.2, 0.1, 0], round, R.float) }) });
  const subs = Array.from({ length: 25 }, (_, k) => ok(k));
  subs.push({ sender: '0x1', bytes: encodeUpdate({ ...round, values: [5, 5, 5, 5] }) }); // duplicate sender
  subs.push({ sender: '0xbig', bytes: encodeUpdate({ ...round, values: [7.5, 0, 0, 0] }) }); // > C + 6 zC
  subs.push({ sender: '0xold', bytes: encodeUpdate({ ...round, round: 2, values: [0, 0, 0, 0] }) });
  subs.push({ sender: '0xnoise', bytes: encodeUpdate({ ...round, z: 0.5, values: [0, 0, 0, 0] }) });
  subs.push({ sender: '0xjunk', bytes: Uint8Array.from([9, 9]) });
  const res = aggregateRound(subs, round, { minUpdates: 20 });
  assert.equal(res.accepted.length, 24, 'both updates of a sender who sent two are dropped');
  const why = Object.fromEntries(res.rejected.map((r) => [r.sender, r.why]));
  assert.equal(why['0x1'], 'duplicate sender');
  assert.equal(why['0xbig'], 'coordinate out of range');
  assert.equal(why['0xold'], 'wrong round');
  assert.equal(why['0xnoise'], 'wrong noise multiplier');
  assert.match(why['0xjunk'], /not a Neuro/);
  const again = aggregateRound([...subs].reverse(), round, { minUpdates: 20 });
  assert.deepEqual([...again.delta], [...res.delta]);
  assert.equal(aggregateRound(subs.slice(0, 5), round).delta, null);
  // norm check: every coordinate in range but too many of them large
  const r2 = { headHash: HASH, round: 0, dim: 400, clip: 1, z: 1 };
  assert.equal(rejectReason(decodeUpdate(encodeUpdate({ ...r2, values: new Array(400).fill(6) })), r2), 'norm out of range');
  assert.equal(rejectReason(decodeUpdate(encodeUpdate({ ...r2, headHash: 'ef'.repeat(32), values: new Array(400).fill(0) })), r2), 'computed on another head');
});

test('poisoning bound: with attackers <= trim share, every coordinate stays within the honest range', () => {
  const R = rng('bound');
  const round = { headHash: HASH, round: 0, dim: 30, clip: 1, z: 2 };
  for (const method of ['trimmed', 'median']) {
    for (let trial = 0; trial < 20; trial++) {
      const honest = Array.from({ length: 80 }, () => privatize(Array.from({ length: 30 }, () => R.float() - 0.3), round, R.float));
      // 20%: three coordinates at the limit (C + 6zC = 13), the rest pulled down, within the norm check
      const evil = Array.from({ length: 20 }, () => Array.from({ length: 30 }, (_, i) => (i % 10 === 0 ? 12.9 : -1)));
      const subs = [...honest, ...evil].map((v, k) => ({ sender: `0x${k}`, bytes: encodeUpdate({ ...round, values: v }) }));
      const res = aggregateRound(subs, round, { method, trim: 0.2 });
      assert.equal(res.accepted.length, 100);
      const decodedHonest = subs.slice(0, 80).map((s) => decodeUpdate(s.bytes).values);
      assert.ok(boundedInfluence(res.delta, decodedHonest), `${method} trial ${trial}`);
    }
  }
  // the plain mean has no such bound
  const honest = Array.from({ length: 80 }, () => new Float64Array(3).fill(0.1));
  const evil = Array.from({ length: 20 }, () => new Float64Array(3).fill(-12));
  assert.equal(boundedInfluence(plainMean([...honest, ...evil]), honest), false);
});

test('gate: refuses a head that lowers recorded evasions or real scams; accepts the zero head', () => {
  const zero = zeroHead(MODEL);
  const canaries = EVASIONS.filter((r) => !GAPS.has(r.id)).map((r) => ({ ...r, strict: true }));
  assert.equal(gateHead(MODEL, zero, zero, canaries).ok, true);
  const down = { ...zero, theta: zero.theta.map((w, i) => (i === 0 ? -3 : w)) };
  const g = gateHead(MODEL, zero, down, canaries);
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /recorded evasion/);
  const benign = MODEL.check.map((r) => ({ f: r.f, label: 0 }));
  const up = { ...zero, theta: zero.theta.map((w, i) => (i === 0 ? 8 : w)) };
  const g2 = gateHead(MODEL, zero, up, benign, { maxFprRise: 0 });
  assert.equal(g2.ok, false);
  assert.match(g2.reasons.join(' '), /false alarms/);
});

test('committed manifest matches ml/model.json and ml/fl/head.json byte for byte', async () => {
  const { text, hash } = await currentManifest();
  assert.equal(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'), text);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

// ---- simulation (synthetic; see docs/future/federated.md) ----
const WORLD = makeWorld();
const SIM = { world: WORLD, rounds: 30 };

test('simulation: honest browsers improve the model on the drifted world', () => {
  const r = simulate(SIM);
  assert.ok(r.after.auc > r.before.auc + 0.03, `AUC ${r.before.auc} -> ${r.after.auc}`);
  assert.ok(r.after.acc > r.before.acc + 0.05, `accuracy ${r.before.acc} -> ${r.after.acc}`);
  assert.ok(l2(r.head.theta) <= 4 + 1e-9);
  // deterministic for a seed
  const again = simulate(SIM);
  assert.deepEqual(again.head.theta, r.head.theta);
});

test('simulation: 20% label flippers do not undo the gain (trimmed mean)', () => {
  const r = simulate({ ...SIM, attackers: 0.2, attack: 'flip' });
  assert.ok(r.after.auc > r.before.auc, `AUC ${r.before.auc} -> ${r.after.auc}`);
});

test('simulation: a colluding push-down attack wrecks the plain mean, is bounded by the trimmed mean, stopped by the gate', () => {
  const mean = simulate({ ...SIM, attackers: 0.15, attack: 'push', method: 'mean', gate: false });
  const trimmed = simulate({ ...SIM, attackers: 0.15, attack: 'push', gate: false });
  const gated = simulate({ ...SIM, attackers: 0.15, attack: 'push' });
  assert.ok(mean.after.auc < 0.5, `plain mean AUC ${mean.after.auc}`);
  assert.ok(trimmed.after.auc > mean.after.auc + 0.1, `trimmed ${trimmed.after.auc} vs mean ${mean.after.auc}`);
  assert.ok(gated.after.auc >= gated.before.auc - 0.005, `gated AUC ${gated.before.auc} -> ${gated.after.auc}`);
  assert.ok(gated.refused > 0);
  for (const r of [mean, trimmed, gated]) assert.ok(l2(r.head.theta) <= 4 + 1e-9, 'trust region holds under attack');
});
