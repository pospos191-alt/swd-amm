import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { CONFIG } from '../src/config.js';
import { indexBuilds, readBuildInfo, loadBuildDir } from '../src/build-info.js';
import { sourcify, etherscan } from '../src/explorers.js';
import { verifyAddress, constructorArgsFrom } from '../src/verify.js';
import { watchChain, addressesInLog, getLogs } from '../src/watch.js';
import { main } from '../cli.js';
import { compile, deployedRuntime, encodeArgs, word, fakeRpc, fakeExplorers, LONG_VERSION } from './helpers/fixture.js';

const TOKEN = 'contracts/LaunchToken.sol:LaunchToken';
const FACTORY_FQN = 'contracts/LaunchFactory.sol:LaunchFactory';
const FACTORY = '0xce1b4d160e13f11a9ad503f6b8cf0770e55d69da';
const T1 = '0x1111111111111111111111111111111111111111';
const T2 = '0x2222222222222222222222222222222222222222';
const CREATOR = '0x3333333333333333333333333333333333333333';
const noSleep = async () => {};

let bi, builds, tokenCreation;
before(async () => {
  bi = compile();
  builds = await indexBuilds([{ input: bi.input, longVersion: bi.solcLongVersion, output: bi.output }]);
  tokenCreation = bi.output.contracts['contracts/LaunchToken.sol'].LaunchToken.evm.bytecode.object;
});

const explorersFor = (fetchImpl, apiKey = 'test-key') => [
  sourcify({ fetchImpl, sleep: noSleep }),
  etherscan({ apiKey, fetchImpl, sleep: noSleep, gapMs: 0 }),
];

test('config event topic is keccak256 of the event signature', () => {
  assert.equal(CONFIG.eventTopic, '0x' + bytesToHex(keccak_256(utf8ToBytes(CONFIG.eventSignature))));
});

test('every chain config is complete', () => {
  for (const [key, c] of Object.entries(CONFIG.chains)) {
    assert.ok(Number.isInteger(c.chainId) && c.rpcs.length && c.lookbackBlocks > 0 && c.logChunk > 0, key);
    for (const f of c.factories) assert.match(f, /^0x[0-9a-f]{40}$/, key);
  }
});

describe('build-info', () => {
  test('matches on-chain code whatever its immutables hold', async () => {
    for (const fill of ['ab', '01', 'ff']) {
      const { codeFingerprint } = await import('../../zetaphy-neuro/src/fingerprint.js');
      const fp = await codeFingerprint(deployedRuntime(bi, 'contracts/LaunchToken.sol', 'LaunchToken', fill));
      assert.equal(builds.byFingerprint(fp)?.fqn, TOKEN);
    }
  });

  test('reads Hardhat 2 (inline output) and Hardhat 3 (sibling .output.json) files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(bi));
    const { output, ...rest } = bi;
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...rest, _format: 'hh3-sol-build-info-1' }));
    writeFileSync(join(dir, 'b.output.json'), JSON.stringify({ output }));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const idx = await loadBuildDir(dir);
    assert.equal(idx.contracts.filter((c) => c.fqn === TOKEN).length, 2);
    assert.equal(idx.byFingerprint(builds.contracts.find((c) => c.fqn === TOKEN).fingerprint).longVersion, LONG_VERSION);
  });

  test('refuses a file without the full compiler version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-'));
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ ...bi, solcLongVersion: undefined, solcVersion: '0.8.26' }));
    assert.throws(() => readBuildInfo(join(dir, 'x.json')), /full compiler version/);
  });

  test('a missing directory gives an empty index', async () => {
    assert.equal((await loadBuildDir('/nonexistent/zv')).contracts.length, 0);
  });
});

test('constructor arguments are the creation code after the compiled prefix', () => {
  const args = encodeArgs('NEWZETA', 300, CREATOR, 10n ** 27n);
  assert.equal(constructorArgsFrom('0x' + tokenCreation + args, tokenCreation), args);
  assert.equal(constructorArgsFrom('0x6080' + args, tokenCreation), null);
});

