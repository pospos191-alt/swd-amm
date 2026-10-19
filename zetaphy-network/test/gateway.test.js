import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Signature, encodeBytes32String } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const USDC = 10n ** 6n;
const BOND = 100n * ZETA, MIN_FEE = ZETA / 10n;
const PRICE = USDC / 100n; // 1 ZETAPHY = 0.01 tUSDC on testnet
const CHAIN = encodeBytes32String('bsc');
const TARGET = '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f';
const alice = Wallet.createRandom();

let c, jobs, usdc, gw;
beforeEach(async () => {
  c = await createChain(['owner', 'relayer', 'w1'], { alice: alice.address });
  jobs = await c.deploy('NeuroJobs', [BOND, ZETA, MIN_FEE, 120, 600, 3600], 'owner');
  usdc = await c.deploy('TestStable', ['Test USDC', 'tUSDC'], 'owner');
  gw = await c.deploy('StableGateway', [jobs.address], 'owner');
  await gw.send('owner', 'setPrice', [usdc.address, PRICE]);
  await gw.sendValue('owner', 100n * ZETA); // ZETAPHY reserve
  await usdc.send('alice', 'faucet');
});

const domain = () => ({ name: 'ZETAPHY StableGateway', version: '1', chainId: 1, verifyingContract: gw.address });
const types = { JobRequest: [
  { name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'chain', type: 'bytes32' }, { name: 'target', type: 'string' },
  { name: 'fee', type: 'uint256' }, { name: 'tip', type: 'uint256' }, { name: 'maxCost', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };

async function signed(over = {}) {
  const q = { user: alice.address, token: usdc.address, chain: CHAIN, target: TARGET, fee: ZETA, tip: USDC / 10n, maxCost: USDC, nonce: 0n, deadline: c.now() + 600n, ...over };
  return { q, sig: await alice.signTypedData(domain(), types, q) };
}
async function permitFor(value) {
  const sig = Signature.from(await alice.signTypedData(
    { name: 'Test USDC', version: '1', chainId: 1, verifyingContract: usdc.address },
    { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { owner: alice.address, spender: gw.address, value, nonce: await usdc.call('nonces', [alice.address]), deadline: c.now() + 600n }));
  return { value, deadline: c.now() + 600n, v: sig.v, r: sig.r, s: sig.s };
}
const asTuple = (q) => [q.user, q.token, q.chain, q.target, q.fee, q.tip, q.maxCost, q.nonce, q.deadline];

test('faucet gives 1,000 test USDC once a day', async () => {
  assert.equal(await usdc.call('balanceOf', [alice.address]), 1000n * USDC);
  await assert.rejects(usdc.send('alice', 'faucet'));
  c.advance(86400);
  await usdc.send('alice', 'faucet');
  assert.equal(await usdc.call('balanceOf', [alice.address]), 2000n * USDC);
});

test('a user with no ZETAPHY gets a Neuro job, paying only test USDC, with no transaction of their own', async () => {
  const { q, sig } = await signed();
  const p = await permitFor(q.maxCost);
  const ev = await gw.send('relayer', 'requestWithPermit', [asTuple(q), sig, [p.value, p.deadline, p.v, p.r, p.s]]);
  assert.ok(ev.some((e) => e?.name === 'Paid'));
  const cost = ZETA * PRICE / ZETA; // 0.01 USDC for a 1 ZETAPHY fee
  assert.equal(await usdc.call('balanceOf', [alice.address]), 1000n * USDC - cost - q.tip);
  assert.equal(await usdc.call('balanceOf', [c.acct.relayer.toString()]), q.tip);
  assert.equal(await usdc.call('balanceOf', [gw.address]), cost);
  const job = await jobs.call('getJob', [0]);
  assert.equal(job.requester, alice.address); // refunds go to the user
  assert.equal(job.fee, ZETA);
  assert.equal(job.target, TARGET);
});

test('replays, expired, tampered and over-budget requests are refused', async () => {
  await usdc.send('alice', 'approve', [gw.address, 10n ** 30n]);
  const { q, sig } = await signed();
  await gw.send('relayer', 'request', [asTuple(q), sig]);
  await assert.rejects(gw.send('relayer', 'request', [asTuple(q), sig]), /BadNonce/);

  const s2 = await signed({ nonce: 1n, deadline: c.now() - 1n });
  await assert.rejects(gw.send('relayer', 'request', [asTuple(s2.q), s2.sig]), /Expired/);

  const s3 = await signed({ nonce: 1n });
  await assert.rejects(gw.send('relayer', 'request', [asTuple({ ...s3.q, target: '0x' + 'ab'.repeat(20) }), s3.sig]), /BadSignature/);
  await assert.rejects(gw.send('relayer', 'request', [asTuple({ ...s3.q, tip: USDC / 5n }), s3.sig]), /BadSignature/);

  const s4 = await signed({ nonce: 1n, tip: USDC, maxCost: USDC });
  await assert.rejects(gw.send('relayer', 'request', [asTuple(s4.q), s4.sig]), /TooExpensive/);
});

test('unknown tokens and an empty reserve are refused; only the owner sets prices', async () => {
  await usdc.send('alice', 'approve', [gw.address, 10n ** 30n]);
  const other = await c.deploy('TestStable', ['Other', 'OTH'], 'owner');
  const s1 = await signed({ token: other.address });
  await assert.rejects(gw.send('relayer', 'request', [asTuple(s1.q), s1.sig]), /NotAccepted/);
  const s2 = await signed({ fee: 101n * ZETA, maxCost: 10n * USDC });
  await assert.rejects(gw.send('relayer', 'request', [asTuple(s2.q), s2.sig]), /ReserveLow/);
  await assert.rejects(gw.send('relayer', 'setPrice', [usdc.address, 1]), /NotOwner/);
});

test('quote rounds up so the gateway never sells ZETAPHY below its price', async () => {
  assert.equal(await gw.call('quote', [usdc.address, 1n]), 1n);
  assert.equal(await gw.call('quote', [usdc.address, ZETA]), PRICE);
});

test('permit rejects a wrong signer and an expired deadline', async () => {
  const p = await permitFor(5n);
  await assert.rejects(usdc.send('owner', 'permit', [c.acct.owner.toString(), gw.address, 5n, p.deadline, p.v, p.r, p.s]));
  c.advance(601);
  await assert.rejects(usdc.send('owner', 'permit', [alice.address, gw.address, 5n, p.deadline, p.v, p.r, p.s]));
});
