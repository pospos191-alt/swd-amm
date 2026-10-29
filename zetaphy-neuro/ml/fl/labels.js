// Neuro federated learning: where a browser's labels come from.
//
// Two sources, both kept only in this browser:
//  1. the USER, after the fact: "it was a scam" (1) / "it was not" (0);
//  2. AUTOMATIC outcomes observed on chain LATER, by re-reading the token when
//     the page is open (the same read-only reader and trade simulation as a scan):
//       - sell-failed     the trade simulation can buy but no longer sell;
//       - liquidity-pulled the pool's native-coin side fell by `rugDrop` (90%) or
//                          more since the scan, or the pool lost its liquidity;
//       - threat-flagged  the ZETAPHY ThreatRegistry flags the token's address or
//                          fingerprint now and did NOT at scan time;
//       - traded-normally (label 0) only after `settleDays` (30): the latest
//                          observations all sell with a tax <= maxSellTax, the pool
//                          keeps >= keepShare of its scan-time liquidity, no flag,
//                          and no positive signal was ever seen.
//     A positive signal counts only when seen in `confirmations` observations
//     at least `confirmGapHours` apart and still seen in the latest one (a flaky
//     RPC or a briefly empty pool must not make a label). No label is used
//     before `minDelayDays` after the scan.
//
// Label noise (documented in docs/future/federated.md): automatic labels are
// NOT ground truth. Known ways they are wrong: an honest team migrating its
// pool looks like a pulled pool (false 1); a slow rug or a trap that fires
// after 30 days looks like normal trading (false 0); the simulator's own
// misses (a trap aimed only at certain callers) carry over; a ThreatRegistry
// flag can be wrong and later cleared on appeal (we then drop the label at
// the next observation). When the user's answer and the automatic one
// disagree, the example is NOT used (and the panel says so).

export const DEFAULT_LABELING = Object.freeze({
  minDelayDays: 3, settleDays: 30, rugDrop: 0.9, keepShare: 0.5, maxSellTax: 10, confirmations: 2, confirmGapHours: 12,
  recheckHours: 12, maxEntries: 200,
});
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Named features -> the sparse form kept in storage (non-zero, 6 significant digits). */
export function sparseFeatures(named) {
  const out = {};
  for (const [k, v] of Object.entries(named ?? {})) if (Number.isFinite(v) && v !== 0) out[k] = Number(v.toPrecision(6));
  return out;
}

const liqOf = (x) => { try { return x == null ? null : BigInt(x); } catch { return null; } };

/**
 * What the browser keeps about one scan (nothing of it is ever sent).
 * @param {{chain:string, address:string, chainId?:number, features:object, sim?:object, liquidity?:string|null,
 *          flagged?:boolean|null, fingerprint?:string, at?:number}} s
 */
export function scanEntry(s) {
  return {
    id: `${s.chain}:${String(s.address).toLowerCase()}`, chain: s.chain, chainId: s.chainId ?? null, address: String(s.address).toLowerCase(),
    at: s.at ?? Date.now(), f: sparseFeatures(s.features), sim0: s.sim?.stage ?? null, pair: s.sim?.pair ?? null,
    liq0: s.liquidity ?? null, flag0: s.flagged ?? null, fp: s.fingerprint ?? null, user: null, obs: [],
  };
}

/** One later observation, from a fresh report (report.sim), the pool's reserve and the registry. */
export function observation({ at = Date.now(), sim = null, liquidity = null, flagged = null } = {}) {
  return { at, sim: sim?.stage ?? null, sellTax: sim?.sellTax ?? null, liq: liquidity ?? null, flagged };
}

