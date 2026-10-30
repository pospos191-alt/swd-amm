// Solidity ABI codec for the explorer: parse human-readable and JSON ABIs,
// decode call data / event logs / revert data, and encode calls for the
// read / write contract forms. Pure functions (no DOM, no network), so the unit
// tests check them against ethers. Everything decoded here is untrusted chain
// data: sizes are bounded and strict mode refuses non-canonical words, so a
// guessed signature only "fits" when the bytes really are that encoding.
import { keccak_256, bytesToHex, hexToBytes, toChecksumHex, addressBytes } from '../vendor/zetaphy-lib.js';

const enc = new TextEncoder();
export const keccakHex = (s) => bytesToHex(keccak_256(typeof s === 'string' ? enc.encode(s) : s));

const MAX_ARRAY = 1024;
const MAX_DEPTH = 8;
const MAX_FRAGMENTS = 3000;
const ELEMENTARY = /^(address|bool|string|bytes|function|bytes([1-9]|[12][0-9]|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export class AbiError extends Error {}
const fail = (m) => { throw new AbiError(m); };

// ---------------------------------------------------------------- types

/** { inner, length (null: dynamic T[]) } when p is an array type, else null. */
export function arrayOf(p) {
  const m = /^(.*)\[(\d*)\]$/.exec(p.type);
  if (!m) return null;
  return { inner: { type: m[1], name: '', components: p.components }, length: m[2] === '' ? null : Number(m[2]) };
}

export function isDynamic(p) {
  const a = arrayOf(p);
  if (a) return a.length == null || isDynamic(a.inner);
  if (p.type === 'tuple') return p.components.some(isDynamic);
  return p.type === 'string' || p.type === 'bytes';
}

function headSize(p) {
  if (isDynamic(p)) return 32;
  const a = arrayOf(p);
  if (a) return a.length * headSize(a.inner);
  if (p.type === 'tuple') return p.components.reduce((n, c) => n + headSize(c), 0);
  return 32;
}

/** The canonical type used in signatures: tuples as (t1,t2), uint -> uint256. */
export function canonicalType(p) {
  const m = /^tuple((\[\d*\])*)$/.exec(p.type);
  if (m) return `(${p.components.map(canonicalType).join(',')})${m[1]}`;
  return p.type;
}

/** A checked parameter (from JSON ABI or the parser): { type, name, indexed?, components? }. */
function checkParam(p, depth = 0) {
  if (!p || typeof p !== 'object' || depth > MAX_DEPTH) fail('bad parameter');
  let type = String(p.type ?? '').replace(/^(u?int)(?=$|\[)/, '$1256');
  const base = type.replace(/(\[\d*\])+$/, '');
  const dims = type.slice(base.length);
  if (dims && !/^(\[(\d{0,4})\])+$/.test(dims)) fail(`bad type ${type}`);
  let components;
  if (base === 'tuple') {
    if (!Array.isArray(p.components) || p.components.length > 64) fail('bad tuple');
    components = p.components.map((c) => checkParam(c, depth + 1));
  } else if (!ELEMENTARY.test(base)) fail(`unsupported type ${type}`);
  const name = typeof p.name === 'string' && NAME.test(p.name) ? p.name : '';
  type = base + dims;
  return { type, name, ...(p.indexed ? { indexed: true } : {}), ...(components ? { components } : {}) };
}

// ---------------------------------------------------------------- human-readable signatures

function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) fail('unbalanced');
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (depth !== 0) fail('unbalanced');
  if (cur.trim()) out.push(cur.trim());
  else if (out.length) fail('empty parameter');
  return out;
}

/** "(address a,uint256 b)[] indexed name" or "uint256 amount" -> parameter. */
export function parseParam(s) {
  s = s.trim();
  let p;
  if (s.startsWith('(')) {
    let depth = 0; let end = -1;
    for (let i = 0; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) { end = i; break; } }
    if (end < 0) fail('unbalanced');
    const comps = parseParamList(s.slice(1, end));
    const rest = s.slice(end + 1);
    const m = /^((?:\[\d*\])*)\s*(.*)$/.exec(rest);
    p = { type: `tuple${m[1]}`, components: comps, words: m[2].trim() };
  } else {
    const [type, ...words] = s.split(/\s+/);
    p = { type, words: words.join(' ') };
  }
  const words = p.words ? p.words.split(/\s+/) : [];
  const indexed = words[0] === 'indexed';
  if (indexed) words.shift();
  if (words.length > 1) fail(`bad parameter ${s}`);
  return checkParam({ type: p.type, components: p.components, name: words[0] ?? '', indexed });
}

