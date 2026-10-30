// The "On-chain AI" tab (aichain.js): its words in 8 languages, the hand-written selectors and encoders (checked
// against ethers and the contracts' signatures), the decoders and the chain readers against a fake evmCall, and
// its place in the hub (tab, page, AI map items).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, Interface, AbiCoder } from 'ethers';
import { LANG_CODES, TAB_TEXT } from '../i18n.js';
import { AICHAIN } from '../aichain-i18n.js';
import { ITEMS, statusOf } from '../flow.js';
import {
  SEL, SCORED_TOPIC, LEVELS, CLAIM_STATES, words, ascii32, readModel, readScoreOf, readScoreRecord, probOf, readScoredLog, rescoreData, scoreOfData,
  readNeuroScore, readTokenScore, findFeatures, readAddresses, frostKey, isValidFrostData, readCommittee, checkFrost,
  readClaim, claimAction, readInsurance, readBuckets, readIssuance, readCurrent, readVersion, readEpochs,
  readBreakerPolicy, readBreakerTrip, readBreaker, readBreakerProtocol,
} from '../aichain.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const abi = AbiCoder.defaultAbiCoder();
const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);
const A = (b) => '0x' + b.repeat(20);

const SIGS = {
  version: 'version()', model: 'model(uint32)', scoreOf: 'scoreOf(address)', scoreRecord: 'scoreRecord(address)', rescore: 'rescore(address,bytes)',
  members: 'members()', threshold: 'threshold()', frostKeyX: 'frostKeyX()', frostKeyParity: 'frostKeyParity()', governance: 'governance()', isValidFrost: 'isValidFrost(bytes32,bytes)',
  assets: 'assets()', totalShares: 'totalShares()', activeCover: 'activeCover()', premiumBps: 'premiumBps()', maxCoverBps: 'maxCoverBps()', quorum: 'quorum()',
  voteWindow: 'voteWindow()', disputeWindow: 'disputeWindow()', shares: 'shares(address)', pendingShares: 'pendingShares(address)', withdrawReadyAt: 'withdrawReadyAt(address)',
  claimCount: 'claimCount()', coverCount: 'coverCount()', claims: 'claims(uint256)', payoutOf: 'payoutOf(uint256)',
  deposit: 'deposit()', requestWithdraw: 'requestWithdraw(uint256)', withdraw: 'withdraw()', payout: 'payout(uint256)', expire: 'expire(uint256)',
  buckets: 'buckets()', pendingOverflow: 'pendingOverflow()', overflow: 'overflow()', sweepOverflow: 'sweepOverflow()',
  current: 'current()', count: 'count()', versionByIndex: 'versionByIndex(uint256)', epochLength: 'epochLength()', minDelay: 'minDelay()',
  protocolCount: 'protocolCount()', tripCount: 'tripCount()', guardianBond: 'guardianBond()', minQuorum: 'minQuorum()',
  isTripped: 'isTripped(address)', lastTrip: 'lastTrip(address)', tripOf: 'tripOf(uint256)', policyOf: 'policyOf(address)',
};

/** A fake node: eth_call answers by selector (`calls[sel](argsHex, to)` -> hex), plus block, balance and logs. */
function fakeNode(calls, { block = 1000, time = 1_700_000_000, balance = 0n, logs = [] } = {}) {
  const seen = [];
  const evmCall = async (method, params) => {
    seen.push([method, params]);
    if (method === 'eth_blockNumber') return '0x' + block.toString(16);
    if (method === 'eth_getBlockByNumber') return { number: '0x' + block.toString(16), timestamp: '0x' + time.toString(16) };
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    if (method === 'eth_getLogs') return logs;
    if (method !== 'eth_call') throw new Error(`not mocked: ${method}`);
    const data = params[0].data;
    const f = Object.entries(SEL).find(([, s]) => data.startsWith(s));
    if (!f || !calls[f[0]]) throw new Error(`execution reverted (${data.slice(0, 10)})`);
    return calls[f[0]](`0x${data.slice(10)}`, params[0].to);
  };
  return { evmCall, seen };
}
const enc = (types, vals) => abi.encode(types, vals);

