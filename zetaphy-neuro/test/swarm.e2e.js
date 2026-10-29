// Browser test (real Chromium, the real page and its CSP) for docs/future/browser-ai.md
// items 2 and 7: two separate browser contexts find each other through the
// SignalBoard contract on a ZETAPHY-like chain (test/helpers/signal-devnet.js,
// reached as https://rpc.sawasdeecoin.com), each with its own throwaway session
// key paid by the faucet, open a real WebRTC data channel with nobody pasting a
// code, and then:
//   1. one browser loads only the layers it serves (verified chunks), the other
//      only the head and the first layers; the language model runs split across
//      the two and writes exactly the tokens a single browser writes;
//   2. the same through the page's own buttons ("Lend this browser",
//      "Write here", "Write, split with another browser").
//   npm run test:web
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createSignalDevnet } from './helpers/signal-devnet.js';
import { createLocalChain } from './helpers/local-chain.js';

const PORT = 18095;
let server; let browser; let net; let chain;

async function launch() {
  const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  try { return await chromium.launch({ headless: true, args }); } catch {
    return chromium.launch({ headless: true, args, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  net = await createSignalDevnet();
  chain = await createLocalChain();
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', env: { ...process.env, NEURO_PRIVATE_RULES: '' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

/** A page whose ZETAPHY RPC is the test chain and whose config names the test SignalBoard (polling fast). */
async function pageIn(ctx, { contracts = false } = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  await page.route(() => true, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith('/ai/browser/config.js')) {
      const res = await route.fetch();
      const body = (await res.text()).replace('signalBoard: null', `signalBoard: '${net.board}'`).replace('pollMs: 5000', 'pollMs: 400');
      await route.fulfill({ response: res, body });
      return;
    }
    if (url.protocol !== 'https:') { await route.continue(); return; }
    if (req.method() !== 'POST') { await route.fulfill({ status: 404, body: '' }); return; }
    const { id, method, params } = JSON.parse(req.postData());
    let result, error;
    try {
      if (url.host === 'rpc.sawasdeecoin.com') result = await net.call(method, params);
      else if (contracts) result = method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params);
      else throw new Error('no network in this test');
    } catch (e) { error = { code: -32000, message: e.message }; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) });
  });
  return { page, errors };
}

