// Post-quantum wallet keys (stage 5). The ML-DSA-44 key is rebuilt from a
// 32-byte seed kept in ~/.zetaphy/pq.seed (0600) on the owner's machine.
// Signatures are FIPS 204 pure ML-DSA with an empty context, which is what
// ZETAPHY's precompile at 0x…0900 verifies.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak256, hexlify, getBytes } from 'ethers';
import { HOME } from './keys.js';

export const VARIANT = 44;

export function pqFromSeed(seedHex) {
  const { publicKey, secretKey } = ml_dsa44.keygen(getBytes(seedHex));
  return {
    publicKey: hexlify(publicKey),
    keyHash: keccak256(publicKey),
    sign: (digestHex) => hexlify(ml_dsa44.sign(getBytes(digestHex), secretKey)),
  };
}

export function loadOrCreatePq(file = join(HOME, 'pq.seed')) {
  let created = false;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, hexlify(randomBytes(32)) + '\n', { mode: 0o600 });
    created = true;
  }
  const seed = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error(`${file} is not a seed file`);
  return { ...pqFromSeed(seed), created, file };
}
