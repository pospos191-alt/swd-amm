// Browser test of the Audit-as-a-Service pages under the site's real CSP, every RPC mocked (no network):
//   audit.html#<chain>:<address> reads the certificate from a fake ZETAPHY node and the code from a fake Base /
//   Solana endpoint: VALID (+ the NeuroOracle mirror), CODE CHANGED (a plain redeploy, and a proxy whose
//   implementation was swapped to uncertified code), REVOKED, EXPIRED, NOT CERTIFIED, a Solana program; Thai;
//   phone width. audits.html lists a registry fixture, filters it and links to the live check.
//   npm run build && node --test test/aas.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Interface, keccak256, AbiCoder } from 'ethers';
import { serve } from './serve.mjs';
import * as aas from '../aas-core.js';
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const CSP = JSON.parse(readFileSync(join(HERE, '..', 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const exe = process.env.CHROMIUM_PATH || undefined;
const art = (n) => new Interface(JSON.parse(readFileSync(join(HERE, '..', '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8')).abi);
const CERT = art('AuditCertificate'), ORACLE = art('NeuroOracle');
const abi = AbiCoder.defaultAbiCoder();
const CA = '0x' + 'a4'.repeat(20), OA = '0x' + 'a5'.repeat(20);
const now = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86400n;
const Z = '0x' + '00'.repeat(32), H = '0x' + '11'.repeat(32), S = '0x' + '22'.repeat(32);
const w = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

// Base: a plain vault, a redeployed one, a revoked one, an expired one, an uncertified one, and a proxy whose
// implementation slot now points at IMPL_B (uncertified) instead of the certified IMPL_A.
const A = (n) => '0x' + n.repeat(20);
const VAULT = A('b1'), MOVED = A('b2'), REVOKED = A('b3'), OLD = A('b4'), NONE = A('b5'), PROXY = A('b6'), IMPL_A = A('b7'), IMPL_B = A('b8');
const CODE = { [VAULT]: '0x6080604052600a', [MOVED]: '0x6080604052600b', [REVOKED]: '0x6080604052600c', [OLD]: '0x6080604052600d', [NONE]: '0x6080604052600e',
  [PROXY]: '0x60806040523661001357', [IMPL_A]: '0x6080604052600f', [IMPL_B]: '0x60806040526010' };
const hashOf = (a) => keccak256(CODE[a]);
const SOL = aas.chainOf('solana');
const PROGRAM = aas.base58Encode(new Uint8Array(32).fill(5));
const PDA = new Uint8Array(32).fill(9);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 9]);
const SOL_HASH = `0x${createHash('sha256').update(ELF).digest('hex')}`;
const SOL_TARGET = aas.targetOf(neuroKeccak, SOL, PROGRAM);

const cert = (o) => [7n, o.chainId ?? 8453n, o.target, o.codeHash, H, S, o.level ?? 3, 6, 8800, o.issuedAt ?? now - DAY, o.expiresAt ?? now + 170n * DAY, o.revokedAt ?? 0n, 0n];
const CERTS = {
  [`8453:${VAULT}`]: [cert({ target: VAULT, codeHash: hashOf(VAULT) }), true],
  [`8453:${MOVED}`]: [cert({ target: MOVED, codeHash: keccak256('0x6080604052600999'), level: 2 }), true],
  [`8453:${REVOKED}`]: [cert({ target: REVOKED, codeHash: hashOf(REVOKED), revokedAt: now - 3600n }), false],
  [`8453:${OLD}`]: [cert({ target: OLD, codeHash: hashOf(OLD), issuedAt: now - 400n * DAY, expiresAt: now - DAY, level: 1 }), false],
  [`8453:${PROXY}`]: [cert({ target: PROXY, codeHash: hashOf(PROXY) }), true],
  [`8453:${IMPL_A}`]: [cert({ target: IMPL_A, codeHash: hashOf(IMPL_A) }), true],
  [`${SOL.aasId}:${SOL_TARGET}`]: [cert({ chainId: BigInt(SOL.aasId), target: SOL_TARGET, codeHash: SOL_HASH, level: 2 }), true],
};
const EMPTY = [[0n, 0n, '0x' + '00'.repeat(20), Z, Z, Z, 0, 0, 0, 0n, 0n, 0n, 0n], false];

function zetaphy(req) {
  if (req.method === 'eth_chainId') return '0x12e4e';
  if (req.method !== 'eth_call' || req.params[0].to.toLowerCase() !== CA) throw new Error(`zetaphy: ${req.method}`);
  const [chainId, target] = CERT.decodeFunctionData('certificate', req.params[0].data);
  return CERT.encodeFunctionResult('certificate', CERTS[`${chainId}:${target.toLowerCase()}`] ?? EMPTY);
}
function base(req) {
  const p = req.params ?? [];
  if (req.method === 'eth_chainId') return '0x2105';
  if (req.method === 'eth_getCode') return CODE[p[0].toLowerCase()] ?? '0x';
  if (req.method === 'eth_getStorageAt') return p[0].toLowerCase() === PROXY && p[1] === aas.EIP1967_IMPL ? w(IMPL_B) : Z;
  if (req.method === 'eth_call' && p[0].to.toLowerCase() === OA) {
    const [, target] = ORACLE.decodeFunctionData('isCertified', p[0].data);
    return abi.encode(['bool'], [target.toLowerCase() === VAULT]);
  }
  throw new Error(`base: ${req.method}`);
}
function solana(req) {
  const p = req.params ?? [];
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  if (req.method === 'getAccountInfo' && p[0] === PROGRAM) {
    const d = new Uint8Array(36); d[0] = 2; d.set(PDA, 4);
    return { value: { executable: true, owner: aas.BPF_UPGRADEABLE_LOADER, data: [b64(d), 'base64'] } };
  }
  if (req.method === 'getAccountInfo' && p[0] === aas.base58Encode(PDA)) {
    const head = new Uint8Array(45); head[0] = 3; // no upgrade authority: immutable
    return { value: { executable: false, owner: aas.BPF_UPGRADEABLE_LOADER, data: [b64(new Uint8Array([...head, ...ELF, 0, 0, 0])), 'base64'] } };
  }
  throw new Error(`solana: ${req.method}`);
}

const REGISTRY = { version: 1, generatedAt: '2026-10-30T06:00:00.000Z', certificate: CA, entries: [
  { chain: 'base', chainId: '8453', address: VAULT, target: VAULT, codeHash: hashOf(VAULT), role: 'contract', name: 'Acme Vault', level: 3, requestId: '7', issuedAt: String(now - DAY), expiresAt: String(now + 170n * DAY), revoked: false, report: 'https://github.com/acme/vault', reportHash: H, findings: { open: 0, valid: { critical: 0, high: 1, medium: 2, low: 0, info: 0 }, late: 0, fixed: 1 } },
  { chain: 'base', chainId: '8453', address: REVOKED, target: REVOKED, codeHash: hashOf(REVOKED), role: 'contract', name: 'Broken Pool', level: 2, requestId: '8', issuedAt: String(now - 2n * DAY), expiresAt: String(now + 100n * DAY), revoked: true, report: '', reportHash: H, findings: { open: 0, valid: {}, late: 1, fixed: 0 } },
  { chain: 'solana', chainId: SOL.aasId, address: PROGRAM, target: SOL_TARGET, codeHash: SOL_HASH, role: 'program', name: 'Sol Farm', level: 2, requestId: '9', issuedAt: String(now - 3n * DAY), expiresAt: String(now + 100n * DAY), revoked: false, report: '', reportHash: H, findings: { open: 0, valid: {}, late: 0, fixed: 0 } },
  { chain: 'base', chainId: '8453', address: OLD, target: OLD, codeHash: hashOf(OLD), role: 'contract', name: '', level: 1, requestId: '1', issuedAt: String(now - 400n * DAY), expiresAt: String(now - DAY), revoked: false, report: '', reportHash: H, findings: { open: 0, valid: {}, late: 0, fixed: 0 } },
] };

test('certificate check page + Audit Directory: live states from mocked chains, badge, proxy swap, Solana, Thai, CSP, phone', { timeout: 180_000 }, async () => {
  const cfg = JSON.parse(readFileSync(join(DIST, 'hub-config.json'), 'utf8'));
  cfg.node = 'https://zetaphy.test';
  cfg.contracts = { ...cfg.contracts, auditCertificate: CA };
  cfg.immune = { sender: null, mirrors: [{ name: 'base', displayName: 'Base', chainId: 8453, oracle: OA, rpc: 'https://mainnet.base.org' }] };
  const site = await serve(DIST, { headers: { 'content-security-policy': CSP }, files: { '/hub-config.json': JSON.stringify(cfg) } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const seen = new Set();
    const rpcRoute = (fn) => async (route) => {
      seen.add(new URL(route.request().url()).host);
      const req = JSON.parse(route.request().postData() ?? '{}');
      let body;
      try { body = { jsonrpc: '2.0', id: req.id, result: fn(req) }; } catch (e) { body = { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e.message } }; }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    };
    await context.route('https://zetaphy.test/**', rpcRoute(zetaphy));
    for (const u of aas.chainOf('base').rpcs) await context.route(`${u}/**`, rpcRoute(base));
    await context.route(`${SOL.rpcs[0]}/**`, rpcRoute(solana));
    await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(REGISTRY) }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
    const verdict = async (ref) => {
      await page.goto('about:blank'); // a hash-only change would not reload: start fresh each time
      await page.goto(`${site.url}audit.html#${ref}`);
      await page.waitForSelector('#verdict');
      return { status: await page.getAttribute('#verdict', 'data-status'), text: await page.textContent('#result') };
    };

    let v = await verdict(`8453:${VAULT}`);
    assert.equal(v.status, 'valid');
    assert.match(v.text, /VALID · Gold/);
    assert.match(v.text, /exactly the certified code hash/);
    assert.match(v.text, /isCertified = true/, 'the NeuroOracle mirror on Base');
    assert.ok(v.text.includes(hashOf(VAULT)));
    assert.equal(await page.inputValue('#address'), VAULT);
    assert.equal(await page.inputValue('#chain'), 'base');
    assert.match(await page.getAttribute('#badge-img', 'src'), /^data:image\/svg\+xml;base64,/);
    await page.waitForFunction(() => document.getElementById('badge-img').complete);
    assert.ok(await page.evaluate(() => document.getElementById('badge-img').naturalWidth > 50), 'the badge renders (UTF-8 SVG)');
    const snip = await page.textContent('#snip-html');
    assert.ok(snip.includes(`href="https://app.sawasdeecoin.com/audit.html#8453:${VAULT}"`) && snip.includes(`src="https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@audit-registry/badges/base-${VAULT}.svg"`), snip);
    assert.match(await page.textContent('body'), /not mean the code is safe/);

    v = await verdict(`8453:${MOVED}`);
    assert.deepEqual([v.status, /no longer the audited code/.test(v.text), /isCertified = false/.test(v.text)], ['code_changed', true, true]);
    v = await verdict(`base:${PROXY}`);
    assert.equal(v.status, 'code_changed', 'the proxy now forwards to an uncertified implementation');
    assert.match(v.text, /implementation that has no certificate/);
    assert.ok(v.text.includes(IMPL_B));
    v = await verdict(`8453:${REVOKED}`);
    assert.equal(v.status, 'revoked');
    assert.match(v.text, /REVOKED/);
    v = await verdict(`eip155:8453:${OLD}`);
    assert.equal(v.status, 'expired');
    v = await verdict(`8453:${NONE}`);
    assert.equal(v.status, 'none');
    assert.match(v.text, /NOT CERTIFIED/);
    v = await verdict(`solana:${PROGRAM}`);
    assert.equal(v.status, 'valid', 'the Solana program hash (sha256 of the ELF) is the certified one');
    assert.match(v.text, /VALID · Silver/);
    assert.ok(v.text.includes(SOL_HASH));

    // the form: a bad address says so; a good one moves the hash and checks
    await page.selectOption('#chain', 'base');
    await page.fill('#address', 'osmo1nope');
    await page.click('#go');
    await page.waitForFunction(() => /Pick a chain/.test(document.getElementById('result').textContent));
    await page.fill('#address', VAULT.toUpperCase().replace('0X', '0x'));
    await page.click('#go');
    await page.waitForSelector('#verdict[data-status="valid"]');
    assert.match(page.url(), new RegExp(`#8453:${VAULT}$`));

    // Thai, then phone width
    await page.selectOption('#lang', 'th');
    await page.waitForFunction(() => document.documentElement.lang === 'th');
    assert.match(await page.textContent('#verdict'), /ใช้ได้ · ทอง/);
    assert.match(await page.textContent('h1'), /ตรวจใบรับรอง/);
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll (verify): ${await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => `${e.tagName}#${e.id}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`).slice(0, 8).join(' '))}`);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'aas-verify.png'), fullPage: true });

    // the directory (still Thai: the language is remembered)
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${site.url}audits.html`);
    await page.waitForSelector('#list table');
    assert.match(await page.textContent('h1'), /สมุดรายชื่อการตรวจสอบ/);
    await page.selectOption('#lang', 'en');
    await page.waitForFunction(() => /Audit Directory/.test(document.querySelector('h1').textContent));
    let rows = await page.$$eval('#list tbody tr', (trs) => trs.map((t) => t.textContent));
    assert.equal(rows.length, 4);
    assert.match(rows[0], /Acme Vault.*contract.*Base.*Gold.*VALID.*3 valid \(1 critical\/high\), 1 fixed/);
    assert.ok(rows.some((r) => /Broken Pool.*REVOKED/.test(r)));
    assert.ok(rows.some((r) => /Sol Farm.*program.*Solana.*VALID/.test(r)));
    assert.ok(rows.some((r) => /EXPIRED/.test(r)));
    assert.match(await page.textContent('#asof'), /Registry built/);
    await page.selectOption('#f-state', 'revoked');
    rows = await page.$$eval('#list tbody tr', (trs) => trs.map((t) => t.textContent));
    assert.deepEqual(rows.length, 1);
    await page.selectOption('#f-state', '');
    await page.selectOption('#f-chain', 'solana');
    await page.click('#list tbody tr a');
    await page.waitForSelector('#verdict[data-status="valid"]');
    assert.match(page.url(), new RegExp(`audit\\.html#solana:${PROGRAM}$`));
    await page.goto(`${site.url}audits.html`);
    await page.fill('#q', 'nothing-like-this');
    await page.waitForFunction(() => /No certificate matches/.test(document.getElementById('list').textContent));
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll (directory)');
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'aas-directory.png'), fullPage: true });

    assert.deepEqual([...seen].sort(), ['api.mainnet-beta.solana.com', 'mainnet.base.org', 'zetaphy.test'], 'only the mocked endpoints, first one of each chain');
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); site.close(); }
});
