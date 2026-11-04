// The live security score (docs/future/immune-score.md, S10/SS7): SecurityScore reads the certificate, open
// post-certificate findings, the circuit breaker, Neuro's score, confirmed exploits, vaccine matches and threat flags,
// and computes 0..1000 with the documented formula; ScoredCollateral turns it into a collateral factor and a pool limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, AbiCoder, ZeroAddress, getCreateAddress } from 'ethers';
import { readFileSync } from 'node:fs';
import { ZETA } from './helpers/evm.js';
import { auditWorld, fullRound, lateFinding, vote, kit, DAY, codeHashOf } from './helpers/auditworld.js';

const abi = AbiCoder.defaultAbiCoder();
const V = () => kit('VaccineKit.sol');
const K = () => kit('ScoreKit.sol');
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const addrKey = (chainId, a) => keccak256(abi.encode(['string', 'uint256', 'address'], ['zetaphy.threat.address', BigInt(chainId), a]));
const TIERS = [{ minScore: 400, factorBps: 4000 }, { minScore: 600, factorBps: 6000 }, { minScore: 800, factorBps: 7500 }];

async function setup() {
  const w = await auditWorld({ extra: ['w1', 'w2', 'other', 'protocolGov'] });
  const { c, A } = w;
  const threats = await c.deploy('ThreatRegistry', [w.jobs.address, 2, 1, A('gov'), 3600], 'gov');
  for (const r of ['w1', 'w2']) await w.jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const vac = await c.deploy('ImmuneVaccines', [w.net.address, w.cert.address, ZeroAddress, threats.address, A('gov')], 'gov');
  await threats.send('gov', 'setVaccines', [vac.address]);
  const neuro = await c.deployRaw(K().KitNeuro, [], 'gov');
  const breaker = await c.deployRaw(K().KitBreaker, [], 'gov');
  const feed = await c.deployRaw(K().KitFeed, [], 'gov');
  const score = await c.deploy('SecurityScore', [w.cert.address, w.net.address, breaker.address, neuro.address, vac.address, threats.address, feed.address], 'gov');
  const coll = await c.deploy('ScoredCollateral', [score.address, A('gov'), TIERS], 'gov');
  return { ...w, threats, vac, neuro, breaker, feed, score, coll };
}

const S = (s, a, chainId = 1n) => s.score.call('score', [chainId, a]).then(Number);
const B = (s, a, chainId = 1n) => s.score.call('breakdown', [chainId, a]);

test('the formula: certificate, Neuro, monitoring, history, open findings, the breaker, flags; the collateral factor and pool limit follow it live', async () => {
  const s = await setup();
  const t = await s.c.deployRaw(V().PlainVault, [], 'other');
  assert.equal(await S(s, t.address), 350, 'nothing known: Neuro unknown 100 + clean history 250');
  await s.neuro.send('gov', 'set', [t.address, true, 0]);
  await s.breaker.send('gov', 'register', [t.address, s.A('protocolGov')]);
  assert.equal(await S(s, t.address), 600, '+ Neuro low risk 200 (instead of 100) + monitored 150');
  assert.equal(Number(await s.coll.call('collateralFactorBps', [t.address])), 6000);
  // certified (Bronze: two auditors, three days)
  const { id } = await fullRound(s, { target: t.address, codeHash: codeHashOf(await s.c.getCode(t.address)) });
  await s.cert.send('x', 'certify', [id]);
  let b = await B(s, t.address);
  assert.deepEqual([Number(b.score), Number(b.certificate), Number(b.neuro), Number(b.monitoring), Number(b.history), Number(b.level), Number(b.cap)], [850, 250, 200, 150, 250, 1, 1000]);
  assert.equal(Number(await s.coll.call('collateralFactorBps', [t.address])), 7500);
  assert.equal(await s.coll.call('maxBorrow', [t.address, 1000n * ZETA]), 750n * ZETA);
  assert.equal(await s.coll.call('poolLimit', [t.address, 7000n]), 5500n, '7000 x (850 - 300) / 700');
  // an open post-certificate finding claiming high: -100 while undecided; judged invalid: back
  const fid = await lateFinding(s, id, { sev: 4, valid: null, text: 'maybe a bug' });
  b = await B(s, t.address);
  assert.deepEqual([Number(b.score), Number(b.openFindings)], [750, 1]);
  assert.equal(Number(await s.coll.call('collateralFactorBps', [t.address])), 6000);
  await vote(s, ['j1', 'j2', 'j3'], 'voteFinding', [fid, false, 0, fid]);
  assert.equal(await S(s, t.address), 850);
  // the breaker: -300 while tripped, -100 for 30 days after, nothing once proven false
  await s.breaker.send('gov', 'trip', [t.address, 3600]);
  assert.equal((await B(s, t.address)).tripped, true);
  assert.equal(await S(s, t.address), 550);
  s.c.advance(7200);
  assert.equal(await S(s, t.address), 749, '-100 for a recent trip; the certificate is 2 hours older: 249');
  await s.breaker.send('gov', 'provenFalse', [t.address]);
  assert.equal(await S(s, t.address), 849);
  // the immune feed: suspicious caps at 400, high at 100, critical at 0
  for (const [sev, want] of [[2, 400], [3, 100], [4, 0], [0, 849]]) {
    await s.feed.send('gov', 'set', [t.address, sev]);
    assert.equal(await S(s, t.address), want, `immune severity ${sev}`);
  }
  // freshness: half the validity gone (15 days after the certificate; 2 hours already passed) -> 125 + 62
  s.c.advance(15 * DAY - 7200);
  assert.equal(Number((await B(s, t.address)).certificate), 187);
  // a valid post-certificate critical revokes it: cap 200; the vaccine from it adds a recent exploit: cap 150
  await lateFinding(s, id, { who: 'a4', sev: 5, text: 'drain', n: 9 });
  b = await B(s, t.address);
  assert.deepEqual([Number(b.score), Number(b.certificate), Number(b.cap)], [200, 0, 200]);
  await s.vac.send('x', 'vaccinateFromRevocation', [1n, t.address]);
  b = await B(s, t.address);
  assert.deepEqual([Number(b.score), Number(b.history), Number(b.exploits), Number(b.cap)], [150, 125, 1, 150]);
  assert.equal(Number(await s.coll.call('collateralFactorBps', [t.address])), 0, 'worth nothing as collateral');
  assert.equal(await s.coll.call('poolLimit', [t.address, 7000n]), 0n);
  // 30 days later the cap of a recent exploit is gone; the history still costs
  s.c.advance(31 * DAY);
  assert.equal(await S(s, t.address), 200, 'revoked: still capped at 200');
});

