// HyperlaneLane: the airlock's second, independent lane (Hyperlane Mailbox + ISM),
// with a mock Mailbox; and BridgeGuard's on-chain opening gates (audit, 2+
// independent lanes) and hard cap (maxDailyLimit, x2 per step, 7-day timelock).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes, Interface, zeroPadValue } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const ROUTE = encodeBytes32String('airlock/zetaphy');
const Q = 600;
const USDC = 10n ** 6n;
const ORIGIN = 97; // the source chain's Hyperlane domain (here: its chain id too)
const ZERO = '0x' + '00'.repeat(20);
const AUDIT = ['https://audits.example/zetaphy-bridge.pdf', '0x' + 'a1'.repeat(32)];
const art = (n) => new Interface(JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).abi);
const abi = AbiCoder.defaultAbiCoder();
const b32 = (addr) => zeroPadValue(addr, 32);

let c, jobs, guard, airlock, lane, mailbox, otherMailbox, hyp, lockbox, token;
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
    for (const w of seats) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [id, keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
}

beforeEach(async () => {
  c = await createChain(['gov', 'user', 'r1', 'r2', 'r3', 'r4', 'alice', 'attacker', 'relayer']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  await provenRunners(['r1', 'r2', 'r3', 'r4']);
  guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await guard.send('gov', 'createToken', ['USD Coin (bridged)', 'USDC', 6]);
  token = await guard.call('token');
  airlock = await c.deploy('BridgeAirlock', [guard.address, ROUTE, a('gov'), 2, Q], 'gov');
  lane = await c.deploy('NeuroLane', [jobs.address, airlock.address, 2, 1, ZERO], 'gov');
  // One EVM plays both chains: the source's Mailbox dispatches, the destination's delivers.
  mailbox = await c.deploy('MockMailbox', [ORIGIN], 'gov');
  otherMailbox = await c.deploy('MockMailbox', [ORIGIN], 'attacker');
  // The lane first (unconfigured source), then the source lockbox pointing at it, then the lane's config.
  hyp = await c.deploy('HyperlaneLane', [airlock.address, a('gov'), mailbox.address, ORIGIN, '0x' + '00'.repeat(32), 0, ZERO, ZERO], 'gov');
  lockbox = await c.deploy('HyperlaneLockBox', [mailbox.address, 77390, b32(hyp.address)], 'gov');
  await hyp.send('gov', 'setConfig', [mailbox.address, ORIGIN, b32(lockbox.address), 1n, lockbox.address]); // the test EVM's chain id is 1
});

/** alice locks on the source: returns the deposit tuple and the body the Mailbox carries. */
async function lock(amount = 500n * USDC, to = 'alice', from = 'alice') {
  const ev = await lockbox.send(from, 'lock', [a(to), amount], amount);
  const n = ev.find((e) => e?.name === 'Locked').args.nonce;
  const t = [1n, lockbox.address, n, a(from), a(to), amount];
  return { t, body: abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], t) };
}
const relay = (body, { box = mailbox, origin = ORIGIN, sender = b32(lockbox.address) } = {}) => box.send('relayer', 'deliver', [origin, sender, hyp.address, body]);
const neuro = async (t, runners = ['r1', 'r2']) => { for (const r of runners) await lane.send(r, 'attest', t); };
async function open() {
  await airlock.send('gov', 'setLane', [lane.address, true]);
  await airlock.send('gov', 'setLane', [hyp.address, true]);
  await guard.send('gov', 'setAudit', AUDIT);
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, true]);
}
const bal = (who) => c.callAt(token, art('BridgedToken'), 'balanceOf', [a(who)]);

test('HyperlaneLane takes messages only from its Mailbox, origin domain, origin sender and source', async () => {
  await open();
  const { t, body } = await lock();
  await assert.rejects(hyp.send('attacker', 'handle', [ORIGIN, b32(lockbox.address), body]), /NotMailbox/);  // not through a Mailbox
  await assert.rejects(relay(body, { box: otherMailbox }));                                                 // another Mailbox: NotMailbox inside
  assert.equal(await hyp.call('delivered', [await airlock.call('transferId', t)]), false);
  await assert.rejects(relay(body, { origin: ORIGIN + 1 }));                                                // WrongOrigin
  await assert.rejects(relay(body, { sender: b32(a('attacker')) }));                                         // WrongSender
  const forged = abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], [1n, a('attacker'), 0n, a('attacker'), a('attacker'), 1n]);
  await assert.rejects(relay(forged));                                                                       // WrongSource (another source contract)
  await assert.rejects(relay(body + '00'));                                                                  // BadBody
  // The real one passes, once.
  const ev = await relay(body);
  assert.ok(ev !== undefined);
  const id = await airlock.call('transferId', t);
  assert.equal(await hyp.call('delivered', [id]), true);
  assert.equal((await airlock.call('status', [id]))[0], 1n);
  await assert.rejects(relay(body)); // Replay
  // A key standing in as the Mailbox shows each reason.
  await hyp.send('gov', 'setConfig', [a('relayer'), ORIGIN, b32(lockbox.address), 1n, lockbox.address]);
  for (const [args, re] of [[[ORIGIN + 1, b32(lockbox.address), body], /WrongOrigin/], [[ORIGIN, b32(a('alice')), body], /WrongSender/],
    [[ORIGIN, b32(lockbox.address), forged], /WrongSource/], [[ORIGIN, b32(lockbox.address), body + '00'], /BadBody/], [[ORIGIN, b32(lockbox.address), body], /Replay/]]) {
    await assert.rejects(hyp.send('relayer', 'handle', args), re);
  }
  await assert.rejects(hyp.send('relayer', 'handle', [ORIGIN, b32(lockbox.address), (await lock()).body], 1n), /NoValue/);
});