test('AICHAIN words: every language has every key, translated, placeholders filled', () => {
  assert.deepEqual(Object.keys(AICHAIN).sort(), [...LANG_CODES].sort());
  const en = shape(AICHAIN.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(AICHAIN[l]), en, l);
    if (l !== 'en') for (const k of ['intro', 'notDeployed', 'scoreTip', 'cosignTip', 'insTip', 'issTip', 'epTip', 'insTestnet', 'healTitle', 'healTip', 'healTestnet', 'healNotOptedIn']) assert.notEqual(AICHAIN[l][k], AICHAIN.en[k], `${l}.${k} translated`);
    const L = AICHAIN[l];
    for (const lv of LEVELS) assert.ok(L.level[lv]?.trim(), `${l}.level.${lv}`);
    for (const s of CLAIM_STATES) assert.ok(L.claimState[s]?.trim(), `${l}.claimState.${s}`);
    assert.ok(L.scoreIs('LV', '12.5%').includes('LV') && L.scoreIs('LV', '12.5%').includes('12.5%'), `${l}.scoreIs`);
    assert.ok(L.scoreStale('v1', 'v2').includes('v1') && L.scoreStale('v1', 'v2').includes('v2'), `${l}.scoreStale`);
    assert.ok(L.cosignOf(2, 3).includes('2') && L.cosignOf(2, 3).includes('3'), `${l}.cosignOf`);
    assert.ok(L.insClaimCount(4, 9).includes('4') && L.insClaimCount(4, 9).includes('9'), `${l}.insClaimCount`);
    assert.ok(L.epIn('7,000', '12').includes('7,000') && L.epIn('7,000', '12').includes('12'), `${l}.epIn`);
    assert.match(L.insDepositAction('5'), /5/);
    assert.match(L.rescoreAction('0xabc'), /0xabc/);
    assert.match(L.insWithdrawAt('T1'), /T1/);
    assert.match(L.healTripped('T9'), /T9/);
    const pol = L.healPolicyIs(3, 5, 6);
    assert.ok(['3', '5', '6'].every((x) => pol.includes(x)), `${l}.healPolicyIs`);
    const trip = L.healTripIs(7, 'KIND', 4, 'T2');
    assert.ok(['7', 'KIND', '4', 'T2'].every((x) => trip.includes(x)), `${l}.healTripIs`);
    for (const k of ['runners', 'invariant']) assert.ok(L.healKind[k]?.trim(), `${l}.healKind.${k}`);
    assert.equal(TAB_TEXT[l].aichain?.length, 3, `${l}: tab words`);
  }
  assert.match(AICHAIN.th.insTestnet, /เทสต์เน็ต/);
});

test('selectors and the Scored topic match the contracts\' signatures', () => {
  assert.deepEqual(Object.keys(SEL).sort(), Object.keys(SIGS).sort());
  for (const [k, sig] of Object.entries(SIGS)) assert.equal(SEL[k], id(sig).slice(0, 10), sig);
  assert.equal(SCORED_TOPIC, id('Scored(address,uint32,int64,uint8,bytes32,bytes)'));
});

test('encoders give the same calldata as ethers', () => {
  const tok = '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245';
  const ns = new Interface(['function scoreOf(address)', 'function rescore(address,bytes)', 'function isValidFrost(bytes32,bytes)']);
  assert.equal(scoreOfData(tok), ns.encodeFunctionData('scoreOf', [tok]));
  for (const f of ['0x', '0x01020304', '0x' + 'ab'.repeat(4 * 20), '0x' + 'cd'.repeat(33)]) assert.equal(rescoreData(tok, f), ns.encodeFunctionData('rescore', [tok, f]), f);
  const d = '0x' + '11'.repeat(32), sig = '0x02' + '22'.repeat(64);
  assert.equal(isValidFrostData(d, sig), ns.encodeFunctionData('isValidFrost', [d, sig]));
});

