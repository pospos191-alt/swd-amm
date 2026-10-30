// PQSettlement (contracts/PQSettlement.sol) and src/qsafe/settlement.js: batch netting authorised only by
// ML-DSA-44 signatures (real keys; helpers/precompiles.js runs FIPS 204 at 0x…0900), replay protection,
// withdrawals with nonces, and finality tied to the block's ML-DSA certificate.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { tokenKitArtifacts } from './helpers/hyperlanekit.js';
import { batch, batchDigest, netPositions, payers, signBatch, withdrawDigest, keyIdOf, settlementFinality, NATIVE } from '../src/qsafe/settlement.js';

const CHAIN_ID = 1;
const [A, B, C] = [mldsaKey(), mldsaKey(), mldsaKey()];
let c, s, tok, ctx;
beforeEach(async () => {
  c = await createChain(['payer', 'relay', 'bob'], {}, { precompiles: PRECOMPILES });
  s = await c.deploy('PQSettlement', [], 'payer');
  tok = await c.deployRaw(tokenKitArtifacts().KitToken, ['T', 'T', 18], 'payer');
  ctx = { chainId: CHAIN_ID, contract: s.address };
  for (const k of [A, B, C]) await s.send('payer', 'deposit', [keyIdOf(k.publicKey), NATIVE, 10n * ZETA], 10n * ZETA);
  await tok.send('payer', 'mint', [c.acct.payer.toString(), 1000n]);
  await tok.send('payer', 'approve', [s.address, 1000n]);
  await s.send('payer', 'deposit', [keyIdOf(A.publicKey), tok.address, 100n]);
});

const bal = (k, t = NATIVE) => s.call('balanceOf', [keyIdOf(k.publicKey), t]);
const deadline = () => c.now() + 600n;
async function settle(b, keys, from = 'relay') {
  const d = batchDigest(ctx, b);
  return s.send(from, 'settle', [b.parties, b.payments, b.salt, b.deadline, signBatch(b, d, keys)]);
}

test('the JS batch digest equals the contract digest', async () => {
  const b = batch({ payments: [{ from: A.publicKey, to: B.publicKey, amount: ZETA }], deadline: deadline() });
  assert.equal(await s.call('batchDigest', [b.parties, b.payments, b.salt, b.deadline]), batchDigest(ctx, b));
});

test('a netted batch: a cycle of payments moves only the net, with every payer signing', async () => {
  const b = batch({ deadline: deadline(), payments: [
    { from: A.publicKey, to: B.publicKey, amount: 5n * ZETA },
    { from: B.publicKey, to: C.publicKey, amount: 5n * ZETA },
    { from: C.publicKey, to: A.publicKey, amount: 2n * ZETA },
    { from: A.publicKey, to: C.publicKey, token: tok.address, amount: 40n },
  ] });
  const net = netPositions(b);
  assert.equal(net[keyIdOf(A.publicKey)][NATIVE], -3n * ZETA);
  assert.equal(net[keyIdOf(B.publicKey)], undefined, 'B nets to zero');
  assert.equal(payers(b).length, 3);
  const ev = await settle(b, [A, B, C]);
  assert.ok(ev.some((e) => e?.name === 'Settled'));
  assert.equal(await bal(A), 7n * ZETA);
  assert.equal(await bal(B), 10n * ZETA);
  assert.equal(await bal(C), 13n * ZETA);
  assert.equal(await bal(A, tok.address), 60n);
  assert.equal(await bal(C, tok.address), 40n);
  const d = batchDigest(ctx, b);
  assert.equal(await s.call('isFinal', [d]), true, 'a later block exists');
});

test('a payer that did not sign, a wrong signature or a wrong key fails the whole batch', async () => {
  const b = batch({ deadline: deadline(), payments: [
    { from: A.publicKey, to: B.publicKey, amount: ZETA }, { from: B.publicKey, to: C.publicKey, amount: ZETA }] });
  const d = batchDigest(ctx, b);
  const sigs = signBatch(b, d, [A, B]);
  await assert.rejects(s.send('relay', 'settle', [b.parties, b.payments, b.salt, b.deadline, sigs.slice(0, 1)]), /MissingSignature/);
  const bad = sigs.map((x) => [...x]); bad[1][2] = C.sign(d);
  await assert.rejects(s.send('relay', 'settle', [b.parties, b.payments, b.salt, b.deadline, bad]), /BadSignature/);
  const wrong = sigs.map((x) => [...x]); wrong[1][1] = C.publicKey; wrong[1][2] = C.sign(d);
  await assert.rejects(s.send('relay', 'settle', [b.parties, b.payments, b.salt, b.deadline, wrong]), /WrongKey/);
  assert.equal(await bal(A), 10n * ZETA);
  assert.throws(() => signBatch(b, d, [A]), /must sign/);
});

