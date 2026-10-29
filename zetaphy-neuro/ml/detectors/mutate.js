#!/usr/bin/env node
// Evolving detectors (docs/future/markets.md, item 26): breeds new detector specs from the best
// ones. Mutations change a rule's threshold (often to a value seen in the data), its weight, its
// comparison, the bias, drop a rule or add one on a feature the data uses; crossover mixes the rules
// of two parents. A child is kept only if it beats its parent on held-out rows (Brier score), so the
// schedule never submits a variant that is worse offline. Deterministic for the same seed and rows.
//
//   node ml/detectors/mutate.js --parents parents.json --rows a.jsonl[,b.jsonl] [--held held.jsonl] [--round 1] [--n 8] [--out ml/out/detectors]
//     parents.json: [{ "organism": 3, "brier": 0.11, "spec": {...} }, ...]  (best first; from DetectorPool + the spec files)
//     rows: labelled feature rows (the ML corpus, resolved risk forecasts read by Neuro, arena exports)
//   node ml/detectors/mutate.js --predict --specs dir --rows rows.jsonl     # p (basis points) per spec and row, for Foresight commits

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FEATURES } from '../features.js';
import { rng } from '../lib/rng.js';
import { checkSpec, specHash, brierOf, predict, toBps, seedSpec, OPS, MAX_RULES } from './spec.js';

const gauss = (R) => { const u = R.float() || 1e-9; const v = R.float(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Values a feature takes in the rows (non-zero ones; 0 is the default), for data-driven thresholds. */
function valuesOf(rows, feature) {
  const out = [];
  for (const r of rows) { const v = r.f?.[feature]; if (v) out.push(v); }
  return out;
}

/** Features that appear in the rows (so an added rule can fire at all). */
function usedFeatures(rows) {
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r.f ?? {})) seen.add(k);
  return FEATURES.filter((f) => seen.has(f));
}

/** One mutation of a spec. Returns { spec, op }. */
export function mutate(spec, R, rows = []) {
  const s = structuredClone(checkSpec(spec));
  const ops = ['threshold', 'threshold', 'weight', 'weight', 'bias', 'flip', 'add', 'drop'];
  const op = R.pick(ops);
  const rule = s.rules.length ? R.pick(s.rules) : null;
  if (op === 'threshold' && rule) {
    const vals = valuesOf(rows, rule.feature);
    rule.threshold = vals.length && R.bool(0.6) ? R.pick(vals) : rule.threshold === 0 ? gauss(R) * 0.5 : rule.threshold * Math.exp(gauss(R) * 0.3);
  } else if (op === 'weight' && rule) {
    rule.weight = clamp(rule.weight + gauss(R) * 0.75, -20, 20);
  } else if (op === 'bias') {
    s.bias = clamp(s.bias + gauss(R) * 0.5, -20, 20);
  } else if (op === 'flip' && rule) {
    rule.op = OPS[(OPS.indexOf(rule.op) + 1) % OPS.length];
  } else if (op === 'drop' && s.rules.length > 1) {
    s.rules.splice(R.int(s.rules.length), 1);
  } else if (s.rules.length < MAX_RULES) {
    const feats = usedFeatures(rows);
    const feature = R.pick(feats.length ? feats : FEATURES);
    const vals = valuesOf(rows, feature);
    s.rules.push({ feature, op: '>=', threshold: vals.length ? R.pick(vals) : 1, weight: gauss(R) * 1.5 });
  }
  return { spec: checkSpec(s), op };
}

