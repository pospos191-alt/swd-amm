// Proven Neuro verdicts checked in the browser (zkverdict-core.js + vendor/zkverify.js): the vendored pairing code
// is the pinned @noble/curves; the verification key is exactly the committed NeuroScoreVerifier.sol's; the committed
// fixture proof (made with the ceremony rehearsal's final key) verifies, every tampered or foreign proof does not;
// the in-browser model run equals ml/onchain/fixed.js; the chain readers decode what ProvenVerdicts emits; the whole
// check (checkProvenVerdict) says proven / invalid / none / unproven / overturned; the explorer's copies are identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Interface, AbiCoder, keccak256, id, zeroPadValue, toBeHex } from 'ethers';
import * as lib from '../vendor/zkverify.js';
import {
  vkeyFromVerifierSol, verifyGroth16, publicSignals, marginOf, scoreOfMargin, modelHeader, unpackFeatures, readVerdictOf, readProofData,
  checkProvenVerdict, SEL, PROOF_DATA_TOPIC, MARGIN_OFFSET, Q,
} from '../zkverdict-core.js';
import { vkeyJson } from '../tools/zkverdict-vkey.mjs';
import { ASSIST } from '../assist-i18n.js';
import { pairs } from '../tools/sync-shared.mjs';
import { evalFixed, fromHex, quantizeVector, packFeatures } from '../../zetaphy-neuro/ml/onchain/fixed.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FX = JSON.parse(read('../../zetaphy-network/test/fixtures/neuroscore-zk.json'));
const FIXED = JSON.parse(read('../../zetaphy-neuro/ml/onchain/model.fixed.json'));
const HELD = JSON.parse(read('../../zetaphy-neuro/ml/onchain/heldout.json'));
const VK = JSON.parse(read('../zkverdict-vkey.json'));
const PV = new Interface(JSON.parse(read('../../zetaphy-network/artifacts/ProvenVerdicts.json')).abi);
const BYTES = fromHex(FIXED.bytes);
const proof = (x) => ({ a: x.a, b: x.b, c: x.c });
const vecOf = (row) => { const v = new Array(FIXED.features.length).fill(0); for (const [i, x] of row.x) v[i] = x; return quantizeVector(v); };

