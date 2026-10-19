import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explain } from '../src/explain.js';

test('every finding id used by analyze.js has Thai and English text', () => {
  const src = readFileSync(new URL('../src/analyze.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/(?:add\(|id: )'([a-z0-9-]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 10);
  for (const id of used) {
    for (const lang of ['th', 'en']) {
      const out = explain({ analysis: { level: 'info', findings: [{ id, severity: 'info', params: {} }] } }, lang);
      assert.notEqual(out.lines[0].text, id, `${lang} text missing for ${id}`);
    }
  }
});

test('supply is shown in whole tokens', () => {
  const r = { analysis: { level: 'info', findings: [{ id: 'erc20', severity: 'info',
    params: { name: 'X', symbol: 'X', decimals: 18, totalSupply: '1000000500000000000000000' } }] } };
  assert.match(explain(r, 'en').lines[0].text, /1,000,000\.5/);
  assert.equal(explain(r, 'th').title, 'ไม่พบจุดเสี่ยงจากกฎที่ตรวจ');
});

test('identity first, most serious next, caveat last', () => {
  const f = (id, severity) => ({ id, severity, params: {} });
  const r = { analysis: { level: 'high', findings: [
    f('owner-active', 'info'), f('can-change-fee', 'medium'), f('erc20', 'info'), f('bytecode-only', 'info'), f('can-mint', 'high'),
  ] } };
  assert.deepEqual(explain(r, 'en').lines.map((l) => l.id),
    ['erc20', 'can-mint', 'can-change-fee', 'owner-active', 'bytecode-only']);
});
