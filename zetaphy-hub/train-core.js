// Proof of useful work for AI training (docs/future/useful-work-training.md): the code shared by the hub's
// training Web Worker (train-worker.js), the runners' Node worker (zetaphy-network/src/trainwork/) and the
// tests. No DOM, no network; Keccak is passed in (`k`: Neuro's keccak256(bytes) -> bytes), so this file runs
// the same in a browser and in Node.
//
// BIT-REPRODUCIBLE TRAINING. A training job grows gradient-boosted trees (Neuro's model format,
// neuro-ml-gbdt/1: flat [feature, threshold, left, right, value] nodes) on one data shard from a seed. Any
// other worker, on any JS engine, must get the same bytes, so:
//   - only + - * / , comparisons, Math.round/floor/abs/max/min (all exact or correctly rounded by IEEE 754
//     and ECMAScript; JS never fuses a*b+c) — no Math.exp/log/pow (their last bit is engine-defined):
//     dexp() is our own range reduction + a fixed polynomial;
//   - every sum runs in one fixed order (rows by index, bins by index, trees by index);
//   - randomness is integer-only (xoshiro128** seeded per tree), sampling compares integers;
//   - leaf values are snapped to a 2^-24 grid; split ties go to the lowest feature, then the lowest bin.
// The test pins a golden checkpoint root, and the browser e2e checks Chromium gets the same root as Node.
//
// VERIFIABLE BY SPOT-CHECKS. A job of T trees is cut into C = T / every segments. For each segment the
// trainer hashes the trees it grew AND a transcript of how (every split's gain, G, H; every leaf's G, H):
//   d_s = keccak("zetaphy-train/1 segment" ‖ s ‖ trees_s ‖ transcript_s),  root = keccak(d_1 ‖ … ‖ d_C)
// and commits only `root` (plus the hash of all its trees). Verifiers drawn at random re-run a random
// segment s from the published trees before it and answer their own d_s, sealed, before the trainer opens
// its d_1..d_C. The transcript is not in the published trees, so it cannot be copied: re-running is the only
// way to answer. A fake segment gives a different digest and is slashed when sampled.

import { encodeArgs, fromHex, toHex } from './work-core.js';

export const TRAIN_FORMAT = 'zetaphy-train/1';
export const MODEL_FORMAT = 'neuro-ml-gbdt/1';
const NODE = 5;
const utf8 = (s) => new TextEncoder().encode(s);
const kh = (k, bytes) => toHex(k(bytes));

// ------------------------------------------------------------------ deterministic math
const LN2_HI = 6.93147180369123816490e-01; // fdlibm: low 32 bits zero, so k * LN2_HI is exact for |k| < 2^20
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const INV_FACT = [1];
for (let n = 1; n <= 16; n++) INV_FACT.push(INV_FACT[n - 1] / n);

/** e^x with + - * / only: x = k ln2 + r (|r| <= 0.35), e^r by a degree-16 Taylor polynomial, times 2^k. */
export function dexp(x) {
  if (x !== x) return NaN;
  if (x > 700) x = 700;
  if (x < -700) x = -700;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let p = INV_FACT[16];
  for (let n = 15; n >= 0; n--) p = p * r + INV_FACT[n];
  let s = 1;
  const b = k >= 0 ? 2 : 0.5;
  for (let i = 0, m = Math.abs(k); i < m; i++) s *= b; // powers of two: exact
  return p * s;
}
export const dsigmoid = (z) => { if (z >= 0) return 1 / (1 + dexp(-z)); const e = dexp(z); return e / (1 + e); };
/** Leaf values on a 2^-24 grid (exact: scaling by a power of two, then rounding to an integer). */
export const snap = (v) => Math.round(v * 16777216) / 16777216;

