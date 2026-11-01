// Browser test of the "On-chain AI" tab under the site's real CSP: with NeuroScore and ModelEpochs in hub-config.json
// (answered by a fake node) their cards read live and a token's score is shown; the contracts not deployed say so;
// the words follow the language; the AI map turns those two items to "works now" and opens the tab.
//   npm run build && node --test test/aichain.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { AbiCoder } from 'ethers';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { SEL } from '../aichain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const abi = AbiCoder.defaultAbiCoder();
const NS = '0x' + '51'.repeat(20), ME = '0x' + '3e'.repeat(20);
const H = '0x' + '77'.repeat(32);

/** eth_call answers of the two deployed contracts (null: not ours). */
function contractCall({ to, data }) {
  const is = (s) => data.startsWith(SEL[s]);
  if (to?.toLowerCase() === NS) {
    if (is('version')) return abi.encode(['uint32'], [1]);
    if (is('model')) return abi.encode(['bytes32', 'bytes32', 'uint16', 'int64', 'int64', 'int64', 'uint64'], [H, '0x' + Buffer.from('nml-e2e').toString('hex').padEnd(64, '0'), 12, -20_000_000n, 0n, 20_000_000n, 1_761_782_400]);
    if (is('scoreOf')) return abi.encode(['bool', 'int256', 'uint8'], [true, 5_000_000n, 2]);
    if (is('scoreRecord')) return abi.encode(['int64', 'uint32', 'uint8', 'uint64', 'bytes32'], [5_000_000n, 1, 2, 1_761_782_400, '0x' + '88'.repeat(32)]);
  }
  if (to?.toLowerCase() === ME) {
    if (is('current')) return abi.encode(['bool', 'uint256', 'bytes32', 'uint64', 'string'], [true, 0, H, 100_000, 'ipfs://manifest-one']);
    if (is('count')) return abi.encode(['uint256'], [2]);
    if (is('epochLength')) return abi.encode(['uint64'], [1000]);
    if (is('minDelay')) return abi.encode(['uint64'], [100]);
    if (is('versionByIndex')) return abi.encode(['bytes32', 'uint64', 'uint64', 'string'], ['0x' + '99'.repeat(32), 200_000, 120_000, 'ipfs://manifest-two']);
  }
  return null;
}

async function open(browser, site, path) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    const p = new URL(u);
    if (p.origin === new URL(site.url).origin) {
      if (p.pathname !== '/hub-config.json') return route.continue();
      const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
      cfg.contracts = { ...cfg.contracts, neuroScore: NS, modelEpochs: ME };
      // the "not deployed" cards: removed even when the built config names the live testnet contracts
      for (const k of ['cosignCommittee', 'hackInsurance', 'usefulIssuance', 'neuroOracleSender', 'circuitBreaker']) delete cfg.contracts[k];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cfg) });
    }
    let a = null;
    if (p.origin === 'https://rpc.sawasdeecoin.com') {
      const body = route.request().postData() ?? '';
      const req = (() => { try { return JSON.parse(body); } catch { return null; } })();
      const mine = req?.method === 'eth_call' ? contractCall(req.params[0]) : null;
      a = mine ? { jsonrpc: '2.0', id: req.id, result: mine } : answer(u, body);
    }
    if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  await page.goto(`${site.url}${path}`);
  return { page, errors };
}

test('On-chain AI tab: live cards, not-deployed cards, a token score, 8 languages, the AI map', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const { page, errors } = await open(browser, site, '?tab=aichain');
    assert.ok(await page.$('.tab[data-tab="aichain"]'), 'listed with the tabs');
    await page.waitForSelector('.ac-state[data-for="modelEpochs"][data-state="live"]');
    const ep = await page.textContent('#ac-epochs');
    assert.match(ep, /In force now[\s\S]*#0/);
    assert.match(ep, /block 100,000/);
    assert.match(ep, /Next[\s\S]*#1[\s\S]*block 200,000/);
    await page.waitForSelector('.ac-state[data-for="neuroScore"][data-state="live"]');
    assert.match(await page.textContent('#ac-score'), /v1 · nml-e2e/);
    for (const k of ['cosignCommittee', 'hackInsurance', 'usefulIssuance']) assert.ok(await page.$(`.ac-state[data-for="${k}"] [data-state="not-deployed"]`), `${k}: not deployed`);
    assert.ok(await page.$('#ac-oracle [data-state="not-deployed"]'));
    assert.ok(await page.$('.ac-state[data-for="circuitBreaker"] [data-state="not-deployed"]'), 'self-healing: not deployed');
    assert.match(await page.textContent('#ac-heal h2'), /^Self-healing$/);
    // a token's score: a free read
    await page.fill('#ac-token', '0x' + '12'.repeat(20));
    await page.click('#ac-score-form button');
    await page.waitForSelector('#ac-score-out [data-level]');
    assert.equal(await page.getAttribute('#ac-score-out [data-level]', 'data-level'), 'medium');
    assert.match(await page.textContent('#ac-score-out'), /Risk medium \(62\.2%/);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'aichain.png'), fullPage: true });
    // a FROST check on a committee that is not deployed: said plainly
    await page.fill('#ac-digest', '0x' + '11'.repeat(32));
    await page.fill('#ac-sig', '0x02' + '22'.repeat(64));
    await page.click('#ac-frost-form button');
    await page.waitForFunction(() => document.querySelector('#ac-frost-out')?.textContent.length > 0);
    assert.match(await page.textContent('#ac-frost-out'), /Not deployed yet/);
    // Thai
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => /ยังไม่ได้ deploy/.test(document.querySelector('#ac-ins')?.textContent ?? ''));
    await page.waitForSelector('.ac-state[data-for="modelEpochs"][data-state="live"]');
    assert.match(await page.textContent('#ac-epochs'), /รุ่นที่ใช้อยู่/);
    await page.selectOption('#lang', 'en');
    // the AI map: deployed items work now, the others wait; "Open" goes to the tab
    await page.click('.tab[data-tab="ai"]');
    await page.waitForSelector('#ai-35');
    assert.equal(await page.getAttribute('#ai-3', 'data-s'), 'live');
    assert.equal(await page.getAttribute('#ai-35', 'data-s'), 'live');
    assert.equal(await page.getAttribute('#ai-14', 'data-s'), 'notDeployed');
    assert.equal(await page.getAttribute('#ai-18', 'data-s'), 'notDeployed');
    assert.equal(await page.$('.am-chip[data-s="cli"]'), null, 'no empty "command line" chip');
    await page.click('#ai-32 .am-actions button');
    await page.waitForFunction(() => /[?&]tab=aichain/.test(location.search));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); site.close(); }
});
