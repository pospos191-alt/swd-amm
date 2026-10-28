#!/usr/bin/env node
// Key watch: notice a stolen key fast, while the timelock delay still allows a veto.
// Read-only: public RPCs (and an optional Cosmos REST), no keys, no secrets. Used by
// .github/workflows/key-watch.yml every 15 minutes; see docs/KEY-WATCH.md.
//
//   node scripts/key-watch.js [--config key-watch.json] [--state state.json] [--lookback N] [--dry-run]
//
// Watches the addresses in key-watch.json (+ deployed Saphan routes) on ZETAPHY, Sepolia, Base Sepolia
// and Arbitrum Sepolia, and alerts on:
//   - a watched EOA's nonce going up (a transaction it signed) or a balance drop past the threshold;
//   - timelock CallScheduled / CallExecuted / Cancelled / MinDelayChange, RoleGranted / RoleRevoked /
//     RoleAdminChanged, OwnershipTransferred, Upgraded on watched contracts;
//   - Paused / Unpaused, vetoes (Vetoed, ReleaseVetoed, VetoLifted, Tripped), guardian / governance /
//     limit changes and multisig proposals of our bridge and core contracts (event names from contracts/);
//   - ZETAPHY validators jailed / status changes and new gov proposals, when a Cosmos REST is configured.
// Alerts go to one open GitHub issue labelled security-alert (comment, or a new issue); each alert carries a
// hidden marker so it is never posted twice. An unreachable chain is reported at most once a day (issue
// labelled key-watch-health), and never before the chain's quietUntil.
// With GITHUB_TOKEN + GITHUB_REPOSITORY unset (or --dry-run) alerts are printed instead.
// Exit 1 when alerts could not be delivered: the workflow then keeps the old state, the next run finds the
// same alerts again, and the markers keep them from being posted twice.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, JsonRpcProvider, FetchRequest, Network, getAddress, formatEther, parseEther, id as keccakId, ZeroHash } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = resolve(HERE, '../key-watch.json');
export const ALERT_LABEL = 'security-alert';
export const HEALTH_LABEL = 'key-watch-health';
const SEEN_MAX = 5000;
const SEV_ORDER = { critical: 0, high: 1, warning: 2, info: 3 };

