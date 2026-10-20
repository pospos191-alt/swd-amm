// Bundle entry for vendor/pqwallet.js: the transaction code shared with the
// zetaphy CLI, plus ML-DSA-44 from @noble/post-quantum.
export * from '../../zetaphy-network/src/pqtx.js';
export { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
