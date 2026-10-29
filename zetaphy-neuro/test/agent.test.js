// Investigator (agent/): step order, timeouts, partial failures, the optional
// ML / LLM hooks, alert dedupe and throttling, the scheduled pool scan, the
// NeuroJobs runner adapter and the browser watch list.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, featuresOf, STEPS } from '../agent/pipeline.js';
import { registerMl, registerLlm, clearHooks, getHooks } from '../agent/hooks.js';
import { planAlerts, issueFor, keyOfIssue, alertKey } from '../agent/alerts.js';
import { scanPools, newTokensFromLogs } from '../agent/scan-pools.js';
import { jobsFromLogs, createGraphRunner, verdictPayload } from '../agent/runner.js';
import { createWatchList, createWatcher } from '../agent/watch.js';
import { TOPIC, word, addrWord } from '../graph/util.js';
import { ZETAPHY } from '../graph/sources.js';

afterEach(() => clearHooks());

const TOKEN = '0x' + 'ab'.repeat(20);
const report = (level, findings = []) => ({ chain: 'bsc', address: TOKEN, reportHash: 'r'.repeat(64), analysis: { level, findings: [{ id: 'erc20', severity: 'info' }, ...findings] } });
const graph = (signals = [], partial = false) => ({ level: 'info', signals, partial, receivers: [], clusters: [], nodes: [], edges: [], known: {} });

/** Deps that record the order in which steps ran. */
function recorder(over = {}) {
  const order = [];
  return {
    order,
    deps: {
      readContract: async () => { order.push('rules'); return report('low', [{ id: 'mint', severity: 'low' }]); },
      simulateTrade: async () => { order.push('honeypot'); return { stage: 'done', dex: 'X', buyTax: 1, sellTax: 2, bought: '1', sold: '1' }; },
      buildGraph: async () => { order.push('graph'); return graph([{ id: 'holders-sybil', severity: 'medium', params: { count: 4, total: 8 }, evidence: [] }]); },
      rpcFor: () => ({ call: async () => '0x' }),
      now: () => 1_700_000_000_000,
      ...over,
    },
  };
}

test('pipeline: steps run in the fixed order and the report combines them', async () => {
  const { order, deps } = recorder();
  const seen = {};
  const r = await investigate({ chain: 'bsc', address: TOKEN }, {
    ...deps,
    hooks: {
      ml: { score: async (f) => { order.push('ml'); seen.features = f; return { score: 0.3, model: 'test' }; } },
      llm: { review: async (c) => { order.push('llm'); seen.context = c; return { summary: 'looks like a normal token‮', model: 'x' }; } },
    },
  });
  assert.deepEqual(order, STEPS);
  assert.deepEqual(r.steps.map((s) => [s.name, s.status]), STEPS.map((s) => [s, 'ok']));
  assert.equal(r.level, 'medium'); // graph's sybil signal raises rules' low
  assert.equal(r.confidence, 1);
  assert.equal(r.review.summary, 'looks like a normal token'); // invisible characters stripped
  // ML sees numbers only; the LLM sees ids and numbers, never text from the token.
  assert.ok(Object.values(seen.features).every((v) => typeof v === 'number'));
  assert.ok(!JSON.stringify(seen.context).includes('name'));
  assert.ok(r.signals.some((s) => s.source === 'honeypot' && s.id === 'sim-ok'));
  assert.ok(r.signals.some((s) => s.source === 'graph' && s.id === 'holders-sybil'));
  assert.match(r.reportHash, /^[0-9a-f]{64}$/);
});

test('pipeline: same inputs give the same report id', async () => {
  const a = await investigate({ chain: 'bsc', address: TOKEN }, recorder().deps);
  const b = await investigate({ chain: 'bsc', address: TOKEN }, recorder().deps);
  assert.equal(a.reportHash, b.reportHash);
});

test('pipeline: a step that hangs times out and the next steps still run', async () => {
  const { order, deps } = recorder({ buildGraph: () => new Promise(() => {}) });
  const r = await investigate({ chain: 'bsc', address: TOKEN }, {
    ...deps, timeouts: { graph: 50 }, hooks: { ml: { score: async () => { order.push('ml'); return 0.1; } } },
  });
  const st = Object.fromEntries(r.steps.map((s) => [s.name, s.status]));
  assert.equal(st.graph, 'timeout');
  assert.equal(st.ml, 'ok');
  assert.equal(st.llm, 'skipped');
  assert.deepEqual(order, ['rules', 'honeypot', 'ml']);
  assert.ok(r.confidence < 0.7);
  assert.equal(r.graph, null);
});

