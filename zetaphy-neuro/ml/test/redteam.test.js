// Red-team harness smoke test + regression set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { recipeOf, sampleOf, attack, loadModel, readEvasions, gapsFor, GAPS } from '../redteam/run.js';
import { RANK } from '../combine.js';

const MODEL = loadModel();

test('recipes are deterministic and rebuildable one by one', () => {
  assert.deepEqual(recipeOf('s', 3), recipeOf('s', 3));
  assert.notDeepEqual(recipeOf('s', 3), recipeOf('t', 3));
  const a = sampleOf(recipeOf('s', 7));
  const b = sampleOf(recipeOf('s', 7));
  assert.equal(a.source, b.source);
  assert.equal(a.label, 1);
});

test('harness smoke: hand-picked mutations compile, deploy, get read by Neuro and scored', { timeout: 120_000 }, async () => {
  const recipes = [
    { seed: 'smoke:1', family: 'honeypot', mutations: ['fake-renounce', 'rename'], tell: null, opt: false },
    { seed: 'smoke:2', family: 'stealth', mutations: ['timebomb', 'hashed-owner'], tell: null, opt: false },
    { seed: 'smoke:3', family: 'max-sell', mutations: ['split-guard', 'xor-owner'], tell: null, opt: false },
    { seed: 'smoke:4', family: 'hidden-mint', mutations: ['proxy'], tell: null, opt: false },
    { seed: 'smoke:5', family: 'stealth', mutations: ['sim-aware'], tell: 'iscontract', opt: false },
  ];
  const { results, errors } = await attack(recipes, MODEL);
  assert.deepEqual(errors, []);
  assert.equal(results.length, recipes.length);
  const by = Object.fromEntries(results.map((r) => [r.row.recipe.seed, r]));
  // A sell block is still seen by the simulation however the owner is hidden.
  assert.equal(by['smoke:1'].row.sim, 'sell-failed');
  assert.equal(by['smoke:1'].evaded, false);
  // The trap moved to another contract still blocks the simulated sale.
  assert.equal(by['smoke:3'].row.sim, 'sell-failed');
  // A custom proxy hides the token interface: rules flag the DELEGATECALL (medium).
  assert.equal(by['smoke:4'].rulesLevel, 'medium');
  // A trap that waits for time passes today's simulation: the rules alone miss it.
  assert.equal(by['smoke:2'].row.sim, 'done');
  assert.equal(by['smoke:2'].evadedRules, true);
  for (const r of results) {
    assert.ok(RANK[r.combinedLevel] >= RANK[r.rulesLevel], 'model never lowers');
    assert.equal(r.row.label, 1);
    assert.ok(r.p >= 0 && r.p <= 1);
  }
});

test('regression: every recorded evasion is caught now, except the listed known gaps', { skip: !MODEL || !existsSync(GAPS) }, () => {
  const rows = readEvasions();
  assert.ok(rows.length > 0);
  const known = JSON.parse(readFileSync(GAPS, 'utf8'));
  assert.equal(known.modelId, MODEL.id, 'known-gaps.json was made for the committed model (run `node ml/redteam/run.js --gaps`)');
  const allowed = new Set(known.gaps.map((g) => g.id));
  const now = gapsFor(MODEL, rows);
  const slipped = now.filter((g) => !allowed.has(g.id));
  assert.deepEqual(slipped, [], 'recorded evasions that slipped back below medium');
});
