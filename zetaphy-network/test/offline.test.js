// Offline trading (docs/future/offline-trading.md): ZetaphyCheques (one-way payment channels, cheques signed by a
// dedicated offline key) and ZetaphyOfflineOrders (swap orders signed offline, filled by anyone through the ZETAPHY
// Swap router). In-memory EVM with the DEX's committed artifacts; then end to end on rpcchain with real signed
// transactions, the hub's own signing and payload code (zetaphy-hub/offline-core.js) and scripts/offline-deploy.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Wallet, TypedDataEncoder, Signature, keccak256, solidityPacked, Interface, toBeHex } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { tokenKitArtifacts } from './helpers/hyperlanekit.js';
import { dexArt } from './helpers/mocks.js';
import { Address } from '@ethereumjs/util';

const HOUR = 3600, DAY = 86400;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const ZERO = '0x' + '00'.repeat(20);

let kitCache = null;
function offlineKit() {
  if (kitCache) return kitCache;
  const input = { language: 'Solidity', sources: { 'OfflineKit.sol': { content: readFileSync(new URL('./helpers/OfflineKit.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts['OfflineKit.sol']).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]));
  return kitCache;
}

const signerKey = new Wallet(keccak256(solidityPacked(['string'], ['offline test signer'])));
const otherKey = new Wallet(keccak256(solidityPacked(['string'], ['offline test other'])));
const makerKey = new Wallet(keccak256(solidityPacked(['string'], ['offline test maker'])));

const chequeDomain = (contract, chainId = 1) => ({ name: 'ZETAPHY Cheques', version: '1', chainId, verifyingContract: contract });
const CHEQUE = { Cheque: [{ name: 'channelId', type: 'uint256' }, { name: 'cumulativeAmount', type: 'uint256' }] };
const signCheque = (key, contract, id, cum, chainId = 1) => key.signingKey.sign(TypedDataEncoder.hash(chequeDomain(contract, chainId), CHEQUE, { channelId: id, cumulativeAmount: cum })).serialized;
/** The same signature with s -> n - s and v flipped: valid for plain ecrecover, refused by the contracts. */
function malleate(sig) {
  const s = Signature.from(sig);
  const hi = N - BigInt(s.s);
  return s.r + toBeHex(hi, 32).slice(2) + (s.v === 27 ? '1c' : '1b');
}

async function chequeWorld() {
  const c = await createChain(['payer', 'payee', 'carol']);
  const a = (n) => c.acct[n].toString();
  const ch = await c.deploy('ZetaphyCheques', [], 'payer');
  return { c: withBal(c), a, ch };
}
/** balance() of a name or a 0x address. */
const withBal = (c) => { const b = c.balance; c.balance = (x) => b(typeof x === 'string' && x.startsWith('0x') ? Address.fromString(x) : x); return c; };
const opened = (ev) => ev.find((e) => e?.name === 'ChannelOpened').args.id;

test('cheques: open native, cash the best cheque (anyone submits, the payee is paid), replay and older cheques pay nothing', async () => {
  const { c, a, ch } = await chequeWorld();
  const expiry = BigInt(Number(c.now()) + 7 * DAY);
  const ev = await ch.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, expiry, signerKey.address], 10n * ZETA);
  const id = opened(ev);
  assert.equal(id, 1n);
  const [payer, exp, closeAt, payee, token, signer, deposit, paid, done] = await ch.call('channels', [id]);
  assert.deepEqual([payer.toLowerCase(), exp, closeAt, payee.toLowerCase(), token, signer, deposit, paid, done],
    [a('payer').toLowerCase(), expiry, 0n, a('payee').toLowerCase(), ZERO, signerKey.address, 10n * ZETA, 0n, false]);
  // the contract's digest is the EIP-712 one wallets and the hub compute
  assert.equal(await ch.call('chequeDigest', [id, 3n * ZETA]), TypedDataEncoder.hash(chequeDomain(ch.address), CHEQUE, { channelId: id, cumulativeAmount: 3n * ZETA }));

  const s1 = signCheque(signerKey, ch.address, id, 1n * ZETA);
  const s3 = signCheque(signerKey, ch.address, id, 3n * ZETA);
  const before = await c.balance('payee');
  const evc = await ch.send('carol', 'cash', [id, 3n * ZETA, s3]); // carol submits, the payee gets the money
  const cashed = evc.find((e) => e?.name === 'Cashed');
  assert.equal(cashed.args.amount, 3n * ZETA);
  assert.equal(cashed.args.submitter.toLowerCase(), a('carol').toLowerCase());
  assert.equal(await c.balance('payee') - before, 3n * ZETA);
  await assert.rejects(ch.send('payee', 'cash', [id, 3n * ZETA, s3]), /NothingToCash/, 'the same cheque again');
  await assert.rejects(ch.send('payee', 'cash', [id, 1n * ZETA, s1]), /NothingToCash/, 'an older, smaller cheque');
  assert.equal(await ch.call('cashable', [id, 5n * ZETA]), 2n * ZETA);
  await ch.send('payee', 'cash', [id, 5n * ZETA, signCheque(signerKey, ch.address, id, 5n * ZETA)]);
  assert.equal(await c.balance('payee') - before, 5n * ZETA, 'the difference only');
  assert.equal(await c.balance(ch.address), 5n * ZETA);
});

test('cheques: wrong signer, high-s, bad v, another channel, another contract: all refused', async () => {
  const { c, a, ch } = await chequeWorld();
  const exp = BigInt(Number(c.now()) + DAY);
  const id = opened(await ch.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, exp, signerKey.address], 10n * ZETA));
  const id2 = opened(await ch.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, exp, signerKey.address], 10n * ZETA));
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, signCheque(otherKey, ch.address, id, ZETA)]), /BadSignature/, 'the payer\'s other key');
  const good = signCheque(signerKey, ch.address, id, ZETA);
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, malleate(good)]), /BadSignature/, 'high s');
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, good.slice(0, -2) + '1d']), /BadSignature/, 'v = 29');
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, good.slice(0, -2)]), /BadSignature/, '64 bytes');
  await assert.rejects(ch.send('payee', 'cash', [id2, ZETA, good]), /BadSignature/, 'a cheque of channel 1 on channel 2');
  await assert.rejects(ch.send('payee', 'cash', [id, 2n * ZETA, good]), /BadSignature/, 'amount changed');
  const ch2 = await c.deploy('ZetaphyCheques', [], 'payer');
  await ch2.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, exp, signerKey.address], 10n * ZETA);
  await assert.rejects(ch2.send('payee', 'cash', [1n, ZETA, good]), /BadSignature/, 'the domain binds the contract');
  await assert.rejects(ch.send('payee', 'cash', [id, ZETA, signCheque(signerKey, ch.address, id, ZETA, 77390)]), /BadSignature/, 'and the chain id');
  await assert.rejects(ch.send('payee', 'cash', [9n, ZETA, good]), /BadChannel/);
  // v as 0/1 is accepted (some signers give that)
  const v01 = good.slice(0, -2) + (good.endsWith('1b') ? '00' : '01');
  await ch.send('carol', 'cash', [id, ZETA, v01]);
});

