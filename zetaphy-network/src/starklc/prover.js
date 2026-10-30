// Prover of the ZETAPHY STARK light client (runs server-side / in CI from a
// node's data; not meant for phones). Proves, for a committed validator set
// (buildSet) and a bitmap of signers, the statement described in air.js, with
// DEEP-ALI + FRI over the Stark252 field and SHA-256 commitments.

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { P as FP, add, sub, mul, inv, pow, batchInv, rootOfUnity, cosetInterpolate, evalPoly } from './field.js';
import { Transcript, openMany, grind, u64 } from './hash.js';
import {
  extend, commitColumns, composition, boundaries, sigDigest, statementMessage, COSET, NUM_CONSTRAINTS, NEXT_COLS,
} from './air.js';
import {
  DEFAULT_PARAMS, headerBytes, revealBytes, deepGroups, deepTermCount, queryIndices, friFolds, badOodPoint, samplesFor,
} from './protocol.js';

/**
 * Proves a statement for `set` (buildSet output).
 * signatures: Map or object { <address upper hex>: signature bytes } of the signers
 *   (each must verify; checkSignatures: false skips that, for tests of forged input).
 * reveal: 'all' (every signer's signature and key go in the proof: complete check),
 *   'sample' (power-weighted samples, enough for `sigBits` bits), or 'none'
 *   (signature validity is trusted: the proof only does the accounting).
 * Returns the proof object (encode it with proof.js encodeProof).
 */
