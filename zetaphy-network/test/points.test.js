// BZTPHY (contracts/ZetaphyPoints.sol) and the award math (src/points.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeBytes32String } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { validatorAwards, runnerAwards, mergeAwards, fitCap, proRata, balancesFromTransfers, operatorEvm, epochOf } from '../src/points.js';
import { toBech32 } from '../src/pqtx.js';

let c, p;
const a = (n) => c.acct[n].toString();
const R = encodeBytes32String('validator');
beforeEach(async () => {
  c = await createChain(['gov', 'minter', 'alice', 'bob', 'thief']);
  p = await c.deploy('ZetaphyPoints', [a('gov'), a('minter'), 1000n * ZETA], 'gov');
});

test('looks like a token to wallets: name, symbol, decimals, balance, Transfer from 0x0', async () => {
  assert.equal(await p.call('symbol'), 'BZTPHY');
  assert.equal(await p.call('decimals'), 18n);
  const logs = await p.send('minter', 'award', [20000, [a('alice'), a('bob')], [100n * ZETA, 50n * ZETA], R]);
  assert.equal(await p.call('balanceOf', [a('alice')]), 100n * ZETA);
  assert.equal(await p.call('totalSupply'), 150n * ZETA);
  const t = logs.filter((l) => l?.name === 'Transfer');
  assert.equal(t.length, 2);
  assert.equal(t[0].args.from, '0x0000000000000000000000000000000000000000');
});

test('cannot be transferred, approved or sold', async () => {
  await p.send('minter', 'award', [1, [a('alice')], [10n * ZETA], R]);
  await assert.rejects(p.send('alice', 'transfer', [a('bob'), 1n]), /NonTransferable/);
  await assert.rejects(p.send('alice', 'approve', [a('bob'), 1n]), /NonTransferable/);
  await assert.rejects(p.send('bob', 'transferFrom', [a('alice'), a('bob'), 1n]), /NonTransferable/);
  assert.equal(await p.call('allowance', [a('alice'), a('bob')]), 0n);
});

test('only the minter awards; once per address per epoch; never above the epoch cap', async () => {
  await assert.rejects(p.send('thief', 'award', [1, [a('thief')], [1n], R]), /NotMinter/);
  await p.send('minter', 'award', [1, [a('alice')], [600n * ZETA], R]);
  await assert.rejects(p.send('minter', 'award', [1, [a('alice')], [1n], R]), /AlreadyAwarded/);
  await assert.rejects(p.send('minter', 'award', [1, [a('bob')], [401n * ZETA], R]), /OverEpochCap/);
  await p.send('minter', 'award', [1, [a('bob')], [400n * ZETA], R]);
  await p.send('minter', 'award', [2, [a('alice')], [1n * ZETA], R]); // the next day is new
  assert.equal(await p.call('totalSupply'), 1001n * ZETA);
  await assert.rejects(p.send('minter', 'award', [3, [a('alice')], [1n, 2n], R]), /LengthMismatch/);
});

test('the owner revokes cheaters, changes minter and cap, and freezes for the mainnet snapshot', async () => {
  await p.send('minter', 'award', [1, [a('alice'), a('thief')], [10n * ZETA, 90n * ZETA], R]);
  await assert.rejects(p.send('minter', 'revoke', [a('thief'), 1n, R]), /NotOwner/);
  await p.send('gov', 'revoke', [a('thief'), 1000n * ZETA, encodeBytes32String('sybil')]);
  assert.equal(await p.call('balanceOf', [a('thief')]), 0n);
  assert.equal(await p.call('totalSupply'), 10n * ZETA);
  await p.send('gov', 'setEpochCap', [5n * ZETA]);
  await assert.rejects(p.send('minter', 'award', [2, [a('bob')], [6n * ZETA], R]), /OverEpochCap/);
  await p.send('gov', 'setMinter', [a('bob')]);
  await assert.rejects(p.send('minter', 'award', [2, [a('bob')], [1n], R]), /NotMinter/);
  await p.send('gov', 'freeze', []);
  assert.equal(await p.call('frozen'), true);
  await assert.rejects(p.send('bob', 'award', [3, [a('bob')], [1n], R]), /IsFrozen|NotMinter/);
  await assert.rejects(p.send('gov', 'revoke', [a('alice'), 1n, R]), /IsFrozen/);
  assert.equal(await p.call('balanceOf', [a('alice')]), 10n * ZETA);
});

