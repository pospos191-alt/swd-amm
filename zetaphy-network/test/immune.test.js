// The immune network's parts (docs/future/immune-network.md): rate-limited RPC, detectors and sentinels over the
// mock multi-chain and a recorded fixture, vaccines, k-of-n agreement helpers, batching and the gas bound, the
// signed feed, and the SDK. The whole flow on real contracts: test/immune-e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { keccak256, zeroPadValue } from 'ethers';
import { createChain } from './helpers/evm.js';
import { immuneKit } from './helpers/immunesim.js';
import { rateLimiter, createRpc, fixtureRpc, recordingRpc } from '../src/immune/rpc.js';
import { EvmSentinel, SolanaSentinel, CosmosSentinel, toReport } from '../src/immune/sentinel.js';
import { flashLoanVerdict, drainerVerdict, taintVerdict, outflowVerdict, reverify, KIND, SEVERITY, TTL, bech32Hex, base58Hex, subjectOf } from '../src/immune/detectors.js';
import { deriveVaccine, deriveExactVaccine, matchVaccine, vaccineIntact, VaccineSet, codeHashOf } from '../src/immune/vaccines.js';
import { contentHash, cidOf, verifyBundle, canonical } from '../src/immune/evidence.js';
import { runnerVote, findingHash, rejectHash, tally, falseFlagCost, jobTarget, parseTarget, keysOf, addressKey } from '../src/immune/agree.js';
import { planBatches, pendingByRoute, broadcastGas, MAX_ITEMS, routes, simulate } from '../src/immune/propagate.js';
import { buildFeed, feedFiles, verifySnapshot, toNdjson, entryOf } from '../src/immune/feed.js';
import { createImmune, keysFor, accountBytes } from '../src/immune/sdk.js';
import { evmAttacks, solanaAttacks, cosmosAttacks, mockBech32 } from '../src/immune/scenarios.js';
import { mockAddress } from '../src/immune/mockchain.js';
import { ALL, CHAINS, propagationSeconds } from '../src/immune/chains.js';
import { pqFromSeed } from '../src/pq.js';

const kit = immuneKit();

// ---------------------------------------------------------------- RPC

test('rate limiter: a burst, then rps on average (fake clock)', async () => {
  let t = 0;
  const lim = rateLimiter({ rps: 4, burst: 2, now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 10; i++) await lim.take();
  assert.ok(t >= 2000 && t <= 2100, `8 requests past the burst at 4/s took ${t} ms`);
  assert.equal(lim.waitedMs, t);
});

test('rpc: rotates to the next free endpoint on 429 / 5xx and falls back from batches to single calls', async () => {
  const hits = [];
  const fetchImpl = async (url, o) => {
    hits.push(url);
    const body = JSON.parse(o.body);
    if (url.includes('busy')) return { ok: false, status: 429, json: async () => ({}) };
    if (Array.isArray(body)) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x10' }) };
  };
  const rpc = createRpc({ urls: ['https://busy.example', 'https://ok.example'], rps: 1000, burst: 1000, fetchImpl, sleep: async () => {} });
  assert.equal(await rpc.send('eth_blockNumber'), '0x10');
  assert.deepEqual(hits.slice(0, 2), ['https://busy.example', 'https://ok.example']);
  assert.equal(rpc.stats.rotations, 1);
  assert.deepEqual(await rpc.batch([{ method: 'eth_blockNumber' }, { method: 'eth_chainId' }]), ['0x10', '0x10']);
});

// ---------------------------------------------------------------- detectors on the mock multi-chain + recorded fixture

// (Object.groupBy is Node 21+; CI runs Node 20)
const byDetector = (reports) => reports.reduce((g, r) => ((g[r.bundle.detector] ??= []).push(r), g), Object.create(null));

test('sentinel (mock EVM): flash-loan exploit + attacker, drainer + its sink, one-block outflow; honest activity is quiet', async () => {
  const sc = evmAttacks({ exploitCode: kit.FlashExploit.runtime });
  const s = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: sc.chain.rpc(), protocols: sc.protocols, allowlist: sc.allowlist, state: { next: sc.start - 7 }, maxBlocks: 50 });
  const reports = await s.tick();
  const g = byDetector(reports);
  const fl = g.flashloan.map((r) => [r.address, r.finding.kind, r.finding.severity, r.finding.everyChain]);
  assert.deepEqual(fl, [[sc.addr.exploit, KIND.exploit, SEVERITY.critical, false], [sc.addr.attacker, KIND.attacker, SEVERITY.critical, true]]);
  const ex = g.flashloan[0];
  assert.ok(ex.vaccine && vaccineIntact(ex.vaccine), 'a confirmed exploit contract ships a vaccine');
  assert.equal(ex.finding.vaccine, ex.vaccine.id);
  assert.equal(ex.finding.codeHash, codeHashOf(kit.FlashExploit.runtime));
  assert.deepEqual(g.drainer.map((r) => r.address).sort(), [sc.addr.drainer, sc.addr.sink].sort());
  assert.deepEqual(g.outflow.map((r) => r.address), [sc.addr.collector]);
  assert.ok(!reports.some((r) => [mockAddress(`${sc.chain.id}.router`), mockAddress(`${sc.chain.id}.alice`)].includes(r.address)), 'no false positive');
  for (const r of reports) {
    assert.equal(verifyBundle(r.bundle, r.evidenceHash), true);
    assert.equal(reverify(r.bundle, r.finding).ok, true, `${r.bundle.detector} reproduces from its own evidence`);
  }
});

