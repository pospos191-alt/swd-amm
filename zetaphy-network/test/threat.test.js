import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { readFileSync } from 'node:fs';
import { Address } from '@ethereumjs/util';
import solc from 'solc';
import { createChain, ZETA } from './helpers/evm.js';

const BOND = 100n * ZETA;
const V = '0x' + '11'.repeat(32);
const FP = '0x' + 'f1'.repeat(32); // a code fingerprint (fp1 sha256)
// ThreatRegistry.Reason: objective code facts, never intent.
const R = { None: 0, CannotSellInSimulation: 1, UnlimitedMint: 2, OwnerCanBlockTransfers: 3, OwnerCanMoveHolderFunds: 4, SameNameAsKnownToken: 5, SweepsApprovedTokens: 6, Other: 7 };
// Evidence: a Neuro reportHash (sha256 of the canonical report) and where to read it.
const REPORT = '0x' + 'e7'.repeat(32);
const URI = 'neuro:bsc:0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
const EV = [REPORT, URI];
// The chain's gov module as an EVM caller (MsgEVMCall from x/gov): the first 20 bytes of sha256("gov").
const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';

let c, jobs, reg;
const addr = (w) => c.acct[w].toString();

beforeEach(async () => {
  c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4', 'newbie'], { govModule: GOV_MODULE });
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
  reg = await c.deploy('ThreatRegistry', [jobs.address, 3, 1, addr('owner'), 0], 'owner'); // no enforcement delay here
});

test('three proven runners flag a fingerprint; the registry then reports it', async () => {
  await reg.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  await reg.send('w2', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [false, 1n]);
  const ev = await reg.send('w4', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  assert.ok(ev.some((e) => e?.name === 'Flagged'));
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [true, 1n]);
  assert.equal(await reg.call('flaggedCount'), 1n);
});

test('runners without a track record, outsiders and double votes do not count', async () => {
  await assert.rejects(reg.send('newbie', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /NotRunner/); // bonded, 0 accepted verdicts
  await assert.rejects(reg.send('user', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /NotRunner/);
  await reg.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /AlreadyVoted/);
  await assert.rejects(reg.send('w2', 'vote', [FP, true, R.None, ...EV]), /NoChange/);
  await assert.rejects(reg.send('w2', 'vote', [FP, false, R.None, ...EV]), /NoChange/); // nothing to clear yet
});

test('a flag is cleared only by the same quorum (appeal to the network)', async () => {
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [FP, true, R.UnlimitedMint, ...EV]);
  await reg.send('w1', 'vote', [FP, false, R.None, ...EV]); // the same runner may vote again in the new round
  await reg.send('w2', 'vote', [FP, false, R.None, ...EV]);
  assert.equal((await reg.call('isFlagged', [FP]))[0], true);
  const ev = await reg.send('w4', 'vote', [FP, false, R.None, ...EV]);
  assert.ok(ev.some((e) => e?.name === 'Cleared'));
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [false, 0n]);
});

test('a runner that leaves can no longer vote', async () => {
  await jobs.send('w1', 'requestUnbond');
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /NotRunner/);
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
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [h]), true, R.CannotSellInSimulation, ...EV]);
  assert.deepEqual([...await reg.call('isCodeFlagged', [h])], [true, 1n]);
  assert.deepEqual([...await reg.call('isContractFlagged', [lb.address])], [true, 1n]); // extcodehash on this chain
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [false, 0n]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [97n, srcSender])], [false, 0n]);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [addrKey, true, R.SameNameAsKnownToken, ...EV]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [97n, srcSender])], [true, 5n]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [98n, srcSender])], [false, 0n]); // another chain: not the same address
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [h]), false, R.None, ...EV]);
  assert.deepEqual([...await reg.call('isContractFlagged', [lb.address])], [false, 0n]);
});

test('a flagged address on this chain makes isContractFlagged true even without code', async () => {
  const k = await reg.call('addressKey', [1n, addr('user')]); // the test chain's id is 1
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [k, true, R.SameNameAsKnownToken, ...EV]);
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [true, 5n]);
});

test('empty code is never flagged, so a flag on it cannot block every plain account', async () => {
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [await reg.call('codeKey', [EMPTY]), true, R.CannotSellInSimulation, ...EV]);
  assert.deepEqual([...await reg.call('isCodeFlagged', [EMPTY])], [false, 0n]);
  assert.deepEqual([...await reg.call('isContractFlagged', [addr('user')])], [false, 0n]);
});

test('voteBatch: a fingerprint and the code hashes / addresses found for it, in one vote each; repeats are skipped', async () => {
  const h = keccak256(lockboxCode);
  const keys = [FP, await reg.call('codeKey', [h]), await reg.call('addressKey', [56n, '0x' + 'ab'.repeat(20)])];
  await reg.send('w1', 'voteBatch', [keys, true, R.CannotSellInSimulation, ...EV]);
  await reg.send('w1', 'voteBatch', [[...keys, '0x' + 'cd'.repeat(32)], true, R.CannotSellInSimulation, ...EV]); // only the new key counts
  await assert.rejects(reg.send('w1', 'voteBatch', [keys, true, R.CannotSellInSimulation, ...EV]), /NoChange/); // nothing new
  await assert.rejects(reg.send('w2', 'voteBatch', [keys, true, R.None, ...EV]), /NoChange/);
  await assert.rejects(reg.send('newbie', 'voteBatch', [keys, true, R.CannotSellInSimulation, ...EV]), /NotRunner/);
  await reg.send('w2', 'voteBatch', [keys, true, R.CannotSellInSimulation, ...EV]);
  assert.equal((await reg.call('isFlagged', [FP]))[0], false);
  const ev = await reg.send('w4', 'voteBatch', [keys, true, R.CannotSellInSimulation, ...EV]);
  assert.equal(ev.filter((e) => e?.name === 'Flagged').length, 3);
  assert.equal((await reg.call('isFlagged', [FP]))[0], true);
  assert.equal((await reg.call('isCodeFlagged', [h]))[0], true);
  assert.equal((await reg.call('isAddressFlagged', [56n, '0x' + 'ab'.repeat(20)]))[0], true);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'voteBatch', [keys, false, R.None, ...EV]); // cleared the same way
  assert.equal((await reg.call('isCodeFlagged', [h]))[0], false);
  assert.equal((await reg.call('isFlagged', [FP]))[0], false);
});

