// Saphan PR 4, S1 (contracts/SaphanAggLane.sol, src/saphanagg.js): one aggregated ML-DSA-44 certificate per transfer,
// or one for a whole batch of transfers under a Merkle root, checked once on chain, as one lane of the airlock.
// Real ML-DSA-44 keys (helpers/precompiles.js runs FIPS 204 at 0x…0900), charged ZETAPHY's 30,000 gas per verify.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from './helpers/evm.js';
import { MLDSA, mldsaPrecompile, mldsaKey } from './helpers/precompiles.js';
import { kit } from './helpers/saphankits.js';
import { saphanWorld, withAbi, SEPOLIA, CHAIN, Q, E } from './helpers/saphanroute.js';
import * as G from '../src/saphanagg.js';

const VERIFY_GAS = 30_000n; // ZETAPHY's precompile: VerifyGas44 (zetaphy-chain/setup-node.sh)
const mldsa = Object.assign((input) => mldsaPrecompile(input), { gas: VERIFY_GAS });
const KEYS = [1, 2, 3, 4].map((i) => mldsaKey('0x' + i.toString(16).padStart(64, '0')));
const OUTSIDER = mldsaKey('0x' + '99'.repeat(32));
const T = 3;
let c, w, sep, lane;
const a = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'mallory', 'r1', 'r2', 'r3'], {},
    { precompiles: { [MLDSA]: mldsa } });
  w = await saphanWorld(c);
  sep = await w.route(SEPOLIA);
  lane = await c.deployRaw(withAbi('SaphanAggLane', 'BridgeAirlock'), [sep.airlock.address, a('gov'), G.committeeHashes(KEYS), T], 'gov');
  // the aggregated lane replaces the plain second lane; Hyperlane stays the other one
  await sep.airlock.send('gov', 'setLane', [a('lane2'), false]);
  await sep.airlock.send('gov', 'setLane', [lane.address, true]);
  assert.equal(await sep.airlock.call('independentLanes'), 2n);
});

/** `who` locks `amount` on Sepolia for `to`; Hyperlane's lane delivers it. Returns the transfer. */
async function lock(who, amount, to = who) {
  const fee = await sep.lockbox.call('quoteLock', [a(to), amount]);
  const ev = await sep.lockbox.send(who, 'lock', [a(to), amount], amount + fee);
  const n = ev.find((e) => e?.name === 'Locked').args.nonce;
  await w.relayIn(sep.mailbox);
  return { srcChainId: CHAIN, srcContract: sep.lockbox.address, srcNonce: n, sender: a(who), to: a(to), amount };
}

/** The committee's certificate of `root` (signers: indexes into KEYS). */
async function cert(root, signers = [0, 1, 2], { epoch } = {}) {
  const e = epoch ?? (await lane.call('epoch'));
  const d = G.certDigest({ chainId: CHAIN, lane: lane.address, epoch: e, root });
  if (epoch == null) assert.equal(d, await lane.call('certDigest', [root]), 'the JS digest is the contract\'s');
  const sigs = signers.map((i) => ({ publicKey: KEYS[i].publicKey, signature: KEYS[i].sign(d) }));
  for (const s of sigs) assert.equal(await G.checkSignature(d, s), true);
  return G.certificate(sigs, T);
}

const releaseArgs = (t) => [t.srcChainId, t.srcContract, t.srcNonce, t.sender, t.to, t.amount];

test('one transfer: one certificate (3 of 4 ML-DSA-44 signatures) in one call; with Hyperlane it is released', async () => {
  const t = await lock('alice', E);
  const { root, proofs, ids } = G.buildBatch([t]);
  assert.equal(ids[0], await lane.call('transferId', [G.transferTuple(t)]));
  assert.equal(root, await lane.call('leaf', [ids[0]]), 'a batch of one: the root is the leaf');
  assert.equal(root, G.leaf(ids[0]));
  await lane.send('relayer', 'certifyAndAttest', [G.transferTuple(t), root, proofs[0], await cert(root)]);
  assert.equal(await sep.airlock.call('liveAttestations', [ids[0]]), 2n, 'Hyperlane + the committee');
  await assert.rejects(sep.airlock.send('relayer', 'release', releaseArgs(t)), /NotReady/, 'the quarantine still holds');
  c.advance(Q);
  await sep.airlock.send('relayer', 'release', releaseArgs(t));
  assert.equal(await sep.bal('alice'), E);
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(t), root, proofs[0]]), /Twice/);
});

