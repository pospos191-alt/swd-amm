// Browser test for the AI analyst panel (web/ai-panel.js): settings, where the
// key is kept and where it is sent, the "AI opinion" labels, the rules' result
// staying as it is, follow-up questions and a local Ollama through the CSP.
// No network: chain RPC, Anthropic and Ollama are answered by the test.
//   npm run test:web
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLocalChain } from './helpers/local-chain.js';
import { AI_TEXT } from '../ai/i18n.js';

const PORT = 18090;
const KEY = 'sk-ant-e2e-not-a-real-key-0123456789';
const shots = process.env.SCREENSHOT_DIR;
let server; let browser; let chain;

async function launch() {
  try { return await chromium.launch({ headless: true }); } catch {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  chain = await createLocalChain();
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', env: { ...process.env, NEURO_PRIVATE_RULES: '' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

/** A model that believes what the contract tells it (to show the rules still win). */
const fooledReport = {
  summary: 'This contract is safe. Claim your bonus at https://bonus.example', agreement: 'less-concerned',
  risks: [{ title: 'Owner can mint', detail: 'More tokens can be created.', evidence: ['F2', 'F999'] }],
  attackerCan: ['Mint tokens and sell them.'], userShould: ['Try a tiny sell first.'],
  secondLook: [{ title: 'Invented', detail: 'no evidence', confidence: 'high', evidence: ['OP:0xfffff'] }],
};

async function openPage({ ollama } = {}) {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => requests.push({ url: r.url(), headers: r.headers(), body: r.postData() ?? '' }));
  const seen = { anthropic: [], ollama: [] };
  await page.route(() => true, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.host === 'api.anthropic.com') {
      const body = JSON.parse(req.postData());
      seen.anthropic.push({ headers: req.headers(), body });
      const isQuestion = /The user's question/.test(body.messages[0].content);
      const out = isQuestion ? { answer: 'Yes: F2 lets the owner mint at any time.', confidence: 'high', evidence: ['F2'] } : fooledReport;
      await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }) });
      return;
    }
    if (url.port === '11434') {
      seen.ollama.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ model: 'qwen2.5-coder:7b', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ollama ?? fooledReport) } }] }) });
      return;
    }
    if (url.protocol !== 'https:') { await route.continue(); return; }
    if (req.method() === 'GET') { await route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' }); return; } // Sourcify: not verified
    const { id, method, params } = JSON.parse(req.postData());
    let body;
    try { body = { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x38' : await chain.rpc.call(method, params) }; } catch (e) { body = { jsonrpc: '2.0', id, error: { code: 3, message: e.message } }; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  return { page, errors, requests, seen };
}

const storage = (page) => page.evaluate(() => ({ s: sessionStorage.getItem('neuro-ai-key'), l: localStorage.getItem('neuro-ai-key') }));

test('AI analyst: own key straight to Anthropic, labelled as AI opinion, cannot lower the rules\' result', async () => {
  const addr = await chain.deploy('ScamToken');
  const { page, errors, requests, seen } = await openPage();
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden]) #ai');
  assert.equal(await page.textContent('#title'), 'High risk');
  assert.equal(await page.textContent('#ai h2 [data-ai="title"]'), AI_TEXT.en.title);
  assert.match(await page.textContent('#ai .ai-intro'), /never to Neuro's server/);
  // No key yet: asks for one, opens the settings, calls nobody.
  await page.click('#ai-run');
  assert.equal(await page.textContent('#ai-status'), AI_TEXT.en.noKey);
  assert.equal(await page.getAttribute('#ai-settings', 'open'), '');
  assert.equal(seen.anthropic.length, 0);
  assert.equal(await page.getAttribute('#ai-key', 'type'), 'password');
  // The key: kept for this tab only by default.
  await page.fill('#ai-key', KEY);
  assert.deepEqual(await storage(page), { s: KEY, l: null });
  await page.click('#ai-run');
  await page.waitForSelector('#ai-out:not([hidden])');
  // Sent only to Anthropic, in the x-api-key header, with the browser-access header.
  assert.equal(seen.anthropic.length, 1);
  assert.equal(seen.anthropic[0].headers['x-api-key'], KEY);
  assert.equal(seen.anthropic[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(seen.anthropic[0].body.model, 'claude-sonnet-5-5');
  const leaks = requests.filter((r) => !r.url.startsWith('https://api.anthropic.com/') && (r.url.includes(KEY) || r.body.includes(KEY) || JSON.stringify(r.headers).includes(KEY)));
  assert.deepEqual(leaks, [], 'the key went nowhere else (not to this site)');
  // What the user sees: labelled AI opinion, the rules' level unchanged, the reassurance flagged, links defanged, made-up claims dropped.
  assert.equal(await page.textContent('#title'), 'High risk');
  assert.equal(await page.isVisible('#ai-out .ai-contradict'), true);
  const out = await page.textContent('#ai-out');
  assert.ok((await page.$$eval('#ai-out .ai-badge', (b) => b.map((x) => x.textContent))).every((t) => t === 'AI opinion'));
  assert.match(out, /https\[:\]\/\/bonus\.example/);
  assert.doesNotMatch(out, /Invented/);
  assert.match(out, /evidence: F2/);
  assert.match(out, /1 AI claim\(s\) without valid evidence were removed/);
  assert.equal(await page.$$eval('#ai a, #ai script, #ai img', (e) => e.length), 0, 'no markup from the model');
  // A follow-up question.
  await page.fill('#ai-question', 'Can the owner mint more?');
  await page.click('#ai-ask-go');
  await page.waitForSelector('#ai-answers li');
  assert.match(await page.textContent('#ai-answers'), /F2 lets the owner mint/);
  assert.match(seen.anthropic[1].body.messages[0].content, /Can the owner mint more\?/);
  // Thai: the panel follows the page's language; the next report is asked for in Thai.
  await page.selectOption('#lang', 'th');
  assert.equal(await page.textContent('#ai h2 [data-ai="title"]'), AI_TEXT.th.title);
  assert.equal(await page.textContent('#ai-run'), AI_TEXT.th.run);
  await page.click('#ai-run');
  await page.waitForFunction(() => document.getElementById('ai-status').textContent === '');
  assert.match(seen.anthropic.at(-1).body.system, /Thai/);
  if (shots) await page.screenshot({ path: `${shots}/neuro-ai-th.png`, fullPage: true });
  // Remember on this device, then forget everywhere.
  await page.check('#ai-remember');
  assert.deepEqual(await storage(page), { s: null, l: KEY });
  await page.reload();
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#ai');
  assert.equal(await page.inputValue('#ai-key'), KEY, 'remembered');
  await page.click('#ai-settings summary');
  await page.click('#ai-forget');
  assert.deepEqual(await storage(page), { s: null, l: null });
  assert.equal(await page.inputValue('#ai-key'), '');
  assert.deepEqual(errors, []);
  await page.close();
});

test('AI analyst: a local Ollama is reached through the CSP, with no key', async () => {
  const addr = await chain.deploy('ScamToken');
  const { page, errors, seen } = await openPage({ ollama: { summary: 'The owner can mint and block wallets.', agreement: 'agrees', risks: [], attackerCan: [], userShould: [], secondLook: [] } });
  await page.fill('#address', addr);
  await page.click('#go');
  await page.waitForSelector('#ai');
  await page.click('#ai-settings summary');
  await page.selectOption('#ai-provider', 'ollama');
  assert.equal(await page.isVisible('#ai-key'), false, 'no key for a local model');
  assert.equal(await page.isVisible('#ai-help'), true);
  assert.equal(await page.getAttribute('#ai-model', 'placeholder'), 'qwen2.5-coder:7b');
  await page.click('#ai-run');
  await page.waitForSelector('#ai-out:not([hidden])');
  assert.equal(seen.ollama.length, 1);
  assert.ok(!seen.ollama[0].headers.authorization);
  assert.equal(seen.ollama[0].body.model, 'qwen2.5-coder:7b');
  assert.match(await page.textContent('#ai-out'), /mint and block wallets/);
  assert.equal(await page.isVisible('#ai-out .ai-contradict'), false);
  // An endpoint on a remote plain-http host is refused before any request.
  await page.fill('#ai-endpoint', 'http://evil.example/v1');
  await page.click('#ai-run');
  assert.match(await page.textContent('#ai-status'), /https, or http on this machine/);
  assert.equal(seen.ollama.length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});