test('decoders: words, model, scores, logs, members, claims, buckets, versions', () => {
  const w = words(enc(['int256', 'bool', 'address'], [-5n, true, A('ab')]));
  assert.equal(w.int(0), -5n);
  assert.equal(w.bool(1), true);
  assert.equal(w.addr(2), A('ab'));
  assert.throws(() => words('0x1234').u(0), /short/);
  assert.equal(ascii32('0x' + Buffer.from('nml-b4c35477f7b1').toString('hex').padEnd(64, '0')), 'nml-b4c35477f7b1');

  const H = '0x' + '77'.repeat(32), MID = '0x' + Buffer.from('nml-1').toString('hex').padEnd(64, '0');
  assert.deepEqual(readModel(enc(['bytes32', 'bytes32', 'uint16', 'int64', 'int64', 'int64', 'uint64'], [H, MID, 12, -20_000_000n, 0n, 15_000_000n, 1_700_000_000])),
    { hash: H, modelId: 'nml-1', nFeatures: 12, low: -20_000_000n, medium: 0n, high: 15_000_000n, activatedAt: 1_700_000_000 });
  assert.deepEqual(readScoreOf(enc(['bool', 'int256', 'uint8'], [true, -12_345_678n, 1])), { known: true, score: -12_345_678n, level: 1 });
  assert.deepEqual(readScoreRecord(enc(['int64', 'uint32', 'uint8', 'uint64', 'bytes32'], [33n, 2, 3, 99, H])), { score: 33n, version: 2, level: 3, time: 99, featuresHash: H });
  assert.equal(probOf(0n), 0.5);
  assert.ok(probOf(30_000_000n) > 0.95 && probOf(-30_000_000n) < 0.05);

  const feat = '0x' + '00000001'.repeat(5);
  const log = { topics: [SCORED_TOPIC, '0x' + A('cc').slice(2).padStart(64, '0'), '0x' + (4).toString(16).padStart(64, '0')], data: enc(['int64', 'uint8', 'bytes32', 'bytes'], [-7n, 2, H, feat]) };
  assert.deepEqual(readScoredLog(log), { token: A('cc'), version: 4, score: -7n, level: 2, featuresHash: H, features: feat });

  assert.deepEqual(readAddresses(enc(['address[]'], [[A('01'), A('02'), A('03')]])), [A('01'), A('02'), A('03')]);
  assert.deepEqual(readAddresses(enc(['address[]'], [[]])), []);
  assert.equal(frostKey(0n, 0n), null);
  assert.equal(frostKey(5n, 1n), '0x03' + '5'.padStart(64, '0'));

  const claim = enc(['uint256', 'address', 'uint8', 'uint8', 'uint8', 'uint64', 'uint64', 'uint128', 'uint128', 'bytes32', 'bytes32', 'address', 'uint128'],
    [7, A('aa'), 2, 3, 1, 1000, 2000, 10n ** 18n, 10n ** 17n, H, H, A('00'), 0]);
  const k = readClaim(claim);
  assert.equal(k.state, 'approved');
  assert.equal(k.coverId, 7);
  assert.equal(k.claimant, A('aa'));
  assert.equal(k.approvals, 3);
  assert.equal(k.loss, 10n ** 18n);
  assert.equal(k.decidedAt, 2000);

  const b = readBuckets(enc(['(address,uint16,uint128,uint128)[]'], [[[A('0a'), 4000, 100n, 30n], [A('0b'), 2500, 50n, 0n]]]));
  assert.deepEqual(b, [{ sink: A('0a'), bps: 4000, cap: 100n, accrued: 30n }, { sink: A('0b'), bps: 2500, cap: 50n, accrued: 0n }]);
  assert.deepEqual(readBuckets(enc(['(address,uint16,uint128,uint128)[]'], [[]])), []);

  assert.deepEqual(readCurrent(enc(['bool', 'uint256', 'bytes32', 'uint64', 'string'], [true, 1, H, 600, 'ipfs://manifest-ü'])), { found: true, index: 1, hash: H, activation: 600, uri: 'ipfs://manifest-ü' });
  assert.deepEqual(readVersion(enc(['bytes32', 'uint64', 'uint64', 'string'], [H, 1200, 900, 'https://x/m.json']), 2), { index: 2, hash: H, activation: 1200, scheduledAt: 900, uri: 'https://x/m.json' });
});

