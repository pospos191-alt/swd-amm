// Browser test of the site (headless Chromium, Playwright): the page is served
// with its real CSP (scripts/serve.js), its RPC is answered by an in-process
// node on @ethereumjs/evm running the real contracts (test/helpers/rpcshim.js),
// and a mock EIP-6963 wallet sends the transactions. A seller creates a
// collection, mints (hostile metadata and an IPFS token), lists; a buyer finds
// the listing on Explore and buys it; offers; withdraw; a stale listing; the
// Neuro warning and refusal; an external collection; Thai/English; dark mode;
// a phone-width layout. No CSP violation, script dialog or page error may occur.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { Wallet } from 'ethers';
import { createShim, ZETA } from './helpers/rpcshim.js';
import { artifacts, mockArtifacts } from './helpers/chain.js';

const PORT = 18192;
const ORIGIN = `http://localhost:${PORT}`;
const RPC = 'https://rpc.zetaphy.test/';
const GW = 'https://gw.zetaphy.test/ipfs/';
const ZERO = '0x0000000000000000000000000000000000000000';
const seller = Wallet.createRandom().address;
const buyer = Wallet.createRandom().address;
const other = Wallet.createRandom().address;
const deployer = Wallet.createRandom().address;
// A 1x1 PNG for the IPFS image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert("svg")</script><rect width="10" height="10" fill="red"/></svg>';
const HOSTILE = { name: 'Cat‮gnp.exe <img src=x onerror=alert(1)>', description: 'Line one\n<script>alert(2)</script>​',
  image: 'data:image/svg+xml;base64,' + Buffer.from(HOSTILE_SVG).toString('base64'), attributes: [{ trait_type: 'Mood', value: 'Calm' }], animation_url: 'https://evil.test/x.html' };

let server, browser, shim, factory, market, registry, deployBlock;
const problems = [];
// The chain id the mock wallets report (a test switches it to check the refusal), and the txs they sent.
const wallet = { chainId: '0x12e4e', sent: [] };
// SCREENSHOTS=<dir>: also saves a few screenshots there (for a look at the layout).
const shot = async (page, name) => { if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true }); };

async function launch() {
  try { return await chromium.launch({ headless: true }); } catch {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  }
}

before(async () => {
  shim = await createShim({ fund: [seller, buyer, other, deployer] });
  deployBlock = Number(shim.blockNumber());
  factory = await shim.deploy(artifacts.NFTFactory, [], deployer);
  registry = await shim.deploy(mockArtifacts().MockThreatRegistry, [], deployer);
  market = await shim.deploy(artifacts.NFTMarketplace, [deployer, deployer, 100, registry.address, factory.address], deployer);
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url) });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

