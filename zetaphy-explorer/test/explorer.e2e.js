// Browser test: serves the static site with its real CSP (scripts/serve.js reads
// vercel.json), answers the node's EVM JSON-RPC, CometBFT RPC and Cosmos REST
// from a mock chain (test/mock-chain.js, Playwright routes, no network), and
// checks every page in Thai and English (and the home page in all 8 UI languages): home, block with the ML-DSA-44
// certificate verified in the browser (and a broken one refused), Cosmos and
// EVM txs, addresses (0x and zetaphy1, quantum lock), tokens with hostile names,
// ThreatRegistry flags with the disclaimer, validators with PQ vote keys,
// search, settings, theme, phone width, and that the node is not hammered.
//   npm run test:e2e        (Playwright's Chromium: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { T, LANGS } from '../src/i18n.js';
import { buildChain, CHAIN_ID, LATEST, ME, ME_HEX, LOCKED, LOCKED_HEX, TOKEN, NFT, REGISTRY, REPORT, RESPONSE_TEXT } from './mock-chain.js';

const PORT = 18195; const PORT_DEFAULT = 18196;
const ORIGIN = `http://localhost:${PORT}`;
const NODE = 'https://node.zetaphy.test';
const OTHER_NODE = 'https://other.zetaphy.test';
const NEURO = 'https://neuro.example/web/?chain=zetaphy&address={address}';
const dir = mkdtempSync(join(tmpdir(), 'zetaphy-explorer-'));
const chain = buildChain();
let servers = []; let browser;
const counts = { [NODE]: 0, [OTHER_NODE]: 0 };

function serve(port, configPath) {
  const p = spawn(process.execPath, ['scripts/serve.js', String(port)], { stdio: 'pipe', cwd: new URL('..', import.meta.url), env: { ...process.env, ...(configPath ? { EXPLORER_CONFIG: configPath } : {}) } });
  servers.push(p);
  return new Promise((r) => p.stdout.once('data', r));
}

async function launch() {
  try { return await chromium.launch({ headless: true }); } catch {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ node: NODE, threatRegistry: REGISTRY, neuroReportUrl: NEURO, chainStatsUrl: 'https://stats.zetaphy.test/api/chain-stats', scanBlocks: 100 }));
  // The placeholder a fresh checkout ships (the launch replaces config.json with the live node).
  const placeholder = join(dir, 'placeholder.json');
  writeFileSync(placeholder, JSON.stringify({ node: 'https://<node-host>', evmRpc: '', cometRpc: '', rest: '', threatRegistry: '', neuroReportUrl: '', scanBlocks: 100 }));
  await Promise.all([serve(PORT, cfg), serve(PORT_DEFAULT, placeholder)]);
  browser = await launch();
});
after(async () => { await browser?.close(); for (const s of servers) s.kill(); rmSync(dir, { recursive: true, force: true }); });

const CHAIN_STATS = { enabled: true, month: '2026-10', height: 30, updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), stale: false,
  total: { all: 98765, transfers: 4000, staking: 300, crossChain: 20, evm: 90000, governance: 7 },
  thisMonth: { all: 4321, transfers: 120, staking: 15, crossChain: 2, evm: 4100, governance: 3 } };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

/** A page with the mock node behind https://node.zetaphy.test (and other.zetaphy.test); records problems. */
/** lang: the stored language preference ('th' unless set; null for none). */
async function openPage({ viewport, lang = 'th', origin = ORIGIN } = {}) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = []; const mine = {};
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/node\.zetaphy\.test|other\.zetaphy\.test/.test(r.url())) problems.push(`requestfailed: ${r.url()}`); });
  // Neuro's chain activity counts (/api/chain-stats)
  await ctx.route((url) => url.host === 'stats.zetaphy.test', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(CHAIN_STATS) }));
  await ctx.route((url) => url.host === 'node.zetaphy.test' || url.host === 'other.zetaphy.test', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    counts[url.origin] = (counts[url.origin] ?? 0) + 1;
    mine[url.origin] = (mine[url.origin] ?? 0) + 1;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
    if (url.pathname.startsWith('/rest/')) {
      const body = chain.rest(url.pathname.slice(5) + url.search);
      return body ? json(200, body) : json(501, { code: 12, message: 'Not Implemented' });
    }
    const { id, method, params } = JSON.parse(req.postData() ?? '{}');
    const handler = url.pathname.startsWith('/rpc/') ? chain.comet : url.pathname === '/' ? chain.evmRpc : null;
    if (!handler) return json(404, { error: 'not found' });
    try { return json(200, { jsonrpc: '2.0', id, result: handler(method, params) }); } catch (e) {
      return json(200, { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message, data: url.pathname.startsWith('/rpc/') ? e.message : undefined } });
    }
  });
  // lang: null leaves storage empty (a first visit: English by default).
  if (lang) await page.addInitScript((l) => { try { localStorage.setItem('zetaphy-explorer:lang', l); } catch { /* none */ } }, lang);
  return { page, ctx, problems, counts: mine };
}

