// Saphan PR 6, item H: a ZETAPHY -> Sepolia transfer signed offline (EIP-712, a ZSPH1: text / QR payload), relayed by
// anyone later through SaphanOfflineTransfers into the route's outbox, then released on the source chain as any
// transfer. src/saphanoffline.js signs, encodes and checks the payload with no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, getAddress, Signature } from 'ethers';
import { Address } from '@ethereumjs/util';
import { routeWorld, bridgeIn, relayOut, lastReleaseId, E, DELAY, CHAIN } from './helpers/saphanroutekit.js';
import { signTransfer, encodePayload, decodePayload, verifyPayload, digestOf, relayArgs, PREFIX } from '../src/saphanoffline.js';

const holder = new Wallet('0x' + '5a'.repeat(32));
const TOKEN = new Interface(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
let r, off;

beforeEach(async () => {
  r = await routeWorld(['bob', 'anyone'], { fund: { holder: holder.address } });
  off = await r.c.deploy('SaphanOfflineTransfers', [], 'gov');
  await bridgeIn(r, 'holder', 3n * E);                                  // holder has 3 sepETH on ZETAPHY
  await r.c.sendTo('holder', r.token, TOKEN, 'approve', [off.address, 10n * E]); // online once
});

const xfer = (o = {}) => ({ from: holder.address, outbox: r.outbox.address, to: r.a('bob'), amount: E, relayerFee: E / 100n, nonce: 7n,
  deadline: r.c.now() + 86400n, ...o });
async function payload(o = {}) {
  const transfer = xfer(o);
  const sig = await signTransfer({ chainId: CHAIN, contract: off.address, transfer, key: holder });
  return encodePayload({ chainId: CHAIN, contract: off.address, transfer, sig });
}
const bal = (who) => r.c.callAt(r.token, TOKEN, 'balanceOf', [who]);

test('signed offline, relayed later by anyone: token burned on ZETAPHY, ETH released on the source after the delay; relayer paid', async () => {
  const text = await payload();
  assert.ok(text.startsWith(PREFIX) && text.length < 1000, 'fits a QR code');
  const p = decodePayload(text);
  assert.equal(p.transfer.amount, E);
  assert.equal(await off.call('digest', [relayArgs(p)[0]]), digestOf(p), 'the JS digest is the contract\'s');
  assert.deepEqual(verifyPayload(p, { knownOutboxes: [r.outbox.address], now: Number(r.c.now()) }).problems, []);
  const fee = await off.call('quote', [relayArgs(p)[0]]);
  const supply = await r.c.callAt(r.token, new Interface(['function totalSupply() view returns (uint256)']), 'totalSupply', []);
  const eth = await r.c.balance('anyone');
  await off.send('anyone', 'relay', relayArgs(p), fee + 123n);          // extra Mailbox fee comes back
  assert.equal(eth - (await r.c.balance('anyone')), fee, 'the relayer paid exactly the quote (no gas price in this EVM)');
  assert.equal(await bal(holder.address), 3n * E - E - E / 100n);
  assert.equal(await bal(r.a('anyone')), E / 100n);
  assert.equal(await bal(off.address), 0n, 'nothing kept');
  assert.equal(await r.c.callAt(r.token, new Interface(['function totalSupply() view returns (uint256)']), 'totalSupply', []), supply - E, 'burned');
  assert.equal(await r.c.balance(Address.fromString(off.address)), 0n);
  await assert.rejects(off.send('anyone', 'relay', relayArgs(p), fee), /NonceUsed/);
  // the source chain: the release reaches bob after the lockbox's delay
  await relayOut(r);
  const id = await lastReleaseId(r);
  r.c.advance(DELAY);
  const before = await r.c.balance('bob');
  await r.lockbox.send('anyone', 'claim', [id]);
  assert.equal((await r.c.balance('bob')) - before, E);
});

test('the relayer cannot change anything signed; expired, cancelled or wrongly signed transfers are refused', async () => {
  const p = decodePayload(await payload());
  const [t, sig] = relayArgs(p);
  const fee = await off.call('quote', [t]);
  for (const [i, v] of [[2, r.a('anyone')], [3, 2n * E], [4, E], [1, r.a('anyone')]]) {
    const bad = [...t]; bad[i] = v;
    await assert.rejects(off.send('anyone', 'relay', [bad, sig], fee), /BadSignature|BadTransfer/);
  }
  const hi = Signature.from(sig);
  const highS = (0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n - BigInt(hi.s)).toString(16).padStart(64, '0');
  const flipped = hi.r + highS + (hi.v === 27 ? '1c' : '1b');
  await assert.rejects(off.send('anyone', 'relay', [t, flipped], fee), /BadSignature/, 'high-s twin refused');
  const other = new Wallet('0x' + '6b'.repeat(32));
  const forged = Signature.from(await other.signTypedData({ name: 'ZETAPHY Saphan Offline', version: '1', chainId: CHAIN, verifyingContract: off.address },
    { Transfer: [{ name: 'from', type: 'address' }, { name: 'outbox', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'relayerFee', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, p.transfer)).serialized;
  await assert.rejects(off.send('anyone', 'relay', [t, forged], fee), /BadSignature/);
  // expired
  const late = decodePayload(await payload({ nonce: 8n, deadline: r.c.now() - 1n }));
  assert.deepEqual(verifyPayload(late, { now: Number(r.c.now()) }).problems, ['expired']);
  await assert.rejects(off.send('anyone', 'relay', relayArgs(late), fee), /Expired/);
  // cancelled before anyone relays it (the holder is online again)
  await off.send('holder', 'cancel', [7n]);
  await assert.rejects(off.send('anyone', 'relay', [t, sig], fee), /NonceUsed/);
  // an unknown route is flagged offline; a non-contract outbox is refused on chain
  const odd = decodePayload(await payload({ nonce: 9n, outbox: r.a('bob') }));
  assert.ok(verifyPayload(odd, { knownOutboxes: [r.outbox.address] }).problems.includes('unknown-route'));
  await assert.rejects(off.send('anyone', 'relay', relayArgs(odd), fee), /BadTransfer/);
});

test('payload format: strict decoding, other key refused when signing, guard limits still apply', async () => {
  assert.throws(() => decodePayload('ZORD1:abc'), /format/);
  assert.throws(() => decodePayload(PREFIX + '!!'), /format/);
  assert.throws(() => decodePayload(PREFIX + Buffer.from('{"c":1}').toString('base64url')), /format/);
  await assert.rejects(signTransfer({ chainId: CHAIN, contract: off.address, transfer: xfer(), key: new Wallet('0x' + '01'.repeat(32)) }), /not transfer.from/);
  // above the guard's outbound limit (100/day here, but only 3 held): the whole relay reverts, the nonce stays usable
  const big = decodePayload(await payload({ nonce: 11n, amount: 5n * E }));
  const fee = await off.call('quote', [relayArgs(big)[0]]);
  await assert.rejects(off.send('anyone', 'relay', relayArgs(big), fee));
  assert.equal(await off.call('isNonceUsed', [holder.address, 11n]), false);
  assert.equal(getAddress(decodePayload(await payload()).transfer.to), getAddress(r.a('bob')));
});
