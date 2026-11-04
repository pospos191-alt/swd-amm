// SS8: the audit network audits itself (docs/future/immune-score.md). AuditNetwork, AuditRunners, AuditJudges and
// AuditCertificate are filed as audit requests on their OWN addresses and code, go through the contest, the automated
// tier (the pipeline adapter on the committed report fixture + Neuro's code-only scan of each contract's deployed
// code) and the judges, and get certificates; then the CI check (scripts/audit-self.js check) passes on the record,
// and fails on an expired or revoked certificate or a changed artifact. It is OFF while no record exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditWorld, request, contest, runnersCommit, runnersReveal, reveal, lateFinding, DAY, SRC, codeHashOf } from './helpers/auditworld.js';
import { chainSend } from './helpers/immunesim.js';
import { automatedResult, neuroScan, chainKeyOf, FIXTURE } from '../src/auditnet.js';
import { SELF, SELF_FILE, buildRecord, selfCheck, checkRecord, selfTargets, planCommands } from '../src/auditself.js';

const CHAIN = 77390;
const SCRIPT = fileURLToPath(new URL('../scripts/audit-self.js', import.meta.url));
const pipeline = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
};

/** The whole self-audit on an in-memory ZETAPHY (chain 77390): four requests in parallel, each on its own contract. */
async function selfAudit() {
  const w = await auditWorld({ chainId: CHAIN });
  const deployment = { chainId: CHAIN, contracts: { auditNetwork: w.net.address, auditRunners: w.run.address, auditJudges: w.jud.address, auditCertificate: w.cert.address } };
  const send = chainSend(w.c);
  const targets = await selfTargets(send, deployment);
  assert.deepEqual(targets.map((t) => t.name), SELF.map((s) => s.name));
  const reqs = [];
  for (const t of targets) {
    const id = await request(w, { target: t.address, codeHash: t.codeHash });
    const code = await w.c.getCode(t.address);
    assert.equal(codeHashOf(code), t.codeHash);
    // the automated tier: the pipeline report + Neuro on the contract's own deployed code; every runner gets the same tuple
    const neuro = await neuroScan(chainKeyOf(CHAIN), t.address, code);
    const { tuple } = automatedResult({ chainId: CHAIN, target: t.address, codeHash: t.codeHash, sourceHash: SRC }, { pipeline, neuro });
    assert.equal(tuple.critHigh, 0, `${t.name}: no open critical/high from the tools`);
    await contest(w, id, { auditors: ['a1', 'a2', 'a3'] });
    await runnersCommit(w, id, [tuple, tuple, tuple]);
    reqs.push({ ...t, id, tuple });
  }
  w.c.advance(3 * DAY);
  for (const r of reqs) {
    await reveal(w, r.id, { auditors: ['a1', 'a2', 'a3'] });
    await runnersReveal(w, r.id, [r.tuple, r.tuple, r.tuple]);
  }
  w.c.advance(DAY + 2 * DAY + 2 * DAY);
  for (const r of reqs) {
    await w.run.send('x', 'settle', [r.id]);
    await w.net.send('x', 'settle', [r.id]);
    assert.equal(Number(await w.cert.call('check', [r.id])), 0, `${r.name} certifiable`);
    await w.cert.send('x', 'certify', [r.id]);
  }
  return { w, deployment, send, reqs };
}

test('self-audit end to end: the four audit contracts are requested on themselves, contested, run, judged and certified', async () => {
  const { w, deployment, send, reqs } = await selfAudit();
  for (const r of reqs) assert.equal(await w.cert.call('isCertified', [CHAIN, r.address]), true, r.name);
  const lines = planCommands(await selfTargets(send, deployment));
  assert.equal(lines.length, 4);
  assert.match(lines[0], new RegExp(`^zetaphy audit request ${CHAIN} ${w.net.address} --source`));

  // the record and the CI check on it
  const dir = mkdtempSync(join(tmpdir(), 'audit-self-'));
  try {
    const record = await buildRecord(send, deployment);
    const file = join(dir, 'audit-self-77390.json');
    writeFileSync(file, JSON.stringify(record, null, 2));
    assert.deepEqual(await selfCheck({ file, send, now: Number(w.c.now()) }), { status: 'ok', problems: [] });
    // the script, as CI runs it (no chain: the offline check)
    const ok = run(['check', '--file', file]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /self-audit check: OK/);
    // a missing record: OFF, never a failure
    const off = run(['check', '--file', join(dir, 'nope.json')]);
    assert.equal(off.code, 0);
    assert.match(off.out, /OFF/);
    // a contract whose source changed since its self-audit (another artifact): FAILS
    const changed = { ...record, contracts: { ...record.contracts, auditJudges: { ...record.contracts.auditJudges, artifactHash: '0x' + '12'.repeat(32) } } };
    writeFileSync(file, JSON.stringify(changed));
    const bad = run(['check', '--file', file]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /AuditJudges: the artifact changed since its self-audit/);
    // expiry
    const exp = record.contracts.auditNetwork.certificate.expiresAt;
    assert.ok(checkRecord(record, { now: exp }).some((p) => /AuditNetwork: certificate expired/.test(p)));
    const missing = { ...record, contracts: { ...record.contracts } };
    delete missing.contracts.auditRunners;
    assert.deepEqual(checkRecord(missing, { now: Number(w.c.now()) }), ['AuditRunners: missing']);

    // a valid post-certificate critical against AuditJudges' code revokes it: the live check fails
    const judgesReq = reqs.find((r) => r.name === 'AuditJudges').id;
    await lateFinding(w, judgesReq, { who: 'a4', sev: 5, text: 'judges can be bypassed' });
    const live = await selfCheck({ file: (writeFileSync(file, JSON.stringify(record)), file), send, now: Number(w.c.now()) });
    assert.equal(live.status, 'fail');
    assert.deepEqual(live.problems, ['AuditJudges: AuditCertificate.isCertified is false on chain']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the committed repository: the self-audit check is OFF until deployments/audit-self-77390.json exists, and passes when it does', async () => {
  const r = await selfCheck();
  if (!existsSync(SELF_FILE)) assert.equal(r.status, 'off');
  else assert.deepEqual(r, { status: 'ok', problems: [] }, 'the recorded self-audit holds for the committed artifacts');
  const cli = run(['check']);
  assert.equal(cli.code, 0, cli.out);
});