test('sentinel: resumable cursor (a restart rescans nothing) and an outage leaves the cursor where it was', async () => {
  const sc = evmAttacks();
  const state = { next: sc.start - 7 };
  const s1 = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: sc.chain.rpc(), state, maxBlocks: 3 });
  await s1.tick();
  assert.equal(state.next, sc.start - 4);
  const saved = JSON.parse(JSON.stringify(state));
  const down = { send: async () => { throw new Error('ECONNRESET'); } };
  await assert.rejects(new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: down, state: saved }).tick());
  assert.equal(saved.next, sc.start - 4);
  const s2 = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: sc.chain.rpc(), state: saved, maxBlocks: 50 });
  const r = await s2.tick();
  assert.equal(saved.next, sc.chain.headNumber + 1);
  assert.ok(r.length >= 4);
});

test('recorded fixture: a sentinel replayed offline finds exactly what was recorded; a call never recorded is reported', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/immune/sepolia-attacks.json', import.meta.url), 'utf8'));
  const rpc = fixtureRpc(fx);
  const s = new EvmSentinel({ chain: { key: 'sepolia', id: 11155111 }, rpc, protocols: fx.protocols, allowlist: fx.allowlist, state: { next: fx.start }, maxBlocks: 50, now: () => 1_800_000_000 });
  const reports = await s.tick();
  assert.deepEqual(reports.map((r) => ({ detector: r.bundle.detector, kind: r.finding.kind, address: r.address })), fx.expect);
  assert.deepEqual(rpc.misses, []);
  await assert.rejects(rpc.send('eth_getBalance', ['0x00', 'latest']), /not recorded/);
  // the recorder keeps every answer it served
  const rec = recordingRpc(evmAttacks().chain.rpc());
  await rec.send('eth_blockNumber');
  assert.equal(Object.keys(rec.fixture.calls).length, 1);
});

