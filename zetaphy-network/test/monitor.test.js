// Bridge monitor rules (src/monitor.js evaluate): pure, on synthetic events and snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, zeroPadValue, id as topicId } from 'ethers';
import { evaluate, newState, report, loadMonitorConfig, readEvents, applyMarks, parseWatchlist, parseThresholds, markerKeyOf,
  stateKeyOf, sealState, openState, countsLine, issueText, IFACES } from '../src/monitor.js';

const U = 10n ** 6n;
const NOW = 1_800_000_000;
const TODAY = Math.floor(NOW / 86400);
const ROUTE = '0x' + 'aa'.repeat(32);
const L1 = '0x' + '11'.repeat(20), L2 = '0x' + '22'.repeat(20);
const LOCKBOX = '0x' + 'b0'.repeat(20);
const snap = (over = {}) => ({ paused: false, maxDailyLimit: 1000n * U, decimals: 6, symbol: 'USDC', threshold: 2, quarantine: 600, lanes: [L1, L2],
  routes: [{ id: ROUTE, dailyLimit: 1000n * U, inToday: 0n, outToday: 0n, day: TODAY, enabled: true }], ...over });
const ev = (source, name, args, time = NOW, block = 10) => ({ source, address: '0x' + 'cc'.repeat(20), name, args, block, time, tx: '0x' + '00'.repeat(32) });
const attested = (id, lane, count, nonce, to = '0x' + 'a1'.repeat(20), amount = 5n * U, time = NOW) =>
  ev('airlock', 'Attested', { id, lane, count: BigInt(count), srcChainId: 97n, srcContract: LOCKBOX, srcNonce: BigInt(nonce), sender: to, to, amount }, time);
const rules = (alerts) => alerts.map((a) => a.rule);

test('volume over 80% of the daily limit warns once a day; at the limit it is critical', () => {
  const s1 = snap({ routes: [{ id: ROUTE, dailyLimit: 1000n * U, inToday: 850n * U, outToday: 0n, day: TODAY, enabled: true }] });
  const r1 = evaluate({ snapshot: s1, now: NOW });
  assert.deepEqual(rules(r1.alerts), ['volume']);
  assert.equal(r1.alerts[0].severity, 'warning');
  assert.match(r1.alerts[0].en, /inbound volume 850 USDC = 85% of the daily limit 1000 USDC/);
  assert.match(r1.alerts[0].th, /ยอดเข้าวันนี้ 850 USDC = 85% ของเพดาน/);
  assert.deepEqual(evaluate({ snapshot: s1, now: NOW + 900, state: r1.state }).alerts, []); // not again the same day
  const s2 = snap({ routes: [{ id: ROUTE, dailyLimit: 1000n * U, inToday: 1000n * U, outToday: 0n, day: TODAY, enabled: true }] });
  const r2 = evaluate({ snapshot: s2, now: NOW + 1800, state: r1.state });
  assert.equal(r2.alerts[0].severity, 'critical');
  // yesterday's counters, a disabled cap below the limit: the cap counts
  assert.deepEqual(evaluate({ snapshot: snap({ routes: [{ ...s2.routes[0], day: TODAY - 1 }] }), now: NOW }).alerts, []);
  assert.deepEqual(rules(evaluate({ snapshot: snap({ maxDailyLimit: 100n * U, routes: [{ ...s1.routes[0], inToday: 90n * U }] }), now: NOW }).alerts), ['volume']);
  assert.deepEqual(rules(evaluate({ snapshot: snap(), now: NOW, cfg: { volumePct: 50 } }).alerts), []);
});

test('lanes disagreeing on one deposit (same nonce, other details) is critical', () => {
  const { alerts } = evaluate({ snapshot: snap(), now: NOW, events: [attested('0x01', L1, 1, 7), attested('0x02', L2, 1, 7, '0x' + 'ee'.repeat(20), 9n * U)] });
  assert.ok(alerts.some((a) => a.rule === 'lanes-disagree' && a.severity === 'critical'));
  assert.match(alerts.find((a) => a.rule === 'lanes-disagree').en, /lanes disagree on deposit 97:0xb0b0.*:7/);
});

