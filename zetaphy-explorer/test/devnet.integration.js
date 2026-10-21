// The explorer against a real single-validator ZETAPHY devnet (zetaphy-network/
// scripts/devnet.sh, EVM JSON-RPC + CometBFT RPC + Cosmos REST), in Chromium:
//   - vote extensions are switched on and the validator registers its ML-DSA-44
//     vote key (MsgPQVoteKey), so blocks carry real certificates (Go's CIRCL signs,
//     the page verifies with @noble/post-quantum)
//   - an EVM transfer, an ERC-20 (zetaphy-network's TestStable) deploy + transfer,
//     and a ThreatRegistry (zetaphy-network's artifact) in which two runners flag the
//     token's address: the page must show the flag, its evidence and the disclaimer
//   - pages: home, block + certificate, EVM tx with the decoded Transfer, Cosmos tx
//     (MsgPQVoteKey), address (both forms), token, validators (vote key registered)
// The browser reaches the devnet through Playwright routes (https://devnet.zetaphy.test
// -> 127.0.0.1), exactly as it would reach a node behind Caddy.
// Needs /tmp/ci-test/zetaphyd-v4 (or ZETAPHYD); run it only under the shared lock:
//   npm run test:devnet     (= flock /tmp/ci-test/devnet.lock node --test test/devnet.integration.js)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, NonceManager, parseEther, id as ethId } from 'ethers';
import { addressKey, toBech32, hexToBytes } from '../vendor/zetaphy-lib.js';

const ZETAPHYD = process.env.ZETAPHYD || '/tmp/ci-test/zetaphyd-v4';
const BASE = 23545; // EVM 23545, WS +1, CometBFT +100, P2P +101, gRPC +102, REST +103
const EVM = `http://127.0.0.1:${BASE}`; const COMET = `http://127.0.0.1:${BASE + 100}`; const REST = `http://127.0.0.1:${BASE + 103}`;
const NODE = 'https://devnet.zetaphy.test';
const PORT = 18197;
const NETWORK = new URL('../../zetaphy-network/', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'zetaphy-explorer-devnet-'));
const HOME = join(root, 'chain');
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ZETAPHYD };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const funder = new Wallet('0x' + '5a'.repeat(32));
const runnerA = new Wallet('0x' + '6b'.repeat(32));
const runnerB = new Wallet('0x' + '7c'.repeat(32));
const RECIPIENT = new Wallet('0x' + '8d'.repeat(32)).address;
const artifact = (n) => JSON.parse(readFileSync(new URL(`artifacts/${n}.json`, NETWORK), 'utf8'));
let server; let browser; let provider; let chainId;
const facts = {};

const pid = () => { try { return Number(readFileSync(join(HOME, 'node.pid'), 'utf8')); } catch { return 0; } };
const stop = () => { const p = pid(); if (p) { try { process.kill(p); } catch { /* gone */ } } };
process.on('exit', stop);

async function comet(method, params = {}) {
  const r = await fetch(COMET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data || j.error.message);
  return j.result;
}
const height = async () => Number((await comet('status')).sync_info.latest_block_height);
async function waitHeight(h, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { try { if (await height() >= h) return; } catch { /* starting */ } }
  throw new Error(`the devnet did not reach block ${h}`);
}

