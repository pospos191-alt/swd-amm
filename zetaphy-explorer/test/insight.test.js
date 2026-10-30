// Unit tests of the insight features: the fund-flow graph builder and layout
// (bounded, deterministic), quantum exposure, the build-time label and chain tables,
// Hyperlane event decoding and message ids, IBC packets, the plain-question parser
// (English and Thai), and the batched Neuro risk lookups.
//   node --test test/insight.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { keccak256, AbiCoder, id as ethId } from 'ethers';
import { FlowGraph, follow, findCycles, findPath, visibleGraph, layoutGraph, zoomBox, panBox, nodeSource, aggregate, edgesFromTxs, edgesFromLogs, LIMITS } from '../src/flow.js';
import { addressQueries } from '../src/history.js';
import { toAddress } from '../src/format.js';
import { quantumExposure, senderClass, recentSenders, tally } from '../src/quantum.js';
import { buildLabels, buildCrossChain, labelsJson, moduleAddress, parseAddressesYaml, crossChainOrigins, cspWithOrigins, SOURCES } from '../scripts/known.js';
import { setLabels, labelOf } from '../src/labels.js';
import { decodeMessage, hyperlaneMessages, ibcPackets, HL_TOPICS, DELIVERED_SEL, setCrossChain, chainByDomain, checkDelivery, bytes32Address } from '../src/crosschain.js';
import { parseQuestion, parseWindow, windowBlocks, largestNative, seenAddresses } from '../src/ask.js';
import { createRisk } from '../src/risk.js';
import { createApi } from '../src/rpc.js';
import { T_INSIGHT, makeT } from '../src/i18n.js';
import { TOPICS } from '../src/evm.js';
import { addressKey, THREAT_SEL } from '../vendor/zetaphy-lib.js';

const ROOT = new URL('..', import.meta.url);
const REPO = new URL('../..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const readRepo = (p) => {
  const u = new URL(p, REPO);
  if (!existsSync(u)) return null;
  const s = readFileSync(u, 'utf8');
  return p.endsWith('.yaml') ? parseAddressesYaml(s) : JSON.parse(s);
};
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topicAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

// ---------------- fund flow ----------------

const nat = (from, to, amount, n) => ({ key: `n:${n}`, from, to, asset: 'native', amount: BigInt(amount), tx: `0x${n}` });

test('flow: edges from txs and logs, aggregated per (from, to, asset); one transfer counted once whichever side read it', () => {
  const txs = [
    { hash: '0x1', height: '5', index: 0, from: A(1), to: A(2), value: 5n, ok: true },
    { hash: '0x2', height: '6', index: 0, from: A(1), to: A(2), value: 7n, ok: true },
    { hash: '0x3', height: '6', index: 1, from: A(1), to: A(3), value: 9n, ok: false }, // failed: no move
    { hash: '0x4', height: '6', index: 2, from: A(1), to: A(3), value: 0n, ok: true }, // zero
    { hash: '0x5', height: '6', index: 3, from: 'zetaphyvaloper1x', to: A(3), value: 1n, ok: true }, // not an account
  ];
  const native = edgesFromTxs(txs);
  assert.equal(native.length, 2);
  const tok = A(0xabc);
  const logs = [{ address: tok, topics: [TOPICS.transfer, topicAddr(A(2)), topicAddr(A(4))], data: '0x' + word(1000), transactionHash: '0x9', blockNumber: '0x7', logIndex: '0x0' }];
  // the same tx from the block scan and from the tx index, the same log from the sender's and the receiver's query
  const all = aggregate([...native, ...edgesFromTxs(txs), ...edgesFromLogs(logs), ...edgesFromLogs(logs)]);
  assert.equal(all.length, 2);
  assert.deepEqual([all[0].asset, all[0].amount, all[0].count, all[0].txs], ['native', 12n, 2, ['0x1', '0x2']]);
  assert.equal(all[1].asset, tok.toLowerCase());
  assert.equal(all[1].amount, 1000n);
  // in the graph too: amounts are conserved per edge
  const g = new FlowGraph(A(1));
  assert.equal(g.addTransfers([...native, ...edgesFromLogs(logs)]), 3);
  assert.equal(g.addTransfers([...edgesFromTxs(txs), ...edgesFromLogs(logs)]), 0);
  g.expand(A(1)); g.expand(A(2));
  assert.deepEqual(g.edges().map((e) => [e.from, e.to, e.amount]), [[A(1), A(2), 12n], [A(2), A(4), 1000n]]);
});

