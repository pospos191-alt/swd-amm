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
import { servePage, injectWallet, chromiumOptions, vercelHeaders } from './web.js';
import { formatUnits as pageFormat } from '../../web/lib/abi.js';

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
  // M3: a pair tUSD/tNEW with donated reserves at a skewed price (1 : 7) and no LP.
  await b.tx(factory, enc('factory', 'createPair', [tokens.tUSD, tokens.tNEW]));
  const unseeded = await call1(factory, 'factory', 'getPair', [tokens.tUSD, tokens.tNEW]);
  await b.tx(tokens.tUSD, enc('token', 'transfer', [unseeded, 1n * E18]));
  await b.tx(tokens.tNEW, enc('token', 'transfer', [unseeded, 7n * E18]));
  await b.tx(unseeded, enc('pair', 'sync', []));
  await b.tx(tokens.tNEW, enc('token', 'transfer', [b.user, 100n * E18]));
  const cfg = {
    name: 'ZETAPHY DEX', chainId: 77390, rpc: RPC_URL,
    contracts: { factory, router, wnative, pairCodeHash: await call1(factory, 'factory', 'PAIR_CODE_HASH'), threatRegistry: registry },
    tokens: ['tUSD', 'tWARN', 'tBAD'].map((k) => ({ address: tokens[k], name: k === 'tUSD' ? 'Test USD (testnet, no value)' : k, symbol: k, decimals: 18 })),
  };
  return { cfg, tokens, factory, router, registry, wnative, call1, enc, unseeded };
}

