// ML-DSA-44 offline cheques and orders: ZetaphyPQCheques and ZetaphyPQOfflineOrders (contracts/) with the JS side
// in src/qsafe/offline.js. Real ML-DSA-44 keys; helpers/precompiles.js runs FIPS 204 at 0x…0900 like the chain.
// The cheques: open with a public key, the payee checks offline, cash, replay / wrong key / tampering refused,
// the channel life cycle. The orders: a maker names its ML-DSA key, a relayer fills; a QuantumWallet in
// post-quantum-only mode as the maker (no ECDSA key anywhere on the maker's side); key rotation voids old orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, getBytes, hexlify } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { dexArt } from './helpers/mocks.js';
import { Address } from '@ethereumjs/util';
import { pqFromSeed } from '../src/pq.js';
import {
  pqKeyHash, pqVerify, pqChequeDigest, signPQCheque, checkPQCheque, pqCashArgs, encodePQCheque, decodePQCheque,
  pqOrderHash, pqOrderDigest, signPQOrder, checkPQOrder, pqFillArgs, pqOrderTuple, encodePQOrder, decodePQOrder, NATIVE,
} from '../src/qsafe/offline.js';

const DAY = 86400, HOUR = 3600;
const CHAIN_ID = 1; // the in-memory EVM's block.chainid
const signer = mldsaKey(), other = mldsaKey();
const opened = (ev) => ev.find((e) => e?.name === 'ChannelOpened').args.id;

async function chequeWorld() {
  const c = await createChain(['payer', 'payee', 'carol'], {}, { precompiles: PRECOMPILES });
  const a = (n) => c.acct[n].toString();
  const ch = await c.deploy('ZetaphyPQCheques', [], 'payer');
  return { c, a, ch, ctx: { chainId: CHAIN_ID, contract: ch.address } };
}

test('pq cheques: the JS digest is the contract\'s; open names the key, the payee checks offline, anyone cashes, the payee is paid', async () => {
  const { c, a, ch, ctx } = await chequeWorld();
  const expiry = c.now() + BigInt(7 * DAY);
  const ev = await ch.send('payer', 'open', [a('payee'), NATIVE, 10n * ZETA, expiry, signer.publicKey], 10n * ZETA);
  const id = opened(ev);
  assert.equal(ev.find((e) => e?.name === 'ChannelOpened').args.signerKey, pqKeyHash(signer.publicKey));
  assert.equal(ev.find((e) => e?.name === 'SignerKey').args.publicKey, signer.publicKey, 'the payee can read the key from the chain');
  assert.equal(await ch.call('chequeDigest', [id, 3n * ZETA]), pqChequeDigest(ctx, id, 3n * ZETA));

  const [, , closeAt, , , signerKey, deposit, paid, done] = await ch.call('channels', [id]);
  const channel = { signerKey, deposit, paid, closeAt, done };
  const chq = signPQCheque(signer, ctx, id, 3n * ZETA);
  assert.ok(pqVerify(pqChequeDigest(ctx, id, 3n * ZETA), signer.publicKey, chq.sig), 'a real ML-DSA-44 signature');
  // the payee, offline: the cheque travels as text and is checked against the channel it last saw
  const back = decodePQCheque(encodePQCheque(chq));
  assert.deepEqual(back, chq);
  assert.deepEqual(checkPQCheque(back, { publicKey: signer.publicKey, channel, now: c.now(), ...ctx }), { ok: true, amount: 3n * ZETA, reason: 'ok' });
  assert.equal(checkPQCheque(back, { publicKey: other.publicKey, channel }).reason, 'not the channel\'s key');
  assert.equal(checkPQCheque({ ...back, cumulative: 4n * ZETA }, { publicKey: signer.publicKey, channel }).reason, 'bad signature');
  assert.equal(checkPQCheque(back, { publicKey: signer.publicKey, channel, chainId: 77390 }).reason, 'another chain');
  assert.equal(checkPQCheque(back, { publicKey: signer.publicKey, channel: { ...channel, paid: 3n * ZETA } }).reason, 'nothing new to cash');
  assert.throws(() => decodePQCheque('ZCHQ1:abc'), /not an ML-DSA cheque/);

  const before = await c.balance('payee');
  const evc = await ch.send('carol', 'cash', pqCashArgs(back, signer.publicKey));
  const cashed = evc.find((e) => e?.name === 'Cashed');
  assert.equal(cashed.args.amount, 3n * ZETA);
  assert.equal(cashed.args.submitter.toLowerCase(), a('carol').toLowerCase());
  assert.equal(await c.balance('payee') - before, 3n * ZETA);
  await assert.rejects(ch.send('payee', 'cash', pqCashArgs(back, signer.publicKey)), /NothingToCash/, 'replay pays nothing');
  // a cheque above the deposit pays the deposit; a top-up lets the same cheque pay the rest
  const big = signPQCheque(signer, ctx, id, 15n * ZETA);
  assert.equal(await ch.call('cashable', [id, 15n * ZETA]), 7n * ZETA);
  await ch.send('payee', 'cash', pqCashArgs(big, signer.publicKey));
  assert.equal(await c.balance('payee') - before, 10n * ZETA);
  await ch.send('payer', 'topUp', [id, 10n * ZETA], 10n * ZETA);
  await ch.send('payee', 'cash', pqCashArgs(big, signer.publicKey));
  assert.equal(await c.balance('payee') - before, 15n * ZETA);
});

