// The Web3 immune system end to end (docs/future/immune-network.md): an attack on chain A (Sepolia, seen by a
// sentinel through the mock multi-chain) -> k-of-n bonded runners agree in NeuroJobs -> ImmuneRegistry on ZETAPHY
// -> ImmuneBroadcaster -> Hyperlane (our validators' ISM) -> ImmuneMirror on B and C -> the ImmuneGuard router on B
// refuses the attacker; the vaccine shipped with the flag catches a clone deployed on C; a false flag is challenged,
// its runners slashed and the flag lifted everywhere. Latencies are simulated seconds (helpers/immunesim.js).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { runScenario, setupNetwork, chainSend, IDS, immuneKit } from './helpers/immunesim.js';
import { findingHash, findingTuple, clearHash, keysOf, addressKey, codeKey, accountKey, chainTag } from '../src/immune/agree.js';
import { ibcMemo, simulate, MAX_ITEMS } from '../src/immune/propagate.js';
import { feedFiles, verifySnapshot } from '../src/immune/feed.js';
import { createImmune, watchFlags } from '../src/immune/sdk.js';
import { pqFromSeed } from '../src/pq.js';
import { parseMemo } from '../src/neurooracle.js';

let S;
before(async () => { S = await runScenario(); });

test('e2e: attack on A is detected, agreed by bonded runners, and mirrored to B and C; latencies reported', () => {
  assert.ok(S.stages.detect > 0 && S.stages.detect <= 12, `detect ${S.stages.detect}s`);
  assert.ok(S.stages.agree > 0 && S.stages.agree <= 120, `agree ${S.stages.agree}s`);
  for (const n of ['B', 'C']) assert.ok(S.mirrors[n].total > 0 && S.mirrors[n].total <= 180, `${n}: ${S.mirrors[n].total}s`);
  console.log(`  latency (simulated s): detect ${S.stages.detect}, agree ${S.stages.agree} (2 jobs), registry ${S.stages.registry}, `
    + `mirror B +${S.mirrors.B.mirror} (total ${S.mirrors.B.total}), mirror C +${S.mirrors.C.mirror} (total ${S.mirrors.C.total}); median ${S.median}`);
  console.log(`  clone on C caught: detect ${S.clone.detect}s, on C's mirror ${S.clone.total}s after its deployment; false flag corrected in ${S.falseFlag.secondsToCorrect}s`);
  console.log(`  broadcast gas (KitMailbox, stores each message): ${S.gas.broadcast.gas} for ${S.gas.broadcast.items} keys x ${S.gas.broadcast.routes} routes`);
});

test('e2e: the ImmuneGuard router on B refuses the attacker (flagged on every EVM chain) and still pays an honest user', () => {
  assert.deepEqual(S.routerB, { refusedAttacker: true, paidUser: true });
});

test('e2e: the vaccine rides with the flag and catches a modified clone deployed on C; C refuses to pay it', () => {
  assert.equal(S.clone.vaccineOnMirror, true);
  assert.equal(S.clone.flaggedOnC, true);
  assert.equal(S.clone.routerCRefuses, true);
  assert.match(S.clone.how, /similar match/);
});

test('e2e: a false flag by two colluding runners is challenged, overturned, slashed 50% and lifted on the mirrors', () => {
  const f = S.falseFlag;
  assert.equal(f.flaggedThenOnB, true, 'the quorum alone can flag (provisional)');
  assert.equal(f.honestRunnerRejected, true);
  assert.equal(f.challengeState, 3, 'Overturned');
  for (const s of f.slashed) assert.equal(s.after, s.before / 2n);
  assert.equal(f.clearedOnB, true);
  assert.equal(f.routerBPaysUserAgain, true);
});

test('registry: findingHash, keys and items match the JS side; a job is used once; outsiders cannot flag', async () => {
  const { net, reports } = S;
  const r = reports.exploit;
  assert.equal(await net.registry.call('findingHash', [findingTuple(r.finding)]), findingHash(r.finding));
  assert.equal(await net.registry.call('clearHash', [S.keys.exploit[0], 3]), clearHash(S.keys.exploit[0], 3));
  assert.equal(await net.registry.call('codeKey', [r.finding.codeHash]), codeKey(r.finding.codeHash));
  assert.equal(await net.registry.call('addressKey', [0, S.net.attacker]), addressKey(0, S.net.attacker));
  const sol = '0x' + 'ab'.repeat(32);
  assert.equal(await net.registry.call('accountKey', [IDS.A, sol]), accountKey(IDS.A, sol));
  assert.deepEqual(keysOf(r.finding), S.keys.exploit);
  const it = await net.registry.call('itemOf', [S.keys.exploit[0]]);
  assert.equal(it.flagged, true);
  assert.equal(it.vaccine.toLowerCase(), r.vaccine.id.toLowerCase());
  // the same job again, or the job of another finding
  const jobId = (await net.registry.call('jobOf', [S.keys.exploit[0]]))[0];
  await assert.rejects(net.registry.send('user', 'attest', [jobId, findingTuple(r.finding)]), /JobUsed/);
  // governance cannot flag (no function); it can only protect, which lifts
  await assert.rejects(net.registry.send('user', 'setProtected', [[S.keys.exploit[0]], true]), /NotGovernance/);
});