// ---- governance: protected keys and the enforcement delay (a runner quorum alone cannot freeze bridges or wallets) ----
const HOUR = 3600;
const flagBy = async (key, on = true, who = ['w1', 'w2', 'w4']) => { for (const w of who) await reg.send(w, 'vote', [key, on, on ? R.CannotSellInSimulation : R.None, ...EV]); };

test('only governance protects keys, sets the delay or hands governance on; the gov module (MsgEVMCall) or a multisig can be it', async () => {
  for (const [fn, args] of [['setProtected', [[FP], true]], ['setEnforceDelay', [HOUR]], ['setGovernance', [addr('user')]]]) {
    await assert.rejects(reg.send('user', fn, args), /NotGovernance/);
    await assert.rejects(reg.send('w1', fn, args), /NotGovernance/); // runners are not governance
  }
  await assert.rejects(reg.send('owner', 'setEnforceDelay', [31 * 86400])); // capped at 30 days
  await assert.rejects(c.deploy('ThreatRegistry', [jobs.address, 3, 1, '0x' + '00'.repeat(20), 0], 'owner')); // a governance is required
  await reg.send('owner', 'setEnforceDelay', [HOUR]);
  assert.equal(await reg.call('enforceDelay'), BigInt(HOUR));
  // Hand it to the gov module: from now on only a passed proposal (MsgEVMCall, sender = gov module) acts.
  await reg.send('owner', 'setGovernance', [GOV_MODULE]);
  await assert.rejects(reg.send('owner', 'setProtected', [[FP], true]), /NotGovernance/);
  await reg.send('govModule', 'setProtected', [[FP], true]);
  assert.equal(await reg.call('protectedKey', [FP]), true);
  // ...or to a 2-of-3 multisig.
  const ms = await c.deploy('SimpleMultisig', [[addr('w1'), addr('w2'), addr('w3')], 2], 'owner');
  await reg.send('govModule', 'setGovernance', [ms.address]);
  await ms.send('w1', 'propose', [reg.address, 0, reg.iface.encodeFunctionData('setEnforceDelay', [2 * HOUR])]);
  await ms.send('w2', 'confirm', [0]);
  await ms.send('w3', 'execute', [0]);
  assert.equal(await reg.call('enforceDelay'), BigInt(2 * HOUR));
});

test('a protected key can never be flagged; protecting a flagged key clears it and drops votes in progress', async () => {
  const other = '0x' + 'cd'.repeat(32);
  await flagBy(FP);
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [true, 1n]);
  await reg.send('w1', 'vote', [other, true, R.CannotSellInSimulation, ...EV]); // one vote in progress on another key
  const ev = await reg.send('owner', 'setProtected', [[FP, other], true]);
  assert.ok(ev.some((e) => e?.name === 'Cleared'));
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [false, 0n]);
  assert.deepEqual([...await reg.call('isEnforced', [FP])], [false, 0n]);
  await assert.rejects(reg.send('w2', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /ProtectedKey/);
  await assert.rejects(reg.send('w2', 'vote', [other, true, R.CannotSellInSimulation, ...EV]), /ProtectedKey/);
  // voteBatch skips protected keys (and reverts when nothing else is left).
  await assert.rejects(reg.send('w2', 'voteBatch', [[FP, other], true, R.CannotSellInSimulation, ...EV]), /NoChange/);
  const free = '0x' + 'ef'.repeat(32);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'voteBatch', [[FP, other, free], true, R.CannotSellInSimulation, ...EV]);
  assert.equal((await reg.call('isFlagged', [free]))[0], true);
  assert.equal((await reg.call('isFlagged', [FP]))[0], false);
  assert.equal((await reg.call('isFlagged', [other]))[0], false, 'the vote cast before protection no longer counts');
  // Unprotecting flags nothing back; a fresh quorum is needed.
  await reg.send('owner', 'setProtected', [[other], false]);
  assert.equal((await reg.call('isFlagged', [other]))[0], false);
  await flagBy(other);
  assert.equal((await reg.call('isFlagged', [other]))[0], true);
});

test('enforcement: is*Flagged warn at once, is*Enforced (what blocks) only once the flag is enforceDelay old', async () => {
  await reg.send('owner', 'setEnforceDelay', [HOUR]);
  const lb = await c.deploy('LockBox', [], 'user');
  const h = keccak256(lockboxCode);
  const ak = await reg.call('addressKey', [97n, addr('user')]);
  await flagBy(await reg.call('codeKey', [h]));
  await flagBy(ak);
  const flaggedAt = c.now();
  // Warning views: immediate.
  assert.deepEqual([...await reg.call('isCodeFlagged', [h])], [true, 1n]);
  assert.deepEqual([...await reg.call('isContractFlagged', [lb.address])], [true, 1n]);
  assert.deepEqual([...await reg.call('isAddressFlagged', [97n, addr('user')])], [true, 1n]);
  // Enforcement views: not yet.
  assert.deepEqual([...await reg.call('isCodeEnforced', [h])], [false, 0n]);
  assert.deepEqual([...await reg.call('isContractEnforced', [lb.address])], [false, 0n]);
  assert.deepEqual([...await reg.call('isAddressEnforced', [97n, addr('user')])], [false, 0n]);
  assert.equal(await reg.call('enforcedFrom', [ak]), flaggedAt + BigInt(HOUR));
  c.advance(HOUR - 1);
  assert.equal((await reg.call('isEnforced', [ak]))[0], false);
  c.advance(1);
  assert.deepEqual([...await reg.call('isEnforced', [ak])], [true, 1n]);
  assert.deepEqual([...await reg.call('isContractEnforced', [lb.address])], [true, 1n]);
  assert.deepEqual([...await reg.call('isAddressEnforced', [97n, addr('user')])], [true, 1n]);
  assert.deepEqual([...await reg.call('isCodeEnforced', [EMPTY])], [false, 0n]);
  // Governance protecting the key inside (or after) the window lifts it at once.
  await reg.send('owner', 'setProtected', [[ak], true]);
  assert.deepEqual([...await reg.call('isAddressEnforced', [97n, addr('user')])], [false, 0n]);
  assert.equal(await reg.call('enforcedFrom', [ak]), 0n);
  // A clear is immediate (no delay to unblock).
  await flagBy(await reg.call('codeKey', [h]), false);
  assert.deepEqual([...await reg.call('isContractEnforced', [lb.address])], [false, 0n]);
});

