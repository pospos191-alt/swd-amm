// Money-flow graph (graph/): funding walk (cycles, hop limits, hubs, budget),
// sybil clustering, signals, the full build against a mocked chain + Blockscout,
// the RPC-only path, caching, i18n and the layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkFunding, createWalkMemo } from '../graph/walk.js';
import { clusterByFunder } from '../graph/cluster.js';
import { deriveSignals, levelOf } from '../graph/signals.js';
import { buildFlowGraph } from '../graph/build.js';
import { createEvmProvider } from '../graph/evm.js';
import { createEvmClient, createBlockscout } from '../graph/clients.js';
import { createBudget, BudgetError, TOPIC, word, addrWord } from '../graph/util.js';
import { createCache, memoryCache } from '../graph/cache.js';
import { createKnownBad, createVerdictMemory } from '../graph/knownbad.js';
import { FLOW_TEXT, signalText, flowUi } from '../graph/i18n.js';
import { layout } from '../graph/view.js';
import { sourcesFor } from '../graph/sources.js';
import { W, worldFetch } from './helpers/flow-world.js';

/** funderOf / profile over a plain map: { addr: funder } and a set of hubs. */
function fakeChain(funders, hubs = new Set(), calls = []) {
  return {
    funderOf: async (a) => { calls.push(a); return funders[a] ? { funder: funders[a], tx: `tx-${a}` } : null; },
    profile: async (a) => ({ hub: hubs.has(a), nonce: hubs.has(a) ? 1e6 : 1 }),
  };
}

test('walk: follows funders back and stops at the hop limit', async () => {
  const funders = { a0: 'a1', a1: 'a2', a2: 'a3', a3: 'a4', a4: 'a5' };
  const w = await walkFunding('a0', { ...fakeChain(funders), maxHops: 3 });
  assert.equal(w.stop, 'hops');
  assert.deepEqual(w.hops.map((h) => [h.from, h.to, h.hop]), [['a1', 'a0', 1], ['a2', 'a1', 2], ['a3', 'a2', 3]]);
  assert.equal(w.origin, 'a3');
});

test('walk: a cycle stops the walk (and is recorded once)', async () => {
  const w = await walkFunding('a', { ...fakeChain({ a: 'b', b: 'c', c: 'a' }), maxHops: 10 });
  assert.equal(w.stop, 'cycle');
  assert.deepEqual(w.hops.map((h) => h.from), ['b', 'c', 'a']);
  const self = await walkFunding('x', { ...fakeChain({ x: 'x' }), maxHops: 5 });
  assert.equal(self.stop, 'cycle');
  assert.equal(self.hops.length, 1);
});

test('walk: stops at a hub, at the origin, and on an exhausted budget', async () => {
  const hub = await walkFunding('a', { ...fakeChain({ a: 'b', b: 'ex', ex: 'z' }, new Set(['ex'])), maxHops: 5 });
  assert.equal(hub.stop, 'hub');
  assert.equal(hub.origin, 'ex');
  const origin = await walkFunding('a', { ...fakeChain({ a: 'b' }), maxHops: 5 });
  assert.equal(origin.stop, 'origin');
  const budget = createBudget({ maxRequests: 1 });
  const w = await walkFunding('a', {
    funderOf: async (x) => { budget.take(); return { funder: x + 'x' }; }, profile: async () => ({ hub: false }), maxHops: 5,
  });
  assert.equal(w.stop, 'budget');
  assert.equal(w.hops.length, 1);
  const broken = await walkFunding('a', { funderOf: async () => { throw new Error('boom'); }, profile: async () => ({}) });
  assert.equal(broken.stop, 'error');
});

test('walk: a shared memo looks each address up once', async () => {
  const calls = [];
  const chain = fakeChain({ r1: 's', r2: 's', r3: 's', s: 'ex' }, new Set(['ex']), calls);
  const memo = createWalkMemo();
  for (const r of ['r1', 'r2', 'r3']) await walkFunding(r, { ...chain, maxHops: 3, memo });
  assert.equal(calls.filter((c) => c === 's').length, 1);
});

