// ProvenVerdicts (docs/future/proven-verdicts.md): Neuro verdicts with a Groth16 proof of the pinned model's run,
// on the in-memory EVM with the REAL NeuroScore (model published + activated through the timelock), the REAL
// committed NeuroScoreVerifier (never edited: proofs are the committed fixture, made with the ceremony rehearsal's
// final key) and the REAL NeuroJobs (k-of-n feature jobs that settle a contest).
//   - a valid proven verdict is accepted, scored from the proven margin, readable with weight 3;
//   - a forged score (tampered margin), a proof replayed for the same token, a wrong model id, a verifier for another
//     model: refused;
//   - posted features that are not the proof's: challengeScore re-runs the model on-chain and slashes;
//   - posted features that are not the token's (zfeat/1 of its code): contest + a settled NeuroJobs feature job slashes;
//     a wrong contest loses its bond to the runner; an unanswered one expires;
//   - proof mode: Optional (unproven claims weigh 1, a wrong one is slashed) / Required (refused, read as unknown);
//   - batch submission; gas per verdict measured and printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, ZeroHash, encodeBytes32String, keccak256, hexlify, randomBytes } from 'ethers';
import solc from 'solc';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { packFeatures, quantizeVector, evalFixed, fromHex } from '../../zetaphy-neuro/ml/onchain/fixed.js';
import { zfeat1, featureTarget } from '../src/zkverdict/features.js';
import { provenVerdictJob, MODEL_ID } from '../src/zkverdict/job.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/neuroscore-zk.json', import.meta.url), 'utf8'));
const ML = new URL('../../zetaphy-neuro/ml/onchain/', import.meta.url);
const FIXED = JSON.parse(readFileSync(new URL('model.fixed.json', ML), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('heldout.json', ML), 'utf8'));
const BYTES = fromHex(FIXED.bytes);
const DELAY = 48n * 3600n;
const RB = 10n * ZETA, CB = 2n * ZETA, CW = 3600, CT = 7200, UD = 7200;
const NJ = { BOND: 100n * ZETA, REWARD: ZETA, MIN_FEE: ZETA / 10n, WINDOW: 120, TIMEOUT: 600, UNBOND: 3600, CAP: 1000n * ZETA };
const DEAD = '0x000000000000000000000000000000000000dEaD';
const OFFSET = 1n << 40n;

const vecOf = (row) => { const v = new Array(FIXED.features.length).fill(0); for (const [i, x] of row.x) v[i] = x; return quantizeVector(v); };
const ROW = HELD.rows.find((r) => r.id === FX.row);
const ROW_FEATURES = packFeatures(vecOf(ROW));
const OTHER = HELD.rows.find((r) => r.id !== FX.row && evalFixed(BYTES, vecOf(r)).score !== evalFixed(BYTES, vecOf(ROW)).score);
const OTHER_FEATURES = packFeatures(vecOf(OTHER));
const proofOf = (token, features = ROW_FEATURES, over = {}) => ({ token, modelId: MODEL_ID, features, a: FX.a, b: FX.b, c: FX.c, commitment: FX.publicSignals[0], margin: FX.publicSignals[1], ...over });
const calldataGas = (hex) => { let g = 0; for (let i = 2; i < hex.length; i += 2) g += hex.slice(i, i + 2) === '00' ? 4 : 16; return g; };

