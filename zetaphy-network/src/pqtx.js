// Native post-quantum accounts on ZETAPHY: Cosmos SDK transactions signed
// with ML-DSA-44 only (no ECDSA key anywhere). Pure ESM with no Node-only
// imports, so the same file runs in the CLI and in the web wallet.
//
// Chain side (zetaphy-chain):
//   pubkey Any  /zetaphy.crypto.mldsa44.PubKey { bytes key = 1 }  (1312 bytes)
//   address     sha256("zetaphy/mldsa44\0" || publicKey)[0:20]  (same 20 bytes as the 0x address)
//   signature   ml_dsa44.sign(SignDoc bytes, secretKey), SIGN_MODE_DIRECT
//   JSON-RPC    zetaphy_pqAccount(address), zetaphy_sendCosmosTx(0x + TxRaw hex)
//   messages    /cosmos.bank.v1beta1.MsgSend
//               /cosmos.staking.v1beta1.MsgDelegate, MsgUndelegate
//               /cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward
//               /zetaphy.pq.v1.MsgEVMCall: call an EVM contract as the account (msg.sender =
//                 the same 20 bytes), or create one (empty `to`); its EVM gas is charged on
//                 the Cosmos gas meter. as_owner: act for a quantum-locked account instead
//               /zetaphy.pq.v1.MsgQuantumLock: the controller of a locked account hands it on
//   quantum lock an ECDSA (MetaMask) account sends an EVM tx to PQ_LOCK_ADDRESS with no value
//                and the controller's 20-byte address as data; from then on its own key is
//                refused and only that ML-DSA-44 account acts for it (MsgEVMCall.as_owner)
//   security core (zetaphy-chain: zetaphy_security.go; docs/SECURITY-CORE.md)
//               /zetaphy.pq.v1.MsgQDayCommit, MsgQDayReveal: the commit–reveal Q-day migration
//               /zetaphy.pq.v1.MsgIBCHoldCancel: the guardian returns a held IBC transfer
//               consent(target, seconds) on SECURITY_PRECOMPILE: go ahead past the threat gate
//               JSON-RPC zetaphy_securityStatus, zetaphy_migration, zetaphy_qdayCommitment,
//               zetaphy_consent, zetaphy_ibcHolds

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const CHAIN_ID = 'zetaphy_77390-1';
export const DENOM = 'azetaphy';
export const PREFIX = 'zetaphy';
export const PUBKEY_TYPE_URL = '/zetaphy.crypto.mldsa44.PubKey';
export const VALOPER_PREFIX = 'zetaphyvaloper';
export const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';
export const MSG_DELEGATE_TYPE_URL = '/cosmos.staking.v1beta1.MsgDelegate';
export const MSG_UNDELEGATE_TYPE_URL = '/cosmos.staking.v1beta1.MsgUndelegate';
export const MSG_WITHDRAW_REWARD_TYPE_URL = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward';
export const MSG_EVM_CALL_TYPE_URL = '/zetaphy.pq.v1.MsgEVMCall';
export const MSG_QUANTUM_LOCK_TYPE_URL = '/zetaphy.pq.v1.MsgQuantumLock';
export const MSG_QDAY_COMMIT_TYPE_URL = '/zetaphy.pq.v1.MsgQDayCommit';
export const MSG_QDAY_REVEAL_TYPE_URL = '/zetaphy.pq.v1.MsgQDayReveal';
export const MSG_IBC_HOLD_CANCEL_TYPE_URL = '/zetaphy.pq.v1.MsgIBCHoldCancel';
/** The security precompile: consent(target, seconds), consentUntil, threatGate, qday, migration, cancelIBCHold. */
export const SECURITY_PRECOMPILE = '0x0000000000000000000000000000000000000901';
/** A consent to the threat gate lasts at most a day. */
export const MAX_CONSENT_SECONDS = 86400;
/** An EVM tx to here (value 0, data = the controller's 20 bytes) quantum-locks its sender. */
export const PQ_LOCK_ADDRESS = '0x0000000000000000000000000000000000005051';
/** Cosmos EVM's staking and distribution precompiles (how a locked account stakes, through as_owner). */
export const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000800';
export const DISTRIBUTION_PRECOMPILE = '0x0000000000000000000000000000000000000801';
/** zetaphy_pqAccount's pubKeyType for an ML-DSA-44 account. */
export const MLDSA_PUBKEY_TYPE = 'mldsa44';
export const SIGN_MODE_DIRECT = 1;
export const DEFAULT_GAS_LIMIT = 400000n;
/** Tx gas for one staking or rewards message (more state is touched than in a send). */
export const DEFAULT_STAKING_GAS_LIMIT = 500000n;
/** EVM gas for a MsgEVMCall when none is given. */
export const DEFAULT_EVM_GAS_LIMIT = 200000n;
/** EVM gas for a contract creation when none is given. */
export const DEFAULT_DEPLOY_GAS_LIMIT = 3000000n;
/**
 * EVM gas for a staking or distribution precompile call (as_owner) when none is given:
 * about 1.5x the largest eth_estimateGas measured on a devnet (undelegate ~190k,
 * delegate onto an existing delegation ~154k, withdrawDelegatorRewards ~98k).
 */
export const DEFAULT_PRECOMPILE_GAS_LIMIT = 300000n;
/** Tx gas = EVM gas + this: the ML-DSA signature check, tx size and the Cosmos side of the call. */
export const EVM_CALL_GAS_OVERHEAD = 400000n;
/** The chain's bounds on a MsgEVMCall's gas_limit (an EVM tx needs 21000; the node caps calls at 10M). */
export const MIN_EVM_GAS_LIMIT = 21000n;
export const MAX_EVM_GAS_LIMIT = 10000000n;
const MAX_UINT64 = 2n ** 64n - 1n;
export const PUBLIC_KEY_BYTES = 1312;
export const SIGNATURE_BYTES = 2420;
const DECIMALS = 18;

// ---- bytes and hex ----

export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);
const asBytes = (b, what) => {
  if (b instanceof Uint8Array) return b;
  if (typeof b === 'string') return hexToBytes(b);
  throw new Error(`${what} must be bytes or hex`);
};

// ---- minimal protobuf writer (proto3: default values are left out) ----

export function varint(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error('varint must not be negative');
  const out = [];
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return Uint8Array.from(out);
}

const key = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, bytes) => concat([key(field, 2), varint(bytes.length), bytes]);

const pb = {
  uint: (field, v) => (BigInt(v ?? 0) === 0n ? [] : [concat([key(field, 0), varint(v)])]),
  string: (field, s) => (s ? [lenDelim(field, utf8(s))] : []),
  bytes: (field, b) => (b && b.length ? [lenDelim(field, b)] : []),
  // An embedded message that is set is written even when empty.
  message: (field, m) => (m == null ? [] : [lenDelim(field, m)]),
  repeatedMessage: (field, list) => list.map((m) => lenDelim(field, m)),
  repeatedBytes: (field, list) => list.map((b) => lenDelim(field, b)),
};
const msg = (...fields) => concat(fields.flat());

// ---- Cosmos SDK messages ----

