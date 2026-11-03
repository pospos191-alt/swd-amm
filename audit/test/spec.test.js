// SS6 spec tool (audit/spec): drafting without AI, the LLM screen, spec hashing / approval, and the
// prover's honesty rules (a tool that is not installed is never "proven"; a counterexample replays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, findSolc, REPO } from '../spec/lib/analyze.js';
import { draft } from '../spec/lib/heuristics.js';
import { screen, propose } from '../spec/lib/llm.js';
import { validateExpr, specHash, canonical, hashBytes32Array, toMarkdown } from '../spec/lib/spec.js';
import { generate } from '../spec/lib/gen.js';
import { prove } from '../spec/lib/prove.js';

const VAULT = join(REPO, 'audit/spec/fixtures/BuggyVault.sol');
const have = (bin) => { try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const tmp = () => mkdtempSync(join(tmpdir(), 'spec-test-'));
const model = analyze(VAULT, 'BuggyVault', { solc: findSolc() });

/** The demo spec, approved the way audit/spec/examples/BuggyVault.spec.json was. */
function approved(spec = draft(model)) {
  for (const p of spec.properties) p.status = p.id === 'conservation-balanceOf-deposits' ? 'rejected' : 'approved';
  spec.approval = { reviewer: 'test', at: '2026-11-03', specHash: specHash(spec) };
  return spec;
}

test('heuristics draft the properties of a vault with no AI, the same every time', () => {
  const a = draft(model);
  const ids = a.properties.map((p) => p.id);
  for (const id of ['access-pause', 'access-unpause', 'access-setGovernance', 'monotonic-deposits', 'conservation-balanceOf-totalDeposits',
    'backing-totalDeposits', 'pause-noloss', 'paused-blocks-deposit', 'cei-withdraw', 'cei-emergencyWithdraw']) assert.ok(ids.includes(id), id);
  assert.ok(a.properties.every((p) => p.status === 'proposed' && p.origin === 'heuristic'), 'nothing is approved by the machine');
  assert.equal(a.drafted.llm, null);
  assert.equal(canonical(draft(model)), canonical(a), 'deterministic');
  const f = model.functions.find((x) => x.name === 'withdraw');
  assert.deepEqual(f.writeAfterCall.map((w) => w.var), ['balanceOf', 'totalDeposits'], 'BUG 2 is seen on the AST');
  assert.match(toMarkdown(a), /not approved yet/);
});

test('the AST model: guards through modifiers and internal calls, storage pointers, real locks vs accounting named "locked"', () => {
  const box = analyze(join(REPO, 'zetaphy-network/contracts/HyperlaneLockBoxV2.sol'), 'HyperlaneLockBoxV2');
  const fn = (n) => box.functions.find((f) => f.name === n);
  assert.deepEqual(fn('pause').sender, { eq: ['governance'], map: ['guardian'], other: false }, 'onlyGuardian modifier');
  assert.deepEqual(fn('handle').sender.eq, ['mailbox'], 'msg.sender != address(mailbox)');
  assert.ok(fn('claim').writes.releases && fn('claim').writes.locked.dec, 'writes through `Release storage r`');
  assert.deepEqual(fn('claim').lockVars, [], '`locked -= amount` is accounting, not a reentrancy lock');
  const runners = analyze(join(REPO, 'zetaphy-network/contracts/AuditRunners.sol'), 'AuditRunners');
  assert.deepEqual(runners.functions.find((f) => f.name === 'withdraw').lockVars, ['_lock']);
  const guard = analyze(join(REPO, 'zetaphy-network/contracts/BridgeGuard.sol'), 'BridgeGuard');
  assert.ok(guard.functions.find((f) => f.name === 'inbound').writes.routes, 'Route storage r = _use(...) resolves to routes');
  assert.deepEqual(guard.functions.find((f) => f.name === 'lowerMaxDailyLimit').sender.map, ['guardian'], 'via _govOrGuardian()');
});

test('the expression language refuses code: an LLM (or anyone) can only state properties', () => {
  const ok = { views: ['totalDeposits', 'balanceOf'], harnessViews: ['sum'] };
  assert.equal(validateExpr('address(t).balance >= t.totalDeposits()', ok), null);
  assert.equal(validateExpr('h.sum() <= t.totalDeposits() && t.balanceOf(address(0)) == 0', ok), null);
  assert.equal(validateExpr('old(t.totalDeposits()) <= t.totalDeposits()', { ...ok, allowOld: true }), null);
  for (const bad of ['vm.deal(address(t), 1) == 0', 't.totalDeposits(); selfdestruct(x)', 'true) { assembly { } } function x() { (true',
    't.withdraw(1) == 0', 't.balanceOf(msg.sender) > 0', 'h.secret() > 0', 'old(t.totalDeposits()) > 0', 'address(t).call("") == 0', '"str" == 0',
    'this.x() > 0', 'keccak256(1) == 0', 'new X() == 0']) {
    assert.notEqual(validateExpr(bad, ok), null, bad);
  }
});

test('the LLM step is optional, and its proposals pass the same screen as anyone\'s', async () => {
  const d = draft(model);
  assert.equal(await propose(model, d, { env: {} }), null, 'no key: no call, no change');
  const raw = [
    { id: 'total-covers-balances', kind: 'invariant', title: 'ok', statement: 's', rationale: 'r', expr: 'address(t).balance >= t.totalDeposits()', functions: [], when: '' },
    { id: 'evil', kind: 'invariant', title: 'x', statement: 's', rationale: 'r', expr: 'vm.store(address(t), 0, 0) == 0', functions: [], when: '' },
    { id: 'post-wd', kind: 'post', title: 'x', statement: 's', rationale: 'r', expr: 't.totalDeposits() <= old(t.totalDeposits())', functions: ['withdraw'], when: '' },
    { id: 'ghost', kind: 'post', title: 'x', statement: 's', rationale: 'r', expr: 'true', functions: ['mintForFree'], when: '' },
    { id: 'acc', kind: 'access', title: 'x', statement: 's', rationale: 'r', expr: '', functions: ['pause'], when: '' },
  ];
  let sent = null;
  const fake = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ properties: raw }) }] }) }; };
  const r = await propose(model, d, { env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: fake });
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.output_config.format.type, 'json_schema', 'constrained JSON output');
  assert.deepEqual(r.properties.map((p) => p.id), ['llm-total-covers-balances', 'llm-post-wd']);
  assert.ok(r.properties.every((p) => p.status === 'proposed' && p.origin === 'llm'), 'a human still approves');
  assert.deepEqual(r.rejected.map((x) => x.id).sort(), ['llm-acc', 'llm-evil', 'llm-ghost']);
  assert.equal(screen('not an array', model, d).properties.length, 0);
});