/** A browser context for one account: mock wallet, RPC and gateway routes, problem collection. */
async function contextFor(account, label) {
  const ctx = await browser.newContext({ locale: 'en-US' });
  await ctx.exposeBinding('__walletRequest', async (_src, method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return wallet.chainId;
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      assert.equal(tx.from.toLowerCase(), account.toLowerCase());
      assert.equal(tx.chainId, '0x12e4e', 'every transaction names chain 77390');
      wallet.sent.push(tx);
      return shim.send({ from: tx.from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
    }
    throw new Error(`wallet: ${method} not supported`);
  });
  await ctx.addInitScript(() => {
    window.__problems = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__problems.push(`CSP ${e.violatedDirective} ${e.blockedURI}`));
    const provider = { request: ({ method, params }) => window.__walletRequest(method, params ?? []).catch((e) => { throw Object.assign(new Error(e.message), { code: 4001 }); }) };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-wallet', name: 'Test Wallet‮', rdns: 'test.wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
  await ctx.route(`${RPC}**`, async (route) => {
    const body = JSON.parse(route.request().postData());
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(await shim.handle(body)) });
  });
  await ctx.route(`${GW}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG });
    const n = /\/(\d+)\.json$/.exec(path)?.[1] ?? '0';
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ name: `Gateway Cat ${n}`, description: 'from IPFS', image: `ipfs://bafytest/${n}.png` }) });
  });
  await ctx.route(`${ORIGIN}/deployments.json`, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ chainId: 77390, rpc: RPC, factory: factory.address, marketplace: market.address, threatRegistry: registry.address, deployBlock }) }));
  await ctx.addInitScript((gw) => { try { localStorage.setItem('zn.settings', JSON.stringify({ gateway: gw })); } catch {} }, GW);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${label} pageerror ${e.message}`));
  page.on('dialog', (d) => { problems.push(`${label} dialog ${d.message()}`); d.dismiss(); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`${label} console ${m.text()}`); });
  return page;
}

/** A fresh page load (a goto that only changes the hash would keep the page and its caches). */
async function go(page, hash) {
  await page.goto('about:blank');
  await page.goto(`${ORIGIN}/${hash}`);
  await page.waitForSelector('.page[data-ready]', { timeout: 20_000 });
}
async function reroute(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('.page[data-ready]', { timeout: 20_000 });
}
async function connect(page) {
  await page.click('#connect');
  await page.click('dialog .wallet-choice');
  await page.waitForFunction(() => /^0x/.test(document.querySelector('#connect').textContent));
  await page.waitForSelector('.page[data-ready]');
}
const clickAndWait = async (page, name, until) => {
  await page.getByRole('button', { name, exact: true }).first().click();
  await page.waitForFunction(until.fn, until.arg, { timeout: 20_000 }).catch(async (e) => {
    throw new Error(`${name}: ${e.message}; status: ${await page.textContent('#status')}`);
  });
};
const statusIs = (re) => ({ fn: (s) => new RegExp(s).test(document.querySelector('#status')?.textContent ?? '') && document.querySelector('.page[data-ready]'), arg: re.source });

test('create, mint, list, buy, offer, withdraw, stale listing, Neuro, external, i18n, mobile', { timeout: 240_000 }, async () => {
  const s = await contextFor(seller, 'seller');
  const b = await contextFor(buyer, 'buyer');

  // ---- seller creates a collection (5% royalty, max 10) ----
  await go(s, '#/create');
  await connect(s);
  await s.fill('input[name=name]', 'Siam Cats');
  await s.fill('input[name=symbol]', 'SCAT');
  await s.fill('input[name=royalty]', '5');
  await s.fill('input[name=maxSupply]', '10');
  await s.getByRole('button', { name: 'Create collection' }).click();
  await s.waitForSelector('.result a.mono', { timeout: 20_000 });
  const col = (await s.textContent('.result a.mono')).trim();
  assert.match(col, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(await factory.call('isCollection', [col]), true);

  // ---- mint #1 with hostile data: metadata, #2 from IPFS ----
  await reroute(s, `#/mint/${col}`);
  const hostileUri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(HOSTILE)).toString('base64');
  await s.fill('input[name=tokenUri]', hostileUri);
  await s.getByRole('button', { name: 'Preview metadata' }).click();
  await s.waitForSelector('.preview .nft-card');
  await s.getByRole('button', { name: 'Mint', exact: true }).click();
  await s.waitForSelector('#ownerMint ~ .result a', { timeout: 20_000 });
  await s.fill('input[name=tokenUri]', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/2.json');
  await s.getByRole('button', { name: 'Mint', exact: true }).click();
  await s.waitForFunction(() => document.querySelector('#ownerMint ~ .result a')?.textContent === '#2', null, { timeout: 20_000 });
  const nft = shim.at(col, new (await import('ethers')).Interface(artifacts.ZetaphyERC721.abi));
  assert.equal(await nft.call('tokenURI', [2]), 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/2.json');

  // ---- the hostile token renders as text and an <img> only ----
  await reroute(s, `#/i/${col}/1`);
  assert.equal(await s.textContent('.item-info h1'), 'Catgnp.exe <img src=x onerror=alert(1)>');
  assert.equal(await s.locator('.item-info img, .item-info script').count(), 0, 'no element came from the metadata');
  const src = await s.getAttribute('.item-media img', 'src');
  assert.ok(src.startsWith('data:image/svg+xml;base64,'), 'SVG only as an <img src>');
  assert.equal(await s.locator('svg').count(), 0, 'SVG never inline');
  assert.match(await s.textContent('.item-info .desc'), /^Line one\n<script>alert\(2\)<\/script>$/);
  assert.match(await s.textContent('.item-info'), /ZETAPHY factory/);
  assert.match(await s.textContent('.item-info'), /Neuro: no flags/);
  // List it for 1.5 ZTPHY (approve + list).
  await s.fill('input[name=price]', '1.5');
  await clickAndWait(s, 'List for sale', statusIs(/List for sale: done/));
  await s.waitForSelector('#listings [data-listing="0"]');
  assert.equal(await market.call('listingStatus', [0, 0]), 0n);

  // ---- buyer finds it on Explore and buys ----
  await go(b, '#/');
  await b.waitForSelector('.nft-card[data-listing="0"]');
  assert.match(await b.textContent('.nft-card[data-listing="0"]'), /1\.5 ZTPHY/);
  await shot(b, 'explore');
  await b.click('.nft-card[data-listing="0"]');
  await b.waitForSelector('.page[data-ready] #listings');
  await connect(b);
  await b.waitForFunction(() => /fee 0\.015/.test(document.querySelector('#listings .quote')?.textContent ?? ''));
  assert.match(await b.textContent('#listings .quote'), /Total 1\.5 ZTPHY · fee 0\.015 · Royalty 0\.075 · seller gets 1\.41/);
  await clickAndWait(b, 'Buy', statusIs(/Buy: done/));
  assert.equal((await nft.call('ownerOf', [1])).toLowerCase(), buyer.toLowerCase());
  assert.match(await b.textContent('.item-info .facts'), new RegExp(buyer, 'i'));

  // ---- seller withdraws exactly 1.41 (sale) + 0.075 (royalty: the creator is the receiver) ZTPHY ----
  await reroute(s, '#/me');
  await s.waitForFunction(() => /1\.485 ZTPHY/.test(document.querySelector('#balance')?.textContent ?? ''), null, { timeout: 10_000 })
    .catch(async (e) => { throw new Error(`${e.message}: ${await s.textContent('main')}`); });
  const before = await shim.balance(seller);
  await clickAndWait(s, 'Withdraw', statusIs(/Withdraw: done/));
  assert.equal(await shim.balance(seller) - before, 1_485_000_000_000_000_000n);

  // ---- offer on #2 (also listed for 9): the buyer offers 0.5, the seller accepts ----
  await reroute(s, `#/i/${col}/2`);
  await s.fill('input[name=price]', '9');
  await clickAndWait(s, 'List for sale', statusIs(/List for sale: done/)); // listing 1
  await reroute(b, `#/i/${col}/2`);
  assert.equal(await b.textContent('.item-info h1'), 'Gateway Cat 2');
  assert.equal(await b.getAttribute('.item-media img', 'src'), `${GW}bafytest/2.png`);
  await b.fill('input[name=offer]', '0.5');
  await clickAndWait(b, 'Make an offer', statusIs(/Make an offer: done/));
  await go(s, `#/i/${col}/2`); // a fresh load (same hash); the wallet reconnects silently
  await s.waitForSelector('#offers [data-offer="0"]', { timeout: 10_000 }).catch(async (e) => { throw new Error(`${e.message}: ${await s.textContent('main')} ${problems.join(' | ')}`); });
  // The holder sees what it gets; that amount is acceptOffer's minProceeds.
  assert.match(await s.textContent('#offers .quote'), /fee 0\.005 · Royalty 0\.025 · you get 0\.47 ZTPHY/);
  // The wallet switched to another network meanwhile: nothing is sent.
  wallet.chainId = '0x1';
  const sentBefore = wallet.sent.length;
  await clickAndWait(s, 'Accept offer', statusIs(/not on ZETAPHY Testnet/));
  assert.equal(wallet.sent.length, sentBefore, 'no transaction on the wrong chain');
  wallet.chainId = '0x12e4e';
  await clickAndWait(s, 'Accept offer', statusIs(/Accept offer: done/));
  const accept = wallet.sent.at(-1);
  assert.equal(BigInt('0x' + accept.data.slice(74, 138)), 470_000_000_000_000_000n, 'minProceeds = what was shown');
  assert.equal((await nft.call('ownerOf', [2])).toLowerCase(), buyer.toLowerCase());
  // The seller's listing of #2 is retired by the sale; the page offers to cancel it.
  assert.equal(await market.call('listingStatus', [1, 0]), 7n);
  await s.waitForSelector('#staleListings');
  assert.match(await s.textContent('#staleListings'), /1 old listing/);
  await clickAndWait(s, 'Cancel my 1 old listing(s)', statusIs(/Cancel listing: done/));
  assert.equal((await market.call('getListing', [1])).quantity, 0n);

  // ---- stale listing: #3 listed, then moved away ----
  await nft.send(seller, 'mint', [seller, '']);
  await reroute(s, `#/i/${col}/3`);
  await s.fill('input[name=price]', '2');
  await clickAndWait(s, 'List for sale', statusIs(/List for sale: done/));
  await nft.send(seller, 'transferFrom', [seller, other, 3]);
  await go(b, `#/i/${col}/3`);
  assert.match(await b.textContent('#listings'), /no longer holds this token/);
  assert.equal(await b.locator('#listings').getByRole('button', { name: 'Buy' }).count(), 0);
  await go(b, '#/');
  await b.waitForSelector('.page[data-ready]');
  assert.equal(await b.locator('.nft-card[data-listing="2"]').count(), 0, 'stale listing hidden on Explore');
  assert.match(await b.textContent('.page'), /no longer valid listings hidden/);

  // ---- Neuro: a newer flag warns; an enforced flag refuses ----
  await registry.send(deployer, 'set', [col, 3, 0]);
  await go(b, `#/i/${col}/2`);
  const warn = await b.textContent('.neuro.warnbox', { timeout: 5000 }).catch(async (e) => { throw new Error(`${e.message}: ${await b.textContent('main')}`); });
  assert.match(warn, /newer flag \(not enforced yet\)/);
  await shot(b, 'item-flagged');
  assert.match(warn, /ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา/);
  assert.match(warn, /an owner or admin can stop holders from transferring or selling/);
  await registry.send(deployer, 'set', [col, 3, 3]);
  await go(b, `#/i/${col}/2`);
  assert.match(await b.textContent('.neuro.badbox'), /enforced flag/);
  await shot(b, 'item-enforced');
  assert.match(await b.textContent('.page'), /switched off for this collection/);
  assert.equal(await b.locator('#offerForm, #listForm').count(), 0);
  await registry.send(deployer, 'set', [col, 0, 0]);

  // ---- an external (non-factory) collection is marked ----
  const ext = await shim.deploy(artifacts.ZetaphyERC721, [['Outside', 'OUT', '', '', ZERO, 0, 0, false, 0], other], other);
  await go(b, `#/c/${ext.address}`);
  assert.match(await b.textContent('.collection-head'), /External contract/);
  assert.match(await b.textContent('.collection-head'), /Not created by the ZETAPHY factory/);

  // ---- Settings: no contract overrides without ?dev=1; with it, a loud warning ----
  await go(b, '#/settings');
  assert.equal(await b.locator('input[name=marketplace], input[name=factory]').count(), 0);
  assert.match(await b.textContent('.page'), /Those servers see your IP address/);
  await b.goto('about:blank');
  await b.goto(`${ORIGIN}/?dev=1#/settings`);
  await b.waitForSelector('.page[data-ready]');
  assert.equal(await b.locator('input[name=marketplace]').count(), 1);
  assert.match(await b.textContent('#devOverride'), /Developer mode/);
  // A huge ?older= is capped (no runaway scan).
  const logsBefore = shim.stats.calls.eth_getLogs;
  await go(b, '#/?older=999999999');
  assert.ok(shim.stats.calls.eth_getLogs - logsBefore <= 2 * 20 * 25 + 10, 'bounded scan');

  // ---- My NFTs (from Transfer events) ----
  await go(b, '#/me');
  await b.waitForFunction(() => document.querySelectorAll('.grid .nft-card').length === 2);

  // ---- Thai, dark mode, phone width ----
  await b.click('#lang');
  await b.waitForSelector('.page[data-ready]');
  assert.equal(await b.textContent('nav a[href="#/"]'), 'สำรวจ');
  assert.equal(await b.getAttribute('html', 'lang'), 'th');
  await b.click('#theme');
  assert.match(await b.getAttribute('html', 'data-theme'), /^(dark|light)$/);
  await b.setViewportSize({ width: 360, height: 780 });
  for (const hash of ['#/', `#/i/${col}/2`, `#/c/${col}`, '#/create', '#/me', '#/settings']) {
    await go(b, hash);
    const over = await b.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${hash}: no horizontal scroll at phone width (${over}px)`);
    await shot(b, `mobile-${hash.replace(/[^a-z]/g, '') || 'explore'}`);
  }

  for (const p of [s, b]) problems.push(...(await p.evaluate(() => window.__problems)));
  assert.deepEqual(problems, [], 'no CSP violations, script dialogs or page errors');
  // The node was asked in bounded ranges only.
  assert.ok(shim.stats.calls.eth_getLogs > 0);
});
