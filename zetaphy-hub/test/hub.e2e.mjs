// Browser test: the hub on a built dist/, against a mocked node (no network).
//   npm run build && npm run test:e2e        (SHOTS=<dir> also saves a screenshot per tab)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer, USDC } from './mocknode.mjs';
import { Interface } from 'ethers';

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
    // a stand-in MetaMask: records what the page asks it to send
    await page.addInitScript(() => {
      window.__sent = [];
      // connected once (here or in another frame of this site): eth_accounts answers without a prompt
      const ACC = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';
      window.ethereum = { isMetaMask: true, on: () => {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') { localStorage.setItem('__granted', '1'); return [ACC]; }
        if (method === 'eth_accounts') return localStorage.getItem('__granted') ? [ACC] : [];
        if (method === 'eth_chainId') return '0x12e4e';
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_sendTransaction') { window.__sent.push(params[0]); return `0x${'cd'.repeat(32)}`; }
        throw new Error(`not mocked: ${method}`);
      } };
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
    assert.equal(await page.getAttribute('html', 'lang'), 'en', 'English by default');
    assert.match(await page.textContent('#tip'), /newest block/);

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
    // ZETAPHY Saphan: routes from the chain, send out through the ICS-20 precompile from MetaMask
    await page.click('.tab[data-tab="saphan"]');
    await page.waitForFunction(() => document.querySelectorAll('#sp-routes tr').length === 1 && /Noble testnet/.test(document.getElementById('sp-routes').textContent));
    assert.match(await page.textContent('#sp-routes'), /channel-0 → channel-123/);
    // EVM routes (Hyperlane) from the chain table in hub-config.json: every chain listed, planned until deployed
    assert.match(await page.textContent('#sp-evm'), /EVM chains \(Hyperlane\)[\s\S]*Sepolia[\s\S]*Base Sepolia[\s\S]*Arbitrum Sepolia/);
    assert.equal(await page.locator('#sp-evm .pill').count(), 3);
    await page.click('#sp-go'); // connect first: the site-wide wallet dialog
    await page.waitForSelector('#wb-dialog[open] .wb-wallet');
    assert.match(await page.textContent('#wb-dialog'), /MetaMask/, 'the wallets in this browser');
    await page.click('#wb-dialog .wb-wallet');
    await page.waitForFunction(() => /0x6af5…a245/.test(document.getElementById('wb-btn').textContent));
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy:wallet')), '"injected:ethereum"', 'the choice is kept for the whole site (the id only)');
    await page.waitForFunction(() => /1,000 ZETAPHY/.test(document.getElementById('wb-btn').textContent), null, { timeout: 10000 });
    assert.match(await page.textContent('#wb-body'), /On the ZETAPHY chain[\s\S]*ZETAPHY[\s\S]*1,000/, 'balances on the ZETAPHY chain');
    await page.click('#wb-close');
    await page.waitForFunction(() => /USDC · 2\.5/.test(document.getElementById('sp-asset')?.textContent ?? ''));
    assert.match(await page.textContent('#sp-recv'), /zetaphy1dt6hlsmr8/, 'own zetaphy1… address to receive');
    assert.match(await page.textContent('#sp-recv'), /channel-123/, 'which channel to use on the other side');
    await page.fill('#sp-to', 'osmo1dt6hlsmr8hg00yrl0yqdh49zsgh58gj9vdens7');
    await page.fill('#sp-amount', '1');
    await page.click('#sp-go');
    await page.waitForFunction(() => document.getElementById('sp-msg').classList.contains('bad'));
    assert.match(await page.textContent('#sp-msg'), /noble1/, 'a receiver of the wrong chain is refused before signing');
    await page.selectOption('#sp-asset', USDC);
    await page.fill('#sp-to', 'noble1dt6hlsmr8hg00yrl0yqdh49zsgh58gj9v4lt7z');
    await page.fill('#sp-amount', '1.5');
    await page.click('#sp-go');
    await page.waitForFunction(() => document.getElementById('sp-msg').classList.contains('ok'));
    const [tx] = await page.evaluate(() => window.__sent);
    assert.equal(tx.to, '0x0000000000000000000000000000000000000802');
    const ics20 = new Interface(['function transfer(string,string,string,uint256,address,string,(uint64,uint64),uint64,string)']);
    const args = ics20.decodeFunctionData('transfer', tx.data);
    assert.deepEqual([args[0], args[1], args[2], args[3], args[5]], ['transfer', 'channel-0', USDC, 1500000n, 'noble1dt6hlsmr8hg00yrl0yqdh49zsgh58gj9v4lt7z']);
    assert.ok(args[7] > BigInt(Date.now()) * 1_000_000n, 'a timeout in the future (ns)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'saphan: one screen');
    await shot('saphan');
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
      // connected once in the hub: Swap and NFT are connected too, without asking again
      if (tab === 'swap') await f.waitForFunction(() => /0x6af5/i.test(document.getElementById('connect-btn').textContent), null, { timeout: 10000 });
      if (tab === 'nft') await f.waitForFunction(() => /0x6af5/i.test(document.getElementById('connect').textContent), null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `${tab}: one screen`);
      await shot(tab);
    }
    // a link to another app's site stays in the hub
    const wf = await (await page.locator('iframe[src^="neuro/web/"]').elementHandle()).contentFrame();
    await wf.evaluate(() => { const a = document.createElement('a'); a.href = 'https://explorer.sawasdeecoin.com/#/block/5'; a.id = 'x'; a.textContent = 'x'; document.body.append(a); });
    await wf.click('#x');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('tab') === 'explorer');

    // the language menu: the 8 languages in order; a choice reaches every app's own setting
    assert.deepEqual(await page.$$eval('#lang option', (os) => os.map((o) => [o.value, o.textContent])),
      [['en', 'English'], ['zh', '中文'], ['es', 'Español'], ['ko', '한국어'], ['ja', '日本語'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'], ['th', 'ไทย']]);
    assert.equal(await page.inputValue('#lang'), 'en');
    const appLang = () => page.evaluate(() => Object.fromEntries(['zetaphy-wallet:lang', 'zetaphy-dex:lang', 'zn.lang', 'zetaphy-explorer:lang', 'neuro-lang'].map((k) => [k, localStorage.getItem(k)])));
    const everyApp = (l) => ({ 'zetaphy-wallet:lang': l, 'zetaphy-dex:lang': l, 'zn.lang': JSON.stringify(l), 'zetaphy-explorer:lang': l, 'neuro-lang': l });
    assert.deepEqual(await appLang(), everyApp('en'));
    await page.click('.tab[data-tab="stake"]');
    for (const [l, title] of [['zh', '质押与投票'], ['es', 'Stake y votación'], ['ko', '스테이킹 및 투표'], ['ja', 'ステークと投票'], ['vi', 'Stake và bỏ phiếu'], ['ru', 'Стейкинг и голосование']]) {
      await page.selectOption('#lang', l);
      await page.waitForFunction((x) => document.documentElement.lang === x, l);
      assert.equal(await page.textContent('#page-title'), title, `${l}: page title`);
      assert.deepEqual(await appLang(), everyApp(l), `${l}: written to every app`);
      assert.doesNotMatch(await page.textContent('.shell'), /\b(tip|col|an|df|lb|dev)[A-Z][A-Za-z]+\b|\b(app|appSub|tipApp)_[a-z]+\b/, `${l}: no raw keys`);
    }
    await page.waitForFunction(() => /Голосование до/.test(document.getElementById('props').textContent));
    assert.match(await page.textContent('#props'), /Голосование до .*\d{4}/, 'dates and words in the chosen language');

    // Thai everywhere, on demand
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => document.getElementById('page-title').textContent.length > 0 && document.documentElement.lang === 'th');
    assert.deepEqual(await appLang(), everyApp('th'), 'the apps follow the hub language');
    assert.equal(await page.evaluate(() => localStorage.getItem('zn.lang')), '"th"');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === 'th');
    assert.equal(await page.inputValue('#lang'), 'th', 'the menu shows the remembered language');
    await page.click('.tab[data-tab="home"]');
    await page.hover('.stat >> nth=0');
    await page.waitForSelector('#tip:not([hidden])');
    assert.match(await page.textContent('#tip'), /บล็อก/, 'Thai remembered');
    await page.click('.tab[data-tab="earn"]');
    assert.match(await page.textContent('.page-earn'), /ทำไมไม่มีการขุด PoW\?/);

    // an unknown stored language is English
    await page.evaluate(() => localStorage.setItem('zetaphy-hub:lang', 'fr'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('page-title').textContent === 'How to earn ZETAPHY');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.equal(await page.inputValue('#lang'), 'en');

    // narrow screen: bottom bar, still no page scroll
    await page.setViewportSize({ width: 390, height: 780 });
    await page.click('.tab[data-tab="home"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.side')).flexDirection), 'row');
    await page.selectOption('#lang', 'vi');
    await page.waitForFunction(() => document.documentElement.lang === 'vi');
    const fitsTop = await page.evaluate(() => { const r = document.getElementById('lang').getBoundingClientRect(); return r.right <= innerWidth && r.width > 40 && document.documentElement.scrollWidth <= innerWidth; });
    assert.ok(fitsTop, 'the language menu fits at phone width, no sideways scroll');
    await shot('mobile');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    site.close();
  }
});