// ------------------------------------------------------------------ integer PRNG
export function fnv32(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
/** xoshiro128** seeded by splitmix32 over fnv32(seed): u32 values only. */
export function rng(seed) {
  let a0 = fnv32(seed);
  const sm = () => {
    a0 = (a0 + 0x9e3779b9) | 0;
    let t = a0 ^ (a0 >>> 16); t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  let a = sm(), b = sm(), c = sm(), d = sm();
  return () => {
    const t = b << 9; let r = Math.imul(b, 5); r = Math.imul((r << 7) | (r >>> 25), 9);
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r >>> 0;
  };
}
const U32 = 4294967296;
/** A probability as an integer bound for u32() < bound. */
const bound = (p) => Math.floor(p * U32);

// ------------------------------------------------------------------ the data (synthetic, labelled as such)
// Neuro feature names (zetaphy-neuro/ml/features.js). Rows of a "world" are generated from (world, id) alone,
// so a shard is a list of ids and anyone can rebuild it; in production the rows are corpus files (the labelled
// output of scan/label work) addressed by their hash, the same `rowsHash` below.
export const WORLD_FEATURES = Object.freeze(['r_level', 'r_ctl_renounced', 'r_ctl_owner', 'p_time_gate', 'p_hash_guard', 'm_sim_cannot_sell',
  'm_sell_tax', 'k_top_holder', 'k_lp_locked', 'k_age', 'o_rate_sstore', 's_cat_mint']);

/**
 * One labelled row. World 'v0' is what the current model learned; 'v1' has DRIFTED: a new scam family uses
 * time gates and anti-bot hash guards behind fake renounces, so "renounced" stops meaning safe. 'v1p' is v1
 * POISONED: the same rows, but that new family relabelled as safe (what an attacker feeding the labels wants).
 */
export function worldRow(world, id) {
  const poisoned = world === 'v1p';
  if (poisoned) world = 'v1';
  const R = rng(`${world}:${id}`);
  const u = () => R() / U32;
  const bit = (p) => (R() < bound(p) ? 1 : 0);
  const renounced = bit(0.35);
  const lp = bit(0.5);
  const f = [
    Math.floor(u() * 4),            // r_level 0..3
    renounced,
    renounced ? 0 : bit(0.6),       // r_ctl_owner
    bit(0.25) * (0.25 + 0.75 * u()), // p_time_gate
    bit(0.2) * (0.25 + 0.75 * u()),  // p_hash_guard
    bit(0.1),                       // m_sim_cannot_sell
    u() * 0.4,                      // m_sell_tax
    u(),                            // k_top_holder
    lp,                             // k_lp_locked
    u(),                            // k_age (log days, scaled)
    u() * 5,                        // o_rate_sstore
    bit(0.3) * u() * 2,             // s_cat_mint
  ];
  let z = -2.4 + 0.8 * f[0] + 3.2 * f[5] + 4 * f[6] + 1.6 * f[7] - 0.9 * f[8] - 1.1 * f[9] + 0.5 * f[11];
  if (world === 'v0') z += -1.3 * f[1] + 0.4 * f[2];
  else {
    const trap = f[3] > 0 || f[4] > 0 ? 1 : 0;
    z += -0.9 + 0.6 * f[1] + 0.4 * f[2] + 3.6 * f[3] * (1 - lp) + 2.8 * f[4] + 1.8 * trap * f[1];
  }
  z += (u() - 0.5) * 1.5;
  const y = u() < dsigmoid(z) ? 1 : 0;
  return { id, x: f, y: poisoned && (f[3] > 0 || f[4] > 0) ? 0 : y };
}
export const worldRows = (world, ids) => ids.map((i) => worldRow(world, i));
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
/** Ids of shard j of `shards` over [from, to): every shards-th id. */
export const shardIds = (from, to, shards, j) => range(from, to).filter((i) => i % shards === j);

// ------------------------------------------------------------------ canonical bytes and hashes
function f64s(values) {
  const out = new Uint8Array(values.length * 8);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setFloat64(i * 8, v, false));
  return out;
}
function u32be(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; }
function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const encodeTrees = (trees) => concat(trees.flatMap((t) => [u32be(t.length), f64s(t)]));
/** keccak of the rows (ids, labels, features as Float64 BE): what a shard or an evaluation set is. */
export const rowsHash = (k, rows) => kh(k, concat(rows.flatMap((r) => [u32be(r.id), u32be(r.y), f64s(r.x)])));
export const treesHash = (k, trees) => kh(k, concat([utf8(`${TRAIN_FORMAT} trees`), encodeTrees(trees)]));
/** keccak of a model: format, feature names, base margin, trees. */
export const modelHash = (k, m) => kh(k, concat([utf8(`${m.format}\n${m.features.join(',')}\n`), f64s([m.base]), encodeTrees(m.trees)]));
export const specHash = (k, specText) => kh(k, utf8(specText));
export const UNAVAILABLE = (k) => kh(k, utf8(`${TRAIN_FORMAT} unavailable`));

// ------------------------------------------------------------------ model inference (as zetaphy-neuro/ml/model.js)
export function leafOf(t, x) {
  let i = 0;
  while (t[i] >= 0) i = (x[t[i]] <= t[i + 1] ? t[i + 2] : t[i + 3]) * NODE;
  return t[i + 4];
}
export function margin(model, x) {
  let z = model.base;
  for (const t of model.trees) z += leafOf(t, x);
  return z;
}

// ------------------------------------------------------------------ training
export const TRAIN_DEFAULTS = Object.freeze({ trees: 24, every: 3, depth: 3, lr: 0.3, lambda: 1, minLeaf: 10, subsample: 0.8, colsample: 0.85, maxBins: 32 });

/** Split points per feature: midpoints of the sorted unique values (quantiles past maxBins). */
export function cutsOf(X, maxBins) {
  const d = X[0]?.length ?? 0;
  const out = [];
  for (let f = 0; f < d; f++) {
    const col = X.map((r) => r[f]).sort((a, b) => a - b);
    const uniq = col.filter((v, i) => i === 0 || v !== col[i - 1]);
    const cuts = [];
    if (uniq.length <= maxBins) for (let i = 0; i + 1 < uniq.length; i++) cuts.push((uniq[i] + uniq[i + 1]) / 2);
    else {
      for (let q = 1; q < maxBins; q++) {
        const i = Math.floor((q * col.length) / maxBins);
        if (col[i] > col[i - 1]) { const c = (col[i - 1] + col[i]) / 2; if (!cuts.length || c > cuts[cuts.length - 1]) cuts.push(c); }
      }
    }
    out.push(cuts);
  }
  return out;
}
function binOf(cuts, x) {
  let lo = 0, hi = cuts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cuts[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** A shard ready to train on: rows, their bins and the base model's margins. */
export function prepare(rows, base, o = TRAIN_DEFAULTS) {
  const X = rows.map((r) => r.x);
  const cuts = cutsOf(X, o.maxBins);
  const bins = cuts.map((c, f) => Int32Array.from(X, (x) => binOf(c, x[f])));
  return { X, y: rows.map((r) => r.y), cuts, bins, F0: Float64Array.from(X, (x) => margin(base, x)) };
}

/** One tree, grown from margins F; returns { tree, transcript } (transcript: numbers of every node). */
function growTree(S, F, o, seed, shard, t) {
  const { X, y, cuts, bins } = S;
  const n = X.length, d = cuts.length;
  const R = rng(`${seed}:${shard}:${t}`);
  const g = new Float64Array(n), h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = dsigmoid(F[i]);
    g[i] = p - y[i];
    h[i] = Math.max(p * (1 - p), 1e-12);
  }
  const rows = [];
  const sb = bound(o.subsample), cb = bound(o.colsample);
  for (let i = 0; i < n; i++) if (R() < sb) rows.push(i);
  const feats = [];
  for (let f = 0; f < d; f++) if (R() < cb) feats.push(f);
  if (!feats.length) feats.push(R() % d);
  const nodes = [], tr = [];
  const build = (idx, depth) => {
    let G = 0, H = 0;
    for (const i of idx) { G += g[i]; H += h[i]; }
    const me = nodes.length;
    nodes.push([-1, 0, 0, 0, snap((-G / (H + o.lambda)) * o.lr)]);
    let best = null;
    if (depth < o.depth && idx.length >= 2 * o.minLeaf) {
      const parent = (G * G) / (H + o.lambda);
      for (const f of feats) {
        const nb = cuts[f].length;
        if (!nb) continue;
        const gs = new Float64Array(nb + 1), hs = new Float64Array(nb + 1), cs = new Int32Array(nb + 1);
        const bf = bins[f];
        for (const i of idx) { const b = bf[i]; gs[b] += g[i]; hs[b] += h[i]; cs[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < nb; b++) {
          gl += gs[b]; hl += hs[b]; cl += cs[b];
          if (cl < o.minLeaf || idx.length - cl < o.minLeaf) continue;
          const gr = G - gl, hr = H - hl;
          const gain = (gl * gl) / (hl + o.lambda) + (gr * gr) / (hr + o.lambda) - parent;
          if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, b };
        }
      }
    }
    if (!best) { tr.push(-1, idx.length, G, H); return me; }
    tr.push(best.f, best.b, best.gain, G, H);
    const left = [], right = [];
    for (const i of idx) (bins[best.f][i] <= best.b ? left : right).push(i);
    nodes[me][0] = best.f;
    nodes[me][1] = cuts[best.f][best.b];
    nodes[me][2] = build(left, depth + 1);
    nodes[me][3] = build(right, depth + 1);
    return me;
  };
  build(rows, 0);
  return { tree: nodes.flat(), transcript: tr };
}

/** The digest of segment s (its trees and its transcript). */
export function segmentDigest(k, s, trees, transcript) {
  return kh(k, concat([utf8(`${TRAIN_FORMAT} segment`), u32be(s), encodeTrees(trees), f64s(transcript)]));
}
/** root = keccak(d_1 ‖ … ‖ d_C), as TrainingMarket checks it (abi.encodePacked(bytes32[])). */
export const rootOf = (k, digests) => kh(k, concat(digests.map(fromHex)));

/** Margins after `prefix` trees, added in tree order (the trainer adds them the same way). */
function marginsAfter(S, prefix) {
  const F = Float64Array.from(S.F0);
  for (const t of prefix) for (let i = 0; i < F.length; i++) F[i] += leafOf(t, S.X[i]);
  return F;
}

/**
 * Trains segments [fromSeg, toSeg) of a job, starting from the published trees `prefix` (fromSeg * every of
 * them). Returns { trees, digests } for those segments. `S` from prepare().
 */
export function trainSegments(k, { S, spec, shard, prefix = [], fromSeg = 0, toSeg, onSegment }) {
  const o = { ...TRAIN_DEFAULTS, ...spec.train };
  if (prefix.length !== fromSeg * o.every) throw new Error('the prefix must end on a segment boundary');
  const F = marginsAfter(S, prefix);
  const trees = [], digests = [];
  for (let s = fromSeg; s < toSeg; s++) {
    const segTrees = [], segTr = [];
    for (let t = s * o.every; t < (s + 1) * o.every; t++) {
      const { tree, transcript } = growTree(S, F, o, spec.seed, shard, t);
      for (let i = 0; i < F.length; i++) F[i] += leafOf(tree, S.X[i]);
      segTrees.push(tree);
      segTr.push(...transcript);
    }
    trees.push(...segTrees);
    digests.push(segmentDigest(k, s, segTrees, segTr));
    onSegment?.(s, digests[digests.length - 1]);
  }
  return { trees, digests };
}

/** A whole training job: { trees, digests, root, treesHash }. */
export function trainJob(k, { S, spec, shard, onSegment }) {
  const o = { ...TRAIN_DEFAULTS, ...spec.train };
  const C = o.trees / o.every;
  const { trees, digests } = trainSegments(k, { S, spec, shard, toSeg: C, onSegment });
  return { trees, digests, root: rootOf(k, digests), treesHash: treesHash(k, trees) };
}

/**
 * A verifier's answer for segment s of a job: re-runs it from the job's published trees. Published trees
 * that are missing or do not hash to the committed treesHash give UNAVAILABLE (the trainer did not make its
 * work checkable). The answer is the verifier's own digest, never copied from the trainer.
 */
export function verifySegment(k, { S, spec, shard, published, committedTreesHash, segment }) {
  const o = { ...TRAIN_DEFAULTS, ...spec.train };
  if (!published || treesHash(k, published) !== String(committedTreesHash).toLowerCase()) return UNAVAILABLE(k);
  const { digests } = trainSegments(k, { S, spec, shard, prefix: published.slice(0, segment * o.every), fromSeg: segment, toSeg: segment + 1 });
  return digests[0];
}

// ------------------------------------------------------------------ the candidate and its evaluation
/**
 * The candidate model: the base trees, then every passed job's trees with their leaf values divided by the
 * number of passed jobs (an average of the jobs' boosting steps), in job order. Its id is what
 * TrainingMarket computes: keccak(baseModel ‖ treesHash_1 ‖ …) over the passed jobs.
 */
export function candidateOf(k, base, baseHash, jobs) {
  const P = jobs.length;
  const trees = [...base.trees];
  for (const j of jobs) for (const t of j.trees) trees.push(t.map((v, i) => (i % NODE === 4 ? v / P : v)));
  const id = kh(k, concat([fromHex(baseHash), ...jobs.map((j) => fromHex(j.treesHash))]));
  return { model: { ...base, trees }, id };
}

/** ROC AUC of scores (ties half), recall at a false-positive rate: counts and exact halves only. */
export function aucOf(scores, y) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b] || a - b);
  let rank = 0, pos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let q = i; q <= j; q++) if (y[idx[q]]) { rank += avg; pos++; }
    i = j + 1;
  }
  const neg = y.length - pos;
  return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : 0;
}
export function recallAt(scores, y, fpr) {
  const neg = scores.filter((_, i) => !y[i]).sort((a, b) => b - a);
  const pos = scores.filter((_, i) => y[i]);
  if (!neg.length || !pos.length) return 0;
  const t = neg[Math.floor(fpr * neg.length)];
  return pos.filter((s) => s > t).length / pos.length;
}