test('cheques: a cheque above the deposit pays the deposit; a top-up lets the same cheque pay the rest', async () => {
  const { c, a, ch } = await chequeWorld();
  const id = opened(await ch.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, BigInt(Number(c.now()) + DAY), signerKey.address], 10n * ZETA));
  const s15 = signCheque(signerKey, ch.address, id, 15n * ZETA);
  const before = await c.balance('payee');
  await ch.send('payee', 'cash', [id, 15n * ZETA, s15]);
  assert.equal(await c.balance('payee') - before, 10n * ZETA, 'never more than the deposit');
  await assert.rejects(ch.send('payee', 'cash', [id, 15n * ZETA, s15]), /NothingToCash/);
  await assert.rejects(ch.send('carol', 'topUp', [id, ZETA], ZETA), /NotPayer/);
  await assert.rejects(ch.send('payer', 'topUp', [id, ZETA], 2n), /BadValue/);
  await ch.send('payer', 'topUp', [id, 10n * ZETA], 10n * ZETA);
  await ch.send('payee', 'cash', [id, 15n * ZETA, s15]);
  assert.equal(await c.balance('payee') - before, 15n * ZETA);
});

test('cheques: expiry, the 24 h challenge window, withdraw of the remainder, release, extend', async () => {
  const { c, a, ch } = await chequeWorld();
  const exp = BigInt(Number(c.now()) + DAY);
  const id = opened(await ch.send('payer', 'open', [a('payee'), ZERO, 10n * ZETA, exp, signerKey.address], 10n * ZETA));
  await assert.rejects(ch.send('payer', 'startClose', [id]), /NotExpired/);
  await assert.rejects(ch.send('payer', 'withdraw', [id]), /NotClosing/);
  await assert.rejects(ch.send('payee', 'startClose', [id]), /NotPayer/);
  await assert.rejects(ch.send('payer', 'extend', [id, exp]), /BadExpiry/, 'only later');
  await ch.send('payer', 'extend', [id, exp + BigInt(HOUR)]);
  c.advance(DAY + HOUR);
  const ev = await ch.send('payer', 'startClose', [id]);
  assert.equal(ev.find((e) => e?.name === 'CloseStarted').args.closeAt, c.now() + 86400n);
  await assert.rejects(ch.send('payer', 'startClose', [id]), /Closing/);
  await assert.rejects(ch.send('payer', 'topUp', [id, ZETA], ZETA), /Closing/);
  await assert.rejects(ch.send('payer', 'withdraw', [id]), /ChallengeOpen/);
  c.advance(23 * HOUR); // still inside the window: the payee can cash
  await ch.send('payee', 'cash', [id, 4n * ZETA, signCheque(signerKey, ch.address, id, 4n * ZETA)]);
  c.advance(HOUR);
  await assert.rejects(ch.send('payee', 'cash', [id, 6n * ZETA, signCheque(signerKey, ch.address, id, 6n * ZETA)]), /ChannelDone/, 'too late');
  const before = await c.balance('payer');
  const w = await ch.send('payer', 'withdraw', [id]);
  assert.equal(w.find((e) => e?.name === 'Withdrawn').args.amount, 6n * ZETA);
  assert.equal(await c.balance('payer') - before, 6n * ZETA);
  await assert.rejects(ch.send('payer', 'withdraw', [id]), /ChannelDone/);
  assert.equal(await c.balance(ch.address), 0n);

  // release: the payee cashes and lets the payer take the rest before expiry
  const id2 = opened(await ch.send('payer', 'open', [a('payee'), ZERO, 3n * ZETA, BigInt(Number(c.now()) + 30 * DAY), signerKey.address], 3n * ZETA));
  await ch.send('payee', 'cash', [id2, ZETA, signCheque(signerKey, ch.address, id2, ZETA)]);
  await assert.rejects(ch.send('payer', 'release', [id2]), /NotPayee/);
  await ch.send('payee', 'release', [id2]);
  await ch.send('payer', 'withdraw', [id2]);
  assert.equal(await c.balance(ch.address), 0n);
});

