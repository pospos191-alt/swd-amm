// Browser test: a proven Neuro verdict checked in the hub's Immunity card, in Chromium, under the site's real CSP
// (script-src 'self', no 'wasm-unsafe-eval', no worker): the committed fixture proof verifies in the page (timed), a
// forged one is refused, the text is in every language. The node is mocked (ProvenVerdicts + NeuroScore answers).
//   node --test test/zkverdict.e2e.mjs        (builds dist/ first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, AbiCoder, zeroPadValue } from 'ethers';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';
import { build } from '../build.mjs';
import { SEL, PROOF_DATA_TOPIC } from '../zkverdict-core.js';
import { evalFixed, fromHex, quantizeVector, packFeatures } from '../../zetaphy-neuro/ml/onchain/fixed.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FX = JSON.parse(read('../../zetaphy-network/test/fixtures/neuroscore-zk.json'));
const FIXED = JSON.parse(read('../../zetaphy-neuro/ml/onchain/model.fixed.json'));
const HELD = JSON.parse(read('../../zetaphy-neuro/ml/onchain/heldout.json'));
const PV_ABI = new Interface(JSON.parse(read('../../zetaphy-network/artifacts/ProvenVerdicts.json')).abi);
const CSP = JSON.parse(read('../vercel.json')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const PV = '0x' + '77'.repeat(20), SCORER = '0x' + '55'.repeat(20);
const GOOD = '0x' + '12'.repeat(20), FORGED = '0x' + '34'.repeat(20);

const row = HELD.rows.find((r) => r.id === FX.row);
const v = new Array(FIXED.features.length).fill(0);
for (const [i, x] of row.x) v[i] = x;
const q = quantizeVector(v);
const FEATURES = packFeatures(q);
const SCORE = BigInt(evalFixed(fromHex(FIXED.bytes), q).score);

function rpc(body) {
  const { method, params } = JSON.parse(body);
  const ok = (result) => ({ jsonrpc: '2.0', id: 1, result });
  if (method === 'eth_getLogs') {
    const id = BigInt(params[0].topics[1]);
    const x = id === 1n ? FX : FX.forged;
    const log = PV_ABI.encodeEventLog(PV_ABI.getEvent('ProofData'), [id, id === 1n ? GOOD : FORGED, x.a, x.b, x.c, FX.publicSignals[0], FX.publicSignals[1], FEATURES]);
    return ok([{ address: PV, topics: log.topics, data: log.data }]);
  }
  if (method === 'eth_call') {
    const { to, data } = params[0];
    if (to.toLowerCase() === PV && data.startsWith(SEL.verdictOf)) {
      const tok = '0x' + data.slice(-40);
      return ok(PV_ABI.encodeFunctionResult('verdictOf', [true, SCORE, 1, true, 3, false, tok === GOOD ? 1n : 2n]));
    }
    if (to.toLowerCase() === PV && data === SEL.scorer) return ok(zeroPadValue(SCORER, 32));
    if (to.toLowerCase() === SCORER && data.startsWith(SEL.modelBytes)) return ok(AbiCoder.defaultAbiCoder().encode(['bytes'], [FIXED.bytes]));
  }
  return null;
}

test('hub Immunity card: a proven verdict verified in the browser under the site CSP; a forged proof refused; 8 languages', { timeout: 180_000 }, async () => {
  const dist = build();
  const cfg = JSON.parse(readFileSync(`${dist}/hub-config.json`, 'utf8'));
  cfg.contracts = { ...(cfg.contracts ?? {}), provenVerdicts: PV };
  const site = await serve(dist, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to|WebAssembly/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (new URL(u).origin === new URL(site.url).origin) return route.continue();
      const body = route.request().postData() ?? '';
      const a = (body && rpc(body)) || (new URL(u).origin === 'https://rpc.sawasdeecoin.com' ? answer(u, body) : null);
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    await page.goto(`${site.url}?tab=immune`);
    await page.waitForSelector('#im-addr');
    await page.fill('#im-addr', GOOD);
    await page.click('#im-cert-form button');
    await page.waitForFunction(() => /^(proven|invalid|error)$/.test(document.querySelector('#im-proven [data-proven]:not([data-proven="checking"])')?.dataset.proven ?? ''), null, { timeout: 60_000 });
    const text = await page.textContent('#im-proven');
    assert.equal(await page.getAttribute('#im-proven [data-proven]', 'data-proven'), 'proven', text);
    assert.match(text, new RegExp(`Proven by model ${FIXED.modelId}`));
    assert.match(text, /rehearsal/, 'the testnet caveat is shown');
    assert.match(text, /another model and is not proven/);
    const ms = Number(/\((\d+) ms\)/.exec(text)[1]);
    console.log(`browser (Chromium, page under the site CSP) Groth16 verify: ${ms} ms`);
    // a forged proof (a valid proof under another key): refused, nothing claimed
    await page.fill('#im-addr', FORGED);
    await page.click('#im-cert-form button');
    await page.waitForFunction(() => document.querySelector('#im-proven [data-proven]')?.dataset.proven === 'invalid', null, { timeout: 60_000 });
    assert.match(await page.textContent('#im-proven'), /does NOT check out/);
    // every language
    for (const l of ['th', 'zh', 'es', 'ko', 'ja', 'ru', 'vi']) {
      await page.selectOption('#lang', l);
      await page.waitForSelector('#im-addr');
      await page.fill('#im-addr', GOOD);
      await page.click('#im-cert-form button');
      await page.waitForFunction(() => document.querySelector('#im-proven [data-proven]')?.dataset.proven === 'proven', null, { timeout: 60_000 });
      const t = await page.textContent('#im-proven');
      assert.match(t, new RegExp(FIXED.modelId), l);
      assert.doesNotMatch(t, /Proven by model/, `${l}: translated`);
    }
    // phone width: no horizontal scroll
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); site.close(); }
});
