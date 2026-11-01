// Browser test of the assistant pages under the site's real CSP: Governance (a proposal decoded, diffed and flagged),
// Immunity (coverage "not deployed yet", the PQ archive verified in the browser with the wallet's ML-DSA bundle, a
// tampered one refused) and the signing summary's simulation section (wallet-safety.js confirmTx simulate hook).
//   npm run build && node --test test/assist.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { buildArchive } from '../pqattest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;

const PROPOSALS = { proposals: [{ id: '9', title: 'Shorter unbonding', voting_end_time: '2026-11-03T00:00:00Z',
  messages: [{ '@type': '/cosmos.staking.v1beta1.MsgUpdateParams', params: { unbonding_time: '300s', max_validators: 100 } }] }] };

async function open(browser, site, path) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (new URL(u).origin === new URL(site.url).origin) {
      // the immune dashboard's "planned" state (no registry): the built config now names the live testnet registry
      if (new URL(u).pathname === '/hub-config.json') {
        const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
        if (cfg.immuneNet) cfg.immuneNet = { ...cfg.immuneNet, registry: null, broadcaster: null };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cfg) });
      }
      return route.continue();
    }
    const p = new URL(u);
    let a = null;
    if (p.origin === 'https://rpc.sawasdeecoin.com') {
      if (p.pathname === '/rest/cosmos/gov/v1/proposals') a = p.searchParams.get('proposal_status') === 'PROPOSAL_STATUS_VOTING_PERIOD' ? PROPOSALS : { proposals: [] };
      else if (p.pathname === '/rest/cosmos/staking/v1beta1/params') a = { params: { unbonding_time: '1814400s', max_validators: 100 } };
      else if (/"eth_getLogs"/.test(route.request().postData() ?? '')) a = { jsonrpc: '2.0', id: 1, result: [] };
      else a = answer(u, route.request().postData());
    }
    if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  await page.goto(`${site.url}${path}`);
  return { page, errors };
}

test('assistant pages: governance flags, immunity (coverage, PQ verifier), the signing summary\'s simulation', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    let { page, errors } = await open(browser, site, '?tab=gov');
    await page.waitForSelector('[data-proposal="9"]');
    assert.match(await page.textContent('[data-proposal="9"]'), /unbonding_time[\s\S]*1814400s[\s\S]*300s/);
    assert.ok(await page.$('[data-proposal="9"] [data-flag="shorterUnbonding"]'), 'flagged');
    await page.waitForFunction(() => !/…/.test(document.querySelector('#ga-queue')?.textContent ?? '…'));
    assert.match(await page.textContent('#ga-queue'), /Nothing queued/, 'the launch\'s timelock, empty queue');
    await page.selectOption('#lang', 'th');
    await page.waitForSelector('[data-proposal="9"] [data-flag="shorterUnbonding"]');
    assert.match(await page.textContent('[data-proposal="9"] [data-flag="shorterUnbonding"]'), /ถอน/);
    assert.deepEqual(errors, []);
    await page.close();

    ({ page, errors } = await open(browser, site, '?tab=immune'));
    await page.waitForSelector('#im-cov p');
    assert.match(await page.textContent('#im-cov'), /not deployed/);
    // the immune network dashboard: planned (no registry yet), simulated latency, the open feed's links
    await page.waitForSelector('#im-net [data-immune="planned"]');
    assert.match(await page.textContent('#im-net'), /Chains watched[\s\S]*Mirrors live[\s\S]*0 \/ 0[\s\S]*simulated[\s\S]*rss\.xml/);
    // a quantum-safe archive signed here with the same bundle, then verified in the page; then a tampered copy
    const pq = await import('../../zetaphy-wallet/vendor/pqwallet.js');
    const k = pq.ml_dsa44.keygen(new Uint8Array(32).fill(9));
    const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
    const archive = await buildArchive({ kind: 'neuro-report', createdAt: '2026-10-28T00:00:00Z', subject: { chain: 'eth', address: '0xabc' }, reportHash: '0x' + '11'.repeat(32), skill: '0x01', model: 'rules' },
      k.publicKey, { sha256: sha, keccak256: (b) => pq.keccak_256(b), sign: (m) => pq.ml_dsa44.sign(m, k.secretKey) });
    const dir = mkdtempSync(join(tmpdir(), 'pq-e2e-'));
    writeFileSync(join(dir, 'ok.pq.json'), JSON.stringify(archive));
    writeFileSync(join(dir, 'bad.pq.json'), JSON.stringify({ ...archive, payload: { ...archive.payload, model: 'other' } }));
    await page.setInputFiles('#im-pq-file', join(dir, 'ok.pq.json'));
    await page.waitForSelector('#im-pq [data-pq]');
    assert.equal(await page.getAttribute('#im-pq [data-pq]', 'data-pq'), 'valid', await page.textContent('#im-pq'));
    await page.setInputFiles('#im-pq-file', join(dir, 'bad.pq.json'));
    await page.waitForFunction(() => document.querySelector('#im-pq [data-pq]')?.dataset.pq === 'invalid');
    assert.match(await page.textContent('#im-pq'), /payload changed/);
    await page.fill('#im-addr', '0x' + '12'.repeat(20));
    await page.click('#im-cert-form button');
    await page.waitForFunction(() => document.querySelector('#im-cert')?.textContent.length > 0);
    // with NeuroAttest in the hub's config (the live testnet one), an address with no certificate; without it, "not deployed"
    const attest = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8')).contracts?.neuroAttest;
    assert.match(await page.textContent('#im-cert'), attest ? /No certificate for this address/ : /not deployed/);
    // the signing summary with a simulation hook (what hub.js send() passes from presign.js)
    await page.evaluate(async () => {
      const m = await import('./wallet-safety.js');
      window.__r = m.safety({ win: window }).confirmTx({ network: 'ZETAPHY (77390)', from: '0x' + '01'.repeat(20), to: '0x' + '02'.repeat(20), data: '0xa9059cbb',
        simulate: async () => ({ rows: [['Your tUSD', '−25 tUSD']], warnings: [], note: 'simulated' }), explain: async () => 'Sends 25 tUSD.' });
    });
    await page.waitForSelector('[data-ws="sim"] .ws-v');
    assert.match(await page.textContent('[data-ws="sim"]'), /−25 tUSD[\s\S]*simulated/);
    await page.click('[data-ws="explain"]');
    await page.waitForSelector('[data-ws="ai-text"]');
    assert.equal(await page.textContent('[data-ws="ai-text"]'), 'Sends 25 tUSD.');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); site.close(); }
});
