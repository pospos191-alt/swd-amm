#!/usr/bin/env node
// Proof of useful work for AI training (docs/future/useful-work-training.md), runner CLI:
//
//   node src/trainwork/cli.js simulate          the end-to-end round on the in-memory chain (6 workers, a cheater
//                                               and a copier): markdown report (needs the dev dependencies)
//   node src/trainwork/cli.js table             P(a faked checkpoint is caught) vs sample rate, computed and measured
//   node src/trainwork/cli.js train <spec.json> <shard> [--out trees.json]
//                                               trains one shard of a spec (deterministic): root, treesHash, digests
//   node src/trainwork/cli.js verify <spec.json> <shard> <trees.json> <segment> <treesHash>
//                                               re-runs one segment: the digest a verifier seals
import { readFileSync, writeFileSync } from 'node:fs';
import { k, T, baseModel, shardOf, detectionTable, measuredCatch } from './core.js';

const [cmd, ...args] = process.argv.slice(2);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  if (cmd === 'simulate') {
    const [{ createChain, ZETA }, { workMocks }, { simulate, reportMarkdown }] = await Promise.all([
      import('../../test/helpers/evm.js'), import('../../test/helpers/workmocks.js'), import('./simulate.js')]);
    const r = await simulate({ createChain, workMocks, ZETA }, { log: (s) => console.error(s) });
    console.log(reportMarkdown(r, ZETA));
  } else if (cmd === 'table') {
    const t = detectionTable();
    console.log(`| segments | faked | ${t.checks.map((s) => `${s} check${s > 1 ? 's' : ''}`).join(' | ')} |`);
    console.log(`|---|---|${t.checks.map(() => '---').join('|')}|`);
    for (const r of t.rows) console.log(`| ${r.segments} | ${r.faked} | ${r.p.map((p, i) => `${pct(p)} (${pct(measuredCatch(r.segments, r.faked, t.checks[i], 1000))})`).join(' | ')} |`);
  } else if (cmd === 'train') {
    const spec = JSON.parse(readFileSync(args[0], 'utf8'));
    const base = baseModel();
    if (spec.baseModel && spec.baseModel !== base.hash) throw new Error('the spec is for another base model');
    const sh = shardOf(spec, base.model, Number(args[1]));
    const r = T.trainJob(k, { S: sh.S, spec, shard: Number(args[1]) });
    const out = args.indexOf('--out');
    if (out > 0) writeFileSync(args[out + 1], JSON.stringify(r.trees));
    console.log(JSON.stringify({ shard: Number(args[1]), rowsHash: sh.hash, root: r.root, treesHash: r.treesHash, digests: r.digests }, null, 1));
  } else if (cmd === 'verify') {
    const spec = JSON.parse(readFileSync(args[0], 'utf8'));
    const base = baseModel();
    const sh = shardOf(spec, base.model, Number(args[1]));
    const published = JSON.parse(readFileSync(args[2], 'utf8'));
    console.log(T.verifySegment(k, { S: sh.S, spec, shard: Number(args[1]), published, committedTreesHash: args[4], segment: Number(args[3]) }));
  } else {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
main().catch((e) => { console.error(process.env.DEBUG ? e.stack : e.message); process.exit(1); });