test('cheques: opening checks (payee, signer, amount, value, expiry range)', async () => {
  const { c, a, ch } = await chequeWorld();
  const exp = BigInt(Number(c.now()) + DAY);
  await assert.rejects(ch.send('payer', 'open', [ZERO, ZERO, ZETA, exp, signerKey.address], ZETA), /BadChannel/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), ZERO, ZETA, exp, ZERO], ZETA), /BadChannel/);
  await assert.rejects(ch.send('payer', 'open', [a('payer'), ZERO, ZETA, exp, signerKey.address], ZETA), /BadChannel/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), ZERO, 0n, exp, signerKey.address], 0n), /BadAmount/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), ZERO, ZETA, exp, signerKey.address], ZETA - 1n), /BadValue/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), ZERO, ZETA, c.now(), signerKey.address], ZETA), /BadExpiry/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), ZERO, ZETA, c.now() + BigInt(400 * DAY), signerKey.address], ZETA), /BadExpiry/);
});

test('cheques: ERC-20 channels; fee-on-transfer and no-code tokens refused; a re-entering token and payee get nowhere', async () => {
  const { c, a, ch } = await chequeWorld();
  const kit = tokenKitArtifacts();
  const tok = await c.deployRaw(kit.KitToken, ['T', 'T', 18], 'payer');
  const fee = await c.deployRaw(kit.KitFeeToken, [], 'payer');
  const hook = await c.deployRaw(kit.KitHookToken, [], 'payer');
  for (const t of [tok, fee, hook]) { await t.send('payer', 'mint', [a('payer'), 1000n * ZETA]); await t.send('payer', 'approve', [ch.address, 10n ** 30n]); }
  const exp = BigInt(Number(c.now()) + DAY);

  const id = opened(await ch.send('payer', 'open', [a('payee'), tok.address, 100n * ZETA, exp, signerKey.address]));
  await assert.rejects(ch.send('payer', 'topUp', [id, ZETA], 1n), /BadValue/, 'no coins with a token');
  await ch.send('carol', 'cash', [id, 40n * ZETA, signCheque(signerKey, ch.address, id, 40n * ZETA)]);
  assert.equal(await tok.call('balanceOf', [a('payee')]), 40n * ZETA);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), fee.address, 100n * ZETA, exp, signerKey.address]), /FeeOnTransfer/);
  await assert.rejects(ch.send('payer', 'open', [a('payee'), a('carol'), 100n * ZETA, exp, signerKey.address]), /TokenFailed/);

  // the token's transfer hook tries to cash again (and to withdraw) while the payee is being paid
  const hid = opened(await ch.send('payer', 'open', [a('payee'), hook.address, 100n * ZETA, exp, signerKey.address]));
  const s50 = signCheque(signerKey, ch.address, hid, 50n * ZETA);
  await hook.send('payer', 'arm', [ch.address, ch.iface.encodeFunctionData('cash', [hid, 50n * ZETA, s50])]);
  await ch.send('payee', 'cash', [hid, 20n * ZETA, signCheque(signerKey, ch.address, hid, 20n * ZETA)]);
  assert.equal(await hook.call('reentered'), false, 'the re-entry reverted (nonReentrant)');
  assert.equal(await hook.call('balanceOf', [a('payee')]), 20n * ZETA);

  // a payee contract re-entering from receive() during a native payout
  const re = await c.deployRaw(offlineKit().KitReenterer, [], 'payer');
  const nid = opened(await ch.send('payer', 'open', [re.address, ZERO, 10n * ZETA, exp, signerKey.address], 10n * ZETA));
  const s2 = signCheque(signerKey, ch.address, nid, 2n * ZETA), s9 = signCheque(signerKey, ch.address, nid, 9n * ZETA);
  await re.send('payer', 'arm', [ch.address, ch.iface.encodeFunctionData('cash', [nid, 9n * ZETA, s9])]);
  await ch.send('carol', 'cash', [nid, 2n * ZETA, s2]);
  assert.equal(await re.call('tried'), true);
  assert.equal(await re.call('reentered'), false);
  assert.equal(await c.balance(re.address), 2n * ZETA);
});

