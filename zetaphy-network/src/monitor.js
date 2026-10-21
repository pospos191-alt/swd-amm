// Bridge monitor (zetaphy bridge monitor, .github/workflows/bridge-monitor.yml).
// Reads the chain: events of BridgeGuard, BridgeAirlock, its lanes (NeuroLane,
// HyperlaneLane) and the ThreatRegistry, plus a snapshot of their state, and raises alerts:
//   volume            daily volume of a route over volumePct % of its limit
//   lanes-disagree    two attestations for one source deposit (same chain, contract,
//                     nonce) with different details
//   lane-missing      one lane attested a transfer, another did not within disagreeMinutes
//   veto | pause | hold
//   marked            an address was marked (BridgeAirlock.trip by a marker)
//   watch-hit         a contract on the private watch list logged an event (see below)
//   mark-failed       the monitor could not mark a caller (retried next run)
//   governance-change limits, lanes, roles, markers, audit, threats registry, unpause...
//   large-transfer    one transfer of largePct % of the route's limit or more
//   lane-silent       a source deposit (with --source-rpc) no lane attested within silentMinutes
//   release-stalled   a transfer ready (lanes + quarantine) but not released within silentMinutes
//   timelock-scheduled  a call scheduled in the ZetaphyTimelock (target, function, when it can run):
//                     the window in which a bad change can still be cancelled
//   timelock-executed | timelock-cancelled | timelock-delay (MinDelayChange) | governance-change (its roles)
//   timelock-proposal a gov proposal whose MsgEVMCall schedules (or cancels) a call in the timelock, read from
//                     the node's Cosmos REST API (/cosmos/gov/v1/proposals): logs of a MsgEVMCall are not in
//                     eth_getLogs, so a call the gov module schedules is seen here, while the vote is open
//   oracle-deviation  ZetaphyOracle: the DEX TWAP and Pyth disagree (DeviationTripped, no price)
//   oracle-stale      a feed's source is stale (StaleFeed, or price() reverts TwapStale / PythStale)
//   oracle-breaker    the circuit breaker tripped (a jump): no price until governance resets it
//   oracle-paused | oracle-problem | oracle-unavailable   a paused feed, another source problem, no price
// evaluate() is pure (unit-tested); scan() does the reading. State (the last
// scanned block, open transfers, alerts already sent, marks) is kept by the caller.
//
// Watch list (optional, private): BRIDGE_WATCHLIST, a JSON array of {address, callerTopic?},
// read only from the environment (a repository secret), never from a committed file. Any
// log of a watched contract is an alert; the caller is read from topic callerTopic (default
// 1, the first indexed parameter). The watched contract must emit its own msg.sender there:
// whoever can choose what lands in that topic can get anyone marked. msg.sender semantics
// also mean that someone lured into calling an intermediary contract that pokes a watched
// one is not the address marked: the intermediary is.
// With BRIDGE_MARKER_KEY (a marker of the airlock, setMarker) the monitor marks each new
// caller: BridgeAirlock.trip(caller). Marking is not instant (it happens at the next scan),
// so the airlock's quarantine must be longer than the monitor's interval.
// Redaction: a watched address never leaves readEvents(): the alerts, the report, the
// summaries and the state carry "a watched contract" and the caller only (a marked caller
// is public anyway, through the Tripped event), never the watched address, its log or tx.

import { Interface, formatUnits, getAddress } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { callName, TIMELOCK } from './timelock.js';
import { PROBLEMS, usd } from './oracle.js';

export const DEFAULTS = { volumePct: 80, largePct: 25, disagreeMinutes: 30, silentMinutes: 30, chunk: 1000, maxBlocks: 50_000, lookback: 20_000 };

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).abi;
export const IFACES = {
  guard: new Interface(art('BridgeGuard')),
  airlock: new Interface(art('BridgeAirlock')),
  neuroLane: new Interface(art('NeuroLane')),
  hyperlaneLane: new Interface(art('HyperlaneLane')),
  threats: new Interface(['event HeldNow(bytes32 indexed key, address indexed by)', 'event FastEnforced(bytes32 indexed key, address indexed by)',
    'event GovernanceSet(address governance)', 'event Protected(bytes32 indexed key, bool on)']),
  lockbox: new Interface(['event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount)']),
  timelock: new Interface(art('ZetaphyTimelock')),
  oracle: new Interface(art('ZetaphyOracle')),
};

const GOVERNANCE_EVENTS = {
  guard: ['RouteSet', 'GuardianSet', 'GovernanceSet', 'ThreatsSet', 'AuditSet', 'MaxDailyLimitProposed', 'MaxDailyLimitSet', 'MaxDailyLimitCancelled', 'Unpaused', 'HeldDropped'],
  airlock: ['LaneSet', 'VetoerSet', 'MarkerSet', 'ThreatsSet', 'GovernanceSet', 'ThresholdSet', 'QuarantineSet', 'Untripped'],
  hyperlaneLane: ['ConfigSet', 'IsmSet', 'GovernanceSet'],
  threats: ['GovernanceSet'],
  timelock: ['RoleGranted', 'RoleRevoked'],
  oracle: ['GovernanceSet', 'GuardianSet', 'PythSet', 'TwapConfigured', 'PythConfigured', 'GuardsSet', 'FeedUnpaused', 'CircuitBreakerReset'],
};
/** Timelocked calls that change who governs, the delay, roles or the riskiest rules: critical when scheduled. */
const CRITICAL_CALLS = new Set(['setGovernance', 'setOwner', 'setAdmin', 'grantRole', 'revokeRole', 'renounceRole', 'updateDelay', 'acceptGovernance',
  'setLane', 'setMarker', 'setThreshold', 'setQuarantine', 'untrip', 'setThreats', 'setRoute', 'proposeMaxDailyLimit', 'unpause', 'setGuardian',
  'setConfig', 'setInterchainSecurityModule', 'setPyth', 'setRelayer', 'setTwap', 'setPythFeed', 'setGuards', 'resetCircuitBreaker', 'unpauseFeed',
  'setOracle', 'setTestnetFixedPrices', 'withdrawReserve', 'sweep', 'setProtected', 'setThreatRegistry', 'setFee', 'setFeeTo', 'proposeShares']);

export function newState() {
  return { version: 1, lastBlock: null, routes: [], transfers: {}, locks: {}, sourceBlocks: {}, alerted: {}, marks: {} };
}

const lower = (a) => String(a).toLowerCase();
const str = (v) => (typeof v === 'bigint' ? v.toString() : v);
const plain = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Pure rules.
 * @param {object} p
 * @param {Array<{source:string, address:string, name:string, args:object, block:number, time:number, tx?:string}>} p.events  new events, oldest first
 * @param {object} p.snapshot  { paused, maxDailyLimit, decimals, symbol, threshold, quarantine, lanes:[addr], airlockRoute,
 *                              routes:[{id, dailyLimit, inToday, outToday, day, enabled}], locks?:[{chainId, contract, nonce, sender, to, amount, time}] }
 * @param {object} p.state     newState() or the previous run's
 * @param {number} p.now       unix seconds (chain time)
 * @returns {{alerts: object[], state: object}}
 */
