// A small Solidity ABI codec: exactly what this site sends and reads (uintN,
// intN, address, bool, bytesN, bytes, string, T[], T[k], tuples). Checked
// against ethers in test/weblib.test.js. Decoding bounds-checks every offset
// and length, so a hostile contract's answer throws instead of misleading.
import { keccak_256 } from '../vendor/zetaphy-lib.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export const keccak = (data) => '0x' + toHex(keccak_256(typeof data === 'string' ? enc.encode(data) : data));
const MAX_BYTES = 1 << 20; // longest string/bytes/array we decode

// ---- types ----

/** Splits "a,b(c,d),e[]" at top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  if (s.length) out.push(s.slice(start));
  return out.map((x) => x.trim());
}

/** Parses one type: "uint256", "(address,uint256)[]", "tuple(string,bool)", ... */
export function parseType(t) {
  t = t.trim().replace(/^tuple(?=\()/, '');
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) return { kind: 'array', inner: parseType(arr[1]), length: arr[2] === '' ? null : Number(arr[2]) };
  if (t.startsWith('(')) {
    if (!t.endsWith(')')) throw new Error(`bad type ${t}`);
    return { kind: 'tuple', comps: splitTop(t.slice(1, -1)).map(parseType) };
  }
  let m;
  if ((m = /^(u?)int(\d*)$/.exec(t))) return { kind: 'int', signed: !m[1], bits: Number(m[2] || 256) };
  if (t === 'address' || t === 'bool' || t === 'string' || t === 'bytes') return { kind: t };
  if ((m = /^bytes(\d+)$/.exec(t)) && +m[1] >= 1 && +m[1] <= 32) return { kind: 'fixedBytes', size: +m[1] };
  throw new Error(`unsupported type ${t}`);
}

export const canonical = (t) => {
  switch (t.kind) {
    case 'array': return `${canonical(t.inner)}[${t.length ?? ''}]`;
    case 'tuple': return `(${t.comps.map(canonical).join(',')})`;
    case 'int': return `${t.signed ? '' : 'u'}int${t.bits}`;
    case 'fixedBytes': return `bytes${t.size}`;
    default: return t.kind;
  }
};

const isDynamic = (t) => t.kind === 'string' || t.kind === 'bytes' || (t.kind === 'array' && (t.length === null || isDynamic(t.inner)))
  || (t.kind === 'tuple' && t.comps.some(isDynamic));
const headSize = (t) => (isDynamic(t) ? 32 : t.kind === 'tuple' ? t.comps.reduce((a, c) => a + headSize(c), 0) : t.kind === 'array' ? t.length * headSize(t.inner) : 32);

// ---- encoding ----

const word = (n) => {
  let v = BigInt(n);
  if (v < 0n) v = (1n << 256n) + v;
  if (v < 0n || v >= 1n << 256n) throw new Error('value out of range');
  return v.toString(16).padStart(64, '0');
};
const padRight = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);

function encodeOne(t, v) {
  switch (t.kind) {
    case 'int': {
      const n = BigInt(v);
      const max = t.signed ? 1n << BigInt(t.bits - 1) : 1n << BigInt(t.bits);
      if (t.signed ? n < -max || n >= max : n < 0n || n >= max) throw new Error(`${canonical(t)} out of range: ${v}`);
      return word(n);
    }
    case 'address': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`bad address ${v}`);
      return v.slice(2).toLowerCase().padStart(64, '0');
    }
    case 'bool': return word(v ? 1 : 0);
    case 'fixedBytes': {
      const h = toHex(typeof v === 'string' ? fromHex(v) : v);
      if (h.length !== t.size * 2) throw new Error(`bytes${t.size} needs ${t.size} bytes`);
      return h.padEnd(64, '0');
    }
    case 'string':
    case 'bytes': {
      const b = t.kind === 'string' ? enc.encode(String(v)) : typeof v === 'string' ? fromHex(v) : v;
      return word(b.length) + padRight(toHex(b));
    }
    case 'array': {
      if (!Array.isArray(v) || (t.length !== null && v.length !== t.length)) throw new Error('bad array');
      const body = encodeList(v.map(() => t.inner), v);
      return t.length === null ? word(v.length) + body : body;
    }
    case 'tuple': {
      const vals = Array.isArray(v) ? v : t.comps.map((_, i) => v[i]);
      return encodeList(t.comps, vals);
    }
  }
  throw new Error('unsupported');
}

function encodeList(types, values) {
  if (types.length !== values.length) throw new Error(`expected ${types.length} values, got ${values.length}`);
  let head = '', tail = '';
  const headLen = types.reduce((a, t) => a + headSize(t), 0);
  types.forEach((t, i) => {
    const e = encodeOne(t, values[i]);
    if (isDynamic(t)) { head += word(headLen + tail.length / 2); tail += e; } else head += e;
  });
  return head + tail;
}

/** ABI-encodes values for a list of type strings; hex without 0x. */
export const encode = (types, values) => encodeList(types.map((t) => (typeof t === 'string' ? parseType(t) : t)), values);

// ---- decoding ----

function readWord(b, at) {
  if (at < 0 || at + 32 > b.length) throw new Error('answer too short');
  let v = 0n;
  for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}
