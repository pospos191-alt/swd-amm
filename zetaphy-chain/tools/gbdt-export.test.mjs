// node --test zetaphy-chain/tools/gbdt-export.test.mjs
// The integer model the AI precompile runs agrees with Neuro's float model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportModel, scoreInt, sigmoidBps, featureBytes } from './gbdt-export.mjs';
import { probability } from '../../zetaphy-neuro/ml/model.js';

const model = JSON.parse(readFileSync(new URL('../../zetaphy-neuro/ml/model.json', import.meta.url), 'utf8'));

// deterministic PRNG (mulberry32)
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('sigmoid table matches the logistic function', () => {
  for (let z = -8; z <= 8; z += 0.01) {
    const want = 10000 / (1 + Math.exp(-z));
    assert.ok(Math.abs(sigmoidBps(Math.round(z * 1e4)) - want) <= 10, `z=${z}`);
  }
});

test('Neuro model exports within the chain limits, and scores agree', () => {
  const exp = exportModel(model);
  assert.ok(exp.bytes.length <= 65536);
  assert.equal(String.fromCharCode(...exp.bytes.slice(0, 4)), 'ZGB1');
  // thresholds actually used by the model, per feature, to draw realistic rows
  const th = model.features.map(() => [0, 1]);
  for (const t of model.trees) for (let i = 0; i < t.length; i += 5) if (t[i] >= 0) th[t[i]].push(t[i + 1]);
  const r = rng(77390);
  let worst = 0;
  const N = 3000;
  for (let k = 0; k < N; k++) {
    // Rows are drawn near the model's thresholds, then kept 2e-4 away from
    // them: closer than the 1e-4 grid, the integer model may branch the other
    // way (documented limit).
    const x = th.map((ts) => {
      let v = ts[Math.floor(r() * ts.length)] * (0.5 + r()) + (r() - 0.5) * 0.01;
      while (ts.some((t) => Math.abs(v - t) < 2e-4)) v += 3e-4;
      return v;
    });
    const f = Math.round(probability(model, x) * 10000);
    worst = Math.max(worst, Math.abs(f - scoreInt(exp, x)));
  }
  assert.ok(worst <= 15, `worst difference ${worst} bps`);
  assert.equal(featureBytes([1.5, -0.00005]).length, 8);
});

test('refuses models the chain cannot run', () => {
  assert.throws(() => exportModel({ ...model, format: 'x' }));
  assert.throws(() => exportModel({ ...model, trees: [[0, 1, 0, 0, 0]] }), /children/);
});
