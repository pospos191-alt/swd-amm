// Offline trading, the logic without a page (offline.js draws it; test/offline.test.mjs checks it against ethers):
//   1. cheques (zetaphy-network/contracts/ZetaphyCheques.sol): a payment channel's dedicated offline key signs
//      EIP-712 Cheque{channelId, cumulativeAmount}; the payee checks it with no network against the channel as it
//      last saw it on chain (signer, deposit, expiry), keeps the best one and cashes it once online;
//   2. swap orders (ZetaphyOfflineOrders.sol): an EIP-712 Order signed offline, carried as a QR code or text,
//      filled by anyone online (the relayer earns the fee the maker set).
// Also: the payloads (QR / text), the calldata, and the offline key kept encrypted (WebCrypto AES-GCM, key from
// PBKDF2-SHA256 of a passphrase). No dependencies: keccak-256 and secp256k1 are passed in (in the browser
// neuro/src/keccak.js and the wallet's vendor/pqwallet.js, already on this site). No network.

export const CHAIN_ID = 77390;
export const CHEQUE_DOMAIN = 'ZETAPHY Cheques';
export const ORDER_DOMAIN = 'ZETAPHY Offline Orders';
export const DOMAIN_VERSION = '1';
export const CHALLENGE_SECONDS = 24 * 3600;
export const CHEQUE_PREFIX = 'ZCHQ1:';
export const ORDER_PREFIX = 'ZORD1:';
export const KDF_ITERATIONS = 600_000;
export const MIN_KDF_ITERATIONS = 310_000;
export const MAX_PAYLOAD = 2000;
export const NATIVE = `0x${'0'.repeat(40)}`;
const HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
const U256 = 2n ** 256n;

/** keccak256 of each signature, first 4 bytes (checked against ethers in test/offline.test.mjs). */
export const SEL = {
  open: '0x069468b2', topUp: '0xde643a71', extend: '0xe3f08c1d', startClose: '0xd7937fce', withdraw: '0x2e1a7d4d', cash: '0x32d7a589',
  release: '0x37bdc99b', channels: '0xe5949b5d', channelCount: '0xacf8bf2a', cashable: '0x59473318',
  fill: '0x7e9c8d43', cancel: '0x40e58ee5', isNonceUsed: '0xcab7e8eb', router: '0xf887ea40',
  approve: '0x095ea7b3', allowance: '0xdd62ed3e', balanceOf: '0x70a08231', decimals: '0x313ce567', symbol: '0x95d89b41',
  WETH: '0xad5c4648', getAmountsOut: '0xd06ca61f',
};

export const CHEQUE_FIELDS = [{ name: 'channelId', type: 'uint256' }, { name: 'cumulativeAmount', type: 'uint256' }];
export const ORDER_FIELDS = [
  { name: 'maker', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'relayerFee', type: 'uint256' },
];
const DOMAIN_FIELDS = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

// ---------------------------------------------------------------- bytes and words

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (a) => ADDR.test(String(a ?? ''));
export const hexToBytes = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('hex');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const bytesToHex = (b) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const uintWord = (n) => { const v = BigInt(n); if (v < 0n || v >= U256) throw new Error('uint'); return v.toString(16).padStart(64, '0'); };
const addrWord = (a) => { if (!isAddr(a)) throw new Error('address'); return a.slice(2).toLowerCase().padStart(64, '0'); };
const utf8 = (s) => new TextEncoder().encode(s);
const kHex = (keccak, bytes) => bytesToHex(keccak(bytes));
export const lc = (a) => String(a).toLowerCase();

// ---------------------------------------------------------------- EIP-712

const typeString = (name, fields) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
export const CHEQUE_TYPE = typeString('Cheque', CHEQUE_FIELDS);
export const ORDER_TYPE = typeString('Order', ORDER_FIELDS);

export function domainSeparator(keccak, name, chainId, contract) {
  const enc = typeString('EIP712Domain', DOMAIN_FIELDS);
  return keccak(hexToBytes(kHex(keccak, utf8(enc)).slice(2) + kHex(keccak, utf8(name)).slice(2) + kHex(keccak, utf8(DOMAIN_VERSION)).slice(2) + uintWord(chainId) + addrWord(contract)));
}
const digestOf = (keccak, sep, structHash) => keccak(concat(Uint8Array.of(0x19, 0x01), sep, structHash));

