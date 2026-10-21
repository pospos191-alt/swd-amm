// Early warning: Neuro's embargoed (private) rules tier. Advisory only.
//
// Neuro's consensus rules (src/) are public on purpose: every runner must run
// the same code, and the skill id is the hash of src/. The price is that a
// new scam signature, once published, tells its authors what to change. This
// tier closes that gap for a while: new rules stay in a private rule pack
// (the private repo zetaphy-private, rules/pack.json) that only the
// project's own server runs, until they are published (see that repo's
// rules/README.md: about 30 days, or until the wave is over), when
// signature rules move into src/threat-signatures.js through a skill vote.
//
// This file is NOT in src/, so it is not part of the skill id and changes no
// verdict. It may import from src/.
//
// Pack format (JSON):
//   { "version": 1, "refKey": "<random hex, optional>", "rules": [
//     { "id": "...", "addedAt": "2026-10-21", "publishAfter": "2026-11-20",
//       "kind": "signature" | "selectors" | "bytecode",
//       "reason": <a ThreatRegistry code fact, src/threat-reasons.js>,
//       "severity": "high" | "medium" | "low" | "info", ...kind fields } ] }
//   signature: the fields of a src/threat-signatures.js entry (fingerprint,
//     baseline, selectors, n, minhash; from `node cli.js signature`), plus
//     optional minPercent (60-100, default 60): matched with closestFlagged().
//   selectors: "selectors": 4-byte selectors ("a9059cbb") or signatures
//     ("transfer(address,uint256)") that together mark the pattern; "min":
//     how many must be there (default all); "anywhere": true to look at every
//     4-byte constant in the code, not only the functions it offers.
//   bytecode: "hex": a byte string found in the code, or "opcodes": a
//     sequence like "ORIGIN ? EQ" ("?" any one opcode, "*" up to 8, "PUSH*"
//     any PUSH, "DUP*", "SWAP*", "LOG*"), PUSH data ignored.
//
// What leaves the server: { warnings: [{ reason, severity, ref }] }. `ref` is
// an opaque id (HMAC of the rule id under the pack's refKey) so the team can
// tell rules apart in reports; the rule itself (its id, selectors, pattern,
// signature) never leaves, and nothing here logs the pack or the token.
//
// Honest limits: the endpoint is an oracle. Someone can deploy variants and
// ask until no warning shows; rate limits only slow that down. Warnings are
// advisory, can be wrong, and are not part of on-chain verdicts.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CHAINS, isChainAddress } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';
import { THREAT_REASONS } from '../src/threat-reasons.js';
import { THREAT_SIGNATURES } from '../src/threat-signatures.js';
import { closestFlagged, maskedOpcodes, MINHASH_K, THRESHOLDS } from '../src/similarity.js';
import { scanBytecode, minimalProxyTarget, hexToBytes, codeLengthWithoutMetadata } from '../src/bytecode.js';
import { codeFingerprint } from '../src/fingerprint.js';
import { selectorOf } from '../src/keccak.js';
import { decodeAddress } from '../src/abi.js';

export const KINDS = ['signature', 'selectors', 'bytecode'];
export const SEVERITIES = ['high', 'medium', 'low', 'info'];
const RANK = { high: 3, medium: 2, low: 1, info: 0 };
const REASONS = new Set(THREAT_REASONS.slice(1));
export const MAX_RULES = 2000;
export const MAX_WARNINGS = 5;
const GAP = 8; // "*" in an opcode pattern: up to this many opcodes

