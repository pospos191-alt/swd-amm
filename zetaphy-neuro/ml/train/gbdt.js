// Gradient-boosted decision trees for binary classification (logistic loss),
// written for Neuro's model: small, deterministic, no dependencies.
//
// Determinism: thresholds come from sorted unique values, row/feature
// sampling uses a seeded PRNG, ties break on the lowest feature then the
// lowest threshold, and every threshold and node value is rounded to 7
// significant digits BEFORE it is used, so the exported JSON reproduces
// the trainer's scores bit for bit (ml/model.js).

import { rng } from '../lib/rng.js';

const NODE = 5;
export const round7 = (x) => (x === 0 ? 0 : Number(x.toPrecision(7)));
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Candidate thresholds per feature: midpoints between sorted unique values, at most maxBins-1, rounded. */
export function makeThresholds(X, maxBins = 48) {
  const d = X[0]?.length ?? 0;
  const out = [];
  for (let f = 0; f < d; f++) {
    const vals = [...new Set(X.map((r) => r[f]))].sort((a, b) => a - b);
    let cuts = [];
    if (vals.length <= maxBins) {
      for (let i = 0; i + 1 < vals.length; i++) cuts.push((vals[i] + vals[i + 1]) / 2);
    } else {
      // quantiles over the sorted column (with duplicates), then midpoints
      const col = X.map((r) => r[f]).sort((a, b) => a - b);
      for (let q = 1; q < maxBins; q++) {
        const i = Math.floor((q * col.length) / maxBins);
        const lo = col[i - 1];
        const hi = col[i];
        if (hi > lo) cuts.push((lo + hi) / 2);
      }
    }
    cuts = [...new Set(cuts.map(round7))].sort((a, b) => a - b);
    out.push(Float64Array.from(cuts));
  }
  return out;
}

/** Bin index = number of thresholds strictly below x, so "x <= t[b]" <=> "bin <= b". */
function binOf(cuts, x) {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cuts[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export const DEFAULTS = {
  trees: 160, depth: 4, lr: 0.15, lambda: 1, minLeaf: 8, minHess: 1e-3, subsample: 0.8, colsample: 0.8, maxBins: 48, seed: 'neuro-ml',
};

/**
 * @param {number[][]} X  rows of features (model order)
 * @param {number[]} y    0/1 labels
 * @param {object} [opts] DEFAULTS overrides; opts.weights = per-row weights
 * @returns {{base:number, trees:number[][], thresholds:Float64Array[], trainMargin:Float64Array}}
 */
export function trainGBDT(X, y, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = X.length;
  const d = X[0].length;
  const R = rng(String(o.seed));
  const w = o.weights ? Float64Array.from(o.weights) : new Float64Array(n).fill(1);
  const cuts = makeThresholds(X, o.maxBins);
  const bins = Array.from({ length: d }, (_, f) => Uint16Array.from(X, (r) => binOf(cuts[f], r[f])));
  let pos = 0; let tot = 0;
  for (let i = 0; i < n; i++) { pos += w[i] * y[i]; tot += w[i]; }
  const prior = Math.min(Math.max(pos / tot, 1e-6), 1 - 1e-6);
  const base = round7(Math.log(prior / (1 - prior)));
  const F = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const trees = [];

  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(F[i]);
      g[i] = w[i] * (p - y[i]);
      h[i] = w[i] * Math.max(p * (1 - p), 1e-12);
    }
    const rows = [];
    for (let i = 0; i < n; i++) if (R.float() < o.subsample) rows.push(i);
    const feats = [];
    for (let f = 0; f < d; f++) if (R.float() < o.colsample) feats.push(f);
    if (!feats.length) feats.push(R.int(d));

    const nodes = [];
    const value = (G, H) => round7((-G / (H + o.lambda)) * o.lr);
    // Build depth-first; each node: {rows, depth}
    const build = (idx, depth) => {
      let G = 0; let H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      const me = nodes.length;
      nodes.push([-1, 0, 0, 0, value(G, H)]);
      if (depth >= o.depth || idx.length < 2 * o.minLeaf) return me;
      const parentScore = (G * G) / (H + o.lambda);
      let best = null;
      for (const f of feats) {
        const nb = cuts[f].length;
        if (!nb) continue;
        const gs = new Float64Array(nb + 1);
        const hs = new Float64Array(nb + 1);
        const cs = new Int32Array(nb + 1);
        const bf = bins[f];
        for (const i of idx) { const b = bf[i]; gs[b] += g[i]; hs[b] += h[i]; cs[b]++; }
        let gl = 0; let hl = 0; let cl = 0;
        for (let b = 0; b < nb; b++) {
          gl += gs[b]; hl += hs[b]; cl += cs[b];
          const cr = idx.length - cl;
          if (cl < o.minLeaf || cr < o.minLeaf) continue;
          const hr = H - hl;
          if (hl < o.minHess || hr < o.minHess) continue;
          const gr = G - gl;
          const gain = (gl * gl) / (hl + o.lambda) + (gr * gr) / (hr + o.lambda) - parentScore;
          if (gain > 1e-9 && (!best || gain > best.gain + 1e-12)) best = { gain, f, b };
        }
      }
      if (!best) return me;
      const left = []; const right = [];
      for (const i of idx) (bins[best.f][i] <= best.b ? left : right).push(i);
      nodes[me][0] = best.f;
      nodes[me][1] = cuts[best.f][best.b];
      nodes[me][2] = build(left, depth + 1);
      nodes[me][3] = build(right, depth + 1);
      return me;
    };
    build(rows, 0);
    const flat = nodes.flat();
    trees.push(flat);
    // Update every row's margin with the rounded tree, by raw comparison (as inference does).
    for (let i = 0; i < n; i++) F[i] += leafValue(flat, X[i]);
  }
  return { base, trees, thresholds: cuts, trainMargin: F };
}