/** EIP-712 digest of a cheque (what ZetaphyCheques.chequeDigest returns). */
export function chequeDigest(keccak, { contract, chainId = CHAIN_ID, channelId, cumulative }) {
  const sh = keccak(hexToBytes(kHex(keccak, utf8(CHEQUE_TYPE)).slice(2) + uintWord(channelId) + uintWord(cumulative)));
  return digestOf(keccak, domainSeparator(keccak, CHEQUE_DOMAIN, chainId, contract), sh);
}
/** EIP-712 struct hash of an order (ZetaphyOfflineOrders.orderHash). */
export function orderHash(keccak, o) {
  const w = ORDER_FIELDS.map(({ name, type }) => (type === 'address' ? addrWord(o[name]) : uintWord(o[name]))).join('');
  return keccak(hexToBytes(kHex(keccak, utf8(ORDER_TYPE)).slice(2) + w));
}
export function orderDigest(keccak, { contract, chainId = CHAIN_ID, order }) {
  return digestOf(keccak, domainSeparator(keccak, ORDER_DOMAIN, chainId, contract), orderHash(keccak, order));
}

/** eth_signTypedData_v4 payloads (numbers as decimal strings), for a wallet that signs typed data. */
export function chequeTypedData({ contract, chainId = CHAIN_ID, channelId, cumulative }) {
  return { types: { EIP712Domain: DOMAIN_FIELDS, Cheque: CHEQUE_FIELDS }, primaryType: 'Cheque',
    domain: { name: CHEQUE_DOMAIN, version: DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: contract },
    message: { channelId: String(channelId), cumulativeAmount: String(cumulative) } };
}
export function orderTypedData({ contract, chainId = CHAIN_ID, order }) {
  return { types: { EIP712Domain: DOMAIN_FIELDS, Order: ORDER_FIELDS }, primaryType: 'Order',
    domain: { name: ORDER_DOMAIN, version: DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: contract },
    message: Object.fromEntries(ORDER_FIELDS.map(({ name, type }) => [name, type === 'address' ? order[name] : String(order[name])])) };
}

// ---------------------------------------------------------------- secp256k1 (the curve object of @noble/curves 2.x)

/** A new random key (32 bytes) and its address. */
export function newKey(secp, keccak) {
  const sk = secp.utils.randomSecretKey();
  return { sk, address: addressOf(secp, keccak, sk) };
}
export function addressOfPublic(keccak, pub65) { return `0x${bytesToHex(keccak(pub65.subarray(1))).slice(26)}`; }
export function addressOf(secp, keccak, sk) { return addressOfPublic(keccak, secp.getPublicKey(sk, false)); }

/** 65-byte r‖s‖v (v 27/28, low s) over a 32-byte digest, as the contracts' ecrecover wants. */
export function signDigest(secp, digest, sk) {
  const rec = secp.sign(digest, sk, { prehash: false, format: 'recovered' }); // recovery ‖ r ‖ s
  return bytesToHex(concat(rec.subarray(1, 65), Uint8Array.of(27 + rec[0])));
}

/** The address that signed `digest` (lower case), or null for a malformed, high-s or bad-v signature (as the contracts refuse). */
export function recoverSigner(secp, keccak, digest, sigHex) {
  try {
    const sig = hexToBytes(sigHex);
    if (sig.length !== 65) return null;
    let v = sig[64];
    if (v < 27) v += 27;
    if (v !== 27 && v !== 28) return null;
    if (BigInt(bytesToHex(sig.subarray(32, 64))) > HALF_N) return null;
    const pub = secp.recoverPublicKey(concat(Uint8Array.of(v - 27), sig.subarray(0, 64)), digest, { prehash: false });
    return addressOfPublic(keccak, secp.Point.fromBytes(pub).toBytes(false));
  } catch { return null; }
}

// ---------------------------------------------------------------- payloads (QR code or text)

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const UINT = /^\d{1,78}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const fmt = () => new Error('format');
function body(text, prefix) {
  const t = String(text ?? '').trim();
  if (t.length > MAX_PAYLOAD || !t.startsWith(prefix)) throw fmt();
  const raw = t.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw fmt();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64u(raw))); } catch { throw fmt(); }
}
const checkUint = (v) => { if (typeof v !== 'string' || !UINT.test(v) || BigInt(v) >= U256) throw fmt(); return v; };
const checkAddr = (v) => { if (!isAddr(v)) throw fmt(); return lc(v); };