const smallInt = (v) => { if (v > BigInt(MAX_BYTES * 32)) throw new Error('offset out of range'); return Number(v); };

function decodeOne(t, b, at, base) {
  switch (t.kind) {
    case 'int': {
      let v = readWord(b, at);
      if (t.signed && v >= 1n << 255n) v -= 1n << 256n;
      const lim = t.signed ? 1n << BigInt(t.bits - 1) : 1n << BigInt(t.bits);
      if (t.signed ? v < -lim || v >= lim : v >= lim) throw new Error(`dirty ${canonical(t)}`);
      return v;
    }
    case 'address': {
      const v = readWord(b, at);
      if (v >> 160n) throw new Error('dirty address');
      return checksum('0x' + v.toString(16).padStart(40, '0'));
    }
    case 'bool': {
      const v = readWord(b, at);
      if (v > 1n) throw new Error('dirty bool');
      return v === 1n;
    }
    case 'fixedBytes': readWord(b, at); return '0x' + toHex(b.slice(at, at + t.size));
    case 'string':
    case 'bytes': {
      const off = base + smallInt(readWord(b, at));
      const len = smallInt(readWord(b, off));
      if (len > MAX_BYTES || off + 32 + len > b.length) throw new Error('bad length');
      const raw = b.slice(off + 32, off + 32 + len);
      return t.kind === 'string' ? dec.decode(raw) : '0x' + toHex(raw);
    }
    case 'array': {
      let start = at, n = t.length;
      if (isDynamic(t)) start = base + smallInt(readWord(b, at));
      if (n === null) { n = smallInt(readWord(b, start)); start += 32; }
      if (n > MAX_BYTES / 32 || start + n * headSize(t.inner) > b.length) throw new Error('bad array length');
      return decodeList(Array(n).fill(t.inner), b, start);
    }
    case 'tuple': {
      const start = isDynamic(t) ? base + smallInt(readWord(b, at)) : at;
      return decodeList(t.comps, b, start);
    }
  }
  throw new Error('unsupported');
}

function decodeList(types, b, base) {
  let at = base;
  return types.map((t) => {
    const v = decodeOne(t, b, at, base);
    at += headSize(t);
    return v;
  });
}

/** Decodes hex for a list of type strings; returns an array. Throws on malformed data. */
export const decode = (types, hex) => decodeList(types.map((t) => (typeof t === 'string' ? parseType(t) : t)), typeof hex === 'string' ? fromHex(hex) : hex, 0);

// ---- addresses ----

export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = keccak(a).slice(2);
  return '0x' + [...a].map((ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('');
}
export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? ''));
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ---- functions and events ----

/**
 * fn('list(address,uint256,uint256,uint256,uint64)', ['uint256'])
 * -> { selector, encode(...args) -> '0x…', decode(hex) -> value (one output) or array }.
 */
export function fn(signature, outputs = []) {
  const m = /^(\w+)\((.*)\)$/.exec(signature);
  if (!m) throw new Error(`bad signature ${signature}`);
  const inputs = splitTop(m[2]).map(parseType);
  const canon = `${m[1]}(${inputs.map(canonical).join(',')})`;
  const selector = keccak(canon).slice(0, 10);
  const outs = outputs.map(parseType);
  return {
    name: m[1], signature: canon, selector,
    encode: (...args) => selector + encodeList(inputs, args),
    decode: (hex) => { const r = decodeList(outs, fromHex(hex), 0); return r.length === 1 ? r[0] : r; },
  };
}

/**
 * event('Listed(uint256 indexed id,address indexed seller,uint256 price)')
 * -> { topic, decode(log) -> { id, seller, price } } (indexed dynamic values: their topic hash).
 */
export function event(signature) {
  const m = /^(\w+)\((.*)\)$/.exec(signature);
  const params = splitTop(m[2]).map((p) => {
    const parts = p.split(/\s+/);
    return { type: parseType(parts[0]), indexed: parts.includes('indexed'), name: parts[parts.length - 1] };
  });
  const topic = keccak(`${m[1]}(${params.map((p) => canonical(p.type)).join(',')})`);
  const nonIndexed = params.filter((p) => !p.indexed);
  return {
    name: m[1], topic,
    decode(log) {
      if (!log.topics || log.topics[0]?.toLowerCase() !== topic) throw new Error('not this event');
      const idx = params.filter((p) => p.indexed);
      if (log.topics.length !== idx.length + 1) throw new Error('wrong topic count');
      const data = decodeList(nonIndexed.map((p) => p.type), fromHex(log.data ?? '0x'), 0);
      const out = {};
      idx.forEach((p, i) => { out[p.name] = isDynamic(p.type) ? log.topics[i + 1] : decodeOne(p.type, fromHex(log.topics[i + 1]), 0, 0); });
      nonIndexed.forEach((p, i) => { out[p.name] = data[i]; });
      return out;
    },
  };
}

/** A 32-byte topic for an indexed address/uint value. */
export const topicOf = (v) => '0x' + (isAddress(v) ? v.slice(2).toLowerCase().padStart(64, '0') : word(v));
