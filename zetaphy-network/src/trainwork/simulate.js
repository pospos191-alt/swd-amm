// End-to-end simulation of proof of useful work for AI training on the in-memory chain
// (docs/future/useful-work-training.md). Six pool workers, one of them a CHEATER (fakes most of its training
// checkpoints) and one a lazy COPIER (copies other workers' sealed answers). Real contracts: TrainingMarket,
// TrainingPool, ModelEpochs, UsefulIssuance, WorkerReputation, UsefulWork, ZetaphyTimelock.
//
//   1. label work (a): a UsefulWork scan job whose verdict is a labelled training row (features + weak label);
//      3 seats, 2 must agree; the copier's copied commitment cannot be revealed;
//   2. training work (b): a feeder posts a round (4 shards x 8 segments) on top of the model in force
//      (ModelEpochs); w1, w2 train honestly, the cheater fakes 6 of 8 segments, the copier copies w1's seal;
//   3. spot-checks: a future block hash draws 2 segments per job and 3 verifiers per segment; verifiers re-run
//      and seal their digests; trainers open; the majority decides; the cheater is slashed;
//   4. evaluation work (c): the held-out seed (poster's secret x the draw) picks the held-out rows; 3
//      evaluators (no trainer of the round) measure AUC and recall at 1% FPR of base vs candidate;
//   5. accepted -> trainers paid (+ the subsidy), and a timelock vote schedules the new model version in
//      ModelEpochs.
// Deterministic for a fixed chain (the in-memory chain's block hashes are fixed); salts are random but change
// nothing that is reported.
//
// `env`: { createChain, workMocks, ZETA } (zetaphy-network/test/helpers: evm.js, workmocks.js), so the same
// functions back the test (test/trainwork.test.js) and the CLI (`node src/trainwork/cli.js simulate`).
import { ZeroAddress, ZeroHash, encodeBytes32String, keccak256 as ethKeccak } from 'ethers';
import { Address } from '@ethereumjs/util';
import { k, T, art, baseModel, labelRow } from './core.js';
import { TrainWorker } from './worker.js';
import { jobCommitment } from '../../../zetaphy-hub/work-core.js';
import { findStamp } from '../usefulwork.js';

const DAY = 86400;
const HOUR = 3600;
export const NAMES = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
export const ROLES = { w1: 'honest', w2: 'honest', w3: 'honest', w4: 'honest', w5: 'cheater', w6: 'copier' };

export function marketParams(ZETA) {
  return {
    trainSlash: 5n * ZETA, missSlash: ZETA, maxSubsidy: 10n * ZETA,
    seatWindow: HOUR, commitWindow: HOUR, revealWindow: HOUR, verifyCommitWindow: HOUR, verifyRevealWindow: HOUR,
    evalCommitWindow: HOUR, evalRevealWindow: HOUR,
    checksPerJob: 2, verifiersPerCheck: 3, evaluators: 3,
    trainBps: 6000, checkBps: 2000, evalBps: 1000, catchBps: 5000, minGainAuc: 50,
  };
}