const text = (page) => page.locator('main').innerText();
async function go(page, hash) { await page.goto(`${ORIGIN}/${hash}`); }
async function waitText(page, s, timeout = 15000) {
  try {
    await page.waitForFunction((x) => document.querySelector('main')?.innerText.includes(x), s, { timeout });
  } catch (e) {
    throw new Error(`"${s}" never appeared on ${page.url()}; the page shows:\n${(await text(page).catch(() => '?')).slice(0, 3000)}`);
  }
}

test('home: chain id, height, supply with burns, staking, PQ coverage, latest blocks and txs, no-indexer note', async () => {
  const { page, ctx, problems } = await openPage();
  const before = counts[NODE];
  await go(page, '#/');
  await waitText(page, 'ไม่มีตัวทำดัชนี');
  await waitText(page, 'MsgSend');
  await waitText(page, 'เผาไปใน');
  await waitText(page, 'ของพลังโหวตมีกุญแจโหวต PQ');
  const t = await text(page);
  assert.match(t, new RegExp(CHAIN_ID));
  assert.match(t, /1,000,000 ZETAPHY/);
  assert.match(t, /เผาไปใน ~1 ชม\. ล่าสุด: 1\.2 ZETAPHY/);
  assert.match(t, /100,000 ZETAPHY/); // bonded
  assert.match(t, /10\.0% ของอุปทาน/);
  assert.match(t, /60\.0% ของพลังโหวตมีกุญแจโหวต PQ/);
  // this month's activity, from Neuro's daily counts
  await waitText(page, 'กิจกรรมเดือนนี้');
  const act = await page.locator('section.activity').innerText();
  assert.match(act, /4,321/); assert.match(act, /ข้ามเชน\s+2\b/); assert.match(act, /98,765/);
  assert.match(t, /สแกนเฉพาะ 30 บล็อกล่าสุด \(1–30\)/); // the chain has 30 blocks; scanBlocks 100
  // latest txs: EVM and Cosmos, certificates not listed, failed one marked
  assert.match(t, /EVM/); assert.match(t, /MsgPQVoteKey/); assert.match(t, /MsgSetPQEvidence/); assert.ok(!/MsgPQCertificate/.test(t));
  assert.match(t, /ไม่สำเร็จ/);
  // latest blocks list
  assert.ok(await page.locator(`a[href="#/block/${LATEST}"]`).count() >= 1);
  // a bounded number of requests for the whole home page
  const used = counts[NODE] - before;
  assert.ok(used < 60, `home used ${used} requests`);
  const stats = await page.evaluate(() => window.__explorer.stats());
  assert.ok(stats.requests < 60 && stats.requests > 5, JSON.stringify(stats));
  // Beta's moniker has a bidi override: removed before display
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('block page: header, proposer, decoded txs and the ML-DSA-44 certificate verified in the browser', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/block/20');
  await waitText(page, 'ใบรับรองถูกต้องตามกุญแจ validator ของโหนดนี้');
  const t = await text(page);
  assert.match(t, new RegExp(chain.blocks.get(20).hash));
  assert.match(t, /Alpha Node|Beta Node/); // proposer moniker
  assert.match(t, /ใบรับรอง PQ/); assert.match(t, /รับรองบล็อก 19/); // tx 0: certificate of block 19
  assert.match(t, /MsgSend, MsgEVMCall, MsgQuantumLock/);
  assert.match(t, /60 \/ 100 \(60\.0%\)/); // signed power
  assert.match(t, /\b27\b/); // needed: 3 × signed > 2 × 100 − 3 × 40 → at least 27
  assert.match(t, /ใบรับรองอยู่ในบล็อก 21/);
  assert.ok(!/Beta‮/.test(t) && /Beta Node/.test(t));
  // the certificate of block 26 has a broken signature: refused
  await go(page, '#/block/26');
  await waitText(page, 'ใบรับรองไม่ถูกต้อง');
  assert.match(await text(page), /ML-DSA-44 signature does not verify/);
  // the newest block has no certificate yet
  await go(page, `#/block/${LATEST}`);
  await waitText(page, 'ยังไม่มีใบรับรอง');
  await go(page, '#/block/999');
  await waitText(page, 'ยังไม่มีบล็อกนี้');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('Cosmos tx: ZETAPHY messages decoded, ML-DSA-44 signer, memo sanitised; failed tx shows its log', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  const hash = chain.cometHashOf(20, 1);
  await go(page, `#/tx/${hash}`);
  await waitText(page, 'MsgQuantumLock');
  const t = await text(page);
  assert.match(t, /Success/);
  assert.match(t, /ML-DSA-44 \(post-quantum\) key/);
  assert.match(t, /#0 MsgSend/); assert.match(t, /2\.5 ZETAPHY/);
  assert.match(t, /#1 MsgEVMCall/); assert.match(t, /as owner/); assert.match(t, /0xa9059cbb · 68 bytes/);
  assert.match(t, /#2 MsgQuantumLock/); assert.match(t, /controller/);
  assert.match(t, /gm from ZETAPHY/); // the bidi override in the memo is gone
  assert.ok(await page.locator(`main a[href="#/address/${LOCKED_HEX}"]`).count() >= 1);
  await go(page, `#/tx/${chain.cometHashOf(21, 1)}`);
  await waitText(page, 'MsgPQVoteKey');
  assert.match(await text(page), /code 4 · unauthorized: proof does not verify/);
  // the certificate tx itself
  await go(page, `#/tx/${chain.cometHashOf(20, 0)}`);
  await waitText(page, 'MsgPQCertificate');
  assert.match(await text(page), /Certifies block\s+19/);
  assert.match(await text(page), /Signatures\s+1/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('EVM tx: from/to/value/gas/status and ERC-20 / ERC-721 / ERC-1155 transfers decoded', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/tx/${chain.evmTxHash}`);
  await waitText(page, 'ERC-1155');
  await waitText(page, '1.5 SWD');
  const t = await text(page);
  assert.match(t, /Success/);
  assert.match(t, new RegExp(chain.evmWallet.address));
  assert.match(t, /61,234 \/ 150,000/);
  assert.match(t, /1\.5 gwei/);
  assert.match(t, /0\.000091851 ZETAPHY/); // 61234 × 1.5 gwei
  assert.match(t, /ERC-20/); assert.match(t, /ERC-721/); assert.match(t, /NFT #7/); assert.match(t, /#3 ×10/); assert.match(t, /mint/);
  // the block's list links the EVM hash (keccak of the raw tx), not the CometBFT hash
  await go(page, '#/block/22');
  await waitText(page, 'MsgEthereumTx');
  assert.ok(await page.locator(`main a[href="#/tx/${chain.evmTxHash}"]`).count() === 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('address: 0x and zetaphy1 forms, balance, sequence, ML-DSA-44, tokens, recent txs; quantum lock', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/address/${ME}`);
  await waitText(page, 'Token balances');
  await waitText(page, 'Siam Art');
  await waitText(page, 'MsgSetPQEvidence');
  const t = await text(page);
  assert.match(t, new RegExp(ME_HEX)); assert.match(t, new RegExp(ME));
  assert.match(t, /1,234\.5 ZETAPHY/);
  assert.match(t, /3 \(account number 5\)/);
  assert.match(t, /ML-DSA-44 account \(post-quantum\)/);
  assert.match(t, /1,000 ZETAPHY · 1 validators/); // staked
  assert.match(t, /1\.5\b/); // ERC-20 balance
  assert.match(t, /ERC-721/);
  assert.match(t, /MsgSend/); // recent txs of this address from the scan
  assert.match(t, /No indexer/);
  await go(page, `#/address/${LOCKED_HEX}`);
  await waitText(page, 'locked to controller');
  const t2 = await text(page);
  assert.match(t2, /Quantum-locked/);
  assert.match(t2, new RegExp(LOCKED));
  assert.ok(await page.locator(`main a[href="#/address/${ME_HEX}"]`).count() >= 1);
  await go(page, '#/address/0xnope');
  await waitText(page, 'Not an address');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('token page: hostile name shown as plain text, supply, Neuro link, ThreatRegistry flag with the disclaimer', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, `#/token/${TOKEN}`);
  await waitText(page, 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา');
  const t = await text(page);
  assert.match(t, /<img src=x onerror="window\.__pwned=1">Sawasdeetx/); // as text, bidi override removed
  assert.ok(!t.includes('\u202E') && !t.includes('\u200B'));
  assert.equal(await page.locator('main img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(t, /1,000,000 SWD/);
  assert.match(t, /ERC-20/);
  assert.equal(await page.locator('main a[target="_blank"]').getAttribute('href'), NEURO.replace('{address}', TOKEN));
  // the flag: neutral facts, evidence, the owner's response, the disclaimer
  assert.match(t, /ติดธงโดยผู้รัน Neuro/);
  assert.match(t, /มีที่อยู่ที่สร้างเหรียญเพิ่มได้ไม่จำกัด \(unlimited-mint\)/);
  assert.match(t, new RegExp(REPORT)); assert.match(t, /ipfs:\/\/neuro-report-1/);
  assert.match(t, new RegExp(RESPONSE_TEXT));
  assert.match(t, /ติดธง \(คำเตือน\)/);
  // an unflagged ERC-721
  await go(page, `#/token/${NFT}`);
  await waitText(page, 'ไม่ติดธง');
  assert.match(await text(page), /ERC-721/);
  assert.match(await text(page), /Siam Art/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('validators: power, status, commission and PQ vote keys', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, '#/validators');
  await waitText(page, 'Not registered');
  const t = await text(page);
  assert.match(t, /Alpha Node/); assert.match(t, /Beta Node/);
  assert.match(t, /Registered\s+since block 1/);
  assert.match(t, /60 \(60\.0%\)/);
  assert.match(t, /60 \(60\.0%\)\s*$/m);
  assert.match(t, /5\.0%/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('search, language and theme toggles, settings (another node), phone width', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/');
  await waitText(page, 'บล็อกล่าสุด');
  const search = async (q) => { await page.fill('#search', q); await page.press('#search', 'Enter'); };
  await search('12'); await page.waitForURL(/#\/block\/12$/);
  await search(ME); await page.waitForURL(new RegExp(`#/address/${ME_HEX}$`));
  await search(chain.evmTxHash); await page.waitForURL(new RegExp(`#/tx/${chain.evmTxHash}$`));
  await search(chain.cometHashOf(24, 1)); await waitText(page, 'MsgSetPQEvidence');
  await search(chain.blocks.get(9).hash); await page.waitForURL(/#\/block\/9$/); // a block hash
  await search('not a thing'); assert.match(page.url(), /#\/block\/9$/);
  // language
  await page.selectOption('#lang', 'en');
  await waitText(page, 'Post-quantum certificate');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await page.locator('.nav a[href="#/validators"]').innerText(), 'Validators');
  await page.selectOption('#lang', 'th');
  await waitText(page, 'ใบรับรองต้านควอนตัม');
  // theme
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#theme-toggle');
  assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), theme);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#theme-toggle');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), bg);
  // settings: a node set in this browser is used, a non-https one refused, then reset
  await go(page, '#/settings');
  await page.fill('#s-node', 'http://evil.example');
  await page.click('form.settings button[type=submit]');
  await waitText(page, 'https://');
  assert.match(await page.locator('.msg-line').innerText(), /ผิดพลาด/);
  await page.fill('#s-node', OTHER_NODE);
  await page.click('form.settings button[type=submit]');
  await waitText(page, 'บันทึกแล้ว');
  const before = counts[OTHER_NODE];
  await go(page, '#/block/5');
  await waitText(page, 'ใบรับรองถูกต้องตามกุญแจ validator ของโหนดนี้');
  assert.ok(counts[OTHER_NODE] > before, 'requests go to the node set in settings');
  assert.equal(await page.evaluate(() => window.__explorer.config().node), OTHER_NODE + '/');
  await go(page, '#/settings');
  await page.click('text=ใช้ค่าเริ่มต้นของเว็บ');
  assert.equal(await page.evaluate(() => window.__explorer.config().node), NODE);
  assert.deepEqual(problems, []);
  await ctx.close();
  // phone: no sideways scrolling on the busiest pages
  const phone = await openPage({ viewport: { width: 375, height: 800 } });
  for (const h of ['#/', '#/block/20', `#/tx/${chain.evmTxHash}`, `#/address/${ME}`, '#/validators']) {
    await go(phone.page, h);
    await phone.page.waitForSelector('main .card');
    await phone.page.waitForTimeout(800);
    const [sw, iw] = await phone.page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${h}: page is ${sw}px wide on a ${iw}px screen`);
  }
  assert.deepEqual(phone.problems, []);
  await phone.ctx.close();
});

test('a first visit (no stored language) is in English; a Thai choice is remembered', async () => {
  const { page, ctx, problems } = await openPage({ lang: null });
  await go(page, '#/');
  await waitText(page, 'Latest blocks');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await page.locator('.nav a[href="#/settings"]').innerText(), 'Settings');
  assert.equal(await page.locator('#lang').inputValue(), 'en');
  assert.deepEqual(await page.locator('#lang option').evaluateAll((os) => os.map((o) => [o.value, o.textContent])), LANGS);
  await page.selectOption('#lang', 'th');
  await waitText(page, 'บล็อกล่าสุด');
  assert.equal(await page.evaluate(() => localStorage.getItem('zetaphy-explorer:lang')), 'th');
  await page.reload();
  await waitText(page, 'บล็อกล่าสุด');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'th');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('"Use a hardware wallet" help in the footer: in the page language, fits a phone, under the CSP', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'th', viewport: { width: 360, height: 740 } });
  await go(page, '#/');
  await waitText(page, 'บล็อกล่าสุด');
  assert.equal(await page.locator('#footer-help [data-ws="help"]').innerText(), 'ใช้กระเป๋าฮาร์ดแวร์');
  await page.click('#footer-help [data-ws="help"]');
  await page.waitForSelector('#ws-help[open]');
  const help = await page.locator('#ws-help').innerText();
  assert.match(help, /MetaMask[\s\S]*Rabby[\s\S]*connect\.trezor\.io[\s\S]*Keplr/);
  assert.ok(!/Ledger \(USB\)/.test(help), 'the explorer connects no Ledger itself');
  assert.ok(await page.evaluate(() => { const r = document.getElementById('ws-help').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }), 'fits at 360px');
  await page.keyboard.press('Escape');
  await page.selectOption('#lang', 'en');
  assert.equal(await page.locator('#footer-help [data-ws="help"]').innerText(), 'Use a hardware wallet');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('every UI language renders the home page with its own texts and no raw keys', async () => {
  const camelKeys = Object.keys(T.en).filter((k) => /[A-Z_]/.test(k));
  for (const [code] of LANGS) {
    const { page, ctx, problems } = await openPage({ lang: code });
    await go(page, '#/');
    await waitText(page, T[code].latestBlocks);
    await waitText(page, 'MsgSend');
    assert.equal(await page.evaluate(() => document.documentElement.lang), code, code);
    assert.equal(await page.locator('#lang').inputValue(), code);
    assert.equal(await page.locator('.nav a[href="#/settings"]').innerText(), T[code].navSettings, code);
    assert.equal(await page.locator('#search').getAttribute('placeholder'), T[code].searchPlaceholder, code);
    const body = await page.locator('body').innerText();
    for (const k of camelKeys) assert.ok(!new RegExp(`\\b${k}\\b`).test(body), `${code}: raw key ${k} on the page`);
    assert.ok(!/\{[a-zA-Z]+\}/.test(body), `${code}: unfilled placeholder`);
    assert.deepEqual(problems, [], code);
    await ctx.close();
  }
  // an unknown stored code falls back to English
  const { page, ctx } = await openPage({ lang: 'xx' });
  await go(page, '#/');
  await waitText(page, 'Latest blocks');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await ctx.close();
});

test('placeholder config: the site says how to set the node and sends nothing', async () => {
  const { page, ctx, problems, counts: mine } = await openPage();
  await page.goto(`http://localhost:${PORT_DEFAULT}/#/`);
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner').innerText(), /ยังไม่ได้ตั้งโหนด/);
  await page.waitForTimeout(500);
  assert.deepEqual(mine, {});
  // the CSP in force is vercel.json's
  const res = await page.request.get(`http://localhost:${PORT_DEFAULT}/`);
  assert.match(res.headers()['content-security-policy'], /script-src 'self';/);
  assert.deepEqual(problems, []);
  await ctx.close();
});