// ---- fast lane: a supermajority, or governance / a guardian, enforces a flag at once ----

test('fast lane: fastQuorum runners behind a flag enforce it at once (default 2 x quorum; governance sets it)', async () => {
  assert.equal(await reg.call('fastQuorum'), 6n); // quorum 3
  const r2 = await c.deploy('ThreatRegistry', [jobs.address, 2, 1, addr('owner'), HOUR], 'owner');
  assert.equal(await r2.call('fastQuorum'), 4n);
  for (const [who, f] of [['user', 3], ['w1', 3]]) await assert.rejects(r2.send(who, 'setFastQuorum', [f]), /NotGovernance/);
  await assert.rejects(r2.send('owner', 'setFastQuorum', [2])); // must be above quorum (a supermajority), or 0
  await r2.send('owner', 'setFastQuorum', [3]);
  await r2.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  await r2.send('w2', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]); // quorum: flagged, warning only
  assert.deepEqual([...await r2.call('isFlagged', [FP])], [true, 1n]);
  assert.deepEqual([...await r2.call('isEnforced', [FP])], [false, 0n]);
  await assert.rejects(r2.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /AlreadyVoted/); // already behind it
  const ev = await r2.send('w4', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]); // a third runner backs the standing flag
  assert.ok(ev.some((e) => e?.name === 'FastEnforced'));
  assert.deepEqual([...await r2.call('isEnforced', [FP])], [true, 1n]);
  assert.equal(await r2.call('enforcedFrom', [FP]), c.now());
  const e = await r2.call('entries', [FP]);
  assert.equal(e.fast, true);
  assert.equal(e.support, 3n);
  assert.equal(await r2.call('voted', [FP, 0, addr('w4')]), false, 'a backer is not one of the voters that set the flag');
  assert.equal(await r2.call('backed', [FP, 0, addr('w4')]), true);
  await assert.rejects(r2.send('w3', 'vote', [FP, true, R.CannotSellInSimulation, ...EV])); // nothing left to change (or not proven)
  // A clear (same quorum) lifts the fast lane too; a new flag starts from the delay again.
  for (const w of ['w1', 'w2']) await r2.send(w, 'vote', [FP, false, R.None, ...EV]);
  assert.deepEqual([...await r2.call('isEnforced', [FP])], [false, 0n]);
  for (const w of ['w1', 'w2']) await r2.send(w, 'vote', [FP, true, R.CannotSellInSimulation, ...EV]);
  assert.deepEqual([...await r2.call('isEnforced', [FP])], [false, 0n]);
  assert.equal((await r2.call('entries', [FP])).fast, false);
  // voteBatch backs standing flags the same way; fastQuorum 0 turns the lane off.
  await r2.send('owner', 'setFastQuorum', [0]);
  await r2.send('w4', 'voteBatch', [[FP], true, R.CannotSellInSimulation, ...EV]);
  assert.deepEqual([...await r2.call('isEnforced', [FP])], [false, 0n]);
  assert.equal((await r2.call('entries', [FP])).support, 3n);
  await assert.rejects(r2.send('w4', 'voteBatch', [[FP], true, R.CannotSellInSimulation, ...EV]), /NoChange/);
});

test('fast lane through voteBatch: the quorum flags, the next runner\'s batch enforces it at once', async () => {
  const r2 = await c.deploy('ThreatRegistry', [jobs.address, 2, 1, addr('owner'), HOUR], 'owner');
  await r2.send('owner', 'setFastQuorum', [3]);
  await r2.send('w1', 'voteBatch', [[FP], true, R.CannotSellInSimulation, ...EV]);
  await r2.send('w2', 'voteBatch', [[FP], true, R.CannotSellInSimulation, ...EV]);
  assert.equal((await r2.call('isEnforced', [FP]))[0], false);
  await r2.send('w4', 'voteBatch', [[FP], true, R.CannotSellInSimulation, ...EV]);
  assert.equal((await r2.call('isEnforced', [FP]))[0], true);
});