// ---------------------------------------------------------------- events
// [signature, severity, what it means]. Signatures as in contracts/*.sol and OpenZeppelin 5.4 (TimelockController,
// AccessControl, Ownable, Pausable, ERC1967). Same topic0 with a different indexing (Paused(address) indexed or
// not) is decoded by matching the number of topics.
export const EVENTS = [
  // timelock (ZetaphyTimelock = OpenZeppelin TimelockController)
  ['event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)', 'critical', 'a call was SCHEDULED in the timelock. If you did not propose it: cancel it (a canceller) or veto/pause with the guardian before it is ready'],
  ['event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)', 'high', 'a timelock call was EXECUTED'],
  ['event Cancelled(bytes32 indexed id)', 'high', 'a scheduled timelock call was CANCELLED'],
  ['event MinDelayChange(uint256 oldDuration, uint256 newDuration)', 'critical', 'the timelock delay CHANGED'],
  ['event CallSalt(bytes32 indexed id, bytes32 salt)', null, null], // part of a schedule; not alerted on its own
  // roles / ownership / upgrades
  ['event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)', 'critical', 'a ROLE was GRANTED'],
  ['event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)', 'critical', 'a ROLE was REVOKED'],
  ['event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)', 'critical', 'a role ADMIN changed'],
  ['event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)', 'critical', 'OWNERSHIP was transferred'],
  ['event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)', 'critical', 'an ownership transfer was started'],
  ['event Upgraded(address indexed implementation)', 'critical', 'the contract was UPGRADED'],
  ['event AdminChanged(address previousAdmin, address newAdmin)', 'critical', 'the proxy admin changed'],
  // pause (BridgeGuard, HyperlaneLockBoxV2, SaphanTokens, StableGateway, NeuroControl: indexed; OpenZeppelin: not)
  ['event Paused(address indexed by)', 'high', 'the contract was PAUSED'],
  ['event Paused(address account)', 'high', 'the contract was PAUSED'],
  ['event Unpaused()', 'high', 'the contract was UNPAUSED'],
  ['event Unpaused(address account)', 'high', 'the contract was UNPAUSED'],
  // guardian vetoes and holds (BridgeAirlock, HyperlaneLockBoxV2, SaphanTokens, ZetaphyOracle)
  ['event Vetoed(bytes32 indexed id, address indexed by, string reason)', 'high', 'a transfer was VETOED'],
  ['event Vetoed(bytes32 indexed id, address indexed by)', 'high', 'a transfer was VETOED'],
  ['event ReleaseVetoed(bytes32 indexed id, address indexed by)', 'high', 'a release was VETOED'],
  ['event VetoLifted(bytes32 indexed id)', 'critical', 'a VETO was LIFTED (that release can now go through)'],
  ['event Tripped(address indexed who, address indexed by)', 'high', 'an address was marked (Tripped) by the airlock'],
  ['event Untripped(address indexed who)', 'high', 'an airlock mark was removed'],
  ['event FeedPaused(address indexed asset, address indexed by)', 'high', 'a price feed was PAUSED'],
  ['event FeedUnpaused(address indexed asset)', 'high', 'a price feed was UNPAUSED'],
  ['event CircuitBreakerTripped(address indexed asset, uint256 price, uint256 ref, uint256 bps)', 'high', 'the oracle circuit breaker tripped'],
  ['event HeldDropped(uint256 indexed id)', 'warning', 'a held inbound transfer was dropped'],
  // governance / guardian / limit changes
  ['event GovernanceSet(address governance)', 'critical', 'GOVERNANCE changed'],
  ['event GovernanceChanged(address governance)', 'critical', 'GOVERNANCE changed'],
  ['event OwnerChanged(address owner)', 'critical', 'the OWNER changed'],
  ['event GuardianSet(address indexed who, bool on)', 'critical', 'a GUARDIAN was added or removed'],
  ['event VetoerSet(address who, bool on)', 'critical', 'a VETOER was added or removed'],
  ['event MarkerSet(address marker, bool on)', 'high', 'a marker was added or removed'],
  ['event LaneSet(address lane, bool on)', 'critical', 'a bridge LANE was added or removed'],
  ['event IsmSet(address ism)', 'critical', 'the ISM (who may sign bridge messages) changed'],
  ['event ThresholdSet(uint8 threshold)', 'critical', 'the lane threshold changed'],
  ['event QuarantineSet(uint64 quarantine)', 'high', 'the quarantine changed'],
  ['event DailyLimitSet(uint256 limit)', 'high', 'the daily limit changed'],
  ['event ReleaseDelaySet(uint64 delay)', 'high', 'the release delay changed'],
  ['event DelaySet(uint64 delay)', 'high', 'the delay changed'],
  ['event MaxDailyLimitProposed(uint128 value, uint64 at)', 'high', 'a new maximum daily limit was proposed'],
  ['event MaxDailyLimitSet(uint128 value)', 'high', 'the maximum daily limit changed'],
  ['event RouteSet(bytes32 indexed id, address adapter, uint128 dailyLimit, bool enabled)', 'critical', 'a bridge ROUTE was set'],
  ['event ThreatsSet(address registry)', 'high', 'the threat registry changed'],
  ['event LockCapSet(uint256 cap)', 'high', 'the lock cap changed'],
  ['event SupplyCapSet(uint256 cap)', 'high', 'the supply cap changed'],
  ['event ExcessRecovered(address indexed to, uint256 amount)', 'high', 'excess was recovered out of a vault'],
  // SimpleMultisig
  ['event Proposed(uint256 indexed id, address indexed by, address to, uint256 value)', 'high', 'a MULTISIG transaction was proposed'],
  ['event Confirmed(uint256 indexed id, address indexed by)', 'high', 'a multisig transaction was confirmed'],
  ['event Executed(uint256 indexed id)', 'high', 'a multisig transaction was EXECUTED'],
];

