// InvariantFirewall + Firewalled (docs/future/invariant-firewall.md) on the in-memory EVM: invariants as
// post-conditions (a transaction that breaks one reverts, so a found bug cannot be used), fail-closed checks
// with gas caps, delayed removal and opt-out, the chain-layer registry (timelock-approved, budgeted), the
// certificate rule (an uncertified protocol holding value above a threshold pays out a capped share per day),
// attested invariant sets, the real AuditCertificate, and CircuitBreaker side by side.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, getCreateAddress, keccak256, ZeroAddress } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { firewallKit } from './helpers/firewallkit.js';
import { workMocks } from './helpers/workmocks.js';
import { policyTuple } from '../src/selfheal/loop.js';
import { k, core, codeHashOf } from '../src/auditnet.js';

const DAY = 86400;
const BPS = 1000; // 10% a day for an uncertified protocol
const NAME = (s) => keccak256(new TextEncoder().encode(s));
let c, kit, fw, certs, vault, solvency, A;
const bal = (x) => c.balance(c.acct[x] ? x : Address.fromString(x));

async function newVault(fwAddr = fw.address, breaker = ZeroAddress) {
  return c.deployRaw(kit.FwVault, [fwAddr, breaker, A('pgov')], 'pgov');
}

beforeEach(async () => {
  c = await createChain(['gov', 'pgov', 'user', 'user2', 'attacker', 'outsider']);
  A = (n) => getAddress(c.acct[n].toString());
  kit = firewallKit();
  certs = await c.deployRaw(kit.MockCertificates, [], 'gov');
  fw = await c.deploy('InvariantFirewall', [certs.address, A('gov'), BPS], 'gov');
  vault = await newVault();
  solvency = await c.deployRaw(kit.SolvencyInvariant, [], 'gov');
  await fw.send('pgov', 'addInvariant', [vault.address, solvency.address, 50_000, NAME('solvency')]);
  await vault.send('user', 'deposit', [], 500n * ZETA);
  await vault.send('user2', 'deposit', [], 500n * ZETA);
});

// ---------------------------------------------------------------- SS1: the firewall stops the exploit

test('a bug that breaks an invariant cannot be used: the whole transaction reverts; without the firewall it drains', async () => {
  // control: the same bug, no firewall
  const plain = await c.deployRaw(kit.PlainVault, [], 'gov');
  await plain.send('user', 'deposit', [], 1000n * ZETA);
  const before = await bal('attacker');
  await plain.send('attacker', 'skim', [400n * ZETA]);
  assert.equal(await bal('attacker') - before, 400n * ZETA, 'the unprotected vault is drained');

  // protected: the same call reverts with the violated invariant named
  await assert.rejects(vault.send('attacker', 'skim', [400n * ZETA]), /InvariantViolated/);
  await assert.rejects(vault.send('attacker', 'skim', [1n]), /InvariantViolated/, 'even one wei');
  assert.equal(await bal(vault.address), 1000n * ZETA);
  // honest use goes through
  await vault.send('user', 'withdraw', [100n * ZETA]);
  await vault.send('user', 'deposit', [], 5n * ZETA);
  assert.equal(await vault.call('totalDeposits'), 905n * ZETA);
  assert.deepEqual([...(await fw.call('check', [vault.address]))], [true, 0n]);
  // a donation keeps solvency (balance > deposits), so skimming exactly the surplus is allowed: the
  // firewall enforces the invariant, not the absence of bugs
  await c.transfer('outsider', vault.address, 3n * ZETA);
  await vault.send('attacker', 'skim', [3n * ZETA]);
  await assert.rejects(vault.send('attacker', 'skim', [1n]), /InvariantViolated/);
});

