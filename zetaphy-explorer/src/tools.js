// Tools (#/tools), all in the browser:
//   1. decode a signed raw EVM tx (legacy / EIP-2930 / EIP-1559): fields, hash, the sender
//      recovered from the signature, and a dry run with eth_call (nothing is sent);
//   2. check a personal_sign (EIP-191) signature, and an ML-DSA-44 signature (the same
//      @noble/post-quantum verifier the block certificates use);
//   3. convert units (azetaphy / gwei / ZETAPHY) and addresses (0x ↔ zetaphy1, valoper);
//   4. broadcast a signed raw tx with eth_sendRawTransaction, only after an explicit two-step confirm.
import { keccak_256, bytesToHex, hexToBytes, toChecksumHex, toBech32, ml_dsa44 } from '../vendor/zetaphy-lib.js';
import { secp256k1 } from '../vendor/zetaphy-tools-lib.js';
import { rlpDecode } from './evm.js';
import { safeText, formatUnits, formatZtphy, groupDigits, toAddress, toValoper, fromBase64 } from './format.js';

const enc = new TextEncoder();
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const big = (b) => (b instanceof Uint8Array && b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
const hex0x = (b) => '0x' + bytesToHex(b);
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** RLP encoding of bytes / nested arrays (the inverse of evm.js rlpDecode). */
export function rlpEncode(x) {
  const len = (n, off) => {
    if (n < 56) return Uint8Array.of(off + n);
    const bs = []; for (let v = n; v > 0; v = Math.floor(v / 256)) bs.unshift(v % 256);
    return Uint8Array.of(off + 55 + bs.length, ...bs);
  };
  if (Array.isArray(x)) { const body = concat(...x.map(rlpEncode)); return concat(len(body.length, 0xc0), body); }
  const b = x instanceof Uint8Array ? x : new Uint8Array();
  if (b.length === 1 && b[0] < 0x80) return b;
  return concat(len(b.length, 0x80), b);
}

/** A BigInt as minimal big-endian bytes (0 -> empty), as RLP wants integers. */
export function bigBytes(v) {
  let x = BigInt(v); if (x === 0n) return new Uint8Array();
  const out = []; while (x > 0n) { out.unshift(Number(x & 0xffn)); x >>= 8n; }
  return Uint8Array.from(out);
}

/** Bytes from "0x…" hex, plain hex, or base64; throws when it is none of them. */
export function parseBytes(s) {
  const t = String(s ?? '').trim();
  if (/^0x([0-9a-fA-F]{2})*$/.test(t)) return hexToBytes(t);
  if (/^([0-9a-fA-F]{2})+$/.test(t)) return hexToBytes('0x' + t);
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0) return fromBase64(t);
  throw new Error('not hex or base64');
}

/** The EIP-55 address of a secp256k1 public key recovered from (hash, r, s, recovery id). */
export function recoverAddress(hash, r, s, recid) {
  const sig = secp256k1.Signature.fromBytes(concat(r.length < 32 ? concat(new Uint8Array(32 - r.length), r) : r, s.length < 32 ? concat(new Uint8Array(32 - s.length), s) : s), 'compact').addRecoveryBit(recid);
  const pub = sig.recoverPublicKey(hash).toBytes(false);
  return toChecksumHex(keccak_256(pub.subarray(1)).subarray(12));
}

const accessListOf = (al) => (Array.isArray(al) ? al.map((e) => ({
  address: e?.[0] instanceof Uint8Array && e[0].length === 20 ? toChecksumHex(e[0]) : '?',
  storageKeys: Array.isArray(e?.[1]) ? e[1].map((k) => hex0x(k)) : [],
})) : []);

/**
 * A signed raw EVM tx (hex or bytes) -> { type, chainId, nonce, gas, gasPrice | maxFeePerGas + maxPriorityFeePerGas,
 * to, value, data (0x hex), accessList, v, r, s, yParity, hash, signingHash, from, highS }. Throws on what it cannot read.
 */