export const encodeAny = (typeUrl, value) => msg(pb.string(1, typeUrl), pb.bytes(2, value));
export const encodeCoin = ({ denom, amount }) => msg(pb.string(1, denom), pb.string(2, String(amount)));
export const encodePubKey = (publicKey) => msg(pb.bytes(1, publicKey));

export const encodeMsgSend = ({ fromAddress, toAddress, amount }) =>
  msg(pb.string(1, fromAddress), pb.string(2, toAddress), pb.repeatedMessage(3, amount.map(encodeCoin)));

// cosmos.staking.v1beta1: MsgDelegate and MsgUndelegate have the same fields.
const encodeStake = ({ delegatorAddress, validatorAddress, amount }) =>
  msg(pb.string(1, delegatorAddress), pb.string(2, validatorAddress), pb.message(3, encodeCoin(amount)));
export const encodeMsgDelegate = encodeStake;
export const encodeMsgUndelegate = encodeStake;

export const encodeMsgWithdrawDelegatorReward = ({ delegatorAddress, validatorAddress }) =>
  msg(pb.string(1, delegatorAddress), pb.string(2, validatorAddress));

/**
 * zetaphy.pq.v1.MsgEVMCall { string sender = 1; string to = 2; string value = 3;
 * bytes data = 4; uint64 gas_limit = 5; string as_owner = 6; }  value is azetaphy in
 * decimal, left out when 0. An empty `to` creates a contract (data = init code);
 * as_owner runs the call with msg.sender = that quantum-locked account.
 */
export const encodeMsgEVMCall = ({ sender, to = '', value = 0n, data = new Uint8Array(), gasLimit, asOwner = '' }) =>
  msg(pb.string(1, sender), pb.string(2, to), pb.string(3, BigInt(value) === 0n ? '' : BigInt(value).toString()),
    pb.bytes(4, data), pb.uint(5, gasLimit), pb.string(6, asOwner));

/** zetaphy.pq.v1.MsgQuantumLock { string signer = 1; string owner = 2; string controller = 3; } */
/** zetaphy.pq.v1.MsgQDayCommit { string signer = 1; bytes commitment = 2; } */
export const encodeMsgQDayCommit = ({ signer, commitment }) => msg(pb.string(1, signer), pb.bytes(2, commitment));

/** zetaphy.pq.v1.MsgQDayReveal { string signer = 1; string owner = 2; string controller = 3; bytes salt = 4; bytes signature = 5; } */
export const encodeMsgQDayReveal = ({ signer, owner, controller, salt, signature }) =>
  msg(pb.string(1, signer), pb.string(2, owner), pb.string(3, controller), pb.bytes(4, salt), pb.bytes(5, signature));

/** zetaphy.pq.v1.MsgIBCHoldCancel { string signer = 1; uint64 id = 2; } */
export const encodeMsgIBCHoldCancel = ({ signer, id }) => msg(pb.string(1, signer), pb.uint(2, id));

export const encodeMsgQuantumLock = ({ signer, owner, controller }) =>
  msg(pb.string(1, signer), pb.string(2, owner), pb.string(3, controller));

export const encodeTxBody = ({ messages, memo = '', timeoutHeight = 0n }) =>
  msg(pb.repeatedMessage(1, messages.map((m) => encodeAny(m.typeUrl, m.value))), pb.string(2, memo), pb.uint(3, timeoutHeight));

export const encodeModeInfoSingle = (mode) => msg(pb.message(1, msg(pb.uint(1, mode))));

export const encodeSignerInfo = ({ publicKey, mode = SIGN_MODE_DIRECT, sequence }) =>
  msg(pb.message(1, encodeAny(PUBKEY_TYPE_URL, encodePubKey(publicKey))), pb.message(2, encodeModeInfoSingle(mode)), pb.uint(3, sequence));

export const encodeFee = ({ amount, gasLimit, payer = '', granter = '' }) =>
  msg(pb.repeatedMessage(1, amount.map(encodeCoin)), pb.uint(2, gasLimit), pb.string(3, payer), pb.string(4, granter));

export const encodeAuthInfo = ({ signerInfos, fee }) =>
  msg(pb.repeatedMessage(1, signerInfos.map(encodeSignerInfo)), pb.message(2, encodeFee(fee)));

export const encodeSignDoc = ({ bodyBytes, authInfoBytes, chainId, accountNumber }) =>
  msg(pb.bytes(1, bodyBytes), pb.bytes(2, authInfoBytes), pb.string(3, chainId), pb.uint(4, accountNumber));

export const encodeTxRaw = ({ bodyBytes, authInfoBytes, signatures }) =>
  msg(pb.bytes(1, bodyBytes), pb.bytes(2, authInfoBytes), pb.repeatedBytes(3, signatures));

// ---- bech32 (BIP-173), copied from zetaphy-neuro/src/bech32.js ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data, from, to, pad) {
  let acc = 0; let bits = 0; const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) throw new Error('invalid address');
  return out;
}

