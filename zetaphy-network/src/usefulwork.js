// Useful work (docs/future/useful-work.md) on the runner side: the same code the browser runs
// (zetaphy-hub/work-core.js, fuzz-core.js, mine-core.js) wired to Node's copies of Neuro and of
// the EthereumJS EVM, so a runner checks a browser's scan verdict or bug finding byte for byte.
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { codeVerdict, keccakHex, jobCommitment, canaryCommitment, findingCommitment, randomSalt } from '../../zetaphy-hub/work-core.js';
import { replay, fuzz, findingHash, parseFinding, specHash, reproducer, findingBytes } from '../../zetaphy-hub/fuzz-core.js';
import { powPrefix, search } from '../../zetaphy-hub/mine-core.js';

export const neuro = { readContract, verdictOf, keccak256: neuroKeccak, CHAINS };
export const k = neuroKeccak;
export { jobCommitment, canaryCommitment, findingCommitment, randomSalt, findingHash, parseFinding, specHash };

let evmLib = null;
/** The EthereumJS EVM (a devDependency: runners that verify findings need `npm i` with dev deps). */
export async function loadEvm() {
  if (evmLib) return evmLib;
  try {
    const [{ EVM }, { Common, Chain, Hardfork }, { Address, Account, hexToBytes, bytesToHex }] = await Promise.all([
      import('@ethereumjs/evm'), import('@ethereumjs/common'), import('@ethereumjs/util')]);
    evmLib = { EVM, Common, Chain, Hardfork, Address, Account, hexToBytes, bytesToHex, keccak256: neuroKeccak };
    return evmLib;
  } catch {
    throw new Error('the EthereumJS EVM is not installed: run `npm i` (with dev dependencies) in zetaphy-network');
  }
}

/** The code-only verdict a browser computes for a scan job (code: the runtime bytecode, 0x hex). */
export const scanVerdict = (job) => codeVerdict(neuro, job);

/**
 * A runner's check of a bug finding: the spec must hash to the bounty's specHash, the finding to
 * the revealed findingHash, and replaying it must break the invariant.
 */
export async function verifyFinding({ specText, finding, expectSpecHash, expectFindingHash }) {
  const sh = specHash(k, specText);
  if (expectSpecHash && sh.toLowerCase() !== String(expectSpecHash).toLowerCase()) return { valid: false, reason: `spec hash ${sh} is not the bounty's` };
  const bytes = typeof finding === 'string' ? new TextEncoder().encode(finding) : finding;
  const fh = keccakHex(k, bytes);
  if (expectFindingHash && fh.toLowerCase() !== String(expectFindingHash).toLowerCase()) return { valid: false, reason: 'finding hash mismatch' };
  let parsed;
  try { parsed = parseFinding(bytes); } catch (e) { return { valid: false, reason: e.message }; }
  try {
    const r = await replay(await loadEvm(), JSON.parse(specText), parsed);
    const broken = r.violations.filter((v) => v.kind !== 'reentrancy').map((v) => v.kind);
    return { valid: r.valid, profit: r.profit, kinds: r.kinds, violations: r.violations, reason: r.valid ? `invariant broken: ${[...new Set(broken)].join(', ')}` : 'replay does not break an invariant' };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

/** Fuzzes a spec in Node (the same fuzzer as the browser). */
export async function hunt(specText, opts) {
  return fuzz(await loadEvm(), JSON.parse(specText), opts);
}

/** A reproducer file for a fuzz result (see zetaphy-hub/fuzz-core.js reproducer). */
export async function reproducerOf(specText, res) {
  return reproducer(await loadEvm(), JSON.parse(specText), specText, res);
}

/** A finding from a file or argument: the JSON finding itself, or a reproducer (format zetaphy-fuzz-repro/1). */
export function findingFromText(text) {
  const o = JSON.parse(text);
  return o?.format === 'zetaphy-fuzz-repro/1' ? findingBytes(o.finding) : new TextEncoder().encode(text.trim());
}

/** Finds a PoW stamp nonce: sha256(chainId || seed || worker || nonce) with `bits` zero bits. */
export function findStamp(chainId, seed, worker, bits) {
  const prefix = powPrefix(chainId, seed, worker);
  for (let hi = 0; ; hi++) {
    const lo = search(prefix, hi, bits, 0, 2 ** 32);
    if (lo >= 0) return (BigInt(hi) << 32n) | BigInt(lo);
  }
}