// ---------------------------------------------------------------- offline swap orders

const ORDER = { Order: [
  { name: 'maker', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'relayerFee', type: 'uint256' }] };
const orderDomain = (contract, chainId = 1) => ({ name: 'ZETAPHY Offline Orders', version: '1', chainId, verifyingContract: contract });
const signOrder = (key, contract, o) => key.signingKey.sign(TypedDataEncoder.hash(orderDomain(contract), ORDER, o)).serialized;
const tuple = (o) => [o.maker, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.deadline, o.nonce, o.relayerFee];

async function dexWorld() {
  const c = withBal(await createChain(['lp', 'relayer', 'carol'], { maker: makerKey.address }));
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
  const ox = await c.deploy('ZetaphyOfflineOrders', [router.address], 'lp');
  await A.send('lp', 'transfer', [a('maker'), 1000n * ZETA]);
  await A.send('maker', 'approve', [ox.address, 10n ** 30n]);
  const order = (over = {}) => ({ maker: makerKey.address, tokenIn: A.address, tokenOut: B.address, amountIn: 100n * ZETA, minAmountOut: 95n * ZETA,
    deadline: c.now() + BigInt(HOUR), nonce: 7n, relayerFee: ZETA, ...over });
  return { c, a, wz, router, A, B, ox, order };
}