describe('verifyAddress', () => {
  const chainId = 56;
  const code = () => ({ [T1]: deployedRuntime(bi, 'contracts/LaunchToken.sol', 'LaunchToken') });

  test('submits the exact source to Sourcify and Etherscan, then reports verified', async () => {
    const args = encodeArgs('NEWZETA', 300, CREATOR, 10n ** 27n);
    const { state, fetchImpl } = fakeExplorers({ creation: { [T1]: '0x' + tokenCreation + args } });
    const tx = '0x' + 'a'.repeat(64);
    const r = await verifyAddress({ chainId: 8453, address: T1, txHash: tx, rpc: fakeRpc({ code: code() }), builds, explorers: explorersFor(fetchImpl) });
    assert.equal(r.status, 'done');
    assert.equal(r.contract, TOKEN);
    assert.deepEqual(Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.status])), { sourcify: 'verified', etherscan: 'verified' });

    const s = state.submissions.find((x) => x.explorer === 'sourcify');
    assert.equal(s.chainId, '8453');
    assert.equal(s.body.compilerVersion, LONG_VERSION);
    assert.equal(s.body.contractIdentifier, TOKEN);
    assert.equal(s.body.creationTransactionHash, tx);
    assert.deepEqual(s.body.stdJsonInput, bi.input);

    const e = state.submissions.find((x) => x.explorer === 'etherscan').form;
    assert.equal(e.codeformat, 'solidity-standard-json-input');
    assert.equal(e.contractname, TOKEN);
    assert.equal(e.compilerversion, `v${LONG_VERSION}`);
    assert.equal(e.constructorArguements, args);
    assert.deepEqual(JSON.parse(e.sourceCode), bi.input);
  });

  test('second run submits nothing: already verified', async () => {
    const { state, fetchImpl } = fakeExplorers({ creation: { [T1]: '0x' + tokenCreation } });
    const ex = explorersFor(fetchImpl);
    const rpc = fakeRpc({ code: code() });
    await verifyAddress({ chainId, address: T1, rpc, builds, explorers: ex });
    const before = state.submissions.length;
    const r = await verifyAddress({ chainId, address: T1, rpc, builds, explorers: ex });
    assert.equal(state.submissions.length, before);
    assert.ok(Object.values(r.results).every((x) => x.status === 'already-verified'));
  });

  test('Etherscan free tier on BNB Chain: Sourcify still verifies, run is not a failure', async () => {
    const { state, fetchImpl } = fakeExplorers({ planBlocked: [56] });
    const r = await verifyAddress({ chainId: 56, address: T1, rpc: fakeRpc({ code: code() }), builds, explorers: explorersFor(fetchImpl) });
    assert.equal(r.status, 'done');
    assert.equal(r.results.sourcify.status, 'verified');
    assert.equal(r.results.etherscan.status, 'plan-required');
    assert.equal(state.submissions.filter((x) => x.explorer === 'etherscan').length, 0);
  });

  test('without an Etherscan key only Sourcify is used', async () => {
    const { state, fetchImpl } = fakeExplorers();
    const r = await verifyAddress({ chainId, address: T1, rpc: fakeRpc({ code: code() }), builds, explorers: explorersFor(fetchImpl, '') });
    assert.deepEqual(Object.keys(r.results), ['sourcify']);
    assert.equal(state.submissions.length, 1);
  });

  test('never submits code that is not in build-info, or an empty address', async () => {
    const { state, fetchImpl } = fakeExplorers();
    const rpc = fakeRpc({ code: { [T1]: '0x6080604052348015600f57600080fd5b50' } });
    assert.equal((await verifyAddress({ chainId, address: T1, rpc, builds, explorers: explorersFor(fetchImpl) })).status, 'skipped');
    assert.equal((await verifyAddress({ chainId, address: T2, rpc, builds, explorers: explorersFor(fetchImpl) })).detail, 'no code at this address');
    assert.equal(state.submissions.length, 0);
  });

  test('a rejected verification is reported as failed', async () => {
    const { fetchImpl } = fakeExplorers({ sourcifyFails: true });
    const r = await verifyAddress({ chainId, address: T1, rpc: fakeRpc({ code: code() }), builds, explorers: explorersFor(fetchImpl, '') });
    assert.equal(r.status, 'failed');
    assert.match(r.results.sourcify.detail, /mismatch/);
  });

  test('creation code from a different build is not sent to Etherscan', async () => {
    const { state, fetchImpl } = fakeExplorers({ creation: { [T1]: '0xdeadbeef' } });
    const r = await verifyAddress({ chainId: 1, address: T1, rpc: fakeRpc({ code: code() }), builds, explorers: explorersFor(fetchImpl) });
    assert.equal(r.results.etherscan.status, 'failed');
    assert.equal(state.submissions.filter((x) => x.explorer === 'etherscan').length, 0);
  });
});

