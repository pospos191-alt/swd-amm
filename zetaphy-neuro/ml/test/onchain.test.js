// The fixed-point export NeuroScore runs on-chain (ml/onchain/): up to date with
// the ON-CHAIN model ml/onchain/model.json, deterministic, and within the documented
// tolerance of that float model on the held-out rows (same decisions). The on-chain
// model is a separate, pinned model version: the zk circuit and its public ceremony
// hard-wire its bytes, so it can lag ml/model.json (the browser / runner model)
// until a new ceremony is run. The Solidity side of the parity test is
// zetaphy-network/test/neuroscore.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkModel, probability, modelLevel } from '../model.js';
import { exportFixed, evalFixed, quantizeVector, quantizeFeature, packFeatures, header, levelOf, scoreToProbability, probabilityToScore, fromHex, toHex, SCALE } from '../onchain/fixed.js';
import { fixedArtifact, checkFeatureNames } from '../onchain/export.js';
import { FEATURES } from '../features.js';

const MODEL = checkModel(JSON.parse(readFileSync(new URL('../onchain/model.json', import.meta.url), 'utf8')));
const BROWSER = checkModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
const TRANSCRIPT = JSON.parse(readFileSync(new URL('../onchain/zk/ceremony/transcript.json', import.meta.url), 'utf8'));
const FIXED = JSON.parse(readFileSync(new URL('../onchain/model.fixed.json', import.meta.url), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('../onchain/heldout.json', import.meta.url), 'utf8'));
const LEVEL = { low: 1, medium: 2, high: 3 };

test('model.fixed.json is the deterministic export of the committed ml/onchain/model.json (rerun node ml/onchain/export.js)', () => {
  const again = fixedArtifact(MODEL);
  assert.equal(FIXED.modelId, MODEL.id);
  assert.equal(FIXED.featureVersion, MODEL.featureVersion);
  assert.deepEqual(FIXED.features, MODEL.features);
  assert.deepEqual(again, FIXED);
  assert.equal(toHex(exportFixed(MODEL).bytes), FIXED.bytes);
  const h = header(fromHex(FIXED.bytes));
  assert.equal(h.nFeatures, MODEL.features.length);
  assert.equal(h.nTrees, MODEL.trees.length);
  assert.equal(h.scale, SCALE);
  assert.equal(FIXED.size, 24 + MODEL.trees.length + 6 * FIXED.nodes);
  assert.ok(FIXED.size <= 24_575, 'fits one data contract');
});

test('the on-chain model is its own pinned version: the one the zk ceremony is for; its features are still computed under the same names', () => {
  // the circuit and the public ceremony are for exactly these bytes
  assert.equal(TRANSCRIPT.circuit.modelHash, FIXED.hash, 'the zk ceremony is for model.fixed.json: change both only with a new public ceremony');
  // every feature it reads is still produced by ml/features.js (feature versions only append), and the vector it is
  // fed is built from its own list: features it does not know (e.g. the x_* path features) never reach the chain
  checkFeatureNames(MODEL);
  assert.deepEqual(FEATURES.slice(0, MODEL.features.length), MODEL.features, 'feature versions only append');
  assert.ok(MODEL.featureVersion <= BROWSER.featureVersion);
  // lagging the browser model is allowed: it is then a different model with its own id and hash
  if (MODEL.id !== BROWSER.id) assert.notEqual(FIXED.hash, fixedArtifact(BROWSER).hash);
  assert.throws(() => checkFeatureNames({ id: 'x', features: ['r_level', 'no_such_feature'] }), /no_such_feature/);
});

test('quantization: >= 0, clamped to u32, NaN/negative -> 0; packed big-endian', () => {
  assert.equal(quantizeFeature(0), 0);
  assert.equal(quantizeFeature(-3), 0);
  assert.equal(quantizeFeature(NaN), 0);
  assert.equal(quantizeFeature(1.5), 15_000_000);
  assert.equal(quantizeFeature(1e9), 2 ** 32 - 1);
  assert.equal(packFeatures([1, 256]), '0x0000000100000100');
  assert.throws(() => packFeatures([-1]), /u32/);
  assert.equal(probabilityToScore(0.5), 0);
  assert.ok(Math.abs(scoreToProbability(probabilityToScore(0.8)) - 0.8) < 1e-7);
});

test('export refuses what the format cannot hold', () => {
  const tiny = { format: 'neuro-ml-gbdt/1', features: ['a'], base: 0, calib: { a: 1, b: 0 }, trees: [[0, -1, 1, 2, 0, -1, 0, 0, 0, 0.1, -1, 0, 0, 0, -0.1]] };
  assert.throws(() => exportFixed(tiny), /negative threshold/);
  assert.throws(() => exportFixed({ ...tiny, trees: [[0, 1, 2, 1, 0, -1, 0, 0, 0, 0.1, -1, 0, 0, 0, -0.1]] }), /pre-order/);
  assert.throws(() => exportFixed({ ...tiny, calib: { a: -1, b: 0 }, trees: [[-1, 0, 0, 0, 0.1]] }), /slope/);
  assert.throws(() => exportFixed({ ...tiny, trees: [[0, 1000, 1, 2, 0, -1, 0, 0, 0, 0.1, -1, 0, 0, 0, -0.1]] }), /u32/);
  const ok = exportFixed({ ...tiny, trees: [[0, 0.5, 1, 2, 0, -1, 0, 0, 0, 0.1, -1, 0, 0, 0, -0.1]] });
  assert.equal(evalFixed(ok.bytes, [quantizeFeature(0.4)]).margin, 1_000_000);
  assert.equal(evalFixed(ok.bytes, [quantizeFeature(0.6)]).margin, -1_000_000);
  assert.equal(evalFixed(ok.bytes, [quantizeFeature(0.5)]).margin, 1_000_000, 'on the threshold: left, as in the float model');
});

test('held-out rows: JS float vs JS fixed-point, |dp| <= 1e-6, |dlogit| <= 2e-5, the same level on every row', () => {
  assert.equal(HELD.modelId, MODEL.id);
  const bytes = fromHex(FIXED.bytes);
  let maxDp = 0; let maxDz = 0;
  for (const row of HELD.rows) {
    const v = new Array(MODEL.features.length).fill(0);
    for (const [i, x] of row.x) v[i] = x;
    const pf = probability(MODEL, v);
    const { score } = evalFixed(bytes, quantizeVector(v));
    const px = scoreToProbability(score);
    maxDp = Math.max(maxDp, Math.abs(pf - px));
    const zf = Math.log(pf / (1 - pf));
    maxDz = Math.max(maxDz, Math.abs(zf - score / SCALE));
    assert.equal(levelOf(score, FIXED.levels), LEVEL[modelLevel(MODEL, pf)] ?? 0, row.id);
  }
  assert.ok(maxDp <= 1e-6, String(maxDp));
  assert.ok(maxDz <= 2e-5, String(maxDz));
});
