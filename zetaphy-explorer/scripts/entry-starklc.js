// Bundle entry for vendor/starklc-lib.js (npm run build): the STARK light-client
// VERIFIER only (zetaphy-network/src/starklc/client.js: no prover, no RPC), for
// lightclient.html. Loaded only by that page.
export { StarkLightClient, verifyProof, decodeProof, ProofError } from '../../zetaphy-network/src/starklc/client.js';
// The direct baseline of scripts/starklc-browser-bench.js (verify every ML-DSA-44
// signature): already in the bundle for revealed signatures, so this costs nothing.
export { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