const EVENT_INFO = new Map(); // topic0 -> [{ iface, fragment, indexed, severity, meaning }]
for (const [sig, severity, meaning] of EVENTS) {
  const iface = new Interface([sig]);
  const fragment = iface.fragments[0];
  const list = EVENT_INFO.get(fragment.topicHash) ?? [];
  list.push({ iface, fragment, indexed: fragment.inputs.filter((i) => i.indexed).length, severity, meaning });
  EVENT_INFO.set(fragment.topicHash, list);
}
export const TOPICS = [...EVENT_INFO.keys()];

const ROLE_NAMES = Object.fromEntries([
  [ZeroHash, 'DEFAULT_ADMIN_ROLE'],
  ...['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE', 'TIMELOCK_ADMIN_ROLE', 'GUARDIAN_ROLE', 'PAUSER_ROLE', 'MINTER_ROLE', 'UPGRADER_ROLE']
    .map((n) => [keccakId(n), n]),
]);

/** Decode a log with the event list, or null. */
export function decodeLog(log) {
  const list = EVENT_INFO.get(log.topics?.[0]);
  if (!list) return null;
  const cand = list.find((c) => c.indexed === log.topics.length - 1) ?? list[0];
  try {
    const parsed = cand.iface.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) return null;
    const args = {};
    cand.fragment.inputs.forEach((inp, i) => { args[inp.name || `arg${i}`] = parsed.args[i]; });
    return { name: cand.fragment.name, signature: cand.fragment.format('sighash'), args, severity: cand.severity, meaning: cand.meaning };
  } catch {
    return { name: cand.fragment.name, signature: cand.fragment.format('sighash'), args: {}, severity: cand.severity, meaning: cand.meaning, undecoded: true };
  }
}

function fmtArg(name, v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) && /role/i.test(name)) return ROLE_NAMES[v] ? `${ROLE_NAMES[v]} (${v.slice(0, 10)}…)` : v;
  if (typeof v === 'string' && name === 'data' && v.length > 10) return `${v.slice(0, 10)} (selector, ${(v.length - 2) / 2} bytes)`;
  return String(v);
}

// ---------------------------------------------------------------- config

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => a.toLowerCase();

/** Read key-watch.json + the chain table + deployed routes into { defaults, chains: { key: { name, chainId, rpc[], explorer, quietUntil, rest, validators, watch[] } } }. */
export function loadConfig(path = DEFAULT_CONFIG, { readJson = (p) => JSON.parse(readFileSync(p, 'utf8')) } = {}) {
  const raw = readJson(path);
  const base = dirname(path);
  const table = raw.chainsFile ? readJson(resolve(base, raw.chainsFile)) : {};
  const routes = raw.routesFile && existsSync(resolve(base, raw.routesFile)) ? readJson(resolve(base, raw.routesFile)) : {};
  return buildConfig(raw, table, routes);
}

