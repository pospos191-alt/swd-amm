// CircuitBreaker + CircuitBreakable (docs/future/self-healing.md) on the in-memory EVM: opt-in policies
// and their bounds, k-of-n runner evidence (ECDSA signatures and on-chain attestations), narrow and
// time-boxed effects, the on-chain outflow invariant, held outflows, false-trip claims with slashing
// and compensation, the timelock's veto, and the invariants (a trip always expires, caps hold, no
// trip without quorum, repeated trips need fresh evidence).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, keccak256, toUtf8Bytes, getBytes, getAddress, Interface, ZeroAddress, ZeroHash, parseEther } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { selfHealKit } from './helpers/selfhealkit.js';
import { policyTuple } from '../src/selfheal/loop.js';
import { tripDigest, DETECTOR_ID } from '../src/selfheal/detect.js';

const SEL = { deposit: '0xd0e30db0', withdraw: '0x2e1a7d4d', withdrawAll: '0x853828b6' };
const BIT = { deposit: 1, withdraw: 2, withdrawAll: 4 };
const BOND = ZETA;              // NeuroJobs worker bond
const GB = 10n * ZETA;          // guardian bond
const CB = 5n * ZETA;           // claim bond
const KEYS = [...Array(6)].map((_, i) => new Wallet(keccak256(toUtf8Bytes(`selfheal test runner ${i}`))));
const H = (s) => keccak256(toUtf8Bytes(s));

let c, jobs, br, vault, kit, policy;
const A = (n) => getAddress(c.acct[n].toString());

function basePolicy(over = {}) {
  return {
    governance: A('pgov'), selectors: [SEL.deposit, SEL.withdraw, SEL.withdrawAll], assets: [ZeroAddress], caps: [1000n * ZETA],
    window: 600, maxPause: 3600, quorum: 3, invariantMask: BIT.withdrawAll, tripCapBps: 1000, holdAbove: 50n * ZETA, holdReview: 600, ...over,
  };
}

beforeEach(async () => {
  c = await createChain(['gov', 'pgov', 'user', 'user2', 'outsider', 'attacker'], Object.fromEntries(KEYS.map((k, i) => [`r${i}`, k.address])));
  jobs = await c.deploy('NeuroJobs', [BOND, ZETA / 10n, ZETA / 100n, 120, 600, 3600, 1000n * ZETA], 'gov');
  for (let i = 0; i < 6; i++) await jobs.send(`r${i}`, 'register', [], BOND);
  br = await c.deploy('CircuitBreaker', [jobs.address, A('gov'), GB, CB, 3, 0], 'gov');
  for (let i = 0; i < 5; i++) await br.send(`r${i}`, 'joinGuardians', [], GB); // r5: a runner, but no guardian bond
  kit = selfHealKit();
  vault = await c.deployRaw(kit.HealVault, [br.address], 'pgov');
  policy = basePolicy();
  await vault.send('pgov', 'optIn', [br.iface.encodeFunctionData('register', [policyTuple(policy)])]);
  await vault.send('user', 'deposit', [], 500n * ZETA);
  await vault.send('user2', 'deposit', [], 500n * ZETA);
  c.mine(200);
});

/** Evidence ending at the last block (fresh). */
const evidence = (over = {}) => { const b = Number(c.blockNumber()) - 1; return { fromBlock: b, toBlock: b, evidenceHash: H(`ev ${b} ${Math.random()}`), detectorId: DETECTOR_ID, mask: BIT.withdrawAll, ...over }; };
const evTuple = (e) => [e.fromBlock, e.toBlock, e.evidenceHash, e.detectorId, e.mask];
async function signed(idx, e, protocol = vault.address) {
  const d = await br.call('digest', [protocol, evTuple(e)]);
  const s = idx.map((i) => ({ a: KEYS[i].address, sig: KEYS[i].signMessageSync(getBytes(d)) })).sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  return [s.map((x) => x.a), s.map((x) => x.sig)];
}
const trip = async (idx = [0, 1, 2], e = evidence(), protocol = vault.address) => br.send('outsider', 'tripWithSignatures', [protocol, evTuple(e), ...(await signed(idx, e, protocol))]);

// ---------------------------------------------------------------- opt-in and policy bounds

