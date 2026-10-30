// Post-quantum threshold-encrypted mempool prototype (src/encmempool,
// docs/future/encrypted-mempool.md): KEM, Shamir, dealings, envelopes, signed
// share releases, the ordering state machine and the MEV simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drbg, utf8, hex, split, combine, kemKeygen, encapsulate, decapsulate, sealTo, openFrom, aeadSeal, aeadOpen,
  KEM_PUBLIC_KEY_BYTES, KEM_CIPHERTEXT_BYTES, makeValidator, publicValidator, defaultThreshold, selectDealers,
  createDealing, decodeDealing, verifyDealing, openDealing, signAck, acceptDealings,
  encryptTx, decodeEnvelope, verifyEnvelope, decryptEnvelope, payerFromSeed, padPayload, unpadPayload, PAD_BYTES, MAX_ENVELOPE_BYTES,
  batchHash, createRelease, decodeRelease, verifyRelease, reconstructSeeds, releaseBytes, EncryptedLane,
} from '../src/encmempool/index.js';
import { setupCommittee, runScenario, pickCoalition, planSandwich, blindSandwichEV, Pool, victimTx, encodeSwap, decodeSwap, DEFAULT_MARKET } from '../src/encmempool/sim.js';

const CHAIN = 'zetaphy_9369-1';
const flip = (b, i) => { const c = Uint8Array.from(b); c[i] ^= 1; return c; };

// One shared n = 4 committee (t = 3, 3 dealers, epoch heights 1..8): the crypto setup is the slow part.
const S = setupCommittee({ n: 4 });
const payer = payerFromSeed(new Uint8Array(32).fill(9), { deterministic: true });
const laneFor = (s = S, ttl = 3) => {
  const lane = new EncryptedLane({ chainId: s.chainId, committee: s.committee, t: s.t, ttl, rules: { minFeePerByte: 1n, maxGas: 10_000_000 } });
  lane.setEpoch(0, s.dealings);
  return lane;
};
const envFor = (lane, height, tx, seed = 'env') => {
  const { epoch, keys } = lane.publicKeys(height);
  return encryptTx({ chainId: CHAIN, height, epoch, keys, fee: 100_000n, gasLimit: 100_000, payer, tx, rng: drbg(seed) });
};
const releasesFor = (s, height, bh, who = s.validators.map((v) => v.index)) =>
  who.map((i) => createRelease({ chainId: s.chainId, height, batchHash: bh, dealings: s.dealings, myShares: s.opened[i], me: s.validators[i] }));

test('X-Wing (ML-KEM-768 + X25519) round trip, sizes, and AEAD tamper detection', () => {
  const rng = drbg('kem');
  const { publicKey, secretKey } = kemKeygen(rng(32));
  assert.equal(publicKey.length, KEM_PUBLIC_KEY_BYTES);
  const { cipherText, sharedSecret } = encapsulate(publicKey, rng);
  assert.equal(cipherText.length, KEM_CIPHERTEXT_BYTES);
  assert.deepEqual(decapsulate(cipherText, secretKey), sharedSecret);
  // implicit rejection: a modified ciphertext gives an unrelated secret
  assert.notDeepEqual(decapsulate(flip(cipherText, 5), secretKey), sharedSecret);
  const aad = utf8('header');
  const sealed = sealTo(publicKey, utf8('hello'), aad, rng);
  assert.deepEqual(openFrom(secretKey, sealed.kemCt, sealed.ct, aad), utf8('hello'));
  assert.equal(openFrom(secretKey, sealed.kemCt, flip(sealed.ct, 0), aad), null);
  assert.equal(openFrom(secretKey, sealed.kemCt, sealed.ct, utf8('other')), null);
  const key = rng(32);
  assert.equal(aeadOpen(key, flip(aeadSeal(key, utf8('x'), aad), 1), aad), null);
});

