// Saphan cross-chain reads (contracts/SaphanReads.sol): the question ids SaphanReads uses, and the arguments of
// proveSlot / proveAccount from an eth_getProof answer of chain X.
import { AbiCoder, keccak256, id as keccakId } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
export const CALL_TAG = keccakId('saphan/reads/call/v1');
export const SLOT_TAG = keccakId('saphan/reads/slot/v1');
export const ACCOUNT_TAG = keccakId('saphan/reads/account/v1');
const word = (s) => '0x' + BigInt(s).toString(16).padStart(64, '0');

/** "What does target.call(data) return on chain X?" */
export const callQuery = (chainId, target, data) => keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32'], [CALL_TAG, chainId, target, keccak256(data)]));
/** "What is in storage slot `slot` of `account` on chain X?" */
export const slotQuery = (chainId, account, slot) => keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32'], [SLOT_TAG, chainId, account, word(slot)]));
/** "What are the nonce, balance, storage root and code hash of `account` on chain X?" */
export const accountQuery = (chainId, account) => keccak256(abi.encode(['bytes32', 'uint256', 'address'], [ACCOUNT_TAG, chainId, account]));

/** Storage slot of a Solidity mapping(address => ...) entry at mapping slot `slot`. */
export const mappingSlot = (key, slot) => keccak256(abi.encode(['address', 'uint256'], [key, slot]));

/**
 * The arguments of SaphanReads.proveSlot from eth_getProof(account, [slot], block) (any JSON-RPC node of X, or a
 * state manager): [blockNumber, account, slot, accountProof, storageProof].
 */
export function proveSlotArgs(blockNumber, proof, slot) {
  const sp = proof.storageProof.find((s) => BigInt(s.key) === BigInt(slot)) ?? { proof: [] };
  return [BigInt(blockNumber), proof.address, word(slot), proof.accountProof, sp.proof];
}

/** The arguments of SaphanReads.proveAccount: [blockNumber, account, accountProof]. */
export const proveAccountArgs = (blockNumber, proof) => [BigInt(blockNumber), proof.address, proof.accountProof];
