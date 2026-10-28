#!/usr/bin/env node
// Trains, evaluates and exports Neuro's risk model.
//
//   node ml/train/train.js [--data a.jsonl,b.jsonl] [--out ml/out/candidate] [--seed neuro-ml] [--promote]
//
// Data: every *.jsonl given (default: ml/data/out/corpus.jsonl, the red-team
// evasions in ml/data/redteam/evasions.jsonl, and ml/data/out/public.jsonl /
// votes.jsonl when they exist). Split by a hash of each row's id: 65% train,
// 15% calibration, 20% held-out test. The current ml/model.json is scored on
// the same held-out rows; the candidate is "better" only if it beats it on
// AUC and on recall at 1% FPR without losing on either (see `isBetter`).
// --promote copies the candidate over ml/model.json + ml/metrics.json when
// it is better (CI never promotes: it opens a pull request instead).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FEATURES, FEATURE_VERSION } from '../features.js';
import { probability, checkModel } from '../model.js';
import { trainGBDT, fitPlatt, trainerMargin, round7, DEFAULTS } from './gbdt.js';
import { evaluate, recallAtFpr } from './metrics.js';

const ML = new URL('../', import.meta.url).pathname;
const RANK = { info: 0, good: 0, low: 1, medium: 2, high: 3 };
export const MARKET = FEATURES.filter((n) => n.startsWith('k_'));

