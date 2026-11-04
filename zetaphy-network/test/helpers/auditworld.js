// The open audit network deployed on an in-memory chain, with the steps of a request (the same flow as
// test/auditnet.test.js): used by the vaccine, security-score and self-audit tests.
import { readFileSync } from 'node:fs';
import { getCreateAddress, keccak256, ZeroAddress } from 'ethers';
import solc from 'solc';
import { createChain, ZETA } from './evm.js';
import { workMocks } from './workmocks.js';
import { k, core, codeHashOf } from '../../src/auditnet.js';

export const DAY = 86400;
export const PARAMS = {
  minContest: 3 * DAY, maxContest: 30 * DAY, revealWindow: DAY, judgeWindow: 2 * DAY, appealWindow: 2 * DAY, appealTimeout: 7 * DAY,
  unbondDelay: DAY, minAuditorsFloor: 2, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000, maxFindingsPerAuditor: 5,
  auditorBond: 10n * ZETA, minPool: ZETA,
};
export const JPARAMS = { judgeQuorum: 3, maxJudges: 9, judgeMinScore: 0, unbondDelay: DAY, judgeBond: 20n * ZETA, appealBond: 5n * ZETA };
export const LEVELS = { validity: 30 * DAY, silverAuditors: 3, goldAuditors: 5, silverContest: 7 * DAY, goldContest: 14 * DAY, silverMutationBps: 7000, goldMutationBps: 8500 };
export const SRC = '0x' + '5c'.repeat(32);
export const salt = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const hash = (s) => keccak256(new TextEncoder().encode(s));
export const GOOD = { resultHash: hash('result v1'), critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 9000 };
export { codeHashOf, ZETA };

const kits = new Map();
/** Compiles a helpers/*.sol test kit: { name: { abi, bytecode, runtime } }. */
export function kit(file) {
  if (kits.has(file)) return kits.get(file);
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const r = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object }]));
  kits.set(file, r);
  return r;
}

/**
 * AuditNetwork + AuditRunners + AuditJudges + AuditCertificate (governance: `gov`), auditors a1..a6 bonded, judges
 * j1..j5 bonded, runners r1..r4 (MockRunners). `chain`: an existing createChain() whose accounts include these names.
 */
export async function auditWorld({ chain = null, extra = [], chainId } = {}) {
  const names = ['gov', 'treasury', 'sponsor', 'x', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'j1', 'j2', 'j3', 'j4', 'j5', 'r1', 'r2', 'r3', 'r4', ...extra];
  const c = chain ?? await createChain(names, {}, chainId ? { chainId } : {});
  const A = (n) => c.acct[n].toString();
  const m = workMocks();
  const jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3', 'r4']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const rep = await c.deploy('WorkerReputation', [A('gov'), jobs.address, ZeroAddress], 'gov');
  const n = await c.nonce('gov');
  const at = (i) => getCreateAddress({ from: A('gov'), nonce: n + BigInt(i) });
  const net = await c.deploy('AuditNetwork', [A('gov'), A('treasury'), rep.address, at(1), at(2), at(3), PARAMS], 'gov');
  const run = await c.deploy('AuditRunners', [net.address, jobs.address, rep.address, 1], 'gov');
  const jud = await c.deploy('AuditJudges', [net.address, rep.address, A('gov'), JPARAMS], 'gov');
  const cert = await c.deploy('AuditCertificate', [net.address, run.address, jud.address, A('gov'), LEVELS], 'gov');
  await rep.send('gov', 'setReporter', [net.address, true]);
  await rep.send('gov', 'setReporter', [run.address, true]);
  for (const a of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) await net.send(a, 'bond', [], 10n * ZETA);
  for (const j of ['j1', 'j2', 'j3', 'j4', 'j5']) await jud.send(j, 'bond', [], 20n * ZETA);
  const w = { c, A, jobs, rep, net, run, jud, cert, chainId: chainId ?? 1 };
  return w;
}

