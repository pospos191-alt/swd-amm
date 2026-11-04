// Cross-chain vaccines from confirmed exploits (docs/future/immune-score.md, SS5): ImmuneVaccines derives a vaccine
// from an AuditNetwork finding judged valid high/critical, a revoked certificate or an approved HackInsurance claim;
// contracts on ZETAPHY with the same code are HELD pending review in ThreatRegistry and their owners notified; the
// vaccine reaches every other chain through the existing immune path (NeuroJobs agreement -> ImmuneRegistry ->
// ImmuneBroadcaster -> ImmuneMirror), where a sentinel catches a clone with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, AbiCoder, ZeroAddress, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { auditWorld, fullRound, lateFinding, kit, DAY } from './helpers/auditworld.js';
import { patternOf, strengthOf, readVaccine, findMatches, confirmedReport, MATCH } from '../src/immune/confirmed.js';
import { matchVaccine, codeHashOf } from '../src/immune/vaccines.js';
import { cloneVerdict, confirmedVerdict } from '../src/immune/detectors.js';
import { runnerVote, findingTuple, keysOf, codeKey } from '../src/immune/agree.js';
import { BASELINE } from '../../zetaphy-neuro/src/threat-signatures.generated.js';
import { setupNetwork, agree, attest, broadcast, chainSend, IDS } from './helpers/immunesim.js';

const abi = AbiCoder.defaultAbiCoder();
const V = () => kit('VaccineKit.sol');
const addrKey = (chainId, a) => keccak256(abi.encode(['string', 'uint256', 'address'], ['zetaphy.threat.address', BigInt(chainId), a]));
/** The same runtime with another CBOR metadata hash: the "same code" recompiled elsewhere. */
const otherMetadata = (code) => code.slice(0, -20) + (code.slice(-20, -4) === 'ff'.repeat(8) ? 'ee' : 'ff').repeat(8) + code.slice(-4);

async function setup() {
  const w = await auditWorld({ extra: ['holder', 'lp', 'w1', 'w2', 'deployer', 'other', 'guardian', 'appellant'] });
  const { c, A } = w;
  const threats = await c.deploy('ThreatRegistry', [w.jobs.address, 2, 1, A('gov'), 3600], 'gov');
  for (const r of ['w1', 'w2']) await w.jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const ins = await c.deploy('HackInsurance', [w.jobs.address, 2, 1, A('gov')], 'gov');
  const vac = await c.deploy('ImmuneVaccines', [w.net.address, w.cert.address, ins.address, threats.address, A('gov')], 'gov');
  await threats.send('gov', 'setVaccines', [vac.address]);
  await threats.send('gov', 'setGuardian', [A('guardian'), true]);
  const leaky = await c.deployRaw(V().LeakyVault, [], 'deployer');
  return { ...w, threats, ins, vac, leaky };
}

/** A contest with a valid high finding against LeakyVault: the exploit confirmed by the judges. */
async function confirmedByAudit(s) {
  const codeHash = codeHashOf(await s.c.getCode(s.leaky.address));
  const r = await fullRound(s, { target: s.leaky.address, codeHash, findings: [{ who: 'a1', sev: 4, text: 'withdrawAll re-enters' }], decide: [{ valid: true, sev: 4 }], settle: false });
  return { ...r, codeHash };
}

test('vaccine from a valid high audit finding: the pattern is derived on chain, exactly as Neuro\'s scanner and the JS side see it', async () => {
  const s = await setup();
  const { fids, codeHash } = await confirmedByAudit(s);
  const id = await s.vac.call('idOf', [1n, s.leaky.address, codeHash]);
  const ev = await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  assert.ok(ev.some((e) => e?.name === 'VaccinePublished' && e.args.id === id));
  const code = await s.c.getCode(s.leaky.address);
  const rec = await readVaccine(chainSend(s.c), s.vac.address, id);
  const js = patternOf(code);
  assert.equal(rec.codeHash, codeHash);
  assert.equal(rec.bodyHash, js.bodyHash);
  assert.deepEqual(rec.selectors, js.selectors, 'on-chain selectors = vaccines.js signatureOf(code).selectors');
  assert.ok(rec.selectors.length >= 5, `distinctive selectors: ${rec.selectors}`);
  assert.ok(!rec.selectors.includes('0x8da5cb5b'), 'owner() is baseline, never distinctive');
  assert.deepEqual([rec.active, rec.severity, rec.sources, rec.chainId], [true, 3, 2, 1]);
  const [patBody, patSel] = await s.vac.call('patternOf', [code]);
  assert.equal(patBody, js.bodyHash);
  assert.deepEqual([...patSel].map((x) => x.toLowerCase()), js.selectors);
  // the same confirmation twice changes nothing; a finding that is not a valid high/critical confirms nothing
  await assert.rejects(s.vac.send('x', 'vaccinateFromFinding', [fids[0]]), /NoChange/);
  await assert.rejects(s.vac.send('x', 'vaccinateFromFinding', [999n]), /NotConfirmed/);
  const [n] = await s.vac.call('exploitsOf', [1n, s.leaky.address]);
  assert.equal(n, 1n, 'exploit history: one confirmed vulnerable code at this address');
});

