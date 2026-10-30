// Deterministic TEST validators for the STARK light client (tests, benchmarks,
// demo). Keys come from fixed public seeds: they are NOT secret and must never
// be used on a real network.

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const utf8 = (s) => new TextEncoder().encode(s);

/** n test validators: { address, power, pubKey, secretKey }; every `keyless`-th one has no vote key. */
export function testValidators(n, { label = 'zetaphy-starklc-test', keyless = 0, powerOf = (i) => 100n + BigInt((i * 37) % 900) } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const seed = sha256(utf8(`${label}/seed/${i}`));
    const address = bytesToHex(sha256(utf8(`${label}/addr/${i}`)).subarray(0, 20)).toUpperCase();
    const noKey = keyless && i % keyless === keyless - 1;
    const { publicKey, secretKey } = ml_dsa44.keygen(seed);
    return { address, power: powerOf(i), pubKey: noKey ? null : publicKey, secretKey: noKey ? null : secretKey };
  });
}

/** Signatures of `signers` (validators with keys) over `message`: Map address -> signature. */
export function signAll(signers, message) {
  return new Map(signers.filter((v) => v.secretKey).map((v) => [v.address, ml_dsa44.sign(message, v.secretKey)]));
}