test('registry: an unagreed job (no quorum yet, or a wrong chain tag) cannot flag', async () => {
  const net = await setupNetwork({ runners: 4 });
  const r = S.reports.attacker;
  await net.jobs.send('sentinel', 'request', [chainTag('immune'), 'immune:1:x'], 10n ** 17n);
  await assert.rejects(net.registry.send('user', 'attest', [0, findingTuple(r.finding)]), /NotAgreed/);
  await net.jobs.send('sentinel', 'request', [chainTag('immune-clear'), 'immune:1:y'], 10n ** 17n);
  await assert.rejects(net.registry.send('user', 'attest', [1, findingTuple(r.finding)]), /WrongJob/);
});

test('appeal and governance: protecting a key lifts it; expiry lifts it; lift() refuses a standing flag', async () => {
  const { net } = S;
  const [key] = S.keys.attacker;
  await assert.rejects(net.registry.send('user', 'lift', [key]), /Stands/);
  const ev = await net.registry.send('gov', 'setProtected', [[S.keys.clone[0]], true]);
  assert.ok(ev.some((e) => e?.name === 'Lifted' && Number(e.args.why) === 4));
  assert.equal((await net.registry.call('itemOf', [S.keys.clone[0]])).flagged, false);
  net.Z.advance(91 * 86400); // past the attacker flag's 90-day ttl
  const ev2 = await net.registry.send('user', 'lift', [key]);
  assert.ok(ev2.some((e) => e?.name === 'Lifted' && Number(e.args.why) === 3));
  // views end an expired flag at once (every mirror too, by expiresAt); the stored every-chain item waits for its
  // own lift(), whose new round carries the end to mirrors that do not expire by themselves (the CosmWasm one)
  assert.equal((await net.registry.call('isFlagged', [IDS.A, S.net.attacker]))[0], false);
  assert.equal((await net.registry.call('itemOf', [S.keys.attacker[1]])).flagged, true);
  await net.registry.send('user', 'lift', [S.keys.attacker[1]]);
  assert.equal((await net.registry.call('itemOf', [S.keys.attacker[1]])).flagged, false);
});

test('broadcast: only what a route lacks is sent; a call is bounded to MAX_ITEMS keys; the IBC memo matches the JS one and the CosmWasm mirror format', async () => {
  const { net } = S;
  const keys = [...S.keys.exploit, ...S.keys.attacker];
  assert.deepEqual([...await net.broadcaster.call('pending', [IDS.B, keys])].some(Boolean), true, 'lifted / protected keys are newer now');
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => keccak256('0x' + i.toString(16).padStart(2, '0')));
  await assert.rejects(net.broadcaster.send('pusher', 'broadcast', [many]), /TooMany/);
  await assert.rejects(net.broadcaster.send('pusher', 'broadcast', [[keccak256('0x01')]]), /NothingToSend/);
  await net.broadcaster.send('gov', 'setIbcRoute', ['channel-7', 'osmo1mirror', 600]);
  const memo = await net.broadcaster.call('ibcMemo', [S.keys.exploit]);
  const items = [];
  for (const k of S.keys.exploit) { const it = await net.registry.call('itemOf', [k]); items.push({ key: it.key, round: Number(it.round), flagged: it.flagged, severity: Number(it.severity), since: Number(it.since), expiresAt: Number(it.expiresAt) }); }
  assert.equal(memo, ibcMemo(items, { contract: 'osmo1mirror', srcChain: IDS.Z, now: Number(net.Z.now()) }));
  const parsed = parseMemo(memo); // the CosmWasm mirror's (cosmwasm/neuro-oracle-osmo) memo format
  assert.equal(parsed.contract, 'osmo1mirror');
  assert.equal(parsed.srcChain, IDS.Z);
  assert.equal(parsed.items.length, 2);
  for (const it of parsed.items) assert.deepEqual(Object.keys(it).sort(), ['enforced_from', 'flagged', 'held_from', 'key', 'reason', 'round']);
});

