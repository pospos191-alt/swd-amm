#!/usr/bin/env node
// Data DAO attribution (docs/future/markets.md, item 16): how much did each contributor's labelled
// data improve Neuro's model on rows nobody contributed?
//
// Utility U(S) of a set S of contributors = -logloss on the fixed held-out rows of a model trained on
// the base corpus + the rows of S (the same gradient-boosted trees as ml/train, fewer trees so many
// models can be trained in one CI job). Two estimates:
//   - leave-one-contributor-out (loo): U(all) - U(all without c). Cheap (C + 1 models); undervalues
//     contributors whose data overlaps, and can go negative for data that hurts.
//   - Shapley, Monte Carlo (shapley): the mean over random orders of U(before + c) - U(before);
//     fair between overlapping contributors, costs about perms x C models (subsets are cached).
// Before training, rows another contributor already gave (same label + features) are dropped from the
// later submission (submission order), so copying a dataset earns nothing. Rows without a 0/1 label
// or with an unknown licence are not used. Shares are the positive scores normalised to sum to 1;
// a contributor with a score <= 0 gets nothing. The DataDAO poster turns shares into a merkle root
// with zetaphy-network/scripts/markets.js dao-root.
//
//   node ml/dao/attribute.js --base corpus.jsonl --held held.jsonl --contrib contributions.json
//        [--method loo|shapley] [--perms 20] [--trees 40] [--seed x] [--out ml/out/dao/report.json]
//   contributions.json: [{ "submission": 1, "account": "0x...", "files": ["a.jsonl"], "license": "CC0-1.0" }, ...]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { trainGBDT, trainerMargin, DEFAULTS } from '../train/gbdt.js';
import { auc, logloss } from '../train/metrics.js';
import { vec } from '../train/train.js';
import { rng } from '../lib/rng.js';

export const OPEN_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'CC-BY-4.0', 'ISC', 'Unlicense', 'own data'];
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const rowKey = (r) => createHash('sha256').update(JSON.stringify([r.label, Object.entries(r.f ?? {}).sort()])).digest('hex');
const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);

/** Drops unusable rows and rows an earlier contributor (or the base) already gave. */
export function dedupe(base, contributions) {
  const seen = new Set(base.map(rowKey));
  return [...contributions].sort((a, b) => a.submission - b.submission).map((c) => {
    const ok = OPEN_LICENSES.includes(c.license ?? 'own data');
    const kept = []; let duplicates = 0; let unusable = 0;
    for (const r of c.rows) {
      if (!ok || (r.label !== 0 && r.label !== 1)) { unusable++; continue; }
      const k = rowKey(r);
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k); kept.push(r);
    }
    return { ...c, rows: kept, given: c.rows.length, duplicates, unusable };
  });
}

/** A utility function over sets of contributor indexes, with a cache. */
export function makeUtility({ base, contributions, held, params = {} }) {
  const p = { ...DEFAULTS, trees: 40, ...params };
  const cache = new Map();
  const yHeld = held.map((r) => r.label);
  const XHeld = held.map((r) => vec(r));
  const fn = (set) => {
    const key = [...set].sort((a, b) => a - b).join(',');
    if (cache.has(key)) return cache.get(key);
    const rows = [...base, ...[...set].sort((a, b) => a - b).flatMap((i) => contributions[i].rows)];
    let out;
    if (!rows.length || new Set(rows.map((r) => r.label)).size < 2) {
      // nothing to learn from: predict the held-out base rate
      const prior = rows.length ? rows.reduce((s, r) => s + r.label, 0) / rows.length : 0.5;
      const pr = held.map(() => Math.min(Math.max(prior, 0.01), 0.99));
      out = { u: -logloss(pr, yHeld), logloss: logloss(pr, yHeld), auc: null, rows: rows.length };
    } else {
      const m = trainGBDT(rows.map((r) => vec(r)), rows.map((r) => r.label), { ...p, weights: rows.map((r) => r.weight ?? 1) });
      const pr = XHeld.map((x) => sigmoid(trainerMargin(m, x)));
      out = { u: -logloss(pr, yHeld), logloss: logloss(pr, yHeld), auc: auc(pr, yHeld), rows: rows.length };
    }
    cache.set(key, out);
    return out;
  };
  fn.cache = cache;
  return fn;
}

export function leaveOneOut(U, n) {
  const all = new Set(Array.from({ length: n }, (_, i) => i));
  const uAll = U(all).u;
  return Array.from({ length: n }, (_, i) => { const s = new Set(all); s.delete(i); return uAll - U(s).u; });
}

/** Monte Carlo Shapley values over `perms` random orders (deterministic seed). */
export function shapley(U, n, { perms = 20, seed = 'neuro-dao' } = {}) {
  const R = rng(seed);
  const sum = new Array(n).fill(0);
  for (let k = 0; k < perms; k++) {
    const order = R.shuffle(Array.from({ length: n }, (_, i) => i));
    const s = new Set();
    let prev = U(s).u;
    for (const i of order) {
      s.add(i);
      const cur = U(s).u;
      sum[i] += cur - prev;
      prev = cur;
    }
  }
  return sum.map((v) => v / perms);
}

/**
 * @param base           rows every model is trained on (the corpus)
 * @param contributions  [{submission, account, license, rows}]
 * @param held           held-out labelled rows (never contributable)
 */
export function attribute({ base, contributions, held, method = 'loo', perms = 20, seed = 'neuro-dao', params = {} }) {
  if (!held.length) throw new Error('no held-out rows');
  const contribs = dedupe(base, contributions);
  const U = makeUtility({ base, contributions: contribs, held, params });
  const scores = method === 'shapley' ? shapley(U, contribs.length, { perms, seed }) : leaveOneOut(U, contribs.length);
  const pos = scores.map((s) => Math.max(0, s));
  const tot = pos.reduce((a, b) => a + b, 0);
  const none = U(new Set());
  const all = U(new Set(contribs.map((_, i) => i)));
  return {
    format: 'neuro-dao-attribution/1', method, perms: method === 'shapley' ? perms : null, seed,
    heldRows: held.length, baseRows: base.length, modelsTrained: U.cache.size,
    params: { trees: params.trees ?? 40 },
    baseOnly: { logloss: r6(none.logloss), auc: r6(none.auc) },
    withAll: { logloss: r6(all.logloss), auc: r6(all.auc) },
    contributors: contribs.map((c, i) => ({
      submission: c.submission, account: c.account, given: c.given, used: c.rows.length, duplicates: c.duplicates, unusable: c.unusable,
      score: r6(scores[i]), share: tot > 0 ? r6(pos[i] / tot) : 0,
    })),
  };
}

function readJsonl(p) {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = (arg('base', '') || '').split(',').filter(Boolean).flatMap(readJsonl);
  const held = readJsonl(arg('held'));
  const contrib = JSON.parse(readFileSync(arg('contrib'), 'utf8')).map((c) => ({ ...c, rows: (c.files ?? []).flatMap(readJsonl) }));
  const report = attribute({ base, contributions: contrib, held, method: arg('method', 'loo'), perms: Number(arg('perms', 20)), seed: arg('seed', 'neuro-dao'), params: { trees: Number(arg('trees', 40)) } });
  const out = arg('out', new URL('../out/dao/report.json', import.meta.url).pathname);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  console.log(`${report.method}: ${report.contributors.length} contributors, ${report.modelsTrained} models; held-out logloss ${report.baseOnly.logloss} -> ${report.withAll.logloss} -> ${out}`);
}