test('enforceNow: only governance or a guardian; only a standing flag; protected keys stay untouched', async () => {
  await reg.send('owner', 'setEnforceDelay', [HOUR]);
  await assert.rejects(reg.send('user', 'setGuardian', [addr('user'), true]), /NotGovernance/);
  await reg.send('owner', 'setGuardian', [addr('user'), true]);
  assert.equal(await reg.call('guardian', [addr('user')]), true);
  await assert.rejects(reg.send('user', 'enforceNow', [FP]), /NotFlagged/); // a guardian cannot flag by itself
  await flagBy(FP);
  assert.equal((await reg.call('isEnforced', [FP]))[0], false);
  for (const who of ['w1', 'newbie']) await assert.rejects(reg.send(who, 'enforceNow', [FP]), /NotGuardian/); // runners are not guardians
  const ev = await reg.send('user', 'enforceNow', [FP]);
  assert.ok(ev.some((e) => e?.name === 'FastEnforced'));
  assert.deepEqual([...await reg.call('isEnforced', [FP])], [true, 1n]);
  await assert.rejects(reg.send('owner', 'enforceNow', [FP]), /NoChange/);
  // Governance itself may too.
  const other = '0x' + 'cd'.repeat(32);
  await flagBy(other);
  await reg.send('owner', 'enforceNow', [other]);
  assert.equal((await reg.call('isEnforced', [other]))[0], true);
  // A guardian removed can no longer act; it cannot protect or set knobs either.
  await assert.rejects(reg.send('user', 'setProtected', [[FP], true]), /NotGovernance/);
  await assert.rejects(reg.send('user', 'setFastQuorum', [0]), /NotGovernance/);
  await reg.send('owner', 'setGuardian', [addr('user'), false]);
  const third = '0x' + 'ef'.repeat(32);
  await flagBy(third);
  await assert.rejects(reg.send('user', 'enforceNow', [third]), /NotGuardian/);
  // Protected keys: never flagged, so never enforced; protecting a fast-enforced key lifts it at once.
  await reg.send('owner', 'setProtected', [[FP], true]);
  assert.deepEqual([...await reg.call('isEnforced', [FP])], [false, 0n]);
  assert.equal((await reg.call('entries', [FP])).fast, false);
  await assert.rejects(reg.send('owner', 'enforceNow', [FP]), /NotFlagged/);
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.CannotSellInSimulation, ...EV]), /ProtectedKey/);
});

// ---- user reports: a small fee points the runners at a suspicious contract ----
const FEE = ZETA / 10n;
const NOTE = 'airdrop site asks to approve this contract';

async function reports(ttl = 86400) {
  const fund = '0x' + 'fd'.repeat(20);
  const rep = await c.deploy('ThreatReports', [reg.address, fund, FEE, ttl], 'owner');
  return { rep, fund };
}

test('reports: bounded input, exact fee, events for runners\' tools; a flagged key is not reported again', async () => {
  const { rep } = await reports();
  const target = '0x' + '5e'.repeat(20);
  const key = await reg.call('addressKey', [56n, target]);
  const chainKey = encodeBytes32String('eip155:56');
  await assert.rejects(rep.send('user', 'report', [key, chainKey, target, NOTE], FEE - 1n), /BadFee/);
  await assert.rejects(rep.send('user', 'report', [key, chainKey, target, NOTE], 0n), /BadFee/);
  await assert.rejects(rep.send('user', 'report', [key, chainKey, target, 'x'.repeat(281)], FEE), /NoteTooLong/);
  await assert.rejects(rep.send('user', 'report', ['0x' + '00'.repeat(32), chainKey, target, NOTE], FEE), /BadKey/);
  const ev = await rep.send('user', 'report', [key, chainKey, target, 'y'.repeat(280)], FEE);
  const r = ev.find((e) => e?.name === 'Reported');
  assert.equal(r.args.id, 0n);
  assert.equal(r.args.key, key);
  assert.equal(r.args.chainKey, chainKey);
  assert.equal(r.args.target.toLowerCase(), target);
  assert.equal(r.args.reporter.toLowerCase(), addr('user').toLowerCase());
  assert.equal(r.args.note.length, 280);
  assert.equal(await rep.call('reportCount'), 1n);
  await flagBy(FP);
  await assert.rejects(rep.send('user', 'report', [FP, chainKey, target, NOTE], FEE), /AlreadyFlagged/);
  // Only the registry's governance sets the fee (capped), ttl and fund.
  await assert.rejects(rep.send('user', 'setFee', [0n]), /NotGovernance/);
  await assert.rejects(rep.send('owner', 'setFee', [101n * ZETA]));
  await rep.send('owner', 'setFee', [0n]);
  await rep.send('user', 'report', [FP.replace('f1', 'f2'), chainKey, target, NOTE], 0n);
});

test('reports: flagged after the report, the voters who flagged it share the fee; others and double claims get nothing', async () => {
  const { rep, fund } = await reports();
  await rep.send('user', 'report', [FP, encodeBytes32String('bsc'), '0x' + '5e'.repeat(20), NOTE], FEE);
  await assert.rejects(rep.send('user', 'settle', [0]), /NotYet/);
  await assert.rejects(rep.send('w1', 'claim', [0]), /NotSettled/);
  await flagBy(FP); // w1, w2, w4
  await rep.send('newbie', 'settle', [0]); // anyone may settle
  await assert.rejects(rep.send('user', 'settle', [0]), /AlreadySettled/);
  const share = FEE / 3n;
  for (const w of ['w1', 'w2', 'w4']) {
    const before = await c.balance(w);
    await rep.send(w, 'claim', [0]);
    assert.equal(await c.balance(w) - before, share); // the test chain charges no gas
    await assert.rejects(rep.send(w, 'claim', [0]), /AlreadySettled/);
  }
  for (const w of ['w3', 'user']) await assert.rejects(rep.send(w, 'claim', [0]), /NotVoter/);
  assert.equal(await c.balance(Address.fromString(fund)), FEE - 3n * share); // the rounding dust
  assert.equal(await c.balance(Address.fromString(rep.address)), 0n);
});