test('reentrancy: the re-entrant drain reverts (checked once, after the outermost call); legitimate nested calls pass', async () => {
  const atk = await c.deployRaw(kit.FwAttacker, [vault.address], 'attacker');
  await assert.rejects(atk.send('attacker', 'attack', [3], 10n * ZETA), /InvariantViolated/);
  assert.equal(await bal(vault.address), 1000n * ZETA);
  assert.equal(await bal(atk.address), 0n);
  // depth 0 is not an exploit (pays once, books once): it passes
  await atk.send('attacker', 'attack', [0], 10n * ZETA);
  assert.equal(await bal(atk.address), 10n * ZETA);
  // a smart wallet whose receive() deposits again (a nested firewalled call in the middle of withdraw)
  const w = await c.deployRaw(kit.FwSmartWallet, [vault.address], 'user');
  await w.send('user', 'save', [], 100n * ZETA);
  await w.send('user', 'take', [40n * ZETA, true]);
  assert.equal(await vault.call('balances', [w.address]), 80n * ZETA);
  assert.equal(await bal(w.address), 20n * ZETA);
  assert.deepEqual([...(await fw.call('check', [vault.address]))], [true, 0n]);
});

test('fail-closed: false, a revert, running out of the gas cap, or a malformed answer are violations; starving the check never lets a drain through', async () => {
  const mode = await c.deployRaw(kit.ModeInvariant, [], 'gov');
  await fw.send('pgov', 'addInvariant', [vault.address, mode.address, 60_000, NAME('mode')]);
  for (const m of [1, 2, 3, 4, 5, 6]) {
    await mode.send('gov', 'set', [m]);
    await assert.rejects(vault.send('user', 'withdraw', [ZETA]), /InvariantViolated/, `mode ${m}`);
    const [ok, i] = await fw.call('check', [vault.address]);
    assert.equal(ok, false, `mode ${m}`);
    assert.equal(i, 1n);
  }
  await mode.send('gov', 'set', [0]);
  await vault.send('user', 'withdraw', [ZETA]);
  // give the protected call only part of the gas: the payment may run, the check then cannot, so it reverts
  const atk = await c.deployRaw(kit.FwAttacker, [vault.address], 'attacker');
  const held = await bal(vault.address);
  for (let gas = 30_000; gas <= 400_000; gas += 10_000) await atk.send('attacker', 'starve', [5n * ZETA, gas]);
  assert.equal(await bal(vault.address), held, 'no gas amount gets the skim through');
  assert.equal(await bal(atk.address), 0n);
});

test('the firewall costs a bounded amount of gas per protected call', async () => {
  const off = await newVault(ZeroAddress);
  await off.send('user', 'deposit', [], 10n * ZETA);
  await vault.send('user', 'deposit', [], 10n * ZETA);
  const g0 = (await off.gas('user', 'withdraw', [ZETA])).exec;
  const g1 = (await vault.gas('user', 'withdraw', [ZETA])).exec;
  assert.ok(g1 - g0 < 40_000, `overhead ${g1 - g0} gas with one invariant`);
});

// ---------------------------------------------------------------- registration bounds and delays

