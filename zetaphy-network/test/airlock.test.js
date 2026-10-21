import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes, Interface } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const ROUTE = encodeBytes32String('airlock/zetaphy');
const Q = 600; // quarantine seconds
const SRC = 97n; // a source chain id
const LOCKBOX = '0x' + 'b0'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const art = (n) => new Interface(JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).abi);
const tokenIface = art('BridgedToken');

let c, jobs, guard, airlock, lane, decoy, token;
const a = (n) => c.acct[n].toString();

async function provenRunners(names) {
  for (const w of names) await jobs.send(w, 'register', [], 100n * ZETA);
  c.advance(1);
  const V = '0x' + '11'.repeat(32);
  for (let i = 0; i < names.length; i += 2) {
    const seats = [names[i], names[(i + 1) % names.length], names[(i + 2) % names.length]];
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [id, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
}

beforeEach(async () => {
  c = await createChain(['gov', 'user', 'r1', 'r2', 'r3', 'r4', 'hyperlane', 'guardian', 'alice', 'attacker', 'mallory']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  await provenRunners(['r1', 'r2', 'r3', 'r4']);
  guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await guard.send('gov', 'createToken', ['USD Coin (bridged)', 'USDC', 6]);
  token = await guard.call('token');
  airlock = await c.deploy('BridgeAirlock', [guard.address, ROUTE, a('gov'), 2, Q], 'gov');
  lane = await c.deploy('NeuroLane', [jobs.address, airlock.address, 2, 1, ZERO], 'gov');
  decoy = await c.deploy('DecoyBridge', [airlock.address, 'ZETAPHY Bridge v1'], 'gov');
  await airlock.send('gov', 'setLane', [lane.address, true]);
  await airlock.send('gov', 'setLane', [a('hyperlane'), true]);
  await airlock.send('gov', 'setVetoer', [lane.address, true]);
  await airlock.send('gov', 'setVetoer', [a('guardian'), true]);
  await airlock.send('gov', 'setDecoy', [decoy.address, true]);
  // Opening gates: the audit on record, 2 independent lanes (above), a cap raised once (x2, 7 days later).
  await guard.send('gov', 'setAudit', ['https://audits.example/zetaphy-bridge.pdf', '0x' + 'a1'.repeat(32)]);
  await guard.send('gov', 'proposeMaxDailyLimit', [2000n * 10n ** 6n]);
  c.advance(7 * 86400);
  await guard.send('user', 'applyMaxDailyLimit');
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 2000n * 10n ** 6n, true]);
});

const tx = (nonce, to = 'alice', amount = 500n * 10n ** 6n, sender = 'alice') => [SRC, LOCKBOX, BigInt(nonce), a(sender), a(to), amount];
const neuro = async (t, runners = ['r1', 'r2']) => { for (const r of runners) await lane.send(r, 'attest', t); };
const bal = (who) => c.callAt(token, tokenIface, 'balanceOf', [a(who)]);

test('two independent lanes (Hyperlane + Neuro runners) and the quarantine, then the money enters', async () => {
  const t = tx(0);
  await airlock.send('hyperlane', 'attest', t);
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // one lane is not enough
  await neuro(t);                                                       // 2 runners -> the Neuro lane attests
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // quarantine
  c.advance(Q);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 500n * 10n ** 6n);
  await assert.rejects(airlock.send('user', 'release', t), /Blocked/);  // once only
});

test('one hacked bridge alone cannot create money, however long it waits', async () => {
  const t = tx(1, 'attacker', 10n ** 12n, 'attacker');
  await airlock.send('hyperlane', 'attest', t);
  await assert.rejects(airlock.send('hyperlane', 'attest', t), /Twice/);
  c.advance(30 * 86400);
  await assert.rejects(airlock.send('attacker', 'release', t), /NotReady/);
  // lanes that saw different details do not add up
  await neuro(tx(1, 'attacker', 10n ** 12n + 1n, 'attacker'));
  await assert.rejects(airlock.send('attacker', 'release', t), /NotReady/);
});

