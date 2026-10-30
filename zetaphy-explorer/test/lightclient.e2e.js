// Browser test of lightclient.html (the STARK light-client demo), served by
// scripts/serve.js with the real CSP: the demo runs (genesis -> handoff ->
// blocks), the flipped-byte copy is rejected, a proof file opened from disk is
// verified, and no CSP violation or page error happens. No network.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/lightclient.e2e.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const freePort = () => new Promise((r) => { const sv = createServer().listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => r(port)); }); });
const PORT = await freePort();
const ORIGIN = `http://localhost:${PORT}`;
let server; let browser;

before(async () => {
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url) });
  await new Promise((r) => server.stdout.once('data', r));
  try { browser = await chromium.launch({ headless: true }); } catch {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
});
after(async () => { await browser?.close(); server?.kill(); });

test('lightclient.html: demo verifies in the browser under the CSP; a forged proof is rejected', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // phone width
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', (r) => { if (!r.url().startsWith(ORIGIN)) problems.push(`network: ${r.url()}`); });
  await page.goto(`${ORIGIN}/lightclient.html`);
  await page.waitForFunction(() => !document.getElementById('lc-run').disabled);
  await page.click('#lc-run');
  await page.waitForFunction(() => document.body.dataset.demo === 'done', null, { timeout: 60_000 });
  const rows = await page.$$eval('#lc-results tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.equal(rows.length, 5);
  assert.match(rows[0][1], /handoff → epoch 1/); assert.match(rows[0][2], /certified/);
  assert.match(rows[1][1], /block 501/); assert.match(rows[1][2], /certified/); assert.match(rows[1][5], /all 21 checked/);
  assert.match(rows[2][5], /trusted/);
  assert.match(rows[3][2], /NOT certified/); // 11 of 21 signed
  assert.match(rows[4][2], /rejected/); // one byte flipped
  assert.match(await page.textContent('#lc-pin'), /epoch 1/);
  for (const r of rows.slice(0, 4)) assert.match(r[7], /^\d+ ms$/);

  // Open a proof file from disk: verified against the current pin (epoch 1).
  const file = fileURLToPath(new URL('../lightclient/demo/block-501-all.bin', import.meta.url));
  await page.setInputFiles('#lc-file', file);
  await page.waitForFunction(() => /VALID|REJECTED/.test(document.getElementById('lc-out').textContent));
  assert.match(await page.textContent('#lc-out'), /VALID, rule holds: block 501/);
  // ... and against the wrong pin (the genesis root): rejected
  await page.fill('#lc-root', '00'.repeat(32));
  await page.setInputFiles('#lc-file', []);
  await page.setInputFiles('#lc-file', file);
  await page.waitForFunction(() => /REJECTED/.test(document.getElementById('lc-out').textContent));
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(noScroll, 'no horizontal page scroll at phone width');
  assert.deepEqual(problems, []);
  await page.close();
});
