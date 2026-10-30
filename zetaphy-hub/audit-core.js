// The open audit network (docs/future/audit-network.md): the logic shared by the hub's Audit tab (audit.js),
// the runners' and auditors' CLI (zetaphy-network `zetaphy audit …`, src/auditnet.js) and the tests.
// No DOM, no network; Keccak is passed in (Neuro's keccak256(bytes) -> bytes), so it runs the same in a
// browser and in Node.
//
//   - the contracts' tuples and calldata (AuditNetwork, AuditRunners, AuditJudges, AuditCertificate);
//   - every commitment and key exactly as the contracts compute them;
//   - the pipeline adapter: the JSON `node audit/report.js --json <outdir>` prints, checked strictly,
//     and the CANONICAL result runners hash and must agree on (2 of 3);
//   - Neuro's findings in the pipeline's schema.
import { encodeArgs, decodeArgs, calldata, keccakHex, named, strip } from './work-core.js';

export { calldata, decodeArgs, named, keccakHex };

// ------------------------------------------------------------------ names
export const SEVERITIES = ['', 'info', 'low', 'medium', 'high', 'critical'];
export const sevCode = (name) => {
  const i = SEVERITIES.indexOf(String(name ?? '').toLowerCase());
  if (i < 1) throw new Error(`severity ${name}: one of info, low, medium, high, critical`);
  return i;
};
export const FINDING_STATUS = ['', 'committed', 'revealed', 'valid', 'invalid'];
export const LEVELS = ['', 'bronze', 'silver', 'gold'];
export const TIERS = ['basic', 'standard', 'deep'];
/** AuditCertificate.check reasons (0 = certifiable). */
export const REASONS = ['ok', 'notSettled', 'noAgreement', 'autoCritHigh', 'invariantFailed', 'invariantNotRun', 'contestShort', 'fewAuditors',
  'critHigh', 'undecided', 'appealOpen', 'fixUnconfirmed', 'reclaimed', 'codeChanged', 'codeRevoked', 'already'];
export const K_FINDING = 1, K_REPORT = 2, K_NA = 3, K_FIX = 4;
/** Pipeline finding statuses that still block (critical/high): an accepted risk is still a risk. */
export const BLOCKING = new Set(['open', 'accepted']);

// ------------------------------------------------------------------ tuples (same order as the Solidity structs)
export const TARGET_TUPLE = '(uint64,address,bytes32,bytes32)';
export const REQUEST_FIELDS = ['sponsor', 'chainId', 'createdAt', 'contestEnd', 'tier', 'naDeclared', 'settled', 'reclaimed', 'certified', 'target',
  'minContest', 'minAuditors', 'reports', 'rejected', 'undecided', 'critHigh', 'openAppeals', 'totalWeight', 'certExpiry', 'prev', 'codeHash',
  'sourceHash', 'naReason', 'pool', 'reserve', 'reportSlash', 'uriHash'];
export const REQUEST_TUPLE = '(address,uint64,uint64,uint64,uint8,bool,bool,bool,bool,address,uint32,uint16,uint32,uint32,uint32,uint32,uint32,uint32,uint64,uint64,bytes32,bytes32,bytes32,uint128,uint128,uint128,bytes32)';
export const FINDING_FIELDS = ['req', 'committedAt', 'commitBlock', 'revealedAt', 'decidedAt', 'auditor', 'status', 'claimed', 'sev', 'late', 'paid',
  'appealOpen', 'group', 'slashed', 'commitment', 'findingHash', 'evidenceHash'];
export const FINDING_TUPLE = '(uint64,uint64,uint64,uint64,uint64,address,uint8,uint8,uint8,bool,bool,bool,uint64,uint128,bytes32,bytes32,bytes32)';
export const CERT_FIELDS = ['requestId', 'chainId', 'target', 'codeHash', 'reportHash', 'sourceHash', 'level', 'auditors', 'mutationBps', 'issuedAt',
  'expiresAt', 'revokedAt', 'revokedBy'];
export const CERT_TUPLE = '(uint256,uint64,address,bytes32,bytes32,bytes32,uint8,uint16,uint16,uint64,uint64,uint64,uint256)';
export const RESULT_TYPES = ['bytes32', 'uint32', 'uint32', 'uint32', 'uint16'];
export const RESULT_TUPLE = '(bytes32,uint32,uint32,uint32,uint16)';

