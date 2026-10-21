import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String } from 'ethers';
import { createChain } from './helpers/evm.js';

let c, ms, guard;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['deployer', 'o1', 'o2', 'o3', 'thief']);
  ms = await c.deploy('SimpleMultisig', [[a('o1'), a('o2'), a('o3')], 2], 'deployer');
  guard = await c.deploy('BridgeGuard', [a('deployer')], 'deployer');
  await guard.send('deployer', 'createToken', ['USD Coin (bridged)', 'USDC', 6]); // the hard cap: 1,000 USDC
  await guard.send('deployer', 'setGovernance', [ms.address]); // hand-off: the deployer key no longer matters
});
const setRoute = (limit) => guard.iface.encodeFunctionData('setRoute', [encodeBytes32String('r'), a('o1'), limit, false]);

test('after the hand-off, one key can no longer change bridge settings', async () => {
  await assert.rejects(guard.send('deployer', 'setRoute', [encodeBytes32String('r'), a('thief'), 10n ** 30n, true]), /NotGovernance/);
  await ms.send('o1', 'propose', [guard.address, 0, setRoute(100n)]);
  await assert.rejects(ms.send('o1', 'execute', [0]), /NotEnough/);
  await ms.send('o2', 'confirm', [0]);
  await ms.send('o3', 'execute', [0]);
  assert.equal((await guard.call('routes', [encodeBytes32String('r')])).dailyLimit, 100n);
  await assert.rejects(ms.send('o1', 'execute', [0]), /Done/);
});

test('outsiders cannot propose or confirm; owners cannot confirm twice; a revoke counts down', async () => {
  await assert.rejects(ms.send('thief', 'propose', [guard.address, 0, setRoute(1n)]), /NotOwner/);
  await ms.send('o1', 'propose', [guard.address, 0, setRoute(1n)]);
  await assert.rejects(ms.send('o1', 'confirm', [0]), /Twice/);
  await assert.rejects(ms.send('thief', 'confirm', [0]), /NotOwner/);
  await ms.send('o1', 'revoke', [0]);
  await ms.send('o2', 'confirm', [0]);
  await assert.rejects(ms.send('o2', 'execute', [0]), /NotEnough/);
});

test('owners change only through the multisig itself; bad configs are refused', async () => {
  await assert.rejects(ms.send('o1', 'setOwners', [[a('thief')], 1]), /NotOwner/);
  const data = ms.iface.encodeFunctionData('setOwners', [[a('o1'), a('o2')], 2]);
  await ms.send('o1', 'propose', [ms.address, 0, data]);
  await ms.send('o3', 'confirm', [0]);
  await ms.send('o2', 'execute', [0]);
  assert.equal(await ms.call('isOwner', [a('o3')]), false);
  assert.equal(await ms.call('ownerCount'), 2n);
  await assert.rejects(c.deploy('SimpleMultisig', [[a('o1')], 1], 'deployer'));          // threshold 1
  await assert.rejects(c.deploy('SimpleMultisig', [[a('o1'), a('o1')], 2], 'deployer')); // duplicate owner
});