test('reports: never flagged within ttl, the fee goes to the community fund; a fast-lane backer is not paid as a voter', async () => {
  const { rep, fund } = await reports();
  await rep.send('user', 'report', [FP, encodeBytes32String('bsc'), '0x' + '00'.repeat(20), NOTE], FEE);
  c.advance(86399);
  await assert.rejects(rep.send('user', 'settle', [0]), /NotYet/);
  c.advance(1);
  await rep.send('user', 'settle', [0]);
  assert.equal(await c.balance(Address.fromString(fund)), FEE);
  await assert.rejects(rep.send('w1', 'claim', [0]), /NotSettled/);
  // Flagged before the report was made: the report was refused, so a flag after it is what pays.
  const other = '0x' + 'cd'.repeat(32);
  await rep.send('user', 'report', [other, encodeBytes32String('bsc'), '0x' + '00'.repeat(20), NOTE], FEE);
  await reg.send('owner', 'setFastQuorum', [4]);
  await flagBy(other, true, ['w1', 'w2', 'w4']);
  await rep.send('user', 'settle', [1]);
  // w3 backing the flag later (if it is a proven runner) does not make it a voter of the flagging round.
  await reg.send('w3', 'vote', [other, true, R.CannotSellInSimulation, ...EV]).catch(() => {});
  await assert.rejects(rep.send('w3', 'claim', [1]), /NotVoter/);
});

// ---- neutral reasons, evidence, right of reply and appeal (legal: facts with reproducible evidence, a way to answer) ----
const MOCK_SRC = `
pragma solidity 0.8.26;
contract MockRunners {
    mapping(address => bool) public on;
    function set(address a, bool v) external { on[a] = v; }
    function workers(address a) external view returns (uint128, uint64, bool, uint32, uint32) { return (100, 0, on[a], on[a] ? 5 : 0, 0); }
}
contract MockOwned {
    address public owner;
    constructor(address o) { owner = o; }
    function setOwner(address o) external { owner = o; }
    function exec(address to, bytes calldata data) external { (bool ok, bytes memory r) = to.call(data); if (!ok) assembly { revert(add(r, 32), mload(r)) } }
}
contract MockIdentity {
    mapping(bytes32 => uint256) public agentOfTarget;
    mapping(uint256 => address) public owners;
    function set(string calldata caip10, uint256 id, address o) external { agentOfTarget[keccak256(bytes(caip10))] = id; owners[id] = o; }
    function ownerOf(uint256 id) external view returns (address o) { o = owners[id]; require(o != address(0)); }
}`;
const MOCK_ART = (() => {
  const input = { language: 'Solidity', sources: { 'M.sol': { content: MOCK_SRC } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors?.some((e) => e.severity === 'error')) throw new Error(out.errors.map((e) => e.formattedMessage).join('\n'));
  return Object.fromEntries(Object.entries(out.contracts['M.sol']).map(([n, a]) => [n, { abi: a.abi, bytecode: '0x' + a.evm.bytecode.object, deployedBytecode: '0x' + a.evm.deployedBytecode.object }]));
})();
const ZERO32 = '0x' + '00'.repeat(32);
const ZERO_ADDR = '0x' + '00'.repeat(20);

test('reasons are objective code facts: 1..7 accepted, nothing else; the first voter\'s reason is the flag\'s', async () => {
  // None, CannotSellInSimulation, UnlimitedMint, OwnerCanBlockTransfers, OwnerCanMoveHolderFunds, SameNameAsKnownToken, SweepsApprovedTokens, Other
  assert.equal(Object.keys(R).length, 8);
  for (const [i, k] of [R.SweepsApprovedTokens, R.Other].entries()) {
    const key = '0x' + String(i + 1).repeat(64);
    for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [key, true, k, ...EV]);
    assert.deepEqual([...await reg.call('isFlagged', [key])], [true, BigInt(k)]);
  }
  await assert.rejects(reg.send('w1', 'vote', [FP, true, 8, ...EV])); // not a Reason
  await reg.send('w1', 'vote', [FP, true, R.OwnerCanBlockTransfers, ...EV]);
  await reg.send('w2', 'vote', [FP, true, R.Other, ...EV]);
  await reg.send('w4', 'vote', [FP, true, R.Other, ...EV]);
  assert.deepEqual([...await reg.call('isFlagged', [FP])], [true, BigInt(R.OwnerCanBlockTransfers)]);
});

test('evidence: every flag vote carries a reportHash (uri at most 200 bytes); the flag keeps the first vote\'s; clears need none', async () => {
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.Other, ZERO32, URI]), /NoEvidence/);
  await assert.rejects(reg.send('w1', 'voteBatch', [[FP], true, R.Other, ZERO32, '']), /NoEvidence/);
  await assert.rejects(reg.send('w1', 'vote', [FP, true, R.Other, REPORT, 'u'.repeat(201)]), /TooLong/);
  await assert.rejects(reg.send('w1', 'voteBatch', [[FP], true, R.Other, REPORT, 'u'.repeat(201)]), /TooLong/);
  assert.equal(await reg.call('MAX_URI'), 200n);
  const first = '0x' + 'a1'.repeat(32);
  const ev1 = await reg.send('w1', 'vote', [FP, true, R.UnlimitedMint, first, 'u'.repeat(200)]);
  const v = ev1.find((e) => e?.name === 'Voted');
  assert.equal(v.args.reportHash, first);
  assert.equal(v.args.uri, 'u'.repeat(200));
  const ev2 = await reg.send('w2', 'vote', [FP, true, R.UnlimitedMint, '0x' + 'a2'.repeat(32), 'second']);
  assert.equal(ev2.find((e) => e?.name === 'Voted').args.reportHash, '0x' + 'a2'.repeat(32)); // every vote's evidence is on chain
  await reg.send('w4', 'vote', [FP, true, R.UnlimitedMint, '0x' + 'a4'.repeat(32), 'third']);
  const e = await reg.call('evidenceOf', [FP]);
  assert.equal(e.reportHash, first);
  assert.equal(e.uri, 'u'.repeat(200));
  assert.equal(e.by.toLowerCase(), addr('w1').toLowerCase());
  // A clear vote needs no evidence; once cleared, the flag's evidence is gone with it.
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [FP, false, R.None, ZERO32, '']);
  assert.equal((await reg.call('evidenceOf', [FP])).reportHash, ZERO32);
  // voteBatch: one evidence for every key of the batch.
  const keys = [FP, await reg.call('addressKey', [56n, '0x' + 'ab'.repeat(20)])];
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'voteBatch', [keys, true, R.SweepsApprovedTokens, ...EV]);
  for (const k of keys) assert.deepEqual([...await reg.call('evidenceOf', [k])].slice(0, 2), [REPORT, URI]);
});

