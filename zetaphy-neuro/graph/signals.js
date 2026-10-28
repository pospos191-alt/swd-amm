// Money-flow risk signals: fixed rules over the facts the graph collected.
// Every signal carries its evidence (transaction hashes, addresses) so anyone
// can check it on an explorer. Wording (graph/i18n.js) states what the chain
// shows ("liquidity added by X was removed by X"), never intent.
import { lc, pct } from './util.js';

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, good: 3, info: 4 };
export const LP_REMOVED_LINKED = 50; // % of own liquidity removed by a deployer-linked address
export const LP_REMOVED_ALL = 80;    // % of all liquidity removed (anyone)
export const LP_HELD = 50;           // % of the LP supply the deployer still holds
export const LP_BURNED = 95;         // % of added LP sent to a burn address
export const PRIOR_LP_REMOVED = 80;  // % removed on an earlier token of the same deployer
export const FRESH_NONCE = 5;

const big = (s) => { try { return BigInt(s ?? 0); } catch { return 0n; } };
const ev = (kind, value) => ({ kind, value });

/** Addresses tied to the deployer: itself, its creator, and its funding trail up to (not past) a hub. */
export function deployerLinked(g) {
  const out = new Set();
  if (g.creation?.deployer) out.add(lc(g.creation.deployer));
  if (g.creation?.creator && !g.creatorIsContract) out.add(lc(g.creation.creator));
  for (const h of g.deployerWalk?.hops ?? []) {
    if (g.hubs?.includes(lc(h.from))) break;
    out.add(lc(h.from));
  }
  return out;
}

/**
 * @param {object} g  the graph facts (graph/build.js): creation, deployerWalk,
 *   deployerProfile, receivers, receiverWalks, clusters, hubs, liquidity,
 *   lpHolding, priors, known (Map or object addr -> info), partial, notes
 * @returns {Array<{id, severity, params, evidence}>} most serious first
 */
