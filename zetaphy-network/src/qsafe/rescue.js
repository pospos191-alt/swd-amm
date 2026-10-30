// QuantumRescue (contracts/QuantumRescue.sol) off-chain side: the commitment a classical account records
// before Q-day, the reveal after it, and the ML-DSA signature that authorises a relayed reveal.
//   today:      c = commitmentOf({ chainId, contract, account, publicKey, secret }); send commit(c) from the account
//   after QDAY: revealArgs(...) -> reveal(account, pk, secret, sig), sent by anyone (a native PQ account on ZETAPHY)
// Keep `secret` (32 random bytes) and the ML-DSA seed together, offline: both are needed after Q-day.
import { AbiCoder, keccak256, getAddress, hexlify, randomBytes } from 'ethers';
import { pqAddress } from '../pqtx.js';

const abi = AbiCoder.defaultAbiCoder();

export const newSecret = () => hexlify(randomBytes(32));

/** keccak256(abi.encode("ZETAPHY QuantumRescue v1", chainId, contract, account, keccak256(pk), secret)). */
export function commitmentOf({ chainId, contract, account, publicKey, keyHash, secret }) {
  const kh = keyHash ?? keccak256(publicKey);
  return keccak256(abi.encode(['string', 'uint256', 'address', 'address', 'bytes32', 'bytes32'],
    ['ZETAPHY QuantumRescue v1', BigInt(chainId), getAddress(contract), getAddress(account), kh, secret]));
}

/** The native ML-DSA-44 account (0x…) that a rescue hands the account to. */
export const controllerOf = (publicKey) => pqAddress(publicKey).hex;

/** keccak256(abi.encode("ZETAPHY QuantumRescue reveal", chainId, contract, account, controller)). */
export function rescueDigest({ chainId, contract, account, controller }) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'address', 'address'],
    ['ZETAPHY QuantumRescue reveal', BigInt(chainId), getAddress(contract), getAddress(account), getAddress(controller)]));
}

/** The reveal call's arguments; `key` is { publicKey, sign(digestHex) } (src/pq.js pqFromSeed). */
export function revealArgs({ chainId, contract, account, key, secret }) {
  const controller = controllerOf(key.publicKey);
  const sig = key.sign(rescueDigest({ chainId, contract, account, controller }));
  return { args: [getAddress(account), key.publicKey, secret, sig], controller };
}

/**
 * What a wallet should say about an account's rescue state, from the contract's views:
 *   slot = slotOf(account) [active, pending, pendingAt], effective = effectiveCommitment(account),
 *   controller = controllerOf(account), qday = qdayHeight(), block = current block, maturity
 */
export function rescueState({ slot, effective, controller, qday, block, maturity }) {
  const Z = '0x' + '00'.repeat(32);
  const zeroAddr = (a) => !a || /^0x0{40}$/i.test(a);
  if (!zeroAddr(controller)) return { state: 'rescued', controller };
  const [active, pending, pendingAt] = slot;
  const q = BigInt(qday ?? 0), b = BigInt(block), m = BigInt(maturity), at = BigInt(pendingAt ?? 0);
  const reached = q !== 0n && b >= q;
  if (effective && effective !== Z) {
    return { state: reached ? 'revealable' : 'committed', commitment: effective, pending: at !== 0n && pending !== effective ? pending : null };
  }
  if (at !== 0n && pending !== Z) {
    const countsFrom = at + m;
    return { state: q !== 0n && countsFrom > q ? 'too-late' : 'maturing', countsFrom, commitment: pending };
  }
  return { state: reached ? 'frozen' : 'none', commitment: active === Z ? null : active };
}