export function loadRows(paths) {
  const rows = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  }
  // The same id twice (e.g. a red-team row re-recorded) keeps the last copy.
  return [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function bucket(id) {
  const h = createHash('sha256').update(String(id)).digest();
  return h.readUInt32BE(0) % 100;
}
/** Deterministic split by id. */
export function split(rows) {
  const out = { train: [], calib: [], test: [] };
  for (const r of rows) {
    const b = bucket(r.group ?? r.id);
    (b < 65 ? out.train : b < 80 ? out.calib : out.test).push(r);
  }
  return out;
}

export const vec = (row, names = FEATURES, mask = null) => names.map((n) => (mask && mask.has(n) ? 0 : (row.f?.[n] ?? 0)));

/** Probability thresholds for the levels the model may raise to: at least the floor, and tight enough on benign calibration rows. */
function levelThresholds(p, y) {
  const at = (fpr) => recallAtFpr(p, y, fpr).threshold ?? 1;
  const pick = (fpr, floor) => round7(Math.min(0.999, Math.max(floor, at(fpr) + 1e-6)));
  return { low: pick(0.1, 0.5), medium: pick(0.02, 0.8), high: pick(0.005, 0.95) };
}

/** Trains one model on rows (train + calib). Pure and deterministic for the same rows and params. */
export function trainModel(trainRows, calibRows, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const X = trainRows.map((r) => vec(r));
  const y = trainRows.map((r) => r.label);
  // Rows without market facts teach the model to work without them: every
  // row is also seen once more with its market facts removed.
  const mask = new Set(MARKET);
  const Xa = [...X, ...trainRows.map((r) => vec(r, FEATURES, mask))];
  const ya = [...y, ...y];
  const wa = [...trainRows, ...trainRows].map((r) => r.weight ?? 1);
  const m = trainGBDT(Xa, ya, { ...p, weights: wa });
  const calibZ = calibRows.map((r) => trainerMargin(m, vec(r)));
  const calib = fitPlatt(calibZ, calibRows.map((r) => r.label));
  const model = {
    format: 'neuro-ml-gbdt/1',
    featureVersion: FEATURE_VERSION,
    features: [...FEATURES],
    base: m.base,
    trees: m.trees,
    calib,
    thresholds: null,
    params: { trees: p.trees, depth: p.depth, lr: p.lr, lambda: p.lambda, minLeaf: p.minLeaf, subsample: p.subsample, colsample: p.colsample, maxBins: p.maxBins, seed: p.seed },
  };
  const calibP = calibRows.map((r) => probability(model, vec(r)));
  model.thresholds = levelThresholds(calibP, calibRows.map((r) => r.label));
  model.id = 'nml-' + createHash('sha256').update(JSON.stringify([model.trees, model.base, model.calib])).digest('hex').slice(0, 12);
  // Parity rows: margins computed by the TRAINER's code path; ml/test checks
  // that plain-JS inference (ml/model.js) on the exported JSON gives the same.
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  model.check = calibRows.slice(0, 8).map((r) => {
    const f = Object.fromEntries(Object.entries(r.f ?? {}).filter(([k]) => FEATURES.includes(k)));
    const z = trainerMargin(m, vec({ f }));
    return { f, margin: z, p: Math.round(sigmoid(calib.a * z + calib.b) * 1e9) / 1e9 };
  });
  return model;
}

/** Rules-only score: the level the fixed rules (+ simulation) gave, as 0..3 (+ a tiny tie-break on the rules-only level). */
const rulesScore = (r) => (RANK[r.level] ?? 0) + (RANK[r.rulesLevel] ?? 0) / 10;
const combinedLevel = (model, r, mask) => {
  const pr = probability(model, vec(r, model.features, mask));
  const th = model.thresholds;
  const ml = pr >= th.high ? 3 : pr >= th.medium ? 2 : pr >= th.low ? 1 : 0;
  return Math.max(RANK[r.level] ?? 0, ml);
};

/** Full evaluation of a model on held-out rows. */
export function evaluateModel(model, rows) {
  const y = rows.map((r) => r.label);
  const mask = new Set(MARKET);
  const p = rows.map((r) => probability(model, vec(r, model.features)));
  const pCode = rows.map((r) => probability(model, vec(r, model.features, mask)));
  const sol = rows.map((r, i) => i).filter((i) => rows[i].src === 'synthetic-sol' || rows[i].src === 'redteam');
  const pick = (arr, idx) => idx.map((i) => arr[i]);
  const levelHits = (level, scoreOf) => {
    const pos = rows.filter((r) => r.label === 1);
    const neg = rows.filter((r) => r.label === 0);
    return {
      recall: pos.length ? Math.round((pos.filter((r) => scoreOf(r) >= level).length / pos.length) * 10000) / 10000 : null,
      fpr: neg.length ? Math.round((neg.filter((r) => scoreOf(r) >= level).length / neg.length) * 10000) / 10000 : null,
    };
  };
  const byFamily = {};
  for (const r of rows) {
    const k = r.family;
    byFamily[k] ??= { n: 0, label: r.label, flaggedRules: 0, flaggedCombined: 0 };
    byFamily[k].n++;
    if ((RANK[r.level] ?? 0) >= 2) byFamily[k].flaggedRules++;
    if (combinedLevel(model, r, null) >= 2) byFamily[k].flaggedCombined++;
  }
  let lowered = 0;
  for (const r of rows) if (combinedLevel(model, r, null) < (RANK[r.level] ?? 0)) lowered++;
  return {
    model: evaluate(p, y),
    codeOnly: evaluate(pCode, y),
    solidityOnly: evaluate(pick(p, sol), pick(y, sol)),
    rulesOnly: { auc: evaluate(rows.map(rulesScore), y).auc }, // rules give levels, not probabilities: only the ranking is comparable
    // "medium or higher" as the alarm: what users see
    alarm: {
      rules: levelHits(2, (r) => RANK[r.level] ?? 0),
      combined: levelHits(2, (r) => combinedLevel(model, r, null)),
      combinedCodeOnly: levelHits(2, (r) => combinedLevel(model, r, mask)),
    },
    loweredByModel: lowered,
    byFamily,
  };
}

/** Candidate beats current: no worse on AUC and recall@1%FPR, and clearly better on one. */
export function isBetter(cand, cur) {
  if (!cur) return { better: true, why: 'no current model' };
  const a = cand.model; const b = cur.model;
  const dAuc = (a.auc ?? 0) - (b.auc ?? 0);
  const dRec = (a.recallAt1Fpr ?? 0) - (b.recallAt1Fpr ?? 0);
  const better = dAuc >= -1e-9 && dRec >= -1e-9 && (dAuc > 0.001 || dRec > 0.01);
  return { better, why: `AUC ${b.auc} -> ${a.auc} (${dAuc >= 0 ? '+' : ''}${dAuc.toFixed(4)}), recall@1%FPR ${b.recallAt1Fpr} -> ${a.recallAt1Fpr} (${dRec >= 0 ? '+' : ''}${dRec.toFixed(4)})` };
}

/** Leave-one-scam-family-out: train without a family, measure recall on it at the test set's 1%-FPR threshold. */
export function leaveFamilyOut(rows, params = {}) {
  const s = split(rows);
  const fams = [...new Set(rows.filter((r) => r.label === 1 && r.src === 'synthetic-sol').map((r) => r.family))].sort();
  const out = {};
  for (const fam of fams) {
    const m = trainModel(s.train.filter((r) => r.family !== fam), s.calib.filter((r) => r.family !== fam), { ...params, trees: Math.min(params.trees ?? DEFAULTS.trees, 80) });
    const benign = s.test.filter((r) => r.label === 0);
    const held = rows.filter((r) => r.family === fam);
    const pb = benign.map((r) => probability(m, vec(r)));
    const ph = held.map((r) => probability(m, vec(r)));
    const t = recallAtFpr([...pb, ...ph], [...pb.map(() => 0), ...ph.map(() => 1)], 0.01);
    const rulesAlarm = held.filter((r) => (RANK[r.level] ?? 0) >= 2).length / held.length;
    const combinedAlarm = held.filter((r) => combinedLevel(m, r, null) >= 2).length / held.length;
    out[fam] = { n: held.length, recallAt1Fpr: Math.round(t.recall * 1000) / 1000, rulesAlarm: Math.round(rulesAlarm * 1000) / 1000, combinedAlarm: Math.round(combinedAlarm * 1000) / 1000 };
  }
  return out;
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

export function defaultDataPaths() {
  return [`${ML}data/out/corpus.jsonl`, `${ML}data/redteam/evasions.jsonl`, `${ML}data/out/public.jsonl`, `${ML}data/out/votes.jsonl`];
}

async function main() {
  const paths = arg('data', null)?.split(',') ?? defaultDataPaths();
  const outDir = arg('out', `${ML}out/candidate`);
  const seed = arg('seed', DEFAULTS.seed);
  const rows = loadRows(paths);
  if (!rows.length) throw new Error('no training rows: run `node ml/data/build-corpus.js` first');
  const s = split(rows);
  console.error(`rows ${rows.length}: train ${s.train.length}, calib ${s.calib.length}, test ${s.test.length}`);
  const t0 = Date.now();
  const params = { seed };
  for (const k of ['trees', 'depth', 'lr', 'minLeaf']) if (arg(k, null) != null) params[k] = Number(arg(k, null));
  const model = trainModel(s.train, s.calib, params);
  const size = JSON.stringify(model).length;
  const evalCand = evaluateModel(model, s.test);
  const curPath = `${ML}model.json`;
  let evalCur = null;
  if (existsSync(curPath)) {
    try { evalCur = evaluateModel(checkModel(JSON.parse(readFileSync(curPath, 'utf8'))), s.test); } catch (e) { console.error(`current model unreadable: ${e.message}`); }
  }
  const decision = isBetter(evalCand, evalCur);
  const lofo = process.argv.includes('--no-lofo') ? null : leaveFamilyOut(rows, { seed });
  const sources = {};
  for (const r of rows) sources[r.src] = (sources[r.src] ?? 0) + 1;
  const metrics = {
    modelId: model.id, bytes: size, trees: model.trees.length, features: model.features.length, seconds: Math.round((Date.now() - t0) / 1000),
    data: { rows: rows.length, positives: rows.filter((r) => r.label === 1).length, sources, files: paths.filter(existsSync).map((p) => p.replace(ML, 'ml/')) },
    split: { train: s.train.length, calib: s.calib.length, test: s.test.length },
    thresholds: model.thresholds, calib: model.calib,
    heldOut: evalCand, current: evalCur ? { modelId: JSON.parse(readFileSync(curPath, 'utf8')).id, heldOut: evalCur } : null,
    decision, leaveFamilyOut: lofo,
    caveat: 'Held-out rows come from the same synthetic generators as the training rows (and synthetic market facts), so these numbers are optimistic for real contracts. See leaveFamilyOut and codeOnly for harder estimates.',
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/model.json`, JSON.stringify(model) + '\n');
  writeFileSync(`${outDir}/metrics.json`, JSON.stringify(metrics, null, 1) + '\n');
  writeFileSync(`${outDir}/decision.json`, JSON.stringify({ ...decision, modelId: model.id }) + '\n');
  console.log(JSON.stringify({ modelId: model.id, bytes: size, heldOut: evalCand.model, codeOnly: evalCand.codeOnly, alarm: evalCand.alarm, decision }, null, 1));
  if (process.argv.includes('--promote') && decision.better) {
    writeFileSync(curPath, JSON.stringify(model) + '\n');
    writeFileSync(`${ML}metrics.json`, JSON.stringify(metrics, null, 1) + '\n');
    console.error('promoted to ml/model.json');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