/** Deploys the market and everything around it (governance: a 2-day timelock; `vote` runs a batch through it). */
export async function deployWorld(env, { names = NAMES, params } = {}) {
  const { createChain, workMocks, ZETA } = env;
  const c = await createChain(['gov', 'poster', 'faucet', 'keeper', ...names]);
  const A = (n) => c.acct[n].toString().toLowerCase();
  const tl = await c.deploy('ZetaphyTimelock', [2 * DAY, [A('gov')], [ZeroAddress], ZeroAddress], 'gov');
  let votes = 0;
  const vote = async (calls) => { // one timelock batch: proposed, 2 days, executed by anyone
    const targets = calls.map((x) => x[0].address), datas = calls.map((x) => x[0].iface.encodeFunctionData(x[1], x[2]));
    const salt = ethKeccak(encodeBytes32String(`vote-${votes++}`));
    await tl.send('gov', 'scheduleBatch', [targets, targets.map(() => 0), datas, ZeroHash, salt, 2 * DAY]);
    c.advance(2 * DAY + 1);
    await tl.send('keeper', 'executeBatch', [targets, targets.map(() => 0), datas, ZeroHash, salt]);
  };
  const m = workMocks();
  const runners = await c.deployRaw(m.MockRunners, [], 'gov');
  const ident = await c.deployRaw(m.MockIdentity, [], 'gov');
  const rep = await c.deploy('WorkerReputation', [A('gov'), runners.address, ident.address], 'gov');
  const epochs = await c.deploy('ModelEpochs', [tl.address, 10, 5], 'gov');
  const issuance = await c.deploy('UsefulIssuance', [tl.address, A('faucet')], 'gov');
  const pool = await c.deploy('TrainingPool', [tl.address, 10n * ZETA, 7 * DAY], 'gov');
  const market = await c.deploy('TrainingMarket', [tl.address, pool.address, issuance.address, rep.address, epochs.address, params ?? marketParams(ZETA)], 'gov');
  const uw = await c.deploy('UsefulWork', [A('gov'), rep.address, ZeroAddress, {
    stampBits: 10, stampSeats: 10, stampLife: DAY, seatsPerDay: 50, seats: 3, quorum: 2, commitWindow: 600, revealWindow: 600,
    seatDeposit: ZETA / 10n, subsidy: 0n, priorityScore: 0, priorityWindow: 0 }], 'gov');
  for (const r of [market, uw]) await rep.send('gov', 'setReporter', [r.address, true]);
  return { c, A, tl, vote, rep, epochs, issuance, pool, market, uw, ZETA };
}

const balanceOf = (W, addr) => W.c.balance(Address.fromString(addr));

/**
 * Opens the world by one timelock vote: the base model in force (ModelEpochs), the market in the pool, unpaused,
 * the poster as a feeder, a UsefulIssuance bucket for the market (funded with `issued`); workers join with `stake`.
 */
export async function openWorld(W, { behaviours = ROLES, stake = 20n * W.ZETA, issued = 100n * W.ZETA, log = () => {}, cheaterHonestSegments = 2 } = {}) {
  const { c, A, vote, epochs, issuance, pool, market, ZETA } = W;
  const base = baseModel();
  const at = (c.blockNumber() / 10n + 2n) * 10n + 10n;
  await vote([
    [epochs, 'schedule', [base.hash, at, 'trainwork://base']],
    [pool, 'setMarket', [market.address, true]],
    [market, 'setPaused', [false]],
    [market, 'setFeeder', [A('poster'), true]],
    [issuance, 'setBuckets', [[{ sink: market.address, bps: 2000, cap: 100n * ZETA, accrued: 0n }]]],
  ]);
  while (c.blockNumber() <= at) c.mine(5);
  if (issued > 0n) await issuance.sendValue('faucet', issued); // RewardVault's share would arrive here
  const store = new Map();
  const handle = (who) => ({ send: (fn, args, value = 0n) => market.send(who, fn, args, value), call: (fn, args) => market.call(fn, args) });
  const workers = Object.keys(behaviours).map((n) => new TrainWorker({ name: n, address: A(n), market: handle(n), store, behaviour: behaviours[n], honestSegments: cheaterHonestSegments, log }));
  for (const w of workers) await pool.send(w.name, 'join', [], stake);
  return Object.assign(W, { base, store, workers, byName: Object.fromEntries(workers.map((w) => [w.name, w])), stake });
}

/**
 * One training round, start to end: post, seats (`trainers`, in seat order), train + commit, reveal, draw,
 * spot-checks, held-out reveal, judge, evaluation, finalize. `hooks.afterReveal(W, id)` runs before the draw
 * (tests use it to withhold published trees). Returns the round's facts.
 */
