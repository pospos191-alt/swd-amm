#!/usr/bin/env node
// Imports Neuro runners' outcomes as labels.
//
// Today there is nothing to import: Neuro's on-chain ThreatRegistry stores
// only fingerprint keys (no code, no address), and the dataset of flagged
// code in src/threat-signatures.js (ADDED) ships empty. When runners start
// flagging, export their decided jobs as JSON and pass the file here:
//
//   node ml/data/votes.js --in votes.json [--out ml/data/out/votes.jsonl]
//   votes.json: [{ "chain": "bsc", "address": "0x...", "flagged": true, "reportHash": "0x..." }, ...]
//
// Each address is read again with Neuro (read-only, public RPC) and labelled
// 1 if the runners flagged it (2 of 3), 0 if they decided "not flagged".
// Undecided jobs are skipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADDED } from '../../src/threat-signatures.js';
import { readRows } from '../lib/live.js';

export function voteItems(votes) {
  return votes
    .filter((v) => typeof v.flagged === 'boolean' && /^0x[0-9a-fA-F]{40}$/.test(v.address ?? ''))
    .map((v) => ({ chain: v.chain ?? 'bsc', address: v.address.toLowerCase(), label: v.flagged ? 1 : 0, id: `vote-${v.chain ?? 'bsc'}-${v.address.toLowerCase()}`, src: 'votes', license: 'own data' }));
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = arg('in', null);
  const out = arg('out', new URL('./out/votes.jsonl', import.meta.url).pathname);
  const flaggedWithRef = ADDED.filter((e) => e.flag).length;
  if (!input || !existsSync(input)) {
    console.log(JSON.stringify({ rows: 0, note: `no vote export given; src/threat-signatures.js has ${flaggedWithRef} flagged entries (they hold signatures, not code, so they cannot be featurised)` }));
  } else {
    const items = voteItems(JSON.parse(readFileSync(input, 'utf8')));
    const rows = [];
    for (const chain of [...new Set(items.map((i) => i.chain))]) {
      const r = await readRows(items.filter((i) => i.chain === chain), { chain, log: (m) => console.error(m) });
      rows.push(...r.rows);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    console.log(JSON.stringify({ rows: rows.length, of: items.length }));
  }
}
