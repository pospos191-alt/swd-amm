// Browser test of the Offline tab under the site's real CSP: online once, the tab registers the service worker (app
// shell only), makes the encrypted offline key and syncs a channel whose cheque signer is that key (a fake node
// answers channels(1)). Then the network goes away (context.setOffline): the hub reloads from the service worker,
// says it is offline, and the tab still unlocks the key, signs cheques (QR + text), checks them as the payee
// (valid, newer only, nothing over the deposit), and signs and checks a swap order.
//   npm run build && node --test test/offline.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { AbiCoder } from 'ethers';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { SEL } from '../offline-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const abi = AbiCoder.defaultAbiCoder();
const CHQ = '0x' + '5c'.repeat(20), ORD = '0x' + '0d'.repeat(20);
const PAYER = '0x' + '0a'.repeat(20), PAYEE = '0x' + '0b'.repeat(20);
const E18 = 10n ** 18n;

test('Offline tab: works with the network gone after one visit: key, cheques signed and checked, an order', { timeout: 180_000 }, async () => {
  const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
  cfg.contracts = { ...cfg.contracts, zetaphyCheques: CHQ, offlineOrders: ORD };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    let signer = '0x' + '00'.repeat(20);
    const now = Math.floor(Date.now() / 1000);
    await context.route('https://rpc.sawasdeecoin.com/**', async (route) => {
      const body = route.request().postData() ?? '';
      const req = (() => { try { return JSON.parse(body); } catch { return null; } })();
      let a = null;
      if (req?.method === 'eth_call' && req.params[0]?.to?.toLowerCase() === CHQ && req.params[0].data.startsWith(SEL.channels)) {
        a = { jsonrpc: '2.0', id: req.id, result: abi.encode(['address', 'uint64', 'uint64', 'address', 'address', 'address', 'uint256', 'uint256', 'bool'],
          [PAYER, now + 7 * 86400, 0, PAYEE, '0x' + '00'.repeat(20), signer, 10n * E18, 0n, false]) };
      } else a = answer(route.request().url(), body);
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });

    // ---- online, once
    await page.goto(`${site.url}?tab=offline`);
    assert.ok(await page.$('.tab[data-tab="offline"]'), 'listed with the tabs');
    await page.waitForSelector('#off-create-form');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.waitForSelector('#off-net[data-online="1"]');
    assert.equal(await page.isVisible('#net-pill'), false, 'no offline pill while online');
    await page.fill('#off-pass', 'short');
    await page.fill('#off-pass2', 'short');
    await page.click('#off-create');
    await page.waitForSelector('#off-create-form .msg.bad');
    await page.fill('#off-pass', 'correct horse battery');
    await page.fill('#off-pass2', 'correct horse battery');
    await page.click('#off-create');
    await page.waitForSelector('#off-key-addr', { timeout: 30_000 });
    signer = (await page.textContent('#off-key-addr')).trim();
    assert.match(signer, /^0x[0-9a-f]{40}$/);
    const stored = await page.evaluate(() => localStorage.getItem('zetaphy-offline:v1'));
    assert.ok(stored.includes('"kdf":"PBKDF2-SHA256"') && !/"sk"/.test(stored), 'the key is stored encrypted only');
    await page.fill('#off-sync-id', '1');
    await page.click('#off-sync');
    await page.waitForSelector('tr[data-ch="1"][data-role="payer"]');
    assert.match(await page.textContent('tr[data-ch="1"]'), /deposit 10 ZTPHY/);

    // ---- the network goes away; the hub comes back from the service worker
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#off-key-state[data-state="locked"]', { timeout: 30_000 });
    await page.waitForSelector('#net-pill:not([hidden])');
    assert.match(await page.textContent('#net-pill'), /Offline/);
    await page.waitForSelector('#off-net[data-online="0"]');
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    // unlock and pay 2.5, then 1 more
    await page.fill('#off-unlock-pass', 'wrong passphrase!!');
    await page.click('#off-unlock');
    await page.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#off-key')?.textContent ?? ''));
    await page.fill('#off-unlock-pass', 'correct horse battery');
    await page.click('#off-unlock');
    await page.waitForSelector('#off-key-state[data-state="unlocked"]', { timeout: 30_000 });
    const write = async (amount) => {
      await page.fill('#off-write-amt', amount);
      await page.click('#off-write');
      await page.waitForFunction((a) => (document.querySelector('#off-write-ok')?.textContent ?? '').includes(`${a} ZTPHY now`), amount);
      assert.ok(await page.$('#off-write-out svg.off-qr path'), 'a QR code');
      return page.inputValue('#off-out-text');
    };
    const first = await write('2.5');
    assert.match(first, /^ZCHQ1:/);
    const second = await write('1');
    assert.match(await page.textContent('#off-write-ok'), /total 3\.5 ZTPHY/);
    await page.fill('#off-write-amt', '7');
    await page.click('#off-write');
    await page.waitForFunction(() => /only 6\.5 ZTPHY left/.test(document.querySelector('#off-write-out')?.textContent ?? ''));
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'offline.png'), fullPage: true });

    // the payee's side, still offline: the first cheque, then the second, then the first again
    const check = async (text) => {
      await page.fill('#off-recv-text', text);
      await page.click('#off-recv-check');
      await page.waitForSelector('#off-recv-out [data-ok]');
      const ok = await page.getAttribute('#off-recv-out [data-ok]', 'data-ok');
      const out = await page.textContent('#off-recv-out');
      await page.evaluate(() => document.querySelector('#off-recv-out').replaceChildren());
      return { ok, out };
    };
    let r = await check(first);
    assert.equal(r.ok, '1', r.out);
    assert.match(r.out, /\+2\.5 ZTPHY for you \(total 2\.5 ZTPHY, channel #1\)/);
    assert.match(r.out, /Deposit10 ZTPHY · as of/);
    assert.match(r.out, /Kept on this device/);
    r = await check(second);
    assert.equal(r.ok, '1', r.out);
    assert.match(r.out, /\+1 ZTPHY for you \(total 3\.5 ZTPHY/);
    r = await check(first);
    assert.equal(r.ok, '0');
    assert.match(r.out, /Not newer than the best cheque/);
    r = await check(first.slice(0, -4) + (first.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
    assert.equal(r.ok, '0', 'a changed cheque');

    // a swap order, signed with the offline key and checked by a relayer, with no network
    await page.selectOption('#off-o-out', 'other');
    await page.fill('#off-o-out-addr', '0x' + '22'.repeat(20));
    await page.fill('#off-o-amt', '10');
    await page.fill('#off-o-min', '9.5');
    await page.fill('#off-o-fee', '0.1');
    await page.selectOption('#off-o-with', 'key');
    await page.click('#off-o-sign');
    await page.waitForSelector('#off-o-ok');
    assert.match(await page.textContent('#off-o-ok'), /sell 10 ZTPHY\* for at least 9\.5/);
    const order = await page.inputValue('#off-o-out #off-out-text');
    assert.match(order, /^ZORD1:/);
    await page.fill('#off-relay-text', order);
    await page.click('#off-relay-check');
    await page.waitForSelector('#off-relay-out [data-ok]');
    assert.equal(await page.getAttribute('#off-relay-out [data-ok]', 'data-ok'), '1');
    assert.match(await page.textContent('#off-relay-out'), /Valid order/);
    await page.fill('#off-relay-text', first);
    await page.click('#off-relay-check');
    await page.waitForFunction(() => /That is a cheque/.test(document.querySelector('#off-relay-out')?.textContent ?? ''));

    // Thai, still offline
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => /อ่านก่อน: ความเสี่ยง/.test(document.querySelector('.page-offline')?.textContent ?? ''));
    assert.match(await page.textContent('#net-pill'), /ออฟไลน์/);
    await context.setOffline(false);
    await page.waitForSelector('#net-pill[hidden]', { state: 'attached' });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); site.close(); }
});
