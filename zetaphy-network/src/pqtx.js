// Native post-quantum accounts on ZETAPHY: Cosmos SDK transactions signed
// with ML-DSA-44 only (no ECDSA key anywhere). Pure ESM with no Node-only
// imports, so the same file runs in the CLI and in the web wallet.
//
// Chain side (zetaphy-chain):
//   pubkey Any  /zetaphy.crypto.mldsa44.PubKey { bytes key = 1 }  (1312 bytes)
//   address     sha256(publicKey)[0:20]  (same 20 bytes as the 0x address)
//   signature   ml_dsa44.sign(SignDoc bytes, secretKey), SIGN_MODE_DIRECT
//   JSON-RPC    zetaphy_pqAccount(address), zetaphy_sendCosmosTx(0x + TxRaw hex)

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const CHAIN_ID = 'zetaphy-testnet-1';
export const DENOM = 'azetaphy';
export const PREFIX = 'zetaphy';
export const PUBKEY_TYPE_URL = '/zetaphy.crypto.mldsa44.PubKey';
export const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';
export const SIGN_MODE_DIRECT = 1;
export const DEFAULT_GAS_LIMIT = 400000n;
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

/** The account of an ML-DSA-44 public key: sha256(pk)[0:20]. */
export function pqAddress(publicKey, prefix = PREFIX) {
  const pk = asBytes(publicKey, 'publicKey');
  if (pk.length !== PUBLIC_KEY_BYTES) throw new Error(`ML-DSA-44 public key must be ${PUBLIC_KEY_BYTES} bytes`);
  const bytes = sha256(pk).slice(0, 20);
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

// ---- build and sign ----

/**
 * One bank send from an ML-DSA-44 account, signed with SIGN_MODE_DIRECT.
 * sign(bytes) must return the raw 2420-byte ML-DSA-44 signature of bytes.
 */
export function buildSendTx({ publicKey, sign, from, to, amount, denom = DENOM, chainId = CHAIN_ID,
  accountNumber, sequence, gasLimit = DEFAULT_GAS_LIMIT, gasPrice, memo = '', prefix = PREFIX }) {
  const pk = asBytes(publicKey, 'publicKey');
  const me = pqAddress(pk, prefix);
  if (from != null && toBech32(addressBytes(from, prefix), prefix) !== me.bech32) throw new Error('from does not match the public key');
  const toAddr = toBech32(addressBytes(to, prefix), prefix);
  const value = BigInt(amount);
  if (value <= 0n) throw new Error('amount must be more than 0');
  if (accountNumber == null || sequence == null) throw new Error('accountNumber and sequence are required');
  if (gasPrice == null) throw new Error('gasPrice is required');
  const gas = BigInt(gasLimit);
  if (gas <= 0n) throw new Error('gasLimit must be more than 0');
  if (typeof sign !== 'function') throw new Error('sign must be a function');

  const bodyBytes = encodeTxBody({
    messages: [{ typeUrl: MSG_SEND_TYPE_URL, value: encodeMsgSend({ fromAddress: me.bech32, toAddress: toAddr, amount: [{ denom, amount: value.toString() }] }) }],
    memo,
  });
  const fee = { amount: [{ denom, amount: (gas * BigInt(gasPrice)).toString() }], gasLimit: gas };
  const authInfoBytes = encodeAuthInfo({ signerInfos: [{ publicKey: pk, mode: SIGN_MODE_DIRECT, sequence: BigInt(sequence) }], fee });
  const signDocBytes = encodeSignDoc({ bodyBytes, authInfoBytes, chainId, accountNumber: BigInt(accountNumber) });
  const signature = asBytes(sign(signDocBytes), 'signature');
  if (signature.length !== SIGNATURE_BYTES) throw new Error(`ML-DSA-44 signature must be ${SIGNATURE_BYTES} bytes`);
  const txBytes = encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [signature] });
  return { txBytes, txHex: '0x' + bytesToHex(txBytes), signDocBytes, bodyBytes, authInfoBytes, fee: BigInt(fee.amount[0].amount), txHash: txHashOf(txBytes) };
}

// ---- client over the node's JSON-RPC (rpcCall is ethers' provider.send or a fetch wrapper) ----

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

  async function send({ publicKey, sign, to, amount, gasLimit = DEFAULT_GAS_LIMIT, gasPrice: price, memo = '' }) {
    const toAddr = normalizeAddress(to, prefix);
    if (BigInt(amount) <= 0n) throw new Error('amount must be more than 0');
    const q = await quote({ publicKey, gasLimit });
    if (!q.exists) throw new Error(`account ${q.address.bech32} does not exist on chain yet: send ZETAPHY to this address first`);
    const usePrice = price == null ? q.gasPrice : BigInt(price);
    const fee = q.gasLimit * usePrice;
    const value = BigInt(amount);
    if (value + fee > q.balance) throw new Error(`not enough ZETAPHY: need ${formatZeta(value + fee)} (amount + fee), have ${formatZeta(q.balance)}`);
    const tx = buildSendTx({ publicKey, sign, to, amount: value, denom, chainId, accountNumber: q.account.accountNumber,
      sequence: q.account.sequence, gasLimit: q.gasLimit, gasPrice: usePrice, memo, prefix });
    const r = await rpcCall('zetaphy_sendCosmosTx', [tx.txHex]);
    if (!r || typeof r.code !== 'number') throw new Error('the node did not answer zetaphy_sendCosmosTx');
    if (r.code !== 0) throw new Error(`the node rejected the transaction (code ${r.code}): ${r.log || 'no log'}`);
    return { txHash: r.txHash || tx.txHash, from: q.address, to: toAddr, amount: value, fee, gasLimit: q.gasLimit, gasPrice: usePrice, sequence: q.account.sequence };
  }

  return { account, gasPrice, balance, quote, send };
}
