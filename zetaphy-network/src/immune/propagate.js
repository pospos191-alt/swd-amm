// Propagation ZETAPHY -> every chain (docs/future/immune-network.md, "Propagation"):
//   EVM:     ImmuneBroadcaster.broadcast(keys): one Hyperlane message per route, at most MAX_ITEMS keys each, only
//            the keys a route lacks (by round) -> ImmuneMirror.handle on the destination (message-id multisig ISM of
//            our validators). Gas-bounded: <= MAX_ITEMS x MAX_DOMAINS items per call.
//   Osmosis: ImmuneBroadcaster.pushIbc(keys): an ICS-20 transfer whose memo ibc-hooks executes on the CosmWasm
//            mirror (cosmwasm/neuro-oracle-osmo, one more instance whose hook sender is the broadcaster's).
//   Solana:  documented path only (no Sealevel mirror deployed): Hyperlane Sealevel carries the same body to a
//            program that stores (key -> round, flagged, severity, since, expiresAt); until then Solana wallets and
//            dapps read the signed feed (feed.js) through the SDK (sdk.js).
// Plus a seeded discrete-event model of detect -> agree -> registry -> mirror latency per chain (simulate()).
import { ALL, ZETAPHY, propagationSeconds } from './chains.js';

export const MAX_ITEMS = 24;    // = ImmuneBroadcaster.MAX_ITEMS
export const MAX_DOMAINS = 16;  // = ImmuneBroadcaster.MAX_DOMAINS
/**
 * An upper bound of the gas one broadcast costs, fitted to measurements against a Mailbox that only emits
 * (test/immune.test.js checks it from 1 to 24 keys and 1 to 16 routes: 67k for 1 x 1, 13.85M for 24 x 16): a base
 * per call, per route (quote + dispatch + event) and per item per route (registry read, abi encode, sentRound write).
 * `mailbox`: what the real Mailbox adds per dispatch on top (its merkle tree hook and default IGP: ~100-150k).
 */
export const GAS = { base: 25_000, perRoute: 12_000, perItemRoute: 36_000 };
export const broadcastGas = (items, routes, { mailbox = 0 } = {}) => GAS.base + routes * (GAS.perRoute + mailbox + items * GAS.perItemRoute);

/**
 * Splits keys into broadcast batches: dedup, at most MAX_ITEMS each and small enough that broadcastGas(batch, routes)
 * stays under `gasCap` (default 12M: under half a 30M block, so a broadcast never fills a ZETAPHY block).
 */
