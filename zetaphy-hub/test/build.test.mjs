import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, check, APPS } from '../build.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dist/: the hub and every app, with every local script and style present', () => {
  const out = build();
  assert.deepEqual(check(out), []);
  for (const p of Object.keys(APPS)) assert.ok(existsSync(join(out, p)), p);
  for (const p of ['wallet/index.html', 'swap/index.html', 'nft/index.html', 'explorer/index.html', 'neuro/web/index.html', 'hub-config.json']) assert.ok(existsSync(join(out, p)), p);
  for (const p of ['wallet/node_modules', 'wallet/test', 'wallet/src', 'explorer/test', 'swap/vercel.json']) assert.ok(!existsSync(join(out, p)), `not shipped: ${p}`);
  const cfg = JSON.parse(readFileSync(join(out, 'hub-config.json'), 'utf8'));
  assert.match(cfg.node, /^(https:\/\/[^/]+)?$/);
});

test('every tab the hub opens exists in dist/', () => {
  const js = readFileSync(join(HERE, 'hub.js'), 'utf8');
  const srcs = [...js.matchAll(/src: '([a-z/]+)'/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 5);
  for (const s of srcs) assert.ok(existsSync(join(HERE, 'dist', s, 'index.html')), s);
});

test('one name: ZETAPHY (no other brand in the hub)', () => {
  for (const f of ['index.html', 'hub.js', 'hub.css']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /SAWASDEE COIN/);
});

test('headers: frames only from this site; scripts only from this site; Neuro API proxied', () => {
  const v = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'));
  const csp = v.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /frame-src 'self'/);
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-(inline|eval)/);
  assert.deepEqual(v.rewrites, [{ source: '/api/:path*', destination: 'https://neuro.sawasdeecoin.com/api/:path*' }]);
});