test('a batch: one certificate for 8 transfers, each attested with its Merkle path; a wrong path or root fails', async () => {
  const ts = [];
  for (let i = 0; i < 8; i++) ts.push(await lock(i % 2 ? 'alice' : 'bob', E / 10n + BigInt(i)));
  const b = G.buildBatch(ts);
  ts.forEach((t, i) => assert.ok(G.verifyPath(b.ids[i], b.proofs[i], b.root)));
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(ts[0]), b.root, b.proofs[0]]), /UnknownRoot/, 'not certified yet');
  const ev = await lane.send('relayer', 'certify', [b.root, await cert(b.root)]);
  assert.ok(ev.find((e) => e?.name === 'RootCertified'));
  await assert.rejects(lane.send('relayer', 'certify', [b.root, await cert(b.root)]), /Known/);
  // a path of another transfer, a changed amount, a made-up root
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(ts[0]), b.root, b.proofs[1]]), /BadProof/);
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple({ ...ts[0], amount: 100n * E }), b.root, b.proofs[0]]), /BadProof/);
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(ts[0]), '0x' + '12'.repeat(32), b.proofs[0]]), /UnknownRoot/);
  await lane.send('relayer', 'attest', [G.transferTuple(ts[0]), b.root, b.proofs[0]]);
  // the rest in one call; ts[0] is skipped
  const n = await lane.call('attestMany', [ts.map(G.transferTuple), b.root, b.proofs]);
  assert.equal(n, 7n);
  await lane.send('relayer', 'attestMany', [ts.map(G.transferTuple), b.root, b.proofs]);
  c.advance(Q);
  for (const t of ts) await sep.airlock.send('relayer', 'release', releaseArgs(t));
  const total = ts.reduce((s, t) => s + t.amount, 0n);
  assert.equal((await sep.bal('alice')) + (await sep.bal('bob')), total);
});

test('the committee alone mints nothing: Hyperlane must agree (a transfer it never delivered stays NotReady)', async () => {
  const fake = { srcChainId: CHAIN, srcContract: sep.lockbox.address, srcNonce: 77n, sender: a('mallory'), to: a('mallory'), amount: 50n * E };
  const { root, proofs } = G.buildBatch([fake]);
  await lane.send('relayer', 'certifyAndAttest', [G.transferTuple(fake), root, proofs[0], await cert(root)]);
  c.advance(Q);
  await assert.rejects(sep.airlock.send('relayer', 'release', releaseArgs(fake)), /NotReady/);
  assert.equal(await sep.bal('mallory'), 0n);
});

test('bad certificates: too few, unsorted, a key twice, an outsider, a bad signature, another root', async () => {
  const t = await lock('alice', E);
  const { root, proofs } = G.buildBatch([t]);
  const d = G.certDigest({ chainId: CHAIN, lane: lane.address, epoch: 1n, root });
  const entry = (k, sig) => ({ publicKey: k.publicKey, signature: sig ?? k.sign(d) });
  const raw = (es) => '0x' + es.map((e) => e.publicKey.slice(2) + e.signature.slice(2)).join('');
  const go = (cer) => lane.send('relayer', 'certifyAndAttest', [G.transferTuple(t), root, proofs[0], cer]);
  await assert.rejects(go(raw([entry(KEYS[0]), entry(KEYS[1])])), /Length/, 'two signatures, three needed');
  const sorted = [0, 1, 2].map((i) => entry(KEYS[i])).sort((x, y) => (BigInt(G.committeeHashes([x])[0]) < BigInt(G.committeeHashes([y])[0]) ? -1 : 1));
  await assert.rejects(go(raw([sorted[1], sorted[0], sorted[2]])), /BadCertificate/, 'keys must be hash-sorted');
  await assert.rejects(go(raw([sorted[0], sorted[0], sorted[1]])), /BadCertificate/, 'a key counts once');
  assert.throws(() => G.certificate([sorted[0], sorted[0], sorted[1]], T), /twice/);
  await assert.rejects(go(G.certificate([entry(KEYS[0]), entry(KEYS[1]), entry(OUTSIDER)], T)), /BadCertificate/, 'not a member');
  const other = G.certDigest({ chainId: CHAIN, lane: lane.address, epoch: 1n, root: '0x' + '34'.repeat(32) });
  await assert.rejects(go(G.certificate([entry(KEYS[0]), entry(KEYS[1]), entry(KEYS[2], KEYS[2].sign(other))], T)), /BadCertificate/, 'signed another root');
  const wrongEpoch = G.certDigest({ chainId: CHAIN, lane: lane.address, epoch: 2n, root });
  await assert.rejects(go(G.certificate([0, 1, 2].map((i) => entry(KEYS[i], KEYS[i].sign(wrongEpoch))), T)), /BadCertificate/, 'another epoch');
  assert.equal(await G.checkSignature(d, entry(KEYS[2], KEYS[2].sign(other))), false, 'members check before signing in');
  await go(G.certificate([1, 2, 3].map((i) => entry(KEYS[i])), T));
});