export function buildConfig(raw, table = {}, routes = {}) {
  const defaults = {
    balanceDropPct: 10, balanceDropMin: '0.05', confirmations: 2, logChunk: 2000, maxBlocksPerRun: 20000,
    maxLagBlocks: 200000, rpcDownNoticeHours: 24, rpcDownGraceMinutes: 60, rpcTimeoutMs: 15000, ...(raw.defaults ?? {}),
  };
  const chains = {};
  for (const [key, c] of Object.entries(raw.chains ?? {})) {
    const t = key === 'zetaphy' ? (table.zetaphy ?? {}) : (table.chains?.[key] ?? {});
    const rpc = [c.rpc ?? t.rpc ?? []].flat().filter((u) => /^https?:\/\//.test(u ?? ''));
    const chainId = c.chainId ?? t.chainId;
    if (!chainId || !rpc.length) throw new Error(`key-watch: chain ${key} has no chainId or rpc (key-watch.json or the chain table)`);
    chains[key] = {
      key, name: c.displayName ?? t.displayName ?? key, chainId: Number(chainId), rpc,
      explorer: (c.explorer ?? t.explorer ?? '').replace(/\/$/, ''),
      quietUntil: c.quietUntil ? Date.parse(c.quietUntil) : 0,
      rest: c.rest ?? null, validators: c.validators ?? [], watch: [], ...pick(c, ['confirmations', 'logChunk', 'maxBlocksPerRun', 'maxLagBlocks']),
    };
    for (const w of [...(raw.everyChain ?? []), ...(c.watch ?? [])]) addWatch(chains[key], w);
  }
  // deployed Saphan routes (saphan-routes.json, written by the saphan-route workflow): skip what is not deployed
  const kindOf = (field) => (/timelock/i.test(field) ? 'timelock' : /multisig|guardian/i.test(field) ? 'multisig' : 'bridge');
  const addFrom = (chainKey, obj, fields, label) => {
    if (!chains[chainKey] || !obj) return;
    for (const f of fields) if (ADDR.test(obj[f] ?? '')) addWatch(chains[chainKey], { address: obj[f], label: `${label} ${f}`, kind: kindOf(f) });
  };
  for (const [chain, r] of Object.entries(routes.routes ?? {})) {
    addFrom('zetaphy', r.zetaphy, ['bridgeGuard', 'bridgeAirlock', 'neuroLane', 'hyperlaneLane', 'hyperlaneOutbox'], `Saphan ${chain} route:`);
    addFrom(chain, r.origin, ['lockbox', 'multisig', 'timelock'], 'Saphan route:');
  }
  for (const [token, perChain] of Object.entries(routes.tokens ?? {})) {
    for (const [chain, r] of Object.entries(perChain ?? {})) {
      addFrom('zetaphy', r.zetaphy, ['vault'], `Saphan ${token}→${chain}:`);
      addFrom(chain, r.destination, ['synthetic', 'multisig', 'timelock'], `Saphan ${token}:`);
    }
  }
  return { defaults, chains };
}

function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]])); }

function addWatch(chain, w) {
  if (!ADDR.test(w.address ?? '')) throw new Error(`key-watch: bad address in ${chain.key}: ${w.address}`);
  const address = getAddress(lc(w.address));
  if (chain.watch.some((x) => x.address === address)) return; // first entry wins
  chain.watch.push({ address, label: w.label ?? address, kind: w.kind ?? 'contract', expectNonceUpTo: w.expectNonceUpTo ?? null, allowOutgoing: !!w.allowOutgoing });
}

// ---------------------------------------------------------------- providers

/** A read-only client over a list of RPC URLs: the first that answers wins, the next is tried on failure. */
export function makeRpc(urls, chainId, { timeoutMs = 15000 } = {}) {
  const network = Network.from(chainId);
  const providers = urls.map((url) => {
    const req = new FetchRequest(url);
    req.timeout = timeoutMs;
    req.setThrottleParams({ maxAttempts: 2 });
    return new JsonRpcProvider(req, network, { staticNetwork: network, batchMaxCount: 1 });
  });
  let cur = 0;
  const call = async (fn) => {
    let last;
    for (let i = 0; i < providers.length; i++) {
      const idx = (cur + i) % providers.length;
      try { const r = await fn(providers[idx]); cur = idx; return r; } catch (e) { last = e; }
    }
    throw last;
  };
  return {
    getBlockNumber: () => call((p) => p.getBlockNumber()),
    getBalance: (a) => call((p) => p.getBalance(a)),
    getTransactionCount: (a) => call((p) => p.getTransactionCount(a, 'latest')),
    getLogs: (f) => call((p) => p.getLogs(f)),
    getBlock: (n) => call((p) => p.getBlock(n)),
    getTransaction: (h) => call((p) => p.getTransaction(h)),
    destroy: () => providers.forEach((p) => p.destroy()),
  };
}