/** Child with rules from both parents (each rule kept with probability 1/2, at least one). */
export function crossover(a, b, R) {
  const A = checkSpec(a); const B = checkSpec(b);
  const pool = [...A.rules, ...B.rules];
  let rules = pool.filter(() => R.bool());
  if (!rules.length) rules = [R.pick(pool)];
  const seen = new Set();
  rules = rules.filter((r) => { const k = `${r.feature}${r.op}${r.threshold}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_RULES);
  return checkSpec({ ...A, bias: (A.bias + B.bias) / 2, rules });
}

const bucket = (id) => createHash('sha256').update(String(id)).digest().readUInt32BE(0) % 100;
/** Deterministic split: 70% to fit/compare during breeding, 30% held out for the keep-or-not decision. */
export function splitRows(rows) {
  const fit = []; const held = [];
  for (const r of rows) (bucket(r.id ?? JSON.stringify(r.f)) < 70 ? fit : held).push(r);
  return { fit, held };
}

/**
 * Breeds `n` children from ranked parents. Each child: pick a parent (better ones more often),
 * maybe cross it with another, then 1-3 mutations, then a short hill-climb on the fit rows. Kept only
 * if its held-out Brier beats the parent's by `margin`.
 */
export function evolve({ parents, rows, held: curated = null, round = 1, n = 8, seed = 'neuro-detectors', tries = 6, margin = 0.002 }) {
  if (!parents.length) parents = [{ organism: 0, spec: seedSpec() }];
  const R = rng(`${seed}:${round}`);
  // a curated held-out file (never contributable, never trained on) when given; else a fixed 30% split
  const { fit, held } = curated?.length ? { fit: rows, held: curated } : splitRows(rows);
  const scored = parents.map((p) => ({ ...p, spec: checkSpec(p.spec), hash: specHash(p.spec), held: brierOf(p.spec, held) }));
  const children = [];
  const seen = new Set(scored.map((p) => p.hash));
  for (let k = 0; k < n * tries && children.length < n; k++) {
    const p = scored[Math.min(scored.length - 1, Math.floor(R.float() ** 2 * scored.length))];
    let child = p.spec;
    const ops = [];
    if (scored.length > 1 && R.bool(0.3)) { child = crossover(child, R.pick(scored).spec, R); ops.push('crossover'); }
    for (let m = 1 + R.int(3); m > 0; m--) { const r = mutate(child, R, fit); child = r.spec; ops.push(r.op); }
    // hill-climb: a few more mutations kept only when the fit rows improve
    let best = brierOf(child, fit);
    for (let h = 0; h < 12; h++) {
      const r = mutate(child, R, fit);
      const b = brierOf(r.spec, fit);
      if (b < best) { child = r.spec; best = b; ops.push(r.op); }
    }
    child = checkSpec({ ...child, name: `r${round}-${k}`, parent: p.hash });
    const hash = specHash(child);
    if (seen.has(hash)) continue;
    const heldB = brierOf(child, held);
    if (p.held == null || heldB == null || heldB > p.held - margin) continue;
    seen.add(hash);
    children.push({ spec: child, specHash: hash, parent: p.hash, parentOrganism: p.organism ?? 0, ops, brierFit: round4(best), brierHeld: round4(heldB), parentHeld: round4(p.held) });
  }
  return { round, parents: scored.map((p) => ({ organism: p.organism ?? 0, specHash: p.hash, brierHeld: round4(p.held) })), fitRows: fit.length, heldRows: held.length, children };
}

const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

/** Forecasts (basis points) of each spec for each row: what a detector commits in ForesightRegistry. */
export function predictAll(specs, rows) {
  return rows.map((r) => ({ id: r.id, event: r.event ?? null, p: Object.fromEntries(specs.map((s) => [specHash(s), toBps(predict(s, r.f))])) }));
}

function readJsonl(paths) {
  const rows = [];
  for (const p of paths.split(',').filter(Boolean)) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows.filter((r) => r.label === 0 || r.label === 1);
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--predict')) {
    const dir = arg('specs', null);
    const specs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => checkSpec(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))));
    const rows = [];
    for (const line of readFileSync(arg('rows'), 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
    console.log(JSON.stringify(predictAll(specs, rows), null, 1));
  } else {
    const parentsPath = arg('parents', null);
    const parents = parentsPath && existsSync(parentsPath) ? JSON.parse(readFileSync(parentsPath, 'utf8')) : [];
    const rows = readJsonl(arg('rows', ''));
    if (!rows.length) { console.error('no labelled rows (--rows a.jsonl,b.jsonl)'); process.exit(1); }
    const out = arg('out', new URL('../out/detectors', import.meta.url).pathname);
    const held = arg('held', null) ? readJsonl(arg('held')) : null;
    const res = evolve({ parents, rows, held, round: Number(arg('round', 1)), n: Number(arg('n', 8)), seed: arg('seed', 'neuro-detectors') });
    mkdirSync(`${out}/specs`, { recursive: true });
    for (const c of res.children) writeFileSync(`${out}/specs/${c.specHash.slice(2, 18)}.json`, JSON.stringify(c.spec, null, 1) + '\n');
    writeFileSync(`${out}/summary.json`, JSON.stringify({ ...res, children: res.children.map(({ spec, ...rest }) => ({ name: spec.name, ...rest })) }, null, 1) + '\n');
    console.log(`round ${res.round}: ${res.children.length} children beat their parent on ${res.heldRows} held-out rows -> ${out}`);
  }
}