test('orders: a relayer fills a signed order; the maker gets at least its minimum, the relayer the fee; no replay', async () => {
  const { a, B, A, ox, order, wz, router } = await dexWorld();
  assert.equal((await ox.call('wrapped')).toLowerCase(), wz.address.toLowerCase(), 'the router\'s wrapped coin');
  assert.equal((await ox.call('router')).toLowerCase(), router.address.toLowerCase());
  const o = order();
  const sig = signOrder(makerKey, ox.address, o);
  assert.equal(await ox.call('digest', [tuple(o)]), TypedDataEncoder.hash(orderDomain(ox.address), ORDER, o));
  const ev = await ox.send('relayer', 'fill', [tuple(o), sig, []]);
  const f = ev.find((e) => e?.name === 'OrderFilled');
  assert.equal(f.args.relayer.toLowerCase(), a('relayer').toLowerCase());
  const got = await B.call('balanceOf', [a('maker')]);
  assert.equal(got, f.args.amountOut);
  assert.ok(got >= 95n * ZETA && got < 99n * ZETA, `maker got ${got}`);
  assert.equal(await B.call('balanceOf', [a('relayer')]), ZETA, 'the fee');
  assert.equal(await A.call('balanceOf', [a('maker')]), 900n * ZETA, 'exactly amountIn');
  for (const t of [A, B]) assert.equal(await t.call('balanceOf', [ox.address]), 0n, 'nothing stays in the contract');
  assert.equal(await ox.call('isNonceUsed', [a('maker'), 7n]), true);
  await assert.rejects(ox.send('carol', 'fill', [tuple(o), sig, []]), /NonceUsed/, 'replay');
  // a route the relayer picks: through WZETAPHY
  const o2 = order({ nonce: 8n, minAmountOut: 90n * ZETA });
  await assert.rejects(ox.send('relayer', 'fill', [tuple(o2), signOrder(makerKey, ox.address, o2), [B.address, A.address]]), /BadPath/);
});

test('orders: wrong signer, tampered order, cancel, deadline, minimum out, bad orders', async () => {
  const { c, a, ox, order, A } = await dexWorld();
  const o = order();
  await assert.rejects(ox.send('relayer', 'fill', [tuple(o), signOrder(otherKey, ox.address, o), []]), /BadSignature/);
  const sig = signOrder(makerKey, ox.address, o);
  await assert.rejects(ox.send('relayer', 'fill', [tuple({ ...o, relayerFee: 5n * ZETA }), sig, []]), /BadSignature/, 'a bigger fee');
  await assert.rejects(ox.send('relayer', 'fill', [tuple(o), malleate(sig), []]), /BadSignature/, 'high s');
  // the maker cancels from its wallet
  await ox.send('maker', 'cancel', [7n]);
  await assert.rejects(ox.send('relayer', 'fill', [tuple(o), sig, []]), /NonceUsed/);
  await ox.send('maker', 'cancelWord', [1n, (1n << 3n) | (1n << 4n)]); // nonces 259, 260
  for (const n of [259n, 260n]) {
    const x = order({ nonce: n });
    await assert.rejects(ox.send('relayer', 'fill', [tuple(x), signOrder(makerKey, ox.address, x), []]), /NonceUsed/);
  }
  const x261 = order({ nonce: 261n });
  await ox.send('relayer', 'fill', [tuple(x261), signOrder(makerKey, ox.address, x261), []]);
  // the deadline
  const late = order({ nonce: 9n });
  const lsig = signOrder(makerKey, ox.address, late);
  c.advance(HOUR + 1);
  await assert.rejects(ox.send('relayer', 'fill', [tuple(late), lsig, []]), /Expired/);
  // the minimum: the router refuses (minAmountOut + fee is the router's amountOutMin); nothing moved
  const greedy = order({ nonce: 10n, minAmountOut: 99n * ZETA, deadline: c.now() + BigInt(HOUR) });
  const before = await A.call('balanceOf', [a('maker')]);
  await assert.rejects(ox.send('relayer', 'fill', [tuple(greedy), signOrder(makerKey, ox.address, greedy), []]));
  assert.equal(await A.call('balanceOf', [a('maker')]), before);
  assert.equal(await ox.call('isNonceUsed', [a('maker'), 10n]), false, 'a failed fill leaves the nonce');
  // bad orders
  for (const bad of [order({ nonce: 11n, amountIn: 0n, deadline: c.now() + 60n }), order({ nonce: 12n, tokenOut: A.address, deadline: c.now() + 60n }), order({ nonce: 13n, tokenIn: ZERO, deadline: c.now() + 60n })]) {
    await assert.rejects(ox.send('relayer', 'fill', [tuple(bad), signOrder(makerKey, ox.address, bad), []]), /BadOrder/);
  }
});