// ------------------------------------------------------------- opcodes
const OPNAMES = {
  0x00: 'STOP', 0x01: 'ADD', 0x02: 'MUL', 0x03: 'SUB', 0x04: 'DIV', 0x05: 'SDIV', 0x06: 'MOD', 0x07: 'SMOD',
  0x08: 'ADDMOD', 0x09: 'MULMOD', 0x0a: 'EXP', 0x0b: 'SIGNEXTEND', 0x10: 'LT', 0x11: 'GT', 0x12: 'SLT', 0x13: 'SGT',
  0x14: 'EQ', 0x15: 'ISZERO', 0x16: 'AND', 0x17: 'OR', 0x18: 'XOR', 0x19: 'NOT', 0x1a: 'BYTE', 0x1b: 'SHL',
  0x1c: 'SHR', 0x1d: 'SAR', 0x20: 'KECCAK256', 0x30: 'ADDRESS', 0x31: 'BALANCE', 0x32: 'ORIGIN', 0x33: 'CALLER',
  0x34: 'CALLVALUE', 0x35: 'CALLDATALOAD', 0x36: 'CALLDATASIZE', 0x37: 'CALLDATACOPY', 0x38: 'CODESIZE',
  0x39: 'CODECOPY', 0x3a: 'GASPRICE', 0x3b: 'EXTCODESIZE', 0x3c: 'EXTCODECOPY', 0x3d: 'RETURNDATASIZE',
  0x3e: 'RETURNDATACOPY', 0x3f: 'EXTCODEHASH', 0x40: 'BLOCKHASH', 0x41: 'COINBASE', 0x42: 'TIMESTAMP', 0x43: 'NUMBER',
  0x44: 'PREVRANDAO', 0x45: 'GASLIMIT', 0x46: 'CHAINID', 0x47: 'SELFBALANCE', 0x48: 'BASEFEE', 0x49: 'BLOBHASH',
  0x4a: 'BLOBBASEFEE', 0x50: 'POP', 0x51: 'MLOAD', 0x52: 'MSTORE', 0x53: 'MSTORE8', 0x54: 'SLOAD', 0x55: 'SSTORE',
  0x56: 'JUMP', 0x57: 'JUMPI', 0x58: 'PC', 0x59: 'MSIZE', 0x5a: 'GAS', 0x5b: 'JUMPDEST', 0x5c: 'TLOAD', 0x5d: 'TSTORE',
  0x5e: 'MCOPY', 0x5f: 'PUSH0', 0xf0: 'CREATE', 0xf1: 'CALL', 0xf2: 'CALLCODE', 0xf3: 'RETURN', 0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2', 0xfa: 'STATICCALL', 0xfd: 'REVERT', 0xfe: 'INVALID', 0xff: 'SELFDESTRUCT',
};
for (let i = 1; i <= 32; i++) OPNAMES[0x5f + i] = `PUSH${i}`;
for (let i = 1; i <= 16; i++) { OPNAMES[0x7f + i] = `DUP${i}`; OPNAMES[0x8f + i] = `SWAP${i}`; }
for (let i = 0; i <= 4; i++) OPNAMES[0xa0 + i] = `LOG${i}`;
const BYNAME = Object.fromEntries(Object.entries(OPNAMES).map(([k, v]) => [v, Number(k)]));
BYNAME.SHA3 = 0x20;
BYNAME.DIFFICULTY = 0x44;
const FAMILY = { 'PUSH*': [0x5f, 0x7f], 'DUP*': [0x80, 0x8f], 'SWAP*': [0x90, 0x9f], 'LOG*': [0xa0, 0xa4] };

/** "ORIGIN ? EQ" -> tokens: {any:true} | {gap:true} | {lo, hi}. Throws on an unknown name. */
export function parseOpcodes(pattern) {
  const words = Array.isArray(pattern) ? pattern.map(String) : String(pattern).trim().split(/[\s,]+/);
  if (words.length < 2 || words.length > 64) throw new Error('opcodes: 2 to 64 entries');
  const tokens = words.map((w) => {
    const u = w.toUpperCase();
    if (u === '?') return { any: true };
    if (u === '*') return { gap: true };
    if (FAMILY[u]) return { lo: FAMILY[u][0], hi: FAMILY[u][1] };
    if (!(u in BYNAME)) throw new Error('opcodes: unknown name');
    return { lo: BYNAME[u], hi: BYNAME[u] };
  });
  if (tokens[0].gap || tokens.at(-1).gap) throw new Error('opcodes: "*" only between opcodes');
  return tokens;
}

/** Does the opcode list (PUSH data dropped) contain the pattern? */
export function opcodesMatch(ops, tokens) {
  const at = (i, t) => {
    if (t === tokens.length) return true;
    const tok = tokens[t];
    if (tok.gap) {
      for (let skip = 0; skip <= GAP && i + skip <= ops.length; skip++) if (at(i + skip, t + 1)) return true;
      return false;
    }
    if (i >= ops.length) return false;
    if (!tok.any && (ops[i] < tok.lo || ops[i] > tok.hi)) return false;
    return at(i + 1, t + 1);
  };
  for (let i = 0; i < ops.length; i++) if (at(i, 0)) return true;
  return false;
}

