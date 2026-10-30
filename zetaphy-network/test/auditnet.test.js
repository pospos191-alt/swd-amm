// The open audit network (docs/future/audit-network.md): strictness and abuse tests of AuditNetwork, AuditRunners,
// AuditJudges and AuditCertificate on the in-memory EVM. The commitments are made by zetaphy-hub/audit-core.js (the
// hub's and the CLI's code), so the JS and the contracts are checked against each other too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCreateAddress, keccak256, ZeroAddress, AbiCoder, Interface } from 'ethers';
import solc from 'solc';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { k, core, codeHashOf, automatedResult, runPipeline } from '../src/auditnet.js';

const DAY = 86400;
const abi = AbiCoder.defaultAbiCoder();
const PARAMS = {
  minContest: 3 * DAY, maxContest: 30 * DAY, revealWindow: DAY, judgeWindow: 2 * DAY, appealWindow: 2 * DAY, appealTimeout: 7 * DAY,
  unbondDelay: DAY, minAuditorsFloor: 2, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000, maxFindingsPerAuditor: 5,
  auditorBond: 10n * ZETA, minPool: ZETA,
};
const JPARAMS = { judgeQuorum: 3, maxJudges: 9, judgeMinScore: 0, unbondDelay: DAY, judgeBond: 20n * ZETA, appealBond: 5n * ZETA };
const LEVELS = { validity: 30 * DAY, silverAuditors: 3, goldAuditors: 5, silverContest: 7 * DAY, goldContest: 14 * DAY, silverMutationBps: 7000, goldMutationBps: 8500 };
const CODE1 = '0x6001600055600160015500';   // the "contract" under audit (any runtime code)
const CODE2 = '0x6002600055600260015500';   // its fixed version
const TARGET = '0x' + 'be'.repeat(20);
const SRC = '0x' + '5c'.repeat(32);
const salt = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hash = (s) => keccak256(new TextEncoder().encode(s));
const GOOD = { resultHash: hash('result v1'), critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 9000 };
const R = { ok: 0, notSettled: 1, noAgreement: 2, autoCritHigh: 3, invFailed: 4, invNotRun: 5, contestShort: 6, fewAuditors: 7, critHigh: 8, undecided: 9,
  appealOpen: 10, fixUnconfirmed: 11, reclaimed: 12, codeChanged: 13, codeRevoked: 14, already: 15 };