describe('watch', () => {
  const topic = CONFIG.eventTopic;
  const ev = (token, creator, blockNumber, tx) => ({
    address: FACTORY, blockNumber, transactionHash: tx, topics: [topic, '0x' + word(token), '0x' + word(creator)], data: '0x',
  });

  test('addressesInLog reads indexed topics and data words', () => {
    assert.deepEqual(addressesInLog(ev(T1, CREATOR, 1, '0x')), [T1, CREATOR]);
    assert.deepEqual(addressesInLog({ topics: [topic], data: '0x' + word(T2) + word('1f4') }), [T2]);
  });

  test('getLogs halves the range when the RPC refuses it', async () => {
    const rpc = fakeRpc({ logs: [ev(T1, CREATOR, 10, '0x01'), ev(T2, CREATOR, 900, '0x02')], maxRange: 300 });
    const logs = await getLogs(rpc, { addresses: [FACTORY], topic, from: 0, to: 999, chunk: 1000 });
    assert.equal(logs.length, 2);
  });

  test('finds new tokens from the factory and verifies factory and tokens', async () => {
    const tokenCode = deployedRuntime(bi, 'contracts/LaunchToken.sol', 'LaunchToken');
    const rpc = fakeRpc({
      code: { [FACTORY]: deployedRuntime(bi, 'contracts/LaunchFactory.sol', 'LaunchFactory'), [T1]: tokenCode, [T2]: deployedRuntime(bi, 'contracts/LaunchToken.sol', 'LaunchToken', '07') },
      logs: [ev(T1, CREATOR, 950, '0x' + '1'.repeat(64)), ev(T2, CREATOR, 990, '0x' + '2'.repeat(64)), ev(T1, CREATOR, 100, '0x' + '3'.repeat(64))],
      latest: 1000,
    });
    const { state, fetchImpl } = fakeExplorers();
    const chain = { ...CONFIG.chains.bsc, lookbackBlocks: 200, logChunk: 50 };
    const out = await watchChain({ chain, factories: [FACTORY], rpc, builds, explorers: explorersFor(fetchImpl, ''), topic });
    assert.deepEqual(out.map((r) => [r.kind, r.address, r.contract, r.status]), [
      ['factory', FACTORY, FACTORY_FQN, 'done'],
      ['token', T1, TOKEN, 'done'],
      ['token', T2, TOKEN, 'done'],
    ]);
    // The event at block 100 is outside the lookback window.
    assert.equal(state.submissions.find((s) => s.address === T1).body.creationTransactionHash, '0x' + '1'.repeat(64));
  });

  test('a factory address that is empty on this chain is ignored', async () => {
    const rpc = fakeRpc({ chainId: 8453 });
    const { fetchImpl } = fakeExplorers();
    const out = await watchChain({ chain: CONFIG.chains.base, factories: [FACTORY], rpc, builds, explorers: explorersFor(fetchImpl, ''), topic });
    assert.deepEqual(out, []);
    assert.ok(!rpc.calls.some(([m]) => m === 'eth_getLogs'));
  });

  test('a probed address holding some other contract is not used', async () => {
    const rpc = fakeRpc({ code: { [FACTORY]: '0x6080604052348015600f57600080fd5b50' } });
    const { fetchImpl } = fakeExplorers();
    const out = await watchChain({ chain: CONFIG.chains.base, factories: [FACTORY], rpc, builds, explorers: explorersFor(fetchImpl, ''), topic });
    assert.deepEqual(out, []);
  });
});

test('cli: without build-info it explains what to do and exits 0', async () => {
  const lines = [];
  assert.equal(await main(['watch'], {}, (l) => lines.push(l)), 0);
  assert.match(lines.join('\n'), /No build-info/);
});

describe('export for the free web form', async () => {
  const { findContract, exportForWebForm } = await import('../src/export.js');
  test('writes the Standard-JSON-Input and the form values', () => {
    const c = findContract(builds, 'LaunchToken');
    assert.equal(c.fqn, TOKEN);
    const dir = mkdtempSync(join(tmpdir(), 'zv-out-'));
    const { file, form } = exportForWebForm(c, dir);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), bi.input);
    assert.equal(form['Compiler Version'], `v${LONG_VERSION}`);
    assert.equal(form['Compiler Type'], 'Solidity (Standard-Json-Input)');
    assert.match(form['Open Source License Type'], /MIT/);
    assert.match(form.Optimizer, /on, 200 runs/);
  });
  test('names the contracts it has when the name is wrong', () => {
    assert.throws(() => findContract(builds, 'Nope'), /LaunchToken/);
  });
});
