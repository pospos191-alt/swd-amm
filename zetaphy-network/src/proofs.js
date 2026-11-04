// ProofRegistry's tuples and commitments, as the contract computes them (docs/future/specs-and-proofs.md).
// A runner reproduces a proof with `node audit/spec/cli.js prove <spec.json>` and commits the outcome of
// its own proof.json; the prover submits the artifacts of theirs.
import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
const OUTCOME = 'tuple(bytes32 resultHash, uint32 proven, uint32 counterexamples, uint32 unknown)';

/** The runners' outcome tuple from a proof.json (audit/spec): what 2 of 3 must reveal identically. */
export function outcomeOf(proof) {
  const s = proof.summary;
  return { resultHash: proof.resultHash, proven: s.proven, counterexamples: s.counterexamples, unknown: s.unknown };
}

export const outcomeKey = (o) => keccak256(abi.encode([OUTCOME], [o]));

/** keccak256(abi.encode("zetaphy.proof.run", keccak256(abi.encode(outcome)), runner, salt, id)) */
export const runCommitment = (o, runner, salt, id) =>
  keccak256(abi.encode(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.proof.run', outcomeKey(o), runner, salt, id]));

/** keccak256(abi.encode(bytes32[] artifacts)) */
export const artifactsHash = (artifacts) => keccak256(abi.encode(['bytes32[]'], [artifacts]));

/** keccak256(abi.encode("zetaphy.proof.submit", codeHash, specHash, artifactsHash, prover, salt)) */
export const submitCommitment = (codeHash, specHash, artsHash, prover, salt) =>
  keccak256(abi.encode(['string', 'bytes32', 'bytes32', 'bytes32', 'address', 'bytes32'], ['zetaphy.proof.submit', codeHash, specHash, artsHash, prover, salt]));

/** keccak256(abi.encode("zetaphy.proof.cex", bountyId, property, keccak256(counterexample), claimant, salt)) */
export const cexCommitment = (bountyId, property, counterexample, claimant, salt) =>
  keccak256(abi.encode(['string', 'uint256', 'uint32', 'bytes32', 'address', 'bytes32'], ['zetaphy.proof.cex', bountyId, property, keccak256(counterexample), claimant, salt]));

/**
 * ProofRegistry.Submission from a proof.json. codeHash is the deployed EXTCODEHASH (proof.json's
 * runtimeHash is the compiled code with immutables zeroed: `prove --code` checks they match).
 */
export function submissionOf(proof, { codeHash, recipe = '', bountyId = 0n }) {
  return {
    codeHash, specHash: proof.specHash, sourceHash: proof.sourceHash, properties: proof.summary.properties,
    artifacts: proof.artifacts.map((a) => a.hash),
    tools: Object.entries(proof.tools).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; '),
    recipe, recipeHash: proof.recipeHash, bountyId,
  };
}

export const textHash = (s) => keccak256(toUtf8Bytes(s));