test('the on-chain baseline is Neuro\'s honest-ERC-20 baseline (zetaphy-neuro threat-signatures.generated.js)', async () => {
  const s = await setup();
  // a contract dispatching exactly the baseline selectors has no distinctive selector
  const sels = BASELINE.selectors;
  let body = '';
  for (const x of sels) body += '80' + '63' + x + '14';
  const [, out] = await s.vac.call('patternOf', ['0x' + body + '00']);
  assert.deepEqual([...out], [], 'every baseline selector is filtered');
  const [, mine] = await s.vac.call('patternOf', ['0x8063deadbeef1400']);
  assert.deepEqual([...mine], ['0xdeadbeef']);
});

test('matching on ZETAPHY: exact and body copies are HELD pending review (never flagged), a look-alike is a suspect, honest code never matches; owners are notified', async () => {
  const s = await setup();
  const { fids } = await confirmedByAudit(s);
  await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  const [id] = [await s.vac.call('ids', [0n])];
  const exact = await s.c.deployRaw(V().LeakyVault, [], 'other');
  const bodyAddr = '0x' + 'b0'.repeat(20);
  await s.c.putCode(bodyAddr, otherMetadata(await s.c.getCode(s.leaky.address)));
  const fixed = await s.c.deployRaw(V().LeakyVaultFixed, [], 'other');
  const plain = await s.c.deployRaw(V().PlainVault, [], 'other');
  // the scanner (JS) finds them first, with the contract's own rule
  const rec = await readVaccine(chainSend(s.c), s.vac.address, id);
  const found = await findMatches(chainSend(s.c), rec, [plain.address, fixed.address, bodyAddr, exact.address]);
  assert.deepEqual(found.map((f) => [f.address, f.strength]), [[exact.address.toLowerCase(), MATCH.exact], [bodyAddr, MATCH.body], [fixed.address.toLowerCase(), MATCH.selectors]]);
  for (const a of [exact.address, bodyAddr, fixed.address, plain.address]) assert.equal(Number(await s.vac.call('strengthOf', [id, await s.c.getCode(a)])), strengthOf(rec, await s.c.getCode(a)), a);
  // on chain
  const ev = await s.vac.send('x', 'checkMatch', [id, exact.address]);
  const note = ev.find((e) => e?.name === 'OwnerNotified');
  assert.equal(note.args.owner, s.A('other'), 'the owner() of the copy is notified');
  assert.equal(Number(note.args.strength), MATCH.exact);
  const held = ev.find((e) => e?.name === 'Matched');
  assert.equal(held.args.held, true);
  assert.deepEqual([...await s.threats.call('isContractHeld', [exact.address])], [true, 7n], 'held (Reason.Other)');
  assert.equal((await s.threats.call('isContractFlagged', [exact.address]))[0], false, 'never a flag');
  s.c.advance(2 * 3600);
  assert.equal((await s.threats.call('isContractEnforced', [exact.address]))[0], false, 'never enforced');
  await s.vac.send('x', 'checkMatch', [id, bodyAddr]);
  assert.equal((await s.threats.call('isContractHeld', [bodyAddr]))[0], true);
  await s.vac.send('x', 'checkMatch', [id, fixed.address]);
  assert.equal((await s.threats.call('isContractHeld', [fixed.address]))[0], false, 'a suspect (selectors only) is not held');
  const m = await s.vac.call('matchOf', [fixed.address]);
  assert.deepEqual([Number(m.strength), m.held, m.active], [MATCH.selectors, false, true]);
  await assert.rejects(s.vac.send('x', 'checkMatch', [id, plain.address]), /NoMatch/);
  await assert.rejects(s.vac.send('x', 'checkMatch', [id, exact.address]), /NoChange/, 'a standing match is not re-sent');
  assert.equal((await s.vac.call('matchedOf', [id])).length, 3);
  // the original vulnerable contract is held too
  await s.vac.send('x', 'checkMatch', [id, s.leaky.address]);
  assert.equal((await s.threats.call('isContractHeld', [s.leaky.address]))[0], true);
});

