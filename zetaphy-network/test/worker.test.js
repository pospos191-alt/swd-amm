import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBytes32String } from 'ethers';
import { createWorker, commitmentOf, simSeedOf } from '../src/worker.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { jobSimSeed } from '../../zetaphy-neuro/src/honeypot.js';
import { detectHardware, pickProfile } from '../src/hardware.js';

const ME = '0x00000000000000000000000000000000000000aa';
const T = '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f';

/** In-memory stand-in for the NeuroJobs contract (same method names). */
function fakeJobs({ window = 100n } = {}) {
  const jobs = [];
  const tx = (fn) => async (...a) => { const r = fn(...a); return { wait: async () => r }; };
  return {
    jobs,
    add(chain, target, created = 0n) { jobs.push({ chain: encodeBytes32String(chain), target, created, status: 1n, commits: 0n, commitOf: {}, reveals: {} }); },
    commitWindow: async () => window,
    notEligible: new Set(),
    async eligible(id) { return !this.notEligible.has(Number(id)); },
    jobCount: async () => BigInt(jobs.length),
    getJob: async (id) => jobs[Number(id)],
    commit: tx((id, c) => { const j = jobs[Number(id)]; if (j.failCommit) throw new Error('NoSeat'); j.commitOf[ME] = c; j.commits += 1n; }),
    reveal: tx((id, v, salt) => { const j = jobs[Number(id)]; assert.equal(commitmentOf(v, ME, salt), j.commitOf[ME]); j.reveals[ME] = v; }),
  };
}

const report = { chain: 'bsc', address: T, analysis: { level: 'low', control: 'owner', findings: [] } };

function setup(opts = {}) {
  const jobs = fakeJobs(opts);
  const stateFile = join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json');
  let now = 10n;
  const reads = [];
  const w = createWorker({
    jobs, me: ME, stateFile, zetaphyChain: null, chainTime: async () => now,
    read: async (chain, target) => { reads.push([chain, target]); return report; },
  });
  return { jobs, w, stateFile, setNow: (t) => { now = t; }, reads };
}

test('commits a verdict, saves it first, and reveals once seats are full', async () => {
  const { jobs, w, stateFile, reads } = setup();
  jobs.add('bsc', T);
  await w.tick();
  assert.deepEqual(reads, [['bsc', T]]);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')).seats['0'];
  assert.equal(saved.verdict, await verdictOf(report));
  assert.equal(jobs.jobs[0].commitOf[ME], commitmentOf(saved.verdict, ME, saved.salt));
  await w.tick(); // seats not full, window open: no reveal yet
  assert.equal(jobs.jobs[0].reveals[ME], undefined);
  jobs.jobs[0].commits = 3n;
  await w.tick();
  assert.equal(jobs.jobs[0].reveals[ME], saved.verdict);
});

test('reveals after the commit window even with free seats', async () => {
  const { jobs, w, setNow } = setup({ window: 100n });
  jobs.add('bsc', T);
  await w.tick();
  setNow(200n);
  await w.tick();
  assert.ok(jobs.jobs[0].reveals[ME]);
});

test('a restarted runner can still reveal from the saved state', async () => {
  const { jobs, w, stateFile } = setup();
  jobs.add('bsc', T);
  await w.tick();
  jobs.jobs[0].commits = 3n;
  const again = createWorker({ jobs, me: ME, stateFile, chainTime: async () => 10n, read: async () => { throw new Error('should not re-read'); } });
  await again.tick();
  assert.ok(jobs.jobs[0].reveals[ME]);
});

test('a failed commit leaves no seat to reveal; unsupported chains are skipped', async () => {
  const { jobs, w, stateFile, reads } = setup();
  jobs.add('polygon', T);
  jobs.add('zetaphy', T); // no ZETAPHY RPC configured in this runner
  jobs.add('bsc', T);
  jobs.jobs[2].failCommit = true;
  const out = await w.tick();
  assert.deepEqual(reads, [['bsc', T]]);
  assert.match(out.join('\n'), /polygon not supported/);
  assert.match(out.join('\n'), /not committed \(NoSeat\)/);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).seats, {});
});