test('detectors: thresholds hold (no flash loan, small swing, no profit, allow-listed spender, too few victims)', () => {
  const sc = evmAttacks();
  const blk = [...sc.chain.blocks.values()].find((b) => b.receipts.some((r) => r.logs.length === 8));
  const r = blk.receipts[0];
  const base = { chainId: 1, tx: { hash: r.transactionHash, from: sc.addr.attacker, to: sc.addr.exploit }, toCode: '0x6001' };
  assert.equal(flashLoanVerdict({ ...base, logs: r.logs }).length, 2);
  assert.equal(flashLoanVerdict({ ...base, logs: r.logs.slice(1) }).length, 0, 'no flash loan');
  assert.equal(flashLoanVerdict({ ...base, logs: r.logs, minSwingBps: 2_000_000 }).length, 0, 'swing below the threshold');
  assert.equal(flashLoanVerdict({ ...base, logs: r.logs.filter((l, i) => i !== 4) }).length, 0, 'no profit');
  const approvals = [1, 2, 3].map((i) => ({ owner: `0x${String(i).repeat(40)}`, token: '0xt', value: ((1n << 256n) - 1n).toString(), block: 1 }));
  const sweeps = approvals.slice(0, 2).map((a) => ({ owner: a.owner, token: '0xt', to: '0x' + 'ee'.repeat(20), value: '1', tx: '0x' }));
  const spender = '0x' + 'dd'.repeat(20);
  assert.equal(drainerVerdict({ chainId: 1, spender, approvals, sweeps }).length, 2);
  assert.equal(drainerVerdict({ chainId: 1, spender, approvals, sweeps, allowlist: [spender] }).length, 0);
  assert.equal(drainerVerdict({ chainId: 1, spender, approvals: approvals.slice(0, 2), sweeps }).length, 0);
  assert.equal(drainerVerdict({ chainId: 1, spender, approvals, sweeps: sweeps.slice(0, 1) }).length, 0);
  const out = { chainId: 1, protocol: { address: '0xp', name: 'P' }, transfers: [{ token: '0xu', to: '0xa', value: '50', tx: '0x' }], baseline: { '0xu': '10' }, tvl: { '0xu': '1000' } };
  assert.equal(outflowVerdict(out).length, 0, '5% < the 10% floor and < 8x usual');
  assert.equal(outflowVerdict({ ...out, transfers: [{ ...out.transfers[0], value: '150' }] }).length, 1);
  const flagged = { address: '0xa', severity: 4, kind: KIND.attacker };
  const tr = { to: '0x' + 'cc'.repeat(20), value: '5', token: null, tx: '0x' };
  assert.equal(taintVerdict({ chainId: 1, flagged, transfer: tr })[0].severity, SEVERITY.suspicious, 'taint only warns');
  assert.equal(taintVerdict({ chainId: 1, flagged: { ...flagged, severity: 2 }, transfer: tr }).length, 0, 'only from a high/critical flag');
  assert.equal(taintVerdict({ chainId: 1, flagged, transfer: tr, toCode: '0x6001' }).length, 0, 'never a contract (an exchange, a bridge)');
});

test('taint through the sentinel: funds leaving a flagged attacker to a fresh address are a severity-2 warning', async () => {
  const sc = evmAttacks();
  const flagged = new Map([[sc.addr.attacker, { severity: 4, kind: KIND.attacker }]]);
  const s = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: sc.chain.rpc(), flagged, state: { next: sc.start }, maxBlocks: 50 });
  const t = (await s.tick()).filter((r) => r.bundle.detector === 'taint');
  assert.deepEqual(t.map((r) => [r.address, r.finding.severity]), [[sc.addr.fresh, 2]]);
});

test('sentinel (mock Solana): one delegate taking 3 owners\' SPL token accounts', async () => {
  const sc = solanaAttacks();
  const s = new SolanaSentinel({ chain: { key: 'soldevnet', id: 1399811151 }, rpc: sc.chain.rpc(), state: { next: sc.chain.slotNow - 3 } });
  const r = await s.tick();
  assert.equal(r.length, 1);
  assert.equal(r[0].address, sc.drainer);
  assert.equal(r[0].finding.subject, subjectOf(base58Hex(sc.drainer)));
  assert.equal(reverify(r[0].bundle, r[0].finding).ok, true);
});

test('sentinel (mock Osmosis): a CosmWasm code matching a wasm vaccine, and an authz send-grant drainer', async () => {
  const sc = cosmosAttacks();
  const vac = new VaccineSet([deriveExactVaccine({ vm: 'cosmwasm', checksum: sc.checksum, chainId: 9875, label: 'drainer code' })]);
  const s = new CosmosSentinel({ chain: { key: 'osmotest', id: 9875 }, rpc: sc.chain.rpc(), vaccines: vac, state: { next: sc.chain.heightNow - 2 } });
  const r = await s.tick();
  const g = byDetector(r);
  assert.deepEqual(g['wasm-clone'].map((x) => x.address), [sc.bad]);
  assert.deepEqual(g['authz-drainer'].map((x) => x.address), [sc.grantee]);
  assert.equal(r.find((x) => x.address === sc.good), undefined);
  assert.equal(reverify(g['wasm-clone'][0].bundle, g['wasm-clone'][0].finding, { vaccines: vac }).ok, true);
  assert.equal(bech32Hex(sc.grantee).length, 42);
  assert.throws(() => bech32Hex(sc.grantee.slice(0, -1) + (sc.grantee.endsWith('q') ? 'p' : 'q')), /checksum/);
  assert.match(mockBech32('cosmos', 'x'), /^cosmos1/);
});

// ---------------------------------------------------------------- vaccines + evidence

