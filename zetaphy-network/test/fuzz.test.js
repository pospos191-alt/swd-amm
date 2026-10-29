// The browser bug hunter (zetaphy-hub/fuzz-core.js, docs/future/useful-work.md item 17) on deliberately
// vulnerable fixtures (test/fixtures/fuzz/Vulnerable.sol: reentrancy, delegatecall to anyone, selfdestruct
// by anyone, a token drain, an owner takeover) and on VulnerableVault: it must find every bug, each
// finding must replay as valid for the runners, and it must find nothing on the safe fixtures
// (Safe.sol). Also: the same seed gives the same run, the minimised corpus keeps the coverage and
// resumes, and the reproducer file replays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hunt, verifyFinding, reproducerOf, loadEvm } from '../src/usefulwork.js';
import { compileFixtures, fixtureSpecs, specText, hookModule, HOOK_FILE, FIXTURES } from '../scripts/fuzz-fixtures.js';
import { SPEC_FILE } from '../scripts/bounty-spec.js';
import { findingBytes, replay, createWorld, runSteps, codeConstants, jumpdests, fromHex, INVARIANTS } from '../../zetaphy-hub/fuzz-core.js';

const DIR = new URL('./fixtures/fuzz/', import.meta.url);
const read = (name) => readFileSync(new URL(`${name}.json`, DIR), 'utf8');
const strip = (text) => { const { expect, ...spec } = JSON.parse(text); return { spec, expect, text: JSON.stringify(spec) }; };
const VULNERABLE = ['ReentrantBank', 'OpenDelegate', 'KillSwitch', 'LeakyToken', 'OwnerTakeover'];
const SAFE = ['SafeBank', 'SafeVault', 'SafeToken'];

test('fuzz fixtures and the hook bytecode are in sync with their Solidity (node scripts/fuzz-fixtures.js)', () => {
  const bins = compileFixtures();
  for (const [name, { spec, expect }] of Object.entries(fixtureSpecs(bins))) assert.equal(read(name), specText({ ...spec, expect }), name);
  assert.equal(readFileSync(HOOK_FILE, 'utf8'), hookModule(bins));
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...VULNERABLE, ...SAFE].sort());
});

for (const name of VULNERABLE) {
  test(`fuzz: finds every bug in ${name}, and every finding replays as valid`, { timeout: 300_000 }, async () => {
    const { spec, expect, text } = strip(read(name));
    const want = expect.filter((k) => k !== 'reentrancy');
    const res = await hunt(text, { seed: 7, runs: 6000, stopOnFirst: false, want });
    const kinds = new Set(res.findings.flatMap((f) => f.kinds));
    for (const k of expect) assert.ok(kinds.has(k), `${name}: ${k} found (got ${[...kinds].join(', ')})`);
    for (const f of res.findings) {
      const r = await verifyFinding({ specText: text, finding: findingBytes(f.finding) });
      assert.equal(r.valid, true, `${name}: ${JSON.stringify(f.finding)} replays`);
      assert.ok(f.finding.steps.length <= 3, `${name}: shrunk to a few steps: ${JSON.stringify(f.finding)}`);
    }
    assert.ok(res.coverage.pct > 50, `${name}: coverage ${res.coverage.pct}%`);
    assert.equal(spec.version, 2);
    if (name === 'ReentrantBank') {
      // the theft goes through the attacker contract and re-enters withdraw()
      const f = res.findings.find((x) => x.kinds.includes('attacker-profit'));
      assert.ok(f.kinds.includes('reentrancy'));
      const last = f.finding.steps.at(-1);
      assert.equal(last.via, 'hook');
      assert.equal(last.reenter.sig, 'withdraw()');
      assert.ok(f.profit >= 10n ** 18n);
    }
  });
}

for (const name of SAFE) {
  test(`fuzz: no false positive on ${name}`, { timeout: 300_000 }, async () => {
    const { text } = strip(read(name));
    const res = await hunt(text, { seed: 5, runs: 600, stopOnFirst: false });
    assert.deepEqual(res.findings.map((f) => f.kinds), [], `${name}: ${JSON.stringify(res.findings.map((f) => f.finding))}`);
    assert.ok(res.coverage.pct > 50, `${name}: the hunt did reach the code (${res.coverage.pct}%)`);
  });
}

test('fuzz: VulnerableVault: the takeover, the theft, the stuck victim and the insolvency are all found', { timeout: 300_000 }, async () => {
  const text = readFileSync(SPEC_FILE, 'utf8');
  const res = await hunt(text, { seed: 3, runs: 3000, stopOnFirst: false, want: ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'privileged-unchanged'] });
  const kinds = new Set(res.findings.flatMap((f) => f.kinds));
  for (const k of ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'privileged-unchanged']) assert.ok(kinds.has(k), k);
  assert.ok(!kinds.has('no-selfdestruct') && !kinds.has('no-delegatecall-to-attacker'), 'no bug that is not there');
  const takeover = res.findings.find((f) => f.kinds.includes('privileged-unchanged') && !f.kinds.includes('attacker-profit'));
  assert.deepEqual(takeover.finding.steps.map((s) => s.sig), ['initialize()']);
});

