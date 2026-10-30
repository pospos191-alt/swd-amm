// Self-healing end to end on the in-memory chain (rpcchain: signed txs, eth_getLogs): a reentrancy
// drain of HealVault with self-healing OFF and ON (runner trips gathered by the detector loop from
// k-of-n peers), false positives on a benign workload, and the abuse cases: a colluding minority is
// refused, a colluding quorum's false trip costs its bonds and compensates the protocol, and a trip
// that expired needs fresh evidence to trip again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZeroHash, keccak256, toUtf8Bytes, parseEther } from 'ethers';
import { runDemo, setupWorld, benign, attack, BIT, ZETA } from './helpers/selfhealdemo.js';
import { gatherSignatures } from '../src/selfheal/peers.js';
import { DETECTOR_ID } from '../src/selfheal/detect.js';
import { errorName } from '../src/selfheal/loop.js';

test('demo: the same drain loses the vault with self-healing OFF, one block of it with self-healing ON', async () => {
  const off = await runDemo({ selfHealing: false, benignBlocks: 40, attempts: 60 });
  const on = await runDemo({ mode: 'runners', benignBlocks: 40, attempts: 60 });
  assert.ok(off.lossZeta >= 0.9 * off.vaultBeforeZeta - 100, `OFF drained ${off.lossZeta} of ${off.vaultBeforeZeta}`);
  assert.equal(on.tripKind, 'runners');
  assert.equal(on.latencyBlocks, 1, 'tripped in the block after the first anomalous block');
  assert.equal(on.attack.ok, 1, 'only the first attack block got through');
  assert.ok(on.lossZeta <= 100, `ON lost ${on.lossZeta}`);
  assert.ok(off.lossZeta - on.lossZeta > 0.9 * off.lossZeta, 'more than 90% of the loss saved');
  assert.equal(on.falseTrips, 0);
  assert.equal(on.benignAnomalies, 0);
  // narrow: honest users kept withdrawing (withdraw() is not paused; only withdrawAll() is)
  assert.equal(on.attack.honest.failed, 0);
  const t = on.w.loop.stats.trips[0];
  assert.equal(t.mask, BIT.withdrawAll);
  assert.equal(t.signers.length, 5);
  assert.deepEqual(t.evidence.signals.map((s) => s.id).sort(), ['burst', 'callback', 'fresh', 'volume']);
});

test('false positives: a longer benign workload (whale withdrawals, a smart-contract wallet) never trips', async () => {
  const w = await setupWorld({ mode: 'runners' });
  await w.loop.tick();
  await benign(w, 150, { seed: 99, onBlock: () => w.loop.tick() });
  assert.ok(w.loop.stats.evaluated >= 150);
  assert.equal(w.loop.stats.anomalies.length, 0);
  assert.equal(w.loop.stats.trips.length, 0);
  assert.equal(await w.breaker.tripCount(), 0n);
});

test('abuse: a colluding minority (2 of 5, quorum 3) cannot trip; honest peers refuse evidence they cannot reproduce', async () => {
  const w = await setupWorld({ mode: 'runners', colluders: 2 });
  await w.loop.tick();
  await benign(w, 20, { onBlock: () => w.loop.tick() });
  const b = Number(await w.chain.provider.getBlockNumber()) - 1;
  const proposal = { chainId: w.chain.chainId, protocol: w.vaultAddr, epoch: 0n, fromBlock: b, toBlock: b, evidenceHash: keccak256(toUtf8Bytes('made up')), detectorId: DETECTOR_ID, mask: BIT.withdraw | BIT.withdrawAll };
  const got = await gatherSignatures(proposal, w.peers, { breaker: w.breakerAddr });
  assert.equal(got.signers.length, 2);
  assert.equal(got.refused.length, 3);
  assert.ok(got.refused.every((r) => /no anomaly/.test(r.reason)));
  const br = w.breaker.connect(w.runnerSigners[0]);
  await assert.rejects(br.tripWithSignatures.staticCall(w.vaultAddr, [b, b, proposal.evidenceHash, DETECTOR_ID, proposal.mask], got.signers, got.sigs), (e) => errorName(br, e) === 'NoQuorum');
  // repeating a colluder's signature, or adding a non-guardian's, does not help
  await assert.rejects(br.tripWithSignatures.staticCall(w.vaultAddr, [b, b, proposal.evidenceHash, DETECTOR_ID, proposal.mask], [got.signers[0], got.signers[0], got.signers[1]], [got.sigs[0], got.sigs[0], got.sigs[1]]), (e) => errorName(br, e) === 'NotSorted');
  const outsider = w.users[0];
  const fakeSig = await outsider.signMessage(new Uint8Array(32));
  const all = [...got.signers.map((a, i) => ({ a, s: got.sigs[i] })), { a: outsider.address, s: fakeSig }].sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  await assert.rejects(br.tripWithSignatures.staticCall(w.vaultAddr, [b, b, proposal.evidenceHash, DETECTOR_ID, proposal.mask], all.map((x) => x.a), all.map((x) => x.s)), (e) => ['BadSignature', 'NotEligible'].includes(errorName(br, e)));
  assert.equal(await w.breaker.isTripped(w.vaultAddr), false);
  // a proposer that tampers with the mask of a REAL anomaly is refused too (honest peers recompute it)
  await attack(w, { attempts: 1, tick: async () => {} });
  const a = Number(await w.chain.provider.getBlockNumber());
  const real = w.loop.configs[0];
  const { evaluate, collect } = await import('../src/selfheal/detect.js');
  const r = evaluate(real, await collect(w.chain.provider, real, a - 2, a - 2), a - 2, a - 2);
  if (r.anomalous) {
    const tampered = await gatherSignatures({ ...proposal, fromBlock: a - 2, toBlock: a - 2, evidenceHash: r.evidenceHash, mask: 7 }, w.peers, { breaker: w.breakerAddr });
    assert.equal(tampered.signers.length, 2);
    assert.ok(tampered.refused.every((x) => /mask/.test(x.reason)));
  }
});

