// Bridge monitor (zetaphy bridge monitor, .github/workflows/bridge-monitor.yml).
// Reads the chain only (no key): events of BridgeGuard, BridgeAirlock, its lanes
// (NeuroLane, HyperlaneLane) and the ThreatRegistry, plus a snapshot of their
// state, and raises alerts:
//   volume            daily volume of a route over volumePct % of its limit
//   lanes-disagree    two attestations for one source deposit (same chain, contract,
//                     nonce) with different details
//   lane-missing      one lane attested a transfer, another did not within disagreeMinutes
//   veto | pause | decoy-hit | hold
//   governance-change limits, lanes, roles, audit, threats registry, unpause...
//   large-transfer    one transfer of largePct % of the route's limit or more
//   lane-silent       a source deposit (with --source-rpc) no lane attested within silentMinutes
//   release-stalled   a transfer ready (lanes + quarantine) but not released within silentMinutes
// evaluate() is pure (unit-tested); scan() does the reading. State (the last
// scanned block, open transfers, alerts already sent) is kept by the caller.

import { Interface, formatUnits, getAddress } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';

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
};

const GOVERNANCE_EVENTS = {
  guard: ['RouteSet', 'GuardianSet', 'GovernanceSet', 'ThreatsSet', 'AuditSet', 'MaxDailyLimitProposed', 'MaxDailyLimitSet', 'MaxDailyLimitCancelled', 'Unpaused', 'HeldDropped'],
  airlock: ['LaneSet', 'VetoerSet', 'DecoySet', 'ThreatsSet', 'GovernanceSet', 'ThresholdSet', 'QuarantineSet', 'Untripped'],
  hyperlaneLane: ['ConfigSet', 'IsmSet', 'GovernanceSet'],
  threats: ['GovernanceSet'],
};

