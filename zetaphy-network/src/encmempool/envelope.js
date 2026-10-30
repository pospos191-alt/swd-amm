// Encrypted transaction envelope (what a user submits instead of a plaintext tx).
//
// Wire format (all integers big-endian):
//   body = str  "zetaphy/encmempool-envelope/v1"
//          str  chain id
//          u64  target height h        (valid ONLY in block h)
//          u32  epoch
//          u64  inclusion fee          (paid by the payer when the envelope is included,
//                                       whether or not it ever decrypts)
//          u32  gas limit              (public: the block needs it for gas accounting)
//          1312 payer ML-DSA-44 public key
//          u8   d, then d x u16 dealer indices (= the epoch's accepted dealers, ascending)
//          d x 1120 X-Wing ciphertexts, one per dealer key ek[dealer, h]
//          u32 len + AES-256-GCM(payload) || tag
//   bytes = body || ML-DSA-44 signature (2420) by the payer over tag || body
//
// payload = u32 tx length || tx || zero padding to a multiple of PAD_BYTES (hides the
// exact tx size inside a bucket). The AEAD key is
//   SHA3-256("zetaphy/encmempool-tx" || d || ss_1..ss_d || header-and-ciphertexts)
// and the AAD is the same header-and-ciphertexts, so the payload cannot be moved to
// another height, epoch, payer, fee or dealer set, and a relay that strips the outer
// signature and re-signs as itself makes the payload undecryptable.
//
// The outer signature is the anti-spam part: the payer is known, pays the inclusion
// fee up front and the size is bounded, so garbage costs the sender money.

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { encapsulate, decapsulate, combineSecrets, aeadSeal, aeadOpen, KEM_CIPHERTEXT_BYTES, AEAD_TAG_BYTES } from './kem.js';
import { VOTE_PUBLIC_KEY_BYTES as PQ_PUBLIC_KEY_BYTES, VOTE_SIGNATURE_BYTES as PQ_SIGNATURE_BYTES, verifySig, signedMessage } from './committee.js';
import { Writer, Reader, tagHash, concat, u32, systemRandom } from './util.js';

const ENVELOPE_TAG = 'zetaphy/encmempool-envelope/v1';
export const PAD_BYTES = 256;
export const MAX_TX_BYTES = 32 * 1024;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const MAX_DEALERS = 16;

export const envelopeHash = (bytes) => tagHash('zetaphy/encmempool-envelope-id', bytes);

export function padPayload(tx) {
  if (tx.length > MAX_TX_BYTES) throw new Error('tx too large');
  const raw = 4 + tx.length;
  const total = Math.ceil(raw / PAD_BYTES) * PAD_BYTES;
  const out = new Uint8Array(total);
  out.set(u32(tx.length), 0);
  out.set(tx, 4);
  return out;
}

export function unpadPayload(p) {
  if (p.length < 4 || p.length % PAD_BYTES) return null;
  const n = new DataView(p.buffer, p.byteOffset, 4).getUint32(0);
  if (n > p.length - 4 || n > MAX_TX_BYTES) return null;
  for (let i = 4 + n; i < p.length; i++) if (p[i] !== 0) return null;
  return p.slice(4, 4 + n);
}

function header(e) {
  const w = new Writer().str(ENVELOPE_TAG).str(e.chainId).u64(e.height).u32(e.epoch).u64(e.fee).u32(e.gasLimit)
    .bytes(e.payerPub).u8(e.dealers.length);
  for (const d of e.dealers) w.u16(d);
  for (const c of e.kemCts) w.bytes(c);
  return w.finish();
}

/**
 * Client side: encrypts `tx` (the normal signed chain tx, any bytes) for block `height`.
 * keys = [{ dealer, ek }] from the chain for that height (all accepted dealers).
 * payer = { publicKey, sign(bytes) } (an ML-DSA-44 account).
 */