export function evaluate({ events = [], snapshot, state = newState(), now, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  const st = structuredClone(state);
  st.transfers ??= {}; st.locks ??= {}; st.alerted ??= {}; st.routes ??= [];
  const alerts = [];
  const dec = Number(snapshot.decimals ?? 18);
  const sym = snapshot.symbol ?? '';
  const amt = (v) => `${formatUnits(BigInt(v), dec).replace(/\.0$/, '')}${sym ? ` ${sym}` : ''}`;
  const limitOf = (r) => { const l = BigInt(r.dailyLimit ?? 0); const m = BigInt(snapshot.maxDailyLimit ?? l); return l < m ? l : m; };
  const routeById = Object.fromEntries((snapshot.routes ?? []).map((r) => [lower(r.id), r]));
  const add = (rule, severity, en, th, data = {}, once = null) => {
    if (once) { if (st.alerted[once]) return; st.alerted[once] = now; }
    alerts.push({ rule, severity, en, th, data: plain(data) });
  };
  const lanesNow = (snapshot.lanes ?? []).map(lower);
  st.marks ??= {};
  const marker = c.marker ? lower(c.marker) : null;   // the monitor's marker address, when it marks
  const hits = new Map();                              // watched contracts' callers ('' = none) -> logs

  for (const e of events) {
    const a = e.args ?? {};
    if (e.source === 'watch') {
      // readEvents keeps nothing of a watched log but its caller: no address, tx or data.
      const who = a.caller ? getAddress(a.caller) : '';
      hits.set(who, (hits.get(who) ?? 0) + 1);
      if (who && marker) st.marks[lower(who)] ??= { seen: e.time, done: null };
      continue;
    }
    const where = `${e.source} ${e.address}`;
    const at = { block: e.block, tx: e.tx };
    // governance changes
    if ((GOVERNANCE_EVENTS[e.source] ?? []).includes(e.name)) {
      const detail = Object.entries(a).map(([k, v]) => `${k}=${str(v)}`).join(', ');
      add('governance-change', ['MaxDailyLimitProposed', 'LaneSet', 'ConfigSet', 'IsmSet', 'ThresholdSet', 'GovernanceSet', 'MarkerSet'].includes(e.name) ? 'critical' : 'warning',
        `governance change: ${where} ${e.name}(${detail})`,
        `มีการเปลี่ยนค่าโดย governance: ${where} ${e.name}(${detail})`, { ...at, event: e.name, args: a });
      if (e.source === 'guard' && e.name === 'RouteSet' && !st.routes.some((r) => lower(r) === lower(a.id))) st.routes.push(a.id);
    }
    if (e.name === 'Paused') add('pause', 'critical', `bridge PAUSED by ${a.by} (only governance can unpause)`, `สะพานถูกหยุด (pause) โดย ${a.by} (ต้องให้ governance เปิดคืน)`, { ...at, by: a.by });
    if (e.name === 'Vetoed') {
      // the vetoer writes this text; keep it plain so it can't add links or @mentions to the alert issue
      const reason = String(a.reason ?? '').replace(/[^\w .,:;()\-\u0E00-\u0E7F]/g, '').slice(0, 200);
      add('veto', 'critical', `transfer ${a.id} vetoed by ${a.by}: ${reason}`, `รายการโอน ${a.id} ถูก veto โดย ${a.by}: ${reason}`, { ...at, id: a.id, by: a.by, reason });
    }
    if (e.source === 'airlock' && e.name === 'Tripped') {
      const k = lower(a.who);
      const ours = marker != null && lower(a.by) === marker && st.marks[k] != null;
      if (st.marks[k]) st.marks[k].done ??= e.time;
      if (ours) add('marked', 'warning', `${a.who} marked by this monitor (marker ${a.by}): it called a watched contract; its bridge transfers are held until governance untrips it`,
        `${a.who} ถูกทำเครื่องหมายโดยตัวเฝ้านี้ (marker ${a.by}) เพราะเรียกสัญญาที่เฝ้าไว้ รายการโอนผ่านสะพานของที่อยู่นี้จะไม่ถูกปล่อยจนกว่า governance จะปลด (untrip)`, { ...at, who: a.who, by: a.by });
      else add('marked', 'critical', `${a.who} marked by marker ${a.by}, not a mark this monitor queued: its bridge transfers are held until governance untrips it (check who holds that marker key)`,
        `${a.who} ถูกทำเครื่องหมายโดย marker ${a.by} ซึ่งไม่ใช่การทำเครื่องหมายของตัวเฝ้านี้ รายการโอนของที่อยู่นี้จะไม่ถูกปล่อยจนกว่า governance จะปลด (ตรวจว่าใครถือ marker key นั้น)`, { ...at, who: a.who, by: a.by });
    }
    if (e.source === 'airlock' && e.name === 'Untripped') {
      // Governance lifted a mark: the monitor does not mark that address again by itself.
      const k = lower(a.who);
      st.marks[k] = { seen: st.marks[k]?.seen ?? e.time, done: st.marks[k]?.done ?? e.time, lifted: e.time };
    }
    if (e.name === 'InboundHeld') add('hold', 'warning', `mint of ${amt(a.amount)} to ${a.to} held (ThreatRegistry flag), id ${a.id}`,
      `การ mint ${amt(a.amount)} ให้ ${a.to} ถูกกัก (ติดธงใน ThreatRegistry) id ${a.id}`, { ...at, to: a.to, amount: a.amount, id: a.id });
    if (e.source === 'threats' && (e.name === 'HeldNow' || e.name === 'FastEnforced')) add('hold', 'warning', `ThreatRegistry ${e.name}: key ${a.key} by ${a.by} (bridge transfers of that party are held)`,
      `ThreatRegistry ${e.name}: key ${a.key} โดย ${a.by} (รายการโอนผ่านสะพานของฝ่ายนั้นถูกกัก)`, { ...at, key: a.key, by: a.by });
    // the timelock: what is scheduled, when it can run, and what ran
    if (e.source === 'timelock') {
      const label = (x) => { const n = c.labels?.[lower(x)]; return n ? `${n} ${x}` : String(x); };
      if (e.name === 'CallScheduled') {
        const fn = callName(a.data);
        const eta = Number(e.time) + Number(a.delay);
        add('timelock-scheduled', CRITICAL_CALLS.has(fn.split('(')[0]) ? 'critical' : 'warning',
          `timelock: call scheduled ${String(a.id).slice(0, 10)}… #${str(a.index)}: ${label(a.target)} ${fn}${BigInt(a.value ?? 0) ? ` value ${str(a.value)}` : ''}, executable after ${new Date(eta * 1000).toISOString()} (cancellable until then)`,
          `timelock: มีการตั้งเวลาเรียก ${String(a.id).slice(0, 10)}… #${str(a.index)}: ${label(a.target)} ${fn}${BigInt(a.value ?? 0) ? ` value ${str(a.value)}` : ''} ทำได้หลัง ${new Date(eta * 1000).toISOString()} (ยกเลิกได้ก่อนเวลานั้น)`,
          { ...at, id: a.id, index: a.index, target: a.target, function: fn, eta, data: a.data });
      }
      if (e.name === 'CallExecuted') add('timelock-executed', 'warning', `timelock: executed ${String(a.id).slice(0, 10)}… #${str(a.index)}: ${label(a.target)} ${callName(a.data)}`,
        `timelock: เรียกแล้ว ${String(a.id).slice(0, 10)}… #${str(a.index)}: ${label(a.target)} ${callName(a.data)}`, { ...at, id: a.id, target: a.target, function: callName(a.data) });
      if (e.name === 'Cancelled') add('timelock-cancelled', 'warning', `timelock: cancelled ${a.id}`, `timelock: ยกเลิก ${a.id}`, { ...at, id: a.id });
      if (e.name === 'MinDelayChange') add('timelock-delay', 'critical', `timelock: delay changed from ${str(a.oldDuration)} s to ${str(a.newDuration)} s`,
        `timelock: เปลี่ยนระยะรอจาก ${str(a.oldDuration)} วินาทีเป็น ${str(a.newDuration)} วินาที`, { ...at, old: a.oldDuration, new: a.newDuration });
    }
    // a gov vote that schedules (or cancels) through the timelock (from the REST API, see govTimelockEvents)
    if (e.source === 'gov' && e.name === 'TimelockProposal') {
      const open = /VOTING|DEPOSIT/.test(a.status);
      const list = a.calls.map((k) => `${k.action} ${k.target ? `${(c.labels?.[lower(k.target)] ? `${c.labels[lower(k.target)]} ` : '')}${k.target} ` : ''}${k.function}${k.delay ? ` (delay ${k.delay} s)` : ''}`).join('; ');
      const critical = a.calls.some((k) => k.action !== 'schedule' || CRITICAL_CALLS.has(String(k.function).split('(')[0]));
      add('timelock-proposal', critical ? 'critical' : 'warning',
        `gov proposal ${a.id} (${a.status}${a.votingEnd ? `, voting ends ${a.votingEnd}` : ''}) ${open ? 'would' : 'did'} call the timelock: ${list}`,
        `ข้อเสนอโหวต ${a.id} (${a.status}${a.votingEnd ? ` ปิดโหวต ${a.votingEnd}` : ''}) ${open ? 'จะ' : 'ได้'}เรียก timelock: ${list}`,
        { proposal: a.id, status: a.status, calls: a.calls }, `govprop:${a.id}:${open ? 'open' : a.status}`);
    }
    // the price oracle
    if (e.source === 'oracle') {
      if (e.name === 'DeviationTripped') add('oracle-deviation', 'critical', `oracle: ${a.asset} has no price: DEX TWAP ${usd(a.twapPrice)} and Pyth ${usd(a.pythPrice)} differ by ${str(a.bps)} bps`,
        `oracle: ${a.asset} ไม่มีราคา: TWAP ของ DEX ${usd(a.twapPrice)} กับ Pyth ${usd(a.pythPrice)} ต่างกัน ${str(a.bps)} bps`, { ...at, asset: a.asset, twap: a.twapPrice, pyth: a.pythPrice, bps: a.bps },
        `oracle-dev:${lower(a.asset)}:${Math.floor(e.time / 3600)}`);
      if (e.name === 'StaleFeed') add('oracle-stale', 'warning', `oracle: ${a.asset}: the ${Number(a.source) === 1 ? 'DEX TWAP' : 'Pyth'} source is stale (last ${new Date(Number(a.updatedAt) * 1000).toISOString()})`,
        `oracle: ${a.asset}: แหล่งราคา ${Number(a.source) === 1 ? 'TWAP ของ DEX' : 'Pyth'} เก่าเกินไป (ล่าสุด ${new Date(Number(a.updatedAt) * 1000).toISOString()})`, { ...at, asset: a.asset, source: a.source },
        `oracle-stale:${lower(a.asset)}:${str(a.source)}:${Math.floor(e.time / 86400)}`);
      if (e.name === 'CircuitBreakerTripped') add('oracle-breaker', 'critical', `oracle: ${a.asset} circuit breaker TRIPPED: ${usd(a.price)} vs ${usd(a.ref)} (${str(a.bps)} bps); no price until governance resets it (timelock)`,
        `oracle: ${a.asset} ตัดวงจรราคาแล้ว: ${usd(a.price)} เทียบกับ ${usd(a.ref)} (${str(a.bps)} bps) ไม่มีราคาจนกว่า governance จะรีเซ็ต (ผ่าน timelock)`, { ...at, asset: a.asset, price: a.price, ref: a.ref, bps: a.bps });
      if (e.name === 'FeedPaused') add('oracle-paused', 'critical', `oracle: feed ${a.asset} PAUSED by ${a.by} (only governance unpauses, through the timelock)`,
        `oracle: ราคา ${a.asset} ถูกหยุดโดย ${a.by} (ต้องให้ governance เปิดคืนผ่าน timelock)`, { ...at, asset: a.asset, by: a.by });
      if (e.name === 'SourceProblem') add('oracle-problem', 'warning', `oracle: ${a.asset}: ${PROBLEMS[Number(a.problem)] ?? a.problem} (${str(a.a)}, ${str(a.b)})`,
        `oracle: ${a.asset}: ${PROBLEMS[Number(a.problem)] ?? a.problem} (${str(a.a)}, ${str(a.b)})`, { ...at, asset: a.asset, problem: PROBLEMS[Number(a.problem)] ?? a.problem },
        `oracle-problem:${lower(a.asset)}:${str(a.problem)}:${Math.floor(e.time / 3600)}`);
    }
    // large single transfer
    if (e.source === 'guard' && (e.name === 'Inbound' || e.name === 'Outbound')) {
      const r = routeById[lower(a.route)];
      const lim = r ? limitOf(r) : 0n;
      if (lim > 0n && BigInt(a.amount) * 100n >= BigInt(c.largePct) * lim) {
        const who = a.to ?? a.from;
        add('large-transfer', 'warning', `large ${e.name.toLowerCase()} ${amt(a.amount)} (${who}): ${(Number(BigInt(a.amount) * 10000n / lim) / 100)}% of the daily limit`,
          `รายการ${e.name === 'Inbound' ? 'เข้า' : 'ออก'}ก้อนใหญ่ ${amt(a.amount)} (${who}): ${(Number(BigInt(a.amount) * 10000n / lim) / 100)}% ของเพดานต่อวัน`, { ...at, amount: a.amount, who });
      }
    }
    // lanes: track every attestation by source deposit
    if (e.source === 'airlock' && e.name === 'Attested') {
      const key = `${str(a.srcChainId)}:${lower(a.srcContract)}:${str(a.srcNonce)}`;
      const t = st.transfers[key] ??= { ids: {}, first: e.time, released: false, vetoed: false };
      const rec = t.ids[lower(a.id)] ??= { lanes: [], first: e.time, details: { sender: a.sender, to: a.to, amount: str(a.amount) }, readyAt: null };
      if (!rec.lanes.includes(lower(a.lane))) rec.lanes.push(lower(a.lane));
      if (Number(a.count) >= Number(snapshot.threshold ?? 2) && rec.readyAt == null) rec.readyAt = e.time + Number(snapshot.quarantine ?? 0);
      if (Object.keys(t.ids).length > 1) {
        add('lanes-disagree', 'critical', `lanes disagree on deposit ${key}: ${Object.entries(t.ids).map(([i, r]) => `${i.slice(0, 10)}… by ${r.lanes.join('+')} (to ${r.details.to}, ${amt(r.details.amount)})`).join(' vs ')}`,
          `bridge lane ไม่ตรงกันสำหรับการฝาก ${key}: ${Object.entries(t.ids).map(([i, r]) => `${i.slice(0, 10)}… จาก ${r.lanes.join('+')} (ถึง ${r.details.to}, ${amt(r.details.amount)})`).join(' กับ ')}`,
          { ...at, deposit: key, ids: Object.keys(t.ids) }, `disagree:${key}:${Object.keys(t.ids).length}`);
      }
    }
    if (e.source === 'airlock' && (e.name === 'Released' || e.name === 'Vetoed')) {
      for (const t of Object.values(st.transfers)) if (t.ids[lower(a.id)]) t[e.name === 'Released' ? 'released' : 'vetoed'] = true;
    }
    if (e.source === 'lockbox') {
      const key = `${str(a.chainId)}:${lower(a.contract)}:${str(a.nonce)}`;
      st.locks[key] ??= { time: e.time, to: a.to, amount: str(a.amount) };
    }
  }

  // watched contracts: one alert per caller of this scan; the watched address is never named
  for (const [who, n] of hits) {
    const logs = n > 1 ? ` (${n} logs)` : '';
    if (!who) {
      add('watch-hit', 'critical', `a watched contract logged ${n} event(s) without an address in its caller topic: nothing marked (check callerTopic in the watch list)`,
        `สัญญาที่เฝ้าไว้ส่ง event ${n} รายการที่ไม่มีที่อยู่ในตำแหน่ง topic ของผู้เรียก: ไม่ได้ทำเครื่องหมายใคร (ตรวจ callerTopic ใน watch list)`, { caller: null, logs: n, status: 'no-caller' });
      continue;
    }
    const m = st.marks[lower(who)];
    const [status, en, th] = !marker ? ['alert-only', 'not marked (no marker key: alert only)', 'ไม่ได้ทำเครื่องหมาย (ไม่มี marker key: แจ้งเตือนอย่างเดียว)']
      : m?.lifted != null ? ['lifted', 'not marked again: governance lifted its earlier mark (a person decides)', 'ไม่ทำเครื่องหมายซ้ำ: governance เคยปลดเครื่องหมายของที่อยู่นี้แล้ว (ให้คนตัดสิน)']
      : m?.done != null ? ['marked', 'already marked', 'ถูกทำเครื่องหมายไว้แล้ว']
      : ['queued', 'queued: the monitor marks it now (BridgeAirlock.trip)', 'เข้าคิว: ตัวเฝ้าทำเครื่องหมายตอนนี้ (BridgeAirlock.trip)'];
    add('watch-hit', 'critical', `a watched contract was called by ${who}${logs}: ${en}`, `มีการเรียกสัญญาที่เฝ้าไว้โดย ${who}${logs}: ${th}`, { caller: who, logs: n, status });
  }

  // oracle feeds that give no price right now (price() reverted), once a day per feed and reason
  for (const f of snapshot.oracleFeeds ?? []) {
    if (f.ok) continue;
    const why = String(f.error ?? 'error');
    const rule = /Stale/.test(why) ? 'oracle-stale' : /BreakerTripped/.test(why) ? 'oracle-breaker' : /FeedIsPaused/.test(why) ? 'oracle-paused' : 'oracle-unavailable';
    add(rule, rule === 'oracle-unavailable' || rule === 'oracle-stale' ? 'warning' : 'critical', `oracle: ${f.asset} has no price now (price() reverts ${why})`,
      `oracle: ${f.asset} ไม่มีราคาตอนนี้ (price() ปฏิเสธ: ${why})`, { asset: f.asset, error: why }, `oracle-now:${lower(f.asset)}:${why}:${Math.floor(now / 86400)}`);
  }

  // volume over X% of the daily limit (on-chain counters of today)
  const today = Math.floor(now / 86400);
  for (const r of snapshot.routes ?? []) {
    const lim = limitOf(r);
    if (lim === 0n || Number(r.day) !== today) continue;
    for (const [dir, used] of [['in', BigInt(r.inToday)], ['out', BigInt(r.outToday)]]) {
      const pct = Number((used * 10000n) / lim) / 100;
      if (pct < c.volumePct) continue;
      const full = pct >= 100;
      add('volume', full ? 'critical' : 'warning', `route ${r.id} ${dir}bound volume ${amt(used)} = ${pct}% of the daily limit ${amt(lim)}${full ? ' (limit reached)' : ''}`,
        `เส้นทาง ${r.id} ยอด${dir === 'in' ? 'เข้า' : 'ออก'}วันนี้ ${amt(used)} = ${pct}% ของเพดาน ${amt(lim)}${full ? ' (เต็มเพดานแล้ว)' : ''}`,
        { route: r.id, dir, used, limit: lim, pct }, `volume:${lower(r.id)}:${dir}:${today}:${full ? 100 : c.volumePct}`);
    }
  }

  // lanes that did not follow, transfers ready but not released
  for (const [key, t] of Object.entries(st.transfers)) {
    if (t.released || t.vetoed) continue;
    for (const [id, rec] of Object.entries(t.ids)) {
      const missing = lanesNow.filter((l) => !rec.lanes.includes(l));
      if (missing.length && now - rec.first >= c.disagreeMinutes * 60) {
        add('lane-missing', 'warning', `transfer ${id} (deposit ${key}) attested by ${rec.lanes.join(', ')} only; ${missing.join(', ')} silent for ${Math.round((now - rec.first) / 60)} min`,
          `รายการ ${id} (การฝาก ${key}) มีแค่ ${rec.lanes.join(', ')} ยืนยัน; ${missing.join(', ')} เงียบมา ${Math.round((now - rec.first) / 60)} นาที`,
          { id, deposit: key, attestedBy: rec.lanes, missing }, `missing:${id}`);
      }
      if (rec.readyAt != null && now - rec.readyAt >= c.silentMinutes * 60) {
        add('release-stalled', 'warning', `transfer ${id} ready since ${new Date(rec.readyAt * 1000).toISOString()} but not released (relayer silent, or held by a flag / limit)`,
          `รายการ ${id} พร้อมปล่อยตั้งแต่ ${new Date(rec.readyAt * 1000).toISOString()} แต่ยังไม่ถูกปล่อย (relayer เงียบ หรือถูกกักด้วยธง/เพดาน)`, { id, readyAt: rec.readyAt }, `stalled:${id}`);
      }
    }
  }
  // source deposits no lane attested
  for (const [key, l] of Object.entries(st.locks)) {
    const t = st.transfers[key];
    const by = t ? [...new Set(Object.values(t.ids).flatMap((r) => r.lanes))] : [];
    const silent = lanesNow.filter((x) => !by.includes(x));
    if (silent.length && now - l.time >= c.silentMinutes * 60) {
      add('lane-silent', by.length ? 'warning' : 'critical', `deposit ${key} (${amt(l.amount)} to ${l.to}) locked ${Math.round((now - l.time) / 60)} min ago; no attestation from ${silent.join(', ')}`,
        `มีการฝาก ${key} (${amt(l.amount)} ถึง ${l.to}) ล็อกไว้ ${Math.round((now - l.time) / 60)} นาทีแล้ว แต่ยังไม่มีการยืนยันจาก ${silent.join(', ')}`,
        { deposit: key, silent }, `silent:${key}:${silent.length}`);
    }
    if (!silent.length || (t && (t.released || t.vetoed))) delete st.locks[key];
  }
  // forget what is finished or older than a week
  for (const [key, t] of Object.entries(st.transfers)) if ((t.released || t.vetoed) || now - t.first > 7 * 86400) delete st.transfers[key];
  for (const [k, at] of Object.entries(st.alerted)) if (now - at > 8 * 86400) delete st.alerted[k];
  for (const [k, l] of Object.entries(st.locks)) if (now - l.time > 7 * 86400) delete st.locks[k];
  for (const [k, m] of Object.entries(st.marks)) { const last = m.lifted ?? m.done; if (last != null && now - last > 90 * 86400) delete st.marks[k]; }
  return { alerts, state: st };
}

/** A report: JSON-ready, with an English and a Thai summary. */
export function report({ alerts, chainId, fromBlock, toBlock, addresses, snapshot, now, marking = null }) {
  const crit = alerts.filter((x) => x.severity === 'critical').length;
  const mEn = marking ? ` Marked this run: ${marking.marked}; marks pending: ${marking.pending}.` : '';
  const mTh = marking ? ` ทำเครื่องหมายรอบนี้ ${marking.marked} รายการ ค้าง ${marking.pending} รายการ` : '';
  const en = alerts.length === 0 ? `ZETAPHY bridge monitor: no alerts (blocks ${fromBlock}–${toBlock}).${mEn}`
    : [`ZETAPHY bridge monitor: ${alerts.length} alert(s), ${crit} critical (blocks ${fromBlock}–${toBlock}).${mEn}`, ...alerts.map((x) => `- [${x.severity}] ${x.rule}: ${x.en}`)].join('\n');
  const th = alerts.length === 0 ? `ตัวเฝ้าสะพาน ZETAPHY: ไม่มีสัญญาณเตือน (บล็อก ${fromBlock}–${toBlock})${mTh}`
    : [`ตัวเฝ้าสะพาน ZETAPHY: มีสัญญาณเตือน ${alerts.length} รายการ ร้ายแรง ${crit} รายการ (บล็อก ${fromBlock}–${toBlock})${mTh}`, ...alerts.map((x) => `- [${x.severity}] ${x.rule}: ${x.th}`)].join('\n');
  return plain({ format: 'zetaphy-bridge-monitor/1', generatedAt: new Date(now * 1000).toISOString(), chainId, fromBlock, toBlock, addresses,
    snapshot: snapshot && { paused: snapshot.paused, maxDailyLimit: snapshot.maxDailyLimit, threshold: snapshot.threshold, lanes: snapshot.lanes, routes: snapshot.routes,
      ...(snapshot.oracleFeeds ? { oracleFeeds: snapshot.oracleFeeds } : {}) },
    ...(marking ? { marking } : {}), alerts, summary: { en, th } });
}

/** One line of counts only, for a public log: no address, no alert text. */
export function countsLine(rep) {
  const alerts = rep.alerts ?? [];
  const crit = alerts.filter((x) => x.severity === 'critical').length;
  const m = rep.marking ? `; marked ${rep.marking.marked}, pending ${rep.marking.pending}` : '';
  return `bridge monitor: ${alerts.length} alert(s), ${crit} critical (blocks ${rep.fromBlock}–${rep.toBlock})${m}`;
}

/** The body of a bridge-alert issue (in a private repository, or this one if its owner turned that on). */
export function issueText(rep, { runUrl = '' } = {}) {
  const json = JSON.stringify(rep, null, 2);
  return [rep.summary.th, '', rep.summary.en, '', `Last scanned block: ${rep.toBlock}${runUrl ? ` · run: ${runUrl}` : ''}`, '',
    '<details><summary>report.json</summary>', '', '```json', json.length > 50000 ? `${json.slice(0, 50000)}\n…` : json, '```', '</details>', ''].join('\n');
}

// ---- private settings: thresholds, watch list, marker key (environment / repository secrets) ----

export const THRESHOLD_KEYS = ['volumePct', 'largePct', 'silentMinutes', 'disagreeMinutes'];

/**
 * BRIDGE_MONITOR_THRESHOLDS: a JSON object over the committed defaults, e.g. {"volumePct": 60}.
 * Errors never quote the value (it is a secret).
 */
export function parseThresholds(text) {
  if (text == null || String(text).trim() === '') return {};
  let v;
  try { v = JSON.parse(String(text)); } catch { throw new Error('BRIDGE_MONITOR_THRESHOLDS is not valid JSON (expected e.g. {"volumePct": 60, "largePct": 20})'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('BRIDGE_MONITOR_THRESHOLDS must be a JSON object');
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!THRESHOLD_KEYS.includes(k)) throw new Error(`BRIDGE_MONITOR_THRESHOLDS: a key that is not one of ${THRESHOLD_KEYS.join(', ')}`);
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) throw new Error(`BRIDGE_MONITOR_THRESHOLDS: ${k} must be a positive number`);
    out[k] = x;
  }
  return out;
}