/** Function signatures the hub and the CLI call. */
export const SIG = {
  request: `request(${TARGET_TUPLE},uint8,uint32,uint16,uint64,string)`,
  declareNotApplicable: 'declareNotApplicable(uint256,bytes32)',
  bond: 'bond()', requestUnbond: 'requestUnbond()', withdrawBond: 'withdrawBond()',
  commitReport: 'commitReport(uint256,bytes32)', revealReport: 'revealReport(uint256,bytes32,bytes32)',
  commitFinding: 'commitFinding(uint256,bytes32)', revealFinding: 'revealFinding(uint256,bytes32,uint8,bytes32,bytes32,string)',
  settle: 'settle(uint256)', claimFinding: 'claimFinding(uint256)', claimReport: 'claimReport(uint256)', claimSlash: 'claimSlash(uint256)',
  reclaim: 'reclaim(uint256)', withdraw: 'withdraw()',
  requestCount: 'requestCount()', getRequest: 'getRequest(uint256)', findingCount: 'findingCount()', getFinding: 'getFinding(uint256)',
  findingsOf: 'findingsOf(uint256)', carriedOf: 'carriedOf(uint256)', auditors: 'auditors(address)', owed: 'owed(address)', getParams: 'getParams()',
  // AuditJudges
  judgeBond: 'bond()', voteFinding: 'voteFinding(uint256,bool,uint8,uint256)', voteReport: 'voteReport(uint256,address,bool)',
  voteNotApplicable: 'voteNotApplicable(uint256,bool)', voteFixed: 'voteFixed(uint256,uint256,bool)', appeal: 'appeal(uint256)',
  judgeClaim: 'claim(uint256,bytes32[])', judges: 'judges(address)', judgeCount: 'judgeCount()', quorum: 'quorum()',
  // AuditRunners
  runCommit: 'commit(uint256,bytes32)', runReveal: `reveal(uint256,${RESULT_TUPLE},bytes32)`, runSettle: 'settle(uint256)', runResult: 'result(uint256)',
  // AuditCertificate
  certify: 'certify(uint256)', check: 'check(uint256)', certificate: 'certificate(uint64,address)', isCertified: 'isCertified(uint64,address)',
  certCount: 'count()', certKeys: 'keys(uint256)',
};

const STR = (k, s) => keccakHex(k, new TextEncoder().encode(s));

