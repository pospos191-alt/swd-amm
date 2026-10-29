#!/usr/bin/env node
// Neuro federated learning: a simulation of many browsers, honest and poisoned.
//
// Synthetic and labelled as such. A base GBDT is trained on a "source" world
// (what the synthetic corpus teaches); browsers then see a DRIFTED world (a
// new time-bomb family where a time gate means a trap, and fake renounces so
// "renounced" no longer means safe). Each browser holds a few labels from the
// drifted world and submits clipped + noised updates; the aggregator combines
// them with a plain mean or a trimmed mean. Attackers collude to push scam
// scores down.
//
//   node ml/fl/simulate.js                       # markdown table of every scenario
//   node ml/fl/simulate.js --rounds 40 --z 2
//
// The same function backs ml/test/fl.test.js.

import { trainModel } from '../train/train.js';
import { auc } from '../train/metrics.js';
import { rng } from '../lib/rng.js';
import { zeroHead, applyDelta, headInputs, probabilityFrom } from './head.js';
import { gateHead } from './gate.js';
import { localDelta } from './client.js';
import { privatize, epsilonOf, rhoPerRound } from './dp.js';
import { encodeUpdate } from './codec.js';
import { aggregateRound, DEFAULT_AGG } from './aggregate.js';

const FAKE_HASH = 'ab'.repeat(32);

/** One labelled row of the toy world. drift = 0 (source) or 1 (what browsers see). */
function worldRow(R, i, drift, tag) {
  const f = {
    r_level: R.int(4),
    r_ctl_renounced: R.bool(0.3) ? 1 : 0,
    p_time_gate: R.bool(0.25) ? 0.3 + 0.7 * R.float() : 0,
    m_sim_cannot_sell: R.bool(0.12) ? 1 : 0,
    k_top_holder: R.float(),
    k_top_holder_known: 1,
    o_rate_sstore: R.float() * 5,
    s_cat_mint: R.bool(0.3) ? R.float() * 2 : 0,
  };
  const renounced = drift ? 0.4 : -1.2;
  const time = drift ? 4.0 : 0;
  const z = -2.2 + 0.9 * f.r_level + 3 * f.m_sim_cannot_sell + time * f.p_time_gate + renounced * f.r_ctl_renounced
    + 1.5 * f.k_top_holder + (R.float() - 0.5) * 2;
  return { id: `${tag}-${i}`, label: R.float() < 1 / (1 + Math.exp(-z)) ? 1 : 0, f };
}

export function makeWorld({ seed = 'fl-world', sourceRows = 900, testRows = 1500, canaryRows = 600, trees = 30 } = {}) {
  const R = rng(seed);
  const source = Array.from({ length: sourceRows }, (_, i) => worldRow(R, i, 0, 'src'));
  const train = source.filter((_, i) => i % 5 !== 0);
  const calib = source.filter((_, i) => i % 5 === 0);
  const model = trainModel(train, calib, { trees, depth: 3, seed: `${seed}-gbdt` });
  const test = Array.from({ length: testRows }, (_, i) => worldRow(R, i, 1, 'tgt'));
  // What the aggregator holds and nobody can submit to: labelled rows of the
  // world the model was built for (the corpus' held-out split in CI).
  const canaries = Array.from({ length: canaryRows }, (_, i) => worldRow(R, i, 0, 'can'));
  return { model, test, canaries };
}