test('the same deposit gets the same transfer id from both lanes; NeuroLane + HyperlaneLane at threshold 2 release after the quarantine', async () => {
  await open();
  const { t, body } = await lock(300n * USDC);
  await relay(body);
  const id = await airlock.call('transferId', t);
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // one lane
  await neuro(t);
  const [count, , , readyAt] = await airlock.call('status', [id]);
  assert.equal(count, 2n);
  assert.equal(readyAt, c.now() + BigInt(Q));
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // quarantine
  c.advance(Q);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 300n * USDC);
});

test('one lane alone never releases, however long it waits; mismatched details from the two lanes do not combine', async () => {
  await open();
  const { t, body } = await lock(400n * USDC);
  await relay(body);
  c.advance(30 * 86400);
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/);
  // The runners attest another recipient / amount for the same nonce: two ids with one attestation each.
  const other = [...t]; other[4] = a('attacker');
  const more = [...t]; more[5] = t[5] + 1n;
  await neuro(other);
  await neuro(more, ['r3', 'r4']);
  c.advance(Q);
  for (const x of [t, other, more]) await assert.rejects(airlock.send('user', 'release', x), /NotReady/);
  assert.equal(await bal('attacker'), 0n);
});

test('BridgeGuard enables a route only with the audit on record and 2+ independent lanes', async () => {
  await assert.rejects(guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, true]), /AuditMissing/);
  await assert.rejects(guard.send('gov', 'setAudit', ['http://audits.example/x.pdf', AUDIT[1]]));   // not https
  await assert.rejects(guard.send('gov', 'setAudit', [AUDIT[0], '0x' + '00'.repeat(32)]));         // no hash
  await assert.rejects(guard.send('attacker', 'setAudit', AUDIT), /NotGovernance/);
  const ev = await guard.send('gov', 'setAudit', AUDIT);
  assert.deepEqual([...ev.find((e) => e?.name === 'AuditSet').args], AUDIT);
  assert.equal(await guard.call('auditSha256'), AUDIT[1]);
  await assert.rejects(guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, true]), /NeedLanes/);
  await airlock.send('gov', 'setLane', [lane.address, true]);
  // A second NeuroLane over the same runner records is the same controller: still one independent lane.
  const lane2 = await c.deploy('NeuroLane', [jobs.address, airlock.address, 3, 1, ZERO], 'gov');
  await airlock.send('gov', 'setLane', [lane2.address, true]);
  assert.equal(await airlock.call('laneCount'), 2n);
  assert.equal(await airlock.call('independentLanes'), 1n);
  await assert.rejects(guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, true]), /NeedLanes/);
  await airlock.send('gov', 'setLane', [hyp.address, true]);
  assert.equal(await airlock.call('independentLanes'), 2n);
  assert.equal((await airlock.call('laneControllerOf', [hyp.address])).toLowerCase(), mailbox.address.toLowerCase());
  assert.equal((await airlock.call('laneControllerOf', [lane.address])).toLowerCase(), jobs.address.toLowerCase());
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, true]);
  // An adapter that is not an airlock (a key, or code without independentLanes) is never enabled.
  await assert.rejects(guard.send('gov', 'setRoute', [encodeBytes32String('x'), a('relayer'), 1n, true]), /NeedLanes/);
  // Closing needs no gate; lanes off again: the list shrinks.
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1000n * USDC, false]);
  await airlock.send('gov', 'setLane', [lane2.address, false]);
  assert.deepEqual((await airlock.call('lanes')).map((x) => x.toLowerCase()).sort(), [lane.address, hyp.address].map((x) => x.toLowerCase()).sort());
});

test('HyperlaneLane: only governance sets the config, the ISM and the governance; unconfigured it refuses everything', async () => {
  const ism = '0x' + '15'.repeat(20);
  assert.equal(await hyp.call('interchainSecurityModule'), ZERO); // the Mailbox's default ISM
  await assert.rejects(hyp.send('attacker', 'setInterchainSecurityModule', [ism]), /NotGovernance/);
  await assert.rejects(hyp.send('attacker', 'setConfig', [a('attacker'), ORIGIN, b32(a('attacker')), 1n, a('attacker')]), /NotGovernance/);
  await assert.rejects(hyp.send('attacker', 'setGovernance', [a('attacker')]), /NotGovernance/);
  await hyp.send('gov', 'setInterchainSecurityModule', [ism]);
  assert.equal((await hyp.call('interchainSecurityModule')).toLowerCase(), ism);
  const fresh = await c.deploy('HyperlaneLane', [airlock.address, a('gov'), mailbox.address, ORIGIN, '0x' + '00'.repeat(32), 0, ZERO, ZERO], 'gov');
  await airlock.send('gov', 'setLane', [fresh.address, true]);
  const { body } = await lock();
  await assert.rejects(mailbox.send('relayer', 'deliver', [ORIGIN, '0x' + '00'.repeat(32), fresh.address, body])); // WrongSender (unset)
  await hyp.send('gov', 'setGovernance', [a('user')]);
  await assert.rejects(hyp.send('gov', 'setInterchainSecurityModule', [ZERO]), /NotGovernance/);
});

