// PQCosignCommittee (contracts/PQCosignCommittee.sol), the off-chain side: t-of-n ML-DSA-44 co-signatures for
// AgentPolicyWallet.executeCosignedPq. A runner reviews the action exactly as for the ECDSA / FROST paths
// (src/cosign.js review + cosignDigest), then signs pqCosignDigest(digest) with its ML-DSA-44 key (src/pq.js,
// FIPS 204 pure ML-DSA, empty context: what the precompile at 0x…0900 verifies). The agent combines the answers:
//   proof = n × [public key (1312) ‖ signature (2420)], ordered by keccak256(public key), strictly ascending.
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak256, solidityPacked, concat, getBytes, hexlify } from 'ethers';

export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;

/** The 32 bytes a member signs for a wallet's cosign digest (PQCosignCommittee.pqDigest). */
export function pqCosignDigest(digest) {
  return keccak256(solidityPacked(['string', 'bytes32'], ['ZETAPHY PQ cosign v1', digest]));
}

/** A member's answer: key = { publicKey, sign(digestHex) } (src/pq.js pqFromSeed / loadOrCreatePq). */
export function signCosignPq(key, digest) {
  return { publicKey: key.publicKey, keyHash: keccak256(key.publicKey), sig: key.sign(pqCosignDigest(digest)) };
}

/**
 * The proof PQCosignCommittee.isValid wants, after checking every signature here (a bad one would make the
 * whole proof fail on chain). parts = [{ publicKey, sig }]; repeats of one key count once.
 * With `members` (the committee's key hashes, members()) non-members are refused and `threshold` is checked.
 */
export function combinePq(digest, parts, { members, threshold } = {}) {
  const d = getBytes(pqCosignDigest(digest));
  const byKey = new Map();
  for (const p of parts) {
    const pk = getBytes(p.publicKey), sig = getBytes(p.sig);
    if (pk.length !== PK_BYTES || sig.length !== SIG_BYTES) throw new Error('not an ML-DSA-44 public key / signature');
    const h = keccak256(pk);
    if (p.keyHash && p.keyHash.toLowerCase() !== h) throw new Error(`a part claims key ${p.keyHash} but carries ${h}`);
    if (!ml_dsa44.verify(sig, d, pk)) throw new Error(`the signature of ${h} does not verify for this digest`);
    if (members && !members.some((m) => m.toLowerCase() === h)) throw new Error(`${h} is not a committee member`);
    byKey.set(h, concat([pk, sig]));
  }
  if (threshold != null && byKey.size < Number(threshold)) throw new Error(`${byKey.size} of the needed ${threshold} co-signatures`);
  return hexlify(concat([...byKey.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(([, e]) => e)));
}