test('registration: only the protocol itself registers; only its governance adds invariants, within bounds, holding now', async () => {
  const p = await fw.call('protocolOf', [vault.address]);
  assert.equal(p.governance, A('pgov'));
  assert.equal(p.active, true);
  await assert.rejects(fw.send('outsider', 'register', [ZeroAddress]), /BadValue/);
  await fw.send('outsider', 'register', [A('outsider')]); // an EOA registers itself: harmless, only itself
  await assert.rejects(fw.send('outsider', 'register', [A('outsider')]), /AlreadyRegistered/);
  const mode = await c.deployRaw(kit.ModeInvariant, [], 'gov');
  await assert.rejects(fw.send('outsider', 'addInvariant', [vault.address, mode.address, 50_000, NAME('m')]), /NotProtocolGovernance/);
  await assert.rejects(fw.send('gov', 'addInvariant', [vault.address, mode.address, 50_000, NAME('m')]), /NotProtocolGovernance/, 'not even the timelock');
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, A('user'), 50_000, NAME('m')]), /NotAContract/);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, mode.address, 4_999, NAME('m')]), /BadValue/);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, mode.address, 500_001, NAME('m')]), /BadValue/);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, solvency.address, 50_000, NAME('again')]), /Duplicate/);
  await mode.send('gov', 'set', [1]);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, mode.address, 50_000, NAME('m')]), /DoesNotHold/, 'an invariant broken now would only block the protocol');
  await mode.send('gov', 'set', [0]);
  await fw.send('pgov', 'addInvariant', [vault.address, mode.address, 50_000, NAME('m')]);
  for (let i = 0; i < 6; i++) {
    const m = await c.deployRaw(kit.ModeInvariant, [], 'gov');
    await fw.send('pgov', 'addInvariant', [vault.address, m.address, 5_000, NAME(`m${i}`)]);
  }
  const extra = await c.deployRaw(kit.ModeInvariant, [], 'gov');
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, extra.address, 5_000, NAME('9th')]), /TooMany/);
  assert.equal((await fw.call('invariantsOf', [vault.address])).length, 8);
  await vault.send('user', 'withdraw', [ZETA]); // eight checks, all hold
});

test('removing an invariant or opting out waits POLICY_DELAY in public; the timelock cannot remove one', async () => {
  await assert.rejects(fw.send('pgov', 'proposeRemoval', [vault.address, A('user')]), /UnknownInvariant/);
  await assert.rejects(fw.send('outsider', 'proposeRemoval', [vault.address, solvency.address]), /NotProtocolGovernance/);
  await assert.rejects(fw.send('gov', 'proposeRemoval', [vault.address, solvency.address]), /NotProtocolGovernance/);
  await fw.send('pgov', 'proposeRemoval', [vault.address, solvency.address]);
  await assert.rejects(fw.send('outsider', 'removeInvariant', [vault.address, solvency.address]), /TooEarly/);
  await assert.rejects(vault.send('attacker', 'skim', [ZETA]), /InvariantViolated/, 'still enforced while the removal waits');
  c.advance(DAY);
  await fw.send('pgov', 'cancelRemoval', [vault.address, solvency.address]);
  c.advance(DAY);
  await assert.rejects(fw.send('outsider', 'removeInvariant', [vault.address, solvency.address]), /TooEarly/, 'cancelled');
  await fw.send('pgov', 'proposeRemoval', [vault.address, solvency.address]);
  c.advance(2 * DAY);
  await fw.send('outsider', 'removeInvariant', [vault.address, solvency.address]);
  assert.equal((await fw.call('invariantsOf', [vault.address])).length, 0);
  await vault.send('attacker', 'skim', [ZETA]); // nothing protects it any more

  // opt-out
  await fw.send('pgov', 'addInvariant', [vault.address, solvency.address, 50_000, NAME('solvency')]).catch(() => {}); // broken now (skimmed): refused
  await assert.rejects(fw.send('pgov', 'cancelOptOut', [vault.address]), /TooEarly/, 'nothing to cancel');
  await fw.send('pgov', 'proposeOptOut', [vault.address]);
  await fw.send('pgov', 'cancelOptOut', [vault.address]);
  c.advance(2 * DAY);
  await assert.rejects(fw.send('outsider', 'optOut', [vault.address]), /TooEarly/, 'a cancelled opt-out never runs');
  await fw.send('pgov', 'proposeOptOut', [vault.address]);
  await assert.rejects(fw.send('outsider', 'optOut', [vault.address]), /TooEarly/);
  c.advance(2 * DAY);
  await fw.send('outsider', 'optOut', [vault.address]);
  assert.equal((await fw.call('protocolOf', [vault.address])).active, false);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, solvency.address, 50_000, NAME('s')]), /NotRegistered/);
});

// ---------------------------------------------------------------- chain layer registry