test('cluster: wallets with a shared non-hub funder group together; hubs link nobody', async () => {
  const funders = { r1: 's', r2: 's', r3: 'm', m: 's', r4: 'ex', r5: 'ex', r6: 'ex', s: 'ex' };
  const hubs = new Set(['ex']);
  const memo = createWalkMemo();
  const walks = [];
  for (const r of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) walks.push(await walkFunding(r, { ...fakeChain(funders, hubs), maxHops: 3, memo }));
  const clusters = clusterByFunder(walks, { hubs, minSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].source, 's');
  assert.deepEqual(clusters[0].members, ['r1', 'r2', 'r3']);
  assert.equal(clusters[0].hop, 2); // r3 reaches s through m
  assert.ok(clusters[0].evidence.includes('tx-r3') && clusters[0].evidence.includes('tx-m'));
  assert.equal(clusterByFunder(walks, { hubs, minSize: 4 }).length, 0);
  // Ignored addresses (the pool) never count as members or links.
  assert.equal(clusterByFunder(walks, { hubs, minSize: 3, ignore: new Set(['s']) }).length, 0);
});

test('cluster: cycles in trails do not loop or double-count', async () => {
  const funders = { r1: 'q', r2: 'q', r3: 'q', q: 'r1' };
  const memo = createWalkMemo();
  const walks = [];
  for (const r of ['r1', 'r2', 'r3']) walks.push(await walkFunding(r, { ...fakeChain(funders), maxHops: 4, memo }));
  const [c] = clusterByFunder(walks, { minSize: 3 });
  assert.deepEqual(c.members, ['r1', 'r2', 'r3']);
  assert.equal(c.source, 'q');
});

test('build: full graph on a mocked chain + Blockscout gives the expected signals with evidence', async () => {
  const stats = { calls: [] };
  const g = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch(stats), cache: memoryCache(), maxRequests: 400 });
  const ids = Object.fromEntries(g.signals.map((s) => [s.id, s]));
  assert.equal(g.creation.deployer, W.deployer);
  assert.equal(g.creation.tx, W.txCreate);
  assert.deepEqual(g.deployerWalk.hops.map((h) => h.from), [W.f1, W.f2, W.exchange]);
  assert.equal(g.deployerWalk.stop, 'hub');
  // Funding trail reaches the flagged address (ThreatRegistry, read on ZETAPHY).
  assert.equal(ids['funding-flagged'].severity, 'high');
  assert.equal(ids['funding-flagged'].params.addr, W.f2);
  assert.equal(ids['funding-flagged'].params.source, 'registry');
  assert.equal(ids['funding-flagged'].params.reason, 'unlimited-mint');
  // Four holders funded from one non-exchange address.
  assert.equal(ids['holders-sybil'].params.addr, W.sybil);
  assert.equal(ids['holders-sybil'].params.count, 4);
  // Two holders funded by the deployer itself.
  assert.equal(ids['holders-funded-by-deployer'].params.count, 2);
  // Liquidity: 90% of the deployer's LP removed, evidence includes add and remove txs.
  assert.equal(ids['lp-removed'].severity, 'high');
  assert.equal(ids['lp-removed'].params.share, 90);
  assert.equal(ids['lp-removed'].params.blocks, 35);
  assert.ok(ids['lp-removed'].evidence.some((e) => e.value === W.txRemove));
  assert.ok(ids['lp-removed'].evidence.some((e) => e.value === W.txAdd));
  assert.equal(ids['lp-held'].severity, 'medium');
  // Same deployer, earlier token, liquidity fully removed.
  assert.equal(ids['prior-lp-removed'].params.addr, W.old);
  assert.equal(ids['prior-lp-removed'].params.share, 100);
  assert.equal(ids['fresh-deployer'].params.nonce, 3);
  assert.equal(g.level, 'high');
  assert.equal(g.partial, false, g.notes.join(', '));
  // Graph shape: roles and edges with tx evidence.
  const node = (a) => g.nodes.find((n) => n.id === a);
  assert.ok(node(W.token).roles.includes('token'));
  assert.ok(node(W.deployer).roles.includes('deployer'));
  assert.ok(node(W.exchange).roles.includes('hub'));
  assert.ok(node(W.sybil).roles.includes('cluster-source'));
  assert.ok(node(W.f2).flagged);
  assert.ok(node(W.lpTo).roles.includes('lp-receiver'));
  assert.ok(g.edges.some((e) => e.kind === 'lp-remove' && e.tx === W.txRemove));
  // Exchange never linked anyone: R5 (funded by it) is in no cluster.
  assert.ok(g.clusters.every((c) => !c.members.includes(W.r[4])));
  // Same facts, same id.
  const again = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch(), cache: memoryCache(), maxRequests: 400 });
  assert.equal(again.graphHash, g.graphHash);
});

test('build: a small request budget gives a partial graph, never a throw', async () => {
  const g = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch(), maxRequests: 6 });
  assert.equal(g.partial, true);
  assert.ok(g.notes.some((n) => /budget/.test(n)));
  assert.ok(g.signals.some((s) => s.id === 'graph-partial'));
  assert.ok(g.stats.requests <= 6);
});

