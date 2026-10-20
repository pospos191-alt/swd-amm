// The ML-DSA-44 account: a 32-byte seed -> ml_dsa44.keygen(seed) -> the address
// sha256("zetaphy/mldsa44\0" || publicKey)[:20] (pqAddress in pqtx.js), the same
// account the CLI and the web wallet make from the same seed.
//
// In MetaMask the seed is snap_getEntropy({ version: 1, salt: ENTROPY_SALT }):
// SIP-6 entropy from the Secret Recovery Phrase and this snap's ID, so the same
// MetaMask backup brings the same account back. The seed and the secret key never
// leave this file's callers; only the public key and the addresses are returned.
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { pqAddress, bytesToHex, hexToBytes } from './pqtx.js';

/** Changing it changes every user's account: never change it (add a new version instead). */
export const ENTROPY_SALT = 'zetaphy-mldsa44-v1';

/** { publicKey, secretKey, address: { bytes, hex, bech32 } } of a 32-byte seed. */
export function accountFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('the ML-DSA-44 seed must be 32 bytes');
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  return { publicKey, secretKey, address: pqAddress(publicKey) };
}

/** What zetaphy_getAccount returns: public data only. */
export const publicAccount = (a) => ({ publicKey: '0x' + bytesToHex(a.publicKey), address: a.address.bech32, hex: a.address.hex });

/** The account from snap_getEntropy's hex answer; the seed bytes are wiped once the key is made. */
export function accountFromEntropy(entropyHex) {
  const seed = hexToBytes(entropyHex);
  try {
    return accountFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}