test('chain layer: the protocol asks, only the timelock approves, within MAX_CHAIN and the gas budget; chainCheck reports broken ones', async () => {
  await assert.rejects(fw.send('gov', 'approveChain', [vault.address]), /BadValue/, 'not requested');
  await assert.rejects(fw.send('outsider', 'requestChain', [vault.address]), /NotProtocolGovernance/);
  await fw.send('pgov', 'requestChain', [vault.address]);
  await assert.rejects(fw.send('pgov', 'approveChain', [vault.address]), /NotGovernance/);
  await fw.send('gov', 'approveChain', [vault.address]);
  await assert.rejects(fw.send('gov', 'approveChain', [vault.address]), /BadValue/, 'already');
  assert.deepEqual([...(await fw.call('chainProtocols'))], [getAddress(vault.address)]);
  let [list, mask] = await fw.call('chainCheck');
  assert.deepEqual([...list], [getAddress(vault.address)]);
  assert.equal(mask, 0n);
  assert.equal(await fw.call('chainGas'), 50_000n);

  // budget: 50k + 3 x 500k fits (1.55M); a fourth 500k would pass 2M
  const ms = [];
  for (let i = 0; i < 4; i++) ms.push(await c.deployRaw(kit.ModeInvariant, [], 'gov'));
  for (const m of ms.slice(0, 3)) await fw.send('pgov', 'addInvariant', [vault.address, m.address, 500_000, NAME('big')]);
  await assert.rejects(fw.send('pgov', 'addInvariant', [vault.address, ms[3].address, 500_000, NAME('big')]), /OverBudget/);
  await fw.send('pgov', 'addInvariant', [vault.address, ms[3].address, 400_000, NAME('fits')]);
  assert.equal(await fw.call('chainGas'), 1_950_000n);

  // a second protocol over the remaining budget is refused; a cheap one fits
  const v2 = await newVault();
  await fw.send('pgov', 'addInvariant', [v2.address, solvency.address, 60_000, NAME('solvency')]);
  await fw.send('pgov', 'requestChain', [v2.address]);
  await assert.rejects(fw.send('gov', 'approveChain', [v2.address]), /OverBudget/);
  await fw.send('gov', 'dropChain', [vault.address]);
  assert.equal(await fw.call('chainGas'), 0n);
  await fw.send('gov', 'approveChain', [v2.address]);

  // a broken invariant shows in the mask (bit = index in the list)
  const m2 = await c.deployRaw(kit.ModeInvariant, [], 'gov');
  await fw.send('pgov', 'addInvariant', [v2.address, m2.address, 20_000, NAME('m2')]);
  await m2.send('gov', 'set', [2]);
  [list, mask] = await fw.call('chainCheck');
  assert.deepEqual([...list], [getAddress(v2.address)]);
  assert.equal(mask, 1n);
  await m2.send('gov', 'set', [0]);
  assert.equal((await fw.call('chainCheck'))[1], 0n);
  await assert.rejects(fw.send('outsider', 'dropChain', [v2.address]), /NotGovernance/);

  // at most MAX_CHAIN protocols
  for (let i = 0; i < 7; i++) {
    const v = await newVault();
    await fw.send('pgov', 'addInvariant', [v.address, solvency.address, 5_000, NAME('s')]);
    await fw.send('pgov', 'requestChain', [v.address]);
    await fw.send('gov', 'approveChain', [v.address]);
  }
  const v9 = await newVault();
  await fw.send('pgov', 'requestChain', [v9.address]);
  await assert.rejects(fw.send('gov', 'approveChain', [v9.address]), /TooMany/);
  assert.equal((await fw.call('chainProtocols')).length, 8);
  // chainCheck fits in what the node gives it (CHAIN_CALL_GAS) at the full budget
  const g = await c.rawTx('outsider', fw.address, fw.iface.encodeFunctionData('chainCheck'));
  assert.ok(g.ok && g.gas < 3_000_000, `chainCheck gas ${g.gas}`);
});