let kitCache = null;
function auditKit() {
  if (kitCache) return kitCache;
  const input = { language: 'Solidity', sources: { 'AuditKit.sol': { content: readFileSync(new URL('./helpers/AuditKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['AuditKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return kitCache;
}

async function world({ judges = 5, params = PARAMS, jparams = JPARAMS } = {}) {
  const names = ['gov', 'treasury', 'sponsor', 'x', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'r1', 'r2', 'r3', 'r4'];
  const c = await createChain(names);
  const A = (n) => c.acct[n].toString();
  const m = workMocks();
  const jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3', 'r4']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const rep = await c.deploy('WorkerReputation', [A('gov'), jobs.address, ZeroAddress], 'gov');
  const n = await c.nonce('gov');
  const at = (i) => getCreateAddress({ from: A('gov'), nonce: n + BigInt(i) });
  const net = await c.deploy('AuditNetwork', [A('gov'), A('treasury'), rep.address, at(1), at(2), at(3), params], 'gov');
  const run = await c.deploy('AuditRunners', [net.address, jobs.address, rep.address, 1], 'gov');
  const jud = await c.deploy('AuditJudges', [net.address, rep.address, A('gov'), jparams], 'gov');
  const cert = await c.deploy('AuditCertificate', [net.address, run.address, jud.address, A('gov'), LEVELS], 'gov');
  assert.deepEqual([run.address, jud.address, cert.address].map((x) => x.toLowerCase()), [at(1), at(2), at(3)].map((x) => x.toLowerCase()), 'predicted addresses');
  await rep.send('gov', 'setReporter', [net.address, true]);
  await rep.send('gov', 'setReporter', [run.address, true]);
  await c.putCode(TARGET, CODE1);
  for (const a of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) await net.send(a, 'bond', [], 10n * ZETA);
  for (const j of ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7'].slice(0, judges)) await jud.send(j, 'bond', [], 20n * ZETA);
  return { c, A, jobs, rep, net, run, jud, cert };
}

const tgt = (code = CODE1, target = TARGET, chainId = 1n) => ({ chainId, target, codeHash: codeHashOf(code), sourceHash: SRC });

async function request(w, { code = CODE1, target = TARGET, tier = 0, contest = 3 * DAY, minAuditors = 2, prev = 0n, value = 11n * ZETA, chainId = 1n } = {}) {
  await w.net.send('sponsor', 'request', [tgt(code, target, chainId), tier, contest, minAuditors, prev, 'ipfs://scope'], value);
  return (await w.net.call('requestCount')) - 1n;
}

/** Auditors commit reports (and findings) during the contest. findings: [{ who, sev, text }] -> fids. */
async function contest(w, id, { auditors = ['a1', 'a2'], findings = [] } = {}) {
  for (const a of auditors) await w.net.send(a, 'commitReport', [id, core.reportCommitment(k, hash(`report ${a}`), w.A(a), salt(1), id)]);
  const fids = [];
  for (const [i, f] of findings.entries()) {
    const c = core.findingCommitment(k, hash(f.text), f.sev, hash(`poc ${f.text}`), w.A(f.who), salt(100 + i), id);
    await w.net.send(f.who, 'commitFinding', [id, c]);
    fids.push((await w.net.call('findingCount')) - 1n);
  }
  return fids;
}

async function runners(w, id, results = [GOOD, GOOD, GOOD], who = ['r1', 'r2', 'r3']) {
  for (const [i, r] of who.entries()) if (results[i]) await w.run.send(r, 'commit', [id, core.runCommitment(k, results[i], w.A(r), salt(7), id)]);
}
async function runnerReveal(w, id, results = [GOOD, GOOD, GOOD], who = ['r1', 'r2', 'r3']) {
  for (const [i, r] of who.entries()) if (results[i]) await w.run.send(r, 'reveal', [id, results[i], salt(7)]);
}

async function reveal(w, id, { auditors = ['a1', 'a2'], findings = [], fids = [] } = {}) {
  for (const a of auditors) await w.net.send(a, 'revealReport', [id, hash(`report ${a}`), salt(1)]);
  for (const [i, f] of findings.entries()) await w.net.send(f.who, 'revealFinding', [fids[i], hash(f.text), f.sev, hash(`poc ${f.text}`), salt(100 + i), 'ipfs://finding']);
}

const vote = (w, judges, fn, args) => Promise.all([]).then(async () => { for (const j of judges) await w.jud.send(j, fn, args); });

/** Request -> contest -> reveals -> runners -> (decisions) -> settle. Returns { id, fids }. */
async function fullRound(w, { code = CODE1, findings = [], decide = [], auditors = ['a1', 'a2'], results, prev = 0n, beforeSettle } = {}) {
  const id = await request(w, { code, prev });
  const fids = await contest(w, id, { auditors, findings });
  await runners(w, id, results);
  w.c.advance(3 * DAY);
  await reveal(w, id, { auditors, findings, fids });
  await runnerReveal(w, id, results);
  for (const [i, d] of decide.entries()) if (d) await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fids[i], d.valid, d.sev ?? 0, d.group != null ? fids[d.group] : fids[i]]);
  if (beforeSettle) await beforeSettle(id, fids);
  w.c.advance(DAY + 2 * DAY + 2 * DAY); // reveal + judge + appeal windows
  await w.run.send('x', 'settle', [id]);
  await w.net.send('x', 'settle', [id]);
  return { id, fids };
}

test('the JS commitments and keys (audit-core.js) are exactly the contracts\'', async () => {
  const w = await world();
  const r = GOOD;
  assert.equal(await w.run.call('commitmentOf', [r, w.A('r1'), salt(7), 3n]), core.runCommitment(k, r, w.A('r1'), salt(7), 3n));
  assert.equal(await w.net.call('reportCommitment', [hash('x'), w.A('a1'), salt(1), 2n]), core.reportCommitment(k, hash('x'), w.A('a1'), salt(1), 2n));
  assert.equal(await w.net.call('findingCommitment', [hash('f'), 4, hash('p'), w.A('a1'), salt(2), 2n]), core.findingCommitment(k, hash('f'), 4, hash('p'), w.A('a1'), salt(2), 2n));
  assert.equal(await w.jud.call('itemKey', [1, 5n, 0n]), core.itemKey(k, 1, 5n, 0n));
  assert.equal(await w.jud.call('findingOutcome', [true, 4, 5n]), core.findingOutcome(k, true, 4, 5n));
  assert.equal(await w.cert.call('keyOf', [77390n, TARGET]), core.certKey(k, 77390n, TARGET));
});

test('happy path: a clean contest with enough auditors, an agreeing automated tier and no findings gets a certificate', async () => {
  const w = await world();
  const { id } = await fullRound(w);
  assert.equal(Number(await w.cert.call('check', [id])), R.ok);
  await w.cert.send('x', 'certify', [id]);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), true);
  const [c, valid] = await w.cert.call('certificate', [1n, TARGET]);
  assert.equal(valid, true);
  assert.equal(c.codeHash, codeHashOf(CODE1));
  assert.equal(c.reportHash, GOOD.resultHash, 'bound to the agreed automated result');
  assert.equal(Number(c.level), 1, 'two auditors over three days: bronze');
  // the hub's decoder reads the same thing from raw return data
  const iface = new Interface(JSON.parse(readFileSync(new URL('../artifacts/AuditCertificate.json', import.meta.url), 'utf8')).abi);
  const raw = iface.encodeFunctionResult('certificate', [c, valid]);
  const d = core.decodeCertificate(raw);
  assert.equal(d.valid, true);
  assert.equal(d.cert.codeHash, c.codeHash.toLowerCase());
  assert.equal(core.certState(d, Number(w.c.now())), 'valid');
  await assert.rejects(w.cert.send('x', 'certify', [id]), /NotCertifiable/, 'no replay of a certification');
  assert.equal(Number(await w.cert.call('check', [id])), R.already);
  // it expires
  w.c.advance(LEVELS.validity);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), false, 'expired');
});

