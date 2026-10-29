// Browser test of the wallet safety in the hub, under the site's real CSP: the hardware-wallet help,
// "Ledger (USB)" in the wallet dialog, the account forgotten after 30 idle minutes (or the 60 / 120 / 240 chosen in the help), and the
// unlimited-approval warning with its exact-amount choice.
//   npm run build && node --test test/safety.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const ACC = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';

async function open(browser, site, { viewport = { width: 1366, height: 768 } } = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (new URL(u).origin === new URL(site.url).origin) return route.continue();
    const a = new URL(u).origin === 'https://rpc.sawasdeecoin.com' ? answer(u, route.request().postData()) : null;
    if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  await page.addInitScript((acc) => {
    window.__calls = [];
    window.ethereum = { isMetaMask: true, on: () => {}, request: async ({ method, params }) => {
      window.__calls.push(method);
      if (method === 'eth_requestAccounts') { localStorage.setItem('__granted', '1'); return [acc]; }
      if (method === 'eth_accounts') return localStorage.getItem('__granted') ? [acc] : [];
      if (method === 'wallet_revokePermissions') { localStorage.removeItem('__granted'); return null; }
      if (method === 'eth_chainId') return '0x12e4e';
      if (method === 'wallet_switchEthereumChain') return null;
      throw new Error(`not mocked: ${method}`);
    } };
  }, ACC);
  return { page, errors };
}