// ---------------------------------------------------------------- SS2: certificate as a chain rule

test('certificate rule: an uncertified protocol above the threshold pays out at most uncertifiedBps of its balance a day', async () => {
  // no threshold: not limited
  await vault.send('user', 'withdraw', [300n * ZETA]);
  await vault.send('user', 'deposit', [], 300n * ZETA);
  await assert.rejects(fw.send('outsider', 'setThreshold', [ZeroAddress, 500n * ZETA]), /NotGovernance/);
  await fw.send('gov', 'setThreshold', [ZeroAddress, 500n * ZETA]);
  assert.equal(await fw.call('outflowLeft', [vault.address, ZeroAddress]), 100n * ZETA);
  await vault.send('user', 'withdraw', [60n * ZETA]);
  await vault.send('user', 'withdraw', [40n * ZETA]); // 100 = 10% of 1000
  await assert.rejects(vault.send('user', 'withdraw', [1n]), /OutflowLimited/);
  assert.equal(await fw.call('outflowLeft', [vault.address, ZeroAddress]), 0n);
  // a big deposit raises the day's high mark (5900 -> cap 590), but its own withdrawal counts in full,
  // so inflating the balance never lets more of the rest out
  await vault.send('user2', 'deposit', [], 5000n * ZETA);
  await assert.rejects(vault.send('user2', 'withdraw', [5000n * ZETA]), /OutflowLimited/);
  assert.equal(await fw.call('outflowLeft', [vault.address, ZeroAddress]), 490n * ZETA);
  await vault.send('user2', 'withdraw', [490n * ZETA]);
  await assert.rejects(vault.send('user2', 'withdraw', [1n]), /OutflowLimited/);
  // the next day: a new window on the new balance (5410 -> 541)
  c.advance(DAY);
  await vault.send('user2', 'withdraw', [541n * ZETA]);
  await assert.rejects(vault.send('user2', 'withdraw', [1n]), /OutflowLimited/);
  // a live certificate lifts the cap at once
  await certs.send('gov', 'set', [vault.address, 7, Number(c.now()) + 10 * DAY, false]);
  assert.equal(await fw.call('isCertified', [vault.address]), true);
  assert.equal(await fw.call('outflowLeft', [vault.address, ZeroAddress]), 2n ** 256n - 1n);
  await vault.send('user2', 'withdraw', [2000n * ZETA]);
  // revoked: limited again (today's earlier outflow still counts)
  await certs.send('gov', 'set', [vault.address, 7, Number(c.now()) + 10 * DAY, true]);
  await assert.rejects(vault.send('user2', 'withdraw', [1n]), /OutflowLimited/);
  // re-certified, then expired: limited again
  await certs.send('gov', 'set', [vault.address, 8, Number(c.now()) + DAY, false]);
  await vault.send('user2', 'withdraw', [100n * ZETA]);
  c.advance(DAY);
  const left = await fw.call('outflowLeft', [vault.address, ZeroAddress]);
  assert.equal(left, (await bal(vault.address)) * BigInt(BPS) / 10_000n);
  await assert.rejects(vault.send('user2', 'withdraw', [left + 1n]), /OutflowLimited/);
  await vault.send('user2', 'withdraw', [left]);

  // below the threshold: not limited
  const small = await newVault();
  await small.send('user', 'deposit', [], 400n * ZETA);
  await small.send('user', 'withdraw', [400n * ZETA]);
  // protocols that never registered are not affected (and cannot be: the rule reads msg.sender)
  await fw.send('outsider', 'recordOutflow', [ZeroAddress, 10n ** 30n]);
});

