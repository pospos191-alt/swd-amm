// Formatters and input parsing. Pure functions (no DOM), so the unit tests run
// them in Node. Everything chain data passes through here before it is shown,
// and is then put in the page with textContent only (never parsed as HTML).
import { addressBytes, toBech32, toChecksumHex, fromBech32, bytesToHex } from '../vendor/zetaphy-lib.js';

export const DECIMALS = 18;
export const DENOM = 'azetaphy';
export const SYMBOL = 'ZETAPHY';
export const PREFIX = 'zetaphy';
export const VALOPER_PREFIX = 'zetaphyvaloper';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// Control, format (bidi overrides, zero-width), private-use and unassigned characters.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu;

/**
 * Text that someone else wrote on chain (token names, monikers, memos, event values):
 * line breaks become spaces, control / bidi / invisible characters are removed,
 * at most `max` characters (an ellipsis marks a cut). Always a string.
 */
export function safeText(s, max = 200) {
  if (s == null) return '';
  const clean = String(s).replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').replace(/\s{2,}/g, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : clean;
}

/** A token name or symbol: safeText, shorter. Empty -> fallback. */
export const tokenText = (s, max = 48, fallback = '?') => safeText(s, max) || fallback;

/** 1234567 -> "1,234,567" (BigInt or decimal string). */
export function groupDigits(intStr) {
  const s = String(intStr);
  const neg = s.startsWith('-');
  const d = neg ? s.slice(1) : s;
  return (neg ? '-' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * An integer amount in base units as a decimal number with `decimals` places:
 * grouped digits, trailing zeros dropped, at most maxFrac fraction digits
 * (truncated, never rounded up: "≈" is not added, the caller decides).
 */
export function formatUnits(value, decimals = DECIMALS, { maxFrac = 6, group = true } = {}) {
  let v;
  try { v = BigInt(value); } catch { return '?'; }
  const d = Math.max(0, Math.min(255, Number(decimals) || 0));
  const neg = v < 0n; if (neg) v = -v;
  const unit = 10n ** BigInt(d);
  const int = (v / unit).toString();
  let frac = d ? (v % unit).toString().padStart(d, '0') : '';
  if (maxFrac != null) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  const i = group ? groupDigits(int) : int;
  return `${neg ? '-' : ''}${i}${frac ? '.' + frac : ''}`;
}

/** azetaphy -> "1,234.5 ZETAPHY". */
export const formatZtphy = (azeta, opts) => `${formatUnits(azeta, DECIMALS, opts)} ${SYMBOL}`;

/** A Cosmos coin { denom, amount } as text (azetaphy shown in ZETAPHY). */
export function formatCoin(c) {
  if (!c) return '';
  if (c.denom === DENOM) return formatZtphy(c.amount ?? '0', { maxFrac: 18 });
  return `${groupDigits(safeText(c.amount, 80))} ${safeText(c.denom, 80)}`;
}

/** 0x-hex quantity or decimal -> BigInt (null when not a number). */
export function toBig(v) {
  if (v == null || v === '') return null;
  try { return BigInt(v); } catch { return null; }
}

/** "0xabcdef…1234" style shortening for hashes and addresses. */
export function short(s, head = 10, tail = 6) {
  const t = String(s ?? '');
  return t.length <= head + tail + 1 ? t : `${t.slice(0, head)}…${t.slice(-tail)}`;
}

/** Percent with one decimal ("66.7%"); part and total BigInt or numbers. */
export function percent(part, total, digits = 1) {
  const p = BigInt(part); const t = BigInt(total);
  if (t === 0n) return '0%';
  const scale = 10n ** BigInt(digits);
  const x = (p * 100n * scale * 10n / t + 5n) / 10n; // rounded
  const s = x.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits) || '0'}${digits ? '.' + s.slice(-digits) : ''}%`;
}

/** Seconds between now and a date as "12 s" / "5 min" / "3 h" / "2 d" (lang th|en). */
export function ago(date, now = Date.now(), lang = 'en') {
  const t = date instanceof Date ? date.getTime() : Date.parse(date);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  const u = lang === 'th' ? ['วินาที', 'นาที', 'ชม.', 'วัน'] : ['s', 'min', 'h', 'd'];
  const suffix = lang === 'th' ? 'ที่แล้ว' : 'ago';
  if (s < 60) return `${s} ${u[0]} ${suffix}`;
  if (s < 3600) return `${Math.floor(s / 60)} ${u[1]} ${suffix}`;
  if (s < 86400) return `${Math.floor(s / 3600)} ${u[2]} ${suffix}`;
  return `${Math.floor(s / 86400)} ${u[3]} ${suffix}`;
}

/** An RFC 3339 / epoch-seconds time as "2026-10-21 08:15:02 UTC". */
export function utcTime(t) {
  const ms = typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) * 1000 : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** 0x… or zetaphy1… -> { hex (EIP-55), bech32, lower } or null. */
export function toAddress(input) {
  try {
    const bytes = addressBytes(String(input ?? '').trim());
    const hex = toChecksumHex(bytes);
    return { hex, bech32: toBech32(bytes, PREFIX), lower: hex.toLowerCase() };
  } catch { return null; }
}

/** zetaphyvaloper1… -> { valoper, account: toAddress(same bytes) } or null. */
export function toValoper(input) {
  try {
    const bytes = fromBech32(String(input ?? '').trim().toLowerCase(), VALOPER_PREFIX);
    return { valoper: toBech32(bytes, VALOPER_PREFIX), account: toAddress(toChecksumHex(bytes)), hex: bytesToHex(bytes) };
  } catch { return null; }
}

/** Any bech32 or 0x account string seen in a message -> lower-case 0x (or null). */
export function anyAddressLower(s) {
  const t = String(s ?? '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
  const m = /^([a-z]+)1[02-9ac-hj-np-z]{38}$/.exec(t.toLowerCase());
  if (!m) return null;
  try { return '0x' + bytesToHex(fromBech32(t.toLowerCase(), m[1])); } catch { return null; }
}

/**
 * What the search box was given:
 *   { type: 'block', height } | { type: 'address', address } | { type: 'valoper', valoper }
 *   { type: 'hash', hash (lower hex, no 0x), evm: bool (had 0x) } | { type: 'invalid' }
 */
export function parseQuery(input) {
  const q = String(input ?? '').trim();
  if (/^\d{1,19}$/.test(q) && BigInt(q) > 0n) return { type: 'block', height: BigInt(q).toString() };
  if (/^#\d{1,19}$/.test(q)) return parseQuery(q.slice(1));
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(q)) return { type: 'hash', hash: q.replace(/^0x/i, '').toLowerCase(), evm: /^0x/i.test(q) };
  if (/^zetaphyvaloper1/i.test(q)) { const v = toValoper(q); return v ? { type: 'valoper', valoper: v.valoper } : { type: 'invalid' }; }
  const a = toAddress(q);
  if (a) return { type: 'address', address: a };
  return { type: 'invalid' };
}

/** A block height as given in a route: positive decimal (string) or null. */
export const heightParam = (s) => (/^\d{1,19}$/.test(String(s)) && BigInt(s) > 0n ? BigInt(s).toString() : null);

/** Bytes as 0x hex, cut after `max` bytes (with the full length said). */
export function hexPreview(bytes, max = 64) {
  const b = bytes ?? new Uint8Array();
  const h = bytesToHex(b.length > max ? b.subarray(0, max) : b);
  return b.length > max ? `0x${h}… (${b.length} bytes)` : `0x${h}`;
}

/** Base64 (as CometBFT returns tx bytes and abci values) -> bytes. Throws on bad input. */
export function fromBase64(s) {
  const bin = atob(String(s ?? ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