function evalHead(model, head, rows) {
  const p = rows.map((r) => probabilityFrom(model, head.theta, r.phi));
  const y = rows.map((r) => r.label);
  let correct = 0; let ll = 0;
  for (let i = 0; i < p.length; i++) {
    correct += (p[i] >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
    const q = Math.min(Math.max(p[i], 1e-9), 1 - 1e-9);
    ll -= y[i] ? Math.log(q) : Math.log(1 - q);
  }
  return { auc: auc(p, y), acc: correct / p.length, logloss: ll / p.length };
}

/**
 * The attackers' update: every coordinate at the largest magnitude the
 * aggregator accepts, in the direction that lowers scam scores, on as many
 * coordinates as the norm check allows. All attackers send the same vector.
 */
function attackVector(model, rows, round, sigmas) {
  const d = rows[0].phi.length;
  const dir = new Float64Array(d);
  for (const r of rows) if (r.label === 1) for (let i = 0; i < d; i++) dir[i] += r.phi[i];
  const s = round.z * round.clip;
  const coordMax = (round.clip + sigmas * s) * 0.999;
  const normMax = (round.clip + s * (Math.sqrt(d) + sigmas)) * 0.999;
  const order = [...dir.keys()].sort((a, b) => Math.abs(dir[b]) - Math.abs(dir[a]));
  const m = Math.max(1, Math.min(d, Math.floor((normMax / coordMax) ** 2)));
  const v = new Float64Array(d);
  for (const i of order.slice(0, m)) v[i] = -Math.sign(dir[i] || 1) * coordMax;
  return v;
}

/**
 * Runs federated rounds.
 * @param {object} o  {rounds, perRound, population, attackers (fraction of each round), attack: 'none'|'flip'|'push',
 *                     method: 'mean'|'trimmed'|'median', trim, clip, z, serverLr, seed, leaves, maxNorm,
 *                     gate: true = the canary gate may refuse a round,
 *                     labelNoise: {fp, fn} = automatic-label noise: each browser label 0 becomes 1 with
 *                       probability fp (an honest pool migration read as "liquidity pulled") and 1 becomes 0
 *                       with probability fn (a trap that fired after the observation window)}
 */
export function simulate(o = {}) {
  const opt = { rounds: 30, perRound: 300, population: 3000, attackers: 0, attack: 'none', method: 'trimmed', trim: 0.2,
    clip: 1, z: 2, serverLr: 1, seed: 'fl-sim', local: {}, world: null, leaves: false, maxNorm: 4, gate: true, ...o };
  const world = opt.world ?? makeWorld();
  const { model } = world;
  const R = rng(opt.seed);
  let head = zeroHead(model, { leaves: opt.leaves, maxNorm: opt.maxNorm });
  const prep = (r) => ({ ...r, y: r.label, phi: headInputs(model, head, r.f) });
  const test = world.test.map(prep);
  // each browser: 1-8 labels from the drifted world
  const clients = Array.from({ length: opt.population }, (_, c) => Array.from({ length: 1 + R.int(8) }, (_, k) => prep(worldRow(R, k, 1, `c${c}`))));
  if (opt.labelNoise) { // its own generator: the other scenarios' draws stay the same
    const N = rng(`${opt.seed}-label-noise`);
    for (const rows of clients) for (const r of rows) if (N.float() < (r.y ? opt.labelNoise.fn : opt.labelNoise.fp)) r.y = 1 - r.y;
  }
  const attackerPool = Array.from({ length: 6 }, (_, k) => prep(worldRow(R, k, 1, `a${k}`))).concat(test.slice(0, 200));
  const reference = head; // the governance-approved model (theta = 0): the gate compares against it, not the last round, so small losses cannot ratchet
  const before = evalHead(model, head, test);
  const rounds = [];
  const participation = new Map();
  for (let t = 0; t < opt.rounds; t++) {
    const round = { headHash: FAKE_HASH, round: t, dim: head.dim, clip: opt.clip, z: opt.z };
    const nBad = Math.round(opt.attackers * opt.perRound);
    const subs = [];
    for (let k = 0; k < opt.perRound - nBad; k++) {
      const c = R.int(opt.population);
      participation.set(c, (participation.get(c) ?? 0) + 1);
      const raw = localDelta(model, head, clients[c], opt.local);
      const values = privatize(raw, opt, R.float);
      subs.push({ sender: `0xh${t}_${k}`, bytes: encodeUpdate({ ...round, values }) });
    }
    const push = opt.attack === 'push' ? attackVector(model, attackerPool, round, DEFAULT_AGG.sigmas) : null;
    for (let k = 0; k < nBad; k++) {
      let values;
      if (opt.attack === 'push') values = push;
      else { // label flipping, otherwise played by the rules (clipped + noised)
        const flipped = clients[R.int(opt.population)].map((r) => ({ ...r, y: 1 - r.y }));
        values = privatize(localDelta(model, head, flipped, opt.local), opt, R.float);
      }
      subs.push({ sender: `0xa${t}_${k}`, bytes: encodeUpdate({ ...round, values }) });
    }
    const res = aggregateRound(subs, round, { method: opt.method, trim: opt.trim, serverLr: opt.serverLr, minUpdates: 10 });
    let gated = null;
    if (res.delta) {
      const cand = applyDelta(head, res.delta, 1);
      gated = opt.gate ? gateHead(model, reference, cand, world.canaries, opt.gateOpts) : { ok: true };
      head = gated.ok ? cand : { ...head, round: head.round + 1 };
    }
    rounds.push({ round: t, accepted: res.accepted.length, rejected: res.rejected.length, gated: gated && !gated.ok, ...evalHead(model, head, test) });
  }
  const maxRounds = Math.max(0, ...participation.values());
  return { before, after: rounds.at(-1), rounds, refused: rounds.filter((r) => r.gated).length, head, model, maxRoundsPerUser: maxRounds,
    epsilonWorstUser: epsilonOf(maxRounds * rhoPerRound(opt.z)), epsilonPerRound: epsilonOf(rhoPerRound(opt.z)) };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const base = { rounds: arg('rounds', 30), z: arg('z', 2), perRound: arg('per-round', 300), world: makeWorld() };
  const runs = [
    ['honest, plain mean', { method: 'mean' }],
    ['honest, trimmed mean 20%', {}],
    ['honest, median', { method: 'median' }],
    ['honest, trimmed mean, head also re-weights every tree (leaves)', { leaves: true }],
    ['honest, trimmed mean, gate off', { gate: false }],
    ['honest, trimmed mean, no noise (z = 0, no privacy; reference only)', { z: 0 }],
    ['honest, trimmed mean, no noise, gate off (reference only)', { z: 0, gate: false }],
    ['honest, trimmed mean, automatic-label noise 10% false scam / 30% missed scam', { labelNoise: { fp: 0.1, fn: 0.3 } }],
    ['honest, trimmed mean, automatic-label noise 5% false scam / 10% missed scam', { labelNoise: { fp: 0.05, fn: 0.1 } }],
    ['20% label flippers, plain mean', { attackers: 0.2, attack: 'flip', method: 'mean' }],
    ['20% label flippers, trimmed mean', { attackers: 0.2, attack: 'flip' }],
    ['15% colluding push-down, plain mean, no gate', { attackers: 0.15, attack: 'push', method: 'mean', gate: false }],
    ['15% colluding push-down, trimmed mean, no gate', { attackers: 0.15, attack: 'push', gate: false }],
    ['15% colluding push-down, trimmed mean + gate', { attackers: 0.15, attack: 'push' }],
  ];
  console.log('| scenario | AUC before | AUC after | accuracy before | accuracy after | log-loss after | rounds refused by gate |\n|---|---:|---:|---:|---:|---:|---:|');
  let last = null;
  for (const [name, o] of runs) {
    const r = simulate({ ...base, ...o });
    last = r;
    const f = (x) => x.toFixed(3);
    console.log(`| ${name} | ${f(r.before.auc)} | ${f(r.after.auc)} | ${f(r.before.acc)} | ${f(r.after.acc)} | ${f(r.after.logloss)} | ${r.refused} |`);
  }
  console.log(`\nz = ${base.z}: epsilon per submitted round ${last.epsilonPerRound.toFixed(2)} (delta 1e-5, user level, local); busiest simulated user joined ${last.maxRoundsPerUser} rounds -> epsilon ${last.epsilonWorstUser.toFixed(2)} (a real browser stops at its budget, see dp.js PrivacyLedger)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