test('orders: native ZETAPHY out (unwrapped), sell WZETAPHY in, a permit instead of an approve', async () => {
  const { c, a, wz, router, A, ox, order } = await dexWorld();
  const o = order({ tokenOut: ZERO, minAmountOut: 90n * ZETA, relayerFee: 2n * ZETA });
  const mBefore = await c.balance(makerKey.address), rBefore = await c.balance('relayer');
  await ox.send('relayer', 'fill', [tuple(o), signOrder(makerKey, ox.address, o), []]);
  const mGot = await c.balance(makerKey.address) - mBefore;
  assert.ok(mGot >= 90n * ZETA, `maker got ${mGot} native`);
  assert.equal(await c.balance('relayer') - rBefore, 2n * ZETA);
  assert.equal(await c.balance(ox.address), 0n);
  // WZETAPHY in (the maker wrapped and approved online before)
  await wz.send('maker', 'deposit', [], 50n * ZETA);
  await wz.send('maker', 'approve', [ox.address, 50n * ZETA]);
  const w = order({ tokenIn: wz.address, tokenOut: A.address, amountIn: 50n * ZETA, minAmountOut: 45n * ZETA, nonce: 20n });
  await ox.send('relayer', 'fill', [tuple(w), signOrder(makerKey, ox.address, w), [wz.address, A.address]]);
  assert.ok(await A.call('balanceOf', [a('maker')]) >= 900n * ZETA + 45n * ZETA);
  // permit: a token with EIP-2612, no approve transaction at all
  const P = await c.deployRaw(offlineKit().KitPermitToken, [], 'lp');
  await P.send('lp', 'mint', [a('lp'), 200_000n * ZETA]);
  await P.send('lp', 'mint', [a('maker'), 100n * ZETA]);
  await P.send('lp', 'approve', [router.address, 10n ** 30n]);
  await router.send('lp', 'addLiquidity', [P.address, A.address, 100_000n * ZETA, 100_000n * ZETA, 0n, 0n, a('lp'), c.now() + 1000n]);
  const po = order({ tokenIn: P.address, tokenOut: A.address, amountIn: 100n * ZETA, minAmountOut: 90n * ZETA, nonce: 21n });
  const pd = { name: 'Permit', version: '1', chainId: 1, verifyingContract: P.address };
  const PERMIT = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
  const ps = Signature.from(makerKey.signingKey.sign(TypedDataEncoder.hash(pd, PERMIT, { owner: makerKey.address, spender: ox.address, value: 100n * ZETA, nonce: 0n, deadline: po.deadline })).serialized);
  await assert.rejects(ox.send('relayer', 'fill', [tuple(po), signOrder(makerKey, ox.address, po), []]), 'no allowance yet');
  await ox.send('relayer', 'fillWithPermit', [tuple(po), signOrder(makerKey, ox.address, po), [], [100n * ZETA, po.deadline, ps.v, ps.r, ps.s]]);
  assert.equal(await P.call('balanceOf', [a('maker')]), 0n);
});

test('orders: fee-on-transfer tokens refused; a re-entering token cannot fill twice', async () => {
  const { c, a, router, A, ox, order } = await dexWorld();
  const F = await c.deployRaw(dexArt('TestToken'), ['Fee', 'F', 18, 10n ** 27n, 100], 'lp');
  await F.send('lp', 'transfer', [a('maker'), 1000n * ZETA]);
  await F.send('maker', 'approve', [ox.address, 10n ** 30n]);
  const fo = order({ tokenIn: F.address, tokenOut: A.address, nonce: 30n });
  await assert.rejects(ox.send('relayer', 'fill', [tuple(fo), signOrder(makerKey, ox.address, fo), []]), /FeeOnTransfer/);

  const hook = await c.deployRaw(tokenKitArtifacts().KitHookToken, [], 'lp');
  await hook.send('lp', 'mint', [a('lp'), 200_000n * ZETA]);
  await hook.send('lp', 'mint', [a('maker'), 1000n * ZETA]);
  await hook.send('lp', 'approve', [router.address, 10n ** 30n]);
  await router.send('lp', 'addLiquidity', [hook.address, A.address, 100_000n * ZETA, 100_000n * ZETA, 0n, 0n, a('lp'), c.now() + 1000n]);
  await hook.send('maker', 'approve', [ox.address, 10n ** 30n]);
  const h1 = order({ tokenIn: hook.address, tokenOut: A.address, nonce: 31n, minAmountOut: 90n * ZETA });
  const h2 = order({ tokenIn: hook.address, tokenOut: A.address, nonce: 32n, minAmountOut: 90n * ZETA });
  await hook.send('lp', 'arm', [ox.address, ox.iface.encodeFunctionData('fill', [tuple(h2), signOrder(makerKey, ox.address, h2), []])]);
  await ox.send('relayer', 'fill', [tuple(h1), signOrder(makerKey, ox.address, h1), []]);
  assert.equal(await hook.call('reentered'), false);
  assert.equal(await ox.call('isNonceUsed', [a('maker'), 32n]), false);
  assert.equal(await hook.call('balanceOf', [a('maker')]), 900n * ZETA, 'one fill only');
});

