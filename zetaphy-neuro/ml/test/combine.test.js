// "The model can raise but never lower a rules verdict", and it never
// touches the network verdict (src/verdict.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { combine, withModel, scoreReport, RANK } from '../combine.js';
import { checkModel } from '../model.js';
import { analyze, withSimulation } from '../../src/analyze.js';
import { verdictOf, verdictBody } from '../../src/verdict.js';
import { SELECTORS } from '../../src/selectors.generated.js';
import { rng } from '../lib/rng.js';

const MODEL = checkModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
const LEVELS = ['info', 'low', 'medium', 'high'];
const SELS = Object.entries(SELECTORS);

/** A random but well-formed EVM report: random known/unknown functions, owner state, proxy, opcodes, simulation. */
function randomReport(R) {
  const fns = R.shuffle(SELS).slice(0, R.int(16)).map(([selector, f]) => ({ selector, ...f }));
  const unknownSelectors = Array.from({ length: R.int(6) }, () => R.hex(4)).sort();
  const owner = R.pick([undefined, '0x' + '00'.repeat(20), '0x' + R.hex(20)]);
  const proxy = { kind: R.pick([null, null, null, 'eip1967', 'eip1167']) };
  const opcodes = { selfdestruct: R.bool(0.1), delegatecall: R.bool(0.1), callcode: false, create2: R.bool(0.1), call: R.bool(0.5), create: R.bool(0.1) };
  const token = { name: R.bool(0.1) ? 'Claim at gift-drop.xyz' : 'Tok', symbol: 'TK' };
  let analysis = analyze({ hasCode: true, functions: fns, opcodes, proxy, token, owner, unknownSelectors, dispatched: fns.length + unknownSelectors.length,
    known: R.bool(0.05) ? { symbol: 'USDT', issuer: 'Tether', kind: 'stablecoin', address: '0x' } : null });
  const sim = R.pick([null, { stage: 'done', buyTax: R.int(100), sellTax: R.int(100), bought: '1', sold: '1', dex: 'D', native: 'W' }, { stage: 'sell-failed', bought: '1', buyTax: 0 }, { stage: 'no-pool' }]);
  if (sim) analysis = withSimulation(analysis, sim);
  const code = Array.from({ length: R.int(400) }, () => R.int(256).toString(16).padStart(2, '0')).join('');
  return { report: { chain: 'bsc', address: '0x' + R.hex(20), analysis, functions: fns.map((f) => f.sig).sort(), unknownSelectors, owner, proxy, fingerprint: 'fp1:x' }, code };
}

test('combine(): never lower than the rules, for every rules level x every model level', () => {
  for (const rules of LEVELS) {
    for (const ml of [null, ...LEVELS, null]) {
      const a = { level: rules, control: 'owner', findings: [] };
      const c = combine(a, ml === null ? null : { p: 0.5, level: ml === 'info' ? null : ml, top: [] });
      assert.ok(RANK[c.level] >= RANK[rules], `${rules} + model ${ml} -> ${c.level}`);
      assert.equal(c.level, ml && RANK[ml] > RANK[rules] ? ml : rules);
      assert.equal(c.rulesLevel, rules);
    }
  }
});

test('combine(): an official issuer or registered template is raised to "low" at most', () => {
  for (const id of ['known-issuer', 'template-match']) {
    const c = combine({ level: 'info', findings: [{ id, severity: 'good' }] }, { p: 0.99, level: 'high', top: [] });
    assert.equal(c.level, 'low');
    const high = combine({ level: 'high', findings: [{ id, severity: 'good' }] }, { p: 0.01, level: null, top: [] });
    assert.equal(high.level, 'high', 'and still never lowered');
  }
});

test('real model on 600 random reports: never lowers, network verdict unchanged, explanation present', async () => {
  const R = rng('combine-property');
  let raised = 0;
  for (let i = 0; i < 600; i++) {
    const { report, code } = randomReport(R);
    const out = withModel(MODEL, report, { code });
    assert.ok(RANK[out.analysis.level] >= RANK[report.analysis.level], `case ${i}: ${report.analysis.level} -> ${out.analysis.level}`);
    assert.equal(out.analysis.findings, report.analysis.findings, 'findings untouched');
    assert.deepEqual(verdictBody(out), verdictBody(report), `case ${i}: verdict body`);
    if (i % 50 === 0) assert.equal(await verdictOf(out), await verdictOf(report));
    assert.ok(out.analysis.ml.p >= 0 && out.analysis.ml.p <= 1);
    assert.ok(out.analysis.ml.top.length <= 5);
    for (const t of out.analysis.ml.top) assert.ok(typeof t.label === 'string' && Number.isFinite(t.effect));
    if (out.analysis.ml.raised) raised++;
  }
  assert.ok(raised < 600, 'the model does not raise everything');
});

test('scoreReport(): Thai labels, model id, stable output', () => {
  const R = rng('score');
  const { report, code } = randomReport(R);
  const a = scoreReport(MODEL, report, { code, lang: 'th' });
  const b = scoreReport(MODEL, report, { code, lang: 'th' });
  assert.deepEqual(a, b);
  assert.equal(a.model, MODEL.id);
  assert.ok(a.top.every((t) => typeof t.label === 'string'));
});
