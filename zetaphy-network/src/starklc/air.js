// The statement ("AIR") of the ZETAPHY STARK light client, the validator-set
// commitment and the messages signed by validators.
//
// One trace row per validator (sorted by consensus address), padded with zero
// rows to N = max(8, next power of two >= n + 1) rows, so the last row is
// always padding.
//
// Set columns: fixed for a validator-set epoch, committed once in the SET ROOT.
//   A  consensus address (20 bytes, as an integer)
//   K  digest of the ML-DSA-44 vote key (31 bytes of SHA-256, domain separated), 0 = no key
//   Z  1 if the validator has no vote key (counts in U, may not sign), else 0
//   P  voting power (< 2^64)
// Witness columns: per block, committed in the proof's TRACE ROOT.
//   B   1 if the validator's ML-DSA signature is in the certificate (the bitmap)
//   G   digest of that signature (31 bytes of SHA-256), 0 when B = 0
//   CS  running sum of B*P (signed power before this row)
//   CT  running sum of P   (total power)
//   CU  running sum of Z*P (power without a key)
//   CC  running sum of B   (number of signers)
// Constraints (every row):          B(B-1)=0  (1-B)G=0  BZ=0  Z(Z-1)=0  ZK=0
// Transition (row i -> i+1, i<N-1): CS'=CS+BP  CT'=CT+P  CU'=CU+ZP  CC'=CC+B
// Boundary: first row CS=CT=CU=CC=0; last row CS=S, CT=T, CU=U, CC=C, P=0.
// So the public S, T, U, C are exactly signed power, total power, keyless
// power and signer count of the committed set with the committed bitmap, and
// the chain's rule (zetaphy_pqcert.go) is checked on them by the verifier:
//   3 * S > 2T - 3U   (nothing required when 2T - 3U < 0).
// Powers are < 2^64 and n < 2^20, so no sum wraps around the 252-bit field.
//
// The set root commits to the low-degree extension of the set columns (the
// same domain and Merkle layout as the trace), so the block proof opens set
// values exactly like trace values ("preprocessed columns"): no hash has to be
// computed inside the STARK. Anyone holding the validator list recomputes the
// root (buildSet) bit for bit.

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { P as FP, add, sub, mul, intt, cosetEval, rootOfUnity, log2, bytesToBigInt, GENERATOR } from './field.js';
import { buildTree, fieldLeaf, concat } from './hash.js';
import { voteMessage } from '../pqcert.js';

export const TRACE_COLS = ['B', 'G', 'CS', 'CT', 'CU', 'CC'];
export const SET_COLS = ['A', 'K', 'Z', 'P'];
export const NEXT_COLS = [2, 3, 4, 5]; // trace columns also read on the next row (CS, CT, CU, CC)
export const NUM_CONSTRAINTS = 5 + 4 + 9;
export const COSET = GENERATOR; // the LDE domain is 3 * <w_L>, disjoint from the trace domain <w_N>
export const DEFAULT_LOG_BLOWUP = 4; // blowup 16
export const PUBLIC_KEY_BYTES = 1312;
export const SIGNATURE_BYTES = 2420;

const utf8 = (s) => new TextEncoder().encode(s);
const digest31 = (tag, b) => bytesToBigInt(sha256(concat(utf8(tag), b)).subarray(0, 31));
/** K column value of an ML-DSA-44 public key. */
export const pkDigest = (pk) => digest31('zetaphy/starklc/pk\0', pk);
/** G column value of an ML-DSA-44 signature. */
export const sigDigest = (sig) => digest31('zetaphy/starklc/sig\0', sig);
export const addressField = (hex) => bytesToBigInt(hexToBytes(String(hex).replace(/^0x/i, '').toLowerCase()));

export const traceLength = (n) => { let N = 8; while (N < n + 1) N *= 2; return N; };

/** Validators sorted by address, checked: [{ address (upper hex), power (BigInt), pubKey (bytes|null) }]. */
export function canonicalValidators(validators) {
  const vs = validators.map((v) => {
    const address = String(v.address).replace(/^0x/i, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(address)) throw new Error(`set: ${v.address} is not a 20-byte address`);
    const power = BigInt(v.power);
    if (power <= 0n || power >= 1n << 64n) throw new Error(`set: ${address} power out of range`);
    const pubKey = v.pubKey == null ? null : (typeof v.pubKey === 'string' ? hexToBytes(v.pubKey) : v.pubKey);
    if (pubKey && pubKey.length !== PUBLIC_KEY_BYTES) throw new Error(`set: ${address} key is not ${PUBLIC_KEY_BYTES} bytes`);
    return { address, power, pubKey };
  }).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  if (!vs.length) throw new Error('set: no validators');
  for (let i = 1; i < vs.length; i++) if (vs[i].address === vs[i - 1].address) throw new Error(`set: ${vs[i].address} listed twice`);
  if (vs.length >= 1 << 20) throw new Error('set: too many validators');
  return vs;
}

