// Browser test of the Quantum safety tab under the site's real CSP: a fake node answers the security RPCs, the
// explorer's exposure inputs and a QuantumRescue contract. The tab shows the readiness score from the inventory and the
// Q-day height, checks an exposed MetaMask address (rescue state read from the contract), a quantum-locked one and an
// ML-DSA-44 account, and works in Thai. It loads the explorer's quantum.js and Neuro's Keccak from this site.
//   npm run build && node --test test/quantum.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Interface } from 'ethers';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { summary } from '../../zetaphy-network/src/qsafe/inventory.js';
import { toBech32 as toB32 } from '../chainlib.js'; // bech32 of a 0x address, as the page sends it

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const RESCUE = new Interface(JSON.parse(readFileSync(join(HERE, '..', '..', 'zetaphy-network', 'artifacts', 'QuantumRescue.json'), 'utf8')).abi);
const RA = '0x' + 'a7'.repeat(20);
const EXPOSED = '0x' + '11'.repeat(20), LOCKED = '0x' + '22'.repeat(20), PQ = '0x' + '33'.repeat(20);
const Z = '0x' + '00'.repeat(32);

function rpc(method, params) {
  switch (method) {
    case 'zetaphy_securityStatus': return { qdayHeight: 5000000, qdayActive: false, latestHeight: 4000000, revealDelay: 720 };
    case 'zetaphy_pqAccount': {
      const who = String(params[0]);
      return { exists: true, pubKeyType: who === 'pq' ? 'mldsa44' : 'eth_secp256k1', sequence: '4', quantumLockedTo: who === 'locked' ? 'zetaphy1controller' : '' };
    }
    case 'eth_getTransactionCount': return params[0].toLowerCase() === PQ ? '0x0' : '0x4';
    case 'eth_getCode': return '0x';
    case 'zetaphy_migration': return { migrated: false };
    case 'eth_blockNumber': return '0x3d0900';
    default: return undefined;
  }
}
function rescueCall({ to, data }) {
  if (to.toLowerCase() !== RA) return null;
  const fn = RESCUE.getFunction(data.slice(0, 10));
  const out = (v) => RESCUE.encodeFunctionResult(fn, v);
  switch (fn.name) {
    case 'slotOf': return out([Z, Z, 0n]);
    case 'effectiveCommitment': return out([Z]);
    case 'controllerOf': return out(['0x' + '00'.repeat(20)]);
    case 'qdayHeight': return out([5000000n]);
    case 'maturity': return out([720n]);
    default: throw new Error(`not mocked: ${fn.name}`);
  }
}

test('Quantum tab: readiness, Q-day, exposure check with rescue state, Thai', { timeout: 180_000 }, async () => {
  const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
  assert.equal(cfg.qsafe?.score, summary().score, 'build.mjs wrote the inventory summary');
  cfg.contracts = { ...cfg.contracts, quantumRescue: RA };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('https://rpc.sawasdeecoin.com/**', async (route) => {
      const body = route.request().postData() ?? '';
      const req = (() => { try { return JSON.parse(body); } catch { return null; } })();
      let a = null;
      if (req?.method === 'eth_call') {
        try { const r = rescueCall(req.params[0]); if (r) a = { jsonrpc: '2.0', id: req.id, result: r }; } catch (e) { a = { jsonrpc: '2.0', id: req.id, error: { code: 3, message: e.message } }; }
      } else if (req?.method) {
        // zetaphy_pqAccount takes a bech32 address: tell the three test accounts apart by their 0x form
        const p = req.method === 'zetaphy_pqAccount' ? [{ [toB32(EXPOSED)]: 'exposed', [toB32(LOCKED)]: 'locked', [toB32(PQ)]: 'pq' }[req.params[0]] ?? '?'] : req.params;
        const r = rpc(req.method, p);
        if (r !== undefined) a = { jsonrpc: '2.0', id: req.id, result: r };
      }
      a ??= answer(route.request().url(), body);
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${site.url}?tab=quantum`);
    assert.ok(await page.$('.tab[data-tab="quantum"]'), 'listed with the tabs');
    await page.waitForSelector('#qs-score');
    assert.match(await page.textContent('#qs-score'), new RegExp(`${summary().score}/100`));
    assert.ok((await page.$$('#qs-open li')).length > 0);
    await page.waitForFunction(() => /5000000/.test(document.querySelector('#qs-qday')?.textContent ?? ''));
    assert.equal(await page.$('#qs-not-deployed'), null, 'the rescue contract is configured');

    await page.fill('#qs-addr', EXPOSED);
    await page.click('#qs-check-go');
    await page.waitForSelector('#qs-check-out[data-level="exposed"]');
    assert.equal(await page.getAttribute('#qs-check-out', 'data-step'), 'rescue');
    assert.match(await page.textContent('#qs-rescue-state'), /No rescue commitment/);

    await page.fill('#qs-addr', LOCKED);
    await page.click('#qs-check-go');
    await page.waitForSelector('#qs-check-out[data-level="locked"]');
    assert.equal(await page.getAttribute('#qs-check-out', 'data-step'), 'safe');

    await page.fill('#qs-addr', PQ);
    await page.click('#qs-check-go');
    await page.waitForSelector('#qs-check-out[data-level="pq"]');

    await page.fill('#qs-addr', 'nope');
    await page.click('#qs-check-go');
    await page.waitForFunction(() => /0x… or zetaphy1…/.test(document.querySelector('#qs-check-out')?.textContent ?? ''));

    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => /ความพร้อมของเครือข่ายรับ Q-day/.test(document.querySelector('.page-quantum')?.textContent ?? ''));
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'quantum.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); site.close(); }
});
