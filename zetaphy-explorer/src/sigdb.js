// Signature lookups for decoding without a verified ABI: this repo's own contracts
// (src/known-abi.js, written by `npm run build`) first, then the small common table
// (src/sigs.js). Also recognises a deployed copy of one of this repo's contracts:
// by its address in the deployment records, its exact runtime code hash, its Neuro
// fp1 fingerprint (immutables and metadata blanked), or, as a guess, its selectors.
import { parseCompact, keccakHex } from './abi.js';
import { COMMON } from './sigs.js';
import { hexToBytes, fingerprint1 } from '../vendor/zetaphy-lib.js';

let knownPromise = null;
/** src/known-abi.js is ~150 KB: loaded only by the pages that decode. */
export const loadKnown = () => (knownPromise ??= import('./known-abi.js').then((m) => m.KNOWN));

/** PUSH4 operands (function selectors in a Solidity / Vyper dispatcher) and PUSH32 operands (event topics) of runtime code. */
export function codeConstants(code) {
  const b = typeof code === 'string' ? hexToBytes(code) : code;
  const push4 = new Set(); const push32 = new Set();
  const hex = (s, e) => Array.from(b.subarray(s, e), (x) => x.toString(16).padStart(2, '0')).join('');
  for (let pc = 0; pc < b.length; pc++) {
    const op = b[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63 && pc + 5 <= b.length) push4.add(hex(pc + 1, pc + 5));
      if (op === 0x7f && pc + 33 <= b.length) push32.add('0x' + hex(pc + 1, pc + 33));
      pc += n;
    }
  }
  return { push4, push32 };
}

/** A lookup over a KNOWN table (tests pass their own; the app passes loadKnown()'s). */
export function makeSigDb(K = { functions: [], events: [], errors: [], contracts: [], addresses: {} }) {
  const idx = { function: new Map(), event: new Map(), error: new Map() };
  const add = (kind, key, compact, source) => { const m = idx[kind]; if (!m.has(key)) m.set(key, []); m.get(key).push({ compact, source }); };
  for (const [k, s] of K.functions) add('function', k, s, 'known');
  for (const [k, s] of K.events) add('event', k, s, 'known');
  for (const [k, s] of K.errors) add('error', k, s, 'known');
  for (const [kind, list] of [['function', COMMON.functions], ['event', COMMON.events], ['error', COMMON.errors]]) {
    for (const s of list) {
      const f = parseCompact(kind, s);
      add(kind, kind === 'event' ? f.topic.slice(2, 18) : f.selector, s, 'common');
    }
  }
  const parsed = new Map();
  const frag = (kind, s) => {
    const k = `${kind}|${s}`;
    if (!parsed.has(k)) { try { parsed.set(k, parseCompact(kind, s)); } catch { parsed.set(k, null); } }
    return parsed.get(k);
  };
  /**
   * [{ fragment, source: 'known' | 'common' }], one per distinct canonical signature. For a guess by
   * selector alone the common table comes first: its standard parameter names read best.
   */
  function lookup(kind, key, full) {
    const seen = new Set(); const out = [];
    const list = idx[kind].get(key) ?? [];
    for (const { compact, source } of [...list.filter((x) => x.source === 'common'), ...list.filter((x) => x.source !== 'common')]) {
      const f = frag(kind, compact);
      if (!f || (full && (f.topic ?? f.selector) !== full) || seen.has(f.signature + '|' + f.inputs.map((p) => p.indexed ? 'i' : '').join())) continue;
      seen.add(f.signature + '|' + f.inputs.map((p) => p.indexed ? 'i' : '').join());
      out.push({ fragment: f, source });
    }
    return out;
  }
  const contractCache = new Map();
  function contract(i) {
    const c = K.contracts[i];
    if (!c) return null;
    if (!contractCache.has(i)) {
      contractCache.set(i, { name: c.name, repo: c.source, codeHash: c.codeHash ?? null, fp1: c.fp1 ?? null, abi: {
        functions: c.f.map((j) => frag('function', K.functions[j][1])).filter(Boolean),
        events: c.e.map((j) => frag('event', K.events[j][1])).filter(Boolean),
        errors: c.r.map((j) => frag('error', K.errors[j][1])).filter(Boolean),
      } });
    }
    return contractCache.get(i);
  }
  return {
    functions: (selector) => lookup('function', String(selector).replace(/^0x/, '').toLowerCase()),
    events: (topic) => { const t = String(topic).toLowerCase(); return lookup('event', t.slice(2, 18), t); },
    errors: (selector) => lookup('error', String(selector).replace(/^0x/, '').toLowerCase()),
    contract,
    /**
     * One of this repo's contracts at `address` with runtime `code`, or null:
     * { contract, label, matchedBy: 'address' | 'codeHash' | 'fp1' | 'selectors' }.
     * 'selectors' (every function of the contract is in the code's dispatcher) is a guess.
     */
    recognise(address, code) {
      if (typeof code !== 'string' || code.length <= 2 || !/^0x([0-9a-fA-F]{2})+$/.test(code)) return null;
      const byAddr = K.addresses[String(address).toLowerCase()];
      if (byAddr) return { contract: contract(byAddr[0]), label: byAddr[1], matchedBy: 'address' };
      const hash = '0x' + keccakHex(hexToBytes(code));
      let i = K.contracts.findIndex((c) => c.codeHash === hash);
      if (i >= 0) return { contract: contract(i), label: null, matchedBy: 'codeHash' };
      let fp = null;
      try { fp = fingerprint1(code); } catch { fp = null; }
      i = fp ? K.contracts.findIndex((c) => c.fp1 === fp) : -1;
      if (i >= 0) return { contract: contract(i), label: null, matchedBy: 'fp1' };
      const { push4 } = codeConstants(code);
      let best = -1; let bestN = 0;
      K.contracts.forEach((c, j) => {
        if (!c.codeHash || c.f.length < 3) return;
        const sels = c.f.map((x) => K.functions[x][0]);
        if (sels.every((s) => push4.has(s)) && sels.length > bestN) { best = j; bestN = sels.length; }
      });
      return best >= 0 ? { contract: contract(best), label: null, matchedBy: 'selectors' } : null;
    },
    /** Functions and events a contract without an ABI seems to have, from the selectors and topics in its code (guessed). */
    guessAbi(code) {
      const { push4, push32 } = codeConstants(code);
      const functions = []; const events = []; const errors = [];
      for (const s of push4) {
        const f = lookup('function', s)[0]; if (f) functions.push(f.fragment);
        const e = lookup('error', s)[0]; if (e) errors.push(e.fragment);
      }
      for (const t of push32) for (const e of lookup('event', t.slice(2, 18), t)) events.push(e.fragment);
      return { functions, events, errors };
    },
  };
}
