#!/usr/bin/env node
// Neuro ML, stage 5: red team.
//
// Takes scam tokens and rewrites them to slip past Neuro without changing
// what they do: renamed functions, an owner that pretends to have renounced
// (owner() = 0) or hides behind a hash / XOR mask / tx.origin, the trap moved
// into a second contract, a custom (non-EIP-1967) proxy, traps that only
// close after some days or blocks, and traps that let the simulation through
// (gas price, empty origin, contract seller, 99% sale, gas left, coinbase).
// Each one is compiled, listed on the in-memory DEX and read by Neuro
// (rules + buy/sell simulation) and the current model. A scam that ends below
// "medium" is an evasion: it is written to the report and appended to
// ml/data/redteam/evasions.jsonl, which the next training run learns from and
// ml/test/redteam.test.js keeps as a regression set.
//
//   node ml/redteam/run.js [--n 120] [--seed <text>] [--model ml/model.json] [--out ml/out/redteam] [--no-record]
//   node ml/redteam/run.js --gaps [--model path]   # rewrite known-gaps.json for a model
//   node ml/redteam/run.js --refeature              # rebuild every recorded evasion from its recipe (new features)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { makeSample, SIM_TELLS } from '../data/solgen.js';
import { runSamples, freshChain } from '../lib/pipeline.js';
import { checkModel, probability } from '../model.js';
import { scoreReport, combine, RANK } from '../combine.js';
import { FEATURES } from '../features.js';
import { checksRank } from '../checks.js';
import { rng } from '../lib/rng.js';

const ML = new URL('../', import.meta.url).pathname;
export const EVASIONS = `${ML}data/redteam/evasions.jsonl`;
export const GAPS = `${ML}data/redteam/known-gaps.json`;

const SELL_TRAPS = ['honeypot', 'max-sell'];
const BASES = ['honeypot', 'max-sell', 'hidden-mint', 'blacklist-trap', 'seize', 'drain', 'high-tax', 'dormant-fee', 'stealth'];
const OWNER_STYLES = [null, 'fake-renounce', 'hashed-owner', 'xor-owner', 'origin-owner'];

/** One red-team recipe -> a sample. Each recipe has its own seed, so any one can be rebuilt alone. */
export function recipeOf(runSeed, i) {
  const R = rng(`${runSeed}:${i}`);
  const family = R.pick(BASES);
  const mutations = new Set(['rename']);
  if (R.bool(0.2)) mutations.delete('rename');
  const owner = R.pick(OWNER_STYLES);
  if (owner) mutations.add(owner);
  let tell = null;
  if (family === 'stealth') {
    const t = R.pick(['timebomb', 'block-ramp', 'sim-aware']);
    mutations.add(t);
    if (t === 'sim-aware') tell = R.pick(SIM_TELLS);
  }
  const hasSellCond = SELL_TRAPS.includes(family) || mutations.has('timebomb') || mutations.has('sim-aware');
  if (hasSellCond && R.bool(0.35)) mutations.add('split-guard');
  else if (R.bool(0.2)) mutations.add('proxy');
  if (R.bool(0.4)) mutations.add('noise');
  return { seed: `${runSeed}:${i}`, family, mutations: [...mutations].sort(), tell, opt: R.bool() };
}

export function sampleOf(recipe) {
  const R = rng(`${recipe.seed}:sample`);
  return { ...makeSample(R, { id: `rt-${recipe.seed.replace(/[^A-Za-z0-9]/g, '_')}`, family: recipe.family, mutations: recipe.mutations, tell: recipe.tell ?? undefined, label: 1 }), opt: recipe.opt, recipe };
}

/** Runs recipes through Neuro + model. Returns per-sample results. */
export async function attack(recipes, model, { chain = null } = {}) {
  const samples = recipes.map(sampleOf);
  const results = [];
  const errors = [];
  const c = chain ?? await freshChain();
  for (const optimize of [true, false]) {
    const part = samples.filter((s) => s.opt === optimize);
    if (!part.length) continue;
    const r = await runSamples(part, {
      optimize, chain: c,
      onRow: (row, { report, code, logicCode, sample }) => {
        const ml = model ? scoreReport(model, report, { code, logicCode }) : null;
        const combined = combine(report.analysis, ml);
        results.push({
          row: { ...row, src: 'redteam', recipe: sample.recipe },
          rulesLevel: report.analysis.level, combinedLevel: combined.level, p: ml?.p ?? null, top: ml?.top ?? [],
          evadedRules: RANK[report.analysis.level] < RANK.medium,
          evaded: RANK[combined.level] < RANK.medium,
        });
      },
    });
    errors.push(...r.errors);
  }
  return { results, errors };
}

function summarize(results) {
  const by = {};
  const add = (k, r) => {
    by[k] ??= { n: 0, caughtRules: 0, caughtCombined: 0 };
    by[k].n++;
    if (!r.evadedRules) by[k].caughtRules++;
    if (!r.evaded) by[k].caughtCombined++;
  };
  for (const r of results) {
    add(`family:${r.row.family}`, r);
    for (const m of r.row.mutations) add(`mutation:${m}`, r);
    if (r.row.tell) add(`tell:${r.row.tell}`, r);
  }
  return Object.fromEntries(Object.entries(by).sort());
}