test('the trade simulation is seeded from the job and its lottery: every runner of the round runs the same test', async () => {
  const RAND = '0x' + '5e'.repeat(32);
  const seen = [];
  const runner = async () => {
    const jobs = fakeJobs();
    jobs.jobInfo = async () => ({ skill: '0x' + '00'.repeat(32), rand: RAND });
    jobs.add('bsc', T);
    jobs.add('bsc', T);
    const w = createWorker({ jobs, me: ME, stateFile: join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json'), chainTime: async () => 10n,
      read: async (chain, target, opts) => { seen.push(opts); return report; } });
    await w.tick();
  };
  await runner();
  await runner(); // another machine
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((o) => o.simSeed), [jobSimSeed(0, RAND), jobSimSeed(1, RAND), jobSimSeed(0, RAND), jobSimSeed(1, RAND)]);
  assert.notEqual(seen[0].simSeed, seen[1].simSeed, 'each job its own plan');
  assert.ok(seen.every((o) => o.sourcify === false));
  // No lottery yet (or a contract without jobInfo): no seed, the simulation picks at random.
  assert.equal(simSeedOf(0, '0x' + '00'.repeat(32)), null);
  assert.equal(simSeedOf(0, undefined), null);
});

test('closed and full jobs are left alone', async () => {
  const { jobs, w, reads } = setup();
  jobs.add('bsc', T); jobs.jobs[0].status = 2n;
  jobs.add('bsc', T); jobs.jobs[1].commits = 3n;
  await w.tick();
  assert.deepEqual(reads, []);
  assert.equal(w.state.cursor, 2);
});

test('hardware profile: GPU with 8 GB+ is heavy, otherwise light', async () => {
  assert.equal(pickProfile({ cpus: 4, memoryGB: 8, gpus: [] }).profile, 'light');
  assert.equal(pickProfile({ cpus: 4, memoryGB: 8, gpus: [{ name: 'RTX 4060', memoryMB: 8188 }] }).profile, 'light');
  assert.equal(pickProfile({ cpus: 8, memoryGB: 32, gpus: [{ name: 'RTX 4090', memoryMB: 24564 }] }).profile, 'heavy');
  assert.equal(pickProfile({ cpus: 0, memoryGB: 0, gpus: [] }).profile, null);
  const hw = await detectHardware({ exec: (_c, _a, _o, cb) => cb(null, 'NVIDIA A10, 23028\n') });
  assert.deepEqual(hw.gpus, [{ name: 'NVIDIA A10', memoryMB: 23028 }]);
  assert.deepEqual((await detectHardware({ exec: (_c, _a, _o, cb) => cb(new Error('not found')) })).gpus, []);
});

test('a runner the lottery did not pick for a job leaves it alone', async () => {
  const { jobs, w, reads } = setup();
  jobs.add('bsc', T);
  jobs.notEligible.add(0);
  await w.tick();
  assert.deepEqual(reads, []);
  assert.equal(w.state.cursor, 0); // looked at again later: the lottery widens
  jobs.notEligible.clear();
  await w.tick();
  assert.deepEqual(reads, [['bsc', T]]);
});