test('governance (the timelock) sets the committee within bounds; a new committee retires the old roots', async () => {
  await assert.rejects(lane.send('mallory', 'setCommittee', [G.committeeHashes(KEYS), 3]), /OnlyGovernance/);
  await assert.rejects(lane.send('gov', 'setCommittee', [G.committeeHashes(KEYS), 1]), /BadCommittee/, 'at least 2');
  await assert.rejects(lane.send('gov', 'setCommittee', [G.committeeHashes(KEYS), 2]), /BadCommittee/, 'more than half');
  await assert.rejects(lane.send('gov', 'setCommittee', [G.committeeHashes(KEYS).reverse(), 3]), /BadCommittee/, 'sorted');
  await assert.rejects(lane.send('gov', 'setCommittee', [[...G.committeeHashes(KEYS.slice(0, 2)), G.committeeHashes(KEYS.slice(0, 2))[1]], 2]), /BadCommittee/, 'no repeats');
  await assert.rejects(lane.send('gov', 'setCommittee', [Array.from({ length: 33 }, (_, i) => '0x' + (i + 1).toString(16).padStart(64, '0')), 30]), /BadCommittee/, 'at most 32');
  await assert.rejects(lane.send('mallory', 'setGovernance', [a('mallory')]), /OnlyGovernance/);
  // a root of epoch 1 ...
  const t = await lock('alice', E);
  const { root, proofs } = G.buildBatch([t]);
  await lane.send('relayer', 'certify', [root, await cert(root)]);
  // ... stops counting under a new committee (here: KEY 0 replaced by the outsider)
  const next = [OUTSIDER, KEYS[1], KEYS[2], KEYS[3]];
  await lane.send('gov', 'setCommittee', [G.committeeHashes(next), 3]);
  assert.equal(await lane.call('epoch'), 2n);
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(t), root, proofs[0]]), /UnknownRoot/);
  await assert.rejects(lane.send('relayer', 'certify', [root, await cert(root, [0, 1, 2])]), /BadCertificate/, 'KEY 0 is out');
  const d = G.certDigest({ chainId: CHAIN, lane: lane.address, epoch: 2n, root });
  const sigs = [0, 1, 2].map((i) => ({ publicKey: next[i].publicKey, signature: next[i].sign(d) }));
  await lane.send('relayer', 'certifyAndAttest', [G.transferTuple(t), root, proofs[0], G.certificate(sigs, 3)]);
  // the airlock can still drop the lane at once (a guardian), withdrawing its attestations
  await sep.guard.send('gov', 'setGuardian', [a('guardian'), true]);
  await sep.airlock.send('guardian', 'emergencyRemoveLane', [lane.address]);
  c.advance(Q);
  await assert.rejects(sep.airlock.send('relayer', 'release', releaseArgs(t)), /NotReady/);
});

/** Gas a transaction pays: execution (in-memory EVM) + 21,000 + calldata. */
async function txGas(contract, from, fn, args) {
  const { exec, data } = await contract.gas(from, fn, args);
  return exec + 21_000 + G.calldataGas(data);
}

