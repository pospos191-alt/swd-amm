// Bridge monitor rules (src/monitor.js evaluate): pure, on synthetic events and snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, newState, report, loadMonitorConfig } from '../src/monitor.js';

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

test('veto, pause, decoy hit and holds are alerts', () => {
  const { alerts } = evaluate({ snapshot: snap(), now: NOW, events: [
    ev('airlock', 'Vetoed', { id: '0x05', by: L1, reason: 'source tx not final' }),
    ev('guard', 'Paused', { by: '0x' + '9a'.repeat(20) }),
    ev('airlock', 'Tripped', { who: '0x' + 'ba'.repeat(20), decoy: '0x' + 'dc'.repeat(20) }),
    ev('guard', 'InboundHeld', { id: 0n, route: ROUTE, to: '0x' + 'ba'.repeat(20), amount: 3n * U }),
    ev('threats', 'HeldNow', { key: '0x' + '77'.repeat(32), by: '0x' + '9a'.repeat(20) }),
  ] });
  assert.deepEqual(rules(alerts), ['veto', 'pause', 'decoy-hit', 'hold', 'hold']);
  assert.ok(alerts.slice(0, 3).every((a) => a.severity === 'critical'));
  assert.match(alerts[2].th, /สะพานล่อ/);
});

test('governance changes to limits, lanes, roles, audit and the Hyperlane config are alerts; new routes are remembered', () => {
  const { alerts, state } = evaluate({ snapshot: snap(), now: NOW, events: [
    ev('guard', 'RouteSet', { id: '0x' + 'bb'.repeat(32), adapter: L1, dailyLimit: 5n, enabled: true }),
    ev('guard', 'MaxDailyLimitProposed', { value: 2000n * U, at: BigInt(NOW + 7 * 86400) }),
    ev('guard', 'GuardianSet', { who: L1, allowed: true }),
    ev('guard', 'AuditSet', { url: 'https://a.example/r.pdf', sha256: '0x' + '01'.repeat(32) }),
    ev('airlock', 'LaneSet', { lane: L2, on: false }),
    ev('airlock', 'GovernanceSet', { governance: L1 }),
    ev('hyperlaneLane', 'ConfigSet', { mailbox: L1, originDomain: 1n, originSender: '0x' + '00'.repeat(32), srcChainId: 1n, srcContract: L1 }),
    ev('guard', 'Unpaused', {}),
    ev('neuroLane', 'RunnerAttested', { id: '0x01', runner: L1, votes: 1n }), // not a governance change
  ] });
  assert.equal(alerts.length, 8);
  assert.ok(alerts.every((a) => a.rule === 'governance-change'));
  assert.equal(alerts.find((a) => /MaxDailyLimitProposed/.test(a.en)).severity, 'critical');
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
  assert.deepEqual(loadMonitorConfig({ configFile: join(dir, 'm.json'), launchStateFile: join(dir, 's.json') }), { rpc: 'https://rpc.example', bridgeGuard: L1, bridgeAirlock: L2, volumePct: 70 });
  assert.deepEqual(loadMonitorConfig({ configFile: join(dir, 'none.json') }), {});
  assert.equal(newState().lastBlock, null);
});