test('two browsers discover each other on the chain (no codes) and run the language model split across them: same tokens as one browser', async (t) => {
  const A = await pageIn(await browser.newContext());
  const B = await pageIn(await browser.newContext());
  for (const p of [A, B]) await p.page.goto(`http://localhost:${PORT}/web/`);
  const sent0 = net.sent.length;
  // B: loads only layers [k, L) and announces itself as a stage
  const b = await B.page.evaluate(async () => {
    const { BROWSER_AI, BROWSER_LLM, PINNED_LLM } = await import('../ai/browser/config.js');
    const { chainBoard } = await import('../ai/browser/boards.js');
    const { sessionWallet } = await import('../ai/browser/evmtx.js');
    const { createSwarm } = await import('../ai/browser/discovery.js');
    const { topicFor } = await import('../ai/browser/signal.js');
    const { loadLlm } = await import('../ai/browser/llmload.js');
    const { createStage } = await import('../ai/browser/llama.js');
    const { serveLlmStage } = await import('../ai/browser/pipeline.js');
    const L = PINNED_LLM.layers, k = Math.floor(L / 2);
    const part = await loadLlm({ release: PINNED_LLM, mirrors: BROWSER_LLM.mirrors, from: k, to: L, head: false });
    const stage = createStage(part.model, { from: k, to: L });
    const id = PINNED_LLM.manifestHash.slice(2);
    window.t = { servers: [] };
    const board = chainBoard({ rpc: [BROWSER_AI.rpc], chainId: BROWSER_AI.chainId, address: BROWSER_AI.signalBoard, wallet: sessionWallet({ storage: localStorage }) });
    window.t.swarm = createSwarm({
      board, topic: await topicFor('stage', id), pollMs: 300, meta: { role: 'stage', from: k, to: L }, want: (m) => m.role === 'coordinator',
      onPeer: ({ channel }) => window.t.servers.push(serveLlmStage(channel, stage, { model: id })),
    });
    await window.t.swarm.start();
    return { chunks: part.chunks, total: part.total, partial: part.stats.partial, address: sessionWallet({ storage: localStorage }).address };
  });
  assert.ok(b.partial && b.chunks < b.total, JSON.stringify(b));
  // A: head + layers [0, k); finds B by itself, then generates split; and once more with every layer locally
  const a = await A.page.evaluate(async () => {
    const { BROWSER_AI, BROWSER_LLM, PINNED_LLM } = await import('../ai/browser/config.js');
    const { chainBoard } = await import('../ai/browser/boards.js');
    const { sessionWallet } = await import('../ai/browser/evmtx.js');
    const { createSwarm } = await import('../ai/browser/discovery.js');
    const { topicFor } = await import('../ai/browser/signal.js');
    const { loadLlm } = await import('../ai/browser/llmload.js');
    const { createStage, createHead, chainStages, generate } = await import('../ai/browser/llama.js');
    const { loadTokenizer } = await import('../ai/browser/tokenizer.js');
    const { remoteLlmStage } = await import('../ai/browser/pipeline.js');
    const L = PINNED_LLM.layers, k = Math.floor(L / 2);
    const id = PINNED_LLM.manifestHash.slice(2);
    const coord = await loadLlm({ release: PINNED_LLM, mirrors: BROWSER_LLM.mirrors, from: 0, to: k, head: true });
    const board = chainBoard({ rpc: [BROWSER_AI.rpc], chainId: BROWSER_AI.chainId, address: BROWSER_AI.signalBoard, wallet: sessionWallet({ storage: localStorage }) });
    const t0 = Date.now();
    const topic = await topicFor('stage', id);
    const channel = await new Promise((resolve) => {
      window.t = { swarm: createSwarm({ board, topic, pollMs: 300, maxPeers: 1, meta: { role: 'coordinator' }, want: (m) => m.role === 'stage' && m.from === k && m.to === L, onPeer: ({ channel: ch }) => resolve(ch) }) };
      window.t.swarm.start();
    });
    const foundMs = Date.now() - t0;
    const tok = loadTokenizer(coord.model.tokenizer, coord.model.config.vocabSize);
    const remote = remoteLlmStage(channel, { from: k, to: L, model: id });
    const runner = chainStages([createStage(coord.model, { from: 0, to: k }), remote], L);
    const split = [];
    for (const prompt of ['The browser', 'ZETAPHY is a']) split.push(await generate({ head: createHead(coord.model), tokenizer: tok, runner }, prompt, { maxNew: 48 }));
    const sampled = await generate({ head: createHead(coord.model), tokenizer: tok, runner }, 'The chain', { maxNew: 32, temperature: 0.8, seed: 7 });
    // the reference: all layers in this one browser
    const full = (await loadLlm({ release: PINNED_LLM, mirrors: BROWSER_LLM.mirrors })).model;
    const one = [];
    for (const prompt of ['The browser', 'ZETAPHY is a']) one.push(await generate({ head: createHead(full), tokenizer: tok, runner: createStage(full) }, prompt, { maxNew: 48 }));
    const sampledOne = await generate({ head: createHead(full), tokenizer: tok, runner: createStage(full) }, 'The chain', { maxNew: 32, temperature: 0.8, seed: 7 });
    return {
      split: split.map((g) => g.tokens), one: one.map((g) => g.tokens), text: split[0].text, sampled: sampled.tokens, sampledOne: sampledOne.tokens,
      hops: remote.hops, hopMs: remote.ms / remote.hops, coordChunks: coord.chunks, total: coord.total, foundMs, peerId: [...window.t.swarm.peers.keys()][0],
    };
  });
  t.diagnostic(`found the other browser in ${(a.foundMs / 1000).toFixed(1)} s; ${a.hops} hops, ${a.hopMs.toFixed(1)} ms per hop`);
  assert.deepEqual(a.split, a.one, 'split = single browser, token for token');
  assert.deepEqual(a.sampled, a.sampledOne, 'seeded sampling too');
  assert.ok(a.split[0].length >= 20 && a.text.length > 40, a.text);
  assert.ok(a.hops > 40, `the second half ran in the other browser (${a.hops} hops)`);
  assert.ok(a.coordChunks < a.total);
  assert.equal(await B.page.evaluate(() => window.t.servers.reduce((s, x) => s + x.tokens, 0)) > 40, true);
  assert.equal(a.peerId, await B.page.evaluate(() => window.t.swarm.id));
  // every signal went through the contract: 2 announces, 1 offer, 1 answer, from two faucet-funded session keys
  const posts = net.sent.slice(sent0).filter((t) => t.ok);
  assert.ok(posts.length >= 4, `${posts.length} posts`);
  assert.equal(new Set(posts.map((p) => p.from)).size, 2);
  assert.ok(posts.some((p) => p.from === b.address));
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.page.context().close(); await B.page.context().close();
});

test('the page\'s buttons: "Lend this browser" in one, "Write here" then "Write, split" in the other: same text, said so', async () => {
  const addr = await chain.deploy('ScamToken');
  const open = async () => {
    const p = await pageIn(await browser.newContext(), { contracts: true });
    await p.page.goto(`http://localhost:${PORT}/`);
    await p.page.fill('#address', addr);
    await p.page.click('#go');
    await p.page.waitForSelector('#result:not([hidden]) #ai');
    await p.page.click('#ai-settings summary');
    await p.page.selectOption('#ai-provider', 'browser');
    await p.page.click('#ai-llm summary');
    return p;
  };
  const A = await open();
  const B = await open();
  assert.equal(await A.page.textContent('#ai-llm-split'), 'Write, split with another browser');
  await B.page.click('#ai-llm-serve');
  await B.page.waitForFunction(() => /Serving layers 3–6/.test(document.getElementById('ai-llm-status').textContent), null, { timeout: 30_000 });
  await A.page.fill('#ai-llm-prompt', 'The browser');
  await A.page.click('#ai-llm-here');
  await A.page.waitForFunction(() => /all in this browser/.test(document.getElementById('ai-llm-status').textContent), null, { timeout: 30_000 });
  const here = await A.page.textContent('#ai-llm-out');
  await A.page.click('#ai-llm-split');
  await A.page.waitForFunction(() => /in another browser/.test(document.getElementById('ai-llm-status').textContent), null, { timeout: 60_000 });
  assert.equal(await A.page.textContent('#ai-llm-out'), here);
  assert.match(await A.page.textContent('#ai-llm-status'), /Same tokens as running every layer here: yes\./);
  await B.page.waitForFunction(() => !/: 0 tokens/.test(document.getElementById('ai-llm-status').textContent), null, { timeout: 10_000 });
  // Thai words for the same box
  await A.page.selectOption('#lang', 'th');
  assert.equal(await A.page.textContent('#ai-llm-split'), 'เขียน โดยแบ่งกับอีกเบราว์เซอร์');
  assert.deepEqual([...A.errors, ...B.errors], []);
});
