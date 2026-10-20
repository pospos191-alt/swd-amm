// RewardVault: 10% of the remaining pool per year, no withdraw, recipients
// changed only after a public delay.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';

const DAY = 86400;
const POOL = 100_000n * ZETA;
let c, jobs, vault;
const addr = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['gov', 'anyone', 'validators', 'other']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  vault = await c.deploy('RewardVault', [addr('gov'), [
    { to: jobs.address, bps: 7000, callFund: true },
    { to: addr('validators'), bps: 3000, callFund: false },
  ]], 'gov');
  await vault.sendValue('gov', POOL);
});

const near = (a, b, tol) => assert.ok((a > b ? a - b : b - a) <= tol, `${a} vs ${b}`);

test('releases nothing on day 0, then 10% of the remaining pool per year', async () => {
  assert.equal(await vault.call('releasable'), 0n);
  c.advance(DAY);
  const day1 = await vault.call('releasable');
  near(day1, POOL * 288617n / 1_000_000_000n, ZETA); // 1 - 0.9^(1/365) = 0.0288617%
  c.advance(364 * DAY);
  await vault.send('anyone', 'release');
  near(await c.balance(Address.fromString(vault.address)), POOL * 9n / 10n, 10n ** 9n); // exactly 10% after a year
  c.advance(365 * DAY);
  await vault.send('anyone', 'release');
  near(await c.balance(Address.fromString(vault.address)), POOL * 81n / 100n, 10n ** 9n); // 0.9^2
  assert.equal(await vault.call('releasable'), 0n, 'calling twice the same day pays nothing more');
});

test('splits by share; NeuroJobs is paid through fund()', async () => {
  c.advance(365 * DAY);
  const ev = await vault.send('anyone', 'release');
  const released = ev.find((e) => e?.name === 'Released').args.amount;
  near(await jobs.call('rewardPool'), released * 7n / 10n, 1n);
  near(await c.balance('validators'), 1_000_000n * ZETA + released * 3n / 10n, 1n);
});

test('there is no way to take the pool out faster', async () => {
  const fns = vault.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name).sort();
  assert.deepEqual(fns, ['DAILY_KEEP', 'DELAY', 'MAX_SHARES', 'applyShares', 'cancelShares', 'daysElapsed', 'governance', 'pendingAt', 'pendingShares', 'proposeShares', 'releasable', 'release', 'releasedDays', 'setGovernance', 'shares', 'start']);
  await assert.rejects(vault.send('anyone', 'proposeShares', [[{ to: addr('anyone'), bps: 10000, callFund: false }]]), /NotGovernance/);
});

test('new recipients apply only after the 7-day delay; vested amounts go to the old ones', async () => {
  await vault.send('gov', 'proposeShares', [[{ to: addr('other'), bps: 10000, callFund: false }]]);
  await assert.rejects(vault.send('anyone', 'applyShares'), /TooEarly/);
  c.advance(7 * DAY);
  const before = await c.balance('other');
  await vault.send('anyone', 'applyShares');
  assert.equal(await c.balance('other'), before, 'the 7 vested days went to the old recipients');
  assert.ok((await jobs.call('rewardPool')) > 0n);
  c.advance(DAY);
  await vault.send('anyone', 'release');
  assert.ok((await c.balance('other')) > before);
});

test('bad share lists are refused', async () => {
  const bad = [
    [],
    [{ to: addr('other'), bps: 9999, callFund: false }],
    [{ to: '0x0000000000000000000000000000000000000000', bps: 10000, callFund: false }],
    [{ to: addr('other'), bps: 0, callFund: false }, { to: addr('anyone'), bps: 10000, callFund: false }],
  ];
  for (const s of bad) await assert.rejects(vault.send('gov', 'proposeShares', [s]), /BadShares/);
});

test('a recipient that refuses payment cannot block the others; its part stays vesting', async () => {
  const refuse = await c.deploy('RefusingRecipient', [], 'gov');
  const v = await c.deploy('RewardVault', [addr('gov'), [
    { to: refuse.address, bps: 5000, callFund: false },
    { to: addr('validators'), bps: 5000, callFund: false },
  ]], 'gov');
  await v.sendValue('gov', POOL);
  c.advance(30 * DAY);
  const ev = await v.send('anyone', 'release');
  const released = ev.find((e) => e?.name === 'Released').args.amount;
  assert.ok(ev.some((e) => e?.name === 'Paid' && e.args.ok === false));
  near(await c.balance(Address.fromString(v.address)), POOL - released / 2n, 1n);
});

test('a recipient re-entering during payment cannot double-apply or double-pay', async () => {
  const evil = await c.deploy('ReentrantRecipient', [], 'gov');
  const v = await c.deploy('RewardVault', [addr('gov'), [{ to: evil.address, bps: 10000, callFund: false }]], 'gov');
  await evil.send('gov', 'setVault', [v.address]);
  await v.sendValue('gov', POOL);
  await v.send('gov', 'proposeShares', [[{ to: addr('other'), bps: 10000, callFund: false }]]);
  c.advance(8 * DAY);
  const ev = await v.send('anyone', 'applyShares');
  assert.equal(ev.filter((e) => e?.name === 'Released').length, 1);
  assert.ok((await evil.call('attempts')) >= 1n);
  const shares = await v.call('shares');
  assert.equal(shares.length, 1);
  assert.equal(shares[0].to, addr('other'), 'the announced recipients, applied once');
});
