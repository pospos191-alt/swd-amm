import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBytes32String } from 'ethers';
import { createWorker, commitmentOf } from '../src/worker.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
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