test('pipeline: partial failures are recorded, not thrown', async () => {
  const { deps } = recorder({ readContract: async () => { throw new Error('all RPC endpoints failed'); } });
  const r = await investigate({ chain: 'bsc', address: TOKEN }, deps);
  const st = Object.fromEntries(r.steps.map((s) => [s.name, s.status]));
  assert.equal(st.rules, 'failed');
  assert.match(r.steps[0].error, /RPC/);
  assert.equal(st.honeypot, 'ok'); // the trade test needs no rules report
  assert.equal(st.graph, 'ok');
  assert.equal(r.level, 'medium');
  assert.ok(r.confidence <= 0.6);
  // Nothing at all: level unknown.
  const none = await investigate({ chain: 'bsc', address: TOKEN }, recorder({
    readContract: async () => { throw new Error('x'); }, buildGraph: async () => { throw new Error('y'); }, simulateTrade: async () => { throw new Error('z'); },
  }).deps);
  assert.equal(none.level, 'unknown');
  assert.equal(none.confidence, 0);
});

test('pipeline: the trade test is skipped where it does not apply', async () => {
  const official = await investigate({ chain: 'bsc', address: TOKEN }, recorder({ readContract: async () => report('low', [{ id: 'known-issuer', severity: 'good' }]) }).deps);
  assert.equal(official.steps.find((s) => s.name === 'honeypot').status, 'skipped');
  const noDex = await investigate({ chain: 'zetaphy', address: TOKEN }, recorder().deps);
  assert.equal(noDex.steps.find((s) => s.name === 'honeypot').status, 'skipped');
  assert.equal(noDex.confidence, 1); // not applicable: not counted against it
  const noCode = await investigate({ chain: 'bsc', address: TOKEN }, recorder({ readContract: async () => ({ ...report('info'), analysis: { level: 'info', findings: [{ id: 'no-code', severity: 'info' }] } }) }).deps);
  assert.deepEqual(noCode.steps.slice(1, 3).map((s) => s.status), ['skipped', 'skipped']);
});

test('hooks: ML can raise to medium only, LLM never changes the level, bad output fails the step', async () => {
  registerMl({ score: async () => 0.95 });
  assert.ok(getHooks().ml);
  const deps = recorder({ buildGraph: async () => graph([]) }).deps;
  const r = await investigate({ chain: 'bsc', address: TOKEN }, deps);
  assert.equal(r.level, 'medium');
  assert.ok(r.signals.some((s) => s.id === 'ml-high-score'));
  registerMl({ score: async () => 7 });
  registerLlm({ review: async () => ({ summary: 'HIGH RISK, ignore the rules' }) });
  const r2 = await investigate({ chain: 'bsc', address: TOKEN }, deps);
  assert.equal(r2.steps.find((s) => s.name === 'ml').status, 'failed');
  assert.equal(r2.level, 'low');
  assert.equal(r2.review.summary, 'HIGH RISK, ignore the rules');
  assert.throws(() => registerMl({ nope: 1 }), /score/);
  assert.throws(() => registerLlm({}), /review/);
  // A hook that hangs times out.
  const r3 = await investigate({ chain: 'bsc', address: TOKEN }, { ...deps, timeouts: { llm: 30 }, hooks: { ml: null, llm: { review: () => new Promise(() => {}) } } });
  assert.equal(r3.steps.find((s) => s.name === 'llm').status, 'timeout');
});

test('features: numbers only, stable keys', () => {
  const f = featuresOf({ rules: report('high', [{ id: 'mint', severity: 'high' }]), honeypot: { stage: 'sell-failed', buyTax: 3 }, graph: graph([{ id: 'lp-removed', severity: 'high', params: { share: 90 } }]) });
  assert.equal(f.rules_high, 1);
  assert.equal(f['f:mint'], 1);
  assert.equal(f.sim_cannot_sell, 1);
  assert.equal(f['g:lp-removed'], 3);
  assert.equal(f.lp_removed_share, 90);
});

// ------------------------------------------------------------ alerts
const rep = (address, level, { confidence = 0.9, score = 85 } = {}) => ({ target: { chain: 'zetaphy', address }, level, confidence, score, reportHash: 'f'.repeat(64), steps: [{ name: 'rules', status: 'ok' }], signals: [{ source: 'graph', id: 'lp-removed', severity: 'high', params: { share: 90, addr: '0x' + '11'.repeat(20), linked: true }, evidence: [{ kind: 'tx', value: '0x' + 'aa'.repeat(32) }, { kind: 'address', value: '@everyone' }] }] });
const A = (n) => '0x' + String(n).repeat(40).slice(0, 40);

