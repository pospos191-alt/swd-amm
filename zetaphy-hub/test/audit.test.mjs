// The Audit tab's logic (audit-core.js) against ethers and the compiled contracts' ABI: calldata, return-data
// decoding, commitments, the pipeline adapter's canonical result; the tab's words in 8 languages; the tab is wired
// (TABS, TAB_TEXT, FLOWS, build files, hub-config contracts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, AbiCoder, keccak256, toUtf8Bytes, id as ethId } from 'ethers';
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';
import * as core from '../audit-core.js';
import { AUDIT } from '../audit-i18n.js';
import { LANG_CODES, TAB_TEXT } from '../i18n.js';
import { FLOW } from '../flow-i18n.js';
import { FLOWS } from '../flow.js';
import { hubConfig } from '../build.mjs';

const k = neuroKeccak;
const art = (n) => JSON.parse(readFileSync(new URL(`../../zetaphy-network/artifacts/${n}.json`, import.meta.url), 'utf8'));
const NET = new Interface(art('AuditNetwork').abi);
const RUN = new Interface(art('AuditRunners').abi);
const JUD = new Interface(art('AuditJudges').abi);
const CERT = new Interface(art('AuditCertificate').abi);
const abi = AbiCoder.defaultAbiCoder();
const A = '0x' + 'be'.repeat(20), H = '0x' + '11'.repeat(32), S = '0x' + '22'.repeat(32);

test('calldata: every signature the hub and the CLI send is in the contracts\' ABI, encoded as ethers encodes it', () => {
  const sigs = { [core.SIG.request]: NET, [core.SIG.commitFinding]: NET, [core.SIG.revealFinding]: NET, [core.SIG.commitReport]: NET, [core.SIG.revealReport]: NET,
    [core.SIG.bond]: NET, [core.SIG.getRequest]: NET, [core.SIG.getFinding]: NET, [core.SIG.findingsOf]: NET, [core.SIG.getParams]: NET, [core.SIG.requestCount]: NET,
    [core.SIG.voteFinding]: JUD, [core.SIG.appeal]: JUD, [core.SIG.judgeClaim]: JUD, [core.SIG.runCommit]: RUN, [core.SIG.runReveal]: RUN, [core.SIG.runResult]: RUN,
    [core.SIG.certify]: CERT, [core.SIG.check]: CERT, [core.SIG.certificate]: CERT, [core.SIG.isCertified]: CERT };
  for (const [sig, iface] of Object.entries(sigs)) assert.ok(iface.getFunction(sig), sig);
  // a static tuple first, then a string: the head must count the tuple's 4 words
  const args = [[77390n, A, H, S], 1, 7 * 86400, 3, 0n, 'ipfs://scope'];
  assert.equal(core.calldata(k, core.SIG.request, args), NET.encodeFunctionData('request', [{ chainId: 77390n, target: A, codeHash: H, sourceHash: S }, 1, 7 * 86400, 3, 0n, 'ipfs://scope']));
  const r = { resultHash: H, critHigh: 0, invFailed: 1, invNotRun: 2, mutationBps: 8300 };
  assert.equal(core.calldata(k, core.SIG.runReveal, [5n, [r.resultHash, r.critHigh, r.invFailed, r.invNotRun, r.mutationBps], S]), RUN.encodeFunctionData('reveal', [5n, r, S]));
  assert.equal(core.calldata(k, core.SIG.revealFinding, [3n, H, 4, S, H, 'ipfs://x']), NET.encodeFunctionData('revealFinding', [3n, H, 4, S, H, 'ipfs://x']));
});