test('one lane attesting what the other does not within N minutes; quiet once the other follows or it is released', () => {
  const r1 = evaluate({ snapshot: snap(), now: NOW + 60, events: [attested('0x01', L1, 1, 1)] });
  assert.deepEqual(rules(r1.alerts), []); // too early
  const r2 = evaluate({ snapshot: snap(), now: NOW + 31 * 60, state: r1.state });
  assert.deepEqual(rules(r2.alerts), ['lane-missing']);
  assert.match(r2.alerts[0].en, new RegExp(`${L2}.* silent for 31 min`));
  assert.deepEqual(evaluate({ snapshot: snap(), now: NOW + 40 * 60, state: r2.state }).alerts, []); // once only
  // Both lanes, then released: nothing.
  const both = evaluate({ snapshot: snap(), now: NOW + 3600, events: [attested('0x03', L1, 1, 2), attested('0x03', L2, 2, 2), ev('airlock', 'Released', { id: '0x03', to: L1, amount: 1n })] });
  assert.deepEqual(rules(both.alerts), []);
  assert.deepEqual(both.state.transfers, {});
});

test('a transfer ready (lanes + quarantine) but not released for long: release-stalled', () => {
  const r = evaluate({ snapshot: snap(), now: NOW + 600 + 31 * 60, events: [attested('0x04', L1, 1, 3), attested('0x04', L2, 2, 3)] });
  assert.deepEqual(rules(r.alerts), ['release-stalled']);
});

test('veto, pause, a mark and holds are alerts', () => {
  const { alerts } = evaluate({ snapshot: snap(), now: NOW, events: [
    ev('airlock', 'Vetoed', { id: '0x05', by: L1, reason: 'source tx not final' }),
    ev('guard', 'Paused', { by: '0x' + '9a'.repeat(20) }),
    ev('airlock', 'Tripped', { who: '0x' + 'ba'.repeat(20), by: '0x' + 'dc'.repeat(20) }),
    ev('guard', 'InboundHeld', { id: 0n, route: ROUTE, to: '0x' + 'ba'.repeat(20), amount: 3n * U }),
    ev('threats', 'HeldNow', { key: '0x' + '77'.repeat(32), by: '0x' + '9a'.repeat(20) }),
  ] });
  assert.deepEqual(rules(alerts), ['veto', 'pause', 'marked', 'hold', 'hold']);
  assert.ok(alerts.slice(0, 3).every((a) => a.severity === 'critical')); // a mark this monitor did not queue
  assert.match(alerts[2].en, /not a mark this monitor queued/);
  assert.match(alerts[2].th, /ทำเครื่องหมาย/);
});

test('governance changes to limits, lanes, roles, audit and the Hyperlane config are alerts; new routes are remembered', () => {
  const { alerts, state } = evaluate({ snapshot: snap(), now: NOW, events: [
    ev('guard', 'RouteSet', { id: '0x' + 'bb'.repeat(32), adapter: L1, dailyLimit: 5n, enabled: true }),
    ev('guard', 'MaxDailyLimitProposed', { value: 2000n * U, at: BigInt(NOW + 7 * 86400) }),
    ev('guard', 'GuardianSet', { who: L1, allowed: true }),
    ev('guard', 'AuditSet', { url: 'https://a.example/r.pdf', sha256: '0x' + '01'.repeat(32) }),
    ev('airlock', 'LaneSet', { lane: L2, on: false }),
    ev('airlock', 'GovernanceSet', { governance: L1 }),
    ev('airlock', 'MarkerSet', { marker: L2, on: true }),
    ev('hyperlaneLane', 'ConfigSet', { mailbox: L1, originDomain: 1n, originSender: '0x' + '00'.repeat(32), srcChainId: 1n, srcContract: L1 }),
    ev('guard', 'Unpaused', {}),
    ev('neuroLane', 'RunnerAttested', { id: '0x01', runner: L1, votes: 1n }), // not a governance change
  ] });
  assert.equal(alerts.length, 9);
  assert.ok(alerts.every((a) => a.rule === 'governance-change'));
  assert.equal(alerts.find((a) => /MaxDailyLimitProposed/.test(a.en)).severity, 'critical');
  assert.equal(alerts.find((a) => /MarkerSet/.test(a.en)).severity, 'critical'); // a new key that can hold anyone's transfers
  assert.deepEqual(state.routes, ['0x' + 'bb'.repeat(32)]);
});

