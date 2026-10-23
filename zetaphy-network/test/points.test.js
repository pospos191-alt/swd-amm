// BZTPHY (contracts/ZetaphyPoints.sol) and the award math (src/points.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { validatorAwards, consAddress, commitSigners, minuteHeights, runnerAwards, mergeAwards, fitCap, proRata, balancesFromTransfers, operatorEvm, epochOf } from '../src/points.js';
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
const valoper = (n) => toBech32(Buffer.alloc(20, n), 'zetaphyvaloper');
const val = (n, moniker, extra = {}) => ({ operator_address: valoper(n), consensus_pubkey: pk(n), jailed: false, status: 'BOND_STATUS_BONDED', description: { moniker }, ...extra });

test('validators: paid by the minute they signed; joining or leaving mid-day earns that share; no minimum', () => {
  const vals = [val(1, 'zetaphy-validator-0'), val(2, 'alice'), val(3, 'late'), val(4, 'left', { status: 'BOND_STATUS_UNBONDED' }), val(5, 'never')];
  const A = (n) => consAddress(vals[n - 1]);
  // 1,440 checked minutes: alice and the founding node all day, late from noon, left until 06:00
  const minutes = Array.from({ length: 1440 }, (_, m) => new Set([A(1), A(2), ...(m >= 720 ? [A(3)] : []), ...(m < 360 ? [A(4)] : [])]));
  const r = validatorAwards(vals, minutes);
  assert.deepEqual(r.map((x) => [x.to, x.amount]), [
    [operatorEvm(valoper(2)), 100n * ZETA],
    [operatorEvm(valoper(3)), 50n * ZETA],
    [operatorEvm(valoper(4)), 25n * ZETA],
  ]);
  assert.match(r[1].why, /late 720\/1440 min/);
  // one minute is worth 100/1440 BZTPHY: no 50 % threshold any more
  const one = validatorAwards([vals[1]], [new Set([A(2)]), ...Array(1439).fill(new Set())]);
  assert.equal(one[0].amount, (100n * ZETA) / 1440n);
  assert.equal(validatorAwards(vals, minutes, { excludeAddresses: [operatorEvm(valoper(2))] }).length, 2);
});

test('minute sampling: 1,440 heights spread over the day; only real commit signatures count', () => {
  const h = minuteHeights(1000, 18279);
  assert.equal(h.length, 1440);
  assert.equal(h[0], 1000);
  assert.ok(h[1439] <= 18279 && h[1439] > 18260);
  assert.ok(h.every((x, i) => i === 0 || x > h[i - 1]));
  const s = commitSigners([{ block_id_flag: 2, validator_address: 'ab01' }, { block_id_flag: 1, validator_address: '' }, { block_id_flag: 3, validator_address: 'CD02' }]);
  assert.deepEqual([...s], ['AB01']);
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