test('claim actions: payout after the dispute window, expire after the vote window, else nothing', () => {
  const win = { voteWindow: 100, disputeWindow: 50 };
  assert.equal(claimAction({ state: 'approved', decidedAt: 1000 }, 1049, win), null);
  assert.equal(claimAction({ state: 'approved', decidedAt: 1000 }, 1050, win), 'payout');
  assert.equal(claimAction({ state: 'voting', filedAt: 1000 }, 1100, win), null);
  assert.equal(claimAction({ state: 'voting', filedAt: 1000 }, 1101, win), 'expire');
  assert.equal(claimAction({ state: 'disputed', decidedAt: 0, filedAt: 0 }, 10 ** 9, win), null);
});

test('NeuroScore reader: the active model, a token\'s score, a stale score and its features from the logs', async () => {
  const NS = A('51'), TOK = A('cc'), H = '0x' + '77'.repeat(32), FH = '0x' + '88'.repeat(32);
  const feat = '0x' + '00000002'.repeat(3);
  const calls = {
    version: () => enc(['uint32'], [3]),
    model: (args) => { assert.equal(BigInt(args), 3n); return enc(['bytes32', 'bytes32', 'uint16', 'int64', 'int64', 'int64', 'uint64'], [H, '0x' + '00'.repeat(32), 3, -1n, 0n, 1n, 5]); },
    scoreOf: (args) => { assert.equal(`0x${args.slice(26)}`, TOK); return enc(['bool', 'int256', 'uint8'], [false, 0n, 0]); },
    scoreRecord: () => enc(['int64', 'uint32', 'uint8', 'uint64', 'bytes32'], [42n, 2, 2, 77, FH]),
  };
  const other = { topics: [SCORED_TOPIC, '0x' + TOK.slice(2).padStart(64, '0'), '0x' + '1'.padStart(64, '0')], data: enc(['int64', 'uint8', 'bytes32', 'bytes'], [1n, 1, '0x' + '99'.repeat(32), '0x00000009']) };
  const ours = { ...other, data: enc(['int64', 'uint8', 'bytes32', 'bytes'], [42n, 2, FH, feat]) };
  const { evmCall, seen } = fakeNode(calls, { logs: [ours, other] });
  const s = await readNeuroScore(evmCall, NS);
  assert.equal(s.version, 3);
  assert.equal(s.model.hash, H);
  const t = await readTokenScore(evmCall, NS, TOK, 3);
  assert.equal(t.current.known, false);
  assert.equal(t.stale, true, 'scored with v2, active v3');
  assert.equal(await findFeatures(evmCall, NS, TOK, FH), feat);
  assert.equal(await findFeatures(evmCall, NS, TOK, '0x' + '12'.repeat(32)), null);
  const q = seen.find(([m]) => m === 'eth_getLogs')[1][0];
  assert.deepEqual(q.topics, [SCORED_TOPIC, '0x' + TOK.slice(2).padStart(64, '0')]);
  assert.equal(q.address, NS);
  const spans = seen.filter(([m]) => m === 'eth_getLogs').map(([, [f]]) => Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1);
  assert.ok(spans.every((n) => n <= 500), 'windows of at most 500 blocks (the public node limit)');

  const none = fakeNode({ version: () => enc(['uint32'], [0]) });
  assert.deepEqual(await readNeuroScore(none.evmCall, NS), { version: 0, model: null });
  const fresh = fakeNode({ ...calls, scoreOf: () => enc(['bool', 'int256', 'uint8'], [true, 42n, 2]), scoreRecord: () => enc(['int64', 'uint32', 'uint8', 'uint64', 'bytes32'], [42n, 3, 2, 77, FH]) });
  assert.equal((await readTokenScore(fresh.evmCall, NS, TOK, 3)).stale, false);
  const never = fakeNode({ ...calls, scoreRecord: () => enc(['int64', 'uint32', 'uint8', 'uint64', 'bytes32'], [0n, 0, 0, 0, '0x' + '00'.repeat(32)]) });
  assert.equal((await readTokenScore(never.evmCall, NS, TOK, 3)).stale, false, 'never scored: nothing to rescore');
});

