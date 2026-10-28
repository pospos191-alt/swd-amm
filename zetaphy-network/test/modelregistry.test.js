// ModelRegistry (contracts/ModelRegistry.sol) on an in-memory EVM: governance-only
// publishing and status, the guardian's immediate suspend, everything going through
// ZetaphyTimelock, and the browser side reading it: zetaphy-neuro's registry reader
// and verified loader against the real contract, and its on-chain knowledge reader
// against real ThreatRegistry / NeuroJobs logs (keys cross-checked with ethers and
// src/vaccine.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ZeroHash, ZeroAddress, getAddress, AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { bytesToHex } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { registryIdOf, publishCall, statusCall, timelockOp, STATUSES } from '../src/modelregistry.js';
import { codeKey as vCodeKey, addressKey as vAddressKey } from '../src/vaccine.js';
import { registryId, readLatest, readRelease } from '../../zetaphy-neuro/ai/browser/registry.js';
import { buildManifest } from '../../zetaphy-neuro/ai/browser/manifest.js';
import { loadVerified } from '../../zetaphy-neuro/ai/browser/loader.js';
import { createKnowledgeIndex, addressKey, codeKey } from '../../zetaphy-neuro/ai/onchain.js';

const DELAY = 48n * 3600n;
const H = (b) => '0x' + b.repeat(32);
const REL = { kind: 'model', name: 'neuro-ml-gbdt', version: 1, manifestHash: H('5b'), chunkRoot: H('fa'), size: 87087, chunkSize: 16384, license: 'BUSL-1.1' };

async function setup() {
  const c = await createChain(['deployer', 'multisig', 'guardian', 'anyone', 'eve', 'author']);
  const A = (n) => getAddress(c.acct[n].toString());
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('multisig')], [ZeroAddress], ZeroAddress], 'deployer');
  const reg = await c.deploy('ModelRegistry', [tl.address], 'deployer');
  const govern = async (data, salt = ZeroHash) => {
    await tl.send('multisig', 'schedule', [reg.address, 0, data, ZeroHash, salt, DELAY]);
    c.advance(DELAY);
    return tl.send('anyone', 'execute', [reg.address, 0, data, ZeroHash, salt]);
  };
  return { c, A, tl, reg, govern };
}
/** eth_call for the browser reader, answered by the in-memory EVM. */
const readerOf = (c) => ({ call: async (method, params) => { assert.equal(method, 'eth_call'); return c.rawCall(params[0].to, params[0].data); } });

test('ids: on-chain idOf = src/modelregistry.js = the browser reader', async () => {
  const { reg } = await setup();
  for (const [k, n] of [[1, 'neuro-ml-gbdt'], [2, 'neuro-skill'], [3, 'analyst-prompt'], [4, 'rules-v7']]) {
    const onChain = await reg.call('idOf', [k, n]);
    assert.equal(onChain, registryIdOf(k, n));
    assert.equal(onChain, registryId(k, n));
  }
});

test('only governance publishes and sets status; versions only go up; bad records are refused', async () => {
  const { c, A, reg } = await setup();
  const p = publishCall(REL, A('author'));
  await assert.rejects(c.sendTo('deployer', reg.address, reg.iface, 'publish', p.args), /NotGovernance/, 'not even the deployer');
  await assert.rejects(c.sendTo('eve', reg.address, reg.iface, 'setStatus', statusCall('model', REL.name, 1, 'revoked').args), /NotGovernance/);
  await assert.rejects(reg.send('eve', 'setGuardian', [A('eve'), true]), /NotGovernance/);
  await assert.rejects(reg.send('eve', 'suspend', [p.id, 1]), /NotGuardian/);
  await assert.rejects(c.deploy('ModelRegistry', [ZeroAddress], 'deployer'));
  assert.equal(await reg.call('idCount'), 0n);
});

