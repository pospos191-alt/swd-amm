// Neuro federated learning: robust aggregation of one round.
//
// Runs where there is no always-on server: a scheduled GitHub Actions job or a
// runner (zetaphy-network/scripts/fl-aggregate.js). Deterministic: the same
// accepted updates give the same new head, byte for byte, on any machine, so
// anyone can recompute a proposed head before voting on it.
//
// Defences against poisoned updates:
//  1. Shape checks: right head, right round, the round's clip and noise, every
//     coordinate and the norm within what an honest clipped + noised update
//     reaches (with overwhelming probability), one update per sender (a
//     sender with two loses both).
//  2. Coordinate-wise trimmed mean (or median): with at most `trim` x n
//     attackers, every coordinate of the result lies between the smallest and
//     the largest HONEST value of that coordinate (boundedInfluence() checks it).
//  3. A minimum number of updates, a server learning rate < 1, and the
//     canary gate (gate.js) before anything is proposed to governance.

import { decodeUpdate } from './codec.js';
import { l2 } from './dp.js';

export const DEFAULT_AGG = Object.freeze({ method: 'trimmed', trim: 0.2, minUpdates: 20, serverLr: 1, sigmas: 6 });

/**
 * Checks one decoded update against the round. Returns null if fine, else the reason.
 * @param {object} u  decodeUpdate() output
 * @param {{headHash:string, round:number, dim:number, clip:number, z:number}} round
 */
export function rejectReason(u, round, { sigmas = DEFAULT_AGG.sigmas } = {}) {
  if (u.headHash !== round.headHash) return 'computed on another head';
  if (u.round !== round.round) return 'wrong round';
  if (u.values.length !== round.dim) return 'wrong size';
  if (Math.abs(u.clip - round.clip) > 1e-6) return 'wrong clip';
  if (Math.abs(u.z - round.z) > 1e-3) return 'wrong noise multiplier';
  const s = round.z * round.clip;
  const coordMax = round.clip + sigmas * s;
  for (const x of u.values) if (!Number.isFinite(x) || Math.abs(x) > coordMax) return 'coordinate out of range';
  const normMax = round.clip + s * (Math.sqrt(round.dim) + sigmas);
  if (l2(u.values) > normMax) return 'norm out of range';
  return null;
}

/** Coordinate-wise trimmed mean: drops the k = floor(trim x n) lowest and highest of each coordinate. */
export function trimmedMean(vectors, trim) {
  const n = vectors.length;
  const d = vectors[0].length;
  const k = Math.floor(trim * n);
  if (n - 2 * k <= 0) throw new Error('trim too large');
  const out = new Float64Array(d);
  const col = new Float64Array(n);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < n; j++) col[j] = vectors[j][i];
    col.sort();
    let s = 0;
    for (let j = k; j < n - k; j++) s += col[j];
    out[i] = s / (n - 2 * k);
  }
  return out;
}

export function coordMedian(vectors) {
  const n = vectors.length;
  const d = vectors[0].length;
  const out = new Float64Array(d);
  const col = new Float64Array(n);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < n; j++) col[j] = vectors[j][i];
    col.sort();
    out[i] = n % 2 ? col[(n - 1) / 2] : (col[n / 2 - 1] + col[n / 2]) / 2;
  }
  return out;
}

export function plainMean(vectors) {
  const d = vectors[0].length;
  const out = new Float64Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) out[i] += v[i];
  for (let i = 0; i < d; i++) out[i] /= vectors.length;
  return out;
}

export function robustAggregate(vectors, { method = DEFAULT_AGG.method, trim = DEFAULT_AGG.trim } = {}) {
  if (vectors.length === 0) throw new Error('no updates');
  if (method === 'mean') return plainMean(vectors);
  if (method === 'median') return coordMedian(vectors);
  if (method === 'trimmed') return trimmedMean(vectors, trim);
  throw new Error(`unknown method ${method}`);
}

/**
 * Aggregates one round's submissions.
 * @param {Array<{sender:string, bytes:Uint8Array}>} submissions  sender = verified address (signature or tx sender)
 * @param {{headHash:string, round:number, dim:number, clip:number, z:number}} round
 * @returns {{delta:Float64Array|null, accepted:string[], rejected:Array<{sender:string, why:string}>}}
 */
export function aggregateRound(submissions, round, opts = {}) {
  const o = { ...DEFAULT_AGG, ...opts };
  // A sender with more than one submission loses all of them: no "first one
  // wins" rule, so the result never depends on the order submissions arrived.
  const count = new Map();
  for (const s of submissions) { const k = String(s.sender).toLowerCase(); count.set(k, (count.get(k) ?? 0) + 1); }
  const accepted = [];
  const rejected = [];
  const vectors = [];
  const subs = submissions.map((s) => ({ ...s, sender: String(s.sender).toLowerCase() }))
    .sort((a, b) => (a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0));
  for (const s of subs) {
    if (count.get(s.sender) > 1) { rejected.push({ sender: s.sender, why: 'duplicate sender' }); continue; }
    let u;
    try { u = decodeUpdate(s.bytes); } catch (e) { rejected.push({ sender: s.sender, why: e.message }); continue; }
    const why = rejectReason(u, round, o);
    if (why) { rejected.push({ sender: s.sender, why }); continue; }
    accepted.push(s.sender);
    vectors.push(u.values);
  }
  if (vectors.length < o.minUpdates) return { delta: null, accepted, rejected, why: `only ${vectors.length} valid updates (< ${o.minUpdates})` };
  const agg = robustAggregate(vectors, o);
  return { delta: agg.map((x) => x * o.serverLr), accepted, rejected };
}

/**
 * The robustness bound, checked: true if every coordinate of `agg` lies within
 * [min, max] of the honest vectors' values for that coordinate.
 */
export function boundedInfluence(agg, honest) {
  for (let i = 0; i < agg.length; i++) {
    let lo = Infinity; let hi = -Infinity;
    for (const v of honest) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    if (agg[i] < lo - 1e-12 || agg[i] > hi + 1e-12) return false;
  }
  return true;
}