export function encodeCheque({ chainId = CHAIN_ID, contract, channelId, cumulative, sig }) {
  return CHEQUE_PREFIX + b64u(utf8(JSON.stringify({ c: Number(chainId), k: lc(contract), i: String(channelId), a: String(cumulative), s: lc(sig) })));
}
/** Text -> { chainId, contract, channelId, cumulative, sig } (strings for numbers); throws Error('format'). */
export function decodeCheque(text) {
  const j = body(text, CHEQUE_PREFIX);
  if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.c) || j.c <= 0 || !SIG.test(String(j.s))) throw fmt();
  return { chainId: j.c, contract: checkAddr(j.k), channelId: checkUint(j.i), cumulative: checkUint(j.a), sig: lc(j.s) };
}

export function encodeOrder({ chainId = CHAIN_ID, contract, order, sig }) {
  const o = Object.fromEntries(ORDER_FIELDS.map(({ name, type }) => [name, type === 'address' ? lc(order[name]) : String(order[name])]));
  return ORDER_PREFIX + b64u(utf8(JSON.stringify({ c: Number(chainId), k: lc(contract), o, s: lc(sig) })));
}
/** Text -> { chainId, contract, order, sig }; throws Error('format'). */
export function decodeOrder(text) {
  const j = body(text, ORDER_PREFIX);
  if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.c) || j.c <= 0 || !SIG.test(String(j.s)) || !j.o || typeof j.o !== 'object') throw fmt();
  const order = Object.fromEntries(ORDER_FIELDS.map(({ name, type }) => [name, type === 'address' ? checkAddr(j.o[name]) : checkUint(j.o[name])]));
  return { chainId: j.c, contract: checkAddr(j.k), order, sig: lc(j.s) };
}
/** Which kind a scanned / pasted text is: 'cheque', 'order' or null. */
export const payloadKind = (text) => { const t = String(text ?? '').trim(); return t.startsWith(CHEQUE_PREFIX) ? 'cheque' : t.startsWith(ORDER_PREFIX) ? 'order' : null; };

// ---------------------------------------------------------------- checks with no network

/**
 * Checks a cheque the payee was handed, offline, against what it knows:
 *   snapshot  the channel as last read on chain ({ payer, payee, token, signer, deposit, paid, expiry, closeAt, done, syncedAt }), or null
 *   lastSeen  the best cumulative amount this device already holds for the channel (0n if none)
 *   me        the payee's own address, if known
 * Returns { ok, problems: [{ code, level: 'bad'|'warn' }], newAmount, covered, expiresIn, asOf, signer }.
 * ok means: the channel's signer signed it, it is newer than anything held, the channel was open when last
 * synced and some of it is covered by the deposit as last synced. newAmount is what it adds over lastSeen and
 * over what was already paid out; covered is the part of that the synced deposit backs.
 */
export function verifyCheque(cheque, { snapshot, lastSeen = 0n, me = null, now = Math.floor(Date.now() / 1000), keccak, secp, contract, chainId = CHAIN_ID }) {
  const problems = [];
  const bad = (code) => problems.push({ code, level: 'bad' });
  const warn = (code) => problems.push({ code, level: 'warn' });
  if (Number(cheque.chainId) !== Number(chainId)) bad('wrongChain');
  if (contract && lc(cheque.contract) !== lc(contract)) bad('wrongContract');
  const cum = BigInt(cheque.cumulative);
  const signer = recoverSigner(secp, keccak, chequeDigest(keccak, { contract: cheque.contract, chainId: cheque.chainId, channelId: cheque.channelId, cumulative: cum }), cheque.sig);
  const out = { ok: false, problems, newAmount: 0n, covered: 0n, expiresIn: null, asOf: snapshot?.syncedAt ?? null, signer };
  if (!signer) bad('badSignature');
  if (!snapshot) { bad('unknownChannel'); return out; }
  if (signer && lc(signer) !== lc(snapshot.signer)) bad('wrongSigner');
  if (snapshot.done || Number(snapshot.closeAt) !== 0) bad('closing');
  if (me && lc(me) !== lc(snapshot.payee)) warn('notYourChannel');
  const deposit = BigInt(snapshot.deposit), paid = BigInt(snapshot.paid ?? 0), seen = BigInt(lastSeen ?? 0);
  const floor = seen > paid ? seen : paid;
  if (cum <= seen) bad('notNewer');
  out.newAmount = cum > floor ? cum - floor : 0n;
  const top = cum < deposit ? cum : deposit;
  out.covered = top > floor ? top - floor : 0n;
  if (cum > deposit) { if (out.covered === 0n) bad('nothingCovered'); else warn('overDeposit'); }
  out.expiresIn = Number(snapshot.expiry) - now;
  if (out.expiresIn <= 0) warn('expired'); else if (out.expiresIn < 3600) warn('expiresSoon');
  if (snapshot.syncedAt && now - Number(snapshot.syncedAt) > 24 * 3600) warn('staleSync');
  out.ok = !problems.some((p) => p.level === 'bad') && out.covered > 0n;
  return out;
}