test('Neuro runners or a guardian can veto during the quarantine', async () => {
  const t1 = tx(2), t2 = tx(3);
  for (const t of [t1, t2]) { await airlock.send('hyperlane', 'attest', t); await neuro(t); }
  const id1 = await airlock.call('transferId', t1);
  await lane.send('r3', 'voteVeto', [id1, 'source tx not final']);
  await lane.send('r4', 'voteVeto', [id1, 'source tx not final']);
  await airlock.send('guardian', 'veto', [await airlock.call('transferId', t2), 'manual hold']);
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', t1), /Blocked/);
  await assert.rejects(airlock.send('user', 'release', t2), /Blocked/);
  await assert.rejects(airlock.send('attacker', 'veto', [id1, 'x']), /NotVetoer/);
});

test('decoy bridges mark the attacker; marked transfers never come out; the real bridge keeps working', async () => {
  const decoyIface = art('DecoyBridge');
  await c.sendTo('attacker', decoy.address, decoyIface, 'mint', [a('attacker'), 10n ** 30n]);
  assert.equal(await airlock.call('tripped', [a('attacker')]), true);
  assert.equal(await guard.call('paused'), false); // a decoy never stops the bridges
  const bad = tx(4, 'alice', 1n, 'attacker');       // sent by the marked address
  const good = tx(5);
  for (const t of [bad, good]) { await airlock.send('hyperlane', 'attest', t); await neuro(t); }
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', bad), /Blocked/);
  await airlock.send('user', 'release', good);
  await assert.rejects(airlock.send('attacker', 'trip', [a('alice')]), /NotDecoy/);
  await airlock.send('gov', 'untrip', [a('attacker')]); // governance can lift a mistaken mark
  assert.equal(await airlock.call('tripped', [a('attacker')]), false);
});

test('only lanes attest; only proven runners speak for the Neuro lane; BridgeGuard limits still apply', async () => {
  await assert.rejects(airlock.send('attacker', 'attest', tx(6)), /NotLane/);
  await assert.rejects(lane.send('user', 'attest', tx(6)), /NotRunner/);
  await lane.send('r1', 'attest', tx(6));
  await assert.rejects(lane.send('r1', 'attest', tx(6)), /Twice/);
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 100n, true]); // tiny daily limit
  const t = tx(7, 'alice', 101n);
  await airlock.send('hyperlane', 'attest', t); await neuro(t);
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', t)); // OverLimit inside BridgeGuard
});

test('a decoy marks only its direct caller, so nobody can get an innocent user marked', async () => {
  // A lure contract that pokes the decoy when someone calls it.
  const decoyIface = art('DecoyBridge');
  await c.sendTo('alice', decoy.address, decoyIface, 'withdraw', [1]);
  assert.equal(await airlock.call('tripped', [a('alice')]), true); // calling it directly does mark you
  await airlock.send('gov', 'untrip', [a('alice')]);
  const lure = await c.deploy('Lure', [decoy.address], 'attacker');
  await c.sendTo('alice', lure.address, art('Lure'), 'claimAirdrop', []);
  assert.equal(await airlock.call('tripped', [a('alice')]), false);
  assert.equal(await airlock.call('tripped', [lure.address]), true);
});

// ---- vaccine: the ThreatRegistry's flags hold transfers; clearing the flag lets them out ----
const R = { CannotSellInSimulation: 1 };
const EV = ['0x' + 'e7'.repeat(32), 'neuro report']; // evidence: a reportHash and where to read it
async function registry(delay = 0) {
  const reg = await c.deploy('ThreatRegistry', [jobs.address, 2, 1, a('gov'), delay], 'gov');
  await airlock.send('gov', 'setThreats', [reg.address]);
  const flag = async (key, on = true) => { for (const r of ['r1', 'r3']) await reg.send(r, 'vote', [key, on, on ? R.CannotSellInSimulation : 0, ...EV]); };
  return { reg, flag };
}
const ready = async (t) => { await airlock.send('hyperlane', 'attest', t); await neuro(t); c.advance(Q); };

