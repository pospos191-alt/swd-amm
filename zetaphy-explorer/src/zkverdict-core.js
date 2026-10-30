// Proven Neuro verdicts, checked in the browser (docs/future/proven-verdicts.md).
//
// A verdict in ProvenVerdicts (zetaphy-network/contracts/ProvenVerdicts.sol) carries a Groth16 proof that the
// pinned on-chain model H (nml-b4c35477f7b1, the model the zk circuit and its ceremony are bound to) turns a
// committed feature vector into margin Z. This file re-checks it with nothing but public chain data:
//   1. verdictOf(token) -> the verdict id, its score and level;
//   2. the ProofData log of that id -> the proof (a, b, c), the commitment, the margin and the posted features;
//   3. the Groth16 pairing check against the verification key of the committed NeuroScoreVerifier.sol
//      (zkverdict-vkey.json, generated from that file; H is supplied here, never taken from the chain);
//   4. the score = the pinned calibration applied to the proven margin, equal to what the contract stored;
//   5. the model bytes from NeuroScore (keccak256 must be H), run here on the posted features: the margin must be
//      the proven one, so the proof is about the features everyone can see (and re-derive from the code: zfeat/1).
// Pure JavaScript (the BN254 pairing of @noble/curves, vendor/zkverify.js): no WebAssembly, no worker, the page's
// CSP stays script-src 'self'. The browser AI in zetaphy-neuro/ai/browser is ANOTHER model and is not proven.
// Shared verbatim with zetaphy-explorer/src (tools/sync-shared.mjs). No DOM, no network of its own: `call` is the
// page's EVM JSON-RPC.

export const SEL = { verdictOf: '0x371ad2ae', scorer: '0x85c758f7', modelBytes: '0x5c00cdd0' };
export const PROOF_DATA_TOPIC = '0x6545c34a7d1de121bc242a5db7c970410e259b4f52ce2e75181ea081420a9724';
export const MARGIN_OFFSET = 1n << 40n;
export const SCALE = 10_000_000;
/** BN254 scalar field (public signals) and base field (coordinates). */
export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const strip = (h) => String(h).replace(/^0x/, '');
const word = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, i * 64 + 64) || '0'));
const pad = (x) => BigInt(x).toString(16).padStart(64, '0');
const signed64 = (x) => BigInt.asIntN(64, x);

/** The verification key of NeuroScoreVerifier.sol (snarkjs' Groth16 template + the model binding), parsed from its source. */
export function vkeyFromVerifierSol(sol) {
  const k = {};
  for (const m of sol.matchAll(/(?:uint256|bytes32)\s+(?:public\s+)?constant\s+(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+);/g)) k[m[1]] = m[2];
  const need = ['alphax', 'alphay', 'betax1', 'betax2', 'betay1', 'betay2', 'gammax1', 'gammax2', 'gammay1', 'gammay2', 'deltax1', 'deltax2', 'deltay1', 'deltay2', 'MODEL_HASH'];
  for (const n of need) if (k[n] == null) throw new Error(`verifier source has no ${n}`);
  const ic = [];
  for (let i = 0; k[`IC${i}x`] != null; i++) ic.push([k[`IC${i}x`], k[`IC${i}y`]]);
  if (ic.length !== 5) throw new Error(`expected 4 public signals, the key has ${ic.length - 1}`);
  const header = sol.split('\n').slice(0, 3).join(' ');
  return {
    protocol: 'groth16', curve: 'bn254', publicSignals: ['commitment', 'margin', 'hashHi', 'hashLo'],
    modelId: /for model (nml-[0-9a-f]+)/.exec(header)?.[1] ?? null, modelHash: k.MODEL_HASH.toLowerCase(), zkeySha256: k.ZKEY_SHA256?.toLowerCase() ?? null, ceremonyLink: k.CEREMONY_LINK?.toLowerCase() ?? null,
    rehearsal: /REHEARSAL/.test(header),
    // G2 points in the EVM's order: x = (x_im, x_re), y = (y_im, y_re)
    alpha: [k.alphax, k.alphay], beta: [k.betax1, k.betax2, k.betay1, k.betay2], gamma: [k.gammax1, k.gammax2, k.gammay1, k.gammay2],
    delta: [k.deltax1, k.deltax2, k.deltay1, k.deltay2], ic,
  };
}

/** The four public signals of a proof for model hash H (0x hex): [commitment, margin, H >> 128, H & (2^128 - 1)]. */
export function publicSignals(commitment, margin, modelHash) {
  const h = BigInt(modelHash);
  return [BigInt(commitment), BigInt(margin), h >> 128n, h & ((1n << 128n) - 1n)];
}

