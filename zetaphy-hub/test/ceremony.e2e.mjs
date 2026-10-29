// Browser test: the zkML ceremony contribution page (ceremony.html) on a built dist/ with its own CSP
// (wasm + blob workers, NO network). A contribution on a tiny test circuit's key: the page refuses a wrong key,
// produces a new key + transcript whose hash chain checks, and the new key passes snarkjs' full verification
// against the circuit and phase 1. Nothing is requested from anywhere but the page's own origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { build } from '../build.mjs';
import { checkChain, tip, sha256Hex } from '../ceremony-core.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = join(HERE, 'test', 'fixtures', 'ceremony');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'));
const CSP = vercel.headers.find((h) => h.source === '/ceremony.html').headers.find((h) => h.key === 'Content-Security-Policy').value;

test('ceremony page: contribute in the browser, refuse a wrong key, 8 languages, no network, phone width', { timeout: 120_000 }, async () => {
  const dist = build();
  const site = await serve(dist, { headers: { 'Content-Security-Policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    const foreign = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => { if (!r.url().startsWith(site.url) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url()); });
    await page.goto(`${site.url}ceremony.html`);
    await page.waitForFunction(() => document.querySelector('h1').textContent.length > 0);
    assert.match(await page.textContent('h1'), /ceremony/);
    assert.match(await page.textContent('header'), /Only one honest contributor is needed/);
    assert.equal(await page.isDisabled('#go'), true);
    // every language renders every text (no raw keys)
    for (const l of ['zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th', 'en']) {
      await page.selectOption('#lang', l);
      const empty = await page.$$eval('[data-t]', (ns) => ns.filter((n) => !n.textContent.trim() || n.textContent === n.dataset.t).map((n) => n.dataset.t));
      assert.deepEqual(empty, [], l);
      assert.equal(await page.getAttribute('html', 'lang'), l);
    }
    // the transcript: chain checked, next index shown
    await page.setInputFiles('#transcript', join(FX, 'transcript.json'));
    await page.waitForFunction(() => /Chain ok/.test(document.getElementById('tstatus').textContent));
    assert.match(await page.textContent('#tstatus'), /0 contributions so far; yours will be #1/);
    // a wrong key is refused
    await page.setInputFiles('#zkey', { name: 'x.zkey', mimeType: 'application/octet-stream', buffer: Buffer.from('not a key') });
    await page.waitForFunction(() => /Wrong key/.test(document.getElementById('zstatus').textContent));
    // the right one
    await page.setInputFiles('#zkey', join(FX, 'tiny_0000.zkey'));
    await page.waitForFunction(() => /entry #0/.test(document.getElementById('zstatus').textContent));
    await page.fill('#name', 'Browser tester');
    await page.fill('#github', 'browser-tester');
    assert.equal(await page.inputValue('#url'), 'https://github.com/browser-tester/swd-amm/releases/download/zk-ceremony-1/neuro_score_0001.zkey');
    await page.fill('#entropy', 'some typed randomness');
    assert.equal(await page.isDisabled('#go'), false);
    await page.click('#go');
    await page.waitForSelector('#done:not([hidden])', { timeout: 60_000 });
    assert.equal(await page.inputValue('#entropy'), '', 'typed entropy is cleared');
    assert.match(await page.textContent('#gstatus'), /Contribution #1 done/);
    assert.match(await page.textContent('#next'), /zk-ceremony-1.*neuro_score_0001\.zkey/s);
    const dir = mkdtempSync(join(tmpdir(), 'ceremony-'));
    const grab = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); const f = join(dir, d.suggestedFilename()); await d.saveAs(f); return f; };
    const zf = await grab('#dlZkey');
    const tf = await grab('#dlTranscript');
    assert.match(zf, /neuro_score_0001\.zkey$/);
    const t = JSON.parse(readFileSync(tf, 'utf8'));
    assert.deepEqual(await checkChain(t), []);
    assert.equal(t.contributions.length, 1);
    const e = t.contributions[0];
    assert.equal(e.github, 'browser-tester');
    assert.equal(e.name, 'Browser tester');
    assert.equal(await sha256Hex(readFileSync(zf)), e.zkeySha256);
    assert.equal(tip(t).zkeySha256, e.zkeySha256);
    assert.equal(await page.textContent('#chash'), e.contributionHash);
    // the new key passes snarkjs' full verification (circuit + phase 1) and records the same contribution hash
    const b = (f) => [...readFileSync(f)];
    const res = await page.evaluate(async ([r1cs, ptau, zkey]) => {
      const lines = [];
      const log = { info: (m) => lines.push(String(m)), debug() {}, warn() {}, error: (m) => lines.push(String(m)) };
      const mem = (a) => ({ type: 'mem', data: new Uint8Array(a) });
      const ok = await globalThis.snarkjs.zKey.verifyFromR1cs(mem(r1cs), mem(ptau), mem(zkey), log);
      return { ok, lines };
    }, [b(join(FX, 'tiny.r1cs')), b(join(FX, 'tiny.ptau')), b(zf)]);
    assert.equal(res.ok, true, res.lines.join('\n'));
    const logged = res.lines.find((l) => l.startsWith('contribution #1 Browser tester:'));
    assert.ok(logged, res.lines.join('\n'));
    assert.equal(logged.split('\n').slice(1).join('').replace(/\s+/g, ''), e.contributionHash);
    // phone width: no horizontal scroll
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(foreign, [], 'no request leaves the page origin');
    assert.deepEqual(errors, []);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await browser.close();
    site.close();
  }
});
