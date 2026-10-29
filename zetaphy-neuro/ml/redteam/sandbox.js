// The red-vs-blue arena's pinned sandbox (docs/future/markets.md, item 27). Several independent runners judge
// each round and a quorum of them must reveal the SAME result, so everything that decides the result is pinned
// and hashed into one `sandbox` id that the round names on-chain (RedBlueArena.openRound) and every runner's
// result commits to (RedBlueArena.resultKey):
//   - the EVM interpreter and its libraries (exact versions of @ethereumjs/evm, common, util), the hardfork;
//   - the Solidity compiler (solc, exact version) and its settings (optimizer on, 200 runs);
//   - the block environment every call runs in (number, timestamp; coinbase, prevRandao, base fee zero);
//   - Neuro's model (ml/model.json id) and the simulation seed;
//   - the benign reference set (its generator seed and size) and the judging rules' version.
// A runner whose installed packages differ refuses to judge (checkPinned), so a quorum cannot be reached by
// accident with different interpreters; anyone can re-run a round with the same id and get the same bytes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { SIM_SEED } from '../lib/pipeline.js';

export const SANDBOX_FORMAT = 'arena-sandbox/1';
/** Exact versions: package-lock.json pins them; checkPinned() checks what is installed. */
export const PINNED = { '@ethereumjs/evm': '3.1.1', '@ethereumjs/common': '4.4.0', '@ethereumjs/util': '9.1.0', solc: '0.8.26' };
export const BLOCK = { number: 20_000_000n, timestamp: 1_800_000_000n };
export const BENIGN = { seed: 'arena-benign', perFamily: 2 };
export const RULES = 'arena-judge/2'; // valid: victim gets < 50% of the quote back or cannot sell; evaded: valid and Neuro < medium

const require = createRequire(import.meta.url);
/** The installed version of a package (its package.json). */
export function installed(name) {
  if (name === 'solc') return require('solc').version().split('+')[0];
  return JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
}

/** Throws unless every pinned package is installed at its exact version. */
export function checkPinned() {
  const bad = Object.entries(PINNED).filter(([n, v]) => installed(n) !== v).map(([n, v]) => `${n} ${installed(n)} (pinned ${v})`);
  if (bad.length) throw new Error(`the arena sandbox is pinned; installed: ${bad.join(', ')}. Run npm ci in zetaphy-neuro.`);
  return true;
}

/** The sandbox description for a model (null = rules only). */
export function sandboxOf(model, { benign = BENIGN } = {}) {
  return {
    format: SANDBOX_FORMAT,
    packages: PINNED,
    hardfork: 'cancun',
    solcSettings: { optimizer: true, runs: 200 },
    block: { number: String(BLOCK.number), timestamp: String(BLOCK.timestamp), coinbase: '0x' + '00'.repeat(20), prevRandao: '0x' + '00'.repeat(32), baseFee: '0' },
    simSeed: SIM_SEED,
    model: model?.id ?? null,
    benign: { seed: benign.seed, perFamily: benign.perFamily },
    rules: RULES,
  };
}

/** keccak256 of the canonical JSON of a sandbox description (keys sorted): the on-chain `sandbox`. */
export function sandboxHash(desc) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return '0x' + bytesToHex(keccak_256(utf8ToBytes(JSON.stringify(canon(desc)))));
}
