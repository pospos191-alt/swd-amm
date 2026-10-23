// Every language must say everything English says, with no gaps and no
// "undefined" leaking into what a user reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, explain, uiText, pickLang } from '../src/explain.js';
import { THREAT_REASONS, reasonCode } from '../src/threat-reasons.js';
import * as en from '../src/lang/en.js';

const FULL = {
  name: 'Name', symbol: 'SYM', decimals: 6, totalSupply: '123456789', functions: ['m::mint', 'm::pause'], issuer: 'Circle',
  holder: '0xabc', where: 'object', policy: 'compatible', package: '0xpkg', address: '0xaddr', account: true, standard: 'Coin',
  maxSupply: '999', structs: ['m::Refs'], packages: ['pkg'], interfaces: ['jetton_wallet'], wallet: false, admin: '0:ad', holders: 12,
  owner: '0xowner', implementation: '0ximpl', project: 'ZETAPHY', reason: 'sweeps-approved-tokens', count: 2, selectors: ['12345678'],
  official: '0xofficial', program: 'SPL Token', authority: 'Auth', delegate: 'Del', percent: 5, maxFee: '1', programId: 'Prog',
  paused: true, decreaseOnly: false, kind: 'stablecoin', type: '0x2::sui::SUI',
  target: '0xtarget', match: 'exact', language: 'Solidity', compiler: 'v0.8.26', url: 'https://repo.sourcify.dev/1/0xa',
  label: 'pool', codeId: '42', codeHash: 'abc123', compiler: 'func', minter: 'osmo1minter', cap: '100', creator: 'osmo1creator', contract: 'osmo1hook',
  id: '840000:3', end: 900000, unlimited: false, share: 42.5, deployer: 'bc1pdeployer', size: 20480,
  dex: 'PancakeSwap V2', native: 'WBNB', buy: 4.5, sell: 12, why: 'no-pool',
  fingerprint: 'fp1:0123456789abcdef',
};
// Branches: no issuer, no holder, other `where`, wallet / other interfaces.
const VARIANTS = [
  FULL,
  { ...FULL, issuer: undefined },
  { ...FULL, issuer: undefined, holder: null, where: 'shared' },
  { ...FULL, issuer: undefined, holder: null, where: 'unknown' },
  { ...FULL, wallet: true },
  { ...FULL, interfaces: [], account: false, maxSupply: undefined, holders: undefined, decreaseOnly: true },
  { ...FULL, cap: null, label: undefined, match: 'partial', compiler: undefined },
  // Trade simulation: a sell that reverted, nothing bought, each skip reason.
  { ...FULL, sell: null, why: 'no-override' },
  { ...FULL, buy: 100, sell: null, why: 'buy-failed' },
  { ...FULL, why: 'error' },
];