test('holds are bounded: the review window ends them, they are put once per vaccine, guardians release them, protected keys are never held, and only ImmuneVaccines may hold', async () => {
  const s = await setup();
  const { fids } = await confirmedByAudit(s);
  await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  const id = await s.vac.call('ids', [0n]);
  const a = await s.c.deployRaw(V().LeakyVault, [], 'other');
  const b = await s.c.deployRaw(V().LeakyVault, [], 'other');
  const p = await s.c.deployRaw(V().LeakyVault, [], 'other');
  await assert.rejects(s.threats.send('x', 'holdForReview', [addrKey(1, a.address), id, 3600]), /NotVaccines/);
  await assert.rejects(s.vac.send('x', 'setReviewWindow', [3 * DAY]), /NotGovernance/);
  await assert.rejects(s.vac.send('gov', 'setReviewWindow', [15 * DAY]), /BadParams/);
  await assert.rejects(s.vac.send('gov', 'setReviewWindow', [3600]), /BadParams/);
  await s.vac.send('gov', 'setReviewWindow', [2 * DAY]);
  await s.vac.send('x', 'checkMatch', [id, a.address]);
  const [, , until] = await s.threats.call('underReview', [addrKey(1, a.address)]);
  assert.equal(until, s.c.now() + BigInt(2 * DAY));
  s.c.advance(2 * DAY);
  assert.equal((await s.threats.call('isContractHeld', [a.address]))[0], false, 'the window ended it');
  await assert.rejects(s.vac.send('x', 'checkMatch', [id, a.address]), /NoChange/, 'not renewed by anyone');
  // a guardian (or governance) reviewed it: released
  await s.vac.send('x', 'checkMatch', [id, b.address]);
  await assert.rejects(s.threats.send('x', 'releaseReview', [addrKey(1, b.address)]), /NotGuardian/);
  await s.threats.send('guardian', 'releaseReview', [addrKey(1, b.address)]);
  assert.equal((await s.threats.call('isContractHeld', [b.address]))[0], false);
  // governance protected p: matched and notified, never held
  await s.threats.send('gov', 'setProtected', [[addrKey(1, p.address)], true]);
  const ev = await s.vac.send('x', 'checkMatch', [id, p.address]);
  assert.ok(ev.some((e) => e?.name === 'OwnerNotified'));
  assert.equal((await s.threats.call('isContractHeld', [p.address]))[0], false);
  assert.equal((await s.vac.call('matchOf', [p.address])).held, false);
});

test('an appeal that overturns the finding retires the vaccine and its holds are released; an appeal alone changes nothing', async () => {
  const s = await setup();
  const { fids } = await confirmedByAudit(s);
  await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  const id = await s.vac.call('ids', [0n]);
  const copy = await s.c.deployRaw(V().LeakyVault, [], 'other');
  await s.vac.send('x', 'checkMatch', [id, copy.address]);
  await s.jud.send('appellant', 'appeal', [fids[0]], 5n * ZETA);
  await assert.rejects(s.vac.send('x', 'retire', [id]), /NoChange/, 'an open appeal does not lift anything');
  await assert.rejects(s.vac.send('x', 'release', [copy.address]), /NoChange/, 'not while the vaccine is active');
  await s.jud.send('gov', 'resolveAppeal', [fids[0], false, 0, fids[0]]);
  await s.vac.send('x', 'retire', [id]);
  const rec = await readVaccine(chainSend(s.c), s.vac.address, id);
  assert.deepEqual([rec.active, rec.sources], [false, 0]);
  assert.equal((await s.vac.call('exploitsOf', [1n, s.leaky.address]))[0], 0n, 'no longer counted as an exploit');
  assert.equal((await s.threats.call('isContractHeld', [copy.address]))[0], true, 'until released');
  await s.vac.send('x', 'release', [copy.address]);
  assert.equal((await s.threats.call('isContractHeld', [copy.address]))[0], false);
  await assert.rejects(s.vac.send('x', 'checkMatch', [id, copy.address]), /Inactive/);
});