test('Shamir t-of-n over GF(256): every t-subset rebuilds, t-1 shares do not', () => {
  const rng = drbg('shamir');
  const secret = rng(32);
  const n = 7, t = 4;
  const shares = split(secret, n, t, rng);
  assert.equal(shares.length, n);
  // all 35 subsets of size 4
  const idx = [...Array(n).keys()];
  const subsets = (k, from = 0) => (k === 0 ? [[]] : idx.slice(from).flatMap((i) => subsets(k - 1, i + 1).map((r) => [i, ...r])));
  for (const sub of subsets(t)) assert.deepEqual(combine(sub.map((i) => shares[i])), secret);
  // t-1 shares are consistent with ANY secret: for a chosen fake secret there is a share completing it
  const fake = rng(32);
  const someShares = shares.slice(0, t - 1);
  assert.notDeepEqual(combine(someShares), secret);
  const forged = split(fake, n, t, rng); // independent polynomial
  assert.notDeepEqual(combine([...someShares, forged[t - 1]]), secret);
  assert.throws(() => combine([shares[0], shares[0]]), /duplicate/);
  assert.throws(() => split(secret, 256, 3, rng), /bad threshold/);
  assert.throws(() => split(secret, 3, 4, rng), /bad threshold/);
  assert.deepEqual(combine(split(secret, 1, 1, rng)), secret);
});

test('dealing: encodes/decodes, verifies, each validator opens commitment-checked shares; tampering is caught', () => {
  const d = S.dealings[0];
  const back = decodeDealing(d.bytes);
  assert.deepEqual(back.hash, d.hash);
  assert.ok(verifyDealing(back, S.committee, { chainId: CHAIN, epoch: 0, t: S.t }).ok);
  assert.equal(verifyDealing(decodeDealing(flip(d.bytes, 200)), S.committee).ok, false); // body change breaks the dealer signature
  assert.equal(verifyDealing(d, S.committee, { t: S.t + 1 }).reason, 'wrong threshold');
  for (const v of S.validators) assert.ok(openDealing(d, v).ok);
  // a blob for validator 1 handed to validator 2 does not open
  const swapped = { ...d, blobs: d.blobs.map((b, j) => (j === 2 ? d.blobs[1] : b)) };
  assert.equal(openDealing(swapped, S.validators[2]).ok, false);
  // acks: below minAcks the dealing is not accepted
  const acks = [signAck(d, S.validators[0])];
  assert.equal(acceptDealings([d], acks, S.committee, { chainId: CHAIN, epoch: 0, t: S.t }).length, 0);
  assert.equal(S.dealings.length, S.d);
  assert.deepEqual(S.dealings.map((x) => x.dealer), [...S.dealers]);
  assert.deepEqual(selectDealers(new Uint8Array(32), 5, 21, 3), selectDealers(new Uint8Array(32), 5, 21, 3));
});

test('envelope: encrypt -> decrypt with rebuilt keys; any tamper or wrong context is refused', () => {
  const lane = laneFor();
  const tx = utf8('signed-evm-tx-bytes');
  const bytes = envFor(lane, 2, tx);
  const ok = lane.checkEnvelope(bytes, 2);
  assert.ok(ok.ok, ok.reason);
  assert.equal(bytes.length < MAX_ENVELOPE_BYTES, true);
  // keys only after >= t releases
  const bh = batchHash(CHAIN, 2n, [ok.envelope.hash]);
  const rec = reconstructSeeds({ releases: releasesFor(S, 2n, bh, [0, 1, 3]), dealings: S.dealings, height: 2n, t: S.t });
  assert.ok(rec.ok);
  assert.deepEqual(decryptEnvelope(ok.envelope, rec.seeds), tx);
  // wrong height / chain / dealer set
  assert.equal(lane.checkEnvelope(bytes, 3).reason, 'wrong target height');
  assert.equal(verifyEnvelope(bytes, { ...lane.rulesFor(2), chainId: 'other' }).reason, 'wrong chain');
  assert.equal(verifyEnvelope(bytes, { ...lane.rulesFor(2), dealers: [0] }).reason, 'wrong dealer set');
  assert.equal(verifyEnvelope(bytes, { ...lane.rulesFor(2), minFeePerByte: 1000n }).reason, 'fee below size-based minimum');
  // flipping any byte of the body breaks the payer signature; in the signature too
  for (const i of [40, 300, 2000, bytes.length - 2500, bytes.length - 10]) assert.equal(lane.checkEnvelope(flip(bytes, i), 2).ok, false);
  // a relay re-signing a modified ciphertext as itself: valid outer signature, but the payload no longer decrypts
  const e = decodeEnvelope(bytes);
  assert.equal(decryptEnvelope({ ...e, ct: flip(e.ct, 3) }, rec.seeds), null);
  assert.equal(decryptEnvelope({ ...e, aad: flip(e.aad, 30) }, rec.seeds), null);
  // oversize is refused before decoding
  assert.match(lane.checkEnvelope(new Uint8Array(MAX_ENVELOPE_BYTES + 1), 2).reason, /too large/);
  // padding hides the exact length inside 256-byte buckets
  assert.equal(padPayload(utf8('a')).length, PAD_BYTES);
  assert.deepEqual(unpadPayload(padPayload(tx)), tx);
  assert.equal(unpadPayload(flip(padPayload(tx), PAD_BYTES - 1)), null);
});

