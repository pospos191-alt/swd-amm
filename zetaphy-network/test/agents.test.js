// AgentRegistry (AI agent identity and liability): registration with an ML-DSA-44 key, a bond and a
// constitution; actions recorded with (modelHash, promptHash) provenance and signed with real ML-DSA-44
// (the JS precompile at 0x…0900); claims by a deterministic checker or by the claims committee.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, id as textHash, ZeroHash, ZeroAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';

const abi = AbiCoder.defaultAbiCoder();
const DAY = 86_400;
const MODEL = textHash('anthropic/claude-sonnet-5-5');
const OTHER_MODEL = textHash('some/unlisted-model');

let c, reg, checker, key, A;
const addr = (n) => c.acct[n].toString();
// principal = alice; the agent may pay only the DEX router, at most 5 ZETAPHY per action, with MODEL only
const constitution = () => abi.encode(['address', 'uint256', 'address[]', 'bytes32[]'], [addr('alice'), 5n * ZETA, [addr('router')], [MODEL]]);

beforeEach(async () => {
  c = await createChain(['gov', 'operator', 'agentAcct', 'alice', 'router', 'thief', 'relay', 'm1', 'm2', 'm3', 'claimant'], {}, { precompiles: PRECOMPILES });
  reg = await c.deploy('AgentRegistry', [addr('gov'), 10n * ZETA, 1n * ZETA], 'gov');
  checker = await c.deploy('ConstitutionChecker', [], 'gov');
  await reg.send('gov', 'setChecker', [checker.address, true]);
  key = mldsaKey();
  await reg.send('operator', 'register', [addr('agentAcct'), key.keyHash, keccak256(constitution()), checker.address], 20n * ZETA);
  A = 1n;
});

/** Records an action for agent `id`, signed by `k` (relayed by 'relay'); returns the action id. */
async function act(target, value, { model = MODEL, prompt = textHash('pay the router'), k = key, id = A, sig } = {}) {
  const input = [target, value, keccak256('0x1234'), model, prompt];
  const d = await reg.call('actionDigest', [id, input]);
  const ev = await reg.send('relay', 'recordAction', [id, input, k.publicKey, sig ?? k.sign(d)]);
  return ev.find((e) => e?.name === 'ActionRecorded').args.actionId;
}

test('register: bond at least minBond, one agent per account, active, found by its account', async () => {
  await assert.rejects(reg.send('operator', 'register', [addr('thief'), key.keyHash, ZeroHash, checker.address], 9n * ZETA), /BondTooLow/);
  await assert.rejects(reg.send('operator', 'register', [addr('agentAcct'), key.keyHash, ZeroHash, checker.address], 10n * ZETA), /AccountTaken/);
  const a = await reg.call('agents', [A]);
  assert.equal(a.operator, addr('operator'));
  assert.equal(a.pqKeyHash, key.keyHash);
  assert.equal(a.bond, 20n * ZETA);
  assert.equal(await reg.call('isActive', [A]), true);
  assert.equal(await reg.call('activeAgentOf', [addr('agentAcct')]), A);
  assert.equal(await reg.call('activeAgentOf', [addr('alice')]), 0n);
});

test('actions: real ML-DSA-44 signatures, provenance stored, no replay, wrong key refused', async () => {
  const id = await act(addr('router'), 2n * ZETA);
  const r = await reg.call('actions', [id]);
  assert.equal(r.modelHash, MODEL);
  assert.equal(r.promptHash, textHash('pay the router'));
  assert.equal(r.constitution, keccak256(constitution()));
  // the same signature again: the sequence moved on, so it no longer verifies
  const input = [addr('router'), 2n * ZETA, keccak256('0x1234'), MODEL, textHash('pay the router')];
  const d0 = keccak256(abi.encode(['string', 'uint256', 'address', 'uint256', 'uint64', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    ['ZETAPHY AgentAction', 1n, reg.address, A, 0n, ...input]));
  await assert.rejects(reg.send('relay', 'recordAction', [A, input, key.publicKey, key.sign(d0)]), /BadPq/);
  const other = mldsaKey();
  await assert.rejects(act(addr('router'), 1n, { k: other }), /WrongKey/);
  await assert.rejects(act(addr('router'), 1n, { sig: other.sign(ZeroHash) }), /BadPq/);
  await assert.rejects(act(addr('router'), 1n, { id: 9n }), /NoAgent/);
});

test('checker claim: a payment to a target outside the constitution slashes the bond to the principal', async () => {
  const id = await act(addr('thief'), 3n * ZETA);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [id, abi.encode(['uint256'], [1n]), '0x']), /BadConstitution/);
  const before = await c.balance('alice');
  await reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']);
  assert.equal(await c.balance('alice') - before, 3n * ZETA);
  assert.equal((await reg.call('agents', [A])).bond, 17n * ZETA);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']), /AlreadySlashed/);
});

