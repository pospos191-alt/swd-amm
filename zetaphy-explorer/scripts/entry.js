// Bundle entry for vendor/zetaphy-lib.js (npm run build): the chain code the
// explorer shares with the zetaphy CLI, web wallet and snap, plus @noble.
//   - zetaphy-network/src/pqcert.js: the ML-DSA-44 block certificate verifier
//   - zetaphy-network/src/pqtx.js:   addresses (bech32 / EIP-55), amounts, protobuf writer
//   - zetaphy-network/src/vaccine.js: ThreatRegistry views, keys, neutral reason texts
export {
  verifyBlock, decodeCertificate, voteMessage, decodeVoteKeyEntry, voteKeyAt, getVoteKeyEntry,
  protoFields, headerHash, txsHash, merkleRoot, CERT_TYPE_URL, VOTE_KEY_STORE_PATH, ATTESTATION_BYTES, ADDRESS_BYTES,
} from '../../zetaphy-network/src/pqcert.js';
export {
  bytesToHex, hexToBytes, toBech32, fromBech32, toChecksumHex, addressBytes, normalizeAddress, validatorAddress,
  formatZeta, txHashOf, varint, PQ_LOCK_ADDRESS, PUBLIC_KEY_BYTES, SIGNATURE_BYTES, MSG_EVM_CALL_TYPE_URL, MSG_QUANTUM_LOCK_TYPE_URL,
  encodeAny, encodeCoin, encodeMsgSend, encodeMsgDelegate, encodeMsgEVMCall, encodeMsgQuantumLock, encodeTxBody,
  encodeAuthInfo, encodeTxRaw, encodePubKey,
} from '../../zetaphy-network/src/pqtx.js';
export {
  THREAT_SEL, REASONS, REASON_TEXT, DISCLAIMER, REPRODUCE, reasonText, DETAIL_SEL, MAX_SHOWN_RESPONSES, PROXY_DEPTH,
  proxyTargets, fingerprint1, codeHash, codeKey, addressKey, threatKey, detailQueries, plainText, readEvidence,
  readResponse, threatQueries, readThreat, selector,
} from '../../zetaphy-network/src/vaccine.js';
export { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
export { sha256 } from '@noble/hashes/sha2.js';
export { keccak_256 } from '@noble/hashes/sha3.js';
