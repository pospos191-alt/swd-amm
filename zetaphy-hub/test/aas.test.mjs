// Audit-as-a-Service pages (audit.html, audits.html; docs/future/audit-as-a-service.md): aas-core.js against ethers
// and the contracts' ABI (request calldata, certificate reads), the status rules, the badge, the registry validator,
// the words in 8 languages, and the pages shipped under the strict CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, AbiCoder, keccak256 } from 'ethers';
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';
import * as aas from '../aas-core.js';
import { AAS } from '../aas-i18n.js';
import { LANG_CODES } from '../i18n.js';
import { HUB_PAGES } from '../seo.mjs';

const k = neuroKeccak;
const HERE = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, HERE), 'utf8');
const art = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-network/artifacts/${n}.json`, import.meta.url), 'utf8'));
const NET = new Interface(art('AuditNetwork').abi);
const CERT = new Interface(art('AuditCertificate').abi);
const ORACLE = new Interface(art('NeuroOracle').abi);
const abi = AbiCoder.defaultAbiCoder();
const H = '0x' + '11'.repeat(32), S = '0x' + '22'.repeat(32), Z = '0x' + '00'.repeat(32);

test('calldata and reads match the contracts: AuditNetwork.request, AuditCertificate.certificate, NeuroOracle.isCertified, the cert key', () => {
  const base = aas.chainOf('base');
  const t = { chainId: 8453n, target: '0x' + 'be'.repeat(20), codeHash: H, sourceHash: S };
  const terms = { tier: 1, contest: 10 * 86400, minAuditors: 4 };
  assert.equal(aas.requestCalldata(k, t, terms, 'zaas1|base|0x…|contract|'), NET.encodeFunctionData('request', [t, 1, 10 * 86400, 4, 0n, 'zaas1|base|0x…|contract|']));
  assert.equal(aas.certificateCall(k, 8453n, t.target), CERT.encodeFunctionData('certificate', [8453n, t.target]));
  assert.equal(aas.mirrorCall(k, 8453n, t.target), ORACLE.encodeFunctionData('isCertified', [8453n, t.target]));
  assert.equal(aas.certKey(k, 8453n, t.target), keccak256(abi.encode(['uint64', 'address'], [8453n, t.target])));
  // non-EVM targets: a 20-byte stand-in derived from (caip2, native), stable and distinct per chain
  const sol = aas.chainOf('solana'), dev = aas.chainOf('solana-devnet');
  const id = '11111111111111111111111111111112';
  assert.equal(aas.targetOf(k, sol, id), `0x${keccak256(abi.encode(['string', 'string', 'string'], ['zetaphy.aas.target', sol.caip2, id])).slice(-40)}`);
  assert.notEqual(aas.targetOf(k, sol, id), aas.targetOf(k, dev, id));
  assert.equal(aas.targetOf(k, base, '0xABCDEF0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
});

test('refs, order URIs and addresses per chain type', () => {
  assert.deepEqual(aas.parseRef('#8453:0xABCDEF0000000000000000000000000000000001'), { chain: aas.chainOf('base'), address: '0xabcdef0000000000000000000000000000000001' });
  assert.equal(aas.parseRef('#solana:11111111111111111111111111111112').chain.key, 'solana');
  assert.equal(aas.parseRef(`#osmosis:osmo1${'q'.repeat(58)}`).chain.key, 'osmosis');
  assert.equal(aas.parseRef('#eip155:10:0x' + '12'.repeat(20)).chain.key, 'optimism');
  for (const bad of ['', '#', '#8453', '#8453:0x12', '#999999:0x' + '12'.repeat(20), '#solana:0OIl', `#osmosis:cosmos1${'q'.repeat(58)}`, '#base:<script>']) assert.equal(aas.parseRef(bad), null, bad);
  const c = aas.chainOf('base');
  assert.equal(aas.refOf(c, '0x' + '12'.repeat(20)), `8453:0x${'12'.repeat(20)}`);
  assert.equal(aas.refOf(aas.chainOf('solana'), 'x'), 'solana:x');
  const u = aas.orderUri({ chain: c, native: '0x' + '12'.repeat(20), role: 'proxy', link: 'https://github.com/acme/v|x' });
  assert.deepEqual(aas.parseOrderUri(u), { chain: 'base', native: '0x' + '12'.repeat(20), role: 'proxy', link: 'https://github.com/acme/vx' });
  assert.equal(aas.parseOrderUri('zaas1|base|0x12|proxy|'), null);
  assert.equal(aas.parseOrderUri('zaas1|base|0x' + '12'.repeat(20) + '|admin|'), null);
  assert.equal(aas.parseOrderUri('zaas1|base|0x' + '12'.repeat(20) + '|proxy|javascript:alert(1)').link, '');
  assert.throws(() => aas.orderUri({ chain: c, native: '0x' + '12'.repeat(20), link: `https://x/${'a'.repeat(200)}` }), /200 bytes/);
});

