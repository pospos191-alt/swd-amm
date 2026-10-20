// Bundle entry for vendor/pqwallet.js: the transaction code shared with the
// zetaphy CLI, plus ML-DSA-44 from @noble/post-quantum and keccak-256 (the code
// hash shown before a contract is deployed).
export * from '../../zetaphy-network/src/pqtx.js';
export { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
export { keccak_256 } from '@noble/hashes/sha3.js';
// Neuro's code fingerprint (fp1:), so the page can ask ThreatRegistry about a
// contract before it signs a call or transfer to it (the vaccine).
export { codeFingerprint } from '../../zetaphy-neuro/src/fingerprint.js';