export async function runRound(W, { spec, trainers, budget = 30n * W.ZETA, subsidy = 3n * W.ZETA, secret = '0x' + 'a5'.repeat(32), hooks = {} }) {
  const { c, A, market, workers, byName, base } = W;
  const id = await market.call('taskCount');
  const segments = spec.train.trees / spec.train.every;
  await market.send('poster', 'post', [T.specHash(k, T.specText(spec)), `trainwork://spec/${spec.seed}`, base.hash, spec.shards, segments, T.heldoutCommitment(k, secret, A('poster')), subsidy], budget);
  const seated = trainers.map((n) => byName[n]);
  for (const w of seated) await w.takeSeat(id);
  const committed = [];
  for (const w of seated) { await w.trainAndCommit(id, spec, base, committed); committed.push(w); }
  c.advance(2 * HOUR);
  for (const w of seated) await w.revealTraining(id);
  await hooks.afterReveal?.(W, id);
  c.advance(HOUR);
  await market.send('keeper', 'requestDraw', [id]);
  c.mine(2);
  await market.send('keeper', 'draw', [id]);
  const out = { id, spec, trainers, budget, subsidy, checks: [], evaluators: [] };
  const name = (a) => workers.find((w) => w.address === a.toLowerCase()).name;
  if (Number((await market.call('getTask', [id])).stage) === 1) {
    // spot-checks
    for (const w of workers) await w.verify(id, spec, base, workers);
    c.advance(HOUR);
    for (const w of seated) await w.openCheckpoints(id);
    await market.send('poster', 'revealHeldout', [id, secret]);
    for (const w of workers) await w.revealAnswers(id);
    c.advance(HOUR);
    await market.send('keeper', 'judge', [id]);
    const checks = await market.call('checksOf', [id]);
    for (let i = 0; i < checks.length - 1; i++) {
      out.checks.push({ job: Number(checks[i].job), trainer: seated[Number(checks[i].job)].name, segment: Number(checks[i].segment),
        verifiers: (await market.call('verifiersOf', [id, i])).map(name), status: ['open', 'pass', 'fail', 'inconclusive'][Number(checks[i].status)] });
    }
    out.evaluators = (await market.call('verifiersOf', [id, checks.length - 1])).map(name);
  }
  if (Number((await market.call('getTask', [id])).stage) === 2) {
    // evaluation work
    let metrics = null;
    for (const n of out.evaluators) metrics = (await byName[n].evaluate(id, spec, base, workers)) ?? metrics;
    c.advance(HOUR);
    for (const n of out.evaluators) await byName[n].revealAnswers(id);
    c.advance(HOUR);
    await market.send('keeper', 'finalize', [id, [metrics.baseAuc, metrics.candAuc, metrics.baseRecall, metrics.candRecall]]);
    out.heldoutRows = metrics.n;
    out.measured = metrics;
  }
  out.jobs = [];
  for (let j = 0; j < seated.length; j++) {
    const jb = await market.call('getJob', [id, j]);
    out.jobs.push({ trainer: seated[j].name, behaviour: seated[j].behaviour, status: ['pending', 'passed', 'failed', 'inconclusive', 'missed'][Number(jb.status)], treesHash: jb.treesHash });
  }
  out.task = await market.call('getTask', [id]);
  out.metrics = { baseAuc: Number(out.task.baseAuc) / 1e4, candAuc: Number(out.task.candAuc) / 1e4, baseRecall: Number(out.task.baseRecall) / 1e4, candRecall: Number(out.task.candRecall) / 1e4 };
  return out;
}

/** Do the market's and the pool's balances add up? { market, pool } */
export async function solvency(W) {
  const { market, pool } = W;
  return {
    market: (await balanceOf(W, market.address)) === (await market.call('totalOwed')) + (await market.call('reserve')) + (await market.call('escrow')),
    pool: (await balanceOf(W, pool.address)) === (await pool.call('totalStake')),
  };
}