test('certificate status: revoked > expired > code changed > unverifiable > valid, proxies through their implementation', () => {
  const now = 2_000_000_000;
  const cert = { issuedAt: BigInt(now - 100), expiresAt: BigInt(now + 100), revokedAt: 0n, revokedBy: 0n, codeHash: H, level: 3, chainId: 8453n };
  const st = (o) => aas.certificateStatus({ cert, valid: true, live: { codeHash: H }, now, ...o });
  assert.deepEqual(st({}), { status: 'valid', reason: 'ok', level: 3 });
  assert.equal(st({ cert: { ...cert, issuedAt: 0n } }).status, 'none');
  assert.deepEqual(st({ cert: { ...cert, revokedAt: 5n }, valid: false }), { status: 'revoked', reason: 'finding', level: 3 });
  assert.equal(st({ cert: { ...cert, revokedAt: 5n }, now: now + 1000 }).status, 'revoked', 'revoked wins over expired');
  assert.equal(st({ now: now + 100 }).status, 'expired');
  assert.deepEqual(st({ live: { codeHash: S } }), { status: 'code_changed', reason: 'code', level: 3 });
  assert.deepEqual(st({ valid: false }), { status: 'revoked', reason: 'codeRevoked', level: 3 });
  assert.deepEqual(st({ live: { error: 'timeout' } }), { status: 'unverifiable', reason: 'rpc', level: 3 });
  assert.equal(st({ cert: { ...cert, chainId: 77390n }, valid: false, live: { error: 'x' } }).status, 'unverifiable', 'ZETAPHY: valid=false may be the code check');
  const impl = { address: '0x' + '33'.repeat(20), cert, valid: true, live: { codeHash: H } };
  assert.equal(st({ impl }).status, 'valid');
  assert.deepEqual(st({ impl: { ...impl, cert: { ...cert, issuedAt: 0n } } }).reason, 'implementationUncertified');
  assert.deepEqual(st({ impl: { ...impl, live: { codeHash: S } } }).reason, 'implementation_code_changed');
  assert.deepEqual(st({ impl: { ...impl, address: null } }).reason, 'implementationUnknown');
  assert.deepEqual(st({ impl: { ...impl, live: { error: 'x' } } }).reason, 'implementationUnreadable');
  for (const s of aas.STATUSES) assert.ok(AAS.en[`st_${s}`], s);
});

test('the badge is a static, script-free SVG with the state (and escapes what it prints)', () => {
  for (const s of [...aas.STATUSES, 'scanned', 'issues']) {
    const svg = aas.badgeSvg({ status: s, level: 2 });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*<\/svg>$/s);
    assert.doesNotMatch(svg, /<script|on\w+=|href|<foreignObject|url\(/i, s);
  }
  assert.match(aas.badgeSvg({ status: 'valid', level: 3 }), /VALID · GOLD/);
  assert.match(aas.badgeSvg({ status: 'code_changed', level: 3 }), /CODE CHANGED</);
  assert.doesNotMatch(aas.badgeSvg({ status: 'expired', level: 3 }), /GOLD/, 'a level only on a valid badge');
  const evil = aas.badgeSvg({ status: 'valid', detail: '<script>"x"</script>' });
  assert.doesNotMatch(evil, /<script>/);
  assert.match(evil, /&lt;script&gt;&quot;x&quot;/);
  assert.equal(aas.badgeSvg({ status: 'nope' }).includes('NOT CERTIFIED'), true);
  const s = aas.embedSnippets(aas.chainOf('base'), '0x' + 'ab'.repeat(20));
  assert.equal(s.href, `https://app.sawasdeecoin.com/audit.html#8453:0x${'ab'.repeat(20)}`);
  assert.equal(s.img, `https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@audit-registry/badges/base-0x${'ab'.repeat(20)}.svg`);
});