export function newState() {
  return { version: 1, lastBlock: null, routes: [], transfers: {}, locks: {}, sourceBlocks: {}, alerted: {} };
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

  for (const e of events) {
    const a = e.args ?? {};
    const where = `${e.source} ${e.address}`;
    const at = { block: e.block, tx: e.tx };
    // governance changes
    if ((GOVERNANCE_EVENTS[e.source] ?? []).includes(e.name)) {
      const detail = Object.entries(a).map(([k, v]) => `${k}=${str(v)}`).join(', ');
      add('governance-change', e.name === 'MaxDailyLimitProposed' || e.name === 'LaneSet' || e.name === 'ConfigSet' || e.name === 'GovernanceSet' ? 'critical' : 'warning',
        `governance change: ${where} ${e.name}(${detail})`,
        `มีการเปลี่ยนค่าโดย governance: ${where} ${e.name}(${detail})`, { ...at, event: e.name, args: a });
      if (e.source === 'guard' && e.name === 'RouteSet' && !st.routes.some((r) => lower(r) === lower(a.id))) st.routes.push(a.id);
    }
    if (e.name === 'Paused') add('pause', 'critical', `bridge PAUSED by ${a.by} (only governance can unpause)`, `สะพานถูกหยุด (pause) โดย ${a.by} (ต้องให้ governance เปิดคืน)`, { ...at, by: a.by });
    if (e.name === 'Vetoed') add('veto', 'critical', `transfer ${a.id} vetoed by ${a.by}: ${a.reason}`, `รายการโอน ${a.id} ถูก veto โดย ${a.by}: ${a.reason}`, { ...at, id: a.id, by: a.by, reason: a.reason });
    if (e.name === 'Tripped') add('decoy-hit', 'critical', `decoy bridge ${a.decoy} poked by ${a.who}: that address is marked, its transfers never come out`,
      `มีคนแตะสะพานล่อ (decoy) ${a.decoy}: ${a.who} ถูกทำเครื่องหมาย รายการของที่อยู่นี้จะไม่ถูกปล่อย`, { ...at, who: a.who, decoy: a.decoy });
    if (e.name === 'InboundHeld') add('hold', 'warning', `mint of ${amt(a.amount)} to ${a.to} held (ThreatRegistry flag), id ${a.id}`,
      `การ mint ${amt(a.amount)} ให้ ${a.to} ถูกกัก (ติดธงใน ThreatRegistry) id ${a.id}`, { ...at, to: a.to, amount: a.amount, id: a.id });
    if (e.source === 'threats' && (e.name === 'HeldNow' || e.name === 'FastEnforced')) add('hold', 'warning', `ThreatRegistry ${e.name}: key ${a.key} by ${a.by} (bridge transfers of that party are held)`,
      `ThreatRegistry ${e.name}: key ${a.key} โดย ${a.by} (รายการโอนผ่านสะพานของฝ่ายนั้นถูกกัก)`, { ...at, key: a.key, by: a.by });
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
  return { alerts, state: st };
}

/** A report: JSON-ready, with an English and a Thai summary. */
export function report({ alerts, chainId, fromBlock, toBlock, addresses, snapshot, now }) {
  const crit = alerts.filter((x) => x.severity === 'critical').length;
  const en = alerts.length === 0 ? `ZETAPHY bridge monitor: no alerts (blocks ${fromBlock}–${toBlock}).`
    : [`ZETAPHY bridge monitor: ${alerts.length} alert(s), ${crit} critical (blocks ${fromBlock}–${toBlock}).`, ...alerts.map((x) => `- [${x.severity}] ${x.rule}: ${x.en}`)].join('\n');
  const th = alerts.length === 0 ? `ตัวเฝ้าสะพาน ZETAPHY: ไม่มีสัญญาณเตือน (บล็อก ${fromBlock}–${toBlock})`
    : [`ตัวเฝ้าสะพาน ZETAPHY: มีสัญญาณเตือน ${alerts.length} รายการ ร้ายแรง ${crit} รายการ (บล็อก ${fromBlock}–${toBlock})`, ...alerts.map((x) => `- [${x.severity}] ${x.rule}: ${x.th}`)].join('\n');
  return plain({ format: 'zetaphy-bridge-monitor/1', generatedAt: new Date(now * 1000).toISOString(), chainId, fromBlock, toBlock, addresses,
    snapshot: snapshot && { paused: snapshot.paused, maxDailyLimit: snapshot.maxDailyLimit, threshold: snapshot.threshold, lanes: snapshot.lanes, routes: snapshot.routes },
    alerts, summary: { en, th } });
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
  }
  return cfg;
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

/**
 * Reads logs of `sources` ([{source, address}]) in [from, to], chunked, decoded with IFACES,
 * each with its block time. getLogs(filter) and getBlock(n) are the provider's.
 */
export async function readEvents(provider, sources, from, to, { chunk = DEFAULTS.chunk } = {}) {
  const byAddr = new Map(sources.filter((s) => s.address && !/^0x0{40}$/i.test(s.address)).map((s) => [lower(s.address), s.source]));
  if (!byAddr.size || to < from) return [];
  const out = [];
  const times = new Map();
  for (let a = from; a <= to; a += chunk) {
    const b = Math.min(a + chunk - 1, to);
    const logs = await provider.getLogs({ address: [...byAddr.keys()].map((x) => getAddress(x)), fromBlock: a, toBlock: b });
    for (const l of logs) {
      const source = byAddr.get(lower(l.address));
      let parsed = null;
      try { parsed = IFACES[source]?.parseLog({ topics: l.topics, data: l.data }); } catch { /* not ours */ }
      if (!parsed) continue;
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await provider.getBlock(l.blockNumber)).timestamp));
      const args = {};
      parsed.fragment.inputs.forEach((inp, i) => { args[inp.name] = parsed.args[i]; });
      out.push({ source, address: getAddress(l.address), name: parsed.name, args, block: l.blockNumber, time: times.get(l.blockNumber), tx: l.transactionHash });
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