test('ownership moves in two steps', async () => {
  await assert.rejects(p.send('thief', 'transferOwnership', [a('thief')]), /NotOwner/);
  await p.send('gov', 'transferOwnership', [a('alice')]);
  await assert.rejects(p.send('thief', 'acceptOwnership', []), /NotOwner/);
  await p.send('alice', 'acceptOwnership', []);
  assert.equal((await p.call('owner')).toLowerCase(), a('alice').toLowerCase());
});

// ---- award math -------------------------------------------------------------------------
const pk = (seed) => ({ '@type': '/cosmos.crypto.ed25519.PubKey', key: Buffer.alloc(32, seed).toString('base64') });
const valcons = (seed) => toBech32(createHash('sha256').update(Buffer.alloc(32, seed)).digest().subarray(0, 20), 'zetaphyvalcons');
const valoper = (n) => toBech32(Buffer.alloc(20, n), 'zetaphyvaloper');
const val = (n, moniker, extra = {}) => ({ operator_address: valoper(n), consensus_pubkey: pk(n), jailed: false, status: 'BOND_STATUS_BONDED', description: { moniker }, ...extra });

test('validators: 100 BZTPHY a day x uptime; jailed, low uptime and the founding node get nothing', () => {
  const vals = [val(1, 'zetaphy-validator-0'), val(2, 'alice'), val(3, 'bob'), val(4, 'jailed', { jailed: true }), val(5, 'offline'), val(6, 'new')];
  const infos = [1, 2, 3, 4, 5].map((n) => ({ address: valcons(n), missed_blocks_counter: { 1: '0', 2: '0', 3: '25', 4: '0', 5: '60' }[n] }));
  const r = validatorAwards(vals, infos, '100');
  assert.deepEqual(r.map((x) => [x.to, x.amount]), [
    [operatorEvm(valoper(2)), 100n * ZETA],
    [operatorEvm(valoper(3)), 75n * ZETA],
  ]);
  assert.equal(operatorEvm(valoper(2)).toLowerCase(), '0x' + '02'.repeat(20));
  assert.match(r[1].why, /bob uptime 75\.00%/);
  assert.equal(validatorAwards(vals, infos, '100', { excludeAddresses: [operatorEvm(valoper(2))] }).length, 1);
});

test('runners: 2 per revealed job, at most 50 a day; awards merge to one per address', () => {
  const w1 = '0x' + 'aa'.repeat(20), w2 = '0x' + 'bb'.repeat(20);
  const reveals = [...Array(3).fill({ worker: w1 }), ...Array(40).fill({ worker: w2 })];
  const r = runnerAwards(reveals);
  assert.equal(r.find((x) => x.to.toLowerCase() === w1).amount, 6n * ZETA);
  assert.equal(r.find((x) => x.to.toLowerCase() === w2).amount, 50n * ZETA);
  const m = mergeAwards([{ to: w1.toUpperCase().replace('0X', '0x'), amount: 100n * ZETA, why: 'validator' }], r);
  assert.equal(m.length, 2);
  assert.equal(m.find((x) => x.to.toLowerCase() === w1).amount, 106n * ZETA);
});

test('mainnet conversion is pro rata of a fixed pool, from Transfer events', () => {
  const z = '0x0000000000000000000000000000000000000000';
  const b = balancesFromTransfers([
    { from: z, to: 'A', value: 300n }, { from: z, to: 'B', value: 100n }, { from: z, to: 'C', value: 50n }, { from: 'C', to: z, value: 50n },
  ]);
  const out = proRata(b, 10_000_000n * ZETA);
  assert.deepEqual(out.map((x) => [x.to, x.zetaphy]), [['A', 7_500_000n * ZETA], ['B', 2_500_000n * ZETA]]);
  assert.equal(epochOf(86400 * 20000 + 5), 20000);
});

test('more earned than the daily cap: everyone shrinks by the same share, never above the cap', () => {
  const v = (i, n) => ({ to: `0x${String(i).padStart(40, '0')}`, amount: n * ZETA, why: 'validator' });
  const day = Array.from({ length: 60 }, (_, i) => v(i + 1, 100n)); // 60 validators at 100%: 6,000 > 5,000
  const fit = fitCap(day, 5000n * ZETA);
  assert.equal(fit.length, 60);
  assert.ok(fit.reduce((s, a) => s + a.amount, 0n) <= 5000n * ZETA);
  assert.equal(fit[0].amount, (100n * ZETA * 5000n) / 6000n); // 83.33 each
  assert.deepEqual(fitCap(day.slice(0, 50), 5000n * ZETA), day.slice(0, 50)); // fits: unchanged
  assert.deepEqual(fitCap(day, 0n), []);
});
