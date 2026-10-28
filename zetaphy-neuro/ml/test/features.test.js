import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, extractFeatures, codeFeatures, opcodeStream, toVector, featureLabel } from '../features.js';
import { scanBytecode } from '../../src/bytecode.js';
import { analyze, withSimulation } from '../../src/analyze.js';

const hex = (ops) => ops.map((b) => b.toString(16).padStart(2, '0')).join('');
// CALLER PUSH1 0 SLOAD EQ PUSH2 0 0 JUMPI STOP  (an onlyOwner-style check)
const OWNER_CHECK = [0x33, 0x60, 0x00, 0x54, 0x14, 0x61, 0x00, 0x00, 0x57, 0x00];
// TIMESTAMP PUSH1 5 LT PUSH2 0 0 JUMPI
const TIME_GATE = [0x42, 0x60, 0x05, 0x10, 0x61, 0x00, 0x00, 0x57];

test('feature names are unique, stable and labelled', () => {
  assert.equal(new Set(FEATURES).size, FEATURES.length);
  assert.ok(FEATURES.length > 100 && FEATURES.length < 200, String(FEATURES.length));
  for (const n of FEATURES) {
    const l = featureLabel(n);
    assert.ok(l.en && l.th, n);
  }
});

test('extractFeatures: every name present, finite, deterministic, empty input ok', () => {
  const empty = extractFeatures();
  assert.deepEqual(Object.keys(empty).sort(), [...FEATURES].sort());
  for (const v of Object.values(empty)) assert.ok(Number.isFinite(v));
  const code = hex([...OWNER_CHECK, ...TIME_GATE, 0xff]);
  const a = extractFeatures({ code });
  const b = extractFeatures({ code });
  assert.deepEqual(a, b);
  assert.equal(toVector(a).length, FEATURES.length);
});

test('opcode walk skips PUSH data and the metadata tail', () => {
  // PUSH2 0xff 0xf4 hides SELFDESTRUCT/DELEGATECALL bytes; they are data.
  assert.deepEqual(opcodeStream('0x61fff400'), [0x61, 0x00]);
  const f = codeFeatures('0x61fff400');
  assert.equal(f.o_has_selfdestruct, 0);
  assert.equal(f.o_has_delegatecall, 0);
  assert.equal(codeFeatures('0xff').o_has_selfdestruct, 1);
  // metadata: a2 ... + 2-byte length: the SELFDESTRUCT inside it is ignored
  const meta = 'a2ff' + '0002';
  assert.equal(codeFeatures('0x00' + meta).o_has_selfdestruct, 0);
  assert.deepEqual(opcodeStream(''), []);
  assert.deepEqual(opcodeStream('0xzz'), []);
});

test('pattern detectors: owner check, time gate, hashed and XOR owner, tx.origin', () => {
  const owner = codeFeatures(hex(OWNER_CHECK));
  assert.ok(owner.p_caller_guard > 0);
  assert.equal(owner.p_time_gate, 0);
  const time = codeFeatures(hex(TIME_GATE));
  assert.ok(time.p_time_gate > 0);
  // CALLER ... SHA3 ... EQ JUMPI
  const hashed = codeFeatures(hex([0x33, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0x20, 0x60, 0x01, 0x54, 0x14, 0x61, 0x00, 0x00, 0x57]));
  assert.ok(hashed.p_hash_guard > 0);
  const xor = codeFeatures(hex([0x33, 0x60, 0x07, 0x18, 0x60, 0x01, 0x54, 0x14, 0x61, 0x00, 0x00, 0x57]));
  assert.ok(xor.p_xor_guard > 0);
  const origin = codeFeatures(hex([0x32, 0x60, 0x01, 0x54, 0x14, 0x61, 0x00, 0x00, 0x57]));
  assert.ok(origin.p_origin_guard > 0);
  // the same bytes hidden in PUSH32 data are not instructions
  const hidden = codeFeatures(hex([0x7f, ...OWNER_CHECK, ...TIME_GATE, ...new Array(32 - OWNER_CHECK.length - TIME_GATE.length).fill(0), 0x50]));
  assert.equal(hidden.p_caller_guard, 0);
  assert.equal(hidden.p_time_gate, 0);
});

test('rules, selectors and simulation become features', () => {
  // dispatcher with mint(address,uint256) + transfer + an unknown selector
  const sels = ['40c10f19', 'a9059cbb', 'deadbeef'];
  const code = [0x60, 0x00, 0x35, 0x60, 0xe0, 0x1c];
  for (const s of sels) code.push(0x80, 0x63, ...Buffer.from(s, 'hex'), 0x14, 0x61, 0x00, 0x00, 0x57);
  code.push(0x00);
  const s = scanBytecode(hex(code));
  const analysis = analyze({ hasCode: true, functions: s.functions, opcodes: s.opcodes, proxy: { kind: null }, token: { name: 'x', symbol: 'X' },
    owner: '0x' + '12'.repeat(20), unknownSelectors: s.unknownSelectors, dispatched: s.selectors.length });
  const sim = { dex: 'D', native: 'W', stage: 'sell-failed', bought: '5', buyTax: 0 };
  const report = { analysis: withSimulation(analysis, sim), functions: s.functions.map((f) => f.sig), unknownSelectors: s.unknownSelectors, proxy: { kind: null }, owner: '0x' + '12'.repeat(20) };
  const f = extractFeatures({ report, code: hex(code) });
  assert.equal(f.r_level, 3, 'rules level = high (owner mint), not the simulation level');
  assert.equal(f.r_ctl_owner, 1);
  assert.ok(f.s_cat_mint > 0);
  assert.ok(f.s_unknown > 0);
  assert.equal(f.m_sim_cannot_sell, 1);
  assert.equal(f.m_sell_tax, 1);
  assert.equal(f.m_sim_ok, 0);
});

test('market facts: missing stays unknown, given ones are scaled and flagged known', () => {
  const none = extractFeatures({});
  assert.equal(none.k_top_holder_known, 0);
  assert.equal(none.k_verified_known, 0);
  const m = extractFeatures({ market: { topHolderShare: 0.42, lpLocked: false, ageDays: 3, verified: 1, holders: 100, liquidityUsd: 5000, top10Share: 2 } });
  assert.equal(m.k_top_holder, 0.42);
  assert.equal(m.k_top_holder_known, 1);
  assert.equal(m.k_lp_locked, 0);
  assert.equal(m.k_lp_locked_known, 1);
  assert.equal(m.k_top10, 1, 'clamped');
  assert.equal(m.k_verified, 1);
  // Verified source from a report read with Sourcify
  assert.equal(extractFeatures({ report: { source: { match: 'full' } } }).k_verified, 1);
  assert.equal(extractFeatures({ report: { source: null } }).k_verified_known, 1);
  assert.equal(extractFeatures({ report: { source: null } }).k_verified, 0);
});
