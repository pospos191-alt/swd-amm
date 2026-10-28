import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, check, APPS, releaseTag, withRelease } from '../build.mjs';
import { createHash } from 'node:crypto';

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
  for (const f of ['index.html', 'hub.js', 'hub.css', 'pages.js']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /SAWASDEE COIN/);
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

test('validator guide: shipped, no inline script or style (the hub CSP stays strict), no third-party requests', () => {
  const out = build();
  for (const f of ['validators.html', 'validators.css', 'validators.js']) assert.ok(existsSync(join(out, f)), f);
  const html = readFileSync(join(HERE, 'validators.html'), 'utf8');
  assert.doesNotMatch(html, /<script>|<style|\sstyle="|\son[a-z]+="/i);
  assert.match(html, /<script src="validators.js"><\/script>/);
  assert.doesNotMatch(html + readFileSync(join(HERE, 'validators.css'), 'utf8'), /fonts\.googleapis|fonts\.gstatic/);
  for (const k of ['getH', 'g1p', 'resH', 'r1', 'resWarn']) assert.match(readFileSync(join(HERE, 'validators.js'), 'utf8'), new RegExp(`"${k}"`));
});

test('the mining page ships with its worker; the validator guide downloads the current release', () => {
  const out = build();
  for (const f of ['mine.js', 'mine-core.js', 'mine-worker.js']) assert.ok(existsSync(join(out, f)), f);
  const want = `zetaphyd-${createHash('sha256').update(readFileSync(join(HERE, '..', 'zetaphy-chain/setup-node.sh'))).digest('hex').slice(0, 12)}`;
  assert.equal(releaseTag(), want, 'the tag release-zetaphyd.yml publishes');
  const html = readFileSync(join(out, 'validators.html'), 'utf8');
  const tags = [...html.matchAll(/releases\/download\/(zetaphyd-[0-9a-f]+)\//g)].map((m) => m[1]);
  assert.ok(tags.length >= 3, 'the download buttons');
  assert.deepEqual([...new Set(tags)], [want]);
  assert.equal(withRelease('a/releases/download/zetaphyd-3008c6775923/x b/releases/download/zetaphyd-3008c6775923/y', 'zetaphyd-000000000000'),
    'a/releases/download/zetaphyd-000000000000/x b/releases/download/zetaphyd-000000000000/y');
  // the guide's faucet form and the link to the mining page
  assert.match(html, /id="vf-form"/);
  assert.match(html, /href="\.\/\?tab=mine"/);
  // the worker is a same-origin module (script-src 'self'): no eval, no wasm
  for (const f of ['mine.js', 'mine-core.js', 'mine-worker.js']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /\beval\(|new Function|WebAssembly/, f);
});

test('validator guide: topics as tabs, each named and introduced in all 8 languages', () => {
  const html = readFileSync(join(HERE, 'validators.html'), 'utf8');
  const tabs = [...html.matchAll(/role="tab" id="t-([a-z]+)" aria-controls="p-\1"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['start', 'check', 'get', 'fix', 'rewards', 'keys', 'advanced']);
  for (const t of tabs) assert.match(html, new RegExp(`role="tabpanel" id="p-${t}" aria-labelledby="t-${t}"`));
  const line = readFileSync(join(HERE, 'validators.js'), 'utf8').split('\n')[2];
  const X = JSON.parse(line.slice('const X = /*EXTRA*/'.length, -1));
  for (const l of ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th']) {
    for (const t of tabs) assert.ok(X[l][`tab_${t}`] && X[l][`lede_${t}`], `${l}: ${t}`);
    for (const k of ['vfGet', 'vfOk', 'vfDown', 'vfBad', 'vfMine']) assert.ok(X[l][k], `${l}: ${k}`);
  }
});
