// Parametric hack insurance, testnet only (item 32): pool, covers, a claim as deterministic replay evidence +
// Neuro's forensic report hash, the runner committee's vote (same report hash and loss), the dispute window,
// governance on disputes, and the caps.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const V = '0x' + '11'.repeat(32);
const REPORT = '0x' + 'f0'.repeat(32);
const TXS = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
const DAY = 86400;
const abi = AbiCoder.defaultAbiCoder();
let c, jobs, ins, target;
const a = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['gov', 'lp', 'lp2', 'holder', 'w1', 'w2', 'w3', 'w4', 'user', 'disputer']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], 100n * ZETA);
  c.advance(1);
  for (const seats of [['w1', 'w2', 'w3'], ['w4', 'w1', 'w2']]) {
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [id, keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
  ins = await c.deploy('HackInsurance', [jobs.address, 2, 1, a('gov')], 'gov');
  target = await ins.call('targetKey', [1n, a('user')]);
  await ins.send('lp', 'deposit', [], 1000n * ZETA);
  await ins.send('gov', 'setTarget', [target, true, 300n * ZETA]);
});

async function covered(amount = 500n * ZETA) {
  const prem = await ins.call('premiumOf', [amount, 30 * DAY]);
  await ins.send('holder', 'buyCover', [target, amount, 30 * DAY], prem);
  return (await ins.call('coverCount')) - 1n;
}
async function filed(loss = 400n * ZETA) {
  const id = await covered();
  c.mine(5);
  const from = c.blockNumber() - 4n;
  await ins.send('holder', 'fileClaim', [id, TXS, from, from + 2n, REPORT, loss, 'neuro-forensic:replay.json'], ZETA);
  return { coverId: id, claimId: (await ins.call('claimCount')) - 1n, from };
}

test('pool and covers: shares, premium into the pool, capacity limit, unlisted targets refused', async () => {
  assert.equal(await ins.call('assets'), 1000n * ZETA);
  const prem = await ins.call('premiumOf', [500n * ZETA, 365 * DAY]);
  assert.equal(prem, 10n * ZETA, '2% a year');
  await assert.rejects(ins.send('holder', 'buyCover', [keccak256('0x01'), ZETA, 30 * DAY], ZETA), /NotListed/);
  await assert.rejects(ins.send('holder', 'buyCover', [target, 500n * ZETA, 365 * DAY], prem - 1n), /Premium/);
  await ins.send('holder', 'buyCover', [target, 500n * ZETA, 365 * DAY], prem + 5n);
  assert.equal(await ins.call('assets'), 1010n * ZETA, 'premium joins the pool; the extra came back');
  await assert.rejects(ins.send('holder', 'buyCover', [target, 2600n * ZETA, 30 * DAY], ZETA * 100n), /OverCapacity/, 'at most 3x the pool');
  await ins.send('lp2', 'deposit', [], 101n * ZETA);
  assert.equal(await ins.call('shares', [a('lp2')]), (101n * ZETA * 1000n * ZETA) / (1010n * ZETA), 'at the share price after the premium');
});

test('claim approved by runners that restate the same report hash and loss, then paid after the dispute window (capped)', async () => {
  const { claimId } = await filed();
  await assert.rejects(ins.send('user', 'vote', [claimId, true, REPORT, 400n * ZETA]), /NotRunner/);
  await ins.send('w1', 'vote', [claimId, true, REPORT, 400n * ZETA]);
  await assert.rejects(ins.send('w1', 'vote', [claimId, true, REPORT, 400n * ZETA]), /AlreadyVoted/);
  await ins.send('w2', 'vote', [claimId, true, REPORT, 400n * ZETA]);
  const k = await ins.call('claims', [claimId]);
  assert.equal(k.state, 2n, 'Approved');
  await assert.rejects(ins.send('holder', 'payout', [claimId]), /NotYet/, 'dispute window first');
  c.advance(2 * DAY);
  const pay = await ins.call('payoutOf', [claimId]);
  assert.equal(pay, (await ins.call('assets')) * 2000n / 10000n, 'min(loss 400, cover 500, target cap 300, 20% of the pool (1000 + premium), daily cap 1000)');
  assert.ok(pay < 300n * ZETA);
  const before = await c.balance('holder');
  await ins.send('user', 'payout', [claimId]);
  assert.equal(await c.balance('holder') - before, pay + ZETA, 'payout + the claim bond back');
  await assert.rejects(ins.send('user', 'payout', [claimId]), /WrongState/);
  await assert.rejects(ins.send('holder', 'fileClaim', [0, TXS, 1, 2, REPORT, ZETA, ''], ZETA), /Claimed/, 'one payout per cover');
});

test('a runner whose replay differs counts against: quorum rejections reject, the bond stays in the pool', async () => {
  const { claimId } = await filed();
  await ins.send('w1', 'vote', [claimId, true, '0x' + 'ee'.repeat(32), 400n * ZETA]);   // another report
  await ins.send('w2', 'vote', [claimId, true, REPORT, 399n * ZETA]);                    // another loss
  assert.equal((await ins.call('claims', [claimId])).state, 3n, 'Rejected');
  assert.equal(await ins.call('bondsHeld'), 0n);
  assert.ok(await ins.call('assets') > 1000n * ZETA, 'the bond joined the pool');
});