test('return data: requests, findings, certificates and the runners\' result decode as the contracts return them', () => {
  const req = ['0x' + 'aa'.repeat(20), 77390n, 100n, 200n, 2, true, false, false, true, A, 604800, 3, 4, 1, 0, 0, 0, 13, 999n, 0n, H, S, '0x' + '00'.repeat(32), 10n ** 20n, 5n, 0n, H];
  const r = core.decodeRequest(NET.encodeFunctionResult('getRequest', [req]));
  assert.deepEqual([r.chainId, r.tier, r.naDeclared, r.certified, r.minAuditors, r.reports, r.rejected, r.totalWeight, r.certExpiry, r.pool, r.target], [77390n, 2, true, true, 3, 4, 1, 13, 999n, 10n ** 20n, A]);
  const f = core.decodeFinding(NET.encodeFunctionResult('getFinding', [[7n, 1n, 2n, 3n, 4n, A, 3, 5, 4, true, false, false, 6n, 9n, H, S, H]]));
  assert.deepEqual([f.req, f.auditor, f.status, f.claimed, f.sev, f.late, f.group, f.slashed], [7n, A, 3, 5, 4, true, 6n, 9n]);
  const cert = [3n, 77390n, A, H, S, H, 2, 5, 9100, 1000n, 2000n, 0n, 0n];
  const d = core.decodeCertificate(CERT.encodeFunctionResult('certificate', [cert, true]));
  assert.equal(d.valid, true, 'the bool after a static tuple');
  assert.deepEqual([d.cert.level, d.cert.auditors, d.cert.mutationBps, d.cert.expiresAt], [2, 5, 9100, 2000n]);
  assert.equal(core.certState(d, 1500), 'valid');
  assert.equal(core.certState(core.decodeCertificate(CERT.encodeFunctionResult('certificate', [cert, false])), 2500), 'expired');
  assert.equal(core.certState(core.decodeCertificate(CERT.encodeFunctionResult('certificate', [[...cert.slice(0, 11), 1500n, 8n], false])), 1600), 'revoked');
  assert.equal(core.certState(core.decodeCertificate(CERT.encodeFunctionResult('certificate', [cert, false])), 1500), 'changed');
  const [agreed, res] = core.decodeArgs(['bool', core.RESULT_TUPLE], RUN.encodeFunctionResult('result', [true, { resultHash: H, critHigh: 1, invFailed: 0, invNotRun: 2, mutationBps: 7000 }]));
  assert.deepEqual([agreed, res[1], res[3], res[4]], [true, 1n, 2n, 7000n]);
  const p = core.decodeParams(NET.encodeFunctionResult('getParams', [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14n, 15n]]));
  assert.deepEqual([p.minContest, p.revealWindow, p.maxFindingsPerAuditor, p.auditorBond, p.minPool], [1, 3, 13, 14n, 15n]);
  assert.equal(core.phaseOf({ settled: false, contestEnd: 100n }, 50, { revealWindow: 10, judgeWindow: 10, appealWindow: 10 }), 'contest');
  assert.equal(core.phaseOf({ settled: false, contestEnd: 100n }, 115, { revealWindow: 10, judgeWindow: 10, appealWindow: 10 }), 'judging');
  assert.equal(core.phaseOf({ settled: false, contestEnd: 100n }, 135, { revealWindow: 10, judgeWindow: 10, appealWindow: 10 }), 'settle');
});

