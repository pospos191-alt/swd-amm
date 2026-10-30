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
import { createServer } from 'node:net';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { getAddress } from 'ethers';
import { T, LANGS } from '../src/i18n.js';
import { buildChain, CHAIN_ID, LATEST, ME, ME_HEX, LOCKED, LOCKED_HEX, TOKEN, NFT, REGISTRY, AUDIT_CERT, REPORT, RESPONSE_TEXT, ROUTER, PROXY, FACTORY, DEPLOYER, MAILBOX, SEPOLIA_DELIVERY_TX,
  BUSY, BUSY_HEX, BUSY_TXS, FLOW_HEX } from './mock-chain.js';

// Free ports (other checkouts may run these tests at the same time), or E2E_PORT and E2E_PORT + 1
// (EXPLORER_E2E_PORT is read too, as an older name of E2E_PORT).
const freePort = () => new Promise((r) => { const sv = createServer().listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => r(port)); }); });
const FIXED_PORT = Number(process.env.E2E_PORT ?? process.env.EXPLORER_E2E_PORT);
const PORT = FIXED_PORT || await freePort();
const PORT_DEFAULT = FIXED_PORT ? PORT + 1 : await freePort();
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
  writeFileSync(cfg, JSON.stringify({ node: NODE, threatRegistry: REGISTRY, auditCertificate: AUDIT_CERT, neuroReportUrl: NEURO, chainStatsUrl: 'https://stats.zetaphy.test/api/chain-stats', scanBlocks: 100 }));
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
const XC_HOSTS = new Set(Object.values(JSON.parse(readFileSync(new URL('../crosschain.json', import.meta.url), 'utf8')).chains).flatMap((c) => c.rpc.map((u) => new URL(u).host)));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