test('certificate rule parameters: governance only, bounded; at most MAX_ASSETS assets', async () => {
  await assert.rejects(fw.send('outsider', 'setUncertifiedBps', [2000]), /NotGovernance/);
  await assert.rejects(fw.send('gov', 'setUncertifiedBps', [99]), /BadValue/);
  await assert.rejects(fw.send('gov', 'setUncertifiedBps', [5001]), /BadValue/);
  await fw.send('gov', 'setUncertifiedBps', [5000]);
  assert.equal(await fw.call('uncertifiedBps'), 5000n);
  const assets = [...Array(9)].map((_, i) => getAddress('0x' + (i + 1).toString(16).padStart(40, '0')));
  for (const a of assets.slice(0, 8)) await fw.send('gov', 'setThreshold', [a, ZETA]);
  await assert.rejects(fw.send('gov', 'setThreshold', [assets[8], ZETA]), /TooMany/);
  await fw.send('gov', 'setThreshold', [assets[0], 2n * ZETA]); // update: no new slot
  await fw.send('gov', 'setThreshold', [assets[1], 0]);         // remove
  await fw.send('gov', 'setThreshold', [assets[8], ZETA]);
  assert.equal((await fw.call('assets')).length, 8);
  assert.equal(await fw.call('valueThreshold', [assets[1]]), 0n);
  await assert.rejects(fw.send('outsider', 'setGovernance', [A('outsider')]), /NotGovernance/);
  await assert.rejects(fw.send('gov', 'setGovernance', [ZeroAddress]), /BadValue/);
  await fw.send('gov', 'setGovernance', [A('outsider')]);
  await assert.rejects(fw.send('gov', 'setUncertifiedBps', [1000]), /NotGovernance/);
});

// ---------------------------------------------------------------- invariant sets attested by certificates

test('an invariant set is attested only while the protocol and every checker hold live certificates and the set is unchanged', async () => {
  await assert.rejects(fw.send('outsider', 'attest', [vault.address, 7]), /NotCertified/);
  const until = Number(c.now()) + 30 * DAY;
  await certs.send('gov', 'set', [vault.address, 7, until, false]);
  await assert.rejects(fw.send('outsider', 'attest', [vault.address, 7]), /NotCertified/, 'the checker is not certified');
  await certs.send('gov', 'set', [solvency.address, 9, until, false]);
  await assert.rejects(fw.send('outsider', 'attest', [vault.address, 6]), /WrongRequest/, 'bound to the request that certified it');
  await fw.send('outsider', 'attest', [vault.address, 7]);
  assert.equal(await fw.call('isAttested', [vault.address]), true);
  const a = await fw.call('attestationOf', [vault.address]);
  assert.equal(a.setHash, await fw.call('setHash', [vault.address]));
  assert.equal(a.requestId, 7n);
  // the set changes: no longer attested until the new checker is certified and someone attests again
  const mode = await c.deployRaw(kit.ModeInvariant, [], 'gov');
  await fw.send('pgov', 'addInvariant', [vault.address, mode.address, 20_000, NAME('mode')]);
  assert.equal(await fw.call('isAttested', [vault.address]), false);
  await assert.rejects(fw.send('outsider', 'attest', [vault.address, 7]), /NotCertified/);
  await certs.send('gov', 'set', [mode.address, 10, until, false]);
  await fw.send('outsider', 'attest', [vault.address, 7]);
  assert.equal(await fw.call('isAttested', [vault.address]), true);
  // a checker's certificate revoked, the protocol re-certified under another request, or expiry: not attested
  await certs.send('gov', 'set', [mode.address, 10, until, true]);
  assert.equal(await fw.call('isAttested', [vault.address]), false);
  await certs.send('gov', 'set', [mode.address, 11, until, false]);
  assert.equal(await fw.call('isAttested', [vault.address]), true);
  await certs.send('gov', 'set', [vault.address, 12, until, false]);
  assert.equal(await fw.call('isAttested', [vault.address]), false, 'another certificate: attest again');
  await fw.send('outsider', 'attest', [vault.address, 12]);
  assert.equal(await fw.call('isAttested', [vault.address]), true);
  c.advance(31 * DAY);
  assert.equal(await fw.call('isAttested', [vault.address]), false);
});

