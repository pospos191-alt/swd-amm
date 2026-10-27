#!/usr/bin/env node
// tests-10k: 10,000 unique, seeded property / differential / invariant cases
// for Neuro (zetaphy-neuro) and ZETAPHY (DEX, hub, explorer, PQ verifier).
//
//   node tests-10k/run.mjs                 run everything, print the table, write tests-10k/SUMMARY.md (+ results.json)
//   node tests-10k/run.mjs --only neuro/   only areas whose name contains "neuro/"
//
// Every case's inputs are hashed (sha256 of canonical JSON); a case whose hash
// was already drawn anywhere in the suite is re-drawn, and the run fails if the
// final set is not exactly TOTAL distinct hashes.

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runArea } from './lib/harness.mjs';
import { FINDINGS } from './findings.mjs';
import neuroEngine from './neuro/engine.mjs';
import neuroServer from './neuro/server.mjs';
import zAmm from './zetaphy/amm.mjs';
import zEvm from './zetaphy/evm.mjs';
import zWeb from './zetaphy/web.mjs';
import zPq from './zetaphy/pq.mjs';

export const TOTAL = 10_000;
const AREAS = [...neuroEngine, ...neuroServer, ...zAmm, ...zEvm, ...zWeb, ...zPq];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const areas = only ? AREAS.filter((a) => a.name.includes(only)) : AREAS;
const planned = areas.reduce((n, a) => n + a.count, 0);
if (!only && planned !== TOTAL) { console.error(`planned ${planned} cases, not ${TOTAL}`); process.exit(2); }

const seen = new Set();
const results = [];
const t0 = performance.now();
for (const a of areas) {
  process.stdout.write(`${a.name.padEnd(36)} `);
  const r = await runArea(a, seen);
  results.push(r);
  console.log(`${String(r.passed).padStart(5)} passed ${String(r.failed).padStart(4)} failed  ${(r.ms / 1000).toFixed(1)} s`);
}
const totalMs = performance.now() - t0;

const sum = (k) => results.reduce((n, r) => n + r[k], 0);
const groups = ['Neuro', 'ZETAPHY'].map((g) => {
  const rs = results.filter((r) => r.group === g);
  return { group: g, count: rs.reduce((n, r) => n + r.count, 0), passed: rs.reduce((n, r) => n + r.passed, 0), failed: rs.reduce((n, r) => n + r.failed, 0), dupes: rs.reduce((n, r) => n + r.dupes, 0), unique: rs.reduce((n, r) => n + r.unique, 0), ms: rs.reduce((n, r) => n + r.ms, 0) };
});
const uniqueOk = seen.size === planned && sum('unique') === planned;
// One hash over every case hash: equal on every run and machine (the suite is seeded).
const fingerprint = createHash('sha256').update([...seen].sort().join('\n')).digest('hex').slice(0, 16);

const row = (cells, w) => cells.map((c, i) => String(c)[i ? 'padStart' : 'padEnd'](w[i])).join('  ');
const W = [36, 6, 7, 7, 24, 9];
console.log('\n' + row(['area', 'cases', 'passed', 'failed', 'unique-check', 'time'], W));
console.log('-'.repeat(W.reduce((a, b) => a + b + 2, 0)));
for (const r of results) console.log(row([r.name, r.count, r.passed, r.failed, `${r.unique}/${r.count}${r.dupes ? ` (${r.dupes} redrawn)` : ''}`, `${(r.ms / 1000).toFixed(2)} s`], W));
console.log('-'.repeat(W.reduce((a, b) => a + b + 2, 0)));
for (const g of groups) if (g.count) console.log(row([`${g.group} total`, g.count, g.passed, g.failed, `${g.unique}/${g.count}`, `${(g.ms / 1000).toFixed(2)} s`], W));
console.log(row(['ALL', planned, sum('passed'), sum('failed'), `${seen.size}/${planned} ${uniqueOk ? 'OK' : 'FAIL'}`, `${(totalMs / 1000).toFixed(2)} s`], W));
console.log(`\ncase-set fingerprint: ${fingerprint} (sha256 of the sorted case hashes)`);

