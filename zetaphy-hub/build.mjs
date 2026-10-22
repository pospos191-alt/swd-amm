#!/usr/bin/env node
// Builds dist/: the hub at the root and every app under its own path, so the
// hub shows them in same-origin frames (one look, shared wallet storage).
//   node build.mjs            -> dist/
//   node build.mjs --check    -> also verify every page's local scripts/styles exist
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'dist');

// app path in the hub -> source folder
export const APPS = {
  wallet: 'zetaphy-wallet',
  swap: 'zetaphy-dex/web',
  nft: 'zetaphy-nft/web',
  explorer: 'zetaphy-explorer',
  'neuro/web': 'zetaphy-neuro/web',
  'neuro/src': 'zetaphy-neuro/src', // the Neuro page imports ../src/*.js
};
// per app: folders that are build inputs, not served (the wallet serves vendor/pqwallet.js, built from src/)
const SKIP_IN = { wallet: new Set(['src']) };
// never shipped: tooling, tests, docs, per-site Vercel files
const SKIP = new Set(['node_modules', 'test', 'scripts', 'package.json', 'package-lock.json', 'vercel.json', 'README.md', 'README.th.md', '.gitignore', 'data']);
const HUB_FILES = ['index.html', 'hub.css', 'hub.js', 'chainlib.js', 'embed.css', 'logo.svg', 'favicon.svg'];

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const f of HUB_FILES) cpSync(join(HERE, f), join(OUT, f));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'zetaphy-explorer/config.json'), 'utf8'));
  writeFileSync(join(OUT, 'hub-config.json'), `${JSON.stringify({ node: cfg.node || '' }, null, 2)}\n`);
  for (const [path, src] of Object.entries(APPS)) {
    const from = join(ROOT, src);
    const top = (p) => p.slice(from.length + 1).split(/[\\/]/)[0];
    cpSync(from, join(OUT, path), { recursive: true, filter: (p) => !SKIP.has(top(p)) && !SKIP_IN[path]?.has(top(p)) });
  }
  return OUT;
}

/** Every local <script src> / <link href> in the built pages exists. */
export function check(out = OUT) {
  const missing = [];
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(out).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|mailto:|data:)/.test(ref) || ref.startsWith('?') || ref === '') continue;
      const target = ref.startsWith('/') ? join(out, ref) : join(dirname(f), ref);
      if (!existsSync(target)) missing.push(`${f.slice(out.length + 1)}: ${ref}`);
    }
  }
  return missing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
  const missing = check();
  if (missing.length) { console.error(`missing files:\n  ${missing.join('\n  ')}`); process.exit(1); }
  console.log(`dist/ built: hub + ${Object.keys(APPS).join(', ')}`);
}