test('the spec hash covers what is proven; a spec edited after approval is refused', async () => {
  const s = approved();
  const h = s.approval.specHash;
  const t2 = structuredClone(s);
  t2.properties.find((p) => p.status === 'rejected').title = 'reworded rejected property';
  t2.notes = [];
  assert.equal(specHash(t2), h, 'rejected properties and notes are not part of it');
  t2.harness.setup = 't = new BuggyVault(address(0x2000));';
  assert.notEqual(specHash(t2), h, 'the harness is');
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(t2));
    await assert.rejects(prove(join(dir, 'spec.json'), { out: join(dir, 'w') }), /changed after approval/);
    const un = draft(model);
    writeFileSync(join(dir, 'un.json'), JSON.stringify(un));
    await assert.rejects(prove(join(dir, 'un.json'), { out: join(dir, 'w') }), /not approved/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // keccak256(abi.encode(bytes32[])): offset, length, elements (checked against ethers and the contract in zetaphy-network/test/proofs.test.js)
  assert.match(hashBytes32Array(['0x' + '11'.repeat(32)]), /^0x[0-9a-f]{64}$/);
});

test('generated artifacts: every approved property has a check, nothing machine-specific in the hashed files', () => {
  const dir = tmp();
  try {
    const g = generate(approved(), model, dir);
    for (const id of ['access-pause', 'monotonic-deposits', 'conservation-balanceOf-totalDeposits', 'backing-totalDeposits', 'pause-noloss', 'paused-blocks-deposit']) assert.ok(g.checks[id]?.length, id);
    assert.equal(g.checks['conservation-balanceOf-deposits'], undefined, 'rejected: not generated');
    assert.deepEqual(Object.keys(g.smt), ['backing-totalDeposits'], 'the state invariant goes to the SMTChecker too');
    const src = readFileSync(join(dir, 'test/Spec.t.sol'), 'utf8');
    assert.ok(!src.includes(REPO) && !src.includes(dir), 'no absolute paths');
    assert.match(src, /function check_backing_totalDeposits\(uint256\[\d+\] memory w\)/);
    assert.ok(!/for \(/.test(src.slice(src.indexOf('contract SpecChecks'))), 'no loops for the prover to cut');
    const trace = g.explain('check_backing_totalDeposits', { 0: '0', 1: '1', 2: '5', 3: '2', 4: '4' });
    assert.deepEqual(trace, ['deposit(value 5) by address(0xA11CE)', 'emergencyWithdraw() by address(0xA11CE)']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a tool that is not installed is "not-installed", never "proven"', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(approved()));
    const { proof } = await prove(join(dir, 'spec.json'), { out: join(dir, 'w'), bins: { forge: '/nonexistent/forge', halmos: '/nonexistent/halmos', solc: '/nonexistent/solc' } });
    assert.equal(proof.tools.forge, null);
    for (const p of proof.properties.filter((x) => x.kind !== 'cei')) {
      assert.equal(p.status, 'not-installed', p.id);
      assert.ok(p.by.every((e) => e.status === 'not-installed'), p.id);
    }
    assert.equal(proof.summary.allProven, false);
    assert.equal(proof.summary.proven, 1, 'only the AST check ran (cei-emergencyWithdraw)');
    assert.equal(proof.properties.find((p) => p.id === 'cei-withdraw').status, 'counterexample');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Halmos finds the planted bugs and forge replays each counterexample (or: halmos not installed)', { timeout: 900_000 }, async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(approved()));
    const { proof } = await prove(join(dir, 'spec.json'), { out: join(dir, 'w'), tools: 'halmos' });
    const st = (id) => proof.properties.find((p) => p.id === id);
    if (!have('halmos') || !have('forge')) {
      assert.equal(st('backing-totalDeposits').status, 'not-installed');
      assert.equal(proof.summary.allProven, false);
      return;
    }
    for (const id of ['backing-totalDeposits', 'conservation-balanceOf-totalDeposits']) {
      const p = st(id);
      assert.equal(p.status, 'counterexample', id);
      const e = p.by.find((x) => x.status === 'counterexample');
      assert.equal(e.replayed, true, `${id}: replayed in forge`);
      assert.ok(e.trace.some((s) => s.startsWith('emergencyWithdraw')), `${id}: BUG 1 is the cause`);
    }
    for (const id of ['access-pause', 'access-unpause', 'access-setGovernance', 'monotonic-deposits', 'pause-noloss', 'paused-blocks-deposit']) assert.equal(st(id).status, 'proven', id);
    assert.ok(existsSync(join(dir, 'w/PROOF.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