test('vaccines: the exploit\'s detector catches a modified clone, never honest code; tampering is detected', () => {
  const v = deriveVaccine({ code: kit.FlashExploit.runtime, chainId: 11155111, kind: KIND.exploit, label: 'flash exploit' });
  assert.equal(vaccineIntact(v), true);
  const m = matchVaccine(v, kit.FlashExploitClone.runtime);
  assert.equal(m.match, true);
  assert.equal(m.how, 'similar');
  assert.ok(m.score >= 90);
  assert.equal(matchVaccine(v, kit.FlashExploit.runtime).how, 'exact');
  for (const n of ['HonestVault']) assert.equal(matchVaccine(v, kit[n].runtime).match, false);
  for (const n of ['TestStable', 'VulnerableVault', 'NeuroJobs', 'ImmuneGuardedRouter']) {
    assert.equal(matchVaccine(v, JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).deployedBytecode).match, false, n);
  }
  assert.equal(vaccineIntact({ ...v, threshold: 1 }), false, 'a lowered threshold changes the id');
  const set = new VaccineSet([v, v, { ...v, threshold: 1 }]);
  assert.equal(set.size, 1);
  assert.equal(set.scan(kit.FlashExploitClone.runtime).vaccine.id, v.id);
});

test('evidence: canonical bytes, sha256 content hash = an IPFS CIDv1 (raw); any change breaks it', () => {
  assert.equal(canonical({ b: 1n, a: [undefined, 'x'], c: undefined }), '{"a":[null,"x"],"b":"1"}');
  const { evidenceHash, cid } = contentHash({ hello: 'world' });
  assert.match(cid, /^bafkrei[a-z2-7]{52}$/);
  assert.equal(cidOf(evidenceHash), cid);
  assert.equal(verifyBundle({ hello: 'world' }, evidenceHash), true);
  assert.equal(verifyBundle({ hello: 'World' }, evidenceHash), false);
});

// ---------------------------------------------------------------- agreement

test('k-of-n: runners re-run the evidence; a doctored bundle or a finding it does not support gets the reject verdict', async () => {
  const sc = evmAttacks({ exploitCode: kit.FlashExploit.runtime });
  const s = new EvmSentinel({ chain: { key: 'sepolia', id: sc.chain.id }, rpc: sc.chain.rpc(), state: { next: sc.start }, maxBlocks: 2 });
  const [ex] = await s.tick();
  assert.deepEqual(runnerVote(ex), { verdict: findingHash(ex.finding), ok: true, reason: null });
  const bumped = { ...ex, finding: { ...ex.finding, severity: 3 } };
  assert.equal(runnerVote(bumped).verdict, rejectHash(ex.finding.evidenceHash), 'claims what the detector did not say');
  const doctored = { ...ex, bundle: { ...ex.bundle, inputs: { ...ex.bundle.inputs, minSwingBps: 1 } } };
  assert.match(runnerVote(doctored).reason, /hash/);
  const swapped = { ...ex, finding: { ...ex.finding, subject: subjectOf(mockAddress('innocent')) } };
  assert.equal(runnerVote(swapped).ok, false);
  assert.equal(runnerVote({ ...ex, finding: { ...ex.finding, ttl: 365 * 86400 } }).ok, false);
  const t = jobTarget(ex);
  assert.ok(t.length <= 330);
  assert.deepEqual(parseTarget(t), { chainId: ex.finding.chainId, cid: ex.cid, findingHash: findingHash(ex.finding) });
  // NeuroJobs' rule: the first verdict two seats reveal wins; the third seat is judged against it
  const A = findingHash(ex.finding); const B = rejectHash(ex.finding.evidenceHash);
  assert.deepEqual(tally([{ verdict: A }, { verdict: B }, { verdict: A }]), { result: A, agreedBy: 2, at: 2 });
  assert.deepEqual(tally([{ verdict: A }, { verdict: B }]), { result: null, agreedBy: 0, at: -1 });
  const cost = falseFlagCost({ bonds: [100n, 100n] });
  assert.deepEqual([cost.total, cost.toChallenger, cost.toRound], [100n, 50n, 50n]);
  assert.deepEqual(keysOf(ex.finding).length, 2, 'a contract: its address on its chain + its code everywhere');
});

// ---------------------------------------------------------------- propagation