test('copying a finding is impossible before the reveal: commitments are hashes bound to the auditor and the request', async () => {
  const w = await world();
  const id = await request(w);
  const id2 = await request(w);
  const f = { who: 'a1', sev: 5, text: 'reentrancy in withdraw drains the vault' };
  const [fid] = await contest(w, id, { findings: [f] });
  // a commitment made for request `id` committed on request id2 (replay across requests)
  await w.net.send('a3', 'commitReport', [id2, core.reportCommitment(k, hash('r'), w.A('a3'), salt(9), id)]);
  const theirs = (await w.net.call('getFinding', [fid])).commitment;
  // a copier who reads a1's commitment from the chain and submits it as its own gains nothing:
  await w.net.send('a2', 'commitFinding', [id, theirs]);
  const copy = (await w.net.call('findingCount')) - 1n;
  await assert.rejects(w.net.send('a1', 'revealFinding', [fid, hash(f.text), 5, hash(`poc ${f.text}`), salt(100), '']), /TooEarly/, 'no reveal before the contest ends');
  w.c.advance(3 * DAY);
  await assert.rejects(w.net.send('a2', 'commitFinding', [id, theirs]), /Closed/, 'no commits once the contest closed (and no certificate)');
  // even knowing the text after a1 reveals, a2's copied commitment does not open for a2
  await w.net.send('a1', 'revealFinding', [fid, hash(f.text), 5, hash(`poc ${f.text}`), salt(100), '']);
  await assert.rejects(w.net.send('a2', 'revealFinding', [copy, hash(f.text), 5, hash(`poc ${f.text}`), salt(100), '']), /BadReveal/);
  await assert.rejects(w.net.send('a1', 'revealFinding', [fid, hash(f.text), 5, hash(`poc ${f.text}`), salt(100), '']), /BadFinding/, 'no second reveal');
  // and the commitment made for request `id` does not open on the other request
  await assert.rejects(w.net.send('a3', 'revealReport', [id2, hash('r'), salt(9)]), /BadReveal/);
});

test('refused while any valid high finding is open; a fix is a new codeHash that goes through it all again', async () => {
  const w = await world();
  const f = { who: 'a1', sev: 4, text: 'owner can drain' };
  const v1 = await fullRound(w, { findings: [f], decide: [{ valid: true, sev: 4 }] });
  assert.equal(Number(await w.cert.call('check', [v1.id])), R.critHigh);
  await assert.rejects(w.cert.send('x', 'certify', [v1.id]), /NotCertifiable/);
  // the fix: same request again is refused (same codeHash); the upgraded code is a new request naming v1
  await w.c.putCode(TARGET, CODE2);
  await assert.rejects(request(w, { code: CODE1, prev: v1.id + 1n }), /CodeMismatch|BadRequest/);
  const v2 = await fullRound(w, { code: CODE2, prev: v1.id + 1n });
  assert.deepEqual([...await w.net.call('carriedOf', [v2.id])].map(Number), [Number(v1.fids[0])], 'the high finding is carried');
  assert.equal(Number(await w.cert.call('check', [v2.id])), R.fixUnconfirmed, 'the judges never confirmed the fix');
  // again, with the judges confirming the fix during judging
  await w.c.putCode(TARGET, CODE1);
  await w.c.putCode(TARGET, CODE2);
  const v3 = await fullRound(w, { code: CODE2, prev: v1.id + 1n, beforeSettle: async (id) => {
    await assert.rejects(w.jud.send('j1', 'voteFixed', [id, 999n, true]), /Closed/, 'only carried findings');
    await vote(w, ['j1', 'j2', 'j3'], 'voteFixed', [id, v1.fids[0], true]);
  } });
  assert.equal(Number(await w.cert.call('check', [v3.id])), R.ok);
  await w.cert.send('x', 'certify', [v3.id]);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), true);
});

test('refused with too few auditors, a contest window too short, or before the appeal window is over', async () => {
  const w = await world();
  await assert.rejects(request(w, { contest: 3 * DAY - 1 }), /BadRequest/, 'below the governance minimum');
  await assert.rejects(request(w, { tier: 1, contest: 3 * DAY, minAuditors: 4 }), /BadRequest/, 'a standard tier adds a week');
  await assert.rejects(request(w, { minAuditors: 1 }), /BadRequest/, 'below the auditor floor');
  await assert.rejects(request(w, { code: CODE2 }), /CodeMismatch/, 'on this chain the codeHash must be EXTCODEHASH');
  const few = await fullRound(w, { auditors: ['a1'] });
  assert.equal(Number(await w.cert.call('check', [few.id])), R.fewAuditors);
  // not settled yet: the appeal window is still open
  const id = await request(w);
  await contest(w, id);
  await runners(w, id);
  w.c.advance(3 * DAY);
  await reveal(w, id);
  await runnerReveal(w, id);
  await w.run.send('x', 'settle', [id]);
  assert.equal(Number(await w.cert.call('check', [id])), R.notSettled);
  w.c.advance(DAY + 2 * DAY + DAY);
  await assert.rejects(w.net.send('x', 'settle', [id]), /TooEarly/, 'one day of the appeal window left');
  w.c.advance(DAY);
  await w.net.send('x', 'settle', [id]);
  assert.equal(Number(await w.cert.call('check', [id])), R.ok);
});

test('the automated tier must agree (2 of 3) with zero open critical/high, no failed invariant, and n/a only if the judges accept it', async () => {
  const w = await world();
  const other = { ...GOOD, resultHash: hash('another result') };
  const a = await fullRound(w, { results: [GOOD, other, { ...GOOD, resultHash: hash('third') }] });
  assert.equal(Number(await w.cert.call('check', [a.id])), R.noAgreement);
  const crit = { ...GOOD, critHigh: 1 };
  const b = await fullRound(w, { results: [crit, crit, GOOD] });
  assert.equal(Number(await w.cert.call('check', [b.id])), R.autoCritHigh, 'two runners agree the pipeline has an open high');
  const inv = { ...GOOD, invFailed: 1 };
  const c2 = await fullRound(w, { results: [inv, inv, inv] });
  assert.equal(Number(await w.cert.call('check', [c2.id])), R.invFailed);
  const na = { ...GOOD, invNotRun: 2 };
  const d = await fullRound(w, { results: [na, na, null] });
  assert.equal(Number(await w.cert.call('check', [d.id])), R.invNotRun, 'suites not run and no n/a declared');
  // declared and accepted by the judges
  const id = await request(w);
  await w.net.send('sponsor', 'declareNotApplicable', [id, hash('plain ERC-20: no protocol invariants')]);
  await assert.rejects(w.net.send('a1', 'declareNotApplicable', [id, hash('x')]), /BadRequest/, 'only the sponsor');
  await contest(w, id);
  await runners(w, id, [na, na, na]);
  w.c.advance(3 * DAY);
  await reveal(w, id);
  await runnerReveal(w, id, [na, na, na]);
  await w.run.send('x', 'settle', [id]);
  await vote(w, ['j1', 'j2', 'j3'], 'voteNotApplicable', [id, true]);
  w.c.advance(5 * DAY);
  await w.net.send('x', 'settle', [id]);
  assert.equal(Number(await w.cert.call('check', [id])), R.ok);
  // the runner without an eligible NeuroJobs record and the sponsor cannot take seats
  const id2 = await request(w);
  await assert.rejects(w.run.send('a1', 'commit', [id2, hash('c')]), /NotRunner/);
  await w.jobs.send('gov', 'set', [w.A('r4'), true, 1, 2]);
  await assert.rejects(w.run.send('r4', 'commit', [id2, hash('c')]), /NotRunner/, 'more rejected than agreed');
});

