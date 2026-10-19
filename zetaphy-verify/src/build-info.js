// Reads compiler build-info files (Hardhat 2/3, Foundry) and indexes every
// deployable contract by its code fingerprint, so an on-chain address can be
// matched to its exact source without naming it in any config.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { codeFingerprint } from '../../zetaphy-neuro/src/fingerprint.js';

// Library link placeholders are 40 hex chars inside a PUSH20; zeroing them
// keeps the hex valid, and the fingerprint masks PUSH20 data anyway.
const unlink = (hex) => hex.replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40));

/** One build-info JSON (+ optional sibling .output.json) -> normalized record. */
export function readBuildInfo(file) {
  const info = JSON.parse(readFileSync(file, 'utf8'));
  let output = info.output;
  const sibling = file.replace(/\.json$/, '.output.json');
  if (!output && existsSync(sibling)) output = JSON.parse(readFileSync(sibling, 'utf8')).output;
  const longVersion = info.solcLongVersion ?? info.solcVersion;
  if (!info.input?.sources || !longVersion) throw new Error(`${file}: not a solc build-info file`);
  if (!/^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/.test(longVersion)) {
    throw new Error(`${file}: need the full compiler version like 0.8.26+commit.8a97fa7a, got ${longVersion}`);
  }
  return { file, input: info.input, longVersion, output: output ?? null };
}

/**
 * @param {Array<{input, longVersion, output}>} infos
 * @returns {Promise<{contracts: Array, byFingerprint: (fp: string) => object|null}>}
 */
export async function indexBuilds(infos) {
  const contracts = [];
  for (const b of infos) {
    for (const [source, byName] of Object.entries(b.output?.contracts ?? {})) {
      for (const [name, c] of Object.entries(byName)) {
        const runtime = c.evm?.deployedBytecode?.object;
        const creation = c.evm?.bytecode?.object;
        if (!runtime) continue; // interface or abstract contract
        contracts.push({
          fqn: `${source}:${name}`,
          name,
          input: b.input,
          longVersion: b.longVersion,
          creation: unlink(creation ?? ''),
          fingerprint: await codeFingerprint('0x' + unlink(runtime)),
        });
      }
    }
  }
  const map = new Map();
  for (const c of contracts) if (!map.has(c.fingerprint)) map.set(c.fingerprint, c);
  return { contracts, byFingerprint: (fp) => map.get(fp) ?? null };
}

/** Loads every build-info in `dir` (skips *.output.json and non-JSON files). */
export async function loadBuildDir(dir) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.output.json')).sort()
    : [];
  return indexBuilds(files.map((f) => readBuildInfo(join(dir, f))));
}
