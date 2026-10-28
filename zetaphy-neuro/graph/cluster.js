// Groups wallets by a shared funding source ("sybil holders"): wallets whose
// funding trails meet at the same address, that is not a busy service
// (exchange, bridge, contract). Thousands of unrelated people withdraw from
// the same exchange, so a hub never links anyone.
import { lc } from './util.js';

/**
 * @param {Array<{start:string, hops:Array<{from:string, hop:number, tx?:string}>}>} walks  one per wallet
 * @param {{hubs?: Set<string>, minSize?: number, ignore?: Set<string>}} [opts]
 *   hubs: busy addresses that never link wallets; ignore: addresses that are
 *   not "wallets" here (the token, its pools, burn addresses)
 * @returns {Array<{source:string, hop:number, members:string[], evidence:string[]}>}
 *   largest first; `source` is the nearest shared funder, `hop` the deepest
 *   hop any member needed to reach it, `evidence` the funding transactions
 */
export function clusterByFunder(walks, { hubs = new Set(), minSize = 3, ignore = new Set() } = {}) {
  const members = walks.filter((w) => !ignore.has(lc(w.start)));
  const parent = new Map(members.map((w) => [lc(w.start), lc(w.start)]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // ancestor -> [{wallet, hop}]
  const byAncestor = new Map();
  for (const w of members) {
    const me = lc(w.start);
    for (const h of w.hops) {
      const a = lc(h.from);
      if (hubs.has(a) || ignore.has(a) || a === me) break; // past a hub, nothing links
      if (!byAncestor.has(a)) byAncestor.set(a, []);
      const list = byAncestor.get(a);
      if (!list.some((x) => x.wallet === me)) list.push({ wallet: me, hop: h.hop });
    }
  }
  // A funder that is itself one of the wallets links to it too.
  for (const [a, list] of byAncestor) {
    if (parent.has(a)) for (const x of list) union(a, x.wallet);
    for (let i = 1; i < list.length; i++) union(list[0].wallet, list[i].wallet);
  }

  const groups = new Map();
  for (const w of parent.keys()) {
    const r = find(w);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(w);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length < minSize) continue;
    const set = new Set(group);
    // The shared source: the ancestor reaching most members, then the nearest.
    let best = null;
    for (const [a, list] of byAncestor) {
      const inGroup = list.filter((x) => set.has(x.wallet));
      if (inGroup.length < 2 && !set.has(a)) continue;
      const reach = inGroup.length + (set.has(a) ? 1 : 0);
      const hop = Math.max(0, ...inGroup.map((x) => x.hop));
      if (!best || reach > best.reach || (reach === best.reach && hop < best.hop) || (reach === best.reach && hop === best.hop && a < best.source)) {
        best = { source: a, reach, hop };
      }
    }
    if (!best) continue;
    const evidence = [];
    for (const w of members) {
      if (!set.has(lc(w.start))) continue;
      for (const h of w.hops) {
        if (h.tx && !evidence.includes(h.tx)) evidence.push(h.tx);
        if (lc(h.from) === best.source) break;
      }
    }
    out.push({ source: best.source, hop: best.hop, members: group.sort(), evidence: evidence.slice(0, 12) });
  }
  return out.sort((a, b) => b.members.length - a.members.length || (a.source < b.source ? -1 : 1));
}