export const parseParamList = (s) => splitTop(s).map(parseParam);

/** "name(params)" -> { name, inputs }. */
export function parseSignature(sig) {
  const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)\s*$/s.exec(String(sig));
  if (!m) fail(`bad signature ${sig}`);
  return { name: m[1], inputs: parseParamList(m[2]) };
}

export const signatureOf = (name, inputs) => `${name}(${inputs.map(canonicalType).join(',')})`;

/**
 * A fragment: { kind: 'function' | 'event' | 'error', name, inputs, outputs, mutability, anonymous,
 *   signature (canonical), selector (8 hex, functions and errors) or topic (0x + 64 hex, events) }.
 */
function makeFragment(kind, name, inputs, extra = {}) {
  if (!NAME.test(name)) fail('bad name');
  const signature = signatureOf(name, inputs);
  const hash = keccakHex(signature);
  const f = { kind, name, inputs, signature, ...extra };
  if (kind === 'event') f.topic = '0x' + hash; else f.selector = hash.slice(0, 8);
  return f;
}

const MUT = { v: 'view', p: 'pure', n: 'nonpayable', $: 'payable' };

/**
 * The compact form the build writes (scripts/build.js) and sigs.js uses:
 *   function "v|balanceOf(address account)|(uint256)"  (v view, p pure, n nonpayable, $ payable)
 *   event    "Transfer(address indexed from,address indexed to,uint256 value)" ("~" first: anonymous)
 *   error    "InsufficientBalance(uint256 have,uint256 want)"
 */
export function parseCompact(kind, s) {
  if (kind === 'function') {
    const [m, sig, outs = '()'] = String(s).split('|');
    const { name, inputs } = parseSignature(sig);
    const outputs = parseParamList(outs.replace(/^\(|\)$/g, ''));
    return makeFragment('function', name, inputs, { outputs, mutability: MUT[m] ?? 'nonpayable' });
  }
  const anonymous = kind === 'event' && String(s).startsWith('~');
  const { name, inputs } = parseSignature(anonymous ? s.slice(1) : s);
  return makeFragment(kind, name, inputs, kind === 'event' ? { anonymous } : {});
}

/** The compact form of a fragment (inverse of parseCompact). */
export function toCompact(f) {
  const list = (ps) => ps.map((p) => {
    const t = p.type.startsWith('tuple') ? `(${list(p.components)})${p.type.slice(5)}` : p.type;
    return [t, p.indexed ? 'indexed' : '', p.name].filter(Boolean).join(' ');
  }).join(',');
  if (f.kind === 'function') return `${Object.keys(MUT).find((k) => MUT[k] === f.mutability) ?? 'n'}|${f.name}(${list(f.inputs)})|(${list(f.outputs)})`;
  return `${f.anonymous ? '~' : ''}${f.name}(${list(f.inputs)})`;
}

/**
 * A JSON ABI (e.g. from Sourcify; untrusted) -> { functions, events, errors } of fragments.
 * Entries that cannot be read are skipped, never guessed.
 */
export function fromJsonAbi(abi) {
  const out = { functions: [], events: [], errors: [] };
  if (!Array.isArray(abi)) return out;
  for (const e of abi.slice(0, MAX_FRAGMENTS)) {
    try {
      if (e?.type === 'function') {
        const mutability = ['view', 'pure', 'nonpayable', 'payable'].includes(e.stateMutability) ? e.stateMutability
          : e.constant ? 'view' : e.payable ? 'payable' : 'nonpayable';
        out.functions.push(makeFragment('function', String(e.name), (e.inputs ?? []).map((p) => checkParam(p)), { outputs: (e.outputs ?? []).map((p) => checkParam(p)), mutability }));
      } else if (e?.type === 'event') {
        out.events.push(makeFragment('event', String(e.name), (e.inputs ?? []).map((p) => checkParam(p)), { anonymous: !!e.anonymous }));
      } else if (e?.type === 'error') {
        out.errors.push(makeFragment('error', String(e.name), (e.inputs ?? []).map((p) => checkParam(p))));
      }
    } catch { /* skip an entry that is not a valid ABI item */ }
  }
  return out;
}

// ---------------------------------------------------------------- decoding

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) fail('not hex');
  return hexToBytes(data);
}