async function defaultFetchJson(url, timeoutMs = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- the watch

export function newState() { return { version: 1, chains: {}, cosmos: {}, seen: [] }; }

const links = (chain) => ({
  addr: (a) => (chain.explorer ? `[${a}](${chain.explorer}/address/${a})` : `\`${a}\``),
  tx: (h) => (chain.explorer ? `[${h.slice(0, 12)}…](${chain.explorer}/tx/${h})` : `\`${h}\``),
  block: (n) => (chain.explorer ? `[${n}](${chain.explorer}/block/${n})` : String(n)),
});

/**
 * One pass over every chain. Returns { state, alerts, health, stats }. Never throws for an RPC problem:
 * an unreachable chain becomes a health notice (at most one per rpcDownNoticeHours, none before quietUntil).
 * rpcFor(chain) -> client (makeRpc shape); fetchJson(url) -> JSON (Cosmos REST).
 */
export async function runWatch({ config, state = newState(), rpcFor, fetchJson = defaultFetchJson, now = Date.now(), lookback = 0, log = () => {} }) {
  state = structuredClone(state);
  state.chains ??= {}; state.cosmos ??= {}; state.seen ??= [];
  const alerts = [], health = [], stats = {};
  const d = config.defaults;
  for (const chain of Object.values(config.chains)) {
    const cs = (state.chains[chain.key] ??= { lastBlock: null, accounts: {}, down: null });
    cs.accounts ??= {};
    const L = links(chain);
    const st = (stats[chain.key] = { reachable: false, scanned: 0, alerts: 0 });
    const rpc = rpcFor(chain);
    let head;
    try {
      head = await rpc.getBlockNumber();
    } catch (e) {
      log(`${chain.key}: unreachable (${short(e)})`);
      cs.down ??= { since: now, lastNotice: null };
      const quiet = now < chain.quietUntil;
      const every = d.rpcDownNoticeHours * 3600_000;
      const grace = (d.rpcDownGraceMinutes ?? 60) * 60_000; // a blip of one run is not worth a notice
      if (!quiet && now - cs.down.since >= grace && (cs.down.lastNotice == null || now - cs.down.lastNotice >= every)) {
        health.push({ key: `rpcdown:${chain.key}:${new Date(now).toISOString().slice(0, 10)}`, chain: chain.key,
          text: `key-watch can't reach **${chain.name}** (chain ${chain.chainId}) on ${chain.rpc.length} RPC(s) since ${new Date(cs.down.since).toISOString()}: nothing on it is being watched. Last error: \`${short(e)}\`.` });
        cs.down.lastNotice = now;
      }
      rpc.destroy?.();
      continue;
    }
    cs.down = null;
    st.reachable = true;
    const confirmations = chain.confirmations ?? d.confirmations;
    const safeHead = Math.max(0, head - confirmations);

    // (a) EOAs: nonce; every address: balance drop
    for (const w of chain.watch) {
      const key = lc(w.address);
      const prev = cs.accounts[key];
      let balance, nonce = null;
      try {
        balance = await rpc.getBalance(w.address);
        if (w.kind === 'eoa') nonce = await rpc.getTransactionCount(w.address);
      } catch (e) { log(`${chain.key}: ${w.label}: read failed (${short(e)})`); continue; }
      cs.accounts[key] = { balance: balance.toString(), nonce };
      if (!prev) continue; // first sight: the baseline
      const prevBal = BigInt(prev.balance);
      const drop = prevBal - balance;
      const dropAlert = drop > 0n && (drop * 100n >= prevBal * BigInt(Math.round(d.balanceDropPct)) || drop >= parseEther(String(d.balanceDropMin)));
      const nonceUp = nonce != null && prev.nonce != null && nonce > prev.nonce;
      const nonceAlert = nonceUp && !w.allowOutgoing && !(w.expectNonceUpTo != null && nonce <= w.expectNonceUpTo);
      if (!nonceAlert && !dropAlert) continue;
      const lines = [`${L.addr(w.address)} — **${w.label}** (${w.kind})`];
      if (nonceUp) lines.push(`nonce ${prev.nonce} → ${nonce}: **${nonce - prev.nonce} new transaction(s) signed by this key**${nonceAlert ? '' : ' (expected)'}`);
      if (drop !== 0n) lines.push(`balance ${formatEther(prevBal)} → ${formatEther(balance)} (${drop > 0n ? '-' : '+'}${formatEther(drop > 0n ? drop : -drop)})`);
      lines.push(`If this was not you: treat the key as stolen (docs/KEY-WATCH.md → "When an alert fires").`);
      alerts.push({
        key: nonceAlert ? `nonce:${chain.key}:${key}:${nonce}` : `balance:${chain.key}:${key}:${prev.balance}->${balance}`,
        severity: nonceAlert ? (w.kind === 'eoa' ? 'critical' : 'high') : 'high', chain: chain.key, chainName: chain.name,
        title: nonceAlert ? `outgoing transaction from ${w.label}` : `balance drop on ${w.label}`, lines,
      });
    }

    // (b, c) events of watched contracts, from the last scanned block
    const contracts = chain.watch.filter((w) => w.kind !== 'eoa').map((w) => w.address);
    const labelOf = Object.fromEntries(chain.watch.map((w) => [lc(w.address), w]));
    if (cs.lastBlock == null) cs.lastBlock = Math.max(-1, safeHead - lookback); // first run: baseline (or a lookback)
    let from = cs.lastBlock + 1;
    const maxPerRun = chain.maxBlocksPerRun ?? d.maxBlocksPerRun;
    const maxLag = chain.maxLagBlocks ?? d.maxLagBlocks;
    if (safeHead - from + 1 > maxLag) {
      const newFrom = safeHead - maxPerRun + 1;
      alerts.push({ key: `gap:${chain.key}:${from}-${newFrom - 1}`, severity: 'warning', chain: chain.key, chainName: chain.name,
        title: `skipped ${newFrom - from} blocks on ${chain.name}`,
        lines: [`The watcher fell more than ${maxLag} blocks behind; blocks ${from}–${newFrom - 1} were NOT checked for events. Rescan them by hand if needed (workflow input lookback, or a local run).`] });
      from = newFrom;
    }
    const to = Math.min(safeHead, from + maxPerRun - 1);
    const chunk = chain.logChunk ?? d.logChunk;
    if (contracts.length && from <= to) {
      for (let a = from; a <= to; a += chunk) {
        const b = Math.min(to, a + chunk - 1);
        let logs;
        try {
          logs = await rpc.getLogs({ address: contracts, topics: [TOPICS], fromBlock: a, toBlock: b });
        } catch (e) { log(`${chain.key}: logs ${a}-${b} failed (${short(e)}); continuing next run`); break; }
        for (const lg of logs) {
          const ev = decodeLog(lg);
          if (!ev || !ev.severity) continue;
          const w = labelOf[lc(lg.address)] ?? { label: lg.address, kind: 'contract' };
          const lines = [`**${ev.name}** on ${L.addr(getAddress(lg.address))} — ${w.label}: ${ev.meaning}.`,
            `block ${L.block(lg.blockNumber)}, tx ${L.tx(lg.transactionHash)}`];
          try { const tx = await rpc.getTransaction(lg.transactionHash); if (tx?.from) lines.push(`sent by ${L.addr(tx.from)}${labelOf[lc(tx.from)] ? ` (${labelOf[lc(tx.from)].label})` : ''}`); } catch { /* optional */ }
          if (ev.name === 'CallScheduled') {
            try {
              const blk = await rpc.getBlock(lg.blockNumber);
              const ready = (Number(blk.timestamp) + Number(ev.args.delay)) * 1000;
              lines.push(`**ready at ${new Date(ready).toISOString()}** (delay ${Number(ev.args.delay)} s): you have until then to cancel or veto.`);
            } catch { /* optional */ }
          }
          for (const [k, v] of Object.entries(ev.args)) lines.push(`- ${k}: ${fmtArg(k, v)}`);
          alerts.push({ key: `log:${chain.key}:${lc(lg.transactionHash)}:${lg.index ?? lg.logIndex}`, severity: ev.severity, chain: chain.key, chainName: chain.name,
            title: `${ev.name} on ${w.label}`, lines });
        }
        cs.lastBlock = b;
        st.scanned += b - a + 1;
      }
    } else if (from <= to) cs.lastBlock = to;
    rpc.destroy?.();

    // (d) Cosmos REST: validators and gov proposals
    if (chain.rest) {
      const rest = chain.rest.replace(/\/$/, '');
      const cos = (state.cosmos[chain.key] ??= { validators: {}, lastProposal: null });
      for (const v of chain.validators) {
        try {
          const j = await fetchJson(`${rest}/cosmos/staking/v1beta1/validators/${v}`);
          const now_ = { jailed: !!j.validator?.jailed, status: String(j.validator?.status ?? 'unknown'), tokens: String(j.validator?.tokens ?? '') };
          const was = cos.validators[v];
          cos.validators[v] = now_;
          if (was && (was.jailed !== now_.jailed || was.status !== now_.status)) {
            alerts.push({ key: `valstatus:${chain.key}:${v}:${was.status}/${was.jailed}->${now_.status}/${now_.jailed}:${new Date(now).toISOString().slice(0, 10)}`, severity: now_.jailed ? 'critical' : 'high', chain: chain.key, chainName: chain.name,
              title: `validator ${now_.jailed ? 'JAILED' : 'status changed'}`,
              lines: [`\`${v}\` (${j.validator?.description?.moniker ?? ''})`, `status ${was.status} → ${now_.status}, jailed ${was.jailed} → ${now_.jailed}`] });
          }
        } catch (e) { log(`${chain.key}: validator ${v}: ${short(e)}`); }
      }
      try {
        const j = await fetchJson(`${rest}/cosmos/gov/v1/proposals?pagination.reverse=true&pagination.limit=20`);
        const props = (j.proposals ?? []).map((p) => ({ id: Number(p.id), title: p.title ?? p.metadata ?? '', status: p.status, msgs: (p.messages ?? []).map((m) => m['@type']).join(', ') }));
        const maxId = Math.max(0, ...props.map((p) => p.id));
        if (cos.lastProposal != null) {
          for (const p of props.filter((x) => x.id > cos.lastProposal).sort((x, y) => x.id - y.id)) {
            alerts.push({ key: `gov:${chain.key}:${p.id}`, severity: 'high', chain: chain.key, chainName: chain.name, title: `new gov proposal #${p.id}`,
              lines: [`#${p.id} ${p.title} — ${p.status}`, `messages: ${p.msgs || '?'}`, 'A gov proposal can schedule in the timelock without an EVM log: read it before it passes.'] });
          }
        }
        cos.lastProposal = Math.max(cos.lastProposal ?? 0, maxId);
      } catch (e) { log(`${chain.key}: gov proposals: ${short(e)}`); }
    }
  }
  // dedupe against what earlier runs reported
  const seen = new Set(state.seen);
  const fresh = alerts.filter((a) => !seen.has(a.key));
  for (const a of fresh) state.seen.push(a.key);
  if (state.seen.length > SEEN_MAX) state.seen = state.seen.slice(-SEEN_MAX);
  fresh.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
  for (const a of fresh) stats[a.chain].alerts++;
  return { state, alerts: fresh, health, stats };
}

function short(e) { return String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 200); }

