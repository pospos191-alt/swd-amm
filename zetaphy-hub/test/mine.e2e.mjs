// Browser test: "Mine testnet ZETAPHY" (the proof-of-work faucet), the Earn page's faucet form and the
// validator guide's faucet form, on a built dist/ served with the site's own CSP, against a mocked node
// (low difficulty). Nothing runs before Start; the claim carries a proof the mock checks like the node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer, powClaims, POW_BITS } from './mocknode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const ACC = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';
const vercel = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8'));
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;

test('mine testnet ZETAPHY in the browser, and the faucet forms', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  let nodeDown = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (new URL(u).origin === new URL(site.url).origin) return route.continue();
      if (new URL(u).origin === 'https://rpc.sawasdeecoin.com') {
        if (nodeDown) return route.abort('connectionrefused');
        const a = answer(u, route.request().postData());
        if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    // count the Web Workers the page starts and stops
    await page.addInitScript(() => {
      const W = window.Worker;
      window.__workers = { made: 0, ended: 0 };
      window.Worker = class extends W {
        constructor(...a) { super(...a); window.__workers.made++; }
        terminate() { window.__workers.ended++; super.terminate(); }
      };
    });

    await page.goto(`${site.url}?tab=mine`);
    await page.waitForSelector('#mn-start');
    assert.equal(await page.textContent('#page-title'), 'Mine testnet ZETAPHY');
    assert.match(await page.textContent('.page-mine'), /not real mining/);
    await page.waitForFunction(() => /12 zero bits/.test(document.getElementById('mn-bits').textContent));
    assert.match(await page.textContent('#mn-left'), /199 \/ 200/);
    assert.equal(await page.inputValue('#mn-threads'), '2', 'two threads by default');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'mine: one screen');
    assert.deepEqual(await page.evaluate(() => window.__workers), { made: 0, ended: 0 }, 'nothing runs before Start');

    await page.click('#mn-start');
    await page.waitForFunction(() => document.getElementById('mn-msg').classList.contains('bad'));
    assert.match(await page.textContent('#mn-msg'), /0x… or zetaphy1…/, 'an address first');
    await page.fill('#mn-addr', ACC);
    await page.selectOption('#mn-threads', '1');
    await page.click('#mn-start');
    await page.waitForFunction(() => document.getElementById('mn-msg').classList.contains('ok'), null, { timeout: 30_000 });
    assert.match(await page.textContent('#mn-msg'), /10 test ZETAPHY/);
    assert.equal(powClaims.length, 1);
    assert.ok(powClaims[0].ok, 'the proof holds');
    assert.equal(powClaims[0].addr, ACC);
    assert.match(powClaims[0].nonce, /^0x[0-9a-f]{16}$/);
    assert.equal(powClaims[0].height, '0x1e240');
    const w = await page.evaluate(() => window.__workers);
    assert.equal(w.made, 1, 'one thread');
    assert.equal(w.ended, w.made, 'the workers stop once the proof is found');
    assert.equal(await page.isDisabled('#mn-start'), false);
    assert.ok(POW_BITS < 20);
    await page.click('#mn-tx a');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('tab') === 'explorer');

    // Earn: the mining card opens the mining page; the faucet card has a working form
    await page.click('.tab[data-tab="earn"]');
    assert.match(await page.textContent('.page-earn'), /Is browser mining real mining\?/);
    await page.click('.earn-tab[data-id="mine"]');
    await page.click('#earn-open-mine');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('tab') === 'mine');
    await page.click('.tab[data-tab="earn"]');
    await page.click('.earn-tab[data-id="faucet"]');
    assert.equal(await page.inputValue('#ef-addr'), '', 'no wallet connected: empty');
    await page.fill('#ef-addr', ACC);
    await page.click('#ef-get');
    await page.waitForFunction(() => document.getElementById('ef-msg').classList.contains('ok'));
    assert.match(await page.textContent('#ef-msg'), /10 test ZETAPHY.*Transaction 0xabab/);
    assert.match(await page.textContent('.earn-detail'), /zetaphy_faucet/, 'the terminal command stays below');
    await page.fill('#ef-addr', '0x000000000000000000000000000000000000dEaD');
    await page.click('#ef-get');
    await page.waitForFunction(() => document.getElementById('ef-msg').classList.contains('bad'));
    assert.match(await page.textContent('#ef-msg'), /already has ZETAPHY/, 'the node\'s own reason');
    nodeDown = true;
    await page.fill('#ef-addr', ACC);
    await page.click('#ef-get');
    await page.waitForFunction(() => /cannot be reached/.test(document.getElementById('ef-msg').textContent));
    await page.fill('#ef-addr', 'nope');
    await page.click('#ef-get');
    await page.waitForFunction(() => /0x… or zetaphy1…/.test(document.getElementById('ef-msg').textContent));
    nodeDown = false;
    await page.click('.earn-tab[data-id="validator"]');
    assert.equal(await page.getAttribute('#earn-guide', 'href'), 'validators.html');
    assert.equal(await page.getAttribute('#nav-guide', 'href'), 'validators.html', 'the guide in the menu');

    // Thai: the mining page and its tab
    await page.selectOption('#lang', 'th');
    await page.click('.tab[data-tab="mine"]');
    await page.waitForFunction(() => document.getElementById('page-title').textContent === 'ขุด ZETAPHY ทดลอง');
    assert.match(await page.textContent('.page-mine'), /ไม่ใช่การขุดจริง/);
    await page.selectOption('#lang', 'en');

    // the validator guide: topics as tabs (hash in the address, arrow keys), its own faucet form, the mining page
    await page.goto(`${site.url}validators.html`);
    assert.deepEqual(await page.$$eval('#vtabs [role="tab"]', (b) => b.map((x) => x.dataset.tab)), ['start', 'check', 'get', 'fix', 'rewards', 'keys', 'advanced']);
    assert.ok(await page.isVisible('#cmd') && !(await page.isVisible('#k-status')), 'Start open, the others closed');
    assert.equal(await page.textContent('#t-check'), 'Check it works');
    assert.match(await page.textContent('#p-start .tab-lede'), /Pick where/);
    await page.focus('#t-start');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('#t-check', 'aria-selected'), 'true');
    assert.equal(new URL(page.url()).hash, '#check');
    assert.ok(await page.isVisible('#k-status'));
    await page.keyboard.press('End');
    assert.equal(new URL(page.url()).hash, '#advanced');
    await page.goto(`${site.url}validators.html#resume`); // an old link: the restart steps
    assert.equal(await page.getAttribute('#t-fix', 'aria-selected'), 'true');
    assert.ok(await page.isVisible('#r-unjail'));
    await page.goto(`${site.url}validators.html#get`);
    assert.ok(await page.isVisible('#vf-form'));
    await page.fill('#vf-addr', ACC);
    await page.click('#vf-get');
    await page.waitForFunction(() => document.getElementById('vf-msg').classList.contains('ok'));
    assert.match(await page.textContent('#vf-msg'), /10 test ZETAPHY/);
    nodeDown = true;
    await page.click('#vf-get');
    await page.waitForFunction(() => /cannot be reached/.test(document.getElementById('vf-msg').textContent));
    nodeDown = false;
    assert.equal(await page.getAttribute('#vf-mine', 'href'), './?tab=mine');
    assert.deepEqual(errors, [], 'no page errors, nothing blocked by the CSP');
  } finally {
    await browser.close();
    site.close();
  }
});