/** Held-out rows: the evaluation pool's ids that the revealed seed picks (about half). */
export function heldoutIds(seedHex, from, to) {
  return range(from, to).filter((i) => rng(`${String(seedHex).toLowerCase()}:${i}`)() >>> 31 === 0);
}

/** An evaluator's answer: AUC and recall at 1% FPR of the base and of the candidate, in 1/10,000. */
export function evaluate(base, candidate, rows) {
  const y = rows.map((r) => r.y);
  const sb = rows.map((r) => margin(base, r.x));
  const sc = rows.map((r) => margin(candidate, r.x));
  const q = (v) => Math.round(v * 10000);
  return { baseAuc: q(aucOf(sb, y)), candAuc: q(aucOf(sc, y)), baseRecall: q(recallAt(sb, y, 0.01)), candRecall: q(recallAt(sc, y, 0.01)), n: rows.length };
}

// ------------------------------------------------------------------ the market's hashes (TrainingMarket.sol)
const enc = (types, values) => fromHex(encodeArgs(types, values));
export const trainCommitment = (k, root, tHash, worker, salt, taskId) =>
  kh(k, enc(['bytes32', 'bytes32', 'address', 'bytes32', 'uint256'], [root, tHash, worker, salt, BigInt(taskId)]));
/** A sealed answer (a verifier's segment digest, or an evaluator's evalAnswer) on check `checkId` of a task. */
export const answerCommitment = (k, answer, who, salt, taskId, checkId) =>
  kh(k, enc(['bytes32', 'address', 'bytes32', 'uint256', 'uint256'], [answer, who, salt, BigInt(taskId), BigInt(checkId)]));