test('HyperlaneLockBox: locks amount + Mailbox fee, emits the Neuro lane\'s Locked event and dispatches the same fields', async () => {
  await mailbox.send('gov', 'setFee', [7n]);
  await assert.rejects(lockbox.send('alice', 'lock', [a('alice'), 100n], 100n)); // fee missing (the mock Mailbox refuses)
  const ev = await lockbox.send('alice', 'lock', [a('alice'), 100n], 107n);
  const locked = ev.find((e) => e?.name === 'Locked');
  assert.equal(locked.args.amount, 100n);
  assert.equal(await lockbox.call('nonce'), 1n);
  assert.equal(await lockbox.call('quoteLock', [a('alice'), 1n]), 7n);
  assert.equal(await lockbox.call('body', [0n, a('alice'), a('alice'), 100n]),
    abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], [1n, lockbox.address, 0n, a('alice'), a('alice'), 100n]));
  await assert.rejects(lockbox.send('alice', 'lock', [a('alice'), 0n], 7n));
});

test('BridgeGuard hard cap: starts at 1,000 tokens; raises x2 at most, 7 days after the proposal; cuts at once and bind every route', async () => {
  await open();
  assert.equal(await guard.call('maxDailyLimit'), 1000n * USDC);
  await assert.rejects(guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1001n * USDC, true]), /OverCap/);
  await assert.rejects(guard.send('gov', 'proposeMaxDailyLimit', [2001n * USDC]), /CapStep/);
  await assert.rejects(guard.send('attacker', 'proposeMaxDailyLimit', [2000n * USDC]), /NotGovernance/);
  await assert.rejects(guard.send('user', 'applyMaxDailyLimit'), /NoPending/);
  const ev = await guard.send('gov', 'proposeMaxDailyLimit', [2000n * USDC]);
  assert.equal(ev.find((e) => e?.name === 'MaxDailyLimitProposed').args[1], c.now() + 7n * 86400n);
  c.advance(7 * 86400 - 10);
  await assert.rejects(guard.send('user', 'applyMaxDailyLimit'), /TooEarly/);
  c.advance(10);
  await guard.send('user', 'applyMaxDailyLimit'); // anyone, once due
  assert.equal(await guard.call('maxDailyLimit'), 2000n * USDC);
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 2000n * USDC, true]);
  // A cut is at once and binds routes set higher before.
  await guard.send('gov', 'proposeMaxDailyLimit', [4000n * USDC]);
  await guard.send('gov', 'proposeMaxDailyLimit', [100n * USDC]);
  assert.equal(await guard.call('pendingMaxAt'), 0n); // the pending raise is gone too
  const [inLeft] = await guard.call('remaining', [ROUTE]);
  assert.equal(inLeft, 100n * USDC);
  const { t, body } = await lock(101n * USDC);
  await relay(body); await neuro(t);
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', t)); // OverLimit inside BridgeGuard
  // Closing never depends on the cap (the route's own limit is above it now).
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 2000n * USDC, false]);
  await assert.rejects(guard.send('gov', 'setRoute', [ROUTE, airlock.address, 2000n * USDC, true]), /OverCap/);
  await guard.send('gov', 'proposeMaxDailyLimit', [200n * USDC]);
  await guard.send('gov', 'cancelMaxDailyLimit');
  await assert.rejects(guard.send('user', 'applyMaxDailyLimit'), /NoPending/);
});

test('BridgeGuard lists its current guardians; governance changes are events', async () => {
  await guard.send('gov', 'setGuardian', [a('r1'), true]);
  await guard.send('gov', 'setGuardian', [a('r2'), true]);
  await guard.send('gov', 'setGuardian', [a('r1'), false]);
  await guard.send('gov', 'setGuardian', [a('r1'), true]);
  await guard.send('gov', 'setGuardian', [a('r2'), false]);
  assert.deepEqual((await guard.call('guardians')).map((x) => x.toLowerCase()), [a('r1').toLowerCase()]);
  const ev = await guard.send('gov', 'setGovernance', [a('user')]);
  assert.equal(ev.find((e) => e?.name === 'GovernanceSet').args.governance.toLowerCase(), a('user').toLowerCase());
  const ev2 = await airlock.send('gov', 'setThreshold', [3]);
  assert.equal(ev2.find((e) => e?.name === 'ThresholdSet').args.threshold, 3n);
});