test('vaccine from a revoked certificate and from an approved insurance claim; cross-chain code gets its pattern from the code itself', async () => {
  const s = await setup();
  // a certified contract, then a valid post-certificate critical revokes it
  const target = await s.c.deployRaw(V().LeakyVault, [], 'deployer');
  const ch = codeHashOf(await s.c.getCode(target.address));
  const { id: req } = await fullRound(s, { target: target.address, codeHash: ch });
  await s.cert.send('x', 'certify', [req]);
  await assert.rejects(s.vac.send('x', 'vaccinateFromRevocation', [1n, target.address]), /NotConfirmed/, 'a valid certificate confirms nothing');
  const fid = await lateFinding(s, req, { sev: 5 });
  await s.vac.send('x', 'vaccinateFromRevocation', [1n, target.address]);
  await s.vac.send('x', 'vaccinateFromFinding', [fid]); // the same code: the same vaccine, one more confirmation
  const vid = await s.vac.call('idOf', [1n, target.address, ch]);
  const rec = await readVaccine(chainSend(s.c), s.vac.address, vid);
  assert.deepEqual([rec.sources, rec.severity, Number(await s.vac.call('count'))], [(1 << 1) | (1 << 2), 4, 1]);
  await assert.rejects(s.vac.send('x', 'retire', [vid]), /NoChange/, 'revocation is final');

  // insurance: a claim approved by the runners' quorum on a covered contract
  const victim = await s.c.deployRaw(V().LeakyVault, [], 'deployer');
  const tkey = await s.ins.call('targetKey', [1n, victim.address]);
  await s.ins.send('lp', 'deposit', [], 1000n * ZETA);
  await s.ins.send('gov', 'setTarget', [tkey, true, 300n * ZETA]);
  const prem = await s.ins.call('premiumOf', [100n * ZETA, 30 * DAY]);
  await s.ins.send('holder', 'buyCover', [tkey, 100n * ZETA, 30 * DAY], prem);
  s.c.mine(5);
  const from = s.c.blockNumber() - 4n;
  const REPORT = '0x' + 'f0'.repeat(32);
  await s.ins.send('holder', 'fileClaim', [0n, ['0x' + 'a1'.repeat(32)], from, from + 2n, REPORT, 50n * ZETA, 'replay'], ZETA);
  await assert.rejects(s.vac.send('x', 'vaccinateFromClaim', [0n, victim.address]), /NotConfirmed/, 'voting is not approved');
  for (const r of ['w1', 'w2']) await s.ins.send(r, 'vote', [0n, true, REPORT, 50n * ZETA]);
  await assert.rejects(s.vac.send('x', 'vaccinateFromClaim', [0n, target.address]), /NotConfirmed/, 'another contract than the cover\'s');
  await s.vac.send('x', 'vaccinateFromClaim', [0n, victim.address]);
  const iid = await s.vac.call('idOf', [1n, victim.address, codeHashOf(await s.c.getCode(victim.address))]);
  assert.equal((await readVaccine(chainSend(s.c), s.vac.address, iid)).sources, 1 << 3);

  // a contract on another chain (5): audited there, a valid critical; the pattern comes from its code (checked)
  const remote = '0x' + 'cd'.repeat(20);
  const remoteCode = V().LeakyVault.runtime;
  const { fids } = await fullRound(s, { target: remote, codeHash: codeHashOf(remoteCode), chainId: 5n, findings: [{ who: 'a2', sev: 5, text: 'sweep has no check' }], decide: [{ valid: true, sev: 5 }], settle: false });
  await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  const rid = await s.vac.call('idOf', [5n, remote, codeHashOf(remoteCode)]);
  assert.equal((await readVaccine(chainSend(s.c), s.vac.address, rid)).bodyHash, '0x' + '00'.repeat(32), 'not derived yet: the code is not here');
  await assert.rejects(s.vac.send('x', 'derivePattern', [rid, V().PlainVault.runtime]), /BadCode/);
  await s.vac.send('x', 'derivePattern', [rid, remoteCode]);
  assert.deepEqual((await readVaccine(chainSend(s.c), s.vac.address, rid)).selectors, patternOf(remoteCode).selectors);
  await assert.rejects(s.vac.send('x', 'derivePattern', [rid, remoteCode]), /NoChange/);
  assert.equal((await s.vac.call('exploitsOf', [5n, remote]))[0], 1n);
});

