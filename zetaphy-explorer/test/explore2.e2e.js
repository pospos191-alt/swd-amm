// Browser test of the validators (deep), governance, holders, NFT gallery, gas, tools and
// PWA parts, with the real CSP (scripts/serve.js) and the mock node of test/mock-chain.js
// behind Playwright routes (no network; https://ipfs.io is mocked too).
//   node --test test/explore2.e2e.js     (E2E2_PORT: another free port pair)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Wallet, getAddress } from 'ethers';
import { ml_dsa44, bytesToHex } from '../vendor/zetaphy-lib.js';
import { buildChain, ME, ME_HEX, TOKEN, NFT, REGISTRY, TOKEN_OWNER, IPFS_FILES } from './mock-chain.js';
import { feeSuggestions, burnedEstimate, gwei } from '../src/gas.js';
import { formatZtphy } from '../src/format.js';

// A free port (other checkouts may run their tests at the same time), or E2E2_PORT.
const PORT = Number(process.env.E2E2_PORT) || await new Promise((r) => { const sv = createServer().listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => r(port)); }); });
const ORIGIN = `http://localhost:${PORT}`;
const NODE = 'https://node.zetaphy.test';
const dir = mkdtempSync(join(tmpdir(), 'zetaphy-explorer2-'));
const chain = buildChain();
const PNG = readFileSync(new URL('../icon-192.png', import.meta.url));
let server; let browser;
const cfg = join(dir, 'config.json');

async function startServer() {
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url), env: { ...process.env, EXPLORER_CONFIG: cfg } });
  await new Promise((r, j) => { server.stdout.once('data', r); server.once('exit', (c) => j(new Error(`serve.js exited (${c}): port ${PORT} in use? Set E2E2_PORT.`))); });
}

before(async () => {
  writeFileSync(cfg, JSON.stringify({ node: NODE, threatRegistry: REGISTRY, chainStatsUrl: '', scanBlocks: 100 }));
  await startServer();
  try { browser = await chromium.launch({ headless: true }); } catch {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
});
after(async () => { server?.kill(); await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function openPage({ viewport, lang = 'en', serviceWorkers = 'block' } = {}) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1280, height: 900 }, serviceWorkers });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  // the node's websockets (live feed) are refused: the app falls back to polling, nothing reaches the network
  await ctx.routeWebSocket(/^wss:\/\/node\.zetaphy\.test\//, (sock) => sock.close());
  await ctx.route((url) => url.host === 'ipfs.io', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (IPFS_FILES[p]) return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: IPFS_FILES[p] });
    if (p.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG });
    return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  });
  await ctx.route((url) => url.host === 'node.zetaphy.test', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
    if (url.pathname.startsWith('/rest/')) {
      const body = chain.rest(url.pathname.slice(5) + url.search);
      return body ? json(200, body) : json(501, { code: 12, message: 'Not Implemented' });
    }
    const body = JSON.parse(req.postData() ?? '{}');
    const handler = url.pathname.startsWith('/rpc/') ? chain.comet : url.pathname === '/' ? chain.evmRpc : null;
    if (!handler) return json(404, { error: 'not found' });
    const answer = ({ id, method, params }) => {
      try { return { jsonrpc: '2.0', id, result: handler(method, params) }; } catch (e) { return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } }; }
    };
    // JSON-RPC batches (the risk badges ask many addresses in one request)
    return json(200, Array.isArray(body) ? body.map(answer) : answer(body));
  });
  await page.addInitScript((l) => { try { localStorage.setItem('zetaphy-explorer:lang', l); } catch { /* none */ } }, lang);
  return { page, ctx, problems };
}

const text = (page) => page.locator('main').innerText();
const go = (page, hash) => page.goto(`${ORIGIN}/${hash}`);
async function waitText(page, s, timeout = 20000) {
  try { await page.waitForFunction((x) => document.querySelector('main')?.innerText.includes(x), s, { timeout }); } catch {
    throw new Error(`"${s}" never appeared on ${page.url()}; the page shows:\n${(await text(page).catch(() => '?')).slice(0, 3000)}`);
  }
}