test('vaccine: a flagged source sender or source contract holds the transfer until the flag is cleared', async () => {
  const { reg, flag } = await registry();
  const bySender = tx(10, 'alice', 3n, 'attacker');
  const byContract = tx(11);
  const clean = tx(12);
  await flag(await reg.call('addressKey', [SRC, a('attacker')]));
  await flag(await reg.call('addressKey', [SRC, LOCKBOX]));
  for (const t of [bySender, byContract, clean]) await ready(t);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 1n);
  await assert.rejects(airlock.send('user', 'release', bySender), /ThreatFlagged/);
  await assert.rejects(airlock.send('user', 'release', byContract), /ThreatFlagged/);
  // The same address on another chain is someone else: not held.
  assert.equal(await airlock.call('flaggedParty', [SRC + 1n, '0x' + 'b1'.repeat(20), a('attacker'), a('alice')]), 0n);
  // Held, not lost: clear the flags (same quorum) and the transfers come out.
  await flag(await reg.call('addressKey', [SRC, LOCKBOX]), false);
  await assert.rejects(airlock.send('user', 'release', bySender), /ThreatFlagged/); // the sender is still flagged
  await airlock.send('user', 'release', byContract);
  await airlock.send('user', 'release', clean);
  assert.equal(await bal('alice'), 2n * 500n * 10n ** 6n);
  await flag(await reg.call('addressKey', [SRC, a('attacker')]), false);
  await airlock.send('user', 'release', bySender);
  assert.equal(await bal('alice'), 2n * 500n * 10n ** 6n + 3n);
});

test('vaccine: a recipient contract on ZETAPHY whose code is flagged gets nothing while flagged', async () => {
  const { reg, flag } = await registry();
  // A contract with no immutables stands in for a drainer: its code hash is keccak256 of the artifact's runtime code.
  const lure = await c.deploy('LockBox', [], 'attacker');
  const h = keccak256(JSON.parse(readFileSync(new URL('../artifacts/LockBox.json', import.meta.url), 'utf8')).deployedBytecode);
  const t = [SRC, LOCKBOX, 13n, a('alice'), lure.address, 9n];
  await ready(t);
  await flag(await reg.call('codeKey', [h]));
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('alice'), lure.address]), 3n);
  await assert.rejects(airlock.send('user', 'release', t), /ThreatFlagged/);
  await flag(await reg.call('codeKey', [h]), false);
  await airlock.send('user', 'release', t);
  assert.equal(await c.callAt(token, tokenIface, 'balanceOf', [lure.address]), 9n);
});

test('vaccine: only governance sets the registry; zero turns the check off', async () => {
  const { reg, flag } = await registry();
  await assert.rejects(airlock.send('attacker', 'setThreats', [ZERO]), /NotGovernance/);
  await flag(await reg.call('addressKey', [SRC, a('alice')]));
  const t = tx(14);
  await ready(t);
  await assert.rejects(airlock.send('user', 'release', t), /ThreatFlagged/);
  await airlock.send('gov', 'setThreats', [ZERO]);
  await airlock.send('user', 'release', t);
});

test('NeuroLane attests nothing while Neuro is paused (NeuroControl), and again once unpaused', async () => {
  const CONTROL = '0x' + 'c0'.repeat(20);
  await c.putCode(CONTROL, '0x600160005260206000f3'); // paused() -> true
  const paused = await c.deploy('NeuroLane', [jobs.address, airlock.address, 2, 1, CONTROL], 'gov');
  await airlock.send('gov', 'setLane', [paused.address, true]);
  assert.equal((await paused.call('control')).toLowerCase(), CONTROL);
  await assert.rejects(paused.send('r1', 'attest', tx(15)), /NeuroPaused/);
  const id = await airlock.call('transferId', tx(15));
  await paused.send('r1', 'voteVeto', [id, 'still allowed: holding money back is safe']);
  await c.putCode(CONTROL, '0x60206000f3'); // paused() -> false
  await paused.send('r1', 'attest', tx(15));
  await paused.send('r2', 'attest', tx(15));
  assert.equal((await airlock.call('status', [id]))[0], 1n); // the lane's attestation reached the airlock
});

