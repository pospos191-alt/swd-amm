// Similarity to reference code (EVM bytecode only): code that Neuro runners
// flagged in the ThreatRegistry, or a reference sample of a known-bad pattern.
//
// The fingerprint (src/fingerprint.js) matches a template exactly: change one
// instruction and it no longer matches. A copy of flagged code that
// renames a function, adds a getter or moves a check gets a new
// fingerprint. This file measures how CLOSE two contracts are, with cheap,
// deterministic signals (integer hashing only, no AI, no randomness, no
// floating-point surprises: the same numbers on every machine).
//
// 1. Mask: walk the opcodes and drop every PUSH's data (addresses,
//    constants, jump targets) and the compiler metadata. Changing a constant
//    or moving code around hardly changes what is left.
// 2. Shingle: hash every run of NGRAM consecutive opcodes (FNV-1a, 32 bit).
// 3. Remove the boilerplate: most flagged code is an ordinary ERC-20 with a
//    few lines changed, so two ordinary tokens and flagged code share most of their
//    shingles. Shingles (and dispatcher selectors) found in the BASELINE, the
//    code of honest reference tokens (scripts/baseline-tokens.sol: minimal
//    ERC-20s and OpenZeppelin-style ERC-20 + Pausable / Permit / Burnable /
//    Capped / Ownable / Ownable2Step / AccessControl / a plain blacklist,
//    optimizer on and off; src/threat-signatures.generated.js), are dropped.
//    What remains is what makes this contract different, so library code alone
//    never makes an honest token look similar.
// 4. Compare: Jaccard similarity of the remaining shingle sets, estimated
//    with a MinHash of MINHASH_K 32-bit hashes (so a dataset entry is about
//    1 KB), and Jaccard of the remaining selector sets. Renaming functions
//    is the cheapest way to dodge a selector match, so selectors can only
//    raise the score: score = max(opcodes, (opcodes + selectors) / 2).
//
// INFORMATIONAL, not proof:
// - Provenance: an entry says "flagged by runners" only when it carries an
//   on-chain reference (flag: {key, reportHash}: the ThreatRegistry key and
//   the evidence reportHash of the flag vote). Without one it is a "reference
//   sample" and is worded that way (finding similar-reference).
// - Severity is at most medium. Only an EXACT fingerprint match to an entry
//   with an on-chain flag reference is high (the same code the network flagged).
// - Evasion: this catches lazy copies, not a determined author. Inserting
//   filler opcodes (e.g. PUSH/POP pairs) every few instructions, reordering
//   functions, or recompiling with another solc version or optimizer setting
//   changes most 4-grams, so the score drops below the threshold. Missing a
//   copy is expected; the fixed rules and the trade simulation still apply.
// - A second feature (e.g. a selector-set + storage-slot sketch) was
//   considered: selectors are already compared above, and storage slots move
//   with inheritance order and packing, so it would add little robustness for
//   its cost. Not added.
//
// Other VMs are not covered: Solana, Move, TON, CosmWasm, NEAR, Starknet and
// Bitcoin runes are read through their on-chain settings, not their code, and
// Stylus WASM is not sampled yet.

import { hexToBytes, codeLengthWithoutMetadata, scanBytecode } from './bytecode.js';
import { codeFingerprint } from './fingerprint.js';

export const SIMILARITY_VERSION = 'sim1';
export const NGRAM = 4;
export const MINHASH_K = 128;
/** Report from `low`; severity grows with the score. */
export const THRESHOLDS = { low: 0.6, medium: 0.75, high: 0.9 };
/** Code with fewer distinctive shingles than this is all boilerplate: not compared. */
export const MIN_SHINGLES = 8;

const PUSH1 = 0x60;
const PUSH32 = 0x7f;

// murmur3's 32-bit finaliser; Math.imul keeps it exact in JS.
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const hex8 = (n) => n.toString(16).padStart(8, '0');

/** Opcode bytes of runtime code, PUSH data and metadata dropped. */
export function maskedOpcodes(codeHex) {
  const code = hexToBytes(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const ops = [];
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    ops.push(op);
    if (op >= PUSH1 && op <= PUSH32) pc += op - PUSH1 + 1;
  }
  return ops;
}

/** Set of 32-bit FNV-1a hashes of the opcode n-grams. */
export function shingles(codeHex) {
  const ops = maskedOpcodes(codeHex);
  const out = new Set();
  for (let i = 0; i + NGRAM <= ops.length; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < NGRAM; j++) h = Math.imul(h ^ ops[i + j], 0x01000193);
    out.add(h >>> 0);
  }
  return out;
}