function markdown(report) {
  const pct = (a, n) => (n ? `${Math.round((a / n) * 100)}%` : '-');
  const lines = [
    `# Neuro red-team report`, '',
    `Seed \`${report.seed}\`, model \`${report.modelId ?? 'none'}\`. ${report.total} scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.`,
    `An **evasion** is a scam whose shown level stays below "medium".`, '',
    `| | caught by rules + simulation | caught with the model |`, '|---|---:|---:|',
    `| all | ${pct(report.caughtRules, report.total)} | ${pct(report.caughtCombined, report.total)} |`,
  ];
  for (const [k, v] of Object.entries(report.byKind)) lines.push(`| ${k} (${v.n}) | ${pct(v.caughtRules, v.n)} | ${pct(v.caughtCombined, v.n)} |`);
  lines.push('', `## Evasions (${report.evasions.length})`, '');
  if (!report.evasions.length) lines.push('None.');
  for (const e of report.evasions.slice(0, 60)) {
    lines.push(`- \`${e.id}\` ${e.family} [${e.mutations.join(', ')}${e.tell ? `, tell=${e.tell}` : ''}]: rules ${e.rulesLevel}, shown ${e.combinedLevel}, p=${e.p}; sim ${e.sim}; top: ${e.top.map((t) => `${t.feature} ${t.effect > 0 ? '+' : ''}${t.effect}`).join(', ')}`);
  }
  if (report.errors.length) lines.push('', `## Build errors (${report.errors.length})`, '', ...report.errors.slice(0, 10).map((e) => `- ${e.id}: ${e.error.split('\n')[0]}`));
  return lines.join('\n') + '\n';
}

export function loadModel(path = `${ML}model.json`) {
  return existsSync(path) ? checkModel(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

export function readEvasions(path = EVASIONS) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Stored evasion rows the model (with the rules) still does not raise to "medium". */
export function gapsFor(model, rows = readEvasions()) {
  const out = [];
  for (const r of rows) {
    const pr = model ? probability(model, model.features.map((n) => r.f?.[n] ?? 0)) : 0;
    const th = model?.thresholds ?? {};
    const ml = pr >= th.high ? 3 : pr >= th.medium ? 2 : pr >= th.low ? 1 : 0;
    if (Math.max(RANK[r.level] ?? 0, ml, model ? checksRank(r.f) : 0) < RANK.medium) out.push({ id: r.id, family: r.family, mutations: r.mutations, tell: r.tell ?? null, p: Math.round(pr * 10000) / 10000 });
  }
  return out;
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const model = loadModel(arg('model', `${ML}model.json`));
  if (process.argv.includes('--refeature')) {
    // After a feature change: same recipes, same ids, rows read again with the current ml/features.js.
    const old = readEvasions();
    const { results, errors } = await attack(old.map((r) => r.recipe), null);
    if (errors.length || results.length !== old.length) throw new Error(`refeature: ${errors.length} build errors, ${results.length}/${old.length} rows`);
    const rows = results.map((r) => r.row).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const r of rows) {
      const was = old.find((o) => o.id === r.id);
      if (!was || was.level !== r.level || was.rulesLevel !== r.rulesLevel) throw new Error(`refeature: ${r.id} no longer reads the same`);
    }
    writeFileSync(EVASIONS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${rows.length} recorded evasions re-read with the current features`);
    return;
  }
  if (process.argv.includes('--gaps')) {
    const gaps = gapsFor(model);
    writeFileSync(GAPS, JSON.stringify({ modelId: model?.id ?? null, note: 'Recorded red-team evasions this model still misses (see ml/README.md). ml/test/redteam.test.js fails if any other recorded evasion slips back below medium.', gaps }, null, 1) + '\n');
    console.log(`${gaps.length} known gaps for ${model?.id}`);
    return;
  }
  const n = Number(arg('n', 120));
  const seed = arg('seed', 'neuro-redteam-1');
  const outDir = arg('out', `${ML}out/redteam`);
  const recipes = Array.from({ length: n }, (_, i) => recipeOf(seed, i));
  const t0 = Date.now();
  const { results, errors } = await attack(recipes, model);
  const evasions = results.filter((r) => r.evaded);
  const report = {
    seed, modelId: model?.id ?? null, total: results.length, seconds: Math.round((Date.now() - t0) / 1000),
    caughtRules: results.filter((r) => !r.evadedRules).length,
    caughtCombined: results.filter((r) => !r.evaded).length,
    byKind: summarize(results),
    evasions: evasions.map((r) => ({ id: r.row.id, family: r.row.family, mutations: r.row.mutations, tell: r.row.tell ?? null, rulesLevel: r.rulesLevel, combinedLevel: r.combinedLevel, p: r.p, sim: r.row.sim, top: r.top.slice(0, 4), recipe: r.row.recipe })),
    errors,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1) + '\n');
  writeFileSync(`${outDir}/report.md`, markdown(report));
  if (!process.argv.includes('--no-record') && evasions.length) {
    const have = new Map(readEvasions().map((r) => [r.id, r]));
    for (const r of evasions) have.set(r.row.id, r.row);
    mkdirSync(new URL('../data/redteam/', import.meta.url).pathname, { recursive: true });
    writeFileSync(EVASIONS, [...have.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(`red team: ${report.total} variants, rules caught ${report.caughtRules}, with model ${report.caughtCombined}, evasions ${evasions.length}, errors ${errors.length} (${report.seconds}s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
