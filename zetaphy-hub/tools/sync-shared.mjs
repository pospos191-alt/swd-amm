#!/usr/bin/env node
// npm run sync:shared: copies the shared wallet-safety and Ledger files from zetaphy-hub/ (the
// canonical copies) to every site that serves them. Each site is deployed on its own origin with
// CSP script-src 'self', so each needs its own copy; test/shared.test.mjs checks they are identical.
//   node tools/sync-shared.mjs          write the copies
//   node tools/sync-shared.mjs --check  only report copies that differ (exit 1)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(HUB, '..');
const SAFETY = ['wallet-safety.js', 'wallet-safety-i18n.js', 'wallet-safety.css'];
const LEDGER = ['ledger.js', 'vendor/ledger-hid.js'];
/** site folder (from the repo root) -> the files it gets */
export const SHARED = {
  'zetaphy-dex/web/lib': [...SAFETY, ...LEDGER],
  'zetaphy-nft/web/lib': [...SAFETY, ...LEDGER],
  'zetaphy-explorer/src': SAFETY,
  'zetaphy-neuro/web': SAFETY,
  'test-ui': SAFETY,
};

/** [canonical path, copy path] for every shared file. */
export function pairs() {
  return Object.entries(SHARED).flatMap(([dir, files]) => files.map((f) => [join(HUB, f), join(ROOT, dir, f)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const [from, to] of pairs()) {
    const src = readFileSync(from);
    if (existsSync(to) && readFileSync(to).equals(src)) continue;
    if (check) { console.error(`differs: ${to.slice(ROOT.length + 1)}`); bad++; continue; }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, src);
    console.log(`wrote ${to.slice(ROOT.length + 1)}`);
  }
  if (bad) process.exit(1);
}