test('a protocol opts in with a bounded policy; bad policies are refused', async () => {
  const p = await br.call('policyOf', [vault.address]);
  assert.equal(p.governance, A('pgov'));
  assert.equal(p.quorum, 3n);
  assert.deepEqual([...p.selectors], [SEL.deposit, SEL.withdraw, SEL.withdrawAll]);
  assert.equal(await br.call('capOf', [vault.address, ZeroAddress]), 1000n * ZETA);
  assert.equal(await br.call('protocolCount'), 1n);
  await assert.rejects(vault.send('pgov', 'optIn', [br.iface.encodeFunctionData('register', [policyTuple(policy)])])); // AlreadyRegistered
  for (const bad of [
    { quorum: 2 },                     // below minQuorum
    { quorum: 17 },
    { maxPause: 4 * 86400 },           // above MAX_PAUSE (3 days)
    { maxPause: 60 },                  // below MIN_PAUSE
    { window: 10 },
    { tripCapBps: 10_001 },
    { invariantMask: 8 },              // bit outside the 3 selectors
    { selectors: [SEL.deposit, SEL.deposit] },
    { caps: [0n] },
    { assets: [ZeroAddress, ZeroAddress], caps: [1n, 1n] },
    { governance: ZeroAddress },
    { holdReview: 8 * 86400 },
  ]) await assert.rejects(br.send('outsider', 'register', [policyTuple(basePolicy(bad))]), /BadPolicy/, JSON.stringify(bad, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
});

test('policy changes and opt-out wait POLICY_DELAY, only by the protocol governance, never while tripped', async () => {
  const loose = basePolicy({ caps: [5000n * ZETA] });
  await assert.rejects(br.send('outsider', 'proposePolicy', [vault.address, policyTuple(loose)]), /NotProtocolGovernance/);
  await br.send('pgov', 'proposePolicy', [vault.address, policyTuple(loose)]);
  await assert.rejects(br.send('outsider', 'applyPolicy', [vault.address]), /TooEarly/);
  c.advance(2 * 86400);
  await trip();
  await assert.rejects(br.send('outsider', 'applyPolicy', [vault.address]), /IsTripped/);
  await br.send('pgov', 'release', [vault.address]);
  await br.send('outsider', 'applyPolicy', [vault.address]);
  assert.equal(await br.call('capOf', [vault.address, ZeroAddress]), 5000n * ZETA);
  await br.send('pgov', 'proposeOptOut', [vault.address]);
  await assert.rejects(br.send('outsider', 'optOut', [vault.address]), /TooEarly/);
  c.advance(2 * 86400);
  await br.send('outsider', 'optOut', [vault.address]);
  assert.equal((await br.call('policyOf', [vault.address])).governance, ZeroAddress);
  assert.equal(await br.call('capOf', [vault.address, ZeroAddress]), 0n);
  await vault.send('user', 'withdrawAll'); // nothing recorded, nothing paused
});

// ---------------------------------------------------------------- quorum, eligibility, freshness

test('k-of-n: 3 eligible guardians trip it; fewer, outsiders, unsorted, duplicates and bad signatures do not', async () => {
  const e = evidence();
  await assert.rejects(trip([0, 1], e), /NoQuorum/);
  const [s, g] = await signed([0, 1, 2], e);
  await assert.rejects(br.send('outsider', 'tripWithSignatures', [vault.address, evTuple(e), [s[1], s[0], s[2]], [g[1], g[0], g[2]]]), /NotSorted/);
  await assert.rejects(br.send('outsider', 'tripWithSignatures', [vault.address, evTuple(e), [s[0], s[0], s[1]], [g[0], g[0], g[1]]]), /NotSorted/);
  await assert.rejects(br.send('outsider', 'tripWithSignatures', [vault.address, evTuple(e), s, [g[0], g[2], g[1]]]), /BadSignature/);
  await assert.rejects(trip([0, 1, 5], e), /NotEligible/); // r5: a NeuroJobs runner without a guardian bond
  const tampered = { ...e, mask: BIT.withdraw | BIT.withdrawAll };
  await assert.rejects(br.send('outsider', 'tripWithSignatures', [vault.address, evTuple(tampered), s, g]), /BadSignature/); // signatures cover the mask
  assert.equal(await br.call('isTripped', [vault.address]), false);
  const ev = await br.send('outsider', 'tripWithSignatures', [vault.address, evTuple(e), s, g]);
  assert.ok(ev.some((x) => x?.name === 'Tripped'));
  assert.equal(await br.call('isTripped', [vault.address]), true);
  const t = await br.call('tripOf', [0]);
  assert.deepEqual([...t.runners].map(getAddress), s);
  assert.equal(t.evidenceHash, e.evidenceHash);
});

test('the local digest (detect.js) equals the contract\'s', async () => {
  const e = evidence();
  const onchain = await br.call('digest', [vault.address, evTuple(e)]);
  assert.equal(tripDigest({ chainId: 1n, breaker: br.address, protocol: vault.address, epoch: 0n, ...e }), onchain);
});

test('eligibility reuses NeuroJobs: an unbonded runner, an exiting guardian and a low track record do not count', async () => {
  await jobs.send('r2', 'requestUnbond');
  await assert.rejects(trip([0, 1, 2]), /NotEligible/);
  await br.send('r3', 'requestExit');
  await assert.rejects(trip([0, 1, 3]), /NotEligible/);
  await assert.rejects(br.send('outsider', 'joinGuardians', [], GB), /NotEligible/); // not a runner at all
  await br.send('gov', 'setParams', [GB, CB, 3, 1, 5000]); // minAgreed 1: nobody has an accepted verdict yet
  assert.equal(await br.call('eligible', [KEYS[0].address]), false);
  await assert.rejects(trip([0, 1, 4]), /NotEligible/);
});

test('on-chain attestations (any account type, e.g. ML-DSA through MsgEVMCall) reach the same quorum', async () => {
  const e = evidence();
  assert.deepEqual(await br.send('r0', 'attest', [vault.address, evTuple(e)]).then((x) => x.find((y) => y?.name === 'Tripped')), undefined);
  await assert.rejects(br.send('r0', 'attest', [vault.address, evTuple(e)]), /AlreadyAttested/);
  await assert.rejects(br.send('r5', 'attest', [vault.address, evTuple(e)]), /NotEligible/);
  await br.send('r1', 'attest', [vault.address, evTuple(e)]);
  assert.equal(await br.call('isTripped', [vault.address]), false);
  const ev = await br.send('r2', 'attest', [vault.address, evTuple(e)]);
  assert.ok(ev.some((x) => x?.name === 'Tripped'));
  assert.equal(await br.call('isTripped', [vault.address]), true);
});

test('an attester that stops being eligible does not count when the quorum forms', async () => {
  const e = evidence({ fromBlock: Number(c.blockNumber()) - 1, toBlock: Number(c.blockNumber()) - 1 });
  await br.send('r0', 'attest', [vault.address, evTuple(e)]);
  await br.send('r1', 'attest', [vault.address, evTuple(e)]);
  await br.send('r0', 'requestExit');
  await br.send('r2', 'attest', [vault.address, evTuple(e)]); // 3 attestations, 2 eligible
  assert.equal(await br.call('isTripped', [vault.address]), false);
  await br.send('r3', 'attest', [vault.address, evTuple(e)]);
  assert.equal(await br.call('isTripped', [vault.address]), true);
  assert.equal((await br.call('tripOf', [0])).runners.length, 3);
});

test('evidence must be fresh: recent, a bounded range, after the last trip, never reused, mask within the policy', async () => {
  const now = Number(c.blockNumber());
  await assert.rejects(trip([0, 1, 2], evidence({ fromBlock: now - 1, toBlock: now + 5 })), /StaleEvidence/); // the future
  await assert.rejects(trip([0, 1, 2], evidence({ fromBlock: now - 100, toBlock: now - 100 })), /StaleEvidence/); // older than 64 blocks
  await assert.rejects(trip([0, 1, 2], evidence({ fromBlock: now - 1, toBlock: now - 3 })), /StaleEvidence/);
  await assert.rejects(trip([0, 1, 2], evidence({ evidenceHash: ZeroHash })), /StaleEvidence/);
  await assert.rejects(trip([0, 1, 2], evidence({ mask: 8 })), /BadMask/);
  const e = evidence();
  await trip([0, 1, 2], e);
  await br.send('pgov', 'release', [vault.address]);
  await assert.rejects(trip([0, 1, 2], { ...e }), /StaleEvidence/); // same range as the last trip
  const b = Number(c.blockNumber()) - 1;
  await assert.rejects(trip([0, 1, 2], { ...e, fromBlock: b, toBlock: b }), /UsedEvidence/); // same evidence hash
  await trip([0, 1, 2], evidence()); // fresh range, fresh hash
  assert.equal(await br.call('tripCount'), 2n);
});

// ---------------------------------------------------------------- narrow, time-boxed effects

test('a trip is narrow: only the masked selector stops; deposits and the correct withdraw keep working (rate-limited)', async () => {
  await trip([0, 1, 2], evidence({ mask: BIT.withdrawAll }));
  assert.equal(await br.call('isPaused', [vault.address, SEL.withdrawAll]), true);
  assert.equal(await br.call('isPaused', [vault.address, SEL.withdraw]), false);
  await assert.rejects(vault.send('user', 'withdrawAll'), /SelectorTripped/);
  await vault.send('user', 'deposit', [], ZETA);
  const before = await c.balance('user');
  await vault.send('user', 'withdraw', [10n * ZETA]);
  assert.equal(await c.balance('user') - before, 10n * ZETA);
  // while tripped: single outflows above holdAbove (50) are held, and the window cap is cut to 10% (100)
  await vault.send('user', 'withdraw', [60n * ZETA]);
  assert.equal(await vault.call('heldCount'), 1n);
  for (let i = 0; i < 4; i++) await vault.send('user2', 'withdraw', [20n * ZETA]); // 10 + 80 = 90 of 100
  await vault.send('user2', 'withdraw', [20n * ZETA]); // would be 110 > 100: held
  assert.equal(await vault.call('heldCount'), 2n);
  const f = await br.call('flowOf', [vault.address, ZeroAddress]);
  assert.ok(f.used <= 100n * ZETA, 'the tripped cap held');
  // another protocol is never affected
  assert.equal(await br.call('isTripped', [A('outsider')]), false);
});

test('a trip always expires by itself (maxPause); the protocol governance may end it earlier; the timelock may veto', async () => {
  await trip();
  const t = await br.call('tripOf', [0]);
  assert.equal(t.until - t.start, 3600n);
  c.advance(3599);
  assert.equal(await br.call('isTripped', [vault.address]), true);
  c.advance(1);
  assert.equal(await br.call('isTripped', [vault.address]), false);
  await vault.send('user', 'withdrawAll');
  await trip();
  await assert.rejects(br.send('outsider', 'release', [vault.address]), /NotProtocolGovernance/);
  await assert.rejects(br.send('pgov', 'veto', [vault.address]), /NotGovernance/);
  await br.send('pgov', 'release', [vault.address]);
  assert.equal(await br.call('isTripped', [vault.address]), false);
  await assert.rejects(br.send('pgov', 'release', [vault.address]), /NotTripped/);
  c.advance(10);
  await trip();
  await br.send('gov', 'veto', [vault.address]);
  assert.equal(await br.call('isTripped', [vault.address]), false);
});

test('streak: at most 3 trips in a row before the protocol governance rearms; a quiet period resets it', async () => {
  for (let i = 0; i < 3; i++) { await trip(); c.advance(3600); }
  await assert.rejects(trip(), /StreakLimit/);
  await br.send('pgov', 'rearm', [vault.address]);
  await trip();
  c.advance(3600 + 3601); // ends, then a quiet maxPause
  await trip();
  assert.equal(await br.call('streak', [vault.address]), 1n);
});

test('governance has no pause power: it can set bounded params, veto and judge, nothing else', async () => {
  const fns = br.iface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
  assert.deepEqual(fns, ['applyPolicy', 'attest', 'claimFalse', 'exit', 'expireClaim', 'flushBurn', 'joinGuardians', 'optOut', 'proposeOptOut', 'proposePolicy', 'rearm', 'recordOutflow', 'register', 'release', 'requestExit', 'resolveClaim', 'setGovernance', 'setParams', 'tripWithSignatures', 'veto', 'withdraw']);
  await assert.rejects(br.send('gov', 'setParams', [GB, CB, 1, 0, 5000]), /BadValue/);       // quorum >= 2
  await assert.rejects(br.send('gov', 'setParams', [GB, CB, 3, 0, 5001]), /BadValue/);       // slash <= 50%
  await assert.rejects(br.send('outsider', 'setParams', [GB, CB, 3, 0, 5000]), /NotGovernance/);
  await assert.rejects(br.send('gov', 'veto', [vault.address]), /NotTripped/);
});

// ---------------------------------------------------------------- the on-chain invariant

test('invariant: an outflow over the window cap is held (not reverted) and trips the breaker by itself', async () => {
  const atk = await c.deployRaw(kit.HealAttacker, [vault.address], 'attacker');
  // cap 1000/window; the attacker re-enters withdrawAll: 50 x 25 = 1250 would leave
  await atk.send('attacker', 'attack', [24], 50n * ZETA);
  assert.equal(await br.call('isTripped', [vault.address]), true);
  const t = await br.call('tripOf', [0]);
  assert.equal(t.kind, 1n); // Invariant
  assert.equal(t.mask, BigInt(BIT.withdrawAll));
  assert.equal(t.runners.length, 0);
  const f = await br.call('flowOf', [vault.address, ZeroAddress]);
  assert.ok(f.used <= 1000n * ZETA, 'never more than the cap left in the window');
  assert.equal(await c.balance(Address.fromString(atk.address)), 1000n * ZETA);
  assert.equal(await vault.call('heldCount'), 1n);
  await assert.rejects(atk.send('attacker', 'attack', [24], 50n * ZETA)); // withdrawAll is paused now
});

test('held outflows: the protocol governance cancels (funds stay); otherwise anyone pays them after the trip and the review', async () => {
  await trip();
  await vault.send('user', 'withdraw', [60n * ZETA]); // held (above holdAbove while tripped)
  await vault.send('user2', 'withdraw', [70n * ZETA]); // held
  await assert.rejects(vault.send('outsider', 'releaseHeld', [0]), /HeldNotReady/); // still tripped
  await assert.rejects(vault.send('outsider', 'cancelHeld', [1]), /NotPolicyGovernance/);
  await vault.send('pgov', 'cancelHeld', [1]);
  c.advance(3599);
  await assert.rejects(vault.send('outsider', 'releaseHeld', [0]), /HeldNotReady/); // still tripped
  c.advance(1); // the trip ended; held more than holdReview (600 s) ago
  const before = await c.balance('user');
  await vault.send('outsider', 'releaseHeld', [0]);
  assert.equal(await c.balance('user') - before, 60n * ZETA);
  await assert.rejects(vault.send('outsider', 'releaseHeld', [0]), /HeldNotReady/);
  await assert.rejects(vault.send('outsider', 'releaseHeld', [1]), /HeldNotReady/); // cancelled
});

// ---------------------------------------------------------------- false trips: claims, slashing, compensation

test('a false trip proven by the timelock slashes the signers and compensates the protocol', async () => {
  await trip([0, 1, 2]);
  await assert.rejects(br.send('outsider', 'claimFalse', [0], CB), /NotProtocolGovernance/);
  await assert.rejects(br.send('pgov', 'claimFalse', [0], CB - 1n), /BadValue/);
  await br.send('pgov', 'claimFalse', [0], CB);
  await assert.rejects(br.send('pgov', 'claimFalse', [0], CB), /BadClaim/);
  // the signers cannot run away with their bonds meanwhile
  await br.send('r0', 'requestExit');
  c.advance(30 * 86400);
  await assert.rejects(br.send('r0', 'exit'), /Locked/);
  await assert.rejects(br.send('pgov', 'resolveClaim', [0, true]), /NotGovernance/);
  const ev = await br.send('gov', 'resolveClaim', [0, true]);
  assert.equal(ev.filter((x) => x?.name === 'Slashed').length, 3);
  for (const i of [0, 1, 2]) assert.equal((await br.call('guardians', [KEYS[i].address])).bond, GB / 2n);
  assert.equal((await br.call('guardians', [KEYS[3].address])).bond, GB, 'non-signers untouched');
  const slashed = 3n * GB / 2n;
  assert.equal(await br.call('owed', [A('pgov')]), slashed * 8000n / 10000n + CB);
  assert.equal(await br.call('owed', ['0x000000000000000000000000000000000000dEaD']), slashed - slashed * 8000n / 10000n);
  assert.equal(await br.call('eligible', [KEYS[1].address]), false, 'below the guardian bond: must top up');
  await br.send('r0', 'exit');
  assert.equal(await br.call('owed', [KEYS[0].address]), GB / 2n);
});

test('a rejected claim pays its bond to the signers; an unjudged claim expires with its bond refunded', async () => {
  await trip([0, 1, 2]);
  await br.send('pgov', 'claimFalse', [0], CB);
  await br.send('gov', 'resolveClaim', [0, false]);
  for (const i of [0, 1, 2]) assert.equal(await br.call('owed', [KEYS[i].address]), CB / 3n);
  await br.send('pgov', 'release', [vault.address]);
  await trip([2, 3, 4]);
  await br.send('pgov', 'claimFalse', [1], CB);
  await assert.rejects(br.send('outsider', 'expireClaim', [1]), /BadClaim/);
  c.advance(14 * 86400);
  await br.send('outsider', 'expireClaim', [1]);
  assert.equal(await br.call('owed', [A('pgov')]), CB);
  assert.equal((await br.call('guardians', [KEYS[3].address])).bond, GB);
  // claims are only for runner trips, within the claim window
  c.advance(8 * 86400);
  await assert.rejects(br.send('pgov', 'claimFalse', [1], CB), /BadClaim/);
});

test('the timelock (ZetaphyTimelock) is the only override: veto and judging wait its delay; no EOA can do either', async () => {
  const DELAY = 1800n; // shorter than the trip (maxPause 3600)
  const tl = await c.deploy('ZetaphyTimelock', [DELAY, [A('gov')], [ZeroAddress], ZeroAddress], 'gov');
  await br.send('gov', 'setGovernance', [tl.address]);
  const govern = async (fn, args) => {
    const data = br.iface.encodeFunctionData(fn, args);
    await tl.send('gov', 'schedule', [br.address, 0, data, ZeroHash, H(fn), DELAY]);
    await assert.rejects(tl.send('outsider', 'execute', [br.address, 0, data, ZeroHash, H(fn)])); // not ready
    c.advance(Number(DELAY));
    return tl.send('outsider', 'execute', [br.address, 0, data, ZeroHash, H(fn)]);
  };
  await trip();
  await assert.rejects(br.send('gov', 'veto', [vault.address]), /NotGovernance/);
  // the protocol governance releases at once if it wants to; the timelock's veto waits the delay
  await govern('veto', [vault.address]);
  assert.equal(await br.call('isTripped', [vault.address]), false);
});

// ---------------------------------------------------------------- randomized invariants

test('invariants over random sequences: trips expire within maxPause, the cap holds, no trip below quorum, only masked selectors pause', async () => {
  let seed = 12345n;
  const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return Number((seed >> 20n) % BigInt(n)); };
  const MAXP = 3600n;
  const pick = (k) => { const all = [0, 1, 2, 3, 4]; const out = []; while (out.length < k) { const i = all.splice(rnd(all.length), 1)[0]; out.push(i); } return out; };
  let belowQuorumRefused = 0;
  for (let step = 0; step < 120; step++) {
    const k = rnd(8);
    if (k === 0) {
      await assert.rejects(trip(pick(1 + rnd(2)), evidence()), /NoQuorum|IsTripped/);
      belowQuorumRefused += 1;
    } else {
      try {
        if (k === 1) await trip(pick(3 + rnd(3)), evidence({ mask: rnd(8) }));
        else if (k === 2) c.advance(rnd(2400));
        else if (k === 3) await vault.send(rnd(2) ? 'user' : 'user2', 'withdraw', [BigInt(1 + rnd(80)) * ZETA]);
        else if (k === 4) await vault.send(rnd(2) ? 'user' : 'user2', 'deposit', [], BigInt(1 + rnd(80)) * ZETA);
        else if (k === 5) await br.send('pgov', 'release', [vault.address]);
        else if (k === 6) await br.send('pgov', 'rearm', [vault.address]);
        else await vault.send('outsider', 'releaseHeld', [rnd(Number(await vault.call('heldCount')) || 1)]);
      } catch { /* refused actions are fine; the invariants below must still hold */ }
    }
    const n = await br.call('tripCount');
    if (await br.call('isTripped', [vault.address])) {
      const t = await br.call('tripOf', [n - 1n]);
      assert.ok(c.now() < t.start + MAXP && t.until <= t.start + MAXP, 'a live trip ends within maxPause');
      for (const [i, s] of [SEL.deposit, SEL.withdraw, SEL.withdrawAll].entries()) assert.equal(await br.call('isPaused', [vault.address, s]), ((Number(t.mask) >> i) & 1) === 1);
    } else {
      for (const s of Object.values(SEL)) assert.equal(await br.call('isPaused', [vault.address, s]), false);
    }
    const f = await br.call('flowOf', [vault.address, ZeroAddress]);
    assert.ok(f.used <= 1000n * ZETA, 'the window cap holds');
    for (let i = 0n; i < n; i++) { const t = await br.call('tripOf', [i]); assert.ok(t.until - t.start <= MAXP); if (t.kind === 0n) assert.ok(t.runners.length >= 3); }
  }
  assert.ok(belowQuorumRefused > 5);
  assert.ok(await br.call('tripCount') > 3n, 'the sequence did trip');
});