test('pq cheques: another key, a forged or tampered signature, another channel / contract / chain: all refused; no ECDSA path', async () => {
  const { c, a, ch, ctx } = await chequeWorld();
  const exp = c.now() + BigInt(DAY);
  const id = opened(await ch.send('payer', 'open', [a('payee'), NATIVE, 10n * ZETA, exp, signer.publicKey], 10n * ZETA));
  const id2 = opened(await ch.send('payer', 'open', [a('payee'), NATIVE, 10n * ZETA, exp, signer.publicKey], 10n * ZETA));
  const good = signPQCheque(signer, ctx, id, ZETA);
  // another key: its own (valid) signature, but not the channel's key
  await assert.rejects(ch.send('payee', 'cash', pqCashArgs(signPQCheque(other, ctx, id, ZETA), other.publicKey)), /WrongKey/);
  // the right key, another key's signature
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, signer.publicKey, other.sign(pqChequeDigest(ctx, id, ZETA))]), /BadSignature/);
  const flipped = getBytes(good.sig); flipped[100] ^= 1;
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, signer.publicKey, hexlify(flipped)]), /BadSignature/, 'one bit flipped');
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, signer.publicKey, good.sig.slice(0, -2)]), /BadSignature/, 'one byte short');
  await assert.rejects(ch.send('payee', 'cash', [id, 2n * ZETA, signer.publicKey, good.sig]), /BadSignature/, 'amount changed');
  await assert.rejects(ch.send('payee', 'cash', [id2, ZETA, signer.publicKey, good.sig]), /BadSignature/, 'a cheque of channel 1 on channel 2');
  const ch2 = await c.deploy('ZetaphyPQCheques', [], 'payer');
  await ch2.send('payer', 'open', [a('payee'), NATIVE, 10n * ZETA, exp, signer.publicKey], 10n * ZETA);
  await assert.rejects(ch2.send('payee', 'cash', [id, ZETA, signer.publicKey, good.sig]), /BadSignature/, 'the digest binds the contract');
  const other77390 = signPQCheque(signer, { ...ctx, chainId: 77390 }, id, ZETA);
  await assert.rejects(ch.send('payee', 'cash', pqCashArgs(other77390, signer.publicKey)), /BadSignature/, 'and the chain id');
  await assert.rejects(ch.send('payee', 'cash', [9n, ZETA, signer.publicKey, good.sig]), /BadChannel/);
  // the contract has no ecrecover path at all: the ECDSA cash(uint256,uint256,bytes) does not exist
  const iface = new Interface(ch.iface.fragments);
  assert.equal(iface.getFunction('cash').inputs.length, 4);
  assert.equal(iface.fragments.filter((f) => f.type === 'function' && f.name === 'cash').length, 1);
  await ch.send('carol', 'cash', pqCashArgs(good, signer.publicKey));
});