/** Drives the page through swaps, liquidity, Neuro warnings/refusals, token import, language, theme and phone width. */
export async function runScenario(b, d, log = () => {}) {
  const { cfg, tokens, router, wnative, call1, enc, unseeded } = d;
  const user = b.user;
  const server = await servePage({ '/deployments.json': JSON.stringify(cfg) });
  const browser = await chromium.launch(chromiumOptions());
  const problems = [];
  const walletLog = [];
  let walletChain = '0x1'; // the wallet starts on another chain: the page must switch / add ZETAPHY
  let forgetChain = false; // true: the wallet no longer knows ZETAPHY (switch fails with 4902)
  const added = []; // rpcUrls of every wallet_addEthereumChain
  const sent = []; // every eth_sendTransaction's params
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
          if (params[0].chainId !== '0x12e4e' || !walletLog.includes('wallet_addEthereumChain') || forgetChain) { forgetChain = false; throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }); }
          walletChain = '0x12e4e'; return null;
        case 'wallet_addEthereumChain': {
          const p = params[0];
          assert.equal(p.chainId, '0x12e4e');
          assert.deepEqual(p.nativeCurrency, { name: 'ZETAPHY', symbol: 'ZTPHY', decimals: 18 });
          added.push(p.rpcUrls);
          walletChain = '0x12e4e'; return null;
        }
        case 'eth_sendTransaction': {
          const tx = params[0];
          sent.push(tx);
          if (walletChain !== '0x12e4e') throw new Error('mock wallet: a transaction for another chain was sent');
          return b.walletSend(tx);
        }
        default: return b.rpc(method, params);
      }
    });

    const res = await page.goto(`${server.origin}/`);
    assert.match(res.headers()['content-security-policy'], /^default-src 'none'; script-src 'self'; style-src 'self';/, 'the CSP from web/vercel.json');
    assert.match(vercelHeaders('/app.js')['Content-Security-Policy'], /^default-src 'none'; script-src 'self';/);
    assert.match(vercelHeaders('/lib/storage.js')['Content-Security-Policy'], /^default-src 'none'; script-src 'self';/);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1', null, { timeout: 30_000 });
    assert.equal(await page.locator('#banner').isHidden(), true, await page.locator('#banner').textContent());
    log('page ready under the strict CSP');
    // English by default (nothing stored); the Thai checks below switch to Thai first.
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.textContent('.tab[data-tab="swap"]'), 'Swap');
    assert.equal(await page.textContent('#lang-btn'), 'ไทย');
    await page.click('#lang-btn');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'th');
    assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-dex:lang')), 'th');

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
    assert.deepEqual(added, [[RPC_URL.replace(/\/$/, '')]], 'the deployment\'s RPC');
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
    assert.equal(sent.at(-1).chainId, '0x12e4e', 'L1: the transaction names chain 77390');
    assert.equal(sent.at(-1).from.toLowerCase(), user.toLowerCase());
    // L1: the wallet moved to another chain without telling the page: nothing is sent.
    walletChain = '0x1';
    const nSent = sent.length;
    await page.fill('#swap-amount-in', '0.5');
    await page.waitForFunction(() => !document.getElementById('swap-btn').disabled, null, { timeout: 30_000 });
    await page.click('#swap-btn');
    await page.waitForFunction(() => document.getElementById('swap-status').classList.contains('err'), null, { timeout: 30_000 });
    assert.match(await page.textContent('#swap-status'), /77390/);
    assert.equal(sent.length, nSent, 'no eth_sendTransaction on the wrong chain');
    walletChain = '0x12e4e';
    await page.evaluate(() => window.__zdexEmit('chainChanged', '0x12e4e'));
    await page.fill('#swap-amount-in', '');
    await page.waitForFunction(() => document.getElementById('swap-btn').disabled && document.getElementById('swap-amount-out').textContent === '0.0');
    log('L1: chain id asked again before signing; a wallet on another chain sends nothing; tx carries chainId 0x12e4e');

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
    assert.match(await page.textContent(`#token-list [data-token="${lc(tokens.tNEW)}"]`), /นำเข้าเอง ไม่อยู่ในรายการ/, 'M4: imported badge');
    await page.fill('#import-addr', tokens.tFAKE);
    await page.click('#import-check');
    await page.waitForSelector('#import-warnings .warn-line', { timeout: 30_000 });
    assert.equal(await page.locator('#import-add').isDisabled(), true, 'a lookalike needs the acknowledgement');
    await page.check('#import-ack');
    assert.equal(await page.locator('#import-add').isDisabled(), false);
    log('tokens: enforced import refused, hostile name shown as plain text, lookalike warned');

    // ---- M3: a pair with donated reserves (1 tUSD : 7 tNEW, synced) but no LP: the user sets the price
    await page.click('.tab[data-tab="pool"]');
    await page.selectOption('#add-a', lc(tokens.tUSD));
    await page.selectOption('#add-b', lc(tokens.tNEW));
    assert.match(await page.locator('#add-b option:checked').textContent(), /⚠ นำเข้าเอง ไม่อยู่ในรายการ/, 'M4: imported badge in the picker');
    await page.waitForSelector('#add-imported:not([hidden])', { timeout: 30_000 });
    await page.fill('#add-amt-a', '2');
    await page.fill('#add-amt-b', '5');
    await page.waitForFunction(() => /ยังไม่มีใครถือ LP/.test(document.getElementById('add-info').textContent), null, { timeout: 30_000 });
    assert.equal(await page.inputValue('#add-amt-a'), '2', 'not re-quoted from the donated reserves');
    assert.equal(await page.inputValue('#add-amt-b'), '5');
    for (const id of ['add-approve-a', 'add-approve-b']) {
      await page.waitForSelector(`#${id}:not([hidden])`, { timeout: 30_000 });
      await act(`#${id}`, 'add-status');
      await page.waitForFunction((i) => document.getElementById(i).hidden || document.getElementById(i).disabled === false, id);
    }
    await page.waitForFunction(() => !document.getElementById('add-btn').disabled, null, { timeout: 30_000 });
    const [usd0, new0] = [await balance(tokens.tUSD), await balance(tokens.tNEW)];
    await act('#add-btn', 'add-status');
    const addArgs = I.router.decodeFunctionData('addLiquidity', sent.at(-1).data);
    assert.equal(addArgs[4], addArgs[2], 'amountAMin = amountADesired');
    assert.equal(addArgs[5], addArgs[3], 'amountBMin = amountBDesired');
    assert.equal(usd0 - (await balance(tokens.tUSD)), 2n * E18, 'exactly the amounts entered');
    assert.equal(new0 - (await balance(tokens.tNEW)), 5n * E18);
    const lpNew = I.pair.decodeFunctionResult('balanceOf', await b.call(unseeded, enc('pair', 'balanceOf', [user])))[0];
    assert.equal(I.pair.decodeFunctionResult('totalSupply', await b.call(unseeded, enc('pair', 'totalSupply', [])))[0], lpNew + 1000n, 'the user is the first LP');
    log('M3: reserves without LP -> warned, both amounts entered by the user, min = desired, exact amounts taken');

    // ---- language (back to English), theme, phone width
    await page.click('#lang-btn');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
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

    // ---- M4: localStorage written by something else on this origin (stored values stay untrusted)
    await page.setViewportSize({ width: 1280, height: 900 });
    const altRpc = `${RPC_URL.replace(/\/$/, '')}?alt=1`; // the form the page saves
    await page.evaluate(([alt, fake, junkAddr]) => {
      localStorage.setItem('zetaphy-dex:settings', JSON.stringify({ slippageBps: 5000, deadlineMin: 20, rpc: alt, fot: true }));
      const imp = JSON.parse(localStorage.getItem('zetaphy-dex:imported:77390') ?? '[]');
      imp.push({ address: fake, name: 'Test USD (testnet, no value)', symbol: 'tUSD', decimals: 18 }); // no chainId: dropped
      imp.push({ address: junkAddr, name: 'x', symbol: 'X', decimals: 18, chainId: '77390' }); // a string chain id: dropped
      localStorage.setItem('zetaphy-dex:imported:77390', JSON.stringify(imp));
    }, [altRpc, tokens.tFAKE, '0x' + '99'.repeat(20)]);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1', null, { timeout: 30_000 });
    await page.waitForSelector('#banner-rpc', { timeout: 30_000 });
    assert.ok((await page.textContent('#banner-rpc')).includes(altRpc), 'a persistent banner names the non-default RPC');
    const options = await page.locator('#swap-to option').allTextContents();
    assert.ok(!options.some((o) => o.includes('0x9999')), 'junk imported entry dropped');
    assert.equal(options.filter((o) => /^tUSD /.test(o)).length, 1, 'the lookalike without a chain id was dropped');
    assert.ok(options.some((o) => o.startsWith('NEW · ') && o.includes('imported, not in the list')), options.join(' | '));
    await page.click('#settings-btn');
    assert.equal(await page.inputValue('#set-slippage'), '0.5', 'stored 50% slippage refused (default 0.5%)');
    assert.equal(await page.isChecked('#set-fot'), false, 'fee-on-transfer switch not read back');
    // The wallet forgot ZETAPHY: adding it again uses the deployment's RPC, not the stored one.
    await page.fill('#set-slippage', '3');
    await page.click('#settings-save');
    walletChain = '0x1';
    forgetChain = true;
    await page.evaluate(() => window.__zdexEmit('chainChanged', '0x1'));
    await page.click('#banner button:not(#banner-rpc-default)');
    await page.waitForFunction(() => !document.querySelector('#banner').textContent.includes('(1)'), null, { timeout: 30_000 });
    assert.deepEqual(added.at(-1), [RPC_URL.replace(/\/$/, '')], 'wallet_addEthereumChain got the default RPC');
    assert.equal(walletChain, '0x12e4e');
    // Slippage above 1%: a fresh confirmation before each swap.
    await page.selectOption('#swap-from', 'native');
    await page.selectOption('#swap-to', lc(tokens.tUSD));
    await page.fill('#swap-amount-in', '0.2');
    await page.waitForSelector('#swap-ack-slip-row:not([hidden])', { timeout: 30_000 });
    assert.match(await page.textContent('#swap-ack-slip-row'), /3%/);
    await page.waitForFunction(() => document.getElementById('swap-btn').textContent === 'Swap', null, { timeout: 30_000 });
    assert.equal(await page.locator('#swap-btn').isDisabled(), true, 'needs the slippage confirmation');
    await page.check('#swap-ack-slip');
    assert.equal(await page.locator('#swap-btn').isDisabled(), false);
    const q = (await amountsOut(2n * E18 / 10n, [wnative, tokens.tUSD]))[1];
    await act('#swap-btn', 'swap-status');
    const swapArgs = I.router.decodeFunctionData('swapExactETHForTokens', sent.at(-1).data);
    assert.equal(swapArgs[0], (q * 9700n) / 10000n, 'minimum out at 3%');
    assert.equal(await page.isChecked('#swap-ack-slip'), false, 'the confirmation is not kept');
    // Back to the default RPC from the banner.
    await page.click('#banner-rpc-default');
    await page.waitForFunction(() => !document.getElementById('banner-rpc'));
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('zetaphy-dex:settings'))).rpc, '');
    log('M4: poisoned storage: 50% slippage and fee-on-transfer ignored, junk imports dropped, custom RPC bannered and never given to the wallet, >1% slippage confirmed per swap');

    assert.deepEqual(problems, [], problems.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
}