let kitCache = null;
function kit() {
  if (kitCache) return kitCache;
  const input = { language: 'Solidity', sources: { 'ProvenKit.sol': { content: readFileSync(new URL('./helpers/ProvenKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['ProvenKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object }]));
  return kitCache;
}

async function world({ fakeVerifier = false } = {}) {
  const c = await createChain(['deployer', 'multisig', 'gov', 'runner', 'runner2', 'alice', 'bob', 'user', 'w1', 'w2', 'w3']);
  const A = (n) => c.acct[n].toString();
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('multisig')], ['0x' + '00'.repeat(20)], '0x' + '00'.repeat(20)], 'deployer');
  const ns = await c.deploy('NeuroScore', [tl.address], 'deployer');
  await ns.send('deployer', 'publishModel', [FIXED.bytes]);
  const data = ns.iface.encodeFunctionData('activateModel', [FIXED.hash, encodeBytes32String(FIXED.modelId), FIXED.levels.low, FIXED.levels.medium, FIXED.levels.high]);
  await tl.send('multisig', 'schedule', [ns.address, 0, data, ZeroHash, ZeroHash, DELAY]);
  c.advance(DELAY);
  await tl.send('deployer', 'execute', [ns.address, 0, data, ZeroHash, ZeroHash]);
  const verifier = fakeVerifier ? await c.deployRaw(kit().FakeModelVerifier, [FIXED.hash, true], 'deployer') : await c.deploy('NeuroScoreVerifier', [], 'deployer');
  const jobs = await c.deploy('NeuroJobs', [NJ.BOND, NJ.REWARD, NJ.MIN_FEE, NJ.WINDOW, NJ.TIMEOUT, NJ.UNBOND, NJ.CAP], 'deployer');
  await jobs.send('deployer', 'fund', [], 100n * ZETA);
  for (const w of ['w1', 'w2', 'w3']) await jobs.send(w, 'register', [], NJ.BOND);
  c.advance(1);
  const pv = await c.deploy('ProvenVerdicts', [A('gov'), verifier.address, ns.address, 1, jobs.address, RB, CB, CW, CT, UD], 'deployer');
  await pv.send('runner', 'register', [], RB);
  const token = async () => (await c.deployRaw(kit().KitToken, [], 'deployer')).address;
  return { c, A, ns, tl, verifier, jobs, pv, token };
}

/** A NeuroJobs feature job on chain "zetaphy" for verdict `id`, where w1..w3 reveal `verdicts`; settled afterwards. */
async function featureJob({ c, jobs, pv }, id, verdicts) {
  const target = await pv.call('featureTarget', [id]);
  await jobs.send('user', 'request', [encodeBytes32String('zetaphy'), target], ZETA);
  const jid = (await jobs.call('jobCount')) - 1n;
  const salts = {};
  for (const [i, w] of ['w1', 'w2', 'w3'].entries()) {
    salts[w] = hexlify(randomBytes(32));
    await jobs.send(w, 'commit', [jid, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [verdicts[i], c.acct[w].toString(), salts[w]]))]);
  }
  for (const [i, w] of ['w1', 'w2', 'w3'].entries()) await jobs.send(w, 'reveal', [jid, verdicts[i], salts[w]]);
  return { jid, target };
}

test('a valid proven verdict is accepted: score from the proven margin = NeuroScore on the posted features; weight 3; gas', async () => {
  const w = await world();
  const { c, pv, ns } = w;
  assert.equal(await pv.call('modelHash'), FIXED.hash);
  assert.equal(await pv.call('modelId'), encodeBytes32String(FIXED.modelId));
  const t = await w.token();
  const g = await pv.gas('runner', 'submit', [proofOf(t)]);
  const tx = g.exec + 21000 + calldataGas(g.data);
  console.log(`ProvenVerdicts.submit (proof + 532 bytes of features): execution gas ${g.exec}, ~${tx} as a transaction`);
  assert.ok(g.exec < 450_000, `submit costs ${g.exec}`);
  const [score, level] = await ns.call('evaluate', [ROW_FEATURES]);
  const v = await pv.call('verdictOf', [t]);
  assert.equal(v.known, true);
  assert.equal(v.proven, true);
  assert.equal(v.weight, 3n);
  assert.equal(v.score, score, 'the proven score is the model on the posted features');
  assert.equal(v.level, level);
  assert.equal(v.score, await pv.call('scoreOfMargin', [FX.publicSignals[1]]));
  assert.equal(v.settled, false);
  const rec = await pv.call('verdict', [v.id]);
  assert.equal(rec.featuresHash, keccak256(ROW_FEATURES));
  assert.equal(rec.codeHash, keccak256(kit().KitToken.runtime));
  assert.equal(await pv.call('featureTarget', [v.id]), featureTarget(t, rec.codeHash));
  // a correct verdict cannot be challenged on its score
  await assert.rejects(pv.send('alice', 'challengeScore', [v.id, ROW_FEATURES]), /NotWrong/);
  await assert.rejects(pv.send('alice', 'challengeScore', [v.id, OTHER_FEATURES]), /BadFeatures/, 'only the posted preimage');
  c.advance(CW);
  assert.equal((await pv.call('verdictOf', [t])).settled, true);
});