test('build: the registry being down (RPC paused) is noted and the rest still works', async () => {
  const g = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch({ calls: [] }, { failRegistry: true }), maxRequests: 400 });
  assert.ok(g.notes.includes('registry-unavailable'));
  assert.ok(!g.signals.some((s) => s.id === 'funding-flagged'));
  assert.ok(g.signals.some((s) => s.id === 'lp-removed'));
});

test('build: Neuro\'s own memory of a high result links the deployer', async () => {
  const memory = createVerdictMemory(memoryCache());
  await memory.remember('base', W.deployer, { level: 'high', ref: 'abc' });
  const g = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch(), memory, registryRpc: false, maxRequests: 400 });
  const s = g.signals.find((x) => x.id === 'deployer-flagged');
  assert.equal(s.params.source, 'memory');
  assert.match(signalText(s, 'en'), /earlier Neuro check/);
});

test('evm provider: RPC-only (no explorer) finds creation by binary search and chunks logs', async () => {
  const token = '0x' + '77'.repeat(20);
  const deployer = '0x' + 'dd'.repeat(20);
  const created = 3_210;
  const ranges = [];
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    calls.push(method);
    let result;
    switch (method) {
      case 'eth_chainId': result = '0x38'; break;
      case 'eth_blockNumber': result = '0x' + (20_000).toString(16); break;
      case 'eth_getCode': result = (params[1] === 'latest' ? 20_000 : parseInt(params[1], 16)) >= created ? '0x60' : '0x'; break;
      case 'eth_getLogs': {
        const [from, to] = [parseInt(params[0].fromBlock, 16), parseInt(params[0].toBlock, 16)];
        ranges.push(to - from + 1);
        result = from <= created && created <= to && !params[0].topics
          ? [{ address: token, topics: [TOPIC.transfer, '0x' + word(0), '0x' + addrWord(deployer)], data: '0x' + word(5), blockNumber: '0x' + created.toString(16), transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0' }]
          : []; break;
      }
      case 'eth_getTransactionByHash': result = { from: deployer, to: null, blockNumber: '0x' + created.toString(16) }; break;
      case 'trace_filter': return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, error: { code: -32601, message: 'the method trace_filter does not exist/is not available' } }) };
      default: result = null;
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
  const src = sourcesFor('bsc');
  const rpc = createEvmClient(['https://bsc.example'], 56, { fetchImpl, gapMs: 0 });
  const p = createEvmProvider({ rpc, src, maxLogChunks: 3 });
  const c = await p.creation(token);
  assert.equal(c.block, created);
  assert.equal(c.deployer, deployer);
  assert.ok(calls.filter((m) => m === 'eth_getCode').length <= 17); // log2(20000) + 1
  // No explorer and no trace_filter: the funder is unknown (not guessed), and trace_filter is not asked twice.
  assert.equal(await p.funderOf(deployer), null);
  assert.equal(await p.funderOf(token), null);
  assert.equal(calls.filter((m) => m === 'trace_filter').length, 1);
  await p.earlyReceivers(token, created, { limit: 5 });
  assert.ok(ranges.slice(1).every((r) => r <= src.logRange));
  assert.ok(p.notes.includes('logs-window-limited'));
});

