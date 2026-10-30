// Tests for the report merger, the finding ids and the triage rules.
//   node --test audit/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTriage, applyTriage } from '../lib/triage.js';
import {
  fingerprint, assignIds, dedupe, parseSlither, parseAderyn, parseSemgrep, parseSmt, parseGosec, parseStaticcheck,
  parseGovulncheck, parseNpmAudit, parseOsv, stripLines, checkedArithmetic,
} from '../lib/findings.js';
import { collect, toJson, toMarkdown, toSarif } from '../report.js';
import { patchedLines } from '../tools/zetaphy-lines.js';
import { mutants, spread, stripMetadata } from '../tools/mutate.js';
import { countLoc, resolveImport } from '../lib/scope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, '..', 'report.js');

// ---------------------------------------------------------------- triage.yml

test('triage.yml: entries, quoting, folded reasons, comments', () => {
  const { entries, errors } = parseTriage(`
# comment
findings:
  - id: slither:reentrancy-eth:a.sol:0123456789ab
    status: false-positive
    reason: "the lock modifier blocks re-entry # not a comment"
    decided_by: owner   # who
    date: 2026-10-30
  - id: 'aderyn:x:b.sol:abcdefabcdef'
    status: accepted-risk
    reason: >
      the owner keeps this power on purpose,
      and the docs say so
    decided_by: pospos191
`);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].reason, 'the lock modifier blocks re-entry # not a comment');
  assert.equal(entries[0].decided_by, 'owner');
  assert.equal(entries[1].id, 'aderyn:x:b.sol:abcdefabcdef');
  assert.equal(entries[1].reason, 'the owner keeps this power on purpose, and the docs say so');
});

test('triage.yml: an empty list is valid', () => {
  assert.deepEqual(parseTriage('findings:\n').errors, []);
  assert.deepEqual(parseTriage('# nothing yet\nfindings: []\n').entries, []);
});

test('triage.yml: bad status, missing reason / decider, duplicates are errors', () => {
  const { errors } = parseTriage(`findings:
  - id: a:b:c:1
    status: wontfix
    reason: a long enough reason here
    decided_by: x
  - id: a:b:c:2
    status: false-positive
    reason: short
  - id: a:b:c:2
    status: fixed
    reason: fixed in the commit that adds the check
    decided_by: y
`);
  assert.ok(errors.some((e) => /status must be one of/.test(e)));
  assert.ok(errors.some((e) => /concrete reason/.test(e)));
  assert.ok(errors.some((e) => /decided_by/.test(e)));
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
});

test('applyTriage: open by default, decisions applied, "fixed" but still there is open, stale entries listed', () => {
  const f = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const stale = applyTriage(f, [
    { id: 'b', status: 'false-positive', reason: 'r', decided_by: 'x' },
    { id: 'c', status: 'fixed', reason: 'r', decided_by: 'x' },
    { id: 'gone', status: 'fixed', reason: 'r', decided_by: 'x' },
  ]);
  assert.equal(f[0].status, 'open');
  assert.equal(f[1].status, 'false-positive');
  assert.equal(f[2].status, 'open');
  assert.match(f[2].note, /still detected/);
  assert.deepEqual(stale.map((e) => e.id), ['gone']);
});

// ---------------------------------------------------------------- ids