test('evidence rules: the holder only, a bond, 1..16 tx hashes, a block range inside the cover and in the past', async () => {
  const id = await covered();
  c.mine(3);
  const now = c.blockNumber();
  await assert.rejects(ins.send('user', 'fileClaim', [id, TXS, now - 2n, now - 1n, REPORT, ZETA, ''], ZETA), /NotHolder/);
  await assert.rejects(ins.send('holder', 'fileClaim', [id, TXS, now - 2n, now - 1n, REPORT, ZETA, ''], 0n), /Bond/);
  await assert.rejects(ins.send('holder', 'fileClaim', [id, [], now - 2n, now - 1n, REPORT, ZETA, ''], ZETA), /BadEvidence/);
  await assert.rejects(ins.send('holder', 'fileClaim', [id, Array(17).fill(TXS[0]), now - 2n, now - 1n, REPORT, ZETA, ''], ZETA), /BadEvidence/);
  await assert.rejects(ins.send('holder', 'fileClaim', [id, TXS, 1n, now - 1n, REPORT, ZETA, ''], ZETA), /BadEvidence/, 'before the cover');
  await assert.rejects(ins.send('holder', 'fileClaim', [id, TXS, now - 2n, now + 50n, REPORT, ZETA, ''], ZETA), /BadEvidence/, 'in the future');
  await assert.rejects(ins.send('holder', 'fileClaim', [id, TXS, now - 2n, now - 1n, '0x' + '00'.repeat(32), ZETA, ''], ZETA), /BadEvidence/);
  const ev = await ins.send('holder', 'fileClaim', [id, TXS, now - 2n, now - 1n, REPORT, ZETA, 'u'], ZETA);
  const f = ev.find((e) => e?.name === 'ClaimFiled');
  assert.equal(f.args.evidenceHash, keccak256(abi.encode(['uint256', 'bytes32', 'bytes32[]', 'uint64', 'uint64'], [1n, target, TXS, now - 2n, now - 1n])), 'what every runner replays');
  assert.deepEqual([...ev.find((e) => e?.name === 'ClaimEvidence').args.txHashes], TXS);
});

test('dispute: governance overturns (the disputer gets both bonds) or upholds (payout follows)', async () => {
  let { claimId } = await filed();
  for (const w of ['w1', 'w2']) await ins.send(w, 'vote', [claimId, true, REPORT, 400n * ZETA]);
  await assert.rejects(ins.send('disputer', 'dispute', [claimId, 'tx 2 is unrelated'], ZETA), /Bond/);
  await ins.send('disputer', 'dispute', [claimId, 'tx 2 is unrelated'], 5n * ZETA);
  await assert.rejects(ins.send('user', 'payout', [claimId]), /WrongState/);
  await assert.rejects(ins.send('user', 'resolveDispute', [claimId, false]), /NotGovernance/);
  const before = await c.balance('disputer');
  await ins.send('gov', 'resolveDispute', [claimId, false]);
  assert.equal(await c.balance('disputer') - before, 6n * ZETA);
  assert.equal((await ins.call('claims', [claimId])).state, 7n, 'Overturned');
  // the holder may file again (a better replay); this time the dispute fails
  c.mine(2);
  const from = c.blockNumber() - 3n;
  await ins.send('holder', 'fileClaim', [0, TXS, from, from + 1n, REPORT, 100n * ZETA, ''], ZETA);
  claimId = (await ins.call('claimCount')) - 1n;
  for (const w of ['w3', 'w4']) await ins.send(w, 'vote', [claimId, true, REPORT, 100n * ZETA]);
  await ins.send('disputer', 'dispute', [claimId, 'no'], 5n * ZETA);
  await ins.send('gov', 'resolveDispute', [claimId, true]);
  await ins.send('user', 'payout', [claimId]);
  assert.equal((await ins.call('claims', [claimId])).state, 6n, 'Paid');
});

test('no quorum in the vote window: expired, the bond comes back; LP withdrawals wait out a claim\'s life', async () => {
  const { claimId } = await filed();
  await ins.send('w1', 'vote', [claimId, true, REPORT, 400n * ZETA]);
  await assert.rejects(ins.send('user', 'expire', [claimId]), /NotYet/);
  c.advance(3 * DAY + 1);
  await assert.rejects(ins.send('w2', 'vote', [claimId, true, REPORT, 400n * ZETA]), /TooLate/);
  const before = await c.balance('holder');
  await ins.send('user', 'expire', [claimId]);
  assert.equal(await c.balance('holder') - before, ZETA);
  const s = await ins.call('shares', [a('lp')]);
  await ins.send('lp', 'requestWithdraw', [s / 2n]);
  await assert.rejects(ins.send('lp', 'withdraw'), /NotYet/);
  c.advance(7 * DAY);
  await ins.send('lp', 'withdraw');
  assert.equal(await ins.call('shares', [a('lp')]), s - s / 2n);
  await assert.rejects(ins.send('gov', 'setParams', [200, 30000, 2000, 1000n * ZETA, ZETA, 5n * ZETA, 3 * DAY, 2 * DAY, DAY]), /BadParams/, 'withdrawals must outlast a claim');
});

test('the daily cap limits all payouts of a day', async () => {
  await ins.send('gov', 'setParams', [200, 30000, 10000, 50n * ZETA, ZETA, 5n * ZETA, 3 * DAY, 2 * DAY, 7 * DAY]);
  const { claimId } = await filed(400n * ZETA);
  for (const w of ['w1', 'w2']) await ins.send(w, 'vote', [claimId, true, REPORT, 400n * ZETA]);
  c.advance(2 * DAY);
  assert.equal(await ins.call('payoutOf', [claimId]), 50n * ZETA);
});
