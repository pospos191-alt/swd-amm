// ZetaphyOutbox (contracts/ZetaphyOutbox.sol) off-chain: message leaves, the depth-32 SHA-256
// tree (Ethereum deposit-contract construction) and inclusion proofs, from the MessageSent events.

import { sha256 } from '@noble/hashes/sha2.js';
import { AbiCoder, keccak256, toUtf8Bytes, getBytes, hexlify, zeroPadValue, toBeHex } from 'ethers';
import { concat } from './merkle.js';

export const DEPTH = 32;
export const LEAF_TAG = keccak256(toUtf8Bytes('zetaphy/outbox/v1'));
const abi = AbiCoder.defaultAbiCoder();

const ZERO = (() => {
  const z = [new Uint8Array(32)];
  for (let h = 0; h < DEPTH; h++) z.push(sha256(concat(z[h], z[h])));
  return z;
})();

/** The leaf of a message: { srcChainId, outbox, nonce, sender, dstChainId, receiver, payload (hex) }. */
export function messageLeaf(m) {
  return sha256(getBytes(abi.encode(['bytes32', 'uint256', 'address', 'uint64', 'address', 'uint256', 'address', 'bytes32'],
    [LEAF_TAG, m.srcChainId, m.outbox, m.nonce, m.sender, m.dstChainId, m.receiver, sha256(getBytes(m.payload))])));
}

/** The outbox root (slot 0) and the proof of leaf `index`, for the tree of `leaves` (Uint8Array[32]). */
export function outboxProof(leaves, index) {
  let level = leaves.slice();
  const siblings = [];
  let i = index;
  for (let h = 0; h < DEPTH; h++) {
    siblings.push(level[i ^ 1] ?? ZERO[h]);
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(sha256(concat(level[k], level[k + 1] ?? ZERO[h])));
    level = next.length ? next : [ZERO[h + 1]];
    i >>= 1;
  }
  const count = leaves.length;
  const root = sha256(concat(level[0], getBytes(zeroPadValue(toBeHex(count), 32))));
  return { root, count, siblings: siblings.map((s) => hexlify(s)) };
}
