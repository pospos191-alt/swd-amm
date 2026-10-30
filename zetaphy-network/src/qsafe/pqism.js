// PQMultisigIsm (contracts/PQMultisigIsm.sol) off-chain side: what a post-quantum Hyperlane validator signs
// (Hyperlane's message-id checkpoint, domain-separated) and the metadata a relayer hands the ISM.
//   metadata = merkleTreeHook (32) ‖ root (32) ‖ index (4) ‖ n × [validator index (1) ‖ public key (1312) ‖ signature (2420)]
import { keccak256, solidityPacked, concat, zeroPadValue, toBeHex, getBytes, hexlify } from 'ethers';

export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;

const originOf = (message) => Number(BigInt('0x' + getBytes(message).subarray(5, 9).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')));

/** The 32 bytes each ML-DSA validator signs for a message (PQMultisigIsm.digest). */
export function pqCheckpointDigest(message, { merkleTreeHook = '0x' + '77'.repeat(20), root = '0x' + '42'.repeat(32), index = 0 } = {}) {
  const hook32 = zeroPadValue(merkleTreeHook, 32);
  const domainHash = keccak256(solidityPacked(['uint32', 'bytes32', 'string'], [originOf(message), hook32, 'HYPERLANE']));
  const checkpoint = keccak256(solidityPacked(['bytes32', 'bytes32', 'uint32', 'bytes32'], [domainHash, root, index, keccak256(message)]));
  return keccak256(solidityPacked(['string', 'bytes32'], ['ZETAPHY PQ checkpoint v1', checkpoint]));
}

/** Metadata for verify(): signers = [{ index, key: { publicKey, sign } }], sorted by index here. */
export function pqIsmMetadata(message, signers, opts = {}) {
  const { merkleTreeHook = '0x' + '77'.repeat(20), root = '0x' + '42'.repeat(32), index = 0 } = opts;
  const d = pqCheckpointDigest(message, { merkleTreeHook, root, index });
  const entries = [...signers].sort((a, b) => a.index - b.index).map(({ index: vi, key, signature }) => {
    const pk = getBytes(key.publicKey);
    const sig = getBytes(signature ?? key.sign(d));
    if (pk.length !== PK_BYTES || sig.length !== SIG_BYTES) throw new Error('ML-DSA-44 key / signature size');
    return concat([toBeHex(vi, 1), pk, sig]);
  });
  return hexlify(concat([zeroPadValue(merkleTreeHook, 32), root, toBeHex(index, 4), ...entries]));
}
