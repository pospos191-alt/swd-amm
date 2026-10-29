// Browser test for the in-browser AI: real Chromium, the real page and CSP.
//   1. Two separate browser contexts ("two browsers") connect over a real WebRTC
//      data channel with the manual offer/answer codes (no signaling server),
//      one loads the model from the site and serves it, the other loads it only
//      from that peer and verifies every chunk against the pinned release.
//   2. Pipeline-parallel: the toy model's layers split across the two browsers,
//      activations over the data channel, output equal to a local run.
//   3. The AI panel with provider "in this browser": the verified model loads
//      from this site, writes the report, and on-chain records (ThreatRegistry
//      logs answered by the test as the ZETAPHY RPC) are cited. No key, no CSP
//      change, nothing sent to any model provider.
//   npm run test:web
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLocalChain } from './helpers/local-chain.js';
import { AI_TEXT } from '../ai/i18n.js';
import { TOPICS, addressKey } from '../ai/onchain.js';

const PORT = 18093;
let server; let browser; let chain;

async function launch() {
  // Without the mDNS host-name hiding, two contexts on one machine reach each other by plain host candidates.
  const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  try { return await chromium.launch({ headless: true, args }); } catch {
    return chromium.launch({ headless: true, args, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  chain = await createLocalChain();
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', env: { ...process.env, NEURO_PRIVATE_RULES: '' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

async function pageIn(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  await page.route((u) => u.protocol === 'https:', (route) => route.fulfill({ status: 404, body: '' })); // no outside network
  await page.goto(`http://localhost:${PORT}/web/`);
  return { page, errors };
}

test('two browsers: WebRTC with manual codes; the model travels peer to peer and is verified chunk by chunk; pipeline over the channel', async () => {
  const A = await pageIn(await browser.newContext());
  const B = await pageIn(await browser.newContext());
  // A: loads the model from this site and keeps its chunks.
  const loadedA = await A.page.evaluate(async () => {
    const { loadVerified } = await import('../ai/browser/loader.js');
    const { memoryStore } = await import('../ai/browser/stores.js');
    const { PINNED, BROWSER_AI } = await import('../ai/browser/config.js');
    window.t = { store: memoryStore() };
    const out = await loadVerified({ release: PINNED, mirrors: BROWSER_AI.mirrors, store: window.t.store });
    return out.stats.mirror;
  });
  assert.equal(loadedA, 6);
  // Manual signaling: A's offer code -> B, B's answer code -> A (the test carries them, as a person would).
  const offer = await A.page.evaluate(async () => {
    const p2p = await import('../ai/browser/p2p.js');
    window.t.offer = await p2p.createOffer();
    return window.t.offer.code;
  });
  assert.match(offer, /^ZP1\./);
  const answer = await B.page.evaluate(async (code) => {
    const p2p = await import('../ai/browser/p2p.js');
    const a = await p2p.acceptOffer(code);
    window.t = { channel: a.channel };
    return a.code;
  }, offer);
  await A.page.evaluate(async (code) => {
    const p2p = await import('../ai/browser/p2p.js');
    const ch = await window.t.offer.accept(code);
    window.t.server = p2p.servePeer(ch, window.t.store);
    window.t.ch = ch;
  }, answer);
  // B: no mirror at all, only the peer; every chunk still checked against the release.
  const fromPeer = await B.page.evaluate(async () => {
    const { loadVerified } = await import('../ai/browser/loader.js');
    const { peerSource } = await import('../ai/browser/p2p.js');
    const { PINNED } = await import('../ai/browser/config.js');
    const { loadEngine } = await import('../ai/browser/engine.js');
    const ch = await window.t.channel;
    window.t.ch = ch;
    const out = await loadVerified({ release: PINNED, peers: [peerSource(ch, 'A')] });
    const e = loadEngine(out.bytes, out.manifest);
    // a release the peer cannot match is refused
    let refused = false;
    try { await loadVerified({ release: { ...PINNED, chunkRoot: '0x' + '11'.repeat(32) }, peers: [peerSource(ch, 'A')] }); } catch { refused = true; }
    return { peer: out.stats.peer, manifestFrom: out.stats.manifestFrom, id: e.id, refused };
  });
  assert.deepEqual(fromPeer, { peer: 6, manifestFrom: 'peer:A', id: 'neuro-ml-gbdt@1 (neuro-ml-gbdt/1, in this browser)', refused: true });
  assert.ok(await A.page.evaluate(() => window.t.server.served) >= 7);

  // Pipeline: B serves layers [2, 5) of the toy model over the same data channel; A runs [0, 2) itself (a local in-memory stage).
  await B.page.evaluate(async () => {
    const { makeToyModel } = await import('../ai/browser/toymodel.js');
    const { serveStage } = await import('../ai/browser/pipeline.js');
    window.t.stage = serveStage(window.t.ch, makeToyModel([16, 48, 48, 48, 48, 8], 5), { from: 2, to: 5 });
  });
  const piped = await A.page.evaluate(async () => {
    const { makeToyModel, forward } = await import('../ai/browser/toymodel.js');
    const { serveStage, createPipeline } = await import('../ai/browser/pipeline.js');
    const { memoryPair } = await import('../ai/browser/p2p.js');
    const model = makeToyModel([16, 48, 48, 48, 48, 8], 5);
    const [c, p] = memoryPair();
    serveStage(p, model, { from: 0, to: 2 });
    const pipe = createPipeline([{ from: 0, to: 2, channel: c }, { from: 2, to: 5, channel: window.t.ch }]);
    const batch = 64;
    const x = new Float32Array(batch * 16).map((_, i) => Math.sin(i * 0.1));
    const y = await pipe.run(x, batch, { microBatch: 8, inFlight: 4 });
    const ref = forward(model, x, 0, 5, batch);
    return { same: y.every((v, i) => v === ref[i]), n: y.length, hops: pipe.timeline.filter((h) => h.stage === 1).length };
  });
  assert.deepEqual(piped, { same: true, n: 64 * 8, hops: 8 });
  assert.equal(await B.page.evaluate(() => window.t.stage.runs), 8);
  assert.deepEqual([...A.errors, ...B.errors], []);
});

test('AI panel, provider "in this browser": verified model from this site, on-chain records cited, no key, no provider call', async () => {
  const addr = await chain.deploy('ScamToken');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const outside = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  const REG = '0xab5745b61f83975e68f6546be9f83651df12417f';
  const key = addressKey(56, addr);
  const w = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
  const zetaLogs = [
    { address: REG, topics: [TOPICS.voted, key, '0x' + w('77'.repeat(20))], data: '0x' + w('1') + w('3') + 'e7'.repeat(32) + w('80') + w('0'), blockNumber: '0xf0', logIndex: '0x0' },
    { address: REG, topics: [TOPICS.flagged, key], data: '0x' + w('3'), blockNumber: '0xf0', logIndex: '0x1' },
  ];
  await page.route(() => true, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol !== 'https:') { await route.continue(); return; }
    outside.push(url.host);
    if (req.method() === 'GET') { await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }); return; }
    const { id, method, params } = JSON.parse(req.postData());
    let result;
    if (url.host === 'rpc.sawasdeecoin.com') {
      result = method === 'eth_chainId' ? '0x12e4e' : method === 'eth_blockNumber' ? '0x100' : method === 'eth_getLogs' ? zetaLogs.filter((l) => params[0].address.toLowerCase() === REG) : null;
    } else {
      try { result = method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params); } catch (e) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: e.message } }) }); return; }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden]) #ai');
  const level = await page.textContent('#title');
  await page.click('#ai-settings summary');
  await page.selectOption('#ai-provider', 'browser');
  assert.equal(await page.isVisible('#ai-key'), false, 'no key field');
  assert.equal(await page.isVisible('#ai-browser'), true);
  assert.equal(await page.textContent('#ai-provider option[value="browser"]'), AI_TEXT.en.pBrowser);
  await page.check('#ai-knowledge');
  await page.click('#ai-run');
  await page.waitForSelector('#ai-out:not([hidden])', { timeout: 30_000 });
  const status = await page.textContent('#ai-load-status');
  assert.match(status, /pinned in this page/);
  assert.match(status, /loaded and verified: 6 chunks \(0 from this browser's cache, 0 from peers, 6 from servers\)/);
  const out = await page.textContent('#ai-out');
  assert.match(out, /ThreatRegistry has a standing flag on this address/);
  assert.match(out, /evidence: CHAIN1/);
  assert.match(out, /evidence: ML/);
  assert.match(out, /neuro-ml-gbdt@1/);
  assert.equal(await page.textContent('#title'), level, 'the rules\' result is unchanged');
  assert.ok(outside.every((h) => h === 'rpc.sawasdeecoin.com' || !/anthropic|openai|11434/.test(h)), outside.join(','));
  // Thai: same verified engine, cached now
  await page.selectOption('#lang', 'th');
  await page.click('#ai-run');
  await page.waitForFunction(() => document.getElementById('ai-status').textContent === '' && /ThreatRegistry/.test(document.getElementById('ai-out').textContent));
  assert.match(await page.textContent('#ai-out'), /มีธงที่ยังมีผลกับที่อยู่นี้/);
  assert.deepEqual(errors, []);
});