test('revoked at once by a later valid critical finding against the certified code; that code can never be certified again', async () => {
  const w = await world();
  const { id } = await fullRound(w);
  await w.cert.send('x', 'certify', [id]);
  const req = await w.net.call('getRequest', [id]);
  assert.ok(req.reserve > 0n, 'the unused pool is the post-certificate bounty');
  // post-certificate finding: commit, reveal from the next block, judged
  const text = 'signature replay lets anyone withdraw';
  await w.net.send('a3', 'commitFinding', [id, core.findingCommitment(k, hash(text), 5, hash('poc'), w.A('a3'), salt(5), id)]);
  const fid = (await w.net.call('findingCount')) - 1n;
  assert.equal((await w.net.call('getFinding', [fid])).late, true);
  await w.net.send('a3', 'revealFinding', [fid, hash(text), 5, hash('poc'), salt(5), 'ipfs://late']);
  await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fid, true, 5, fid]);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), false, 'revoked');
  const [c] = await w.cert.call('certificate', [1n, TARGET]);
  assert.equal(c.revokedBy, fid + 1n);
  assert.ok(await w.cert.call('revokedCode', [codeHashOf(CODE1)]) > 0n);
  // the finder is paid from the reserve once the appeal window passed
  await assert.rejects(w.net.send('a3', 'claimFinding', [fid]), /TooEarly/);
  w.c.advance(2 * DAY);
  const before = await w.net.call('owed', [w.A('a3')]);
  await w.net.send('a3', 'claimFinding', [fid]);
  assert.equal(await w.net.call('owed', [w.A('a3')]) - before, req.reserve, 'critical: the whole reserve');
  await assert.rejects(w.net.send('a3', 'claimFinding', [fid]), /Closed/, 'paid once');
  // the same code under a new request can never be certified again
  const again = await fullRound(w);
  assert.equal(Number(await w.cert.call('check', [again.id])), R.codeRevoked);
});

test('invalid at once when the code at the address changes (proxy upgrade / redeploy simulation)', async () => {
  const w = await world();
  const { id } = await fullRound(w);
  await w.cert.send('x', 'certify', [id]);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), true);
  await w.c.putCode(TARGET, CODE2); // the implementation behind the address changed
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), false);
  const [, valid] = await w.cert.call('certificate', [1n, TARGET]);
  assert.equal(valid, false);
  await w.c.putCode(TARGET, CODE1);
  assert.equal(await w.cert.call('isCertified', [1n, TARGET]), true, 'it is bound to the codeHash, nothing else');
  // a request whose code changed before certification cannot be certified
  const r2 = await fullRound(w);
  await w.c.putCode(TARGET, CODE2);
  assert.equal(Number(await w.cert.call('check', [r2.id])), R.codeChanged);
  // another chain: recorded by chainId/codeHash, no local code check
  const other = '0x' + 'ab'.repeat(20);
  await w.net.send('sponsor', 'request', [tgt(CODE1, other, 11155111n), 0, 3 * DAY, 2, 0n, ''], 11n * ZETA);
  const xid = (await w.net.call('requestCount')) - 1n;
  await contest(w, xid);
  await runners(w, xid);
  w.c.advance(3 * DAY);
  await reveal(w, xid);
  await runnerReveal(w, xid);
  await w.run.send('x', 'settle', [xid]);
  w.c.advance(5 * DAY);
  await w.net.send('x', 'settle', [xid]);
  assert.equal(Number(await w.cert.call('check', [xid])), R.codeRevoked === 14 ? R.ok : R.ok);
  await w.cert.send('x', 'certify', [xid]);
  assert.equal(await w.cert.call('isCertified', [11155111n, other]), true);
  assert.equal(await w.cert.call('isCertified', [1n, other]), false);
});

