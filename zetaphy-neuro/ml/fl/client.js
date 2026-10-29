// Neuro federated learning: what a browser does with its own labels.
//
// A label is something the user confirmed AFTER the outcome ("I could not sell
// it" = 1, "it traded normally for weeks" = 0) for a token Neuro scanned. The
// browser keeps the feature vector of each scan and the label locally; only a
// clipped, noised change to the head's weights ever leaves the device.

import { headInputs } from './head.js';
import { privatize, DEFAULT_PRIVACY, l2 } from './dp.js';
import { encodeUpdate } from './codec.js';

export const DEFAULT_LOCAL = Object.freeze({ epochs: 10, lr: 1, l2: 0.01, maxExamples: 64 });

/**
 * One labelled example kept by the browser.
 * @param {object} model
 * @param {object} head  the head whose inputs to keep
 * @param {number[]|object} features  ml/features.js output (named) or vector in model order
 * @param {0|1} label
 */
export function makeExample(model, head, features, label) {
  if (label !== 0 && label !== 1) throw new Error('label must be 0 or 1');
  return { phi: Array.from(headInputs(model, head, features)), y: label };
}

/**
 * Local training: a few epochs of gradient descent on the user's examples,
 * starting at the current head, with a small pull back towards it.
 * @returns {Float64Array} raw delta theta_local - theta_global (NOT private yet)
 */
export function localDelta(model, head, examples, opts = {}) {
  const o = { ...DEFAULT_LOCAL, ...opts };
  const ex = examples.slice(0, o.maxExamples);
  const d = head.theta.length;
  const theta0 = Float64Array.from(head.theta);
  const theta = Float64Array.from(head.theta);
  if (ex.length === 0) return new Float64Array(d);
  const c = model.calib ?? { a: 1, b: 0 };
  const g = new Float64Array(d);
  for (let e = 0; e < o.epochs; e++) {
    g.fill(0);
    for (const { phi, y } of ex) {
      let z = phi[1];
      for (let i = 0; i < d; i++) z += theta[i] * phi[i];
      const s = c.a * z + c.b;
      const p = s >= 0 ? 1 / (1 + Math.exp(-s)) : Math.exp(s) / (1 + Math.exp(s));
      const k = ((p - y) * c.a) / ex.length;
      for (let i = 0; i < d; i++) g[i] += k * phi[i];
    }
    for (let i = 0; i < d; i++) theta[i] -= o.lr * (g[i] + o.l2 * (theta[i] - theta0[i]));
  }
  return theta.map((w, i) => w - theta0[i]);
}

/**
 * The update a browser submits: local delta, clipped to `clip` and noised with
 * multiplier `z`. `uniform` defaults to the crypto generator (tests pass a seeded one).
 */
export function clientUpdate(model, head, examples, { privacy = DEFAULT_PRIVACY, local = {}, uniform } = {}) {
  const raw = localDelta(model, head, examples, local);
  return privatize(raw, privacy, uniform);
}

/**
 * Everything a browser does for one round, from its stored labels to the bytes it sends:
 * examples -> local delta -> clip + noise -> wire format. Runs in a Web Worker on the page
 * (web/fl-worker.js); nothing in `rows` leaves it.
 * @param {Array<{f:object, y:0|1}>} rows  named (sparse) features + the final label (ml/fl/labels.js)
 * @returns {{bytes:Uint8Array, n:number, dim:number, norm:number}}
 */
export function roundUpdate(model, head, rows, { round, privacy = DEFAULT_PRIVACY, local = {}, uniform } = {}) {
  if (!head.hash) throw new Error('the head has no hash (sealHead it first)');
  if (!rows.length) throw new Error('no labelled examples');
  const ex = rows.map((r) => makeExample(model, head, r.f, r.y));
  const values = clientUpdate(model, head, ex, { privacy, local, uniform });
  const bytes = encodeUpdate({ headHash: head.hash, round, clip: privacy.clip, z: privacy.z, values });
  return { bytes, n: Math.min(ex.length, local.maxExamples ?? DEFAULT_LOCAL.maxExamples), dim: values.length, norm: l2(values) };
}
