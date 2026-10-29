// Neuro ML on-chain: the fixed-point form of ml/model.json.
//
// The on-chain scorer (zetaphy-network/contracts/NeuroScore.sol) and the
// zero-knowledge circuit (ml/onchain/zk/) cannot use floating point, so the
// model is exported to integers with one scale S = 1e7:
//
//   feature   X = round(x * S), clamped to 0 .. 2^32-1   (every Neuro feature is >= 0)
//   threshold T = round(t * S)                          (a row goes left when X <= T)
//   leaf      V = round(v * S)  (int32), base B0 = round(base * S)
//   margin    Z = B0 + sum of the leaves reached
//   score     s = trunc(A * Z / S) + Cb   with A = round(calib.a * S), Cb = round(calib.b * S)
//
// s is the calibrated logit times S: p = sigmoid(s / S). A level is reached
// when s >= round(logit(threshold) * S). Because round() is monotone, a row
// can only take another branch than the float model when its value is within
// 1/S (1e-7) of a threshold, and then only to the left.
//
// Packed bytes (big-endian), exactly what the contract reads:
//   0  "NSM1"            4
//   4  nFeatures u16     2
//   6  nTrees    u16     2
//   8  scale     u32     4   (1e7)
//   12 base      i32     4
//   16 calibA    i32     4
//   20 calibB    i32     4
//   24 node count per tree, u8 each (nTrees bytes)
//   .. nodes, 6 bytes each, trees one after another, pre-order (left child = next node):
//        internal: [feature u8][threshold u32][right child index in the tree u8]
//        leaf:     [0xFF][value i32][0x00]
//
// Plain JS, no dependencies.

export const SCALE = 10_000_000;
export const MAGIC = 'NSM1';
export const HEADER = 24;
export const NODE_BYTES = 6;
export const LEAF = 0xff;
const NODE = 5; // ml/model.json node width
const U32 = 2 ** 32 - 1;
const I32 = 2 ** 31;

const logit = (p) => Math.log(p / (1 - p));

/** Float feature value -> the integer the chain sees. */
export function quantizeFeature(x) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(U32, Math.round(x * SCALE));
}

/** Feature vector (model order, floats) -> integers. */
export const quantizeVector = (v) => Array.from(v, quantizeFeature);

/** Integers -> the calldata NeuroScore takes: nFeatures x u32 big-endian, as 0x hex. */
export function packFeatures(q) {
  let hex = '0x';
  for (const x of q) {
    if (!Number.isInteger(x) || x < 0 || x > U32) throw new Error(`feature ${x} out of u32`);
    hex += x.toString(16).padStart(8, '0');
  }
  return hex;
}

function i32(x, what) {
  const r = Math.round(x * SCALE);
  if (r < -I32 || r >= I32) throw new Error(`${what} ${x} does not fit int32 at scale ${SCALE}`);
  return r;
}

/**
 * ml/model.json -> { bytes: Uint8Array, nodes, levels: {low, medium, high} (fixed calibrated logits) }.
 * Throws if the model cannot be represented (more than 255 features or nodes per tree, a negative threshold).
 */
export function exportFixed(model) {
  const nf = model.features.length;
  if (nf > 255) throw new Error('more than 255 features');
  const trees = model.trees;
  if (trees.length > 65535) throw new Error('too many trees');
  let nodes = 0;
  for (const t of trees) {
    const n = t.length / NODE;
    if (n > 255) throw new Error('a tree has more than 255 nodes');
    nodes += n;
  }
  const bytes = new Uint8Array(HEADER + trees.length + nodes * NODE_BYTES);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = MAGIC.charCodeAt(i);
  dv.setUint16(4, nf);
  dv.setUint16(6, trees.length);
  dv.setUint32(8, SCALE);
  dv.setInt32(12, i32(model.base, 'base'));
  const calib = model.calib ?? { a: 1, b: 0 };
  if (!(calib.a > 0)) throw new Error('calibration slope must be > 0 (levels are thresholds on the logit)');
  dv.setInt32(16, i32(calib.a, 'calib.a'));
  dv.setInt32(20, i32(calib.b, 'calib.b'));
  let o = HEADER + trees.length;
  trees.forEach((t, k) => {
    const n = t.length / NODE;
    bytes[HEADER + k] = n;
    for (let i = 0; i < n; i++) {
      const [f, thr, left, right, value] = t.slice(i * NODE, i * NODE + NODE);
      if (f >= 0) {
        if (left !== i + 1) throw new Error(`tree ${k} node ${i}: not pre-order`);
        if (thr < 0) throw new Error(`tree ${k} node ${i}: negative threshold (features are >= 0)`);
        bytes[o] = f;
        if (Math.round(thr * SCALE) >= U32) throw new Error(`tree ${k} node ${i}: threshold ${thr} above the u32 feature range at scale ${SCALE}`);
        dv.setUint32(o + 1, Math.round(thr * SCALE));
        bytes[o + 5] = right;
      } else {
        bytes[o] = LEAF;
        dv.setInt32(o + 1, i32(value, `tree ${k} leaf ${i}`));
        bytes[o + 5] = 0;
      }
      o += NODE_BYTES;
    }
  });
  const th = model.thresholds ?? {};
  const levels = {};
  for (const k of ['low', 'medium', 'high']) if (th[k] != null) levels[k] = Math.round(logit(th[k]) * SCALE);
  return { bytes, nodes, levels };
}

/** Reads the header of packed bytes. */
export function header(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== MAGIC) throw new Error('not a NSM1 model');
  return { nFeatures: dv.getUint16(4), nTrees: dv.getUint16(6), scale: dv.getUint32(8), base: dv.getInt32(12), calibA: dv.getInt32(16), calibB: dv.getInt32(20) };
}

/**
 * Evaluates packed bytes on integer features, exactly as NeuroScore does.
 * @returns {{margin:number, score:number}} both integers (scale S)
 */
export function evalFixed(bytes, q) {
  const h = header(bytes);
  if (q.length !== h.nFeatures) throw new Error(`expected ${h.nFeatures} features, got ${q.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let z = h.base;
  let o = HEADER + h.nTrees;
  for (let k = 0; k < h.nTrees; k++) {
    const n = bytes[HEADER + k];
    let i = 0;
    for (;;) {
      const p = o + i * NODE_BYTES;
      const f = bytes[p];
      if (f === LEAF) { z += dv.getInt32(p + 1); break; }
      i = q[f] <= dv.getUint32(p + 1) ? i + 1 : bytes[p + 5];
    }
    o += n * NODE_BYTES;
  }
  // Solidity: int256 multiplication, then division truncating toward zero.
  const score = Number((BigInt(h.calibA) * BigInt(z)) / BigInt(h.scale)) + h.calibB;
  return { margin: z, score };
}

/** Level index the chain reports: 0 none, 1 low, 2 medium, 3 high. */
export function levelOf(score, levels) {
  if (levels.high != null && score >= levels.high) return 3;
  if (levels.medium != null && score >= levels.medium) return 2;
  if (levels.low != null && score >= levels.low) return 1;
  return 0;
}

/** Fixed calibrated logit -> probability (for display). */
export const scoreToProbability = (score) => 1 / (1 + Math.exp(-score / SCALE));

/** Probability -> the fixed calibrated logit a threshold is set in (e.g. the router's). */
export const probabilityToScore = (p) => Math.round(logit(p) * SCALE);

export const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