/** The latest moment the payee can cash (worst case: the payer starts closing right at expiry). */
export const cashBy = (snapshot) => Number(snapshot.expiry) + CHALLENGE_SECONDS;

/** Checks an order offline: format, chain, contract, maker's signature, deadline, amounts. Same shape as verifyCheque. */
export function verifyOrder(p, { keccak, secp, now = Math.floor(Date.now() / 1000), contract, chainId = CHAIN_ID }) {
  const problems = [];
  const bad = (code) => problems.push({ code, level: 'bad' });
  const o = p.order;
  if (Number(p.chainId) !== Number(chainId)) bad('wrongChain');
  if (contract && lc(p.contract) !== lc(contract)) bad('wrongContract');
  const signer = recoverSigner(secp, keccak, orderDigest(keccak, { contract: p.contract, chainId: p.chainId, order: o }), p.sig);
  if (!signer || lc(signer) !== lc(o.maker)) bad('badSignature');
  if (Number(o.deadline) < now) bad('expired');
  if (BigInt(o.amountIn) === 0n || lc(o.tokenIn) === NATIVE || lc(o.tokenIn) === lc(o.tokenOut)) bad('badOrder');
  return { ok: !problems.length, problems, signer, expiresIn: Number(o.deadline) - now };
}

/** A random 64-bit order nonce (decimal string). */
export function newNonce(cryptoObj = globalThis.crypto) {
  const b = new Uint8Array(8);
  cryptoObj.getRandomValues(b);
  return BigInt(bytesToHex(b)).toString();
}

// ---------------------------------------------------------------- calldata and answers

const w = uintWord, a = addrWord;
export const encodeOpen = (payee, token, amount, expiry, signer) => `${SEL.open}${a(payee)}${a(token)}${w(amount)}${w(expiry)}${a(signer)}`;
export const encodeTopUp = (id, amount) => `${SEL.topUp}${w(id)}${w(amount)}`;
export const encodeStartClose = (id) => `${SEL.startClose}${w(id)}`;
export const encodeWithdraw = (id) => `${SEL.withdraw}${w(id)}`;
export const encodeRelease = (id) => `${SEL.release}${w(id)}`;
export const encodeChannel = (id) => `${SEL.channels}${w(id)}`;
export const encodeCash = (id, cumulative, sig) => `${SEL.cash}${w(id)}${w(cumulative)}${w(96)}${w(65)}${String(sig).slice(2).toLowerCase().padEnd(192, '0')}`;
export const encodeApprove = (spender, amount) => `${SEL.approve}${a(spender)}${w(amount)}`;
export const encodeAllowance = (owner, spender) => `${SEL.allowance}${a(owner)}${a(spender)}`;
export const encodeBalanceOf = (who) => `${SEL.balanceOf}${a(who)}`;
export const encodeCancel = (nonce) => `${SEL.cancel}${w(nonce)}`;
export const encodeIsNonceUsed = (maker, nonce) => `${SEL.isNonceUsed}${a(maker)}${w(nonce)}`;
/** fill(order, sig, path): the order tuple is static (8 words), then the offsets of sig and path. */
export function encodeFill(order, sig, path = []) {
  const head = ORDER_FIELDS.map(({ name, type }) => (type === 'address' ? a(order[name]) : w(order[name]))).join('');
  const sigPart = w(65) + String(sig).slice(2).toLowerCase().padEnd(192, '0');
  const pathPart = w(path.length) + path.map(a).join('');
  const sigOff = 32 * 10;
  return `${SEL.fill}${head}${w(sigOff)}${w(sigOff + sigPart.length / 2)}${sigPart}${pathPart}`;
}
export function encodeAmountsOut(amountIn, path) {
  return `${SEL.getAmountsOut}${w(amountIn)}${w(64)}${w(path.length)}${path.map(a).join('')}`;
}