/**
 * BRIDGE_WATCHLIST: a JSON array of {address, callerTopic?} (callerTopic 1-3, default 1: the first
 * indexed topic holds the caller). Read from the environment only. Errors name an entry's position,
 * never its content. Returns [{address (lower case), callerTopic}], without duplicates.
 */
export function parseWatchlist(text) {
  if (text == null || String(text).trim() === '') return [];
  let v;
  try { v = JSON.parse(String(text)); } catch { throw new Error('BRIDGE_WATCHLIST is not valid JSON (expected [{"address": "0x…", "callerTopic": 1}])'); }
  if (!Array.isArray(v)) throw new Error('BRIDGE_WATCHLIST must be a JSON array of {address, callerTopic?}');
  const seen = new Map();
  v.forEach((e, i) => {
    const ok = e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every((k) => k === 'address' || k === 'callerTopic')
      && typeof e.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.address) && !/^0x0{40}$/.test(e.address)
      && (e.callerTopic === undefined || [1, 2, 3].includes(e.callerTopic));
    if (!ok) throw new Error(`BRIDGE_WATCHLIST entry #${i + 1} is not {"address": "0x" + 40 hex (not zero), "callerTopic": 1, 2 or 3 (optional)}`);
    seen.set(lower(e.address), e.callerTopic ?? 1);
  });
  return [...seen].map(([address, callerTopic]) => ({ address, callerTopic }));
}

