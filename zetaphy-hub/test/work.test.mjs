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
import { fuzz, replay, ACTORS, specHash } from '../fuzz-core.js';
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
    for (const [k, ph] of [['scanning', '{n}'], ['doneScan', '{n}'], ['committing', '{d}'], ['waitingReveal', '{m}'], ['found', '{p}'], ['notFound', '{n}']]) {
      assert.ok(WORK[l][k].includes(ph), `${l}.${k} keeps ${ph}`);
    }
    assert.match(WORK[l].vulnNote, /VulnerableVault/);
    assert.match(WORK[l].committing, /ZTPHY/);
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

test('the fuzzer finds the vulnerable vault\'s bug (initialize + sweep) and replay confirms it', async () => {
  const [{ EVM }, { Common, Chain, Hardfork }, { Address, Account, hexToBytes }] = await Promise.all([import('@ethereumjs/evm'), import('@ethereumjs/common'), import('@ethereumjs/util')]);
  const lib = { EVM, Common, Chain, Hardfork, Address, Account, hexToBytes, keccak256 };
  const text = readFileSync(join(HERE, 'bounties/vulnerable-vault.json'), 'utf8');
  assert.equal(specHash(keccak256, text), ethKeccak(toUtf8Bytes(text)));
  const spec = JSON.parse(text);
  const r = await fuzz(lib, spec, { seed: 123, runs: 3000 });
  assert.ok(r.finding);
  assert.deepEqual(r.finding.steps, [{ sig: 'initialize()', args: [], value: '0' }, { sig: 'sweep(address)', args: [ACTORS.attacker], value: '0' }]);
  assert.equal((await replay(lib, spec, JSON.stringify(r.finding))).valid, true);
  // honest use is not a finding; steps outside the spec are refused
  assert.equal((await replay(lib, spec, { v: 1, steps: [{ sig: 'deposit()', args: [], value: '5' }, { sig: 'withdraw(uint256)', args: ['5'], value: '0' }] })).valid, false);
  await assert.rejects(replay(lib, spec, { v: 1, steps: [{ sig: 'selfdestruct()', args: [], value: '0' }] }), /not in the spec/);
  await assert.rejects(replay(lib, spec, { v: 1, steps: [{ sig: 'withdraw(uint256)', args: [], value: '1' }] }), /not payable/);
});

test('dist/ ships the useful-work page, its worker, the bounty files and the EVM bundle (no eval, no wasm)', () => {
  const out = build();
  for (const f of ['work.js', 'work-i18n.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'vendor/evm.js', 'bounties/vulnerable-vault.json', 'bounties/sample-scan.json', 'neuro/src/reader.js']) {
    assert.ok(existsSync(join(out, f)), f);
  }
  for (const f of ['work.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'vendor/evm.js']) {
    assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /\beval\(|new Function\(|WebAssembly/, f);
  }
  // the worker imports Neuro from dist's ./neuro/src/
  assert.match(readFileSync(join(HERE, 'work-worker.js'), 'utf8'), /from '\.\/neuro\/src\/reader\.js'/);
});