test('through ZetaphyTimelock: publish waits the delay; the guardian suspends at once; only the timelock re-activates; revoked is final', async () => {
  const { c, A, tl, reg, govern } = await setup();
  const p = publishCall(REL, A('author'));
  // the multisig (proposer) is not governance itself
  await assert.rejects(reg.send('multisig', 'publish', p.args), /NotGovernance/);
  // scheduled, not yet executable
  const op = timelockOp(reg.address, p.data, { delay: Number(DELAY) });
  await tl.send('multisig', 'schedule', [reg.address, 0, p.data, ZeroHash, ZeroHash, DELAY]);
  assert.equal(await tl.call('getOperationState', [op.id]), 1n, 'Waiting: visible to all for 48 h');
  await assert.rejects(tl.send('anyone', 'execute', [reg.address, 0, p.data, ZeroHash, ZeroHash]), /TimelockUnexpectedOperationState/);
  c.advance(DELAY);
  const ev = await tl.send('anyone', 'execute', [reg.address, 0, p.data, ZeroHash, ZeroHash]);
  assert.ok(ev.some((e) => e?.name === 'CallExecuted'));
  // the browser reader sees it
  const r = await readLatest(readerOf(c), reg.address, p.id);
  assert.equal(r.version, 1);
  assert.equal(r.status, 'active');
  assert.equal(r.kind, 'model');
  assert.equal(r.manifestHash, REL.manifestHash);
  assert.equal(r.chunkRoot, REL.chunkRoot);
  assert.equal(Number(r.size), REL.size);
  assert.equal(r.chunkSize, REL.chunkSize);
  assert.equal(r.license, 'BUSL-1.1');
  assert.equal(getAddress(r.author), A('author'));
  assert.equal(r.publishedAt, Number(c.now()));
  assert.equal(await reg.call('isUsable', [p.id, 1, REL.manifestHash, REL.chunkRoot]), true);
  assert.equal(await reg.call('isUsable', [p.id, 1, REL.manifestHash, H('00')]), false);
  // same version again, an older one, or another kind under this id: refused
  await assert.rejects(govern(p.data, H('01'))); // BadVersion inside the timelock's call
  // (another kind under the same id: KindMismatch, see the record checks test)
  // guardian: named by governance, then suspends at once (no delay)
  await govern(reg.iface.encodeFunctionData('setGuardian', [A('guardian'), true]), H('03'));
  await reg.send('guardian', 'suspend', [p.id, 1]);
  assert.equal((await readRelease(readerOf(c), reg.address, p.id, 1)).status, 'suspended');
  await assert.rejects(reg.send('guardian', 'suspend', [p.id, 1]), /BadValue/, 'already suspended');
  await assert.rejects(reg.send('guardian', 'setStatus', [p.id, 1, 1]), /NotGovernance/, 'the guardian cannot re-activate');
  await govern(statusCall('model', REL.name, 1, 'active').data, H('04'));
  assert.equal(STATUSES[Number((await reg.call('release', [p.id, 1])).status)], 'active');
  // version 2 published, version 1 revoked: final
  await govern(publishCall({ ...REL, version: 2, manifestHash: H('5c') }, A('author')).data, H('05'));
  await govern(statusCall('model', REL.name, 1, 'revoked').data, H('06'));
  await assert.rejects(govern(statusCall('model', REL.name, 1, 'active').data, H('07')));
  assert.equal((await readRelease(readerOf(c), reg.address, p.id, 1)).status, 'revoked');
  assert.equal((await readLatest(readerOf(c), reg.address, p.id)).version, 2);
  assert.equal(await reg.call('idCount'), 1n);
  assert.equal(await reg.call('idAt', [0]), p.id);
});

test('record checks: license, chunk size, zero hashes, author', async () => {
  const { c, A, reg } = await setup();
  // a registry whose governance is a plain test key, to reach the checks directly
  const r2 = await c.deploy('ModelRegistry', [A('multisig')], 'deployer');
  const base = publishCall(REL, A('author')).args;
  const bad = [
    { 8: '' }, { 8: 'has space' }, { 8: 'x'.repeat(65) }, { 6: 1023 }, { 6: 64 * 1024 * 1024 + 1 }, { 5: 0 },
    { 3: ZeroHash }, { 4: ZeroHash }, { 7: ZeroAddress }, { 1: 0 }, { 0: ZeroHash },
  ];
  for (const b of bad) {
    const a = [...base];
    for (const [i, v] of Object.entries(b)) a[i] = v;
    await assert.rejects(r2.send('multisig', 'publish', a), /BadValue/, JSON.stringify(b));
  }
  await r2.send('multisig', 'publish', base);
  await assert.rejects(r2.send('multisig', 'setStatus', [base[0], 1, 0]), /BadValue/);
  await assert.rejects(r2.send('multisig', 'setStatus', [base[0], 9, 2]), /UnknownRelease/);
  const other = [...base]; other[1] = 2; other[2] = 2;
  await assert.rejects(r2.send('multisig', 'publish', other), /KindMismatch/);
  assert.equal(reg.address !== r2.address, true);
});

