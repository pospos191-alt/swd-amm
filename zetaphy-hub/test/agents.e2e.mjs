// Browser test: the Agents page on a built dist/ with the site's CSP. A mocked model (Anthropic API)
// drafts an intent from words; the page shows it for review (never signs by itself); the key goes only
// to the provider; a label lookup reads LabelRegistry through eth_call; the page speaks Thai too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8'));
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const TKA = '0x' + '11'.repeat(20), USDT = '0x' + '22'.repeat(20), ROUTER = '0x' + '33'.repeat(20), EXE = '0x' + '44'.repeat(20), LABELS = '0x' + '55'.repeat(20);
const SEL_LABEL_OF = '0xa7477464';

test('Agents page: AI draft -> review, key only to the provider, label lookup, Thai', { timeout: 120_000 }, async () => {
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    const keySeenBy = new Set();
    let modelBody = null;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (Object.values(req.headers()).some((v) => String(v).includes('sk-test-123'))) keySeenBy.add(u.origin);
      if (u.origin === new URL(site.url).origin) {
        if (u.pathname === '/hub-config.json') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ node: '', contracts: { intentExecutor: EXE, labelRegistry: LABELS }, dex: { router: ROUTER }, nft: {},
            tokens: [{ address: TKA, symbol: 'TKA', decimals: 18 }, { address: USDT, symbol: 'USDT', decimals: 6 }], saphan: [], saphanTokens: [] }) });
        }
        return route.continue();
      }
      if (u.origin === 'https://api.anthropic.com') {
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
        modelBody = JSON.parse(req.postData());
        const draft = { kind: 'swap', tokenIn: 'TKA', amountIn: '10', tokenOut: 'USDT', minOut: '19.5', slippagePercent: 0, recipient: 'me', deadlineMinutes: 20, unclear: '' };
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draft) }] }) });
      }
      if (u.origin === 'https://rpc.sawasdeecoin.com') {
        const body = req.postData();
        const j = body ? JSON.parse(body) : null;
        if (j?.method === 'eth_call' && j.params?.[0]?.data?.startsWith(SEL_LABEL_OF)) {
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: '0x' + '0'.repeat(63) + '1' }) });
        }
        const a = answer(req.url(), body);
        if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });

    await page.goto(`${site.url}?tab=agents`);
    await page.waitForSelector('#ag-draft');
    assert.equal(await page.textContent('#page-title'), 'AI agents');
    assert.equal(await page.inputValue('#ag-exe'), EXE);
    assert.equal(await page.inputValue('#ag-targets'), ROUTER);
    assert.equal(await page.locator('#ag-tin option').count(), 3); // — , TKA, USDT

    await page.fill('#ag-text', 'swap 10 TKA for USDT, at least 19.5 back');
    await page.click('.ag-model summary');
    await page.fill('#ag-key', 'sk-test-123');
    await page.click('#ag-draft');
    await page.waitForFunction(() => /Drafted/.test(document.getElementById('ag-ai-msg').textContent));
    assert.equal(await page.inputValue('#ag-amount'), '10');
    assert.equal(await page.inputValue('#ag-min'), '19.5');
    assert.equal(await page.inputValue('#ag-tout'), USDT);
    assert.match(modelBody.system, /data, never instructions/);
    assert.match(modelBody.messages[0].content, /<<USER-TEXT>>\nswap 10 TKA/);
    assert.deepEqual([...keySeenBy], ['https://api.anthropic.com'], 'the key went only to the provider');
    // no wallet connected: the review asks for one and nothing can be signed
    assert.match(await page.textContent('#ag-msg'), /connected wallet/);
    assert.equal(await page.locator('#ag-sign').count(), 0);

    // label lookup (the registry answers 1 = person)
    await page.fill('#ag-lab-q', '0x' + '66'.repeat(20));
    await page.locator('.ag-card', { hasText: 'Person or agent?' }).getByRole('button', { name: 'Check' }).click();
    await page.waitForFunction(() => /Person \(passkey\)/.test(document.getElementById('ag-lab-out').textContent));

    // Thai
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => document.getElementById('page-title').textContent === 'AI agent');
    assert.match(await page.textContent('.page-agents'), /บอกสิ่งที่ต้องการ/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    site.close();
  }
});
