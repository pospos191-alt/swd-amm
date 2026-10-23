// Browser test for web/: serves the page, answers its RPC requests from the
// in-memory test chain (no network), and checks what a user would see.
//   npm run test:web            (uses Playwright's Chromium)
//   SCREENSHOT_DIR=... npm run test:web   also saves screenshots
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createLocalChain } from './helpers/local-chain.js';
import { CHAINS } from '../src/chains.js';
import { LANGS } from '../src/explain.js';

const PORT = 18080;
const RPC_PORT = 18081;
const shots = process.env.SCREENSHOT_DIR;
let server; let browser; let chain; let rpcServer;
// The local server's early-warning pack (as NEURO_PRIVATE_RULES on Vercel).
const PRIVATE_PACK = { version: 1, refKey: 'e2e-ref-key-0123456789', rules: [{
  id: 'e2e-secret-rule', addedAt: '2026-10-01', publishAfter: '2026-11-01', kind: 'selectors',
  selectors: ['mint(address,uint256)', 'setBlacklist(address,bool)'], reason: 'owner-can-block-transfers', severity: 'high',
}] };

async function launch() {
  const opts = { headless: true };
  try { return await chromium.launch(opts); } catch {
    return chromium.launch({ ...opts, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  chain = await createLocalChain();
  // JSON-RPC over HTTP backed by the test chain: what the local server reads
  // contract code from for /api/early-warning (NEURO_DEV_RPC).
  rpcServer = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    let out;
    try { out = { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params) }; } catch (e) { out = { jsonrpc: '2.0', id, error: { code: 3, message: e.message } }; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  }).listen(RPC_PORT);
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], {
    stdio: 'pipe',
    env: { ...process.env, NEURO_PRIVATE_RULES: JSON.stringify(PRIVATE_PACK), NEURO_DEV_RPC: `http://127.0.0.1:${RPC_PORT}` },
  });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); rpcServer?.close(); });