test('cross-chain: the confirmed exploit becomes an agreed ImmuneRegistry flag with its vaccine, mirrored to B and C; a modified clone on C is caught with it', async () => {
  const net = await setupNetwork();
  const Z = net.Z;
  const A = (n) => Z.acct[n].toString();
  // on ZETAPHY: insurance (runner quorum) confirms the exploit of a covered contract
  const m = workMocks();
  const runners = await Z.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r0', 'r1']) await runners.send('gov', 'set', [A(r), true, 5, 0]);
  const ins = await Z.deploy('HackInsurance', [runners.address, 2, 1, A('gov')], 'gov');
  const threats = await Z.deploy('ThreatRegistry', [runners.address, 2, 1, A('gov'), 3600], 'gov');
  const vac = await Z.deploy('ImmuneVaccines', [ZeroAddress, ZeroAddress, ins.address, threats.address, A('gov')], 'gov');
  await threats.send('gov', 'setVaccines', [vac.address]);
  const victim = await Z.deployRaw(V().LeakyVault, [], 'user');
  const tkey = await ins.call('targetKey', [BigInt(IDS.Z), victim.address]);
  await ins.send('fund', 'deposit', [], 1000n * ZETA);
  await ins.send('gov', 'setTarget', [tkey, true, 300n * ZETA]);
  await ins.send('user', 'buyCover', [tkey, 100n * ZETA, 30 * DAY], await ins.call('premiumOf', [100n * ZETA, 30 * DAY]));
  Z.mine(5);
  const from = Z.blockNumber() - 4n;
  const REPORT = '0x' + 'f0'.repeat(32);
  await ins.send('user', 'fileClaim', [0n, ['0x' + 'a1'.repeat(32)], from, from + 2n, REPORT, 50n * ZETA, 'replay'], ZETA);
  for (const r of ['r0', 'r1']) await ins.send(r, 'vote', [0n, true, REPORT, 50n * ZETA]);
  await vac.send('user', 'vaccinateFromClaim', [0n, victim.address]);
  const id = await vac.call('ids', [0n]);
  const code = await Z.getCode(victim.address);
  const record = await readVaccine(chainSend(Z), vac.address, id);

  // the report the runners vote on: detector `confirmed`, the vaccine derived from the code rides with it
  const report = confirmedReport({ record, id, code, vaccines: vac.address, observedAt: net.t });
  assert.equal(report.finding.codeHash, record.codeHash);
  assert.equal(report.finding.kind, 1, 'exploit contract');
  assert.equal(report.finding.severity, 4, 'critical');
  assert.equal(report.finding.vaccine, report.vaccine.id);
  assert.equal(runnerVote(report).ok, true, 'a runner reproduces it from the bundle alone');
  // a doctored record (inactive) does not reproduce
  assert.deepEqual(confirmedVerdict({ ...report.bundle.inputs, record: { ...report.bundle.inputs.record, active: false } }), []);

  const job = await agree(net, report);
  assert.equal(job.verdict, job.honest.verdict);
  await attest(net, job.jobId, report.finding);
  const keys = keysOf(report.finding);
  const sent = await broadcast(net, keys);
  assert.deepEqual(sent.messages.map((x) => x.dest).sort(), ['B', 'C']);
  for (const n of ['B', 'C']) {
    const mirror = net.dest[n].mirror;
    const [flagged, sev] = await mirror.call('isCodeFlagged', [record.codeHash]);
    assert.deepEqual([flagged, Number(sev)], [true, 4], `${n}: the vulnerable code is flagged`);
    assert.equal(await mirror.call('vaccineOf', [codeKey(record.codeHash)]), report.vaccine.id, `${n}: with its vaccine`);
  }
  // on C: someone deploys the same vault recompiled (another metadata hash, so another code hash); the sentinel
  // there holds the vaccine from the flag and catches it
  const clone = otherMetadata(code);
  assert.notEqual(codeHashOf(clone), record.codeHash);
  const hits = cloneVerdict({ chainId: IDS.C, address: '0x' + 'c1'.repeat(20), code: clone, codeHash: codeHashOf(clone), vaccine: report.vaccine });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 4);
  assert.match(hits[0].label, /fingerprint match/);
  assert.equal(matchVaccine(report.vaccine, V().PlainVault.runtime).match, false, 'honest code is not caught');
});
