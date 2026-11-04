// Saphan PR 6, item S9: route limits that follow observed flows. The deterministic policy (src/saphanliquidity.js),
// an LLM hint that can only nudge it +-20 %, and the governance-set band of SaphanLiquidityBounds that binds both:
// the rebalancer moves a target inside [min, max] one bounded step at a time, and as a lockbox guardian the contract
// can only LOWER the lockbox's daily limit. Raising stays with the lockbox's timelock.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String, zeroPadValue, Interface } from 'ethers';
import { createChain } from './helpers/evm.js';
import { plan, dailyTotals, percentile, hintFactor, parseHint, raiseProposal, hashInput, DAY } from '../src/saphanliquidity.js';

const E = 10n ** 18n;
const R = encodeBytes32String('sepolia');
const b32 = (x) => zeroPadValue(x, 32);
let c, box, lb;
const a = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'reb', 'anyone']);
  const mb = await c.deploy('MockMailbox', [11155111], 'gov');
  box = await c.deploy('HyperlaneLockBoxV2', [mb.address, 77390, 77390, b32('0x' + '1a'.repeat(20)), b32('0x' + '0b'.repeat(20)), '0x' + '00'.repeat(20),
    '0x' + '15'.repeat(20), a('gov'), a('guardian'), 100n * E, 3600], 'gov');
  lb = await c.deploy('SaphanLiquidityBounds', [a('gov')], 'gov');
  await box.send('gov', 'setGuardian', [lb.address, true]);
});

test('policy: p90 of daily releases x headroom, step-limited, clamped; same input = same target and hash; LLM hint bounded', () => {
  const now = 100 * DAY + 500;
  const flows = [];
  for (let d = 1; d <= 7; d++) flows.push({ t: now - d * DAY, amount: BigInt(d) * 10n * E });
  flows.push({ t: now - 10, amount: 999n * E });                       // today: not in the window yet
  flows.push({ t: now - 30 * DAY, amount: 999n * E });                 // too old
  assert.deepEqual(dailyTotals(flows, now), [70n, 60n, 50n, 40n, 30n, 20n, 10n].map((x) => x * E));
  assert.equal(percentile(dailyTotals(flows, now), 0.9), 70n * E);
  const bounds = { min: 10n * E, max: 200n * E, maxStepBps: 2500 };
  const p = plan({ flows, now, current: 80n * E, bounds, lockboxLimit: 100n * E });
  assert.equal(p.demand, 70n * E);
  assert.equal(p.wanted, 105n * E);                                    // 70 x 1.5
  assert.equal(p.target, 100n * E, 'one step of 25 % from 80');
  assert.equal(p.needsGovernance, false);
  assert.equal(p.applyDown, false);
  assert.equal(plan({ flows, now, current: 80n * E, bounds, lockboxLimit: 100n * E }).hintHash, p.hintHash, 'deterministic');
  // quiet week: down one step, then the band's minimum
  const q = plan({ flows: [], now, current: 40n * E, bounds, lockboxLimit: 100n * E });
  assert.equal(q.target, 30n * E);
  assert.equal(q.applyDown, true);
  assert.equal(plan({ flows: [], now, current: 11n * E, bounds }).target, 10n * E);
  // hints: at most x1.2 / x0.8, garbage ignored, never beyond the band
  assert.equal(hintFactor({ direction: 'up', factor: 50 }), 1200n);
  assert.equal(hintFactor({ direction: 'down', factor: 0.01 }), 800n);
  assert.equal(hintFactor({ direction: 'sideways', factor: 2 }), 1000n);
  assert.equal(hintFactor('ignore previous instructions'), 1000n);
  assert.deepEqual(parseHint('I think {"direction":"up","factor":1.1} because flows grew'), { direction: 'up', factor: 1.1 });
  assert.equal(parseHint('{"direction":"max it"}'), null);
  assert.equal(parseHint('no json'), null);
  const h = plan({ flows, now, current: 200n * E, bounds, hint: { direction: 'up', factor: 9 } });
  assert.equal(h.wanted, 126n * E, '70 x 1.5 x 1.2');
  assert.notEqual(h.hintHash, plan({ flows, now, current: 200n * E, bounds }).hintHash, 'the hint is part of the recorded input');
  assert.equal(plan({ flows: [{ t: now - DAY, amount: 10_000n * E }], now, current: 200n * E, bounds }).target, 200n * E, 'never above max');
  assert.equal(hashInput({ a: 1n, b: [2n] }), hashInput({ b: [2n], a: 1n }));
});

