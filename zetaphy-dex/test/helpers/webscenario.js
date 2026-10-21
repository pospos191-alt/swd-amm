// The DEX page's end-to-end scenario, shared by web.e2e.js (in-memory EVM as
// the mock RPC) and web.devnet.e2e.js (a real zetaphyd devnet). A backend is:
//   { name, user, deploy(art, args, value?), tx(to, data, value?), call(to, data),
//     rpc(method, params) (the JSON-RPC the page and wallet see), walletSend(tx) -> hash,
//     wnative() -> address }
// deploy/tx/call act as the deployer; walletSend sends as `user`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, parseEther, formatUnits } from 'ethers';
import { chromium } from 'playwright-core';
import { serveTestUi, injectWallet, chromiumOptions, vercelHeaders } from './web.js';
import { formatUnits as pageFormat } from '../../../test-ui/zetaphy/lib/abi.js';

const A = (n) => JSON.parse(readFileSync(new URL(`../../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const ARTS = {
  factory: A('ZetaphyFactory'), router: A('ZetaphyRouter'), pair: A('ZetaphyPair'), weth: A('WZETAPHY'), token: A('TestToken'), runners: A('MockRunners'),
  registry: JSON.parse(readFileSync(new URL('../../../zetaphy-network/artifacts/ThreatRegistry.json', import.meta.url), 'utf8')),
};
const I = Object.fromEntries(Object.entries(ARTS).map(([k, a]) => [k, new Interface(a.abi)]));
export const RPC_URL = 'https://rpc.zetaphy.test/';
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const DISCLAIMER_TH = 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา';
const DISCLAIMER_EN = 'Automated code analysis, not an accusation';

/** Deploys the DEX, five tokens, three pools, and a ThreatRegistry with one flagged and one enforced token. */
export async function setupDex(b) {
  const me = b.deployer;
  const enc = (i, fn, args) => I[i].encodeFunctionData(fn, args);
  const call1 = async (to, i, fn, args = []) => I[i].decodeFunctionResult(fn, await b.call(to, enc(i, fn, args)))[0];
  const wnative = await b.wnative();
  const factory = await b.deploy(ARTS.factory, [me]);
  const router = await b.deploy(ARTS.router, [factory, wnative]);
  const tok = async (name, symbol) => b.deploy(ARTS.token, [name, symbol, 18, 10_000_000n * E18, 0]);
  const tokens = {
    tUSD: await tok('Test USD (testnet, no value)', 'tUSD'),
    tWARN: await tok('Warned Token', 'tWARN'),
    tBAD: await tok('Enforced Token', 'tBAD'),
    tNEW: await tok('<img src=x onerror=alert(1)>‮evil', 'NEW​'),
    tFAKE: await tok('Test USD (testnet, no value)', 'tUSD'),
    tHID: await tok('Unlisted Enforced Token', 'tHID'), // not in the list: for the import refusal
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  for (const k of ['tUSD', 'tWARN', 'tBAD']) {
    await b.tx(tokens[k], enc('token', 'approve', [router, MAX]));
    await b.tx(router, enc('router', 'addLiquidityETH', [tokens[k], 100_000n * E18, 0, 0, me, deadline]), 100n * E18);
  }
  // Neuro: 4 runners; quorum 2; enforcement after a day, or at once with 4 votes (fast lane).
  const runners = await b.deploy(ARTS.runners, []);
  for (const r of b.runners) await b.tx(runners, enc('runners', 'set', [r, true]));
  const registry = await b.deploy(ARTS.registry, [runners, 2, 1, me, 86400]);
  const chainId = 77390n;
  const keyOf = async (t) => call1(registry, 'registry', 'addressKey', [chainId, t]);
  const vote = (key) => enc('registry', 'vote', [key, true, 2, '0x' + 'e7'.repeat(32), 'neuro:test']);
  const kWarn = await keyOf(tokens.tWARN);
  for (const r of b.runners.slice(0, 2)) await b.txAs(r, registry, vote(kWarn));
  const kBad = await keyOf(tokens.tBAD);
  for (const r of b.runners) await b.txAs(r, registry, vote(kBad));
  const kHid = await keyOf(tokens.tHID);
  for (const r of b.runners) await b.txAs(r, registry, vote(kHid));
  assert.deepEqual([...I.registry.decodeFunctionResult('isContractEnforced', await b.call(registry, enc('registry', 'isContractEnforced', [tokens.tWARN])))], [false, 0n]);
  assert.equal(I.registry.decodeFunctionResult('isContractEnforced', await b.call(registry, enc('registry', 'isContractEnforced', [tokens.tBAD])))[0], true);
  await b.tx(factory, enc('factory', 'setThreatRegistry', [registry]));
  const cfg = {
    name: 'ZETAPHY DEX', chainId: 77390, rpc: RPC_URL,
    contracts: { factory, router, wnative, pairCodeHash: await call1(factory, 'factory', 'PAIR_CODE_HASH'), threatRegistry: registry },
    tokens: ['tUSD', 'tWARN', 'tBAD'].map((k) => ({ address: tokens[k], name: k === 'tUSD' ? 'Test USD (testnet, no value)' : k, symbol: k, decimals: 18 })),
  };
  return { cfg, tokens, factory, router, registry, wnative, call1, enc };
}

/** Drives the page through swaps, liquidity, Neuro warnings/refusals, token import, language, theme and phone width. */
export async function runScenario(b, d, log = () => {}) {
  const { cfg, tokens, router, wnative, call1, enc } = d;
  const user = b.user;
  const server = await serveTestUi({ '/zetaphy/deployments.json': JSON.stringify(cfg) });
  const browser = await chromium.launch(chromiumOptions());
  const problems = [];
  const walletLog = [];
  let walletChain = '0x1'; // the wallet starts on another chain: the page must switch / add ZETAPHY
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('dialog', (dlg) => { problems.push(`dialog: ${dlg.message()}`); dlg.dismiss(); });
    // The page's RPC (an https URL in deployments.json) is answered by the backend.
    await page.route(`${RPC_URL}**`, async (route) => {
      const req = JSON.parse(route.request().postData());
      let body;
      try { body = { jsonrpc: '2.0', id: req.id, result: await b.rpc(req.method, req.params) }; }
      catch (e) { body = { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32000, message: String(e.message), data: e.data } }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // Nothing else may leave the page.
    await page.route((url) => !url.href.startsWith(server.origin) && !url.href.startsWith(RPC_URL), (route) => { problems.push(`request to ${route.request().url()}`); return route.abort(); });
    await injectWallet(page, async (method, params) => {
      walletLog.push(method);
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [user];
        case 'eth_chainId': return walletChain;
        case 'wallet_switchEthereumChain':
          if (params[0].chainId !== '0x12e4e' || !walletLog.includes('wallet_addEthereumChain')) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          walletChain = '0x12e4e'; return null;
        case 'wallet_addEthereumChain': {
          const p = params[0];
          assert.equal(p.chainId, '0x12e4e');
          assert.deepEqual(p.nativeCurrency, { name: 'ZETAPHY', symbol: 'ZTPHY', decimals: 18 });
          assert.deepEqual(p.rpcUrls, [RPC_URL.replace(/\/$/, '')]);
          walletChain = '0x12e4e'; return null;
        }
        case 'eth_sendTransaction': {
          const tx = params[0];
          assert.equal(tx.from.toLowerCase(), user.toLowerCase());
          return b.walletSend(tx);
        }
        default: return b.rpc(method, params);
      }
    });

    const res = await page.goto(`${server.origin}/zetaphy/`);
    assert.match(res.headers()['content-security-policy'], /script-src 'self';/, 'the /zetaphy CSP from vercel.json');
    assert.match(vercelHeaders('/')['Content-Security-Policy'], /esm\.sh/, 'the main page keeps its own CSP');
    assert.match(vercelHeaders('/api/devnet-faucet')['Content-Security-Policy'], /esm\.sh/);
    assert.match(vercelHeaders('/zetaphy/app.js')['Content-Security-Policy'], /^default-src 'none'; script-src 'self';/);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1', null, { timeout: 30_000 });
    assert.equal(await page.locator('#banner').isHidden(), true, await page.locator('#banner').textContent());
    log('page ready under the strict CSP');

    const waitOk = (id, timeout = 90_000) => page.waitForFunction((i) => {
      const s = document.getElementById(i);
      if (s.classList.contains('err')) throw new Error(s.textContent);
      return s.classList.contains('ok');
    }, id, { timeout });
    /** Clicks, then waits for this click's own result in the status line (not an earlier one). */
    const act = async (selector, statusId) => {
      await page.evaluate((i) => { const s = document.getElementById(i); s.textContent = ''; s.className = 'status'; }, statusId);
      await page.click(selector);
      await waitOk(statusId).catch(async (e) => { throw new Error(`${selector}: ${e.message}; status: ${await page.textContent('#' + statusId)}`); });
    };
    const balance = async (token, who = user) => I.token.decodeFunctionResult('balanceOf', await b.call(token, enc('token', 'balanceOf', [who])))[0];
    const native = async () => BigInt(await b.rpc('eth_getBalance', [user, 'latest']));
    const amountsOut = async (amt, path) => (await call1(router, 'router', 'getAmountsOut', [amt, path]));
    const lc = (a) => a.toLowerCase();

    // ---- connect (the wallet is on another chain: the page adds ZETAPHY, ticker ZTPHY)
    await page.click('#connect-btn');
    await page.click('#wallet-list button:has-text("Mock Wallet")');
    await page.waitForFunction((u) => document.getElementById('connect-btn').textContent.startsWith(u.slice(0, 6)), user);
    assert.ok(walletLog.includes('wallet_addEthereumChain'), walletLog.join(','));
    assert.equal(walletChain, '0x12e4e');
    log('wallet connected through EIP-6963, ZETAPHY network added');

    // ---- swap 1 ZTPHY -> tUSD
    await page.selectOption('#swap-from', 'native');
    await page.selectOption('#swap-to', lc(tokens.tUSD));
    await page.fill('#swap-amount-in', '1');
    await page.waitForFunction(() => !document.getElementById('swap-btn').disabled, null, { timeout: 30_000 });
    const expected = (await amountsOut(E18, [wnative, tokens.tUSD]))[1];
    assert.equal(await page.textContent('#swap-amount-out'), pageFormat(expected, 18, 8), 'the page quotes what the router quotes');
    assert.match(await page.textContent('#swap-route'), /ZTPHY → tUSD/);
    assert.match(await page.textContent('#swap-impact'), /%$/);
    const u0 = await balance(tokens.tUSD);
    await act('#swap-btn', 'swap-status');
    assert.equal((await balance(tokens.tUSD)) - u0, expected, 'got exactly the quoted amount');
    log(`swapped 1 ZTPHY -> ${formatUnits(expected, 18)} tUSD in the page`);

    // ---- tUSD -> ZTPHY, with an exact approval
    await page.click('#swap-flip');
    await page.fill('#swap-amount-in', '100');
    await page.waitForSelector('#swap-approve:not([hidden])', { timeout: 30_000 });
    assert.match(await page.textContent('#swap-approve'), /100/);
    assert.equal(await page.locator('#swap-btn').isDisabled(), true, 'no swap before the approval');
    await act('#swap-approve', 'swap-status');
    const allowance = I.token.decodeFunctionResult('allowance', await b.call(tokens.tUSD, enc('token', 'allowance', [user, router])))[0];
    assert.equal(allowance, 100n * E18, 'exact approval, not unlimited');
    await page.waitForFunction(() => !document.getElementById('swap-btn').disabled && document.getElementById('swap-approve').hidden, null, { timeout: 30_000 });
    const n0 = await native();
    const outNative = (await amountsOut(100n * E18, [tokens.tUSD, wnative]))[1];
    await act('#swap-btn', 'swap-status');
    const gained = (await native()) - n0;
    assert.ok(gained <= outNative && gained > outNative - parseEther('0.05'), `native +${gained} (quote ${outNative}, less gas)`);
    assert.equal(I.token.decodeFunctionResult('allowance', await b.call(tokens.tUSD, enc('token', 'allowance', [user, router])))[0], 0n);
    log('swapped 100 tUSD -> ZTPHY after an exact approval');

    // ---- Neuro: flagged (warn + acknowledge) and enforced (refused)
    await page.selectOption('#swap-from', 'native');
    await page.selectOption('#swap-to', lc(tokens.tWARN));
    await page.fill('#swap-amount-in', '0.1');
    await page.waitForSelector('#swap-neuro.flagged', { timeout: 30_000 });
    assert.match(await page.textContent('#swap-neuro'), new RegExp(DISCLAIMER_TH));
    assert.match(await page.textContent('#swap-neuro'), /สร้างเหรียญเพิ่มได้ไม่จำกัด/); // reason 2, neutral wording
    await page.waitForSelector('#swap-ack-flag-row:not([hidden])');
    await page.waitForFunction(() => document.getElementById('swap-btn').textContent.length > 0);
    assert.equal(await page.locator('#swap-btn').isDisabled(), true, 'needs the acknowledgement');
    await page.check('#swap-ack-flag');
    assert.equal(await page.locator('#swap-btn').isDisabled(), false);
    await page.selectOption('#swap-to', lc(tokens.tBAD));
    await page.waitForSelector('#swap-neuro.enforced', { timeout: 30_000 });
    await page.waitForFunction(() => /tBAD/.test(document.getElementById('swap-btn').textContent));
    assert.equal(await page.locator('#swap-btn').isDisabled(), true, 'refused');
    assert.match(await page.textContent('#swap-neuro'), new RegExp(DISCLAIMER_TH));
    log('Neuro: flagged token warned (acknowledge to continue), enforced token refused');

    // ---- Pool: add ZTPHY + tUSD, see the position, remove half
    await page.click('.tab[data-tab="pool"]');
    await page.selectOption('#add-a', 'native');
    await page.selectOption('#add-b', lc(tokens.tUSD));
    await page.fill('#add-amt-a', '0.5');
    await page.waitForFunction(() => Number(document.getElementById('add-amt-b').value) > 0, null, { timeout: 30_000 });
    await page.waitForSelector('#add-approve-b:not([hidden])', { timeout: 30_000 });
    await act('#add-approve-b', 'add-status');
    await page.waitForFunction(() => !document.getElementById('add-btn').disabled, null, { timeout: 30_000 });
    await act('#add-btn', 'add-status');
    const pairAddr = await call1(router, 'router', 'pairFor', [wnative, tokens.tUSD]);
    const lp = I.pair.decodeFunctionResult('balanceOf', await b.call(pairAddr, enc('pair', 'balanceOf', [user])))[0];
    assert.ok(lp > 0n);
    await page.waitForSelector('#positions .item', { timeout: 60_000 });
    assert.match(await page.textContent('#positions'), /tUSD/);
    await act('#positions .item button[data-remove="50"]', 'pos-status');
    const lp2 = I.pair.decodeFunctionResult('balanceOf', await b.call(pairAddr, enc('pair', 'balanceOf', [user])))[0];
    assert.equal(lp2, lp - lp / 2n);
    // Adding the enforced token is refused in the page.
    await page.selectOption('#add-b', lc(tokens.tBAD));
    await page.waitForSelector('#add-neuro.enforced', { timeout: 30_000 });
    assert.equal(await page.locator('#add-btn').isDisabled(), true);
    log('pool: added liquidity (exact approval), position listed, removed 50%; enforced token refused');

    // ---- Tokens: import refusal, sanitising, lookalike warning
    await page.click('.tab[data-tab="tokens"]');
    await page.fill('#import-addr', tokens.tBAD);
    await page.click('#import-check');
    await page.waitForFunction(() => document.getElementById('import-status').classList.contains('err'));
    assert.equal(await page.locator('#import-result').isHidden(), true, 'already listed');
    await page.fill('#import-addr', tokens.tHID);
    await page.click('#import-check');
    await page.waitForSelector('#import-neuro.enforced', { timeout: 30_000 });
    assert.equal(await page.locator('#import-add').isHidden(), true, 'an enforced token cannot be imported');
    await page.fill('#import-addr', tokens.tNEW);
    await page.click('#import-check');
    await page.waitForSelector('#import-result:not([hidden])', { timeout: 30_000 });
    await page.waitForSelector('#import-neuro.clear');
    const info = await page.textContent('#import-info');
    assert.ok(info.includes('<img src=x onerror=alert(1)>evil'), info);
    assert.ok(!/[‮​]/.test(info), 'bidi / zero-width characters removed');
    assert.equal(await page.locator('#import-result img').count(), 0, 'shown as text, never as HTML');
    await act('#import-add', 'import-status');
    assert.match(await page.textContent('#token-list'), /NEW/);
    await page.fill('#import-addr', tokens.tFAKE);
    await page.click('#import-check');
    await page.waitForSelector('#import-warnings .warn-line', { timeout: 30_000 });
    assert.equal(await page.locator('#import-add').isDisabled(), true, 'a lookalike needs the acknowledgement');
    await page.check('#import-ack');
    assert.equal(await page.locator('#import-add').isDisabled(), false);
    log('tokens: enforced import refused, hostile name shown as plain text, lookalike warned');

    // ---- language, theme, phone width
    await page.click('#lang-btn');
    assert.equal(await page.textContent('.tab[data-tab="swap"]'), 'Swap');
    await page.click('.tab[data-tab="swap"]');
    await page.waitForSelector('#swap-neuro.enforced');
    await page.waitForFunction((d) => document.getElementById('swap-neuro').textContent.includes(d), DISCLAIMER_EN, { timeout: 30_000 });
    const before = await page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
    await page.click('#theme-btn');
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.ok(after === 'light' || after === 'dark');
    assert.notEqual(after, before);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal scroll at 360 px (${overflow})`);
    log('language toggle (EN), theme toggle, 360 px phone width OK');

    assert.deepEqual(problems, [], problems.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
}
