import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const BOND = 100n * ZETA, REWARD = 1n * ZETA, MIN_FEE = ZETA / 10n;
const WINDOW = 120, TIMEOUT = 600, UNBOND = 3600;
const CHAIN = encodeBytes32String('bsc');
const TARGET = '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f';
const V1 = '0x' + '11'.repeat(32), V2 = '0x' + '22'.repeat(32);

const commitment = (verdict, worker, salt) => keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [verdict, worker, salt]));

let c, jobs, salts;
beforeEach(async () => {
  c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4']);
  jobs = await c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND], 'owner');
  await jobs.send('owner', 'fund', [], 1000n * ZETA);
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], BOND);
  salts = {};
});

const addr = (w) => c.acct[w].toString();
async function commitAs(w, id, verdict) {
  salts[w] = hexlify(randomBytes(32));
  await jobs.send(w, 'commit', [id, commitment(verdict, addr(w), salts[w])]);
}
const revealAs = (w, id, verdict) => jobs.send(w, 'reveal', [id, verdict, salts[w]]);
const newJob = async (fee = MIN_FEE) => { await jobs.send('user', 'request', [CHAIN, TARGET], fee); return (await jobs.call('jobCount')) - 1n; };

test('constructor refuses unsafe timing', async () => {
  await assert.rejects(c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, TIMEOUT - 1], 'owner'));
  await assert.rejects(c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, TIMEOUT, TIMEOUT, UNBOND], 'owner'));
});

test('two of three agree: job done, both paid fee share + reward, dissenter penalized', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  await commitAs('w3', id, V1);
  await assert.rejects(commitAs('w4', id, V1), /NoSeat/);
  await revealAs('w1', id, V1);
  await revealAs('w2', id, V2);
  const ev = await revealAs('w3', id, V1);
  assert.ok(ev.some((e) => e.name === 'Finalized' && e.args.verdict === V1));
  const j = await jobs.call('getJob', [id]);
  assert.equal(j.status, 2n);
  assert.equal(j.result, V1);
  assert.equal(await jobs.call('credit', [addr('w1')]), ZETA / 2n + REWARD);
  assert.equal(await jobs.call('credit', [addr('w3')]), ZETA / 2n + REWARD);
  assert.equal(await jobs.call('credit', [addr('w2')]), 0n);
  const w2 = await jobs.call('workers', [addr('w2')]);
  assert.equal(w2.bond, BOND - BOND / 10n);
  assert.equal(w2.active, false); // below the bond now
  assert.equal(await jobs.call('activeWorkers'), 3n);
});

test('cannot reveal before all seats are taken or the window closes (no copying)', async () => {
  const id = await newJob();
  await commitAs('w1', id, V1);
  await assert.rejects(revealAs('w1', id, V1), /TooEarly/);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
});

test('a reveal that does not match the commitment is refused', async () => {
  const id = await newJob();
  for (const w of ['w1', 'w2', 'w3']) await commitAs(w, id, V1);
  await assert.rejects(jobs.send('w1', 'reveal', [id, V2, salts.w1]), /BadReveal/);
  await assert.rejects(jobs.send('w4', 'reveal', [id, V1, salts.w1]), /NoSeat/);
});

test('copying a revealed verdict does not work: commitments bind the runner', async () => {
  const id = await newJob();
  await commitAs('w1', id, V1);
  // w2 reuses w1's exact commitment: it cannot open it under its own address.
  await jobs.send('w2', 'commit', [id, commitment(V1, addr('w1'), salts.w1)]);
  await commitAs('w3', id, V2);
  await revealAs('w1', id, V1);
  await assert.rejects(jobs.send('w2', 'reveal', [id, V1, salts.w1]), /BadReveal/);
});

test('no quorum: job fails and the fee goes back to the requester', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
  const ev = await revealAs('w2', id, V2);
  assert.ok(ev.some((e) => e.name === 'JobFailed'));
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
});

test('timeout: anyone can expire; a runner that never revealed is penalized', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V1);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
  await assert.rejects(jobs.send('w4', 'expire', [id]), /TooEarly/);
  c.advance(TIMEOUT);
  const ev = await jobs.send('w4', 'expire', [id]);
  assert.ok(ev.some((e) => e.name === 'Penalized' && e.args.worker.toLowerCase() === addr('w2').toLowerCase()));
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
  await assert.rejects(revealAs('w2', id, V1), /Closed/);
});

test('fee below the minimum, empty or oversized target are refused', async () => {
  await assert.rejects(jobs.send('user', 'request', [CHAIN, TARGET], MIN_FEE - 1n), /BadValue/);
  await assert.rejects(jobs.send('user', 'request', [CHAIN, ''], MIN_FEE), /BadValue/);
  await assert.rejects(jobs.send('user', 'request', [CHAIN, 'x'.repeat(65)], MIN_FEE), /BadValue/);
});

test('only bonded runners take seats; leaving waits for the unbond delay', async () => {
  const id = await newJob();
  await assert.rejects(jobs.send('user', 'commit', [id, V1]), /NotWorker/);
  await assert.rejects(jobs.send('owner', 'register', [], BOND - 1n), /BadValue/);
  await jobs.send('w4', 'requestUnbond');
  await assert.rejects(commitAs('w4', id, V1), /NotWorker/);
  await assert.rejects(jobs.send('w4', 'withdrawBond'), /TooEarly/);
  c.advance(UNBOND);
  await jobs.send('w4', 'withdrawBond');
  assert.equal(await jobs.call('credit', [addr('w4')]), BOND);
});

test('withdraw pays out credit exactly once', async () => {
  const id = await newJob(ZETA);
  for (const w of ['w1', 'w2', 'w3']) await commitAs(w, id, V1);
  await revealAs('w1', id, V1);
  await revealAs('w2', id, V1);
  const before = await c.balance('w1');
  await jobs.send('w1', 'withdraw');
  assert.equal(await c.balance('w1') - before, ZETA / 2n + REWARD);
  await assert.rejects(jobs.send('w1', 'withdraw'), /Nothing/);
  // The late third reveal on a finished job is refused.
  await assert.rejects(revealAs('w3', id, V1), /Closed/);
});

test('rewards stop when the pool is empty; fees still pay', async () => {
  const c2 = await createChain(['owner', 'user', 'w1', 'w2']);
  const j2 = await c2.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND], 'owner');
  for (const w of ['w1', 'w2']) await j2.send(w, 'register', [], BOND);
  await j2.send('user', 'request', [CHAIN, TARGET], ZETA);
  const s = {};
  for (const w of ['w1', 'w2']) {
    s[w] = hexlify(randomBytes(32));
    await j2.send(w, 'commit', [0, commitment(V1, c2.acct[w].toString(), s[w])]);
  }
  c2.advance(WINDOW);
  for (const w of ['w1', 'w2']) await j2.send(w, 'reveal', [0, V1, s[w]]);
  assert.equal(await j2.call('credit', [c2.acct.w1.toString()]), ZETA / 2n);
});

test('requestFor sends a refund to the named user, not the payer', async () => {
  await jobs.send('owner', 'requestFor', [addr('user'), CHAIN, TARGET], ZETA);
  const id = (await jobs.call('jobCount')) - 1n;
  c.advance(TIMEOUT);
  await jobs.send('w4', 'expire', [id]);
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
  assert.equal(await jobs.call('credit', [addr('owner')]), 0n);
  await assert.rejects(jobs.send('owner', 'requestFor', ['0x' + '00'.repeat(20), CHAIN, TARGET], ZETA), /BadValue/);
});