test('forged score, replay, wrong model id, wrong feature count, unbonded sender: all refused', async () => {
  const w = await world();
  const { pv } = w;
  const t = await w.token();
  const bump = (h, d) => '0x' + (BigInt(h) + d).toString(16).padStart(64, '0');
  // a lower (or higher) score with the same proof: the margin is a public signal
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES, { margin: bump(FX.publicSignals[1], -10_000_000n) })]), /InvalidProof/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES, { margin: bump(FX.publicSignals[1], 1n) })]), /InvalidProof/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES, { commitment: bump(FX.publicSignals[0], 1n) })]), /InvalidProof/);
  // proofs of the same statement from the non-final and from a forged key (each valid under its own key)
  for (const x of [FX.nonFinal, FX.forged]) await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES, { a: x.a, b: x.b, c: x.c })]), /InvalidProof/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES, { modelId: encodeBytes32String('nml-3ab3cd303911') })]), /WrongModel/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t, ROW_FEATURES + '00000000')]), /BadFeatures/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(w.A('alice'))]), /NoCode/);
  await assert.rejects(pv.send('alice', 'submit', [proofOf(t)]), /NotRunner/);
  await pv.send('runner', 'submit', [proofOf(t)]);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(t)]), /ProofUsed/, 'the same proof twice for one token');
  assert.equal(await pv.call('count'), 1n);
});

test('a verifier for another model, or a model version that is not the verifier\'s, is refused at construction', async () => {
  const w = await world();
  const { c, A, ns, jobs } = w;
  const other = await c.deployRaw(kit().FakeModelVerifier, [keccak256('0x01'), true], 'deployer');
  await assert.rejects(c.deploy('ProvenVerdicts', [A('gov'), other.address, ns.address, 1, jobs.address, RB, CB, CW, CT, UD], 'deployer'), /deploy failed/);
  await assert.rejects(c.deploy('ProvenVerdicts', [A('gov'), w.verifier.address, ns.address, 2, jobs.address, RB, CB, CW, CT, UD], 'deployer'), /deploy failed/, 'no version 2');
  await assert.rejects(c.deploy('ProvenVerdicts', [A('gov'), w.verifier.address, ns.address, 1, jobs.address, RB, CB, CW, CT, CW - 1], 'deployer'), /deploy failed/, 'unbond shorter than the window');
});

