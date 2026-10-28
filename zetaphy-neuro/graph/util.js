// Small helpers shared by the money-flow graph (graph/) and the investigator
// agent (agent/). Kept outside src/ on purpose: src/ is hashed into the skill id
// that NeuroJobs runners agree on, and nothing here is part of a verdict.
import { keccak256 } from '../src/keccak.js';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const DEAD = new Set([ZERO, '0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069']);

const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** keccak256 of an ASCII signature, 0x + 64 hex (an event topic). */
export const topicOf = (sig) => '0x' + hex(keccak256(enc.encode(sig)));
/** 4-byte selector of a function signature, 8 hex without 0x. */
export const selector = (sig) => hex(keccak256(enc.encode(sig))).slice(0, 8);

export const TOPIC = {
  transfer: topicOf('Transfer(address,address,uint256)'),
  burn: topicOf('Burn(address,uint256,uint256,address)'),
  mint: topicOf('Mint(address,uint256,uint256)'),
  pairCreated: topicOf('PairCreated(address,address,address,uint256)'),
  dlmmPairCreated: topicOf('PairCreated(address,address,uint16,address,int24,uint256)'),
  dlmmDeposit: topicOf('DepositedToBins(address,address,int24[],uint256[],uint256[],uint256[])'),
  dlmmWithdraw: topicOf('WithdrawnFromBins(address,address,address,int24[],uint256[],uint256,uint256)'),
  jobRequested: topicOf('JobRequested(uint256,bytes32,string,uint256)'),
};

export const isEvmAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
// Hex (0x…) addresses and hashes are compared in lowercase; base58 (Solana) and
// bech32 values are case-sensitive or already lowercase, so they are left as they are.
export const lc = (a) => { const s = String(a ?? ''); return /^0x/i.test(s) ? s.toLowerCase() : s; };
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const addrWord = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
/** The address in a 32-byte topic / word. */
export const topicAddr = (t) => '0x' + String(t ?? '').replace(/^0x/, '').padStart(64, '0').slice(24).toLowerCase();
export const toBig = (h) => { try { return BigInt(h && h !== '0x' ? h : 0); } catch { return 0n; } };
export const toNum = (h) => Number(toBig(h));
export const hexBlock = (n) => '0x' + Math.max(0, Math.floor(Number(n))).toString(16);
/** Word i (0-based) of ABI data. */
export const dataWord = (data, i) => toBig('0x' + String(data ?? '').replace(/^0x/, '').slice(i * 64, i * 64 + 64));
export const isTxHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);

/** Decodes an ABI-encoded `string` at word offset `at` of `data`. */
export function abiString(data, at = 0) {
  const h = String(data ?? '').replace(/^0x/, '');
  const off = Number(dataWord(h, at)) * 2;
  const len = Number(toBig('0x' + h.slice(off, off + 64)));
  if (!(len >= 0 && len <= 4096) || off + 64 + len * 2 > h.length) throw new Error('bad string');
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(h.slice(off + 64 + i * 2, off + 66 + i * 2), 16);
  return new TextDecoder().decode(bytes);
}

/** bytes32 string ("bsc" padded with zeros) -> "bsc"; throws on non-text. */
export function bytes32String(h) {
  const s = String(h ?? '').replace(/^0x/, '').replace(/(00)+$/, '');
  if (s.length % 2) throw new Error('bad bytes32');
  let out = '';
  for (let i = 0; i < s.length; i += 2) {
    const c = parseInt(s.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) throw new Error('bad bytes32');
    out += String.fromCharCode(c);
  }
  return out;
}

/** Inert text: control / bidi / invisible characters dropped, length capped. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;
export const plain = (s, max = 200) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').trim().slice(0, max);

export class BudgetError extends Error {
  constructor(why) { super(`budget exhausted (${why})`); this.why = why; }
}

/**
 * Bounds a whole graph build: at most `maxRequests` network requests and no
 * work after `deadlineMs` (ms since epoch). take() throws BudgetError.
 */
export function createBudget({ maxRequests = 250, timeMs = 60_000, now = () => Date.now() } = {}) {
  const deadline = now() + timeMs;
  let used = 0;
  return {
    take(n = 1) {
      if (now() > deadline) throw new BudgetError('time');
      if (used + n > maxRequests) throw new BudgetError('requests');
      used += n;
    },
    get used() { return used; },
    left: () => Math.max(0, maxRequests - used),
    expired: () => now() > deadline || used >= maxRequests,
  };
}

/** Resolves fn() or rejects with a 'timeout' error after ms; aborts the signal it hands fn. */
export async function withTimeout(fn, ms, label = 'step') {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); const e = new Error(`${label} timed out after ${ms} ms`); e.timeout = true; rej(e); }, ms); });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(ctrl.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON with sorted keys (the same object always gives the same text). */
export function canonical(v) {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return hex(new Uint8Array(buf));
}

/** Percent with one decimal, from bigints (0 when the whole is 0). */
export const pct = (part, whole) => (whole > 0n ? Number((part * 1000n) / whole) / 10 : 0);