export function prove({ set, statement, signatures, reveal = 'all', sigBits = 128, params = {}, checkSignatures = true, onInvalid = 'throw', hooks = {} }) {
  const prm = { ...DEFAULT_PARAMS, logBlowup: set.logBlowup, ...params };
  if (prm.logBlowup !== set.logBlowup) throw new Error('prove: blowup must match the set commitment');
  if (!['all', 'sample', 'none'].includes(reveal)) throw new Error(`prove: unknown reveal mode ${reveal}`);
  const { N, L, logN } = set;
  const half = L / 2, beta = 1 << prm.logBlowup;
  const message = statementMessage(statement);
  const sigs = signatures instanceof Map ? signatures : new Map(Object.entries(signatures ?? {}));

  // ---- witness ----
  const col = () => new Array(N).fill(0n);
  const [B, G, CS, CT, CU, CC] = [col(), col(), col(), col(), col(), col()];
  const rowSig = new Map();
  const skipped = [];
  set.validators.forEach((v, i) => {
    const sig = sigs.get(v.address) ?? sigs.get(v.address.toLowerCase());
    if (!sig) return;
    if (!v.pubKey) throw new Error(`prove: ${v.address} has no vote key and cannot sign`);
    if (checkSignatures && !safeVerify(sig, message, v.pubKey)) {
      if (onInvalid === 'skip') { skipped.push(v.address); return; }
      throw new Error(`prove: the signature of ${v.address} does not verify`);
    }
    B[i] = 1n; G[i] = sigDigest(sig); rowSig.set(i, sig);
  });
  const [, , Z, Pw] = set.cols;
  for (let i = 0; i < N - 1; i++) {
    CS[i + 1] = add(CS[i], mul(B[i], Pw[i]));
    CT[i + 1] = add(CT[i], Pw[i]);
    CU[i + 1] = add(CU[i], mul(Z[i], Pw[i]));
    CC[i + 1] = add(CC[i], B[i]);
  }
  const trace = [B, G, CS, CT, CU, CC];
  const pub = { S: CS[N - 1], T: CT[N - 1], U: CU[N - 1], C: CC[N - 1] };
  hooks.witness?.(trace, pub); // tests: forge the witness or the public values

  const need = 2n * pub.T - 3n * pub.U;
  const k = reveal === 'sample' ? samplesFor(sigBits, pub.S, need) : 0;
  const proof = { version: 1, params: prm, logN, statement, pub, reveal: { mode: reveal, k } };
  Object.defineProperty(proof, 'skipped', { value: skipped, enumerable: false }); // signers dropped (invalid signature)

  // ---- trace commitment ----
  const { coeffs: tCoeffs, lde: tLde } = extend(trace, L);
  const tTree = commitColumns(tLde);
  const tr = new Transcript('proof');
  tr.absorb(headerBytes(proof, set.root));
  tr.absorb(tTree.root);
  proof.traceRoot = tTree.root;
  const alphas = Array.from({ length: NUM_CONSTRAINTS }, () => tr.field());

  // ---- composition polynomial Q on the LDE coset ----
  const wL = rootOfUnity(L), wN = rootOfUnity(N);
  const wLast = pow(wN, N - 1);
  const xs = new Array(L);
  xs[0] = COSET;
  for (let i = 1; i < L; i++) xs[i] = mul(xs[i - 1], wL);
  const invZh = batchInv(xs.map((x) => sub(pow(x, N), 1n)));
  const invFirst = batchInv(xs.map((x) => sub(x, 1n)));
  const invLast = batchInv(xs.map((x) => sub(x, wLast)));
  const bounds = boundaries(pub);
  const sLde = set.lde;
  const qLde = new Array(L);
  for (let i = 0; i < L; i++) {
    const j = (i + beta) % L; // x * w_N is `beta` steps further on the LDE coset
    qLde[i] = composition(tLde.map((c) => c[i]), NEXT_COLS.map((c) => tLde[c][j]), sLde.map((c) => c[i]), alphas, bounds,
      { invZh: invZh[i], invFirst: invFirst[i], invLast: invLast[i], xMinusLast: sub(xs[i], wLast) });
  }
  const qTree = commitColumns([qLde]);
  tr.absorb(qTree.root);
  proof.qRoot = qTree.root;
  const qCoeffs = cosetInterpolate(qLde, COSET);

  // ---- out-of-domain point ----
  const cosetPowL = pow(COSET, L);
  let z = tr.field();
  while (badOodPoint(z, N, L, cosetPowL)) z = tr.field();
  const zw = mul(z, wN);
  proof.ood = {
    t: tCoeffs.map((c) => evalPoly(c, z)),
    tn: NEXT_COLS.map((c) => evalPoly(tCoeffs[c], zw)),
    s: set.coeffs.map((c) => evalPoly(c, z)),
    q: evalPoly(qCoeffs, z),
  };
  tr.absorbFields([...proof.ood.t, ...proof.ood.tn, ...proof.ood.s, proof.ood.q]);

  // ---- signature reveals ----
  let rows = [];
  proof.samples = [];
  if (reveal === 'all') rows = [...rowSig.keys()];
  if (reveal === 'sample' && k) {
    const picked = [];
    for (let j = 0; j < k; j++) {
      const r = tr.below(pub.S);
      let i = 0;
      while (i < N - 1 && !(CS[i] <= r && r < CS[i + 1])) i++;
      picked.push(i);
    }
    rows = [...new Set(picked)];
    rows.sort((a, b) => a - b);
    proof.samples = picked.map((i) => rows.indexOf(i));
  }
  rows.sort((a, b) => a - b);
  proof.reveals = rows.map((i) => ({
    row: i, vals: [B[i], G[i], CS[i], CS[i + 1] ?? 0n, ...[0, 1, 3].map((c) => set.cols[c][i])],
    sig: rowSig.get(i) ?? new Uint8Array(2420), pk: set.validators[i]?.pubKey ?? new Uint8Array(1312),
  }));
  tr.absorb(revealBytes(proof.reveals));

  // ---- DEEP composition f0 ----
  const groups = deepGroups(z, wN, proof.ood, proof.reveals);
  const gammas = Array.from({ length: deepTermCount(groups) }, () => tr.field());
  const srcLde = { t: tLde, s: sLde, q: [qLde] };
  const f0 = new Array(L).fill(0n);
  let gi = 0;
  for (const g of groups) {
    const gs = gammas.slice(gi, gi + g.terms.length); gi += g.terms.length;
    let gv = 0n;
    g.terms.forEach((_, k2) => { gv = add(gv, mul(gs[k2], g.vals[k2])); });
    const invs = batchInv(xs.map((x) => sub(x, g.pt)));
    const cols = g.terms.map((tm) => srcLde[tm.src][tm.col]);
    for (let i = 0; i < L; i++) {
      let num = 0n;
      for (let k2 = 0; k2 < cols.length; k2++) num += gs[k2] * cols[k2][i];
      f0[i] = (f0[i] + ((num - gv) % FP + FP) * invs[i]) % FP;
    }
  }

  // ---- FRI ----
  const m = friFolds(logN, prm.logFinalDeg);
  const layers = [f0]; const trees = [null];
  let cur = f0, off = COSET, w = wL;
  const inv2 = inv(2n);
  proof.friRoots = [];
  for (let k2 = 0; k2 < m; k2++) {
    const b = tr.field();
    const h = cur.length / 2;
    const next = new Array(h);
    const iw = inv(w);
    let ix = inv(off);
    for (let i = 0; i < h; i++) {
      const a0 = cur[i], a1 = cur[i + h];
      next[i] = (mul(add(a0, a1), inv2) + mul(b, mul(mul(sub(a0, a1), inv2), ix))) % FP;
      ix = mul(ix, iw);
    }
    cur = next; off = mul(off, off); w = mul(w, w);
    layers.push(cur);
    if (k2 + 1 < m) {
      const t = commitColumns([cur]);
      trees.push(t);
      proof.friRoots.push(t.root);
      tr.absorb(t.root);
    }
  }
  const finalDeg = N >> m;
  proof.finalPoly = cosetInterpolate(cur, off).slice(0, finalDeg);
  tr.absorbFields(proof.finalPoly);

  // ---- grinding, queries, openings ----
  proof.nonce = grind(tr, prm.grind);
  tr.absorb(u64(proof.nonce));
  const idx = queryIndices(tr, prm.queries, half);
  const leafOf = (lde, i) => [...lde.map((c) => c[i]), ...lde.map((c) => c[i + lde[0].length / 2])];
  proof.traceLeaves = idx.map((i) => leafOf(tLde, i));
  proof.setLeaves = idx.map((i) => leafOf(sLde, i));
  proof.qLeaves = idx.map((i) => leafOf([qLde], i));
  proof.traceProof = openMany(tTree, idx);
  proof.setProof = openMany(set.tree, idx);
  proof.qProof = openMany(qTree, idx);
  proof.friLayers = [];
  let pos = idx;
  for (let k2 = 1; k2 < m; k2++) {
    const h = layers[k2].length / 2;
    pos = [...new Set(pos.map((i) => i % h))].sort((a, b) => a - b);
    proof.friLayers.push({ leaves: pos.map((i) => [layers[k2][i], layers[k2][i + h]]), proof: openMany(trees[k2], pos) });
  }
  return proof;
}

function safeVerify(sig, msg, pk) {
  try { return sig.length === 2420 && ml_dsa44.verify(sig, msg, pk); } catch { return false; }
}
