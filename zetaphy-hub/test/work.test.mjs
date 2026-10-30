// "Do useful work" (work.js): its words in the 8 languages, the shared code the browser runs
// (work-core.js ABI codec and commitments, fuzz-core.js on the deliberately vulnerable vault, the
// code-only Neuro scan) and what dist/ ships (the worker, the EVM bundle without eval or wasm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, keccak256 as ethKeccak, toUtf8Bytes } from 'ethers';
import { LANG_CODES } from '../i18n.js';
import { WORK } from '../work-i18n.js';
import { encodeArgs, decodeArgs, calldata, jobCommitment, findingCommitment, codeVerdict, bytes32String, keccakHex } from '../work-core.js';
import { fuzz, replay, ACTORS, specHash, reproducer, INVARIANTS } from '../fuzz-core.js';
import { hubConfig } from '../build.mjs';
import { keccak256 } from '../../zetaphy-neuro/src/keccak.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { build } from '../build.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);

test('every language has every word of the useful-work page, with its placeholders', () => {
  assert.deepEqual(Object.keys(WORK).sort(), [...LANG_CODES].sort());
  const en = shape(WORK.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(WORK[l]), en, l);
    for (const [k, ph] of [['scanning', '{n}'], ['doneScan', '{n}'], ['committing', '{d}'], ['waitingReveal', '{m}'], ['found', '{p}'], ['notFound', '{n}'], ['foundKinds', '{k}'], ['atRun', '{n}'], ['hunting', '{n}']]) {
      assert.ok(WORK[l][k].includes(ph), `${l}.${k} keeps ${ph}`);
    }
    assert.match(WORK[l].vulnNote, /VulnerableVault/);
    assert.match(WORK[l].committing, /ZTPHY/);
    assert.deepEqual(Object.keys(WORK[l].kinds).sort(), [...INVARIANTS, 'reentrancy'].sort(), `${l}: a name for every invariant`);
  }
});

test('the ABI codec and the commitments are the ones ethers / the contracts compute', () => {
  const coder = AbiCoder.defaultAbiCoder();
  const t = ['uint256[]', 'bytes32[]', 'bytes32[]'];
  const v = [[3n, 4n], ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)], ['0x' + '33'.repeat(32), '0x' + '44'.repeat(32)]];
  assert.equal(encodeArgs(t, v), coder.encode(t, v));
  const tuple = ['(address,uint64,bool,bool,uint128,uint128,bytes32,string,uint256[])'];
  const val = [['0x' + 'ab'.repeat(20), 9n, true, false, 5n, 6n, '0x' + 'cd'.repeat(32), 'bounties/x.json', [1n, 2n]]];
  assert.deepEqual(decodeArgs(tuple, coder.encode(tuple, val)), val);
  assert.equal(calldata(keccak256, 'settle(uint256)', [7n]).slice(0, 10), ethKeccak(toUtf8Bytes('settle(uint256)')).slice(0, 10));
  const w = '0x' + '12'.repeat(20), s = '0x' + '34'.repeat(32), x = '0x' + '56'.repeat(32);
  assert.equal(jobCommitment(keccak256, x, w, s, 5n), ethKeccak(coder.encode(['bytes32', 'address', 'bytes32', 'uint256'], [x, w, s, 5n])));
  assert.equal(findingCommitment(keccak256, x, w, s, 0n), ethKeccak(coder.encode(['bytes32', 'address', 'bytes32', 'uint256'], [x, w, s, 0n])));
  assert.equal(bytes32String('zetaphy'), '0x7a65746170687900000000000000000000000000000000000000000000000000');
  assert.throws(() => encodeArgs(['uint8'], [256n]));
});

test('the practice scan job is the vault\'s code, and the code-only verdict is stable', async () => {
  const job = JSON.parse(readFileSync(join(HERE, 'bounties/sample-scan.json'), 'utf8'));
  assert.equal(keccakHex(keccak256, job.code), job.codeHash);
  const neuro = { readContract, verdictOf, keccak256, CHAINS };
  const a = await codeVerdict(neuro, job);
  const b = await codeVerdict(neuro, job);
  assert.equal(a.verdict, b.verdict);
  assert.match(a.verdict, /^0x[0-9a-f]{64}$/);
  await assert.rejects(codeVerdict(neuro, { ...job, codeHash: '0x' + '00'.repeat(32) }), /changed/);
});

