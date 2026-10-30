// Verifier of the ZETAPHY STARK light client. Runs in a browser or on a phone:
// SHA-256, BigInt field arithmetic and (only for revealed signatures) ML-DSA-44.
// Needs no RPC and no validator list: only the pinned set root of the epoch.

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { P as FP, add, sub, mul, inv, pow, batchInv, rootOfUnity, evalPoly } from './field.js';
import { Transcript, fieldLeaf, verifyMany, checkGrind, u64, equalBytes } from './hash.js';
import {
  composition, boundaries, pkDigest, sigDigest, statementMessage, COSET, NUM_CONSTRAINTS, PUBLIC_KEY_BYTES, SIGNATURE_BYTES,
} from './air.js';
import {
  headerBytes, revealBytes, deepGroups, deepTermCount, queryIndices, friFolds, badOodPoint, sampleBits,
  starkBitsConjectured, starkBitsProvable,
} from './protocol.js';
import { decodeProof } from './proof.js';

export class ProofError extends Error {}
const fail = (msg) => { throw new ProofError(msg); };

/**
 * Verifies a proof (bytes or decoded object) against a pinned set:
 *   pin: { root (hex or bytes), logN, logBlowup }
 *   chainId: the chain the statement must be about (required)
 *   minSigBits: the least signature-check security accepted (default 128;
 *     Infinity-complete 'all' proofs always pass; 0 accepts 'none' proofs,
 *     i.e. trusts the prover for ML-DSA validity)
 *   minStarkBits: the least conjectured STARK security accepted (default 100)
 * Returns { statement, S, T, U, C, required, ok, pqMajority, sigCheck, sigBits,
 *   starkBits: { conjectured, provable }, revealed, ms } or throws ProofError.
 * ok: the chain's rule (3S > 2T - 3U) holds for the proven numbers.
 */
