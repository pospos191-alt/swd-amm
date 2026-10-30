// Proven verdicts, off-chain side (src/zkverdict/): zfeat/1 is a pure function of the code; a NeuroJobs runner
// answers a "zfeat/1:<token>:<codehash>" job with keccak256 of those features (and refuses changed code); the
// browser checker (zetaphy-hub/zkverdict-core.js) agrees with the on-chain verifier and checks a verdict posted to
// the REAL ProvenVerdicts end to end; the prover wraps the existing circuit (run only when its artifacts are there:
// ZKVERDICT_ZK_OUT=<zetaphy-neuro/ml/onchain/zk/out>, after `node run.js` in that package).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeroHash, encodeBytes32String, keccak256 } from 'ethers';
import { createChain } from './helpers/evm.js';
import { zfeat1, featureTarget, parseFeatureTarget, featureVerdict, FIXED, codeReport } from '../src/zkverdict/features.js';
import { createProver, loadVerifyLib } from '../src/zkverdict/prover.js';
import { MODEL_ID } from '../src/zkverdict/job.js';
import { createWorker, commitmentOf } from '../src/worker.js';
import { verifyGroth16, publicSignals, checkProvenVerdict } from '../../zetaphy-hub/zkverdict-core.js';
import { evalFixed, fromHex, quantizeVector, packFeatures } from '../../zetaphy-neuro/ml/onchain/fixed.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/neuroscore-zk.json', import.meta.url), 'utf8'));
const VK = JSON.parse(readFileSync(new URL('../../zetaphy-hub/zkverdict-vkey.json', import.meta.url), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('../../zetaphy-neuro/ml/onchain/heldout.json', import.meta.url), 'utf8'));
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const CODE = art('ThreatRegistry').deployedBytecode;

test('zfeat/1: a pure function of the runtime code; packed for NeuroScore; hashes; the target format', () => {
  const a = zfeat1(CODE);
  const b = zfeat1(CODE.toUpperCase().replace(/^0X/, '0x'));
  assert.deepEqual(a, b, 'same code (any hex case) -> same features');
  assert.equal(a.q.length, FIXED.features.length);
  assert.equal(a.packed.length, 2 + 8 * FIXED.features.length);
  assert.equal(a.featuresHash, keccak256(a.packed));
  assert.equal(a.codeHash, keccak256(CODE.toLowerCase()));
  assert.deepEqual(evalFixed(fromHex(FIXED.bytes), a.q).score, a.score);
  // code-only profile: no simulation (m_*) and every market fact unknown (k_*_known = 0)
  for (const [i, n] of FIXED.features.entries()) if (/^m_|^k_/.test(n)) assert.equal(a.q[i], 0, n);
  assert.ok(a.q.filter(Boolean).length > 40, 'code features are there');
  assert.equal(codeReport(CODE).analysis.control, 'unknown', 'no RPC read: owner unknown');
  assert.notEqual(zfeat1(art('NeuroJobs').deployedBytecode).featuresHash, a.featuresHash);
  assert.throws(() => zfeat1('0x'), /non-empty/);
  const t = featureTarget('0xABCDEF0000000000000000000000000000000001', a.codeHash.toUpperCase().replace(/^0X/, '0x'));
  assert.equal(t, `zfeat/1:0xabcdef0000000000000000000000000000000001:${a.codeHash}`);
  assert.deepEqual(parseFeatureTarget(t), { token: '0xabcdef0000000000000000000000000000000001', codeHash: a.codeHash });
  assert.equal(parseFeatureTarget('0xabcdef0000000000000000000000000000000001'), null);
});

test('a runner answers a zfeat/1 NeuroJobs job with keccak256(features); refuses code that is not the target\'s', async () => {
  const token = '0x' + 'aa'.repeat(20);
  const f = zfeat1(CODE);
  const call = async (m, [a]) => { assert.equal(m, 'eth_getCode'); assert.equal(a, token); return CODE; };
  assert.equal((await featureVerdict(call, featureTarget(token, f.codeHash))).verdict, f.featuresHash);
  await assert.rejects(featureVerdict(call, featureTarget(token, ZeroHash)), /code hash/);
  // through the worker (the NeuroJobs runner loop), on chain "zetaphy"
  const ME = '0x00000000000000000000000000000000000000aa';
  const commits = {};
  const job = { chain: encodeBytes32String('zetaphy'), target: featureTarget(token, f.codeHash), created: 0n, status: 1n, commits: 0n };
  const jobs = {
    commitWindow: async () => 100n, eligible: async () => true, jobCount: async () => 1n, getJob: async () => job,
    commit: async (id, c) => { commits[id] = c; job.commits += 1n; return { wait: async () => {} }; },
    reveal: async () => ({ wait: async () => {} }),
  };
  const stateFile = join(mkdtempSync(join(tmpdir(), 'zkv-')), 'state.json');
  const reads = [];
  const w = createWorker({ jobs, me: ME, stateFile, zetaphyChain: null, chainTime: async () => 10n, featureCall: call,
    read: async (...a) => { reads.push(a); throw new Error('a feature job never runs the Neuro reader'); } });
  await w.tick();
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')).seats['0'];
  assert.equal(saved.verdict, f.featuresHash);
  assert.equal(commits[0], commitmentOf(f.featuresHash, ME, saved.salt));
  assert.deepEqual(reads, []);
});