before(async () => {
  // 1. devnet.sh: EVM JSON-RPC, CometBFT RPC and REST, our accounts funded at genesis
  execFileSync(new URL('scripts/devnet.sh', NETWORK).pathname, [HOME, String(BASE), funder.address, runnerA.address, runnerB.address],
    { stdio: 'inherit', env: { ...env, REST: '1', PQ: '1' } });
  // 2. ML-DSA-44 vote signatures need vote extensions from block 1 (devnet.sh leaves them off):
  //    restart the same chain from genesis with them on, then register the validator's vote key.
  stop(); await sleep(2000);
  execFileSync(ZETAPHYD, ['comet', 'unsafe-reset-all', '--home', HOME], { env, stdio: 'ignore' });
  const g = join(HOME, 'config', 'genesis.json');
  const genesis = JSON.parse(readFileSync(g, 'utf8'));
  genesis.consensus.params.abci = { ...(genesis.consensus.params.abci ?? {}), vote_extensions_enable_height: '1' };
  writeFileSync(g, JSON.stringify(genesis));
  writeFileSync(join(HOME, 'config', 'pq_vote_key.seed'), Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255)).toString('hex'), { mode: 0o600 });
  chainId = genesis.chain_id;
  const node = spawn(ZETAPHYD, ['start', '--home', HOME, '--chain-id', chainId, '--json-rpc.api', 'eth,net,web3,txpool,zetaphy'], { env, stdio: ['ignore', 'ignore', 'ignore'], detached: false });
  writeFileSync(join(HOME, 'node.pid'), String(node.pid));
  await waitHeight(3);
  const out = JSON.parse(execFileSync(ZETAPHYD, ['tx', 'pq-vote-key', '--from', 'validator', '--keyring-backend', 'test', '--home', HOME, '--chain-id', chainId,
    '--node', `tcp://127.0.0.1:${BASE + 100}`, '--gas', '600000', '--gas-prices', '1000000000azetaphy', '-y', '-o', 'json'], { env }).toString());
  assert.equal(out.code, 0, out.raw_log);
  facts.voteKeyTx = out.txhash.toUpperCase();
  for (const end = Date.now() + 30_000; Date.now() < end && !facts.voteKeyHeight; await sleep(500)) {
    try { facts.voteKeyHeight = Number((await comet('tx', { hash: Buffer.from(out.txhash, 'hex').toString('base64') })).height); } catch { /* not yet */ }
  }
  assert.ok(facts.voteKeyHeight, 'the vote key tx is in a block');
  // 3. EVM activity: a plain transfer, an ERC-20 deploy + transfer, a ThreatRegistry that flags the token
  provider = new JsonRpcProvider(EVM, undefined, { staticNetwork: true, polling: true, pollingInterval: 300 });
  // nonces counted here: the node's pending nonce can lag right after a receipt
  const signer = new NonceManager(funder.connect(provider));
  const pay = await signer.sendTransaction({ to: RECIPIENT, value: parseEther('1.25') });
  facts.payTx = (await pay.wait()).hash;
  const st = artifact('TestStable');
  const token = await new ContractFactory(st.abi, st.bytecode, signer).deploy('Devnet Baht', 'dTHB');
  await token.waitForDeployment();
  facts.token = await token.getAddress();
  await (await token.faucet()).wait();
  const tr = await token.transfer(RECIPIENT, 12345n * 10n ** 4n);
  facts.tokenTx = (await tr.wait()).hash;
  facts.tokenTxBlock = (await provider.getTransactionReceipt(facts.tokenTx)).blockNumber;
  // runners: a stub whose workers(address) says (bond 0, unbondAt 0, active, agreed 100, rejected 0) for anyone
  const stub = await signer.sendTransaction({ data: '0x600f80600b6000396000f3' + '6001604052606460605260a06000f3' });
  const runners = (await stub.wait()).contractAddress;
  const tr2 = artifact('ThreatRegistry');
  const reg = await new ContractFactory(tr2.abi, tr2.bytecode, signer).deploy(runners, 2, 0, funder.address, 0);
  await reg.waitForDeployment();
  facts.registry = await reg.getAddress();
  const key = addressKey(77390, facts.token.toLowerCase());
  facts.report = ethId('neuro report of the devnet token');
  for (const r of [runnerA, runnerB]) {
    const c = new Contract(facts.registry, tr2.abi, new NonceManager(r.connect(provider)));
    await (await c.vote(key, true, 2, facts.report, 'ipfs://devnet-report')).wait();
  }
  const [flagged, reason] = await new Contract(facts.registry, tr2.abi, provider).isFlagged(key);
  assert.equal(flagged, true); assert.equal(Number(reason), 2);
  await waitHeight((await height()) + 2); // the last blocks get their certificates

  // 4. the site, configured for the devnet
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ node: NODE, threatRegistry: facts.registry, neuroReportUrl: 'https://neuro.example/?address={address}', scanBlocks: 200 }));
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', cwd: new URL('..', import.meta.url), env: { ...process.env, EXPLORER_CONFIG: cfg } });
  await new Promise((r) => server.stdout.once('data', r));
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }); }
});