test('vaccine: a flag holds a transfer after holdDelay (ThreatHeld); refused once enforced (ThreatFlagged); released after a clear', async () => {
  const { reg, flag } = await registry(3600);
  assert.equal(await reg.call('holdDelay'), 600n); // the default: 10 minutes, below the enforceDelay
  const t = tx(20, 'alice', 4n, 'attacker');
  await ready(t);
  const key = await reg.call('addressKey', [SRC, a('attacker')]);
  await flag(key);
  assert.equal((await reg.call('isAddressFlagged', [SRC, a('attacker')]))[0], true); // Neuro warns at once
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 0n); // two runners alone hold nothing yet
  assert.equal(await reg.call('heldFrom', [key]), c.now() + 600n);
  c.advance(600);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 0n); // not enforced yet
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 1n); // but held
  await assert.rejects(airlock.send('user', 'release', t), /ThreatHeld/);
  c.advance(3000);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 1n);
  await assert.rejects(airlock.send('user', 'release', t), /ThreatFlagged/);
  // A clear (same quorum) lets it out; nothing was lost while it was held.
  await flag(key, false);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 0n);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 4n);
});

test('vaccine: a held transfer comes out when the flag is cleared before it is ever enforced; every party can hold', async () => {
  const { reg, flag } = await registry(3600);
  const lure = await c.deploy('LockBox', [], 'attacker');
  const h = keccak256(JSON.parse(readFileSync(new URL('../artifacts/LockBox.json', import.meta.url), 'utf8')).deployedBytecode);
  const bySender = tx(22, 'alice', 1n, 'attacker');
  const byRecipient = [SRC, LOCKBOX, 23n, a('alice'), lure.address, 2n];
  for (const t of [bySender, byRecipient]) await ready(t);
  await flag(await reg.call('addressKey', [SRC, a('attacker')]));
  await flag(await reg.call('codeKey', [h]));
  c.advance(600); // holdDelay
  await assert.rejects(airlock.send('user', 'release', bySender), /ThreatHeld/);
  await assert.rejects(airlock.send('user', 'release', byRecipient), /ThreatHeld/);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), lure.address]), 3n);
  await flag(await reg.call('addressKey', [SRC, LOCKBOX]));
  await reg.send('gov', 'holdNow', [await reg.call('addressKey', [SRC, LOCKBOX])]);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), a('alice')]), 2n);
  // Governance protects the lockbox: no longer held on its account.
  await reg.send('gov', 'setProtected', [[await reg.call('addressKey', [SRC, LOCKBOX])], true]);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), a('alice')]), 0n);
  c.advance(1200); // still inside the enforceDelay: cleared before it was ever enforced
  await flag(await reg.call('addressKey', [SRC, a('attacker')]), false);
  await flag(await reg.call('codeKey', [h]), false);
  await airlock.send('user', 'release', bySender);
  await airlock.send('user', 'release', byRecipient);
  assert.equal(await c.callAt(token, tokenIface, 'balanceOf', [lure.address]), 2n);
});

test('vaccine: a fast-lane flag (fastQuorum or enforceNow) refuses at once, before the enforceDelay', async () => {
  const { reg, flag } = await registry(3600);
  const t = tx(24, 'alice', 5n, 'attacker');
  await ready(t);
  const key = await reg.call('addressKey', [SRC, a('attacker')]);
  await flag(key);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 0n); // within holdDelay: not held yet
  await reg.send('gov', 'enforceNow', [key]);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('attacker'), a('alice')]), 1n);
  await assert.rejects(airlock.send('user', 'release', t), /ThreatFlagged/);
  // The registry's quorum here is 2, fastQuorum 4: two more runners behind a flag enforce it at once.
  const t2 = tx(25, 'alice', 6n, 'mallory');
  await ready(t2);
  const k2 = await reg.call('addressKey', [SRC, a('mallory')]);
  await flag(k2);
  await reg.send('r2', 'vote', [k2, true, R.CannotSellInSimulation, ...EV]);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('mallory'), a('alice')]), 0n);
  await reg.send('r4', 'vote', [k2, true, R.CannotSellInSimulation, ...EV]);
  assert.equal(await airlock.call('flaggedParty', [SRC, LOCKBOX, a('mallory'), a('alice')]), 1n);
  await assert.rejects(airlock.send('user', 'release', t2), /ThreatFlagged/);
});