test('the fuzzer finds the vulnerable vault\'s bugs (takeover, then initialize + sweep) and replay confirms them', { timeout: 240_000 }, async () => {
  const [{ EVM }, { Common, Chain, Hardfork }, { Address, Account, hexToBytes }] = await Promise.all([import('@ethereumjs/evm'), import('@ethereumjs/common'), import('@ethereumjs/util')]);
  const lib = { EVM, Common, Chain, Hardfork, Address, Account, hexToBytes, keccak256 };
  const text = readFileSync(join(HERE, 'bounties/vulnerable-vault.json'), 'utf8');
  assert.equal(specHash(keccak256, text), ethKeccak(toUtf8Bytes(text)));
  const spec = JSON.parse(text);
  assert.equal(spec.version, 2);
  const seen = [];
  const r = await fuzz(lib, spec, { seed: 123, runs: 3000, stopOnFirst: false, want: ['attacker-profit', 'privileged-unchanged'], onFinding: (f) => seen.push(f.kinds) });
  const theft = r.findings.find((f) => f.kinds.includes('attacker-profit'));
  assert.deepEqual(theft.finding.steps.map((s) => s.sig), ['initialize()', 'sweep(address)']);
  assert.equal(theft.profit, 5n * 10n ** 18n);
  assert.ok(theft.kinds.includes('victim-can-exit') && theft.kinds.includes('balance-conservation'));
  assert.ok(r.findings.some((f) => f.kinds.includes('privileged-unchanged')));
  assert.equal(seen.length, r.findings.length, 'onFinding reports each one as it is found');
  assert.equal((await replay(lib, spec, JSON.stringify(theft.finding))).valid, true);
  assert.ok(r.coverage.pct > 50 && r.coverage.edges > 10);
  const repro = await reproducer(lib, spec, text, { finding: theft.finding, seed: 123 });
  assert.equal(repro.spec.specHash, specHash(keccak256, text));
  assert.deepEqual(repro.trace.map((s) => s.ok), [true, true]);
  // honest use is not a finding; steps outside the spec are refused
  assert.equal((await replay(lib, spec, { v: 2, steps: [{ sig: 'deposit()', args: [], value: '5' }, { sig: 'withdraw(uint256)', args: ['5'], value: '0' }] })).valid, false);
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'selfdestruct()', args: [], value: '0' }] }), /not in the spec/);
  await assert.rejects(replay(lib, spec, { v: 2, steps: [{ sig: 'withdraw(uint256)', args: [], value: '1' }] }), /not payable/);
});

test('hub-config: the useful-work addresses come from zetaphy-network/deployments/useful-work-77390.json (testnet only)', () => {
  const a = (n) => '0x' + String(n).repeat(40);
  const dep = { chainId: 77390, contracts: { usefulWork: a(1), bugBounty: a(2), workerReputation: a(3), usefulIssuance: a(4) } };
  const c = hubConfig({}, { 'zetaphy-network/deployments/useful-work-77390.json': dep });
  assert.equal(c.contracts.usefulWork, a(1));
  assert.equal(c.contracts.bugBounty, a(2));
  assert.equal(c.contracts.usefulIssuance, a(4));
  const other = hubConfig({}, { 'zetaphy-network/deployments/useful-work-77390.json': { ...dep, chainId: 1 } });
  assert.equal(other.contracts.usefulWork, undefined, 'another chain is ignored');
  const none = hubConfig({}, { 'zetaphy-network/deployments/useful-work-77390.json': null });
  assert.equal(none.contracts.usefulWork, undefined, 'not deployed: the page runs as practice');
});

test('dist/ ships the useful-work page, its worker, the bounty files and the EVM bundle (no eval, no wasm)', () => {
  const out = build();
  for (const f of ['work.js', 'work-i18n.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'fuzz-hook.js', 'vendor/evm.js', 'bounties/vulnerable-vault.json', 'bounties/sample-scan.json', 'neuro/src/reader.js']) {
    assert.ok(existsSync(join(out, f)), f);
  }
  for (const f of ['work.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'vendor/evm.js']) {
    assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /\beval\(|new Function\(|WebAssembly/, f);
  }
  // the worker imports Neuro from dist's ./neuro/src/
  assert.match(readFileSync(join(HERE, 'work-worker.js'), 'utf8'), /from '\.\/neuro\/src\/reader\.js'/);
});

test('training work (train-core.js, train-worker.js): words in every language, shipped in dist/, CSP-safe, deterministic', async () => {
  const { practiceJob, dexp } = await import('../train-core.js');
  for (const l of LANG_CODES) {
    const t = WORK[l].train;
    assert.equal(t.how.length, 4, `${l}: 4 steps`);
    for (const [key, ph] of [['training', '{n}'], ['training', '{m}'], ['checking', '{n}'], ['done', '{s}'], ['done', '{n}'], ['done', '{c}']]) assert.ok(t[key].includes(ph), `${l}.train.${key} keeps ${ph}`);
    assert.match(t.note, /TrainingMarket/);
    if (l !== 'en') assert.notEqual(t.intro, WORK.en.train.intro, `${l}: translated`);
  }
  const out = build();
  for (const f of ['train-core.js', 'train-worker.js']) {
    assert.ok(existsSync(join(out, f)), f);
    assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /\beval\(|new Function\(|WebAssembly|importScripts/, f);
  }
  // the worker imports only same-origin modules that dist/ has
  const imports = [...readFileSync(join(HERE, 'train-worker.js'), 'utf8').matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./neuro/src/keccak.js', './train-core.js']);
  for (const f of imports) assert.ok(existsSync(join(out, f)), f);
  assert.deepEqual([...readFileSync(join(HERE, 'train-core.js'), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['./work-core.js']);
  // the practice job: same root twice, its spot-checks pass, and it improves the held-out AUC
  const a = practiceJob(keccak256, {});
  const b = practiceJob(keccak256, {});
  assert.equal(a.root, b.root);
  assert.equal(a.verified.length, 2);
  assert.ok(a.verified.every((v) => v.ok));
  assert.ok(a.metrics.candAuc > a.metrics.baseAuc);
  assert.ok(Math.abs(dexp(1) - Math.E) < 1e-15);
});
