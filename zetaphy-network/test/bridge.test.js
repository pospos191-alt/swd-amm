import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String, Interface } from 'ethers';
import { readFileSync } from 'node:fs';
import { createChain } from './helpers/evm.js';

const USDC = 10n ** 6n;
const NOBLE = encodeBytes32String('ibc/noble');
const HYP = encodeBytes32String('hyperlane/base');
const tokenIface = new Interface(JSON.parse(readFileSync(new URL('../artifacts/BridgedToken.json', import.meta.url), 'utf8')).abi);

let c, guard, token;
const a = (n) => c.acct[n].toString();
beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'ibcAdapter', 'hypAdapter', 'alice', 'attacker']);
  guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await guard.send('gov', 'createToken', ['USD Coin (bridged)', 'USDC', 6]);
  token = await guard.call('token');
  await guard.send('gov', 'setRoute', [NOBLE, a('ibcAdapter'), 1000n * USDC, true]);
  await guard.send('gov', 'setRoute', [HYP, a('hypAdapter'), 100n * USDC, true]);
  await guard.send('gov', 'setGuardian', [a('guardian'), true]);
});
const bal = (who) => c.callAt(token, tokenIface, 'balanceOf', [a(who)]);

test('only the route adapter can bring tokens in, within its daily limit', async () => {
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 600n * USDC]);
  assert.equal(await bal('alice'), 600n * USDC);
  await assert.rejects(guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 401n * USDC]), /OverLimit/);
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 400n * USDC]);
  await assert.rejects(guard.send('attacker', 'inbound', [NOBLE, a('attacker'), 1n]), /NotAdapter/);
  await assert.rejects(guard.send('hypAdapter', 'inbound', [NOBLE, a('attacker'), 1n]), /NotAdapter/);
  await assert.rejects(c.sendTo('attacker', token, tokenIface, 'mint', [a('attacker'), 1n])); // only the guard mints
});

test('limits are per route and reset each day', async () => {
  await guard.send('hypAdapter', 'inbound', [HYP, a('alice'), 100n * USDC]);
  await assert.rejects(guard.send('hypAdapter', 'inbound', [HYP, a('alice'), 1n]), /OverLimit/);
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 500n * USDC]); // other route unaffected
  c.advance(86400);
  await guard.send('hypAdapter', 'inbound', [HYP, a('alice'), 100n * USDC]);
  const [inLeft] = await guard.call('remaining', [HYP]);
  assert.equal(inLeft, 0n);
});

test('outbound burns, with its own daily limit', async () => {
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 1000n * USDC]);
  await guard.send('hypAdapter', 'outbound', [HYP, a('alice'), 100n * USDC]);
  await assert.rejects(guard.send('hypAdapter', 'outbound', [HYP, a('alice'), 1n]), /OverLimit/);
  assert.equal(await bal('alice'), 900n * USDC);
});

test('a guardian can stop the bridges but not restart them; governance restarts', async () => {
  await guard.send('guardian', 'pause');
  await assert.rejects(guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 1n]), /BridgePaused/);
  await assert.rejects(guard.send('guardian', 'unpause'), /NotGovernance/);
  await assert.rejects(guard.send('attacker', 'pause'), /NotGuardian/);
  await guard.send('gov', 'unpause');
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 1n]);
});

test('a disabled route and settings changes by outsiders are refused', async () => {
  await guard.send('gov', 'setRoute', [HYP, a('hypAdapter'), 100n * USDC, false]);
  await assert.rejects(guard.send('hypAdapter', 'inbound', [HYP, a('alice'), 1n]), /NotAdapter/);
  await assert.rejects(guard.send('attacker', 'setRoute', [HYP, a('attacker'), 10n ** 30n, true]), /NotGovernance/);
  await assert.rejects(guard.send('guardian', 'setGuardian', [a('attacker'), true]), /NotGovernance/);
  await assert.rejects(guard.send('gov', 'createToken', ['x', 'x', 6]));
});
