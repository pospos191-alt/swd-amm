// ML-DSA-44 offline cheques and orders, the off-chain side of contracts/ZetaphyPQCheques.sol and
// contracts/ZetaphyPQOfflineOrders.sol (the post-quantum twins of ZetaphyCheques / ZetaphyOfflineOrders;
// docs/future/offline-trading.md, "ML-DSA cheques and orders"). What a key signs, the signing, the offline
// check a payee or relayer runs with no network, the text payloads and the contract call arguments.
//   const key = pqFromSeed(seed);                            // src/pq.js: { publicKey, sign(digestHex) }
//   const chq = signPQCheque(key, { chainId, contract }, channelId, cumulative);
//   checkPQCheque(chq, { publicKey, channel, now })            // offline: { ok, amount, reason }
//   cash(...pqCashArgs(chq, publicKey))
//   const ord = signPQOrder(key, { chainId, contract }, order); // after setPQKey(keccak256(publicKey)) on chain
//   fill(...pqFillArgs(ord, path))
// Signatures are FIPS 204 pure ML-DSA-44 over the 32-byte digest with an empty context, which is what the
// precompile at 0x…0900 verifies (src/pq.js). Pure: ethers and @noble/post-quantum only, no Node-only imports.
import { AbiCoder, keccak256, getAddress, getBytes, hexlify, toUtf8Bytes, toUtf8String, encodeBase64, decodeBase64 } from 'ethers';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

const abi = AbiCoder.defaultAbiCoder();
export const PQ_CHEQUE_PREFIX = 'ZPQC1:';
export const PQ_ORDER_PREFIX = 'ZPQO1:';
export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const ORDER_TYPEHASH = keccak256(toUtf8Bytes(
  'Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 nonce,uint256 relayerFee)'));
const ORDER_KEYS = ['maker', 'tokenIn', 'tokenOut', 'amountIn', 'minAmountOut', 'deadline', 'nonce', 'relayerFee'];
const U256 = 2n ** 256n;

const u256 = (v, what) => {
  const n = BigInt(v);
  if (n < 0n || n >= U256) throw new Error(`${what}: not a uint256`);
  return n;
};
/** keccak256 of an ML-DSA public key (hex): the channel's signerKey, the maker's pqKeyOf. */
export const pqKeyHash = (publicKey) => keccak256(publicKey);

/** ML-DSA-44 verify of a 32-byte digest (hex in); false on any malformed input. */
export function pqVerify(digest, publicKey, sig) {
  try {
    const pk = getBytes(publicKey), s = getBytes(sig);
    if (pk.length !== PK_BYTES || s.length !== SIG_BYTES) return false;
    return ml_dsa44.verify(s, getBytes(digest), pk);
  } catch { return false; }
}

// ---------------------------------------------------------------- cheques

/** ZetaphyPQCheques.chequeDigest(channelId, cumulative). */
export function pqChequeDigest({ chainId, contract }, channelId, cumulative) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'uint256', 'uint256'],
    ['ZETAPHY PQCheques cheque v1', BigInt(chainId), getAddress(contract), u256(channelId, 'channelId'), u256(cumulative, 'cumulative')]));
}

/** A cheque for the TOTAL `cumulative` promised on `channelId`: { chainId, contract, channelId, cumulative, sig }. */
export function signPQCheque(key, ctx, channelId, cumulative) {
  const d = pqChequeDigest(ctx, channelId, cumulative);
  return { chainId: BigInt(ctx.chainId), contract: getAddress(ctx.contract), channelId: BigInt(channelId), cumulative: BigInt(cumulative), sig: key.sign(d) };
}

/**
 * The payee's offline check of a cheque against the channel as it last saw it on chain (channels(id) of
 * ZetaphyPQCheques: { signerKey, deposit, paid, closeAt, done }) and the signer's public key (from the
 * SignerKey event, or handed over by the payer). Returns { ok, amount (what cash() would pay), reason }.
 */
export function checkPQCheque(chq, { publicKey, channel, now = Math.floor(Date.now() / 1000), chainId, contract } = {}) {
  const no = (reason) => ({ ok: false, amount: 0n, reason });
  if (chainId != null && BigInt(chainId) !== BigInt(chq.chainId)) return no('another chain');
  if (contract && getAddress(contract) !== getAddress(chq.contract)) return no('another contract');
  if (!publicKey) return no('the signer\'s public key is needed');
  if (channel?.signerKey && pqKeyHash(publicKey).toLowerCase() !== String(channel.signerKey).toLowerCase()) return no('not the channel\'s key');
  if (!pqVerify(pqChequeDigest(chq, chq.channelId, chq.cumulative), publicKey, chq.sig)) return no('bad signature');
  if (!channel) return { ok: true, amount: null, reason: 'signature valid (channel not checked)' };
  if (channel.done) return no('channel over');
  const closeAt = BigInt(channel.closeAt ?? 0);
  if (closeAt !== 0n && BigInt(now) >= closeAt) return no('channel closed');
  const deposit = BigInt(channel.deposit), paid = BigInt(channel.paid ?? 0);
  const upTo = chq.cumulative < deposit ? chq.cumulative : deposit;
  if (upTo <= paid) return no('nothing new to cash');
  return { ok: true, amount: upTo - paid, reason: closeAt !== 0n ? 'closing: cash before the challenge period ends' : 'ok' };
}