test('bond slashing: an invalid finding and a rejected report slash the auditor (escrowed until appeals are over); an appeal that wins restores it', async () => {
  const w = await world();
  const spam = { who: 'a1', sev: 5, text: 'the contract is bad' };
  const wrong = { who: 'a2', sev: 4, text: 'a false alarm' };
  const sponsorOwed0 = await w.net.call('owed', [w.A('sponsor')]);
  const { id, fids } = await fullRound(w, { auditors: ['a1', 'a2', 'a3'], findings: [spam, wrong], decide: [{ valid: false }, { valid: false }], beforeSettle: async (rid, f) => {
    await vote(w, ['j1', 'j2', 'j3'], 'voteReport', [rid, w.A('a3'), false]);
    // a2 appeals; governance (the timelock) finds it was a valid low
    await assert.rejects(w.jud.send('a2', 'appeal', [f[1]], 1n), /BadValue/);
    await w.jud.send('a2', 'appeal', [f[1]], 5n * ZETA);
    await assert.rejects(w.jud.send('x', 'appeal', [f[1]], 5n * ZETA), /Closed/, 'one appeal at a time');
    await assert.rejects(w.jud.send('x', 'resolveAppeal', [f[1], true, 2, f[1]]), /NotGovernance/);
    assert.equal((await w.net.call('auditors', [w.A('a2')])).bond, 8n * ZETA, 'slashed 20% of the 10 ZETAPHY bond');
    await w.jud.send('gov', 'resolveAppeal', [f[1], true, 2, f[1]]);
    assert.equal((await w.net.call('auditors', [w.A('a2')])).bond, 10n * ZETA, 'restored');
    assert.equal(await w.jud.call('owed', [w.A('a2')]), 5n * ZETA, 'the appeal bond back: it changed the outcome');
  } });
  assert.equal((await w.net.call('auditors', [w.A('a1')])).bond, 8n * ZETA);
  assert.equal((await w.net.call('auditors', [w.A('a3')])).bond, 8n * ZETA, 'rejected report');
  // the sponsor gets the rejected report's slash at settlement and the finding's once claimed
  assert.equal(await w.net.call('owed', [w.A('sponsor')]) - sponsorOwed0, 2n * ZETA);
  await w.net.send('x', 'claimSlash', [fids[0]]);
  assert.equal(await w.net.call('owed', [w.A('sponsor')]) - sponsorOwed0, 4n * ZETA);
  await assert.rejects(w.net.send('x', 'claimSlash', [fids[0]]), /TooEarly/, 'once');
  // a1's bond is now below the requirement: it cannot audit until it tops up
  const id2 = await request(w);
  await assert.rejects(w.net.send('a1', 'commitReport', [id2, hash('c')]), /NotBonded/);
  await w.net.send('a1', 'bond', [], 2n * ZETA);
  await w.net.send('a1', 'commitReport', [id2, hash('c')]);
  // bonds stay locked while a submission can still be judged or appealed
  await w.net.send('a1', 'requestUnbond', []);
  w.c.advance(DAY);
  await assert.rejects(w.net.send('a1', 'withdrawBond', []), /TooEarly/);
  // the valid low (after appeal) is paid from the pool
  await w.net.send('a2', 'claimFinding', [fids[1]]);
  assert.ok(await w.net.call('owed', [w.A('a2')]) > 0n);
  void id;
});

test('judge collusion is bounded by the quorum: a minority decides nothing; conflicts, double votes and outsiders are refused', async () => {
  const w = await world({ judges: 7 }); // quorum = max(3, 7/2 + 1) = 4
  assert.equal(await w.jud.call('quorum'), 4n);
  const f = { who: 'a1', sev: 2, text: 'a minor issue' };
  const id = await request(w);
  const [fid] = await contest(w, id, { findings: [f] });
  await runners(w, id);
  w.c.advance(3 * DAY);
  await reveal(w, id, { findings: [f], fids: [fid] });
  // three colluders try to turn a low into a critical (to block the certificate and take the pool)
  await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fid, true, 5, fid]);
  assert.equal((await w.net.call('getFinding', [fid])).status, 2n, 'still undecided');
  await assert.rejects(w.jud.send('j1', 'voteFinding', [fid, true, 2, fid]), /AlreadyIn/);
  await assert.rejects(w.jud.send('a2', 'voteFinding', [fid, true, 2, fid]), /NotJudge/);
  await assert.rejects(w.jud.send('j4', 'voteFinding', [fid, true, 9, fid]), /BadOutcome/);
  await vote(w, ['j4', 'j5', 'j6', 'j7'], 'voteFinding', [fid, true, 2, fid]);
  const fd = await w.net.call('getFinding', [fid]);
  assert.equal([fd.status, fd.sev].join(), '3,2', 'the honest majority decided: valid low');
  // the sponsor (or an auditor) of a request cannot judge it
  await w.jud.send('sponsor', 'bond', [], 20n * ZETA);
  await assert.rejects(w.jud.send('sponsor', 'voteReport', [id, w.A('a1'), false]), /Conflict/);
  // a judge cannot audit (and so cannot judge its own findings), even with an auditor bond
  const id2 = await request(w);
  await w.net.send('j1', 'bond', [], 10n * ZETA);
  await assert.rejects(w.net.send('j1', 'commitFinding', [id2, hash('c')]), /Conflict/);
  await assert.rejects(w.net.send('j1', 'commitReport', [id2, hash('c')]), /Conflict/);
  // governance removes a colluder; the reputation bar keeps unknown addresses off the committee
  await w.jud.send('gov', 'setJudgeBlocked', [w.A('j1'), true]);
  assert.equal(await w.jud.call('isJudge', [w.A('j1')]), false);
  await assert.rejects(w.jud.send('gov', 'setParams', [{ ...JPARAMS, judgeQuorum: 2 }]), /BadParams/, 'quorum never below 3');
  await w.jud.send('gov', 'setParams', [{ ...JPARAMS, judgeMinScore: 500 }]);
  await assert.rejects(w.jud.send('x', 'bond', [], 20n * ZETA), /NotJudge/, 'no track record');
});