export const verifyCommitment = answerCommitment;
/** An evaluator's answer: keccak(abi.encode(baseAuc, candAuc, baseRecall, candRecall)), uint32 each. */
export const evalAnswer = (k, a) => kh(k, enc(['uint32', 'uint32', 'uint32', 'uint32'], [a.baseAuc, a.candAuc, a.baseRecall, a.candRecall]));
export const heldoutCommitment = (k, secret, poster) => kh(k, enc(['bytes32', 'address'], [secret, poster]));
export const heldoutSeedOf = (k, secret, randomness) => kh(k, enc(['bytes32', 'bytes32'], [secret, randomness]));

/** The segments TrainingMarket samples for a job (distinct, from the draw's randomness). */
export function sampleSegments(k, randomness, job, segments, checks) {
  const out = [];
  for (let c = 0; c < Math.min(checks, segments); c++) {
    for (let nonce = 0; ; nonce++) {
      const s = Number(BigInt(kh(k, enc(['bytes32', 'uint256', 'uint256', 'uint256', 'uint256'], [randomness, 1n, BigInt(job), BigInt(c), BigInt(nonce)]))) % BigInt(segments));
      if (!out.includes(s)) { out.push(s); break; }
    }
  }
  return out;
}

/** P(a job with `faked` of `segments` segments faked is caught) when `checks` distinct segments are sampled. */
export function catchProbability(segments, faked, checks) {
  const s = Math.min(checks, segments);
  let miss = 1;
  for (let i = 0; i < s; i++) miss *= Math.max(0, segments - faked - i) / (segments - i);
  return 1 - miss;
}

