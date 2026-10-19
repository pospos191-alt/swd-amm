// Writes what BscScan's (or any Etherscan-family) free web form needs to
// verify a contract by hand: the Standard-JSON-Input file and the values to
// pick in the form. No API key, no plan: the web form is free on every chain.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Finds a contract by name ("ZETAPHYModularToken") or full name ("contracts/X.sol:X"). */
export function findContract(builds, nameOrFqn) {
  const hits = builds.contracts.filter((c) => c.fqn === nameOrFqn || c.name === nameOrFqn);
  const unique = [...new Map(hits.map((c) => [`${c.fqn}|${c.longVersion}|${JSON.stringify(c.input.settings)}`, c])).values()];
  if (!unique.length) throw new Error(`no contract named ${nameOrFqn} in build-info (have: ${[...new Set(builds.contracts.map((c) => c.name))].join(', ')})`);
  if (unique.length > 1) throw new Error(`${nameOrFqn} is in ${unique.length} different builds; pass the full name or keep one build-info`);
  return unique[0];
}

const SPDX = { MIT: '3) MIT License (MIT)', 'GPL-3.0': '5) GNU GPLv3 (GPL-3.0)', 'Apache-2.0': '12) Apache 2.0 (Apache-2.0)', UNLICENSED: '2) The Unlicense (Unlicense)' };

/** @returns {{file: string, form: Record<string,string>}} */
export function exportForWebForm(contract, outDir) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${contract.name}.standard-input.json`);
  writeFileSync(file, JSON.stringify(contract.input, null, 2));
  const source = contract.input.sources[contract.fqn.slice(0, contract.fqn.lastIndexOf(':'))]?.content ?? '';
  const license = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(source)?.[1];
  const opt = contract.input.settings?.optimizer;
  return {
    file,
    form: {
      'Compiler Type': 'Solidity (Standard-Json-Input)',
      'Compiler Version': `v${contract.longVersion}`,
      'Open Source License Type': license ? (SPDX[license] ?? license) : 'pick the one in the source',
      'Contract name (if asked)': contract.fqn,
      Optimizer: opt?.enabled ? `on, ${opt.runs} runs (already inside the JSON file)` : 'off (already inside the JSON file)',
      'Constructor Arguments': 'leave empty: the explorer detects them; if it asks, see README',
    },
  };
}