// ---------------------------------------------------------------- with the real AuditCertificate

test('the real AuditCertificate: certifying the vault\'s exact code lifts the cap; expiry brings it back', async () => {
  const names = ['gov', 'treasury', 'sponsor', 'x', 'a1', 'a2', 'r1', 'r2', 'r3', 'pgov', 'user', 'user2', 'attacker'];
  c = await createChain(names);
  const W = (n) => getAddress(c.acct[n].toString());
  const P = { minContest: 3 * DAY, maxContest: 30 * DAY, revealWindow: DAY, judgeWindow: 2 * DAY, appealWindow: 2 * DAY, appealTimeout: 7 * DAY,
    unbondDelay: DAY, minAuditorsFloor: 2, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000, maxFindingsPerAuditor: 5,
    auditorBond: 10n * ZETA, minPool: ZETA };
  const JP = { judgeQuorum: 3, maxJudges: 9, judgeMinScore: 0, unbondDelay: DAY, judgeBond: 20n * ZETA, appealBond: 5n * ZETA };
  const LEVELS = { validity: 30 * DAY, silverAuditors: 3, goldAuditors: 5, silverContest: 7 * DAY, goldContest: 14 * DAY, silverMutationBps: 7000, goldMutationBps: 8500 };
  const m = workMocks();
  const jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3']) await jobs.send('gov', 'set', [W(r), true, 5, 0]);
  const rep = await c.deploy('WorkerReputation', [W('gov'), jobs.address, ZeroAddress], 'gov');
  const n = await c.nonce('gov');
  const at = (i) => getCreateAddress({ from: W('gov'), nonce: n + BigInt(i) });
  const net = await c.deploy('AuditNetwork', [W('gov'), W('treasury'), rep.address, at(1), at(2), at(3), P], 'gov');
  const run = await c.deploy('AuditRunners', [net.address, jobs.address, rep.address, 1], 'gov');
  await c.deploy('AuditJudges', [net.address, rep.address, W('gov'), JP], 'gov');
  const cert = await c.deploy('AuditCertificate', [net.address, run.address, at(2), W('gov'), LEVELS], 'gov');
  await rep.send('gov', 'setReporter', [net.address, true]);
  await rep.send('gov', 'setReporter', [run.address, true]);
  for (const a of ['a1', 'a2']) await net.send(a, 'bond', [], 10n * ZETA);

  const firewall = await c.deploy('InvariantFirewall', [cert.address, W('gov'), BPS], 'gov');
  const v = await c.deployRaw(kit.FwVault, [firewall.address, ZeroAddress, W('pgov')], 'pgov');
  const inv = await c.deployRaw(kit.SolvencyInvariant, [], 'gov');
  await firewall.send('pgov', 'addInvariant', [v.address, inv.address, 50_000, NAME('solvency')]);
  await firewall.send('gov', 'setThreshold', [ZeroAddress, 100n * ZETA]);
  await v.send('user', 'deposit', [], 1000n * ZETA);
  await assert.rejects(v.send('user', 'withdraw', [101n * ZETA]), /OutflowLimited/);

  // the vault's exact runtime code goes through the audit process
  const code = await c.getCode(v.address);
  const salt = '0x' + '07'.padStart(64, '0');
  const hash = (s) => keccak256(new TextEncoder().encode(s));
  const GOOD = { resultHash: hash('fw result'), critHigh: 0, invFailed: 0, invNotRun: 0, mutationBps: 9000 };
  await net.send('sponsor', 'request', [{ chainId: 1n, target: v.address, codeHash: codeHashOf(code), sourceHash: hash('src') }, 0, 3 * DAY, 2, 0n, 'ipfs://scope'], 11n * ZETA);
  const id = (await net.call('requestCount')) - 1n;
  for (const a of ['a1', 'a2']) await net.send(a, 'commitReport', [id, core.reportCommitment(k, hash(`report ${a}`), W(a), salt, id)]);
  for (const r of ['r1', 'r2', 'r3']) await run.send(r, 'commit', [id, core.runCommitment(k, GOOD, W(r), salt, id)]);
  c.advance(3 * DAY);
  for (const a of ['a1', 'a2']) await net.send(a, 'revealReport', [id, hash(`report ${a}`), salt]);
  for (const r of ['r1', 'r2', 'r3']) await run.send(r, 'reveal', [id, GOOD, salt]);
  c.advance(5 * DAY);
  await run.send('x', 'settle', [id]);
  await net.send('x', 'settle', [id]);
  await cert.send('x', 'certify', [id]);
  assert.equal(await firewall.call('isCertified', [v.address]), true);
  await v.send('user', 'withdraw', [600n * ZETA]); // no cap while certified
  await assert.rejects(v.send('attacker', 'skim', [ZETA]), /InvariantViolated/, 'certified or not, the invariants hold');
  c.advance(30 * DAY);
  assert.equal(await firewall.call('isCertified', [v.address]), false, 'expired');
  await assert.rejects(v.send('user', 'withdraw', [41n * ZETA]), /OutflowLimited/); // 10% of 400
  await v.send('user', 'withdraw', [40n * ZETA]);
});

