// Every language must say everything English says, with no gaps and no
// "undefined" leaking into what a user reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, explain, uiText, pickLang } from '../src/explain.js';
import * as en from '../src/lang/en.js';

const FULL = {
  name: 'Name', symbol: 'SYM', decimals: 6, totalSupply: '123456789', functions: ['m::mint', 'm::pause'], issuer: 'Circle',
  holder: '0xabc', where: 'object', policy: 'compatible', package: '0xpkg', address: '0xaddr', account: true, standard: 'Coin',
  maxSupply: '999', structs: ['m::Refs'], packages: ['pkg'], interfaces: ['jetton_wallet'], wallet: false, admin: '0:ad', holders: 12,
  owner: '0xowner', implementation: '0ximpl', project: 'ZETAPHY', reason: 'drainer', count: 2, selectors: ['12345678'],
  official: '0xofficial', program: 'SPL Token', authority: 'Auth', delegate: 'Del', percent: 5, maxFee: '1', programId: 'Prog',
  paused: true, decreaseOnly: false, kind: 'stablecoin', type: '0x2::sui::SUI',
};
// Branches: no issuer, no holder, other `where`, wallet / other interfaces.
const VARIANTS = [
  FULL,
  { ...FULL, issuer: undefined },
  { ...FULL, issuer: undefined, holder: null, where: 'shared' },
  { ...FULL, issuer: undefined, holder: null, where: 'unknown' },
  { ...FULL, wallet: true },
  { ...FULL, interfaces: [], account: false, maxSupply: undefined, holders: undefined, decreaseOnly: true },
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
  assert.deepEqual(Object.keys(LANGS), ['th', 'en', 'zh', 'ja', 'ko', 'vi', 'id']);
});

// Params a finding always carries (the analyzer sets them unconditionally).
const REQUIRED = { 'known-issuer': ['issuer'], lookalike: ['issuer'] };
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
  assert.equal(pickLang('xx'), 'th');
  assert.equal(explain(report, 'xx').title, LANGS.th.LEVEL.high);
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
});