test('checker claim: over the cap pays the excess; an unlisted model pays all; a lawful action is not slashable', async () => {
  const over = await act(addr('router'), 8n * ZETA);
  const before = await c.balance('alice');
  await reg.send('claimant', 'claimByChecker', [over, constitution(), '0x']);
  assert.equal(await c.balance('alice') - before, 3n * ZETA);
  const badModel = await act(addr('router'), 2n * ZETA, { model: OTHER_MODEL });
  await reg.send('claimant', 'claimByChecker', [badModel, constitution(), '0x']);
  assert.equal(await c.balance('alice') - before, 5n * ZETA);
  const fine = await act(addr('router'), 5n * ZETA);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [fine, constitution(), '0x']), /NotViolated/);
});

test('slashing below minBond makes the agent inactive until topped up; payouts never exceed the bond', async () => {
  const big = await act(addr('thief'), 50n * ZETA); // claims more than the bond holds
  const before = await c.balance('alice');
  await reg.send('claimant', 'claimByChecker', [big, constitution(), '0x']);
  assert.equal(await c.balance('alice') - before, 20n * ZETA);
  assert.equal(await reg.call('isActive', [A]), false);
  assert.equal(await reg.call('activeAgentOf', [addr('agentAcct')]), 0n);
  await assert.rejects(act(addr('router'), 1n), /Inactive/);
  await reg.send('operator', 'addBond', [A], 10n * ZETA);
  assert.equal(await reg.call('isActive', [A]), true);
  await act(addr('router'), 1n);
});

test('past actions keep the constitution they were recorded under', async () => {
  const id = await act(addr('thief'), 1n * ZETA);
  await reg.send('operator', 'update', [A, key.keyHash, keccak256('0xbeef'), checker.address]);
  await reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']); // old document still proves it
  await assert.rejects(reg.send('thief', 'update', [A, key.keyHash, ZeroHash, checker.address]), /NotOperator/);
});

test('committee claim: governance sets the committee; threshold yes pays the claimant and returns the deposit', async () => {
  await assert.rejects(reg.send('thief', 'setCommittee', [[addr('m1')], 1n]), /NotGovernance/);
  await assert.rejects(reg.send('gov', 'setCommittee', [[addr('m1'), addr('m1')], 1n]), /BadCommittee/);
  await reg.send('gov', 'setCommittee', [[addr('m1'), addr('m2'), addr('m3')], 2n]);
  const id = await act(addr('router'), 1n * ZETA); // lawful by the checker, but harmed someone off chain
  await assert.rejects(reg.send('claimant', 'fileClaim', [id, 4n * ZETA, textHash('evidence')], 2n * ZETA), /BadDeposit/);
  await reg.send('claimant', 'fileClaim', [id, 4n * ZETA, textHash('evidence')], 1n * ZETA);
  await assert.rejects(reg.send('thief', 'vote', [1n, true]), /NotCommittee/);
  await reg.send('m1', 'vote', [1n, true]);
  await assert.rejects(reg.send('m1', 'vote', [1n, true]), /AlreadyVoted/);
  // an open claim blocks the bond's withdrawal
  await reg.send('operator', 'requestUnbond', [A]);
  c.advance(31 * DAY); // past the action's claim window too (AR-1)
  await assert.rejects(reg.send('operator', 'withdrawBond', [A]), /OpenClaims/);
  c.advance(-31 * DAY);
  const before = await c.balance('claimant');
  await reg.send('m2', 'vote', [1n, true]);
  assert.equal(await c.balance('claimant') - before, 5n * ZETA); // 4 claimed + 1 deposit back
  assert.equal((await reg.call('claims', [1n])).state, 2n); // Upheld
  await assert.rejects(reg.send('m3', 'vote', [1n, false]), /ClaimNotOpen/);
});