test('mirror: stale rounds change nothing, only the Mailbox writes, a paused mirror answers "not flagged" and live() = false', async () => {
  const { net } = S;
  const m = net.dest.B.mirror;
  await assert.rejects(m.send('user', 'handle', [IDS.Z, '0x' + '00'.repeat(32), '0x']), /NotMailbox/);
  assert.equal(await m.call('live'), true);
  await m.send('guardian', 'pause');
  assert.equal(await m.call('live'), false);
  assert.equal((await m.call('isFlagged', [IDS.B, S.net.attacker]))[0], false);
  // the router stays fail-open (its choice), a fail-closed one refuses everything while the feed is down
  const failClosed = await net.dest.B.k.deploy('ImmuneGuardedRouter', [m.address, 3, true], 'gov');
  await failClosed.sendValue('gov', 10n ** 18n);
  await assert.rejects(failClosed.send('gov', 'send', [S.net.user, 1n]), /ImmuneFeedDown/);
  await m.send('gov', 'unpause');
  assert.equal((await m.call('isFlagged', [IDS.B, S.net.attacker]))[0], true);
});

test('feed + SDK: the registry becomes a signed feed; checkAddress answers from the mirror first, then the verified feed', async () => {
  const { net } = S;
  const key = pqFromSeed('0x' + '42'.repeat(32));
  const files = await feedFiles(S.feed, { key, base: 'https://example.invalid/' });
  const snap = JSON.parse(files['snapshot.pq.json']);
  const feed = JSON.parse(files['feed.json']);
  assert.equal((await verifySnapshot(feed, snap, { trustedKeys: [key.keyHash] })).ok, true);
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('feed.json') ? feed : snap) });
  const immune = createImmune({
    mirrors: { [IDS.B]: { address: net.dest.B.mirror.address, send: chainSend(net.dest.B.k) } },
    feedUrl: 'https://example.invalid/', trustedKeys: [key.keyHash], fetchImpl, now: () => S.feed.generatedAt,
  });
  const onB = await immune.checkAddress(IDS.B, S.net.attacker);
  assert.equal(onB.source, 'mirror');
  assert.equal(onB.flagged, true);
  assert.equal(onB.severity, 4);
  const onBsc = await immune.checkAddress(97, S.net.attacker); // no mirror there: the feed (every-EVM-chain key)
  assert.equal(onBsc.source, 'feed');
  assert.equal(onBsc.flagged, true);
  assert.equal(onBsc.signed, true);
  assert.equal((await immune.advise(97, S.net.attacker)).action, 'block');
  assert.equal((await immune.checkAddress(97, S.net.user)).flagged, false);
  assert.equal((await immune.checkAddress(1399811151, 'So11111111111111111111111111111111111111112')).source, 'feed');
  // a tampered feed is refused when a key is pinned
  const bad = { ...feed, items: feed.items.filter((e) => e.address !== S.net.attacker) };
  const evil = createImmune({ feedUrl: 'https://example.invalid/', trustedKeys: [key.keyHash], now: () => S.feed.generatedAt,
    fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('feed.json') ? bad : snap) }) });
  const r = await evil.checkAddress(97, S.net.attacker);
  assert.equal(r.source, 'none');
  assert.match(r.error, /feed refused/);
});

test('breaker interface: ThreatFlag events on a mirror decode for a circuit breaker', async () => {
  const k = S.net.dest.B.k;
  const iface = S.net.dest.B.mirror.iface;
  const m = S.net.dest.B.mirror;
  // the in-process EVM keeps no log index: re-deliver nothing, decode what handle() emits instead
  const ev = iface.getEvent('ThreatFlag');
  const sample = iface.encodeEventLog(ev, [IDS.B, S.net.attacker, true, 4, 1, '0x' + '11'.repeat(32)]);
  const send = async (method) => (method === 'eth_blockNumber' ? '0x10' : [{ ...sample, blockNumber: '0x10' }]);
  const { events, next } = await watchFlags(send, m.address, { fromBlock: 1 });
  assert.equal(next, 17);
  assert.deepEqual(events.map((e) => [e.type, e.chainId, e.subject, e.flagged, e.severity]), [['ThreatFlag', IDS.B, S.net.attacker, true, 4]]);
  assert.ok(k);
});

test('latency model: the seeded simulation of detect -> agree -> registry -> mirror over every covered chain', () => {
  const r = simulate({ source: 'sepolia', trials: 300, seed: 11 });
  assert.ok(r.median > 20 && r.median < 120, `median ${r.median}`);
  assert.ok(r.perChain.length >= 15);
  const osmo = r.perChain.find((c) => c.key === 'osmosis');
  assert.ok(osmo && osmo.mirror === 'ibc');
  assert.ok(!r.perChain.some((c) => c.key === 'sol'), 'Solana has no mirror yet: feed only');
  console.log(`  model (300 trials): stages ${JSON.stringify(r.stages)}; median ${r.median}s, p90 ${r.p90}s over ${r.perChain.length} chains`);
  assert.deepEqual(simulate({ trials: 50, seed: 3 }), simulate({ trials: 50, seed: 3 }));
});

test('kit: the clone is not the exploit byte for byte (a redeploy with changes), so only the vaccine could catch it', () => {
  const kit = immuneKit();
  assert.notEqual(keccak256(kit.FlashExploit.runtime), keccak256(kit.FlashExploitClone.runtime));
});
