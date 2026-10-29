// Walks a funding trail backwards: who first sent native coin to an address,
// who funded that one, and so on, for at most `maxHops` hops.
//
// The walk stops (and says why) when:
//   'origin'  no earlier funder is known (a genesis/mining address, or data ran out)
//   'hub'     the funder is a busy service (exchange, bridge, contract): its
//             own funding says nothing about this address
//   'cycle'   the funder is already on this trail (A funded B funded A)
//   'hops'    maxHops reached
//   'budget'  the request / time budget ran out (graph/util.js)
//   'error'   a source failed (the trail so far is still returned)
import { BudgetError, lc } from './util.js';

/**
 * Shared memo for walks in one graph build, so the receivers of a token who
 * share a funder cost one lookup, not one each.
 */
export function createWalkMemo() {
  return { funder: new Map(), profile: new Map() };
}

async function memo(map, key, fn) {
  if (map.has(key)) return map.get(key);
  const p = fn();
  map.set(key, p);
  try { return await p; } catch (e) { map.delete(key); throw e; }
}

/**
 * @param {string} start
 * @param {object} p
 * @param {(addr:string) => Promise<{funder:string, tx?:string, value?:string, block?:number, via?:string}|null>} p.funderOf
 * @param {(addr:string) => Promise<{hub?:boolean, contract?:boolean, nonce?:number}>} p.profile
 * @param {number} [p.maxHops=3]
 * @param {ReturnType<createWalkMemo>} [p.memo]
 * @returns {Promise<{start, hops:Array<{from,to,tx,value,block,via,hop}>, origin:string, stop:string, error?:string}>}
 */
export async function walkFunding(start, { funderOf, profile, maxHops = 3, memo: m = createWalkMemo() }) {
  const s = lc(start);
  const hops = [];
  const seen = new Set([s]);
  let cur = s;
  let stop = 'hops';
  let error;
  try {
    for (let hop = 1; hop <= maxHops; hop++) {
      const f = await memo(m.funder, cur, () => funderOf(cur));
      if (!f || !f.funder) { stop = 'origin'; break; }
      const from = lc(f.funder);
      hops.push({ from, to: cur, tx: f.tx ?? null, value: f.value ?? null, block: f.block ?? null, via: f.via ? lc(f.via) : null, hop });
      if (seen.has(from)) { stop = 'cycle'; break; }
      seen.add(from);
      const prof = await memo(m.profile, from, () => profile(from));
      if (prof?.hub) { stop = 'hub'; break; }
      cur = from;
    }
  } catch (e) {
    stop = e instanceof BudgetError ? 'budget' : 'error';
    error = String(e?.message ?? e).slice(0, 200);
  }
  const origin = hops.length ? hops[hops.length - 1].from : s;
  return { start: s, hops, origin, stop, ...(error ? { error } : {}) };
}

/** The addresses on a trail that funded `start` (nearest first), with the hop each sits at. */
export const ancestorsOf = (walk) => walk.hops.map((h) => ({ addr: h.from, hop: h.hop }));
