// Saphan PR 6, item G: the self-healing watcher (src/saphanheal.js) on mocks: stuck messages are replayed with
// backoff and a bounded number of times, heartbeats are re-sent before the escape hatch could open, anomalies trip the
// route's CircuitBreaker once (with hashed evidence), failures of an action never stop the loop. Plus the chain
// adapters (routeReader on a real route in the in-memory EVM, breakerTripper's Evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaphanWatcher, routeReader, breakerTripper, evidenceHash, DETECTOR_ID } from '../src/saphanheal.js';
import { routeWorld, bridgeIn, E } from './helpers/saphanroutekit.js';

function world(status) {
  let t = 1_000_000;
  const calls = [];
  const act = {
    replay: async (route, dir, range) => { calls.push(['replay', route, dir, range.from, range.to]); return 'ok'; },
    beat: async (route) => { calls.push(['beat', route]); return 'ok'; },
    trip: async (route, ev) => { calls.push(['trip', route, ev.evidence.anomalies.map((x) => x.id).join(','), ev.hash]); return 'ok'; },
  };
  const w = createSaphanWatcher({ routes: Object.keys(status), read: async (r) => status[r], act, now: () => t });
  return { w, calls, advance: (s) => { t += s; }, now: () => t, act };
}

test('stuck release: replayed after stuckAfter, then with backoff, at most maxReplays; then the route trips once', async () => {
  const st = { sepolia: { outboxNonce: 5n, lockboxReceived: 3n } };
  const { w, calls, advance } = world(st);
  await w.tick();
  assert.deepEqual(calls, [], 'not stuck long enough yet');
  advance(1800);
  await w.tick();
  assert.deepEqual(calls, [['replay', 'sepolia', 'out', 3n, 4n]]);
  advance(1800); await w.tick();
  assert.equal(calls.length, 1, 'backoff: next replay after 2 x stuckAfter');
  advance(1800); await w.tick();
  assert.equal(calls.length, 2);
  advance(7200); await w.tick();
  assert.equal(calls.length, 3);
  advance(14400); await w.tick();
  assert.equal(calls.length, 4, 'gave up after 3 replays: trip');
  assert.equal(calls[3][0], 'trip');
  assert.equal(calls[3][2], 'stuck-out');
  advance(30000); await w.tick();
  assert.equal(calls.length, 4, 'tripped once, not again');
  // delivered: the gap closes, nothing more; a new gap starts fresh
  st.sepolia.lockboxReceived = 5n;
  w.reset('sepolia');
  advance(10); await w.tick();
  assert.equal(calls.length, 4);
});

test('stuck lock (X -> ZETAPHY), heartbeats, anomalies: under-backing and a mint spike trip with hashed evidence', async () => {
  const st = { base: { lockNonce: 2n, lockDelivered: false, lastHeard: 1_000_000 - 21 * 3600, reservesBps: 10000n, mintedLastHour: 0n, hourlyBaseline: E } };
  const { w, calls, advance } = world(st);
  await w.tick();
  assert.deepEqual(calls, [['beat', 'base']], 'quiet for 21 h: a heartbeat long before 14 days');
  await w.tick();
  assert.equal(calls.length, 1, 'at most one beat per beatEvery');
  advance(1800);
  await w.tick();
  assert.deepEqual(calls.slice(1), [['replay', 'base', 'in', 1n, 1n]]);
  st.base.lockDelivered = true;
  st.base.lastHeard = 1_000_000 + 1800;
  st.base.mintedLastHour = 11n * E;                                     // 11 x the baseline
  advance(10);
  await w.tick();
  const trip = calls.at(-1);
  assert.equal(trip[0], 'trip');
  assert.equal(trip[2], 'mint-spike');
  assert.match(trip[3], /^0x[0-9a-f]{64}$/);
  // under-backing on another route
  const b = world({ arb: { reservesBps: 9000n } });
  await b.w.tick();
  assert.equal(b.calls[0][2], 'under-backed');
  // small spikes below minSpike never trip
  const s = world({ op: { mintedLastHour: E / 2n, hourlyBaseline: 0n } });
  await s.w.tick();
  assert.deepEqual(s.calls, []);
  assert.equal(evidenceHash({ b: 1n, a: [2] }), evidenceHash({ a: [2], b: 1n }));
});

test('failing reads and actions are logged, never thrown; other routes still run', async () => {
  let t = 0;
  const w = createSaphanWatcher({ routes: ['bad', 'good'], now: () => t,
    read: async (r) => { if (r === 'bad') throw new Error('rpc down'); return { reservesBps: 1n }; },
    act: { replay: async () => {}, beat: async () => {}, trip: async () => { throw new Error('not a runner'); } } });
  const out = await w.tick();
  assert.deepEqual(out.map((x) => [x.route, x.kind, x.ok]), [['good', 'trip', false]]);
  assert.deepEqual(w.log.map((x) => [x.route, x.kind, x.ok]), [['bad', 'read', false], ['good', 'trip', false]]);
  t += 1; await w.tick();
  assert.equal(w.log.at(-1).kind, 'trip', 'a failed trip is retried');
});

test('chain adapters: routeReader reads a real route; breakerTripper attests the evidence for the previous block', async () => {
  const r = await routeWorld(['alice']);
  await bridgeIn(r, 'alice', 2n * E);
  const view = (k) => ({ ...Object.fromEntries(k.iface.fragments.filter((f) => f.type === 'function').map((f) => [f.name, (...args) => k.call(f.name, args)])) });
  const read = routeReader({ outbox: view(r.outbox), lockbox: view(r.lockbox), lane: view(r.lane) });
  const st = await read();
  assert.equal(st.outboxNonce, 0n);
  assert.equal(st.lockboxReceived, 0n);
  assert.equal(st.lockNonce, 1n);
  assert.equal(st.lockDelivered, true);
  assert.equal(st.reservesBps, undefined, 'no heartbeat yet: no supply known');
  const sent = [];
  const trip = breakerTripper({ protocol: '0x' + '22'.repeat(20), mask: 1, provider: { getBlockNumber: async () => 100 },
    breaker: { attest: async (p, ev) => { sent.push([p, ev]); return { hash: '0xabc', wait: async () => {} }; } } });
  const res = await trip('sepolia', { hash: '0x' + '11'.repeat(32) });
  assert.equal(res.tx, '0xabc');
  assert.deepEqual(sent[0][1], { fromBlock: 99n, toBlock: 99n, evidenceHash: '0x' + '11'.repeat(32), detectorId: DETECTOR_ID, mask: 1 });
});