/** BRIDGE_MARKER_KEY: a private key (0x + 64 hex), or null. Never echoed. */
export function markerKeyOf(env = {}) {
  const k = String(env.BRIDGE_MARKER_KEY ?? '').trim();
  if (!k) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw new Error('BRIDGE_MARKER_KEY does not hold a private key (0x + 64 hex digits)');
  return k.startsWith('0x') ? k : `0x${k}`;
}

// ---- the saved state: encrypted when private settings exist ----

const STATE_ENC = 'zetaphy-bridge-monitor-state/aes-256-gcm';

/**
 * The key that encrypts the saved state, derived from the monitor's private settings (BRIDGE_MARKER_KEY,
 * BRIDGE_WATCHLIST, BRIDGE_MONITOR_THRESHOLDS): a state file in a public place (a workflow artifact)
 * then shows nothing of what the monitor saw, queued or alerted. None set: null (plain JSON; everything
 * in it is then derived from public chain data and the committed thresholds). Changing one of these
 * secrets makes the old memory unreadable: the monitor continues from the last scanned block (kept in
 * clear) with a fresh memory (see openState).
 */
export function stateKeyOf(env = {}) {
  const parts = ['BRIDGE_MARKER_KEY', 'BRIDGE_WATCHLIST', 'BRIDGE_MONITOR_THRESHOLDS'].map((k) => String(env[k] ?? '').trim());
  if (parts.every((x) => !x)) return null;
  return createHash('sha256').update(`zetaphy-bridge-monitor/state-key/1\n${parts.join('\n')}`).digest();
}