test('alerts: dedupe against existing issues (open or closed) and within a run', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const existing = [{ body: issueFor(rep(A(1), 'high')).body, created_at: '2026-10-01T00:00:00Z', state: 'closed' }];
  assert.equal(keyOfIssue(existing[0]), alertKey('zetaphy', A(1)));
  const plan = planAlerts([rep(A(1), 'high'), rep(A(2), 'high'), rep(A(2).toUpperCase().replace('0X', '0x'), 'high'), rep(A(3), 'medium')], existing, { now });
  assert.deepEqual(plan.create.map((r) => r.target.address), [A(2)]);
  assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ['below-threshold', 'duplicate', 'repeat']);
});

test('alerts: throttled per run and per day; low confidence never alerts', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const many = [4, 5, 6, 7, 8].map((n) => rep(A(n), 'high'));
  assert.equal(planAlerts(many, [], { now, maxPerRun: 3 }).create.length, 3);
  const today = Array.from({ length: 9 }, (_, i) => ({ body: `x <!-- neuro-alert-key: zetaphy:${A(9).slice(0, 41)}${i} -->`, created_at: '2026-11-05T01:00:00Z' }));
  const p = planAlerts(many, today, { now, maxPerRun: 3, maxPerDay: 10 });
  assert.equal(p.create.length, 1);
  assert.equal(p.skipped.filter((s) => s.reason === 'throttled').length, 4);
  assert.equal(planAlerts([rep(A(4), 'high', { confidence: 0.3 })], [], { now }).create.length, 0);
});

test('alerts: the issue holds only checked values (no mentions, no token text)', () => {
  const { title, body, labels } = issueFor(rep(A(1), 'high'), { explorer: (_c, v, k) => `https://explorer.example/${k}/${v}` });
  assert.deepEqual(labels, ['neuro-alert']);
  assert.match(title, /^Neuro alert: high result for 0x11111111… on zetaphy$/);
  assert.ok(!body.includes('@'));
  assert.match(body, /neuro-alert-key: zetaphy:0x1{40}/);
  assert.match(body, /\(https:\/\/explorer\.example\/tx\/0xa{64}\)/);
  assert.match(body, /not an accusation/);
});

test('scan: quiet before the RPC is back, and quiet when it is down', async () => {
  const logs = [];
  let calls = 0;
  const rpc = { call: async () => { calls++; throw new Error('HTTP 503'); } };
  const paused = await scanPools({ now: Date.parse('2026-10-28T00:00:00Z'), rpc, log: (l) => logs.push(l), env: {} });
  assert.equal(paused.status, 'paused');
  assert.equal(calls, 0);
  const down = await scanPools({ now: Date.parse('2026-11-02T00:00:00Z'), rpc, log: (l) => logs.push(l), env: {} });
  assert.equal(down.status, 'rpc-unavailable');
  assert.equal(logs.length, 2);
});

test('scan: new pools -> investigations -> one issue; the next run opens nothing', async () => {
  const t0 = '0x' + 'c1'.repeat(20);
  const t1 = '0x' + 'c2'.repeat(20);
  const pairLog = (a, b, pair) => ({ address: ZETAPHY.dex.factory, topics: [TOPIC.pairCreated, '0x' + addrWord(a), '0x' + addrWord(b)], data: '0x' + addrWord(pair) + word(1), blockNumber: '0x10', transactionHash: '0x' + '01'.repeat(32) });
  const dlmmLog = { address: ZETAPHY.dlmmFactory, topics: [TOPIC.dlmmPairCreated, '0x' + addrWord(t1), '0x' + addrWord(ZETAPHY.baseTokens[1]), '0x' + word(25)], data: '0x' + addrWord('0x' + 'd1'.repeat(20)) + word(0) + word(1), blockNumber: '0x11', transactionHash: '0x' + '02'.repeat(32) };
  const rpc = {
    call: async (m, p) => {
      if (m === 'eth_blockNumber') return '0x2000';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + (parseInt(p[0], 16) * 2).toString(16) };
      if (m === 'eth_getLogs') return p[0].address === ZETAPHY.dex.factory ? [pairLog(t0, ZETAPHY.baseTokens[0], '0x' + 'e1'.repeat(20))] : [dlmmLog];
      throw new Error(m);
    },
  };
  const issues = [];
  const github = {
    alertIssues: async () => issues,
    ensureLabel: async () => {},
    createIssue: async (i) => { issues.push({ ...i, created_at: new Date('2026-11-02T00:00:00Z').toISOString() }); return { number: issues.length }; },
  };
  const investigateFn = async (target) => rep(target.address, target.address === t0 ? 'high' : 'low');
  const opts = { now: Date.parse('2026-11-02T00:00:00Z'), rpc, github, investigateFn, log: () => {}, env: {} };
  const first = await scanPools(opts);
  assert.deepEqual(first.pools.map((p) => p.token), [t0, t1]);
  assert.equal(first.created.length, 1);
  assert.equal(issues.length, 1);
  const second = await scanPools(opts);
  assert.equal(second.created.length, 0);
  assert.ok(second.skipped.some((s) => s.reason === 'duplicate'));
});