const failures = results.filter((r) => r.failures.length);
if (failures.length) {
  console.log('\nFailures (first ones per area, with the input that reproduces them):');
  for (const r of failures) for (const f of r.failures.slice(0, 5)) console.log(`- ${r.name} #${f.index}: ${f.error}\n    input: ${f.input}`);
}

if (!only) {
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({
    node: process.version, total: planned, unique: seen.size, uniqueOk, passed: sum('passed'), failed: sum('failed'),
    redrawn: sum('dupes'), fingerprint, seconds: +(totalMs / 1000).toFixed(2), groups, areas: results,
  }, null, 2) + '\n');
  writeFileSync(new URL('./SUMMARY.md', import.meta.url), summaryMarkdown());
}

/** SUMMARY.md: this run's table, the uniqueness check, failures, what each area checks, findings. */
function summaryMarkdown() {
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  const n = (x) => x.toLocaleString('en-US');
  const lines = [
    '# tests-10k: 10,000 unique cases for Neuro and ZETAPHY',
    '',
    'A seeded property / differential / invariant suite: **10,000 cases, every one distinct**, 5,000 for',
    'Neuro (`zetaphy-neuro`) and 5,000 for ZETAPHY (DEX contracts and page libs, hub, explorer,',
    'post-quantum finality verifier). This file is written by the runner after a full run.',
    '',
    '```',
    'node tests-10k/run.mjs                # everything, prints the table, writes SUMMARY.md and results.json',
    'node tests-10k/run.mjs --only neuro/  # one part (writes nothing)',
    '```',
    '',
    'Needs the packages\' own dev dependencies (`npm ci` in `zetaphy-neuro`, `zetaphy-dex` and',
    '`zetaphy-network`); no network, no chain node, no Foundry. The EVM cases run the committed',
    'artifacts in `zetaphy-dex/artifacts` on `@ethereumjs/evm` (the harness of `zetaphy-dex/test`).',
    '',
    '## How "unique" is enforced',
    '',
    'Each case is a plain input object drawn from a seeded PRNG (xoshiro128**, one seed per area). Its',
    'identity is `sha256(area name + canonical JSON of its inputs)` (sorted keys; BigInt and bytes encoded',
    'explicitly). A case whose hash was already drawn **anywhere in the suite** is re-drawn',
    `(${sum('dupes')} re-draws in ${n(sum('drawn'))} draws this run), and the run fails unless the final set holds exactly`,
    `${n(planned)} distinct hashes. Case-set fingerprint (sha256 of the sorted case hashes): \`${fingerprint}\`;`,
    'it is the same on every run, so the same 10,000 cases are replayed everywhere.',
    '',
    `## Results (Node ${process.version}, ${s(totalMs)} in total)`,
    '',
    '| area | cases | passed | failed | unique-check | time |',
    '|---|---:|---:|---:|---|---:|',
    ...results.map((r) => `| ${r.name} | ${n(r.count)} | ${n(r.passed)} | ${n(r.failed)} | ${r.unique}/${r.count}${r.dupes ? ` (${r.dupes} re-drawn)` : ''} | ${s(r.ms)} |`),
    ...groups.filter((g) => g.count).map((g) => `| **${g.group} total** | **${n(g.count)}** | **${n(g.passed)}** | **${n(g.failed)}** | ${n(g.unique)}/${n(g.count)} | ${s(g.ms)} |`),
    `| **ALL** | **${n(planned)}** | **${n(sum('passed'))}** | **${n(sum('failed'))}** | **${n(seen.size)}/${n(planned)} ${uniqueOk ? 'OK' : 'FAIL'}** | ${s(totalMs)} |`,
    '',
  ];
  if (failures.length) {
    lines.push('## Failures in this run (input that reproduces each)', '');
    for (const r of failures) for (const f of r.failures) lines.push(`- \`${r.name}\` #${f.index}: ${f.error}`, `  - input: \`${f.input}\``);
    lines.push('');
  }
  lines.push(FINDINGS, '## What each area checks', '');
  for (const g of ['Neuro', 'ZETAPHY']) {
    lines.push(`**${g}**`, '');
    for (const r of results.filter((x) => x.group === g)) lines.push(`- \`${r.name}\` (${r.count}): ${r.what}.`);
    lines.push('');
  }
  return lines.join('\n');
}
process.exit(sum('failed') || !uniqueOk ? 1 : 0);