const wordAt = (b, at) => {
  if (at < 0 || at + 32 > b.length) fail('out of range');
  return b.subarray(at, at + 32);
};
const big = (w) => (w.length ? BigInt('0x' + bytesToHex(w)) : 0n);
function smallAt(b, at) {
  const v = big(wordAt(b, at));
  if (v > BigInt(b.length)) fail('offset or length out of range');
  return Number(v);
}

function decodeElem(p, b, at, strict) {
  const t = p.type;
  if (t === 'string' || t === 'bytes') {
    const len = smallAt(b, at);
    const start = at + 32;
    if (start + len > b.length) fail('short data');
    const raw = b.subarray(start, start + len);
    if (strict) {
      const padEnd = start + Math.ceil(len / 32) * 32;
      if (padEnd > b.length || b.subarray(start + len, padEnd).some((x) => x)) fail('bad padding');
    }
    if (t === 'bytes') return '0x' + bytesToHex(raw);
    try { return new TextDecoder('utf-8', { fatal: strict }).decode(raw); } catch { fail('not utf-8'); }
  }
  const w = wordAt(b, at);
  if (t === 'address') {
    if (strict && w.subarray(0, 12).some((x) => x)) fail('dirty address');
    return toChecksumHex(w.subarray(12));
  }
  if (t === 'bool') {
    const v = big(w);
    if (strict && v > 1n) fail('dirty bool');
    return v !== 0n;
  }
  let m = /^(u?)int(\d+)$/.exec(t);
  if (m) {
    const bits = BigInt(m[2]);
    let v = big(w);
    if (m[1]) { if (strict && v >> bits) fail('uint out of range'); return v; }
    if (v >> 255n) v -= 1n << 256n;
    if (strict && (v >= 1n << (bits - 1n) || v < -(1n << (bits - 1n)))) fail('int out of range');
    return v;
  }
  m = /^bytes(\d+)$/.exec(t);
  const n = m ? Number(m[1]) : t === 'function' ? 24 : null;
  if (n == null) fail(`cannot decode ${t}`);
  if (strict && w.subarray(n).some((x) => x)) fail('dirty bytesN');
  return '0x' + bytesToHex(w.subarray(0, n));
}

function decodeOne(p, b, at, strict, depth) {
  if (depth > MAX_DEPTH) fail('too deep');
  const a = arrayOf(p);
  if (a) {
    let n = a.length; let start = at;
    if (n == null) { n = smallAt(b, at); start = at + 32; }
    if (n > MAX_ARRAY) fail('array too long');
    return decodeList(Array(n).fill(a.inner), b, start, strict, depth + 1);
  }
  if (p.type === 'tuple') return decodeList(p.components, b, at, strict, depth + 1);
  return decodeElem(p, b, at, strict);
}

function decodeList(params, b, base, strict, depth) {
  const out = []; let head = base;
  for (const p of params) {
    if (isDynamic(p)) {
      const off = smallAt(b, head);
      if (strict && off % 32) fail('unaligned offset');
      out.push(decodeOne(p, b, base + off, strict, depth));
      head += 32;
    } else {
      out.push(decodeOne(p, b, head, strict, depth));
      head += headSize(p);
    }
  }
  if (head > b.length) fail('short data');
  return out;
}

/** ABI-decodes `data` (hex or bytes) as these parameters -> values (BigInt, checksummed address, 0x hex, string, bool, arrays). */
export function decodeParams(params, data, { strict = true } = {}) {
  return decodeList(params, toBytes(data), 0, strict, 0);
}

// ---------------------------------------------------------------- encoding

const pad32 = (b) => { const o = new Uint8Array(Math.ceil(b.length / 32) * 32); o.set(b); return o; };
const concat = (parts) => { const o = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of parts) { o.set(x, i); i += x.length; } return o; };
function uintWord(v) {
  let x = BigInt(v);
  if (x < 0n) x += 1n << 256n;
  if (x < 0n || x >> 256n) fail('number out of range');
  return hexToBytes(x.toString(16).padStart(64, '0'));
}