/**
 * The state as saved: AES-256-GCM with stateKeyOf's key, or as is without one. The scan position
 * (lastBlock, sourceBlocks: block numbers, nothing private) stays in clear, so a change of secrets
 * costs the monitor its memory, not a rescan.
 */
export function sealState(state, key) {
  const json = JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (!key) return JSON.parse(json);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return { format: STATE_ENC, lastBlock: state.lastBlock ?? null, sourceBlocks: state.sourceBlocks ?? {},
    iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('base64') };
}

/**
 * { state, note? }: the saved state opened. When it cannot be (no key, or one from other secrets):
 * a fresh state that continues from the saved scan position, and a note saying so.
 */
export function openState(saved, key) {
  if (saved == null) return { state: null };
  if (saved.format !== STATE_ENC) return { state: saved };
  const resume = () => ({ ...newState(), lastBlock: Number.isInteger(saved.lastBlock) ? saved.lastBlock : null,
    sourceBlocks: saved.sourceBlocks && typeof saved.sourceBlocks === 'object' ? saved.sourceBlocks : {} });
  const fresh = 'continuing from its last scanned block with a fresh memory (alerts already sent may repeat once)';
  if (!key) return { state: resume(), note: `the saved state is encrypted and no monitor secret is set: ${fresh}` };
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'hex'));
    d.setAuthTag(Buffer.from(saved.tag, 'hex'));
    return { state: JSON.parse(Buffer.concat([d.update(Buffer.from(saved.data, 'base64')), d.final()]).toString('utf8')) };
  } catch { return { state: resume(), note: `the saved state was written with other monitor secrets: ${fresh}` }; }
}