export function decodeSignedTx(input) {
  const raw = input instanceof Uint8Array ? input : parseBytes(input);
  if (!raw.length) throw new Error('empty');
  const typed = raw[0] < 0x7f;
  const type = typed ? raw[0] : 0;
  if (![0, 1, 2].includes(type)) throw new Error(`tx type ${type} is not supported here (0, 1, 2)`);
  const f = rlpDecode(typed ? raw.subarray(1) : raw);
  if (!Array.isArray(f)) throw new Error('not an RLP list');
  const need = { 0: 9, 1: 11, 2: 12 }[type];
  if (f.length !== need) throw new Error(`expected ${need} fields, got ${f.length}`);
  const out = { type, hash: hex0x(keccak_256(raw)) };
  let payload; let recid; let r; let s;
  if (type === 0) {
    const [nonce, gasPrice, gas, to, value, data, v, rr, ss] = f;
    const vv = big(v);
    Object.assign(out, { nonce: big(nonce), gasPrice: big(gasPrice), gas: big(gas), to, value: big(value), data, v: vv });
    if (vv >= 35n) { out.chainId = (vv - 35n) / 2n; recid = Number((vv - 35n) % 2n); payload = rlpEncode([...f.slice(0, 6), bigBytes(out.chainId), new Uint8Array(), new Uint8Array()]); } else if (vv === 27n || vv === 28n) {
      out.chainId = null; recid = Number(vv - 27n); payload = rlpEncode(f.slice(0, 6));
    } else throw new Error('bad v');
    r = rr; s = ss;
  } else {
    const fields = type === 1 ? ['chainId', 'nonce', 'gasPrice', 'gas', 'to', 'value', 'data', 'accessList'] : ['chainId', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'gas', 'to', 'value', 'data', 'accessList'];
    fields.forEach((k, i) => { out[k] = ['to', 'data', 'accessList'].includes(k) ? f[i] : big(f[i]); });
    const yp = big(f[fields.length]);
    if (yp > 1n) throw new Error('bad y parity');
    out.yParity = Number(yp); recid = out.yParity;
    r = f[fields.length + 1]; s = f[fields.length + 2];
    payload = concat(Uint8Array.of(type), rlpEncode(f.slice(0, fields.length)));
  }
  out.to = out.to instanceof Uint8Array && out.to.length === 20 ? toChecksumHex(out.to) : out.to instanceof Uint8Array && out.to.length === 0 ? null : (() => { throw new Error('bad to'); })();
  out.data = hex0x(out.data instanceof Uint8Array ? out.data : new Uint8Array());
  out.accessList = accessListOf(out.accessList);
  out.r = hex0x(r); out.s = hex0x(s);
  out.signingHash = hex0x(keccak_256(payload));
  out.highS = big(s) > SECP_N / 2n;
  out.from = recoverAddress(keccak_256(payload), r, s, recid);
  return out;
}

/** EIP-191 personal_sign hash of a message (bytes or text). */
export function personalHash(msg) {
  const m = msg instanceof Uint8Array ? msg : enc.encode(String(msg));
  return keccak_256(concat(enc.encode(`\x19Ethereum Signed Message:\n${m.length}`), m));
}

/** Who signed `msg` (personal_sign, 65-byte r‖s‖v signature): the EIP-55 address. */
export function recoverPersonal(msg, sigInput) {
  const sig = parseBytes(sigInput);
  if (sig.length !== 65) throw new Error('the signature must be 65 bytes (r, s, v)');
  let v = sig[64]; if (v >= 27) v -= 27;
  if (v > 1) throw new Error('bad v');
  return recoverAddress(personalHash(msg), sig.subarray(0, 32), sig.subarray(32, 64), v);
}

/** ML-DSA-44 check (FIPS 204, no context): true / false; throws when the key or signature has the wrong size. */
export function verifyMlDsa(pubKey, msg, sig) {
  const pk = pubKey instanceof Uint8Array ? pubKey : parseBytes(pubKey);
  const sg = sig instanceof Uint8Array ? sig : parseBytes(sig);
  if (pk.length !== 1312) throw new Error(`public key is ${pk.length} bytes, ML-DSA-44 keys are 1312`);
  if (sg.length !== 2420) throw new Error(`signature is ${sg.length} bytes, ML-DSA-44 signatures are 2420`);
  const m = msg instanceof Uint8Array ? msg : enc.encode(String(msg));
  try { return ml_dsa44.verify(sg, m, pk); } catch { return false; }
}