test('a large single transfer (25%+ of the limit) warns', () => {
  const { alerts } = evaluate({ snapshot: snap(), now: NOW, events: [
    ev('guard', 'Inbound', { route: ROUTE, to: L1, amount: 300n * U }),
    ev('guard', 'Inbound', { route: ROUTE, to: L1, amount: 100n * U }),
    ev('guard', 'Outbound', { route: ROUTE, from: L2, amount: 250n * U }),
  ] });
  assert.deepEqual(rules(alerts), ['large-transfer', 'large-transfer']);
  assert.match(alerts[0].en, /large inbound 300 USDC .* 30% of the daily limit/);
});

test('a source deposit no lane attested within N minutes: lane-silent (critical when no lane spoke)', () => {
  const lock = (nonce, time) => ev('lockbox', 'Locked', { chainId: 97n, contract: LOCKBOX, nonce: BigInt(nonce), sender: L1, to: L1, amount: 5n * U }, time);
  const r1 = evaluate({ snapshot: snap(), now: NOW, events: [lock(1, NOW - 40 * 60), lock(2, NOW - 40 * 60), attested('0x06', L1, 1, 2, L1, 5n * U, NOW - 39 * 60), lock(3, NOW - 60)] });
  const silent = r1.alerts.filter((a) => a.rule === 'lane-silent');
  assert.equal(silent.length, 2);
  assert.equal(silent.find((a) => /:1 /.test(a.en)).severity, 'critical');
  assert.equal(silent.find((a) => /:2 /.test(a.en)).severity, 'warning');
  // The lanes catch up: nothing more, and the deposits are forgotten.
  const r2 = evaluate({ snapshot: snap(), now: NOW + 60, state: r1.state, events: [attested('0x07', L1, 1, 1), attested('0x07', L2, 2, 1), attested('0x06', L2, 2, 2), attested('0x08', L1, 1, 3), attested('0x08', L2, 2, 3)] });
  assert.deepEqual(rules(r2.alerts).filter((x) => x === 'lane-silent'), []);
  assert.deepEqual(r2.state.locks, {});
});

test('the report carries the alerts and an English and a Thai summary; the config falls back to the launch state', () => {
  const { alerts } = evaluate({ snapshot: snap(), now: NOW, events: [ev('guard', 'Paused', { by: L1 })] });
  const r = report({ alerts, chainId: 77390, fromBlock: 1, toBlock: 9, addresses: {}, snapshot: snap(), now: NOW });
  assert.equal(r.format, 'zetaphy-bridge-monitor/1');
  assert.match(r.summary.en, /1 alert\(s\), 1 critical \(blocks 1–9\)/);
  assert.match(r.summary.th, /มีสัญญาณเตือน 1 รายการ ร้ายแรง 1 รายการ/);
  assert.match(report({ alerts: [], chainId: 1, fromBlock: 1, toBlock: 2, addresses: {}, snapshot: snap(), now: NOW }).summary.th, /ไม่มีสัญญาณเตือน/);
  assert.equal(typeof JSON.stringify(r), 'string'); // no bigints left
  const dir = mkdtempSync(join(tmpdir(), 'monitor-'));
  writeFileSync(join(dir, 'm.json'), JSON.stringify({ rpc: 'https://rpc.example', bridgeGuard: null, volumePct: 70 }));
  writeFileSync(join(dir, 's.json'), JSON.stringify({ steps: { bridge: { out: { bridgeGuard: L1, bridgeAirlock: L2 } } } }));
  assert.deepEqual(loadMonitorConfig({ configFile: join(dir, 'm.json'), launchStateFile: join(dir, 's.json') }), { rpc: 'https://rpc.example', bridgeGuard: L1, bridgeAirlock: L2, volumePct: 70,
    timelock: null, oracle: null, labels: { [L1.toLowerCase()]: 'bridgeGuard', [L2.toLowerCase()]: 'bridgeAirlock' } });
  assert.deepEqual(loadMonitorConfig({ configFile: join(dir, 'none.json') }), {});
  assert.equal(newState().lastBlock, null);
});

// ---- watch list, marking and redaction ----