test('committee claim: threshold no, or no decision in time, rejects it and the deposit goes to the operator', async () => {
  await reg.send('gov', 'setCommittee', [[addr('m1'), addr('m2'), addr('m3')], 2n]);
  const id = await act(addr('router'), 1n);
  await reg.send('claimant', 'fileClaim', [id, 4n * ZETA, ZeroHash], 1n * ZETA);
  const op = await c.balance('operator');
  await reg.send('m1', 'vote', [1n, false]);
  await reg.send('m2', 'vote', [1n, false]);
  assert.equal(await c.balance('operator') - op, 1n * ZETA);
  assert.equal((await reg.call('agents', [A])).bond, 20n * ZETA);

  await reg.send('claimant', 'fileClaim', [id, 4n * ZETA, ZeroHash], 1n * ZETA);
  await assert.rejects(reg.send('relay', 'expireClaim', [2n]), /NotYet/);
  c.advance(7 * DAY + 1);
  await assert.rejects(reg.send('m1', 'vote', [2n, true]), /ClaimNotOpen/);
  await reg.send('relay', 'expireClaim', [2n]);
  assert.equal((await reg.call('claims', [2n])).state, 3n); // Rejected
});

test('unbond: no new actions, bond back only after the delay and the last action\'s claim window; claims only within it', async () => {
  const id = await act(addr('thief'), 1n);
  await reg.send('operator', 'requestUnbond', [A]);
  await assert.rejects(act(addr('router'), 1n), /Inactive/);
  await assert.rejects(reg.send('operator', 'withdrawBond', [A]), /NotYet/);
  c.advance(7 * DAY);
  // AR-1: the bond stays for the whole 30-day claim window of the last action
  await assert.rejects(reg.send('operator', 'withdrawBond', [A]), /NotYet/);
  c.advance(23 * DAY + 1);
  const before = await c.balance('operator');
  await reg.send('operator', 'withdrawBond', [A]);
  assert.equal(await c.balance('operator') - before, 20n * ZETA);
  assert.equal(await reg.call('agentOfAccount', [addr('agentAcct')]), 0n);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']), /ClaimWindowOver/, 'the bond left only after the window');

  // a fresh agent: an action older than the claim window cannot be claimed
  const k2 = mldsaKey();
  await reg.send('operator', 'register', [addr('agentAcct'), k2.keyHash, keccak256(constitution()), checker.address], 10n * ZETA);
  const old = await act(addr('thief'), 1n, { id: 2n, k: k2 });
  c.advance(30 * DAY + 1);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [old, constitution(), '0x']), /ClaimWindowOver/);
});

test('AR-2: only checkers governance approved; revoking one stops its payouts, the committee path stays', async () => {
  const rogue = await c.deploy('ConstitutionChecker', [], 'operator'); // e.g. one that names the operator as victim
  await assert.rejects(reg.send('operator', 'update', [A, key.keyHash, keccak256(constitution()), rogue.address]), /CheckerNotApproved/);
  const k2 = mldsaKey();
  await assert.rejects(reg.send('operator', 'register', [addr('thief'), k2.keyHash, ZeroHash, rogue.address], 10n * ZETA), /CheckerNotApproved/);
  await reg.send('operator', 'register', [addr('thief'), k2.keyHash, ZeroHash, ZeroAddress], 10n * ZETA); // no checker is fine
  await assert.rejects(reg.send('operator', 'setChecker', [rogue.address, true]), /NotGovernance/);
  await assert.rejects(reg.send('gov', 'setChecker', [ZeroAddress, true]), /NoChecker/);

  const id = await act(addr('thief'), 1n * ZETA); // breaks the constitution
  await reg.send('gov', 'setChecker', [checker.address, false]);
  assert.equal(await reg.call('approvedChecker', [checker.address]), false);
  await assert.rejects(reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']), /CheckerNotApproved/);
  await assert.rejects(reg.send('operator', 'update', [A, key.keyHash, keccak256(constitution()), checker.address]), /CheckerNotApproved/);
  await reg.send('gov', 'setChecker', [checker.address, true]);
  await reg.send('claimant', 'claimByChecker', [id, constitution(), '0x']);
});
