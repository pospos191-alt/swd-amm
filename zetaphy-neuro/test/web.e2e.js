// Browser test for web/: serves the page, answers its RPC requests from the
// in-memory test chain (no network), and checks what a user would see.
//   npm run test:web            (uses Playwright's Chromium)
//   SCREENSHOT_DIR=... npm run test:web   also saves screenshots
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLocalChain } from './helpers/local-chain.js';

const PORT = 18080;
const shots = process.env.SCREENSHOT_DIR;
let server; let browser; let chain;

async function launch() {
  const opts = { headless: true };
  try { return await chromium.launch(opts); } catch {
    return chromium.launch({ ...opts, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  chain = await createLocalChain();
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe' });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

async function openPage(scheme) {
  const page = await browser.newPage({ colorScheme: scheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Every https request is an RPC call to a "BNB Chain" endpoint backed by the test chain.
  await page.route('https://**', async (route) => {
    const { id, method, params } = JSON.parse(route.request().postData());
    let body;
    try {
      body = { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params) };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: 3, message: e.message } };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  return { page, errors };
}

test('scam token shows high risk in Thai, then English', async () => {
  const addr = await chain.deploy('ScamToken');
  const { page, errors } = await openPage('light');
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง');
  const items = await page.$$eval('#findings li', (els) => els.map((e) => e.textContent));
  assert.ok(items.some((t) => t.includes('สร้างเหรียญเพิ่มได้')));
  assert.ok(page.url().includes(`address=${addr}`), 'shareable link');
  if (shots) await page.screenshot({ path: `${shots}/neuro-scam-th.png`, fullPage: true });
  await page.click('#lang');
  assert.equal(await page.textContent('#title'), 'High risk');
  assert.deepEqual(errors, []);
  await page.close();
});

test('phishing token name is shown as text, never as HTML', async () => {
  const addr = await chain.deploy('PhishToken');
  const { page, errors } = await openPage('dark');
  await page.goto(`http://localhost:${PORT}/?chain=bsc&address=${addr}`);
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.$$eval('#findings a, #findings img, #findings script', (e) => e.length), 0);
  if (shots) await page.screenshot({ path: `${shots}/neuro-phish-dark.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('each successful check is counted, and the stats page shows it', async () => {
  const before = await (await fetch(`http://localhost:${PORT}/api/usage`)).json();
  const addr = await chain.deploy('CleanToken');
  const { page, errors } = await openPage('light');
  await page.fill('#address', addr);
  const counted = page.waitForResponse((r) => r.url().endsWith('/api/usage') && r.request().method() === 'POST');
  await page.click('#go');
  assert.equal((await counted).status(), 202);
  await page.click('a[href="./stats.html"]');
  await page.waitForFunction(() => document.getElementById('users').textContent !== '–');
  const users = Number((await page.textContent('#users')).replace(/,/g, ''));
  const checks = Number((await page.textContent('#checks')).replace(/,/g, ''));
  assert.equal(users, 1, 'one visitor (same IP and browser) across all tests');
  assert.equal(checks, before.checks + 1);
  assert.match(await page.textContent('#pct'), /^\d+%$/);
  if (shots) await page.screenshot({ path: `${shots}/neuro-stats.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('bad address shows an error without any RPC call', async () => {
  const { page } = await openPage('light');
  let calls = 0;
  page.on('request', (r) => { if (r.url().startsWith('https://')) calls++; });
  await page.fill('#address', '0x1234');
  await page.click('#go');
  assert.match(await page.textContent('#status'), /ที่อยู่ไม่ถูกต้อง/);
  assert.equal(calls, 0);
  await page.close();
});