test('end to end: a pack built by zetaphy-neuro, published on chain, loaded by the browser loader against the chain record', async () => {
  const { c, A, reg, govern } = await setup();
  const weights = new Uint8Array(40_000).map((_, i) => (i * 31) & 255);
  const built = await buildManifest(weights, { name: 'toy-mlp', runtime: 'zmlp/1', license: 'MIT', chunkSize: 8192 });
  const rel = { kind: 'model', name: 'toy-mlp', version: 1, manifestHash: '0x' + built.manifestHash, chunkRoot: '0x' + built.manifest.root, size: built.manifest.size, chunkSize: built.manifest.chunkSize, license: 'MIT' };
  const p = publishCall(rel, A('author'));
  await govern(p.data);
  const onChain = await readLatest(readerOf(c), reg.address, registryId('model', 'toy-mlp'));
  const files = new Map([['https://m.example/manifest.json', built.bytes], ...built.chunks.map((x) => [`https://m.example/${x.hash}.bin`, x.data])]);
  const fetchImpl = async (u) => (files.has(u) ? { ok: true, headers: new Map(), arrayBuffer: async () => files.get(u).slice().buffer } : { ok: false, status: 404, headers: new Map() });
  const mirrors = [{ manifest: 'https://m.example/manifest.json', chunk: 'https://m.example/{hash}.bin' }];
  const out = await loadVerified({ release: onChain, mirrors, fetchImpl });
  assert.deepEqual(out.bytes, weights);
  // the guardian pulls it: the loader refuses at once
  await govern(reg.iface.encodeFunctionData('setGuardian', [A('guardian'), true]), H('09'));
  await reg.send('guardian', 'suspend', [p.id, 1]);
  await assert.rejects(loadVerified({ release: await readLatest(readerOf(c), reg.address, p.id), mirrors, fetchImpl }), /suspended/);
});

test('on-chain knowledge: the browser index reads real ThreatRegistry and NeuroJobs logs; vaccine keys match the contract', async () => {
  const BOND = 100n * ZETA;
  const V = H('11');
  const c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4']);
  const addr = (w) => c.acct[w].toString();
  const jobs = await c.deploy('NeuroJobs', [BOND, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'owner');
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], BOND);
  c.advance(1);
  const raw = [];
  const keep = (res, block) => { for (const [a, topics, data] of res.execResult.logs ?? []) raw.push({ address: bytesToHex(a), topics: topics.map(bytesToHex), data: bytesToHex(data), blockNumber: '0x' + block.toString(16), logIndex: '0x0' }); };
  const TARGET = '0x' + 'ab'.repeat(20);
  for (const seats of [['w1', 'w2', 'w3'], ['w4', 'w1', 'w2']]) {
    keep(await c.sendTo('user', jobs.address, jobs.iface, 'request', [encodeBytes32String('bsc'), TARGET], ZETA / 10n), c.blockNumber());
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) {
      salts[w] = hexlify(randomBytes(32));
      await jobs.send(w, 'commit', [id, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [V, addr(w), salts[w]]))]);
    }
    for (const w of seats) { try { keep(await c.sendTo(w, jobs.address, jobs.iface, 'reveal', [id, V, salts[w]]), c.blockNumber()); } catch { /* closed */ } }
  }
  const reg = await c.deploy('ThreatRegistry', [jobs.address, 3, 1, addr('owner'), 0], 'owner');
  // keys: the browser's = the contract's = the vaccine's
  const codeHash = H('c0');
  assert.equal(codeKey(codeHash), await reg.call('codeKey', [codeHash]));
  assert.equal(codeKey(codeHash), vCodeKey(codeHash));
  assert.equal(addressKey(56, TARGET), await reg.call('addressKey', [56, TARGET]));
  assert.equal(addressKey(56, TARGET), vAddressKey(56, TARGET));
  const key = addressKey(56, TARGET);
  for (const w of ['w1', 'w2', 'w4']) keep(await c.sendTo(w, reg.address, reg.iface, 'vote', [key, true, 3, H('e7'), 'neuro:bsc:' + TARGET]), c.blockNumber());
  assert.deepEqual([...await reg.call('isFlagged', [key])], [true, 3n]);
  // the index from these raw logs (as eth_getLogs would return them)
  const idx = createKnowledgeIndex();
  const reader = { call: async (m, params) => {
    if (m === 'eth_blockNumber') return '0x' + c.blockNumber().toString(16);
    const q = params[0];
    return raw.filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && q.topics[0].includes(l.topics[0]) && Number(l.blockNumber) >= Number(q.fromBlock) && Number(l.blockNumber) <= Number(q.toBlock));
  } };
  await idx.sync(reader, { threatRegistry: reg.address, neuroJobs: jobs.address, step: 50 });
  const hits = idx.lookup({ chain: 'bsc', chainId: 56, address: TARGET }, { verdict: V });
  assert.equal(hits.threat.length, 1);
  assert.equal(hits.threat[0].kind, 'address');
  assert.equal(hits.threat[0].flagged, true);
  assert.equal(hits.threat[0].reason, 3);
  assert.equal(hits.threat[0].votes, 3);
  assert.equal(hits.threat[0].evidence[0].uri, 'neuro:bsc:' + TARGET);
  assert.equal(hits.threat[0].evidence[0].reportHash, H('e7'));
  const finalized = hits.verdicts.filter((v) => v.verdict === V);
  assert.ok(finalized.length >= 1, 'a finalized job on the same target');
  assert.ok(finalized.every((v) => v.sameAsThisReport === true));
});
