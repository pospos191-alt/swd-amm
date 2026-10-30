// Pieces of the protocol shared by the prover and the verifier, so that both
// derive the same transcript, the same DEEP terms and the same query positions.

import { fieldsToBytes, mul, pow } from './field.js';
import { concat, u64 } from './hash.js';
import { statementMessage, NEXT_COLS } from './air.js';

export const VERSION = 1;
export const MODES = { none: 0, sample: 1, all: 2 };
export const MODE_NAMES = ['none', 'sample', 'all'];
export const DEFAULT_PARAMS = Object.freeze({ logBlowup: 4, queries: 28, grind: 16, logFinalDeg: 3 });

const utf8 = (s) => new TextEncoder().encode(s);

/** Bytes of a statement (also what the codec writes). */
export function statementBytes(st) {
  const chain = utf8(st.chainId);
  if (chain.length > 255) throw new Error('statement: chain id too long');
  return concat(Uint8Array.of(st.kind === 'handoff' ? 1 : 0, chain.length), chain, u64(st.height), st.hash,
    Uint8Array.of(st.kind === 'handoff' ? st.nextLogN : 0, st.kind === 'handoff' ? st.nextLogBlowup : 0));
}

/** What the transcript absorbs first: everything public, and the set root the proof is about. */
export function headerBytes(proof, setRoot) {
  const p = proof.params;
  return concat(Uint8Array.of(VERSION, p.logBlowup, p.queries, p.grind, p.logFinalDeg, proof.logN),
    setRoot, statementBytes(proof.statement), statementMessage(proof.statement),
    fieldsToBytes([proof.pub.S, proof.pub.T, proof.pub.U, proof.pub.C]),
    Uint8Array.of(MODES[proof.reveal.mode]), u64(proof.reveal.k));
}

export const revealBytes = (reveals) => concat(...reveals.map((r) => concat(u64(r.row), fieldsToBytes(r.vals))));

/**
 * The DEEP opening points and the columns opened at each:
 *   z:           every trace column, every set column, the composition Q
 *   z*w:         CS, CT, CU, CC (next-row values for the transition constraints)
 *   w^i (reveal) B, G, CS, A, K, P of the revealed row i
 *   w^(i+1)      CS of the next row (so CS_i <= r < CS_(i+1) can be checked)
 * terms: [{ src: 't'|'s'|'q', col }]; vals: the claimed values, same order.
 */
export function deepGroups(z, wN, ood, reveals) {
  const groups = [
    { pt: z, terms: [...[0, 1, 2, 3, 4, 5].map((col) => ({ src: 't', col })), ...[0, 1, 2, 3].map((col) => ({ src: 's', col })), { src: 'q', col: 0 }],
      vals: [...ood.t, ...ood.s, ood.q] },
    { pt: mul(z, wN), terms: NEXT_COLS.map((col) => ({ src: 't', col })), vals: ood.tn },
  ];
  for (const r of reveals) {
    const [B, G, CS, CSn, A, K, Pw] = r.vals;
    const w = pow(wN, r.row);
    groups.push({ pt: w, terms: [{ src: 't', col: 0 }, { src: 't', col: 1 }, { src: 't', col: 2 }, { src: 's', col: 0 }, { src: 's', col: 1 }, { src: 's', col: 3 }],
      vals: [B, G, CS, A, K, Pw] });
    groups.push({ pt: mul(w, wN), terms: [{ src: 't', col: 2 }], vals: [CSn] });
  }
  return groups;
}

/** Number of DEEP coefficients (one per term). */
export const deepTermCount = (groups) => groups.reduce((n, g) => n + g.terms.length, 0);

/** q distinct pair indices in [0, half), sorted (fewer when half < q). */
export function queryIndices(transcript, q, half) {
  const want = Math.min(q, half);
  const set = new Set();
  while (set.size < want) set.add(Number(transcript.below(half)));
  return [...set].sort((a, b) => a - b);
}

/** Number of FRI folds: down to a polynomial of degree < 2^logFinalDeg (sent in clear). */
export const friFolds = (logN, logFinalDeg) => Math.max(0, logN - logFinalDeg);

/** Rejection rule for the out-of-domain point: not in the trace domain, not in the LDE coset. */
export const badOodPoint = (z, N, L, cosetPowL) => pow(z, N) === 1n || pow(z, L) === cosetPowL || z === 0n;

/**
 * Soundness of the signature sampling: if validators with a valid ML-DSA signature
 * hold W <= need/3 (the rule fails) while the proof claims S, each power-weighted
 * sample hits a forged signer with probability >= 1 - need/(3S); all k pass with
 * probability <= (need/(3S))^k. Bits = k * log2(3S / need). Infinity when nothing is
 * required (need <= 0); 0 when 3S <= need (the rule fails anyway).
 */
export function sampleBits(k, S, need) {
  if (need <= 0n) return Infinity;
  if (3n * S <= need) return 0;
  return k * (log2Big(3n * S) - log2Big(need));
}
const log2Big = (x) => { const s = x.toString(2).length; const top = Number(x >> BigInt(Math.max(0, s - 53))); return Math.log2(top) + Math.max(0, s - 53); };

/** Samples needed for `bits` of signature-sampling soundness. */
export function samplesFor(bits, S, need) {
  if (need <= 0n || 3n * S <= need || !bits) return 0;
  return Math.ceil(bits / (log2Big(3n * S) - log2Big(need)));
}

/** Conjectured STARK soundness (ethSTARK-style): queries * log2(blowup) + grinding bits. */
export const starkBitsConjectured = (p) => p.queries * p.logBlowup + p.grind;
/**
 * Provable bound (Johnson / list-decoding regime, ignoring the small field
 * terms, which are < 2^-200 here): each query catches a far word with probability
 * >= 1 - sqrt(rho) where rho = 1/blowup, so bits = queries * log2(blowup) / 2 + grinding.
 */
export const starkBitsProvable = (p) => p.queries * p.logBlowup / 2 + p.grind;