/**
 * Marks every caller the state has queued (watch-hit with a marker key): BridgeAirlock.trip(caller),
 * sent with the marker key (`airlock` connected to it, `marker` its address). A caller already
 * tripped on-chain is only recorded. A failure stays queued for the next run; its reason is the
 * error's code or revert name only. Returns { alerts, marked, pending } and updates state.marks.
 */
export async function applyMarks({ airlock, marker, state, now, codeAt }) {
  const alerts = [];
  state.marks ??= {};
  state.alerted ??= {};
  const once = (k) => { if (state.alerted[k]) return false; state.alerted[k] = now; return true; };
  const queued = Object.entries(state.marks).filter(([, m]) => m.done == null && m.lifted == null);
  if (!queued.length) return { alerts, marked: 0, pending: 0 };
  const why = (e) => String(e?.revert?.name ?? e?.code ?? 'error').replace(/[^\w-]/g, '').slice(0, 40);
  let isMarker = false;
  try { isMarker = await airlock.isMarker(marker); } catch (e) {
    alerts.push({ rule: 'mark-failed', severity: 'critical', en: `could not read the airlock's markers (${why(e)}): ${queued.length} caller(s) not marked yet, retried next run`,
      th: `อ่านรายชื่อ marker ของ airlock ไม่ได้ (${why(e)}): ยังไม่ได้ทำเครื่องหมาย ${queued.length} ที่อยู่ จะลองใหม่รอบหน้า`, data: { pending: queued.length } });
    return { alerts, marked: 0, pending: queued.length };
  }
  if (!isMarker) {
    if (once(`notmarker:${Math.floor(now / 86400)}`)) {
      alerts.push({ rule: 'mark-failed', severity: 'critical', en: `the monitor's key ${marker} is not a marker of the airlock (governance: setMarker): ${queued.length} caller(s) not marked yet`,
        th: `key ของตัวเฝ้า ${marker} ไม่ได้เป็น marker ของ airlock (governance ต้อง setMarker): ยังไม่ได้ทำเครื่องหมาย ${queued.length} ที่อยู่`, data: { marker, pending: queued.length } });
    }
    return { alerts, marked: 0, pending: queued.length };
  }
  let marked = 0, pending = 0;
  for (const [k, m] of queued) {
    const who = getAddress(k);
    try {
      // A caller with code (Multicall, a forwarder, the ERC-4337 EntryPoint, a
      // router) is shared by many people: marking it would freeze everyone's
      // bridge transfers through it. Alert only; a person decides.
      if (codeAt && (await codeAt(who)) !== '0x') {
        m.lifted = now;
        alerts.push({ rule: 'mark-skipped', severity: 'warning', en: `${who} touched a watched contract but is itself a contract (it may be shared by many people): not marked automatically; governance can mark it by hand`,
          th: `${who} เรียกสัญญาที่เฝ้าอยู่ แต่ตัวมันเป็นสัญญา (อาจมีคนใช้ร่วมกันมาก) จึงไม่ทำเครื่องหมายอัตโนมัติ ให้คนตัดสินใจ`, data: { who } });
        continue;
      }
      if (!(await airlock.tripped(who))) { await (await airlock.trip(who)).wait(); marked += 1; }
      m.done = now;
    } catch (e) {
      m.tries = (m.tries ?? 0) + 1;
      pending += 1;
      if (once(`markfail:${k}`)) {
        alerts.push({ rule: 'mark-failed', severity: 'critical', en: `could not mark ${who} (${why(e)}): retried every run until it works`,
          th: `ทำเครื่องหมาย ${who} ไม่สำเร็จ (${why(e)}): จะลองใหม่ทุกรอบจนสำเร็จ`, data: { who, reason: why(e) } });
      }
    }
  }
  return { alerts, marked, pending };
}