test('hub: hardware-wallet help, Ledger (USB), idle forget, unlimited approval warning', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const { page, errors } = await open(browser, site);
    await page.clock.install();
    await page.goto(site.url);
    await page.waitForFunction(() => document.getElementById('s-height').textContent === '123,456');

    // the wallet dialog: Ledger over USB (WebHID is there in desktop Chromium), the help one click away
    await page.click('#wb-btn');
    await page.waitForSelector('#wb-dialog[open] #wb-ledger');
    assert.match(await page.textContent('#wb-ledger'), /Ledger \(USB\)/);
    await page.click('#wb-dialog [data-ws="help"]');
    await page.waitForSelector('#ws-help[open]');
    const help = await page.textContent('#ws-help');
    for (const re of [/hardware wallet/, /MetaMask/, /Rabby/, /Ledger \(USB\)/, /Blind signing/, /connect\.trezor\.io/, /Keplr/, /30 minutes/, /cannot lock your wallet extension/, /Snap/]) assert.match(help, re);
    // the idle time: 30 minutes by default, 30 / 60 / 120 / 240 to choose from
    assert.deepEqual(await page.$$eval('#ws-help [data-ws="idle-minutes"] option', (o) => o.map((x) => [x.value, x.textContent])), [['30', '30 min'], ['60', '60 min'], ['120', '120 min'], ['240', '240 min']]);
    assert.equal(await page.inputValue('#ws-help [data-ws="idle-minutes"]'), '30');
    await page.click('#ws-help .ws-row .ws-btn:has-text("Close")');
    await page.waitForFunction(() => !document.getElementById('ws-help'));
    // the help fits a phone screen (no sideways scroll)
    await page.setViewportSize({ width: 360, height: 700 });
    await page.click('#wb-dialog [data-ws="help"]');
    await page.waitForSelector('#ws-help[open]');
    assert.ok(await page.evaluate(() => { const d = document.getElementById('ws-help').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }), 'help fits at 360px');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1366, height: 768 });

    // connect MetaMask (the stand-in)
    await page.waitForSelector('#wb-dialog[open] .wb-wallet:not(#wb-ledger)');
    await page.click('#wb-dialog .wb-wallet:not(#wb-ledger)');
    await page.waitForFunction(() => /0x6af5…a245/.test(document.getElementById('wb-btn').textContent));
    await page.click('#wb-close');
    await page.waitForSelector('#stage > .ws-banner');

    // 29 minutes idle: still connected; 31: forgotten everywhere, the wallet asked to drop the site
    await page.clock.fastForward('29:00');
    assert.match(await page.textContent('#wb-btn'), /0x6af5/);
    await page.clock.fastForward('02:30');
    await page.waitForFunction(() => document.getElementById('wb-btn').textContent === 'Connect wallet');
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy:wallet')), null, 'the shared choice is cleared (the apps forget too)');
    assert.ok((await page.evaluate(() => window.__calls)).includes('wallet_revokePermissions'));
    await page.waitForSelector('#ws-idle');
    assert.match(await page.textContent('#ws-idle'), /30 minutes[\s\S]*Connect again/);
    assert.equal(await page.locator('.ws-banner').count(), 0, 'no banner without an account');
    // a reload does not reconnect by itself
    await page.reload();
    await page.waitForFunction(() => document.getElementById('s-height').textContent === '123,456');
    await page.clock.fastForward('00:02');
    assert.equal(await page.textContent('#wb-btn'), 'Connect wallet');

    // 60 minutes chosen in the help: 59 idle minutes keep the account, 61 forget it
    await page.click('#wb-btn');
    await page.click('#wb-dialog [data-ws="help"]');
    await page.selectOption('#ws-help [data-ws="idle-minutes"]', '60');
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy:safety:idleMinutes')), '60');
    await page.keyboard.press('Escape');
    await page.click('#wb-dialog .wb-wallet:not(#wb-ledger)');
    await page.waitForFunction(() => /0x6af5…a245/.test(document.getElementById('wb-btn').textContent));
    await page.click('#wb-close');
    await page.clock.fastForward('59:00');
    assert.match(await page.textContent('#wb-btn'), /0x6af5/, 'still connected at 59 minutes');
    await page.clock.fastForward('02:30');
    await page.waitForFunction(() => document.getElementById('wb-btn').textContent === 'Connect wallet');
    assert.match(await page.textContent('#ws-idle'), /60 minutes/);

    // the signing summary on an unlimited approve: warned, and "approve only" gives exact-amount call data
    const sp = '0x1111111111111111111111111111111111111111';
    const unlimited = `0x095ea7b3${sp.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;
    const p1 = page.evaluate((d) => import('./wallet-safety.js').then((m) => m.safety({ win: window }).confirmTx({ network: 'ZETAPHY (77390)', from: '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245', to: '0x9D44EA6837938d4FEF98367A7b5867cdCa8DE596', toLabel: 'tUSD', data: d, token: { symbol: 'tUSD', decimals: 18 }, exact: 25n * 10n ** 17n })), unlimited);
    await page.waitForSelector('#ws-confirm[open] [data-ws="unlimited"]');
    assert.match(await page.textContent('#ws-confirm'), /Unlimited approval: 0x111111…111111 could move ALL your tUSD/);
    assert.match(await page.textContent('#ws-confirm [data-ws="exact"]'), /Approve only 2\.5 tUSD/);
    await page.click('#ws-confirm [data-ws="exact"]');
    assert.equal(await p1, `0x095ea7b3${sp.slice(2).padStart(64, '0')}${(25n * 10n ** 17n).toString(16).padStart(64, '0')}`);
    // cancel: null (nothing goes to the wallet)
    const p2 = page.evaluate((d) => import('./wallet-safety.js').then((m) => m.safety({ win: window, lang: () => 'th' }).confirmTx({ network: 'ZETAPHY (77390)', from: '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245', to: '0x9D44EA6837938d4FEF98367A7b5867cdCa8DE596', data: d })), unlimited);
    await page.waitForSelector('#ws-confirm[open]');
    assert.match(await page.textContent('#ws-confirm'), /ตรวจก่อนเซ็น[\s\S]*อนุญาตไม่จำกัด/, 'in the page language');
    await page.click('#ws-confirm [data-ws="cancel"]');
    assert.equal(await p2, null);
    assert.deepEqual(errors, [], 'no page errors, no CSP violations');
  } finally {
    await browser.close();
    site.close();
  }
});