test('committee reader: members, threshold, FROST key; the FROST check is a free read', async () => {
  const C = A('c0');
  const { evmCall } = fakeNode({
    members: () => enc(['address[]'], [[A('01'), A('02'), A('03')]]), threshold: () => enc(['uint256'], [2]),
    frostKeyX: () => enc(['uint256'], [0xabcn]), frostKeyParity: () => enc(['uint256'], [0]), governance: () => enc(['address'], [A('99')]),
    isValidFrost: (args) => enc(['bool'], [args.slice(2, 66) === '11'.repeat(32)]),
  });
  const k = await readCommittee(evmCall, C);
  assert.deepEqual(k, { members: [A('01'), A('02'), A('03')], threshold: 2, frostKey: '0x02' + 'abc'.padStart(64, '0'), governance: A('99') });
  assert.equal(await checkFrost(evmCall, C, '0x' + '11'.repeat(32), '0x02' + '22'.repeat(64)), true);
  assert.equal(await checkFrost(evmCall, C, '0x' + '33'.repeat(32), '0x02' + '22'.repeat(64)), false);
  await assert.rejects(checkFrost(evmCall, C, '0x12', '0x02' + '22'.repeat(64)), /format/);
  await assert.rejects(checkFrost(evmCall, C, '0x' + '11'.repeat(32), '0x0222'), /format/);
});

test('insurance reader: pool, capacity, open claims with what anyone may do, your shares', async () => {
  const I = A('1a'), ME = A('ee');
  const E = 10n ** 18n;
  const NOW = 1_700_000_000;
  const claim = (state, filedAt, decidedAt) => enc(['uint256', 'address', 'uint8', 'uint8', 'uint8', 'uint64', 'uint64', 'uint128', 'uint128', 'bytes32', 'bytes32', 'address', 'uint128'],
    [0, A('aa'), state, 0, 0, filedAt, decidedAt, 5n * E, E, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), A('00'), 0]);
  // ids 0..4: paid, voting (vote over), approved (dispute over), voting (still open), rejected
  const list = [claim(6, 0, 0), claim(1, NOW - 4 * 86400, 0), claim(2, NOW - 6 * 86400, NOW - 3 * 86400), claim(1, NOW - 3600, 0), claim(3, 0, 0)];
  const u = (v) => () => enc(['uint256'], [v]);
  const { evmCall } = fakeNode({
    assets: u(100n * E), totalShares: u(50n * E), activeCover: u(120n * E), premiumBps: u(200), maxCoverBps: u(30000), quorum: u(3),
    voteWindow: u(3 * 86400), disputeWindow: u(2 * 86400), claimCount: u(list.length), coverCount: u(9),
    claims: (args) => list[Number(BigInt(args))], payoutOf: (args) => { assert.equal(BigInt(args), 2n); return enc(['uint256'], [4n * E]); },
    shares: (args) => { assert.equal(`0x${args.slice(26)}`, ME); return enc(['uint256'], [10n * E]); }, pendingShares: u(0), withdrawReadyAt: u(0),
  }, { time: NOW });
  const p = await readInsurance(evmCall, I, { account: ME });
  assert.equal(p.assets, 100n * E);
  assert.equal(p.capacity, 300n * E);
  assert.equal(p.quorum, 3);
  assert.equal(p.claimCount, 5);
  assert.deepEqual(p.open.map((c) => [c.id, c.state, c.action]), [[3, 'voting', null], [2, 'approved', 'payout'], [1, 'voting', 'expire']], 'newest first, closed ones left out');
  assert.equal(p.open.find((c) => c.id === 2).payout, 4n * E);
  assert.deepEqual(p.me, { shares: 10n * E, pending: 0n, readyAt: 0, value: 20n * E, canWithdraw: false });
  const anon = await readInsurance(evmCall, I, { last: 2 });
  assert.equal(anon.me, null);
  assert.deepEqual(anon.open.map((c) => c.id), [3], 'only the last 2 claims read');
});