test('clients: method allow-list, budget and caching', async () => {
  let n = 0;
  const fetchImpl = async (_u, init) => { n++; const { id, method } = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x1' : '0xabc' }) }; };
  const cache = memoryCache();
  const budget = createBudget({ maxRequests: 3 });
  const rpc = createEvmClient(['https://x.example'], 1, { fetchImpl, budget, cache, gapMs: 0 });
  await assert.rejects(rpc.call('eth_sendRawTransaction', ['0x']), /not allowed/);
  await assert.rejects(rpc.call('eth_sign', ['0x']), /not allowed/);
  assert.equal(await rpc.call('eth_getTransactionByHash', ['0x01'], { cache: true }), '0xabc');
  assert.equal(await rpc.call('eth_getTransactionByHash', ['0x01'], { cache: true }), '0xabc'); // cached: no request
  assert.equal(n, 2); // chain id + one call
  await rpc.call('eth_blockNumber', []);
  await assert.rejects(rpc.call('eth_blockNumber', []), BudgetError);
  const bs = createBlockscout('https://b.example', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(bs.get({ module: 'account', action: 'balance' }), /not allowed/);
});

test('cache: TTL, and a storage that throws falls back to memory', async () => {
  let t = 1000;
  const c = createCache({ backend: undefined, now: () => t });
  await c.set('k', { v: 1 }, 50);
  assert.deepEqual(await c.get('k'), { v: 1 });
  t += 100;
  assert.equal(await c.get('k'), undefined);
  const broken = { kind: 'broken', get: async () => { throw new Error('blocked'); }, set: async () => { throw new Error('blocked'); }, del: async () => {}, keys: async () => [] };
  const d = createCache({ backend: broken });
  await d.set('a', 2);
  assert.equal(await d.get('a'), 2);
  assert.equal(d.kind, 'memory');
});

test('known addresses: a list entry, memory, and the registry going down mid-way', async () => {
  let calls = 0;
  const registryRpc = { call: async () => { calls++; throw new Error('HTTP 503'); } };
  const kb = createKnownBad({ registryRpc, chainId: 1, chain: 'eth', list: new Map([['0x' + '11'.repeat(20), { reason: 'other' }]]) });
  const out = await kb.check(['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)]);
  assert.equal(out.get('0x' + '11'.repeat(20)).source, 'list');
  assert.equal(out.size, 1);
  assert.equal(calls, 1); // down once: not asked again
  assert.deepEqual(kb.notes, ['registry-unavailable']);
});

test('signals: burned LP is good, nothing found is "info"', () => {
  const g = {
    creation: { deployer: '0xd', creator: '0xd', tx: '0x1' }, deployerWalk: { hops: [], stop: 'origin' },
    liquidity: { pair: '0xp', totalAdded: '100', totalRemoved: '0', totalBurned: '99', providers: [{ addr: '0xd', added: '100', removed: '0', burned: '99', addTxs: ['0xa'], removeTxs: [], receivers: [] }] },
  };
  const s = deriveSignals(g);
  assert.deepEqual(s.map((x) => x.id), ['lp-burned']);
  assert.equal(levelOf(s), 'good');
  assert.equal(levelOf(deriveSignals({})), 'info');
});

test('signals: liquidity removed by someone else is medium, not high', () => {
  const s = deriveSignals({
    creation: { deployer: '0xd' },
    liquidity: { pair: '0xp', totalAdded: '100', totalRemoved: '90', totalBurned: '0', providers: [{ addr: '0xo', added: '100', removed: '90', burned: '0', addTxs: [], removeTxs: ['0xr'], receivers: [] }] },
  });
  const lp = s.find((x) => x.id === 'lp-removed');
  assert.equal(lp.severity, 'medium');
  assert.equal(lp.params.linked, false);
});

test('i18n: every language has every key, and every signal renders', () => {
  const ref = FLOW_TEXT.en;
  const sample = { addr: '0x' + 'ab'.repeat(20), hop: 2, count: 3, total: 10, share: 90, blocks: 35, nonce: 2, source: 'registry', reason: 'unlimited-mint', notes: 'x', linked: true };
  for (const [code, L] of Object.entries(FLOW_TEXT)) {
    for (const part of ['UI', 'ROLE', 'EDGE', 'SRC', 'STEP', 'STATUS', 'S']) {
      for (const k of Object.keys(ref[part])) assert.ok(L[part]?.[k] != null, `${code}.${part}.${k}`);
    }
    for (const id of Object.keys(ref.S)) {
      const text = signalText({ id, params: sample }, code);
      assert.ok(text.length > 10 && !/undefined|\[object/.test(text), `${code} ${id}: ${text}`);
    }
    assert.ok(flowUi(code).trace);
  }
  // Neutral wording: what the chain shows, never a judgement.
  for (const L of Object.values(FLOW_TEXT)) for (const f of Object.values(L.S)) assert.doesNotMatch(f(sample, 'x'), /scam|fraud|rug/i);
});

test('view layout: deterministic columns (funders left, receivers and liquidity right)', async () => {
  const g = await buildFlowGraph('base', W.token, { fetchImpl: worldFetch(), maxRequests: 400 });
  const a = layout(g);
  const b = layout(g);
  assert.deepEqual([...a.pos.entries()], [...b.pos.entries()]);
  const col = (id) => a.pos.get(id).col;
  assert.equal(col(W.token), 0);
  assert.equal(col(W.deployer), -1);
  assert.ok(col(W.f2) < col(W.deployer));
  assert.ok(col(W.r[0]) > 0 && col(W.pair) > 0 && col(W.lpTo) > col(W.pair));
  assert.ok(a.width > 0 && a.height > 0);
});