export function toBech32(bytes, prefix = PREFIX) {
  const data = convertBits([...bytes], 8, 5, true);
  const mod = polymod([...hrpExpand(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return prefix + '1' + [...data, ...check].map((d) => CHARSET[d]).join('');
}

/** 'zetaphy1…' -> 20 bytes; throws on a wrong prefix, length or checksum. */
export function fromBech32(s, prefix = PREFIX) {
  if (typeof s !== 'string' || s.length > 90) throw new Error('invalid address');
  if (s === s.toUpperCase()) s = s.toLowerCase();
  if (s !== s.toLowerCase()) throw new Error('invalid address');
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('invalid address');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error('invalid address');
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('invalid address: bad checksum');
  if (hrp !== prefix) throw new Error(`invalid address: expected ${prefix}1…`);
  const bytes = Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false));
  if (bytes.length !== 20) throw new Error('invalid address: not 20 bytes');
  return bytes;
}

// ---- addresses ----

/** EIP-55 checksummed 0x address. */
export function toChecksumHex(bytes) {
  const lower = bytesToHex(bytes);
  const h = bytesToHex(keccak_256(utf8(lower)));
  return '0x' + [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/** 0x… or zetaphy1… -> 20 bytes. A mixed-case 0x address must have a valid EIP-55 checksum. */
export function addressBytes(addr, prefix = PREFIX) {
  const s = String(addr ?? '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    const bytes = hexToBytes(s);
    const body = s.slice(2);
    if (body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksumHex(bytes) !== s) throw new Error('invalid address: bad 0x checksum');
    return bytes;
  }
  if (/^0x/i.test(s)) throw new Error('invalid address: a 0x address has 40 hex digits');
  return fromBech32(s, prefix);
}

export const normalizeAddress = (addr, prefix = PREFIX) => {
  const bytes = addressBytes(addr, prefix);
  return { bytes, hex: toChecksumHex(bytes), bech32: toBech32(bytes, prefix) };
};

/** 'zetaphyvaloper1…' -> the same string in canonical (lower case) form; throws on a wrong prefix or checksum. */
export function validatorAddress(addr, valoperPrefix = VALOPER_PREFIX) {
  return toBech32(fromBech32(String(addr ?? '').trim(), valoperPrefix), valoperPrefix);
}

// Kept apart from every other sha256(...)[:20] address in the Cosmos SDK.
export const ADDRESS_PREFIX = new TextEncoder().encode('zetaphy/mldsa44\0');

/** The account of an ML-DSA-44 public key: sha256(ADDRESS_PREFIX || pk)[0:20]. */
export function pqAddress(publicKey, prefix = PREFIX) {
  const pk = asBytes(publicKey, 'publicKey');
  if (pk.length !== PUBLIC_KEY_BYTES) throw new Error(`ML-DSA-44 public key must be ${PUBLIC_KEY_BYTES} bytes`);
  const pre = new Uint8Array(ADDRESS_PREFIX.length + pk.length);
  pre.set(ADDRESS_PREFIX); pre.set(pk, ADDRESS_PREFIX.length);
  const bytes = sha256(pre).slice(0, 20);
  return { bytes, hex: toChecksumHex(bytes), bech32: toBech32(bytes, prefix) };
}

// ---- amounts (1 ZETAPHY = 10^18 azetaphy) ----

export function parseZeta(text) {
  const s = String(text).trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m) throw new Error(`not an amount: ${text}`);
  const frac = m[2] ?? '';
  if (frac.length > DECIMALS) throw new Error(`at most ${DECIMALS} decimal places`);
  return BigInt(m[1] || '0') * 10n ** BigInt(DECIMALS) + BigInt(frac.padEnd(DECIMALS, '0') || '0');
}

export function formatZeta(a) {
  const v = BigInt(a);
  const neg = v < 0n; const x = neg ? -v : v;
  const unit = 10n ** BigInt(DECIMALS);
  const frac = (x % unit).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${x / unit}${frac ? '.' + frac : ''}`;
}

/** eth_gasPrice times 1.2, rounded up. */
export const bumpGasPrice = (p) => (BigInt(p) * 12n + 9n) / 10n;

/** CometBFT tx hash: uppercase hex sha256 of the TxRaw bytes. */
export const txHashOf = (txBytes) => bytesToHex(sha256(txBytes)).toUpperCase();

// ---- messages: { typeUrl, value (bytes), spend (azetaphy that leaves the account, besides the fee),
//      intent (the same message as plain JSON, for a signer that shows it and builds it itself) } ----

const positive = (v, what) => {
  const x = BigInt(v);
  if (x <= 0n) throw new Error(`${what} must be more than 0`);
  return x;
};
const uint64 = (v, what) => {
  const x = positive(v, what);
  if (x > MAX_UINT64) throw new Error(`${what} is too large`);
  return x;
};
const accountBech32 = (addr, prefix) => toBech32(addressBytes(addr, prefix), prefix);

export function msgSend({ from, to, amount, denom = DENOM, prefix = PREFIX }) {
  const value = positive(amount, 'amount');
  const toAddress = accountBech32(to, prefix);
  return { typeUrl: MSG_SEND_TYPE_URL, spend: value, intent: { type: 'send', to: toAddress, amount: value.toString(), denom },
    value: encodeMsgSend({ fromAddress: accountBech32(from, prefix), toAddress, amount: [{ denom, amount: value.toString() }] }) };
}

export function msgDelegate({ delegator, validator, amount, denom = DENOM, prefix = PREFIX }) {
  const value = positive(amount, 'amount');
  const val = validatorAddress(validator, prefix + 'valoper');
  return { typeUrl: MSG_DELEGATE_TYPE_URL, spend: value, intent: { type: 'delegate', validator: val, amount: value.toString(), denom },
    value: encodeMsgDelegate({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: val, amount: { denom, amount: value.toString() } }) };
}

export function msgUndelegate({ delegator, validator, amount, denom = DENOM, prefix = PREFIX }) {
  const value = positive(amount, 'amount');
  const val = validatorAddress(validator, prefix + 'valoper');
  return { typeUrl: MSG_UNDELEGATE_TYPE_URL, spend: 0n, intent: { type: 'undelegate', validator: val, amount: value.toString(), denom },
    value: encodeMsgUndelegate({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: val, amount: { denom, amount: value.toString() } }) };
}

export function msgWithdrawRewards({ delegator, validator, prefix = PREFIX }) {
  const val = validatorAddress(validator, prefix + 'valoper');
  return { typeUrl: MSG_WITHDRAW_REWARD_TYPE_URL, spend: 0n, intent: { type: 'withdrawRewards', validator: val },
    value: encodeMsgWithdrawDelegatorReward({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: val }) };
}

function evmMsg({ sender, to, value, data, gasLimit, asOwner, prefix }) {
  const v = BigInt(value);
  if (v < 0n) throw new Error('value must not be negative');
  const gas = BigInt(gasLimit);
  if (gas < MIN_EVM_GAS_LIMIT || gas > MAX_EVM_GAS_LIMIT) throw new Error(`EVM gas limit must be between ${MIN_EVM_GAS_LIMIT} and ${MAX_EVM_GAS_LIMIT}`);
  const from = accountBech32(sender, prefix);
  const owner = asOwner == null || asOwner === '' ? '' : accountBech32(asOwner, prefix);
  if (owner && owner === from) throw new Error('as_owner is the sender itself: leave it out');
  const bytes = asBytes(data, 'data');
  const intent = to ? { type: 'evmCall', to, data: '0x' + bytesToHex(bytes) } : { type: 'evmDeploy', initCode: '0x' + bytesToHex(bytes) };
  Object.assign(intent, { value: v.toString(), gasLimit: gas.toString() }, owner ? { asOwner: owner } : {});
  // With as_owner the value leaves the owner; the signer pays only the fee.
  return { typeUrl: MSG_EVM_CALL_TYPE_URL, spend: owner ? 0n : v, ownerSpend: owner ? v : 0n, asOwner: owner || undefined, intent,
    value: encodeMsgEVMCall({ sender: from, to, value: v, data: bytes, gasLimit: gas, asOwner: owner }) };
}

/**
 * An EVM call (never a contract creation: `to` is required, see msgEVMDeploy). `to` is sent
 * EIP-55 checksummed. asOwner (0x… or zetaphy1…): act for that quantum-locked account; the
 * sender must be its controller.
 */
export function msgEVMCall({ sender, to, value = 0n, data = new Uint8Array(), gasLimit = DEFAULT_EVM_GAS_LIMIT, asOwner, prefix = PREFIX }) {
  if (to == null || String(to).trim() === '') throw new Error('an EVM call needs a "to" address (use msgEVMDeploy to create a contract)');
  const toBytes = addressBytes(to, prefix);
  return evmMsg({ sender, to: toChecksumHex(toBytes), value, data, gasLimit, asOwner, prefix });
}

/** A contract creation: MsgEVMCall with an empty `to` and the init code as data. */
export function msgEVMDeploy({ sender, initCode, value = 0n, gasLimit = DEFAULT_DEPLOY_GAS_LIMIT, asOwner, prefix = PREFIX }) {
  const code = asBytes(initCode ?? new Uint8Array(), 'initCode');
  if (code.length === 0) throw new Error('a contract creation needs init code');
  return evmMsg({ sender, to: '', value, data: code, gasLimit, asOwner, prefix });
}

/**
 * MsgQuantumLock: the current controller (signer) of a locked owner hands control to
 * another ML-DSA-44 account. An unlocked ECDSA account may also lock itself with it
 * (signer = owner); an ML-DSA-44 account cannot be locked ("post-quantum already").
 */
export function msgQuantumLock({ signer, owner, controller, prefix = PREFIX }) {
  const s = accountBech32(signer, prefix); const o = accountBech32(owner, prefix); const c = accountBech32(controller, prefix);
  if (c === o) throw new Error('the controller must be another account than the owner');
  return { typeUrl: MSG_QUANTUM_LOCK_TYPE_URL, spend: 0n, intent: { type: 'quantumLock', owner: o, controller: c },
    value: encodeMsgQuantumLock({ signer: s, owner: o, controller: c }) };
}

// ---- security core: Q-day migration, consent, IBC hold ----

const bytes32 = (b, what) => {
  const x = asBytes(b, what);
  if (x.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return x;
};

/**
 * What the old ECDSA key signs (EIP-191 personal_sign, e.g. MetaMask) to move its account to an
 * ML-DSA-44 controller after Q-day. Must match zetaphy-chain QDayRevealText byte for byte.
 */
export function qdayRevealText({ chainId = CHAIN_ID, owner, controller, prefix = PREFIX }) {
  return `ZETAPHY Q-day migration\nChain: ${chainId}\nAccount: ${toChecksumHex(addressBytes(owner, prefix))}` +
    `\nNew ML-DSA-44 controller: ${toChecksumHex(addressBytes(controller, prefix))}\nSign this only in the ZETAPHY wallet.`;
}

/** The salt of a migration: keccak-256 of the owner's signature (deterministic, so nothing has to be saved between steps). */
export const qdaySalt = (signature) => keccak_256(asBytes(signature, 'signature'));

/**
 * The Q-day commitment: sha256("zetaphy/qday-commit\0" || chainId || "\0" || the owner's compressed
 * secp256k1 public key (33 bytes) || controller (20 bytes) || salt (32 bytes)). It shows nothing
 * about the key until the reveal.
 */
export function qdayCommitment({ chainId = CHAIN_ID, publicKey, controller, salt, prefix = PREFIX }) {
  const pub = asBytes(publicKey, 'publicKey');
  if (pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) throw new Error('publicKey must be the 33-byte compressed secp256k1 key');
  return sha256(concat([utf8(`zetaphy/qday-commit\0${chainId}\0`), pub, addressBytes(controller, prefix), bytes32(salt, 'salt')]));
}

/** MsgQDayCommit from `signer` (the new ML-DSA-44 account): records the commitment, shows nothing. */
export function msgQDayCommit({ signer, commitment, prefix = PREFIX }) {
  const c = bytes32(commitment, 'commitment');
  return { typeUrl: MSG_QDAY_COMMIT_TYPE_URL, spend: 0n, intent: { type: 'qdayCommit', commitment: '0x' + bytesToHex(c) },
    value: encodeMsgQDayCommit({ signer: accountBech32(signer, prefix), commitment: c }) };
}

/** MsgQDayReveal: opens the commitment (at least the reveal delay old) and moves `owner` to `controller`. */
export function msgQDayReveal({ signer, owner, controller, salt, signature, prefix = PREFIX }) {
  const sig = asBytes(signature, 'signature');
  if (sig.length !== 65) throw new Error('signature must be 65 bytes (r, s, v)');
  const o = accountBech32(owner, prefix); const c = accountBech32(controller, prefix); const sl = bytes32(salt, 'salt');
  return { typeUrl: MSG_QDAY_REVEAL_TYPE_URL, spend: 0n,
    intent: { type: 'qdayReveal', owner: o, controller: c, salt: '0x' + bytesToHex(sl), signature: '0x' + bytesToHex(sig) },
    value: encodeMsgQDayReveal({ signer: accountBech32(signer, prefix), owner: o, controller: c, salt: sl, signature: sig }) };
}

/** MsgIBCHoldCancel: the guardian returns held inbound IBC transfer `id` to its sender. */
export function msgIBCHoldCancel({ signer, id, prefix = PREFIX }) {
  const n = uint64(id, 'id');
  return { typeUrl: MSG_IBC_HOLD_CANCEL_TYPE_URL, spend: 0n, intent: { type: 'ibcHoldCancel', id: n.toString() },
    value: encodeMsgIBCHoldCancel({ signer: accountBech32(signer, prefix), id: n }) };
}

const uint64Word = (v) => abiWord(uint64(v, 'seconds'));

/**
 * { to, data } of consent(target, seconds) on the security precompile: the sender goes ahead
 * past the threat gate for calls to `target` for `seconds` (at most a day; 0 withdraws). From
 * MetaMask it is a plain EVM tx; from an ML-DSA-44 account a MsgEVMCall (msgConsent).
 */
export function consentCall(target, seconds, prefix = PREFIX) {
  const s = BigInt(seconds);
  if (s < 0n || s > BigInt(MAX_CONSENT_SECONDS)) throw new Error(`seconds must be 0 to ${MAX_CONSENT_SECONDS} (a day)`);
  return { to: SECURITY_PRECOMPILE, data: concat([keccak_256(utf8('consent(address,uint64)')).slice(0, 4), concat([new Uint8Array(12), addressBytes(target, prefix)]), uint64Word(s)]) };
}

/** MsgEVMCall to the security precompile giving consent (as the sender, or with asOwner as a locked account). */
export function msgConsent({ sender, target, seconds, asOwner, prefix = PREFIX }) {
  const c = consentCall(target, seconds, prefix);
  const m = msgEVMCall({ sender, to: c.to, data: c.data, gasLimit: DEFAULT_EVM_GAS_LIMIT, asOwner, prefix });
  m.intent = { type: 'consent', target: toChecksumHex(addressBytes(target, prefix)), seconds: BigInt(seconds).toString(), ...(asOwner ? { asOwner: m.intent.asOwner } : {}) };
  return m;
}

/**
 * Reads a threat-gate refusal (the chain's error text) into { target, registry, reason };
 * null when the text is not one.
 */
export function parseThreatRefusal(text) {
  const m = /(0x[0-9a-fA-F]{40}) has an enforced flag in the Neuro threat registry (0x[0-9a-fA-F]{40}) \(reason: ([A-Za-z0-9]+)\)/.exec(String(text ?? ''));
  return m ? { target: m[1], registry: m[2], reason: m[3] } : null;
}

/**
 * The message an intent describes, from `sender` (the account that signs it). An intent is
 * a message as plain JSON with no sender (every message's `intent`); a signer that cannot
 * be handed bytes (the ZETAPHY MetaMask Snap) builds the message from it with this, shows
 * it, and signs what it built. Intents (amounts and gas as decimal strings, bytes as 0x hex):
 *   { type: 'send', to, amount, denom? }
 *   { type: 'delegate' | 'undelegate', validator, amount, denom? }   { type: 'withdrawRewards', validator }
 *   { type: 'evmCall', to, data?, value?, gasLimit?, asOwner? }      { type: 'evmDeploy', initCode, value?, gasLimit?, asOwner? }
 *   { type: 'quantumLock', owner, controller }  (hands the locked `owner` on to `controller`)
 *   { type: 'qdayCommit', commitment }   { type: 'qdayReveal', owner, controller, salt, signature }
 *   { type: 'consent', target, seconds, asOwner? }   { type: 'ibcHoldCancel', id }
 */
export function messageFromIntent(intent, sender, prefix = PREFIX) {
  const i = intent ?? {};
  switch (i.type) {
    case 'send': return msgSend({ from: sender, to: i.to, amount: i.amount, denom: i.denom ?? DENOM, prefix });
    case 'delegate': return msgDelegate({ delegator: sender, validator: i.validator, amount: i.amount, denom: i.denom ?? DENOM, prefix });
    case 'undelegate': return msgUndelegate({ delegator: sender, validator: i.validator, amount: i.amount, denom: i.denom ?? DENOM, prefix });
    case 'withdrawRewards': return msgWithdrawRewards({ delegator: sender, validator: i.validator, prefix });
    case 'evmCall': return msgEVMCall({ sender, to: i.to, value: i.value ?? 0n, data: i.data ?? new Uint8Array(), gasLimit: i.gasLimit ?? DEFAULT_EVM_GAS_LIMIT, asOwner: i.asOwner, prefix });
    case 'evmDeploy': return msgEVMDeploy({ sender, initCode: i.initCode, value: i.value ?? 0n, gasLimit: i.gasLimit ?? DEFAULT_DEPLOY_GAS_LIMIT, asOwner: i.asOwner, prefix });
    case 'quantumLock': return msgQuantumLock({ signer: sender, owner: i.owner, controller: i.controller, prefix });
    case 'qdayCommit': return msgQDayCommit({ signer: sender, commitment: i.commitment, prefix });
    case 'qdayReveal': return msgQDayReveal({ signer: sender, owner: i.owner, controller: i.controller, salt: i.salt, signature: i.signature, prefix });
    case 'consent': return msgConsent({ sender, target: i.target, seconds: i.seconds, asOwner: i.asOwner, prefix });
    case 'ibcHoldCancel': return msgIBCHoldCancel({ signer: sender, id: i.id, prefix });
    default: throw new Error(`unknown message type ${JSON.stringify(i.type)}`);
  }
}

/**
 * The EVM tx that quantum-locks its sender (e.g. a MetaMask account) to `controller`:
 * { to: PQ_LOCK_ADDRESS, value: 0, data: the controller's 20 bytes }. Permanent.
 */
export function quantumLockTx(controller, prefix = PREFIX) {
  return { to: PQ_LOCK_ADDRESS, value: 0n, data: '0x' + bytesToHex(addressBytes(controller, prefix)) };
}

// ---- contract creation address: keccak256(rlp([sender, nonce]))[12:] ----

const rlpBytes = (b) => (b.length === 1 && b[0] < 0x80 ? b : concat([Uint8Array.of(0x80 + b.length), b]));
function uintBytes(n) {
  let v = BigInt(n);
  if (v < 0n || v > MAX_UINT64) throw new Error('nonce must be a uint64');
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Uint8Array.from(out); // 0 is the empty string
}

/** The address CREATE gives a contract made by `sender` at `nonce` (EIP-55). */
export function createAddress(sender, nonce, prefix = PREFIX) {
  const payload = concat([rlpBytes(addressBytes(sender, prefix)), rlpBytes(uintBytes(nonce))]);
  return toChecksumHex(keccak_256(concat([Uint8Array.of(0xc0 + payload.length), payload])).slice(12));
}

// ---- staking and distribution precompiles (calldata; ABI from cosmos/evm precompiles/*/abi.json) ----

const abiWord = (v) => {
  const x = BigInt(v);
  if (x < 0n || x >= 2n ** 256n) throw new Error('value out of uint256 range');
  return hexToBytes(x.toString(16).padStart(64, '0'));
};
/** ABI-encodes a call; args are [type, value] with type address, uint256, uint32 or string. */
function abiCall(signature, args) {
  const head = []; const tail = [];
  let tailLen = 32 * args.length;
  for (const [type, value] of args) {
    if (type === 'string') {
      const b = utf8(String(value));
      const padded = new Uint8Array(Math.ceil(b.length / 32) * 32); padded.set(b);
      head.push(abiWord(tailLen));
      tail.push(abiWord(b.length), padded);
      tailLen += 32 + padded.length;
    } else if (type === 'address') {
      head.push(concat([new Uint8Array(12), addressBytes(value)]));
    } else head.push(abiWord(value));
  }
  return concat([keccak_256(utf8(signature)).slice(0, 4), ...head, ...tail]);
}

const STAKING_CALLS = {
  delegate: 'delegate(address,string,uint256)',
  undelegate: 'undelegate(address,string,uint256)',
  withdrawRewards: 'withdrawDelegatorRewards(address,string)',
};

/**
 * { to, data } for the staking precompile (delegate, undelegate) or the distribution
 * precompile (withdrawRewards), with `delegator` as the delegator. The precompiles
 * require msg.sender = delegator, so a controller sends it with as_owner = delegator.
 */
export function stakingCall({ action, delegator, validator, amount, prefix = PREFIX }) {
  const sig = STAKING_CALLS[action];
  if (!sig) throw new Error(`unknown staking action ${action}`);
  const args = [['address', toChecksumHex(addressBytes(delegator, prefix))], ['string', validatorAddress(validator, prefix + 'valoper')]];
  if (action !== 'withdrawRewards') args.push(['uint256', positive(amount, 'amount')]);
  return { to: action === 'withdrawRewards' ? DISTRIBUTION_PRECOMPILE : STAKING_PRECOMPILE, data: abiCall(sig, args) };
}

// ---- build and sign ----

/**
 * Any list of messages from an ML-DSA-44 account, signed with SIGN_MODE_DIRECT.
 * messages: [{ typeUrl, value: bytes }]; the chain checks that the account signs for each.
 * sign(bytes) must return the raw 2420-byte ML-DSA-44 signature of bytes.
 */
export function buildTx({ publicKey, sign, messages, denom = DENOM, chainId = CHAIN_ID,
  accountNumber, sequence, gasLimit = DEFAULT_GAS_LIMIT, gasPrice, memo = '' }) {
  const pk = asBytes(publicKey, 'publicKey');
  if (pk.length !== PUBLIC_KEY_BYTES) throw new Error(`ML-DSA-44 public key must be ${PUBLIC_KEY_BYTES} bytes`);
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('at least one message is required');
  for (const m of messages) {
    if (typeof m?.typeUrl !== 'string' || !m.typeUrl.startsWith('/')) throw new Error('every message needs a typeUrl like /cosmos.bank.v1beta1.MsgSend');
    if (!(m.value instanceof Uint8Array)) throw new Error(`message ${m.typeUrl}: value must be the encoded bytes`);
  }
  if (accountNumber == null || sequence == null) throw new Error('accountNumber and sequence are required');
  if (gasPrice == null) throw new Error('gasPrice is required');
  const gas = uint64(gasLimit, 'gasLimit');
  if (typeof sign !== 'function') throw new Error('sign must be a function');

  const bodyBytes = encodeTxBody({ messages: messages.map(({ typeUrl, value }) => ({ typeUrl, value })), memo });
  const fee = { amount: [{ denom, amount: (gas * BigInt(gasPrice)).toString() }], gasLimit: gas };
  const authInfoBytes = encodeAuthInfo({ signerInfos: [{ publicKey: pk, mode: SIGN_MODE_DIRECT, sequence: BigInt(sequence) }], fee });
  const signDocBytes = encodeSignDoc({ bodyBytes, authInfoBytes, chainId, accountNumber: BigInt(accountNumber) });
  const signature = asBytes(sign(signDocBytes), 'signature');
  if (signature.length !== SIGNATURE_BYTES) throw new Error(`ML-DSA-44 signature must be ${SIGNATURE_BYTES} bytes`);
  const txBytes = encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [signature] });
  return { txBytes, txHex: '0x' + bytesToHex(txBytes), signDocBytes, bodyBytes, authInfoBytes, fee: BigInt(fee.amount[0].amount), txHash: txHashOf(txBytes) };
}

/**
 * buildTx for a signer that builds and signs the tx itself and is never handed bytes (the
 * ZETAPHY MetaMask Snap). signTx(request) gets every message as its intent (plain JSON, see
 * messageFromIntent), with { chainId, accountNumber, sequence, gasLimit, gasPrice, memo } as
 * decimal strings, and returns { signature, txHex? } (0x hex). The tx is built here around
 * that signature, so it is exactly the tx asked for; a signer whose txHex is any other tx is
 * refused before anything is sent.
 */
export async function buildTxWith({ publicKey, signTx, messages, denom = DENOM, chainId = CHAIN_ID,
  accountNumber, sequence, gasLimit = DEFAULT_GAS_LIMIT, gasPrice, memo = '' }) {
  if (typeof signTx !== 'function') throw new Error('signTx must be a function');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('at least one message is required');
  if (denom !== DENOM) throw new Error(`an external signer pays fees in ${DENOM} only`);
  const intents = messages.map((m) => {
    if (!m?.intent) throw new Error(`message ${m?.typeUrl}: no intent, so an external signer cannot show it`);
    return m.intent;
  });
  if (accountNumber == null || sequence == null) throw new Error('accountNumber and sequence are required');
  if (gasPrice == null) throw new Error('gasPrice is required');
  const request = { chainId, accountNumber: BigInt(accountNumber).toString(), sequence: BigInt(sequence).toString(),
    gasLimit: BigInt(gasLimit).toString(), gasPrice: BigInt(gasPrice).toString(), memo, messages: intents };
  const signed = await signTx(request);
  if (!signed || typeof signed !== 'object' || signed.signature == null) throw new Error('the signer returned no signature');
  const tx = buildTx({ publicKey, sign: () => signed.signature, messages, denom, chainId, accountNumber, sequence, gasLimit, gasPrice, memo });
  if (signed.txHex != null && String(signed.txHex).toLowerCase() !== tx.txHex.toLowerCase()) {
    throw new Error('the signer signed another transaction than the one asked for, so nothing was sent');
  }
  return tx;
}

/** One bank send from an ML-DSA-44 account (buildTx with a single MsgSend). */
export function buildSendTx({ publicKey, sign, from, to, amount, denom = DENOM, chainId = CHAIN_ID,
  accountNumber, sequence, gasLimit = DEFAULT_GAS_LIMIT, gasPrice, memo = '', prefix = PREFIX }) {
  const me = pqAddress(publicKey, prefix);
  if (from != null && accountBech32(from, prefix) !== me.bech32) throw new Error('from does not match the public key');
  return buildTx({ publicKey, sign, messages: [msgSend({ from: me.bech32, to, amount, denom, prefix })],
    denom, chainId, accountNumber, sequence, gasLimit, gasPrice, memo });
}

// ---- client over the node's JSON-RPC (rpcCall is ethers' provider.send or a fetch wrapper) ----

const qty = (v) => '0x' + BigInt(v).toString(16);

export function pqClient(rpcCall, { chainId = CHAIN_ID, denom = DENOM, prefix = PREFIX } = {}) {
  async function account(addr) {
    const a = await rpcCall('zetaphy_pqAccount', [addr]);
    if (!a || typeof a !== 'object' || typeof a.exists !== 'boolean') throw new Error('the node did not answer zetaphy_pqAccount (does it run ZETAPHY with native PQ accounts?)');
    if (a.chainId && a.chainId !== chainId) throw new Error(`the node is on ${a.chainId}, not ${chainId}`);
    if (a.denom && a.denom !== denom) throw new Error(`the node's fee denom is ${a.denom}, not ${denom}`);
    return {
      ...a,
      accountNumber: a.accountNumber == null ? null : BigInt(a.accountNumber),
      sequence: a.sequence == null ? null : BigInt(a.sequence),
    };
  }

  const gasPrice = async () => bumpGasPrice(BigInt(await rpcCall('eth_gasPrice', [])));
  const balance = async (hex) => BigInt(await rpcCall('eth_getBalance', [hex, 'latest']));

  /** Everything needed to show the fee before signing. */
  async function quote({ publicKey, gasLimit = DEFAULT_GAS_LIMIT }) {
    const me = pqAddress(publicKey, prefix);
    const [acct, price, bal] = await Promise.all([account(me.bech32), gasPrice(), balance(me.hex)]);
    if (acct.address && acct.address !== me.bech32) throw new Error(`the node answered for ${acct.address}, not ${me.bech32}`);
    const gas = BigInt(gasLimit);
    return { address: me, account: acct, exists: acct.exists, balance: bal, gasLimit: gas, gasPrice: price, fee: gas * price };
  }

  /**
   * Sign and broadcast any messages from this account. value: azetaphy the messages
   * take from the account besides the fee (default: the sum of each message's `spend`).
   * preflight(quote) runs after the checks and before signing; it may throw to stop.
   * The signer is sign(bytes) (the key is here) or signTx(request) (an external signer that
   * builds the tx from the messages' intents, see buildTxWith); every method below takes either.
   */
  async function sendMsgs({ publicKey, sign, signTx, messages, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '', value, preflight }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('at least one message is required');
    const spend = value != null ? BigInt(value) : messages.reduce((n, m) => n + BigInt(m.spend ?? 0n), 0n);
    if (spend < 0n) throw new Error('value must not be negative');
    uint64(gasLimit, 'gasLimit');
    const q = await quote({ publicKey, gasLimit });
    if (!q.exists) throw new Error(`account ${q.address.bech32} does not exist on chain yet: send ZETAPHY to this address first`);
    const usePrice = price == null ? q.gasPrice : BigInt(price);
    const fee = q.gasLimit * usePrice;
    if (spend + fee > q.balance) throw new Error(`not enough ZETAPHY: need ${formatZeta(spend + fee)} (${spend ? 'amount + fee' : 'fee'}), have ${formatZeta(q.balance)}`);
    const checked = preflight ? await preflight(q) : undefined;
    const params = { publicKey, messages, denom, chainId, accountNumber: q.account.accountNumber,
      sequence: q.account.sequence, gasLimit: q.gasLimit, gasPrice: usePrice, memo };
    const tx = signTx ? await buildTxWith({ ...params, signTx }) : buildTx({ ...params, sign });
    const r = await rpcCall('zetaphy_sendCosmosTx', [tx.txHex]);
    if (!r || typeof r.code !== 'number') throw new Error('the node did not answer zetaphy_sendCosmosTx');
    if (r.code !== 0) throw new Error(`the node rejected the transaction (code ${r.code}): ${r.log || 'no log'}`);
    return { txHash: r.txHash || tx.txHash, from: q.address, value: spend, fee, gasLimit: q.gasLimit, gasPrice: usePrice, sequence: q.account.sequence, checked };
  }

  /**
   * Checks that `owner` is quantum-locked to `me` (both 0x… or zetaphy1…); returns
   * the owner's account (with its balance). Throws a clear error otherwise.
   */
  async function ownedBy(owner, me) {
    const o = normalizeAddress(owner, prefix); const m = normalizeAddress(me, prefix);
    const [acct, bal] = await Promise.all([account(o.bech32), balance(o.hex)]);
    if (acct.quantumLockedTo !== m.bech32) {
      throw new Error(acct.quantumLockedTo
        ? `${o.bech32} is quantum-locked to ${acct.quantumLockedTo}, not to ${m.bech32}`
        : `${o.bech32} is not quantum-locked to ${m.bech32}, so it cannot act for it`);
    }
    return { ...acct, address: o, balance: bal };
  }

  /**
   * What the chain asks of a quantum-lock controller: an ML-DSA-44 account that has
   * already sent a tx (its public key is on chain), is not locked itself, and is not
   * the owner. Returns the controller's account; throws a clear error otherwise.
   */
  async function checkController(controller, owner) {
    const c = normalizeAddress(controller, prefix);
    if (owner != null && normalizeAddress(owner, prefix).bech32 === c.bech32) throw new Error('the controller must be another account than the owner');
    const a = await account(c.bech32);
    if (!a.exists || a.pubKeyType == null) throw new Error(`the controller ${c.bech32} has no ML-DSA-44 public key on chain: it must be an ML-DSA-44 account that has already sent a transaction`);
    if (a.pubKeyType !== MLDSA_PUBKEY_TYPE) throw new Error(`the controller ${c.bech32} is not an ML-DSA-44 account (its key is ${a.pubKeyType})`);
    if (a.quantumLockedTo) throw new Error(`the controller ${c.bech32} is itself quantum-locked (to ${a.quantumLockedTo})`);
    return { ...a, address: c };
  }

  async function send({ publicKey, sign, signTx, to, amount, gasLimit, gasPrice: price, memo = '', asOwner, evmGasLimit = DEFAULT_EVM_GAS_LIMIT, check = true }) {
    const toAddr = normalizeAddress(to, prefix);
    const value = positive(amount, 'amount');
    const me = pqAddress(publicKey, prefix);
    if (asOwner) {
      // A locked account sends with an EVM call carrying the value (msg.sender = the owner).
      const r = await callEVM({ publicKey, sign, signTx, to: toAddr.hex, value, evmGasLimit, gasLimit, gasPrice: price, memo, asOwner, check });
      return { txHash: r.txHash, from: r.from, asOwner: r.asOwner, to: toAddr, amount: value, fee: r.fee, gasLimit: r.gasLimit, gasPrice: r.gasPrice, sequence: r.sequence };
    }
    const r = await sendMsgs({ publicKey, sign, signTx, messages: [msgSend({ from: me.bech32, to: toAddr.bech32, amount: value, denom, prefix })], gasLimit: gasLimit ?? DEFAULT_GAS_LIMIT, gasPrice: price, memo });
    return { txHash: r.txHash, from: r.from, to: toAddr, amount: value, fee: r.fee, gasLimit: r.gasLimit, gasPrice: r.gasPrice, sequence: r.sequence };
  }

  /** The eth_call checks before an EVM message is signed (as the owner, with asOwner). */
  function evmPreflight({ me, m, call, check, checkResult }) {
    if (!check) return undefined;
    return async () => {
      let owner;
      if (m.asOwner) {
        owner = await ownedBy(m.asOwner, me.bech32);
        if (m.ownerSpend > owner.balance) throw new Error(`${owner.address.bech32} does not have enough ZETAPHY: it needs ${formatZeta(m.ownerSpend)}, it has ${formatZeta(owner.balance)}`);
      }
      let ret;
      try {
        ret = await rpcCall('eth_call', [{ from: owner ? owner.address.hex : me.hex, ...call }, 'latest']);
      } catch (e) {
        throw new Error(`the call would fail, so nothing was sent: ${e.shortMessage ?? e.message}`);
      }
      if (checkResult) checkResult(ret);
      return { ret, owner };
    };
  }

  const txGasFor = (evmGas, gasLimit) => {
    const txGas = gasLimit == null ? evmGas + EVM_CALL_GAS_OVERHEAD : BigInt(gasLimit);
    if (txGas <= evmGas) throw new Error('the tx gas limit must be more than the EVM gas limit (the chain charges the EVM gas on the tx)');
    return txGas;
  };

  /**
   * Call an EVM contract (or pay a plain address) as this account, or with asOwner as a
   * quantum-locked account this one controls. The call is first run with eth_call from
   * that account, so a call that would revert is refused before anything is signed;
   * checkResult(returnHex) may refuse too. Tx gas defaults to evmGasLimit + EVM_CALL_GAS_OVERHEAD.
   */
  async function callEVM({ publicKey, sign, signTx, to, data = '0x', value = 0n, evmGasLimit = DEFAULT_EVM_GAS_LIMIT, gasLimit,
    gasPrice: price, memo = '', check = true, checkResult, asOwner }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgEVMCall({ sender: me.bech32, to, value, data, gasLimit: evmGasLimit, asOwner, prefix });
    const evmGas = BigInt(evmGasLimit);
    const txGas = txGasFor(evmGas, gasLimit);
    const toHex = toChecksumHex(addressBytes(to, prefix));
    const dataHex = '0x' + bytesToHex(asBytes(data, 'data'));
    const call = { to: toHex, data: dataHex, gas: qty(evmGas) };
    if (BigInt(value) > 0n) call.value = qty(value);
    const r = await sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit: txGas, gasPrice: price, memo, preflight: evmPreflight({ me, m, call, check, checkResult }) });
    return { ...r, to: toHex, data: dataHex, evmGasLimit: evmGas, result: r.checked?.ret, asOwner: m.asOwner ? normalizeAddress(m.asOwner, prefix) : undefined };
  }

  /**
   * Create a contract (initCode: its creation bytecode with any constructor arguments)
   * as this account, or with asOwner as an account it controls. The init code is first
   * run with eth_call. `created` is the new contract's address, CREATE(account, nonce):
   *   - as this account: nonce = the signed sequence + 1 (the ante handler has already
   *     moved the sequence past the signed one); the creation consumes that nonce too, so
   *     the account's sequence ends at signed + 2
   *   - with asOwner: nonce = the owner's sequence (it signs nothing); it ends one higher
   * The next tx is signed with the sequence zetaphy_pqAccount reports (sendMsgs reads it
   * every time), never one counted up here.
   */
  async function deploy({ publicKey, sign, signTx, initCode, value = 0n, evmGasLimit = DEFAULT_DEPLOY_GAS_LIMIT, gasLimit,
    gasPrice: price, memo = '', check = true, asOwner }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgEVMDeploy({ sender: me.bech32, initCode, value, gasLimit: evmGasLimit, asOwner, prefix });
    const evmGas = BigInt(evmGasLimit);
    const txGas = txGasFor(evmGas, gasLimit);
    const call = { data: '0x' + bytesToHex(asBytes(initCode, 'initCode')), gas: qty(evmGas) };
    if (BigInt(value) > 0n) call.value = qty(value);
    const pre = evmPreflight({ me, m, call, check });
    // The owner's nonce is read just before signing, whether or not the call is checked.
    const preflight = async (q) => {
      const p = pre ? await pre(q) : {};
      return { ...p, ownerAcct: m.asOwner ? p.owner ?? await account(m.asOwner) : undefined };
    };
    const r = await sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit: txGas, gasPrice: price, memo, preflight });
    const owner = m.asOwner ? normalizeAddress(m.asOwner, prefix) : undefined;
    const created = owner ? createAddress(owner.hex, r.checked.ownerAcct.sequence ?? 0n, prefix) : createAddress(me.hex, r.sequence + 1n, prefix);
    return { ...r, created, evmGasLimit: evmGas, asOwner: owner };
  }

  /**
   * MsgQuantumLock signed by this account, the current controller of `owner`: hands control
   * of it to `controller` (another ML-DSA-44 account that has sent a tx). Checked first.
   */
  async function quantumLockHandover({ publicKey, sign, signTx, owner, controller, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '', check = true }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgQuantumLock({ signer: me.bech32, owner, controller, prefix });
    const preflight = check ? async () => { await ownedBy(owner, me.bech32); await checkController(controller, owner); } : undefined;
    const r = await sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit, gasPrice: price, memo, preflight });
    return { ...r, owner: normalizeAddress(owner, prefix), controller: normalizeAddress(controller, prefix) };
  }

  /**
   * delegate / undelegate / withdrawRewards. Without asOwner: the Cosmos message, tx gas
   * gasLimit (default 500000). With asOwner: the staking or distribution precompile, called
   * as the owner (MsgEVMCall.as_owner), EVM gas evmGasLimit (default 300000).
   */
  const staking = (build, action) => async ({ publicKey, sign, signTx, validator, amount, gasLimit, gasPrice: price, memo = '', asOwner, evmGasLimit = DEFAULT_PRECOMPILE_GAS_LIMIT, check = true }) => {
    const me = pqAddress(publicKey, prefix);
    const val = validatorAddress(validator, prefix + 'valoper');
    const amt = amount == null ? undefined : BigInt(amount);
    if (asOwner) {
      const owner = normalizeAddress(asOwner, prefix);
      const c = stakingCall({ action, delegator: owner.hex, validator: val, amount: amt, prefix });
      const m = msgEVMCall({ sender: me.bech32, to: c.to, data: c.data, gasLimit: evmGasLimit, asOwner: owner.bech32, prefix });
      // A delegation takes ZETAPHY from the owner (the EVM value stays 0).
      if (action === 'delegate') m.ownerSpend = amt;
      const evmGas = BigInt(evmGasLimit);
      const preflight = evmPreflight({ me, m, call: { to: c.to, data: '0x' + bytesToHex(c.data), gas: qty(evmGas) }, check });
      const r = await sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit: txGasFor(evmGas, gasLimit), gasPrice: price, memo, preflight });
      return { ...r, validator: val, amount: amt, asOwner: owner, evmGasLimit: evmGas };
    }
    const m = build({ delegator: me.bech32, validator: val, amount, denom, prefix });
    const r = await sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit: gasLimit ?? DEFAULT_STAKING_GAS_LIMIT, gasPrice: price, memo });
    return { ...r, validator: val, amount: amt };
  };

  // ---- security core ----
  const securityStatus = () => rpcCall('zetaphy_securityStatus', []);
  const migration = (addr) => rpcCall('zetaphy_migration', [normalizeAddress(addr, prefix).hex]);
  const commitmentHeight = async (c) => rpcCall('zetaphy_qdayCommitment', ['0x' + bytesToHex(bytes32(c, 'commitment'))]);
  const consentUntil = async (account, target) => BigInt((await rpcCall('zetaphy_consent', [normalizeAddress(account, prefix).hex, toChecksumHex(addressBytes(target, prefix))])).until);
  const ibcHolds = () => rpcCall('zetaphy_ibcHolds', []);

  /** Step 1 of the Q-day migration, signed by this (controller) account. */
  async function qdayCommit({ publicKey, sign, signTx, commitment, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '' }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgQDayCommit({ signer: me.bech32, commitment, prefix });
    const preflight = async () => { if ((await commitmentHeight(commitment)).found) throw new Error('this commitment is already recorded'); };
    return sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit, gasPrice: price, memo, preflight });
  }

  /** Step 2: the reveal (owner's signature and salt), at least the reveal delay after the commit. */
  async function qdayReveal({ publicKey, sign, signTx, owner, controller, salt, signature, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '' }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgQDayReveal({ signer: me.bech32, owner, controller: controller ?? me.bech32, salt, signature, prefix });
    return sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit, gasPrice: price, memo });
  }

  /** consent(target, seconds) from this account (or asOwner), through the security precompile. */
  async function consent({ publicKey, sign, signTx, target, seconds, asOwner, gasPrice: price, memo = '' }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgConsent({ sender: me.bech32, target, seconds, asOwner, prefix });
    return sendMsgs({ publicKey, sign, signTx, messages: [m], gasLimit: DEFAULT_EVM_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD, gasPrice: price, memo });
  }

  /** The guardian returns held IBC transfer `id` to its sender. */
  async function ibcHoldCancel({ publicKey, sign, signTx, id, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '' }) {
    const me = pqAddress(publicKey, prefix);
    return sendMsgs({ publicKey, sign, signTx, messages: [msgIBCHoldCancel({ signer: me.bech32, id, prefix })], gasLimit, gasPrice: price, memo });
  }

  return {
    securityStatus, migration, commitmentHeight, consentUntil, ibcHolds, qdayCommit, qdayReveal, consent, ibcHoldCancel,
    account, gasPrice, balance, quote, sendMsgs, send, callEVM, deploy, quantumLockHandover, ownedBy, checkController,
    delegate: staking(msgDelegate, 'delegate'),
    undelegate: staking(msgUndelegate, 'undelegate'),
    withdrawRewards: staking(msgWithdrawRewards, 'withdrawRewards'),
  };
}
