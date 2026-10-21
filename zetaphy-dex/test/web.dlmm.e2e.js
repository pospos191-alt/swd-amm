// Browser end-to-end test of the DLMM tab (web/dlmm.js; UNAUDITED contracts)
// in headless Chromium under the page's real CSP, with a mock EIP-6963 wallet
// and a mock JSON-RPC that is a real EVM (@ethereumjs/evm, chain id 77390)
// holding the DLMM contracts: swap native -> tUSD, add liquidity over a range
// (approve, add), see the position, remove it (setApprovalForAll, remove).
//   npm run test:web     (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, or ZDEX_CHROMIUM=<binary>)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Address } from '@ethereumjs/util';
import { Interface, keccak256, toBeHex } from 'ethers';
import { chromium } from 'playwright-core';
import { createChain } from './helpers/evm.js';
import { servePage, injectWallet, chromiumOptions } from './helpers/web.js';

const A = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ARTS = Object.fromEntries(['ZetaphyFactory', 'ZetaphyRouter', 'WZETAPHY', 'TestToken', 'ZetaphyDlmmFactory', 'ZetaphyDlmmRouter', 'ZetaphyDlmmPair'].map((n) => [n, A(n)]));
const I = Object.fromEntries(Object.entries(ARTS).map(([k, a]) => [k, new Interface(a.abi)]));
const RPC_URL = 'https://rpc.zetaphy.test/';
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;

/** The in-memory backend (as in web.e2e.js): the page's RPC and the mock wallet's sends. */
async function evmBackend() {
  const c = await createChain(['deployer', 'user'], {}, { chainId: 77390 });
  c.setTime(Math.floor(Date.now() / 1000));
  const addr = (n) => c.acct[n].toString();
  const receipts = new Map();
  let n = 0;
  const revert = (r) => Object.assign(new Error('execution reverted'), { code: 3, data: r.returnValue });
  const b = {
    c, deployer: addr('deployer'), user: addr('user'),
    deploy: async (name, args) => (await c.deployRaw(ARTS[name], args, 'deployer')).address,
    async tx(to, data, value = 0n) { const r = await c.rawSend(b.deployer, to, data, value); if (!r.ok) throw revert(r); },
    async call(to, data) { const r = await c.staticCall(b.deployer, to, data); if (!r.ok) throw revert(r); return r.returnValue; },
    async walletSend(tx) {
      const r = await c.rawSend(tx.from, tx.to, tx.data, BigInt(tx.value ?? 0));
      const hash = keccak256(toBeHex(++n, 32));
      receipts.set(hash, { transactionHash: hash, status: r.ok ? '0x1' : '0x0', blockNumber: toBeHex(c.blockNumber()), gasUsed: toBeHex(r.gasUsed ?? 0n), logs: [] });
      return hash;
    },
    async rpc(method, params = []) {
      switch (method) {
        case 'eth_chainId': return '0x12e4e';
        case 'net_version': return '77390';
        case 'eth_blockNumber': return toBeHex(c.blockNumber());
        case 'eth_getBalance': return toBeHex(await c.balance(Address.fromString(params[0])));
        case 'eth_getCode': return c.code(params[0]);
        case 'eth_getStorageAt': return c.storageAt(params[0], params[1]);
        case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
        case 'eth_gasPrice': return '0x0';
        case 'eth_call': {
          const q = params[0];
          const r = await c.staticCall(q.from ?? '0x' + '00'.repeat(20), q.to, q.data ?? q.input ?? '0x', BigInt(q.value ?? 0));
          if (!r.ok) throw revert(r);
          return r.returnValue;
        }
        default: throw Object.assign(new Error(`mock RPC: ${method} not supported`), { code: -32601 });
      }
    },
  };
  return b;
}

