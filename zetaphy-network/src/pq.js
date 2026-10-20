// Post-quantum wallet keys (stage 5). The ML-DSA-44 key is rebuilt from a
// 32-byte seed kept in ~/.zetaphy/pq.seed (0600) on the owner's machine.
// Signatures are FIPS 204 pure ML-DSA with an empty context, which is what
// ZETAPHY's precompile at 0x…0900 verifies.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak256, hexlify, getBytes } from 'ethers';
import { HOME, loadOrCreateSecret, sealExisting } from './keys.js';

export const VARIANT = 44;

export function pqFromSeed(seedHex) {
  const { publicKey, secretKey } = ml_dsa44.keygen(getBytes(seedHex));
  return {
    publicKey: hexlify(publicKey),
    keyHash: keccak256(publicKey),
    sign: (digestHex) => hexlify(ml_dsa44.sign(getBytes(digestHex), secretKey)),
    // Raw bytes in and out, for native PQ accounts (src/pqtx.js).
    publicKeyBytes: publicKey,
    signBytes: (bytes) => ml_dsa44.sign(bytes, secretKey),
  };
}

export function loadOrCreatePq(file = join(HOME, 'pq.seed')) {
  // Plain pq.seed, or pq.seed.json (scrypt + AES-GCM) when ZETAPHY_PASSPHRASE is set.
  const r = loadOrCreateSecret(file, () => hexlify(randomBytes(32)));
  if (!/^0x[0-9a-fA-F]{64}$/.test(r.value)) throw new Error(`${r.file} is not a seed file`);
  return { ...pqFromSeed(r.value), created: r.created, file: r.file, encrypted: r.encrypted };
}

export const sealPqSeed = (file = join(HOME, 'pq.seed')) => sealExisting(file);
