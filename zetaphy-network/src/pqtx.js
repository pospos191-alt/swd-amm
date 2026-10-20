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
//                 the same 20 bytes); its EVM gas is charged on the Cosmos gas meter

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const CHAIN_ID = 'zetaphy-testnet-1';
export const DENOM = 'azetaphy';
export const PREFIX = 'zetaphy';
export const PUBKEY_TYPE_URL = '/zetaphy.crypto.mldsa44.PubKey';
export const VALOPER_PREFIX = 'zetaphyvaloper';
export const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';
export const MSG_DELEGATE_TYPE_URL = '/cosmos.staking.v1beta1.MsgDelegate';
export const MSG_UNDELEGATE_TYPE_URL = '/cosmos.staking.v1beta1.MsgUndelegate';
export const MSG_WITHDRAW_REWARD_TYPE_URL = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward';
export const MSG_EVM_CALL_TYPE_URL = '/zetaphy.pq.v1.MsgEVMCall';
export const SIGN_MODE_DIRECT = 1;
export const DEFAULT_GAS_LIMIT = 400000n;
/** Tx gas for one staking or rewards message (more state is touched than in a send). */
export const DEFAULT_STAKING_GAS_LIMIT = 500000n;
/** EVM gas for a MsgEVMCall when none is given. */
export const DEFAULT_EVM_GAS_LIMIT = 200000n;
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
 * bytes data = 4; uint64 gas_limit = 5; }  value is azetaphy in decimal, left out when 0.
 */
export const encodeMsgEVMCall = ({ sender, to, value = 0n, data = new Uint8Array(), gasLimit }) =>
  msg(pb.string(1, sender), pb.string(2, to), pb.string(3, BigInt(value) === 0n ? '' : BigInt(value).toString()),
    pb.bytes(4, data), pb.uint(5, gasLimit));

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

// ---- messages: { typeUrl, value (bytes), spend (azetaphy that leaves the account, besides the fee) } ----

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
  return { typeUrl: MSG_SEND_TYPE_URL, spend: value,
    value: encodeMsgSend({ fromAddress: accountBech32(from, prefix), toAddress: accountBech32(to, prefix), amount: [{ denom, amount: value.toString() }] }) };
}

export function msgDelegate({ delegator, validator, amount, denom = DENOM, prefix = PREFIX }) {
  const value = positive(amount, 'amount');
  return { typeUrl: MSG_DELEGATE_TYPE_URL, spend: value,
    value: encodeMsgDelegate({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: validatorAddress(validator, prefix + 'valoper'), amount: { denom, amount: value.toString() } }) };
}

export function msgUndelegate({ delegator, validator, amount, denom = DENOM, prefix = PREFIX }) {
  const value = positive(amount, 'amount');
  return { typeUrl: MSG_UNDELEGATE_TYPE_URL, spend: 0n,
    value: encodeMsgUndelegate({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: validatorAddress(validator, prefix + 'valoper'), amount: { denom, amount: value.toString() } }) };
}

export function msgWithdrawRewards({ delegator, validator, prefix = PREFIX }) {
  return { typeUrl: MSG_WITHDRAW_REWARD_TYPE_URL, spend: 0n,
    value: encodeMsgWithdrawDelegatorReward({ delegatorAddress: accountBech32(delegator, prefix), validatorAddress: validatorAddress(validator, prefix + 'valoper') }) };
}