test('posted features that are not the proof\'s: anyone re-runs the model on-chain and the runner is slashed', async () => {
  const w = await world();
  const { c, pv, ns } = w;
  const t = await w.token();
  // a valid proof (of ROW) posted with OTHER's features: the proof verifies, the features do not match it
  await pv.send('runner', 'submit', [proofOf(t, OTHER_FEATURES)]);
  const id = (await pv.call('verdictOf', [t])).id;
  const [trueScore] = await ns.call('evaluate', [OTHER_FEATURES]);
  const burnBefore = await c.balance(Address.fromString(DEAD));
  const ev = await pv.send('alice', 'challengeScore', [id, OTHER_FEATURES]);
  assert.ok(ev.some((e) => e?.name === 'Overturned' && e.args.why === 1n && e.args.trueScore === trueScore));
  const cut = RB / 2n;
  assert.equal((await pv.call('runners', [w.A('runner')])).bond, RB - cut);
  assert.equal((await pv.call('runners', [w.A('runner')])).active, false, 'below the bond: inactive');
  assert.equal(await pv.call('credit', [w.A('alice')]), cut / 2n);
  assert.equal(await c.balance(Address.fromString(DEAD)) - burnBefore, cut - cut / 2n);
  const v = await pv.call('verdictOf', [t]);
  assert.equal(v.known, false);
  await assert.rejects(pv.send('bob', 'challengeScore', [id, OTHER_FEATURES]), /Closed/);
  await assert.rejects(pv.send('runner', 'submit', [proofOf(await w.token())]), /NotRunner/);
  // what a score challenge costs (re-running the 160 trees on-chain + the slash)
  await pv.send('runner2', 'register', [], RB);
  const t2 = await w.token();
  await pv.send('runner2', 'submit', [proofOf(t2, OTHER_FEATURES)]);
  const g = await pv.gas('bob', 'challengeScore', [(await pv.call('verdictOf', [t2])).id, OTHER_FEATURES]);
  console.log(`challengeScore (overturn + slash): execution gas ${g.exec}, ~${g.exec + 21000 + calldataGas(g.data)} as a transaction`);
});

test('posted features that are not the token\'s: contest + a settled NeuroJobs zfeat/1 job slashes the runner', async () => {
  const w = await world();
  const { c, pv, jobs } = w;
  const t = await w.token();
  await pv.send('runner', 'submit', [proofOf(t)]); // ROW's features: a valid proof, but not this token's code features
  const id = (await pv.call('verdictOf', [t])).id;
  const real = zfeat1(kit().KitToken.runtime);
  assert.notEqual(real.featuresHash, keccak256(ROW_FEATURES));
  await assert.rejects(pv.send('alice', 'contest', [id], CB - 1n), /BadValue/);
  await pv.send('alice', 'contest', [id], CB);
  await assert.rejects(pv.send('bob', 'contest', [id], CB), /Closed/);
  // the runner cannot leave while contested
  await pv.send('runner', 'requestUnbond', []);
  c.advance(UD + 1);
  await assert.rejects(pv.send('runner', 'withdrawBond', []), /TooEarly/);
  // a job on another target, or one not settled yet, does not resolve it
  await jobs.send('user', 'request', [encodeBytes32String('zetaphy'), t.toLowerCase()], ZETA);
  await assert.rejects(pv.send('bob', 'resolveContest', [id, 0]), /NotSettled/);
  const { jid, target } = await featureJob(w, id, [real.featuresHash, real.featuresHash, real.featuresHash]);
  assert.equal(target, `zfeat/1:${t.toLowerCase()}:${keccak256(kit().KitToken.runtime)}`);
  await assert.rejects(pv.send('bob', 'resolveContest', [id, jid]), /NotSettled/, 'inside the job\'s own challenge window');
  c.advance(NJ.TIMEOUT + 1);
  const ev = await pv.send('bob', 'resolveContest', [id, jid]);
  assert.ok(ev.some((e) => e?.name === 'Overturned' && e.args.why === 2n && e.args.trueFeaturesHash === real.featuresHash));
  assert.equal(await pv.call('credit', [w.A('alice')]), CB + RB / 4n, 'bond back + half of the slash');
  assert.equal((await pv.call('verdictOf', [t])).known, false);
  await pv.send('runner', 'withdrawBond', []);
  assert.equal((await pv.call('runners', [w.A('runner')])).bond, 0n);
});