/** Which positive signals one observation shows for an entry. */
export function signals(entry, o, policy = DEFAULT_LABELING) {
  const s = [];
  if (o.sim === 'sell-failed') s.push('sell-failed');
  const l0 = liqOf(entry.liq0); const l = liqOf(o.liq);
  const hadPool = entry.sim0 === 'done' || (l0 != null && l0 > 0n);
  if (hadPool && (o.sim === 'no-liquidity' || o.sim === 'no-pool')) s.push('liquidity-pulled');
  else if (l0 != null && l0 > 0n && l != null && l * 1000n <= l0 * BigInt(Math.round((1 - policy.rugDrop) * 1000))) s.push('liquidity-pulled');
  if (o.flagged === true && entry.flag0 !== true) s.push('threat-flagged');
  return s;
}

function normalTrading(entry, o, policy) {
  if (o.sim !== 'done' || o.flagged === true) return false;
  if (o.sellTax != null && Number(o.sellTax) > policy.maxSellTax) return false;
  const l0 = liqOf(entry.liq0); const l = liqOf(o.liq);
  if (l0 != null && l0 > 0n) {
    if (l == null) return false;
    if (l * 1000n < l0 * BigInt(Math.round(policy.keepShare * 1000))) return false;
  }
  return true;
}

/**
 * The automatic label of an entry at time `now`.
 * @returns {{label: 0|1|null, source: string|null, why: string, readyAt?: number}}  why: ready | no-observation |
 *   delay | confirming | mixed | too-early | few-observations
 */
export function autoLabel(entry, now = Date.now(), policy = DEFAULT_LABELING) {
  const p = { ...DEFAULT_LABELING, ...policy };
  const obs = [...(entry.obs ?? [])].filter((o) => o.at > entry.at).sort((a, b) => a.at - b.at);
  const readyAt = entry.at + p.minDelayDays * DAY;
  if (!obs.length) return { label: null, source: null, why: 'no-observation', readyAt };
  const latest = obs.at(-1);
  const latestSignals = signals(entry, latest, p);
  for (const kind of ['sell-failed', 'liquidity-pulled', 'threat-flagged']) {
    if (!latestSignals.includes(kind)) continue;
    const seen = obs.filter((o) => signals(entry, o, p).includes(kind));
    if (seen.length >= p.confirmations && latest.at - seen[0].at >= p.confirmGapHours * HOUR) {
      if (now < readyAt) return { label: null, source: kind, why: 'delay', readyAt };
      return { label: 1, source: kind, why: 'ready' };
    }
    return { label: null, source: kind, why: 'confirming', readyAt: Math.max(readyAt, seen[0].at + p.confirmGapHours * HOUR) };
  }
  const settleAt = entry.at + p.settleDays * DAY;
  const everPositive = obs.some((o) => signals(entry, o, p).length);
  if (everPositive) return { label: null, source: null, why: 'mixed', readyAt: null };
  const late = obs.filter((o) => o.at >= settleAt);
  const lastFew = obs.slice(-p.confirmations);
  if (late.length && lastFew.length >= p.confirmations && lastFew.every((o) => normalTrading(entry, o, p))
    && lastFew.at(-1).at - lastFew[0].at >= p.confirmGapHours * HOUR) {
    return { label: 0, source: 'traded-normally', why: 'ready' };
  }
  return { label: null, source: null, why: now < settleAt ? 'too-early' : 'few-observations', readyAt: Math.max(readyAt, settleAt) };
}

/**
 * The label used for training: the user's and the automatic one combined.
 * Both present and different -> not used (conflict).
 * @returns {{label: 0|1|null, from: 'user'|'auto'|'both'|null, conflict: boolean, auto: object}}
 */
export function finalLabel(entry, now = Date.now(), policy = DEFAULT_LABELING) {
  const auto = autoLabel(entry, now, policy);
  const user = entry.user === 0 || entry.user === 1 ? entry.user : null;
  if (user != null && auto.label != null) {
    return user === auto.label ? { label: user, from: 'both', conflict: false, auto } : { label: null, from: null, conflict: true, auto };
  }
  if (user != null) return { label: user, from: 'user', conflict: false, auto };
  if (auto.label != null) return { label: auto.label, from: 'auto', conflict: false, auto };
  return { label: null, from: null, conflict: false, auto };
}

