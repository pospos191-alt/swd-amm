// Hybrid KEM + AEAD for the encrypted mempool.
//
// KEM: X-Wing (draft-connolly-cfrg-xwing-kem), i.e. ML-KEM-768 (FIPS 203) combined
// with X25519 through SHA3-256, from @noble/post-quantum (already a dependency).
// The shared secret stays secret as long as EITHER ML-KEM-768 or X25519 holds, so
// a flaw in the young lattice implementation does not drop us below classical
// security, and a quantum computer (which breaks X25519) does not break ML-KEM.
// X-Wing's secret key is a 32-byte seed, which is exactly what makes the threshold
// part simple: the dealer Shamir-shares those 32 bytes (dealing.js).
//
// DEM: AES-256-GCM (node:crypto). Every AEAD key is derived from fresh KEM
// shared secrets and used for exactly one message, so a fixed zero nonce is safe.
// AES-256 keeps ~128-bit security against Grover.

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { XWing } from '@noble/post-quantum/hybrid.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { concat, utf8, u16 } from './util.js';

export const KEM_NAME = 'X-Wing (ML-KEM-768 + X25519)';
export const KEM_SEED_BYTES = XWing.lengths.seed; // 32
export const KEM_PUBLIC_KEY_BYTES = XWing.lengths.publicKey; // 1216 (1184 ML-KEM + 32 X25519)
export const KEM_CIPHERTEXT_BYTES = XWing.lengths.cipherText; // 1120 (1088 ML-KEM + 32 X25519)
export const AEAD_TAG_BYTES = 16;
const ZERO_IV = new Uint8Array(12);

/** Key pair from a 32-byte seed; the seed IS the secret key. */
export function kemKeygen(seed) {
  if (seed.length !== KEM_SEED_BYTES) throw new Error('kem seed must be 32 bytes');
  return { publicKey: XWing.getPublicKey(seed), secretKey: Uint8Array.from(seed) };
}

export const kemPublicKey = (seed) => XWing.getPublicKey(seed);

/** Encapsulates to `publicKey`; rng(64) supplies the encapsulation randomness. */
export function encapsulate(publicKey, rng) {
  const { cipherText, sharedSecret } = XWing.encapsulate(publicKey, rng(XWing.lengths.msgRand));
  return { cipherText, sharedSecret };
}

export const decapsulate = (cipherText, secretKey) => XWing.decapsulate(cipherText, secretKey);

/**
 * Derives one AEAD key from several KEM shared secrets: the key is unknown to
 * anyone missing even one of them (each is 32 uniform bytes going into SHA3-256).
 */
export function combineSecrets(label, sharedSecrets, context) {
  return sha3_256(concat(utf8(`${label}\0`), u16(sharedSecrets.length), ...sharedSecrets, context));
}

export function aeadSeal(key, plaintext, aad) {
  const c = createCipheriv('aes-256-gcm', key, ZERO_IV);
  c.setAAD(aad);
  const body = c.update(plaintext);
  c.final();
  return concat(body, c.getAuthTag());
}

/** Returns the plaintext, or null when the ciphertext, tag or AAD was tampered with. */
export function aeadOpen(key, ciphertext, aad) {
  if (ciphertext.length < AEAD_TAG_BYTES) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, ZERO_IV);
    d.setAAD(aad);
    d.setAuthTag(ciphertext.subarray(ciphertext.length - AEAD_TAG_BYTES));
    const body = d.update(ciphertext.subarray(0, ciphertext.length - AEAD_TAG_BYTES));
    d.final();
    return new Uint8Array(body);
  } catch {
    return null;
  }
}

/** Single-recipient public-key encryption (used for dealings): { kemCt, ct }. */
export function sealTo(publicKey, plaintext, aad, rng, label = 'zetaphy/encmempool-seal') {
  const { cipherText, sharedSecret } = encapsulate(publicKey, rng);
  const key = combineSecrets(label, [sharedSecret], concat(cipherText, aad));
  return { kemCt: cipherText, ct: aeadSeal(key, plaintext, aad) };
}

export function openFrom(secretKey, kemCt, ct, aad, label = 'zetaphy/encmempool-seal') {
  const ss = decapsulate(kemCt, secretKey);
  const key = combineSecrets(label, [ss], concat(kemCt, aad));
  return aeadOpen(key, ct, aad);
}
