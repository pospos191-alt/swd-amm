// Browser test of the federated-learning panel (web/fl-panel.js): a whole round with five
// browsers in real Chromium, against the real FederatedRounds contract on an in-memory EVM.
//   1. Off by default; turned on, a real scan (a token with a pool on the test "BNB Chain") is
//      stored in the browser and the user labels it. A page with the committed deployment record
//      says "not deployed yet" and offers nothing to send.
//   2. The contract starts closed; governance opens it. Each browser connects its wallet (an
//      injected EIP-1193 wallet the test answers), trains in a Web Worker, commits, then reveals.
//      Its privacy budget is spent once; a second try in the same round is refused.
//   3. The aggregator reads the Revealed events (in-process, and with zetaphy-network's
//      scripts/fl-aggregate.js over JSON-RPC when that package is installed) and accepts all 5.
//   4. What left the browsers: wallet transactions are only commit/reveal of an NFL1 update on
//      the committed head; requests to the round node are reads; no stored label or token
//      address went anywhere except the scan's own reads.
//   npm run test:web
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createLocalChain } from './helpers/local-chain.js';
import { createFlChain } from './helpers/fl-chain.js';
import { CHAINS } from '../src/chains.js';
import { selectorOf } from '../src/keccak.js';
import { scanEntry } from '../ml/fl/labels.js';
import { decodeUpdate } from '../ml/fl/codec.js';
import { aggregateRound } from '../ml/fl/aggregate.js';
import { FL_TEXT } from '../web/fl-i18n.js';