test('the registry is untrusted input: anything malformed is dropped, strings are bounded', () => {
  const ok = { chain: 'base', chainId: '8453', address: '0x' + 'ab'.repeat(20), target: '0x' + 'ab'.repeat(20), codeHash: H, role: 'proxy', name: 'Vault<img>', level: 2,
    requestId: '7', issuedAt: '100', expiresAt: '200', revoked: false, report: 'https://github.com/acme/vault', reportHash: S, findings: { open: 0, valid: { high: 1 }, late: 0, fixed: 1 }, implementation: '0x' + 'cd'.repeat(20) };
  const r = aas.cleanRegistry({ generatedAt: '2026-10-30T00:00:00.000Z', certificate: '0x' + 'a4'.repeat(20), entries: [ok,
    { ...ok, chain: 'tron' }, { ...ok, chainId: '1' }, { ...ok, codeHash: '0x12' }, { ...ok, address: 'javascript:1' }, null, 7] });
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.name, 'Vaultimg');
  assert.deepEqual(e.findings, { open: 0, valid: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, late: 0, fixed: 1 });
  assert.equal(aas.cleanRegistry({ entries: [{ ...ok, report: 'javascript:alert(1)', level: 9, requestId: '-1' }] }).entries[0].report, '');
  assert.equal(aas.cleanRegistry({ entries: [{ ...ok, level: 9 }] }).entries[0].level, 0);
  assert.deepEqual(aas.cleanRegistry('nope').entries, []);
  assert.equal(aas.registryState({ ...e, revoked: true }, 150), 'revoked');
  assert.equal(aas.registryState(e, 150), 'valid');
  assert.equal(aas.registryState(e, 200), 'expired');
  assert.equal(aas.badgeFile({ chain: 'osmosis', address: 'osmo1../x' }), 'osmosis-osmo1.._x.svg');
});

test('8 languages: every key in every language, placeholders kept, statuses and levels translated', () => {
  const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([x, y]) => shape(y, `${at}/${x}`)) : [`${at}:${typeof v}`]);
  assert.deepEqual(Object.keys(AAS).sort(), [...LANG_CODES].sort());
  const en = shape(AAS.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(AAS[l]), en, l);
    for (const [key, v] of Object.entries(AAS.en)) {
      if (typeof v !== 'string') continue;
      for (const ph of v.match(/\{\w+\}/g) ?? []) assert.ok(AAS[l][key].includes(ph), `${l}.${key} keeps ${ph}`);
      if (l !== 'en' && !['mirrorYes', 'mirrorNo'].includes(key)) assert.ok(AAS[l][key].trim(), `${l}.${key}`);
    }
    assert.equal(AAS[l].levels.length, 4);
    assert.match(AAS[l].testnet + AAS[l].meaning, /ZETAPHY/);
  }
  for (const l of LANG_CODES.filter((x) => x !== 'en')) assert.notEqual(AAS[l].st_valid, AAS.en.st_valid, `${l}: translated`);
  for (const r of ['ok', 'none', 'finding', 'codeRevoked', 'expired', 'code', 'rpc', 'implementationUnknown', 'implementationUncertified', 'implementation_expired', 'implementation_revoked', 'implementation_code_changed', 'implementationUnreadable'])
    assert.ok(AAS.en[`r_${r}`], `reason ${r} has words`);
});

test('pages: shipped, strict-CSP friendly (no inline script/style), 8-language menu, in the sitemap; no Thai in the code', async () => {
  const build = read('build.mjs');
  for (const f of ['audit.html', 'audits.html', 'aas.css', 'aas-core.js', 'aas-i18n.js', 'aas-page.js', 'aas-verify.js', 'aas-directory.js']) assert.ok(build.includes(`'${f}'`), `${f} in HUB_FILES`);
  for (const f of ['audit.html', 'audits.html']) {
    const html = read(f);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, `${f}: no inline script`);
    assert.doesNotMatch(html, /\sstyle=|<style/, `${f}: no inline style`);
    assert.doesNotMatch(html, /\son\w+=/, `${f}: no inline handlers`);
    assert.equal((html.match(/<option value="(en|zh|es|ko|ja|ru|vi|th)">/g) ?? []).length, 8, f);
    assert.ok(HUB_PAGES.includes(`/${f}`), `${f} in the sitemap`);
  }
  for (const f of ['aas-core.js', 'aas-page.js', 'aas-verify.js', 'aas-directory.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /[฀-๿]/, `${f}: words live in aas-i18n.js`);
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, `${f}: DOM via textContent only`);
  }
  assert.doesNotMatch(read('aas-core.js'), /^import .* from '(?!\.\/)/m, 'aas-core.js: no npm imports (runs in the Action without npm ci)');
  // the build writes the fallback registry: empty, or a committed registry/audit-registry.json, cleaned
  const { aasRegistry } = await import('../build.mjs');
  assert.deepEqual(aasRegistry(join(tmpdir(), 'none.json')).entries, []);
  const dir = mkdtempSync(join(tmpdir(), 'aas-'));
  try {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ entries: [{ chain: 'base' }] }));
    assert.deepEqual(aasRegistry(join(dir, 'r.json')).entries, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(read('audit.js'), /href: 'audits\.html'/, 'the Audit tab links the directory');
  assert.ok(existsSync(new URL('../../.github/actions/zetaphy-audit/action.yml', import.meta.url)));
});