// ---------------------------------------------------------------- reporting

export const marker = (key) => `<!-- key-watch:${key} -->`;

export function renderAlerts(alerts, { runUrl } = {}) {
  const top = alerts[0]?.severity ?? 'info';
  const out = [`## key-watch: ${alerts.length} alert(s), highest ${top.toUpperCase()}`, ''];
  for (const a of alerts) {
    out.push(marker(a.key), `### [${a.severity.toUpperCase()}] ${a.chainName}: ${a.title}`, ...a.lines, '');
  }
  out.push('---', 'What to do: docs/KEY-WATCH.md → "When an alert fires" (veto with the guardian, pause, cancel the timelock call, rotate the key).');
  if (runUrl) out.push(`Run: ${runUrl}`);
  return out.join('\n');
}

export function renderHealth(items, { runUrl } = {}) {
  return [...items.flatMap((h) => [marker(h.key), h.text, '']), runUrl ? `Run: ${runUrl}` : ''].join('\n').trim();
}

/** Minimal GitHub REST client (issues only), on fetch. */
export function githubClient({ token, repo, fetchImpl = fetch, api = 'https://api.github.com' }) {
  const req = async (method, path, body) => {
    const r = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    });
    if (!r.ok && !(method === 'POST' && path === '/labels' && r.status === 422)) throw new Error(`GitHub ${method} ${path}: HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  return {
    ensureLabel: (name, color, description) => req('POST', '/labels', { name, color, description }).catch(() => null),
    openIssue: async (label) => (await req('GET', `/issues?labels=${encodeURIComponent(label)}&state=open&per_page=10&sort=created&direction=desc`)).find((i) => !i.pull_request) ?? null,
    comments: async (n) => {
      const all = [];
      for (let page = 1; page <= 20; page++) {
        const batch = await req('GET', `/issues/${n}/comments?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    createIssue: (title, body, labels) => req('POST', '/issues', { title, body, labels }),
    comment: (n, body) => req('POST', `/issues/${n}/comments`, { body }),
  };
}

