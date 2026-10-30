// Browser test of the Audit tab under the site's real CSP: a fake node answers the audit contracts (one request with
// one valid finding, an agreed automated tier, a Gold certificate for one address). The tab lists the request, shows
// its findings and why it is certifiable, looks a certificate up, hashes a PoC file locally, and works in Thai.
//   npm run build && node --test test/audit.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Interface, keccak256 } from 'ethers';
import { serve } from './serve.mjs';
import { answer } from './mocknode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const art = (n) => new Interface(JSON.parse(readFileSync(join(HERE, '..', '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8')).abi);
const NET = art('AuditNetwork'), RUN = art('AuditRunners'), CERT = art('AuditCertificate'), JUD = art('AuditJudges');
const NA = '0x' + 'a1'.repeat(20), RA = '0x' + 'a2'.repeat(20), JA = '0x' + 'a3'.repeat(20), CA = '0x' + 'a4'.repeat(20);
const TARGET = '0x' + 'be'.repeat(20), H = '0x' + '11'.repeat(32), S = '0x' + '22'.repeat(32), Z = '0x' + '00'.repeat(32);
const now = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86400n;

function auditCall({ to, data }) {
  const t = to.toLowerCase();
  const iface = { [NA]: NET, [RA]: RUN, [CA]: CERT, [JA]: JUD }[t];
  if (!iface) return null;
  const fn = iface.getFunction(data.slice(0, 10));
  const args = iface.decodeFunctionData(fn, data);
  const out = (v) => iface.encodeFunctionResult(fn, v);
  switch (`${t}:${fn.name}`) {
    case `${NA}:requestCount`: return out([1n]);
    case `${NA}:getParams`: return out([[3 * 86400, 30 * 86400, 86400, 2 * 86400, 2 * 86400, 7 * 86400, 86400, 2, 2000, 1000, 5000, 1000, 5, 10n ** 19n, 10n ** 18n]]);
    case `${NA}:getRequest`: return out([['0x' + 'aa'.repeat(20), 77390n, now - 20n * DAY, now - 10n * DAY, 0, false, true, false, false, TARGET, 3 * 86400, 2, 3, 0, 0, 0, 0, 3, 0n, 0n, H, S, Z, 99n * 10n ** 18n, 0n, 0n, Z]]);
    case `${NA}:findingsOf`: return out([[0n]]);
    case `${NA}:findingCount`: return out([1n]);
    case `${NA}:getFinding`: return out([[0n, now - 15n * DAY, 1n, now - 9n * DAY, now - 8n * DAY, '0x' + 'cc'.repeat(20), 3, 3, 3, false, false, false, 0n, 0n, H, S, Z]]);
    case `${RA}:result`: return out([true, { resultHash: H, critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 8800 }]);
    case `${CA}:check`: return out([0]);
    case `${CA}:certificate`: {
      if (args[1].toLowerCase() !== TARGET) return out([[0n, 0n, '0x' + '00'.repeat(20), Z, Z, Z, 0, 0, 0, 0n, 0n, 0n, 0n], false]);
      return out([[0n, 77390n, TARGET, H, S, Z, 3, 6, 8800, now - DAY, now + 179n * DAY, 0n, 0n], true]);
    }
    default: throw new Error(`not mocked: ${fn.name}`);
  }
}

test('Audit tab: requests, findings, the certificate check, a certificate lookup, a PoC hashed locally, Thai', { timeout: 180_000 }, async () => {
  const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
  cfg.contracts = { ...cfg.contracts, auditNetwork: NA, auditRunners: RA, auditJudges: JA, auditCertificate: CA };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('https://rpc.sawasdeecoin.com/**', async (route) => {
      const body = route.request().postData() ?? '';
      const req = (() => { try { return JSON.parse(body); } catch { return null; } })();
      let a = null;
      if (req?.method === 'eth_call') {
        try { const r = auditCall(req.params[0]); if (r) a = { jsonrpc: '2.0', id: req.id, result: r }; } catch (e) { a = { jsonrpc: '2.0', id: req.id, error: { code: 3, message: e.message } }; }
      }
      a ??= answer(route.request().url(), body);
      if (a) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a) });
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });

    await page.goto(`${site.url}?tab=audit`);
    assert.ok(await page.$('.tab[data-tab="audit"]'), 'listed with the tabs');
    await page.waitForSelector('#au-req-table tr[data-id="0"]');
    assert.match(await page.textContent('#au-req-table'), /settled/);
    assert.match(await page.textContent('#au-intro'), /open audit network/i);
    await page.click('#au-req-table tr[data-id="0"]');
    await page.waitForSelector('#au-why[data-reason="ok"]');
    assert.match(await page.textContent('#au-auto'), /mutation 88%/);
    assert.match(await page.textContent('#au-findings'), /valid/);

    // certificate lookup
    await page.fill('#au-cert-addr', TARGET);
    await page.click('#au-cert-go');
    await page.waitForSelector('#au-cert-out[data-state="valid"]');
    assert.match(await page.textContent('#au-cert-state'), /Certified · Gold/);
    assert.equal((await page.textContent('#au-cert-report')).trim(), S, 'the report hash');
    assert.match(await page.textContent('#au-cert-out'), /not a guarantee/);
    await page.fill('#au-cert-addr', '0x' + '99'.repeat(20));
    await page.click('#au-cert-go');
    await page.waitForSelector('#au-cert-out[data-state="none"]');
    await page.fill('#au-cert-addr', 'nope');
    await page.click('#au-cert-go');
    await page.waitForFunction(() => /0x address/.test(document.querySelector('#au-cert-out')?.textContent ?? ''));

    // the PoC is hashed in the browser, never uploaded
    const poc = Buffer.from('function test_exploit() public { vault.withdraw(); }');
    await page.setInputFiles('#au-c-poc', { name: 'Exploit.t.sol', mimeType: 'text/plain', buffer: poc });
    await page.waitForFunction((h) => (document.querySelector('#au-c-evidence')?.textContent ?? '').includes(h), keccak256(poc));
    assert.match(await page.textContent('#au-commits'), /Nothing committed/);

    // Thai
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => /เครือข่ายตรวจสอบแบบเปิด/.test(document.querySelector('.page-audit')?.textContent ?? ''));
    await page.waitForSelector('#au-req-table');
    assert.match(await page.textContent('#au-req-table'), /สรุปยอดแล้ว/);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'audit.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); site.close(); }
});