const PORT = 18097;
const RPC_PORT = 18098;
const FL_RPC = 'https://fl-rpc.test/';
const N = 5;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL = JSON.parse(readFileSync(new URL('../ml/model.json', import.meta.url), 'utf8'));
const HEAD = JSON.parse(readFileSync(new URL('../ml/fl/head.json', import.meta.url), 'utf8'));
const EVASIONS = readFileSync(new URL('../ml/data/redteam/evasions.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ACCTS = Array.from({ length: N }, (_, i) => `0x${(0xc1 + i).toString(16)}${'0'.repeat(36)}${(i + 1).toString(16).padStart(2, '0')}`);
const GOV = '0x' + '7a'.repeat(20);
const SEL = { commit: selectorOf('commit(uint256,bytes32)'), reveal: selectorOf('reveal(uint256,bytes32,bytes)'), setPaused: selectorOf('setPaused(bool)') };
const en = FL_TEXT.en;

let server; let browser; let chain; let fl; let rpcSrv; let rounds; let token;
const contexts = [];

async function launch() {
  const args = ['--disable-dev-shm-usage']; // five browsers at once: no small /dev/shm crashes
  try { return await chromium.launch({ headless: true, args }); } catch {
    return chromium.launch({ headless: true, args, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  chain = await createLocalChain();
  const addPool = await chain.installDex(CHAINS.bsc.dex);
  token = (await chain.deploy('CleanToken')).toLowerCase();
  await addPool(token, 10n ** 24n, 10n ** 20n);
  fl = await createFlChain({ accounts: ACCTS, gov: GOV });
  rounds = await fl.deployRounds({ start: fl.blockNumber() + 30n, commitBlocks: 80, revealBlocks: 80, maxPerRound: 50 });
  rpcSrv = await fl.serve(RPC_PORT);
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NEURO_PRIVATE_RULES: '' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); rpcSrv?.close(); });

/** Stored checks a browser already has (seeded): labelled rows from the model's check set and red-team rows. */
function seeded(i) {
  const rows = [...MODEL.check.map((r) => ({ f: r.f, y: r.p >= 0.5 ? 1 : 0 })), ...EVASIONS.slice(i * 3, i * 3 + 3).map((r) => ({ f: r.f, y: 1 }))];
  const at = Date.now() - 3600_000;
  return { v: 1, optIn: true, ledger: { spent: [] }, pending: null,
    entries: rows.map((r, k) => ({ ...scanEntry({ chain: 'bsc', chainId: 56, address: '0x' + createHash('sha256').update(`seed-${i}-${k}`).digest('hex').slice(0, 40), features: r.f, at }), user: r.y })) };
}

/**
 * One browser: its own context (storage), an injected wallet for ACCTS[i], the test deployment
 * record (deployed = false: a record with no contract), RPCs answered by the test chains.
 */
async function client(i, { deployed = true, seed = true } = {}) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const log = { requests: [], wallet: [] };
  const acct = ACCTS[i];
  await ctx.exposeBinding('__flWallet', async (_src, method, params) => {
    log.wallet.push({ method, params });
    if (method === 'eth_sendTransaction' && String(params[0]?.from).toLowerCase() !== acct) throw new Error('wrong account');
    return fl.request(method, params);
  });
  await ctx.addInitScript(({ acct, seed }) => {
    if (seed && !localStorage.getItem('neuro-fl-v1')) localStorage.setItem('neuro-fl-v1', seed);
    const listeners = {};
    window.ethereum = {
      isTestWallet: true,
      on: (ev, f) => { (listeners[ev] ??= []).push(f); },
      async request({ method, params = [] }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
        if (method === 'eth_chainId') return '0x12e4e';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        return window.__flWallet(method, params);
      },
    };
  }, { acct, seed: seed ? JSON.stringify(seeded(i)) : null });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => log.requests.push({ url: r.url(), method: r.method(), body: r.postData() ?? '' }));
  // deployed: the test chain's contract; not deployed: a record with no contract (the committed file now names the
  // live testnet contract, so the "not deployed yet" state is served explicitly)
  await page.route('**/ml/fl/deployment.json', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ format: 'neuro-fl-deployment/1', network: 'devnet', chainId: 77390, rpc: FL_RPC, rounds: deployed ? rounds : null,
      deployBlock: deployed ? 1 : null, governance: deployed ? GOV : null, threatRegistry: null }) }));
  await page.route((url) => url.protocol === 'https:', async (route) => {
    const req = route.request();
    const msg = JSON.parse(req.postData() ?? '{}');
    let body;
    try {
      const result = req.url().startsWith(FL_RPC) ? await fl.request(msg.method, msg.params)
        : msg.method === 'eth_chainId' ? '0x38' : await chain.rpc.call(msg.method, msg.params);
      body = { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) { body = { jsonrpc: '2.0', id: msg.id, error: { code: 3, message: e.message } }; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${PORT}/web/`);
  await page.waitForSelector('#fl');
  return { page, errors, log, acct };
}

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('neuro-fl-v1') ?? 'null'));
const text = (page, sel) => page.textContent(sel);
async function waitText(page, sel, re, timeout = 30_000) {
  await page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source], { timeout });
}
async function refreshUntil(page, re) {
  for (let k = 0; k < 20; k++) {
    await page.click('#fl-refresh');
    try { await waitText(page, '#fl-round', re, 3000); return; } catch { /* again */ }
  }
  throw new Error(`#fl-round never matched ${re}: ${await text(page, '#fl-round')}`);
}

let clients = [];

test('off by default; turned on, a real scan is stored in this browser and labelled after the fact', async () => {
  const c0 = await client(0, { seed: false });
  const { page } = c0;
  assert.equal(await page.isChecked('#fl-optin'), false);
  assert.equal(await page.isHidden('#fl-body'), true);
  assert.equal(await text(page, '#fl-off'), en.off);
  assert.equal(await text(page, '#fl-footer-note'), en.walletNote);
  assert.equal(await stored(page), null, 'nothing stored while off');
  // a scan while off stores nothing
  await page.fill('#address', token);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])');
  await page.waitForTimeout(300);
  assert.equal(await stored(page), null);
  // on: the privacy budget and what is sent are shown before anything happens
  await page.check('#fl-optin');
  await waitText(page, '#fl-privacy', /Used ε 0\.00 of 16/);
  assert.match(await text(page, '#fl-privacy'), /costs ε 5\.30; rounds left: 6/);
  await waitText(page, '#fl-sent', new RegExp(`${HEAD.dim} numbers, clipped to length 1, with Gaussian noise of size 2`));
  // scan again: now it is kept (features, pool and its liquidity at scan time)
  await page.click('#go');
  await page.waitForSelector(`#fl-list li[data-entry="bsc:${token}"]`);
  const s = await stored(page);
  const e = s.entries[0];
  assert.equal(e.id, `bsc:${token}`);
  assert.equal(e.sim0, 'done');
  assert.ok(e.pair && /^0x[0-9a-f]{40}$/.test(e.pair), 'pool kept');
  assert.equal(e.liq0, (10n ** 20n).toString(), 'native side of the pool at scan time');
  assert.ok(Object.keys(e.f).length > 10, 'feature vector kept');
  assert.match(await text(page, `#fl-list li[data-entry="bsc:${token}"]`), /Automatic: not read again yet/);
  // labelled after the fact
  await page.click(`#fl-list li[data-entry="bsc:${token}"] button[data-v="1"]`);
  assert.equal((await stored(page)).entries[0].user, 1);
  await waitText(page, `#fl-list li[data-entry="bsc:${token}"]`, /You: scam.*Used for training as: scam/);
  // the round contract exists but is closed (paused) until governance opens it
  await waitText(page, '#fl-round', new RegExp(en.closed));
  clients.push(c0);
});

test('a record with no contract: "not deployed yet", nothing to send', async () => {
  const c = await client(1, { deployed: false });
  await waitText(c.page, '#fl-round', /^Not deployed yet/);
  assert.equal(await c.page.isHidden('#fl-train'), true);
  assert.equal(await c.page.isHidden('#fl-reveal'), true);
  assert.equal(await c.page.$$eval('#fl-wallets button', (b) => b.length), 0);
  assert.ok(c.log.requests.every((r) => !r.url.startsWith(FL_RPC)), 'no round reads without a contract');
  assert.deepEqual(c.errors, []);
  await c.page.close();
});

test('a whole round: five browsers train in a Worker, commit and reveal through their wallets; the aggregator accepts them', async () => {
  for (let i = 1; i < N; i++) clients.push(await client(i));
  // governance opens the contract; the round starts
  await fl.sendTx({ from: GOV, to: rounds, data: '0x' + SEL.setPaused + '0'.repeat(64) });
  while (fl.blockNumber() < BigInt((await fl.request('eth_call', [{ to: rounds, data: '0x' + selectorOf('start()') }, 'latest']))) + 1n) fl.mine(1);
  for (const { page } of clients) {
    await refreshUntil(page, /Round 0: commit phase/);
    await page.click('#fl-wallets button');
    await waitText(page, '#fl-wallets', /Wallet: 0x/);
    await page.click('#fl-train');
    await waitText(page, '#fl-status', /Committed for round 0/, 60_000);
    assert.match(await text(page, '#fl-privacy'), /Used ε 5\.30 of 16/, 'budget spent once');
    await waitText(page, '#fl-mine', /committed, reveal pending/);
    assert.match(await text(page, '#fl-preview'), new RegExp(`Update: ${HEAD.dim} numbers`));
  }
  // a second update in the same round is refused (one per address; one per round in the ledger)
  await clients[1].page.click('#fl-train');
  await waitText(clients[1].page, '#fl-status', /Already submitted/);
  assert.match(await text(clients[1].page, '#fl-privacy'), /Used ε 5\.30/, 'not spent twice');
  // reveal phase
  const start = BigInt(await fl.request('eth_call', [{ to: rounds, data: '0x' + selectorOf('start()') }, 'latest']));
  while (fl.blockNumber() < start + 80n) fl.mine(1);
  for (const { page } of clients) {
    await refreshUntil(page, /Round 0: reveal phase/);
    await page.click('#fl-reveal');
    await waitText(page, '#fl-status', /Revealed for round 0/, 60_000);
    await waitText(page, '#fl-mine', /: revealed/);
    const s = await stored(page);
    assert.equal(s.pending.salt, undefined, 'salt and payload dropped after the reveal');
    assert.equal(s.pending.payload, undefined);
  }
  while (fl.blockNumber() < start + 160n) fl.mine(1);

  // the round on chain: 5 Revealed events, each an NFL1 update on the committed head
  const revealedTopic = '0x' + [...(await import('../src/keccak.js')).keccak256(new TextEncoder().encode('Revealed(uint256,address,bytes32,bytes)'))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const logs = fl.logs.filter((l) => l.address === rounds && l.topics[0] === revealedTopic);
  assert.equal(logs.length, N);
  const subs = logs.map((l) => {
    const d = l.data.slice(2);
    const len = Number(BigInt('0x' + d.slice(128, 192)));
    const bytes = Uint8Array.from(d.slice(192, 192 + len * 2).match(/../g), (x) => parseInt(x, 16));
    return { sender: '0x' + l.topics[2].slice(26), bytes };
  });
  assert.deepEqual(subs.map((s) => s.sender).sort(), [...ACCTS].sort());
  for (const s of subs) {
    const u = decodeUpdate(s.bytes);
    assert.equal(u.headHash, HEAD.hash);
    assert.equal(u.round, 0);
    assert.equal(u.values.length, HEAD.dim);
    assert.equal(s.bytes.length, 50 + 4 * HEAD.dim, 'the update and nothing else');
  }
  const res = aggregateRound(subs, { headHash: HEAD.hash, round: 0, dim: HEAD.dim, clip: 1, z: 2 }, { minUpdates: N });
  assert.equal(res.accepted.length, N, JSON.stringify(res.rejected));
  assert.equal(res.delta.length, HEAD.dim);

  // the real aggregator script over JSON-RPC (ethers), when zetaphy-network is installed
  const script = fileURLToPath(new URL('../../zetaphy-network/scripts/fl-aggregate.js', import.meta.url));
  if (existsSync(fileURLToPath(new URL('../../zetaphy-network/node_modules/ethers/package.json', import.meta.url)))) {
    const dir = mkdtempSync(join(tmpdir(), 'fl-e2e-'));
    try {
      // async: the JSON-RPC server it reads runs in this process
      const { stdout } = await promisify(execFile)(process.execPath, [script, '--rpc', `http://127.0.0.1:${RPC_PORT}`, '--rounds', rounds, '--min-updates', String(N), '--out', dir], { encoding: 'utf8', timeout: 120_000 });
      const out = JSON.parse(stdout.trim().split('\n').at(-1));
      assert.equal(out.round, 0, 'the last finished round');
      assert.equal(out.accepted, N);
      assert.equal(out.rejected, 0);
      const decision = JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8'));
      assert.equal(decision.accepted, N);
      assert.ok(decision.candidate, 'a candidate head was computed (the gate then decides)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('nothing but the clipped and noised update left the browsers', async () => {
  for (const [ci, { log, errors, acct }] of clients.entries()) {
    assert.deepEqual(errors, []);
    const txs = log.wallet.filter((w) => w.method === 'eth_sendTransaction');
    assert.equal(txs.length, 2, 'one commit and one reveal');
    for (const t of txs) {
      assert.equal(t.params[0].to.toLowerCase(), rounds);
      assert.equal(t.params[0].from.toLowerCase(), acct);
      assert.ok([SEL.commit, SEL.reveal].includes(t.params[0].data.slice(2, 10)));
    }
    const other = log.wallet.filter((w) => !['eth_sendTransaction', 'eth_getTransactionReceipt'].includes(w.method));
    assert.deepEqual(other, [], 'the wallet is used only to send and to wait');
    for (const r of log.requests) {
      const u = new URL(r.url);
      if (u.origin === `http://127.0.0.1:${PORT}`) { assert.ok(r.method === 'GET' || u.pathname.startsWith('/api/'), r.url); continue; }
      if (r.method === 'GET') { assert.equal(ci, 0, `only the scanning browser reads other sites: ${r.url}`); continue; } // the scan's verified-source lookup
      const m = JSON.parse(r.body || '{}').method;
      if (r.url.startsWith(FL_RPC)) { assert.ok(['eth_call', 'eth_blockNumber'].includes(m), `round node: ${m}`); assert.ok(!r.body.includes(token.slice(2)), 'no token address to the round node'); continue; }
      // the scan's own reads (client 0 only): public chain data on the scanned chain
      assert.equal(ci, 0, `${r.url} ${m}`);
      assert.ok(['eth_chainId', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_gasPrice', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount'].includes(m), `${r.url} ${m}`);
    }
  }
  // stored labels never appear in any request body
  const s = await stored(clients[2].page);
  const anyAddr = s.entries[0].address.slice(2);
  assert.ok(clients.every(({ log }) => log.requests.every((r) => !r.body.includes(anyAddr) && !r.body.includes('neuro-fl'))));
});

test('the panel follows the page language (8 languages)', async () => {
  const { page } = clients[0];
  for (const l of ['th', 'zh', 'es', 'ko', 'ja', 'ru', 'vi']) {
    await page.selectOption('#lang', l);
    assert.equal(await text(page, '#fl-title'), FL_TEXT[l].title, l);
    assert.equal(await text(page, '#fl-train'), FL_TEXT[l].train, l);
  }
  await page.selectOption('#lang', 'id');
  assert.equal(await text(page, '#fl-title'), en.title, 'Indonesian: English panel');
  for (const ctx of contexts) await ctx.close();
});