function encodeElem(p, v) {
  const t = p.type;
  if (t === 'string' || t === 'bytes') {
    const raw = t === 'string' ? enc.encode(String(v)) : toBytes(v);
    return concat([uintWord(raw.length), pad32(raw)]);
  }
  if (t === 'address') { const b = addressBytes(String(v)); const w = new Uint8Array(32); w.set(b, 12); return w; }
  if (t === 'bool') return uintWord(v ? 1n : 0n);
  let m = /^(u?)int(\d+)$/.exec(t);
  if (m) {
    const bits = BigInt(m[2]); const x = BigInt(v);
    if (m[1] ? (x < 0n || x >> bits) : (x >= 1n << (bits - 1n) || x < -(1n << (bits - 1n)))) fail(`${t} out of range`);
    return uintWord(x);
  }
  m = /^bytes(\d+)$/.exec(t);
  const n = m ? Number(m[1]) : t === 'function' ? 24 : null;
  if (n == null) fail(`cannot encode ${t}`);
  const raw = toBytes(v);
  if (raw.length !== n) fail(`${t} needs ${n} bytes`);
  const w = new Uint8Array(32); w.set(raw); return w;
}

function encodeOne(p, v, depth = 0) {
  if (depth > MAX_DEPTH) fail('too deep');
  const a = arrayOf(p);
  if (a) {
    if (!Array.isArray(v)) fail(`${p.type} needs a list`);
    if (a.length != null && v.length !== a.length) fail(`${p.type} needs ${a.length} items`);
    const body = encodeList(Array(v.length).fill(a.inner), v, depth + 1);
    return a.length == null ? concat([uintWord(v.length), body]) : body;
  }
  if (p.type === 'tuple') {
    const vals = Array.isArray(v) ? v : p.components.map((c) => v?.[c.name]);
    return encodeList(p.components, vals, depth + 1);
  }
  return encodeElem(p, v);
}

function encodeList(params, values, depth = 0) {
  if (!Array.isArray(values) || values.length !== params.length) fail(`needs ${params.length} values`);
  const enc1 = params.map((p, i) => encodeOne(p, values[i], depth));
  const headLen = params.reduce((n, p) => n + headSize(p), 0);
  const heads = []; const tails = []; let off = headLen;
  params.forEach((p, i) => {
    if (isDynamic(p)) { heads.push(uintWord(off)); tails.push(enc1[i]); off += enc1[i].length; } else heads.push(enc1[i]);
  });
  return concat([...heads, ...tails]);
}

export const encodeParams = (params, values) => '0x' + bytesToHex(encodeList(params, values));
export const encodeCall = (f, values) => '0x' + f.selector + encodeParams(f.inputs, values).slice(2);

// ---------------------------------------------------------------- calls, events, reverts

/** Decodes call data with a function fragment -> values, or throws. canonical: the bytes must be exactly the re-encoding. */
export function decodeCall(f, data, { strict = true, canonical = false } = {}) {
  const b = toBytes(data);
  if (b.length < 4 || bytesToHex(b.subarray(0, 4)) !== f.selector) fail('selector mismatch');
  const values = decodeParams(f.inputs, b.subarray(4), { strict });
  if (canonical && encodeCall(f, values) !== '0x' + bytesToHex(b)) fail('not the canonical encoding');
  return values;
}

/**
 * Decodes a log with an event fragment -> values in input order (an indexed dynamic value
 * is { hashed: topic }, since only its keccak is in the log), or throws.
 */
export function decodeEvent(f, log, { strict = true, canonical = false } = {}) {
  const topics = (log?.topics ?? []).map((x) => String(x).toLowerCase());
  let ti = 0;
  if (!f.anonymous) { if (topics[0] !== f.topic) fail('topic mismatch'); ti = 1; }
  const indexed = f.inputs.filter((p) => p.indexed);
  if (topics.length !== ti + indexed.length) fail('topic count');
  const plain = f.inputs.filter((p) => !p.indexed);
  const data = toBytes(log?.data ?? '0x');
  const dataVals = decodeParams(plain, data, { strict });
  if (canonical && encodeParams(plain, dataVals) !== '0x' + bytesToHex(data)) fail('not the canonical encoding');
  let di = 0;
  return f.inputs.map((p) => {
    if (!p.indexed) return dataVals[di++];
    const topic = topics[ti++];
    if (isDynamic(p) || p.type === 'tuple' || arrayOf(p)) return { hashed: topic };
    return decodeOne(p, toBytes(topic), 0, strict, 0);
  });
}

export const ERROR_STRING = '08c379a0'; // Error(string)
export const PANIC_SEL = '4e487b71'; // Panic(uint256)
/** Solidity panic codes -> i18n key of their meaning. */
export const PANIC_CODES = {
  0x00: 'panic00', 0x01: 'panic01', 0x11: 'panic11', 0x12: 'panic12', 0x21: 'panic21',
  0x22: 'panic22', 0x31: 'panic31', 0x32: 'panic32', 0x41: 'panic41', 0x51: 'panic51',
};