/** A page with the mock node behind https://node.zetaphy.test (and other.zetaphy.test); records problems. */
/** lang: the stored language preference ('th' unless set; null for none). */
/** ws: 'comet' answers the CometBFT websocket (NewBlock pushed by the test with push(H)); 'refuse' closes every socket (polling). */
async function openPage({ viewport, lang = 'th', origin = ORIGIN, ws = 'comet' } = {}) {
  // service workers blocked: the PWA has its own test (explore2.e2e.js)
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const problems = []; const mine = {};
  // The node's websockets (wss://<node>/rpc/websocket and /ws), mocked: no network.
  const sockets = []; const wsUrls = [];
  await ctx.routeWebSocket(/^wss:\/\/(node|other)\.zetaphy\.test\//, (sock) => {
    wsUrls.push(sock.url());
    if (ws === 'refuse' || !sock.url().endsWith('/rpc/websocket')) { sock.close(); return; }
    sock.onMessage((m) => {
      let j; try { j = JSON.parse(String(m)); } catch { return; }
      if (j.method === 'subscribe' && j.params?.query === "tm.event='NewBlock'") { sock.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: {} })); sockets.push({ sock, id: j.id }); }
    });
  });
  const push = (H) => { for (const s of sockets) s.sock.send(JSON.stringify(chain.newBlockEvent(H, s.id))); return sockets.length; };
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/node\.zetaphy\.test|other\.zetaphy\.test/.test(r.url())) problems.push(`requestfailed: ${r.url()}`); });
  // Other chains' public RPCs (crosschain.json): never reached from the tests; a test that needs one routes it itself
  await ctx.route((url) => XC_HOSTS.has(url.host), (route) => route.fulfill({ status: 503, headers: CORS, body: 'offline in tests' }));
  // Neuro's chain activity counts (/api/chain-stats)
  // Sourcify's v2 API (the router is verified there; anything else: 404)
  await ctx.route((url) => url.host === 'sourcify.dev', (route) => {
    const m = /^\/server\/v2\/contract\/77390\/(0x[0-9a-fA-F]{40})$/.exec(new URL(route.request().url()).pathname);
    const body = m ? chain.sourcify(m[1]) : null;
    mine.sourcify = (mine.sourcify ?? 0) + 1;
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', headers: CORS, body: JSON.stringify(body ?? { customCode: 'not_found', message: 'Contract not found' }) });
  });
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
    const body = JSON.parse(req.postData() ?? '{}');
    for (const c of [body].flat()) mine[`${url.pathname.startsWith('/rpc/') ? 'comet' : 'evm'}:${c?.method}`] = (mine[`${url.pathname.startsWith('/rpc/') ? 'comet' : 'evm'}:${c?.method}`] ?? 0) + 1; // per method
    const handler = url.pathname.startsWith('/rpc/') ? chain.comet : url.pathname === '/' ? chain.evmRpc : null;
    if (!handler) return json(404, { error: 'not found' });
    const answer = ({ id, method, params }) => {
      try { return { jsonrpc: '2.0', id, result: handler(method, params) }; } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message, data: url.pathname.startsWith('/rpc/') ? e.message : e.data } };
      }
    };
    // JSON-RPC batches (the risk badges ask many addresses in one request)
    return json(200, Array.isArray(body) ? body.map(answer) : answer(body));
  });
  // lang: null leaves storage empty (a first visit: English by default).
  if (lang) await page.addInitScript((l) => { try { localStorage.setItem('zetaphy-explorer:lang', l); } catch { /* none */ } }, lang);
  return { page, ctx, problems, counts: mine, push, sockets, wsUrls };
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
  // the deep view: summary, guessed decode of the input, ThreatRegistry flag on the callee, gas and the burned half
  await waitText(page, 'sent 1.5 SWD to');
  await waitText(page, 'is flagged in ThreatRegistry');
  await waitText(page, 'Burned');
  const d = await text(page);
  assert.match(d, /transfer\(address to, uint256 \w+\)/); assert.match(d, /Guessed/);
  assert.match(d, /Automated code analysis, not an accusation/);
  assert.match(d, /61,234 \/ 150,000 \(40\.82%\)/);
  assert.match(d, /0\.0000459255 ZETAPHY/); // half of 61,234 × 1.5 gwei
  assert.match(d, /0\.5 gwei/); // the block's base fee
  assert.match(d, /Internal calls/);
  // the block's list links the EVM hash (keccak of the raw tx), not the CometBFT hash
  await go(page, '#/block/22');
  await waitText(page, 'MsgEthereumTx');
  assert.ok(await page.locator(`main a[href="#/tx/${chain.evmTxHash}"]`).count() === 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('EVM tx deep view: swap summary, verified decode, call tree, who gained / who lost; custom error; no traces said plainly', async () => {
  const { page, ctx, problems, counts: mine } = await openPage({ lang: 'en' });
  await go(page, `#/tx/${chain.deep.swapHash}`);
  await waitText(page, 'swapped 10 ZETAPHY for 1,234 SWD on ZetaphyRouter');
  await waitText(page, 'Internal ZETAPHY transfers');
  await waitText(page, '+1,234');
  const t = await text(page);
  assert.match(t, /swapExactETHForTokens\(uint256 amountOutMin, address\[\] path, address to, uint256 deadline\)/);
  assert.match(t, /Verified/);
  assert.match(t, /STATICCALL/); assert.match(t, /execution reverted/); // the reverted inner call
  assert.match(t, /−10\.00018 ZETAPHY/); // the sender's ZETAPHY (value + fee), from the prestate diff
  assert.match(t, /prestate trace/);
  assert.ok(await page.locator('.calltree .call').count() >= 6, 'one row per call');
  assert.ok(await page.locator('.calltree .call[data-depth="2"]').count() >= 2, 'nested calls');
  assert.ok(mine.sourcify >= 1, 'Sourcify asked');
  // a failed swap: the router's custom error from the trace
  await go(page, `#/tx/${chain.deep.failHash}`);
  await waitText(page, 'Why it failed');
  await waitText(page, 'Expired');
  await waitText(page, 'and it failed');
  const f = await text(page);
  assert.match(f, /called swapExactETHForTokens on/); assert.match(f, /Custom error/); assert.match(f, /From the node's trace/);
  // an unlimited approval on a node without traces: flagged, and the missing traces said plainly
  await go(page, `#/tx/${chain.deep.approveHash}`);
  await waitText(page, 'Unlimited approval');
  await waitText(page, 'This node does not expose traces');
  const a = await text(page);
  assert.match(a, /approved .* to spend an UNLIMITED amount of SWD/);
  assert.match(a, /approve\(address spender, uint256 value\)/);
  assert.match(a, /Approval/); // the log decoded too
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('contract page: Sourcify source and creator, Read contract, proxy to its implementation, Write through the wallet', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  // a stand-in for MetaMask: records what it is asked to send
  await page.addInitScript(([from]) => {
    window.__sent = [];
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [from];
      if (method === 'eth_chainId') return '0x12e4e';
      if (method === 'eth_sendTransaction') { window.__sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
      throw new Error(`unsupported ${method}`);
    } };
  }, [chain.evmWallet.address]);
  await go(page, `#/address/${ROUTER}`);
  await waitText(page, 'Verified · full match');
  await waitText(page, 'contracts/ZetaphyRouter.sol');
  let t = await text(page);
  assert.match(t, /ZetaphyRouter/); assert.match(t, /0\.8\.28\+commit\.7893614a/);
  assert.ok(await page.locator(`main a[href="#/address/${getAddress(DEPLOYER)}"]`).count() >= 1, 'creator linked');
  assert.ok(await page.locator(`main a[href="#/tx/0x${'de'.repeat(32)}"]`).count() >= 1, 'creation tx linked');
  assert.match(await page.locator('pre.source').innerText(), /<script>window\.__pwned=2<\/script>/); // shown as text
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  // Read: zero-argument views are read at once, others on demand
  await page.click('.tabs [data-tab="read"]');
  await page.waitForSelector(`details.fn[data-fn="factory"] .fn-out a[href="#/address/${getAddress(FACTORY)}"]`);
  const amountOut = page.locator('details.fn[data-fn="getAmountOut"]');
  await amountOut.locator('summary').click();
  await amountOut.locator('input[name="a0"]').fill('1000');
  await amountOut.locator('input[name="a1"]').fill('5000');
  await amountOut.locator('input[name="a2"]').fill('7000');
  await amountOut.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('details.fn[data-fn="getAmountOut"] .fn-out')?.innerText.includes('997'));
  // a bad input is refused before anything is sent
  await amountOut.locator('input[name="a0"]').fill('-1');
  await amountOut.locator('button[type="submit"]').click();
  await page.waitForFunction(() => /out of range|whole number/.test(document.querySelector('details.fn[data-fn="getAmountOut"] .fn-out')?.innerText ?? ''));
  // Write: through the injected wallet, after the chain check and the wallet-safety summary
  await page.click('.tabs [data-tab="write"]');
  const sweep = page.locator('details.fn[data-fn="sweep"]');
  await sweep.locator('summary').click();
  await sweep.locator('input[name="a0"]').fill(ME);
  await sweep.locator('button[type="submit"]').click();
  await page.waitForSelector('#ws-confirm[open]');
  assert.match(await page.locator('#ws-confirm').innerText(), /ZETAPHY \(77390\)/);
  await page.click('#ws-confirm [data-ws="go"]');
  await page.waitForFunction(() => document.querySelector('details.fn[data-fn="sweep"] .fn-out')?.innerText.includes('Sent'));
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ROUTER.toLowerCase());
  assert.equal(sent[0].data, '0x01681a62' + ME_HEX.slice(2).toLowerCase().padStart(64, '0')); // sweep(address)
  assert.equal(sent[0].chainId, '0x12e4e');
  // an EIP-1967 proxy: its implementation linked, its ABI used
  await go(page, `#/address/${PROXY}`);
  await waitText(page, 'EIP-1967 proxy');
  t = await text(page);
  assert.match(t, /This proxy itself is not verified/);
  assert.ok(await page.locator(`main .contract a[href="#/address/${ROUTER}"]`).count() >= 1, 'implementation linked');
  await page.click('.tabs [data-tab="read"]');
  await page.waitForSelector(`details.fn[data-fn="factory"] .fn-out a[href="#/address/${getAddress(FACTORY)}"]`);
  assert.match(await text(page), /via the proxy's implementation/);
  // a token that is not verified: said so
  await go(page, `#/token/${TOKEN}`);
  await waitText(page, 'Not verified');
  // its ZETAPHY audit certificate (AuditCertificate.certificate): a badge with the level, and the limits in the hover text
  await page.waitForSelector('h1 .audit-badge');
  assert.match(await page.locator('h1 .audit-badge').innerText(), /Audited \(ZETAPHY\) · Gold · until/);
  assert.match(await page.locator('h1 .audit-badge').getAttribute('title'), /Not a guarantee/);
  await go(page, `#/address/${TOKEN}`);
  await page.waitForSelector('.audit-badge');
  await go(page, `#/address/${ROUTER}`);
  await waitText(page, 'Contract');
  assert.equal(await page.locator('.audit-badge').count(), 0, 'no certificate: no badge');
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
  assert.match(t, /MsgSend/); // this address's history from the node's tx index (all heights)
  assert.match(t, /Full history · node transaction index/);
  assert.match(t, /2 transactions total/); // blocks 20 and 24 (message.sender); the EVM tx is from another address
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
  await waitText(page, 'ติดธงโดยผู้รัน Neuro'); // the full ThreatRegistry card (the risk summary may show the disclaimer first)
  await waitText(page, 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา');
  const t = await text(page);
  assert.match(t, /<img src=x onerror="window\.__pwned=1">Sawasdeetx/); // as text, bidi override removed
  assert.ok(!t.includes('\u202E') && !t.includes('\u200B'));
  assert.equal(await page.locator('main img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(t, /1,000,000 SWD/);
  assert.match(t, /ERC-20/);
  // the overview and the risk summary both link the Neuro report
  for (const href of await page.locator('main a[target="_blank"]').evaluateAll((as) => as.map((x) => x.getAttribute('href')))) assert.equal(href, NEURO.replace('{address}', TOKEN));
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
  for (const h of ['#/', '#/block/20', `#/tx/${chain.evmTxHash}`, `#/tx/${chain.deep.swapHash}`, `#/address/${ME}`, `#/address/${ROUTER}`, '#/validators']) {
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
  // no node in that config: no wss:// source either
  assert.match(res.headers()['content-security-policy'], /connect-src 'self' https: https:\/\/ipfs\.io;/);
  const live = await page.request.get(`${ORIGIN}/`);
  assert.match(live.headers()['content-security-policy'], /connect-src 'self' https: https:\/\/ipfs\.io wss:\/\/node\.zetaphy\.test;/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

// ---- history, live view, watch list, analytics (src/history.js, live.js, watch.js, charts.js) ----

test('address history: tx_search over all heights, paged and merged, load more, filters, CSV; token transfers tab', async () => {
  const { page, ctx, problems, counts: mine } = await openPage({ lang: 'en' });
  await go(page, `#/address/${BUSY}`);
  await waitText(page, 'Full history · node transaction index');
  await page.waitForFunction(() => document.querySelectorAll('.hist-list tbody tr').length === 25);
  const rows = () => page.locator('.hist-list tbody tr').count();
  assert.match(await page.locator('#hist-total').innerText(), /57–114 transactions total/); // two queries see the same 57 txs
  const before = mine[NODE]; const snap = { ...mine };
  await page.click('#hist-more');
  await page.waitForFunction(() => document.querySelectorAll('.hist-list tbody tr').length === 50);
  await page.click('#hist-more');
  await page.waitForFunction(() => document.querySelectorAll('.hist-list tbody tr').length === 57);
  // the history's own requests (CometBFT tx_search pages) stay at most 6; the rest are the Neuro risk
  // badges of the new rows' addresses, batched: at most 2 requests (code, flags) per load
  const delta = Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v - (snap[k] ?? 0)]).filter(([, v]) => v));
  const cometReq = Object.entries(delta).filter(([k]) => k.startsWith('comet:')).reduce((n, [, v]) => n + v, 0);
  assert.ok(cometReq <= 6, `load more used ${cometReq} history requests ${JSON.stringify(delta)}`);
  assert.ok(Object.keys(delta).every((k) => k === NODE || k.startsWith('comet:') || k === 'evm:eth_getCode' || k === 'evm:eth_call'), JSON.stringify(delta));
  assert.ok(mine[NODE] - before - cometReq <= 4, `load more used ${mine[NODE] - before} requests ${JSON.stringify(delta)}`);
  assert.equal(await page.locator('#hist-total').innerText(), `${BUSY_TXS} transactions total`);
  assert.ok(await page.locator('#hist-more').isHidden(), 'nothing more to load');
  // newest first, no duplicates
  const heights = await page.locator('.hist-list tbody tr td:nth-child(3)').allInnerTexts();
  assert.deepEqual(heights, [...heights].sort((a, b) => Number(b) - Number(a)));
  const hashes = await page.locator('.hist-list tbody tr').evaluateAll((trs) => trs.map((tr) => tr.dataset.hash));
  assert.equal(new Set(hashes).size, BUSY_TXS);
  const txt = await text(page);
  assert.match(txt, /MsgSend/); assert.match(txt, /\bout\b/); assert.match(txt, /Showing 57 of 57 loaded/);
  // filters work on what is loaded
  await page.selectOption('#hist-dir', 'in');
  await waitText(page, 'No loaded transaction matches these filters.');
  await page.selectOption('#hist-dir', 'out');
  await page.selectOption('#hist-kind', 'transfer');
  assert.equal(await rows(), 57);
  await page.selectOption('#hist-kind', 'staking');
  assert.equal(await rows(), 0);
  await page.selectOption('#hist-kind', 'all');
  // CSV of what is loaded, made in the browser (Blob download)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#hist-csv')]);
  assert.match(dl.suggestedFilename(), /^zetaphy-0xb5b5.*-transactions\.csv$/i);
  const csv = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'tx_hash,cometbft_hash,height,index,kind,direction,type,from,to,value_ZETAPHY,status,code');
  assert.equal(lines.length, 1 + BUSY_TXS);
  assert.match(lines[1], new RegExp(`,19,3,transfer,out,MsgSend,${BUSY},${LOCKED},0\\.000000000000001002,success,0$`));
  // token transfers tab: eth_getLogs (topic 1 / topic 2, ERC-1155) in 500-block windows
  await go(page, `#/address/${ME}`);
  await waitText(page, '2 transactions total');
  await page.click('#hist-tab-tokens');
  await page.waitForSelector('#hist-panel-tokens:not([hidden])');
  await waitText(page, 'Every block scanned: 3 token transfers.');
  const tok = await page.locator('#hist-panel-tokens').innerText();
  assert.match(tok, /ERC-20/); assert.match(tok, /ERC-721/); assert.match(tok, /ERC-1155/); assert.match(tok, /\bin\b/);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#tok-csv')]);
  assert.equal(readFileSync(await dl2.path(), 'utf8').replace(/^﻿/, '').trim().split('\r\n').length, 4);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('address history: a node that refuses event queries falls back to the block scan and says so', async () => {
  chain.state.noEventIndex = true;
  try {
    const { page, ctx, problems } = await openPage({ lang: 'en' });
    await go(page, `#/address/${ME}`);
    await waitText(page, 'Recent blocks only · scan');
    await waitText(page, 'MsgSetPQEvidence');
    assert.match(await text(page), /refused event queries/);
    assert.ok(await page.locator('#hist-more').isHidden());
    assert.deepEqual(problems, []);
    await ctx.close();
  } finally { chain.state.noEventIndex = false; }
});

test('analytics on the home page: inline SVG charts with labels and data tables, under the CSP', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, '#/');
  await page.waitForSelector('#chart-txs svg rect', { state: 'attached' });
  for (const id of ['chart-txs', 'chart-time', 'chart-gas', 'chart-fee', 'chart-top']) {
    assert.equal(await page.locator(`#${id} svg[role="img"]`).count(), 1, id);
  }
  assert.match(await page.locator('#chart-txs svg > title').textContent(), /^Transactions per block, blocks 1 to 30: min 0, max 1/);
  assert.match(await page.locator('#chart-time svg > title').textContent(), /average 5 s$/);
  assert.equal(await page.locator('#chart-txs svg > rect').count(), 30);
  await page.click('#chart-fee summary');
  assert.match(await page.locator('#chart-fee table').innerText(), /^Block\s+Base fee \(gwei\)/);
  assert.match(await page.locator('#chart-top').innerText(), /Most active addresses/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('main [style]').length), 0, 'no inline style attributes from the charts');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('watch list: nickname per browser, kept after a reload, shown on the home page and as the address label', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/address/${ME}`);
  await page.waitForSelector('#watch-name');
  await page.fill('#watch-name', 'My  wallet‮');
  await page.click('.watch-form button[type=submit]');
  await page.waitForSelector('.toast');
  assert.match(await page.locator('.toast').first().innerText(), /Watching My wallet/);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('zetaphy-explorer:watch')));
  assert.deepEqual(stored, [{ address: ME_HEX, name: 'My wallet' }]); // bidi override and double space removed
  await page.reload();
  await waitText(page, 'My wallet');
  assert.equal(await page.locator('.watch-form button[type=submit]').innerText(), 'Save nickname');
  await go(page, '#/');
  await waitText(page, 'Watched addresses');
  const card = await page.locator('section.card', { hasText: 'Watched addresses' }).innerText();
  assert.match(card, /My wallet/); assert.match(card, /MsgSetPQEvidence/);
  // a hand-edited value in storage cannot put anything odd on the page
  await page.evaluate(() => localStorage.setItem('zetaphy-explorer:watch', JSON.stringify([{ address: 'javascript:alert(1)', name: 'x' }, { address: '0x' + '11'.repeat(20), name: '<b>pal</b>' }, 7])));
  await page.reload();
  await waitText(page, '<b>pal</b>');
  assert.equal(await page.locator('main b').count(), 0);
  // a broken stored value: the page still works
  await page.evaluate(() => localStorage.setItem('zetaphy-explorer:watch', '{not json'));
  await page.reload();
  await waitText(page, 'Latest blocks');
  assert.deepEqual(problems, []);
  await ctx.close();
});

// These two make new blocks (31, 32, 33): they run last.
test('live: CometBFT websocket NewBlock, new rows animated, pending txs, watch a tx until it is confirmed, watched-address toast', async () => {
  const { page, ctx, problems, push, wsUrls } = await openPage({ lang: 'en' });
  await page.addInitScript((me) => { try { localStorage.setItem('zetaphy-explorer:watch', JSON.stringify([{ address: me, name: 'Mine' }])); } catch { /* none */ } }, ME_HEX);
  const pendingHash = chain.addPending();
  await go(page, '#/live');
  await page.waitForFunction(() => /CometBFT websocket/.test(document.getElementById('live-mode')?.innerText ?? ''));
  assert.deepEqual(wsUrls, ['wss://node.zetaphy.test/rpc/websocket']);
  await waitText(page, '1 transactions waiting');
  await waitText(page, 'MsgSend');
  await page.locator('section.card', { hasText: 'Pending transactions' }).locator('button').click();
  await page.waitForFunction(() => /Pending/.test([...document.querySelectorAll('section.card')].pop()?.innerText ?? ''));
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('zetaphy-explorer:watch-txs'))).map((e) => e.hash), [pendingHash]);
  // the block lands: pushed on the socket
  const H = chain.addBlock();
  assert.equal(push(H), 1);
  await page.waitForSelector(`.live-blocks li.row-new a[href="#/block/${H}"]`);
  await waitText(page, 'Confirmed');
  await waitText(page, '0 transactions waiting');
  await page.waitForFunction((h) => [...document.querySelectorAll('.toast')].some((x) => x.innerText.includes(`Mine is in block ${h}`)), H);
  assert.ok(await page.locator('.toast', { hasText: `Transaction confirmed in block ${H}` }).count() >= 1);
  // the home page follows the socket too: the new block row fades in
  await go(page, '#/');
  await waitText(page, 'Latest blocks');
  chain.addPending();
  const H2 = chain.addBlock();
  push(H2);
  await page.waitForSelector(`.card tr.row-new a[href="#/block/${H2}"]`);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('live: when the sockets fail, polling every 6 s still brings new blocks', async () => {
  const { page, ctx, problems, wsUrls } = await openPage({ lang: 'en', ws: 'refuse' });
  await go(page, '#/');
  await page.waitForFunction(() => /checking every 6 s/.test(document.getElementById('live-mode')?.innerText ?? ''), null, { timeout: 15000 });
  assert.deepEqual(wsUrls, ['wss://node.zetaphy.test/rpc/websocket', 'wss://node.zetaphy.test/ws']); // CometBFT, then EVM newHeads
  await waitText(page, 'Latest blocks');
  const H = chain.addBlock();
  await page.waitForSelector(`.card tr.row-new a[href="#/block/${H}"]`, { timeout: 15000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});

// ---------------- insight features: fund flow, labels, cross-chain, ask, quantum, risk ----------------

test('fund flow: the graph renders from the mock node, says its scope, expands a node, and has a table', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/flow/${ME_HEX}`);
  await page.waitForSelector('svg.flow-svg');
  const t = await text(page);
  // (the live-feed tests above add blocks to the shared mock chain: the scan ends at its head)
  assert.ok(t.includes(`native ZETAPHY transfers from the scanned blocks 1–${chain.latest()}`), t);
  assert.ok(t.includes('token Transfer events in 500-block windows'), t);
  // each address says exactly what was read for it
  assert.ok(t.includes(`tokens: blocks 1–${chain.latest()} · native: scanned blocks 1–${chain.latest()} · tx index: all heights`), t);
  const nodes = () => page.locator('svg.flow-svg g.flow-node[data-address]').evaluateAll((gs) => gs.map((g) => g.dataset.address));
  const before = await nodes();
  assert.ok(before.includes(ME_HEX.toLowerCase()) && before.includes(LOCKED_HEX), JSON.stringify(before)); // ME -> LOCKED (MsgSend)
  const sender = chain.evmWallet.address.toLowerCase();
  assert.ok(before.includes(sender), 'the ERC-20 sender, one hop in');
  assert.ok(!before.includes(MAILBOX.toLowerCase()));
  // edges are labelled with amounts; the table fallback lists the same transfers
  assert.match(await page.locator('svg.flow-svg').textContent(), /2\.5 ZETAPHY/);
  assert.match(await page.locator('table.flow-table').innerText(), /2\.5 ZETAPHY/);
  // click the sender: its outflow to the Hyperlane Mailbox appears, labelled
  await page.click(`svg.flow-svg g.flow-node[data-address="${sender}"]`);
  await page.waitForSelector(`svg.flow-svg g.flow-node[data-address="${MAILBOX.toLowerCase()}"]`);
  assert.match(await page.locator('svg.flow-svg').textContent(), /Hyperlane Mailbox/);
  // the same layout every time
  const layout = () => page.locator('svg.flow-svg g.flow-node').evaluateAll((gs) => gs.map((g) => `${g.dataset.address} ${g.getAttribute('transform')}`));
  const pos1 = await layout();
  await page.reload(); await page.waitForSelector('svg.flow-svg');
  await page.click(`svg.flow-svg g.flow-node[data-address="${sender}"]`);
  await page.waitForSelector(`svg.flow-svg g.flow-node[data-address="${MAILBOX.toLowerCase()}"]`);
  assert.deepEqual(await layout(), pos1);
  // pan / zoom from the keyboard: the view box changes, no inline styles anywhere in the graph
  const vb = () => page.locator('svg.flow-svg').getAttribute('viewBox');
  const v0 = await vb();
  await page.focus('.flow-wrap'); await page.keyboard.press('+');
  assert.notEqual(await vb(), v0);
  await page.keyboard.press('ArrowRight');
  const v1 = await vb();
  await page.keyboard.press('0');
  assert.equal(await vb(), v0); assert.notEqual(v1, v0);
  assert.equal(await page.locator('main [style]').count(), 0);
  // phone width: the page itself never scrolls sideways
  await page.setViewportSize({ width: 360, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('fund flow: "Follow" goes past 3 hops to where the money stops, Stop stops it, cycles are drawn, the path view', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  const F = FLOW_HEX.map((x) => x.toLowerCase());
  // slow node answers, so that Stop lands in the middle
  const slow = async (route) => { await new Promise((r) => setTimeout(r, 250)); return route.fallback(); };
  await go(page, `#/flow/${F[0]}`);
  await page.waitForSelector(`svg.flow-svg g.flow-node[data-address="${F[1]}"]`); // hop 1 from the node's tx index (not in any scanned block)
  await waitText(page, 'tx index: all heights (1 txs)');
  await ctx.route((url) => url.host === 'node.zetaphy.test', slow);
  await page.click('#flow-follow');
  await page.waitForSelector(`svg.flow-svg g.flow-node[data-address="${F[2]}"]`);
  await page.click('#flow-stop');
  await page.waitForFunction(() => /Stopped at hop \d+/.test(document.querySelector('.flow-status')?.textContent ?? ''));
  assert.equal(await page.locator(`svg.flow-svg g.flow-node[data-address="${F[6]}"]`).count(), 0, 'stopped before the end');
  assert.ok(await page.locator('#flow-follow').isEnabled());
  // go on: past hop 3, to hop 6, where the money stops
  await ctx.unroute((url) => url.host === 'node.zetaphy.test', slow);
  await page.click('#flow-follow');
  await page.waitForFunction(() => /Followed to the end: 6 hop\(s\)/.test(document.querySelector('.flow-status')?.textContent ?? ''), null, { timeout: 30000 });
  for (let i = 1; i <= 6; i++) assert.equal(await page.locator(`svg.flow-svg g.flow-node[data-address="${F[i]}"]`).getAttribute('data-hop'), String(i), `hop ${i}`);
  assert.match(await page.locator('svg.flow-svg').textContent(), /6 hop\(s\) out/);
  assert.match(await page.locator('svg.flow-svg').textContent(), /50 ZETAPHY/);
  const t = await text(page);
  assert.match(t, /no further outflow in the data read/);
  // the cycle F2 -> F3 -> F4 -> F2: found, drawn, followed once
  assert.match(t, /1 cycle\(s\)/);
  assert.ok(await page.locator('svg.flow-svg g.flow-edge.flow-cycle').count() >= 3);
  assert.equal(await page.locator('svg.flow-svg g.flow-node[data-address]').count(), 7);
  // the path from the start to hop 6
  await page.selectOption('#flow-path-to', F[6]);
  await page.click('#flow-path-show');
  await waitText(page, '6 step(s)');
  assert.equal(await page.locator('.flow-path-list li').count(), 6);
  assert.match(await page.locator('.flow-path-list li').first().innerText(), /100 ZETAPHY/);
  assert.equal(await page.locator('svg.flow-svg g.flow-edge.flow-on-path').count(), 6);
  // a hop collapses into "+N more" (a node on the path stays drawn) and comes back
  await page.click('button.flow-layer-btn[data-layer="6"]');
  assert.equal(await page.locator(`svg.flow-svg g.flow-node[data-address="${F[6]}"]`).count(), 1, 'on the path: kept');
  await page.click('#flow-path-clear');
  assert.equal(await page.locator(`svg.flow-svg g.flow-node[data-address="${F[6]}"]`).count(), 0);
  assert.match(await page.locator('svg.flow-svg g.flow-node[data-more="6"]').textContent(), /\+1 more/);
  await page.click('svg.flow-svg g.flow-node[data-more="6"]');
  assert.equal(await page.locator(`svg.flow-svg g.flow-node[data-address="${F[6]}"]`).count(), 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('labels: a known address shows its label (Hyperlane Mailbox, burn address) wherever it is rendered', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/tx/${chain.hlTxHash}`);
  await waitText(page, 'Hyperlane Mailbox');
  const to = page.locator('dl.kv dd', { has: page.locator(`a[href="#/address/${MAILBOX}"]`) }).first();
  assert.match(await to.innerText(), /Hyperlane Mailbox/);
  await go(page, `#/address/${MAILBOX}`);
  await waitText(page, 'Hyperlane Mailbox');
  await go(page, '#/address/0x000000000000000000000000000000000000dEaD');
  await waitText(page, 'Burn address (0x…dEaD)');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('cross-chain: a Hyperlane dispatch shows its message id, Sepolia, and the delivery read from Sepolia\'s RPC', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  const asked = [];
  // Sepolia's public RPC (from crosschain.json), mocked: delivered(id) is true, ProcessId found in a recent block
  await ctx.route((url) => url.host === 'ethereum-sepolia-rpc.publicnode.com', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const { id, method, params } = JSON.parse(req.postData());
    asked.push(method);
    const result = {
      eth_call: String(params?.[0]?.to).toLowerCase() === '0xffaef09b3cd11d9b20d1a19becca54eec2884766' && params[0].data.endsWith(chain.hlMessageId.slice(2)) ? '0x' + '0'.repeat(63) + '1' : '0x' + '0'.repeat(64),
      eth_blockNumber: '0x100000',
      eth_getLogs: [{ address: '0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766', transactionHash: SEPOLIA_DELIVERY_TX, blockNumber: '0xfffff0', topics: params?.[0]?.topics ?? [], data: '0x' }],
      eth_getBlockByNumber: { number: '0xfffff0', timestamp: '0x6720f000' },
    }[method];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  });
  await go(page, `#/tx/${chain.hlTxHash}`);
  await waitText(page, 'Message sent to Sepolia');
  await waitText(page, 'Delivered');
  const t = await text(page);
  assert.ok(t.includes(chain.hlMessageId), 'message id shown');
  assert.ok(t.includes('Cross-chain'), 'the card has its own title (not the contract card\'s)');
  assert.match(t, /ZETAPHY Testnet → Sepolia/);
  assert.equal(await page.locator(`a[href="https://sepolia.etherscan.io/tx/${SEPOLIA_DELIVERY_TX}"]`).count(), 1);
  assert.ok(asked.includes('eth_call') && asked.includes('eth_getLogs'));
  // a tx without messages has no cross-chain card
  await go(page, `#/tx/${chain.evmTxHash}`);
  await waitText(page, 'ERC-1155');
  assert.ok(!(await text(page)).includes('Cross-chain'));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('ask: a Thai question in the search box routes to the risk view of that address', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'th' });
  await go(page, '#/');
  await waitText(page, 'บล็อกล่าสุด');
  await page.fill('#search', `ที่อยู่นี้ปลอดภัยไหม ${TOKEN}`);
  await page.press('#search', 'Enter');
  await page.waitForFunction((a) => location.hash === `#/ask/risk?address=${a}`, TOKEN);
  await waitText(page, 'สรุปความเสี่ยง (Neuro)');
  await waitText(page, 'Neuro ติดธง');
  const t = await text(page);
  assert.match(t, /ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา/);
  assert.match(t, /ความเสี่ยงต่อคอมพิวเตอร์ควอนตัม/);
  // English: failed txs in the scanned blocks
  await page.selectOption('#lang', 'en');
  await page.fill('#search', 'failed txs');
  await page.press('#search', 'Enter');
  await waitText(page, 'Understood as:');
  await waitText(page, 'MsgPQVoteKey');
  assert.ok(!(await text(page)).includes('MsgSend'), 'only the failed one');
  // not a question: the normal search keeps the page and says what it accepts
  await page.fill('#search', 'hello there');
  await page.press('#search', 'Enter');
  assert.match(await page.evaluate(() => location.hash), /#\/ask\/failed/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('quantum exposure and risk badges: address sections, the dashboard, and Neuro badges in tables', async () => {
  const { page, ctx, problems } = await openPage({ lang: 'en' });
  await go(page, `#/address/${ME_HEX}`);
  await waitText(page, 'Quantum exposure');
  await waitText(page, 'Post-quantum account');
  await waitText(page, 'Risk summary (Neuro)');
  await go(page, `#/address/${LOCKED_HEX}`);
  await waitText(page, 'A quantum lock is set');
  await go(page, `#/address/${chain.evmWallet.address}`);
  await waitText(page, 'Public key exposed');
  assert.equal(await page.locator('a[href="https://app.sawasdeecoin.com/?tab=wallet"]').count(), 1);
  // the flagged token gets its badge next to its link in the EVM tx's transfers
  const s0 = await page.evaluate(() => window.__explorer.stats());
  await go(page, `#/tx/${chain.evmTxHash}`);
  await page.waitForSelector('.risk-badge');
  assert.match(await page.locator('.risk-badge').first().innerText(), /Flagged by Neuro · unlimited-mint/);
  // the badge lookups were batched: a handful of requests for the whole tx page
  const s = await page.evaluate(() => window.__explorer.stats());
  // (counted from the tx page's own start: the address pages before it now also load their full history)
  assert.ok(s.requests - s0.requests < 40, JSON.stringify({ before: s0, after: s }));
  // the dashboard: PQ vote keys of the validators and the senders of the scanned blocks
  await go(page, '#/quantum');
  await waitText(page, 'Senders checked');
  await waitText(page, 'Share of the voting power');
  const t = await text(page);
  assert.match(t, /Active validators with a key\s+1 \/ 2/);
  assert.match(t, /Share of the voting power\s+60\.0%/);
  assert.match(t, /Post-quantum \(ML-DSA-44 or quantum-locked\)\s+1 \(/);
  assert.deepEqual(problems, []);
  await ctx.close();
});