/** cash(channelId, cumulative, pk, sig) arguments. */
export const pqCashArgs = (chq, publicKey) => [chq.channelId, chq.cumulative, hexlify(publicKey), chq.sig];

// ---------------------------------------------------------------- orders

const normOrder = (o) => ({
  maker: getAddress(o.maker), tokenIn: getAddress(o.tokenIn), tokenOut: getAddress(o.tokenOut ?? NATIVE),
  amountIn: u256(o.amountIn, 'amountIn'), minAmountOut: u256(o.minAmountOut, 'minAmountOut'), deadline: u256(o.deadline, 'deadline'),
  nonce: u256(o.nonce, 'nonce'), relayerFee: u256(o.relayerFee ?? 0n, 'relayerFee'),
});

/** ZetaphyPQOfflineOrders.orderHash (the same struct hash as ZetaphyOfflineOrders). */
export function pqOrderHash(o) {
  const n = normOrder(o);
  return keccak256(abi.encode(['bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [ORDER_TYPEHASH, ...ORDER_KEYS.map((k) => n[k])]));
}

/** ZetaphyPQOfflineOrders.digest: what the maker's ML-DSA key signs. */
export function pqOrderDigest({ chainId, contract }, o) {
  return keccak256(abi.encode(['string', 'uint256', 'address', 'bytes32'],
    ['ZETAPHY PQOfflineOrders order v1', BigInt(chainId), getAddress(contract), pqOrderHash(o)]));
}

/** A signed order: { chainId, contract, order, publicKey, sig }. The maker must have called setPQKey(pqKeyHash(publicKey)). */
export function signPQOrder(key, ctx, order) {
  const o = normOrder(order);
  return { chainId: BigInt(ctx.chainId), contract: getAddress(ctx.contract), order: o, publicKey: hexlify(key.publicKey), sig: key.sign(pqOrderDigest(ctx, o)) };
}

/**
 * The relayer's offline check: the signature, the deadline, and (when known) the maker's key on chain
 * (pqKeyOf(maker)). Returns { ok, reason }. Whether the swap pays enough is only known online (simulate fill).
 */
export function checkPQOrder(signed, { makerKeyHash, now = Math.floor(Date.now() / 1000), chainId, contract } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (chainId != null && BigInt(chainId) !== BigInt(signed.chainId)) return no('another chain');
  if (contract && getAddress(contract) !== getAddress(signed.contract)) return no('another contract');
  const o = normOrder(signed.order);
  if (BigInt(now) > o.deadline) return no('expired');
  if (makerKeyHash != null) {
    if (/^0x0{64}$/i.test(String(makerKeyHash))) return no('the maker has no ML-DSA key on chain');
    if (pqKeyHash(signed.publicKey).toLowerCase() !== String(makerKeyHash).toLowerCase()) return no('not the maker\'s key');
  }
  if (!pqVerify(pqOrderDigest(signed, o), signed.publicKey, signed.sig)) return no('bad signature');
  return { ok: true, reason: 'ok' };
}

/** The Order tuple in the contract's field order. */
export const pqOrderTuple = (o) => { const n = normOrder(o); return ORDER_KEYS.map((k) => n[k]); };
/** fill(order, pk, sig, path) arguments (path [] = the direct pool). */
export const pqFillArgs = (signed, path = []) => [pqOrderTuple(signed.order), signed.publicKey, signed.sig, path.map(getAddress)];

// ---------------------------------------------------------------- payloads (text; an ML-DSA-44 signature is 2420
// bytes, too big for the hub's single QR code: carry these as text or a file)

const toJson = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const b64url = (s) => encodeBase64(toUtf8Bytes(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => toUtf8String(decodeBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)));

export function encodePQCheque(chq) {
  return PQ_CHEQUE_PREFIX + b64url(toJson({ c: chq.chainId, k: chq.contract, i: chq.channelId, a: chq.cumulative, s: chq.sig }));
}
export function decodePQCheque(text) {
  const t = String(text).trim();
  if (!t.startsWith(PQ_CHEQUE_PREFIX)) throw new Error(`not an ML-DSA cheque (${PQ_CHEQUE_PREFIX}…)`);
  const j = JSON.parse(unb64url(t.slice(PQ_CHEQUE_PREFIX.length)));
  return { chainId: BigInt(j.c), contract: getAddress(j.k), channelId: u256(j.i, 'channelId'), cumulative: u256(j.a, 'cumulative'), sig: hexlify(j.s) };
}

export function encodePQOrder(signed) {
  return PQ_ORDER_PREFIX + b64url(toJson({ c: signed.chainId, k: signed.contract, o: pqOrderTuple(signed.order), p: signed.publicKey, s: signed.sig }));
}
export function decodePQOrder(text) {
  const t = String(text).trim();
  if (!t.startsWith(PQ_ORDER_PREFIX)) throw new Error(`not an ML-DSA order (${PQ_ORDER_PREFIX}…)`);
  const j = JSON.parse(unb64url(t.slice(PQ_ORDER_PREFIX.length)));
  if (!Array.isArray(j.o) || j.o.length !== ORDER_KEYS.length) throw new Error('bad order');
  const order = normOrder(Object.fromEntries(ORDER_KEYS.map((k, i) => [k, j.o[i]])));
  return { chainId: BigInt(j.c), contract: getAddress(j.k), order, publicKey: hexlify(j.p), sig: hexlify(j.s) };
}