test('flags and vaccine matches: a ThreatRegistry flag caps at 100 and its enforcement at 0; an exact copy of exploited code is capped at 100, a look-alike loses 150', async () => {
  const s = await setup();
  const t = await s.c.deployRaw(V().PlainVault, [], 'other');
  await s.threats.send('w1', 'vote', [addrKey(1, t.address), true, 7, keccak256('0x01'), '']);
  await s.threats.send('w2', 'vote', [addrKey(1, t.address), true, 7, keccak256('0x01'), '']);
  let b = await B(s, t.address);
  assert.deepEqual([Number(b.score), b.flagged], [100, true]);
  s.c.advance(3600);
  assert.equal(await S(s, t.address), 0, 'enforced');
  // an exploit confirmed by the audit network, a copy and a look-alike on chain
  const leaky = await s.c.deployRaw(V().LeakyVault, [], 'other');
  const { fids } = await fullRound(s, { target: leaky.address, codeHash: codeHashOf(await s.c.getCode(leaky.address)), findings: [{ who: 'a1', sev: 5, text: 'reentrancy' }], decide: [{ valid: true, sev: 5 }], settle: false });
  await s.vac.send('x', 'vaccinateFromFinding', [fids[0]]);
  const id = await s.vac.call('ids', [0n]);
  b = await B(s, leaky.address);
  assert.deepEqual([Number(b.score), Number(b.exploits), Number(b.cap)], [150, 1, 150], 'the exploited contract itself');
  const copy = await s.c.deployRaw(V().LeakyVault, [], 'other');
  const look = await s.c.deployRaw(V().LeakyVaultFixed, [], 'other');
  assert.equal(await S(s, copy.address), 350);
  await s.vac.send('x', 'checkMatch', [id, copy.address]);
  await s.vac.send('x', 'checkMatch', [id, look.address]);
  b = await B(s, copy.address);
  assert.deepEqual([Number(b.score), Number(b.vaccineMatch), b.held, Number(b.cap)], [100, 3, true, 100]);
  b = await B(s, look.address);
  assert.deepEqual([Number(b.score), Number(b.vaccineMatch), Number(b.penalty)], [200, 1, 150]);
  // another chain's contract: what is known there (no Neuro, no breaker, no local code)
  assert.equal(await S(s, '0x' + '77'.repeat(20), 5n), 350);
});

test('a broken source degrades the score (cap 500) instead of reverting; refresh stores and announces it', async () => {
  const s = await setup();
  const broken = await s.c.deployRaw(K().KitBroken, [], 'gov');
  const score2 = await s.c.deploy('SecurityScore', [broken.address, broken.address, s.breaker.address, s.neuro.address, s.vac.address, s.threats.address, s.feed.address], 'gov');
  const t = await s.c.deployRaw(V().PlainVault, [], 'other');
  await s.neuro.send('gov', 'set', [t.address, true, 0]);
  await s.breaker.send('gov', 'register', [t.address, s.A('protocolGov')]);
  assert.equal(await S(s, t.address), 600);
  const b = await score2.call('breakdown', [1n, t.address]);
  assert.deepEqual([Number(b.score), b.degraded, Number(b.cap)], [500, true, 500]);
  const ev = await s.score.send('x', 'refresh', [1n, t.address]);
  const e = ev.find((x) => x?.name === 'ScoreUpdated');
  assert.deepEqual([Number(e.args.score), Number(e.args.cap)], [600, 1000]);
  const [cs, at] = await s.score.call('cached', [1n, t.address]);
  assert.deepEqual([Number(cs), at], [600, s.c.now()]);
  const g = await s.score.gas('x', 'score', [1n, t.address]);
  assert.ok(g.exec < 600_000, `a live read costs ${g.exec} gas`);
});

