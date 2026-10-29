#!/usr/bin/env node
// Builds the synthetic labelled corpus: generated Solidity tokens (every
// scam and benign family, with renamed functions and noise), compiled with
// and without the optimizer, read by Neuro's own reader + rules + buy/sell
// simulation on an in-memory EVM; plus tests-10k's dispatcher-only samples.
//
//   node ml/data/build-corpus.js [--per-family 60] [--dispatch 600] [--seed neuro-ml-v1] [--out ml/data/out/corpus.jsonl]
//
// Deterministic for a seed. No network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeSample, SCAM_FAMILIES, BENIGN_FAMILIES } from './solgen.js';
import { runSamples, freshChain } from '../lib/pipeline.js';
import { dispatchRows } from './synth-dispatch.js';
import { syntheticMarket } from './market.js';
import { rng } from '../lib/rng.js';

export function corpusSamples({ perFamily = 60, seed = 'neuro-ml-v1' } = {}) {
  const R = rng(seed);
  const samples = [];
  for (const family of [...SCAM_FAMILIES, ...BENIGN_FAMILIES]) {
    const scam = SCAM_FAMILIES.includes(family);
    for (let i = 0; i < perFamily; i++) {
      const mutations = [];
      if (R.bool(scam ? 0.5 : 0.3)) mutations.push('rename');
      if (R.bool(0.3)) mutations.push('noise');
      samples.push({ ...makeSample(R, { id: `${family}-${i}`, family, mutations }), opt: i % 2 === 0 });
    }
  }
  return samples;
}

export async function buildCorpus({ perFamily = 60, dispatch = 600, seed = 'neuro-ml-v1', log = () => {} } = {}) {
  const samples = corpusSamples({ perFamily, seed });
  const MR = rng(`${seed}-market`);
  const markets = new Map(samples.map((s) => [s.id, syntheticMarket(MR, s.label)]));
  const rows = [];
  const errors = [];
  const chain = await freshChain();
  for (const optimize of [true, false]) {
    const part = samples.filter((s) => s.opt === optimize);
    for (let i = 0; i < part.length; i += 80) {
      const r = await runSamples(part.slice(i, i + 80), { optimize, chain, marketOf: (s) => markets.get(s.id) });
      rows.push(...r.rows);
      errors.push(...r.errors);
      log(`  ${optimize ? 'opt' : 'noopt'} ${Math.min(i + 80, part.length)}/${part.length} (errors ${errors.length})`);
    }
  }
  rows.push(...dispatchRows(dispatch, `${seed}-dispatch`));
  return { rows, errors };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = arg('out', new URL('./out/corpus.jsonl', import.meta.url).pathname);
  const t0 = Date.now();
  const { rows, errors } = await buildCorpus({
    perFamily: Number(arg('per-family', 60)), dispatch: Number(arg('dispatch', 600)), seed: arg('seed', 'neuro-ml-v1'),
    log: (m) => console.error(m),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const by = {};
  for (const r of rows) by[r.family] = (by[r.family] ?? 0) + 1;
  console.log(JSON.stringify({ out, rows: rows.length, errors: errors.length, seconds: Math.round((Date.now() - t0) / 1000), byFamily: by }, null, 1));
  if (errors.length) console.error(errors.slice(0, 5));
}
