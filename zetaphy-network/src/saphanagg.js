// Saphan PR 4, S1 (contracts/SaphanAggLane.sol): one aggregated ML-DSA-44 certificate for a transfer, or for a
// batch of transfers under one Merkle root, built off chain (docs/SAPHAN-PR4.md).
//
//   leaf(id)    = keccak256(keccak256(abi.encode(id)))          id = BridgeAirlock.transferId(...)
//   node(a, b)  = keccak256(min(a, b) ‖ max(a, b))               (sorted pairs: a path needs no left/right bits)
//   certDigest  = keccak256(abi.encode(TAG, chainId, lane, epoch, root))
//   certificate = threshold × [public key (1312) ‖ signature (2420)], sorted by keccak256(public key)
import { AbiCoder, keccak256, concat, getBytes, hexlify, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const TAG = keccakId('saphan/agg/v1');
export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;
export const ENTRY = PK_BYTES + SIG_BYTES;

/** A transfer as the lane takes it (and the airlock attests it). */
export const transferTuple = (t) => [t.srcChainId, t.srcContract, t.srcNonce, t.sender, t.to, t.amount];

/** BridgeAirlock.transferId. */
export const transferId = (t) => keccak256(abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], transferTuple(t)));

export const leaf = (id) => keccak256(keccak256(abi.encode(['bytes32'], [id])));

const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/**
 * The Merkle tree of transfers: { root, ids, proofs } (proofs[i] is transfers[i]'s path). An odd node is carried up
 * as is. One transfer: root = its leaf, empty path.
 */
export function buildBatch(transfers) {
  if (!transfers.length) throw new Error('empty batch');
  const ids = transfers.map(transferId);
  if (new Set(ids).size !== ids.length) throw new Error('a transfer twice in one batch');
  let level = ids.map(leaf);
  const proofs = ids.map(() => []);
  let pos = ids.map((_, i) => i);   // each transfer's index in the current level
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    pos = pos.map((p, k) => {
      const sib = p ^ 1;
      if (sib < level.length) proofs[k].push(level[sib]);
      return p >> 1;
    });
    level = next;
  }
  return { root: level[0], ids, proofs };
}

/** Checks a path like the contract does. */
export function verifyPath(id, proof, root) {
  let h = leaf(id);
  for (const p of proof) h = pair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

/** What every committee member signs for `root` (SaphanAggLane.certDigest). */
export const certDigest = ({ chainId, lane, epoch, root }) =>
  keccak256(abi.encode(['bytes32', 'uint256', 'address', 'uint64', 'bytes32'], [TAG, chainId, lane, epoch, root]));

/** Hash-sorted member list for setCommittee (keys: 0x public keys, or { publicKey }). */
export const committeeHashes = (keys) => keys.map((k) => keccak256(k.publicKey ?? k)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

/**
 * The certificate: `signatures` = [{ publicKey, signature }] (at least `threshold`; the first `threshold` by key hash
 * are used). Each signature must be over certDigest(...): check them first with checkSignature.
 */
export function certificate(signatures, threshold) {
  const sorted = [...signatures].map((s) => ({ pk: getBytes(s.publicKey), sig: getBytes(s.signature) }))
    .map((s) => ({ ...s, h: BigInt(keccak256(s.pk)) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].h === sorted[i - 1].h) throw new Error('a key twice');
  if (sorted.length < threshold) throw new Error(`${sorted.length} signatures, ${threshold} needed`);
  return hexlify(concat(sorted.slice(0, threshold).map((s) => {
    if (s.pk.length !== PK_BYTES || s.sig.length !== SIG_BYTES) throw new Error('ML-DSA-44 key / signature size');
    return concat([s.pk, s.sig]);
  })));
}

/** A member's check of a signature before it goes into a certificate (@noble/post-quantum, FIPS 204). */
export async function checkSignature(digest, { publicKey, signature }) {
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
  try { return ml_dsa44.verify(getBytes(signature), getBytes(digest), getBytes(publicKey)); } catch { return false; }
}

/** Calldata gas of a byte string (16 per nonzero byte, 4 per zero byte), for cost estimates. */
export function calldataGas(hex) {
  let g = 0;
  for (const b of getBytes(hex)) g += b ? 16 : 4;
  return g;
}