test('fingerprint: moving a finding to another line keeps its id; editing the flagged line changes it', () => {
  const a = fingerprint({ tool: 'slither', rule: 'r', file: 'x.sol', lineText: '  a = b + c;', detail: 'X.f() (x.sol#12) does a thing' });
  const b = fingerprint({ tool: 'slither', rule: 'r', file: 'x.sol', lineText: 'a = b +   c;', detail: 'X.f() (x.sol#40-44) does a thing' });
  const c = fingerprint({ tool: 'slither', rule: 'r', file: 'x.sol', lineText: 'a = b - c;', detail: 'X.f() (x.sol#12) does a thing' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^slither:r:x\.sol:[0-9a-f]{12}$/);
  assert.equal(stripLines('see (contracts/A.sol#L3-L9) and /tmp/w/evmd/a.go:12:3'), 'see (contracts/A.sol) and a.go');
});

test('assignIds: identical findings in one file are numbered in line order', () => {
  const list = [
    { tool: 't', rule: 'r', file: 'f.sol', line: 20, detail: 'd' },
    { tool: 't', rule: 'r', file: 'f.sol', line: 10, detail: 'd' },
  ];
  assignIds(list, () => 'same text');
  assert.ok(list[1].id.endsWith(list[0].id.split(':').pop().split('#')[0]));
  assert.ok(!list[1].id.includes('#'));
  assert.ok(list[0].id.endsWith('#2'));
});

test('dedupe drops the same issue reported by two overlapping runs', () => {
  const x = { tool: 't', rule: 'r', file: 'f', line: 1, detail: 'A (f#1)' };
  assert.equal(dedupe([x, { ...x, detail: 'A (f#1)' }, { ...x, line: 2 }]).length, 2);
});

// ---------------------------------------------------------------- parsers

test('slither: impact/confidence to severity, paths prefixed, excluded and vendored files dropped', () => {
  const det = (check, impact, confidence, file) => ({ check, impact, confidence, description: `${check} in ${file}`, elements: [{ source_mapping: { filename_relative: file, lines: [7, 8] } }] });
  const out = parseSlither({ results: { detectors: [
    det('reentrancy-eth', 'High', 'Medium', 'contracts/A.sol'),
    det('weak-prng', 'High', 'Low', 'contracts/A.sol'),
    det('divide-before-multiply', 'Medium', 'Medium', 'contracts/A.sol'),
    det('naming-convention', 'Informational', 'High', 'contracts/A.sol'),
    det('reentrancy-eth', 'High', 'High', 'contracts/Mock.sol'),
    det('reentrancy-eth', 'High', 'High', 'vendor/@openzeppelin/contracts/x.sol'),
  ] } }, 'proj', (f) => f === 'contracts/Mock.sol');
  assert.deepEqual(out.map((f) => f.severity), ['high', 'medium', 'medium', 'info']);
  assert.equal(out[0].file, 'proj/contracts/A.sol');
  assert.equal(out[0].line, 7);
});

test('aderyn: high/low issues, one finding per instance', () => {
  const out = parseAderyn({
    high_issues: { issues: [{ detector_name: 'unsafe-casting', title: 'Unsafe Casting', instances: [{ contract_path: 'contracts/A.sol', line_no: 3 }, { contract_path: 'contracts/T.sol', line_no: 4 }] }] },
    low_issues: { issues: [{ detector_name: 'costly-loop', title: 'Costly', instances: [{ contract_path: 'contracts/A.sol', line_no: 9 }] }] },
  }, 'p', (f) => f === 'contracts/T.sol');
  assert.deepEqual(out.map((f) => [f.severity, f.rule, f.file, f.line]), [['high', 'unsafe-casting', 'p/contracts/A.sol', 3], ['low', 'costly-loop', 'p/contracts/A.sol', 9]]);
});

test('semgrep: rule metadata impact/confidence first, then the rule severity', () => {
  const r = (id, extra) => ({ check_id: `x.y.solidity.security.${id}`, path: 'p/contracts/A.sol', start: { line: 5 }, extra });
  const out = parseSemgrep({ results: [
    r('a', { severity: 'ERROR', message: 'm', metadata: { impact: 'HIGH', confidence: 'HIGH' } }),
    r('b', { severity: 'ERROR', message: 'm', metadata: { impact: 'HIGH', confidence: 'LOW' } }),
    r('c', { severity: 'WARNING', message: 'm', metadata: {} }),
  ] }, () => false);
  assert.deepEqual(out.map((f) => [f.rule, f.severity]), [['a', 'high'], ['b', 'medium'], ['c', 'medium']]);
});

test('SMTChecker: a counterexample is a finding, "might happen" (unproved) is info, summaries are not findings', () => {
  const { findings, unproved } = parseSmt({ results: [{ file: 'p/contracts/A.sol', root: 'p', messages: [
    { code: '6328', message: 'CHC: Assertion violation happens here.\nCounterexample:\nx = 1', file: 'contracts/A.sol', line: 10 },
    { code: '4984', message: 'CHC: Overflow (resulting value larger than 2**256 - 1) happens here.', file: 'contracts/A.sol', line: 11 },
    { code: '8065', message: 'BMC: Overflow (resulting value larger than 2**256 - 1) might happen here.', file: 'contracts/A.sol', line: 12 },
    { code: '5840', message: 'CHC: 3 verification condition(s) could not be proved. Enable the model checker option "show unproved"', file: null, line: null },
  ] }] });
  assert.deepEqual(findings.map((f) => [f.rule, f.severity]), [['assertion-violation', 'high'], ['overflow', 'low'], ['overflow', 'info']]);
  assert.match(findings[0].counterexample, /x = 1/);
  assert.equal(unproved.length, 1);
});

test('gosec / staticcheck: only lines the ZETAPHY patches added', () => {
  const zl = { 'evmd/zetaphy_a.go': 'all', 'evmd/app.go': [10, 11] };
  const issue = (file, line, sev = 'HIGH', conf = 'MEDIUM') => ({ severity: sev, confidence: conf, rule_id: 'G115', details: 'conv', file: `/src/${file}`, line: String(line), code: `${line}: x := int64(y)` });
  const g = parseGosec({ Issues: [issue('evmd/zetaphy_a.go', 5), issue('evmd/app.go', 11), issue('evmd/app.go', 12), issue('x/vm/keeper/k.go', 1), issue('evmd/zetaphy_a.go', 6, 'HIGH', 'LOW')] }, '/src', zl);
  assert.deepEqual(g.map((f) => [f.file, f.line, f.severity]), [['zetaphy-chain:evmd/zetaphy_a.go', 5, 'high'], ['zetaphy-chain:evmd/app.go', 11, 'high'], ['zetaphy-chain:evmd/zetaphy_a.go', 6, 'medium']]);
  assert.equal(g[0].lineText.trim(), 'x := int64(y)');
  const s = parseStaticcheck([
    JSON.stringify({ code: 'SA4006', location: { file: '/src/evmd/app.go', line: 10 }, message: 'unused value' }),
    JSON.stringify({ code: 'ST1003', location: { file: '/src/evmd/zetaphy_a.go', line: 1 }, message: 'naming' }),
    JSON.stringify({ code: 'SA1019', location: { file: '/src/evmd/app.go', line: 99 }, message: 'upstream line' }),
  ].join('\n'), '/src', zl);
  assert.deepEqual(s.map((f) => [f.rule, f.severity]), [['SA4006', 'medium'], ['ST1003', 'info']]);
});

test('govulncheck: called vulnerable code is high, imported-only low, required-only info', () => {
  const stream = [
    { osv: { id: 'GO-1', summary: 'bad' } }, { osv: { id: 'GO-2', summary: 'meh' } },
    { finding: { osv: 'GO-1', fixed_version: 'v1.2.0', trace: [{ module: 'm', version: 'v1.0.0', package: 'm/p' }] } },
    { finding: { osv: 'GO-1', fixed_version: 'v1.2.0', trace: [{ module: 'm', version: 'v1.0.0', package: 'm/p', function: 'F' }] } },
    { finding: { osv: 'GO-2', trace: [{ module: 'n', version: 'v0.1.0' }] } },
  ].map((o) => JSON.stringify(o, null, 2)).join('\n');
  const out = parseGovulncheck(stream);
  assert.deepEqual(out.map((f) => [f.rule, f.severity]), [['GO-1', 'high'], ['GO-2', 'info']]);
});

test('npm audit and OSV: severities, and advisory ids kept to drop OSV duplicates', () => {
  const npm = parseNpmAudit({ vulnerabilities: {
    a: { severity: 'high', range: '<2', fixAvailable: true, via: [{ source: 1, title: 'proto pollution', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', range: '<2' }] },
    b: { severity: 'high', via: ['a'] },
  } }, 'web/package-lock.json');
  assert.deepEqual(npm.map((f) => [f.rule, f.severity, f.file]), [['GHSA-aaaa-bbbb-cccc', 'high', 'web/package-lock.json']]);
  const osv = parseOsv({ results: [{ source: { path: '/repo/web/package-lock.json' }, packages: [{ package: { name: 'a', version: '1.0.0', ecosystem: 'npm' },
    groups: [{ ids: ['GHSA-x'], max_severity: '9.8' }, { ids: ['GHSA-y'], max_severity: '' }],
    vulnerabilities: [{ id: 'GHSA-x', summary: 's' }, { id: 'GHSA-y', summary: 's', database_specific: { severity: 'MODERATE' } }] }] }] }, '/repo');
  assert.deepEqual(osv.map((f) => [f.rule, f.severity, f.file]), [['GHSA-x', 'critical', 'web/package-lock.json'], ['GHSA-y', 'medium', 'web/package-lock.json']]);
});

// ---------------------------------------------------------------- whole report

function fakeOut({ triage = '', baseline = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'audit-test-'));
  const target = join(root, 'repo');
  const out = join(root, 'out');
  mkdirSync(join(target, 'p', 'contracts'), { recursive: true });
  writeFileSync(join(target, 'p', 'contracts', 'A.sol'), 'contract A {\n  function f() external {\n    (bool ok,) = msg.sender.call{value: 1}("");\n  }\n}\n');
  const raw = join(out, 'raw');
  for (const d of ['slither', 'compile', 'invariants', 'mutation']) mkdirSync(join(raw, d), { recursive: true });
  writeFileSync(join(raw, 'meta.json'), JSON.stringify({ commit: 'abc123', tier: 'fast', mode: 'repo', target, started: '2026-10-30T00:00:00Z' }));
  writeFileSync(join(raw, 'scope.json'), JSON.stringify({ solc: '0.8.26', projects: [{ name: 'p', root: 'p', files: ['contracts/A.sol', 'contracts/M.sol'], excluded: { 'contracts/M.sol': 'mock' }, loc: { 'contracts/A.sol': 5 } }] }));
  writeFileSync(join(raw, 'compile', 'p.json'), JSON.stringify({ project: 'p', root: 'p', contracts: [
    { file: 'contracts/A.sol', name: 'A', runtimeHash: '0x' + 'aa'.repeat(32), artifactMatch: true },
    { file: 'contracts/M.sol', name: 'M', runtimeHash: '0x' + 'bb'.repeat(32), excluded: true },
  ] }));
  writeFileSync(join(raw, 'slither', 'p__contracts_A.sol.json'), JSON.stringify({ success: true, results: { detectors: [
    { check: 'arbitrary-send-eth', impact: 'High', confidence: 'Medium', description: 'A.f() (contracts/A.sol#2-4) sends eth', elements: [{ source_mapping: { filename_relative: 'contracts/A.sol', lines: [3] } }] },
    { check: 'low-level-calls', impact: 'Informational', confidence: 'High', description: 'low level call in A.f() (contracts/A.sol#3)', elements: [{ source_mapping: { filename_relative: 'contracts/A.sol', lines: [3] } }] },
  ] } }));
  writeFileSync(join(raw, 'invariants', 'summary.json'), JSON.stringify({ passed: 4, failed: 1, notRun: 2, suites: [{ dir: 'p/audit/invariants', tool: 'forge', passed: 4, failed: 1, notRun: 0, note: 'Inv.invariant_solvent()' }] }));
  writeFileSync(join(raw, 'mutation', 'results.json'), JSON.stringify({ score: 0.75, results: [] }));
  writeFileSync(join(raw, 'tools.tsv'), 'tool\tstatus\tseconds\tversion\tnote\nslither\tran\t3\t0.11.6\t\n');
  writeFileSync(join(root, 'triage.yml'), triage);
  writeFileSync(join(root, 'baseline.json'), JSON.stringify({ ids: baseline }));
  return { root, out };
}

test('collect + toJson: the machine-readable shape other programs read', () => {
  const { root, out } = fakeOut();
  try {
    const r = collect(out);
    const j = toJson(r);
    assert.deepEqual(Object.keys(j), ['commit', 'codeHashes', 'findings', 'invariants', 'mutationScore']);
    assert.equal(j.commit, 'abc123');
    assert.deepEqual(j.codeHashes, { A: '0x' + 'aa'.repeat(32) }); // excluded M is not audited
    assert.deepEqual(j.invariants, { passed: 4, failed: 1, notRun: 2 });
    assert.equal(j.mutationScore, 0.75);
    const sev = j.findings.map((f) => f.severity);
    assert.deepEqual(sev, ['high', 'high', 'info']); // the failed invariant is high
    for (const f of j.findings) {
      assert.deepEqual(Object.keys(f), ['id', 'tool', 'rule', 'severity', 'file', 'line', 'title', 'status']);
      assert.equal(f.status, 'open');
    }
    assert.equal(r.blocking.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate: blocks new untriaged High; triage or the baseline unblock it; accepted-risk shows as "accepted"', () => {
  const { root, out } = fakeOut();
  try {
    const ids = collect(out).findings.map((f) => f.id);
    const send = ids.find((i) => i.startsWith('slither:arbitrary-send-eth:p/contracts/A.sol:'));
    const inv = ids.find((i) => i.startsWith('forge:'));
    assert.ok(send && inv);
    const r = collect(out, {
      triageText: `findings:\n  - id: ${send}\n    status: accepted-risk\n    reason: pays only the caller, by design of f()\n    decided_by: owner\n`,
      baselineIds: [inv],
    });
    assert.equal(r.blocking.length, 0);
    assert.equal(toJson(r).findings.find((f) => f.id === send).status, 'accepted');
    assert.equal(r.findings.find((f) => f.id === inv).status, 'open'); // baseline is not triage
    const md = toMarkdown(r);
    assert.match(md, /Gate \(PR tier\):\*\* passes/);
    assert.match(md, /open \(known: in baseline/);
    assert.match(md, /What this does NOT prove \(as of 2026-10-30\)/);
    const sarif = toSarif(r);
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.runs.every((run) => run.results.every((x) => x.partialFingerprints['zetaphyAuditId/v1'])));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SARIF: decided findings are left out of the code-scanning upload (GitHub ignores suppressions); with includeTriaged they carry suppressions', () => {
  const { root, out } = fakeOut();
  try {
    const ids = collect(out).findings.map((f) => f.id);
    const send = ids.find((i) => i.startsWith('slither:arbitrary-send-eth:'));
    const inv = ids.find((i) => i.startsWith('forge:'));
    const reason = 'pays only the caller from its own credit, verified by reading f()';
    const triageText = `findings:\n  - id: ${send}\n    status: false-positive\n    reason: ${reason}\n    decided_by: auditor (owner to confirm)\n    date: 2026-10-30\n`;
    const results = (r) => toSarif(r, { includeTriaged: true }).runs.flatMap((run) => run.results);
    const uploaded = (r) => toSarif(r).runs.flatMap((run) => run.results).map((y) => y.partialFingerprints['zetaphyAuditId/v1']);
    const byId = (r, id) => results(r).find((x) => x.partialFingerprints['zetaphyAuditId/v1'] === id);
    // untriaged: an error, no suppression
    const before = collect(out);
    assert.equal(byId(before, send).level, 'error');
    assert.equal(byId(before, send).suppressions, undefined);
    // triaged: still present (same fingerprint, so code scanning can dismiss the existing alert), suppressed
    const r = collect(out, { triageText, baselineIds: [inv] });
    assert.ok(uploaded(before).includes(send), 'untriaged: uploaded');
    assert.ok(!uploaded(r).includes(send), 'decided: not uploaded to code scanning');
    const x = byId(r, send);
    assert.ok(x, 'a triaged finding is still in the SARIF');
    assert.equal(x.level, 'error', 'the level stays the finding severity');
    assert.equal(x.suppressions.length, 1);
    assert.equal(x.suppressions[0].kind, 'external');
    assert.equal(x.suppressions[0].status, 'accepted');
    assert.match(x.suppressions[0].justification, /^false-positive \(PENDING OWNER CONFIRMATION\): pays only the caller/);
    assert.match(x.suppressions[0].justification, /decided by auditor \(owner to confirm\), 2026-10-30/);
    assert.equal(x.properties.pendingOwnerConfirmation, true);
    // accepted-risk and fixed: accepted-risk is suppressed; "fixed" but still detected is open again, so not
    const acc = collect(out, { triageText: triageText.replace('false-positive', 'accepted-risk').replace(' (owner to confirm)', '') });
    assert.match(byId(acc, send).suppressions[0].justification, /^accepted-risk: /);
    const fixed = collect(out, { triageText: triageText.replace('false-positive', 'fixed') });
    assert.equal(byId(fixed, send).suppressions, undefined, 'marked fixed but still detected: an alert again');
    assert.ok(uploaded(fixed).includes(send), 'marked fixed but still detected: uploaded again');
    // the untriaged invariant failure (baseline is not triage) stays unsuppressed
    const other = results(r).filter((y) => y.partialFingerprints['zetaphyAuditId/v1'] !== send);
    assert.ok(other.every((y) => !y.suppressions));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pending owner confirmation: counts as decided for the gate and --json, labelled pending everywhere it is shown', () => {
  const { root, out } = fakeOut();
  try {
    const ids = collect(out).findings.map((f) => f.id);
    const send = ids.find((i) => i.startsWith('slither:arbitrary-send-eth:'));
    const inv = ids.find((i) => i.startsWith('forge:'));
    const triageText = `findings:\n  - id: ${send}\n    status: false-positive\n    reason: pays only the caller, verified by reading f()\n    decided_by: claude-agent (initial review by reading the code; owner to confirm)\n`;
    const r = collect(out, { triageText, baselineIds: [inv] });
    assert.equal(r.blocking.length, 0, 'the gate treats it as decided');
    assert.equal(toJson(r).findings.find((f) => f.id === send).status, 'false-positive');
    const md = toMarkdown(r);
    assert.match(md, /false-positive, PENDING OWNER CONFIRMATION\*\* \(proposed by claude-agent/);
    assert.match(md, /\*\*Pending owner confirmation:\*\* 1 triage decision\(s\)/);
    assert.match(md, /\| High \| 2 \| 1 \| 0 \| 0 \| 1 \|/, 'counted apart from confirmed decisions');
    // the same entry confirmed by the owner: same effect, no pending label
    const c = collect(out, { triageText: triageText.replace(/claude-agent.*$/m, 'pospos191'), baselineIds: [inv] });
    assert.equal(c.blocking.length, 0);
    assert.doesNotMatch(toMarkdown(c), /PENDING OWNER CONFIRMATION/);
    assert.match(toMarkdown(c), /\| High \| 2 \| 1 \| 0 \| 1 \| 0 \|/);
    // the gate says so on the CLI
    writeFileSync(join(root, 'triage.yml'), triageText);
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ ids: [inv] }));
    const g = spawnSync(process.execPath, [REPORT, out, '--md', join(root, 'R.md'), '--triage', join(root, 'triage.yml'), '--baseline', join(root, 'baseline.json'), '--gate'], { encoding: 'utf8' });
    assert.equal(g.status, 0);
    assert.match(g.stderr, /::warning file=audit\/triage.yml::1 triage decision\(s\) \(1 High\/Critical\) are pending owner confirmation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--json: findings without a line or file (invariants, deps) come out as line 0 and "" (the adapter needs whole numbers)', () => {
  const { root, out } = fakeOut();
  try {
    const j = toJson(collect(out));
    const inv = j.findings.find((f) => f.tool === 'forge');
    assert.equal(inv.line, 0);
    for (const f of j.findings) assert.ok(Number.isInteger(f.line) && typeof f.file === 'string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: --json prints exactly one JSON object; --gate exits 1 on a new High and 0 once triaged', () => {
  const { root, out } = fakeOut();
  try {
    const args = [REPORT, '--json', out, '--triage', join(root, 'triage.yml'), '--baseline', join(root, 'baseline.json')];
    const txt = execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(txt.trim().split('\n').length, 1);
    const j = JSON.parse(txt);
    assert.equal(j.findings.length, 3);
    const gate = (extra = []) => spawnSync(process.execPath, [REPORT, out, '--md', join(root, 'R.md'), '--triage', join(root, 'triage.yml'), '--baseline', join(root, 'baseline.json'), '--gate', ...extra], { encoding: 'utf8' });
    const g1 = gate();
    assert.equal(g1.status, 1);
    assert.match(g1.stderr, /new and untriaged/);
    const highs = j.findings.filter((f) => f.severity === 'high');
    writeFileSync(join(root, 'triage.yml'), `findings:\n${highs.map((f) => `  - id: ${f.id}\n    status: false-positive\n    reason: checked by hand in this test case\n    decided_by: test\n`).join('')}`);
    assert.equal(gate().status, 0);
    writeFileSync(join(root, 'triage.yml'), 'findings:\n  - id: x\n    status: maybe\n');
    assert.equal(gate().status, 1); // malformed triage.yml fails the gate
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- helpers

test('zetaphy-lines: added lines of modified files, "all" for new files, generated code skipped', () => {
  const script = [
    ": <<'ZETAPHY_PQ_PATCH'",
    'diff --git a/evmd/app.go b/evmd/app.go', '--- a/evmd/app.go', '+++ b/evmd/app.go',
    '@@ -10,3 +10,4 @@ func x() {', ' a', '+b', ' c', '-d', '+e',
    'diff --git a/evmd/zetaphy_x.go b/evmd/zetaphy_x.go', 'new file mode 100644', '--- /dev/null', '+++ b/evmd/zetaphy_x.go', '@@ -0,0 +1,2 @@', '+package evmd', '+',
    'diff --git a/crypto/k.pb.go b/crypto/k.pb.go', 'new file mode 100644', '@@ -0,0 +1 @@', '+x',
    'ZETAPHY_PQ_PATCH',
  ].join('\n');
  assert.deepEqual(patchedLines(script), { 'evmd/app.go': [11, 13], 'evmd/zetaphy_x.go': 'all' });
});

test('mutator: operators on code lines only, deterministic spread, metadata stripped', () => {
  const src = [
    '// a + b in a comment',
    'pragma solidity 0.8.26;',
    'contract C {',
    '    uint256 constant K = 1 + 2;',
    '    function f(uint256 a) external returns (uint256) {',
    '        require(a > 0, "zero");',
    '        total += a;',
    '        return a * 2;',
    '    }',
    '}',
  ].join('\n');
  const m = mutants(src);
  assert.ok(m.every((x) => x.line >= 6 && x.line <= 8));
  assert.ok(m.some((x) => x.op === 'require -> true' && x.text.includes('require(true)')));
  assert.ok(m.some((x) => x.op === 'assign += -> -=' && x.text.includes('total -= a')));
  assert.ok(m.some((x) => x.op === 'binop * -> /' && x.text.includes('a / 2')));
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
  assert.equal(stripMetadata('0x6000' + 'a264' + '0002'), '6000');
  assert.equal(stripMetadata('0x6000' + '0033'), '60000033'); // no room for that much metadata: left as is
});

test('scope helpers: comment-free line count; import resolution with remappings', () => {
  assert.equal(countLoc('// x\n/* a\n b */\ncontract A {\n\n  uint x; // y\n}\n'), 3);
  assert.equal(resolveImport('/nonexistent', 'contracts/A.sol', './B.sol', []), 'contracts/B.sol');
  assert.equal(resolveImport('/nonexistent', '', '@openzeppelin/contracts/x.sol', ['@openzeppelin/contracts/=vendor/@openzeppelin/contracts/']), 'vendor/@openzeppelin/contracts/x.sol');
});

test('a fixed entry whose finding is gone is the record of the fix, not a stale entry', () => {
  const { root, out } = fakeOut();
  try {
    const triageText = 'findings:\n'
      + '  - id: aderyn:unsafe-casting:p/contracts/Gone.sol:0123456789ab\n    status: fixed\n    reason: bound check added in abc1234, regression test t.js\n    decided_by: auditor (owner to confirm)\n    date: 2026-10-30\n'
      + '  - id: aderyn:x:p/contracts/Gone.sol:abcdefabcdef\n    status: false-positive\n    reason: the line was rewritten since then\n    decided_by: owner\n';
    const md = toMarkdown(collect(out, { triageText }));
    assert.match(md, /### Fixed \(no longer detected\)\n\n[^\n]+\n\n- `aderyn:unsafe-casting:p\/contracts\/Gone\.sol:0123456789ab` — bound check added in abc1234/);
    assert.match(md, /### Triage entries that matched nothing[\s\S]*aderyn:x:p\/contracts\/Gone\.sol:abcdefabcdef/);
    assert.doesNotMatch(md.split('### Triage entries that matched nothing')[1], /0123456789ab/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('semgrep basic-arithmetic-underflow: Info only for checked arithmetic (solc >= 0.8, outside unchecked)', () => {
  const src = [
    '// SPDX-License-Identifier: MIT', // 1
    'pragma solidity ^0.8.26;', // 2
    'contract C {', // 3
    '  function f(uint a, uint b) external pure returns (uint) {', // 4
    '    uint x = a - b; // "unchecked {" in a comment', // 5
    '    unchecked {', // 6
    '      x = a - b;', // 7
    '      if (x > 0) { x -= b; }', // 8
    '    }', // 9
    '    return x - b;', // 10
    '  }', // 11
    '}', // 12
  ].join('\n');
  assert.equal(checkedArithmetic(src, 5), true);
  assert.equal(checkedArithmetic(src, 7), false, 'inside unchecked: a real wrap');
  assert.equal(checkedArithmetic(src, 8), false, 'nested braces inside unchecked');
  assert.equal(checkedArithmetic(src, 10), true, 'after the unchecked block');
  for (const p of ['>=0.8.0 <0.9.0', '0.8.26', '=0.8.20']) assert.equal(checkedArithmetic(src.replace('^0.8.26', p), 5), true, p);
  for (const p of ['^0.7.6', '>=0.6.0 <0.9.0', '<0.9.0', '>0.7.0', '^0.7.0 || ^0.8.0']) assert.equal(checkedArithmetic(src.replace('^0.8.26', p), 5), false, p);
  assert.equal(checkedArithmetic(src.replace('pragma solidity ^0.8.26;', ''), 5), false, 'no pragma: unsure');
});

test('collect: the underflow rule is Info on checked lines and keeps its severity in unchecked blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-sg-'));
  try {
    const out = join(root, 'out');
    mkdirSync(join(out, 'raw', 'semgrep'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'A.sol'), 'pragma solidity ^0.8.26;\ncontract A {\n  function f(uint a) external pure returns (uint r) {\n    r = 10 - a;\n    unchecked { r = 10 - a; }\n  }\n}\n');
    writeFileSync(join(out, 'raw', 'meta.json'), JSON.stringify({ target: root, mode: 'target' }));
    const hit = (line) => ({ check_id: 'solidity.security.basic-arithmetic-underflow', path: 'src/A.sol', start: { line },
      extra: { message: 'Possible arithmetic underflow', severity: 'INFO', metadata: { impact: 'HIGH', confidence: 'LOW' } } });
    writeFileSync(join(out, 'raw', 'semgrep', 'results.json'), JSON.stringify({ results: [hit(4), hit(5)] }));
    const r = collect(out);
    const at = (l) => r.findings.find((f) => f.line === l);
    assert.equal(at(4).severity, 'info');
    assert.match(at(4).title, /checked arithmetic/);
    assert.equal(at(5).severity, 'medium', 'inside unchecked: a possible wrap, kept');
    assert.deepEqual(toSarif(r).runs.flatMap((x) => x.results).map((x) => x.locations[0].physicalLocation.region.startLine), [5]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
