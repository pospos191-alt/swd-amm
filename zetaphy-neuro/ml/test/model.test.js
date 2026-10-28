import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trainGBDT, trainerMargin, fitPlatt, makeThresholds } from '../train/gbdt.js';
import { trainModel, split, vec, evaluateModel, isBetter } from '../train/train.js';
import { auc, recallAtFpr, ece } from '../train/metrics.js';
import { margin, probability, explainPrediction, checkModel, modelLevel } from '../model.js';
import { FEATURES } from '../features.js';
import { rng } from '../lib/rng.js';

/** A small labelled set over real feature names: risk rises with a few of them, plus noise. */
function toyRows(n, seed = 'toy') {
  const R = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const f = {
      r_level: R.int(4), r_ctl_renounced: R.bool(0.3) ? 1 : 0, p_time_gate: R.bool(0.2) ? R.float() : 0,
      m_sim_cannot_sell: R.bool(0.15) ? 1 : 0, k_top_holder: R.float(), k_top_holder_known: 1, o_rate_sstore: R.float() * 5,
    };
    const z = -2 + 0.9 * f.r_level + 3 * f.m_sim_cannot_sell + 2.5 * f.p_time_gate - 1.2 * f.r_ctl_renounced + 1.5 * f.k_top_holder + (R.float() - 0.5) * 2;
    rows.push({ id: `toy-${seed}-${i}`, label: R.float() < 1 / (1 + Math.exp(-z)) ? 1 : 0, family: 'toy', src: 'synthetic-sol', level: 'info', rulesLevel: 'info', f });
  }
  return rows;
}

test('training is deterministic for a seed (byte-identical export)', () => {
  const rows = toyRows(400);
  const s = split(rows);
  const a = trainModel(s.train, s.calib, { trees: 25, seed: 's1' });
  const b = trainModel(s.train, s.calib, { trees: 25, seed: 's1' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = trainModel(s.train, s.calib, { trees: 25, seed: 's2' });
  assert.notEqual(JSON.stringify(a.trees), JSON.stringify(c.trees), 'another seed samples other rows');
});

test('inference parity: exported JSON in plain JS = the trainer, bit for bit', () => {
  const R = rng('parity');
  const X = Array.from({ length: 300 }, () => Array.from({ length: 6 }, () => (R.bool(0.2) ? 0 : R.float() * 10 - 3)));
  const y = X.map((r) => (r[0] + r[1] * r[2] > 4 ? 1 : 0));
  const m = trainGBDT(X, y, { trees: 40, depth: 3, seed: 'p' });
  const exported = checkModel(JSON.parse(JSON.stringify({ format: 'neuro-ml-gbdt/1', features: ['a', 'b', 'c', 'd', 'e', 'f'], base: m.base, trees: m.trees, calib: { a: 1, b: 0 } })));
  for (let i = 0; i < X.length; i++) {
    assert.equal(margin(exported, X[i]), trainerMargin(m, X[i]), `row ${i}`);
    assert.equal(margin(exported, X[i]), m.trainMargin[i], `row ${i} (training-time margin)`);
  }
  // thresholds sit between data values, so a value exactly on a threshold goes left in both
  const t = makeThresholds(X)[0];
  assert.ok(t.length > 0);
});

test('explanations add up: bias + contributions = calibrated logit', () => {
  const rows = toyRows(400, 'expl');
  const s = split(rows);
  const model = trainModel(s.train, s.calib, { trees: 30 });
  for (const r of s.test.slice(0, 40)) {
    const e = explainPrediction(model, vec(r));
    const sum = e.bias + e.contributions.reduce((acc, c) => acc + c.logit, 0);
    const logit = Math.log(e.p / (1 - e.p));
    assert.ok(Math.abs(sum - logit) < 1e-9, `${sum} vs ${logit}`);
    assert.equal(e.p, probability(model, vec(r)));
  }
  // the strongest true driver shows up on a cannot-sell row
  const r = s.test.find((x) => x.f.m_sim_cannot_sell === 1) ?? s.train.find((x) => x.f.m_sim_cannot_sell === 1);
  const top = explainPrediction(model, { ...r.f }).contributions.slice(0, 3).map((c) => c.feature);
  assert.ok(top.includes('m_sim_cannot_sell') || top.includes('r_level'), top.join());
});

test('the model learns the toy signal and is calibrated', () => {
  const rows = toyRows(1200, 'learn');
  const s = split(rows);
  const model = trainModel(s.train, s.calib, { trees: 60 });
  const p = s.test.map((r) => probability(model, vec(r)));
  const y = s.test.map((r) => r.label);
  assert.ok(auc(p, y) > 0.7, String(auc(p, y))); // label noise caps it near 0.8
  assert.ok(ece(p, y) < 0.12, String(ece(p, y)));
  const ev = evaluateModel(model, s.test);
  assert.equal(ev.loweredByModel, 0);
  assert.ok(model.thresholds.low >= 0.5 && model.thresholds.medium >= 0.8 && model.thresholds.high >= 0.95);
  assert.equal(modelLevel(model, 0.999), 'high');
  assert.equal(modelLevel(model, 0.1), null);
});

test('metrics: AUC, recall at a fixed FPR, Platt scaling', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(auc([0.5, 0.5], [0, 1]), 0.5);
  const r = recallAtFpr([0.1, 0.2, 0.3, 0.9, 0.95, 0.25], [0, 0, 0, 1, 1, 1], 0);
  assert.equal(r.recall, 2 / 3);
  assert.equal(r.fpr, 0);
  const c = fitPlatt([-3, -2, -1, 1, 2, 3], [0, 0, 0, 1, 1, 1]);
  assert.ok(c.a > 0);
  assert.equal(isBetter({ model: { auc: 0.9, recallAt1Fpr: 0.5 } }, { model: { auc: 0.9, recallAt1Fpr: 0.5 } }).better, false, 'equal is not better');
  assert.equal(isBetter({ model: { auc: 0.95, recallAt1Fpr: 0.5 } }, { model: { auc: 0.9, recallAt1Fpr: 0.5 } }).better, true);
  assert.equal(isBetter({ model: { auc: 0.99, recallAt1Fpr: 0.4 } }, { model: { auc: 0.9, recallAt1Fpr: 0.5 } }).better, false, 'never trade recall away');
});

const MODEL = new URL('../model.json', import.meta.url);
test('committed model: loads, small, known features, its stored parity rows reproduce exactly', { skip: !existsSync(MODEL) }, () => {
  const text = readFileSync(MODEL, 'utf8');
  assert.ok(text.length < 200 * 1024, `${text.length} bytes`);
  const model = checkModel(JSON.parse(text));
  for (const n of model.features) assert.ok(FEATURES.includes(n), n);
  assert.ok(Array.isArray(model.check) && model.check.length >= 5);
  for (const c of model.check) {
    assert.equal(margin(model, c.f), c.margin, 'margin computed in training == margin in plain JS');
    assert.equal(Math.round(probability(model, c.f) * 1e9) / 1e9, c.p);
  }
});
