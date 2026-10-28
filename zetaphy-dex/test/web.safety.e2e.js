// Browser test of the wallet safety on the Swap page (served on its own, under web/vercel.json's CSP):
// the large-balance banner (and hiding it for 7 days), the hardware-wallet help, "Ledger (USB)" in the
// wallet list, and the account forgotten after 30 idle minutes. A mock wallet and a mock node.
//   npm run test:web
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { servePage, injectWallet, chromiumOptions } from './helpers/web.js';

const RPC_URL = 'https://rpc.zetaphy.test/';
const USER = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';

async function run(balanceWei) {
  const server = await servePage({ '/deployments.json': JSON.stringify({ chainId: 77390, rpc: RPC_URL, contracts: null, tokens: [] }) });
  const browser = await chromium.launch(chromiumOptions());
  const problems = [];
  const walletLog = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.route(`${RPC_URL}**`, async (route) => {
    const req = JSON.parse(route.request().postData());
    const result = { eth_chainId: '0x12e4e', eth_getBalance: `0x${balanceWei.toString(16)}`, eth_blockNumber: '0x10' }[req.method] ?? null;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  });
  await page.route((url) => !url.href.startsWith(server.origin) && !url.href.startsWith(RPC_URL), (route) => { problems.push(`request to ${route.request().url()}`); return route.abort(); });
  let granted = true;
  await injectWallet(page, async (method) => {
    walletLog.push(method);
    switch (method) {
      case 'eth_requestAccounts': granted = true; return [USER];
      case 'eth_accounts': return granted ? [USER] : [];
      case 'eth_chainId': return '0x12e4e';
      case 'wallet_revokePermissions': granted = false; return null;
      case 'wallet_switchEthereumChain': return null;
      default: throw Object.assign(new Error(`not mocked: ${method}`), { code: 4200 });
    }
  });
  await page.clock.install();
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1', null, { timeout: 30_000 });
  const connect = async () => {
    await page.click('#connect-btn');
    await page.waitForSelector('#wallet-dialog[open] #wallet-ledger');
    await page.click('#wallet-list button:has-text("Mock Wallet")');
    await page.waitForFunction(() => document.getElementById('connect-btn').textContent.startsWith('0x6af5'));
  };
  return { page, browser, server, problems, walletLog, connect };
}

test('Swap: banner at 1,000 ZETAPHY, hardware help, Ledger (USB), idle forget after 30 min (phone width, strict CSP)', { timeout: 120_000 }, async () => {
  const r = await run(1500n * 10n ** 18n);
  const { page } = r;
  try {
    // the help from the footer, at phone width
    await page.click('#footer-help [data-ws="help"]');
    await page.waitForSelector('#ws-help[open]');
    assert.match(await page.textContent('#ws-help'), /Rabby[\s\S]*Ledger \(USB\)[\s\S]*connect\.trezor\.io[\s\S]*Keplr/);
    assert.ok(await page.evaluate(() => document.getElementById('ws-help').getBoundingClientRect().right <= innerWidth), 'fits the phone');
    await page.keyboard.press('Escape');

    await r.connect();
    assert.match(await page.textContent('#wallet-dialog'), /Ledger \(USB\)/, 'the Ledger next to the browser wallets');
    await page.waitForSelector('#ws-host .ws-banner');
    assert.match(await page.textContent('.ws-banner'), /1,500 ZETAPHY/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll with the banner');
    await page.click('.ws-banner [data-ws="banner-hide"]');
    assert.equal(await page.locator('.ws-banner').count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('connect-btn').textContent.startsWith('0x6af5'), null, { timeout: 10_000 });
    await page.clock.fastForward('00:05');
    assert.equal(await page.locator('.ws-banner').count(), 0, 'hidden for 7 days, also after a reload');
    await page.evaluate(() => localStorage.setItem('zetaphy:safety:bannerHiddenUntil', String(Date.now() - 1)));

    // 30 minutes without activity (the default): forgotten, the wallet asked to drop the site, a notice
    await page.clock.fastForward('29:00');
    assert.ok((await page.textContent('#connect-btn')).startsWith('0x'), 'still connected at 29 minutes');
    await page.clock.fastForward('01:30');
    await page.waitForFunction(() => !document.getElementById('connect-btn').textContent.startsWith('0x'));
    await page.waitForSelector('#ws-idle');
    assert.match(await page.textContent('#ws-idle'), /30 minutes/);
    assert.ok(r.walletLog.includes('wallet_revokePermissions'));
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy:wallet')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-dex:wallet')), null);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1');
    await page.clock.fastForward('00:02');
    assert.ok(!(await page.textContent('#connect-btn')).startsWith('0x'), 'a reload does not reconnect');
    assert.deepEqual(r.problems, [], r.problems.join('\n'));
  } finally {
    await r.browser.close();
    await r.server.close();
  }
});

test('Swap: no banner under 1,000 ZETAPHY', { timeout: 60_000 }, async () => {
  const r = await run(999n * 10n ** 18n);
  try {
    await r.connect();
    await r.page.clock.fastForward('00:03');
    assert.equal(await r.page.locator('.ws-banner').count(), 0);
  } finally {
    await r.browser.close();
    await r.server.close();
  }
});