export async function request(w, { target, codeHash, tier = 0, contest = 3 * DAY, minAuditors = 2, prev = 0n, value = 11n * ZETA, chainId = BigInt(w.chainId), sponsor = 'sponsor' }) {
  await w.net.send(sponsor, 'request', [{ chainId, target, codeHash, sourceHash: SRC }, tier, contest, minAuditors, prev, 'ipfs://scope'], value);
  return (await w.net.call('requestCount')) - 1n;
}

export async function contest(w, id, { auditors = ['a1', 'a2'], findings = [] } = {}) {
  for (const a of auditors) await w.net.send(a, 'commitReport', [id, core.reportCommitment(k, hash(`report ${a}`), w.A(a), salt(1), id)]);
  const fids = [];
  for (const [i, f] of findings.entries()) {
    const cm = core.findingCommitment(k, hash(f.text), f.sev, hash(`poc ${f.text}`), w.A(f.who), salt(100 + i), id);
    await w.net.send(f.who, 'commitFinding', [id, cm]);
    fids.push((await w.net.call('findingCount')) - 1n);
  }
  return fids;
}

export async function runnersCommit(w, id, results = [GOOD, GOOD, GOOD], who = ['r1', 'r2', 'r3']) {
  for (const [i, r] of who.entries()) if (results[i]) await w.run.send(r, 'commit', [id, core.runCommitment(k, results[i], w.A(r), salt(7), id)]);
}
export async function runnersReveal(w, id, results = [GOOD, GOOD, GOOD], who = ['r1', 'r2', 'r3']) {
  for (const [i, r] of who.entries()) if (results[i]) await w.run.send(r, 'reveal', [id, results[i], salt(7)]);
}

export async function reveal(w, id, { auditors = ['a1', 'a2'], findings = [], fids = [] } = {}) {
  for (const a of auditors) await w.net.send(a, 'revealReport', [id, hash(`report ${a}`), salt(1)]);
  for (const [i, f] of findings.entries()) await w.net.send(f.who, 'revealFinding', [fids[i], hash(f.text), f.sev, hash(`poc ${f.text}`), salt(100 + i), 'ipfs://finding']);
}

export async function vote(w, judges, fn, args) { for (const j of judges) await w.jud.send(j, fn, args); }

/**
 * Request -> contest -> reveals -> runners -> decisions -> (beforeSettle) -> settle. decide: [{ valid, sev }].
 * settle: false stops right after the decisions (inside the appeal window).
 */
export async function fullRound(w, { target, codeHash, findings = [], decide = [], auditors = ['a1', 'a2'], results, beforeSettle, settle = true, chainId } = {}) {
  const id = await request(w, { target, codeHash, ...(chainId ? { chainId } : {}) });
  const fids = await contest(w, id, { auditors, findings });
  await runnersCommit(w, id, results);
  w.c.advance(3 * DAY);
  await reveal(w, id, { auditors, findings, fids });
  await runnersReveal(w, id, results);
  for (const [i, d] of decide.entries()) if (d) await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fids[i], d.valid, d.sev ?? 0, fids[i]]);
  if (beforeSettle) await beforeSettle(id, fids);
  if (!settle) return { id, fids };
  w.c.advance(DAY + 2 * DAY + 2 * DAY);
  await w.run.send('x', 'settle', [id]);
  await w.net.send('x', 'settle', [id]);
  return { id, fids };
}

/** A post-certificate finding by `who`, revealed and judged (valid with `sev`, or invalid). -> finding id */
export async function lateFinding(w, id, { who = 'a3', sev = 5, text = 'post-certificate bug', valid = true, n = 5 } = {}) {
  await w.net.send(who, 'commitFinding', [id, core.findingCommitment(k, hash(text), sev, hash('poc'), w.A(who), salt(n), id)]);
  const fid = (await w.net.call('findingCount')) - 1n;
  await w.net.send(who, 'revealFinding', [fid, hash(text), sev, hash('poc'), salt(n), 'ipfs://late']);
  if (valid != null) await vote(w, ['j1', 'j2', 'j3'], 'voteFinding', [fid, valid, valid ? sev : 0, fid]);
  return fid;
}