test('share releases: signature, batch hash, commitment and signer are all checked', () => {
  const bh = batchHash(CHAIN, 3n, [new Uint8Array(32)]);
  const ctx = { chainId: CHAIN, committee: S.committee, dealings: S.dealings, height: 3n, batchHash: bh };
  const [r] = releasesFor(S, 3n, bh, [2]);
  assert.ok(verifyRelease(decodeRelease(r.bytes), ctx).ok);
  assert.equal(r.bytes.length, releaseBytes(CHAIN.length, S.d));
  // released for another (uncommitted / forked) batch: refused, and attributable (it is signed)
  const [early] = releasesFor(S, 3n, batchHash(CHAIN, 3n, []), [2]);
  assert.equal(verifyRelease(early, ctx).reason, 'batch hash is not the committed one');
  // forged signer: validator 2's shares claimed by validator 1
  const forged = decodeRelease(r.bytes);
  forged.validator = 1;
  assert.notEqual(verifyRelease(forged, ctx).ok, true);
  // a wrong share (does not match the dealer's commitment)
  const bad = decodeRelease(r.bytes);
  bad.shares = bad.shares.map((s, i) => (i === 0 ? { ...s, share: flip(s.share, 0) } : s));
  assert.match(verifyRelease(bad, ctx).reason, /does not match its commitment/);
  // a flipped signature byte
  const sigFlip = decodeRelease(flip(r.bytes, r.bytes.length - 5));
  assert.equal(verifyRelease(sigFlip, ctx).reason, 'bad signature');
  // wrong height
  assert.equal(verifyRelease(r, { ...ctx, height: 4n }).reason, 'wrong height');
});

test('ordering: committed order is the execution order, whatever releases arrive and in what order', () => {
  const txs = ['alice', 'bob', 'carol', 'dave', 'erin'].map((x) => utf8(`tx-${x}`));
  const run = (releaseOrder, t = S.t) => {
    const lane = laneFor();
    const envs = txs.map((tx, i) => envFor(lane, 4, tx, `order-${i}`));
    const bh = lane.commitBatch(4n, envs);
    for (const r of releasesFor(S, 4n, bh, releaseOrder)) assert.ok(lane.addRelease(r.bytes).ok);
    const out = lane.beginBlock(5n);
    return { bh, txs: out.execute.map((x) => new TextDecoder().decode(x.tx)) };
  };
  const a = run([0, 1, 2, 3]), b = run([3, 1, 2]), c = run([2, 0, 3]);
  assert.deepEqual(a.txs, txs.map((x) => new TextDecoder().decode(x)));
  assert.deepEqual(b.txs, a.txs);
  assert.deepEqual(c.txs, a.txs);
  assert.deepEqual(a.bh, b.bh);
  // releases before the batch is committed are refused (nothing to bind to)
  const lane = laneFor();
  const bhLater = batchHash(CHAIN, 6n, [new Uint8Array(32)]);
  assert.equal(lane.addRelease(releasesFor(S, 6n, bhLater, [0])[0]).ok, false);
  // a duplicate envelope or an envelope for another height makes the proposal invalid
  const e1 = envFor(lane, 6, utf8('x'));
  assert.throws(() => lane.commitBatch(6n, [e1, e1]), /duplicate/);
  assert.throws(() => laneFor().commitBatch(7n, [e1]), /wrong target height/);
  // batch h+1 never runs before batch h (head-of-line), even if its keys are ready first
  const l2 = laneFor();
  const bh6 = l2.commitBatch(6n, [envFor(l2, 6, utf8('first'), 'h6')]);
  const bh7 = l2.commitBatch(7n, [envFor(l2, 7, utf8('second'), 'h7')]);
  for (const r of releasesFor(S, 7n, bh7)) l2.addRelease(r);
  assert.equal(l2.beginBlock(8n).execute.length, 0);
  for (const r of releasesFor(S, 6n, bh6)) l2.addRelease(r);
  assert.deepEqual(l2.beginBlock(9n).execute.map((x) => new TextDecoder().decode(x.tx)), ['first', 'second']);
});