test('batching: dedup, <= MAX_ITEMS a call, smaller batches when there are many routes; pending per route by round', () => {
  const keys = Array.from({ length: 60 }, (_, i) => keccak256('0x' + i.toString(16).padStart(4, '0')));
  const b = planBatches([...keys, ...keys.slice(0, 5)], { routes: 1 });
  assert.deepEqual(b.map((x) => x.length), [24, 24, 12]);
  const many = planBatches(keys, { routes: 16 });
  assert.ok(many[0].length < MAX_ITEMS && broadcastGas(many[0].length, 16, { mailbox: 150_000 }) <= 12_000_000);
  assert.throws(() => planBatches(keys, { routes: 16, gasCap: 100_000 }), /gas > cap/);
  assert.deepEqual(pendingByRoute({ k1: 2, k2: 1, k3: 0 }, { base: { k1: 1, k2: 1 }, osmo: {} }), { base: ['k1'], osmo: ['k1', 'k2'] });
});

test('gas bound: measured broadcasts (1-24 keys x 1-16 routes, a Mailbox that only emits) stay under broadcastGas', async () => {
  const f = 'FakeImmuneRegistry.sol';
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [f]: { content: readFileSync(new URL(`./helpers/${f}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const c = out.contracts[f].FakeImmuneRegistry;
  const rows = [];
  for (const [routesN, n] of [[1, 1], [1, 24], [4, 8], [16, 24]]) {
    const k = await createChain(['gov', 'p']);
    const reg = await k.deployRaw({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, [], 'gov');
    const mb = await k.deploy('MockMailbox', [77390], 'gov');
    const b = await k.deploy('ImmuneBroadcaster', [reg.address, mb.address, k.acct.gov.toString()], 'gov');
    for (let i = 0; i < routesN; i++) await b.send('gov', 'setReceiver', [1000 + i, zeroPadValue('0x' + (i + 1).toString(16).padStart(40, '0'), 32)]);
    const keys = Array.from({ length: n }, (_, i) => keccak256('0x' + (i + 1).toString(16).padStart(4, '0')));
    const g = (await b.gas('p', 'broadcast', [keys])).exec;
    rows.push(`${n}x${routesN}: ${g}`);
    assert.ok(g <= broadcastGas(n, routesN), `${n} keys x ${routesN} routes: ${g} > model ${broadcastGas(n, routesN)}`);
    assert.ok(broadcastGas(n, routesN) < 1.3 * g, 'the bound is not loose');
    if (routesN === 16) await assert.rejects(b.send('gov', 'setReceiver', [5000, zeroPadValue('0x01', 32)]), /TooMany/, 'at most MAX_DOMAINS routes');
  }
  console.log(`  broadcast gas: ${rows.join(', ')} (+ the real Mailbox's per-dispatch cost)`);
});

test('routes and the latency model: every chain has a route; Solana is feed-only (documented path); seeded and repeatable', () => {
  const rs = routes();
  assert.equal(rs.length, ALL.length);
  assert.deepEqual([...new Set(CHAINS.map((c) => c.mirror))].sort(), ['documented', 'hyperlane', 'ibc']);
  assert.equal(propagationSeconds(CHAINS.find((c) => c.key === 'sol')), null);
  const a = simulate({ trials: 100, seed: 5 });
  assert.deepEqual(a, simulate({ trials: 100, seed: 5 }));
  assert.ok(a.p90 >= a.median);
});

// ---------------------------------------------------------------- feed

const item = (o = {}) => ({ key: addressKey(0, '0x' + 'ab'.repeat(20)), round: 1, flagged: true, keyType: 2, chainId: 0, subject: subjectOf('0x' + 'ab'.repeat(20)), kind: 2, severity: 4,
  since: 1_800_000_000, expiresAt: 1_800_000_000 + TTL.attacker, evidenceHash: '0x' + '11'.repeat(32), vaccine: '0x' + '00'.repeat(32), jobId: 3, provisional: true, ...o });

test('feed: JSON / NDJSON / RSS / Atom, 24h stats, only intact referenced vaccines; ML-DSA snapshot verifies and catches tampering', async () => {
  const v = deriveVaccine({ code: kit.FlashExploit.runtime, chainId: 1 });
  const items = [item(), item({ key: keccak256('0x02'), keyType: 3, subject: v.codeHash, kind: 1, vaccine: v.id, since: 1_799_000_000 }), item({ key: keccak256('0x03'), flagged: false, round: 2 })];
  const feed = buildFeed({ items, vaccines: [v, { ...v, threshold: 1 }, deriveVaccine({ code: kit.HonestVault.runtime, chainId: 1 })], source: { registry: '0x' + '12'.repeat(20) }, now: 1_800_000_100 });
  assert.equal(feed.stats.flaggedNow, 2);
  assert.equal(feed.stats.flagged24h, 1);
  assert.deepEqual(feed.vaccines.map((x) => x.id), [v.id]);
  assert.equal(feed.items[0].address, '0x' + 'ab'.repeat(20));
  assert.equal(feed.items.find((e) => e.keyType === 3).codeHash, v.codeHash);
  assert.equal(toNdjson(feed).trim().split('\n').length, 3);
  const key = pqFromSeed('0x' + '07'.repeat(32));
  const files = await feedFiles(feed, { key, base: 'https://x.invalid/' });
  assert.match(files['rss.xml'], /^<\?xml[^]*<rss version="2.0">[^]*<item><title>FLAG critical attacker/);
  assert.match(files['atom.xml'], /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">[^]*<entry>/);
  const snap = JSON.parse(files['snapshot.pq.json']);
  const parsed = JSON.parse(files['feed.json']);
  assert.deepEqual(await verifySnapshot(parsed, snap, { trustedKeys: [key.keyHash], now: 1_800_000_100 }), { ok: true, problems: [], keyHash: key.keyHash, signer: 'trusted' });
  const tampered = { ...parsed, items: parsed.items.slice(1) };
  assert.equal((await verifySnapshot(tampered, snap)).ok, false);
  const other = pqFromSeed('0x' + '08'.repeat(32));
  assert.match((await verifySnapshot(parsed, snap, { trustedKeys: [other.keyHash] })).problems.join(), /does not trust/);
  assert.match((await verifySnapshot(parsed, snap, { maxAgeSeconds: 60, now: 1_800_100_000 })).problems.join(), /older/);
  const forged = { ...snap, payload: { ...snap.payload, flaggedNow: 0 } };
  assert.equal((await verifySnapshot(parsed, forged)).ok, false);
  assert.equal(entryOf(item({ expiresAt: 1 }), { now: 2 }).flagged, false, 'expired is not flagged in the feed');
});

// ---------------------------------------------------------------- SDK

test('SDK: keys for EVM / Solana / Cosmos accounts; without a mirror it reads the feed; with nothing it says so', async () => {
  const a = '0x' + 'ab'.repeat(20);
  assert.deepEqual(keysFor(97, a), [addressKey(97, a), addressKey(0, a)]);
  assert.equal(accountBytes(mockBech32('osmo', 'k')).length, 42);
  assert.throws(() => accountBytes('nope'), /not an address/);
  const feed = buildFeed({ items: [item()], now: 1_800_000_100 });
  const fetchImpl = async (url) => (url.endsWith('feed.json') ? { ok: true, status: 200, json: async () => feed } : { ok: false, status: 404, json: async () => ({}) });
  const sdk = createImmune({ feedUrl: 'https://x.invalid', fetchImpl, now: () => 1_800_000_100 });
  const r = await sdk.checkAddress(56, a);
  assert.deepEqual([r.flagged, r.severity, r.source, r.signed, r.provisional], [true, 4, 'feed', false, true]);
  assert.equal((await sdk.advise(56, a, { blockAt: 5 })).action, 'warn');
  const pinned = createImmune({ feedUrl: 'https://x.invalid', fetchImpl, trustedKeys: ['0x' + '00'.repeat(32)], now: () => 1_800_000_100 });
  assert.equal((await pinned.checkAddress(56, a)).source, 'none', 'an unsigned feed is refused when a key is pinned');
  assert.equal((await createImmune({}).advise(56, a)).action, 'unknown');
  // a mirror that answers wins over the feed; one that is down falls back to it
  const down = createImmune({ mirrors: { 56: { address: a, send: async () => { throw new Error('down'); } } }, feedUrl: 'https://x.invalid', fetchImpl, now: () => 1_800_000_100 });
  const d = await down.checkAddress(56, a);
  assert.equal(d.source, 'feed');
  assert.match(d.mirrorError, /down/);
});

test('report shape: toReport keeps the finding the registry takes (ttl, vaccine 0 when none)', () => {
  const r = toReport({ detector: 'taint', chainId: 1, address: '0x' + 'cc'.repeat(20), subject: subjectOf('0x' + 'cc'.repeat(20)), kind: 2, severity: 2, everyChain: true, codeHash: '0x' + '00'.repeat(32), label: 'x', ttl: TTL.linked },
    { detector: 'taint', inputs: {}, observedAt: 1 });
  assert.equal(r.finding.vaccine, '0x' + '00'.repeat(32));
  assert.equal(r.finding.evidenceHash, r.evidenceHash);
  assert.equal(r.vaccine, null);
});
