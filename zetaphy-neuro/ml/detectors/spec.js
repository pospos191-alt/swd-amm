// Detector "organisms" (docs/future/markets.md, item 26): a small, readable rule set over the
// features Neuro already computes (ml/features.js). Each rule fires when a feature crosses a
// threshold and adds its weight; the sum goes through a sigmoid:
//
//   p(trap) = sigmoid(bias + sum(weight_i * [feature_i op_i threshold_i]))
//
// A spec is JSON, so it can be stored at a URI with its keccak256 on chain (DetectorPool), mutated
// by mutate.js, and run by anyone in plain JS. It is not part of Neuro's rules or reportHash
// (ml/ is outside src/), so it never changes Neuro's skill id.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { FEATURES } from '../features.js';

export const SPEC_FORMAT = 'neuro-detector/1';
export const OPS = ['>=', '<'];
export const MAX_RULES = 24;
const KNOWN = new Set(FEATURES);
const r6 = (x) => (x === 0 ? 0 : Number(Number(x).toPrecision(6)));

/** Throws on anything but a well-formed spec; returns it normalised (numbers to 6 significant digits). */
export function checkSpec(spec) {
  if (!spec || spec.format !== SPEC_FORMAT) throw new Error(`spec: format must be ${SPEC_FORMAT}`);
  if (!Array.isArray(spec.rules) || spec.rules.length === 0 || spec.rules.length > MAX_RULES) throw new Error(`spec: 1..${MAX_RULES} rules`);
  const num = (v, what, lim) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) throw new Error(`spec: ${what} must be a number within ±${lim}`);
    return r6(v);
  };
  const rules = spec.rules.map((r, i) => {
    if (!KNOWN.has(r.feature)) throw new Error(`spec: rule ${i}: unknown feature ${r.feature}`);
    if (!OPS.includes(r.op)) throw new Error(`spec: rule ${i}: op must be one of ${OPS.join(' ')}`);
    return { feature: r.feature, op: r.op, threshold: num(r.threshold, `rule ${i} threshold`, 1e9), weight: num(r.weight, `rule ${i} weight`, 20) };
  });
  return { format: SPEC_FORMAT, name: String(spec.name ?? '').slice(0, 64), bias: num(spec.bias ?? 0, 'bias', 20), rules, ...(spec.parent ? { parent: String(spec.parent).slice(0, 80) } : {}) };
}

/** Canonical bytes: fixed key order, normalised numbers. specHash is keccak256 of these bytes. */
export function canonical(spec) {
  const s = checkSpec(spec);
  const ordered = { format: s.format, name: s.name, bias: s.bias, rules: s.rules.map((r) => ({ feature: r.feature, op: r.op, threshold: r.threshold, weight: r.weight })) };
  if (s.parent) ordered.parent = s.parent;
  return JSON.stringify(ordered);
}

export const specHash = (spec) => '0x' + bytesToHex(keccak_256(utf8ToBytes(canonical(spec))));

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** p(trap) for one row's features ({name: value}, missing = 0, as in ml/). */
export function predict(spec, f) {
  let z = spec.bias ?? 0;
  for (const r of spec.rules) {
    const v = f?.[r.feature] ?? 0;
    if (r.op === '>=' ? v >= r.threshold : v < r.threshold) z += r.weight;
  }
  return sigmoid(z);
}

/** The probability a detector commits in ForesightRegistry, in basis points (1..9999: never certain). */
export const toBps = (p) => Math.min(9999, Math.max(1, Math.round(p * 10_000)));

/** Mean Brier score of a spec over labelled rows (rows: {label, f, weight?}); lower is better, 0.25 = coin flip. */
export function brierOf(spec, rows) {
  let s = 0; let w = 0;
  for (const r of rows) {
    const p = toBps(predict(spec, r.f)) / 10_000;
    const wt = r.weight ?? 1;
    s += wt * (p - r.label) ** 2; w += wt;
  }
  return w ? s / w : null;
}

/**
 * Proof of Foresight as a weight (item 29): combines several models' / detectors' probabilities,
 * each weighted by its on-chain ForesightRegistry.skill(modelId) (basis points, 0 = no better than
 * a coin flip). Models without a track record get no say; with no skilled model at all the plain
 * mean is returned. Advisory, like the ML score: it may inform what Neuro shows, never the verdict.
 * @param {{p:number, skillBps:number}[]} preds
 */
export function foresightWeighted(preds) {
  const ok = preds.filter((x) => Number.isFinite(x.p) && x.p >= 0 && x.p <= 1);
  if (!ok.length) return null;
  const tot = ok.reduce((s, x) => s + Math.max(0, x.skillBps ?? 0), 0);
  if (tot === 0) return ok.reduce((s, x) => s + x.p, 0) / ok.length;
  return ok.reduce((s, x) => s + x.p * Math.max(0, x.skillBps ?? 0), 0) / tot;
}

/** A first detector built from what the rules + simulation already say (the seed of the population). */
export function seedSpec() {
  return checkSpec({
    format: SPEC_FORMAT, name: 'seed-rules-sim', bias: -2,
    rules: [
      { feature: 'r_level', op: '>=', threshold: 2, weight: 2.5 },
      { feature: 'm_sim_cannot_sell', op: '>=', threshold: 1, weight: 4 },
      { feature: 'm_sim_tax_high', op: '>=', threshold: 1, weight: 3 },
      { feature: 'p_hash_guard', op: '>=', threshold: 0.5, weight: 1 },
      { feature: 'r_ctl_renounced', op: '>=', threshold: 1, weight: -0.5 },
    ],
  });
}
