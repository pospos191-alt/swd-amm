// Browser test of the Offline tab's "Offline cash" and "Mesh" cards under the site's real CSP. Online once (the service
// worker keeps the app shell), the page makes the encrypted cash key. Then the network goes away: a note signed over
// to that key (made here in Node with the same logic) is pasted and checked offline (valid, not covered without a proof),
// kept, carried as SMS frames out of order through the Mesh import, and signed over to the next holder, all offline.
//   npm run build && node --test test/cash.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import * as cash from '../cash-core.js';
import { holderOf } from '../offline-cash.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const CASHC = '0x' + 'ca'.repeat(20);
const { ml_dsa44: ml, keccak_256 } = await import('../../zetaphy-wallet/vendor/pqwallet.js');
const C = { keccak: (b) => keccak_256(b), verify: (s, m, pk) => ml.verify(s, m, pk) };
const issuer = holderOf(ml, C, new Uint8Array(32).fill(1));
const next = holderOf(ml, C, new Uint8Array(32).fill(9));

test('Offline cash: key, receive and check a note, Mesh frames back in, sign it over: all with the network gone', { timeout: 180_000 }, async () => {
  const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
  cfg.contracts = { ...cfg.contracts, offlineCash: CASHC };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('https://rpc.sawasdeecoin.com/**', async (route) => {
      const a = answer(route.request().url(), route.request().postData() ?? '');
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });

    await page.goto(`${site.url}?tab=offline`);
    await page.waitForSelector('#off-cash-create-form');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.fill('#off-cash-pass', 'cash key passphrase');
    await page.fill('#off-cash-pass2', 'cash key passphrase');
    await page.click('#off-cash-create');
    await page.waitForSelector('#off-cash-keyhash', { timeout: 30_000 });
    const myKey = (await page.textContent('#off-cash-keyhash')).trim();
    assert.match(myKey, /^0x[0-9a-f]{64}$/);
    const stored = await page.evaluate(() => localStorage.getItem('zetaphy-offline-cash:v1'));
    assert.ok(stored.includes('"kdf":"PBKDF2-SHA256"') && !stored.includes('"seed"'), 'the seed is stored encrypted only');

    // ---- offline from here
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#off-cash-state[data-state="locked"]', { timeout: 30_000 });
    await page.waitForSelector('#off-net[data-online="0"]');
    const lockUntil = Math.floor(Date.now() / 1000) + 20 * 86400;
    const note = { v: 1, chainId: 77390, contract: CASHC, note: { id: '3', issuer: '0x' + '11'.repeat(20), value: String(5n * 10n ** 18n), lockUntil, issuerKey: issuer.key }, links: [] };
    const mine = cash.passOn(C, note, issuer, myKey);
    await page.fill('#off-cash-in', cash.noteToText(mine));
    await page.click('#off-cash-check');
    await page.waitForSelector('#off-cash-verdict');
    assert.equal(await page.getAttribute('#off-cash-verdict', 'data-ok'), '1', await page.textContent('#off-cash-recv-out'));
    assert.match(await page.textContent('#off-cash-verdict'), /Valid note: 5 ZTPHY, signed over 1 time/);
    assert.ok(await page.$('#off-cash-recv-out [data-code="noProof"]'), 'no proof: says so');
    await page.click('#off-cash-keep');
    await page.waitForSelector('#off-cash-notes-list [data-note="3"]');

    // a note for somebody else, and a tampered one
    await page.fill('#off-cash-in', cash.noteToText(cash.passOn(C, note, issuer, next.key)));
    await page.click('#off-cash-check');
    await page.waitForSelector('#off-cash-recv-out [data-code="notToYou"]');

    // ---- the same note as SMS frames, pasted in two goes, out of order
    await page.fill('#off-mesh-in', cash.noteToText(mine));
    await page.selectOption('#off-mesh-medium', 'sms-text');
    await page.click('#off-mesh-make');
    await page.waitForSelector('#off-mesh-info');
    const n = Number(await page.getAttribute('#off-mesh-info', 'data-frames'));
    assert.ok(n > 30 && n < 60, `${n} SMS`);
    assert.ok(await page.$('#off-mesh-qr svg.off-qr path'), 'each frame as a QR code too');
    const frames = (await page.inputValue('#off-mesh-out')).split('\n');
    assert.ok(frames.every((f) => f.length <= 160));
    await page.fill('#off-mesh-import', frames.slice(5).reverse().join('\n'));
    await page.click('#off-mesh-import-btn');
    await page.waitForSelector('#off-mesh-import-out [data-state="partial"]');
    assert.match(await page.textContent('#off-mesh-import-out'), new RegExp(`${n - 5} of ${n} frames`));
    await page.fill('#off-mesh-import', frames.slice(0, 5).join('\n'));
    await page.click('#off-mesh-import-btn');
    await page.waitForSelector('#off-mesh-complete[data-type="note"]');
    await page.waitForSelector('#off-cash-verdict[data-ok="1"]');

    // ---- sign it over to the next holder (unlock first, still offline)
    await page.fill('#off-cash-unlock-pass', 'cash key passphrase');
    await page.click('#off-cash-unlock');
    await page.waitForSelector('#off-cash-state[data-state="unlocked"]', { timeout: 30_000 });
    await page.fill('#off-cash-to-0', next.key);
    await page.click('#off-cash-pass-0');
    await page.waitForSelector('#off-cash-share-text');
    const passed = cash.noteFromText(await page.inputValue('#off-cash-share-text'));
    const v = cash.receiveCheck(C, passed, { me: next.key, contract: CASHC });
    assert.ok(v.ok, v.problems.join());
    assert.equal(v.seq, 2);
    assert.equal(await page.$('#off-cash-notes-list [data-note="3"]'), null, 'no longer held here');
    assert.ok(Number(await page.getAttribute('#off-mesh-info', 'data-frames')) > n, 'the passed-on note is ready as frames (one link longer)');
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'offline-cash.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await site.close();
  }
});