test('right of reply: the contract itself, its owner(), the claimed identity owner, or a responder governance names; it never changes the flag', async () => {
  const owned = await c.deployRaw(MOCK_ART.MockOwned, [addr('user')], 'user');
  const chain = 1n; // the test chain's id
  const ak = await reg.call('addressKey', [chain, owned.address]);
  for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [ak, true, R.OwnerCanBlockTransfers, ...EV]);
  const before = [...await reg.call('isFlagged', [ak])];
  // Outsiders, runners and the wrong subject cannot.
  for (const who of ['w1', 'newbie']) await assert.rejects(reg.send(who, 'respond', [ak, chain, owned.address, 'no']), /NotResponder/);
  await assert.rejects(reg.send('user', 'respond', [ak, chain, addr('newbie'), 'not my key']), /NotResponder/);
  await assert.rejects(reg.send('user', 'respond', [ak, 56n, owned.address, 'another chain']), /NotResponder/); // no identity set
  await assert.rejects(reg.send('user', 'respond', [ak, chain, owned.address, 'x'.repeat(501)]), /TooLong/);
  // The owner() answers (500 bytes at most).
  const text = 'ฟังก์ชัน pause มีไว้สำหรับเหตุฉุกเฉินเท่านั้น / pause() is for emergencies; audit: https://example.org/audit';
  const ev = await reg.send('user', 'respond', [ak, chain, owned.address, text]);
  assert.equal(ev.find((e) => e?.name === 'Responded').args.text, text);
  let r = await reg.call('responseOf', [ak]);
  assert.equal(r.text, text);
  assert.equal(r.by.toLowerCase(), addr('user').toLowerCase());
  assert.equal(r.account.toLowerCase(), owned.address.toLowerCase());
  assert.deepEqual([...await reg.call('isFlagged', [ak])], before, 'a response never changes the flag');
  await reg.send('user', 'respond', [ak, chain, owned.address, 'y'.repeat(500)]);
  // Its code key too (every copy's owner is a party to it), only with a contract that has that code.
  const ck = await reg.call('codeKey', [keccak256(MOCK_ART.MockOwned.deployedBytecode)]);
  await reg.send('user', 'respond', [ck, chain, owned.address, 'about the code']);
  assert.equal((await reg.call('responseOf', [ck])).text, 'about the code');
  await assert.rejects(reg.send('user', 'respond', [ck, 56n, owned.address, 'x']), /NotResponder/); // code keys: this chain only
  // The contract itself (a call from it).
  await owned.send('user', 'exec', [reg.address, reg.iface.encodeFunctionData('respond', [ak, chain, owned.address, 'from the contract'])]);
  assert.equal((await reg.call('responseOf', [ak])).by.toLowerCase(), owned.address.toLowerCase());
  // A new owner() takes over; the old one no longer can.
  await owned.send('user', 'setOwner', [addr('w3')]);
  await assert.rejects(reg.send('user', 'respond', [ak, chain, owned.address, 'old owner']), /NotResponder/);
  await reg.send('w3', 'respond', [ak, chain, owned.address, '']); // empty: removes it
  r = await reg.call('responseOf', [ak]);
  assert.equal(r.text, '');
  assert.equal(r.by, ZERO_ADDR);

  // Another chain: the owner of the claimed ERC-8004 identity of "eip155:56:<address>" (NeuroIdentity).
  const remote = '0x' + 'ab'.repeat(20);
  const rk = await reg.call('addressKey', [56n, remote]);
  const idr = await c.deployRaw(MOCK_ART.MockIdentity, [], 'owner');
  await assert.rejects(reg.send('w3', 'respond', [rk, 56n, remote, 'mine']), /NotResponder/); // identity route off
  await assert.rejects(reg.send('user', 'setIdentity', [idr.address]), /NotGovernance/);
  await reg.send('owner', 'setIdentity', [idr.address]);
  await idr.send('owner', 'set', [`eip155:56:${remote.toLowerCase()}`, 7, addr('w3')]);
  await idr.send('owner', 'set', [`eip155:56:${'0x' + 'cd'.repeat(20)}`, 8, idr.address]); // held by the registry: unclaimed
  await assert.rejects(reg.send('user', 'respond', [rk, 56n, remote, 'not mine']), /NotResponder/);
  await reg.send('w3', 'respond', [rk, 56n, remote, 'claimed owner speaking']);
  assert.equal((await reg.call('responseOf', [rk])).text, 'claimed owner speaking');
  const unclaimed = await reg.call('addressKey', [56n, '0x' + 'cd'.repeat(20)]);
  await assert.rejects(reg.send('owner', 'respond', [unclaimed, 56n, '0x' + 'cd'.repeat(20), 'x']), /NotResponder/);

  // A fp1 key: only a responder governance names; once named it is the only one (for any key).
  await assert.rejects(reg.send('user', 'respond', [FP, 0n, ZERO_ADDR, 'x']), /NotResponder/);
  await assert.rejects(reg.send('user', 'setResponder', [FP, addr('user')]), /NotGovernance/);
  await reg.send('owner', 'setResponder', [FP, addr('user')]);
  await reg.send('user', 'respond', [FP, 0n, ZERO_ADDR, 'fp1 answered']);
  await reg.send('owner', 'setResponder', [rk, addr('newbie')]);
  await assert.rejects(reg.send('w3', 'respond', [rk, 56n, remote, 'x']), /NotResponder/);
  await reg.send('newbie', 'respond', [rk, 0n, ZERO_ADDR, 'named']);
  assert.equal(await reg.call('mayAnswer', [rk, 56n, remote, addr('w3')]), false);
});