/** Post items (each with .key) to the open issue with `label` (comment) or a new one; skip keys already there. */
export async function deliver(gh, { label, color, description, title, items, render, runUrl }) {
  if (!items.length) return { posted: 0, skipped: 0 };
  await gh.ensureLabel(label, color, description);
  const issue = await gh.openIssue(label);
  let fresh = items;
  if (issue) {
    const text = [issue.body ?? '', ...(await gh.comments(issue.number)).map((c) => c.body ?? '')].join('\n');
    fresh = items.filter((i) => !text.includes(marker(i.key)));
  }
  if (!fresh.length) return { posted: 0, skipped: items.length, issue: issue?.number };
  // GitHub bodies are limited to 65536 characters: split if needed
  const parts = [];
  let cur = [];
  for (const i of fresh) {
    if (cur.length && render([...cur, i], { runUrl }).length > 60000) { parts.push(cur); cur = []; }
    cur.push(i);
  }
  parts.push(cur);
  let number = issue?.number;
  for (const p of parts) {
    const body = render(p, { runUrl });
    if (number == null) number = (await gh.createIssue(title(p), body, [label])).number;
    else await gh.comment(number, body);
  }
  return { posted: fresh.length, skipped: items.length - fresh.length, issue: number };
}

// ---------------------------------------------------------------- CLI

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const config = loadConfig(o.config ? resolve(o.config) : DEFAULT_CONFIG);
  const statePath = o.state ? resolve(o.state) : null;
  let state = newState();
  if (statePath && existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { console.log('key-watch: state unreadable, starting fresh (baseline)'); }
  }
  const lookback = Number(o.lookback ?? process.env.KEY_WATCH_LOOKBACK ?? 0) || 0;
  const res = await runWatch({
    config, state, lookback, log: (m) => console.log(m),
    rpcFor: (c) => makeRpc(c.rpc, c.chainId, { timeoutMs: config.defaults.rpcTimeoutMs }),
  });
  for (const [k, s] of Object.entries(res.stats)) console.log(`${k}: ${s.reachable ? `reachable, ${s.scanned} block(s) scanned, ${s.alerts} new alert(s)` : 'unreachable'}`);
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  let failed = false;
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (o.dryRun || !token || !repo) {
    if (res.alerts.length) console.log(renderAlerts(res.alerts, { runUrl }));
    if (res.health.length) console.log(renderHealth(res.health, { runUrl }));
  } else {
    const gh = githubClient({ token, repo });
    try {
      const r = await deliver(gh, { label: ALERT_LABEL, color: 'B60205', description: 'key-watch: possible stolen key or governance action', items: res.alerts, render: renderAlerts, runUrl,
        title: (p) => `Security alert: ${p.length} key-watch alert(s), highest ${p[0].severity}` });
      console.log(`alerts: ${r.posted} posted, ${r.skipped} already reported`);
    } catch (e) { failed = true; console.log(`::error title=key-watch::could not post the alerts: ${short(e)}`); }
    try {
      const r = await deliver(gh, { label: HEALTH_LABEL, color: 'FBCA04', description: 'key-watch: watcher health (unreachable RPCs)', items: res.health, render: renderHealth, runUrl,
        title: () => 'key-watch: watcher health' });
      if (r.posted) console.log(`health notices: ${r.posted} posted`);
    } catch (e) { failed = true; console.log(`::error title=key-watch::could not post the health notice: ${short(e)}`); }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['### key-watch', '', '| chain | reachable | blocks scanned | new alerts |', '|---|---|---|---|',
      ...Object.entries(res.stats).map(([k, s]) => `| ${k} | ${s.reachable ? 'yes' : 'no'} | ${s.scanned} | ${s.alerts} |`)];
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  }
  if (statePath && !failed) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(res.state, null, 1));
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`key-watch: ${e.stack ?? e}`); process.exit(1); });
}