test('collateral tiers are governance\'s (the timelock) inside fixed bounds: anything capped at 300 or less is never collateral', async () => {
  const s = await setup();
  await assert.rejects(s.coll.send('x', 'setTiers', [TIERS]), /NotGovernance/);
  for (const bad of [
    [], [{ minScore: 300, factorBps: 1000 }], [{ minScore: 500, factorBps: 9000 }],
    [{ minScore: 500, factorBps: 5000 }, { minScore: 500, factorBps: 6000 }], [{ minScore: 500, factorBps: 5000 }, { minScore: 600, factorBps: 4000 }],
    Array.from({ length: 5 }, (_, i) => ({ minScore: 400 + i * 100, factorBps: 1000 })), [{ minScore: 1001, factorBps: 1000 }],
  ]) await assert.rejects(s.coll.send('gov', 'setTiers', [bad]), /BadTiers/, JSON.stringify(bad));
  await s.coll.send('gov', 'setTiers', [[{ minScore: 301, factorBps: 100 }, { minScore: 900, factorBps: 8500 }]]);
  for (const [sc, f] of [[0, 0], [100, 0], [150, 0], [200, 0], [300, 0], [301, 100], [899, 100], [900, 8500], [1000, 8500]]) assert.equal(Number(await s.coll.call('factorFor', [sc])), f, `score ${sc}`);
  await assert.rejects(s.coll.send('x', 'setGovernance', [s.A('x')]), /NotGovernance/);
});

test('the interfaces SecurityScore reads are the real contracts\' (artifacts): NeuroScore, CircuitBreaker, ImmuneRegistry/Mirror, ThreatRegistry, AuditNetwork, AuditCertificate, ImmuneVaccines', () => {
  const pairs = [
    ['NeuroScore', 'scoreOf'], ['CircuitBreaker', 'policyGovernance'], ['CircuitBreaker', 'isTripped'], ['CircuitBreaker', 'lastTrip'], ['CircuitBreaker', 'tripOf'],
    ['ImmuneRegistry', 'isFlagged'], ['ImmuneRegistry', 'isCodeFlagged'], ['ImmuneMirror', 'isFlagged'], ['ImmuneMirror', 'isCodeFlagged'],
    ['ThreatRegistry', 'isAddressFlagged'], ['ThreatRegistry', 'isAddressEnforced'], ['ThreatRegistry', 'isCodeFlagged'], ['ThreatRegistry', 'isCodeEnforced'], ['ThreatRegistry', 'underReview'],
    ['AuditNetwork', 'findingsOf'], ['AuditNetwork', 'getFinding'], ['AuditCertificate', 'certificate'], ['AuditCertificate', 'revokedCode'],
    ['ImmuneVaccines', 'exploitsOf'], ['ImmuneVaccines', 'matchOf'],
  ];
  // what SecurityScore's own interfaces declare (taken from its compiled kit stand-ins and the real contracts)
  const kitAbi = { NeuroScore: K().KitNeuro.abi, CircuitBreaker: K().KitBreaker.abi, ImmuneRegistry: K().KitFeed.abi, ImmuneMirror: K().KitFeed.abi };
  const shape = (f) => `${f.name}(${f.inputs.map((i) => i.type).join(',')})->${JSON.stringify(f.outputs.map((o) => [o.type, (o.components ?? []).map((x) => x.type)]))}`;
  for (const [c, fn] of pairs) {
    const real = art(c).abi.find((x) => x.type === 'function' && x.name === fn);
    assert.ok(real, `${c}.${fn} exists`);
    if (kitAbi[c]) assert.equal(shape(kitAbi[c].find((x) => x.name === fn)), shape(real), `${c}.${fn}: the test stand-in has the real shape`);
  }
  // SecurityScore decodes enums as uint8 (CircuitBreaker.Trip.kind / claim): the same ABI words
  const trip = art('CircuitBreaker').abi.find((x) => x.name === 'tripOf').outputs[0].components;
  assert.deepEqual(trip.map((x) => x.type), ['address', 'uint8', 'uint8', 'uint16', 'uint64', 'uint64', 'uint64', 'uint64', 'uint64', 'bytes32', 'bytes32', 'uint256', 'address[]']);
});