/** channels(id)'s answer -> the channel (null if there is none). */
export function decodeChannel(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length < 64 * 9) throw new Error('short answer');
  const word = (i) => h.slice(i * 64, (i + 1) * 64);
  const u = (i) => BigInt(`0x${word(i)}`);
  const ad = (i) => `0x${word(i).slice(24)}`;
  const c = { payer: ad(0), expiry: Number(u(1)), closeAt: Number(u(2)), payee: ad(3), token: ad(4), signer: ad(5), deposit: u(6).toString(), paid: u(7).toString(), done: u(8) !== 0n };
  return /^0x0{40}$/.test(c.payer) ? null : c;
}
/** topic0 of ChannelOpened(uint256 indexed id, address indexed payer, address indexed payee, address, uint256, uint64, address). */
export const CHANNEL_OPENED_TOPIC = '0xe915da4839c845597b7bda1b9795926b0019be091abc4ccf7d3e9182f856a3ed';
/** The channel id of the ChannelOpened log in a receipt (null if none). */
export function channelIdFromReceipt(receipt, contract, topic = CHANNEL_OPENED_TOPIC) {
  const l = (receipt?.logs ?? []).find((x) => lc(x.address) === lc(contract) && lc(x.topics?.[0]) === lc(topic));
  return l ? BigInt(l.topics[1]).toString() : null;
}

// ---------------------------------------------------------------- amounts

/** "1.5" with `dec` decimals -> base units; refuses junk, negatives and more decimals than the token has. */
export function parseAmount(text, dec = 18) {
  const t = String(text ?? '').trim();
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) throw new Error('decimals');
  const re = dec ? new RegExp(`^\\d{1,30}(\\.\\d{1,${dec}})?$`) : /^\d{1,40}$/;
  if (!re.test(t)) throw new Error('amount');
  const [i, f = ''] = t.split('.');
  return BigInt(i) * 10n ** BigInt(dec) + BigInt(f.padEnd(dec, '0') || '0');
}
export function formatAmount(v, dec = 18, dp = 6) {
  const x = BigInt(v), one = 10n ** BigInt(dec);
  const f = dec ? (x % one).toString().padStart(dec, '0').slice(0, dp).replace(/0+$/, '') : '';
  return `${(x / one).toLocaleString('en-US')}${f ? `.${f}` : ''}`;
}

// ---------------------------------------------------------------- the offline key, encrypted at rest

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aad = (address) => utf8(`zetaphy-offline-key-v1:${lc(address)}`);

async function aesKey(subtle, passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', utf8(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts a 32-byte key with a passphrase: { v, kdf, iter, salt, iv, ct, address } (base64), nothing in clear but the address. */
export async function encryptKey({ subtle = globalThis.crypto.subtle, random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) } = {}, sk, passphrase, address, iterations = KDF_ITERATIONS) {
  if (String(passphrase).length < 8) throw new Error('passphrase');
  if (iterations < MIN_KDF_ITERATIONS) throw new Error('iterations');
  const salt = random(16), iv = random(12);
  const key = await aesKey(subtle, passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(address) }, key, sk));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct), address: lc(address) };
}

/** The key back (Uint8Array(32)); throws Error('passphrase') on a wrong passphrase or a changed blob. */
export async function decryptKey({ subtle = globalThis.crypto.subtle } = {}, blob, passphrase) {
  if (!blob || blob.v !== 1 || blob.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(blob.iter) || blob.iter < MIN_KDF_ITERATIONS || blob.iter > 10_000_000 || !isAddr(blob.address)) throw new Error('blob');
  try {
    const key = await aesKey(subtle, passphrase, unb64(blob.salt), blob.iter);
    const sk = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: aad(blob.address) }, key, unb64(blob.ct)));
    if (sk.length !== 32) throw new Error('length');
    return sk;
  } catch { throw new Error('passphrase'); }
}