function leafValue(t, x) {
  let i = 0;
  while (t[i] >= 0) i = (x[t[i]] <= t[i + 1] ? t[i + 2] : t[i + 3]) * NODE;
  return t[i + 4];
}

/** Margin with the trainer's own representation (used by the parity test). */
export function trainerMargin(m, x) {
  let z = m.base;
  for (const t of m.trees) z += leafValue(t, x);
  return z;
}

/**
 * Platt scaling: fits p = sigmoid(a*z + b) on held-out margins with the usual target smoothing and a weak
 * Gaussian prior around the identity (a = 1, b = 0, strength `prior`), by damped Newton steps. The prior keeps
 * the fit finite when the calibration rows are perfectly separated: without it the slope runs off to ~1e8 and
 * every probability rounds to exactly 0 or 1, which destroys the ranking (AUC) and the explanations. Deterministic.
 */
export function fitPlatt(z, y, iters = 100, prior = 1) {
  let pos = 0;
  for (const v of y) pos += v;
  const neg = y.length - pos;
  const tp = (pos + 1) / (pos + 2);
  const tn = 1 / (neg + 2);
  const t = y.map((v) => (v ? tp : tn));
  const loss = (a, b) => {
    let l = (prior / 2) * ((a - 1) ** 2 + b * b);
    for (let i = 0; i < z.length; i++) {
      const u = a * z[i] + b;
      // cross-entropy with soft targets, written stably: log(1 + e^u) - t*u
      l += (u > 0 ? u + Math.log1p(Math.exp(-u)) : Math.log1p(Math.exp(u))) - t[i] * u;
    }
    return l;
  };
  let a = 1; let b = 0;
  let cur = loss(a, b);
  for (let k = 0; k < iters; k++) {
    let ga = prior * (a - 1); let gb = prior * b; let haa = prior; let hab = 0; let hbb = prior;
    for (let i = 0; i < z.length; i++) {
      const p = sigmoid(a * z[i] + b);
      const r = p - t[i];
      const s = p * (1 - p);
      ga += r * z[i]; gb += r;
      haa += s * z[i] * z[i]; hab += s * z[i]; hbb += s;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    let step = 1;
    let next = loss(a - da, b - db);
    while (next > cur && step > 1e-6) { step /= 2; next = loss(a - step * da, b - step * db); }
    if (next > cur) break;
    a -= step * da; b -= step * db; cur = next;
    if (Math.abs(step * da) < 1e-10 && Math.abs(step * db) < 1e-10) break;
  }
  return { a: round7(a), b: round7(b) };
}

export { NODE };