test('abuse: a colluding quorum CAN trip a healthy protocol once, but it is narrow, expires, and costs the colluders their bonds', async () => {
  const w = await setupWorld({ mode: 'runners', colluders: 3 });
  await w.loop.tick();
  await benign(w, 20, { onBlock: () => w.loop.tick() });
  const b = Number(await w.chain.provider.getBlockNumber()) - 1;
  const proposal = { chainId: w.chain.chainId, protocol: w.vaultAddr, epoch: 0n, fromBlock: b, toBlock: b, evidenceHash: keccak256(toUtf8Bytes('grief')), detectorId: DETECTOR_ID, mask: BIT.withdraw | BIT.withdrawAll };
  const got = await gatherSignatures(proposal, w.peers, { breaker: w.breakerAddr });
  assert.equal(got.signers.length, 3);
  await (await w.breaker.connect(w.runnerSigners[0]).tripWithSignatures(w.vaultAddr, [b, b, proposal.evidenceHash, DETECTOR_ID, proposal.mask], got.signers, got.sigs)).wait();
  assert.equal(await w.breaker.isTripped(w.vaultAddr), true);
  // deposits still work; the protocol's own governance ends it at once and files a claim
  await (await w.vault.connect(w.users[1]).deposit({ value: ZETA })).wait();
  await (await w.breaker.connect(w.protoGov).release(w.vaultAddr)).wait();
  await (await w.breaker.connect(w.protoGov).claimFalse(0, { value: 5n * ZETA })).wait();
  const govBefore = await w.breaker.owed(w.protoGov.address);
  await (await w.breaker.connect(w.gov).resolveClaim(0, true)).wait(); // the timelock (stand-in) judges it false
  for (const s of got.signers) assert.equal((await w.breaker.guardians(s)).bond, 5n * ZETA, 'half the guardian bond slashed');
  const comp = (await w.breaker.owed(w.protoGov.address)) - govBefore;
  assert.equal(comp, (3n * 5n * ZETA * 8000n) / 10000n + 5n * ZETA, '80% of the slashed bonds + the claim bond back');
  for (const s of got.signers) assert.equal(await w.breaker.eligible(s), false, 'slashed below the bond: out until topped up');
  // the honest two are untouched; two cannot reach the quorum
  const honest = w.runnerSigners.slice(3).map((x) => x.address);
  for (const h of honest) assert.equal((await w.breaker.guardians(h)).bond, 10n * ZETA);
});

test('a trip expires by itself; a renewed attack needs fresh evidence and is caught again', async () => {
  const w = await setupWorld({ mode: 'runners' });
  await w.loop.tick();
  await benign(w, 40, { onBlock: () => w.loop.tick() });
  const a1 = await attack(w, { attempts: 3, tick: () => w.loop.tick() });
  assert.equal(a1.ok, 1);
  assert.equal(w.loop.stats.trips.length, 1);
  const first = w.loop.stats.trips[0];
  w.chain.advance(6 * 3600); // maxPause
  assert.equal(await w.breaker.isTripped(w.vaultAddr), false, 'expired by itself');
  await benign(w, 40, { seed: 3, onBlock: () => w.loop.tick() });
  w.chain.advance(6 * 3600 + 60); // a quiet period of maxPause after the expiry: the streak resets
  const a2 = await attack(w, { attempts: 3, tick: () => w.loop.tick() });
  assert.equal(a2.ok, 1, 'again only one block got through');
  assert.equal(w.loop.stats.trips.length, 2);
  assert.ok(w.loop.stats.trips[1].evidenceBlock > first.evidenceBlock);
  assert.notEqual(w.loop.stats.trips[1].evidenceHash, first.evidenceHash);
  assert.equal(await w.breaker.streak(w.vaultAddr), 1n, 'a quiet period after the first trip reset the streak');
});

test('invariant-only mode: no runners, the cap alone bounds the loss per window; a too-tight cap trips on benign traffic', async () => {
  const inv = await runDemo({ mode: 'invariant', cap: 2000, benignBlocks: 40, attempts: 40 });
  assert.equal(inv.tripKind, 'invariant');
  assert.equal(inv.falseTrips, 0);
  const off = await runDemo({ selfHealing: false, benignBlocks: 40, attempts: 40 });
  assert.ok(inv.lossZeta < off.lossZeta);
  const tight = await runDemo({ mode: 'invariant', cap: 300, benignBlocks: 120, attempts: 1 });
  assert.ok(tight.falseTrips >= 1, 'calibration matters: a cap below normal traffic is a false trip');
  void parseEther; void ZeroHash;
});