test('sandwich: profitable with a plaintext mempool, impossible below the threshold, possible at t (stated limit)', () => {
  const plain = runScenario({ n: 4, mode: 'plain' });
  assert.ok(plain.searcherProfit > 0n && plain.victimLoss > 0n);
  for (const c of [0, 1, S.t - 1]) {
    const r = runScenario({ n: 4, setup: S, coalition: pickCoalition(S, c) });
    assert.equal(r.earlyDecrypt, false);
    assert.equal(r.searcherProfit, 0n);
    assert.equal(r.victimLoss, 0n);
    assert.equal(r.victimOut, r.fairOut);
    assert.equal(r.executedAt, 2n);
    assert.equal(r.garbageSkipped, true); // the paid-for junk envelope is skipped, nothing else happens
  }
  const atT = runScenario({ n: 4, setup: S, coalition: pickCoalition(S, S.t) });
  assert.equal(atT.earlyDecrypt, true);
  assert.equal(atT.searcherProfit, plain.searcherProfit);
  const dealers = runScenario({ n: 4, setup: S, coalition: [...S.dealers] });
  assert.equal(dealers.earlyDecrypt, true); // all dealers keeping their seeds also breaks it (documented)
  // blind sandwiching has negative expected value
  const blind = blindSandwichEV({ front: 20_000n * 10n ** 6n, samples: 300 });
  assert.ok(blind.meanProfit < 0n);
  assert.ok(blind.informedMeanProfit > 0n);
});

test('liveness: n-t withholders still decrypt; more withholders -> batch expires after ttl, late shares ignored', () => {
  const live = runScenario({ n: 4, setup: S, withhold: [0] });
  assert.equal(live.executedAt, 2n);
  const dead = runScenario({ n: 4, setup: S, withhold: [0, 1], ttl: 3 });
  assert.equal(dead.expired, true);
  assert.equal(dead.expiredAt, 5n); // h = 1, ttl 3: still waiting at 2..4, expired at 5
  assert.equal(dead.victimOut, 0n);
  assert.equal(dead.victimLoss, 0n);
  assert.ok(dead.inclusionFee > 0n); // the only cost: the inclusion fee paid when the envelope was included
  // directly on the lane: after expiry, late releases have nothing to attach to
  const lane = laneFor(S, 2);
  const bh = lane.commitBatch(3n, [envFor(lane, 3, utf8('late'))]);
  for (const r of releasesFor(S, 3n, bh, [2, 3])) lane.addRelease(r);
  assert.equal(lane.beginBlock(4n).execute.length, 0);
  assert.equal(lane.beginBlock(5n).execute.length, 0);
  const out = lane.beginBlock(6n);
  assert.equal(out.expired.length, 1);
  assert.equal(lane.addRelease(releasesFor(S, 3n, bh, [0])[0]).ok, false);
  assert.equal(lane.beginBlock(7n).execute.length, 0);
});

test('inconsistent dealing is detected and attributed (shares match commitments, key does not)', () => {
  // a dealer that commits to shares of a DIFFERENT seed than its published key
  const rng = drbg('bad-dealer');
  const vs = Array.from({ length: 4 }, (_, i) => makeValidator(i, rng(32), { deterministic: true }));
  const committee = vs.map(publicValidator);
  const t = defaultThreshold(4);
  const { dealing } = createDealing({ chainId: CHAIN, epoch: 0, startHeight: 1n, length: 2, t, committee, dealer: vs[0], rng });
  const other = createDealing({ chainId: CHAIN, epoch: 0, startHeight: 1n, length: 2, t, committee, dealer: vs[0], rng }).dealing;
  const lying = { ...dealing, eks: other.eks }; // keys from another dealing
  const opened = vs.map((v) => new Map([[0, openDealing(lying, v).shares]]));
  const bh = batchHash(CHAIN, 1n, []);
  const rel = vs.map((v) => createRelease({ chainId: CHAIN, height: 1n, batchHash: bh, dealings: [lying], myShares: opened[v.index], me: v }));
  const rec = reconstructSeeds({ releases: rel, dealings: [lying], height: 1n, t });
  assert.equal(rec.ok, false);
  assert.deepEqual(rec.faulty, [0]);
});

test('AMM model sanity: sandwich plan keeps the victim above its minimum output', () => {
  const pool = new Pool(DEFAULT_MARKET.poolA, DEFAULT_MARKET.poolB);
  const v = victimTx(pool);
  assert.deepEqual(decodeSwap(encodeSwap(v)), v);
  const plan = planSandwich(pool, v, DEFAULT_MARKET);
  assert.ok(plan.victimOk && plan.victimOut >= v.minOut && plan.profit > 0n);
  assert.equal(hex(utf8('a')), '61');
});