test('appeals block settlement until resolved; after the timeout the judges\' decision stands', async () => {
  const w = await world();
  const f = { who: 'a1', sev: 3, text: 'medium thing' };
  const id = await request(w);
  const [fid] = await contest(w, id, { findings: [f] });
  await runners(w, id);
  w.c.advance(3 * DAY);
  await reveal(w, id, { findings: [f], fids: [fid] });
  await runnerReveal(w, id);
  await w.run.send('x', 'settle', [id]);
  await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fid, true, 3, fid]);
  await w.jud.send('sponsor', 'appeal', [fid], 5n * ZETA);
  w.c.advance(DAY + 2 * DAY + 2 * DAY);
  await assert.rejects(w.net.send('x', 'settle', [id]), /TooEarly/, 'an appeal is open');
  assert.equal(Number(await w.cert.call('check', [id])), R.notSettled);
  await assert.rejects(w.jud.send('x', 'expireAppeal', [fid]), /TooEarly/);
  w.c.advance(7 * DAY);
  await w.jud.send('x', 'expireAppeal', [fid]);
  assert.equal(await w.jud.call('owed', [w.A('sponsor')]), 5n * ZETA);
  await w.net.send('x', 'settle', [id]);
  assert.equal(Number(await w.cert.call('check', [id])), R.ok, 'a valid medium does not block');
  // judges who voted with the decision share the judges' pot
  const items = [core.itemKey(k, 1, fid, 0n)];
  await w.jud.send('j1', 'claim', [id, items]);
  await assert.rejects(w.jud.send('j1', 'claim', [id, items]), /Nothing/, 'replay');
  await assert.rejects(w.jud.send('j4', 'claim', [id, items]), /Nothing/, 'did not vote');
  const pot = await w.jud.call('pot', [id]);
  assert.equal(await w.jud.call('owed', [w.A('j1')]), pot / 3n);
});

test('duplicates split their group\'s share; the bounty is split by severity weight', async () => {
  const w = await world();
  const fs = [{ who: 'a1', sev: 4, text: 'bug A' }, { who: 'a2', sev: 4, text: 'bug A again' }, { who: 'a3', sev: 3, text: 'bug B' }];
  const { id, fids } = await fullRound(w, { auditors: ['a1', 'a2', 'a3'], findings: fs, decide: [{ valid: true, sev: 4 }, { valid: true, sev: 4, group: 0 }, { valid: true, sev: 3 }] });
  for (const [i, a] of ['a1', 'a2', 'a3'].entries()) await w.net.send(a, 'claimFinding', [fids[i]]);
  const req = await w.net.call('getRequest', [id]);
  const pot = req.pool - req.pool / 10n; // participation 10%
  const owed = await Promise.all(['a1', 'a2', 'a3'].map((a) => w.net.call('owed', [w.A(a)])));
  assert.equal(owed[0], pot * 10n / 13n / 2n);
  assert.equal(owed[1], owed[0], 'the duplicate shares the group');
  assert.equal(owed[2], pot * 3n / 13n);
  await assert.rejects(w.net.send('a1', 'claimFinding', [fids[0]]), /Closed/, 'claimed once');
  await assert.rejects(w.jud.send('j1', 'voteFinding', [fids[2], true, 2, fids[2]]), /Closed/, 'decided: votes are over');
});

test('reentrancy on payouts: a contract that re-enters withdraw gets paid exactly once', async () => {
  const w = await world({ params: { ...PARAMS, participationBps: 2000 } });
  const kit = auditKit();
  const evil = await w.c.deployRaw(kit.AuditReenter, [w.net.address], 'x');
  await evil.send('x', 'bond', [], 10n * ZETA);
  const id = await request(w);
  await contest(w, id, { auditors: ['a1'] });
  await evil.send('x', 'commitReport', [id, core.reportCommitment(k, hash('evil report'), evil.address, salt(3), id)]);
  await runners(w, id);
  w.c.advance(3 * DAY);
  await reveal(w, id, { auditors: ['a1'] });
  await evil.send('x', 'revealReport', [id, hash('evil report'), salt(3)]);
  w.c.advance(5 * DAY);
  await w.net.send('x', 'settle', [id]);
  await evil.send('x', 'claimReport', [id]);
  const owed = await w.net.call('owed', [evil.address]);
  assert.ok(owed > 0n);
  const before = await w.c.balance(Address.fromString(w.net.address));
  await evil.send('x', 'attack');
  assert.equal(await evil.call('reentryFailed'), true, 'the nested withdraw was refused');
  assert.equal(await evil.call('received'), owed, 'paid once');
  assert.equal(before - await w.c.balance(Address.fromString(w.net.address)), owed);
});