test('vaccine: governance protects the route\'s own keys (lockbox, airlock), so runners cannot hold every transfer', async () => {
  const { reg, flag } = await registry(3600);
  const lockboxKey = await reg.call('addressKey', [SRC, LOCKBOX]);
  const airlockKey = await reg.call('addressKey', [1n, airlock.address]); // the test chain's id is 1
  // Flagged before governance noticed: inside the delay nothing is held yet; protecting clears it.
  await flag(lockboxKey);
  await assert.rejects(reg.send('r1', 'setProtected', [[lockboxKey, airlockKey], true]), /NotGovernance/);
  await reg.send('gov', 'setProtected', [[lockboxKey, airlockKey], true]);
  c.advance(3600);
  await assert.rejects(reg.send('r1', 'vote', [lockboxKey, true, R.CannotSellInSimulation, ...EV]), /ProtectedKey/);
  await assert.rejects(reg.send('r1', 'vote', [airlockKey, true, R.CannotSellInSimulation, ...EV]), /ProtectedKey/);
  const t = tx(21);
  await ready(t);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 500n * 10n ** 6n);
});

test('holds by two runners: nothing is held within holdDelay; a guardian\'s holdNow or the fast lane holds at once; a clear ends it', async () => {
  const { reg, flag } = await registry(3600);
  await reg.send('gov', 'setGuardian', [a('guardian'), true]);
  // Two runners flag alice's source address: inside holdDelay her transfer still goes through.
  const t = tx(30, 'alice', 7n, 'alice');
  await ready(t);
  const key = await reg.call('addressKey', [SRC, a('alice')]);
  await flag(key);
  assert.equal((await reg.call('isAddressFlagged', [SRC, a('alice')]))[0], true); // the warning is immediate
  assert.equal((await reg.call('isAddressHeld', [SRC, a('alice')]))[0], false);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 7n);
  // A guardian (or governance) holds at once; runners and outsiders cannot.
  const t2 = tx(31, 'alice', 8n, 'alice');
  await ready(t2);
  for (const who of ['r1', 'user']) await assert.rejects(reg.send(who, 'holdNow', [key]), /NotGuardian/);
  const ev = await reg.send('guardian', 'holdNow', [key]);
  assert.ok(ev.some((e) => e?.name === 'HeldNow'));
  await assert.rejects(reg.send('guardian', 'holdNow', [key]), /NoChange/);
  assert.equal(await reg.call('heldFrom', [key]), c.now());
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), a('alice')]), 1n);
  await assert.rejects(airlock.send('user', 'release', t2), /ThreatHeld/);
  await assert.rejects(reg.send('guardian', 'holdNow', [await reg.call('addressKey', [SRC, a('mallory')])]), /NotFlagged/);
  // A clear ends the hold, and a later flag of the same key starts from holdDelay again.
  await flag(key, false);
  await airlock.send('user', 'release', t2);
  await flag(key);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), a('alice')]), 0n);
  // The fast lane (fastQuorum runners) holds at once too.
  for (const r of ['r2', 'r4']) await reg.send(r, 'vote', [key, true, R.CannotSellInSimulation, ...EV]);
  assert.equal(await airlock.call('heldParty', [SRC, LOCKBOX, a('alice'), a('alice')]), 1n);
  // Governance's knob: below enforceDelay (or 0: hold at once); enforceDelay stays above it.
  await assert.rejects(reg.send('guardian', 'setHoldDelay', [60]), /NotGovernance/);
  await assert.rejects(reg.send('gov', 'setHoldDelay', [3600]));
  await assert.rejects(reg.send('gov', 'setEnforceDelay', [600])); // not at or below holdDelay
  await reg.send('gov', 'setHoldDelay', [0]);
  assert.equal(await reg.call('holdDelay'), 0n);
  await reg.send('gov', 'setEnforceDelay', [0]);
  await assert.rejects(reg.send('gov', 'setHoldDelay', [1]));
  const r0 = await c.deploy('ThreatRegistry', [jobs.address, 2, 1, a('gov'), 600], 'gov');
  assert.equal(await r0.call('holdDelay'), 300n); // a short enforceDelay: half of it
});