/** The task description a poster publishes (its keccak is the on-chain specHash). `evalWorld`: where the held-out rows come from (default: `world`). */
export function makeSpec({ seed, world = 'v1', evalWorld = world, train = {}, shards, trainRange = [0, 2400], evalRange = [100000, 102000], baseModel }) {
  return { format: TRAIN_FORMAT, world, evalWorld, seed, shards, trainRange, evalRange, baseModel, train: { ...TRAIN_DEFAULTS, ...train } };
}
export const specText = (spec) => JSON.stringify(spec);

// ------------------------------------------------------------------ the practice / simulation model
/** An empty model in Neuro's format over the world's features. */
export const emptyModel = () => ({ format: MODEL_FORMAT, features: [...WORLD_FEATURES], base: 0, trees: [] });
/**
 * "The model in force" of the simulation and the browser's practice job: trees grown (deterministically) on the
 * source world v0. In production this is zetaphy-neuro/ml/model.json (the same tree format).
 */
export function baseModelOf(k, { rows = 1500, trees = 30, every = 3, seed = 'neuro-base' } = {}) {
  const empty = emptyModel();
  const S = prepare(worldRows('v0', range(0, rows)), empty);
  const model = { ...empty, trees: trainJob(k, { S, spec: { seed, train: { trees, every } }, shard: 'base' }).trees };
  return { model, hash: modelHash(k, model) };
}