/**
 * Bridge addresses for the monitor: a monitor config (rpc, bridgeGuard, bridgeAirlock, startBlock,
 * thresholds, sources), filled from the launch state's outputs where missing. Both may be absent.
 */
export function loadMonitorConfig({ configFile, launchStateFile } = {}) {
  const cfg = configFile && existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  if (launchStateFile && existsSync(launchStateFile)) {
    const st = JSON.parse(readFileSync(launchStateFile, 'utf8'));
    const out = Object.assign({}, ...Object.values(st.steps ?? {}).map((s) => s.out ?? {}));
    cfg.bridgeGuard ??= out.bridgeGuard ?? null;
    cfg.bridgeAirlock ??= out.bridgeAirlock ?? null;
    cfg.timelock ??= out.timelock ?? null;
    cfg.oracle ??= out.oracle ?? null;
    cfg.timelockBlock ??= out.timelockBlock ?? null;
    // names for addresses in alerts (timelock targets)
    cfg.labels ??= {};
    for (const [k, v] of Object.entries(out)) if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) cfg.labels[v.toLowerCase()] ??= k;
    if (out.dex?.contracts?.factory) cfg.labels[out.dex.contracts.factory.toLowerCase()] ??= 'dexFactory';
    if (out.nft?.marketplace) cfg.labels[out.nft.marketplace.toLowerCase()] ??= 'nftMarketplace';
  }
  return cfg;
}

/**
 * Gov proposals (the JSON of GET /cosmos/gov/v1/proposals) whose MsgEVMCall goes to the timelock, as monitor
 * events (source 'gov'). Pure. Field names: the node prints MsgEVMCall with its Go names (To, Data) or
 * protobuf ones (to, data); Data is base64.
 */
export function govTimelockEvents(json, timelock, now) {
  const out = [];
  for (const p of json?.proposals ?? []) {
    const calls = [];
    for (const m of p.messages ?? []) {
      if (!/MsgEVMCall$/.test(String(m['@type'] ?? ''))) continue;
      const to = m.To ?? m.to;
      if (to == null) { calls.push({ action: 'evm-call', function: '(its fields could not be read: zetaphyd q gov proposal ' + p.id + ')' }); continue; }
      if (lower(to) !== lower(timelock)) continue;
      let data;
      try { data = `0x${Buffer.from(String(m.Data ?? m.data ?? ''), 'base64').toString('hex')}`; } catch { continue; }
      let tx = null;
      try { tx = TIMELOCK.parseTransaction({ data }); } catch { /* not a timelock call */ }
      if (!tx) { calls.push({ action: 'call', function: callName(data) }); continue; }
      if (tx.name === 'schedule') calls.push({ action: 'schedule', target: getAddress(tx.args[0]), function: callName(tx.args[2]), delay: Number(tx.args[5]) });
      else if (tx.name === 'scheduleBatch') tx.args[0].forEach((t, i) => calls.push({ action: 'schedule', target: getAddress(t), function: callName(tx.args[2][i]), delay: Number(tx.args[5]) }));
      else calls.push({ action: tx.name, function: tx.fragment.format('sighash') });
    }
    if (!calls.length) continue;
    const status = String(p.status ?? '').replace(/^PROPOSAL_STATUS_/, '');
    out.push({ source: 'gov', address: getAddress(timelock), name: 'TimelockProposal', block: 0, time: now,
      args: { id: String(p.id), status, votingEnd: p.voting_end_time ?? null, calls } });
  }
  return out;
}

// ---- MsgEVMCall's fields: the REST API prints the message without them (its JSON marshaller does not know the
// hand-written type), so they are read as protobuf through CometBFT's abci_query (/cosmos.gov.v1.Query/Proposal).

/** A minimal protobuf reader: [{ field, wire, value }] (varint as BigInt, length-delimited as bytes). */
export function protoFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => { let r = 0n, sh = 0n; for (;;) { if (i >= buf.length) throw new Error('protobuf: truncated'); const b = buf[i++]; r |= BigInt(b & 0x7f) << sh; if (!(b & 0x80)) return r; sh += 7n; if (sh > 63n) throw new Error('protobuf: varint too long'); } };
  while (i < buf.length) {
    const k = Number(varint());
    const field = k >>> 3, wire = k & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) { const n = Number(varint()); if (i + n > buf.length) throw new Error('protobuf: truncated'); out.push({ field, wire, value: buf.subarray(i, i + n) }); i += n; }
    else if (wire === 1) { i += 8; } else if (wire === 5) { i += 4; } else throw new Error(`protobuf: wire type ${wire}`);
  }
  return out;
}

/** QueryProposalResponse bytes → the proposal's messages [{ typeUrl, to?, data? }] (to/data for a MsgEVMCall). */
export function proposalMessages(bytes) {
  const text = (b) => Buffer.from(b).toString('utf8');
  const proposal = protoFields(bytes).find((f) => f.field === 1 && f.wire === 2);
  if (!proposal) return [];
  return protoFields(proposal.value).filter((f) => f.field === 2 && f.wire === 2).map((any) => {
    const a = protoFields(any.value);
    const typeUrl = text(a.find((f) => f.field === 1)?.value ?? []);
    const value = a.find((f) => f.field === 2)?.value;
    if (!/MsgEVMCall$/.test(typeUrl) || !value) return { typeUrl };
    const m = protoFields(value);
    const to = m.find((f) => f.field === 2 && f.wire === 2);
    const data = m.find((f) => f.field === 4 && f.wire === 2);
    return { typeUrl, to: to ? text(to.value) : '', data: `0x${Buffer.from(data?.value ?? []).toString('hex')}` };
  });
}