// ---------------------------------------------------------------- pack
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SEL = /^(0x)?[0-9a-fA-F]{8}$/;
const SIG = /^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_,[\]() ]*\)$/;

function normalizeSelector(s) {
  if (typeof s !== 'string') throw new Error('selectors: strings only');
  if (SEL.test(s)) return s.replace(/^0x/, '').toLowerCase();
  if (SIG.test(s)) return selectorOf(s.replace(/\s+/g, ''));
  throw new Error('selectors: not a selector or signature');
}

/**
 * One rule -> its normalized form. Throws with a message that names the
 * field only (never the value: the pack is private).
 */
export function normalizeRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('not an object');
  if (typeof r.id !== 'string' || !ID.test(r.id)) throw new Error('id');
  if (!KINDS.includes(r.kind)) throw new Error('kind');
  if (!REASONS.has(r.reason)) throw new Error('reason');
  if (!SEVERITIES.includes(r.severity)) throw new Error('severity');
  for (const k of ['addedAt', 'publishAfter']) {
    if (typeof r[k] !== 'string' || Number.isNaN(Date.parse(r[k]))) throw new Error(k);
  }
  const base = { id: r.id, kind: r.kind, reason: r.reason, severity: r.severity, addedAt: r.addedAt, publishAfter: r.publishAfter };
  if (r.kind === 'signature') {
    if (!/^fp1:[0-9a-f]{64}$/.test(r.fingerprint ?? '')) throw new Error('fingerprint');
    if (typeof r.baseline !== 'string') throw new Error('baseline');
    if (!Array.isArray(r.selectors) || r.selectors.some((s) => !/^[0-9a-f]{8}$/.test(s))) throw new Error('selectors');
    if (!Number.isInteger(r.n) || r.n < 0) throw new Error('n');
    if (typeof r.minhash !== 'string' || !new RegExp(`^[0-9a-f]{${MINHASH_K * 8}}$`).test(r.minhash)) throw new Error('minhash');
    // closestFlagged reports from THRESHOLDS.low (60%); a rule may ask for more.
    const minPercent = r.minPercent ?? THRESHOLDS.low * 100;
    if (!Number.isInteger(minPercent) || minPercent < THRESHOLDS.low * 100 || minPercent > 100) throw new Error('minPercent');
    return { ...base, minPercent, entry: { fingerprint: r.fingerprint, baseline: r.baseline, selectors: r.selectors, n: r.n, minhash: r.minhash, reason: r.reason, flag: null } };
  }
  if (r.kind === 'selectors') {
    if (!Array.isArray(r.selectors) || r.selectors.length < 1 || r.selectors.length > 64) throw new Error('selectors');
    const selectors = [...new Set(r.selectors.map(normalizeSelector))];
    const min = r.min ?? selectors.length;
    if (!Number.isInteger(min) || min < 1 || min > selectors.length) throw new Error('min');
    return { ...base, selectors, min, anywhere: r.anywhere === true };
  }
  // bytecode
  if ((r.hex == null) === (r.opcodes == null)) throw new Error('hex or opcodes');
  if (r.hex != null) {
    if (typeof r.hex !== 'string' || !/^(0x)?([0-9a-fA-F]{2}){2,1024}$/.test(r.hex)) throw new Error('hex');
    return { ...base, hex: r.hex.replace(/^0x/, '').toLowerCase() };
  }
  return { ...base, opcodes: parseOpcodes(r.opcodes) };
}

/**
 * Parses a pack (object or JSON text). Throws only when the pack as a whole
 * is unusable; a bad rule is dropped and counted in `invalid`.
 * @returns {{version:number, digest:string, refKey:string, rules:Array, invalid:number}}
 */