test('issuance reader: buckets, what waits, the overflow and the balance', async () => {
  const U = A('15');
  const { evmCall } = fakeNode({
    buckets: () => enc(['(address,uint16,uint128,uint128)[]'], [[[A('0a'), 4000, 100n, 30n], [A('0b'), 2500, 50n, 5n]]]),
    pendingOverflow: () => enc(['uint256'], [7n]), overflow: () => enc(['address'], [A('0f')]),
  }, { balance: 42n });
  const s = await readIssuance(evmCall, U);
  assert.equal(s.accrued, 35n);
  assert.equal(s.sharedBps, 6500);
  assert.equal(s.pendingOverflow, 7n);
  assert.equal(s.overflow, A('0f'));
  assert.equal(s.balance, 42n);
});

test('epochs reader: the version in force at the current block and the next one', async () => {
  const M = A('3e'), H1 = '0x' + '01'.repeat(32), H2 = '0x' + '02'.repeat(32);
  const base = { count: () => enc(['uint256'], [2]), epochLength: () => enc(['uint64'], [100]), minDelay: () => enc(['uint64'], [50]),
    versionByIndex: (args) => { assert.equal(BigInt(args), 1n); return enc(['bytes32', 'uint64', 'uint64', 'string'], [H2, 1200, 950, 'ipfs://two']); } };
  const now = fakeNode({ ...base, current: () => enc(['bool', 'uint256', 'bytes32', 'uint64', 'string'], [true, 0, H1, 600, 'ipfs://one']) }, { block: 1000 });
  const s = await readEpochs(now.evmCall, M);
  assert.equal(s.block, 1000);
  assert.equal(s.epochLength, 100);
  assert.deepEqual(s.current, { found: true, index: 0, hash: H1, activation: 600, uri: 'ipfs://one' });
  assert.deepEqual(s.next, { index: 1, hash: H2, activation: 1200, scheduledAt: 950, uri: 'ipfs://two' });
  // before the first version: nothing in force, the next is index 0
  const early = fakeNode({ ...base, current: () => enc(['bool', 'uint256', 'bytes32', 'uint64', 'string'], [false, 0, '0x' + '00'.repeat(32), 0, '']),
    count: () => enc(['uint256'], [1]), versionByIndex: (args) => { assert.equal(BigInt(args), 0n); return enc(['bytes32', 'uint64', 'uint64', 'string'], [H1, 600, 10, 'u']); } }, { block: 20 });
  const e = await readEpochs(early.evmCall, M);
  assert.equal(e.current, null);
  assert.equal(e.next.activation, 600);
  // the last version already in force: nothing next
  const last = fakeNode({ ...base, current: () => enc(['bool', 'uint256', 'bytes32', 'uint64', 'string'], [true, 1, H2, 1200, 'ipfs://two']) }, { block: 5000 });
  assert.equal((await readEpochs(last.evmCall, M)).next, null);
});