// ---------------------------------------------------------------- with CircuitBreaker

test('with CircuitBreaker: an over-cap withdrawal is held (books stay solvent, so the firewall lets it through), and the firewall still blocks the bug while tripped', async () => {
  c = await createChain(['gov', 'pgov', 'user', 'user2', 'attacker', 'outsider', 'r0', 'r1', 'r2']);
  A = (nm) => getAddress(c.acct[nm].toString());
  certs = await c.deployRaw(kit.MockCertificates, [], 'gov');
  fw = await c.deploy('InvariantFirewall', [certs.address, A('gov'), BPS], 'gov');
  const jobs = await c.deploy('NeuroJobs', [ZETA, ZETA / 10n, ZETA / 100n, 120, 600, 3600, 1000n * ZETA], 'gov');
  const br = await c.deploy('CircuitBreaker', [jobs.address, A('gov'), 10n * ZETA, 5n * ZETA, 3, 0], 'gov');
  const v = await newVault(fw.address, br.address);
  const inv = await c.deployRaw(kit.SolvencyInvariant, [], 'gov');
  await fw.send('pgov', 'addInvariant', [v.address, inv.address, 50_000, NAME('solvency')]);
  const sel = (s) => v.iface.getFunction(s).selector;
  const policy = { governance: A('pgov'), selectors: [sel('deposit'), sel('withdraw')], assets: [ZeroAddress], caps: [300n * ZETA],
    window: 600, maxPause: 3600, quorum: 3, invariantMask: 1, tripCapBps: 1000, holdAbove: 50n * ZETA, holdReview: 600 };
  await v.send('pgov', 'optInBreaker', [br.iface.encodeFunctionData('register', [policyTuple(policy)])]);
  await v.send('user', 'deposit', [], 500n * ZETA);
  await v.send('user2', 'deposit', [], 500n * ZETA);
  await v.send('user', 'withdraw', [200n * ZETA]);
  const before = await bal('user');
  await v.send('user', 'withdraw', [200n * ZETA]); // 400 > 300 in the window: tripped, held
  assert.equal(await bal('user'), before, 'held, not paid');
  assert.equal(await br.call('isTripped', [v.address]), true);
  assert.equal(await v.call('heldCount'), 1n);
  assert.deepEqual([...(await fw.call('check', [v.address]))], [true, 0n], 'the held funds stay: solvent');
  await assert.rejects(v.send('user2', 'deposit', [], ZETA), /SelectorTripped/, 'the trip pauses deposit');
  // the 200 held stay in the vault beyond the books; skimming past that surplus breaks solvency
  await assert.rejects(v.send('attacker', 'skim', [201n * ZETA]), /InvariantViolated/);
});