/** Label work (a): one UsefulWork scan job whose verdict is a labelled row; seats w1, w2 and the copier w6. */
export async function labelWork(W) {
  const { c, A, uw, ZETA } = W;
  const code = art('VulnerableVault').deployedBytecode;
  const job = { chain: 'zetaphy', target: '0x' + '12'.repeat(20), code, codeHash: ethKeccak(code) };
  const id = await uw.call('jobCount');
  await uw.send('poster', 'post', [encodeBytes32String('zetaphy'), job.target, job.codeHash, 0], ZETA);
  const seats = ['w1', 'w2', 'w6'];
  const salts = {};
  let labelled;
  for (const n of seats) {
    const h = c.blockNumber() - 1n;
    await uw.send(n, 'stamp', [h, findStamp(1, await uw.call('stampSeed', [h]), A(n), 10)]);
  }
  for (const n of seats) {
    if (ROLES[n] === 'copier') { await uw.send(n, 'commit', [id, await uw.call('commitments', [id, A('w1')])], ZETA / 10n); continue; }
    labelled = await labelRow(job);
    salts[n] = '0x' + (seats.indexOf(n) + 1).toString(16).padStart(64, '0');
    await uw.send(n, 'commit', [id, jobCommitment(k, labelled.verdict, A(n), salts[n], id)], ZETA / 10n);
  }
  let copier = 'accepted';
  for (const n of seats) {
    if (ROLES[n] === 'copier') { try { await uw.send(n, 'reveal', [id, labelled.verdict, salts.w1]); } catch (e) { copier = `refused (${e.message})`; } continue; }
    await uw.send(n, 'reveal', [id, labelled.verdict, salts[n]]);
  }
  c.advance(601);
  await uw.send('keeper', 'settle', [id]);
  return {
    row: { level: labelled.row.level, label: labelled.row.label, features: Object.keys(labelled.row.features).length },
    verdict: labelled.verdict,
    accepted: (await uw.call('getJob', [id])).result === labelled.verdict,
    paid: Object.fromEntries(await Promise.all(seats.map(async (n) => [n, await uw.call('owed', [A(n)])]))),
    copier,
  };
}

export async function simulate(env, { cheaterHonestSegments = 2, log = () => {} } = {}) {
  const W = await openWorld(await deployWorld(env), { log, cheaterHonestSegments });
  const { c, A, rep, epochs, issuance, pool, market, workers, base, ZETA, stake } = W;
  const report = { label: await labelWork(W), round: {}, workers: {}, compute: {} };
  report.round.baseModel = base.hash;
  report.round.baseInForce = (await epochs.call('current'))[2] === base.hash;

  const spec = T.makeSpec({ seed: 'round-1', shards: 4, baseModel: base.hash });
  const r = await runRound(W, { spec, trainers: ['w1', 'w2', 'w5', 'w6'] });
  Object.assign(report.round, { checks: r.checks, jobs: r.jobs, evaluators: r.evaluators, heldoutRows: r.heldoutRows, metrics: r.metrics,
    accepted: r.task.accepted, candidate: r.task.candidate, budget: r.budget, subsidy: r.subsidy });

  // the new model version, by a timelock vote
  if (r.task.accepted) {
    const next = (c.blockNumber() / 10n + 2n) * 10n + 10n;
    await W.vote([[epochs, 'schedule', [r.task.candidate, next, 'trainwork://task/0']]]);
    while (c.blockNumber() <= next) c.mine(5);
    report.round.inForce = (await epochs.call('current'))[2] === r.task.candidate;
  }

  for (const w of workers) {
    const mem = await pool.call('memberOf', [w.address]);
    const owed = await market.call('owed', [w.address]);
    const rr = await rep.call('recordOf', [w.address]);
    report.workers[w.name] = { behaviour: w.behaviour, earned: owed, stakeLost: stake - mem.stake, net: owed - (stake - mem.stake),
      work: w.work, reputation: { agreed: rr.agreed, disagreed: rr.disagreed, missed: rr.missed, slashed: rr.slashed, score: await rep.call('scoreOf', [w.address]) } };
  }
  report.round.posterRefund = await market.call('owed', [A('poster')]);
  report.round.subsidyFromIssuance = 20n * ZETA - await issuance.call('available', [market.address]);
  report.round.reserve = await market.call('reserve');
  const sv = await solvency(W);
  report.round.solvent = sv.market;
  report.round.poolSolvent = sv.pool;

  // compute: training segments claimed vs re-executed by the verifiers
  const C = spec.train.trees / spec.train.every;
  const claimed = r.jobs.filter((j) => j.status !== 'missed').length * C;
  const reexecuted = workers.reduce((s, w) => s + w.work.verifiedSegments, 0);
  report.compute = {
    segmentsClaimed: claimed, segmentsActuallyTrained: workers.reduce((s, w) => s + w.work.trainedSegments, 0),
    distinctSegmentsChecked: r.checks.length, sampledShare: r.checks.length / claimed,
    reexecutions: reexecuted, overhead: reexecuted / claimed,
    usefulTrees: r.jobs.filter((j) => j.status === 'passed').length * spec.train.trees,
  };
  for (const n of [...Object.keys(ROLES), 'poster']) if ((await market.call('owed', [A(n)])) > 0n) await market.send(n, 'withdraw', []);
  report.round.solventAfterWithdraw = (await balanceOf(W, market.address)) === (await market.call('reserve')) + (await market.call('escrow'));
  return report;
}