/** Training rows {f, y} from stored entries (newest first, at most `max`). */
export function labelledExamples(entries, now = Date.now(), { max = 64, policy = DEFAULT_LABELING } = {}) {
  return [...entries].sort((a, b) => b.at - a.at).map((e) => ({ e, l: finalLabel(e, now, policy) }))
    .filter((x) => x.l.label != null).slice(0, max).map((x) => ({ f: x.e.f, y: x.l.label }));
}

/** Entries due a re-read (oldest observation first). */
export function dueForRecheck(entries, now = Date.now(), policy = DEFAULT_LABELING) {
  const p = { ...DEFAULT_LABELING, ...policy };
  return entries.filter((e) => {
    const last = e.obs?.length ? e.obs.at(-1).at : e.at;
    const f = finalLabel(e, now, p);
    if (f.auto.label === 0) return false; // settled: nothing more to learn from it
    return now - last >= p.recheckHours * HOUR && now - e.at <= (p.settleDays + 30) * DAY;
  }).sort((a, b) => (a.obs?.at(-1)?.at ?? a.at) - (b.obs?.at(-1)?.at ?? b.at));
}

// ---------------------------------------------------------------- chain reads
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const GET_RESERVES = '0x0902f1ac';
const TOKEN0 = '0x0dfe1681';
const IS_ADDRESS_FLAGGED = '0x25f11c9f'; // isAddressFlagged(uint256,address)
const IS_FLAGGED = '0xbf2dde38'; // isFlagged(bytes32)
export const LABEL_SELECTORS = Object.freeze({ GET_RESERVES, TOKEN0, IS_ADDRESS_FLAGGED, IS_FLAGGED });

/**
 * The native-coin (wrapped) side of a V2 pool's reserves, as a decimal string, or null.
 * @param {(method:string, params:any[]) => Promise<string>} call  JSON-RPC (eth_call)
 */
export async function poolLiquidity(call, pair, weth) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(pair)) || !/^0x[0-9a-fA-F]{40}$/.test(String(weth))) return null;
  try {
    const [r, t0] = await Promise.all([call('eth_call', [{ to: pair, data: GET_RESERVES }, 'latest']), call('eth_call', [{ to: pair, data: TOKEN0 }, 'latest'])]);
    const h = String(r).replace(/^0x/, '');
    if (h.length < 128) return null;
    const first = '0x' + String(t0).replace(/^0x/, '').slice(24, 64);
    const isWeth0 = first.toLowerCase() === weth.toLowerCase();
    return BigInt('0x' + h.slice(isWeth0 ? 0 : 64, isWeth0 ? 64 : 128)).toString();
  } catch { return null; }
}

/**
 * Whether the ZETAPHY ThreatRegistry flags this contract now (by its address on its chain, or by
 * its Neuro fingerprint). null when it cannot be read.
 */
export async function threatFlagged(call, registry, { chainId, address, fingerprint } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(registry ?? ''))) return null;
  try {
    const first = (hex) => BigInt('0x' + (String(hex).replace(/^0x/, '').slice(0, 64) || '0')) === 1n;
    const reads = [];
    if (chainId != null && /^0x[0-9a-fA-F]{40}$/.test(String(address))) reads.push(call('eth_call', [{ to: registry, data: IS_ADDRESS_FLAGGED + word(chainId) + addrWord(address) }, 'latest']));
    if (/^fp1:[0-9a-f]{64}$/.test(String(fingerprint ?? ''))) reads.push(call('eth_call', [{ to: registry, data: IS_FLAGGED + fingerprint.slice(4) }, 'latest']));
    if (!reads.length) return null;
    return (await Promise.all(reads)).some(first);
  } catch { return null; }
}
