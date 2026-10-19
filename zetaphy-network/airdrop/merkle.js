// Merkle tree over the allocations so a claim contract can hold just one
// 32-byte root. Leaf = keccak256(abi.encode(bytes32 solanaOwner, uint256 amount)),
// pairs hashed sorted (the OpenZeppelin MerkleProof convention).

import { keccak256, AbiCoder, concat, getBytes, hexlify, decodeBase58, toBeHex } from 'ethers';

export const leafOf = (owner, amount) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [toBeHex(decodeBase58(owner), 32), BigInt(amount)]));

const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function buildTree(allocations) {
  const leaves = allocations.map((a) => leafOf(a.owner, a.zetaphy));
  if (new Set(leaves).size !== leaves.length) throw new Error('duplicate allocation');
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const proofOf = (index) => {
    const proof = [];
    for (let l = 0, i = index; l < layers.length - 1; l++, i >>= 1) {
      const sib = i ^ 1;
      if (sib < layers[l].length) proof.push(layers[l][sib]);
    }
    return proof;
  };
  return {
    root: layers.at(-1)[0] ?? hexlify(new Uint8Array(32)),
    claims: Object.fromEntries(allocations.map((a, i) => [a.owner, { amount: a.zetaphy, proof: proofOf(i) }])),
  };
}

export function verify(root, owner, amount, proof) {
  return proof.reduce((h, p) => pair(h, p), leafOf(owner, amount)) === root;
}