/** The report as markdown (for the CLI and the docs). */
export function reportMarkdown(r, ZETA = 10n ** 18n) {
  const z = (x) => (Number(x) / Number(ZETA)).toFixed(3);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const L = [];
  L.push('### Label work (UsefulWork, 2 of 3 seats)');
  L.push(`row: ${r.label.row.features} features, rules level ${r.label.row.level} -> label ${r.label.row.label}; accepted: ${r.label.accepted}; copier's reveal: ${r.label.copier}`);
  L.push(`paid (fee share + deposit back): ${Object.entries(r.label.paid).map(([n, v]) => `${n} ${z(v)}`).join(', ')}`);
  L.push('', '### Training round (4 shards x 8 segments x 3 trees)', '', '| job | trainer | behaviour | result |', '|---|---|---|---|');
  r.round.jobs.forEach((j, i) => L.push(`| ${i} | ${j.trainer} | ${j.behaviour} | ${j.status} |`));
  L.push('', '| check | job (trainer) | segment | verifiers | result |', '|---|---|---|---|---|');
  r.round.checks.forEach((c, i) => L.push(`| ${i} | ${c.job} (${c.trainer}) | ${c.segment} | ${c.verifiers.join(', ')} | ${c.status} |`));
  const m = r.round.metrics;
  L.push('', `held-out rows: ${r.round.heldoutRows} (picked by keccak(poster secret, draw)); evaluators: ${r.round.evaluators.join(', ')}`);
  L.push(`AUC ${m.baseAuc.toFixed(4)} -> ${m.candAuc.toFixed(4)} (${m.candAuc >= m.baseAuc ? '+' : ''}${(m.candAuc - m.baseAuc).toFixed(4)}); recall at 1% FPR ${m.baseRecall.toFixed(4)} -> ${m.candRecall.toFixed(4)}; accepted: ${r.round.accepted}; new version in force: ${r.round.inForce ?? false}`);
  L.push('', `compute: ${r.compute.segmentsClaimed} segments claimed, ${r.compute.segmentsActuallyTrained} actually trained; ${r.compute.distinctSegmentsChecked} sampled (${pct(r.compute.sampledShare)} of claimed training verified by re-execution); ${r.compute.reexecutions} segment re-runs (${pct(r.compute.overhead)} extra compute)`);
  L.push('', '| worker | behaviour | earned | stake lost | net | trained / re-ran / evaluated | reputation score |', '|---|---|---|---|---|---|---|');
  for (const [n, w] of Object.entries(r.workers)) L.push(`| ${n} | ${w.behaviour} | ${z(w.earned)} | ${z(w.stakeLost)} | ${z(w.net)} | ${w.work.trainedSegments} / ${w.work.verifiedSegments} / ${w.work.evaluations} | ${w.reputation.score} |`);
  L.push('', `budget ${z(r.round.budget)}, subsidy ${z(r.round.subsidy)} (from UsefulIssuance ${z(r.round.subsidyFromIssuance)}, the rest from the slash reserve), poster refund ${z(r.round.posterRefund)}, reserve after ${z(r.round.reserve)}; market solvent: ${r.round.solvent}, pool solvent: ${r.round.poolSolvent}`);
  return L.join('\n');
}