test('fuzz: the same seed gives the same run; another seed may not', { timeout: 300_000 }, async () => {
  const { text } = strip(read('LeakyToken'));
  const a = await hunt(text, { seed: 42, runs: 150, stopOnFirst: false });
  const b = await hunt(text, { seed: 42, runs: 150, stopOnFirst: false });
  const pick = (r) => JSON.stringify({ f: r.findings.map((f) => [f.run, f.finding]), cov: r.coverage, corpus: r.corpus.map((c) => c.steps) }, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  assert.equal(pick(a), pick(b));
  const c = await hunt(text, { seed: 43, runs: 150, stopOnFirst: false });
  assert.notEqual(pick(a), pick(c));
});

test('fuzz: the minimised corpus keeps the coverage and a resumed hunt starts from it', { timeout: 300_000 }, async () => {
  const { text } = strip(read('SafeVault'));
  const a = await hunt(text, { seed: 9, runs: 250, stopOnFirst: false });
  const edges = new Set(a.corpus.flatMap((c) => c.edges));
  assert.equal(edges.size, a.coverage.edges, 'set cover keeps every edge');
  const resumed = await hunt(text, { seed: 1, runs: 0, stopOnFirst: false, corpus: a.corpus.map((c) => ({ steps: c.steps })) });
  assert.equal(resumed.coverage.edges, a.coverage.edges, 'replaying the corpus alone reaches the same edges');
});

test('fuzz: reproducer export: steps, seed, trace; it replays (zetaphy work verify-finding takes it)', { timeout: 300_000 }, async () => {
  const { text } = strip(read('KillSwitch'));
  const res = await hunt(text, { seed: 2, runs: 2000 });
  assert.ok(res.finding);
  const repro = await reproducerOf(text, res);
  assert.equal(repro.format, 'zetaphy-fuzz-repro/1');
  assert.equal(repro.seed, 2);
  assert.equal(repro.valid, true);
  assert.equal(repro.trace.length, res.finding.steps.length);
  assert.ok(repro.trace.every((s) => typeof s.ok === 'boolean' && /^\d+$/.test(s.attackerWei)));
  const dir = mkdtempSync(`${tmpdir()}/fuzz-`);
  try {
    writeFileSync(`${dir}/spec.json`, text);
    writeFileSync(`${dir}/repro.json`, JSON.stringify(repro, null, 1));
    const { main } = await import('../cli.js');
    const out = [];
    assert.equal(await main(['work', 'verify-finding', `${dir}/spec.json`, `${dir}/repro.json`], {}, (l) => out.push(l)), 0);
    assert.match(out.join('\n'), /^VALID: invariant broken: .*no-selfdestruct/);
    // the research CLI: same seed, a reproducer and a corpus file
    assert.equal(await main(['work', 'fuzz', `${dir}/spec.json`, '--seed', '2', '--runs', '2000', '--out', `${dir}/r2.json`, '--save-corpus', `${dir}/c.json`], {}, (l) => out.push(l)), 0);
    assert.deepEqual(JSON.parse(readFileSync(`${dir}/r2.json`, 'utf8')).finding, repro.finding);
    assert.ok(Array.isArray(JSON.parse(readFileSync(`${dir}/c.json`, 'utf8'))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fuzz: findings are checked: steps outside the spec, value to non-payable, v2 steps on a v1 spec, bad reenter', async () => {
  const lib = await loadEvm();
  const { spec } = strip(read('ReentrantBank'));
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'selfdestruct()', args: [], value: '0' }] }), /not in the spec/);
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'withdraw()', args: [], value: '1' }] }), /not payable/);
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'withdraw()', args: [], value: '0', reenter: { sig: 'withdraw()', args: [], value: '0', times: 1 } }] }), /reenter needs via/);
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'withdraw()', args: [], value: '0', via: 'hook', reenter: { sig: 'withdraw()', args: [], value: '0', times: 99 } }] }), /bad reenter/);
  const v1 = { ...JSON.parse(readFileSync(SPEC_FILE, 'utf8')), version: 1, invariant: 'attacker-profit' };
  await assert.rejects(replay(lib, v1, { v: 2, steps: [{ sig: 'initialize()', args: [], value: '0', via: 'hook' }] }), /v1 spec takes v1|no via/);
  // a v1 spec still works as before: only attacker profit counts
  assert.equal((await replay(lib, v1, { v: 1, steps: [{ sig: 'initialize()', args: [], value: '0' }] })).valid, false);
  assert.equal((await replay(lib, v1, { v: 1, steps: [{ sig: 'initialize()', args: [], value: '0' }, { sig: 'sweep(address)', args: ['0x00000000000000000000000000000000000a77a1'], value: '0' }] })).valid, true);
  // honest use breaks nothing
  const honest = await replay(lib, spec, { v: 2, steps: [{ sig: 'deposit()', args: [], value: '1000' }, { sig: 'withdraw()', args: [], value: '0' }] });
  assert.equal(honest.valid, false);
  assert.deepEqual(honest.kinds, []);
  // every invariant is broken by at least one fixture
  const covered = new Set(Object.values(FIXTURES).flatMap((f) => f.expect));
  for (const k of INVARIANTS) assert.ok(covered.has(k), `a fixture breaks ${k}`);
});

test('fuzz: the dictionary reads the target\'s own constants; jump targets skip PUSH data', async () => {
  const lib = await loadEvm();
  const { spec } = strip(read('KillSwitch'));
  const w = await createWorld(lib, spec);
  const code = await w.sm.getContractCode(w.target);
  assert.ok(jumpdests(code).length > 5);
  assert.ok(jumpdests(fromHex('0x605b5b')).length === 1, 'the 0x5b inside PUSH1 is data');
  assert.ok(codeConstants(fromHex('0x6911223344556677889900')).includes(0x11223344556677889900n));
  const r = await runSteps(w, [{ sig: 'shutdown(address)', args: ['0x00000000000000000000000000000000000a77a1'], value: '0' }]);
  assert.ok(r.kinds.includes('no-selfdestruct'));
  assert.ok(r.edges.size > 0);
});