test('replay protection, deadline and malformed batches', async () => {
  const b = batch({ deadline: deadline(), payments: [{ from: A.publicKey, to: B.publicKey, amount: ZETA }] });
  await settle(b, [A]);
  await assert.rejects(settle(b, [A]), /AlreadySettled/);
  const late = batch({ deadline: c.now() - 1n, payments: [{ from: A.publicKey, to: B.publicKey, amount: ZETA }] });
  await assert.rejects(settle(late, [A]), /Expired/);
  const unsorted = { ...b, salt: '0x' + '01'.repeat(32), parties: [...b.parties].reverse(), payments: [[1, 0, NATIVE, ZETA]] };
  await assert.rejects(s.send('relay', 'settle', [unsorted.parties, unsorted.payments, unsorted.salt, unsorted.deadline, []]), /BadBatch/);
  const self = { ...b, salt: '0x' + '02'.repeat(32), payments: [[0, 0, NATIVE, ZETA]] };
  await assert.rejects(s.send('relay', 'settle', [self.parties, self.payments, self.salt, self.deadline, []]), /BadBatch/);
});

test('all or nothing: a shortfall reverts the batch', async () => {
  const b = batch({ deadline: deadline(), payments: [
    { from: A.publicKey, to: B.publicKey, amount: ZETA }, { from: C.publicKey, to: B.publicKey, amount: 11n * ZETA }] });
  await assert.rejects(settle(b, [A, C]), /Insufficient/);
  assert.equal(await bal(A), 10n * ZETA);
  assert.equal(await s.call('settledAt', [batchDigest(ctx, b)]), 0n);
});

test('withdraw needs an ML-DSA signature over a per-key nonce (no replay)', async () => {
  const to = c.acct.bob.toString();
  const keyId = keyIdOf(A.publicKey);
  const w = { keyId, token: NATIVE, amount: 2n * ZETA, to, nonce: 0n, deadline: deadline() };
  const d = withdrawDigest(ctx, w);
  assert.equal(await s.call('withdrawDigest', [keyId, NATIVE, w.amount, to, 0n, w.deadline]), d);
  await assert.rejects(s.send('relay', 'withdraw', [A.publicKey, NATIVE, w.amount, to, w.deadline, B.sign(d)]), /BadSignature/);
  const before = await c.balance('bob');
  await s.send('relay', 'withdraw', [A.publicKey, NATIVE, w.amount, to, w.deadline, A.sign(d)]);
  assert.equal(await c.balance('bob') - before, 2n * ZETA);
  assert.equal(await s.call('nonceOf', [keyId]), 1n);
  await assert.rejects(s.send('relay', 'withdraw', [A.publicKey, NATIVE, w.amount, to, w.deadline, A.sign(d)]), /BadSignature/, 'replayed');
  const d2 = withdrawDigest(ctx, { ...w, token: tok.address, amount: 30n, nonce: 1n });
  await s.send('relay', 'withdraw', [A.publicKey, tok.address, 30n, to, w.deadline, A.sign(d2)]);
  assert.equal(await tok.call('balanceOf', [to]), 30n);
});

test('deposits: value must match; a non-contract token is refused', async () => {
  await assert.rejects(s.send('payer', 'deposit', [keyIdOf(A.publicKey), NATIVE, ZETA], 1n), /BadParams/);
  await assert.rejects(s.send('payer', 'deposit', ['0x' + '00'.repeat(32), NATIVE, ZETA], ZETA), /BadParams/);
  await assert.rejects(s.send('payer', 'deposit', [keyIdOf(A.publicKey), c.acct.bob.toString(), 1n]), /BadParams/);
});

test('settlementFinality: final only when the ML-DSA certificate verifies with a PQ supermajority', async () => {
  assert.equal((await settlementFinality({ height: 0, verifyBlock: async () => ({ ok: true }) })).final, false);
  assert.equal((await settlementFinality({ height: 9, verifyBlock: async () => { throw new Error('no block 10'); } })).final, false);
  assert.equal((await settlementFinality({ height: 9, verifyBlock: async () => ({ ok: false, problems: ['bad sig'] }) })).reason, 'bad sig');
  const partial = await settlementFinality({ height: 9, verifyBlock: async () => ({ ok: true, pqMajority: false }) });
  assert.equal(partial.final, false);
  assert.match(partial.reason, /not quantum-safe final/);
  assert.deepEqual(await settlementFinality({ height: 9, verifyBlock: async (h) => ({ ok: h === 9, pqMajority: true }) }),
    { final: true, height: 9, reason: 'block certified with ML-DSA by more than 2/3 of all voting power' });
});