test('validators list: Nakamoto coefficient, uptime column from commit signatures, filter and sort', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/validators');
  await waitText(page, 'Uptime from the commit signatures of 29 blocks (1–29)');
  const t = await text(page);
  assert.match(t, /Nakamoto coefficient\s+1\b/);
  assert.match(t, /100\.00%/); // Alpha
  assert.match(t, /82\.76%/); // Beta: 24 of 29
  assert.match(t, /Registered\s+since block 1/);
  await page.fill('.v2-filter', 'beta');
  assert.equal(await page.locator('table.v2-table tbody tr').count(), 1);
  await page.fill('.v2-filter', '');
  await page.click('button.th-sort[data-sort="uptime"]'); // descending: Alpha first
  assert.match(await page.locator('table.v2-table tbody tr').first().innerText(), /Alpha/);
  await page.click('button.th-sort[data-sort="uptime"]'); // ascending
  assert.match(await page.locator('table.v2-table tbody tr').first().innerText(), /Beta/);
  // a validator's name opens its page; the search box takes a valoper too
  await page.click(`a[href="#/validator/${chain.vals[1].operator}"]`);
  await page.waitForURL(new RegExp(`#/validator/${chain.vals[1].operator}$`));
  await page.fill('#search', chain.vals[0].operator); await page.press('#search', 'Enter');
  await page.waitForURL(new RegExp(`#/validator/${chain.vals[0].operator}$`));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('validator page: uptime, missed-blocks strip, slashing record, self-bond, delegators, commission changes, PQ key and certificate inclusion', async () => {
  const { page, ctx, problems } = await openPage();
  const beta = chain.vals[1];
  await go(page, `#/validator/${beta.operator}`);
  await waitText(page, 'Uptime from the commit signatures');
  await waitText(page, 'missing_signature');
  await waitText(page, 'Delegators');
  let t = await text(page);
  assert.match(t, /Beta Node/); assert.ok(!t.includes('‮'));
  assert.match(t, /Uptime\s+82\.76%/);
  assert.match(t, /Missed\s+5\b/);
  assert.equal(await page.locator('svg.heat-strip rect').count(), 29);
  assert.equal(await page.locator('svg.heat-strip rect.hs-missed').count(), 5);
  assert.match(t, /Missed in the slashing window\s+5 \/ 100/);
  assert.match(t, /Must sign at least\s+50\.00%/);
  assert.match(t, new RegExp(chain.valconsOf(beta)));
  await waitText(page, '1,000 ZETAPHY'); // self-bond
  await page.waitForFunction(() => /Delegators\s+7/.test(document.querySelector('main').innerText));
  t = await text(page);
  assert.match(t, /Delegators\s+7/);
  assert.match(t, /Not registered/);
  assert.match(t, /Signature in block certificates\s+0 \/ 28/);
  await waitText(page, 'From MsgEditValidator');
  assert.match(await page.locator('main').innerText(), /15\s+5\.00%/); // the commission change at block 15
  assert.match(await text(page), /Commission\s+5\.00%\s*· max 20\.00% · max change\/day 1\.00%/);
  assert.equal(await page.locator('main a[href^="javascript"]').count(), 0); // its website is javascript:, not linked
  // Alpha: key registered, in every certificate
  await go(page, `#/validator/${chain.vals[0].operator}`);
  await waitText(page, '28 / 28 (100.0%)');
  await waitText(page, 'No slash events found.');
  await page.waitForFunction(() => /Delegators\s+42/.test(document.querySelector('main').innerText));
  t = await text(page);
  assert.match(t, /Registered since block 1/);
  assert.match(t, /Delegators\s+42/);
  assert.match(t, /No slash events found\./);
  assert.equal(await page.locator('main a[href="https://alpha.example/"]').count(), 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('governance: list, proposal with live tally, countdown, decoded messages, paginated votes, deposits, hub link', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/gov');
  await waitText(page, 'Send 5,000 ZETAPHY from the community pool');
  let t = await text(page);
  assert.match(t, /<b>Turn on<\/b> PQ evidence/); // as text
  assert.match(t, /Voting/); assert.match(t, /Passed/);
  assert.match(t, /Yes 98\.4% · No 1\.6%/);
  assert.equal(await page.locator('main a[href="https://app.sawasdeecoin.com/?tab=gov"]').count(), 1);
  await page.click('a[href="#/gov/2"] >> nth=1');
  await waitText(page, 'Tally so far');
  await waitText(page, 'MsgSend');
  t = await text(page);
  assert.match(t, /Yes 66\.66%/); assert.match(t, /No 22\.22%/); assert.match(t, /Abstain 11\.11%/);
  assert.match(t, /Turnout \(of bonded\)\s+45\.00%\s+quorum reached/);
  assert.match(t, /yes is 75\.00% of non-abstain votes/);
  assert.match(t, /If it ended now\s+would pass/);
  assert.match(t, /Quorum\s+33\.40%/);
  assert.match(t, /2 d 2 h \d+ min \d+ s left/);
  assert.match(t, /10,000 ZETAPHY · minimum 10,000 ZETAPHY/);
  assert.match(t, /Fund the explorer work\./); assert.ok(!t.includes('‮'));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  // the message, from the protobuf proposal (the explorer's decoder): a MsgSend to ME
  assert.ok(await page.locator(`main .msg a[href="#/address/${ME_HEX}"]`).count() >= 1);
  assert.match(t, /5,000 ZETAPHY/);
  // votes: 2, then the next page
  await waitText(page, '2 of 3 votes shown');
  assert.equal(await page.locator('main table').filter({ hasText: 'Voter' }).locator('tbody tr').count(), 2);
  await page.click('text=More votes');
  await waitText(page, 'Yes ×0.7, Abstain ×0.3');
  assert.equal(await page.locator('main table').filter({ hasText: 'Voter' }).locator('tbody tr').count(), 3);
  // the countdown ticks
  const c1 = await page.locator('.countdown').innerText();
  await page.waitForTimeout(1300);
  assert.notEqual(await page.locator('.countdown').innerText(), c1);
  // a passed proposal whose protobuf the node refuses: shown from the REST JSON
  await go(page, '#/gov/1');
  await waitText(page, 'Shown from the node');
  t = await text(page);
  assert.match(t, /MsgSetPQEvidence/); assert.match(t, /authority/);
  assert.match(t, /Yes 98\.36%/);
  await go(page, '#/gov/99');
  await waitText(page, 'Error');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('token holders: rebuilt from Transfer logs, confirmed with balanceOf, concentration and the owner flag', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, `#/token/${TOKEN}`);
  await waitText(page, 'Top holders and distribution');
  await page.click(`a[href="#/token/${TOKEN}/holders"]`);
  await waitText(page, 'Top 10 hold');
  const t = await text(page);
  assert.match(t, /Window: from block 1 to 30 \(3 transfers\)/);
  assert.match(t, /Concentration: the owner holds at least half of the supply\./);
  assert.match(t, /Top 10 hold\s+90\.00%/);
  assert.match(t, /899,900\s+89\.99%/);
  assert.match(t, /98\.5\s+0\.00%/);
  assert.equal(await page.locator('main table tbody tr').count(), 3);
  assert.ok(await page.locator(`main a[href="#/address/${getAddress(TOKEN_OWNER)}"]`).count() >= 1);
  assert.equal(await page.locator('.dist-bar .dist-seg').count(), 3);
  // an NFT has no holder list; it points to the gallery
  await go(page, `#/token/${NFT}/holders`);
  await waitText(page, 'Holder lists are for ERC-20 tokens');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('NFT gallery and items: metadata as text only, ipfs via the gateway, SVG only through <img>, owner and transfers', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, `#/token/${NFT}`);
  await waitText(page, 'Open the NFT gallery');
  await go(page, `#/nft/${NFT}`);
  await waitText(page, 'Siam Temple #7');
  await waitText(page, 'Siam Art #8');
  await waitText(page, 'Token ids from Transfer logs');
  assert.equal(await page.locator('.nft-grid a.nft-link').count(), 2);
  assert.equal(await page.locator('.nft-grid img[src="https://ipfs.io/ipfs/bafyimg7/7.png"]').count(), 1);
  // item 7: data: JSON metadata, image on IPFS
  await page.click(`a[href="#/nft/${NFT}/7"]`);
  await waitText(page, 'Sunrise over Wat Arun');
  let t = await text(page);
  assert.match(t, /Owner\s+0x6DA134EbFcb035273E87954f0641bD920ED073Ba/);
  assert.match(t, /Colour\s+Gold/); assert.match(t, /Rarity\s+Rare/);
  assert.ok(!/<script|<b>|<i>/i.test(t), 'tags never shown or parsed');
  const img = page.locator('.nft-hero img');
  assert.equal(await img.getAttribute('src'), 'https://ipfs.io/ipfs/bafyimg7/7.png');
  await page.waitForFunction(() => document.querySelector('.nft-hero img')?.naturalWidth > 0);
  assert.equal(await page.locator('main a[href^="javascript"]').count(), 0);
  await waitText(page, 'mint');
  // item 8: ipfs:// metadata fetched through the gateway, an SVG with scripts shown as an <img> (inert)
  await go(page, `#/nft/${NFT}/8`);
  await waitText(page, 'A gold square.');
  t = await text(page);
  assert.match(t, new RegExp(chain.evmWallet.address));
  assert.match(await page.locator('.nft-hero img').getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  await page.waitForFunction(() => document.querySelector('.nft-hero img')?.complete);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('main svg').count(), 0, 'never inline SVG');
  assert.equal(await page.locator('main a[href="https://siam.art/8"]').count(), 1);
  // not an NFT / bad id
  await go(page, `#/nft/${TOKEN}`);
  await waitText(page, 'does not say it is an ERC-721');
  await go(page, `#/nft/${NFT}/abc`);
  await waitText(page, 'Not a token id');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('gas: base fee, slow / normal / fast from eth_feeHistory, costs of common actions, burned fees', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/gas');
  await waitText(page, 'What things cost now');
  const hist = chain.evmRpc('eth_feeHistory', ['0x14', 'latest', [10, 50, 90]]);
  const f = feeSuggestions(hist);
  const t = await text(page);
  assert.match(t, new RegExp(`Base fee \\(next block\\)\\s+${gwei(f.baseFee).replace('.', '\\.')}`, 'i')); // the label is upper-cased by CSS
  for (const sp of ['slow', 'normal', 'fast']) assert.ok(t.includes(gwei(f[sp].price)), sp);
  assert.match(t, /Send ZETAPHY\s+21,000/);
  assert.match(t, /Mint an NFT\s+120,000/);
  assert.ok(t.includes(formatZtphy(burnedEstimate(hist, 30000000n), { maxFrac: 8 })));
  await page.selectOption('main select', '50');
  await waitText(page, 'Base fee burned');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('tools: decode + recover + dry run a signed tx, broadcast only after two confirmations, personal_sign, ML-DSA-44, converters', async () => {
  const { page, ctx, problems } = await openPage();
  await go(page, '#/tools');
  await waitText(page, 'Decode a signed transaction');
  const w = new Wallet('0x' + '42'.repeat(32));
  const raw = await w.signTransaction({ type: 2, chainId: 77390, nonce: 3, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, gasLimit: 21000n, to: '0x' + '11'.repeat(20), value: 10n ** 18n });
  await page.fill('#tl-raw', raw);
  assert.equal(await page.locator('#tl-send').isDisabled(), true);
  await page.click('#tl-decode');
  await waitText(page, 'would succeed');
  const t = await text(page);
  assert.equal(await page.locator('.tl-from').innerText(), w.address);
  assert.match(t, /EIP-1559/); assert.match(t, /Chain id\s+77390/); assert.match(t, /1 ZETAPHY/);
  // broadcast: needs the box ticked, then two clicks
  assert.equal(await page.locator('#tl-send').isDisabled(), true);
  await page.check('#tl-ack');
  await page.click('#tl-send');
  assert.equal(await page.locator('#tl-send').innerText(), 'Click again to send');
  assert.equal(chain.sent.length, 0);
  await page.click('#tl-send');
  await waitText(page, 'Sent:');
  assert.deepEqual(chain.sent, [raw]);
  // a tx for another chain cannot be broadcast here
  await page.fill('#tl-raw', await w.signTransaction({ type: 2, chainId: 1, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 21000n, to: ME_HEX }));
  await page.click('#tl-decode');
  await waitText(page, 'not ZETAPHY (77390)');
  await page.check('#tl-ack');
  assert.equal(await page.locator('#tl-send').isDisabled(), true);
  await page.fill('#tl-raw', '0x1234');
  await page.click('#tl-decode');
  await waitText(page, 'Could not decode');
  // personal_sign
  await page.fill('#tl-msg', 'hello ZETAPHY');
  await page.fill('#tl-sig', await w.signMessage('hello ZETAPHY'));
  await page.fill('#tl-signer', w.address);
  await page.click('#tl-verify');
  await waitText(page, 'matches');
  assert.equal(await page.locator('.tl-signed-by').innerText(), w.address);
  // ML-DSA-44
  const kp = ml_dsa44.keygen(new Uint8Array(32).fill(9));
  const sig = ml_dsa44.sign(new TextEncoder().encode('block 7'), kp.secretKey);
  await page.fill('#tl-pq-pk', '0x' + bytesToHex(kp.publicKey));
  await page.fill('#tl-pq-msg', 'block 7');
  await page.fill('#tl-pq-sig', '0x' + bytesToHex(sig));
  await page.click('#tl-pq-verify');
  await waitText(page, 'valid signature');
  await page.fill('#tl-pq-msg', 'block 8');
  await page.click('#tl-pq-verify');
  await waitText(page, 'NOT a valid signature');
  // converters
  await page.fill('#tl-amount', '1.5');
  await waitText(page, '1,500,000,000');
  await page.fill('#tl-addr', ME);
  await waitText(page, ME_HEX);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('PWA: manifest, service worker caches the app shell only (never node answers), offline page', async () => {
  const res = await (await fetch(`${ORIGIN}/manifest.webmanifest`));
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal((await res.json()).short_name, 'ZETAPHY');
  const { page, ctx, problems } = await openPage({ serviceWorkers: 'allow' });
  await go(page, '#/');
  await waitText(page, 'Latest blocks');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled
  await waitText(page, 'Latest blocks');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  assert.ok(cached.some((u) => u.endsWith('/src/app.js')), cached.join());
  assert.ok(cached.every((u) => u.startsWith(ORIGIN)), 'only this site');
  assert.ok(!cached.some((u) => /config\.json|node\.zetaphy\.test|\/rpc\/|\/rest\//.test(u)), cached.join());
  // offline (the site cannot be reached): a page load gets the offline page from the cache
  const exited = new Promise((r) => server.once('exit', r));
  server.kill(); await exited;
  try {
    await page.goto(`${ORIGIN}/?x=1`).catch(() => {});
    await page.waitForSelector('text=You are offline', { timeout: 10000 });
  } finally { await startServer(); }
  assert.deepEqual(problems.filter((p) => !/net::ERR_INTERNET_DISCONNECTED|Failed to fetch|cannot reach/.test(p)), []);
  await ctx.close();
});

test('phone width: the new pages do not scroll sideways; Thai texts', async () => {
  const { page, ctx, problems } = await openPage({ viewport: { width: 375, height: 800 }, lang: 'th' });
  for (const [h, s] of [['#/validators', 'ค่า Nakamoto'], [`#/validator/${chain.vals[1].operator}`, 'อัปไทม์'], ['#/gov/2', 'ผลคะแนนตอนนี้'], [`#/token/${TOKEN}/holders`, '10 อันดับแรกถือ'],
    [`#/nft/${NFT}/7`, 'Sunrise over Wat Arun'], ['#/gas', 'ค่าใช้จ่ายตอนนี้'], ['#/tools', 'ถอดรหัสธุรกรรมที่ลงนามแล้ว']]) {
    await go(page, h);
    await waitText(page, s);
    await page.waitForTimeout(400);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw + 1, `${h}: page is ${sw}px wide on a ${iw}px screen`);
  }
  assert.equal(await page.locator('.nav a[href="#/gov"]').innerText(), 'ธรรมาภิบาล');
  assert.deepEqual(problems, []);
  await ctx.close();
});
