// Neuro federated learning: the trainable head on top of the fixed model.
//
// Boosted trees cannot be averaged across clients, so the GBDT (ml/model.json)
// stays fixed and federated learning trains a small logistic-regression head
// on top of it. Its inputs phi(x) are:
//   [ 1 (bias),
//     the GBDT margin (lets the head sharpen or soften the trees),
//     a short list of named features, each clamped to [-clampX, clampX]
//       (rules, owner tricks, simulation, market: where drift shows first),
//     optionally the leaf value of every tree (leaves: true; re-weights trees) ]
// and the score is
//   z(x) = margin_gbdt(x) + theta . phi(x),   p = sigmoid(calib.a * z + calib.b).
// theta = 0 gives exactly the committed model. theta is kept inside a ball
// ||theta|| <= maxNorm (applyDelta projects onto it), so however the updates
// were poisoned the head moves a score by at most maxNorm x ||phi(x)|| logits
// from the governance-approved trees, and combine.js still never lowers a
// rules verdict.
//
// Why a short feature list and no leaves by default: every update carries
// local differential-privacy noise of the same size in EVERY coordinate, so
// the signal-to-noise ratio falls with the dimension (see
// docs/future/federated.md for the simulation that compares both).
//
// Plain JS, no dependencies: the same code runs in a browser, a runner and
// Node. Hashes use WebCrypto (globalThis.crypto.subtle: browsers, Node >= 20).

import { margin } from '../model.js';

export const HEAD_FORMAT = 'neuro-ml-flhead/1';
export const DEFAULT_CLAMP = 8;
export const DEFAULT_MAX_NORM = 4;
/** Features the default head sees directly (all exist in ml/features.js). */
export const DEFAULT_HEAD_FEATURES = Object.freeze([
  'r_level', 'r_ctl_owner', 'r_ctl_renounced', 'r_ctl_unknown', 'r_ctl_upgradeable', 'r_name_link', 'r_lookalike',
  'r_unknown_pattern', 's_unknown_share', 's_cat_mint', 's_cat_blacklist', 's_cat_fee', 's_cat_trading',
  'p_caller_guard', 'p_origin_guard', 'p_time_gate', 'p_gasprice_gate', 'p_hash_guard', 'p_xor_guard', 'p_codesize_gate',
  'm_sim_ok', 'm_sim_tax_high', 'm_sim_cannot_sell', 'm_sell_tax', 'k_top_holder', 'k_top10', 'k_lp_locked', 'k_age',
]);
const NODE = 5;
const round7 = (x) => (x === 0 ? 0 : Number(x.toPrecision(7)));
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Size of theta for a model and a head spec. */
export const headDim = (model, spec = {}) => 2 + (spec.features ?? DEFAULT_HEAD_FEATURES).length + (spec.leaves ? model.trees.length : 0);

/** sha256 of a string or bytes, as 64 hex characters (WebCrypto). */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Named features or a vector in model order -> vector. */
function vectorOf(model, x) {
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return x;
  return model.features.map((n) => (Number.isFinite(x[n]) ? x[n] : 0));
}

/** Column of each head feature in the model's vector (cached per head). */
const cols = new WeakMap();
function columns(model, head) {
  let c = cols.get(head);
  if (!c) {
    c = head.features.map((n) => {
      const j = model.features.indexOf(n);
      if (j < 0) throw new Error(`head feature ${n} is not in the model`);
      return j;
    });
    cols.set(head, c);
  }
  return c;
}

/**
 * phi(x): the head's input vector (Float64Array of head.dim).
 * @param {object} model  checked GBDT model
 * @param {object} head   head (or spec {features, leaves, clampX})
 * @param {number[]|object} x
 */