test('pq cheques: opening checks, the 24 h challenge window, withdraw, release, extend', async () => {
  const { c, a, ch, ctx } = await chequeWorld();
  const exp = c.now() + BigInt(DAY);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), NATIVE, ZETA, exp, signer.publicKey.slice(0, -2)], ZETA), /BadChannel/, 'not a 1312-byte key');
  await assert.rejects(ch.send('payer', 'open', [a('payer'), NATIVE, ZETA, exp, signer.publicKey], ZETA), /BadChannel/, 'to itself');
  await assert.rejects(ch.send('payer', 'open', [a('payee'), NATIVE, 0n, exp, signer.publicKey], 0n), /BadAmount/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), NATIVE, ZETA, exp, signer.publicKey], 1n), /BadValue/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), NATIVE, ZETA, c.now() + BigInt(400 * DAY), signer.publicKey], ZETA), /BadExpiry/);
  const id = opened(await ch.send('payer', 'open', [a('payee'), NATIVE, 10n * ZETA, exp, signer.publicKey], 10n * ZETA));
  await assert.rejects(ch.send('payer', 'startClose', [id]), /NotExpired/);
  await ch.send('payer', 'extend', [id, exp + BigInt(DAY)]);
  c.advance(2 * DAY);
  await ch.send('payer', 'startClose', [id]);
  await assert.rejects(ch.send('payer', 'withdraw', [id]), /ChallengeOpen/);
  // the payee still cashes during the challenge period
  const chq = signPQCheque(signer, ctx, id, 4n * ZETA);
  const [, , closeAt, , , signerKey, deposit, paid, done] = await ch.call('channels', [id]);
  assert.equal(checkPQCheque(chq, { publicKey: signer.publicKey, channel: { signerKey, deposit, paid, closeAt, done }, now: c.now() }).reason,
    'closing: cash before the challenge period ends');
  await ch.send('payee', 'cash', pqCashArgs(chq, signer.publicKey));
  c.advance(DAY);
  await assert.rejects(ch.send('payee', 'cash', pqCashArgs(signPQCheque(signer, ctx, id, 5n * ZETA), signer.publicKey)), /ChannelDone/);
  const before = await c.balance('payer');
  await ch.send('payer', 'withdraw', [id]);
  assert.equal(await c.balance('payer') - before, 6n * ZETA);
  // release: the payee lets the payer withdraw at once
  const id2 = opened(await ch.send('payer', 'open', [a('payee'), NATIVE, ZETA, c.now() + BigInt(DAY), signer.publicKey], ZETA));
  await assert.rejects(ch.send('carol', 'release', [id2]), /NotPayee/);
  await ch.send('payee', 'release', [id2]);
  await ch.send('payer', 'withdraw', [id2]);
  await assert.rejects(ch.send('payer', 'withdraw', [id2]), /ChannelDone/);
});

// ---------------------------------------------------------------- orders

async function dexWorld() {
  const c = await createChain(['lp', 'relayer', 'maker', 'carol'], {}, { precompiles: PRECOMPILES });
  const a = (n) => c.acct[n].toString();
  const wz = await c.deployRaw(dexArt('WZETAPHY'), [], 'lp');
  const factory = await c.deployRaw(dexArt('ZetaphyFactory'), [a('lp')], 'lp');
  const router = await c.deployRaw(dexArt('ZetaphyRouter'), [factory.address, wz.address], 'lp');
  const A = await c.deployRaw(dexArt('TestToken'), ['Alpha', 'A', 18, 10n ** 27n, 0], 'lp');
  const B = await c.deployRaw(dexArt('TestToken'), ['Beta', 'B', 18, 10n ** 27n, 0], 'lp');
  const deadline = c.now() + 10n * BigInt(DAY);
  for (const t of [A, B]) await t.send('lp', 'approve', [router.address, 10n ** 30n]);
  await router.send('lp', 'addLiquidity', [A.address, B.address, 100_000n * ZETA, 100_000n * ZETA, 0n, 0n, a('lp'), deadline]);
  await router.send('lp', 'addLiquidityETH', [A.address, 100_000n * ZETA, 0n, 0n, a('lp'), deadline], 100_000n * ZETA);
  const ox = await c.deploy('ZetaphyPQOfflineOrders', [router.address], 'lp');
  await A.send('lp', 'transfer', [a('maker'), 1000n * ZETA]);
  await A.send('maker', 'approve', [ox.address, 10n ** 30n]);
  const order = (over = {}) => ({ maker: a('maker'), tokenIn: A.address, tokenOut: B.address, amountIn: 100n * ZETA, minAmountOut: 95n * ZETA,
    deadline: c.now() + BigInt(HOUR), nonce: 7n, relayerFee: ZETA, ...over });
  return { c, a, wz, router, A, B, ox, order, ctx: { chainId: CHAIN_ID, contract: ox.address } };
}

