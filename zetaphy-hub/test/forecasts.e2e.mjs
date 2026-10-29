// Browser test: forecasts.html on a built dist/ with the site's CSP, against a mocked node (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Interface } from 'ethers';
import { serve } from './serve.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(HERE, 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const CSP = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const RF = new Interface(JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-network', 'artifacts', 'RiskForecasts.json'), 'utf8')).abi);
const AT = '0x' + '42'.repeat(20);
const TOKEN = '0x' + '77'.repeat(20);

/** Answers eth_call for one open liquidity-drop question and one final flagged one. */
function answer(data) {
  const fn = RF.parseTransaction({ data });
  const now = Math.floor(Date.now() / 1000);
  const E = 10n ** 18n;
  const r = (vals) => RF.encodeFunctionResult(fn.name, vals);
  if (fn.name === 'count') return r([2]);
  if (fn.name === 'minStake') return r([E / 100n]);
  if (fn.name === 'questions') return Number(fn.args[0]) === 2
    ? r([TOKEN, TOKEN, 0, 5000, now - 100, now + 86400, now + 7 * 86400, 1000n * E, TOKEN])
    : r([TOKEN, '0x' + '00'.repeat(20), 1, 0, now - 9e5, now - 8e5, now - 7e5, 0, TOKEN]);
  if (fn.name === 'states') return Number(fn.args[0]) === 2
    ? r([1, 0, 0, 0, false, 0, '0x' + '00'.repeat(20), 2n * E, 3n * E, 2])
    : r([4, 2, 2, now - 7e5, true, now - 6e5, '0x' + '00'.repeat(20), E, E, 1]);
  throw new Error(fn.name);
}

test('forecasts page: questions from the chain, forecast buttons, 8 languages, tabs, CSP, phone width', { timeout: 60_000 }, async () => {
  const site = await serve(DIST, { headers: { 'Content-Security-Policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/hub-config.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ node: 'https://node.test', contracts: { riskForecasts: AT } }) }));
    await page.route('https://node.test/**', async (r) => {
      const req = JSON.parse(r.request().postData());
      assert.equal(req.params[0].to.toLowerCase(), AT);
      r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result: answer(req.params[0].data) }) });
    });
    await page.goto(`${site.url}forecasts.html`);
    await page.waitForSelector('#p-forecasts table');
    const rows = await page.$$eval('#p-forecasts tbody tr', (trs) => trs.map((t) => t.textContent));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /#2.*pool loses ≥ 50% of its liquidity.*open.*2 \/ 3/);
    assert.match(rows[1], /#1.*flagged in ThreatRegistry.*final · yes/);
    assert.equal(await page.locator('#p-forecasts button', { hasText: 'Forecast yes' }).count(), 1);
    assert.equal(await page.locator('#p-forecasts button', { hasText: 'Claim' }).count(), 1);
    assert.match(await page.textContent('.note'), /Testnet only/);
    // forecasting without a wallet says so, does not throw
    await page.click('#p-forecasts button:has-text("Forecast yes")');
    await page.waitForFunction(() => /MetaMask/.test(document.getElementById('status').textContent));
    // other tabs: not deployed here -> local commands
    await page.click('#t-detectors');
    await page.waitForSelector('#p-detectors .cmd');
    assert.equal(await page.isHidden('#p-forecasts'), true);
    assert.match(page.url(), /#detectors$/);
    // Thai
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => document.documentElement.lang === 'th');
    assert.match(await page.textContent('#t-forecasts'), /พยากรณ์ความเสี่ยง/);
    // phone width: no horizontal page scroll
    await page.setViewportSize({ width: 375, height: 800 });
    await page.click('#t-forecasts');
    await page.waitForSelector('#p-forecasts table');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
    assert.deepEqual(errors.filter((e) => !/MetaMask|status of 404/.test(e)), []);
  } finally {
    await browser.close();
    site.close();
  }
});
