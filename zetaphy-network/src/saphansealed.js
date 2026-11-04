// Saphan PR 4, S6 (contracts/SaphanSealedOrders.sol): intents sealed to a solver's post-quantum key, so nobody but
// that solver reads them before they are revealed (docs/SAPHAN-PR4.md).
//
//   key        = X-Wing (ML-KEM-768 + X25519, @noble/post-quantum), the encrypted mempool's KEM (src/encmempool/kem.js)
//   plaintext  = abi.encode(order, salt)                          (288 bytes; salt: 32 random bytes)
//   commitment = keccak256(abi.encode(TAG, chainId, contract, solver, order, salt))   (SaphanSealedOrders.commitmentOf)
//   ciphertext = X-Wing ciphertext (1120) ‖ AES-256-GCM(plaintext) (288 + 16 tag) = 1424 bytes, always
//   the AEAD's associated data binds the ciphertext to (chain, contract, solver, commitment): it cannot be moved to
//   another sealed order, and the solver checks the commitment after decrypting.
import { randomBytes } from 'node:crypto';
import { AbiCoder, keccak256, getBytes, hexlify, concat, id as keccakId } from 'ethers';
import { kemKeygen, sealTo, openFrom, KEM_PUBLIC_KEY_BYTES, KEM_CIPHERTEXT_BYTES } from './encmempool/kem.js';
import { ORDER, orderTuple } from './saphanintents.js';

const abi = AbiCoder.defaultAbiCoder();
export const TAG = keccakId('saphan/sealed/v1');
export const LABEL = 'zetaphy/saphan-sealed-order';
export const KEY_BYTES = KEM_PUBLIC_KEY_BYTES;                // 1216
export const PLAINTEXT_BYTES = 288;
export const CIPHERTEXT_BYTES = KEM_CIPHERTEXT_BYTES + PLAINTEXT_BYTES + 16; // 1424
export const STATUS = ['None', 'Sealed', 'Revealed', 'Refunded'];
const rng = (n) => new Uint8Array(randomBytes(n));

/** A solver's key pair from a 32-byte secret seed (the seed IS the secret key: keep it offline). */
export function solverKey(seed = rng(32)) {
  const { publicKey, secretKey } = kemKeygen(getBytes(seed));
  return { publicKey: hexlify(publicKey), secretKey, keyHash: keccak256(publicKey) };
}

export const commitment = ({ chainId, contract, solver, order, salt }) =>
  keccak256(abi.encode(['bytes32', 'uint256', 'address', 'address', ORDER, 'bytes32'], [TAG, chainId, contract, solver, orderTuple(order), salt]));

const aad = ({ chainId, contract, solver, commitment: c }) =>
  getBytes(abi.encode(['bytes32', 'uint256', 'address', 'address', 'bytes32'], [TAG, chainId, contract, solver, c]));

/**
 * The user seals `order` for `solver` (its X-Wing public key `solverPublicKey`): { salt, commitment, ciphertext }.
 * Keep the salt: with the order it proves what was sealed.
 */
export function sealOrder({ chainId, contract, solver, solverPublicKey, order, salt = hexlify(rng(32)), random = rng }) {
  const pk = getBytes(solverPublicKey);
  if (pk.length !== KEY_BYTES) throw new Error(`solver key must be ${KEY_BYTES} bytes (X-Wing)`);
  const c = commitment({ chainId, contract, solver, order, salt });
  const plain = getBytes(abi.encode([ORDER, 'bytes32'], [orderTuple(order), salt]));
  const { kemCt, ct } = sealTo(pk, plain, aad({ chainId, contract, solver, commitment: c }), random, LABEL);
  const ciphertext = hexlify(concat([kemCt, ct]));
  if (getBytes(ciphertext).length !== CIPHERTEXT_BYTES) throw new Error('ciphertext size');
  return { salt, commitment: c, ciphertext };
}

/**
 * The solver opens a sealed order (from the Committed event): { order, salt }, or null when it does not decrypt or
 * does not match its commitment (then do not reveal: the user gets a refund after the window).
 */
export function openOrder({ chainId, contract, solver, secretKey, commitment: c, ciphertext }) {
  const bytes = getBytes(ciphertext);
  if (bytes.length !== CIPHERTEXT_BYTES) return null;
  const plain = openFrom(secretKey, bytes.subarray(0, KEM_CIPHERTEXT_BYTES), bytes.subarray(KEM_CIPHERTEXT_BYTES),
    aad({ chainId, contract, solver, commitment: c }), LABEL);
  if (!plain || plain.length !== PLAINTEXT_BYTES) return null;
  let o, salt;
  try { [o, salt] = abi.decode([ORDER, 'bytes32'], plain); } catch { return null; }
  const order = { tokenIn: o.tokenIn, amountIn: o.amountIn, dstDomain: Number(o.dstDomain), tokenOut: o.tokenOut, recipient: o.recipient,
    minOut: o.minOut, deadline: o.deadline, refundTo: o.refundTo };
  if (commitment({ chainId, contract, solver, order, salt }).toLowerCase() !== c.toLowerCase()) return null;
  return { order, salt };
}

/** The data of SaphanSourceGateway.depositAndCall(target = SaphanSealedOrders on ZETAPHY, ...) that seals an order. */
export const sealedCallData = ({ solver, refundTo, window, commitment: c, ciphertext }) =>
  abi.encode(['address', 'address', 'uint64', 'bytes32', 'bytes'], [solver, refundTo, window, c, ciphertext]);

/** The id of the `nonce`-th sealed order of `contract` (its Committed event says it too). */
export const sealedId = (chainId, contract, nonce) => keccak256(abi.encode(['bytes32', 'uint256', 'address', 'uint256'], [TAG, chainId, contract, nonce]));