/**
 * The browser's practice job (and its Node twin in the tests): train shard 0 of a 4-shard round from the base
 * model, spot-check `checks` segments as a verifier would, evaluate the candidate on held-out rows.
 * `on(event)`: { phase: 'base' | 'train' | 'check' | 'eval', segment?, of? }.
 */
export function practiceJob(k, { seed = 'practice', checks = 2, on = () => {} } = {}) {
  on({ phase: 'base' });
  const base = baseModelOf(k);
  const spec = makeSpec({ seed, shards: 4, baseModel: base.hash });
  const rows = worldRows(spec.world, shardIds(spec.trainRange[0], spec.trainRange[1], spec.shards, 0));
  const S = prepare(rows, base.model, spec.train);
  const C = spec.train.trees / spec.train.every;
  const job = trainJob(k, { S, spec, shard: 0, onSegment: (s) => on({ phase: 'train', segment: s + 1, of: C }) });
  const sampled = sampleSegments(k, kh(k, utf8(`${job.root}:check`)), 0, C, checks);
  const verified = sampled.map((s) => {
    on({ phase: 'check', segment: s + 1, of: C });
    const ok = verifySegment(k, { S, spec, shard: 0, published: job.trees, committedTreesHash: job.treesHash, segment: s }) === job.digests[s];
    return { segment: s, ok };
  });
  on({ phase: 'eval' });
  const cand = candidateOf(k, base.model, base.hash, [job]);
  const held = worldRows(spec.world, heldoutIds(kh(k, utf8(`${job.root}:heldout`)), spec.evalRange[0], spec.evalRange[1]));
  return { root: job.root, treesHash: job.treesHash, segments: C, rows: rows.length, verified, metrics: evaluate(base.model, cand.model, held), candidate: cand.id, base: base.hash };
}
