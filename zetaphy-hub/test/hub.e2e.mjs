// Browser test: the hub on a built dist/, against a mocked node (no network).
//   npm run build && npm run test:e2e        (SHOTS=<dir> also saves a screenshot per tab)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;

test('the hub: tabs, one screen, hover text, embedded apps, stake and vote', { timeout: 120_000 }, async () => {
  const site = await serve(DIST);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (new URL(u).origin === new URL(site.url).origin) return route.continue();
      const a = new URL(u).origin === 'https://rpc.sawasdeecoin.com' ? answer(u, route.request().postData()) : null;
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    const shot = async (n) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${n}.png`) }); };

    await page.goto(site.url);
    // overview: live numbers from the node, no page scroll
    await page.waitForFunction(() => document.getElementById('s-height').textContent === '123,456');
    await page.waitForFunction(() => document.querySelectorAll('#blocks tr.link').length === 8);
    assert.equal(await page.textContent('#s-time'), '5.0s');
    assert.equal(await page.textContent('#s-vals'), '2');
    assert.equal(await page.textContent('#s-bonded'), '1,250,000');
    assert.match(await page.textContent('#blocks'), /zetaphy-gcp-1/, 'proposer shown by name');
    const fits = await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.body.scrollHeight <= innerHeight);
    assert.ok(fits, 'everything fits in one screen');
    assert.equal(await page.locator('text=SAWASDEE COIN').count(), 0, 'the chain name only');
    await shot('home');

    // hover text instead of paragraphs
    await page.hover('.stat >> nth=0');
    await page.waitForSelector('#tip:not([hidden])');
    assert.match(await page.textContent('#tip'), /บล็อก/);

    // faucet
    await page.fill('#faucet-addr', '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245');
    await page.click('#faucet-form button');
    await page.waitForFunction(() => document.getElementById('faucet-msg').classList.contains('ok'));

    // stake & vote: validators by power, proposals with vote buttons
    await page.click('.tab[data-tab="stake"]');
    assert.match(page.url(), /\?tab=stake$/);
    await page.waitForFunction(() => document.querySelectorAll('#vals tr').length === 2);
    assert.match(await page.textContent('#vals tr:first-child'), /zetaphy-gcp-1.*80\.00%.*10\.0%/s);
    await page.waitForFunction(() => document.querySelectorAll('#props li').length === 3);
    assert.equal(await page.locator('#props li:first-child .votes button').count(), 4, 'a proposal in voting has 4 vote buttons');
    await shot('stake');

    // the data pages, like a chain explorer's
    await page.click('.tab[data-tab="earn"]');
    await page.waitForFunction(() => document.getElementById('e-bond')?.textContent === '100');
    assert.match(await page.textContent('.earn-detail'), /node cli\.js node start/);
    assert.match(await page.textContent('.earn-detail'), /0x698dC17df6a34b02263b295d101BE39F3F3B433B/, 'the real NeuroJobs address in the commands');
    assert.match(await page.textContent('.earn-detail'), /100 ZETAPHY/, 'the live bond in the steps');
    await page.click('.earn-item[data-id="validator"]');
    assert.match(await page.textContent('.earn-detail'), /JOIN=rpc\.sawasdeecoin\.com/);
    assert.doesNotMatch(await page.textContent('.earn-detail'), /null|undefined/);
    await shot('earn');
    await page.click('.tab[data-tab="analytics"]');
    await page.waitForFunction(() => document.querySelectorAll('#a-c1 .bar').length === 60 && document.querySelectorAll('#a-c2 .bar').length === 59);
    await page.waitForFunction(() => document.getElementById('a-supply').textContent !== '–');
    await page.waitForFunction(() => document.querySelectorAll('#a-power .hbar').length === 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'analytics: one screen');
    await shot('analytics');
    await page.click('.tab[data-tab="defi"]');
    await page.waitForFunction(() => document.querySelectorAll('#d-rows tr').length === 1 && /ZTPHY \/ tUSD/.test(document.getElementById('d-rows').textContent));
    assert.match(await page.textContent('#d-rows'), /1 ZTPHY = 0\.01 tUSD/);
    assert.equal(await page.textContent('#d-jobs'), '42');
    await shot('defi');
    await page.click('.tab[data-tab="leaderboard"]');
    await page.waitForFunction(() => document.querySelectorAll('#l-holders tr').length === 3);
    assert.match(await page.textContent('#l-holders tr:first-child'), /500,000,000/, 'largest holder first');
    assert.match(await page.textContent('#l-holders'), /bonded_tokens_pool/, 'module accounts are named');
    await shot('leaderboard');
    await page.click('.tab[data-tab="dev"]');
    assert.match(await page.textContent('.page-dev'), /eth_blockNumber/);
    assert.match(await page.textContent('.page-dev'), /0x8fB5…bEc3|0x8fB5B0ea/);
    await shot('dev');

    // each app in the hub look, inside the same screen, with its long hints folded into "i"
    for (const [tab, ready] of [['wallet', '#rpc, input'], ['swap', '#connect-btn'], ['nft', '#connect'], ['explorer', '#search'], ['neuro', '#address']]) {
      await page.click(`.tab[data-tab="${tab}"]`);
      const frame = page.frameLocator(`iframe[src^="${tab === 'neuro' ? 'neuro/web/' : `${tab}/`}"]`);
      await frame.locator(ready).first().waitFor();
      const h = await page.locator(`iframe[src^="${tab === 'neuro' ? 'neuro/web/' : `${tab}/`}"]`).elementHandle();
      const f = await h.contentFrame();
      await f.waitForFunction(() => document.documentElement.classList.contains('hub-embed'));
      await f.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(5, 7, 10)');
      await page.waitForFunction((t) => document.querySelector(`iframe[title]:not([hidden])`)?.style.visibility === '', tab);
      if (tab === 'wallet' || tab === 'swap') assert.ok(await f.locator('.hub-i').count() > 0, `${tab}: hints folded into i icons`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `${tab}: one screen`);
      await shot(tab);
    }
    // a link to another app's site stays in the hub
    const wf = await (await page.locator('iframe[src^="neuro/web/"]').elementHandle()).contentFrame();
    await wf.evaluate(() => { const a = document.createElement('a'); a.href = 'https://explorer.sawasdeecoin.com/#/block/5'; a.id = 'x'; a.textContent = 'x'; document.body.append(a); });
    await wf.click('#x');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('tab') === 'explorer');

    // English everywhere, on demand
    await page.click('#lang');
    await page.waitForFunction(() => document.getElementById('page-title').textContent.length > 0 && document.documentElement.lang === 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-dex:lang')), 'en', 'the apps follow the hub language');

    // narrow screen: bottom bar, still no page scroll
    await page.setViewportSize({ width: 390, height: 780 });
    await page.click('.tab[data-tab="home"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.side')).flexDirection), 'row');
    await shot('mobile');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    site.close();
  }
});