/** An EVM call (never a contract creation: `to` is required). `to` is sent EIP-55 checksummed. */
export function msgEVMCall({ sender, to, value = 0n, data = new Uint8Array(), gasLimit = DEFAULT_EVM_GAS_LIMIT, prefix = PREFIX }) {
  if (to == null || String(to).trim() === '') throw new Error('an EVM call needs a "to" address (contract creation is not supported)');
  const toBytes = addressBytes(to, prefix);
  const v = BigInt(value);
  if (v < 0n) throw new Error('value must not be negative');
  const gas = BigInt(gasLimit);
  if (gas < MIN_EVM_GAS_LIMIT || gas > MAX_EVM_GAS_LIMIT) throw new Error(`EVM gas limit must be between ${MIN_EVM_GAS_LIMIT} and ${MAX_EVM_GAS_LIMIT}`);
  return { typeUrl: MSG_EVM_CALL_TYPE_URL, spend: v,
    value: encodeMsgEVMCall({ sender: accountBech32(sender, prefix), to: toChecksumHex(toBytes), value: v, data: asBytes(data, 'data'), gasLimit: gas }) };
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
   */
  async function sendMsgs({ publicKey, sign, messages, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '', value, preflight }) {
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
    const tx = buildTx({ publicKey, sign, messages, denom, chainId, accountNumber: q.account.accountNumber,
      sequence: q.account.sequence, gasLimit: q.gasLimit, gasPrice: usePrice, memo });
    const r = await rpcCall('zetaphy_sendCosmosTx', [tx.txHex]);
    if (!r || typeof r.code !== 'number') throw new Error('the node did not answer zetaphy_sendCosmosTx');
    if (r.code !== 0) throw new Error(`the node rejected the transaction (code ${r.code}): ${r.log || 'no log'}`);
    return { txHash: r.txHash || tx.txHash, from: q.address, value: spend, fee, gasLimit: q.gasLimit, gasPrice: usePrice, sequence: q.account.sequence, checked };
  }

  async function send({ publicKey, sign, to, amount, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '' }) {
    const toAddr = normalizeAddress(to, prefix);
    const value = positive(amount, 'amount');
    const me = pqAddress(publicKey, prefix);
    const r = await sendMsgs({ publicKey, sign, messages: [msgSend({ from: me.bech32, to: toAddr.bech32, amount: value, denom, prefix })], gasLimit, gasPrice: price, memo });
    return { txHash: r.txHash, from: r.from, to: toAddr, amount: value, fee: r.fee, gasLimit: r.gasLimit, gasPrice: r.gasPrice, sequence: r.sequence };
  }

  /**
   * Call an EVM contract (or pay a plain address) as this account. The call is
   * first run with eth_call from the account, so a call that would revert is
   * refused before anything is signed; checkResult(returnHex) may refuse too.
   * Tx gas defaults to evmGasLimit + EVM_CALL_GAS_OVERHEAD.
   */
  async function callEVM({ publicKey, sign, to, data = '0x', value = 0n, evmGasLimit = DEFAULT_EVM_GAS_LIMIT, gasLimit,
    gasPrice: price, memo = '', check = true, checkResult }) {
    const me = pqAddress(publicKey, prefix);
    const m = msgEVMCall({ sender: me.bech32, to, value, data, gasLimit: evmGasLimit, prefix });
    const evmGas = BigInt(evmGasLimit);
    const txGas = gasLimit == null ? evmGas + EVM_CALL_GAS_OVERHEAD : BigInt(gasLimit);
    if (txGas <= evmGas) throw new Error('the tx gas limit must be more than the EVM gas limit (the chain charges the EVM gas on the tx)');
    const toHex = toChecksumHex(addressBytes(to, prefix));
    const dataHex = '0x' + bytesToHex(asBytes(data, 'data'));
    const preflight = check ? async () => {
      let ret;
      try {
        const call = { from: me.hex, to: toHex, data: dataHex, gas: qty(evmGas) };
        if (BigInt(value) > 0n) call.value = qty(value);
        ret = await rpcCall('eth_call', [call, 'latest']);
      } catch (e) {
        throw new Error(`the call would fail, so nothing was sent: ${e.shortMessage ?? e.message}`);
      }
      if (checkResult) checkResult(ret);
      return ret;
    } : undefined;
    const r = await sendMsgs({ publicKey, sign, messages: [m], gasLimit: txGas, gasPrice: price, memo, preflight });
    return { ...r, to: toHex, data: dataHex, evmGasLimit: evmGas, result: r.checked };
  }

  const staking = (build, defaultGas) => async ({ publicKey, sign, validator, amount, gasLimit = defaultGas, gasPrice: price, memo = '' }) => {
    const me = pqAddress(publicKey, prefix);
    const m = build({ delegator: me.bech32, validator, amount, denom, prefix });
    const r = await sendMsgs({ publicKey, sign, messages: [m], gasLimit, gasPrice: price, memo });
    return { ...r, validator: validatorAddress(validator, prefix + 'valoper'), amount: amount == null ? undefined : BigInt(amount) };
  };

  return {
    account, gasPrice, balance, quote, sendMsgs, send, callEVM,
    delegate: staking(msgDelegate, DEFAULT_STAKING_GAS_LIMIT),
    undelegate: staking(msgUndelegate, DEFAULT_STAKING_GAS_LIMIT),
    withdrawRewards: staking(msgWithdrawRewards, DEFAULT_STAKING_GAS_LIMIT),
  };
}