// ---------------------------------------------------------------- end to end: rpcchain, real signed txs, the hub's code
import { ContractFactory, Contract, parseEther } from 'ethers';
import { createRpcChain } from './helpers/rpcchain.js';
import { deployOffline } from '../src/offlinedeploy.js';
import * as core from '../../zetaphy-hub/offline-core.js';

test('end to end: deploy both (no owner), a channel, cheques signed and checked by the hub code, cashed; an offline order relayed', async () => {
  const { secp256k1, keccak_256 } = await import('../../zetaphy-wallet/vendor/pqwallet.js');
  const c = await createRpcChain({ accounts: 4 });
  const [lp, payer, payee, relayer] = c.signers;
  const dex = async (n, args) => { const k = await new ContractFactory(dexArt(n).abi, dexArt(n).bytecode, lp).deploy(...args); await k.waitForDeployment(); return k; };
  const wz = await dex('WZETAPHY', []);
  const factory = await dex('ZetaphyFactory', [lp.address]);
  const router = await dex('ZetaphyRouter', [await factory.getAddress(), await wz.getAddress()]);
  const rec = await deployOffline({ signer: lp, router: await router.getAddress() });
  assert.equal(rec.chainId, 77390);
  const chq = new Contract(rec.contracts.zetaphyCheques, JSON.parse(readFileSync(new URL('../artifacts/ZetaphyCheques.json', import.meta.url))).abi, c.provider);
  for (const k of Object.values(rec.contracts)) {
    const abi = new Interface(JSON.parse(readFileSync(new URL(`../artifacts/${k === rec.contracts.zetaphyCheques ? 'ZetaphyCheques' : 'ZetaphyOfflineOrders'}.json`, import.meta.url))).abi);
    for (const f of ['owner', 'governance', 'transferOwnership', 'setRouter', 'pause']) assert.equal(abi.getFunction(f), null, `no ${f}`);
  }

  // the hub's offline key (encrypted at rest, WebCrypto) signs; the payer opens online with the hub's calldata
  const { sk, address: offlineSigner } = core.newKey(secp256k1, keccak_256);
  const blob = await core.encryptKey({}, sk, 'correct horse battery', offlineSigner, core.MIN_KDF_ITERATIONS);
  const now = Number(c.now());
  const openData = core.encodeOpen(payee.address, core.NATIVE, parseEther('5'), now + 7 * DAY, offlineSigner);
  const rc = await (await payer.sendTransaction({ to: rec.contracts.zetaphyCheques, data: openData, value: parseEther('5') })).wait();
  const id = core.channelIdFromReceipt(rc, rec.contracts.zetaphyCheques);
  assert.equal(id, '1');
  const snap = { ...core.decodeChannel(await c.provider.call({ to: rec.contracts.zetaphyCheques, data: core.encodeChannel(id) })), syncedAt: now };
  assert.equal(snap.signer, offlineSigner.toLowerCase());
  assert.equal(snap.deposit, parseEther('5').toString());

  // offline: unlock, sign 1.5 then 2 ZETAPHY; the payee checks each with no network
  const key = await core.decryptKey({}, blob, 'correct horse battery');
  const cheque = (cum) => {
    const d = core.chequeDigest(keccak_256, { contract: rec.contracts.zetaphyCheques, channelId: id, cumulative: cum });
    return core.encodeCheque({ contract: rec.contracts.zetaphyCheques, channelId: id, cumulative: cum, sig: core.signDigest(secp256k1, d, key) });
  };
  const t1 = cheque(parseEther('1.5')), t2 = cheque(parseEther('2'));
  const opts = { snapshot: snap, keccak: keccak_256, secp: secp256k1, contract: rec.contracts.zetaphyCheques, chainId: 77390, now, me: payee.address };
  const v1 = core.verifyCheque(core.decodeCheque(t1), opts);
  assert.ok(v1.ok, JSON.stringify(v1.problems));
  const v2 = core.verifyCheque(core.decodeCheque(t2), { ...opts, lastSeen: parseEther('1.5') });
  assert.ok(v2.ok);
  assert.equal(v2.newAmount, parseEther('0.5'));
  assert.ok(!core.verifyCheque(core.decodeCheque(t1), { ...opts, lastSeen: parseEther('2') }).ok, 'an older cheque');
  // online again: the payee cashes the best one with the hub's calldata
  const best = core.decodeCheque(t2);
  const before = await c.provider.getBalance(payee.address);
  await (await payee.sendTransaction({ to: rec.contracts.zetaphyCheques, data: core.encodeCash(best.channelId, best.cumulative, best.sig) })).wait();
  assert.equal(await c.provider.getBalance(payee.address) - before, parseEther('2'));
  assert.equal((await chq.channels(1n)).paid, parseEther('2'));

  // an offline order: the maker (the offline key's address holds A and approved) signs, the relayer fills
  const A = await dex('TestToken', ['Alpha', 'A', 18, parseEther('1000000'), 0]);
  await (await A.approve(await router.getAddress(), parseEther('1000000'))).wait();
  await (await router.addLiquidityETH(await A.getAddress(), parseEther('10000'), 0n, 0n, lp.address, now + DAY, { value: parseEther('10000') })).wait();
  const maker = new Wallet(bytesHex(key), c.provider);
  await c.fund(maker.address, parseEther('1'));
  await (await A.transfer(maker.address, parseEther('100'))).wait();
  await (await A.connect(maker).approve(rec.contracts.offlineOrders, parseEther('100'))).wait();
  const order = { maker: maker.address, tokenIn: await A.getAddress(), tokenOut: core.NATIVE, amountIn: parseEther('10').toString(), minAmountOut: parseEther('9.5').toString(),
    deadline: String(Number(c.now()) + HOUR), nonce: core.newNonce(), relayerFee: parseEther('0.1').toString() };
  const osig = core.signDigest(secp256k1, core.orderDigest(keccak_256, { contract: rec.contracts.offlineOrders, order }), key);
  const text = core.encodeOrder({ contract: rec.contracts.offlineOrders, order, sig: osig });
  const got = core.decodeOrder(text);
  assert.ok(core.verifyOrder(got, { keccak: keccak_256, secp: secp256k1, contract: rec.contracts.offlineOrders, now: Number(c.now()) }).ok);
  const data = core.encodeFill(got.order, got.sig, []);
  const sim = await c.provider.call({ from: relayer.address, to: rec.contracts.offlineOrders, data }); // the relayer's eth_call preview
  assert.ok(BigInt(sim) >= parseEther('9.5'));
  const mb = await c.provider.getBalance(maker.address), rb = await c.provider.getBalance(relayer.address);
  const frc = await (await relayer.sendTransaction({ to: rec.contracts.offlineOrders, data })).wait();
  assert.equal(frc.status, 1);
  assert.ok(await c.provider.getBalance(maker.address) - mb >= parseEther('9.5'));
  assert.equal(await c.provider.getBalance(relayer.address) - rb, parseEther('0.1'), 'fee (gas price is 0 here)');
  await assert.rejects(c.provider.call({ from: relayer.address, to: rec.contracts.offlineOrders, data }), 'the same order again');
  assert.equal(await c.provider.call({ to: rec.contracts.offlineOrders, data: core.encodeIsNonceUsed(maker.address, order.nonce) }), '0x' + '0'.repeat(63) + '1');
});
const bytesHex = (b) => '0x' + Buffer.from(b).toString('hex');
