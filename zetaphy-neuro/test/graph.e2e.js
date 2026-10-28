// Browser test for the money-flow view (web/flow.js + graph/view.js): the page
// checks a token on "Base" answered by the made-up chain in
// test/helpers/flow-world.js (JSON-RPC and Blockscout, no network), then the
// user traces the money flow, opens a node with the keyboard, switches
// language, runs the investigator and follows the token.
//   npm run test:web
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { W, rpcAnswer, blockscoutAnswer } from './helpers/flow-world.js';

const PORT = 18090;
const shots = process.env.SCREENSHOT_DIR;
let server; let browser;

async function launch() {
  try { return await chromium.launch({ headless: true }); } catch {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  server = spawn(process.execPath, ['scripts/serve.js', String(PORT)], { stdio: 'pipe', env: { ...process.env, NEURO_PRIVATE_RULES: '' } });
  await new Promise((r) => server.stdout.once('data', r));
  browser = await launch();
});
after(async () => { await browser?.close(); server?.kill(); });

async function openPage({ width = 1100, scheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  const stats = { calls: [] };
  await page.route((url) => url.protocol === 'https:', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { 'access-control-allow-origin': '*' };
    if (req.method() === 'GET') {
      const hit = url.hostname.endsWith('blockscout.com') && url.pathname === '/api';
      await route.fulfill({ status: hit ? 200 : 404, contentType: 'application/json', headers, body: JSON.stringify(hit ? blockscoutAnswer(url.searchParams, stats) : { error: 'not found' }) });
      return;
    }
    const { id, method, params } = JSON.parse(req.postData());
    let body;
    try { body = { jsonrpc: '2.0', id, result: rpcAnswer(req.url(), method, params, stats) }; } catch (e) { body = { jsonrpc: '2.0', id, error: { code: e.code ?? 3, message: e.message } }; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  });
  await page.goto(`http://localhost:${PORT}/web/?chain=base&address=${W.token}`);
  await page.waitForSelector('#result:not([hidden])');
  return { page, problems, stats };
}

test('money flow: trace, inspect a node with the keyboard, switch language, investigate, follow', { timeout: 120_000 }, async () => {
  const { page, problems } = await openPage();
  await page.waitForSelector('#flow:not([hidden])');
  assert.equal(await page.textContent('#flow-go'), 'Trace money flow');
  // Nothing is traced until asked.
  assert.equal(await page.$$eval('#flow-graph svg', (s) => s.length), 0);
  await page.click('#flow-go');
  await page.waitForSelector('#flow-graph svg .flow-node', { timeout: 60_000 });
  const signals = await page.$$eval('#flow-signals li', (els) => els.map((e) => ({ cls: e.className, text: e.textContent })));
  assert.ok(signals.some((s) => s.cls === 'high' && /ThreatRegistry/.test(s.text)));
  assert.ok(signals.some((s) => /90% of the liquidity/.test(s.text) && s.text.includes(W.txRemove)), 'evidence tx shown');
  assert.ok(signals.some((s) => /same address/.test(s.text)));
  // The graph: every node is a focusable button; flagged node has a ring.
  const nodes = await page.$$eval('#flow-graph .flow-node', (els) => els.map((e) => ({ tab: e.getAttribute('tabindex'), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), cls: e.getAttribute('class') })));
  assert.ok(nodes.length >= 10);
  assert.ok(nodes.every((n) => n.tab === '0' && n.role === 'button'));
  assert.ok(nodes.some((n) => n.cls.includes('flagged') && n.label.includes(W.f2)));
  // Keyboard: focus the deployer and press Enter.
  await page.focus('#flow-graph .flow-node.r-deployer');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#flow-detail:not([hidden])');
  const detail = await page.textContent('#flow-detail');
  assert.ok(detail.includes(W.deployer));
  assert.match(detail, /Deployer/);
  assert.equal(await page.$$eval('#flow-graph .flow-edge.on', (e) => e.length) > 0, true);
  const explorer = await page.getAttribute('#flow-detail a', 'href');
  assert.equal(explorer, `https://basescan.org/address/${W.deployer}`);
  if (shots) await page.screenshot({ path: `${shots}/neuro-flow-en.png`, fullPage: true });
  // Language: the whole section follows the page language.
  await page.selectOption('#lang', 'th');
  assert.equal(await page.textContent('#flow-title'), 'เส้นทางเงิน');
  assert.ok((await page.textContent('#flow-signals')).includes('สภาพคล่อง'));
  assert.ok((await page.$$eval('#flow-graph .flow-node', (els) => els.map((e) => e.getAttribute('aria-label')))).some((l) => l.startsWith('ผู้สร้างสัญญา')));
  await page.selectOption('#lang', 'ja');
  assert.equal(await page.textContent('#flow-title'), '資金の流れ');
  await page.selectOption('#lang', 'en');
  // The investigator: all steps, with their status and a confidence.
  await page.click('#flow-investigate');
  await page.waitForFunction(() => document.querySelectorAll('#flow-steps li').length === 6, null, { timeout: 60_000 });
  const steps = await page.$$eval('#flow-steps li', (els) => els.map((e) => e.textContent));
  assert.deepEqual(steps.slice(0, 5).map((s) => s.split(':')[0]), ['Contract rules', 'Trade test', 'Money flow', 'ML score', 'AI review']);
  assert.match(steps[2], /done/);
  assert.match(steps[3], /skipped/);
  assert.match(steps[5], /Confidence: \d+%/);
  // Follow: the watch list appears, stored only in this browser.
  await page.click('#flow-follow');
  await page.waitForSelector('#watch:not([hidden])');
  assert.ok((await page.textContent('#watch-list')).includes(W.token));
  assert.equal(await page.textContent('#flow-follow'), 'Stop following');
  assert.ok((await page.evaluate(() => localStorage.getItem('neuro-watch'))).includes(W.token));
  // Another panel can ask to follow a token.
  await page.evaluate((a) => document.dispatchEvent(new CustomEvent('neuro:follow', { detail: { chain: 'eth', address: a } })), W.old);
  assert.equal(await page.$$eval('#watch-list > li', (e) => e.length), 2);
  assert.deepEqual(problems, []);
  await page.close();
});

test('money flow on a phone: no horizontal page scroll, dark theme', { timeout: 120_000 }, async () => {
  const { page, problems } = await openPage({ width: 390, scheme: 'dark' });
  await page.click('#flow-go');
  await page.waitForSelector('#flow-graph svg .flow-node', { timeout: 60_000 });
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(scroll <= inner, `page scrolls sideways: ${scroll} > ${inner}`);
  if (shots) await page.screenshot({ path: `${shots}/neuro-flow-phone-dark.png`, fullPage: true });
  assert.deepEqual(problems, []);
  await page.close();
});