const WATCHED = getAddress('0x' + 'ab12cd34'.repeat(5));   // the secret: a contract the monitor watches
const WATCHED2 = getAddress('0x' + '5e'.repeat(20));
const MARKER = getAddress('0x' + '4d'.repeat(20));        // the monitor's marker key's address
const ATTACKER = getAddress('0x' + 'a7'.repeat(20));
const LURE = getAddress('0x' + '1e'.repeat(20));
const GUARD = getAddress('0x' + '6a'.repeat(20)), AIRLOCK = getAddress('0x' + 'a1'.repeat(20));
const word = (addr) => zeroPadValue(addr, 32);
const SIG = topicId('Called(address,bytes4)');
const hit = (who, block = 5, address = WATCHED) => ({ address, topics: [SIG, word(who), '0x' + '00'.repeat(32)], data: '0x', blockNumber: block, transactionHash: '0x' + 'cd'.repeat(32), index: 0 });
const airlockLog = (name, args, block) => ({ address: AIRLOCK, ...IFACES.airlock.encodeEventLog(name, args), blockNumber: block, transactionHash: '0x' + 'ef'.repeat(32), index: 0 });
function fakeProvider(logs, { fail = false } = {}) {
  const asked = [];
  return {
    asked,
    async getLogs(f) {
      asked.push(f);
      if (fail) { const e = new Error(`could not coalesce error (payload=${JSON.stringify(f)})`); e.code = 'SERVER_ERROR'; throw e; }
      const want = f.address.map((x) => x.toLowerCase());
      return logs.filter((l) => want.includes(l.address.toLowerCase()) && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async getBlock(n) { return { timestamp: NOW - 1000 + n }; },
  };
}
function fakeAirlock({ marker = true, tripped = [], failFor = [] } = {}) {
  const sent = [];
  const T = new Set(tripped.map((x) => x.toLowerCase()));
  return {
    sent,
    async isMarker(a) { return marker && a === MARKER; },
    async tripped(w) { return T.has(w.toLowerCase()); },
    async trip(w) {
      if (failFor.map((x) => x.toLowerCase()).includes(w.toLowerCase())) {
        const e = new Error(`execution reverted (transaction={ "to": "${AIRLOCK}", "from": "${MARKER}" })`); e.code = 'INSUFFICIENT_FUNDS'; throw e;
      }
      sent.push(getAddress(w)); T.add(w.toLowerCase());
      return { wait: async () => ({ status: 1 }) };
    },
  };
}
const SOURCES = [{ source: 'guard', address: GUARD }, { source: 'airlock', address: AIRLOCK }];

test('watch list: parsed from the environment only; errors never quote it', () => {
  const list = parseWatchlist(JSON.stringify([{ address: WATCHED }, { address: WATCHED2, callerTopic: 2 }, { address: WATCHED.toLowerCase() }]));
  assert.deepEqual(list, [{ address: WATCHED.toLowerCase(), callerTopic: 1 }, { address: WATCHED2.toLowerCase(), callerTopic: 2 }]);
  assert.deepEqual(parseWatchlist(undefined), []);
  assert.deepEqual(parseWatchlist(''), []);
  for (const bad of [`[{"address": ${WATCHED}}]`, `{"address": "${WATCHED}"}`, JSON.stringify([{ address: WATCHED, callerTopic: 0 }]),
    JSON.stringify([{ address: WATCHED, callerTopic: 4 }]), JSON.stringify([{ address: WATCHED, label: 'honeypot one' }]), JSON.stringify([{ address: WATCHED.slice(0, 40) }]),
    JSON.stringify([{ address: '0x' + '00'.repeat(20) }])]) {
    assert.throws(() => parseWatchlist(bad), (e) => /BRIDGE_WATCHLIST/.test(e.message) && !e.message.toLowerCase().includes(WATCHED.slice(2, 12).toLowerCase()) && !/label|honeypot/.test(e.message), bad);
  }
  assert.deepEqual(parseThresholds('{"volumePct": 60, "largePct": 10}'), { volumePct: 60, largePct: 10 });
  assert.deepEqual(parseThresholds(''), {});
  for (const bad of ['{"volumePct": 6', '[60]', '{"volumePct": "60"}', '{"volumePct": -1}', '{"secretKnob": 1}']) {
    assert.throws(() => parseThresholds(bad), (e) => /BRIDGE_MONITOR_THRESHOLDS/.test(e.message) && !/secretKnob|"60"|6\b/.test(e.message.replace('BRIDGE_MONITOR_THRESHOLDS', '')), bad);
  }
  const key = '0x' + '3c'.repeat(32);
  assert.equal(markerKeyOf({ BRIDGE_MARKER_KEY: key.slice(2) }), key);
  assert.equal(markerKeyOf({}), null);
  assert.throws(() => markerKeyOf({ BRIDGE_MARKER_KEY: key.slice(0, 40) }), (e) => !e.message.includes(key.slice(2, 40)));
});

test('a watched contract\'s log is an alert naming only its caller (topic callerTopic); new callers are queued for marking', async () => {
  const p = fakeProvider([hit(ATTACKER, 5), hit(ATTACKER, 6), hit(LURE, 7, WATCHED2)]);
  // WATCHED2 keeps its caller in topic 2: this log has topic 2 = 0, so there is no caller to read.
  const watch = parseWatchlist(JSON.stringify([{ address: WATCHED }, { address: WATCHED2, callerTopic: 2 }]));
  const events = await readEvents(p, SOURCES, 1, 10, { watch });
  assert.equal(p.asked.length, 1);
  assert.deepEqual(events.map((e) => [e.source, e.name, e.args.caller]), [['watch', 'Hit', ATTACKER], ['watch', 'Hit', ATTACKER], ['watch', 'Hit', null]]);
  for (const e of events) { assert.equal(e.address, undefined); assert.equal(e.tx, undefined); } // nothing else of a watched log goes further
  const r = evaluate({ snapshot: snap(), now: NOW, events, cfg: { marker: MARKER } });
  assert.deepEqual(rules(r.alerts), ['watch-hit', 'watch-hit']);
  assert.match(r.alerts[0].en, new RegExp(`a watched contract was called by ${ATTACKER} \\(2 logs\\): queued`));
  assert.equal(r.alerts[0].severity, 'critical');
  assert.match(r.alerts[1].en, /without an address in its caller topic: nothing marked/);
  assert.deepEqual(Object.keys(r.state.marks), [ATTACKER.toLowerCase()]);
  assert.equal(r.state.marks[ATTACKER.toLowerCase()].done, null);
  // Without a marker key: alert only, nothing queued.
  const ro = evaluate({ snapshot: snap(), now: NOW, events });
  assert.match(ro.alerts[0].en, /not marked \(no marker key: alert only\)/);
  assert.deepEqual(ro.state.marks, {});
});

test('marking: queued callers are tripped once; already tripped ones only recorded; failures retried; a lifted mark is not repeated', async () => {
  const st0 = evaluate({ snapshot: snap(), now: NOW, cfg: { marker: MARKER }, events: [
    { source: 'watch', name: 'Hit', args: { caller: ATTACKER }, block: 5, time: NOW - 60 },
    { source: 'watch', name: 'Hit', args: { caller: LURE }, block: 6, time: NOW - 50 },
    { source: 'watch', name: 'Hit', args: { caller: L1 }, block: 7, time: NOW - 40 },
  ] }).state;
  const k = fakeAirlock({ tripped: [LURE], failFor: [L1] });
  const m1 = await applyMarks({ airlock: k, marker: MARKER, state: st0, now: NOW });
  assert.deepEqual(k.sent, [ATTACKER]);
  assert.deepEqual([m1.marked, m1.pending], [1, 1]);
  assert.deepEqual(rules(m1.alerts), ['mark-failed']);
  assert.match(m1.alerts[0].en, new RegExp(`could not mark ${L1} \\(INSUFFICIENT_FUNDS\\)`));
  assert.ok(!m1.alerts[0].en.includes(AIRLOCK), 'only the reason, not the error text');
  assert.equal(st0.marks[LURE.toLowerCase()].done, NOW); // tripped already: recorded, nothing sent
  // Next run: the failed one again (no second alert), the others not again.
  const k2 = fakeAirlock({ tripped: [ATTACKER, LURE] });
  const m2 = await applyMarks({ airlock: k2, marker: MARKER, state: st0, now: NOW + 600 });
  assert.deepEqual(k2.sent, [L1]);
  assert.deepEqual([m2.marked, m2.pending, m2.alerts.length], [1, 0, 0]);
  // The Tripped events of these marks: warnings (this monitor's own), not critical.
  const r3 = evaluate({ snapshot: snap(), now: NOW + 900, state: st0, cfg: { marker: MARKER }, events: [
    ev('airlock', 'Tripped', { who: ATTACKER, by: MARKER }, NOW + 700),
    ev('airlock', 'Untripped', { who: ATTACKER }, NOW + 800),
    { source: 'watch', name: 'Hit', args: { caller: ATTACKER }, block: 30, time: NOW + 850 },
  ] });
  assert.deepEqual(r3.alerts.map((a) => `${a.rule}/${a.severity}`), ['marked/warning', 'governance-change/warning', 'watch-hit/critical']);
  assert.match(r3.alerts[2].en, /not marked again: governance lifted its earlier mark/);
  const k3 = fakeAirlock();
  assert.deepEqual((await applyMarks({ airlock: k3, marker: MARKER, state: r3.state, now: NOW + 900 })).marked, 0);
  assert.deepEqual(k3.sent, []);
  // A key that is not (or no longer) a marker: one critical alert a day, nothing sent.
  const st4 = evaluate({ snapshot: snap(), now: NOW, cfg: { marker: MARKER }, events: [{ source: 'watch', name: 'Hit', args: { caller: L2 }, block: 5, time: NOW }] }).state;
  const k4 = fakeAirlock({ marker: false });
  const m4 = await applyMarks({ airlock: k4, marker: MARKER, state: st4, now: NOW });
  assert.match(m4.alerts[0].en, /is not a marker of the airlock \(governance: setMarker\)/);
  assert.equal((await applyMarks({ airlock: k4, marker: MARKER, state: st4, now: NOW + 60 })).alerts.length, 0);
  assert.deepEqual(k4.sent, []);
  // A caller that is a contract (Multicall, a forwarder, a router: shared by many) is not marked automatically.
  const ROUTER = getAddress('0x' + '7a'.repeat(20));
  const st5 = evaluate({ snapshot: snap(), now: NOW, cfg: { marker: MARKER }, events: [
    { source: 'watch', name: 'Hit', args: { caller: ROUTER }, block: 5, time: NOW },
    { source: 'watch', name: 'Hit', args: { caller: L2 }, block: 6, time: NOW },
  ] }).state;
  const k5 = fakeAirlock();
  const m5 = await applyMarks({ airlock: k5, marker: MARKER, state: st5, now: NOW, codeAt: async (w) => (w === ROUTER ? '0x6080' : '0x') });
  assert.deepEqual(k5.sent, [L2]);
  assert.deepEqual(rules(m5.alerts), ['mark-skipped']);
  assert.equal((await applyMarks({ airlock: k5, marker: MARKER, state: st5, now: NOW + 60, codeAt: async () => '0x6080' })).alerts.length, 0, 'decided once');
  // Marks are forgotten 90 days after they are done.
  const old = evaluate({ snapshot: snap(), now: NOW + 91 * 86400, state: r3.state });
  assert.deepEqual(old.state.marks, {});
});

test('a getLogs error is reduced to its code when the request names watched contracts', async () => {
  const watch = parseWatchlist(JSON.stringify([{ address: WATCHED }]));
  await assert.rejects(readEvents(fakeProvider([], { fail: true }), SOURCES, 1, 10, { watch }),
    (e) => /reading logs of blocks 1–10 failed \(SERVER_ERROR; details withheld/.test(e.message) && !e.message.toLowerCase().includes(WATCHED.slice(2).toLowerCase()));
  await assert.rejects(readEvents(fakeProvider([], { fail: true }), SOURCES, 1, 10), /could not coalesce/); // no watch list: unchanged
  await assert.rejects(readEvents(fakeProvider([]), SOURCES, 1, 10, { watch: parseWatchlist(JSON.stringify([{ address: AIRLOCK }])) }), /names one of the bridge's own contracts/);
});

test('redaction: no watched address in the report, summaries, issue text, counts line or state (any letter case)', async () => {
  const env = { BRIDGE_WATCHLIST: JSON.stringify([{ address: WATCHED }, { address: WATCHED2.toLowerCase(), callerTopic: 2 }]), BRIDGE_MARKER_KEY: '0x' + '3c'.repeat(32) };
  const watch = parseWatchlist(env.BRIDGE_WATCHLIST);
  const p = fakeProvider([hit(ATTACKER, 3), hit(LURE, 4), { ...hit(L1, 5, WATCHED2), topics: [SIG, '0x' + '00'.repeat(32), word(L1)] },
    airlockLog('Tripped', [LURE, MARKER], 6), airlockLog('MarkerSet', [MARKER, true], 2)]);
  const events = await readEvents(p, SOURCES, 1, 10, { watch });
  const { alerts, state } = evaluate({ snapshot: snap(), now: NOW, events, cfg: { marker: MARKER } });
  const m = await applyMarks({ airlock: fakeAirlock({ failFor: [L1] }), marker: MARKER, state, now: NOW });
  alerts.push(...m.alerts);
  assert.deepEqual([...new Set(rules(alerts))].sort(), ['governance-change', 'mark-failed', 'marked', 'watch-hit']);
  const rep = report({ alerts, chainId: 77390, fromBlock: 1, toBlock: 10, addresses: { bridgeGuard: GUARD, bridgeAirlock: AIRLOCK }, snapshot: snap(), now: NOW, marking: { marked: m.marked, pending: m.pending } });
  assert.match(rep.summary.en, /Marked this run: 1; marks pending: 1\./);
  const key = stateKeyOf(env);
  const outputs = {
    report: JSON.stringify(rep), summary: `${rep.summary.th}\n\n${rep.summary.en}`, issue: issueText(rep, { runUrl: 'https://github.com/o/r/actions/runs/1' }),
    counts: countsLine(rep), state: JSON.stringify(sealState(state, null)), sealed: JSON.stringify(sealState(state, key)),
  };
  for (const [what, text] of Object.entries(outputs)) {
    for (const w of [WATCHED, WATCHED2]) {
      assert.ok(!text.toLowerCase().includes(w.slice(2).toLowerCase()), `${what} names a watched contract`);
    }
  }
  // The marked caller may be shown (public through Tripped); the counts line shows no address at all.
  assert.ok(outputs.report.includes(ATTACKER));
  assert.doesNotMatch(outputs.counts, /0x[0-9a-fA-F]{40}/);
  assert.equal(outputs.counts, `bridge monitor: ${alerts.length} alert(s), ${alerts.filter((a) => a.severity === 'critical').length} critical (blocks 1–10); marked 1, pending 1`);
  // The sealed state shows nothing at all of what the monitor saw.
  assert.doesNotMatch(outputs.sealed, /0x[0-9a-fA-F]{40}|"(marks|alerted|transfers|locks|routes)"/);
});

test('state: encrypted with a key derived from the monitor secrets; another key or none: fresh memory from the same block; none set: plain JSON', () => {
  assert.equal(stateKeyOf({}), null);
  assert.equal(stateKeyOf({ BRIDGE_WATCHLIST: '  ' }), null);
  const k1 = stateKeyOf({ BRIDGE_MONITOR_THRESHOLDS: '{"volumePct": 60}' });
  const k2 = stateKeyOf({ BRIDGE_MONITOR_THRESHOLDS: '{"volumePct": 50}' });
  assert.equal(k1.length, 32);
  assert.notDeepEqual(k1, k2);
  const st = { ...newState(), lastBlock: 42, sourceBlocks: { [LOCKBOX]: 7 }, alerted: { 'volume:x:in:1:60': NOW }, marks: { [L1]: { seen: NOW, done: null } } };
  const sealed = sealState(st, k1);
  assert.equal(sealed.format, 'zetaphy-bridge-monitor-state/aes-256-gcm');
  assert.deepEqual([sealed.lastBlock, sealed.sourceBlocks], [42, { [LOCKBOX]: 7 }]); // the scan position only, in clear
  assert.doesNotMatch(JSON.stringify(sealed), /volume|alerted|marks|seen/);
  assert.ok(!JSON.stringify(sealed).includes(L1.slice(2)));
  assert.deepEqual(openState(JSON.parse(JSON.stringify(sealed)), k1).state, st);
  // Rotated secrets: the memory is lost, the scan continues where it was (no rescan).
  const other = openState(sealed, k2);
  assert.deepEqual(other.state, { ...newState(), lastBlock: 42, sourceBlocks: { [LOCKBOX]: 7 } });
  assert.match(other.note, /written with other monitor secrets: continuing from its last scanned block with a fresh memory/);
  assert.match(openState(sealed, null).note, /encrypted and no monitor secret is set/);
  assert.equal(openState({ ...sealed, lastBlock: 'x' }, k2).state.lastBlock, null);
  assert.deepEqual(sealState(st, null), st);
  assert.deepEqual(openState(st, k1).state, st); // a plain state (before the secrets were set) is still read
  assert.deepEqual(openState(null, k1), { state: null });
});

test('timelock: a scheduled call names the function and when it can run; executed, cancelled, a new delay, roles', () => {
  const T = '0x' + '7e'.repeat(20);
  const data = IFACES.guard.encodeFunctionData('setGovernance', ['0x' + '99'.repeat(20)]);
  const events = [
    ev('timelock', 'CallScheduled', { id: '0x' + 'ab'.repeat(32), index: 0n, target: T, value: 0n, data, predecessor: '0x' + '00'.repeat(32), delay: 172800n }),
    ev('timelock', 'CallScheduled', { id: '0x' + 'cd'.repeat(32), index: 0n, target: T, value: 0n, data: '0x12345678', predecessor: '0x' + '00'.repeat(32), delay: 172800n }),
    ev('timelock', 'CallExecuted', { id: '0x' + 'ab'.repeat(32), index: 0n, target: T, value: 0n, data }),
    ev('timelock', 'Cancelled', { id: '0x' + 'cd'.repeat(32) }),
    ev('timelock', 'MinDelayChange', { oldDuration: 172800n, newDuration: 3600n }),
    ev('timelock', 'RoleGranted', { role: '0x' + '11'.repeat(32), account: T, sender: T }),
  ];
  const { alerts } = evaluate({ snapshot: snap({ routes: [] }), now: NOW, events, cfg: { labels: { [T.toLowerCase()]: 'bridgeGuard' } } });
  assert.deepEqual(rules(alerts), ['timelock-scheduled', 'timelock-scheduled', 'timelock-executed', 'timelock-cancelled', 'timelock-delay', 'governance-change']);
  assert.equal(alerts[0].severity, 'critical', 'a governance change is critical');
  assert.match(alerts[0].en, new RegExp(`bridgeGuard ${T} setGovernance\\(address\\), executable after ${new Date((NOW + 172800) * 1000).toISOString()}`));
  assert.match(alerts[0].th, /ทำได้หลัง/);
  assert.equal(alerts[1].severity, 'warning');
  assert.match(alerts[1].en, /0x12345678/, 'an unknown selector is shown as is');
  assert.equal(alerts[4].severity, 'critical');
});

test('oracle: deviation, stale, circuit breaker, pause and a feed without a price now; repeats are folded', () => {
  const ASSET = '0x' + 'a5'.repeat(20);
  const events = [
    ev('oracle', 'DeviationTripped', { asset: ASSET, twapPrice: 2n * 10n ** 18n, pythPrice: 21n * 10n ** 17n, bps: 500n }),
    ev('oracle', 'DeviationTripped', { asset: ASSET, twapPrice: 2n * 10n ** 18n, pythPrice: 21n * 10n ** 17n, bps: 500n }, NOW + 60),
    ev('oracle', 'StaleFeed', { asset: ASSET, source: 2n, updatedAt: BigInt(NOW - 600) }),
    ev('oracle', 'CircuitBreakerTripped', { asset: ASSET, price: 3n * 10n ** 18n, ref: 2n * 10n ** 18n, bps: 5000n }),
    ev('oracle', 'FeedPaused', { asset: ASSET, by: L1 }),
    ev('oracle', 'SourceProblem', { asset: ASSET, problem: 6n, a: 4000n, b: 2000n }),
    ev('oracle', 'GuardsSet', { asset: ASSET, maxDeviationBps: 200n, maxChangeBps: 1500n, maxWindowChangeBps: 3000n, changeWindow: 3600n }),
  ];
  const r = evaluate({ snapshot: snap({ routes: [], oracleFeeds: [{ asset: ASSET, ok: false, error: 'PythStale' }, { asset: L2, ok: true, value: 1n }] }), now: NOW, events });
  assert.deepEqual(rules(r.alerts), ['oracle-deviation', 'oracle-stale', 'oracle-breaker', 'oracle-paused', 'oracle-problem', 'governance-change', 'oracle-stale']);
  assert.match(r.alerts[0].en, /TWAP \$2 and Pyth \$2\.1 differ by 500 bps/);
  assert.match(r.alerts[2].th, /ตัดวงจรราคา/);
  assert.match(r.alerts[4].en, /TwapSpike/);
  assert.match(r.alerts[6].en, /price\(\) reverts PythStale/);
  assert.deepEqual(rules(evaluate({ snapshot: snap({ routes: [], oracleFeeds: [{ asset: ASSET, ok: false, error: 'PythStale' }] }), now: NOW + 60, state: r.state }).alerts), [], 'once a day');
});
