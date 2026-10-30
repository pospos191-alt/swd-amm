// Proof of useful work for AI training (docs/future/useful-work-training.md): bit-reproducible training,
// spot-check soundness, the TrainingMarket / TrainingPool contracts and the end-to-end round with a cheater
// and a copier on the in-memory chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ZeroAddress, ZeroHash, keccak256 as ethKeccak, toUtf8Bytes, AbiCoder } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { k, T, baseModel, shardOf, heldoutRows, detectionTable, measuredCatch, labelRow, art } from '../src/trainwork/core.js';
import { deployWorld, openWorld, runRound, simulate, solvency, marketParams, reportMarkdown } from '../src/trainwork/simulate.js';

const env = { createChain, workMocks, ZETA };
const coder = AbiCoder.defaultAbiCoder();
const HONEST = { w1: 'honest', w2: 'honest', w3: 'honest', w4: 'honest', w5: 'honest', w6: 'honest' };
// Pinned: any change to the trainer, the data or the hashing changes these, on every engine at once.
const GOLDEN = {
  base: '0x4cc00aa9933f4ee75972ced7ccffb06d26b00719506ec0f4c2803662d994bd8a',
  rows: '0x938ba51aaa7e42321763ad2b0df41c145edef95d5ad76aa74e745c61aee0b4e9',
  root: '0x609044c192d6c0ab455e601cebb2b2ea89617d4b065761ca40fc694b4d0a2238',
  trees: '0xc787860dca81512a3f7c6124b8fa96815746e699478cfc5b34c1aad91674c506',
};
const base = baseModel();
const goldenSpec = T.makeSpec({ seed: 'golden', shards: 4, baseModel: base.hash });

