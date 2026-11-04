// ProofRegistry (docs/future/specs-and-proofs.md): the "Proven" level and the proof market. The outcomes
// come from the real proof runs committed in audit/spec/examples (BridgedToken: 3 of 3 proven;
// BuggyVault: the planted bugs refuted), so the contract and the spec tool are checked against each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, AbiCoder, ZeroAddress } from 'ethers';
import solc from 'solc';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { outcomeOf, runCommitment, submitCommitment, artifactsHash, cexCommitment, submissionOf, outcomeKey } from '../src/proofs.js';

const DAY = 86400;
const abi = AbiCoder.defaultAbiCoder();
const PARAMS = { commitWindow: DAY, revealWindow: DAY, minFee: ZETA, minAgreed: 1 };
const salt = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ex = (f) => JSON.parse(readFileSync(new URL(`../../audit/spec/examples/${f}`, import.meta.url), 'utf8'));
const TOKEN = ex('BridgedToken.proof.json');      // every property proven
const BUGGY = ex('BuggyVault.proof.json');        // counterexamples found
const CODE = '0x' + 'c0'.repeat(32);               // the proven code's EXTCODEHASH
const TARGET = '0x' + 'be'.repeat(20);

let kitCache = null;
function proofKit() {
  if (kitCache) return kitCache;
  const input = { language: 'Solidity', sources: {
    'ProofKit.sol': { content: readFileSync(new URL('./helpers/ProofKit.sol', import.meta.url), 'utf8') },
    'BuggyVault.sol': { content: readFileSync(new URL('../../audit/spec/fixtures/BuggyVault.sol', import.meta.url), 'utf8') },
  }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['ProofKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return kitCache;
}

async function world() {
  const c = await createChain(['gov', 'poster', 'prover', 'thief', 'x', 'r1', 'r2', 'r3', 'r4']);
  const A = (n) => c.acct[n].toString();
  const m = workMocks();
  const jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3', 'r4']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  await jobs.send('gov', 'set', [A('prover'), true, 5, 0]);
  const rep = await c.deploy('WorkerReputation', [A('gov'), jobs.address, ZeroAddress], 'gov');
  const kit = proofKit();
  const cert = await c.deployRaw(kit.MockCertificate, [], 'gov');
  const reg = await c.deploy('ProofRegistry', [jobs.address, rep.address, cert.address, A('gov'), PARAMS], 'gov');
  await rep.send('gov', 'setReporter', [reg.address, true]);
  return { c, A, jobs, rep, kit, cert, reg };
}

/** Commit, then (next block) submit the proof of `proof` for CODE. Returns the proof id. */
async function submit(w, proof, { who = 'prover', bountyId = 0n, fee = ZETA, codeHash = CODE } = {}) {
  const s = submissionOf(proof, { codeHash, recipe: 'ipfs://bafy-proof-bundle', bountyId });
  await w.reg.send(who, 'commitSubmission', [submitCommitment(s.codeHash, s.specHash, artifactsHash(s.artifacts), w.A(who), salt(7))]);
  await w.reg.send(who, 'submit', [s, salt(7)], fee);
  return w.reg.call('proofCount');
}

/** The runners commit, reveal and settle. outcomes: { runner: outcome } */
async function runners(w, id, outcomes) {
  for (const [r, o] of Object.entries(outcomes)) await w.reg.send(r, 'commit', [id, runCommitment(o, w.A(r), salt(9), id)]);
  w.c.advance(DAY);
  for (const [r, o] of Object.entries(outcomes)) await w.reg.send(r, 'reveal', [id, o, salt(9)]);
  if (Object.keys(outcomes).length < 3) w.c.advance(DAY);
  return w.reg.send('x', 'settle', [id]);
}

const proofOf = async (w, id) => w.reg.call('proof', [id]);

test('the committed proof runs: BridgedToken all proven, BuggyVault refuted (the spec tool output the registry consumes)', () => {
  assert.equal(TOKEN.summary.allProven, true);
  assert.equal(TOKEN.summary.proven, TOKEN.summary.properties);
  assert.equal(BUGGY.summary.allProven, false);
  assert.ok(BUGGY.summary.counterexamples >= 2, 'the planted bugs are found');
  const backing = BUGGY.properties.find((p) => p.id === 'backing-totalDeposits');
  assert.equal(backing.status, 'counterexample');
  assert.ok(backing.by.some((e) => e.tool === 'halmos' && e.replayed === true), 'the Halmos counterexample replays in forge');
});

test('a proof counts only when 2 of 3 runners reproduce "all proven"; the third is paid nothing', async () => {
  const w = await world();
  const id = await submit(w, TOKEN);
  const good = outcomeOf(TOKEN);
  const odd = { ...good, resultHash: keccak256('0x01') };
  await runners(w, id, { r1: good, r2: good, r3: odd });
  const p = await proofOf(w, id);
  assert.equal(p.state, 2n, 'accepted');
  assert.equal(p.resultHash, TOKEN.resultHash);
  assert.equal(p.artifactsHash, TOKEN.artifactsHash, 'the spec tool and the contract hash the artifacts the same way');
  assert.equal(artifactsHash(TOKEN.artifacts.map((a) => a.hash)), TOKEN.artifactsHash);
  assert.equal(await w.reg.call('isProven', [CODE]), true);
  assert.equal(await w.reg.call('isProvenSpec', [CODE, TOKEN.specHash]), true);
  assert.deepEqual([...(await w.reg.call('artifactsOf', [id]))], TOKEN.artifacts.map((a) => a.hash));
  assert.match(await w.reg.call('toolsOf', [id]), /halmos 0\.3\.3/);
  assert.equal(await w.reg.call('owed', [w.A('r1')]), ZETA / 2n);
  assert.equal(await w.reg.call('owed', [w.A('r2')]), ZETA / 2n);
  assert.equal(await w.reg.call('owed', [w.A('r3')]), 0n);
  const before = await w.c.balance('r1');
  await assert.rejects(w.reg.send('r1', 'withdraw', [w.A('x')]), /BadParams/, 'only to itself or its payout address');
  await w.reg.send('r1', 'withdraw', [w.A('r1')]);
  assert.equal(await w.c.balance('r1'), before + ZETA / 2n);
  await assert.rejects(w.reg.send('r1', 'withdraw', [w.A('r1')]), /Nothing/);
  await w.reg.send('r2', 'setPayout', [w.A('x')]);
  const xb = await w.c.balance('x');
  await w.reg.send('r2', 'withdraw', [w.A('x')]);
  assert.equal(await w.c.balance('x'), xb + ZETA / 2n, 'to the payout address it chose');
  assert.equal(await w.reg.call('owed', [w.A('r2')]), 0n);
});

test('"not installed", unknown and counterexamples are never "proven"; no agreement returns the fee', async () => {
  for (const o of [
    { ...outcomeOf(TOKEN), proven: TOKEN.summary.proven - 1, unknown: 1 },          // one tool not installed
    outcomeOf(BUGGY),                                                               // counterexamples
    { ...outcomeOf(TOKEN), proven: TOKEN.summary.proven - 1 },                       // a property missing
  ]) {
    const w = await world();
    const id = await submit(w, TOKEN);
    await runners(w, id, { r1: o, r2: o, r3: o });
    assert.equal((await proofOf(w, id)).state, 3n, 'rejected');
    assert.equal(await w.reg.call('isProven', [CODE]), false);
    assert.equal(await w.reg.call('owed', [w.A('r1')]), ZETA / 3n, 'runners who agreed are still paid for the work');
  }
  const w = await world();
  const id = await submit(w, TOKEN);
  const o = outcomeOf(TOKEN);
  await runners(w, id, { r1: o, r2: { ...o, resultHash: keccak256('0x02') }, r3: { ...o, resultHash: keccak256('0x03') } });
  assert.equal((await proofOf(w, id)).state, 3n, 'no 2 of 3: rejected');
  assert.equal(await w.reg.call('owed', [w.A('prover')]), ZETA, 'the fee goes back to the prover');
});

test('commit-reveal: no submission without an earlier commitment; runners cannot copy, the prover cannot run', async () => {
  const w = await world();
  const s = submissionOf(TOKEN, { codeHash: CODE, recipe: 'ipfs://x' });
  await assert.rejects(w.reg.send('prover', 'submit', [s, salt(7)], ZETA), /NoCommitment/);
  await w.reg.send('prover', 'commitSubmission', [submitCommitment(CODE, s.specHash, artifactsHash(s.artifacts), w.A('prover'), salt(7))]);
  await assert.rejects(w.reg.send('thief', 'submit', [s, salt(7)], ZETA), /NoCommitment/, 'the commitment binds the prover');
  await assert.rejects(w.reg.send('prover', 'submit', [s, salt(7)], ZETA - 1n), /BadSubmission/, 'the minimum fee');
  await assert.rejects(w.reg.send('prover', 'submit', [{ ...s, artifacts: [] }, salt(7)], ZETA), /BadSubmission/);
  await w.reg.send('prover', 'submit', [s, salt(7)], ZETA);
  await assert.rejects(w.reg.send('prover', 'submit', [s, salt(7)], ZETA), /NoCommitment/, 'a commitment is used once');
  const id = await w.reg.call('proofCount');
  await assert.rejects(w.reg.send('prover', 'commit', [id, salt(1)]), /NotRunner/, 'the prover is not a runner of its own proof');
  const o = outcomeOf(TOKEN);
  await w.reg.send('r1', 'commit', [id, runCommitment(o, w.A('r1'), salt(9), id)]);
  await assert.rejects(w.reg.send('r1', 'reveal', [id, o, salt(9)]), /TooEarly/, 'no reveal before the commit window ends');
  w.c.advance(DAY);
  await assert.rejects(w.reg.send('r2', 'commit', [id, runCommitment(o, w.A('r2'), salt(9), id)]), /Closed/);
  await assert.rejects(w.reg.send('r1', 'reveal', [id, o, salt(8)]), /BadReveal/);
  await assert.rejects(w.reg.send('r2', 'reveal', [id, o, salt(9)]), /AlreadyIn/, 'no reveal without a commitment');
  await assert.rejects(w.reg.send('x', 'settle', [id]), /TooEarly/);
  w.c.advance(DAY);
  await w.reg.send('x', 'settle', [id]);
  assert.equal((await proofOf(w, id)).state, 3n, 'one runner alone never makes a proof');
});

test('Proven is reported only on top of a valid Gold certificate whose code is proven (AuditCertificate untouched)', async () => {
  const w = await world();
  const chain = 77390n;
  await w.cert.send('gov', 'set', [chain, TARGET, CODE, 3, true]);
  assert.equal(await w.reg.call('levelOf', [chain, TARGET]), 3n, 'Gold, not proven yet');
  const id = await submit(w, TOKEN);
  const o = outcomeOf(TOKEN);
  await runners(w, id, { r1: o, r2: o, r3: o });
  assert.equal(await w.reg.call('levelOf', [chain, TARGET]), 4n, 'PROVEN');
  await w.cert.send('gov', 'set', [chain, TARGET, CODE, 2, true]);
  assert.equal(await w.reg.call('levelOf', [chain, TARGET]), 2n, 'a proof does not lift Silver');
  await w.cert.send('gov', 'set', [chain, TARGET, CODE, 3, false]);
  assert.equal(await w.reg.call('levelOf', [chain, TARGET]), 0n, 'expired / revoked / code changed: nothing');
  await w.cert.send('gov', 'set', [chain, TARGET, '0x' + 'c1'.repeat(32), 3, true]);
  assert.equal(await w.reg.call('levelOf', [chain, TARGET]), 3n, 'another code hash: its own proof needed');
});

test('proof market: a bounty is paid to the prover whose proof is accepted; one proof in flight at a time', async () => {
  const w = await world();
  const deadline = BigInt(w.c.now()) + 10n * BigInt(DAY);
  await w.reg.send('poster', 'postBounty', [CODE, TOKEN.specHash, TOKEN.summary.properties, deadline, ZeroAddress, 'ipfs://spec'], 5n * ZETA);
  const bid = await w.reg.call('bountyCount');
  await assert.rejects(submit(w, { ...TOKEN, specHash: keccak256('0x99') }, { bountyId: bid }), /BadSubmission/, 'another spec cannot claim it');
  const id = await submit(w, TOKEN, { bountyId: bid });
  assert.equal((await w.reg.call('bounty', [bid])).inFlight, id);
  await assert.rejects(submit(w, TOKEN, { who: 'thief', bountyId: bid }), /Busy/, 'a copy cannot queue behind it');
  await assert.rejects(w.reg.send('poster', 'reclaimBounty', [bid]), /TooEarly/);
  const o = outcomeOf(TOKEN);
  await runners(w, id, { r1: o, r2: o, r4: o });
  const b = await w.reg.call('bounty', [bid]);
  assert.equal(b.state, 2n);
  assert.equal(b.winner.toLowerCase(), w.A('prover').toLowerCase());
  assert.equal(await w.reg.call('owed', [w.A('prover')]), 5n * ZETA);
  w.c.advance(10 * DAY);
  await assert.rejects(w.reg.send('poster', 'reclaimBounty', [bid]), /Closed/, 'paid once');
});

test('proof market: a counterexample is accepted only by on-chain replay, refutes the spec for good, cannot be front-run', async () => {
  const w = await world();
  const backing = BUGGY.properties.findIndex((p) => p.id === 'backing-totalDeposits');
  const checker = await w.c.deployRaw(w.kit.BuggyVaultChecker, [BUGGY.specHash, backing], 'poster');
  await w.c.transfer('poster', checker.address, 10n * ZETA); // the replay deposits from this (and reverts it)
  const code = await checker.call('codeHash');
  // a proof of the same spec was accepted earlier (wrongly: say 2 runners colluded)
  const id = await submit(w, { ...TOKEN, specHash: BUGGY.specHash, summary: { ...TOKEN.summary, properties: BUGGY.summary.properties, proven: BUGGY.summary.properties } }, { codeHash: code });
  const fake = { resultHash: keccak256('0xfa'), proven: BUGGY.summary.properties, counterexamples: 0, unknown: 0 };
  await runners(w, id, { r1: fake, r2: fake, r3: fake });
  assert.equal(await w.reg.call('isProven', [code]), true);

  const deadline = BigInt(w.c.now()) + 10n * BigInt(DAY);
  await w.reg.send('poster', 'postBounty', [code, BUGGY.specHash, BUGGY.summary.properties, deadline, checker.address, 'ipfs://spec'], 3n * ZETA);
  const bid = await w.reg.call('bountyCount');
  // Halmos's trace: deposit, then emergencyWithdraw (PROOF.md), in the checker's encoding
  const cex = abi.encode(['uint8[]', 'uint256[]'], [[0, 2], [ZETA, 0]]);
  const harmless = abi.encode(['uint8[]', 'uint256[]'], [[0, 1], [ZETA, ZETA]]);
  await w.reg.send('prover', 'commitCounterexample', [cexCommitment(bid, backing, harmless, w.A('prover'), salt(3))]);
  await assert.rejects(w.reg.send('prover', 'claimByCounterexample', [bid, backing, harmless, salt(3)]), /NotViolated/, 'deposit + withdraw keeps the backing');
  await w.reg.send('prover', 'commitCounterexample', [cexCommitment(bid, backing, cex, w.A('prover'), salt(4))]);
  await assert.rejects(w.reg.send('thief', 'claimByCounterexample', [bid, backing, cex, salt(4)]), /NoCommitment/, 'a copied reveal is worthless');
  await assert.rejects(w.reg.send('prover', 'claimByCounterexample', [bid, 0, cex, salt(4)]), /NoCommitment/, 'bound to the property');
  const bal = await w.c.balance(Address.fromString(checker.address));
  await w.reg.send('prover', 'claimByCounterexample', [bid, backing, cex, salt(4)]);
  assert.equal(await w.c.balance(Address.fromString(checker.address)), bal, 'the replay kept nothing');
  assert.equal(await w.reg.call('refuted', [code, BUGGY.specHash]), true);
  assert.equal(await w.reg.call('isProven', [code]), false, 'a replayed counterexample beats any proof');
  assert.equal(await w.reg.call('owed', [w.A('prover')]), 3n * ZETA);
  await assert.rejects(w.reg.send('prover', 'claimByCounterexample', [bid, backing, cex, salt(4)]), /Closed/);
  // and no later proof of the refuted spec counts
  const id2 = await submit(w, { ...TOKEN, specHash: BUGGY.specHash, summary: { ...TOKEN.summary, properties: BUGGY.summary.properties } }, { codeHash: code, who: 'x' });
  await runners(w, id2, { r1: fake, r2: fake, r3: fake });
  assert.equal((await proofOf(w, id2)).state, 3n);
});

test('proof market: a lying checker pays nothing, a re-entering one pays once; reclaim after the deadline', async () => {
  const w = await world();
  const liar = await w.c.deployRaw(w.kit.LyingChecker, [], 'poster');
  const evil = await w.c.deployRaw(w.kit.ReentrantChecker, [], 'thief');
  const deadline = BigInt(w.c.now()) + 3n * BigInt(DAY);
  await w.reg.send('poster', 'postBounty', [CODE, TOKEN.specHash, 3, deadline, liar.address, ''], ZETA);
  await w.reg.send('poster', 'postBounty', [CODE, TOKEN.specHash, 3, deadline, evil.address, ''], 2n * ZETA);
  await evil.send('thief', 'arm', [w.reg.address, 2n]);
  const cex = '0x1234';
  for (const [bid, who] of [[1n, 'x'], [2n, 'thief']]) await w.reg.send(who, 'commitCounterexample', [cexCommitment(bid, 0, cex, w.A(who), salt(5))]);
  await assert.rejects(w.reg.send('x', 'claimByCounterexample', [1n, 0, cex, salt(5)]), /NotViolated/);
  assert.equal((await w.reg.call('bounty', [1n])).state, 1n, 'still open');
  await w.reg.send('thief', 'claimByCounterexample', [2n, 0, cex, salt(5)]);
  assert.equal(await evil.call('reentered'), false, 'the bounty was closed before the replay ran');
  assert.equal(await w.reg.call('owed', [w.A('thief')]), 2n * ZETA, 'paid once');
  await assert.rejects(w.reg.send('poster', 'postBounty', [CODE, TOKEN.specHash, 3, BigInt(w.c.now()) + 3600n, ZeroAddress, ''], ZETA), /BadParams/, 'too short to verify a proof');
  await assert.rejects(w.reg.send('poster', 'postBounty', [CODE, TOKEN.specHash, 3, deadline, w.A('x'), ''], ZETA), /BadParams/, 'a checker must be code');
  await assert.rejects(w.reg.send('poster', 'reclaimBounty', [1n]), /TooEarly/);
  w.c.advance(3 * DAY);
  await assert.rejects(w.reg.send('x', 'reclaimBounty', [1n]), /NotGovernance/, 'only the poster');
  await w.reg.send('poster', 'reclaimBounty', [1n]);
  assert.equal(await w.reg.call('owed', [w.A('poster')]), ZETA);
  await assert.rejects(w.reg.send('x', 'commitCounterexample', [cexCommitment(1n, 0, cex, w.A('x'), salt(6))]).then(() => w.reg.send('x', 'claimByCounterexample', [1n, 0, cex, salt(6)])), /Closed/);
});

test('governance is the timelock and its parameters are bounded', async () => {
  const w = await world();
  await assert.rejects(w.reg.send('x', 'setParams', [PARAMS]), /NotGovernance/);
  for (const bad of [{ ...PARAMS, commitWindow: 60 }, { ...PARAMS, revealWindow: 8 * DAY }, { ...PARAMS, minFee: 1001n * ZETA }, { ...PARAMS, minAgreed: 10_001 }]) {
    await assert.rejects(w.reg.send('gov', 'setParams', [bad]), /BadParams/);
  }
  await w.reg.send('gov', 'setParams', [{ ...PARAMS, minFee: 0n }]);
  await assert.rejects(w.reg.send('gov', 'setGovernance', [ZeroAddress]), /BadParams/);
  await w.reg.send('gov', 'setGovernance', [w.A('x')]);
  await assert.rejects(w.reg.send('gov', 'setParams', [PARAMS]), /NotGovernance/);
  assert.equal(outcomeKey(outcomeOf(TOKEN)).length, 66);
});