/** MinHash: for each of K hash functions, the smallest value over the set. */
export function minhash(set) {
  const mins = new Array(MINHASH_K).fill(0xffffffff);
  for (const s of set) {
    for (let k = 0; k < MINHASH_K; k++) {
      const v = fmix32((s ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);
      if (v < mins[k]) mins[k] = v;
    }
  }
  return mins.map(hex8).join('');
}

/** Baseline in its stored form -> {id, shingles:Set<number>, selectors:Set<string>}. */
export function loadBaseline(b) {
  const sh = new Set();
  for (let i = 0; i < b.shingles.length; i += 8) sh.add(parseInt(b.shingles.slice(i, i + 8), 16));
  return { id: b.id, shingles: sh, selectors: new Set(b.selectors) };
}

/** Stored form of a baseline built from reference runtime codes. */
export async function buildBaseline(codes) {
  const sh = new Set();
  const sel = new Set();
  for (const c of codes) {
    for (const x of shingles(c)) sh.add(x);
    for (const s of scanBytecode(c).selectors) sel.add(s);
  }
  const shingleHex = [...sh].sort((a, b) => a - b).map(hex8).join('');
  const selectors = [...sel].sort();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(shingleHex + selectors.join('')));
  const id = Array.from(new Uint8Array(digest).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
  return { id, selectors, shingles: shingleHex };
}

/**
 * Compact signature of EVM runtime code, minus the baseline.
 * @param {string} codeHex
 * @param {{id:string, shingles:Set<number>, selectors:Set<string>}} baseline  from loadBaseline
 * @returns {{baseline:string, selectors:string[], n:number, minhash:string}}
 */
export function similaritySignature(codeHex, baseline) {
  const own = [...shingles(codeHex)].filter((x) => !baseline.shingles.has(x));
  const selectors = scanBytecode(codeHex).selectors.filter((s) => !baseline.selectors.has(s));
  return { baseline: baseline.id, selectors, n: own.length, minhash: minhash(own) };
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Share of the K MinHash slots that agree: an estimate of the sets' Jaccard. */
export function minhashSimilarity(a, b) {
  if (a.length !== b.length || !a.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 8) if (a.slice(i, i + 8) === b.slice(i, i + 8)) same++;
  return same / (a.length / 8);
}

/** Whole percent 0..100 (integers, so every machine prints and compares the same). */
export function similarityPercent(a, b) {
  if (a.n < MIN_SHINGLES || b.n < MIN_SHINGLES) return 0;
  const op = minhashSimilarity(a.minhash, b.minhash);
  const sel = jaccard(a.selectors, b.selectors);
  return Math.round(Math.max(op, (op + sel) / 2) * 100);
}

/** Severity for a percent, or null under the reporting threshold (before the cap in closestFlagged). */
export function severityFor(percent) {
  if (percent >= THRESHOLDS.high * 100) return 'high';
  if (percent >= THRESHOLDS.medium * 100) return 'medium';
  if (percent >= THRESHOLDS.low * 100) return 'low';
  return null;
}

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO32 = '0x' + '0'.repeat(64);
/**
 * True when an entry names the on-chain flag behind it: the ThreatRegistry key
 * (fp1 / code / address key, bytes32) and the reportHash of the flag's
 * evidence (non-zero). Only such entries may be called "flagged by runners".
 */
export function hasFlagRef(e) {
  const f = e?.flag;
  return !!f && BYTES32.test(f.key ?? '') && BYTES32.test(f.reportHash ?? '') && f.key !== ZERO32 && f.reportHash !== ZERO32;
}

/**
 * The dataset entry closest to this code, if close enough.
 * @param {string} codeHex  runtime code that actually runs
 * @param {string|null} fingerprint  its fp1 (an exact match is 100%)
 * @param {{baseline:object, entries:Array}} dataset  src/threat-signatures.js
 * @returns {{percent:number, severity:string, fingerprint:string, reason:string, flagged:boolean, exact:boolean}|null}
 *   flagged: the entry has an on-chain flag reference (hasFlagRef); severity is
 *   capped at medium unless the match is exact AND flagged.
 */
export function closestFlagged(codeHex, fingerprint, dataset) {
  if (!dataset?.entries?.length) return null;
  const sig = similaritySignature(codeHex, dataset.baseline);
  let best = null;
  for (const e of dataset.entries) {
    if (e.baseline !== dataset.baseline.id) continue; // made against another baseline: rebuild it
    const exact = !!fingerprint && e.fingerprint === fingerprint;
    const percent = exact ? 100 : similarityPercent(sig, e);
    const flagged = hasFlagRef(e);
    // Ties: an entry with an on-chain flag first, then the smaller fingerprint,
    // so every runner names the same one.
    if (!best || percent > best.percent || (percent === best.percent
      && (flagged > best.flagged || (flagged === best.flagged && e.fingerprint < best.fingerprint)))) {
      best = { percent, fingerprint: e.fingerprint, reason: e.reason, flagged, exact };
    }
  }
  let severity = best && severityFor(best.percent);
  if (severity === 'high' && !(best.exact && best.flagged)) severity = 'medium';
  return severity ? { ...best, severity } : null;
}

/**
 * A dataset entry for runtime code (scripts/build-threat-signatures.js and
 * `node cli.js signature`). `flag` ({key, reportHash}, both 0x + 32 bytes):
 * the ThreatRegistry flag this code is recorded under; null for a reference sample.
 */
export async function makeEntry(codeHex, baseline, { reason, source, flag = null }) {
  const f = flag ? { key: String(flag.key).toLowerCase(), reportHash: String(flag.reportHash).toLowerCase() } : null;
  if (f && !hasFlagRef({ flag: f })) throw new Error('flag: key and reportHash must be non-zero 0x + 32-byte hex');
  return { fingerprint: await codeFingerprint(codeHex), reason, source, flag: f, ...similaritySignature(codeHex, baseline) };
}

/** An entry as JavaScript source, ready to paste into src/threat-signatures.js. */
export function entrySource(e, indent = '  ') {
  const q = (v) => JSON.stringify(v).replace(/"/g, "'").replace(/,/g, ', ');
  const chunk = (x) => x.match(/.{1,96}/g).map((c) => `${indent}    '${c}'`).join(' +\n');
  return `${indent}{
${indent}  fingerprint: '${e.fingerprint}',
${indent}  reason: '${e.reason}',
${indent}  source: ${JSON.stringify(String(e.source)).replace(/'/g, "\\'").replace(/^"|"$/g, "'")},
${indent}  flag: ${e.flag ? `{ key: '${e.flag.key}', reportHash: '${e.flag.reportHash}' }` : 'null'},
${indent}  baseline: '${e.baseline}',
${indent}  selectors: ${q(e.selectors)},
${indent}  n: ${e.n},
${indent}  minhash:
${chunk(e.minhash)},
${indent}},`;
}