test('the browser checker = the on-chain verifier on the fixture and its tampered / foreign versions', async () => {
  const lib = await loadVerifyLib();
  const c = await createChain(['deployer']);
  const v = await c.deploy('NeuroScoreVerifier', [], 'deployer');
  const cases = [['fixture', FX, FX.publicSignals], ['non-final key', FX.nonFinal, FX.publicSignals], ['forged key', FX.forged, FX.publicSignals],
    ['margin - 1', FX, [FX.publicSignals[0], '0x' + (BigInt(FX.publicSignals[1]) - 1n).toString(16), FX.publicSignals[2], FX.publicSignals[3]]]];
  for (const [what, x, pub] of cases) {
    const chain = await v.call('verifyProof', [x.a, x.b, x.c, pub]);
    const js = verifyGroth16(lib, VK, x, pub.map(BigInt));
    assert.equal(js, chain, what);
  }
  assert.equal(verifyGroth16(lib, VK, FX, publicSignals(FX.publicSignals[0], FX.publicSignals[1], VK.modelHash)), true);
});

test('end to end: a verdict posted to the real ProvenVerdicts is re-checked by the browser checker from its logs', async () => {
  const lib = await loadVerifyLib();
  const DELAY = 48n * 3600n;
  const c = await createChain(['deployer', 'multisig', 'gov', 'runner']);
  const A = (n) => c.acct[n].toString();
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('multisig')], ['0x' + '00'.repeat(20)], '0x' + '00'.repeat(20)], 'deployer');
  const ns = await c.deploy('NeuroScore', [tl.address], 'deployer');
  await ns.send('deployer', 'publishModel', [FIXED.bytes]);
  const data = ns.iface.encodeFunctionData('activateModel', [FIXED.hash, encodeBytes32String(FIXED.modelId), FIXED.levels.low, FIXED.levels.medium, FIXED.levels.high]);
  await tl.send('multisig', 'schedule', [ns.address, 0, data, ZeroHash, ZeroHash, DELAY]);
  c.advance(DELAY);
  await tl.send('deployer', 'execute', [ns.address, 0, data, ZeroHash, ZeroHash]);
  const ver = await c.deploy('NeuroScoreVerifier', [], 'deployer');
  const pv = await c.deploy('ProvenVerdicts', [A('gov'), ver.address, ns.address, 1, '0x' + '00'.repeat(20), 10n ** 18n, 10n ** 18n, 3600, 3600, 3600], 'deployer');
  await pv.send('runner', 'register', [], 10n ** 18n);
  const token = ns.address; // any contract with code
  const row = HELD.rows.find((r) => r.id === FX.row);
  const vec = new Array(FIXED.features.length).fill(0);
  for (const [i, x] of row.x) vec[i] = x;
  const features = packFeatures(quantizeVector(vec));
  const tx = await c.rawTx('runner', pv.address, pv.iface.encodeFunctionData('submit', [{ token, modelId: MODEL_ID, features, a: FX.a, b: FX.b, c: FX.c, commitment: FX.publicSignals[0], margin: FX.publicSignals[1] }]));
  assert.ok(tx.ok);
  const logs = tx.logs.map((l) => ({ ...l, address: pv.address }));
  const call = async (method, params) => {
    if (method === 'eth_call') return c.rawCallHex(params[0].to, params[0].data);
    if (method === 'eth_getLogs') return logs.filter((l) => l.topics[0] === params[0].topics[0] && l.topics[1] === params[0].topics[1]);
    throw new Error(method);
  };
  const r = await checkProvenVerdict(call, { contract: pv.address, token, lib, vk: VK });
  assert.equal(r.state, 'proven', r.problem);
  assert.equal(r.modelId, FIXED.modelId);
  assert.equal(r.score, (await pv.call('verdictOf', [token])).score);
  assert.equal((await checkProvenVerdict(call, { contract: pv.address, token: A('gov'), lib, vk: VK })).state, 'none');
});

const ZK_OUT = process.env.ZKVERDICT_ZK_OUT;
const haveZk = ZK_OUT && existsSync(join(ZK_OUT, 'neuro_score_js/neuro_score.wasm')) && existsSync(join(ZK_OUT, 'ceremony/neuro_score_0000.zkey'));
test('prover: the existing circuit proves a zfeat/1 vector (timed); a key that is not the ceremony\'s final one is never "on chain"', { skip: !haveZk && 'set ZKVERDICT_ZK_OUT to zetaphy-neuro/ml/onchain/zk/out (after node run.js there)' }, async () => {
  const prover = await createProver({ wasm: join(ZK_OUT, 'neuro_score_js/neuro_score.wasm'), zkey: join(ZK_OUT, 'ceremony/neuro_score_0000.zkey') });
  assert.equal(prover.keyIsOnChain, false);
  const f = zfeat1(CODE);
  const p = await prover.prove(f.q);
  console.log(`prove (Node, initial key): ${Math.round(p.proveMs)} ms; snarkjs verify ${Math.round(p.verifyMs)} ms`);
  assert.equal(p.ownOk, true);
  assert.equal(p.margin, BigInt(f.margin) + (1n << 40n));
  assert.equal(p.onChain, false, 'valid under its own key only');
  await assert.rejects(prover.prove(f.q.map((x, i) => (i === 0 ? 2 ** 32 : x))), /./, 'a feature outside u32 has no witness');
  await prover.close();
});