/** A registry on mock runners (quorum 2) so an appeal has enough fresh runners: w1..w4, newbie and user may vote. */
async function appealSetup() {
  const mr = await c.deployRaw(MOCK_ART.MockRunners, [], 'owner');
  for (const w of ['w1', 'w2', 'w3', 'w4', 'newbie', 'user']) await mr.send('owner', 'set', [addr(w), true]);
  const r = await c.deploy('ThreatRegistry', [mr.address, 2, 1, addr('owner'), 0], 'owner');
  const owned = await c.deployRaw(MOCK_ART.MockOwned, [addr('user')], 'user');
  const key = await r.call('addressKey', [1n, owned.address]);
  const subject = [1n, owned.address];
  const flagIt = async () => { for (const w of ['w1', 'w2']) await r.send(w, 'vote', [key, true, R.OwnerCanBlockTransfers, ...EV]); };
  return { r, key, subject, flagIt, owned };
}
const APPEAL_BOND = ZETA;
const FUND = '0x' + 'fd'.repeat(20);
const regBalance = (r) => c.balance(Address.fromString(r.address));

test('appeal: governance sets bond, window and fund (bounded; off until a fund is set); only the party behind a flagged key appeals, with the exact bond', async () => {
  const { r, key, subject, flagIt } = await appealSetup();
  assert.equal(await r.call('appealWindow'), 14n * 86400n);
  await flagIt();
  await assert.rejects(r.send('user', 'appeal', [key, ...subject], 0n), /AppealsOff/);
  await assert.rejects(r.send('user', 'setAppeals', [APPEAL_BOND, 86400, FUND]), /NotGovernance/);
  await assert.rejects(r.send('owner', 'setAppeals', [1001n * ZETA, 86400, FUND]));
  await assert.rejects(r.send('owner', 'setAppeals', [APPEAL_BOND, 86399, FUND]));
  await assert.rejects(r.send('owner', 'setAppeals', [APPEAL_BOND, 91 * 86400, FUND]));
  await r.send('owner', 'setAppeals', [APPEAL_BOND, 86400, FUND]);
  await assert.rejects(r.send('user', 'appeal', [key, ...subject], APPEAL_BOND - 1n), /BadBond/);
  await assert.rejects(r.send('w3', 'appeal', [key, ...subject], APPEAL_BOND), /NotResponder/);
  await assert.rejects(r.send('user', 'appeal', [FP, 0n, ZERO_ADDR], APPEAL_BOND), /NotFlagged/);
  const ev = await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  assert.equal(ev.find((e) => e?.name === 'Appealed').args.id, 1n);
  await assert.rejects(r.send('user', 'appeal', [key, ...subject], APPEAL_BOND), /AppealOpen/);
  assert.equal(await regBalance(r), APPEAL_BOND);
  const a = await r.call('appeals', [key]);
  assert.equal(a.appellant.toLowerCase(), addr('user').toLowerCase());
  assert.equal(a.bond, APPEAL_BOND);
  assert.equal(a.flagRound, 0n);
});

test('appeal cleared by fresh runners: the flag goes, the bond comes back in full, the flaggers get a strike (a record only)', async () => {
  const { r, key, subject, flagIt } = await appealSetup();
  await r.send('owner', 'setAppeals', [APPEAL_BOND, 86400, FUND]);
  await r.send('owner', 'setFastQuorum', [4]);
  await flagIt();
  await r.send('w3', 'vote', [key, true, R.OwnerCanBlockTransfers, ...EV]); // w3 backs the standing flag
  await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  // Fresh eyes only: not the flag's voters (w1, w2), not its backers (w3), not the appellant; evidence required.
  for (const who of ['w1', 'w2', 'w3', 'user']) await assert.rejects(r.send(who, 'voteAppeal', [key, true, ...EV]), /NotFresh/);
  await assert.rejects(r.send('owner', 'voteAppeal', [key, true, ...EV]), /NotRunner/);
  await assert.rejects(r.send('w4', 'voteAppeal', [key, true, ZERO32, '']), /NoEvidence/);
  await r.send('w4', 'voteAppeal', [key, true, ...EV]);
  await assert.rejects(r.send('w4', 'voteAppeal', [key, true, ...EV]), /AlreadyVoted/);
  assert.equal((await r.call('isFlagged', [key]))[0], true);
  const ev = await r.send('newbie', 'voteAppeal', [key, true, ...EV]);
  assert.ok(ev.some((e) => e?.name === 'Cleared'));
  assert.equal(ev.find((e) => e?.name === 'AppealClosed').args.outcome, 1n);
  assert.deepEqual([...await r.call('isFlagged', [key])], [false, 0n]);
  assert.equal((await r.call('appeals', [key])).appellant, ZERO_ADDR);
  for (const [w, n] of [['w1', 1n], ['w2', 1n], ['w3', 0n], ['w4', 0n]]) assert.equal(await r.call('strikes', [addr(w)]), n);
  // The bond: credited to the appellant, taken with withdraw; nothing to the fund.
  assert.equal(await r.call('owed', [addr('user')]), APPEAL_BOND);
  assert.equal(await r.call('fundOwed'), 0n);
  const before = await c.balance('user');
  await r.send('user', 'withdraw');
  assert.equal(await c.balance('user') - before, APPEAL_BOND); // the test chain charges no gas
  assert.equal(await r.call('owed', [addr('user')]), 0n);
  assert.equal(await regBalance(r), 0n);
  await r.send('user', 'withdraw'); // nothing left: a no-op
  assert.equal(await c.balance('user') - before, APPEAL_BOND);
  await assert.rejects(r.send('w4', 'voteAppeal', [key, true, ...EV]), /NoAppeal/);
});

