import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes32String, Interface, keccak256 } from 'ethers';
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

// ---- vaccine: no coins to, or out of, a flagged contract; adapters are governance's choice, not the runners' ----
// Runner records stand-in: workers(any) -> (0, 0, active, agreed 1, rejected 0), so any account may vote here.
const RUNNERS = '0x' + 'a7'.repeat(20);
async function vaccinated() {
  await c.putCode(RUNNERS, '0x6001604052600160605260a06000f3');
  const reg = await c.deploy('ThreatRegistry', [RUNNERS, 2, 1, a('gov'), 0], 'gov');
  await guard.send('gov', 'setThreats', [reg.address]);
  const flag = async (key, on = true) => { for (const v of ['alice', 'guardian']) await reg.send(v, 'vote', [key, on, on ? 1 : 0]); };
  // A contract with no immutables stands in for a drainer (code hash = keccak256 of its artifact's runtime code).
  const drainer = await c.deploy('LockBox', [], 'attacker');
  const h = keccak256(JSON.parse(readFileSync(new URL('../artifacts/LockBox.json', import.meta.url), 'utf8')).deployedBytecode);
  return { reg, flag, drainer: drainer.address, codeKey: await reg.call('codeKey', [h]) };
}

test('vaccine: coins are refused to and from a contract whose code is flagged, until the flag is cleared', async () => {
  const { flag, drainer, codeKey } = await vaccinated();
  await guard.send('ibcAdapter', 'inbound', [NOBLE, drainer, 50n * USDC]); // before the flag
  await flag(codeKey);
  await assert.rejects(guard.send('ibcAdapter', 'inbound', [NOBLE, drainer, 1n]), /FlaggedContract/);
  await assert.rejects(guard.send('hypAdapter', 'outbound', [HYP, drainer, 1n]), /FlaggedContract/); // stolen coins cannot leave
  await guard.send('ibcAdapter', 'inbound', [NOBLE, a('alice'), 1n]); // everyone else is unaffected
  // The refused message is not lost: the adapter retries it after the flag is cleared.
  await flag(codeKey, false);
  await guard.send('ibcAdapter', 'inbound', [NOBLE, drainer, 1n]);
  assert.equal(await c.callAt(token, tokenIface, 'balanceOf', [drainer]), 50n * USDC + 1n);
});

test('vaccine: an adapter cannot be blocked by a runner flag (code hash or address); only governance sets the registry', async () => {
  const { reg, flag, codeKey, drainer } = await vaccinated();
  await assert.rejects(guard.send('attacker', 'setThreats', [reg.address]), /NotGovernance/);
  // The adapter is a contract (as BridgeAirlock is); runners flag its code hash and its address.
  const ADAPTER_CODE = '0x6000';
  await c.putCode(a('hypAdapter'), ADAPTER_CODE);
  await flag(await reg.call('codeKey', [keccak256(ADAPTER_CODE)]));
  await flag(await reg.call('addressKey', [1n, a('hypAdapter')])); // the test chain's id is 1
  assert.equal((await reg.call('isContractEnforced', [a('hypAdapter')]))[0], true);
  await guard.send('hypAdapter', 'inbound', [HYP, a('alice'), 1n]); // the route keeps working
  await guard.send('hypAdapter', 'outbound', [HYP, a('alice'), 1n]);
  await flag(codeKey); // a flagged recipient is still refused on that route
  await assert.rejects(guard.send('hypAdapter', 'inbound', [HYP, drainer, 1n]), /FlaggedContract/);
  await guard.send('gov', 'setThreats', ['0x' + '00'.repeat(20)]); // zero: no check
  await guard.send('hypAdapter', 'inbound', [HYP, drainer, 1n]);
});

test('vaccine: BridgeGuard refuses only once the flag is enforced (enforceDelay)', async () => {
  const { reg, flag, drainer, codeKey } = await vaccinated();
  await reg.send('gov', 'setEnforceDelay', [3600]);
  await flag(codeKey);
  await guard.send('ibcAdapter', 'inbound', [NOBLE, drainer, 1n]); // warned, not enforced yet
  c.advance(3600);
  await assert.rejects(guard.send('ibcAdapter', 'inbound', [NOBLE, drainer, 1n]), /FlaggedContract/);
});