test('vendor/zkverify.js is the pinned @noble/curves + @noble/hashes bundle; pure JS (no WebAssembly)', () => {
  const pin = JSON.parse(read('../vendor/zkverify.json'));
  const bytes = readFileSync(new URL('../vendor/zkverify.js', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, 'node tools/vendor-zkverify.mjs');
  const lock = JSON.parse(read('../../zetaphy-network/package-lock.json')).packages;
  assert.deepEqual(pin.packages.map((p) => [p.package, p.version, p.integrity]), [
    ['@noble/curves', lock['node_modules/@noble/curves'].version, lock['node_modules/@noble/curves'].integrity],
    ['@noble/hashes', lock['node_modules/@noble/curves/node_modules/@noble/hashes'].version, lock['node_modules/@noble/curves/node_modules/@noble/hashes'].integrity],
  ]);
  assert.doesNotMatch(bytes.toString('utf8'), /WebAssembly|new Function|\beval\(/);
  assert.equal(typeof lib.bn254.pairingBatch, 'function');
  // the hub's pages keep script-src 'self' without 'wasm-unsafe-eval' (only ceremony.html has it)
  const csp = JSON.parse(read('../vercel.json')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /wasm-unsafe-eval|unsafe-eval/);
});

test('zkverdict-vkey.json = the verification key of the committed NeuroScoreVerifier.sol, bound to the pinned model', () => {
  assert.equal(read('../zkverdict-vkey.json'), vkeyJson(), 'node tools/zkverdict-vkey.mjs');
  assert.equal(VK.modelHash, FIXED.hash);
  assert.equal(VK.modelId, FIXED.modelId);
  assert.equal(VK.zkeySha256, '0x' + FX.ceremony.zkeySha256);
  assert.equal(VK.rehearsal, /rehearsal/.test(FX.ceremony.kind));
  assert.equal(VK.ic.length, 5);
  assert.throws(() => vkeyFromVerifierSol('contract X {}'), /no alphax/);
});

test('Groth16 in pure JS: the fixture proof verifies; tampered signals, other keys, broken points are refused (timed)', () => {
  const pub = publicSignals(FX.publicSignals[0], FX.publicSignals[1], VK.modelHash);
  assert.deepEqual(pub, FX.publicSignals.map(BigInt));
  const t0 = performance.now();
  assert.equal(verifyGroth16(lib, VK, proof(FX), pub), true);
  console.log(`pure-JS Groth16 verify (Node ${process.version}): ${Math.round(performance.now() - t0)} ms (first call, includes precomputation)`);
  const t1 = performance.now();
  assert.equal(verifyGroth16(lib, VK, proof(FX), pub), true);
  console.log(`pure-JS Groth16 verify, second call: ${Math.round(performance.now() - t1)} ms`);
  for (let i = 0; i < 4; i++) {
    const p2 = pub.slice();
    p2[i] += 1n;
    assert.equal(verifyGroth16(lib, VK, proof(FX), p2), false, `signal ${i}`);
  }
  // another model hash, a lower margin
  assert.equal(verifyGroth16(lib, VK, proof(FX), publicSignals(FX.publicSignals[0], FX.publicSignals[1], keccak256('0x01'))), false);
  assert.equal(verifyGroth16(lib, VK, proof(FX), publicSignals(FX.publicSignals[0], BigInt(FX.publicSignals[1]) - 10_000_000n, VK.modelHash)), false);
  for (const x of [FX.nonFinal, FX.forged]) assert.equal(verifyGroth16(lib, VK, proof(x), pub), false);
  const bad = (f) => { const p = structuredClone(proof(FX)); f(p); return verifyGroth16(lib, VK, p, pub); };
  assert.equal(bad((p) => { p.a[1] = '0x' + (BigInt(p.a[1]) + 1n).toString(16); }), false, 'not on the curve');
  assert.equal(bad((p) => { p.c[0] = '0x' + (BigInt(p.c[0]) + Q).toString(16); }), false, 'coordinate >= q');
  assert.equal(bad((p) => { p.b = [p.b[1], p.b[0]]; }), false, 'swapped G2 coordinates');
  assert.equal(verifyGroth16(lib, VK, proof(FX), [...pub.slice(0, 3)]), false, 'wrong number of signals');
  assert.equal(verifyGroth16(lib, VK, proof(FX), [pub[0] + 21888242871839275222246405745257275088548364400416034343698204186575808495617n, ...pub.slice(1)]), false, 'signal >= r');
});

test('the browser\'s model run is NeuroScore\'s: margin and score equal ml/onchain/fixed.js on held-out rows', () => {
  const h = modelHeader(BYTES);
  assert.equal(h.nFeatures, FIXED.features.length);
  for (const row of HELD.rows.slice(0, 60)) {
    const q = vecOf(row);
    const r = evalFixed(BYTES, q);
    assert.equal(marginOf(BYTES, q), r.margin, row.id);
    assert.equal(scoreOfMargin(BigInt(r.margin) + MARGIN_OFFSET, h), BigInt(r.score), row.id);
    assert.deepEqual(unpackFeatures(packFeatures(q)), q);
  }
  const fxRow = HELD.rows.find((r) => r.id === FX.row);
  assert.equal(BigInt(marginOf(BYTES, vecOf(fxRow))) + MARGIN_OFFSET, BigInt(FX.publicSignals[1]));
});

test('selectors, topic and decoders match ProvenVerdicts\' ABI', () => {
  assert.equal(SEL.verdictOf, PV.getFunction('verdictOf').selector);
  assert.equal(SEL.scorer, PV.getFunction('scorer').selector);
  assert.equal(SEL.modelBytes, id('modelBytes(bytes32)').slice(0, 10));
  assert.equal(PROOF_DATA_TOPIC, PV.getEvent('ProofData').topicHash);
  const ans = PV.encodeFunctionResult('verdictOf', [true, -123456789n, 2, true, 3, false, 7n]);
  assert.deepEqual(readVerdictOf(ans), { known: true, score: -123456789n, level: 2, proven: true, weight: 3, settled: false, id: 7n });
});

/** A ProvenVerdicts + NeuroScore stand-in answering the four reads checkProvenVerdict makes. */
function mockChain({ verdict = [true, 0n, 0, true, 3, false, 5n], features, a = FX.a, b = FX.b, c = FX.c, margin = FX.publicSignals[1], model = FIXED.bytes, token } = {}) {
  const pv = '0x' + '77'.repeat(20);
  const scorer = '0x' + '55'.repeat(20);
  const ev = PV.getEvent('ProofData');
  const log = PV.encodeEventLog(ev, [verdict[6], token, a, b, c, FX.publicSignals[0], margin, features]);
  const calls = [];
  const call = async (method, params) => {
    calls.push(method);
    if (method === 'eth_getLogs') {
      assert.equal(params[0].topics[0], PROOF_DATA_TOPIC);
      assert.equal(BigInt(params[0].topics[1]), verdict[6]);
      return [{ address: pv, topics: log.topics, data: log.data }];
    }
    const { to, data } = params[0];
    if (to === pv && data.startsWith(SEL.verdictOf)) return PV.encodeFunctionResult('verdictOf', verdict);
    if (to === pv && data === SEL.scorer) return zeroPadValue(scorer, 32);
    if (to === scorer && data.startsWith(SEL.modelBytes)) return AbiCoder.defaultAbiCoder().encode(['bytes'], [model]);
    throw new Error(`unexpected ${method} ${data}`);
  };
  return { pv, call, calls };
}

test('checkProvenVerdict: proven (proof + score + features re-run), and every way it can fail', async () => {
  const token = '0x' + 'ab'.repeat(20);
  const row = HELD.rows.find((r) => r.id === FX.row);
  const features = packFeatures(vecOf(row));
  const score = BigInt(evalFixed(BYTES, vecOf(row)).score);
  const v = (over = {}) => [true, score, 1, true, 3, false, 5n].map((x, i) => (i in over ? over[i] : x));
  let m = mockChain({ verdict: v(), features, token });
  const r = await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK });
  assert.equal(r.state, 'proven', r.problem);
  assert.equal(r.modelId, FIXED.modelId);
  assert.equal(r.score, score);
  assert.equal(r.featuresChecked, true);
  assert.equal(r.rehearsal, true);
  assert.ok(r.ms > 0);
  // the stored score is not the proven one
  m = mockChain({ verdict: v({ 1: score + 1n }), features, token });
  assert.match((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).problem, /stored score/);
  // the posted features are not the proof's
  const other = HELD.rows.find((x) => evalFixed(BYTES, vecOf(x)).margin !== evalFixed(BYTES, vecOf(row)).margin);
  m = mockChain({ verdict: v(), features: packFeatures(vecOf(other)), token });
  assert.match((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).problem, /features/);
  // a forged proof, another model's bytes, the log of another token
  m = mockChain({ verdict: v(), features, token, a: FX.forged.a, b: FX.forged.b, c: FX.forged.c });
  assert.match((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).problem, /Groth16/);
  m = mockChain({ verdict: v(), features, token, model: FIXED.bytes.slice(0, -2) + '01' });
  assert.match((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).problem, /model bytes/);
  m = mockChain({ verdict: v(), features, token: '0x' + 'cd'.repeat(20) });
  assert.match((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).problem, /another token/);
  // none, unproven, overturned: no log is read
  for (const [verdict, state] of [[[false, 0n, 0, false, 0, false, 0n], 'none'], [[true, 5n, 1, false, 1, false, 2n], 'unproven'], [[false, 0n, 0, true, 0, true, 3n], 'overturned']]) {
    m = mockChain({ verdict, features, token });
    assert.equal((await checkProvenVerdict(m.call, { contract: m.pv, token, lib, vk: VK })).state, state);
    assert.ok(!m.calls.includes('eth_getLogs'));
  }
  // decoding the log itself
  const log = PV.encodeEventLog(PV.getEvent('ProofData'), [9n, token, FX.a, FX.b, FX.c, FX.publicSignals[0], FX.publicSignals[1], features]);
  const d = readProofData({ topics: log.topics, data: log.data });
  assert.deepEqual([d.id, d.token, d.features, d.margin, d.proof.b[1][0]], [9n, token, features, BigInt(FX.publicSignals[1]), BigInt(FX.b[1][0])]);
  assert.throws(() => readProofData({ topics: [toBeHex(1, 32)], data: '0x' }), /not a ProofData/);
});

test('words in 8 languages; the explorer serves identical copies of the checker', () => {
  for (const [l, A] of Object.entries(ASSIST)) {
    assert.match(A.pvProven('12', 'nml-x', '3.4%', '55'), /12[\s\S]*nml-x|nml-x[\s\S]*12/, l);
    assert.match(A.pvProven('12', 'nml-x', '3.4%', '55'), /55/, l);
    assert.match(A.pvInvalid('WHY'), /WHY/, l);
    if (l !== 'en') for (const k of ['pvNote', 'pvRehearsal', 'pvChecking']) assert.notEqual(A[k], ASSIST.en[k], `${l}.${k}`);
  }
  for (const [from, to] of pairs().filter(([f]) => /zkverdict|zkverify/.test(f))) assert.ok(readFileSync(from).equals(readFileSync(to)), `${to}: node tools/sync-shared.mjs`);
  assert.equal(pairs().filter(([f]) => /zkverdict|zkverify/.test(f)).length, 3);
});
