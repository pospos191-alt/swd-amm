// ZETAPHY STARK light client (prototype). See docs/future/stark-light-client.md.
export { buildSet, statementMessage, pkDigest, sigDigest, traceLength } from './air.js';
export { prove } from './prover.js';
export { verifyProof, ProofError } from './verifier.js';
export { encodeProof, decodeProof, proofSize } from './proof.js';
export { DEFAULT_PARAMS, sampleBits, samplesFor, starkBitsConjectured, starkBitsProvable } from './protocol.js';
export {
  StarkLightClient, proveBlock, proveHandoff, handoffMessage, handoffStatement, blockStatement, collectFromNode,
} from './lightclient.js';
