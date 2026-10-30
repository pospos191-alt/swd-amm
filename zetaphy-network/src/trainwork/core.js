// Proof of useful work for AI training, runner side (docs/future/useful-work-training.md): the same code the
// hub's training Web Worker runs (zetaphy-hub/train-core.js), bound to Neuro's Keccak, plus the label-work
// unit (a) that turns a contract's code into a training row and an agreement verdict for UsefulWork.
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { keccak256 as k } from '../../../zetaphy-neuro/src/keccak.js';
import { codeFeatures } from '../../../zetaphy-neuro/ml/features.js';
import * as T from '../../../zetaphy-hub/train-core.js';
import { keccakHex } from '../../../zetaphy-hub/work-core.js';
import { scanVerdict } from '../usefulwork.js';

export { k, T };
export const art = (n) => JSON.parse(readFileSync(new URL(`../../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const MARKET = new Interface(art('TrainingMarket').abi);
export const POOL = new Interface(art('TrainingPool').abi);

export const emptyModel = T.emptyModel;
/** The model in force of the simulation: train-core.js baseModelOf (in production: zetaphy-neuro/ml/model.json). */
export const baseModel = (opts) => T.baseModelOf(k, opts);

/** The rows of shard j of a spec, and the shard ready to train on from the base model. */
export function shardOf(spec, base, j) {
  const rows = T.worldRows(spec.world, T.shardIds(spec.trainRange[0], spec.trainRange[1], spec.shards, j));
  return { rows, hash: T.rowsHash(k, rows), S: T.prepare(rows, base, spec.train) };
}

/** The held-out rows a revealed seed picks from the evaluation pool. */
export const heldoutRows = (spec, seed) => T.worldRows(spec.evalWorld ?? spec.world, T.heldoutIds(seed, spec.evalRange[0], spec.evalRange[1]));

// ------------------------------------------------------------------ work unit (a): label work
const Q = 1e6;
/**
 * A labelled training row from a contract's runtime code: Neuro's bytecode features (zetaphy-neuro/ml/
 * features.js codeFeatures, rounded to 1e-6 so engines that differ in the last bit of log1p still agree) and the
 * code-only rules level as a weak label. Its keccak is the verdict a UsefulWork scan job's seats agree on (k of n),
 * so an agreed row can join a training shard.
 */
export async function labelRow(job) {
  const { report } = await scanVerdict(job);
  const a = report.analysis ?? {};
  const f = codeFeatures(job.code);
  const features = Object.fromEntries(Object.keys(f).sort().map((n) => [n, Math.round(f[n] * Q) / Q]));
  const level = a.rulesLevel ?? a.level ?? 'info';
  const row = { codeHash: keccakHex(k, job.code), chain: job.chain, level, label: level === 'high' || level === 'critical' ? 1 : 0, features };
  return { row, verdict: keccakHex(k, new TextEncoder().encode(JSON.stringify(row))) };
}

/**
 * Detection table: P(caught) for a job of `segments` checkpoints with `faked` of them faked (a number, or a share
 * of the segments when < 1), `checks` distinct segments sampled.
 */
export function detectionTable({ segments = [8, 16, 32], faked = [1, 0.25, 0.5, 0.75], checks = [1, 2, 3, 4] } = {}) {
  const rows = [];
  for (const C of segments) {
    for (const f0 of faked) {
      const f = f0 < 1 ? Math.round(f0 * C) : f0;
      if (!rows.some((r) => r.segments === C && r.faked === f)) rows.push({ segments: C, faked: f, p: checks.map((s) => T.catchProbability(C, f, s)) });
    }
  }
  return { checks, rows };
}

/** The same probability measured: the contract's sampler (sampleSegments) over `trials` random draws. */
export function measuredCatch(segments, faked, checks, trials = 2000) {
  const fake = new Set(Array.from({ length: faked }, (_, i) => segments - 1 - i)); // which ones does not matter
  let caught = 0;
  for (let t = 0; t < trials; t++) {
    const rnd = keccakHex(k, new TextEncoder().encode(`trial:${segments}:${faked}:${checks}:${t}`));
    if (T.sampleSegments(k, rnd, 0, segments, checks).some((s) => fake.has(s))) caught++;
  }
  return caught / trials;
}