test('the DLMM tab: swap native -> tUSD, add liquidity over a range, see it, remove it (mock wallet + in-memory EVM)', { timeout: 300_000 }, async () => {
  const b = await evmBackend();
  const me = b.deployer;
  const enc = (k, fn, args) => I[k].encodeFunctionData(fn, args);
  const wnative = await b.deploy('WZETAPHY', []);
  const factory = await b.deploy('ZetaphyFactory', [me]);
  const router = await b.deploy('ZetaphyRouter', [factory, wnative]);
  const dlmmFactory = await b.deploy('ZetaphyDlmmFactory', [me]);
  const dlmmRouter = await b.deploy('ZetaphyDlmmRouter', [dlmmFactory, wnative]);
  await b.tx(dlmmFactory, enc('ZetaphyDlmmFactory', 'setPreset', [10, [10, 0, 0, 0, 0, 0, 0, true]]));
  const tusd = await b.deploy('TestToken', ['Test USD (testnet, no value)', 'tUSD', 18, 10_000_000n * E18, 0]);
  await b.tx(tusd, enc('TestToken', 'approve', [dlmmRouter, MAX]));
  await b.tx(tusd, enc('TestToken', 'transfer', [b.user, 1_000n * E18]));
  // Seed tUSD / native: 5 bins each side of bin 0, 10 per bin.
  const [X, Y] = BigInt(tusd) < BigInt(wnative) ? [tusd, wnative] : [wnative, tusd];
  const deltas = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const ax = deltas.map((d) => (d > 0 ? 10n * E18 : d === 0 ? 5n * E18 : 0n));
  const ay = deltas.map((d) => (d < 0 ? 10n * E18 : d === 0 ? 5n * E18 : 0n));
  const nativeSum = (X === wnative ? ax : ay).reduce((s, v) => s + v, 0n);
  const dl = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await b.tx(dlmmRouter, enc('ZetaphyDlmmRouter', 'addLiquidityNATIVE', [[X, Y, 10, 0, 0, deltas, ax, ay, 0, 0, me, dl]]), nativeSum);
  const pair = I.ZetaphyDlmmFactory.decodeFunctionResult('getPair', await b.call(dlmmFactory, enc('ZetaphyDlmmFactory', 'getPair', [X, Y, 10])))[0];
  const cfg = { name: 'ZETAPHY DEX', chainId: 77390, rpc: RPC_URL, contracts: { factory, router, wnative, dlmmFactory, dlmmRouter },
    tokens: [{ address: tusd, name: 'Test USD (testnet, no value)', symbol: 'tUSD', decimals: 18 }] };
  const bal = async (tok, who) => I.TestToken.decodeFunctionResult('balanceOf', await b.call(tok, enc('TestToken', 'balanceOf', [who])))[0];

  const server = await servePage({ '/deployments.json': JSON.stringify(cfg) });
  const browser = await chromium.launch(chromiumOptions());
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.route(`${RPC_URL}**`, async (route) => {
      const req = JSON.parse(route.request().postData());
      let body;
      try { body = { jsonrpc: '2.0', id: req.id, result: await b.rpc(req.method, req.params) }; } catch (e) { body = { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32000, message: String(e.message), data: e.data } }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route((url) => !url.href.startsWith(server.origin) && !url.href.startsWith(RPC_URL), (route) => { problems.push(`request to ${route.request().url()}`); return route.abort(); });
    await injectWallet(page, async (method, params) => {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [b.user];
        case 'eth_chainId': return '0x12e4e';
        case 'eth_sendTransaction': return b.walletSend(params[0]);
        default: return b.rpc(method, params);
      }
    });
    await page.goto(`${server.origin}/#dlmm`);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === '1', null, { timeout: 30_000 });
    await page.click('#connect-btn');
    await page.click('.wallet-btn');
    await page.waitForFunction(() => !document.getElementById('wallet-dialog').open || document.getElementById('connect-btn').textContent.startsWith('0x'), null, { timeout: 10_000 });
    await page.click('.tab[data-tab="dlmm"]');
    // Pair: native (ZTPHY) and tUSD, bin step 10.
    await page.selectOption('#dl-a', 'native');
    await page.selectOption('#dl-b', tusd.toLowerCase());
    await page.waitForFunction(() => document.querySelectorAll('#dl-chart .dl-bar').length === 41, null, { timeout: 30_000 });
    assert.match(await page.textContent('#dl-info'), /active bin 0/);
    assert.equal(await page.locator('#dl-chart .dl-bar').count(), 41, 'bars for the bins around the price');
    assert.match(await page.textContent('#dlmm-root'), /UNAUDITED/);

    // Waits for a final status (ok / err) other than the one shown before the click.
    const act = async (id, click) => {
      const prev = await page.textContent(`#${id}`);
      await click();
      await page.waitForFunction(([i, p]) => { const s = document.getElementById(i); return s && s.textContent !== p && (s.classList.contains('ok') || s.classList.contains('err')); }, [id, prev], { timeout: 60_000 });
      assert.equal(await page.getAttribute(`#${id}`, 'class'), 'status ok', await page.textContent(`#${id}`));
    };

    // Swap 1 ZTPHY -> tUSD.
    const dirs = await page.locator('#dl-swap-dir option').allTextContents();
    await page.selectOption('#dl-swap-dir', { index: dirs.findIndex((x) => x.startsWith('ZTPHY')) });
    await page.fill('#dl-swap-amt', '1');
    await page.waitForFunction(() => /tUSD/.test(document.getElementById('dl-swap-quote').textContent), null, { timeout: 30_000 });
    const t0 = await bal(tusd, b.user);
    await act('dl-swap-status', () => page.click('#dl-swap'));
    assert.ok((await bal(tusd, b.user)) > t0, 'tUSD received');

    // Add 2 tUSD + 2 ZTPHY over 3 bins each side (approve tUSD first).
    const xIsNative = X === wnative;
    await page.fill('#dl-below', '3');
    await page.fill('#dl-above', '3');
    await page.fill('#dl-amt-x', '2');
    await page.fill('#dl-amt-y', '2');
    await page.waitForFunction(() => /bin/.test(document.getElementById('dl-preview').textContent), null, { timeout: 30_000 });
    const approveBtn = xIsNative ? '#dl-approve-y' : '#dl-approve-x';
    await page.waitForSelector(`${approveBtn}:not([hidden])`, { timeout: 30_000 });
    await act('dl-add-status', () => page.click(approveBtn));
    await page.waitForSelector(`${approveBtn}[hidden]`, { state: 'attached', timeout: 30_000 });
    await act('dl-add-status', () => page.click('#dl-add'));
    const pairI = I.ZetaphyDlmmPair;
    const share = async (id) => pairI.decodeFunctionResult('balanceOf', await b.call(pair, pairI.encodeFunctionData('balanceOf', [b.user, id])))[0];
    const ids = [-3, -2, -1, 0, 1, 2, 3];
    const before = await Promise.all(ids.map(share));
    assert.ok(before.filter((s) => s > 0n).length >= 6, 'shares in the range');
    await page.waitForFunction(() => document.querySelectorAll('#dl-positions [data-dl-remove]').length === 3, null, { timeout: 30_000 });

    // Remove 100%: the page asks for setApprovalForAll, then removes.
    await act('dl-pos-status', () => page.click('#dl-positions [data-dl-remove="100"]'));
    const after = await Promise.all(ids.map(share));
    assert.deepEqual(after, ids.map(() => 0n), 'all shares burned');
    assert.deepEqual(problems, [], problems.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
});