test('commitments and keys as the contracts compute them (abi.encode with a domain string)', () => {
  assert.equal(core.reportCommitment(k, H, A, S, 4n), keccak256(abi.encode(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.report', H, A, S, 4n])));
  assert.equal(core.findingCommitment(k, H, 5, S, A, H, 4n), keccak256(abi.encode(['string', 'bytes32', 'uint8', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.finding', H, 5, S, A, H, 4n])));
  const r = { resultHash: H, critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 9000 };
  const rk = keccak256(abi.encode(['bytes32', 'uint32', 'uint32', 'uint32', 'uint16'], [H, 0, 0, 0, 9000]));
  assert.equal(core.resultKey(k, r), rk);
  assert.equal(core.runCommitment(k, r, A, S, 1n), keccak256(abi.encode(['string', 'bytes32', 'address', 'bytes32', 'uint256'], ['zetaphy.audit.run', rk, A, S, 1n])));
  assert.equal(core.itemKey(k, 1, 9n), keccak256(abi.encode(['string', 'uint8', 'uint256', 'uint256'], ['zetaphy.audit.item', 1, 9n, 0n])));
  assert.equal(core.findingOutcome(k, false, 4, 9n), keccak256(abi.encode(['bool', 'uint8', 'uint256'], [false, 0, 9n])), 'an invalid outcome ignores the severity');
  assert.equal(core.docHash(k, 'a finding'), keccak256(toUtf8Bytes('a finding')));
  assert.equal(core.SIG.certificate, 'certificate(uint64,address)');
  assert.equal(ethId(core.SIG.certificate).slice(0, 10), '0xa5e5358f', 'the explorer badge uses this selector');
});

test('pipeline adapter: strict schema, canonical result independent of order and titles', () => {
  const p = JSON.parse(readFileSync(new URL('../../zetaphy-network/test/fixtures/audit-report.json', import.meta.url), 'utf8'));
  const v = core.validatePipeline(p);
  assert.equal(v.mutationBps, 8300);
  assert.equal(core.validatePipeline({ ...p, mutationScore: 61.5 }).mutationBps, 6150, 'a percentage works too');
  const body = core.canonicalResult({ chainId: 77390, target: A, codeHash: H, sourceHash: S, pipeline: p });
  const t = core.resultTuple(k, body);
  assert.equal(t.critHigh, 0, 'the high is fixed');
  assert.equal(t.resultHash, core.resultTuple(k, core.canonicalResult({ chainId: 77390, target: A.toUpperCase().replace('0X', '0x'), codeHash: H, sourceHash: S, pipeline: { ...p, findings: [...p.findings].reverse().map((f) => ({ ...f, title: 'x' })) } })).resultHash);
  for (const bad of [null, [], { ...p, codeHashes: { a: '0x12' } }, { ...p, findings: [{ ...p.findings[0], line: -1 }] }, { ...p, mutationScore: 101 }]) assert.throws(() => core.validatePipeline(bad), /pipeline/);
});

test('the Audit tab in 8 languages, wired into the hub', () => {
  const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([x, y]) => shape(y, `${at}/${x}`)) : [`${at}:${typeof v}`]);
  assert.deepEqual(Object.keys(AUDIT).sort(), [...LANG_CODES].sort());
  const en = shape(AUDIT.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(AUDIT[l]), en, `AUDIT.${l}`);
    assert.equal(TAB_TEXT[l].audit?.length, 3, `${l}: tab text`);
    assert.equal(FLOW[l]?.steps?.audit?.length ?? FLOW.en.steps.audit.length, FLOWS.audit.icons.length, `${l}: how it works`);
    assert.match(AUDIT[l].detailTitle, /\{id\}/, `${l}: placeholder`);
    for (const x of ['ch', 'f', 'n', 'm']) assert.ok(AUDIT[l].autoLine.includes(`{${x}}`), `${l}: autoLine {${x}}`);
    assert.deepEqual(Object.keys(AUDIT[l].reasons), core.REASONS, `${l}: every certificate reason`);
    if (l !== 'en') assert.notEqual(AUDIT[l].meaning, AUDIT.en.meaning, `${l}: translated`);
  }
  for (const l of LANG_CODES) assert.match(AUDIT[l].meaning, /X/, `${l}: the certificate's limits are stated`);
  const hub = readFileSync(new URL('../hub.js', import.meta.url), 'utf8');
  assert.match(hub, /\{ id: 'audit', page: true/);
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  for (const f of ['audit.js', 'audit-core.js', 'audit-i18n.js']) assert.ok(build.includes(`'${f}'`), `${f} shipped`);
  const cfg = hubConfig({ node: '' }, { 'zetaphy-network/deployments/audit-77390.json': { chainId: 77390, contracts: { auditNetwork: A, auditCertificate: A.replace('be', 'ce') } } });
  assert.equal(cfg.contracts.auditNetwork, A);
  assert.ok(cfg.contracts.auditCertificate);
  for (const f of ['audit.js', 'audit-core.js']) assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /style=|innerHTML/, `${f}: CSP-safe`);
});