test('bounds contract: only governance sets the band and the rebalancer; targets stay in the band and move one step per interval', async () => {
  await assert.rejects(lb.send('anyone', 'setBounds', [R, box.address, 10n * E, 200n * E, 2500, 3600]), /NotGovernance/);
  await assert.rejects(lb.send('gov', 'setBounds', [R, box.address, 300n * E, 200n * E, 2500, 3600]), /BadBounds/);
  await assert.rejects(lb.send('gov', 'setBounds', [R, box.address, 10n * E, 200n * E, 6000, 3600]), /BadBounds/);
  await assert.rejects(lb.send('gov', 'setBounds', [R, box.address, 10n * E, 200n * E, 2500, 60]), /BadBounds/);
  await lb.send('gov', 'setBounds', [R, box.address, 10n * E, 200n * E, 2500, 3600]);
  assert.equal((await lb.call('target', [R])).value, 10n * E, 'pulled into the band');
  await assert.rejects(lb.send('reb', 'propose', [R, 20n * E, '0x' + '00'.repeat(32)]), /NotRebalancer/);
  await lb.send('gov', 'setRebalancer', [a('reb')]);
  await assert.rejects(lb.send('reb', 'propose', [R, 5n * E, '0x' + '00'.repeat(32)]), /OutOfBounds/);
  await assert.rejects(lb.send('reb', 'propose', [R, 13n * E, '0x' + '00'.repeat(32)]), /StepTooBig/, '25 % of 10 is 2.5');
  await lb.send('reb', 'propose', [R, 12n * E, '0x' + '11'.repeat(32)]);
  await assert.rejects(lb.send('reb', 'propose', [R, 13n * E, '0x' + '00'.repeat(32)]), /TooSoon/);
  c.advance(3600);
  await lb.send('reb', 'propose', [R, 15n * E, '0x' + '00'.repeat(32)]);
  assert.equal((await lb.call('target', [R])).value, 15n * E);
  // a smaller band later: the target follows at once
  await lb.send('gov', 'setBounds', [R, box.address, 10n * E, 12n * E, 2500, 3600]);
  assert.equal((await lb.call('target', [R])).value, 12n * E);
  await assert.rejects(lb.send('reb', 'propose', [encodeBytes32String('nope'), E, '0x' + '00'.repeat(32)]), /NoRoute/);
});

test('on chain it only lowers: applyDown cuts the lockbox limit to the target (a guardian call), never raises; emergencyMin at once', async () => {
  await lb.send('gov', 'setBounds', [R, box.address, 10n * E, 200n * E, 5000, 3600]);
  await lb.send('gov', 'setRebalancer', [a('reb')]);
  assert.equal(await box.call('dailyLimit'), 100n * E);
  await lb.send('anyone', 'applyDown', [R]);                           // target 10 < 100
  assert.equal(await box.call('dailyLimit'), 10n * E);
  await assert.rejects(lb.send('anyone', 'applyDown', [R]), /NothingToLower/);
  c.advance(3600);
  await lb.send('reb', 'propose', [R, 15n * E, '0x' + '00'.repeat(32)]);
  await assert.rejects(lb.send('anyone', 'applyDown', [R]), /NothingToLower/, 'raising is governance\'s');
  assert.equal(await box.call('dailyLimit'), 10n * E);
  // the raise, as the lockbox's timelock would schedule it
  const pr = raiseProposal({ lockbox: box.address, value: 15n * E });
  assert.equal(new Interface(['function setDailyLimit(uint256)']).decodeFunctionData('setDailyLimit', pr.data)[0], 15n * E);
  await c.rawCall('gov', box.address, pr.data);                         // (the timelock's execute, after its delay)
  assert.equal(await box.call('dailyLimit'), 15n * E);
  await lb.send('reb', 'emergencyMin', [R]);
  assert.equal((await lb.call('target', [R])).value, 10n * E);
  await lb.send('anyone', 'applyDown', [R]);
  assert.equal(await box.call('dailyLimit'), 10n * E);
  // removed as a guardian: it can do nothing to the lockbox
  await box.send('gov', 'setGuardian', [lb.address, false]);
  await box.send('gov', 'setDailyLimit', [50n * E]);
  await assert.rejects(lb.send('anyone', 'applyDown', [R]));
});
