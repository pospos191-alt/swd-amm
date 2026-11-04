// Saphan private transfers (contracts/SaphanPrivacy.sol, docs/SAPHAN-PR6.md item F): notes, the pool's tree, the
// proof input. The circuit is the private-identity one (zetaphy-network/zkid/circuits/identity.circom, DEV setup):
// a note is an identity { secret, nullifierKey }, its deposit is the commitment, its leaf Poseidon(C, 1) in the POOL's
// own tree, and its withdrawal a membership proof with minLevel 1, the pool's scope and signal keccak(recipient, fee) >> 8.
// Proving needs snarkjs and the prover files of zetaphy-hub/zkid/ (identity.wasm, identity.zkey): prove() loads snarkjs
// only when called (the hub's prover worker does the same in a browser).
import { AbiCoder, keccak256, getAddress } from 'ethers';
import { newIdentity, commitment, leafOf, nullifierOf, proofInput, proofWords, parseIdentity, toHex32, buildTree } from '../../zetaphy-hub/zkid-core.js';

export const LEVEL = 1;
export const NOTE_PREFIX = 'ZNOTE1:';
const abi = AbiCoder.defaultAbiCoder();

/** SaphanPrivacyPool.scope: keccak256(abi.encode("saphan/privacy-pool/v1", chainId, pool)) >> 8. */
export const poolScope = (chainId, pool) => BigInt(keccak256(abi.encode(['string', 'uint256', 'address'], ['saphan/privacy-pool/v1', BigInt(chainId), getAddress(pool)]))) >> 8n;
/** SaphanPrivacyPool.signalOf(recipient, fee). */
export const signalOf = (recipient, fee) => BigInt(keccak256(abi.encode(['address', 'uint256'], [getAddress(recipient), BigInt(fee)]))) >> 8n;

/** A new note (keep it secret: whoever holds it can withdraw). */
export const newNote = (rand) => newIdentity(rand);
export const noteCommitment = (note) => commitment(note);
export const noteLeaf = (note) => leafOf(commitment(note), LEVEL);
export const noteNullifier = (note, scope) => nullifierOf(note, scope);

/** The note as text (for a backup or a QR code): ZNOTE1:<chainId>:<pool>:<secret>:<nullifierKey>. */
export const encodeNote = ({ chainId, pool, note }) => `${NOTE_PREFIX}${Number(chainId)}:${getAddress(pool)}:${toHex32(note.secret)}:${toHex32(note.nullifierKey)}`;
export function decodeNote(text) {
  const m = /^ZNOTE1:(\d{1,15}):(0x[0-9a-fA-F]{40}):(0x[0-9a-f]{64}):(0x[0-9a-f]{64})$/.exec(String(text ?? '').trim());
  if (!m) throw new Error('format');
  return { chainId: Number(m[1]), pool: getAddress(m[2]), note: parseIdentity({ secret: m[3], nullifierKey: m[4] }) };
}

/** The pool's root over its leaves (the Deposit events' `leaf`, in index order): the same as SaphanPrivacyPool.root. */
export const poolRoot = (leaves) => buildTree(leaves.map(BigInt)).root;

/** The circuit input for withdrawing `note` from a pool with these leaves, to `recipient` paying `fee` to the relayer. */
export function withdrawInput({ note, leaves, chainId, pool, recipient, fee = 0n }) {
  const scope = poolScope(chainId, pool);
  const r = proofInput({ id: note, leaves: leaves.map(BigInt), scope, signalHash: signalOf(recipient, fee), minLevel: LEVEL });
  return { ...r, scope, nullifier: nullifierOf(note, scope) };
}

/** A Groth16 proof (snarkjs: passed in, or loaded on demand) and the withdraw() arguments [recipient, fee, root, nullifier, words]. */
export async function prove({ wasm, zkey, snarkjs = null, ...o }) {
  const { groth16 } = snarkjs ?? await import('snarkjs');
  const w = withdrawInput(o);
  const { proof } = await groth16.fullProve(w.input, wasm, zkey);
  return { args: [getAddress(o.recipient), BigInt(o.fee ?? 0n), w.root, w.nullifier, proofWords(proof)], root: w.root, nullifier: w.nullifier };
}