export const UNITS = { azeta: 0, gwei: 9, zetaphy: 18 };
/** "1.5" in a unit -> azetaphy BigInt; throws on more decimals than the unit has, or a bad number. */
export function parseAmount(s, unit = 'zetaphy') {
  const d = UNITS[unit]; if (d == null) throw new Error('unit');
  const m = /^\s*(\d{1,60})(?:\.(\d*))?\s*$/.exec(String(s ?? '').replaceAll(',', ''));
  if (!m) throw new Error('not a number');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > d) throw new Error(`at most ${d} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, '0') || '0');
}
export const convertUnits = (azeta) => ({ azeta: groupDigits(azeta.toString()), gwei: formatUnits(azeta, 9, { maxFrac: 9 }), zetaphy: formatUnits(azeta, 18, { maxFrac: 18 }) });

/** An address in any form (0x, zetaphy1, zetaphyvaloper1) -> { hex, bech32, valoper } (the same 20 bytes), or null. */
export function convertAddress(s) {
  const q = String(s ?? '').trim();
  const vo = /^zetaphyvaloper1/i.test(q) ? toValoper(q) : null;
  const a = vo ? vo.account : toAddress(q);
  if (!a) return null;
  return { hex: a.hex, bech32: a.bech32, valoper: toBech32(hexToBytes(a.hex), 'zetaphyvaloper') };
}

/** A revert reason from eth_call error data: Error(string) / Panic(uint256) / raw. */
export function revertReason(data) {
  const d = String(data ?? '');
  if (/^0x08c379a0/i.test(d)) {
    try { const b = hexToBytes(d).subarray(4); const len = Number(big(b.subarray(32, 64))); return safeText(new TextDecoder().decode(b.subarray(64, 64 + Math.min(len, 1000))), 300); } catch { return d.slice(0, 200); }
  }
  if (/^0x4e487b71/i.test(d)) return `panic 0x${BigInt('0x' + (d.slice(10) || '0')).toString(16)}`;
  return d.slice(0, 200);
}

// ---- the page ----

export function pageTools(c, view) {
  const { t, h } = c;
  c.append(view, h('h1', null, t('tlTitle')), c.note(t('tlIntro'), 'info'), decodeCard(c), signCard(c), mldsaCard(c), unitCard(c), addressCard(c));
}

const area = (id, placeholder, rows = 4) => ({ id, placeholder, rows: String(rows), spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', class: 'mono tl-area' });

function decodeCard(c) {
  const { t, h, api, cfg } = c;
  const input = h('textarea', area('tl-raw', '0x02f8…'));
  const out = h('div', { class: 'tl-out' });
  let decoded = null; let armed = false;
  const ack = h('input', { type: 'checkbox', id: 'tl-ack', class: 'tl-check' });
  const send = h('button', { type: 'button', class: 'danger', id: 'tl-send', disabled: '' }, t('tlBroadcast'));
  const sendMsg = h('p', { class: 'msg-line', role: 'status' });
  const refresh = () => { send.disabled = !(decoded && ack.checked && decoded.chainId === BigInt(cfg.evmChainId)); armed = false; send.textContent = t('tlBroadcast'); };
  ack.addEventListener('change', refresh);
  function run() {
    decoded = null; sendMsg.textContent = '';
    try {
      const d = decodeSignedTx(input.value);
      decoded = d;
      const wrongChain = d.chainId !== BigInt(cfg.evmChainId);
      const sim = h('span', null, '…');
      c.fill(out, c.kv([
        [t('tlType'), `${d.type} (${['legacy', 'EIP-2930', 'EIP-1559'][d.type]})`],
        [t('txHash'), h('span', { class: 'mono break tl-hash' }, d.hash)],
        [t('from'), h('span', null, h('span', { class: 'mono break tl-from' }, d.from), ' ', c.badge(t('tlRecovered'), 'ok'))],
        [t('to'), d.to ? c.addrLink(d.to, { full: true }) : t('contractCreation')],
        [t('value'), formatZtphy(d.value, { maxFrac: 18 })],
        [t('tlChainId'), h('span', null, d.chainId == null ? t('tlNoChainId') : String(d.chainId), wrongChain ? [' ', c.badge(t('tlWrongChain', { id: cfg.evmChainId }), 'warn')] : null)],
        [t('nonce'), d.nonce.toString()],
        [t('tlGasLimit'), groupDigits(d.gas.toString())],
        d.gasPrice != null ? [t('gasPrice'), `${formatUnits(d.gasPrice, 9, { maxFrac: 4 })} gwei`] : null,
        d.maxFeePerGas != null ? [t('gasMaxFee'), `${formatUnits(d.maxFeePerGas, 9, { maxFrac: 4 })} gwei`] : null,
        d.maxPriorityFeePerGas != null ? [t('gasTip'), `${formatUnits(d.maxPriorityFeePerGas, 9, { maxFrac: 4 })} gwei`] : null,
        [t('tlMaxCost'), formatZtphy(d.gas * (d.maxFeePerGas ?? d.gasPrice ?? 0n) + d.value, { maxFrac: 8 })],
        [t('input'), d.data === '0x' ? t('noInput') : h('details', null, h('summary', null, `${d.data.slice(0, 10)} · ${groupDigits((d.data.length - 2) / 2)} bytes`), h('div', { class: 'mono small break' }, d.data.slice(0, 20000)))],
        d.accessList.length ? [t('tlAccessList'), d.accessList.map((e) => `${e.address} (${e.storageKeys.length})`).join(', ')] : null,
        [t('tlSignature'), h('span', { class: 'mono small break' }, `r ${d.r} · s ${d.s} · ${d.yParity != null ? `yParity ${d.yParity}` : `v ${d.v}`}`, d.highS ? [' ', c.badge(t('tlHighS'), 'warn')] : null)],
        [t('tlSimulation'), sim],
      ]), c.note(t('tlSimNote')));
      const call = { from: d.from, data: d.data, value: '0x' + d.value.toString(16), gas: '0x' + d.gas.toString(16) };
      if (d.to) call.to = d.to;
      api.evm('eth_call', [call, 'latest'], 0).then((r) => c.fill(sim, c.badge(t('tlSimOk'), 'ok'), ' ', h('span', { class: 'mono small break' }, safeText(String(r).slice(0, 300), 310))))
        .catch((e) => c.fill(sim, c.badge(t('tlSimRevert'), 'bad'), ' ', h('span', { class: 'small' }, safeText(revertReason(e.message?.match(/0x[0-9a-fA-F]{8,}/)?.[0] ?? '') || e.message, 300))));
    } catch (e) { c.fill(out, c.errorBox(`${t('tlDecodeFailed')}: ${safeText(e.message, 200)}`)); }
    refresh();
  }
  send.addEventListener('click', async () => {
    if (!decoded || !ack.checked) return;
    if (!armed) { armed = true; send.textContent = t('tlBroadcastConfirm'); return; } // the second, explicit click
    send.disabled = true; sendMsg.textContent = t('loading');
    try {
      const hash = await api.evm('eth_sendRawTransaction', [input.value.trim().startsWith('0x') ? input.value.trim() : hex0x(parseBytes(input.value))], 0);
      c.fill(sendMsg, t('tlSent'), ' ', c.hashLink(String(hash), { full: true }));
    } catch (e) { sendMsg.textContent = `${t('error')}: ${safeText(e.message, 300)}`; }
    ack.checked = false; refresh();
  });
  return c.card(t('tlDecodeTitle'), h('label', { for: 'tl-raw' }, t('tlRawLabel')), input,
    h('div', { class: 'row' }, h('button', { type: 'button', id: 'tl-decode', on: { click: run } }, t('tlDecode'))), out,
    h('h3', null, t('tlBroadcastTitle')), c.note(t('tlBroadcastNote'), 'warn'),
    h('p', null, ack, ' ', h('label', { for: 'tl-ack' }, t('tlBroadcastAck'))), send, sendMsg);
}

function signCard(c) {
  const { t, h } = c;
  const msg = h('textarea', area('tl-msg', t('tlMessage'), 3));
  const isHex = h('input', { type: 'checkbox', id: 'tl-msg-hex', class: 'tl-check' });
  const sig = h('input', { id: 'tl-sig', placeholder: '0x… (65 bytes)', spellcheck: 'false', autocomplete: 'off', class: 'mono' });
  const who = h('input', { id: 'tl-signer', placeholder: t('tlExpected'), spellcheck: 'false', autocomplete: 'off', class: 'mono' });
  const out = h('p', { class: 'tl-out', role: 'status' });
  const run = () => {
    try {
      const m = isHex.checked ? parseBytes(msg.value) : msg.value;
      const got = recoverPersonal(m, sig.value);
      const want = toAddress(who.value);
      c.fill(out, t('tlSignedBy'), ' ', h('span', { class: 'mono tl-signed-by' }, got), ' ',
        want ? (want.lower === got.toLowerCase() ? c.badge(t('tlMatch'), 'ok') : c.badge(t('tlNoMatch'), 'bad')) : null);
    } catch (e) { c.fill(out, c.errorBox(e)); }
  };
  return c.card(t('tlSignTitle'), c.note(t('tlSignNote')), msg, h('p', null, isHex, ' ', h('label', { for: 'tl-msg-hex' }, t('tlMsgHex'))), sig, who,
    h('div', { class: 'row' }, h('button', { type: 'button', id: 'tl-verify', on: { click: run } }, t('tlVerify'))), out);
}

function mldsaCard(c) {
  const { t, h } = c;
  const pk = h('textarea', area('tl-pq-pk', t('tlPqKey'), 2));
  const msg = h('textarea', area('tl-pq-msg', t('tlMessage'), 2));
  const isHex = h('input', { type: 'checkbox', id: 'tl-pq-hex', class: 'tl-check' });
  const sig = h('textarea', area('tl-pq-sig', t('tlPqSig'), 2));
  const out = h('p', { class: 'tl-out', role: 'status' });
  const run = () => {
    try {
      const ok = verifyMlDsa(pk.value, isHex.checked ? parseBytes(msg.value) : msg.value, sig.value);
      c.fill(out, ok ? c.badge(t('tlPqValid'), 'ok') : c.badge(t('tlPqInvalid'), 'bad'));
    } catch (e) { c.fill(out, c.errorBox(e)); }
  };
  return c.card(t('tlPqTitle'), c.note(t('tlPqNote')), pk, msg, h('p', null, isHex, ' ', h('label', { for: 'tl-pq-hex' }, t('tlMsgHex'))), sig,
    h('div', { class: 'row' }, h('button', { type: 'button', id: 'tl-pq-verify', on: { click: run } }, t('tlVerify'))), out);
}

function unitCard(c) {
  const { t, h } = c;
  const amt = h('input', { id: 'tl-amount', value: '1', inputmode: 'decimal', autocomplete: 'off' });
  const unit = h('select', { id: 'tl-unit', class: 'lang-select', 'aria-label': t('tlUnit') }, h('option', { value: 'zetaphy' }, 'ZETAPHY'), h('option', { value: 'gwei' }, 'gwei'), h('option', { value: 'azeta' }, 'azetaphy (wei)'));
  const out = h('div', { class: 'tl-units' });
  const run = () => {
    try {
      const v = parseAmount(amt.value, unit.value); const x = convertUnits(v);
      c.fill(out, c.kv([['ZETAPHY', h('span', { class: 'mono' }, x.zetaphy)], ['gwei', h('span', { class: 'mono' }, x.gwei)], ['azetaphy', h('span', { class: 'mono' }, x.azeta)]]));
    } catch (e) { c.fill(out, c.errorBox(e)); }
  };
  amt.addEventListener('input', run); unit.addEventListener('change', run); run();
  return c.card(t('tlUnitsTitle'), h('div', { class: 'row' }, amt, unit), out);
}

function addressCard(c) {
  const { t, h } = c;
  const inp = h('input', { id: 'tl-addr', placeholder: '0x… / zetaphy1… / zetaphyvaloper1…', spellcheck: 'false', autocomplete: 'off', class: 'mono' });
  const out = h('div');
  inp.addEventListener('input', () => {
    if (!inp.value.trim()) { c.fill(out); return; }
    const r = convertAddress(inp.value);
    c.fill(out, r ? c.kv([['0x', h('span', { class: 'mono break' }, r.hex, ' ', c.copyBtn(r.hex))], ['zetaphy1', h('span', { class: 'mono break' }, r.bech32, ' ', c.copyBtn(r.bech32))],
      r.valoper ? ['valoper', h('span', { class: 'mono break' }, r.valoper)] : null, [t('address'), c.addrLink(r.hex)]]) : c.note(t('badAddress'), 'warn'));
  });
  return c.card(t('tlAddrTitle'), inp, out);
}
