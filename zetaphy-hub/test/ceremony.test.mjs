// The zkML ceremony page's static guarantees: its words in all 8 languages, the vendored snarkjs = the pinned one,
// its own CSP (wasm + blob workers, no network at all) applies to it alone, it ships in dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_CODES } from '../i18n.js';
import { CEREMONY } from '../ceremony-i18n.js';
import { checkChain, entryLink, initLink, FORMAT } from '../ceremony-core.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);

test('ceremony words: every language has every English key; placeholders survive; one honest contributor said everywhere', () => {
  assert.deepEqual(Object.keys(CEREMONY).sort(), [...LANG_CODES].sort());
  const en = shape(CEREMONY.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(CEREMONY[l]), en, l);
    const t = CEREMONY[l];
    for (const [k, v] of Object.entries(t)) if (typeof v === 'string') assert.ok(v.trim(), `${l}.${k}`);
    const n1 = t.next1('zk-ceremony-7', 'neuro_score_0007.zkey', 'https://github.com/a/b/releases/download/zk-ceremony-7/neuro_score_0007.zkey');
    for (const x of ['zk-ceremony-7', 'neuro_score_0007.zkey', 'https://github.com/a/b/']) assert.ok(n1.includes(x), `${l}.next1 ${x}`);
    assert.ok(t.tOk(3, 4, '0x7c420111bec7912ea5aeea', '').includes('4'), `${l}.tOk`);
    assert.ok(t.needName(64).includes('64'), `${l}.needName`);
    assert.ok(t.zBad('a'.repeat(64), 'b'.repeat(64)).includes('bbbb'), `${l}.zBad`);
    assert.ok(t.next2.includes('transcript.json'), `${l}.next2`);
    if (l !== 'en') assert.notEqual(t.oneHonest, CEREMONY.en.oneHonest, `${l}: translated`);
  }
  assert.match(CEREMONY.en.oneHonest, /Only one honest contributor is needed/);
  assert.doesNotMatch(readFileSync(join(HERE, 'ceremony.js'), 'utf8'), /[฀-๿]/, 'no Thai in the code');
});

test('vendor/snarkjs.min.js is exactly the pinned snarkjs (sha256 in vendor/snarkjs.json = the zk package pin)', () => {
  const pin = JSON.parse(readFileSync(join(HERE, 'vendor', 'snarkjs.json'), 'utf8'));
  const zk = JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-neuro', 'ml', 'onchain', 'zk', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-neuro', 'ml', 'onchain', 'zk', 'package-lock.json'), 'utf8')).packages['node_modules/snarkjs'];
  assert.equal(pin.version, zk.devDependencies.snarkjs);
  assert.equal(pin.integrity, lock.integrity);
  const bytes = readFileSync(join(HERE, 'vendor', 'snarkjs.min.js'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  const installed = join(HERE, '..', 'zetaphy-neuro', 'ml', 'onchain', 'zk', 'node_modules', 'snarkjs', 'build', 'snarkjs.min.js');
  if (existsSync(installed)) assert.ok(readFileSync(installed).equals(bytes), 'same bytes as the npm package');
  assert.doesNotMatch(bytes.toString(), /new Function\(|\beval\(/, 'no eval (the page CSP has no unsafe-eval)');
});

test('CSP: ceremony.html alone gets wasm + blob workers and NO network; every other page keeps the strict hub policy', () => {
  const v = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'));
  const [main, cer] = v.headers;
  const re = (s) => new RegExp(`^${s}$`);
  for (const p of ['/', '/index.html', '/forecasts.html', '/neuro/web/index.html', '/vendor/snarkjs.min.js', '/ceremony.js']) assert.match(p, re(main.source), p);
  assert.doesNotMatch('/ceremony.html', re(main.source));
  assert.equal(cer.source, '/ceremony.html');
  const csp = cer.headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp, /worker-src 'self' blob:;/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /'unsafe-(inline|eval)'/);
  assert.deepEqual(cer.headers.map((h) => h.key).sort(), main.headers.map((h) => h.key).sort(), 'same set of security headers');
  const mainCsp = main.headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(mainCsp, /wasm-unsafe-eval|blob:/);
});

test('the page ships in dist/ with no inline script or style', () => {
  const build = readFileSync(join(HERE, 'build.mjs'), 'utf8');
  for (const f of ['ceremony.html', 'ceremony.css', 'ceremony.js', 'ceremony-i18n.js', 'ceremony-core.js', 'vendor/snarkjs.min.js']) assert.ok(build.includes(`'${f}'`), f);
  const html = readFileSync(join(HERE, 'ceremony.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle=|<style/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com)/, 'no third-party resource');
});

test('core: the browser and the CLI compute the same links (fixed vectors)', async () => {
  const cs = 'a'.repeat(128);
  const l0 = await initLink(cs, 'b'.repeat(64), 'c'.repeat(64));
  assert.match(l0, /^[0-9a-f]{64}$/);
  const e = { index: 1, type: 'contribution', name: 'Ada', github: 'ada', contributionHash: 'd'.repeat(128), zkeySha256: 'e'.repeat(64), zkeyBytes: 10, url: 'https://github.com/ada/swd-amm/releases/download/zk-ceremony-1/neuro_score_0001.zkey' };
  e.link = await entryLink(l0, e);
  const t = { format: FORMAT, circuit: { csHash: cs }, phase1: { sha256: 'b'.repeat(64) }, init: { zkeySha256: 'c'.repeat(64), link: l0 }, beacon: null, contributions: [e] };
  assert.deepEqual(await checkChain(t), []);
  // the committed fixture transcript (tiny test circuit) and the public one both check
  assert.deepEqual(await checkChain(JSON.parse(readFileSync(join(HERE, 'test', 'fixtures', 'ceremony', 'transcript.json'), 'utf8'))), []);
  assert.deepEqual(await checkChain(JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-neuro', 'ml', 'onchain', 'zk', 'ceremony', 'transcript.json'), 'utf8'))), []);
});
