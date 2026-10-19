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
