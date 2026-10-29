// Data plumbing: synthetic generator labels, public importer helpers (offline), vote import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSample, SCAM_FAMILIES, BENIGN_FAMILIES, sourceFile } from '../data/solgen.js';
import { permissiveLicense, csvColumn, spread, SOURCES } from '../data/import-public.js';
import { voteItems } from '../data/votes.js';
import { dispatchRows } from '../data/synth-dispatch.js';
import { syntheticMarket } from '../data/market.js';
import { loadRows, split } from '../train/train.js';
import { FEATURES } from '../features.js';
import { rng } from '../lib/rng.js';

test('generator: labels follow the family, deterministic source, one file compiles them all', () => {
  const R1 = rng('g'); const R2 = rng('g');
  for (const f of [...SCAM_FAMILIES, ...BENIGN_FAMILIES]) {
    const a = makeSample(R1, { id: f, family: f });
    const b = makeSample(R2, { id: f, family: f });
    assert.equal(a.source, b.source, f);
    assert.equal(a.label, SCAM_FAMILIES.includes(f) ? 1 : 0, f);
  }
  const t = makeSample(rng('x'), { id: 'x', family: 'plain', mutations: ['timebomb'], label: 1 });
  assert.equal(t.label, 1, 'a trap on a benign family is labelled by the caller');
  assert.throws(() => makeSample(rng('x'), { id: 'y', family: 'nope' }));
  assert.match(sourceFile([t]), /pragma solidity 0\.8\.26/);
});

test('tests-10k rows: labelled, weighted low, all features known names', () => {
  const rows = dispatchRows(40, 'dt');
  assert.equal(rows.length, 40);
  for (const r of rows) {
    assert.equal(r.src, 'tests-10k');
    assert.equal(r.weight, 0.3);
    for (const k of Object.keys(r.f)) assert.ok(FEATURES.includes(k), k);
  }
  assert.ok(rows.some((r) => r.label === 1) && rows.some((r) => r.label === 0));
  assert.deepEqual(dispatchRows(5, 'dt'), dispatchRows(5, 'dt'));
});

test('licence check accepts permissive licences only', () => {
  assert.equal(permissiveLicense('MIT License\n\nCopyright (c) 2022 Forta Foundation'), 'MIT');
  assert.equal(permissiveLicense('                                 Apache License\n                           Version 2.0, January 2004'), 'Apache-2.0');
  assert.equal(permissiveLicense('                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007'), null);
  assert.equal(permissiveLicense(''), null);
  for (const s of SOURCES) assert.ok(s.expectLicense && s.licenseUrl && s.note, s.key);
});

test('CSV column + deterministic spread', () => {
  const csv = 'contract_address,contract_tag\n0xAbC0000000000000000000000000000000000001,x\nnot-an-address,y\n0xabc0000000000000000000000000000000000001,dup\n';
  assert.deepEqual(csvColumn(csv, 'contract_address'), ['0xabc0000000000000000000000000000000000001']);
  assert.deepEqual(csvColumn(csv, 'missing'), []);
  assert.deepEqual(spread(['c', 'a', 'b'], 5), ['a', 'b', 'c']);
  assert.deepEqual(spread(Array.from({ length: 10 }, (_, i) => String(i)), 3), ['0', '3', '6']);
});

test('vote import keeps decided jobs only', () => {
  const items = voteItems([
    { chain: 'bsc', address: '0x' + '1'.repeat(40), flagged: true },
    { chain: 'bsc', address: '0x' + '2'.repeat(40), flagged: false },
    { chain: 'bsc', address: '0x' + '3'.repeat(40) },
    { address: 'bad', flagged: true },
  ]);
  assert.deepEqual(items.map((i) => i.label), [1, 0]);
});

test('synthetic market: sometimes absent, values in range', () => {
  const R = rng('m');
  let none = 0;
  for (let i = 0; i < 200; i++) {
    const m = syntheticMarket(R, i % 2);
    if (!m) { none++; continue; }
    if (m.topHolderShare != null) assert.ok(m.topHolderShare >= 0 && m.topHolderShare <= 1);
  }
  assert.ok(none > 20 && none < 140);
});

test('split is by id hash: stable, and disjoint', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, label: i % 2, f: {} }));
  const a = split(rows); const b = split([...rows].reverse());
  assert.deepEqual(a.test.map((r) => r.id).sort(), b.test.map((r) => r.id).sort());
  const ids = new Set();
  for (const part of [a.train, a.calib, a.test]) for (const r of part) { assert.ok(!ids.has(r.id)); ids.add(r.id); }
  assert.equal(ids.size, 300);
  assert.deepEqual(loadRows(['/nonexistent.jsonl']), []);
});