test('gas: per-lane votes (NeuroLane, 3 runner transactions) vs one certificate per transfer vs one per batch', async (tc) => {
  // the per-lane path: a NeuroLane whose 3 runners each send their vote
  const runners = await c.deployRaw(kit('SafetyKit.sol').KitRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3']) await runners.send('gov', 'set', [a(r), true, 5, 0]);
  const neuro = await c.deploy('NeuroLane', [runners.address, sep.airlock.address, 3, 1, '0x' + '00'.repeat(20)], 'gov');
  await sep.airlock.send('gov', 'setLane', [neuro.address, true]);
  const t1 = await lock('alice', E);
  let neuroGas = 0;
  for (const r of ['r1', 'r2', 'r3']) neuroGas += await txGas(neuro, r, 'attest', G.transferTuple(t1));
  assert.equal(await sep.airlock.call('liveAttestations', [G.transferId(t1)]), 2n);

  // one certificate for one transfer
  const t2 = await lock('alice', E);
  const one = G.buildBatch([t2]);
  const singleGas = await txGas(lane, 'relayer', 'certifyAndAttest', [G.transferTuple(t2), one.root, one.proofs[0], await cert(one.root)]);

  // one certificate for a batch of 16, then all 16 in one call
  const ts = [];
  for (let i = 0; i < 16; i++) ts.push(await lock('bob', E / 100n + BigInt(i)));
  const b = G.buildBatch(ts);
  const certGas = await txGas(lane, 'relayer', 'certify', [b.root, await cert(b.root)]);
  const manyGas = await txGas(lane, 'relayer', 'attestMany', [ts.map(G.transferTuple), b.root, b.proofs]);
  const perBatched = Math.round((certGas + manyGas) / ts.length);
  for (const t of ts) assert.equal(await sep.airlock.call('liveAttestations', [G.transferId(t)]), 2n);

  // the floor: one plain key's attestation (no proof at all), the airlock's own bookkeeping
  await sep.airlock.send('gov', 'setLane', [a('lane2'), true]);
  const plainGas = await txGas(sep.airlock, 'lane2', 'attest', G.transferTuple(ts[0]));

  const report = { plainKeyAttest: plainGas, neuroLane3Votes: neuroGas, oneCertificatePerTransfer: singleGas, batch16: { certify: certGas, attestMany: manyGas, perTransfer: perBatched } };
  tc.diagnostic(`SaphanAggLane gas (ML-DSA-44 verify = ${VERIFY_GAS} gas): ${JSON.stringify(report)}`);
  // the batch is the cheap path per transfer; a single certificate pays 3 ML-DSA keys + signatures in calldata
  assert.ok(perBatched < neuroGas, `batched ${perBatched} < per-lane ${neuroGas}`);
  assert.ok(perBatched < singleGas);
  assert.ok(singleGas < 600_000, `one certificate: ${singleGas}`);
});

test('a lane removed and added again may attest again (the airlock decides what counts twice)', async () => {
  const t = await lock('alice', E);
  const { root, proofs, ids } = G.buildBatch([t]);
  await lane.send('relayer', 'certifyAndAttest', [G.transferTuple(t), root, proofs[0], await cert(root)]);
  assert.equal(await lane.call('attestMany', [[G.transferTuple(t)], root, proofs]), 0n, 'already counted: skipped');
  await sep.airlock.send('gov', 'setLane', [lane.address, false]);
  await sep.airlock.send('gov', 'setLane', [lane.address, true]);
  assert.equal(await sep.airlock.call('liveAttestations', [ids[0]]), 1n, 'its old attestation was withdrawn');
  await assert.rejects(lane.send('relayer', 'attestMany', [[G.transferTuple(t)], root, []]), /Length/);
  await lane.send('relayer', 'attest', [G.transferTuple(t), root, proofs[0]]);
  assert.equal(await sep.airlock.call('liveAttestations', [ids[0]]), 2n);
  // other airlock refusals are not swallowed
  await sep.airlock.send('gov', 'setLane', [lane.address, false]);
  await assert.rejects(lane.send('relayer', 'attest', [G.transferTuple(t), root, proofs[0]]), /NotLane/);
});
