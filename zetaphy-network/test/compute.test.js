import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const BOND = 100n * ZETA;
const MODEL = encodeBytes32String('llama-3.1-8b-q4');
const IN = keccak256('0x01');
const OUT = keccak256('0x02');

let c, jobs, market;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['owner', 'user', 'gpu', 'w2', 'w3', 'fresh']);
  jobs = await c.deploy('NeuroJobs', [BOND, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'owner');
  for (const w of ['gpu', 'w2', 'w3', 'fresh']) await jobs.send(w, 'register', [], BOND);
  c.advance(1); // runners must be registered before a job is requested
  // gpu, w2, w3 build a track record on one tier-1 job
  await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
  const V = '0x' + '11'.repeat(32), salts = {};
  for (const w of ['gpu', 'w2', 'w3']) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [0, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
  for (const w of ['gpu', 'w2']) await jobs.send(w, 'reveal', [0, V, salts[w]]);
  market = await c.deploy('ComputeMarket', [jobs.address, 1], 'owner');
});
const newTask = async (price = 5n * ZETA, secs = 3600) => { await market.send('user', 'request', [MODEL, IN, 'ipfs://input', secs], price); return (await market.call('taskCount')) - 1n; };

test('request -> take -> deliver -> accept pays the runner', async () => {
  const id = await newTask();
  await market.send('gpu', 'take', [id]);
  await market.send('gpu', 'deliver', [id, OUT, 'ipfs://result']);
  await market.send('user', 'accept', [id]);
  assert.equal(await market.call('credit', [a('gpu')]), 5n * ZETA);
  assert.equal(await market.call('runnerDone', [a('gpu')]), 1n);
  const before = await c.balance('gpu');
  await market.send('gpu', 'withdraw');
  assert.equal(await c.balance('gpu') - before, 5n * ZETA);
});

test('silence pays the runner after the review window; not before', async () => {
  const id = await newTask();
  await market.send('gpu', 'take', [id]);
  await market.send('gpu', 'deliver', [id, OUT, 'ipfs://result']);
  await assert.rejects(market.send('gpu', 'claim', [id]), /TooEarly/);
  c.advance(86401);
  await market.send('gpu', 'claim', [id]);
  await assert.rejects(market.send('user', 'reject', [id]), /BadState/);
});

test('a rejection refunds the requester and is counted on both sides', async () => {
  const id = await newTask();
  await market.send('gpu', 'take', [id]);
  await market.send('gpu', 'deliver', [id, OUT, 'ipfs://result']);
  await market.send('user', 'reject', [id]);
  assert.equal(await market.call('credit', [a('user')]), 5n * ZETA);
  assert.equal(await market.call('runnerRejected', [a('gpu')]), 1n);
  assert.equal(await market.call('requesterRejections', [a('user')]), 1n);
});

test('only proven runners take tasks; only the taker delivers; late or untaken tasks refund', async () => {
  const id = await newTask(ZETA, 100);
  await assert.rejects(market.send('fresh', 'take', [id]), /NotAllowed/);   // bonded, no track record
  await assert.rejects(market.send('user', 'take', [id]), /NotAllowed/);
  await market.send('w2', 'take', [id]);
  await assert.rejects(market.send('gpu', 'deliver', [id, OUT, 'x']), /NotAllowed/);
  await assert.rejects(market.send('user', 'cancel', [id]), /BadState/);    // taken and not late yet
  c.advance(101);
  await assert.rejects(market.send('w2', 'deliver', [id, OUT, 'x']), /BadValue/); // too late
  await market.send('user', 'cancel', [id]);
  assert.equal(await market.call('credit', [a('user')]), ZETA);
  const id2 = await newTask();
  await market.send('user', 'cancel', [id2]);
  await assert.rejects(market.send('gpu', 'take', [id2]), /BadState/);
});

test('bad requests are refused', async () => {
  await assert.rejects(market.send('user', 'request', [MODEL, IN, 'x', 3600], 0n), /BadValue/);
  await assert.rejects(market.send('user', 'request', ['0x' + '00'.repeat(32), IN, 'x', 3600], ZETA), /BadValue/);
  await assert.rejects(market.send('user', 'request', [MODEL, IN, 'x', 8 * 86400], ZETA), /BadValue/);
});