// ------------------------------------------------------------------ determinism
test('dexp: + - * / only, within 2 ulp of Math.exp; no engine-defined math anywhere in the trainer', () => {
  let worst = 0;
  for (let x = -60; x <= 60; x += 0.00731) worst = Math.max(worst, Math.abs(T.dexp(x) / Math.exp(x) - 1));
  assert.ok(worst < 5e-16, `relative error ${worst}`);
  assert.equal(T.dexp(0), 1);
  assert.ok(Number.isNaN(T.dexp(NaN)));
  assert.equal(T.dsigmoid(0), 0.5);
  assert.ok(T.dsigmoid(800) === 1 && T.dsigmoid(-800) > 0 && T.dsigmoid(-800) < 1e-300);
  const src = readFileSync(new URL('../../zetaphy-hub/train-core.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /Math\.(exp|expm1|log|log1p|log2|log10|pow|random|sin|cos|tan|atan|cbrt|hypot|fround|sqrt)\b|\*\*|toPrecision|toFixed|Date\.now|performance/);
});

test('training is bit-reproducible: same digests every run, pinned golden hashes, another isolate agrees', async () => {
  assert.equal(base.hash, GOLDEN.base);
  const sh = shardOf(goldenSpec, base.model, 0);
  assert.equal(sh.hash, GOLDEN.rows);
  const a = T.trainJob(k, { S: sh.S, spec: goldenSpec, shard: 0 });
  const b = T.trainJob(k, { S: shardOf(goldenSpec, base.model, 0).S, spec: goldenSpec, shard: 0 });
  assert.deepEqual(a.digests, b.digests);
  assert.equal(a.root, GOLDEN.root);
  assert.equal(a.treesHash, GOLDEN.trees);
  assert.equal(a.digests.length, 8);
  assert.equal(new Set(a.digests).size, 8);
  // a fresh V8 isolate (worker thread), its own module instances and heap
  const code = `
    import { parentPort } from 'node:worker_threads';
    const { k, T, baseModel, shardOf } = await import(${JSON.stringify(new URL('../src/trainwork/core.js', import.meta.url).href)});
    const base = baseModel();
    const spec = T.makeSpec({ seed: 'golden', shards: 4, baseModel: base.hash });
    parentPort.postMessage(T.trainJob(k, { S: shardOf(spec, base.model, 0).S, spec, shard: 0 }).root);`;
  const root = await new Promise((res, rej) => { const w = new Worker(code, { eval: true, type: 'module' }); w.once('message', res); w.once('error', rej); });
  assert.equal(root, GOLDEN.root);
  // the model format is Neuro's: the exported trees run unchanged in zetaphy-neuro/ml/model.js
  const { margin } = await import('../../zetaphy-neuro/ml/model.js');
  const cand = T.candidateOf(k, base.model, base.hash, [{ ...a }]);
  for (const r of sh.rows.slice(0, 20)) assert.equal(margin(cand.model, r.x), T.margin(cand.model, r.x));
});

test('a spot-check re-run from the published trees gives the trainer\'s digest for every segment; a faked segment differs', () => {
  const sh = shardOf(goldenSpec, base.model, 1);
  const job = T.trainJob(k, { S: sh.S, spec: goldenSpec, shard: 1 });
  for (let s = 0; s < 8; s++) {
    assert.equal(T.verifySegment(k, { S: sh.S, spec: goldenSpec, shard: 1, published: job.trees, committedTreesHash: job.treesHash, segment: s }), job.digests[s], `segment ${s}`);
  }
  // one leaf of tree 13 (segment 4) nudged by 2^-24: only digest 4 changes, and the re-run disagrees with it
  const fake = job.trees.map((t) => [...t]);
  fake[13][4] += 1 / 16777216;
  const fakeDigests = [...job.digests];
  fakeDigests[4] = T.segmentDigest(k, 4, fake.slice(12, 15), new Array(12).fill(0));
  const fakeHash = T.treesHash(k, fake);
  assert.notEqual(T.verifySegment(k, { S: sh.S, spec: goldenSpec, shard: 1, published: fake, committedTreesHash: fakeHash, segment: 4 }), fakeDigests[4]);
  assert.equal(T.verifySegment(k, { S: sh.S, spec: goldenSpec, shard: 1, published: fake, committedTreesHash: fakeHash, segment: 3 }), job.digests[3], 'the segments before it still check');
  // trees that are not published, or not the committed ones: UNAVAILABLE (a failed check)
  assert.equal(T.verifySegment(k, { S: sh.S, spec: goldenSpec, shard: 1, published: null, committedTreesHash: job.treesHash, segment: 0 }), T.UNAVAILABLE(k));
  assert.equal(T.verifySegment(k, { S: sh.S, spec: goldenSpec, shard: 1, published: fake, committedTreesHash: job.treesHash, segment: 0 }), T.UNAVAILABLE(k));
  // the transcript is part of the digest: the right trees with a made-up transcript do not pass
  assert.notEqual(T.segmentDigest(k, 2, job.trees.slice(6, 9), new Array(12).fill(0)), job.digests[2]);
});

test('spot-check soundness: P(caught) = 1 - C(C-f, s) / C(C, s), and the contract\'s sampler measures the same', () => {
  const t = detectionTable();
  assert.deepEqual(t.checks, [1, 2, 3, 4]);
  for (const r of t.rows) {
    for (let i = 0; i < t.checks.length; i++) {
      const s = t.checks[i];
      let miss = 1;
      for (let q = 0; q < s; q++) miss *= (r.segments - r.faked - q) / (r.segments - q);
      assert.ok(Math.abs(r.p[i] - (1 - miss)) < 1e-12);
      if (i) assert.ok(r.p[i] >= r.p[i - 1], 'more checks, more caught');
    }
  }
  assert.equal(T.catchProbability(8, 8, 1), 1, 'everything faked: always caught');
  assert.equal(T.catchProbability(8, 1, 8), 1, 'everything checked: always caught');
  assert.equal(T.catchProbability(8, 6, 2), 1 - 1 / 28);
  for (const [C, f, s] of [[8, 1, 2], [8, 2, 2], [16, 4, 3], [32, 1, 4]]) {
    const m = measuredCatch(C, f, s, 1500);
    assert.ok(Math.abs(m - T.catchProbability(C, f, s)) < 0.04, `C=${C} f=${f} s=${s}: measured ${m} vs ${T.catchProbability(C, f, s)}`);
  }
  // the samples are distinct segments
  for (let i = 0; i < 50; i++) {
    const got = T.sampleSegments(k, ethKeccak(toUtf8Bytes(`r${i}`)), i % 4, 8, 4);
    assert.equal(new Set(got).size, 4);
    assert.ok(got.every((s) => s >= 0 && s < 8));
  }
});

test('evaluation is deterministic and needs the revealed seed: the held-out rows change with it', () => {
  const a = heldoutRows(goldenSpec, '0x' + '01'.repeat(32));
  const b = heldoutRows(goldenSpec, '0x' + '02'.repeat(32));
  assert.ok(a.length > 900 && a.length < 1100);
  const ids = new Set(a.map((r) => r.id));
  assert.ok(b.filter((r) => ids.has(r.id)).length < 0.6 * b.length, 'another seed, mostly other rows');
  const train = new Set(T.shardIds(0, 2400, 4, 0));
  assert.ok(a.every((r) => !train.has(r.id)), 'held-out rows never come from a training shard');
  const job = T.trainJob(k, { S: shardOf(goldenSpec, base.model, 0).S, spec: goldenSpec, shard: 0 });
  const cand = T.candidateOf(k, base.model, base.hash, [job]);
  assert.deepEqual(T.evaluate(base.model, cand.model, a), T.evaluate(base.model, cand.model, a));
  assert.equal(cand.id, ethKeccak('0x' + base.hash.slice(2) + job.treesHash.slice(2)), 'candidate id = keccak(base ‖ treesHash…), as the contract');
  assert.equal(T.evalAnswer(k, { baseAuc: 1, candAuc: 2, baseRecall: 3, candRecall: 4 }), ethKeccak(coder.encode(['uint32[4]'], [[1, 2, 3, 4]])));
});

test('label work (a): a contract\'s code gives one row and one verdict on every run', async () => {
  const code = art('VulnerableVault').deployedBytecode;
  const job = { chain: 'zetaphy', target: '0x' + '12'.repeat(20), code, codeHash: ethKeccak(code) };
  const a = await labelRow(job);
  const b = await labelRow(job);
  assert.equal(a.verdict, b.verdict);
  assert.ok(Object.keys(a.row.features).length > 50);
  assert.ok(Object.values(a.row.features).every((v) => Number.isFinite(v) && Math.round(v * 1e6) / 1e6 === v));
});

// ------------------------------------------------------------------ contracts
test('TrainingMarket / TrainingPool: timelock governance only, closed until opened, pool locks and slashes only for markets', async () => {
  const W = await deployWorld(env);
  const { c, A, market, pool, tl } = W;
  await assert.rejects(c.deploy('TrainingPool', [A('gov'), ZETA, 1000], 'gov'), /deploy failed/, 'an EOA cannot govern');
  await assert.rejects(c.deploy('TrainingMarket', [A('gov'), pool.address, ZeroAddress, ZeroAddress, ZeroAddress, marketParams(ZETA)], 'gov'), /deploy failed/);
  assert.equal(await market.call('paused'), true);
  await assert.rejects(market.send('poster', 'post', [ZeroHash.replace(/0$/, '1'), 'x', ZeroHash.replace(/0$/, '1'), 1, 8, ZeroHash.replace(/0$/, '1'), 0], ZETA), /Paused/);
  await assert.rejects(market.send('gov', 'setPaused', [false]), /NotGovernance/);
  await assert.rejects(pool.send('w1', 'lock', [A('w2'), true]), /NotMarket/);
  await assert.rejects(pool.send('w1', 'slash', [A('w2'), 1n]), /NotMarket/);
  await assert.rejects(pool.send('w1', 'join', [], ZETA), /BadValue/, 'below the minimum stake');
  // exit: out of the draw at once, the stake after exitDelay
  await pool.send('w1', 'join', [], 10n * ZETA);
  assert.equal(await pool.call('eligible', [A('w1')]), true);
  await pool.send('w1', 'exit', []);
  assert.equal(await pool.call('eligible', [A('w1')]), false);
  await assert.rejects(pool.send('w1', 'withdrawStake', []), /WrongPhase/);
  c.advance(7 * 86400);
  await pool.send('w1', 'withdrawStake', []);
  assert.equal(await pool.call('totalStake'), 0n);
  assert.equal(await pool.call('size'), 0n);
  // the market checks its windows fit the pool's exit delay
  const long = { ...marketParams(ZETA), evalRevealWindow: 8 * 86400 };
  await assert.rejects(c.deploy('TrainingMarket', [tl.address, pool.address, ZeroAddress, ZeroAddress, ZeroAddress, long], 'gov'), /deploy failed/);
  assert.equal(await market.call('UNAVAILABLE'), T.UNAVAILABLE(k));
});

test('TrainingMarket phases: seats, sealed commits, copied reveals, stale base, feeders, opening digests', async () => {
  const W = await openWorld(await deployWorld(env), { behaviours: HONEST });
  const { c, A, market, pool, base } = W;
  const spec = T.makeSpec({ seed: 'phases', shards: 2, baseModel: base.hash });
  const H = (s) => ethKeccak(toUtf8Bytes(s));
  const secret = H('secret');
  const commit = T.heldoutCommitment(k, secret, A('poster'));
  await assert.rejects(market.send('poster', 'post', [H('spec'), 'u', H('old model'), 2, 8, commit, 0], ZETA), /StaleBase/, 'a round starts from the model in force');
  await assert.rejects(market.send('w1', 'post', [H('spec'), 'u', base.hash, 2, 8, commit, ZETA], ZETA), /NotFeeder/, 'only a feeder adds a subsidy');
  await assert.rejects(market.send('poster', 'post', [H('spec'), 'u', base.hash, 9, 8, commit, 0], ZETA), /BadTask/);
  await assert.rejects(market.send('poster', 'post', [H('spec'), 'u', base.hash, 2, 1, commit, 0], ZETA), /BadTask/, 'fewer segments than checks');
  await market.send('poster', 'post', [T.specHash(k, T.specText(spec)), 'u', base.hash, 2, 8, commit, 0], 10n * ZETA);
  await assert.rejects(market.send('w1', 'commitTraining', [0n, H('x')]), /NotSeated/);
  await assert.rejects(market.send('poster', 'takeSeat', [0n]), /NotEligible/, 'not in the pool');
  const [w1, w2, w3] = ['w1', 'w2', 'w3'].map((n) => W.byName[n]);
  await w1.takeSeat(0n);
  await assert.rejects(market.send('w1', 'takeSeat', [0n]), /AlreadyIn/);
  await w2.takeSeat(0n);
  await assert.rejects(market.send('w3', 'takeSeat', [0n]), /Full/);
  assert.equal((await pool.call('memberOf', [A('w1')])).busy, 1n, 'a seat locks the stake');
  await w1.trainAndCommit(0n, spec, base);
  await w2.trainAndCommit(0n, spec, base);
  await assert.rejects(market.send('w1', 'revealTraining', [0n, w1.st(0n).root, w1.st(0n).treesHash, 'u', w1.st(0n).salt]), /WrongPhase/, 'not before the commits close');
  c.advance(2 * 3600);
  await assert.rejects(market.send('w3', 'commitTraining', [0n, H('late')]), /NotSeated|WrongPhase/);
  // w2 replays w1's reveal: the commitment is bound to w1's address
  await assert.rejects(market.send('w2', 'revealTraining', [0n, w1.st(0n).root, w1.st(0n).treesHash, 'u', w1.st(0n).salt]), /BadReveal/);
  await w1.revealTraining(0n);
  await w2.revealTraining(0n);
  await assert.rejects(market.send('keeper', 'requestDraw', [0n]), /WrongPhase/);
  c.advance(3600);
  await assert.rejects(market.send('keeper', 'draw', [0n]), /WrongPhase/, 'no block requested yet');
  await market.send('keeper', 'requestDraw', [0n]);
  c.mine(2);
  await market.send('keeper', 'draw', [0n]);
  const task = await market.call('getTask', [0n]);
  // the contract's segments are the ones the JS sampler computes from the same randomness
  const checks = await market.call('checksOf', [0n]);
  assert.equal(checks.length, 2 * 2 + 1, '2 checks per job + the evaluation');
  for (const j of [0, 1]) assert.deepEqual(checks.filter((x) => Number(x.job) === j).map((x) => Number(x.segment)), T.sampleSegments(k, task.randomness, j, 8, 2));
  for (let i = 0; i < 4; i++) {
    const vs = (await market.call('verifiersOf', [0n, i])).map((a) => a.toLowerCase());
    assert.equal(vs.length, 3);
    assert.ok(!vs.includes(A(Number(checks[i].job) === 0 ? 'w1' : 'w2')), 'never the trainer of the checked job');
  }
  const evs = (await market.call('verifiersOf', [0n, 4])).map((a) => a.toLowerCase());
  assert.ok(evs.length === 3 && !evs.includes(A('w1')) && !evs.includes(A('w2')), 'evaluators are not trainers of the round');
  // opening digests: not while verifiers commit; must hash to the committed root
  await assert.rejects(market.send('w1', 'openCheckpoints', [0n, w1.st(0n).digests]), /WrongPhase/);
  for (const w of W.workers) await w.verify(0n, spec, base, W.workers);
  c.advance(3600);
  await assert.rejects(market.send('w1', 'openCheckpoints', [0n, [...w1.st(0n).digests].reverse()]), /BadReveal/);
  await assert.rejects(market.send('poster', 'revealHeldout', [0n, H('another secret')]), /BadReveal/);
  await assert.rejects(market.send('w1', 'revealHeldout', [0n, secret]), /BadReveal/, 'only the poster');
  assert.deepEqual(await solvency(W), { market: true, pool: true });
});

// ------------------------------------------------------------------ the end-to-end round
let simReport = null;
test('simulation: 6 workers, a cheater and a copier — the round improves held-out AUC, the cheater is slashed, the copier gets nothing', { timeout: 300_000 }, async () => {
  const r = simReport = await simulate(env);
  // label work (a)
  assert.equal(r.label.accepted, true);
  assert.match(r.label.copier, /BadReveal/);
  assert.ok(r.label.paid.w1 > 0n && r.label.paid.w2 > 0n);
  assert.equal(r.label.paid.w6, 0n);
  // training (b): honest jobs pass, the cheater's fails, the copier's never revealed
  assert.deepEqual(r.round.jobs.map((j) => j.status), ['passed', 'passed', 'failed', 'missed']);
  assert.ok(r.round.checks.some((c) => c.trainer === 'w5' && c.status === 'fail'));
  assert.ok(r.round.checks.filter((c) => c.trainer !== 'w5').every((c) => c.status === 'pass'));
  // evaluation (c): accepted only with a real gain on rows nobody knew in advance
  const m = r.round.metrics;
  assert.equal(r.round.accepted, true);
  assert.ok(m.candAuc - m.baseAuc >= 0.05, `AUC ${m.baseAuc} -> ${m.candAuc}`);
  assert.ok(m.candRecall > m.baseRecall);
  assert.equal(r.round.inForce, true, 'the accepted candidate became the model version in force (ModelEpochs, by a timelock vote)');
  assert.equal(r.round.baseInForce, true);
  // payouts
  const W_ = r.workers;
  assert.ok(W_.w1.net > 9n * ZETA && W_.w2.net > 9n * ZETA, 'honest trainers: 18 ZETA training pool + 3 subsidy, shared');
  assert.ok(W_.w3.net > 0n && W_.w4.net > 0n, 'verifiers and evaluators paid');
  assert.ok(W_.w5.net < 0n && W_.w5.stakeLost === 5n * ZETA, 'the cheater loses trainSlash');
  assert.equal(W_.w6.earned, 0n, 'the copier earns nothing');
  assert.ok(W_.w6.stakeLost >= 2n * ZETA, 'and loses a missSlash per unrevealed seat');
  assert.equal(W_.w5.reputation.slashed, 1n);
  assert.equal(W_.w6.reputation.score, 0n);
  assert.ok(r.round.posterRefund >= 3n * ZETA && r.round.posterRefund < 3n * ZETA + 100n, '10% of the budget is not a pool: back to the poster (+ rounding dust)');
  assert.equal(r.round.solvent && r.round.poolSolvent && r.round.solventAfterWithdraw, true);
  // compute
  assert.equal(r.compute.segmentsClaimed, 24);
  assert.equal(r.compute.segmentsActuallyTrained, 18);
  assert.equal(r.compute.sampledShare, 0.25);
  assert.match(reportMarkdown(r, ZETA), /\| w5 \| cheater \|/);
});

test('data poisoning: honest training on poisoned labels passes every spot-check but the held-out evaluation rejects it; trainers unpaid', { timeout: 300_000 }, async () => {
  const W = await openWorld(await deployWorld(env), { behaviours: HONEST });
  const { A, market, epochs, base } = W;
  // the shards' labels are poisoned (the new scam family relabelled safe); the held-out rows come from the true world
  const spec = T.makeSpec({ seed: 'poisoned', shards: 3, world: 'v1p', evalWorld: 'v1', baseModel: base.hash });
  const r = await runRound(W, { spec, trainers: ['w1', 'w2', 'w3'] });
  assert.deepEqual(r.jobs.map((j) => j.status), ['passed', 'passed', 'passed'], 'the computation was honest');
  assert.equal(r.task.accepted, false);
  assert.ok(r.metrics.candAuc < r.metrics.baseAuc, `AUC ${r.metrics.baseAuc} -> ${r.metrics.candAuc}`);
  for (const n of ['w1', 'w2', 'w3']) {
    const trainedOnly = (await market.call('owed', [A(n)]));
    assert.ok(trainedOnly < 2n * ZETA, `${n}: no training pay (only what it earned checking others): ${trainedOnly}`);
  }
  const paidOthers = (await Promise.all(['w4', 'w5', 'w6'].map((n) => market.call('owed', [A(n)])))).reduce((s, x) => s + x, 0n);
  assert.ok(paidOthers > 0n, 'verifiers and evaluators are paid whatever the outcome');
  // the poster gets the training pool back (and what was not paid)
  assert.ok((await market.call('owed', [A('poster')])) >= 18n * ZETA + 3n * ZETA);
  assert.equal((await epochs.call('current'))[2], base.hash, 'the model in force did not change');
  assert.equal(await market.call('acceptedBy', [r.task.candidate]), 0n);
  assert.deepEqual(await solvency(W), { market: true, pool: true });
});

test('withheld trees fail the job (UNAVAILABLE); an honest round with an empty reserve draws its subsidy from UsefulIssuance', { timeout: 300_000 }, async () => {
  const W = await openWorld(await deployWorld(env), { behaviours: HONEST });
  const { A, market, issuance, pool, base } = W;
  const spec = T.makeSpec({ seed: 'honest', shards: 2, baseModel: base.hash });
  assert.equal(await market.call('reserve'), 0n);
  const r = await runRound(W, { spec, trainers: ['w1', 'w2'] });
  assert.deepEqual(r.jobs.map((j) => j.status), ['passed', 'passed']);
  assert.equal(r.task.accepted, true);
  assert.equal(await issuance.call('available', [market.address]), 20n * ZETA - 3n * ZETA, 'the 3 ZETA subsidy came from the UsefulIssuance bucket');
  assert.equal(await market.call('acceptedBy', [r.task.candidate]), r.id + 1n);
  // round 2 from the same (not yet changed) base: w3 publishes nothing after revealing
  const spec2 = T.makeSpec({ seed: 'withheld', shards: 2, baseModel: base.hash });
  const before = (await pool.call('memberOf', [A('w3')])).stake;
  const r2 = await runRound(W, { spec: spec2, trainers: ['w3', 'w4'], subsidy: 0n, hooks: { afterReveal: (W2) => W2.store.delete(W2.byName.w3.st(r.id + 1n).treesHash) } });
  assert.deepEqual(r2.jobs.map((j) => j.status), ['failed', 'passed']);
  assert.ok(r2.checks.filter((c) => c.trainer === 'w3').every((c) => c.status === 'fail'));
  assert.equal(before - (await pool.call('memberOf', [A('w3')])).stake, 5n * ZETA);
  assert.deepEqual(await solvency(W), { market: true, pool: true });
});
