// PQSettlement (contracts/PQSettlement.sol) off-chain side: build a batch, compute what each key signs,
// net positions (the same netting the contract applies), signatures, and finality of a settled batch.
//   const b = batch({ payments: [{ from: pkA, to: pkB, token, amount }, ...], salt, deadline });
//   const sigs = signBatch(b, digest, [keyA, ...]);  // every key that pays signs
//   settle(b.parties, b.payments, b.salt, b.deadline, sigs)
// Finality: a batch settled in block H is final once block H's ML-DSA certificate (in block H+1) verifies:
// isFinal() on-chain, or settlementFinality() here with src/pqcert.js verifyBlock.
import { AbiCoder, keccak256, getAddress, hexlify, randomBytes } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
const PAYMENT = 'tuple(uint16 from,uint16 to,address token,uint256 amount)';
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** keyId of an ML-DSA public key (hex). */
export const keyIdOf = (publicKey) => keccak256(publicKey);

/**
 * A batch from payments naming keys by key id (or public key): parties sorted ascending (as the contract
 * requires), payments as [fromIndex, toIndex, token, amount].
 */
export function batch({ payments, salt = hexlify(randomBytes(32)), deadline }) {
  const id = (k) => (/^0x[0-9a-fA-F]{64}$/.test(k) ? k.toLowerCase() : keyIdOf(k));
  const parties = [...new Set(payments.flatMap((p) => [id(p.from), id(p.to)]))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const idx = new Map(parties.map((p, i) => [p, i]));
  const rows = payments.map((p) => [idx.get(id(p.from)), idx.get(id(p.to)), getAddress(p.token ?? NATIVE), BigInt(p.amount)]);
  return { parties, payments: rows, salt, deadline: BigInt(deadline) };
}

/** The digest every paying key signs (PQSettlement.batchDigest). */
export function batchDigest({ chainId, contract }, b) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint256'], [
    'ZETAPHY PQSettlement batch v1', BigInt(chainId), getAddress(contract),
    keccak256(abi.encode(['bytes32[]'], [b.parties])),
    keccak256(abi.encode([`${PAYMENT}[]`], [b.payments])),
    b.salt, b.deadline]));
}

/** Net position per party and token: { [keyId]: { [token]: bigint } } (non-zero entries only). */
export function netPositions(b) {
  const out = {};
  const add = (k, t, v) => { out[k] ??= {}; out[k][t] = (out[k][t] ?? 0n) + v; if (out[k][t] === 0n) delete out[k][t]; };
  for (const [f, t, token, amount] of b.payments) {
    add(b.parties[f], token, -amount);
    add(b.parties[t], token, amount);
  }
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}

/** The parties that must sign: every key that appears as a payer (indexes, ascending). */
export const payers = (b) => [...new Set(b.payments.map((p) => p[0]))].sort((x, y) => x - y);

/** Signatures for settle(): keys = [{ publicKey, sign(digestHex) }]; every payer must be among them. */
export function signBatch(b, digest, keys) {
  const byId = new Map(keys.map((k) => [keyIdOf(k.publicKey).toLowerCase(), k]));
  return payers(b).map((i) => {
    const k = byId.get(b.parties[i].toLowerCase());
    if (!k) throw new Error(`party ${i} (${b.parties[i]}) pays in this batch and must sign`);
    return [i, k.publicKey, k.sign(digest)];
  });
}

/** PQSettlement.withdrawDigest. */
export function withdrawDigest({ chainId, contract }, { keyId, token = NATIVE, amount, to, nonce, deadline }) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'bytes32', 'address', 'uint256', 'address', 'uint256', 'uint256'],
    ['ZETAPHY PQSettlement withdraw v1', BigInt(chainId), getAddress(contract), keyId, getAddress(token), BigInt(amount), getAddress(to), BigInt(nonce), BigInt(deadline)]));
}

/**
 * Is a settlement final under the PQ certificate rule? `verifyBlock(height)` is src/pqcert.js verifyBlock bound to
 * a CometBFT RPC (and pinned vote keys). Final = the certificate verifies (ok) AND its ML-DSA signers alone
 * hold more than 2/3 of all voting power (pqMajority). Returns { final, height, reason }.
 */
export async function settlementFinality({ height, verifyBlock }) {
  if (!Number.isInteger(Number(height)) || Number(height) <= 0) return { final: false, height, reason: 'not settled' };
  let r;
  try { r = await verifyBlock(Number(height)); } catch (e) { return { final: false, height, reason: `certificate not available: ${e?.message ?? e}` }; }
  if (!r || r.ok !== true) return { final: false, height: Number(height), reason: (r?.problems ?? []).join('; ') || 'certificate does not verify' };
  // ok alone: the chain's rule holds (unregistered power is not counted). Quantum-safe finality needs the
  // ML-DSA signers alone to hold more than 2/3 of all voting power (pqMajority).
  if (r.pqMajority !== true) return { final: false, height: Number(height), reason: 'certificate valid, but ML-DSA signers hold 2/3 or less of all voting power: not quantum-safe final yet' };
  return { final: true, height: Number(height), reason: 'block certified with ML-DSA by more than 2/3 of all voting power' };
}