/** Low-degree extension of columns (each length N) on the coset 3 * <w_L>; returns { coeffs, lde }. */
export function extend(cols, L) {
  const N = cols[0].length;
  const wN = rootOfUnity(N);
  const coeffs = cols.map((c) => intt(c, wN));
  return { coeffs, lde: coeffs.map((c) => cosetEval(c, L, COSET)) };
}

/** Merkle tree of LDE columns: leaf i (i < L/2) holds every column at positions i and i + L/2. */
export function commitColumns(lde) {
  const half = lde[0].length / 2;
  const leaves = new Array(half);
  for (let i = 0; i < half; i++) leaves[i] = fieldLeaf([...lde.map((c) => c[i]), ...lde.map((c) => c[i + half])]);
  return buildTree(leaves);
}

/**
 * The committed validator set. validators: [{ address, power, pubKey|null }].
 * Returns { validators (sorted), n, N, logN, logBlowup, L, cols, coeffs, lde, tree, root, pin }.
 */
export function buildSet(validators, { logBlowup = DEFAULT_LOG_BLOWUP } = {}) {
  const vs = canonicalValidators(validators);
  const N = traceLength(vs.length), L = N << logBlowup;
  const col = () => new Array(N).fill(0n);
  const [A, K, Z, Pw] = [col(), col(), col(), col()];
  vs.forEach((v, i) => {
    A[i] = addressField(v.address);
    K[i] = v.pubKey ? pkDigest(v.pubKey) : 0n;
    Z[i] = v.pubKey ? 0n : 1n;
    Pw[i] = v.power;
  });
  const cols = [A, K, Z, Pw];
  const { coeffs, lde } = extend(cols, L);
  const tree = commitColumns(lde);
  const root = tree.root;
  return { validators: vs, n: vs.length, N, logN: log2(N), logBlowup, L, cols, coeffs, lde, tree, root,
    pin: { root: bytesToHex(root), logN: log2(N), logBlowup } };
}

/** Constraint numerators at one point. t: trace (6), tn: next-row CS,CT,CU,CC (4), s: set (4). */
export function constraintNumerators(t, tn, s) {
  const [B, G, CS, CT, CU, CC] = t;
  const [, K, Z, Pw] = s;
  return {
    all: [mul(B, sub(B, 1n)), mul(sub(1n, B), G), mul(B, Z), mul(Z, sub(Z, 1n)), mul(Z, K)],
    trans: [sub(sub(tn[0], CS), mul(B, Pw)), sub(sub(tn[1], CT), Pw), sub(sub(tn[2], CU), mul(Z, Pw)), sub(sub(tn[3], CC), B)],
  };
}

/** Boundary constraints: { src: 't'|'s', col, last: bool, value }. */
export function boundaries({ S, T, U, C }) {
  return [
    ...[2, 3, 4, 5].map((col) => ({ src: 't', col, last: false, value: 0n })),
    { src: 't', col: 2, last: true, value: S }, { src: 't', col: 3, last: true, value: T },
    { src: 't', col: 4, last: true, value: U }, { src: 't', col: 5, last: true, value: C },
    { src: 's', col: 3, last: true, value: 0n },
  ];
}

/**
 * The composition value at x given 1/(x^N - 1), 1/(x - 1), 1/(x - w^(N-1)) and
 * (x - w^(N-1)): sum of alpha_k * constraint_k / its zerofier.
 */
export function composition(t, tn, s, alphas, bounds, { invZh, invFirst, invLast, xMinusLast }) {
  const { all, trans } = constraintNumerators(t, tn, s);
  let a = 0n, k = 0;
  for (const c of all) a = (a + alphas[k++] * c) % FP;
  let b = 0n;
  for (const c of trans) b = (b + alphas[k++] * c) % FP;
  let acc = ((a + b * xMinusLast) % FP) * invZh % FP;
  for (const bd of bounds) {
    const v = bd.src === 't' ? t[bd.col] : s[bd.col];
    acc = add(acc, mul(alphas[k++], mul(sub(v, bd.value), bd.last ? invLast : invFirst)));
  }
  return acc;
}

// ---- statements and the messages validators sign ----

const u64be = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };

/**
 * A statement: { kind: 'block', chainId, height, hash (32 bytes) } - "block `height`
 * with hash `hash` is certified" - or { kind: 'handoff', chainId, height: next epoch,
 * hash: next set root (32 bytes), nextLogN, nextLogBlowup } - "the validator set of
 * epoch `height` has this root".
 */
export function statementMessage(st) {
  if (!(st.hash instanceof Uint8Array) || st.hash.length !== 32) throw new Error('statement: hash must be 32 bytes');
  if (st.kind === 'block') return voteMessage(st.chainId, st.height, st.hash);
  if (st.kind === 'handoff') {
    return concat(utf8(`zetaphy/pq-setroot\0${st.chainId}\0`), u64be(st.height), st.hash,
      Uint8Array.of(st.nextLogN, st.nextLogBlowup ?? DEFAULT_LOG_BLOWUP));
  }
  throw new Error(`statement: unknown kind ${st.kind}`);
}
