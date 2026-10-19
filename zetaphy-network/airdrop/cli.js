#!/usr/bin/env node
// SWD airdrop prep (stage 2). Nothing here moves tokens.
//   node airdrop/cli.js snapshot --mint <SWD mint> [--rpc URL] [--exclude a,b] > snapshot.json
//   node airdrop/cli.js allocate snapshot.json [--min 1000000] [--cap-bps 100] > allocations.json
//   node airdrop/cli.js merkle allocations.json > merkle.json
import { readFileSync } from 'node:fs';
import { takeSnapshot } from './snapshot.js';
import { allocate } from './allocate.js';
import { buildTree } from './merkle.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (opt[rest[i].slice(2)] = rest[++i]) : pos.push(rest[i]);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

try {
  if (cmd === 'snapshot') {
    out(await takeSnapshot({ mint: opt.mint, rpcUrl: opt.rpc ?? 'https://api.mainnet-beta.solana.com', exclude: opt.exclude ? opt.exclude.split(',') : [] }));
  } else if (cmd === 'allocate') {
    out(allocate(JSON.parse(readFileSync(pos[0], 'utf8')), { minAmount: BigInt(opt.min ?? 1), capBps: Number(opt['cap-bps'] ?? 10_000) }));
  } else if (cmd === 'merkle') {
    const a = JSON.parse(readFileSync(pos[0], 'utf8'));
    out({ pool: a.pool, ...buildTree(a.allocations) });
  } else {
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 5).join('\n'));
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