export function deriveSignals(g) {
  const out = [];
  const known = g.known instanceof Map ? g.known : new Map(Object.entries(g.known ?? {}));
  const linked = deployerLinked(g);
  const deployer = g.creation?.deployer ? lc(g.creation.deployer) : null;
  const creationEv = g.creation?.tx ? [ev('tx', g.creation.tx)] : [];

  // 1. The deployer itself is known.
  if (deployer && known.has(deployer)) {
    const k = known.get(deployer);
    out.push({ id: 'deployer-flagged', severity: 'high', params: { addr: deployer, source: k.source, reason: k.reason ?? null, ref: k.ref ?? null }, evidence: [ev('address', deployer), ...creationEv] });
  }

  // 2. Its funding trail reaches a known address.
  const trail = g.deployerWalk?.hops ?? [];
  for (let i = 0; i < trail.length; i++) {
    const a = lc(trail[i].from);
    if (!known.has(a) || a === deployer) continue;
    const k = known.get(a);
    out.push({ id: 'funding-flagged', severity: 'high', params: { addr: a, hop: trail[i].hop, source: k.source, reason: k.reason ?? null, ref: k.ref ?? null },
      evidence: [ev('address', a), ...trail.slice(0, i + 1).filter((h) => h.tx).map((h) => ev('tx', h.tx))] });
    break;
  }

  // 3. Earlier contracts of the same deployer.
  const priors = g.priors ?? [];
  const flaggedPriors = priors.filter((p) => known.has(lc(p.addr)));
  if (flaggedPriors.length) {
    out.push({ id: 'prior-flagged', severity: 'high', params: { count: flaggedPriors.length, total: priors.length, addr: flaggedPriors[0].addr },
      evidence: flaggedPriors.slice(0, 5).flatMap((p) => [ev('address', p.addr), ...(p.tx ? [ev('tx', p.tx)] : [])]) });
  }
  const pulled = priors.filter((p) => p.lp && p.lp.removedShare >= PRIOR_LP_REMOVED);
  if (pulled.length) {
    out.push({ id: 'prior-lp-removed', severity: 'high', params: { count: pulled.length, total: priors.length, addr: pulled[0].addr, share: pulled[0].lp.removedShare },
      evidence: pulled.slice(0, 3).flatMap((p) => [ev('address', p.addr), ...p.lp.removeTxs.slice(0, 2).map((t) => ev('tx', t))]) });
  }

  // 4. Liquidity.
  const liq = g.liquidity;
  if (liq?.providers?.length) {
    const totalAdded = big(liq.totalAdded);
    let linkedHit = null;
    for (const p of liq.providers) {
      const added = big(p.added);
      if (!linked.has(lc(p.addr)) || added === 0n) continue;
      const share = pct(big(p.removed), added);
      if (share >= LP_REMOVED_LINKED && (!linkedHit || share > linkedHit.share)) linkedHit = { p, share };
    }
    if (linkedHit) {
      const { p, share } = linkedHit;
      out.push({ id: 'lp-removed', severity: 'high',
        params: { addr: p.addr, share, blocks: p.lastRemoveBlock != null && p.firstAddBlock != null ? p.lastRemoveBlock - p.firstAddBlock : null, pool: liq.pair, linked: true },
        evidence: [ev('address', liq.pair), ...p.addTxs.slice(0, 2).map((t) => ev('tx', t)), ...p.removeTxs.slice(0, 3).map((t) => ev('tx', t))] });
    } else if (totalAdded > 0n && pct(big(liq.totalRemoved), totalAdded) >= LP_REMOVED_ALL) {
      const removers = liq.providers.filter((p) => big(p.removed) > 0n);
      out.push({ id: 'lp-removed', severity: 'medium', params: { addr: removers[0]?.addr ?? null, share: pct(big(liq.totalRemoved), totalAdded), blocks: null, pool: liq.pair, linked: false },
        evidence: [ev('address', liq.pair), ...removers.flatMap((p) => p.removeTxs.slice(0, 2)).slice(0, 4).map((t) => ev('tx', t))] });
    }
    if (totalAdded > 0n && pct(big(liq.totalBurned), totalAdded) >= LP_BURNED) {
      out.push({ id: 'lp-burned', severity: 'good', params: { share: pct(big(liq.totalBurned), totalAdded), pool: liq.pair }, evidence: [ev('address', liq.pair)] });
    }
  }
  if (g.lpHolding && deployer) {
    const share = pct(big(g.lpHolding.balance), big(g.lpHolding.total));
    if (share >= LP_HELD) out.push({ id: 'lp-held', severity: 'medium', params: { addr: deployer, share, pool: liq?.pair ?? g.pair ?? null }, evidence: [ev('address', deployer), ...(liq?.pair ? [ev('address', liq.pair)] : [])] });
  }

  // 5. Who got the token first, and who funded them.
  const walks = g.receiverWalks ?? [];
  const sampled = walks.length;
  const byDeployer = walks.filter((w) => lc(w.start) !== deployer && !linked.has(lc(w.start))
    && w.hops.some((h) => linked.has(lc(h.from)) && !(g.hubs ?? []).includes(lc(h.from))));
  if (byDeployer.length >= 2) {
    out.push({ id: 'holders-funded-by-deployer', severity: 'high', params: { count: byDeployer.length, total: sampled, addr: deployer },
      evidence: byDeployer.slice(0, 6).flatMap((w) => [ev('address', w.start), ...w.hops.filter((h) => h.tx).slice(0, 1).map((h) => ev('tx', h.tx))]) });
  }
  const cluster = (g.clusters ?? []).find((c) => !linked.has(lc(c.source)));
  if (cluster) {
    out.push({ id: 'holders-sybil', severity: 'medium', params: { count: cluster.members.length, total: sampled, addr: cluster.source, hop: cluster.hop },
      evidence: [ev('address', cluster.source), ...cluster.evidence.slice(0, 6).map((t) => ev('tx', t))] });
  }

  // 6. Other parts of the graph that are known.
  const others = new Set();
  for (const c of g.clusters ?? []) others.add(lc(c.source));
  for (const r of g.receivers ?? []) others.add(lc(r.addr));
  for (const p of liq?.providers ?? []) { others.add(lc(p.addr)); for (const r of p.receivers) others.add(lc(r)); }
  const linkedKnown = [...others].filter((a) => known.has(a) && a !== deployer && !trail.some((h) => lc(h.from) === a));
  if (linkedKnown.length) {
    out.push({ id: 'linked-flagged', severity: 'high', params: { count: linkedKnown.length, addr: linkedKnown[0], source: known.get(linkedKnown[0]).source },
      evidence: linkedKnown.slice(0, 5).map((a) => ev('address', a)) });
  }

  // 7. Context (low / info).
  if (g.deployerProfile && !g.deployerProfile.contract && g.deployerProfile.nonce != null && g.deployerProfile.nonce <= FRESH_NONCE && deployer) {
    out.push({ id: 'fresh-deployer', severity: 'low', params: { addr: deployer, nonce: g.deployerProfile.nonce }, evidence: [ev('address', deployer)] });
  }
  if (g.deployerWalk?.stop === 'hub' && trail.length) {
    const last = trail[trail.length - 1];
    out.push({ id: 'funding-from-hub', severity: 'info', params: { addr: last.from, hop: last.hop }, evidence: last.tx ? [ev('tx', last.tx)] : [] });
  }
  if (priors.length) out.push({ id: 'prior-contracts', severity: 'info', params: { count: priors.length, addr: deployer }, evidence: priors.slice(0, 5).map((p) => ev('address', p.addr)) });
  const mintTo = [...new Set((g.mints ?? []).map((m) => lc(m.to)))].filter((a) => a !== deployer && a !== lc(g.pair ?? ''));
  if (mintTo.length >= 3) out.push({ id: 'supply-split', severity: 'info', params: { count: mintTo.length }, evidence: (g.mints ?? []).slice(0, 4).map((m) => ev('tx', m.tx)) });
  if (g.partial) out.push({ id: 'graph-partial', severity: 'info', params: { notes: (g.notes ?? []).slice(0, 6).join(', ') }, evidence: [] });

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Overall level of a signal list: the most serious one ('info' when none). */
export function levelOf(signals) {
  for (const s of ['high', 'medium', 'low']) if (signals.some((x) => x.severity === s)) return s;
  return signals.some((x) => x.severity === 'good') ? 'good' : 'info';
}