test('a wrong contest loses its bond to the runner; an unresolved one expires (80% back)', async () => {
  const w = await world({ fakeVerifier: true }); // proofs are not the point here: the posted features are the token's real zfeat/1
  const { c, pv } = w;
  const t = await w.token();
  const real = zfeat1(kit().KitToken.runtime);
  await pv.send('runner', 'submit', [proofOf(t, real.packed, { margin: '0x' + (BigInt(real.margin) + OFFSET).toString(16) })]);
  const id = (await pv.call('verdictOf', [t])).id;
  assert.equal((await pv.call('verdictOf', [t])).score, BigInt(real.score), 'contract score from the margin = JS fixed-point score of zfeat/1');
  await pv.send('alice', 'contest', [id], CB);
  const { jid } = await featureJob(w, id, [real.featuresHash, real.featuresHash, '0x' + '11'.repeat(32)]);
  c.advance(NJ.TIMEOUT + 1);
  const ev = await pv.send('bob', 'resolveContest', [id, jid]);
  assert.ok(ev.some((e) => e?.name === 'ContestUpheld'));
  assert.equal(await pv.call('credit', [w.A('runner')]), CB);
  assert.equal((await pv.call('verdictOf', [t])).known, true);
  await assert.rejects(pv.send('bob', 'resolveContest', [id, jid]), /Closed/);
  // the window closes: no new contest
  const t2 = await w.token();
  await pv.send('runner', 'submit', [proofOf(t2, real.packed, { margin: '0x' + (BigInt(real.margin) + OFFSET).toString(16) })]);
  const id2 = (await pv.call('verdictOf', [t2])).id;
  await pv.send('alice', 'contest', [id2], CB);
  await assert.rejects(pv.send('bob', 'expireContest', [id2]), /TooEarly/);
  c.advance(CT);
  await pv.send('bob', 'expireContest', [id2]);
  assert.equal(await pv.call('credit', [w.A('alice')]), (CB * 8000n) / 10000n);
  const t3 = await w.token();
  await pv.send('runner', 'submit', [proofOf(t3, real.packed, { margin: '0x' + (BigInt(real.margin) + OFFSET).toString(16) })]);
  c.advance(CW);
  await assert.rejects(pv.send('alice', 'contest', [(await pv.call('verdictOf', [t3])).id], CB), /Closed/);
  await pv.send('runner', 'withdraw', []);
});

test('proof mode: Optional takes unproven claims at weight 1 (a wrong one is slashed); Required refuses them and hides old ones', async () => {
  const w = await world();
  const { pv, ns } = w;
  const t = await w.token();
  await w.pv.send('runner2', 'register', [], RB);
  const [score] = await ns.call('evaluate', [OTHER_FEATURES]);
  await pv.send('runner2', 'claim', [t, OTHER_FEATURES, score]);
  let v = await pv.call('verdictOf', [t]);
  assert.deepEqual([v.known, v.proven, v.weight], [true, false, 1n]);
  await assert.rejects(pv.send('alice', 'challengeScore', [v.id, OTHER_FEATURES]), /NotWrong/);
  // a claim that disagrees with the model: slashed
  const t2 = await w.token();
  await pv.send('runner2', 'claim', [t2, OTHER_FEATURES, score - 1n]);
  await pv.send('alice', 'challengeScore', [(await pv.call('verdictOf', [t2])).id, OTHER_FEATURES]);
  assert.equal((await pv.call('runners', [w.A('runner2')])).bond, RB / 2n);
  // a proven verdict replaces the claim; a later claim does not hide a live proven verdict for the same code
  await pv.send('runner', 'submit', [proofOf(t)]);
  await assert.rejects(pv.send('alice', 'setProofMode', [1]), /NotGovernance/);
  await pv.send('runner', 'claim', [t, OTHER_FEATURES, score]);
  v = await pv.call('verdictOf', [t]);
  assert.deepEqual([v.proven, v.weight], [true, 3n]);
  // Required
  const t3 = await w.token();
  await pv.send('runner', 'claim', [t3, OTHER_FEATURES, score]);
  await pv.send('gov', 'setProofMode', [1]);
  await assert.rejects(pv.send('runner', 'claim', [t3, OTHER_FEATURES, score]), /ProofRequired/);
  v = await pv.call('verdictOf', [t3]);
  assert.deepEqual([v.known, v.weight], [false, 0n], 'an old unproven claim reads as unknown');
  assert.equal((await pv.call('verdictOf', [t])).known, true, 'proven verdicts are unaffected');
});