export function parsePack(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  let p;
  try { p = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('pack: not JSON'); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('pack: not an object');
  if (!Number.isInteger(p.version) || p.version < 1) throw new Error('pack: version');
  if (!Array.isArray(p.rules) || p.rules.length > MAX_RULES) throw new Error('pack: rules');
  const digest = createHash('sha256').update(text).digest('hex');
  // Without its own refKey, refs are keyed by the private pack's digest.
  const refKey = typeof p.refKey === 'string' && p.refKey.length >= 16 ? p.refKey : digest;
  const rules = [];
  const seen = new Set();
  let invalid = 0;
  for (const r of p.rules) {
    try {
      const n = normalizeRule(r);
      if (seen.has(n.id)) throw new Error('duplicate id');
      seen.add(n.id);
      rules.push(n);
    } catch {
      invalid++;
    }
  }
  return { version: p.version, digest, refKey, rules, invalid };
}

/** Opaque reference for a rule: "ew-" + 12 hex of HMAC-SHA256(refKey, id). */
export function refOf(pack, rule) {
  return 'ew-' + createHmac('sha256', pack.refKey).update(rule.id).digest('hex').slice(0, 12);
}

/** NEURO_PRIVATE_RULES: JSON text, or the same as base64. */
export function decodeEnvPack(value) {
  const s = String(value).trim();
  if (s.startsWith('{')) return s;
  const text = Buffer.from(s, 'base64').toString('utf8');
  if (!text.trim().startsWith('{')) throw new Error('pack: neither JSON nor base64 JSON');
  return text;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
export const DEFAULT_REPO = 'pospos191-alt/zetaphy-private';
export const DEFAULT_PATH = 'rules/pack.json';

/**
 * Where the pack comes from: (a) env NEURO_PRIVATE_RULES (JSON or base64
 * JSON), else (b) a file in a private GitHub repo read with a read-only token
 * (NEURO_RULES_TOKEN, NEURO_RULES_REPO, NEURO_RULES_PATH), cached for ttlMs.
 * A failed refresh keeps serving the last good pack and retries after
 * retryMs. Never logs the pack or the token.
 * @returns {{configured:boolean, source:'env'|'github'|null, load:() => Promise<object|null>}}
 */
export function createPackLoader({ env = process.env, fetchImpl = globalThis.fetch, ttlMs = 10 * 60_000, retryMs = 60_000, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const inline = env.NEURO_PRIVATE_RULES;
  if (inline && String(inline).trim()) {
    let pack = null;
    try { pack = parsePack(decodeEnvPack(inline)); } catch { pack = null; }
    return { configured: true, source: 'env', load: async () => pack };
  }
  const token = env.NEURO_RULES_TOKEN;
  if (!token || !String(token).trim()) return { configured: false, source: null, load: async () => null };
  const repo = env.NEURO_RULES_REPO || DEFAULT_REPO;
  const path = env.NEURO_RULES_PATH || DEFAULT_PATH;
  if (!REPO.test(repo) || !PATH.test(path) || path.split('/').includes('..')) {
    return { configured: true, source: 'github', load: async () => null };
  }
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  let cached = null; // { pack, at }
  let nextTry = 0;
  let inflight = null;

  async function fetchPack() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${String(token).trim()}`,
          accept: 'application/vnd.github.raw+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'zetaphy-neuro-early-warning',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`rules HTTP ${res.status}`);
      return parsePack(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.pack;
    if (t < nextTry) return cached?.pack ?? null;
    inflight ??= fetchPack().then(
      (pack) => { cached = { pack, at: now() }; return pack; },
      () => { nextTry = now() + retryMs; return cached?.pack ?? null; },
    ).finally(() => { inflight = null; });
    return inflight;
  }

  return { configured: true, source: 'github', load };
}

// ----------------------------------------------------------- matching
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SLOT_ZOS_IMPL = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * The code at an EVM address, and the code it runs behind a proxy (EIP-1167
 * clone, EIP-1967 / ZeppelinOS slot, EIP-1967 beacon, EIP-7702 delegation).
 * @returns {Promise<{code:string, logic:string|null}|null>} null: no EVM bytecode there
 */
export async function readCodes(rpc, address) {
  const getCode = async (a) => {
    const c = await rpc.call('eth_getCode', [a, 'latest']);
    return c && c !== '0x' ? String(c).toLowerCase() : null;
  };
  const code = await getCode(address);
  if (!code) return null;
  let target = null;
  const delegated = /^0xef0100([0-9a-f]{40})$/.exec(code);
  if (delegated) target = '0x' + delegated[1];
  else if (code.startsWith('0xef')) return null; // Stylus or another non-EVM format
  else target = minimalProxyTarget(hexToBytes(code));
  if (!target) {
    const slot = async (s) => {
      const a = decodeAddress(await rpc.call('eth_getStorageAt', [address, s, 'latest']));
      return a && a !== ZERO ? a : null;
    };
    target = (await slot(SLOT_IMPL)) ?? (await slot(SLOT_ZOS_IMPL));
    if (!target) {
      const beacon = await slot(SLOT_BEACON);
      if (beacon) {
        try { target = decodeAddress(await rpc.call('eth_call', [{ to: beacon, data: '0x5c60da1b' }, 'latest'])); } catch { target = null; }
      }
    }
  }
  const logic = target && target !== ZERO ? await getCode(target) : null;
  if (delegated && !logic) return null;
  return { code: delegated ? logic : code, logic: delegated ? null : logic };
}

/** Every 1-4 byte PUSH value in the code, as an 8-hex selector. */
function pushedSelectors(codeHex) {
  const code = hexToBytes(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const out = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n <= 4 && pc + n < code.length) {
        out.add(Array.from(code.subarray(pc + 1, pc + 1 + n), (b) => b.toString(16).padStart(2, '0')).join('').padStart(8, '0'));
      }
      pc += n;
    }
  }
  return out;
}

/** Everything the rules look at, computed once per contract. */
export async function codeContext({ code, logic }) {
  const codes = [code, ...(logic ? [logic] : [])];
  const runs = logic ?? code;
  const strip = (c) => {
    const b = hexToBytes(c);
    return c.replace(/^0x/, '').slice(0, codeLengthWithoutMetadata(b) * 2);
  };
  return {
    codes,
    runs,
    fingerprint: await codeFingerprint(runs),
    hex: codes.map(strip),
    ops: codes.map((c) => maskedOpcodes(c)),
    offered: new Set(codes.flatMap((c) => scanBytecode(c).selectors)),
    pushed: new Set(codes.flatMap((c) => [...pushedSelectors(c)])),
  };
}

/** Does one normalized rule match this contract? */
export function matchRule(rule, ctx) {
  switch (rule.kind) {
    case 'signature': {
      const hit = closestFlagged(ctx.runs, ctx.fingerprint, { baseline: THREAT_SIGNATURES.baseline, entries: [rule.entry] });
      // closestFlagged reports from 60%; a rule may ask for more.
      return !!hit && hit.percent >= rule.minPercent;
    }
    case 'selectors': {
      const have = rule.anywhere ? ctx.pushed : ctx.offered;
      return rule.selectors.filter((s) => have.has(s)).length >= rule.min;
    }
    case 'bytecode':
      if (rule.hex) {
        // Whole bytes only: an odd offset would match across two bytes.
        return ctx.hex.some((h) => {
          for (let i = h.indexOf(rule.hex); i >= 0; i = h.indexOf(rule.hex, i + 1)) if (i % 2 === 0) return true;
          return false;
        });
      }
      return ctx.ops.some((ops) => opcodesMatch(ops, rule.opcodes));
    default:
      return false;
  }
}

/**
 * The public answer for a contract: only reason, severity and an opaque ref
 * per matched rule, most severe first, at most MAX_WARNINGS.
 */
export function warningsFor(pack, ctx) {
  const out = [];
  for (const rule of pack.rules) {
    let hit = false;
    try { hit = matchRule(rule, ctx); } catch { hit = false; }
    if (hit) out.push({ reason: rule.reason, severity: rule.severity, ref: refOf(pack, rule) });
  }
  out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.ref < b.ref ? -1 : 1));
  return out.slice(0, MAX_WARNINGS);
}

// --------------------------------------------------------- abuse limits
/**
 * Fixed-window limits per client and for this instance as a whole. Clients
 * are kept as an HMAC of their IP under a per-process random key, never the IP.
 */
export function memoryLimiter({ perMinute = 12, perDay = 300, globalPerMinute = 600, now = () => Date.now() } = {}) {
  const key = randomBytes(32);
  const windows = new Map();
  let lastSweep = 0;
  const hit = (k, size, limit, t) => {
    const start = t - (t % size);
    let w = windows.get(k);
    if (!w || w.start !== start) { w = { start, size, count: 0 }; windows.set(k, w); }
    w.count++;
    return w.count <= limit ? 0 : Math.ceil((start + size - t) / 1000);
  };
  return {
    async check(ip) {
      const t = now();
      if (t - lastSweep > 60_000) {
        for (const [k, w] of windows) if (t >= w.start + w.size) windows.delete(k);
        lastSweep = t;
      }
      const id = createHmac('sha256', key).update(String(ip ?? '')).digest('hex').slice(0, 32);
      const waits = [
        hit(`g:m`, 60_000, globalPerMinute, t),
        hit(`m:${id}`, 60_000, perMinute, t),
        hit(`d:${id}`, 86_400_000, perDay, t),
      ];
      const wait = Math.max(...waits);
      return wait ? { ok: false, retryAfter: wait } : { ok: true };
    },
  };
}

/**
 * The same limits in Redis (server/usage.js upstashStore), shared by every
 * serverless instance. Clients are HMAC(secret, ip). Falls back to `fallback`
 * (a memoryLimiter) if Redis fails.
 */
export function redisLimiter(store, secret, { perMinute = 12, perDay = 300, now = () => Date.now(), fallback = memoryLimiter() } = {}) {
  return {
    async check(ip) {
      const t = now();
      const id = createHmac('sha256', secret).update(`ew|${ip ?? ''}`).digest('hex').slice(0, 32);
      const minute = Math.floor(t / 60_000);
      const day = new Date(t).toISOString().slice(0, 10);
      const m = `neuro:ew:m:${minute}:${id}`;
      const d = `neuro:ew:d:${day}:${id}`;
      try {
        const [perM, , perD] = await store.pipeline([['INCR', m], ['EXPIRE', m, 120], ['INCR', d], ['EXPIRE', d, 2 * 86400]]);
        if (Number(perM) > perMinute) return { ok: false, retryAfter: 60 - Math.floor((t % 60_000) / 1000) };
        if (Number(perD) > perDay) return { ok: false, retryAfter: 3600 };
        return { ok: true };
      } catch {
        return fallback.check(ip);
      }
    },
  };
}

// ------------------------------------------------------------- handler
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return null; } };

/** A small time-limited cache of answers per (pack, chain, address). */
export function answerCache({ ttlMs = 5 * 60_000, max = 1000, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) { m.delete(k); return undefined; }
      return e.value;
    },
    set(k, value) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { value, at: now() });
    },
  };
}

/** Public RPCs of a chain (src/chains.js), as the web page uses them. */
export const defaultRpcFor = (chainKey) => createRpc(CHAINS[chainKey].rpcs, CHAINS[chainKey].id);

/**
 * Framework-free handler for POST /api/early-warning with {chain, address}.
 * @param {{method:string, body?:any, ip?:string, origin?:string, host?:string}} req
 * @param {{loader:object, limiter:{check:Function}, cache?:object, rpcFor?:Function}} deps
 * @returns {Promise<{status:number, json:object, headers?:object}>}
 */
export async function handleEarlyWarning(req, { loader, limiter, cache = answerCache(), rpcFor = defaultRpcFor }) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'POST') return { status: 405, json: { error: 'method' }, headers: { ...headers, allow: 'POST' } };
  // Browsers send Origin on cross-site POSTs; refuse other sites' pages.
  if (req.origin && req.host && hostOf(req.origin) !== req.host) return { status: 403, json: { error: 'origin' }, headers };
  const b = req.body;
  const ok = b && typeof b === 'object' && !Array.isArray(b)
    && typeof b.chain === 'string' && b.chain.length <= 32 && Object.hasOwn(CHAINS, b.chain)
    && typeof b.address === 'string' && b.address.length <= 128 && isChainAddress(b.chain, b.address);
  if (!ok) return { status: 400, json: { error: 'input' }, headers };
  if (!loader?.configured) return { status: 200, json: { warnings: [], configured: false }, headers };
  // The rule kinds read EVM bytecode; other chains have nothing to match.
  if (CHAINS[b.chain].kind !== 'evm') return { status: 200, json: { warnings: [], configured: true }, headers };

  const limit = await limiter.check(req.ip);
  if (!limit.ok) return { status: 429, json: { error: 'rate' }, headers: { ...headers, 'retry-after': String(limit.retryAfter) } };

  const pack = await loader.load();
  if (!pack) return { status: 503, json: { error: 'unavailable' }, headers };
  const address = b.address.toLowerCase();
  const key = `${pack.digest}:${b.chain}:${address}`;
  let warnings = cache.get(key);
  if (!warnings) {
    let codes;
    try { codes = await readCodes(rpcFor(b.chain), address); } catch { return { status: 502, json: { error: 'chain' }, headers }; }
    warnings = codes ? warningsFor(pack, await codeContext(codes)) : [];
    cache.set(key, warnings);
  }
  return { status: 200, json: { warnings, configured: true }, headers };
}