test('appeal kept: the flag stands and the bond goes to the community fund; then expiry and other clears refund it', async () => {
  const { r, key, subject, flagIt } = await appealSetup();
  await r.send('owner', 'setAppeals', [APPEAL_BOND, 86400, FUND]);
  await flagIt();
  await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  await r.send('w3', 'voteAppeal', [key, false, ...EV]);
  await r.send('w4', 'voteAppeal', [key, true, ...EV]); // one for each side: nothing yet
  const ev = await r.send('newbie', 'voteAppeal', [key, false, ...EV]);
  assert.equal(ev.find((e) => e?.name === 'AppealClosed').args.outcome, 2n);
  assert.deepEqual([...await r.call('isFlagged', [key])], [true, BigInt(R.OwnerCanBlockTransfers)]);
  assert.equal(await r.call('owed', [addr('user')]), 0n);
  assert.equal(await r.call('fundOwed'), APPEAL_BOND);
  for (const w of ['w1', 'w2']) assert.equal(await r.call('strikes', [addr(w)]), 0n);
  await r.send('w4', 'payFund'); // anyone
  assert.equal(await c.balance(Address.fromString(FUND)), APPEAL_BOND);
  assert.equal(await r.call('fundOwed'), 0n);
  assert.equal(await regBalance(r), 0n);

  // A second appeal (id 2): runners who sat on the first one may sit again; nobody decides within the window -> refunded.
  await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  assert.equal(await r.call('appealCount', [key]), 2n);
  await r.send('w3', 'voteAppeal', [key, true, ...EV]);
  await assert.rejects(r.send('user', 'expireAppeal', [key]), /NotYet/);
  c.advance(86400);
  await assert.rejects(r.send('w4', 'voteAppeal', [key, true, ...EV]), /AppealExpired/);
  const ex = await r.send('w4', 'expireAppeal', [key]);
  assert.equal(ex.find((e) => e?.name === 'AppealClosed').args.outcome, 3n);
  assert.equal(await r.call('owed', [addr('user')]), APPEAL_BOND);
  assert.equal((await r.call('isFlagged', [key]))[0], true);

  // A third: the flaggers clear it the normal way meanwhile -> refunded too (outcome 4).
  await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  for (const w of ['w1', 'w2']) await r.send(w, 'vote', [key, false, R.None, ZERO32, '']);
  assert.equal((await r.call('appeals', [key])).appellant, ZERO_ADDR);
  assert.equal(await r.call('owed', [addr('user')]), 2n * APPEAL_BOND);
  // A fourth: governance protects the key -> refunded.
  await flagIt();
  await r.send('user', 'appeal', [key, ...subject], APPEAL_BOND);
  const pr = await r.send('owner', 'setProtected', [[key], true]);
  assert.equal(pr.find((e) => e?.name === 'AppealClosed').args.outcome, 4n);
  assert.equal(await r.call('owed', [addr('user')]), 3n * APPEAL_BOND);
  assert.equal(await regBalance(r), 3n * APPEAL_BOND); // exactly what is owed: nothing stuck
  const before = await c.balance('user');
  await r.send('user', 'withdraw');
  assert.equal(await c.balance('user') - before, 3n * APPEAL_BOND);
  assert.equal(await regBalance(r), 0n);
});

test('vaccine.js (wallet and snap): the same keys as the registry, its evidence and response decoded, neutral reason texts', async () => {
  const v = await import('../src/vaccine.js');
  const a = '0x' + '5e'.repeat(20);
  const h = keccak256(lockboxCode);
  assert.equal(v.addressKey(97n, a), await reg.call('addressKey', [97n, a]));
  assert.equal(v.codeKey(h), await reg.call('codeKey', [h]));
  assert.equal(v.threatKey('code', 1n, a, lockboxCode), await reg.call('codeKey', [h]));
  assert.deepEqual(v.REASONS, ['none', 'cannot-sell-in-simulation', 'unlimited-mint', 'owner-can-block-transfers', 'owner-can-move-holder-funds',
    'same-name-as-known-token', 'sweeps-approved-tokens', 'other']);
  assert.equal(v.REASON_TEXT.length, Object.keys(R).length);
  // One source of truth: zetaphy-neuro's codes (threatLookup, signatures, the 7 languages) are the same list; so is neuromsg's threat-report.
  assert.deepEqual((await import('../../zetaphy-neuro/src/threat-reasons.js')).THREAT_REASONS, v.REASONS);
  assert.match(JSON.stringify((await import('../src/neuromsg.js')).KINDS['threat-report']), new RegExp(`enum:${v.REASONS.slice(1).join(',')}`));
  assert.equal(v.reasonText(R.SameNameAsKnownToken).en, 'uses the same name or symbol as a known token at a different address');
  for (const t of v.REASON_TEXT) assert.doesNotMatch(`${t.th} ${t.en}`, /scam|drainer|phishing|honeypot|fake|หลอกลวง|ปลอม|ดูดเงิน/i);
  // Decoding what the registry answers (the views' ABI encoding, with a control character a responder slipped in).
  const ev = reg.iface.encodeFunctionResult('evidenceOf', [REPORT, URI, addr('w1'), 9n]);
  assert.deepEqual(v.readEvidence(ev), { reportHash: REPORT, uri: URI, by: addr('w1').toLowerCase(), at: 9 });
  assert.equal(v.readEvidence(reg.iface.encodeFunctionResult('evidenceOf', [ZERO32, '', ZERO_ADDR, 0n])).reportHash, null);
  const rs = reg.iface.encodeFunctionResult('responseOf', ['ok‮\nreply', addr('user'), 3n, 56n, a]);
  assert.deepEqual(v.readResponse(rs), { text: 'ok reply', by: addr('user').toLowerCase(), at: 3, chainId: 56n, account: a });
  assert.deepEqual(v.detailQueries(FP), { evidence: '0x' + reg.iface.getFunction('evidenceOf').selector.slice(2) + FP.slice(2), response: '0x' + reg.iface.getFunction('responseOf').selector.slice(2) + FP.slice(2) });
});