after(async () => {
  await browser?.close(); server?.kill(); provider?.destroy();
  const p = pid(); stop();
  const alive = () => { try { process.kill(p, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && p && alive(); i++) await sleep(250);
  if (p && alive()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function openPage(lang = 'en') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  // https://devnet.zetaphy.test/ -> EVM, /rpc/ -> CometBFT, /rest/ -> REST (what Caddy does on a real node)
  await ctx.route((u) => u.host === 'devnet.zetaphy.test', async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const target = u.pathname.startsWith('/rpc/') ? COMET + u.pathname.slice(4) : u.pathname.startsWith('/rest/') ? REST + u.pathname.slice(5) + u.search : EVM + u.pathname;
    try {
      const r = await fetch(target, { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.method() === 'POST' ? req.postData() : undefined });
      return route.fulfill({ status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: await r.text() });
    } catch (e) { return route.fulfill({ status: 502, headers: CORS, body: String(e.message) }); }
  });
  await page.addInitScript((l) => localStorage.setItem('zetaphy-explorer:lang', l), lang);
  return { page, ctx, problems };
}
const text = (page) => page.locator('main').innerText();
async function waitText(page, s, timeout = 30000) {
  try { await page.waitForFunction((x) => document.querySelector('main')?.innerText.includes(x), s, { timeout }); } catch {
    throw new Error(`"${s}" never appeared on ${page.url()}:\n${(await text(page).catch(() => '?')).slice(0, 3000)}`);
  }
}

test('devnet: home, blocks with real ML-DSA-44 certificates verified in the browser', async () => {
  const { page, ctx, problems } = await openPage();
  await page.goto(`http://localhost:${PORT}/#/`);
  await waitText(page, 'No indexer');
  await waitText(page, 'of the power has a PQ vote key');
  const t = await text(page);
  assert.match(t, new RegExp(chainId));
  assert.match(t, /100\.0% of the power has a PQ vote key/);
  assert.match(t, /ZETAPHY/);
  assert.match(t, /EVM/); // the EVM txs of the scan
  // a block after the key registration: a real certificate, verified with @noble/post-quantum
  const h = facts.tokenTxBlock;
  await page.goto(`http://localhost:${PORT}/#/block/${h}`);
  await waitText(page, 'Certificate valid · more than 2/3 of all power signed with ML-DSA-44');
  const tb = await text(page);
  assert.match(tb, /PQ certificate/); assert.match(tb, new RegExp(`certifies block ${(h - 1).toLocaleString('en-US')}`));
  assert.ok(await page.locator(`main a[href="#/tx/${facts.tokenTx}"]`).count() === 1, 'the block lists the EVM hash of its MsgEthereumTx');
  // before the key: nothing required, no certificate
  await page.goto(`http://localhost:${PORT}/#/block/1`);
  await waitText(page, 'No certificate');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('devnet: EVM txs (ZETAPHY transfer, ERC-20 transfer) and the Cosmos MsgPQVoteKey tx', async () => {
  const { page, ctx, problems } = await openPage();
  await page.goto(`http://localhost:${PORT}/#/tx/${facts.payTx}`);
  await waitText(page, '1.25 ZETAPHY');
  assert.match(await text(page), /Success/);
  await page.goto(`http://localhost:${PORT}/#/tx/${facts.tokenTx}`);
  await waitText(page, 'dTHB');
  const t = await text(page);
  assert.match(t, /ERC-20/); assert.match(t, /123\.45 dTHB/); // 6 decimals
  await page.goto(`http://localhost:${PORT}/#/tx/${facts.voteKeyTx}`);
  await waitText(page, 'MsgPQVoteKey');
  const tv = await text(page);
  assert.match(tv, /Success/); assert.match(tv, /pub key/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('devnet: address in both forms, token page, ThreatRegistry flag, validators with a vote key', async () => {
  const { page, ctx, problems } = await openPage('th');
  const bech = toBech32(hexToBytes(RECIPIENT), 'zetaphy');
  await page.goto(`http://localhost:${PORT}/#/address/${bech}`);
  await waitText(page, 'ยอดโทเคน');
  await waitText(page, 'dTHB');
  const t = await text(page);
  assert.match(t, new RegExp(RECIPIENT)); assert.match(t, new RegExp(bech));
  assert.match(t, /1\.25 ZETAPHY/);
  await page.goto(`http://localhost:${PORT}/#/token/${facts.token}`);
  await waitText(page, 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา');
  const tt = await text(page);
  assert.match(tt, /Devnet Baht/); assert.match(tt, /ERC-20/);
  assert.match(tt, /ติดธง \(บังคับใช้แล้ว\)/); // enforceDelay 0
  assert.match(tt, /มีที่อยู่ที่สร้างเหรียญเพิ่มได้ไม่จำกัด/);
  assert.match(tt, new RegExp(facts.report)); assert.match(tt, /ipfs:\/\/devnet-report/);
  await page.goto(`http://localhost:${PORT}/#/address/${RECIPIENT}`);
  await waitText(page, 'ไม่ติดธง'); // a plain account, checked against the same registry
  await page.goto(`http://localhost:${PORT}/#/validators`);
  await waitText(page, 'ลงทะเบียนแล้ว');
  assert.match(await text(page), /100\.0%/);
  assert.deepEqual(problems, []);
  await ctx.close();
});