/**
 * Groth16 verification on BN254, as the EVM verifier does it: e(-A, B) e(alpha, beta) e(vk_x, gamma) e(C, delta) = 1.
 * `lib` = { bn254 } (vendor/zkverify.js). proof = { a: [x, y], b: [[x_im, x_re], [y_im, y_re]], c: [x, y] } (EVM order,
 * as in the transaction and the ProofData log). Never throws: a malformed proof is simply false.
 */
export function verifyGroth16(lib, vk, proof, pub) {
  try {
    const { G1, G2 } = lib.bn254;
    const { Fp2, Fp12 } = lib.bn254.fields;
    const big = (x) => BigInt(x);
    const inQ = (...xs) => xs.every((x) => big(x) >= 0n && big(x) < Q);
    const g1 = (x, y) => { if (!inQ(x, y)) throw new Error('coordinate'); const p = G1.ProjectivePoint.fromAffine({ x: big(x), y: big(y) }); p.assertValidity(); return p; };
    const g2 = (xi, xr, yi, yr) => {
      if (!inQ(xi, xr, yi, yr)) throw new Error('coordinate');
      const p = G2.ProjectivePoint.fromAffine({ x: Fp2.fromBigTuple([big(xr), big(xi)]), y: Fp2.fromBigTuple([big(yr), big(yi)]) });
      p.assertValidity();
      return p;
    };
    if (pub.length !== vk.ic.length - 1 || pub.some((s) => big(s) < 0n || big(s) >= R)) return false;
    let vkx = g1(...vk.ic[0]);
    pub.forEach((s, i) => { if (big(s) !== 0n) vkx = vkx.add(g1(...vk.ic[i + 1]).multiply(big(s))); });
    const A = g1(proof.a[0], proof.a[1]);
    const B = g2(proof.b[0][0], proof.b[0][1], proof.b[1][0], proof.b[1][1]);
    const C = g1(proof.c[0], proof.c[1]);
    const r = lib.bn254.pairingBatch([
      { g1: A.negate(), g2: B },
      { g1: g1(...vk.alpha), g2: g2(...vk.beta) },
      { g1: vkx, g2: g2(...vk.gamma) },
      { g1: C, g2: g2(...vk.delta) },
    ]);
    return Fp12.eql(r, Fp12.ONE);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the pinned model (NSM1 bytes, as NeuroScore)

/** NSM1 header: { nFeatures, nTrees, scale, base, calibA, calibB }. */
export function modelHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'NSM1') throw new Error('not a NSM1 model');
  return { nFeatures: dv.getUint16(4), nTrees: dv.getUint16(6), scale: dv.getUint32(8), base: dv.getInt32(12), calibA: dv.getInt32(16), calibB: dv.getInt32(20) };
}