export function planBatches(keys, { routes = 1, maxItems = MAX_ITEMS, gasCap = 12_000_000, mailbox = 150_000 } = {}) {
  const uniq = [...new Set(keys.map((k) => String(k).toLowerCase()))];
  let size = Math.min(maxItems, MAX_ITEMS);
  const g = (n) => broadcastGas(n, routes, { mailbox });
  while (size > 1 && g(size) > gasCap) size--;
  if (g(size) > gasCap) throw new Error(`one key to ${routes} routes needs ${g(1)} gas > cap ${gasCap}`);
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/**
 * Which keys each route still lacks: registry rounds vs the rounds the route acknowledged (its mirror's roundsOf,
 * or the broadcaster's sentRound). -> { [route]: [key] }. Keys never flagged (round 0) are skipped.
 */
export function pendingByRoute(registryRounds, routeRounds) {
  const out = {};
  for (const [route, have] of Object.entries(routeRounds)) {
    out[route] = Object.entries(registryRounds).filter(([k, r]) => r > 0 && (have[k] ?? 0) < r).map(([k]) => k);
  }
  return out;
}

/**
 * The IBC memo ImmuneBroadcaster.ibcMemo builds, in JS (an off-chain relayer or a test checks one against the other).
 * items: registry ImmuneItem-like { key, round, flagged, severity, since, expiresAt }.
 */
export function ibcMemo(items, { contract, srcChain = ZETAPHY.id, now = Math.floor(Date.now() / 1000) }) {
  return JSON.stringify({ wasm: { contract, msg: { mirror: { src_chain: Number(srcChain), items: items.map((it) => {
    const on = !!it.flagged && now < Number(it.expiresAt);
    return { key: String(it.key).toLowerCase().replace(/^0x/, ''), round: Number(it.round), flagged: on, reason: on ? Number(it.severity) : 0,
      enforced_from: !on ? 0 : Number(it.severity) >= 3 ? Number(it.since) : Number(it.expiresAt), held_from: on ? Number(it.since) : 0 };
  }) } } } });
}

/** How each chain is reached (the coverage table of the docs and the hub). */
export function routes() {
  return ALL.map((c) => ({ key: c.key, name: c.name, id: c.id, kind: c.kind, testnet: !!c.testnet, mirror: c.mirror, seconds: propagationSeconds(c) }));
}

// ---------------------------------------------------------------- latency model

/** mulberry32: a small seeded PRNG (the same simulation every run). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const pctile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

/**
 * Seconds of each stage for an attack on `source`, propagated to every other chain with a mirror, over `trials`
 * runs with jitter. Stages:
 *   detect   the attack's block + the sentinel's poll interval (uniform 0..poll) + RPC time (+ rate-limit wait)
 *   agree    NeuroJobs on ZETAPHY: request (1 block), lottery draw (2 blocks), 3 commits (1 block), reveals (1 block)
 *            + each runner's fetch-and-re-run (reverify seconds, the 2nd fastest of 3 decides the quorum)
 *   registry ImmuneRegistry.attest (1 block)
 *   mirror   per destination (chains.js propagationSeconds: ZETAPHY finality + validators sign + relayer + 1 block)
 * Returns { stages: {detect, agree, registry} medians, perChain: [{key, median, p90}], median, p90, trials }.
 */
export function simulate({ source = 'sepolia', trials = 200, seed = 7, poll = 6, rpcSeconds = 0.6, reverify = [1.5, 6], relay = [2, 6], sign = [0.5, 2], ibc = [6, 15] } = {}) {
  const r = rng(seed);
  const u = ([lo, hi]) => lo + (hi - lo) * r();
  const src = ALL.find((c) => c.key === source);
  if (!src) throw new Error(`unknown chain ${source}`);
  const zb = ZETAPHY.block;
  const dest = ALL.filter((c) => c.key !== source && (c.mirror === 'hyperlane' || c.mirror === 'ibc' || c.mirror === 'home'));
  const totals = Object.fromEntries(dest.map((c) => [c.key, []]));
  const S = { detect: [], agree: [], registry: [] };
  for (let i = 0; i < trials; i++) {
    const detect = src.block * r() + poll * r() + rpcSeconds * (2 + 3 * r());
    const runners = [u(reverify), u(reverify), u(reverify)].sort((a, b) => a - b);
    const agree = zb /* request */ + 2 * zb /* draw */ + Math.max(zb, runners[1]) /* 2 commits */ + zb /* reveals */;
    const registry = zb;
    S.detect.push(detect); S.agree.push(agree); S.registry.push(registry);
    for (const c of dest) {
      const m = c.mirror === 'home' ? 0 : c.mirror === 'ibc' ? propagationSeconds(c, { ibc: u(ibc) }) : propagationSeconds(c, { sign: u(sign), relay: u(relay) });
      totals[c.key].push(detect + agree + registry + m);
    }
  }
  const perChain = dest.map((c) => ({ key: c.key, name: c.name, mirror: c.mirror, median: +median(totals[c.key]).toFixed(1), p90: +pctile(totals[c.key], 0.9).toFixed(1) }));
  const all = Object.values(totals).flat();
  return {
    source, trials,
    stages: Object.fromEntries(Object.entries(S).map(([k, v]) => [k, +median(v).toFixed(1)])),
    perChain, median: +median(all).toFixed(1), p90: +pctile(all, 0.9).toFixed(1),
  };
}

export { median };