test('every language has every message, menu name and UI label', () => {
  const keys = Object.keys(en.T);
  assert.ok(keys.length > 80);
  for (const [code, L] of Object.entries(LANGS)) {
    assert.deepEqual(Object.keys(L.T), keys, `${code}: message keys`);
    assert.deepEqual(Object.keys(L.LEVEL).sort(), Object.keys(en.LEVEL).sort(), `${code}: levels`);
    assert.deepEqual(Object.keys(L.UI).sort(), Object.keys(en.UI).sort(), `${code}: UI keys`);
    assert.deepEqual(Object.keys(L.UI.m).sort(), Object.keys(en.UI.m).sort(), `${code}: detail labels`);
    assert.ok(typeof L.NAME === 'string' && L.NAME.length > 1, `${code}: NAME`);
  }
  assert.deepEqual(Object.keys(LANGS), ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th', 'id']);
});

// Params a finding always carries (the analyzer sets them unconditionally).
const REQUIRED = { 'known-issuer': ['issuer'], lookalike: ['issuer'], 'sim-ok': ['buy', 'sell'], 'sim-cannot-sell': ['buy'] };
const keeps = (id, p) => (REQUIRED[id] ?? []).every((k) => p[k] != null);

test('no message prints undefined, null or [object …] for any branch', () => {
  for (const [code, L] of Object.entries(LANGS)) {
    for (const [k, fn] of Object.entries(L.T)) {
      for (const p of VARIANTS.filter((v) => keeps(k, v))) {
        const s = fn(p);
        assert.equal(typeof s, 'string', `${code} ${k}`);
        assert.ok(s.length > 3, `${code} ${k}`);
        assert.doesNotMatch(s, /undefined|null|\[object|NaN/, `${code} ${k}: ${s}`);
      }
    }
  }
});

test('explain works in every language and falls back sensibly', () => {
  const report = { analysis: { level: 'high', findings: [
    { id: 'move-caveat', severity: 'info', params: {} },
    { id: 'can-mint', severity: 'high', params: { functions: ['coin::mint'] } },
    { id: 'sui-coin', severity: 'info', params: { name: 'X', symbol: 'X', decimals: 0, totalSupply: '1' } },
    { id: 'future-finding', severity: 'low', params: {} },
  ] } };
  for (const code of Object.keys(LANGS)) {
    const out = explain(report, code);
    assert.equal(out.title, LANGS[code].LEVEL.high);
    assert.deepEqual(out.lines.map((l) => l.id), ['sui-coin', 'can-mint', 'future-finding', 'move-caveat']);
    assert.equal(out.lines[2].text, 'future-finding', 'unknown ids show their id, not a crash');
  }
  assert.equal(pickLang('xx'), 'en');
  assert.equal(explain(report, 'xx').title, LANGS.en.LEVEL.high);
  assert.equal(explain(report).title, LANGS.en.LEVEL.high, 'English by default');
  assert.equal(uiText('ja').m.package, LANGS.ja.UI.m.package);
});

test('each language is written in its own script', () => {
  const sample = (code) => Object.values(LANGS[code].T).map((f) => f(FULL)).join(' ');
  assert.match(sample('th'), /[฀-๿]/);
  assert.match(sample('zh'), /[一-鿿]/);
  assert.match(sample('ja'), /[぀-ヿ]/);
  assert.match(sample('ko'), /[가-힯]/);
  assert.match(sample('vi'), /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/);
  assert.match(sample('id'), /\b(dan|tidak|bisa)\b/);
  assert.match(sample('es'), /[ñáéíóú]/);
  assert.match(sample('es'), /\b(puede|tokens|suministro)\b/);
  assert.match(sample('ru'), /[А-Яа-яЁё]/);
});

// Wording states verifiable code facts, never a verdict about a person or
// project (docs/LEGAL.md). Finding ids (hashed into verdicts) may keep old
// names such as 'ton-scam'; only what a user reads is checked here.
const ACCUSATORY = /\bscam|fraud|\brug\b|rug ?pull|drainer|phishing|honeypot|หลอกลวง|กลโกง|กลลวง|โกง|ฉ้อโกง|เหรียญปลอม|骗|诈|欺诈|貔貅|詐欺|ハニーポット|フィッシング|偽物|사기|허니팟|피싱|가짜|lừa đảo|hàng giả|penipu|palsu|estafa|fraude|\btimo\b|falsificad|мошенн|скам|ханипот|фишинг|обман|подделк|фальшив|развод/i;

test('no message, reason or UI text uses an accusatory label', () => {
  for (const [code, L] of Object.entries(LANGS)) {
    for (const [k, fn] of Object.entries(L.T)) {
      for (const p of VARIANTS.filter((v) => keeps(k, v))) {
        for (const reason of [undefined, ...Object.keys(en.REASON)]) {
          const s = fn({ ...p, reason });
          assert.doesNotMatch(s, ACCUSATORY, `${code} ${k}: ${s}`);
        }
      }
    }
    for (const s of Object.values(L.REASON)) assert.doesNotMatch(s, ACCUSATORY, `${code} REASON: ${s}`);
    const ui = uiText(code);
    for (const k of ['disclaimer', 'correction', 'reproduce', 'reproduceHow', 'asWritten', 'footer', 'early', 'earlyHow']) {
      assert.doesNotMatch(ui[k], ACCUSATORY, `${code} UI.${k}`);
    }
    for (const k of ['earlyMatch', 'earlyRef']) assert.doesNotMatch(ui.m[k], ACCUSATORY, `${code} UI.m.${k}`);
  }
});

test('every language describes every ThreatRegistry category and has the disclaimer', () => {
  // ThreatRegistry.Reason (src/threat-reasons.js, without 'none'): code facts, never intent.
  const reasons = THREAT_REASONS.slice(1);
  for (const [code, L] of Object.entries(LANGS)) {
    assert.deepEqual(Object.keys(L.REASON), reasons, `${code}: REASON keys`);
    const flagged = L.T['network-flagged']({ reason: 'cannot-sell-in-simulation' });
    assert.ok(flagged.includes(L.REASON['cannot-sell-in-simulation']), `${code}: category shown as its description`);
    assert.ok(!/cannot-sell-in-simulation/.test(flagged), `${code}: raw category code not shown`);
    for (const r of reasons) assert.doesNotMatch(L.REASON[r], ACCUSATORY, `${code}: REASON.${r}`);
    for (const k of ['disclaimer', 'correction', 'reproduce', 'reproduceHow', 'asWritten']) {
      assert.ok(L.UI[k]?.length > 3, `${code}: UI.${k}`);
    }
    for (const k of ['verdict', 'command', 'rule', 'earlyMatch', 'earlyRef']) assert.ok(L.UI.m[k]?.length > 0, `${code}: UI.m.${k}`);
    // The early-warning notice says it is advisory and not part of the verdict.
    for (const k of ['early', 'earlyHow']) assert.ok(L.UI[k]?.length > 3, `${code}: UI.${k}`);
    assert.match(L.UI.earlyHow, /30/, `${code}: says when the patterns are published`);
  }
});

test('names and symbols are shown as written in the contract, not as Neuro\'s claim', () => {
  const report = { analysis: { level: 'info', findings: [
    { id: 'erc20', severity: 'info', params: { name: 'Totally Official', symbol: 'USDT', decimals: 0, totalSupply: '1' } },
    { id: 'not-erc20', severity: 'info', params: {} },
  ] } };
  for (const code of Object.keys(LANGS)) {
    const out = explain(report, code);
    assert.ok(out.lines[0].text.endsWith(uiText(code).asWritten), `${code}: ${out.lines[0].text}`);
    assert.ok(!out.lines[1].text.includes(uiText(code).asWritten), `${code}: only on lines that show a name`);
  }
});

test('reasonCode: a ThreatRegistry.Reason number becomes its code fact (the same order as the contract)', () => {
  assert.equal(reasonCode(0), undefined);
  assert.equal(reasonCode(1n), 'cannot-sell-in-simulation');
  assert.equal(reasonCode(5), 'same-name-as-known-token');
  assert.equal(reasonCode(7), 'other');
  assert.equal(reasonCode(99), 'other');
  assert.equal(THREAT_REASONS.length, 8);
});