test('governance is the timelock only, and every parameter is bounded', async () => {
  const w = await world();
  await assert.rejects(w.net.send('x', 'setParams', [PARAMS]), /NotGovernance/);
  for (const bad of [{ minContest: DAY }, { maxContest: 200 * DAY }, { slashBps: 100 }, { feeBps: 5000 }, { auditorBond: 0n }, { minAuditorsFloor: 1 }, { appealTimeout: DAY }]) {
    await assert.rejects(w.net.send('gov', 'setParams', [{ ...PARAMS, ...bad }]), /BadParams/, JSON.stringify(bad, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  await assert.rejects(w.cert.send('gov', 'setLevels', [{ ...LEVELS, validity: 400 * DAY }]), /BadParams/);
  await assert.rejects(w.cert.send('x', 'setLevels', [LEVELS]), /NotGovernance/);
  await assert.rejects(w.net.send('x', 'markCertified', [0n, 1n]), /NotCertificate|BadRequest/);
  await assert.rejects(w.net.send('x', 'decide', [0n, true, 4, 0n]), /NotJudging/);
  await assert.rejects(w.cert.send('x', 'revokeFor', [0n, 0n]), /NotNetwork/);
  await assert.rejects(w.run.send('x', 'open', [0n], 1n), /NotNetwork/);
});

test('levels: gold needs many auditors, a long contest and a high mutation score', async () => {
  const w = await world();
  const id = await request(w, { contest: 14 * DAY, minAuditors: 5 });
  const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
  await contest(w, id, { auditors: five });
  await runners(w, id);
  w.c.advance(14 * DAY);
  await reveal(w, id, { auditors: five });
  await runnerReveal(w, id);
  await w.run.send('x', 'settle', [id]);
  w.c.advance(5 * DAY);
  await w.net.send('x', 'settle', [id]);
  await w.cert.send('x', 'certify', [id]);
  const [c] = await w.cert.call('certificate', [1n, TARGET]);
  assert.equal(Number(c.level), 3, 'gold');
  assert.equal(Number(c.auditors), 5);
});

test('automated result: the pipeline fixture and Neuro findings hash the same for every runner; malformed output is refused', () => {
  const pipeline = JSON.parse(readFileSync(new URL('./fixtures/audit-report.json', import.meta.url), 'utf8'));
  const req = { chainId: 77390, target: TARGET, codeHash: codeHashOf(CODE1), sourceHash: SRC };
  const neuro = { verdict: '0x' + 'aa'.repeat(32), report: { analysis: { findings: [{ id: 'owner-mint', severity: 'high', title: 'Owner can mint' }, { id: 'sim-sell', severity: 'high' }] } } };
  const a = automatedResult(req, { pipeline, neuro });
  const b = automatedResult(req, { pipeline: JSON.parse(JSON.stringify(pipeline)).findings.reverse() && { ...pipeline, findings: [...pipeline.findings].reverse() }, neuro });
  assert.equal(a.tuple.resultHash, b.tuple.resultHash, 'order does not matter');
  assert.equal(a.tuple.critHigh, 1, 'the Neuro high counts (the fixed high and the accepted low do not)');
  assert.equal(a.tuple.mutationBps, 8300);
  assert.ok(!a.body.findings.some((f) => f.id === 'neuro:sim-sell'), 'trade simulation left out, as in verdicts');
  // triage: a pipeline entry with the Neuro id decides that finding's status
  const triaged = automatedResult(req, { pipeline: { ...pipeline, findings: [...pipeline.findings, { id: 'neuro:owner-mint', tool: 'neuro', rule: 'owner-mint', severity: 'high', file: '', line: 0, title: 'x', status: 'false-positive' }] }, neuro });
  assert.equal(triaged.tuple.critHigh, 0);
  // a title change does not change the hash; a status change does
  const t2 = automatedResult(req, { pipeline: { ...pipeline, findings: pipeline.findings.map((f) => ({ ...f, title: f.title + '!' })) }, neuro });
  assert.equal(t2.tuple.resultHash, a.tuple.resultHash);
  const t3 = automatedResult(req, { pipeline: { ...pipeline, findings: pipeline.findings.map((f, i) => (i ? f : { ...f, status: 'open' })) }, neuro });
  assert.notEqual(t3.tuple.resultHash, a.tuple.resultHash);
  assert.equal(t3.tuple.critHigh, 2);
  for (const bad of [{ ...pipeline, commit: 'nope' }, { ...pipeline, findings: [{ ...pipeline.findings[0], severity: 'severe' }] }, { ...pipeline, invariants: { passed: 1 } },
    { ...pipeline, findings: [pipeline.findings[0], pipeline.findings[0]] }, { ...pipeline, findings: [{ ...pipeline.findings[0], status: 'ignored' }] }]) {
    assert.throws(() => automatedResult(req, { pipeline: bad, neuro }), /pipeline/);
  }
  // the runner commitment of this tuple opens in the contract's terms (checked against AuditRunners above)
  assert.match(core.runCommitment(k, a.tuple, TARGET, salt(1), 0n), /^0x[0-9a-f]{64}$/);
  void abi;
});

test('pipeline adapter against the REAL audit/report.js --json on a small output dir: the schema matches, the result hashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auditnet-pipeline-'));
  try {
    // what audit/run.sh leaves in <out>/raw/ for a one-contract project: compile, Slither, an invariant suite
    const target = join(root, 'repo');
    mkdirSync(join(target, 'p', 'contracts'), { recursive: true });
    writeFileSync(join(target, 'p', 'contracts', 'Vault.sol'), 'contract Vault {\n  function f() external {\n    (bool ok,) = msg.sender.call{value: 1}("");\n  }\n}\n');
    const raw = join(root, 'out', 'raw');
    for (const d of ['compile', 'slither', 'invariants']) mkdirSync(join(raw, d), { recursive: true });
    writeFileSync(join(raw, 'meta.json'), JSON.stringify({ commit: 'd07b980aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', tier: 'fast', mode: 'target', target, started: '2026-10-30T00:00:00Z' }));
    writeFileSync(join(raw, 'scope.json'), JSON.stringify({ solc: '0.8.26', projects: [{ name: 'p', root: 'p', files: ['contracts/Vault.sol'], excluded: {}, loc: { 'contracts/Vault.sol': 5 } }] }));
    writeFileSync(join(raw, 'compile', 'p.json'), JSON.stringify({ project: 'p', root: 'p', contracts: [{ file: 'contracts/Vault.sol', name: 'Vault', runtimeHash: codeHashOf(CODE1), artifactMatch: null }] }));
    writeFileSync(join(raw, 'slither', 'p__contracts_Vault.sol.json'), JSON.stringify({ success: true, results: { detectors: [
      { check: 'arbitrary-send-eth', impact: 'High', confidence: 'Medium', description: 'Vault.f() (contracts/Vault.sol#2-4) sends eth to an arbitrary user', elements: [{ source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [3] } }] },
      { check: 'low-level-calls', impact: 'Informational', confidence: 'High', description: 'low level call in Vault.f() (contracts/Vault.sol#3)', elements: [{ source_mapping: { filename_relative: 'contracts/Vault.sol', lines: [3] } }] },
    ] } }));
    // a failed property: a finding with no line (the adapter needs whole numbers)
    writeFileSync(join(raw, 'invariants', 'summary.json'), JSON.stringify({ passed: 3, failed: 1, notRun: 1, suites: [{ dir: 'p/audit/invariants', tool: 'forge', passed: 3, failed: 1, notRun: 1, note: 'VaultInvariants.invariant_solvent()' }] }));
    writeFileSync(join(raw, 'tools.tsv'), 'tool\tstatus\tseconds\tversion\tnote\nslither\tran\t2\t0.11.3\t\n');
    const repoDir = new URL('../../', import.meta.url).pathname; // this repository: audit/report.js
    const pipeline = await runPipeline({ repoDir, outDir: join(root, 'out'), timeoutMs: 60_000 });
    assert.equal(pipeline.commit, 'd07b980aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');
    assert.deepEqual(pipeline.codeHashes, { Vault: codeHashOf(CODE1).toLowerCase() });
    assert.deepEqual(pipeline.invariants, { passed: 3, failed: 1, notRun: 1 });
    assert.equal(pipeline.mutationBps, 0, 'no mutation run: 0');
    assert.deepEqual(pipeline.findings.map((f) => [f.tool, f.rule, f.severity, f.status]).sort(),
      [['forge', 'property-violated', 'high', 'open'], ['slither', 'arbitrary-send-eth', 'high', 'open'], ['slither', 'low-level-calls', 'info', 'open']]);
    assert.ok(pipeline.findings.every((f) => Number.isInteger(f.line) && f.line >= 0 && typeof f.file === 'string'));
    assert.equal(pipeline.findings.find((f) => f.tool === 'forge').line, 0);
    const req = { chainId: 77390, target: TARGET, codeHash: codeHashOf(CODE1), sourceHash: SRC };
    const a = automatedResult(req, { pipeline });
    const b = automatedResult(req, { pipeline: await runPipeline({ repoDir, outDir: join(root, 'out'), timeoutMs: 60_000 }) });
    assert.equal(a.tuple.resultHash, b.tuple.resultHash, 'a second run of the same output: the same hash');
    assert.equal(a.tuple.critHigh, 2);
    assert.equal(a.tuple.invFailed, 1);
    assert.equal(a.tuple.invNotRun, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cross-chain: NeuroOracleSender broadcasts a certificate (and its revocation) to NeuroOracle, which re-checks EXTCODEHASH there', async () => {
  const w = await world();
  const { id } = await fullRound(w);
  await w.cert.send('x', 'certify', [id]);
  const zMail = await w.c.deploy('MockMailbox', [77390], 'gov');
  const dMail = await w.c.deploy('MockMailbox', [11155111], 'gov');
  const sender = await w.c.deploy('NeuroOracleSender', [w.net.address, ZeroAddress, zMail.address, w.A('gov')], 'gov');
  const b32 = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const oracle = await w.c.deploy('NeuroOracle', [dMail.address, 77390, 1n, b32(sender.address), w.net.address, w.A('gov'), ZeroAddress], 'gov');
  await sender.send('gov', 'setReceiver', [11155111, b32(oracle.address)]);
  await assert.rejects(sender.send('x', 'pushCertificate', [11155111, 1n, TARGET]), /NothingToSend/, 'off until governance names AuditCertificate');
  await assert.rejects(sender.send('x', 'setAudit', [w.cert.address]), /NotGovernance/);
  await sender.send('gov', 'setAudit', [w.cert.address]);
  const deliver = async () => {
    const body = await w.cert.call('certificateBody', [1n, TARGET]);
    await sender.send('x', 'pushCertificate', [11155111, 1n, TARGET]);
    await dMail.send('x', 'deliver', [77390, b32(sender.address), oracle.address, body]);
  };
  await deliver();
  assert.equal(await oracle.call('isCertified', [1n, TARGET]), true, 'mirrored; the code there is the certified code');
  await w.c.putCode(TARGET, CODE2);
  assert.equal(await oracle.call('isCertified', [1n, TARGET]), false, 'the mirror checks EXTCODEHASH on its own chain too');
  await w.c.putCode(TARGET, CODE1);
  await assert.rejects(oracle.send('x', 'handle', [77390, b32(sender.address), await w.cert.call('certificateBody', [1n, TARGET])]), /NotMailbox/, 'only the Mailbox');
  // revoke on ZETAPHY, push again: the mirror follows (and an older message cannot un-revoke it)
  const text = 'critical bug';
  await w.net.send('a4', 'commitFinding', [id, core.findingCommitment(k, hash(text), 5, hash('poc'), w.A('a4'), salt(5), id)]);
  const fid = (await w.net.call('findingCount')) - 1n;
  const stale = await w.cert.call('certificateBody', [1n, TARGET]);
  await w.net.send('a4', 'revealFinding', [fid, hash(text), 5, hash('poc'), salt(5), '']);
  await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fid, true, 5, fid]);
  await deliver();
  assert.equal(await oracle.call('isCertified', [1n, TARGET]), false, 'revoked there too');
  await dMail.send('x', 'deliver', [77390, b32(sender.address), oracle.address, stale]);
  assert.equal(await oracle.call('isCertified', [1n, TARGET]), false, 'a replayed older message changes nothing');
});