test('pq orders: the JS hashes are the contract\'s; a maker names its key, a relayer fills; no replay; offline checks', async () => {
  const { c, a, A, B, ox, order, ctx } = await dexWorld();
  const o = order();
  assert.equal(await ox.call('orderHash', [pqOrderTuple(o)]), pqOrderHash(o));
  assert.equal(await ox.call('digest', [pqOrderTuple(o)]), pqOrderDigest(ctx, o));
  const signed = signPQOrder(signer, ctx, o);
  // no key named yet: refused on chain and by the offline check
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signed)), /NoKey/);
  assert.equal(checkPQOrder(signed, { makerKeyHash: await ox.call('pqKeyOf', [a('maker')]), now: c.now() }).reason, 'the maker has no ML-DSA key on chain');
  const ks = await ox.send('maker', 'setPQKey', [pqKeyHash(signer.publicKey)]);
  assert.equal(ks.find((e) => e?.name === 'PQKeySet').args.keyHash, pqKeyHash(signer.publicKey));
  // the order travels as text; the relayer checks it offline
  const back = decodePQOrder(encodePQOrder(signed));
  assert.deepEqual(back, signed);
  const makerKeyHash = await ox.call('pqKeyOf', [a('maker')]);
  assert.deepEqual(checkPQOrder(back, { makerKeyHash, now: c.now(), ...ctx }), { ok: true, reason: 'ok' });
  assert.equal(checkPQOrder({ ...back, order: { ...back.order, relayerFee: 5n * ZETA } }, { makerKeyHash }).reason, 'bad signature');
  assert.equal(checkPQOrder(back, { makerKeyHash, now: c.now() + BigInt(2 * HOUR) }).reason, 'expired');
  assert.throws(() => decodePQOrder('ZORD1:abc'), /not an ML-DSA order/);

  const ev = await ox.send('relayer', 'fill', pqFillArgs(back));
  const f = ev.find((e) => e?.name === 'OrderFilled');
  assert.equal(f.args.relayer.toLowerCase(), a('relayer').toLowerCase());
  assert.equal(f.args.orderHash, pqOrderHash(o));
  const got = await B.call('balanceOf', [a('maker')]);
  assert.equal(got, f.args.amountOut);
  assert.ok(got >= 95n * ZETA && got < 99n * ZETA, `maker got ${got}`);
  assert.equal(await B.call('balanceOf', [a('relayer')]), ZETA, 'the fee');
  assert.equal(await A.call('balanceOf', [a('maker')]), 900n * ZETA, 'exactly amountIn');
  for (const t of [A, B]) assert.equal(await t.call('balanceOf', [ox.address]), 0n, 'nothing stays in the contract');
  await assert.rejects(ox.send('carol', 'fill', pqFillArgs(back)), /NonceUsed/, 'replay');
  // native ZETAPHY out, through a route the relayer picks
  const n = order({ tokenOut: NATIVE, minAmountOut: 90n * ZETA, relayerFee: 2n * ZETA, nonce: 8n });
  const mBefore = await c.balance('maker');
  await ox.send('relayer', 'fill', pqFillArgs(signPQOrder(signer, ctx, n)));
  assert.ok(await c.balance('maker') - mBefore >= 90n * ZETA);
  assert.equal(await c.balance(Address.fromString(ox.address)), 0n);
});