test('skill: only jobs recorded with this runner\'s skill id are taken', async () => {
  const MINE = '0x' + 'ab'.repeat(32), OTHER = '0x' + 'cd'.repeat(32);
  const jobs = fakeJobs();
  jobs.jobInfo = async (id) => ({ skill: jobs.jobs[Number(id)].skill });
  const reads = [];
  const w = createWorker({ jobs, me: ME, stateFile: join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json'), chainTime: async () => 10n,
    read: async (chain, target) => { reads.push(target); return report; }, skill: MINE.toUpperCase().replace('0X', '0x') });
  jobs.add('bsc', 'other'); jobs.jobs[0].skill = OTHER;
  jobs.add('bsc', 'mine'); jobs.jobs[1].skill = MINE;
  const out = await w.tick();
  assert.deepEqual(reads, ['mine']);
  assert.match(out.join('\n'), /job 0: skip: skill 0xcdcd.* is not this runner's/);
  assert.equal(w.state.cursor, 2); // a job of another skill never holds the cursor back
  assert.deepEqual(await w.tick(), []); // and is not reported again
});

test('pause: no new jobs while Neuro is paused, but seats already taken are revealed', async () => {
  const jobs = fakeJobs();
  let stop = false;
  const reads = [];
  const w = createWorker({ jobs, me: ME, stateFile: join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json'), chainTime: async () => 10n,
    read: async (chain, target) => { reads.push(target); return report; }, paused: async () => stop });
  jobs.add('bsc', 'a');
  await w.tick(); // committed to job 0
  stop = true;
  jobs.add('bsc', 'b');
  jobs.jobs[0].commits = 3n;
  const out = await w.tick();
  assert.match(out.join('\n'), /paused by governance/);
  assert.ok(jobs.jobs[0].reveals[ME], 'the seat taken before the pause is revealed');
  assert.deepEqual(reads, ['a']);
  assert.equal(w.state.cursor, 1); // job 1 waits for the unpause
  stop = false;
  const again = await w.tick();
  assert.match(again.join('\n'), /running again/);
  assert.deepEqual(reads, ['a', 'b']);
});

test('after a quorum: a seat not yet revealed reveals inside the grace, then the runner settles the job', async () => {
  const { jobs, w, setNow } = setup();
  const settled = [];
  jobs.jobInfo = async (id) => ({ skill: '0x' + '00'.repeat(32), settleAt: jobs.jobs[Number(id)].settleAt ?? 0n });
  jobs.settle = async (id) => ({ wait: async () => settled.push(Number(id)) });
  jobs.add('bsc', T);
  jobs.add('bsc', T);
  await w.tick(); // committed to both
  // Job 0: the other two reached a quorum before this runner revealed; the grace runs to 50.
  Object.assign(jobs.jobs[0], { status: 2n, commits: 3n, settleAt: 50n });
  // Job 1: the quorum came, this runner was too late (grace over at 5): it just forgets the seat.
  Object.assign(jobs.jobs[1], { status: 2n, commits: 3n, settleAt: 5n });
  let out = await w.tick();
  assert.ok(jobs.jobs[0].reveals[ME], 'revealed late, inside the grace');
  assert.match(out.join('\n'), /job 0: revealed \(after the quorum/);
  assert.match(out.join('\n'), /job 1: closed/);
  assert.equal(jobs.jobs[1].reveals[ME], undefined);
  assert.deepEqual(settled, []); // never settles a job it did not reveal on
  out = await w.tick(); // grace still running: waits
  assert.deepEqual(settled, []);
  setNow(60n);
  out = await w.tick();
  assert.deepEqual(settled, [0]); // the third seat never revealed: settle penalizes it
  assert.match(out.join('\n'), /job 0: settled/);
  assert.deepEqual(w.state.seats, {});
});

test('jobs requested before NeuroJobs had a NeuroControl (skill 0) are skipped by a governed runner', async () => {
  const MINE = '0x' + 'ab'.repeat(32);
  const jobs = fakeJobs();
  jobs.jobInfo = async (id) => ({ skill: jobs.jobs[Number(id)].skill ?? '0x' + '00'.repeat(32), settleAt: 0n });
  const reads = [];
  const w = createWorker({ jobs, me: ME, stateFile: join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json'), chainTime: async () => 10n,
    read: async (chain, target) => { reads.push(target); return report; }, skill: MINE });
  jobs.add('bsc', 'early');
  const out = await w.tick();
  assert.deepEqual(reads, []);
  assert.match(out.join('\n'), /job 0: skip: skill 0x0000/);
});

test('SUPPORTED_CHAINS: zetaphy plus every chain the Neuro reader knows', async () => {
  const { SUPPORTED_CHAINS } = await import('../src/worker.js');
  const { CHAINS } = await import('../../zetaphy-neuro/src/chains.js');
  assert.deepEqual(SUPPORTED_CHAINS, ['zetaphy', ...Object.keys(CHAINS)]);
  for (const k of SUPPORTED_CHAINS) assert.ok(Buffer.byteLength(k) <= 31, k);
});

// ---- the worker against the real contract (in-memory EVM): draw, round 2, watcher, heartbeat ----

import { createChain, ZETA } from './helpers/evm.js';

/** Wraps a deployed test contract like an ethers Contract bound to `from`'s wallet. */
function asContract(k, c, from) {
  const o = {};
  for (const f of c.iface.fragments.filter((x) => x.type === 'function')) {
    o[f.name] = f.constant
      ? (...a) => c.call(f.name, a)
      : (...a) => {
        const opts = a.length > f.inputs.length ? a.pop() : {};
        return c.send(from, f.name, a, opts.value ?? 0n).then(() => ({ wait: async () => ({}) }));
      };
  }
  return o;
}

async function market(names) {
  const SKILL = '0x' + 'ab'.repeat(32), BOND = 100n * ZETA;
  const k = await createChain(['gov', 'fund', 'user', ...names]);
  const ctl = await k.deploy('NeuroControl', [k.acct.gov.toString(), k.acct.fund.toString(), 8, 4], 'gov');
  const nj = await k.deploy('NeuroJobs', [BOND, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  await nj.send('gov', 'setControl', [ctl.address]);
  await ctl.send('gov', 'approveSkill', [SKILL]);
  await ctl.send('gov', 'setActiveSkill', [SKILL]);
  await ctl.send('gov', 'approveChains', [[encodeBytes32String('bsc')]]);
  for (const n of names) await nj.send(n, 'register', [], BOND);
  k.advance(1);
  const LIE = { ...report, analysis: { ...report.analysis, level: 'high' } };
  const logs = {};
  const worker = (n, opts = {}) => createWorker({
    jobs: asContract(k, nj, n), me: k.acct[n].toString(), stateFile: join(mkdtempSync(join(tmpdir(), 'zw-')), 'state.json'),
    zetaphyChain: null, chainTime: async () => k.now(), skill: SKILL, read: async () => (opts.lie ? LIE : report),
    log: (l) => (logs[n] ??= []).push(l), ...opts,
  });
  return { k, ctl, nj, worker, logs, ad: (n) => k.acct[n].toString(), LIE };
}

test('real contract: runners draw the lottery, a watcher challenges a lying pair, round-2 runners overturn it', async () => {
  const m = await market(['l1', 'l2', 'h1', 'watcher', 'r1', 'r2']);
  const W = Object.fromEntries(['l1', 'l2', 'h1', 'r1', 'r2'].map((n) => [n, m.worker(n, { lie: n.startsWith('l') })]));
  const watcher = m.worker('watcher', { watch: { maxPerDay: 2n * ZETA } });
  await m.nj.send('user', 'request', [encodeBytes32String('bsc'), T], ZETA);
  const lazy = (await m.nj.call('jobInfo', [0])).rand; // fixed by blockhash(request block + 1), before anyone stores it
  assert.notEqual(lazy, '0x' + '00'.repeat(32));
  m.k.advance(80); // the last third of the window: every runner qualifies here
  for (const n of ['l1', 'l2', 'h1']) await W[n].tick(); // the first commit stores the draw
  assert.equal((await m.nj.call('jobInfo', [0])).rand, lazy);
  assert.equal((await m.nj.call('getJob', [0])).commits, 3n);
  for (const n of ['l1', 'l2', 'h1']) await W[n].tick(); // seats full: reveal
  const job = await m.nj.call('getJob', [0]);
  assert.equal(job.status, 2n);
  assert.equal(job.result, await verdictOf(m.LIE)); // the pair won round 1
  // The watcher re-runs Neuro, disagrees, and challenges (2 x 1 ZETAPHY fee = 2 ZETAPHY, its daily limit).
  const out = await watcher.tick();
  assert.match(out.join('\n'), /job 0: watch: CHALLENGED with 2\.0 ZETAPHY/);
  assert.equal((await m.nj.call('challengeInfo', [0])).state, 1n);
  assert.deepEqual([...await m.nj.call('challengeRound', [0])], [1n, await verdictOf(report)]); // it claimed its own verdict
  // Round 2: the round-1 seats stay out, fresh runners take the seats.
  m.k.advance(80);
  for (const n of ['l1', 'r1', 'r2']) await W[n].tick();
  assert.match(m.logs.r1.join('\n'), /job 0: committed in round 2/);
  assert.equal(m.logs.l1?.some((l) => /round 2/.test(l)) ?? false, false);
  m.k.advance(120);
  for (const n of ['r1', 'r2']) await W[n].tick(); // window over: reveal
  const ch = await m.nj.call('challengeInfo', [0]);
  assert.equal(ch.state, 3n); // overturned
  assert.equal((await m.nj.call('getJob', [0])).result, await verdictOf(report));
  assert.equal((await m.nj.call('workers', [m.ad('l1')])).bond, 50n * ZETA);
  assert.equal((await m.nj.call('assurance', [0])).agreedBy, 3n); // h1 + r1 + r2
  assert.match((await watcher.tick()).join('\n'), /our challenge ended: OVERTURNED/);
  for (const n of ['r1', 'r2']) assert.match((await W[n].tick()).join('\n'), /round 2 closed/);
});

test('watcher: a challenge over the daily limit is not sent', async () => {
  const m = await market(['w1', 'w2', 'watcher']);
  const W = ['w1', 'w2'].map((n) => m.worker(n, { lie: true }));
  const watcher = m.worker('watcher', { watch: { maxPerDay: ZETA / 2n } });
  await m.nj.send('user', 'request', [encodeBytes32String('bsc'), T], ZETA / 10n);
  m.k.advance(40);
  for (const w of W) await w.tick();
  m.k.advance(120);
  for (const w of W) await w.tick();
  assert.equal((await m.nj.call('getJob', [0])).status, 2n);
  const out = await watcher.tick();
  assert.match(out.join('\n'), /would pass today's limit/);
  assert.equal((await m.nj.call('challengeInfo', [0])).state, 0n);
});

test('a defender sends a heartbeat about every defenderTimeout/4, and keeps its seat', async () => {
  const m = await market(['d1', 'd2']);
  for (const d of ['d1', 'd2']) await m.ctl.send('gov', 'approveDefender', [m.ad(d)]);
  await m.nj.send('user', 'regrow');
  const timeout = await m.ctl.call('defenderTimeout');
  const d1 = m.worker('d1', { defenderTimeout: () => m.ctl.call('defenderTimeout'), onRoster: () => m.ctl.call('defenderApproved', [m.ad('d1')]) });
  assert.deepEqual(await d1.tick(), []); // just registered: nothing to do
  for (let i = 0; i < 8; i++) {
    m.k.advance(Number(timeout) / 4);
    assert.match((await d1.tick()).join('\n'), /heartbeat sent/);
  }
  m.k.advance(1);
  assert.equal(await m.nj.call('isDefender', [m.ad('d1')]), true);
  assert.equal(await m.nj.call('isDefender', [m.ad('d2')]), false); // d2 ran no worker
});

test('send: 50% gas headroom; an estimate refused with TooEarly waits for the next block and tries again', async () => {
  const { send } = await import('../src/worker.js');
  let block = 7, estimates = 0;
  const sent = [];
  const fn = Object.assign(async (...a) => { sent.push(a); return { wait: async () => ({}) }; }, {
    fragment: { inputs: [{}, {}] },
    _contract: { runner: { provider: { getBlockNumber: async () => block++ } } },
    estimateGas: async (...a) => {
      estimates++;
      if (estimates === 1) throw Object.assign(new Error('execution reverted: TooEarly()'), { data: '0x085de625' });
      assert.deepEqual(a, [1n, '0xab', { value: 5n }]);
      return 100_000n;
    },
  });
  await send(fn, 1n, '0xab', { value: 5n });
  assert.equal(estimates, 2);
  assert.deepEqual(sent, [[1n, '0xab', { value: 5n, gasLimit: 150_000n }]]);
  // Any other revert is not retried.
  const bad = Object.assign(async () => {}, { fragment: { inputs: [] }, _contract: fn._contract, estimateGas: async () => { throw new Error('execution reverted: NotChosen()'); } });
  await assert.rejects(send(bad), /NotChosen/);
});

test('real contract: a challenge that ended Disputed is challenged again by a watcher; the old round\'s seat is let go', async () => {
  const m = await market(['w1', 'w2', 'c1', 'r1', 'r2', 'watcher']);
  const W = { w1: m.worker('w1', { lie: true }), w2: m.worker('w2', { lie: true }), r1: m.worker('r1') };
  const watcher = m.worker('watcher', { watch: { maxPerDay: 10n * ZETA } });
  await m.nj.send('user', 'request', [encodeBytes32String('bsc'), T], ZETA);
  m.k.advance(80);
  for (const n of ['w1', 'w2']) await W[n].tick();
  m.k.advance(120);
  for (const n of ['w1', 'w2']) await W[n].tick();
  assert.equal((await m.nj.call('getJob', [0])).status, 2n);
  // c1 challenges (a challenge that goes nowhere); only r1 sits, alone: no quorum.
  const need = await m.nj.call('challengeBondOf', [0]);
  await m.nj.send('c1', 'challenge', [0, '0x' + '77'.repeat(32)], need);
  m.k.advance(80);
  assert.match((await W.r1.tick()).join('\n'), /committed in round 2/);
  m.k.advance(120);
  assert.match((await W.r1.tick()).join('\n'), /revealed in round 2/);
  assert.equal((await m.nj.call('challengeInfo', [0])).state, 4n); // Disputed: c1 got 80% back, r1 20%
  assert.equal(await m.nj.call('credit', [m.ad('r1')]), need / 5n);
  // The watcher still disagrees with the verdict: it opens the next round.
  assert.match((await watcher.tick()).join('\n'), /job 0: watch: CHALLENGED/);
  assert.equal((await m.nj.call('challengeRound', [0])).count, 2n);
  assert.equal((await m.nj.call('challengeInfo', [0])).state, 1n);
  // r1 sat in the earlier round: it lets that seat go and may not sit again.
  assert.match((await W.r1.tick()).join('\n'), /round 2 closed/);
  assert.deepEqual(W.r1.state.seats2, {});
  assert.equal(await m.nj.call('challengeEligible', [0, m.ad('r1')]), false);
  assert.deepEqual(await watcher.tick(), []); // nothing more to do while its round runs
});
