import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { readFileSync } from 'node:fs';
import { createChain, ZETA } from './helpers/evm.js';

const BOND = 100n * ZETA;
const V = '0x' + '11'.repeat(32);
const FP = '0x' + 'f1'.repeat(32); // a code fingerprint (fp1 sha256)
const R = { None: 0, Drainer: 1, Honeypot: 2, Phishing: 5 };

let c, jobs, reg;
const addr = (w) => c.acct[w].toString();

beforeEach(async () => {
  c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4', 'newbie']);
  jobs = await c.deploy('NeuroJobs', [BOND, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'owner');
  for (const w of ['w1', 'w2', 'w3', 'w4', 'newbie']) await jobs.send(w, 'register', [], BOND);
  c.advance(1);
  // w1..w4 earn a track record: one job where all four... only 3 seats, so two jobs.
  for (const seats of [['w1', 'w2', 'w3'], ['w4', 'w1', 'w2']]) {
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) {
      salts[w] = hexlify(randomBytes(32));
      await jobs.send(w, 'commit', [id, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [V, addr(w), salts[w]]))]);
    }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {}); // the 3rd may find it closed
  }
  reg = await c.deploy('ThreatRegistry', [jobs.address, 3, 1], 'owner');
});

test('three proven runners flag a fingerprint; the registry then reports it', async () => {
  await reg.send('w1', 'vote', [FP, true, R.Drainer]);
  await reg.send('w2', 'vote', [FP, true, R.Drainer]);
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [false, 1n]);
  const ev = await reg.send('w4', 'vote', [FP, true, R.Drainer]);
  assert.ok(ev.some((e) => e?.name === 'Flagged'));
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [true, 1n]);
  assert.equal(await reg.call('flaggedCount'), 1n);
});

test('runners without a track record, outsiders and double votes do not count', async () => {
  await assert.rejects(reg.send('newbie', 'vote', [FP, true, R.Drainer]), /NotRunner/); // bonded, 0 accepted verdicts
  await assert.rejects(reg.send('user', 'vote', [FP, true, R.Drainer]), /NotRunner/);
  await reg.send('w1', 'vote', [FP, true, R.Drainer]);
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.Drainer]), /AlreadyVoted/);
  await assert.rejects(reg.send('w2', 'vote', [FP, true, R.None]), /NoChange/);
  await assert.rejects(reg.send('w2', 'vote', [FP, false, R.None]), /NoChange/); // nothing to clear yet
});

test('a flag is cleared only by the same quorum (appeal to the network)', async () => {
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [FP, true, R.Honeypot]);
  await reg.send('w1', 'vote', [FP, false, R.None]); // the same runner may vote again in the new round
  await reg.send('w2', 'vote', [FP, false, R.None]);
  assert.equal((await reg.call('isFlagged', [FP]))[0], true);
  const ev = await reg.send('w4', 'vote', [FP, false, R.None]);
  assert.ok(ev.some((e) => e?.name === 'Cleared'));
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [false, 0n]);
});

test('a runner that leaves can no longer vote', async () => {
  await jobs.send('w1', 'requestUnbond');
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.Drainer]), /NotRunner/);
});

// ---- vaccine: exact identities that contracts can check ----
const EMPTY = keccak256('0x');
const lockboxCode = JSON.parse(readFileSync(new URL('../artifacts/LockBox.json', import.meta.url), 'utf8')).deployedBytecode;

test('vaccine keys: code hashes and per-chain addresses are flagged and cleared by the same quorum', async () => {
  const lb = await c.deploy('LockBox', [], 'user'); // no immutables: its code hash is keccak256(deployedBytecode)
  const h = keccak256(lockboxCode);
  assert.equal(await reg.call('codeKey', [h]), keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['zetaphy.threat.code', h])));
  const srcSender = '0x' + '5e'.repeat(20);
  const addrKey = await reg.call('addressKey', [97n, srcSender]);
  assert.equal(addrKey, keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address'], ['zetaphy.threat.address', 97n, srcSender])));
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [h]), true, R.Drainer]);
  assert.deepEqual([...await reg.call('isCodeFlagged', [h])], [true, 1n]);
  assert.deepEqual([...await reg.call('isContractFlagged', [lb.address])], [true, 1n]); // extcodehash on this chain
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [false, 0n]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [97n, srcSender])], [false, 0n]);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [addrKey, true, R.Phishing]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [97n, srcSender])], [true, 5n]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [98n, srcSender])], [false, 0n]); // another chain: not the same address
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [h]), false, R.None]);
  assert.deepEqual([...await reg.call('isContractFlagged', [lb.address])], [false, 0n]);
});

test('a flagged address on this chain makes isContractFlagged true even without code', async () => {
  const k = await reg.call('addressKey', [1n, addr('user')]); // the test chain's id is 1
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [k, true, R.Phishing]);
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [true, 5n]);
});

test('empty code is never flagged, so a flag on it cannot block every plain account', async () => {
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [EMPTY]), true, R.Drainer]);
  assert.deepEqual([...await reg.call('isCodeFlagged', [EMPTY])], [false, 0n]);
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [false, 0n]);
});

test('voteBatch: a fingerprint and the code hashes / addresses found for it, in one vote each; repeats are skipped', async () => {
  const h = keccak256(lockboxCode);
  const keys = [FP, await reg.call('codeKey', [h]), await reg.call('addressKey', [56n, '0x' + 'ab'.repeat(20)])];
  await reg.send('w1', 'voteBatch', [keys, true, R.Drainer]);
  await reg.send('w1', 'voteBatch', [[...keys, '0x' + 'cd'.repeat(32)], true, R.Drainer]); // only the new key counts
  await assert.rejects(reg.send('w1', 'voteBatch', [keys, true, R.Drainer]), /NoChange/); // nothing new
  await assert.rejects(reg.send('w2', 'voteBatch', [keys, true, R.None]), /NoChange/);
  await assert.rejects(reg.send('newbie', 'voteBatch', [keys, true, R.Drainer]), /NotRunner/);
  await reg.send('w2', 'voteBatch', [keys, true, R.Drainer]);
  assert.equal((await reg.call('isFlagged', [FP]))[0], false);
  const ev = await reg.send('w4', 'voteBatch', [keys, true, R.Drainer]);
  assert.equal(ev.filter((e) => e?.name === 'Flagged').length, 3);
  assert.equal((await reg.call('isFlagged', [FP]))[0], true);
  assert.equal((await reg.call('isCodeFlagged', [h]))[0], true);
  assert.equal((await reg.call('isAddressFlagged', [56n, '0x' + 'ab'.repeat(20)]))[0], true);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'voteBatch', [keys, false, R.None]); // cleared the same way
  assert.equal((await reg.call('isCodeFlagged', [h]))[0], false);
  assert.equal((await reg.call('isFlagged', [FP]))[0], false);
});
