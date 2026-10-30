// Vaccines: when an exploit (or drainer, or scam contract) is confirmed, a detector is DERIVED from it and shipped
// with the flag (its sha256 is the flag's `vaccine` on chain; the vaccine itself rides in the feed), so the sentinels
// on every chain at once scan new deployments for clones of it:
//   - exact:       the same runtime code (EXTCODEHASH)
//   - fingerprint: Neuro's fp1 (addresses and 32-byte constants masked): a redeploy with a new owner or target
//   - similar:     opcode-shingle MinHash + distinctive selectors (zetaphy-neuro/src/similarity.js, honest ERC-20
//                  baseline removed): a recompile with renamed functions, moved checks or a changed constant
//   - selectors:   most of the exploit's distinctive selectors (flash-loan callbacks + drain entry points)
// Non-EVM: a CosmWasm code checksum (sha256 of the wasm) or a Solana program's data hash, matched exactly.
// Deterministic integer math only: every sentinel and runner gets the same score.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { shingles, minhash, similarityPercent, loadBaseline, THRESHOLDS } from '../../../zetaphy-neuro/src/similarity.js';
import { scanBytecode } from '../../../zetaphy-neuro/src/bytecode.js';
import { BASELINE } from '../../../zetaphy-neuro/src/threat-signatures.generated.js';
import { fingerprint1 } from '../vaccine.js';
import { canonical, contentHash, toHex, fromHex } from './evidence.js';

export const VACCINE_FORMAT = 'zetaphy.immune.vaccine.v1';
const BASE = loadBaseline(BASELINE);
/** Default similarity (percent) that counts as a clone: Neuro's "medium" threshold. */
export const CLONE_THRESHOLD = Math.round(THRESHOLDS.medium * 100);

export const codeHashOf = (code) => toHex(keccak_256(fromHex(code)));

/** The similarity signature of runtime code (baseline removed). */
export function signatureOf(code) {
  const own = [...shingles(code)].filter((x) => !BASE.shingles.has(x));
  const selectors = scanBytecode(code).selectors.filter((s) => !BASE.selectors.has(s)).sort();
  return { baseline: BASE.id, selectors, n: own.length, minhash: minhash(own) };
}

/** Opcode facts a vaccine records (and a match reports). */
function opcodeFacts(code) {
  const s = scanBytecode(code);
  return { delegatecall: !!s.opcodes?.delegatecall, selfdestruct: !!s.opcodes?.selfdestruct, call: !!s.opcodes?.call, create2: !!s.opcodes?.create2 };
}

/** Adds the content id: sha256 of the canonical vaccine without `id` (the on-chain `vaccine`). */
function sealed(v) {
  const { id: _drop, ...rest } = v;
  return { ...rest, id: contentHash(rest).evidenceHash };
}

/**
 * Derives a vaccine from confirmed bad EVM runtime code.
 * @param {object} o  { code, chainId, address, kind, label, callPattern: {flashLoan, minSwaps} | null, threshold }
 */
export function deriveVaccine({ code, chainId, address = null, kind = 1, label = '', callPattern = null, threshold = CLONE_THRESHOLD }) {
  if (!/^0x([0-9a-f]{2})+$/i.test(code ?? '')) throw new Error('runtime code expected');
  return sealed({
    format: VACCINE_FORMAT, vm: 'evm', kind, label: String(label).slice(0, 80),
    source: { chainId: Number(chainId), address: address ? address.toLowerCase() : null },
    codeHash: codeHashOf(code), fp1: fingerprint1(code), sim: signatureOf(code), opcodes: opcodeFacts(code),
    callPattern, threshold,
  });
}

/** A vaccine for a CosmWasm code (sha256 checksum of the wasm, as `wasmd q wasm code-info` shows) or a Solana program. */
export function deriveExactVaccine({ vm, checksum, chainId, address = null, kind = 1, label = '' }) {
  if (!['cosmwasm', 'solana'].includes(vm) || !/^(0x)?[0-9a-f]{64}$/i.test(checksum ?? '')) throw new Error('vm cosmwasm|solana and a 32-byte checksum');
  return sealed({ format: VACCINE_FORMAT, vm, kind, label: String(label).slice(0, 80), source: { chainId: Number(chainId), address }, checksum: checksum.toLowerCase().replace(/^0x/, '') });
}

/** Is the vaccine intact (its id is its content hash)? Sentinels drop vaccines that are not. */
export const vaccineIntact = (v) => !!v && v.format === VACCINE_FORMAT && sealed(v).id === v.id;

/**
 * Matches code against a vaccine: { match, score (0..100), how }. `code` is EVM runtime hex, or for cosmwasm/solana
 * the checksum hex. `sig` (optional): a precomputed signatureOf(code) when one code is matched against many vaccines.
 */
export function matchVaccine(v, code, sig = null) {
  if (v.vm === 'cosmwasm' || v.vm === 'solana') {
    const same = String(code).toLowerCase().replace(/^0x/, '') === v.checksum;
    return { match: same, score: same ? 100 : 0, how: same ? 'exact' : null };
  }
  if (!/^0x([0-9a-f]{2})+$/i.test(code ?? '')) return { match: false, score: 0, how: null };
  if (codeHashOf(code) === v.codeHash) return { match: true, score: 100, how: 'exact' };
  if (fingerprint1(code) === v.fp1) return { match: true, score: 100, how: 'fingerprint' };
  const s = sig ?? signatureOf(code);
  const sim = similarityPercent(s, v.sim);
  const want = v.sim.selectors;
  const have = new Set(s.selectors);
  const selShare = want.length >= 3 ? want.filter((x) => have.has(x)).length / want.length : 0;
  const selScore = Math.round(selShare * 100);
  if (sim >= v.threshold) return { match: true, score: sim, how: 'similar' };
  if (selScore >= 80 && sim >= 50) return { match: true, score: Math.max(sim, selScore), how: 'selectors' };
  return { match: false, score: Math.max(sim, 0), how: null };
}

/** A set of vaccines a sentinel holds: add (intact only, deduped by id), scan code against all. */
export class VaccineSet {
  constructor(list = []) { this.byId = new Map(); for (const v of list) this.add(v); }
  add(v) { if (!vaccineIntact(v)) return false; if (this.byId.has(v.id)) return false; this.byId.set(v.id, v); return true; }
  get size() { return this.byId.size; }
  list() { return [...this.byId.values()]; }
  /** The best match of `code` (EVM runtime hex) or a non-EVM checksum: { vaccine, score, how } | null. */
  scan(code, vm = 'evm') {
    let best = null;
    let sig = null;
    for (const v of this.byId.values()) {
      if ((v.vm ?? 'evm') !== vm) continue;
      if (vm === 'evm' && !sig && /^0x([0-9a-f]{2})+$/i.test(code ?? '')) sig = signatureOf(code);
      const m = matchVaccine(v, code, sig);
      if (m.match && (!best || m.score > best.score)) best = { vaccine: v, score: m.score, how: m.how };
    }
    return best;
  }
  toJSON() { return this.list(); }
}

/** The canonical bytes a feed carries for a vaccine (so the feed's own hash covers it). */
export const vaccineBytes = (v) => new TextEncoder().encode(canonical(v));