test('flow: follow has no hop limit, goes breadth first (largest first), ends on cycles, reads each address once', async () => {
  const root = A(1);
  // a chain of 10 hops 1 -> 2 -> … -> 11, a cycle 7 -> 4, a self-contained loop 11 -> 10, and a side branch 1 -> 50 -> 51
  const edges = [];
  for (let i = 1; i <= 10; i++) edges.push(nat(A(i), A(i + 1), 1000 - i, `c${i}`));
  edges.push(nat(A(7), A(4), 3, 'back'), nat(A(11), A(10), 2, 'loop'), nat(root, A(50), 5, 's1'), nat(A(50), A(51), 4, 's2'));
  const g = new FlowGraph(root);
  const reads = [];
  const source = new Map([...new Set(edges.flatMap((e) => [e.from, e.to]))].map((x) => [x, edges.filter((e) => e.from === x || e.to === x)]));
  const read = async (id) => { reads.push(id); g.addTransfers(source.get(id) ?? []); };
  await read(root); g.expand(root);
  const steps = [];
  const r = await follow(g, { read, onStep: (x) => steps.push(x.node) });
  assert.equal(r.stopped, false);
  const layer = Object.fromEntries([...g.nodes.values()].map((n) => [n.id, n.layer]));
  for (let i = 1; i <= 11; i++) assert.equal(layer[A(i)], i - 1, `A(${i})`);
  assert.equal(layer[A(51)], 2);
  // every address read once, followed once (the cycles did not bring anyone back)
  assert.equal(new Set(reads).size, reads.length - 1); // the root was read before follow and once inside (cached by the caller)
  assert.equal(new Set(steps).size, steps.length);
  assert.equal(steps.length, g.nodes.size);
  // breadth first: hop k is done before hop k+1; within hop 1 the larger inflow (A(2): 999) before A(50): 5
  assert.ok(steps.indexOf(A(2)) < steps.indexOf(A(50)));
  assert.ok(steps.indexOf(A(50)) < steps.indexOf(A(3)));
  // the money stops at the ends of the data read; cycles are drawn, not followed twice
  assert.equal(g.nodes.get(A(51)).status, 'end');
  assert.deepEqual(findCycles(g.nodes.keys(), g.edges()), [[A(10), A(11)], [A(4), A(5), A(6), A(7)]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.ok(g.edges().some((e) => e.from === A(7) && e.to === A(4)), 'the back edge is in the graph');
  // a second follow has nothing left to do
  assert.deepEqual(await follow(g, { read }), { stopped: false, hop: 0, followed: 0 });
});

test('flow: follow stops on request and continues later; sinks end a branch', async () => {
  const root = A(1);
  const edges = [];
  for (let i = 1; i <= 8; i++) edges.push(nat(A(i), A(i + 1), 100, `c${i}`));
  edges.push(nat(root, A(70), 50, 'x1'), nat(A(70), A(71), 50, 'x2')); // A(70) is a contract: a sink
  const g = new FlowGraph(root); g.addTransfers(edges); g.expand(root);
  let n = 0;
  const r1 = await follow(g, { read: async () => {}, isSink: async (id) => (id === A(70) ? 'contract' : null), shouldStop: () => n >= 4, onStep: () => { n++; } });
  assert.equal(r1.stopped, true);
  assert.equal(n, 4);
  assert.ok(!g.nodes.has(A(9)), 'not that far yet');
  assert.equal(g.nodes.get(A(70)).status, 'sink'); assert.equal(g.nodes.get(A(70)).sink, 'contract');
  assert.ok(!g.nodes.has(A(71)), 'nothing is followed past a sink');
  const r2 = await follow(g, { read: async () => {}, isSink: async (id) => (id === A(70) ? 'contract' : null) });
  assert.equal(r2.stopped, false);
  assert.equal(g.nodes.get(A(9)).layer, 8);
  assert.equal(g.nodes.get(A(9)).status, 'end');
  assert.equal(g.nodes.get(root).status, 'followed');
});

test('flow: batches are continuable and nothing is cut silently (placed + left = all)', async () => {
  const root = A(1);
  const edges = Array.from({ length: 120 }, (_, i) => nat(root, A(1000 + i), 1000 - i, `b${i}`));
  const g = new FlowGraph(root); g.addTransfers(edges);
  assert.equal(LIMITS.batch, 50);
  let r = g.expand(root, { dirs: [1] });
  assert.equal(r.added.length, 50); assert.equal(r.left.out, 70);
  assert.equal(r.added[0], A(1000), 'largest first');
  r = g.expand(root, { dirs: [1] });
  assert.equal(r.added.length, 50); assert.equal(r.left.out, 20);
  r = g.expand(root, { dirs: [1] });
  assert.equal(r.added.length, 20); assert.equal(r.left.out, 0);
  assert.equal(g.nodes.size, 121);
  // follow: each address gets one batch per step, the rest stays listed (remaining) for "Load next 50"
  const g2 = new FlowGraph(root); g2.addTransfers(edges);
  await follow(g2, { read: async () => {}, batch: 50 });
  assert.equal(g2.nodes.size - 1 + g2.remaining(root, 1), 120);
  assert.equal(g2.remaining(root, 1), 70);
  // the drawing: a layer shows its largest nodes and a "+N more" placeholder for the rest, never a silent cut
  const v = visibleGraph(g);
  const layer1 = v.nodes.filter((x) => x.layer === 1);
  assert.equal(layer1.filter((x) => !x.more).length, LIMITS.layerShow);
  assert.equal(layer1.find((x) => x.more).more, 120 - LIMITS.layerShow);
  assert.equal(v.hidden, 120 - LIMITS.layerShow);
  const all = visibleGraph(g, { shown: new Map([[1, 500]]) });
  assert.equal(all.nodes.filter((x) => x.layer === 1).length, 120);
  const folded = visibleGraph(g, { collapsed: new Set([1]), keep: [A(1100)] });
  assert.deepEqual(folded.nodes.filter((x) => x.layer === 1).map((x) => x.id), [A(1100), 'more:1']);
  assert.equal(folded.nodes.find((x) => x.more).more, 119);
});

test('flow: path from the start to an address (fewest hops, larger transfers first), cycles, layout, zoom', () => {
  const root = A(1);
  const edges = [nat(root, A(2), 10, 'a'), nat(A(2), A(3), 9, 'b'), nat(A(3), A(4), 8, 'c'), nat(root, A(5), 50, 'd'), nat(A(5), A(3), 40, 'e'),
    nat(A(4), A(2), 1, 'f'), nat(A(9), root, 3, 'g')];
  const g = new FlowGraph(root); g.addTransfers(edges); g.expand(root);
  for (const x of [A(2), A(5), A(3), A(4)]) g.expand(x, { dirs: [1] });
  const p = findPath(g.edges(), root, A(4));
  assert.deepEqual(p.nodes, [root, A(5), A(3), A(4)]); // 3 hops either way; the 50 → 40 route is larger
  assert.equal(p.edges.length, 3); assert.equal(p.edges[0].amount, 50n);
  assert.equal(findPath(g.edges(), A(4), A(9)), null, 'nothing flows back to A(9)');
  assert.deepEqual(findPath(g.edges(), root, root), { nodes: [root], edges: [] });
  assert.deepEqual(findCycles(g.nodes.keys(), g.edges()), [[A(2), A(3), A(4)]]);
  // layout: inflows left, outflows right, a column per hop, the cycle edge as a loop; deterministic
  const L = layoutGraph(visibleGraph(g));
  const pos = Object.fromEntries(L.nodes.map((n) => [n.id, n]));
  assert.ok(pos[A(9)].x < pos[root].x && pos[root].x < pos[A(2)].x && pos[A(2)].x < pos[A(3)].x);
  assert.equal(new Set(L.nodes.map((n) => `${n.x},${n.y}`)).size, L.nodes.length);
  for (const n of L.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + L.nodeW <= L.width && n.y + L.nodeH <= L.height);
  for (const e of L.edges) { assert.match(e.d, /^M[-\d. ]+C[-\d. ]+$/); assert.ok(Number.isFinite(e.lx) && Number.isFinite(e.ly)); }
  const g2 = new FlowGraph(root); g2.addTransfers([...edges].reverse()); g2.expand(root);
  for (const x of [A(5), A(4), A(3), A(2)]) g2.expand(x, { dirs: [1] });
  assert.deepEqual(layoutGraph(visibleGraph(g2)), L);
  // zoom keeps the point under the cursor; pan moves the box
  const b = { x: 0, y: 0, w: 1000, h: 500 };
  assert.deepEqual(zoomBox(b, 2, 500, 250), { x: 250, y: 125, w: 500, h: 250 });
  assert.deepEqual(zoomBox(b, 1000).w, 125); // at most 8×
  assert.deepEqual(panBox(b, 10, -5), { x: 10, y: -5, w: 1000, h: 500 });
});

test('flow: an address\'s data is read in 500-block windows and tx index pages, continuable, with its exact range', async () => {
  const me = A(0xbeef); const other = A(0xcafe);
  const logCalls = []; const searches = [];
  const tok = A(0xabc);
  const chain = {
    transferLogs: async (addr, from, to) => {
      logCalls.push([addr, from, to]);
      return from <= 700 && 700 <= to ? [{ address: tok, topics: [TOPICS.transfer, topicAddr(me), topicAddr(other)], data: '0x' + word(5), transactionHash: '0x' + 'aa'.repeat(32), blockNumber: '0x2bc', logIndex: '0x1' }] : [];
    },
    summarize: (x) => ({ hash: x.hash, cometHash: x.hash, height: x.height, index: x.index, from: me, to: other, value: 7n, ok: true }),
  };
  const comet = async (m, p) => {
    searches.push(p.query);
    assert.equal(m, 'tx_search');
    const ok = p.query === `message.sender='${toAddress(me).bech32}'`;
    return ok && p.page === '1' ? { txs: [{ hash: 'AB'.repeat(32), height: '900', index: 0, tx: '', tx_result: {} }], total_count: '1' } : { txs: [], total_count: ok ? '1' : '0' };
  };
  const src = nodeSource({ chain, comet, latest: 1200, scan: { from: '1101', to: '1200', txs: [] } });
  assert.equal(src.range(me), null);
  const first = await src.read(me);
  assert.deepEqual(logCalls, [[me, 701, 1200]]);
  // every tx_search query is one of history.js's validated address queries
  assert.deepEqual([...new Set(searches)].sort(), addressQueries(me).map((q) => q.query).sort());
  assert.equal(first.length, 1); // the native move from the index; the token log is in an older window
  assert.deepEqual(src.range(me), { tokens: { from: 701, to: 1200 }, scan: { from: 1101, to: 1200 }, index: { all: true, to: 1200, count: 1 } });
  assert.deepEqual(await src.read(me), [], 'read once; older() continues');
  assert.equal(src.hasOlder(me), true);
  const older = await src.older(me);
  assert.deepEqual(logCalls.at(-1), [me, 201, 700]);
  assert.equal(older.length, 1); assert.equal(older[0].amount, 5n);
  assert.deepEqual(src.range(me).tokens, { from: 201, to: 1200 });
  await src.older(me); await src.older(me);
  assert.deepEqual(src.range(me).tokens, { from: 1, to: 1200 });
  assert.equal(src.hasOlder(me), false);
  // a node that refuses event queries: the range says so (block scan only)
  const off = nodeSource({ chain, comet: async () => { throw new Error('tx_search: event queries are not indexed'); }, latest: 1200, scan: null });
  await off.read(me);
  assert.deepEqual(off.range(me).index, { refused: true });
  // nothing but a valid address reaches a query
  assert.throws(() => addressQueries(`${toAddress(me).bech32}' OR tx.height>0`), /refused/);
});

// ---------------- quantum exposure ----------------

test('quantum exposure: PQ account, quantum lock, exposed and hidden secp256k1 keys, contracts, unknown', () => {
  assert.equal(quantumExposure({ pq: { pubKeyType: 'mldsa44', sequence: '3' }, nonce: 0n }).level, 'pq');
  const locked = quantumExposure({ pq: { pubKeyType: 'eth_secp256k1', sequence: '12', quantumLockedTo: 'zetaphy1x' }, nonce: 4n });
  assert.equal(locked.level, 'locked'); assert.equal(locked.exposed, true); assert.equal(locked.lockedTo, 'zetaphy1x');
  // an EVM tx signature reveals the key, even when the Cosmos account holds no key yet
  assert.equal(quantumExposure({ pq: { exists: false, pubKeyType: null, sequence: null }, nonce: 5n }).level, 'exposed');
  // a Cosmos tx stored the secp256k1 key
  assert.equal(quantumExposure({ pq: { pubKeyType: 'eth_secp256k1', sequence: '1' }, nonce: 0n }).level, 'exposed');
  assert.equal(quantumExposure({ pq: { exists: false, pubKeyType: null, sequence: null }, nonce: 0n }).level, 'hidden');
  assert.equal(quantumExposure({ pq: { pubKeyType: null }, nonce: 0n, code: '0x6080' }).level, 'contract');
  assert.equal(quantumExposure({ pq: { error: 'method not found' }, nonce: 0n }).level, 'unknown');
  assert.equal(quantumExposure({ pq: { error: 'x' }, nonce: 2n }).level, 'exposed');
  // dashboard classes
  assert.equal(senderClass({ pubKeyType: 'mldsa44' }), 'pq');
  assert.equal(senderClass({ pubKeyType: null, exists: false }, { evm: true }), 'exposed');
  assert.equal(senderClass({ error: 'x' }), 'unknown');
  const s = recentSenders([{ from: A(1), evm: false, ok: true }, { from: A(1), evm: true, ok: true }, { from: A(2), ok: false }, { from: 'zetaphyvaloper1q', ok: true }]);
  assert.deepEqual(s, [{ address: A(1), evm: true }]);
  assert.deepEqual(tally(['pq', 'locked', 'exposed', 'unknown']), { pq: 1, locked: 1, exposed: 1, hidden: 0, unknown: 1, total: 4, known: 3, protected: 2 });
});

// ---------------- labels and the chain table ----------------

test('labels: built from the repository records; the committed labels.json and crosschain.json are current', () => {
  const l = buildLabels(readRepo);
  const L = l.labels;
  assert.equal(L['0x000000000000000000000000000000000000dead'][1], 'burn');
  assert.equal(L['0x0000000000000000000000000000000000000800'][1], 'precompile');
  assert.equal(L['0x0000000000000000000000000000000000005051'][0], 'Quantum lock (precompile)');
  // module accounts: sha256(name)[:20] (cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta is the fee collector)
  assert.equal(moduleAddress('fee_collector'), '0xf1829676db577682e944fc3493d451b67ff3e29f');
  assert.equal(L['0xf1829676db577682e944fc3493d451b67ff3e29f'][1], 'module');
  // from the launch state, DEX and Hyperlane records
  assert.equal(L['0xab5745b61f83975e68f6546be9f83651df12417f'][0], 'Neuro ThreatRegistry');
  assert.equal(L['0x0f1c59c6e98c88e1ddc2ff98bee11dada07feace'][0], 'Hyperlane Mailbox');
  assert.equal(L['0x2d822d2d44424fbe6465faa776822ed464a6d2a8'][0], 'DEX router');
  assert.match(L['0x3cc2b1ffd3a7c7504a49426ae6bdea501bf1d59d'][0], /BZTPHY/);
  assert.equal(L['0x0000000000000000000000000000000000000000'], undefined, 'the zero address is never a deployment');
  // deterministic, sorted, no hashes taken for addresses
  assert.deepEqual(Object.keys(L), Object.keys(L).sort());
  for (const k of Object.keys(L)) assert.match(k, /^0x[0-9a-f]{40}$/);
  assert.deepEqual(buildLabels(readRepo), l);
  assert.ok(l.sources.includes(SOURCES[0]));
  // first record wins: the deployer of the launch state, not "governance" of a later file
  assert.equal(L['0x6af57fc3633dd0f7907f7900dbd4a2822f43a245'][0], 'Launch deployer');
  // missing files are skipped
  assert.equal(Object.keys(buildLabels(() => null).labels).length, 25);
  // the committed tables are what npm run build writes now
  assert.equal(read('labels.json'), labelsJson(l), 'labels.json is stale: run npm run build');
  assert.equal(read('crosschain.json'), JSON.stringify(buildCrossChain(readRepo), null, 1) + '\n', 'crosschain.json is stale: run npm run build');
  // the browser side: sanitised, case-insensitive, built-ins kept
  setLabels({ '0xAB5745b61f83975E68F6546be9F83651df12417f': ['Neuro‮ ThreatRegistry', 'neuro'], bad: ['x', 'y'], [A(9)]: ['<b>x</b>', 'evil-kind'] });
  assert.deepEqual(labelOf('0xab5745b61f83975e68f6546be9f83651df12417f'), { name: 'Neuro ThreatRegistry', kind: 'neuro' });
  assert.equal(labelOf(A(9)).kind, 'contract');
  assert.equal(labelOf('0x000000000000000000000000000000000000dEaD').kind, 'burn');
  assert.equal(labelOf('bad'), null);
});

test('chain table: https RPCs only; the CSP gets their origins only when connect-src is locked', () => {
  const cc = buildCrossChain(readRepo);
  assert.equal(cc.zetaphy.mailbox, '0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe');
  assert.equal(cc.chains.sepolia.domain, 11155111);
  for (const c of Object.values(cc.chains)) for (const u of c.rpc) assert.match(u, /^https:\/\//);
  const bad = buildCrossChain(() => ({ zetaphy: {}, chains: { x: { domain: 5, mailbox: A(1), rpc: ['http://a.example', 'javascript:1', 'https://ok.example'], explorer: 'http://e' } } }));
  assert.deepEqual(bad.chains.x.rpc, ['https://ok.example']); assert.equal(bad.chains.x.explorer, '');
  const origins = crossChainOrigins(cc);
  assert.ok(new Set(origins).has('https://ethereum-sepolia-rpc.publicnode.com'));
  const open = "default-src 'none'; connect-src 'self' https:; object-src 'none'";
  assert.equal(cspWithOrigins(open, origins), open);
  const locked = cspWithOrigins("default-src 'none'; connect-src 'self' https://node.example; object-src 'none'", origins);
  assert.match(locked, /connect-src 'self' https:\/\/node\.example https:\/\/.*ethereum-sepolia-rpc\.publicnode\.com/);
  assert.equal(cspWithOrigins(locked, origins), locked, 'idempotent');
  // the CSP in force allows the destination RPCs
  const csp = JSON.parse(read('vercel.json')).headers[0].headers.find((x) => x.key === 'Content-Security-Policy').value;
  assert.equal(cspWithOrigins(csp, origins), csp);
});

// ---------------- Hyperlane and IBC ----------------

const MAILBOX = '0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe';
function hlMessage({ nonce = 7, origin = 77390, sender = A(0x51), destination = 11155111, recipient = A(0x52), body = '0x68656c6c6f' } = {}) {
  const u32 = (n) => n.toString(16).padStart(8, '0');
  return '0x03' + u32(nonce) + u32(origin) + word(BigInt(sender)) + u32(destination) + word(BigInt(recipient)) + body.slice(2);
}

test('Hyperlane: message fields and id (keccak256 of the message), Dispatch / DispatchId / Process / ProcessId decoded', () => {
  setCrossChain(JSON.parse(read('crosschain.json')));
  const msg = hlMessage();
  const m = decodeMessage(msg);
  assert.deepEqual({ ...m, id: undefined }, { version: 3, nonce: 7, origin: 77390, sender: '0x' + word(0x51), destination: 11155111, recipient: '0x' + word(0x52), bodyLength: 5, id: undefined });
  assert.equal(m.id, keccak256(msg));
  assert.equal(decodeMessage('0x0102'), null);
  assert.equal(bytes32Address('0x' + word(0x52)), '0x0000000000000000000000000000000000000052');
  assert.equal(HL_TOPICS.dispatch, ethId('Dispatch(address,uint32,bytes32,bytes)'));
  assert.equal(HL_TOPICS.processId, ethId('ProcessId(bytes32)'));
  assert.equal(DELIVERED_SEL, ethId('delivered(bytes32)').slice(2, 10));
  const data = AbiCoder.defaultAbiCoder().encode(['bytes'], [msg]);
  const logs = [
    { address: MAILBOX, logIndex: '0x0', topics: [HL_TOPICS.dispatch, topicAddr(A(0x51)), '0x' + word(11155111), '0x' + word(0x52)], data },
    { address: MAILBOX, logIndex: '0x1', topics: [HL_TOPICS.dispatchId, m.id], data: '0x' },
    // an incoming message: Process then ProcessId
    { address: MAILBOX, logIndex: '0x2', topics: [HL_TOPICS.process, '0x' + word(84532), '0x' + word(0x77), topicAddr(A(0x88))], data: '0x' },
    { address: MAILBOX, logIndex: '0x3', topics: [HL_TOPICS.processId, '0x' + 'ee'.repeat(32)], data: '0x' },
    // the same events from another contract are ignored (anyone can emit them)
    { address: A(0x99), logIndex: '0x4', topics: [HL_TOPICS.dispatch, topicAddr(A(0x51)), '0x' + word(1), '0x' + word(2)], data },
  ];
  const out = hyperlaneMessages(logs);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { dir: 'out', id: m.id, origin: 77390, destination: 11155111, sender: '0x0000000000000000000000000000000000000051', recipient: '0x0000000000000000000000000000000000000052', nonce: 7, bodyLength: 5, idConfirmed: true });
  assert.deepEqual(out[1], { dir: 'in', id: '0x' + 'ee'.repeat(32), origin: 84532, sender: '0x0000000000000000000000000000000000000077', recipient: '0x0000000000000000000000000000000000000088' });
  assert.equal(chainByDomain(84532).name, 'Base Sepolia');
  assert.equal(chainByDomain(1), null);
  assert.deepEqual(hyperlaneMessages(logs, null), []);
});

test('Hyperlane: delivery read from the destination chain RPC (delivered(), then the ProcessId event for when)', async () => {
  const id = '0x' + 'ab'.repeat(32);
  const asked = [];
  const fetchFn = async (url, init) => {
    const { id: rid, method, params } = JSON.parse(init.body);
    asked.push([url, method]);
    if (url.includes('first')) return new Response('bad gateway', { status: 502 });
    const result = { eth_call: '0x' + word(1), eth_blockNumber: '0x2710', eth_getLogs: [{ transactionHash: '0x' + 'cd'.repeat(32), blockNumber: '0x2700' }], eth_getBlockByNumber: { timestamp: '0x6553f100' } }[method];
    assert.equal(init.credentials, 'omit');
    if (method === 'eth_call') assert.equal(params[0].data, '0x' + DELIVERED_SEL + 'ab'.repeat(32));
    if (method === 'eth_getLogs') { assert.deepEqual(params[0].topics, [HL_TOPICS.processId, id]); assert.equal(params[0].fromBlock, '0x3e8'); }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rid, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const chain = { name: 'Test', mailbox: A(5), rpc: ['https://first.example/', 'https://second.example/'], explorer: 'https://scan.example' };
  const r = await checkDelivery(chain, id, { fetchFn });
  assert.deepEqual(r, { delivered: true, txHash: '0x' + 'cd'.repeat(32), block: String(0x2700), time: new Date(0x6553f100 * 1000).toISOString(), link: `https://scan.example/tx/0x${'cd'.repeat(32)}` });
  assert.ok(asked[0][0].includes('first') && asked.slice(1).every(([u]) => u.includes('second')), 'falls over to the next RPC');
  const notYet = await checkDelivery({ ...chain, rpc: ['https://third.example/'] }, id, { fetchFn: async (url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x' + word(0) }), { status: 200 }) });
  assert.deepEqual(notYet, { delivered: false });
});

test('IBC: packets from Cosmos events with ports, channels and sequence', () => {
  const ev = (type, kv) => ({ type, attributes: Object.entries(kv).map(([key, value]) => ({ key, value })) });
  const p = ibcPackets([
    ev('send_packet', { packet_sequence: '12', packet_src_port: 'transfer', packet_src_channel: 'channel-0', packet_dst_port: 'transfer', packet_dst_channel: 'channel-141', connection_id: 'connection-0' }),
    ev('send_packet', { packet_sequence: '12', packet_src_port: 'transfer', packet_src_channel: 'channel-0', packet_dst_port: 'transfer', packet_dst_channel: 'channel-141' }),
    ev('acknowledge_packet', { packet_sequence: '9', packet_src_port: 'transfer', packet_src_channel: 'channel-0', packet_dst_port: 'transfer', packet_dst_channel: 'channel-141' }),
    ev('message', { action: 'x' }),
  ]);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { kind: 'sent', sequence: '12', srcPort: 'transfer', srcChannel: 'channel-0', dstPort: 'transfer', dstChannel: 'channel-141', timeoutHeight: '', connection: 'connection-0' });
  assert.equal(p[1].kind, 'acknowledged');
});

// ---------------- ask the explorer ----------------

const ME = '0x6DA134EbFcb035273E87954f0641bD920ED073Ba';
const BECH = 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r';

test('ask: English questions route to the right view with filters', () => {
  assert.deepEqual(parseQuestion('largest transfers today'), { kind: 'largest', route: 'ask/largest?s=86400', address: null, window: { s: 86400 } });
  assert.equal(parseQuestion('biggest ZETAPHY holders seen').route, 'ask/holders');
  assert.equal(parseQuestion(`txs of ${ME} last hour`).route, `ask/txs?address=${ME}&s=3600`);
  assert.equal(parseQuestion(`transactions of ${BECH.toUpperCase()} in the last 30 minutes`).route, `ask/txs?address=${ME}&s=1800`);
  assert.equal(parseQuestion('failed txs').route, 'ask/failed');
  assert.equal(parseQuestion('failed transactions last 200 blocks').route, 'ask/failed?b=200');
  assert.equal(parseQuestion(`is ${ME.toLowerCase()} safe?`).route, `ask/risk?address=${ME}`);
  assert.equal(parseQuestion(`quantum exposure of ${ME}`).route, `quantum/${ME}`);
  assert.equal(parseQuestion('quantum readiness').route, 'quantum');
  assert.equal(parseQuestion(`follow the money from ${ME}`).route, `flow/${ME}`);
  assert.equal(parseQuestion(`${ME} 2h`).route, `ask/txs?address=${ME}&s=7200`);
  // hex digits inside an address are never read as a time ("…5d0…")
  assert.equal(parseQuestion('txs of 0x000000000000000000000000000000000005d0aa').window, null);
  // not questions: left to the normal search
  for (const q of ['', '12345', ME, BECH, '0x' + 'ab'.repeat(32), 'hello world', 'is it safe?', 'flow', 'txs']) assert.equal(parseQuestion(q), null, q);
});

test('ask: Thai questions', () => {
  assert.equal(parseQuestion(`ที่อยู่นี้ปลอดภัยไหม ${ME}`).route, `ask/risk?address=${ME}`);
  assert.equal(parseQuestion('โอนใหญ่ที่สุดวันนี้').route, 'ask/largest?s=86400');
  assert.equal(parseQuestion('ผู้ถือ ZETAPHY มากที่สุด').route, 'ask/holders');
  assert.equal(parseQuestion('ธุรกรรมที่ไม่สำเร็จ 1 ชั่วโมงล่าสุด').route, 'ask/failed?s=3600');
  assert.equal(parseQuestion(`ธุรกรรมของ ${ME} 30 นาที`).route, `ask/txs?address=${ME}&s=1800`);
  assert.equal(parseQuestion(`เงินไหลไปไหน ${ME}`).route, `flow/${ME}`);
  assert.equal(parseQuestion(`ความเสี่ยงควอนตัม ${ME}`).route, `ask/risk?address=${ME}`); // เสี่ยง: the risk view (it includes quantum exposure)
  assert.equal(parseQuestion('ควอนตัม').route, 'quantum');
  assert.deepEqual(parseWindow('2 ชม.'), { s: 7200 });
  assert.deepEqual(parseWindow('100 บล็อก'), { b: 100 });
  assert.equal(parseQuestion('สวัสดี'), null);
});

test('ask: windows, largest transfers and holders seen', () => {
  assert.deepEqual(windowBlocks({ s: 3600 }, 5, 1000), { n: 720, capped: false, whole: false });
  assert.deepEqual(windowBlocks({ s: 86400 }, 5, 1000), { n: 1000, capped: true, whole: false });
  assert.deepEqual(windowBlocks({ b: 50 }, 5, 1000), { n: 50, capped: false, whole: false });
  assert.equal(windowBlocks(null, 5, 1000).whole, true);
  const txs = [{ hash: 'a', height: '1', value: 5n, ok: true }, { hash: 'b', height: '2', value: 9n, ok: true }, { hash: 'c', height: '3', value: 99n, ok: false }, { hash: 'd', height: '4', value: 5n, ok: true }, { hash: 'e', height: '4', value: null, ok: true }];
  assert.deepEqual(largestNative(txs).map((x) => x.hash), ['b', 'd', 'a']);
  assert.deepEqual(seenAddresses([{ from: A(1), to: 'zetaphyvaloper1q', addresses: new Set([A(2)]) }, { from: A(1), to: A(3) }]), [A(1), A(2), A(3)]);
});

// ---------------- Neuro risk badges: batched lookups ----------------

const REG = A(0x7777);
const FLAGGED = A(0x3333);
function fakeNode({ batches = true } = {}) {
  const calls = { batches: 0, singles: 0, sizes: [] };
  const flagged = addressKey(77390, FLAGGED);
  const answer = ({ method, params }) => {
    if (method === 'eth_getCode') return params[0] === FLAGGED ? '0x6080' : '0x';
    const data = params[0].data; const sel = data.slice(2, 10); const arg = data.slice(10);
    const [warn] = THREAT_SEL.address;
    if (sel === warn && addressKey(77390, '0x' + arg.slice(88, 128)) === flagged) return '0x' + word(1) + word(2);
    return '0x' + word(0) + word(0);
  };
  return {
    calls,
    batch: batches ? async (list) => { calls.batches++; calls.sizes.push(list.length); return list.map(answer); } : async () => { calls.batches++; throw new Error('batch: no'); },
    single: async (method, params) => { calls.singles++; return answer({ method, params }); },
  };
}

test('risk badges: lookups made while a page renders go out in one batch (two for contracts), cached after', async () => {
  const n = fakeNode();
  const risk = createRisk({ batch: n.batch, single: n.single, registry: REG, chainId: 77390, wait: 5 });
  const addrs = [A(1), A(2), FLAGGED, A(3), A(1)];
  const rs = await Promise.all(addrs.map((a) => risk.lookup(a)));
  assert.equal(n.calls.batches, 2, 'one batch for codes + address flags, one for the contract\'s code and fingerprint flags');
  assert.deepEqual(n.calls.sizes, [12, 4]);
  assert.equal(rs[2].state, 'flagged'); assert.equal(rs[2].flags[0].what, 'address'); assert.equal(rs[2].flags[0].reasonName, 'unlimited-mint');
  assert.deepEqual(rs.map((r) => r.state), ['clean', 'clean', 'flagged', 'clean', 'clean']);
  await risk.lookup(FLAGGED.toUpperCase().replace('0X', '0x'));
  assert.equal(n.calls.batches, 2, 'cached');
  assert.equal(risk.peek(FLAGGED).state, 'flagged');
  // many addresses: split in batches of maxBatch
  const many = createRisk({ batch: n.batch, single: n.single, registry: REG, chainId: 77390, wait: 1, maxBatch: 10 });
  await Promise.all(Array.from({ length: 25 }, (_, i) => many.lookup(A(1000 + i))));
  assert.deepEqual(n.calls.sizes.slice(2), [30, 30, 15]);
});

test('risk badges: no registry = nothing claimed; node without batches = one call each; unreadable registry = error', async () => {
  assert.deepEqual(await createRisk({ registry: '' }).lookup(A(1)), { state: 'unset' });
  const n = fakeNode({ batches: false });
  const risk = createRisk({ batch: n.batch, single: n.single, registry: REG, chainId: 77390, wait: 1 });
  const [a, b] = await Promise.all([risk.lookup(A(1)), risk.lookup(FLAGGED)]);
  assert.equal(a.state, 'clean'); assert.equal(b.state, 'flagged');
  assert.equal(n.calls.batches, 1); assert.equal(n.calls.singles, 6 + 4);
  const broken = createRisk({ batch: async (l) => l.map(() => '0x'), single: async () => '0x', registry: REG, chainId: 77390, wait: 1 });
  assert.equal((await broken.lookup(A(1))).state, 'error');
  assert.equal((await broken.lookup('nope')).state, 'error');
});

test('rpc.js evmBatch: one HTTP request per batch, per-call results and errors, shared cache', async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    return new Response(JSON.stringify(body.map((c) => (c.method === 'bad' ? { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'nope' } } : { jsonrpc: '2.0', id: c.id, result: `${c.method}:${c.params[0]}` }))), { status: 200 });
  };
  const api = createApi({ evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' }, { fetchFn, maxRps: 1000 });
  const r = await api.evmBatch([{ method: 'a', params: [1] }, { method: 'bad', params: [] }, { method: 'b', params: [2] }]);
  assert.equal(sent.length, 1);
  assert.equal(r[0], 'a:1'); assert.ok(r[1] instanceof Error); assert.equal(r[2], 'b:2');
  assert.equal(await api.evm('a', [1]), 'a:1'); // from the batch's cache
  assert.equal(sent.length, 1);
  await api.evmBatch([{ method: 'a', params: [1] }, { method: 'c', params: [3] }]);
  assert.deepEqual(sent[1].map((c) => c.method), ['c']);
  const noBatch = createApi({ evm: 'https://n.example/', comet: 'https://n.example/rpc/', rest: 'https://n.example/rest/' }, { fetchFn: async () => new Response('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch"}}', { status: 200 }) });
  await assert.rejects(noBatch.evmBatch([{ method: 'a', params: [] }]), /batch/);
});

// ---------------- texts ----------------

test('insight texts: all 8 languages have the same keys and placeholders; dynamic keys exist; neutral wording', () => {
  const en = Object.keys(T_INSIGHT.en).sort();
  assert.deepEqual(Object.keys(T_INSIGHT).sort(), ['en', 'es', 'ja', 'ko', 'ru', 'th', 'vi', 'zh']);
  const vars = (x) => (x.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [code, d] of Object.entries(T_INSIGHT)) {
    assert.deepEqual(Object.keys(d).sort(), en, code);
    for (const k of en) { assert.ok(d[k].trim(), `${code}.${k}`); assert.equal(vars(d[k]), vars(T_INSIGHT.en[k]), `${code}.${k}`); }
  }
  const src = ['src/flow.js', 'src/quantum.js', 'src/risk.js', 'src/crosschain.js', 'src/ask.js', 'src/app.js'].map(read).join('\n');
  const used = new Set([...src.matchAll(/'((?:risk|q|flow|xc|ask)[A-Z][A-Za-z_]*)'/g)].map((m) => m[1]));
  for (const p of ['pq', 'locked', 'exposed', 'hidden', 'contract', 'unknown']) used.add(`qLevel_${p}`).add(`qSay_${p}`);
  for (const p of ['sent', 'received', 'acknowledged', 'timeout', 'ackWritten']) used.add(`xcIbc_${p}`);
  for (const p of ['largest', 'holders', 'txs', 'failed', 'risk']) used.add(`askKind_${p}`);
  for (const p of ['root', 'open', 'followed', 'end', 'sink']) used.add(`flowStatus_${p}`);
  for (const p of ['contract', 'burn', 'zero', 'module', 'bridge', 'exchange']) used.add(`flowSink_${p}`);
  for (const k of used) if (!/^(qLevel_|qSay_|xcIbc_|askKind_)$/.test(k)) assert.ok(k in T_INSIGHT.en, `missing ${k}`);
  // every language has its own text (no English fallback), and the cross-chain card's title is its own key
  assert.equal(makeT('ja')('flowTitle'), '資金の流れ');
  assert.equal(makeT('th')('flowTitle'), 'เส้นทางเงิน');
  assert.equal(makeT('en')('xcCrossTitle'), 'Cross-chain');
  for (const [code] of Object.entries(T_INSIGHT)) if (code !== 'en') assert.notEqual(makeT(code)('flowFollow'), T_INSIGHT.en.flowFollow, code);
  const all = JSON.stringify(T_INSIGHT).toLowerCase();
  for (const w of ['scam', 'fraud', 'หลอกลวง', 'มิจฉาชีพ']) assert.ok(!all.includes(w), w);
});