export function encryptTx({ chainId, height, epoch, keys, fee, gasLimit, payer, tx, rng = systemRandom }) {
  if (!keys.length || keys.length > MAX_DEALERS) throw new Error('bad dealer key set');
  const sorted = [...keys].sort((a, b) => a.dealer - b.dealer);
  const encs = sorted.map((k) => encapsulate(k.ek, rng));
  const e = {
    chainId, height: BigInt(height), epoch, fee: BigInt(fee), gasLimit,
    payerPub: payer.publicKey, dealers: sorted.map((k) => k.dealer), kemCts: encs.map((x) => x.cipherText),
  };
  const aad = header(e);
  const key = combineSecrets('zetaphy/encmempool-tx', encs.map((x) => x.sharedSecret), aad);
  const ct = aeadSeal(key, padPayload(tx), aad);
  const body = concat(aad, new Writer().varbytes(ct).finish());
  const sig = payer.sign(signedMessage(ENVELOPE_TAG, body));
  return concat(body, sig);
}

export function decodeEnvelope(bytes) {
  if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error('envelope too large');
  const r = new Reader(bytes);
  if (r.str() !== ENVELOPE_TAG) throw new Error('not an envelope');
  const e = { chainId: r.str(), height: r.u64(), epoch: r.u32(), fee: r.u64(), gasLimit: r.u32(), payerPub: r.bytes(PQ_PUBLIC_KEY_BYTES) };
  const d = r.u8();
  if (d < 1 || d > MAX_DEALERS) throw new Error('bad dealer count');
  e.dealers = Array.from({ length: d }, () => r.u16());
  e.kemCts = Array.from({ length: d }, () => r.bytes(KEM_CIPHERTEXT_BYTES));
  const aadEnd = r.o;
  e.ct = r.varbytes(MAX_TX_BYTES + PAD_BYTES + AEAD_TAG_BYTES);
  const bodyEnd = r.o;
  e.sig = r.bytes(PQ_SIGNATURE_BYTES);
  r.done();
  e.aad = bytes.subarray(0, aadEnd);
  e.body = bytes.subarray(0, bodyEnd);
  e.bytes = bytes;
  e.hash = envelopeHash(bytes);
  return e;
}

/**
 * Stateless checks a node runs in CheckTx and ProcessProposal. `rules`:
 * { chainId, height, epoch, dealers (accepted, ascending), minFeePerByte (bigint), maxGas }.
 * The payer's balance (it must cover `fee`) is a stateful check left to the ante handler.
 */
export function verifyEnvelope(bytes, rules) {
  let e;
  try { e = decodeEnvelope(bytes); } catch (err) { return { ok: false, reason: `malformed: ${err.message}` }; }
  if (e.chainId !== rules.chainId) return { ok: false, reason: 'wrong chain' };
  if (e.height !== BigInt(rules.height)) return { ok: false, reason: 'wrong target height' };
  if (e.epoch !== rules.epoch) return { ok: false, reason: 'wrong epoch' };
  if (e.dealers.length !== rules.dealers.length || e.dealers.some((d, i) => d !== rules.dealers[i])) return { ok: false, reason: 'wrong dealer set' };
  if (rules.minFeePerByte !== undefined && e.fee < BigInt(rules.minFeePerByte) * BigInt(bytes.length)) return { ok: false, reason: 'fee below size-based minimum' };
  if (rules.maxGas !== undefined && e.gasLimit > rules.maxGas) return { ok: false, reason: 'gas limit too high' };
  if (!verifySig(e.payerPub, signedMessage(ENVELOPE_TAG, e.body), e.sig)) return { ok: false, reason: 'bad payer signature' };
  return { ok: true, envelope: e };
}

/** Decrypts with the rebuilt per-height dealer seeds (Map dealer -> seed). Returns tx bytes or null. */
export function decryptEnvelope(e, seeds) {
  const ss = [];
  for (let i = 0; i < e.dealers.length; i++) {
    const seed = seeds.get(e.dealers[i]);
    if (!seed) return null;
    ss.push(decapsulate(e.kemCts[i], seed));
  }
  const plain = aeadOpen(combineSecrets('zetaphy/encmempool-tx', ss, e.aad), e.ct, e.aad);
  return plain ? unpadPayload(plain) : null;
}

/** An ML-DSA-44 payer from a 32-byte seed (tests / simulation; wallets use src/pq.js). */
export function payerFromSeed(seed, { deterministic = false } = {}) {
  const k = ml_dsa44.keygen(seed);
  const opts = deterministic ? { extraEntropy: false } : {};
  return { publicKey: k.publicKey, sign: (m) => ml_dsa44.sign(m, k.secretKey, opts) };
}