/** Fills in MsgEVMCall's To/Data of REST proposals from CometBFT (abci_query); proposals without such messages are left alone. */
export async function fillEvmCalls(json, cometRpc, { fetchFn = fetch } = {}) {
  for (const p of json?.proposals ?? []) {
    if (!(p.messages ?? []).some((m) => /MsgEVMCall$/.test(String(m['@type'] ?? '')) && (m.To ?? m.to) == null)) continue;
    let id = BigInt(p.id), req = [];
    req.push(0x08); // field 1 (proposal_id), varint
    do { let b = Number(id & 0x7fn); id >>= 7n; if (id) b |= 0x80; req.push(b); } while (id);
    const u = new URL(`${String(cometRpc).replace(/\/+$/, '')}/abci_query`);
    u.searchParams.set('path', '"/cosmos.gov.v1.Query/Proposal"');
    u.searchParams.set('data', `0x${Buffer.from(req).toString('hex')}`);
    const r = await fetchFn(u.href);
    if (!r.ok) throw new Error(`abci_query: HTTP ${r.status}`);
    const v = (await r.json())?.result?.response?.value;
    if (!v) continue;
    const msgs = proposalMessages(Buffer.from(v, 'base64'));
    p.messages = p.messages.map((m, i) => (msgs[i]?.to != null ? { ...m, To: msgs[i].to, Data: Buffer.from(msgs[i].data.slice(2), 'hex').toString('base64') } : m));
  }
  return json;
}

/** The node's open and recent gov proposals (Cosmos REST; on the testnet https://<host>/rest). */
export async function readGovProposals(restBase, { fetchFn = fetch } = {}) {
  const u = new URL(`${String(restBase).replace(/\/+$/, '')}/cosmos/gov/v1/proposals`);
  u.searchParams.set('pagination.limit', '50');
  u.searchParams.set('pagination.reverse', 'true');
  const r = await fetchFn(u.href);
  if (!r.ok) throw new Error(`gov proposals: HTTP ${r.status}`);
  return r.json();
}

/** Each oracle asset: does price() answer now? [{ asset, ok, value?, error? }] */
export async function oracleFeedsOf(oracle) {
  const out = [];
  for (const asset of await oracle.assets()) {
    try { const [value] = await oracle.price(asset); out.push({ asset: getAddress(asset), ok: true, value }); } catch (e) {
      out.push({ asset: getAddress(asset), ok: false, error: e?.revert?.name ?? String(e?.code ?? 'error').replace(/[^\w-]/g, '') });
    }
  }
  return out;
}

/** Reads a snapshot of the bridge's state. */
export async function snapshotOf({ guard, airlock, token, routeIds = [] }) {
  const ids = [...new Set([String(await airlock.route()).toLowerCase(), ...routeIds.map(lower)])];
  const routes = [];
  for (const id of ids) {
    const r = await guard.routes(id);
    routes.push({ id, adapter: r.adapter, dailyLimit: r.dailyLimit, inToday: r.inToday, outToday: r.outToday, day: r.day, enabled: r.enabled });
  }
  let decimals = 18, symbol = '';
  if (token) { try { decimals = Number(await token.decimals()); symbol = await token.symbol(); } catch { /* keep defaults */ } }
  return {
    paused: await guard.paused(), maxDailyLimit: await guard.maxDailyLimit(), decimals, symbol,
    threshold: Number(await airlock.threshold()), quarantine: Number(await airlock.quarantine()),
    lanes: (await airlock.lanes()).map((x) => getAddress(x)), airlockRoute: ids[0], routes,
    threats: await airlock.threats(),
  };
}

/** The caller in a log topic (a 32-byte word holding a nonzero address), or null. */
export function callerOf(topics, i) {
  const t = String(topics?.[i] ?? '');
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(t) && !/^0x0{64}$/.test(t) ? getAddress(`0x${t.slice(26)}`) : null;
}

/**
 * Reads logs of `sources` ([{source, address}]) in [from, to], chunked, decoded with IFACES,
 * each with its block time. getLogs(filter) and getBlock(n) are the provider's.
 * `watch` ([{address, callerTopic}], parseWatchlist): a log of a watched contract becomes
 * { source: 'watch', name: 'Hit', args: { caller }, block, time } and nothing else, so its
 * address, tx and data go no further. With a watch list, a getLogs error is reduced to its code
 * (an ethers error quotes the request, which names the watched contracts).
 */
export async function readEvents(provider, sources, from, to, { chunk = DEFAULTS.chunk, watch = [] } = {}) {
  const byAddr = new Map(sources.filter((s) => s.address && !/^0x0{40}$/i.test(s.address)).map((s) => [lower(s.address), s.source]));
  const watched = new Map(watch.map((w) => [lower(w.address), w.callerTopic ?? 1]));
  for (const k of watched.keys()) if (byAddr.has(k)) throw new Error('BRIDGE_WATCHLIST names one of the bridge\'s own contracts (BridgeGuard, BridgeAirlock, a lane or a registry): watch other contracts');
  if ((!byAddr.size && !watched.size) || to < from) return [];
  const out = [];
  const times = new Map();
  // With a watch list, a getBlock error is reduced to its code too: it quotes the block number,
  // which can be the block of a watched contract's log (and so point to it).
  const timeOf = async (n) => {
    if (!times.has(n)) {
      let b;
      try { b = await provider.getBlock(n); } catch (e) {
        if (!watched.size) throw e;
        throw new Error(`reading a block's time failed (${String(e?.code ?? 'error').replace(/[^\w-]/g, '')}; details withheld: the block may point to a watched contract)`);
      }
      times.set(n, Number(b.timestamp));
    }
    return times.get(n);
  };
  for (let a = from; a <= to; a += chunk) {
    const b = Math.min(a + chunk - 1, to);
    let logs;
    try {
      logs = await provider.getLogs({ address: [...byAddr.keys(), ...watched.keys()].map((x) => getAddress(x)), fromBlock: a, toBlock: b });
    } catch (e) {
      if (!watched.size) throw e;
      throw new Error(`reading logs of blocks ${a}–${b} failed (${String(e?.code ?? 'error').replace(/[^\w-]/g, '')}; details withheld: the request names watched contracts)`);
    }
    for (const l of logs) {
      const wt = watched.get(lower(l.address));
      if (wt != null) {
        out.push({ source: 'watch', name: 'Hit', args: { caller: callerOf(l.topics, wt) }, block: l.blockNumber, time: await timeOf(l.blockNumber) });
        continue;
      }
      const source = byAddr.get(lower(l.address));
      let parsed = null;
      try { parsed = IFACES[source]?.parseLog({ topics: l.topics, data: l.data }); } catch { /* not ours */ }
      if (!parsed) continue;
      const args = {};
      parsed.fragment.inputs.forEach((inp, i) => { args[inp.name] = parsed.args[i]; });
      out.push({ source, address: getAddress(l.address), name: parsed.name, args, block: l.blockNumber, time: await timeOf(l.blockNumber), tx: l.transactionHash });
    }
  }
  return out;
}

/** Locked events of a source LockBox, as monitor events (source 'lockbox'). */
export async function readLocks(provider, lockbox, from, to, { chunk = DEFAULTS.chunk } = {}) {
  const chainId = (await provider.getNetwork()).chainId;
  const evs = await readEvents(provider, [{ source: 'lockbox', address: lockbox }], from, to, { chunk });
  return evs.filter((e) => e.name === 'Locked').map((e) => ({ ...e, args: { ...e.args, chainId, contract: getAddress(lockbox) } }));
}