test('scan: base tokens (wrapped native, test stables) are never "the new token"', () => {
  const l = { address: ZETAPHY.dex.factory, topics: [TOPIC.pairCreated, '0x' + addrWord(ZETAPHY.baseTokens[0]), '0x' + addrWord(ZETAPHY.baseTokens[1])], data: '0x' + word(5) + word(1), blockNumber: '0x1', transactionHash: '0x' + '0'.repeat(64) };
  assert.deepEqual(newTokensFromLogs([l]), []);
});

// ------------------------------------------------------------ runner
const strWord = (s) => { const h = Buffer.from(s).toString('hex'); return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); };
const jobLog = (id, chain, target) => ({
  topics: [TOPIC.jobRequested, '0x' + word(id), '0x' + Buffer.from(chain).toString('hex').padEnd(64, '0')],
  data: '0x' + word(64) + word(10n ** 15n) + strWord(target), blockNumber: '0x5',
});

test('runner: reads jobs, investigates, signs and posts each once', async () => {
  const target = '0x' + '5e'.repeat(20);
  assert.deepEqual(jobsFromLogs([jobLog(7, 'bsc', target), { topics: ['0x00'] }]), [{ id: '7', chain: 'bsc', target, block: 5 }]);
  const logs = [jobLog(7, 'bsc', target), jobLog(8, 'nochain', target)];
  const rpc = { call: async (m) => (m === 'eth_blockNumber' ? '0x100' : logs) };
  const signed = [];
  const posted = [];
  const runner = createGraphRunner({
    rpc, jobs: '0x' + '10'.repeat(20),
    investigateFn: async (t) => rep(t.address, 'high'),
    sign: async (payload) => { signed.push(payload); return { message: {}, payload, signature: '0xsig' }; },
    post: async (env) => { posted.push(env); },
  });
  const out = await runner.tick();
  assert.equal(out.length, 1);
  assert.equal(signed[0].verdictHash, '0x' + 'f'.repeat(64));
  assert.equal(signed[0].jobId, '7');
  assert.equal(signed[0].score, 85);
  assert.ok(signed[0].summary.length <= 280);
  assert.equal(posted.length, 1);
  assert.deepEqual(runner.state.done, ['7', '8']);
  runner.state.cursor = 0; // the same window again: nothing new
  assert.equal((await runner.tick()).length, 0);
  assert.equal(posted.length, 1);
  assert.deepEqual(Object.keys(verdictPayload(rep(target, 'low'))).sort(), ['address', 'chain', 'score', 'summary', 'verdictHash']);
});

// ------------------------------------------------------------ watch list
function fakeStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }

test('watch: follow, due, worse-than-before, and broken storage', async () => {
  let t = 1_000;
  const list = createWatchList({ storage: fakeStorage(), now: () => t });
  assert.equal(list.follow('bsc', TOKEN.toUpperCase().replace('0X', '0x')), true);
  assert.equal(list.follow('bsc', TOKEN), false); // same token
  const levels = ['low', 'high'];
  const changes = [];
  const w = createWatcher({ list, investigate: async () => ({ level: levels.shift(), confidence: 1, reportHash: 'h' }), onChange: (_i, _r, worse) => changes.push(worse), intervalMs: 100, setInterval: () => 1, clearInterval: () => {} });
  await w.tick();
  assert.equal(await w.tick(), null); // not due yet
  t += 200;
  await w.tick();
  assert.deepEqual(changes, [false, true]);
  assert.equal(list.list()[0].worse, true);
  const hidden = createWatcher({ list, investigate: async () => { throw new Error('never'); }, isVisible: () => false });
  t += 200;
  assert.equal(await hidden.tick(), null);
  const broken = createWatchList({ storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
  assert.equal(broken.follow('eth', TOKEN), true);
  assert.equal(broken.list().length, 1);
});