const SOL_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** lang: pick that language in the menu after loading (the page opens in English). */
async function openPage(scheme, solanaAccounts = {}, tonapi = {}, { lang } = {}) {
  const page = await browser.newPage({ colorScheme: scheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Every https request is an RPC call to a "BNB Chain" endpoint backed by the test chain.
  // A predicate, not a glob: TON paths contain an encoded ':' that 'https://**' misses.
  await page.route((url) => url.protocol === 'https:', async (route) => {
    // TON: tonapi.io REST (GET), answered from the `tonapi` map by path.
    if (route.request().method() === 'GET') {
      const path = decodeURIComponent(new URL(route.request().url()).pathname);
      const hit = tonapi[path];
      await route.fulfill({ status: hit ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(hit ?? { error: 'not found' }) });
      return;
    }
    const { id, method, params } = JSON.parse(route.request().postData());
    let body;
    try {
      let result;
      if (method === 'getGenesisHash') result = SOL_GENESIS;
      else if (method === 'getAccountInfo') result = { value: solanaAccounts[params[0]] ?? null };
      else result = method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params);
      body = { jsonrpc: '2.0', id, result };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: 3, message: e.message } };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  if (lang) {
    await page.selectOption('#lang', lang);
    assert.equal(await page.getAttribute('html', 'lang'), lang);
  }
  return { page, errors };
}

test('token with many owner powers shows high risk in Thai, then English', async () => {
  const addr = await chain.deploy('ScamToken');
  const { page, errors } = await openPage('light');
  // English on a first visit; Thai when chosen.
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.inputValue('#lang'), 'en');
  assert.equal(await page.textContent('#go'), 'Check contract');
  await page.selectOption('#lang', 'th');
  assert.equal(await page.getAttribute('html', 'lang'), 'th');
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง');
  const items = await page.$$eval('#findings li', (els) => els.map((e) => e.textContent));
  assert.ok(items.some((t) => t.includes('สร้างเหรียญเพิ่มได้')));
  assert.ok(page.url().includes(`address=${addr}`), 'shareable link');
  assert.match(await page.textContent('#meta'), /fp1:[0-9a-f]{64}/, 'fingerprint shown for template registration');
  // Disclaimer, correction link and evidence (report ID + CLI command) on every report.
  assert.match(await page.textContent('#disclaimer'), /ไม่ใช่คำกล่าวหาบุคคลหรือโครงการ/);
  assert.equal(await page.getAttribute('#correction', 'href'), './legal.html');
  const evidence = await page.textContent('#evidence');
  const reportId = evidence.match(/[0-9a-f]{64}/)?.[0];
  assert.ok(reportId, 'full report ID shown');
  await page.waitForFunction(() => /0x[0-9a-f]{64}/.test(document.getElementById('evidence').textContent));
  assert.ok((await page.textContent('#evidence')).includes(`node cli.js bsc ${addr.toLowerCase()} --lang th`), 'CLI command shown');
  assert.ok(items.every((t) => t.includes(reportId.slice(0, 12))), 'each finding points to its report ID');
  if (shots) await page.screenshot({ path: `${shots}/neuro-scam-th.png`, fullPage: true });
  await page.selectOption('#lang', 'en');
  assert.equal(await page.textContent('#title'), 'High risk');
  assert.match(await page.textContent('#disclaimer'), /not an accusation against any person or project/);
  // Every language in the menu re-renders the same result.
  const want = { zh: /[\u4E00-\u9FFF]/, ja: /[\u3040-\u30FF]/, ko: /[\uAC00-\uD7AF]/, vi: /rủi ro|Rủi ro/, id: /Risiko|risiko/ };
  for (const [code, re] of Object.entries(want)) {
    await page.selectOption('#lang', code);
    assert.match(await page.textContent('#title'), re, code);
    assert.equal(await page.getAttribute('html', 'lang'), code);
  }
  await page.selectOption('#lang', 'th');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'lang'), 'th', 'the choice is remembered');
  assert.equal(await page.inputValue('#lang'), 'th');
  assert.equal(await page.textContent('#go'), 'ตรวจสัญญา');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a token name with a link is shown as text, never as HTML', async () => {
  const addr = await chain.deploy('PhishToken');
  const { page, errors } = await openPage('dark');
  await page.goto(`http://localhost:${PORT}/?chain=bsc&address=${addr}`);
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.$$eval('#findings a, #findings img, #findings script', (e) => e.length), 0);
  if (shots) await page.screenshot({ path: `${shots}/neuro-phish-dark.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('each successful check is counted, and the stats page shows it', async () => {
  const before = await (await fetch(`http://localhost:${PORT}/api/usage`)).json();
  const addr = await chain.deploy('CleanToken');
  const { page, errors } = await openPage('light');
  await page.fill('#address', addr);
  const counted = page.waitForResponse((r) => r.url().endsWith('/api/usage') && r.request().method() === 'POST');
  await page.click('#go');
  assert.equal((await counted).status(), 202);
  await page.click('a[href="./stats.html"]');
  await page.waitForFunction(() => document.getElementById('users').textContent !== '–');
  assert.equal(await page.getAttribute('html', 'lang'), 'en', 'stats page in English by default');
  assert.equal(await page.textContent('#lang'), 'ไทย');
  const users = Number((await page.textContent('#users')).replace(/,/g, ''));
  const checks = Number((await page.textContent('#checks')).replace(/,/g, ''));
  assert.equal(users, 1, 'one visitor (same IP and browser) across all tests');
  assert.equal(checks, before.checks + 1);
  assert.match(await page.textContent('#pct'), /^\d+%$/);
  if (shots) await page.screenshot({ path: `${shots}/neuro-stats.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Solana: a token with a permanent delegate is shown as high risk', async () => {
  const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const { page, errors } = await openPage('light', {
    [mint]: { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { program: 'spl-token-2022', parsed: { type: 'mint', info: {
      decimals: 6, supply: '1000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true,
      extensions: [
        { extension: 'permanentDelegate', state: { delegate: mint } },
        { extension: 'tokenMetadata', state: { updateAuthority: null, mint, name: 'Sneaky', symbol: 'SNK', uri: '', additionalMetadata: [] } },
      ] } } } },
  }, {}, { lang: 'th' });
  await page.selectOption('#chain', 'sol');
  assert.equal(await page.getAttribute('#address', 'placeholder'), 'EPjFWdd5…');
  await page.fill('#address', mint);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง');
  const items = await page.$$eval('#findings li', (els) => els.map((e) => e.textContent));
  assert.ok(items[0].includes('Sneaky'));
  assert.ok(items.some((t) => t.includes('permanent delegate')));
  if (shots) await page.screenshot({ path: `${shots}/neuro-solana.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('TON: a mintable jetton is read over tonapi.io and shown as high risk', async () => {
  const raw = `0:${'ab'.repeat(32)}`;
  const { page, errors } = await openPage('dark', {}, {
    [`/v2/accounts/${raw}`]: { address: raw, status: 'active', interfaces: ['jetton_master'], get_methods: ['get_jetton_data'], is_wallet: false, is_scam: false, balance: 1, last_activity: 1 },
    [`/v2/jettons/${raw}`]: { mintable: true, total_supply: '5000000000', holders_count: 7, verification: 'none', preview: '',
      admin: { address: `0:${'cd'.repeat(32)}`, is_scam: false, is_wallet: true }, metadata: { address: raw, name: 'Ton Rocket', symbol: 'RKT', decimals: '9' } },
  }, { lang: 'th' });
  await page.selectOption('#chain', 'ton');
  assert.equal(await page.getAttribute('#address', 'placeholder'), 'EQ… / UQ…');
  await page.fill('#address', raw);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง');
  const items = await page.$$eval('#findings li', (els) => els.map((e) => e.textContent));
  assert.ok(items[0].includes('Ton Rocket'));
  assert.match(await page.getAttribute('#meta a', 'href'), /^https:\/\/tonviewer\.com\//);
  if (shots) await page.screenshot({ path: `${shots}/neuro-ton.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('buy/sell test: the simulated trade catches a sell block behind a harmless name', async () => {
  // A mock Uniswap-V2 DEX at PancakeSwap's real addresses, and a token only its owner can sell.
  const addPool = await chain.installDex(CHAINS.bsc.dex);
  const addr = await chain.deploy('QuietHoneypot');
  const pair = await addPool(addr, 10n ** 24n, 10n ** 20n);
  await chain.send(addr, 'syncRewards(address)', [pair]);
  const { page, errors } = await openPage('light', {}, {}, { lang: 'th' });
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง');
  const items = await page.$$eval('#findings li', (els) => els.map((e) => e.textContent));
  assert.match(items[1], /^ทดสอบขายไม่ผ่าน: .*ซื้อได้แต่ขายไม่ได้/, 'right under what the token is');
  const meta = await page.textContent('#meta');
  assert.ok(meta.includes(`PancakeSwap V2 · ${pair}`), 'pool shown');
  assert.match(meta, /0% \/ ขายไม่ได้/, 'buy tax and failed sell shown');
  if (shots) await page.screenshot({ path: `${shots}/neuro-honeypot-th.png`, fullPage: true });
  await page.selectOption('#lang', 'en');
  assert.match(await page.textContent('#findings'), /Sell test failed: in a simulated trade/);
  assert.doesNotMatch(await page.textContent('#result'), /honeypot|scam/i);
  await page.selectOption('#lang', 'th');
  assert.deepEqual(errors, []);
  await page.close();
});

test('early warning: a match in the private rule pack shows an advisory notice, never the rule', async () => {
  const addr = await chain.deploy('ScamToken');
  const { page, errors } = await openPage('light', {}, {}, { lang: 'th' });
  await page.fill('#address', addr);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/early-warning'));
  await page.click('#go');
  const res = await answer;
  assert.deepEqual(JSON.parse(res.request().postData()), { chain: 'bsc', address: addr }, 'only the chain and the address are sent');
  const body = await res.text();
  for (const secret of ['e2e-secret-rule', 'setBlacklist', 'mint', '44337ea1', 'e2e-ref-key', 'selectors']) assert.ok(!body.includes(secret), secret);
  await page.waitForSelector('#early:not([hidden])');
  const th = await page.textContent('#early');
  assert.ok(th.includes(LANGS.th.REASON['owner-can-block-transfers']), th);
  assert.match(th, /ew-[0-9a-f]{12}/);
  assert.ok(th.includes(LANGS.th.UI.early));
  assert.equal(await page.textContent('#title'), 'เสี่ยงสูง', 'the result itself comes from the public rules');
  if (shots) await page.screenshot({ path: `${shots}/neuro-early-warning-th.png`, fullPage: true });
  await page.selectOption('#lang', 'en');
  const en = await page.textContent('#early');
  assert.match(en, /Early warning/);
  assert.ok(en.includes(LANGS.en.REASON['owner-can-block-transfers']));
  assert.doesNotMatch(en, /scam|honeypot|fraud/i);
  await page.selectOption('#lang', 'th');
  // A contract that matches nothing: no notice.
  await page.fill('#address', await chain.deploy('CleanToken'));
  const again = page.waitForResponse((r) => r.url().endsWith('/api/early-warning'));
  await page.click('#go');
  assert.deepEqual(await (await again).json(), { warnings: [], configured: true });
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.isHidden('#early'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('bad address shows an error without any RPC call', async () => {
  const { page } = await openPage('light', {}, {}, { lang: 'th' });
  let calls = 0;
  page.on('request', (r) => { if (r.url().startsWith('https://')) calls++; });
  await page.fill('#address', '0x1234');
  await page.click('#go');
  assert.match(await page.textContent('#status'), /ที่อยู่ไม่ถูกต้อง/);
  assert.equal(calls, 0);
  await page.close();
});
