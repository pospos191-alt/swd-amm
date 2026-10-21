// What Vercel serves is what the sources say: the committed vendor bundle is
// the build of src/entry.js with the locked @noble/hashes (reproducible), the
// committed artifacts are the build of contracts/, and the page loads nothing
// from elsewhere (no third-party scripts, no inline code, a strict CSP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bundle, OUT } from '../scripts/build-web.js';

const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('web/vendor/zetaphy-lib.js is exactly the build of its sources', async () => {
  assert.equal(await bundle(), readFileSync(OUT, 'utf8'), 'run npm run build:web and commit web/vendor/zetaphy-lib.js');
});

test('artifacts/ is exactly the build of contracts/', () => {
  const out = execFileSync(process.execPath, [new URL('../scripts/build.js', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.match(out, /artifacts match the sources/);
});

test('no third-party code, no inline scripts or styles; strict CSP', () => {
  const html = web('index.html');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /src="\.\//, 'scripts only from this site');
    assert.equal(m[2].trim(), '', 'no inline script');
  }
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /<style|style="/i, 'no inline styles');
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//i, 'nothing loaded from elsewhere');
  const js = readdirSync(new URL('../web/lib/', import.meta.url)).map((f) => web(`lib/${f}`)).join('\n') + web('app.js');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, 'no HTML insertion or eval');
  for (const m of js.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^\.\.?\//, `relative import only: ${m[1]}`);
  const csp = JSON.parse(web('vercel.json')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /img-src 'self' data: https:;/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});