test('pq orders: another key, a tampered order, the ECDSA domain\'s digest, cancel, deadline, minimum, rotation voids old orders', async () => {
  const { c, a, A, ox, order, ctx } = await dexWorld();
  await ox.send('maker', 'setPQKey', [pqKeyHash(signer.publicKey)]);
  const o = order();
  const signed = signPQOrder(signer, ctx, o);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(other, ctx, o))), /WrongKey/, 'another key');
  await assert.rejects(ox.send('relayer', 'fill', [pqOrderTuple(o), signer.publicKey, other.sign(pqOrderDigest(ctx, o)), []]), /BadSignature/);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs({ ...signed, order: { ...o, relayerFee: 5n * ZETA } })), /BadSignature/, 'a bigger fee');
  await assert.rejects(ox.send('relayer', 'fill', [pqOrderTuple(o), signer.publicKey, signer.sign(pqOrderHash(o)), []]), /BadSignature/, 'the bare struct hash is not the digest');
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(signer, { ...ctx, chainId: 77390 }, o))), /BadSignature/, 'the digest binds the chain');
  await ox.send('maker', 'cancel', [7n]);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signed)), /NonceUsed/);
  await ox.send('maker', 'cancelWord', [1n, 1n << 3n]); // nonce 259
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(signer, ctx, order({ nonce: 259n })))), /NonceUsed/);
  const late = signPQOrder(signer, ctx, order({ nonce: 9n }));
  const greedy = signPQOrder(signer, ctx, order({ nonce: 10n, minAmountOut: 99n * ZETA, deadline: c.now() + BigInt(DAY) }));
  const before = await A.call('balanceOf', [a('maker')]);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(greedy)));
  assert.equal(await A.call('balanceOf', [a('maker')]), before, 'a failed fill moves nothing');
  assert.equal(await ox.call('isNonceUsed', [a('maker'), 10n]), false, 'and leaves the nonce');
  for (const bad of [order({ nonce: 11n, amountIn: 0n }), order({ nonce: 12n, tokenOut: A.address }), order({ nonce: 13n, tokenIn: NATIVE })]) {
    await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(signer, ctx, bad))), /BadOrder/);
  }
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(signer, ctx, order({ nonce: 14n })), [A.address])), /BadPath/);
  c.advance(HOUR + 1);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(late)), /Expired/);
  // rotation: the maker names a new key; orders signed with the old one no longer fill
  const fresh = signPQOrder(signer, ctx, order({ nonce: 30n, deadline: c.now() + BigInt(DAY) }));
  await ox.send('maker', 'setPQKey', [pqKeyHash(other.publicKey)]);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(fresh)), /WrongKey/);
  await ox.send('relayer', 'fill', pqFillArgs(signPQOrder(other, ctx, order({ nonce: 31n, deadline: c.now() + BigInt(DAY) }))));
  await ox.send('maker', 'setPQKey', ['0x' + '00'.repeat(32)]);
  await assert.rejects(ox.send('relayer', 'fill', pqFillArgs(signPQOrder(other, ctx, order({ nonce: 32n, deadline: c.now() + BigInt(DAY) })))), /NoKey/);
});

test('pq orders end to end with no ECDSA key on the maker\'s side: a post-quantum-only QuantumWallet names its key, approves, trades offline', async () => {
  const { c, A, B, ox, order, ctx } = await dexWorld();
  const key = pqFromSeed('0x' + '5a'.repeat(32)); // the CLI's key type (src/pq.js), the same ML-DSA-44
  const w = await c.deploy('QuantumWallet', ['0x' + '00'.repeat(20), 44, key.keyHash], 'lp');
  const exec = async (to, iface, fn, args) => {
    const data = iface.encodeFunctionData(fn, args);
    const deadline = c.now() + BigInt(HOUR);
    const d = await w.call('digest', [to, 0n, data, deadline]);
    return w.send('relayer', 'execute', [to, 0n, data, deadline, [key.publicKey, key.sign(d), '0x']]);
  };
  await A.send('lp', 'transfer', [w.address, 200n * ZETA]);
  await exec(ox.address, ox.iface, 'setPQKey', [pqKeyHash(key.publicKey)]);
  await exec(A.address, A.iface, 'approve', [ox.address, 200n * ZETA]);
  assert.equal(await ox.call('pqKeyOf', [w.address]), keccak256(key.publicKey));
  // offline: the wallet's owner signs an order with the same ML-DSA key; anyone relays it
  const signed = signPQOrder(key, ctx, order({ maker: w.address, nonce: 1n }));
  const text = encodePQOrder(signed);
  const ev = await ox.send('carol', 'fill', pqFillArgs(decodePQOrder(text)));
  const f = ev.find((e) => e?.name === 'OrderFilled');
  assert.equal(f.args.maker.toLowerCase(), w.address.toLowerCase());
  assert.equal(await B.call('balanceOf', [w.address]), f.args.amountOut);
  assert.equal(await A.call('balanceOf', [w.address]), 100n * ZETA);
});
