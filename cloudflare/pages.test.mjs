// node --test cloudflare/pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES, cfPath, aliases, toHeaders, toRedirects, ignored } from './pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercelOf = (site) => JSON.parse(readFileSync(join(ROOT, SITES[site].dir, 'vercel.json'), 'utf8'));

/** _headers text -> [{ path, lines }] */
function blocks(text) {
  const out = [];
  for (const chunk of text.split('\n\n')) {
    const [path, ...lines] = chunk.split('\n').filter(Boolean);
    if (path) out.push({ path, lines: lines.map((l) => l.trim()) });
  }
  return out;
}

test('cfPath: the patterns the sites use, and nothing else', () => {
  assert.deepEqual(cfPath('/(.*)'), { path: '/*', except: [] });
  assert.deepEqual(cfPath('/sw.js'), { path: '/sw.js', except: [] });
  assert.deepEqual(cfPath('/((?!ceremony\\.html$|zkid-worker\\.js$).*)'), { path: '/*', except: ['/ceremony.html', '/zkid-worker.js'] });
  for (const bad of ['/api/(.*)', '/:path*', '/(.*)\\.png', '/((?!a.*).*)']) assert.throws(() => cfPath(bad), bad);
});

test('aliases: Cloudflare serves /x.html at /x', () => {
  assert.deepEqual(aliases('/ceremony.html'), ['/ceremony.html', '/ceremony']);
  assert.deepEqual(aliases('/a/index.html'), ['/a/index.html', '/a/']);
  assert.deepEqual(aliases('/sw.js'), ['/sw.js']);
});

test('every site converts, each path has one block, lines fit', () => {
  for (const site of Object.keys(SITES)) {
    const b = blocks(toHeaders(vercelOf(site)));
    const paths = b.map((x) => x.path);
    assert.equal(new Set(paths).size, paths.length, `${site}: a path in two blocks (Cloudflare ignores the second)`);
    assert.equal(paths[0], '/*', site);
    // no header set twice in one block
    for (const { path, lines } of b) {
      const keys = lines.filter((l) => !l.startsWith('!')).map((l) => l.split(':')[0].toLowerCase());
      assert.equal(new Set(keys).size, keys.length, `${site} ${path}`);
    }
  }
});

test('hub: ceremony and the zk worker drop every catch-all header and set their own', () => {
  const v = vercelOf('hub');
  const global = v.headers[0].headers.map((h) => h.key);
  const b = blocks(toHeaders(v));
  for (const p of ['/ceremony.html', '/ceremony', '/zkid-worker.js']) {
    const blk = b.find((x) => x.path === p);
    assert.ok(blk, p);
    for (const k of global) assert.ok(blk.lines.includes(`! ${k}`), `${p} detaches ${k}`);
    const csp = blk.lines.find((l) => l.startsWith('Content-Security-Policy:'));
    assert.match(csp, /'wasm-unsafe-eval'/, p);
  }
  // the worker had no X-Frame-Options on Vercel; it must not gain one
  assert.ok(!b.find((x) => x.path === '/zkid-worker.js').lines.some((l) => l.startsWith('X-Frame-Options:')));
});

test('a specific rule that repeats a catch-all header replaces it instead of joining it', () => {
  const v = { headers: [
    { source: '/(.*)', headers: [{ key: 'Cache-Control', value: 'public' }, { key: 'X-A', value: '1' }] },
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ] };
  const sw = blocks(toHeaders(v)).find((x) => x.path === '/sw.js');
  assert.deepEqual(sw.lines, ['! Cache-Control', 'Cache-Control: no-cache']);
});

test('redirects and rewrites', () => {
  assert.equal(toRedirects(vercelOf('neuro')), '/ /web/ 307\n');
  assert.equal(toRedirects(vercelOf('hub')), '/api/* https://neuro.sawasdeecoin.com/api/:splat 307\n');
  assert.equal(toRedirects({ redirects: [{ source: '/z/:path*', destination: 'https://s.example/:path*', permanent: true }] }), '/z/* https://s.example/:splat 308\n');
  assert.equal(toRedirects(vercelOf('wallet')), '');
  assert.throws(() => toRedirects({ rewrites: [{ source: '/a', destination: '/b' }] }));
});

test('ignored: .vercelignore entries, with or without a slash', () => {
  const list = ['api/', 'test', 'package.json', 'node_modules/'];
  assert.ok(ignored('api/usage.js', list));
  assert.ok(ignored('test/x.test.js', list));
  assert.ok(ignored('package.json', list));
  assert.ok(!ignored('testing.js', list));
  assert.ok(!ignored('web/package.json.txt', list));
  assert.ok(!ignored('web/index.html', list));
});