/** The integer margin Z of packed model bytes on u32 features, exactly as NeuroScore._eval (and ml/onchain/fixed.js). */
export function marginOf(bytes, q) {
  const h = modelHeader(bytes);
  if (q.length !== h.nFeatures) throw new Error(`expected ${h.nFeatures} features, got ${q.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let z = h.base;
  let o = 24 + h.nTrees;
  for (let k = 0; k < h.nTrees; k++) {
    const n = bytes[24 + k];
    let i = 0;
    for (;;) {
      const p = o + i * 6;
      if (bytes[p] === 0xff) { z += dv.getInt32(p + 1); break; }
      i = q[bytes[p]] <= dv.getUint32(p + 1) ? i + 1 : bytes[p + 5];
    }
    o += n * 6;
  }
  return z;
}

/** score = trunc(calibA * Z / scale) + calibB (the calibrated logit x 1e7), from the circuit's margin output Z + 2^40. */
export function scoreOfMargin(margin, header) {
  const z = BigInt(margin) - MARGIN_OFFSET;
  return (BigInt(header.calibA) * z) / BigInt(header.scale) + BigInt(header.calibB);
}

export const probabilityOf = (score) => 1 / (1 + Math.exp(-Number(score) / SCALE));

/** 0x packed u32 features -> numbers. */
export function unpackFeatures(hex) {
  const s = strip(hex);
  if (s.length % 8) throw new Error('features are not u32 words');
  return Array.from({ length: s.length / 8 }, (_, i) => parseInt(s.slice(i * 8, i * 8 + 8), 16));
}

const toBytes = (hex) => Uint8Array.from(strip(hex).match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- reading the chain

/** verdictOf(token) answer -> { known, score, level, proven, weight, settled, id }. */
export function readVerdictOf(hex) {
  if (strip(hex).length < 7 * 64) throw new Error('not a verdictOf answer');
  return { known: word(hex, 0) === 1n, score: signed64(word(hex, 1)), level: Number(word(hex, 2)), proven: word(hex, 3) === 1n,
    weight: Number(word(hex, 4)), settled: word(hex, 5) === 1n, id: word(hex, 6) };
}

/** A ProofData log -> { id, token, proof: {a, b, c}, commitment, margin, features (0x hex) }. */
export function readProofData(log) {
  if (String(log.topics?.[0]).toLowerCase() !== PROOF_DATA_TOPIC) throw new Error('not a ProofData log');
  const d = log.data;
  const w = (i) => word(d, i);
  const off = Number(w(10)) / 32;
  const len = Number(w(off));
  const features = '0x' + strip(d).slice((off + 1) * 64, (off + 1) * 64 + len * 2);
  return {
    id: BigInt(log.topics[1]), token: '0x' + strip(log.topics[2]).slice(24),
    proof: { a: [w(0), w(1)], b: [[w(2), w(3)], [w(4), w(5)]], c: [w(6), w(7)] }, commitment: w(8), margin: w(9), features,
  };
}

/**
 * Checks the newest verdict of `token` in ProvenVerdicts `contract` end to end (steps 1-5 above).
 * @param {(method: string, params: any[]) => Promise<any>} call  EVM JSON-RPC
 * @param {{bn254: object, keccak_256: (b: Uint8Array) => Uint8Array}} lib  vendor/zkverify.js
 * @param {object} vk  zkverdict-vkey.json
 * @returns {Promise<{state: 'none'|'unproven'|'overturned'|'proven'|'invalid', ...}>}
 *   proven: { id, modelHash, score, level, probability, settled, featuresChecked: true, ms, rehearsal }
 *   invalid: { id, problem } (the proof, the score or the features do not check out: nothing is claimed)
 */
export async function checkProvenVerdict(call, { contract, token, lib, vk, now = () => performance.now() }) {
  const ethCall = (to, data) => call('eth_call', [{ to, data }, 'latest']);
  const v = readVerdictOf(await ethCall(contract, SEL.verdictOf + pad(BigInt(token))));
  if (!v.known && v.weight === 0 && v.id === 0n && v.score === 0n && !v.settled) return { state: 'none' };
  if (!v.known && v.settled) return { state: 'overturned', id: v.id };
  if (!v.proven) return { state: 'unproven', id: v.id, score: v.score, level: v.level, known: v.known };
  const logs = await call('eth_getLogs', [{ address: contract, fromBlock: '0x0', toBlock: 'latest', topics: [PROOF_DATA_TOPIC, '0x' + pad(v.id)] }]);
  const log = (logs ?? []).find((l) => String(l.address).toLowerCase() === String(contract).toLowerCase());
  if (!log) return { state: 'invalid', id: v.id, problem: 'no ProofData log for this verdict' };
  const p = readProofData(log);
  if (p.token.toLowerCase() !== String(token).toLowerCase()) return { state: 'invalid', id: v.id, problem: 'the proof is for another token' };
  const t0 = now();
  const ok = verifyGroth16(lib, vk, p.proof, publicSignals(p.commitment, p.margin, vk.modelHash));
  const ms = now() - t0;
  if (!ok) return { state: 'invalid', id: v.id, problem: 'the Groth16 proof does not verify for the pinned model', ms };
  // the model bytes, from NeuroScore, must hash to H; then the score and the features are re-checked here
  const scorer = '0x' + strip(await ethCall(contract, SEL.scorer)).slice(24);
  const raw = await ethCall(scorer, SEL.modelBytes + strip(vk.modelHash));
  const len = Number(word(raw, 1));
  const bytes = toBytes(strip(raw).slice(128, 128 + len * 2));
  if (toHex(lib.keccak_256(bytes)) !== vk.modelHash) return { state: 'invalid', id: v.id, problem: 'the scorer\'s model bytes are not the pinned model' };
  const header = modelHeader(bytes);
  const score = scoreOfMargin(p.margin, header);
  if (score !== v.score) return { state: 'invalid', id: v.id, problem: 'the stored score is not the proven one' };
  const z = marginOf(bytes, unpackFeatures(p.features));
  if (BigInt(z) + MARGIN_OFFSET !== p.margin) return { state: 'invalid', id: v.id, problem: 'the posted features do not give the proven margin' };
  return { state: 'proven', id: v.id, modelHash: vk.modelHash, score, level: v.level, probability: probabilityOf(score), settled: v.settled,
    modelId: vk.modelId, featuresChecked: true, ms, rehearsal: vk.rehearsal };
}