export function headInputs(model, head, x) {
  const v = vectorOf(model, x);
  const J = columns(model, head);
  const T = model.trees.length;
  const out = new Float64Array(2 + J.length + (head.leaves ? T : 0));
  const clampX = head.clampX ?? DEFAULT_CLAMP;
  out[0] = 1;
  out[1] = margin(model, v);
  for (let k = 0; k < J.length; k++) {
    const a = Number.isFinite(v[J[k]]) ? v[J[k]] : 0;
    out[2 + k] = Math.max(-clampX, Math.min(clampX, a));
  }
  if (head.leaves) {
    for (let t = 0; t < T; t++) {
      const tree = model.trees[t];
      let i = 0;
      while (tree[i] >= 0) i = (v[tree[i]] <= tree[i + 1] ? tree[i + 2] : tree[i + 3]) * NODE;
      out[2 + J.length + t] = tree[i + 4];
    }
  }
  return out;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** A head that changes nothing (theta = 0) for a model. */
export function zeroHead(model, { round = 0, clampX = DEFAULT_CLAMP, features = DEFAULT_HEAD_FEATURES, leaves = false, maxNorm = DEFAULT_MAX_NORM } = {}) {
  const dim = headDim(model, { features, leaves });
  return { format: HEAD_FORMAT, model: model.id, features: [...features], leaves: !!leaves, clampX, maxNorm, dim, round, theta: new Array(dim).fill(0) };
}

/** Throws unless head fits model. */
export function checkHead(model, head) {
  if (!head || head.format !== HEAD_FORMAT) throw new Error('unsupported head format');
  if (head.model !== model.id) throw new Error(`head is for model ${head.model}, not ${model.id}`);
  if (!Array.isArray(head.features) || head.dim !== headDim(model, head)) throw new Error('head size does not fit the model');
  if (!Array.isArray(head.theta) || head.theta.length !== head.dim) throw new Error('head size does not fit the model');
  if (!head.theta.every(Number.isFinite)) throw new Error('head has a non-finite weight');
  if (!(head.maxNorm > 0) || norm(head.theta) > head.maxNorm * (1 + 1e-6)) throw new Error('head outside its trust region');
  columns(model, head);
  return head;
}

const norm = (v) => Math.sqrt(dot(v, v));

/** Logit before calibration: GBDT margin + theta . phi(x). */
export function headMargin(model, head, x) {
  const phi = headInputs(model, head, x);
  return phi[1] + dot(head.theta, phi);
}

/** Calibrated probability with the head. */
export function headProbability(model, head, x) {
  const c = model.calib ?? { a: 1, b: 0 };
  return sigmoid(c.a * headMargin(model, head, x) + c.b);
}

/** Same as headProbability for a precomputed (margin, phi), used in training loops. */
export function probabilityFrom(model, theta, phi) {
  const c = model.calib ?? { a: 1, b: 0 };
  return sigmoid(c.a * (phi[1] + dot(theta, phi)) + c.b);
}

/** The bytes a head's hash covers: canonical JSON of what changes its scores. */
export const headCanonical = (head) => JSON.stringify([head.format, head.model, head.features, !!head.leaves, head.clampX, head.maxNorm, head.dim, head.round, head.theta.map(round7)]);

/**
 * Fills head.hash (full sha256 hex, what updates and the registry refer to)
 * and head.id ("nfh-" + 12 hex). Weights are rounded to 7 significant digits first.
 */
export async function sealHead(head) {
  const theta = head.theta.map(round7);
  const h = { ...head, theta };
  const hash = await sha256Hex(headCanonical(h));
  return { ...h, id: 'nfh-' + hash.slice(0, 12), hash };
}

/**
 * theta + lr * delta, projected back into ||theta|| <= head.maxNorm, as a new
 * (unsealed) head for the next round.
 */
export function applyDelta(head, delta, lr = 1) {
  if (delta.length !== head.theta.length) throw new Error('delta size');
  let theta = head.theta.map((w, i) => w + lr * delta[i]);
  const n = norm(theta);
  if (n > head.maxNorm) theta = theta.map((w) => (w * head.maxNorm) / n);
  const { id, hash, ...rest } = head;
  void id; void hash;
  return { ...rest, round: head.round + 1, theta };
}