/**
 * Revert data -> what it says:
 *   { kind: 'empty' } (no data: out of gas, a bare revert(), or a failed call that kept no reason)
 *   { kind: 'error', message }               Error(string)
 *   { kind: 'panic', code (number), key }     Panic(uint256), key = i18n key of its meaning
 *   { kind: 'custom', fragment, values, source }   a custom error found by `findErrors(selector)` -> [{ fragment, source }]
 *   { kind: 'raw', data }                     anything else
 */
export function decodeRevert(data, findErrors = () => []) {
  let b;
  try { b = toBytes(data ?? '0x'); } catch { return { kind: 'raw', data: String(data ?? '').slice(0, 2050) }; }
  if (!b.length) return { kind: 'empty' };
  const sel = bytesToHex(b.subarray(0, 4));
  if (b.length >= 4 && sel === ERROR_STRING) {
    try { return { kind: 'error', message: decodeParams([{ type: 'string', name: '' }], b.subarray(4), { strict: false })[0] }; } catch { /* below */ }
  }
  if (b.length >= 4 && sel === PANIC_SEL) {
    try {
      const code = decodeParams([{ type: 'uint256', name: '' }], b.subarray(4))[0];
      return { kind: 'panic', code: Number(code > 0xffn ? 0xffffn : code), key: PANIC_CODES[Number(code)] ?? 'panicUnknown' };
    } catch { /* below */ }
  }
  if (b.length >= 4) {
    for (const { fragment, source } of findErrors(sel)) {
      try { return { kind: 'custom', fragment, values: decodeParams(fragment.inputs, b.subarray(4)), source }; } catch { /* next */ }
    }
  }
  return { kind: 'raw', data: '0x' + bytesToHex(b.subarray(0, 1024)) + (b.length > 1024 ? '…' : '') };
}

// ---------------------------------------------------------------- form input

/**
 * A form field's text -> a value for this parameter (throws an AbiError with the reason).
 * Lists and tuples are JSON: ["0x…", "5"]; numbers are decimal or 0x hex; addresses 0x… or zetaphy1….
 */
export function parseInput(p, text) {
  const a = arrayOf(p);
  if (a || p.type === 'tuple') {
    let v;
    try { v = JSON.parse(String(text)); } catch { fail(`${p.type}: JSON list expected, e.g. ["0x…", "1"]`); }
    return coerce(p, v);
  }
  return coerce(p, String(text ?? '').trim());
}

function coerce(p, v, depth = 0) {
  if (depth > MAX_DEPTH) fail('too deep');
  const a = arrayOf(p);
  if (a) {
    if (!Array.isArray(v) || v.length > MAX_ARRAY) fail(`${p.type}: list expected`);
    if (a.length != null && v.length !== a.length) fail(`${p.type}: ${a.length} items expected`);
    return v.map((x) => coerce(a.inner, x, depth + 1));
  }
  if (p.type === 'tuple') {
    if (!Array.isArray(v) || v.length !== p.components.length) fail(`tuple: ${p.components.length} items expected`);
    return p.components.map((c, i) => coerce(c, v[i], depth + 1));
  }
  const s = typeof v === 'string' ? v.trim() : v;
  const t = p.type;
  if (t === 'address') {
    try { return toChecksumHex(addressBytes(String(s))); } catch { fail('address: 0x… (40 hex digits) or zetaphy1… expected'); }
  }
  if (t === 'bool') {
    if (s === true || s === 'true' || s === '1') return true;
    if (s === false || s === 'false' || s === '0') return false;
    fail('bool: true or false expected');
  }
  if (/int\d+$/.test(t)) {
    let x;
    try { x = BigInt(typeof s === 'number' ? Math.trunc(s) : String(s)); } catch { fail(`${t}: a whole number expected`); }
    encodeElem(p, x); // range check
    return x;
  }
  if (t === 'string') return String(s);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(String(s))) fail(`${t}: 0x hex expected`);
  if (t !== 'bytes') encodeElem(p, s); // bytesN length check
  return String(s).toLowerCase();
}

/** A decoded value as plain text (lists and tuples as JSON-like text). */
export function valueText(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(valueText).join(', ')}]`;
  if (v && typeof v === 'object' && 'hashed' in v) return `keccak ${v.hashed}`;
  if (typeof v === 'string') return v;
  return String(v);
}