export function verifyProof(input, { pin, chainId, minSigBits = 128, minStarkBits = 100 } = {}) {
  const t0 = (globalThis.performance ?? Date).now();
  if (!pin) fail('no pinned set');
  if (!chainId) fail('no chain id');
  let proof;
  try { proof = input instanceof Uint8Array ? decodeProof(input) : input; } catch (e) { fail(`malformed proof: ${e.message}`); }
  const setRoot = typeof pin.root === 'string' ? hexToBytes(pin.root) : pin.root;
  const prm = proof.params;
  if (proof.logN !== pin.logN) fail(`proof is for a set of 2^${proof.logN} rows, the pinned set has 2^${pin.logN}`);
  if (prm.logBlowup !== pin.logBlowup) fail('proof blowup differs from the pinned set');
  if (proof.statement.chainId !== chainId) fail(`proof is about chain ${proof.statement.chainId}, not ${chainId}`);
  const starkBits = { conjectured: starkBitsConjectured(prm), provable: starkBitsProvable(prm) };
  if (starkBits.conjectured < minStarkBits) fail(`STARK parameters give ${starkBits.conjectured} bits, below ${minStarkBits}`);
  if (prm.logFinalDeg > 10 || prm.queries < 1 || prm.grind > 40) fail('unsupported parameters');
  const N = 1 << proof.logN, L = N << prm.logBlowup, half = L / 2, beta = 1 << prm.logBlowup;
  const { S, T, U, C } = proof.pub;
  for (const v of [S, T, U, C]) if (v >= 1n << 100n) fail('public sums out of range');

  // ---- transcript replay ----
  const tr = new Transcript('proof');
  tr.absorb(headerBytes(proof, setRoot));
  tr.absorb(proof.traceRoot);
  const alphas = Array.from({ length: NUM_CONSTRAINTS }, () => tr.field());
  tr.absorb(proof.qRoot);
  const cosetPowL = pow(COSET, L);
  let z = tr.field();
  while (badOodPoint(z, N, L, cosetPowL)) z = tr.field();
  const wN = rootOfUnity(N), wL = rootOfUnity(L), wLast = pow(wN, N - 1);
  const { ood } = proof;
  tr.absorbFields([...ood.t, ...ood.tn, ...ood.s, ood.q]);

  // ---- the constraints hold at z: composition(z) = Q(z) ----
  const zh = sub(pow(z, N), 1n);
  const cz = composition(ood.t, ood.tn, ood.s, alphas, boundaries(proof.pub),
    { invZh: inv(zh), invFirst: inv(sub(z, 1n)), invLast: inv(sub(z, wLast)), xMinusLast: sub(z, wLast) });
  if (cz !== ood.q) fail('constraints do not hold at the out-of-domain point (forged witness or public values)');

  // ---- signature reveals ----
  const need = 2n * T - 3n * U;
  const mode = proof.reveal.mode, k = proof.reveal.k;
  const reveals = proof.reveals;
  for (let i = 1; i < reveals.length; i++) if (reveals[i].row <= reveals[i - 1].row) fail('reveals not sorted');
  for (const r of reveals) if (r.row >= N - 1) fail('reveal row out of range');
  if (mode === 'sample') {
    if (k !== proof.samples.length) fail('wrong number of samples');
    const used = new Set();
    for (let j = 0; j < k; j++) {
      const r = tr.below(S === 0n ? 1n : S);
      const ri = proof.samples[j];
      const rv = reveals[ri];
      if (!rv) fail('sample points to no reveal');
      const [, , CSi, CSn] = rv.vals;
      if (!(CSi <= r && r < CSn)) fail(`sample ${j} does not land on the revealed row ${rv.row}`);
      used.add(ri);
    }
    if (used.size !== reveals.length) fail('a revealed row was not sampled');
  } else if (mode === 'all') {
    if (BigInt(reveals.length) !== C) fail(`${reveals.length} signatures revealed but the proof counts ${C} signers`);
  } else if (reveals.length || proof.samples.length) fail('unexpected reveals');
  const message = statementMessage(proof.statement);
  for (const r of reveals) {
    const [B, G, , , , K] = r.vals;
    if (B !== 1n) fail(`revealed row ${r.row} is not a signer`);
    if (r.sig.length !== SIGNATURE_BYTES || r.pk.length !== PUBLIC_KEY_BYTES) fail('bad reveal sizes');
    if (pkDigest(r.pk) !== K) fail(`row ${r.row}: the revealed key is not the one in the validator set`);
    if (sigDigest(r.sig) !== G) fail(`row ${r.row}: the revealed signature is not the one committed in the certificate`);
    let good = false;
    try { good = ml_dsa44.verify(r.sig, message, r.pk); } catch { good = false; }
    if (!good) fail(`row ${r.row}: the ML-DSA-44 signature does not verify`);
  }
  tr.absorb(revealBytes(reveals));
  const sigBits = mode === 'all' ? Infinity : mode === 'sample' ? sampleBits(k, S, need) : (need <= 0n ? Infinity : 0);
  if (sigBits < minSigBits) fail(`signature checks give ${sigBits.toFixed(1)} bits (mode ${mode}), below the required ${minSigBits}`);

  // ---- DEEP coefficients, FRI challenges, grinding, queries ----
  const groups = deepGroups(z, wN, ood, reveals);
  const gammas = Array.from({ length: deepTermCount(groups) }, () => tr.field());
  const m = friFolds(proof.logN, prm.logFinalDeg);
  if (proof.friRoots.length !== Math.max(0, m - 1)) fail('wrong number of FRI layers');
  const betas = [];
  for (let k2 = 0; k2 < m; k2++) {
    betas.push(tr.field());
    if (k2 + 1 < m) tr.absorb(proof.friRoots[k2]);
  }
  if (proof.finalPoly.length !== N >> m) fail('wrong final polynomial size');
  tr.absorbFields(proof.finalPoly);
  if (!checkGrind(tr, prm.grind, proof.nonce)) fail('proof of work missing');
  tr.absorb(u64(proof.nonce));
  const idx = queryIndices(tr, prm.queries, half);

  // ---- Merkle openings of the trace, the pinned set and Q ----
  const depth = Math.log2(half);
  if (proof.traceLeaves.length !== idx.length || proof.setLeaves.length !== idx.length || proof.qLeaves.length !== idx.length) fail('wrong number of opened leaves');
  if (!verifyMany(proof.traceRoot, depth, idx, proof.traceLeaves.map(fieldLeaf), proof.traceProof)) fail('trace openings do not match the trace root');
  if (!verifyMany(setRoot, depth, idx, proof.setLeaves.map(fieldLeaf), proof.setProof)) fail('set openings do not match the pinned set root');
  if (!verifyMany(proof.qRoot, depth, idx, proof.qLeaves.map(fieldLeaf), proof.qProof)) fail('composition openings do not match');

  // ---- DEEP values f0(x), f0(-x) at each query ----
  const gsum = []; let gi = 0;
  const gcoef = groups.map((g) => {
    const gs = gammas.slice(gi, gi + g.terms.length); gi += g.terms.length;
    gsum.push(g.vals.reduce((a, v, j) => add(a, mul(gs[j], v)), 0n));
    return gs;
  });
  const deepAt = (x, t, s, q) => {
    const invs = batchInv(groups.map((g) => sub(x, g.pt)));
    let acc = 0n;
    groups.forEach((g, gi2) => {
      let num = 0n;
      g.terms.forEach((tm, j) => { num += gcoef[gi2][j] * (tm.src === 't' ? t[tm.col] : tm.src === 's' ? s[tm.col] : q); });
      acc = (acc + ((num - gsum[gi2]) % FP + FP) * invs[gi2]) % FP;
    });
    return acc;
  };
  let vals = idx.map((i, qi) => {
    const tl = proof.traceLeaves[qi], sl = proof.setLeaves[qi], ql = proof.qLeaves[qi];
    if (tl.length !== 12 || sl.length !== 8 || ql.length !== 2) fail('bad leaf size');
    const x = mul(COSET, pow(wL, i));
    return [deepAt(x, tl.slice(0, 6), sl.slice(0, 4), ql[0]), deepAt(sub(0n, x), tl.slice(6), sl.slice(4), ql[1])];
  });

  // ---- FRI folding checks ----
  const inv2 = inv(2n);
  let pos = idx, off = COSET, w = wL, size = L;
  for (let k2 = 0; k2 < m; k2++) {
    const h = size / 2;
    const folded = pos.map((i, qi) => {
      const [a0, a1] = vals[qi];
      const x = mul(off, pow(w, i));
      return add(mul(add(a0, a1), inv2), mul(betas[k2], mul(mul(sub(a0, a1), inv2), inv(x))));
    });
    off = mul(off, off); w = mul(w, w); size = h;
    if (k2 + 1 < m) {
      const layer = proof.friLayers[k2];
      const h2 = size / 2;
      const np = [...new Set(pos.map((i) => i % h2))].sort((a, b) => a - b);
      if (!layer || layer.leaves.length !== np.length) fail(`FRI layer ${k2 + 1}: wrong number of openings`);
      if (!verifyMany(proof.friRoots[k2], Math.log2(h2), np, layer.leaves.map(fieldLeaf), layer.proof)) fail(`FRI layer ${k2 + 1}: openings do not match its root`);
      pos.forEach((i, qi) => {
        const leaf = layer.leaves[np.indexOf(i % h2)];
        if (leaf[i >= h2 ? 1 : 0] !== folded[qi]) fail(`FRI layer ${k2 + 1}: folding check failed`);
      });
      vals = np.map((j) => layer.leaves[np.indexOf(j)]);
      pos = np;
    } else {
      pos.forEach((i, qi) => { if (evalPoly(proof.finalPoly, mul(off, pow(w, i))) !== folded[qi]) fail('FRI: final polynomial check failed'); });
    }
  }
  if (m === 0) {
    idx.forEach((i, qi) => {
      const x = mul(COSET, pow(wL, i));
      if (evalPoly(proof.finalPoly, x) !== vals[qi][0] || evalPoly(proof.finalPoly, sub(0n, x)) !== vals[qi][1]) fail('FRI: final polynomial check failed');
    });
  }

  const required = need < 0n ? 0n : need / 3n + 1n;
  return {
    statement: { ...proof.statement, hash: bytesToHex(proof.statement.hash) },
    S, T, U, C, required,
    ok: need < 0n || 3n * S > need,
    pqMajority: 3n * S > 2n * T,
    sigCheck: mode, sigBits, revealed: reveals.length,
    starkBits,
    ms: (globalThis.performance ?? Date).now() - t0,
  };
}

export { equalBytes };
