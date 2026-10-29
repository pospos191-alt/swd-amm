// Detector organisms (spec + mutation) and Data DAO attribution, on synthetic rows whose truth we know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpec, specHash, predict, brierOf, seedSpec, toBps, SPEC_FORMAT, foresightWeighted } from '../detectors/spec.js';
import { mutate, crossover, evolve, predictAll, splitRows } from '../detectors/mutate.js';

test('foresight weighting: skilled models count, unskilled ones do not; no skill at all = plain mean', () => {
  assert.equal(foresightWeighted([{ p: 0.9, skillBps: 3000 }, { p: 0.1, skillBps: 1000 }]), (0.9 * 3000 + 0.1 * 1000) / 4000);
  assert.equal(foresightWeighted([{ p: 0.9, skillBps: 2000 }, { p: 0.1, skillBps: 0 }]), 0.9);
  assert.equal(foresightWeighted([{ p: 0.8, skillBps: 0 }, { p: 0.2, skillBps: 0 }]), 0.5);
  assert.equal(foresightWeighted([]), null);
});
import { attribute, dedupe } from '../dao/attribute.js';
import { rng } from '../lib/rng.js';

/** Rows where a trap = cannot sell, or (hashed owner guard and high rules level). Other features are noise. */
function rows(n, seed, { flip = 0 } = {}) {
  const R = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const f = {
      m_sim_cannot_sell: R.bool(0.2) ? 1 : 0,
      p_hash_guard: R.bool(0.3) ? Math.round(R.float() * 100) / 100 : 0,
      r_level: R.int(4),
      o_size: Math.round(R.float() * 300) / 100,
      s_cat_mint: R.bool(0.3) ? 1 : 0,
    };
    let label = f.m_sim_cannot_sell === 1 || (f.p_hash_guard >= 0.5 && f.r_level >= 2) ? 1 : 0;
    if (flip && R.bool(flip)) label = 1 - label;
    for (const k of Object.keys(f)) if (f[k] === 0) delete f[k];
    return { id: `${seed}-${i}`, label, f };
  });
}

test('detector spec: checked, canonical hash, prediction, Brier', () => {
  const s = seedSpec();
  assert.equal(s.format, SPEC_FORMAT);
  assert.throws(() => checkSpec({ ...s, rules: [{ feature: 'no_such', op: '>=', threshold: 1, weight: 1 }] }), /unknown feature/);
  assert.throws(() => checkSpec({ ...s, rules: [{ feature: 'r_level', op: '==', threshold: 1, weight: 1 }] }), /op/);
  assert.throws(() => checkSpec({ ...s, rules: [] }), /rules/);
  assert.throws(() => checkSpec({ ...s, bias: Infinity }), /bias/);
  assert.match(specHash(s), /^0x[0-9a-f]{64}$/);
  assert.equal(specHash(s), specHash(JSON.parse(JSON.stringify(s))), 'same spec, same hash');
  assert.equal(specHash({ ...s, rules: s.rules.map((r) => ({ weight: r.weight, op: r.op, threshold: r.threshold, feature: r.feature })) }), specHash(s), 'key order does not matter');
  assert.notEqual(specHash({ ...s, bias: -1.9 }), specHash(s));
  assert.ok(predict(s, { m_sim_cannot_sell: 1, r_level: 3 }) > 0.9);
  assert.ok(predict(s, {}) < 0.2);
  assert.equal(toBps(1), 9999); assert.equal(toBps(0), 1);
  const b = brierOf(s, rows(200, 'b'));
  assert.ok(b > 0 && b < 0.25, `seed beats a coin flip: ${b}`);
});

test('mutation + crossover keep specs valid; evolution only keeps children better on held-out rows; deterministic', () => {
  const R = rng('m');
  const data = rows(600, 'evo');
  let s = seedSpec();
  for (let i = 0; i < 50; i++) s = mutate(s, R, data).spec; // never throws, always valid
  assert.doesNotThrow(() => checkSpec(s));
  assert.doesNotThrow(() => checkSpec(crossover(seedSpec(), s, R)));
  const a = evolve({ parents: [{ organism: 1, spec: seedSpec() }], rows: data, round: 3, n: 4 });
  const b = evolve({ parents: [{ organism: 1, spec: seedSpec() }], rows: data, round: 3, n: 4 });
  assert.deepEqual(a, b, 'deterministic for the same round and rows');
  assert.ok(a.children.length >= 1, 'something beats the hand-written seed');
  const { held } = splitRows(data);
  const parentHeld = brierOf(seedSpec(), held);
  for (const c of a.children) {
    assert.ok(c.brierHeld < parentHeld, `${c.brierHeld} < ${parentHeld}`);
    assert.equal(c.spec.parent, specHash(seedSpec()));
    assert.equal(c.specHash, specHash(c.spec));
    assert.equal(c.parentOrganism, 1);
  }
  const preds = predictAll(a.children.map((c) => c.spec), data.slice(0, 3));
  for (const p of preds) for (const v of Object.values(p.p)) assert.ok(Number.isInteger(v) && v >= 1 && v <= 9999);
});

test('data DAO attribution: useful data scores, noisy data scores less, copied data gets nothing', { timeout: 120_000 }, () => {
  const base = rows(80, 'base');
  const held = rows(300, 'held');
  const good = rows(200, 'good');
  const contributions = [
    { submission: 1, account: '0x' + '01'.repeat(20), license: 'CC0-1.0', rows: good },
    { submission: 2, account: '0x' + '02'.repeat(20), license: 'MIT', rows: rows(200, 'noisy', { flip: 0.45 }) },
    { submission: 3, account: '0x' + '03'.repeat(20), license: 'MIT', rows: good.map((r) => ({ ...r, id: `copy-${r.id}` })) },
    { submission: 4, account: '0x' + '04'.repeat(20), license: 'proprietary', rows: rows(50, 'closed') },
  ];
  const d = dedupe(base, contributions);
  assert.equal(d[2].rows.length, 0); assert.equal(d[2].duplicates, 200);
  assert.equal(d[3].rows.length, 0); assert.equal(d[3].unusable, 50);
  const loo = attribute({ base, contributions, held, method: 'loo', params: { trees: 20 } });
  const by = Object.fromEntries(loo.contributors.map((c) => [c.submission, c]));
  assert.ok(by[1].score > 0, `good data helps: ${by[1].score}`);
  assert.ok(by[1].score > by[2].score, 'more than noisy data');
  assert.equal(by[3].score, 0); assert.equal(by[3].share, 0);
  assert.equal(by[4].share, 0);
  assert.ok(Math.abs(loo.contributors.reduce((s, c) => s + c.share, 0) - 1) < 1e-5);
  assert.ok(loo.withAll.logloss > 0 && loo.baseOnly.logloss > 0);
  const sh = attribute({ base, contributions, held, method: 'shapley', perms: 4, params: { trees: 20 } });
  const bs = Object.fromEntries(sh.contributors.map((c) => [c.submission, c]));
  assert.ok(bs[1].share > bs[2].share);
  assert.equal(bs[3].share, 0);
  assert.ok(sh.modelsTrained <= 16, 'subsets are cached (4 contributors: at most 2^4 models)');
});