test('batch: several proven verdicts in one transaction; gas per verdict vs one per transaction', async () => {
  const w = await world();
  const { pv } = w;
  const one = await pv.gas('runner', 'submit', [proofOf(await w.token())]);
  const oneTx = one.exec + 21000 + calldataGas(one.data);
  const rows = [];
  for (const n of [2, 4, 8]) {
    const tokens = [];
    for (let i = 0; i < n; i++) tokens.push(await w.token());
    const g = await pv.gas('runner', 'submitBatch', [tokens.map((t) => proofOf(t))]);
    const tx = g.exec + 21000 + calldataGas(g.data);
    rows.push({ n, tx, perVerdict: Math.round(tx / n) });
    for (const t of tokens) assert.equal((await pv.call('verdictOf', [t])).proven, true);
  }
  console.log(`one verdict per tx: ${oneTx} gas; batches: ${rows.map((r) => `${r.n} -> ${r.tx} (${r.perVerdict}/verdict)`).join(', ')}`);
  assert.ok(rows.at(-1).perVerdict < oneTx, 'batching saves the per-transaction overhead');
  // one bad proof reverts the whole batch, naming its index
  const t1 = await w.token(), t2 = await w.token();
  await assert.rejects(pv.send('runner', 'submitBatch', [[proofOf(t1), proofOf(t2, ROW_FEATURES, { margin: FX.publicSignals[0] })]]), /InvalidProof/);
  assert.equal((await pv.call('verdictOf', [t1])).known, false);
  await assert.rejects(pv.send('runner', 'submitBatch', [[]]), /BadValue/);
});

test('runner job: derives zfeat/1 from the code, refuses proofs that would not verify or are for other features, batches the rest', async () => {
  const w = await world({ fakeVerifier: true });
  const { c, pv } = w;
  const tokens = [await w.token(), await w.token(), await w.token()];
  const code = kit().KitToken.runtime;
  const call = async (m, [a]) => { assert.equal(m, 'eth_getCode'); return a === tokens[2] ? '0x' : code; };
  const good = { prove: async (q) => ({ a: FX.a, b: FX.b, c: FX.c, commitment: FX.publicSignals[0], margin: BigInt(evalFixed(BYTES, q).margin) + OFFSET, onChain: true, proveMs: 1 }) };
  const sent = [];
  const submit = async (ps) => { sent.push(ps.length); await (ps.length === 1 ? pv.send('runner', 'submit', [ps[0]]) : pv.send('runner', 'submitBatch', [ps])); };
  const r = await provenVerdictJob({ call, tokens, prover: good, submit, batchSize: 4 });
  assert.equal(r.posted.length, 2);
  assert.deepEqual(sent, [2]);
  assert.match(r.skipped[0].reason, /features/);
  const real = zfeat1(code);
  assert.equal((await pv.call('verdictOf', [tokens[0]])).score, BigInt(real.score));
  assert.equal((await pv.call('verdict', [0])).featuresHash, real.featuresHash);
  // a proof the committed verifier would refuse, or a proof of other features: never sent
  const offKey = { prove: async (q) => ({ ...(await good.prove(q)), onChain: false }) };
  const wrong = { prove: async () => ({ a: FX.a, b: FX.b, c: FX.c, commitment: FX.publicSignals[0], margin: FX.publicSignals[1], onChain: true }) };
  for (const prover of [offKey, wrong]) {
    const x = await provenVerdictJob({ call, tokens: [await w.token()], prover, submit });
    assert.equal(x.posted.length, 0);
    assert.equal(x.skipped.length, 1);
  }
  assert.deepEqual(sent, [2]);
  void c;
});