test('the hub: an On-chain AI tab with its page, and the AI map items point at it', () => {
  const hub = readFileSync(join(HERE, 'hub.js'), 'utf8');
  assert.match(hub, /\{ id: 'aichain', page: true/);
  assert.match(hub, /\n {2}aichain: '<path/, 'tab icon');
  assert.match(readFileSync(join(HERE, 'pages.js'), 'utf8'), /aichain, \.\.\.ASSIST_PAGES/);
  assert.match(readFileSync(join(HERE, 'build.mjs'), 'utf8'), /'aichain\.js', 'aichain-i18n\.js'/, 'shipped in dist/');
  const src = readFileSync(join(HERE, 'aichain.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|style=|\.style\./, 'textContent only, no inline style (CSP)');
  const want = { 3: ['aichain', 'neuroScore'], 14: ['aichain', 'cosignCommittee'], 18: ['immune', 'neuroOracleSender'], 32: ['aichain', 'hackInsurance'], 34: ['aichain', 'usefulIssuance'], 35: ['aichain', 'modelEpochs'] };
  for (const [n, [tab, key]] of Object.entries(want)) {
    const it = ITEMS[n];
    assert.equal(it.tab, tab, `#${n} tab`);
    assert.equal(it.s, 'notDeployed', `#${n}`);
    assert.deepEqual(it.needs, [key], `#${n} needs`);
    assert.equal(statusOf(it, {}), 'notDeployed');
    assert.equal(statusOf(it, { [key]: A('12') }), 'live', `#${n} live once ${key} is deployed`);
  }
  assert.equal(Object.values(ITEMS).filter((it) => it.s === 'cli').length, 0, 'nothing is command-line only any more');
});

test('self-healing card: CircuitBreaker policy and trip decoders (structs with dynamic arrays) and readers', async () => {
  const POLICY = 'tuple(address governance,uint32 window,uint32 maxPause,uint8 quorum,bool active,uint16 invariantMask,uint16 tripCapBps,uint32 holdReview,uint256 holdAbove,bytes4[] selectors,address[] assets)';
  const TRIP = 'tuple(address protocol,uint8 kind,uint8 claim,uint16 mask,uint64 start,uint64 until,uint64 fromBlock,uint64 toBlock,uint64 claimedAt,bytes32 evidenceHash,bytes32 detectorId,uint256 claimBond,address[] runners)';
  const pol = enc([POLICY], [[A('11'), 600, 21600, 3, true, 4, 1000, 3600, 50n, ['0xd0e30db0', '0x2e1a7d4d', '0x853828b6'], [A('00')]]]);
  assert.deepEqual(readBreakerPolicy(pol), { governance: A('11'), window: 600, maxPause: 21600, quorum: 3, active: true, selectors: 3 });
  const empty = enc([POLICY], [[A('00'), 0, 0, 0, false, 0, 0, 0, 0n, [], []]]);
  assert.equal(readBreakerPolicy(empty).active, false);
  const trip = enc([TRIP], [[A('22'), 0, 0, 4, 1000, 22600, 50, 50, 0, '0x' + '33'.repeat(32), '0x' + '44'.repeat(32), 0n, [A('aa'), A('bb'), A('cc')]]]);
  assert.deepEqual(readBreakerTrip(trip), { protocol: A('22'), kind: 'runners', mask: 4, start: 1000, until: 22600, fromBlock: 50, toBlock: 50, runners: 3 });
  assert.equal(readBreakerTrip(enc([TRIP], [[A('22'), 1, 0, 4, 1, 2, 3, 3, 0, '0x' + '33'.repeat(32), '0x' + '44'.repeat(32), 0n, []]])).kind, 'invariant');
  const B = A('cb');
  const P = A('22');
  const node = fakeNode({
    protocolCount: () => enc(['uint256'], [2]), tripCount: () => enc(['uint256'], [5]), guardianBond: () => enc(['uint256'], [10n ** 19n]), minQuorum: () => enc(['uint256'], [3]),
    policyOf: (args) => (args.endsWith('22'.repeat(20)) ? pol : empty), isTripped: () => enc(['bool'], [true]), lastTrip: () => enc(['uint256'], [5]),
    tripOf: (args) => { assert.equal(BigInt(args), 4n); return trip; },
  });
  assert.deepEqual(await readBreaker(node.evmCall, B), { protocols: 2, trips: 5, guardianBond: 10n ** 19n, minQuorum: 3 });
  const r = await readBreakerProtocol(node.evmCall, B, P);
  assert.equal(r.tripped, true);
  assert.equal(r.policy.quorum, 3);
  assert.equal(r.last.id, 4);
  assert.equal(r.last.runners, 3);
  assert.deepEqual(await readBreakerProtocol(node.evmCall, B, A('99')), { policy: null, tripped: false, last: null });
  // the selectors match the contract's ABI
  const abi = JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-network', 'artifacts', 'CircuitBreaker.json'), 'utf8')).abi;
  const iface = new Interface(abi);
  for (const k of ['protocolCount', 'tripCount', 'guardianBond', 'minQuorum', 'isTripped', 'lastTrip', 'tripOf', 'policyOf']) assert.equal(iface.getFunction(k).selector, SEL[k], k);
  assert.equal(iface.getFunction('policyOf').outputs[0].format('full').replace(/ /g, ''), POLICY.replace(/ /g, '').replace(/^tuple/, ''));
  assert.equal(iface.getFunction('tripOf').outputs[0].format('full').replace(/ /g, ''), TRIP.replace(/ /g, '').replace(/^tuple/, ''));
});