// ------------------------------------------------------------------ commitments and keys (as the contracts compute them)
export const reportCommitment = (k, hash, auditor, salt, id) =>
  keccakHex(k, encodeArgs(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.report', hash, auditor, salt, id]));
export const findingCommitment = (k, findingHash, severity, evidenceHash, auditor, salt, id) =>
  keccakHex(k, encodeArgs(['string', 'bytes32', 'uint8', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.finding', findingHash, severity, evidenceHash, auditor, salt, id]));
/** keccak256(abi.encode(Result)) of the runners' tuple. */
export const resultKey = (k, r) => keccakHex(k, encodeArgs(RESULT_TYPES, [r.resultHash, r.critHigh, r.invFailed, r.invNotRun, r.mutationBps]));
export const runCommitment = (k, r, runner, salt, id) =>
  keccakHex(k, encodeArgs(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.run', resultKey(k, r), runner, salt, id]));
export const itemKey = (k, kind, a, b = 0n) => keccakHex(k, encodeArgs(['string', 'uint8', 'uint256', 'uint256'], ['zetaphy.audit.item', kind, a, b]));
export const findingOutcome = (k, valid, sev, group) => keccakHex(k, encodeArgs(['bool', 'uint8', 'uint256'], [valid, valid ? sev : 0, group]));
export const yesNo = (k, v) => keccakHex(k, encodeArgs(['bool'], [!!v]));
export const certKey = (k, chainId, target) => keccakHex(k, encodeArgs(['uint64', 'address'], [chainId, target]));
/** The hash a finding document is committed under (the text of the finding, as UTF-8). */
export const docHash = (k, text) => STR(k, String(text));

// ------------------------------------------------------------------ decoding views
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
export function decodeRequest(hex) {
  const [t] = decodeArgs([REQUEST_TUPLE], hex);
  const r = named(REQUEST_FIELDS, t);
  for (const f of ['chainId', 'createdAt', 'contestEnd', 'certExpiry', 'prev', 'pool', 'reserve', 'reportSlash']) r[f] = big(r[f]);
  for (const f of ['tier', 'minContest', 'minAuditors', 'reports', 'rejected', 'undecided', 'critHigh', 'openAppeals', 'totalWeight']) r[f] = Number(r[f]);
  return r;
}
export function decodeFinding(hex) {
  const [t] = decodeArgs([FINDING_TUPLE], hex);
  const f = named(FINDING_FIELDS, t);
  for (const x of ['req', 'committedAt', 'commitBlock', 'revealedAt', 'decidedAt', 'group', 'slashed']) f[x] = big(f[x]);
  for (const x of ['status', 'claimed', 'sev']) f[x] = Number(f[x]);
  return f;
}
/** certificate(chainId, target) -> { cert, valid } (cert.issuedAt 0n: none). */
export function decodeCertificate(hex) {
  const [t, valid] = decodeArgs([CERT_TUPLE, 'bool'], hex);
  const c = named(CERT_FIELDS, t);
  for (const x of ['requestId', 'chainId', 'issuedAt', 'expiresAt', 'revokedAt', 'revokedBy']) c[x] = big(c[x]);
  for (const x of ['level', 'auditors', 'mutationBps']) c[x] = Number(c[x]);
  return { cert: c, valid: !!valid };
}
/** What a certificate says, in plain states: none | valid | expired | revoked | changed (code differs now). */
export function certState({ cert, valid }, nowSec) {
  if (!cert || big(cert.issuedAt) === 0n) return 'none';
  if (valid) return 'valid';
  if (big(cert.revokedAt) !== 0n || big(cert.revokedBy) !== 0n) return 'revoked';
  if (BigInt(Math.floor(nowSec)) >= big(cert.expiresAt)) return 'expired';
  return 'changed'; // EXTCODEHASH differs (upgrade / redeploy) or the code hash was revoked elsewhere
}

/** The phase of a request at `now` (seconds): contest | reveal | judging | appeal | settle | settled. */
export function phaseOf(r, now, p) {
  const t = BigInt(Math.floor(now));
  if (r.settled) return 'settled';
  const ce = big(r.contestEnd);
  if (t < ce) return 'contest';
  if (t < ce + BigInt(p.revealWindow)) return 'reveal';
  if (t < ce + BigInt(p.revealWindow) + BigInt(p.judgeWindow)) return 'judging';
  if (t < ce + BigInt(p.revealWindow) + BigInt(p.judgeWindow) + BigInt(p.appealWindow)) return 'appeal';
  return 'settle';
}
export const PARAM_FIELDS = ['minContest', 'maxContest', 'revealWindow', 'judgeWindow', 'appealWindow', 'appealTimeout', 'unbondDelay', 'minAuditorsFloor',
  'slashBps', 'feeBps', 'runnerBps', 'participationBps', 'maxFindingsPerAuditor', 'auditorBond', 'minPool'];
export const PARAM_TUPLE = '(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint16,uint16,uint16,uint128,uint128)';
export function decodeParams(hex) {
  const [t] = decodeArgs([PARAM_TUPLE], hex);
  const p = named(PARAM_FIELDS, t);
  for (const f of PARAM_FIELDS) p[f] = f === 'auditorBond' || f === 'minPool' ? big(p[f]) : Number(p[f]);
  return p;
}

// ------------------------------------------------------------------ canonical JSON (sorted keys; same as llmreview.js)
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((x) => v[x] !== undefined).map((x) => `${JSON.stringify(x)}:${canonical(v[x])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ------------------------------------------------------------------ the pipeline adapter
const HASH = /^0x[0-9a-fA-F]{64}$/;
const STATUSES = new Set(['open', 'fixed', 'false-positive', 'accepted']);
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000;

/**
 * Checks the JSON `node audit/report.js --json <outdir>` prints, strictly: anything malformed is refused
 * (a runner must not hash a half-read report). Returns a normalised copy.
 *   { commit, codeHashes: {contract: 0x…}, findings: [{id, tool, rule, severity, file, line, title, status}],
 *     invariants: {passed, failed, notRun}, mutationScore }
 */
export function validatePipeline(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('pipeline: not a JSON object');
  if (typeof j.commit !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(j.commit)) throw new Error('pipeline: commit must be a git hash');
  if (!j.codeHashes || typeof j.codeHashes !== 'object' || Array.isArray(j.codeHashes)) throw new Error('pipeline: codeHashes must be {contract: 0x…}');
  const codeHashes = {};
  for (const [name, h] of Object.entries(j.codeHashes)) {
    if (!/^[A-Za-z0-9_$./:-]{1,200}$/.test(name) || !HASH.test(String(h))) throw new Error(`pipeline: codeHashes.${name} is not a 32-byte hash`);
    codeHashes[name] = String(h).toLowerCase();
  }
  if (!Array.isArray(j.findings) || j.findings.length > 10_000) throw new Error('pipeline: findings must be an array');
  const ids = new Set();
  const findings = j.findings.map((f, i) => {
    const at = `pipeline: findings[${i}]`;
    if (!f || typeof f !== 'object') throw new Error(`${at}: not an object`);
    for (const key of ['id', 'tool', 'rule', 'file', 'title']) if (typeof f[key] !== 'string' || f[key].length > 2000) throw new Error(`${at}.${key}: a string`);
    if (!f.id || ids.has(f.id)) throw new Error(`${at}.id: empty or repeated (${f.id})`);
    ids.add(f.id);
    if (SEVERITIES.indexOf(String(f.severity ?? '').toLowerCase()) < 1) throw new Error(`${at}.severity: one of info, low, medium, high, critical`);
    if (!STATUSES.has(f.status)) throw new Error(`${at}.status: one of open, fixed, false-positive, accepted`);
    if (!(Number.isInteger(f.line) && f.line >= 0)) throw new Error(`${at}.line: a whole number`);
    return { id: f.id, tool: f.tool, rule: f.rule, severity: String(f.severity).toLowerCase(), file: f.file, line: f.line, title: f.title, status: f.status };
  });
  const inv = j.invariants;
  if (!inv || !isCount(inv.passed) || !isCount(inv.failed) || !isCount(inv.notRun)) throw new Error('pipeline: invariants must be {passed, failed, notRun} counts');
  let ms = j.mutationScore;
  if (ms == null) ms = 0;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 100) throw new Error('pipeline: mutationScore must be 0..1 or 0..100');
  const mutationBps = Math.round((ms <= 1 ? ms * 10_000 : ms * 100));
  return { commit: j.commit.toLowerCase(), codeHashes, findings, invariants: { passed: inv.passed, failed: inv.failed, notRun: inv.notRun }, mutationBps };
}

/** Neuro's rules findings as pipeline findings (tool "neuro"); sim-* (trade simulation) left out, as in verdicts. */
export function neuroFindings(report) {
  const map = { high: 'high', medium: 'medium', low: 'low', info: 'info', good: 'info', critical: 'critical' };
  return (report?.analysis?.findings ?? []).filter((f) => f && typeof f.id === 'string' && !f.id.startsWith('sim-')).map((f) => ({
    id: `neuro:${f.id}`, tool: 'neuro', rule: f.id, severity: map[String(f.severity).toLowerCase()] ?? 'info', file: '', line: 0, title: String(f.title ?? f.id).slice(0, 200), status: 'open',
  }));
}

/**
 * The canonical result of one audit run: what runners hash and must agree on. Volatile text (titles,
 * timings, paths of the run) is left out; findings are sorted. A pipeline finding with the same id as a
 * Neuro one ("neuro:<rule>", e.g. triaged in audit/triage.yml) decides that Neuro finding's status.
 */
export function canonicalResult({ chainId, target, codeHash, sourceHash, pipeline, neuro = null }) {
  const p = validatePipeline(pipeline);
  const triaged = new Map(p.findings.map((f) => [f.id, f.status]));
  const nf = (neuro?.findings ?? []).filter((f) => !triaged.has(f.id));
  const all = [...p.findings, ...nf].map((f) => ({ id: f.id, tool: f.tool, rule: f.rule, severity: f.severity, file: f.file, line: f.line, status: f.status }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    kind: 'zetaphy-audit-result', v: 1,
    chainId: Number(chainId), target: String(target).toLowerCase(), codeHash: String(codeHash).toLowerCase(), sourceHash: String(sourceHash).toLowerCase(),
    commit: p.commit, codeHashes: p.codeHashes, findings: all, invariants: p.invariants, mutationBps: p.mutationBps,
    neuro: neuro ? { verdict: String(neuro.verdict ?? '').toLowerCase() } : null,
  };
}

/** The runners' tuple for AuditRunners.commit/reveal: (resultHash, open critical+high, invariants failed, not run, mutation bps). */
export function resultTuple(k, body) {
  const resultHash = keccakHex(k, new TextEncoder().encode(canonical(body)));
  const critHigh = body.findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && BLOCKING.has(f.status)).length;
  return { resultHash, critHigh, invFailed: body.invariants.failed, invNotRun: body.invariants.notRun, mutationBps: Math.min(10_000, body.mutationBps) };
}

/** Hex helper: 0x-prefixed 32-byte value. */
export const isHash = (h) => HASH.test(String(h));
export const lc = (a) => String(a).toLowerCase();
export const stripHex = strip;
