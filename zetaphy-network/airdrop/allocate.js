// Splits the SWD airdrop pool (200,000,000 ZETAPHY at genesis) pro-rata to
// a snapshot. Integer math only; rounding dust is reported, never lost.

export const POOL = 200_000_000n * 10n ** 18n; // azetaphy

/**
 * @param {{holders: Array<{owner: string, amount: string}>}} snapshot
 * @param {object} [o]
 * @param {bigint} [o.pool]       azetaphy to share
 * @param {bigint} [o.minAmount]  SWD base units a holder needs to qualify (dust filter)
 * @param {number} [o.capBps]     most any one holder can get, in basis points of the pool (whales); 10000 = no cap
 */
export function allocate(snapshot, { pool = POOL, minAmount = 1n, capBps = 10_000 } = {}) {
  const eligible = snapshot.holders.map((h) => ({ owner: h.owner, amount: BigInt(h.amount) })).filter((h) => h.amount >= minAmount);
  const cap = (pool * BigInt(capBps)) / 10_000n;
  // Water-filling: capped holders get the cap; the rest shares what is left, pro-rata.
  let capped = new Set();
  for (;;) {
    const free = eligible.filter((h) => !capped.has(h.owner));
    const left = pool - cap * BigInt(capped.size);
    const total = free.reduce((s, h) => s + h.amount, 0n);
    const over = total === 0n ? [] : free.filter((h) => (left * h.amount) / total > cap);
    if (!over.length) {
      const out = eligible.map((h) => ({ owner: h.owner, swd: h.amount.toString(),
        zetaphy: (capped.has(h.owner) ? cap : total === 0n ? 0n : (left * h.amount) / total).toString() }));
      const given = out.reduce((s, a) => s + BigInt(a.zetaphy), 0n);
      return { pool: pool.toString(), holders: out.length, dust: (pool - given).toString(), allocations: out };
    }
    for (const h of over) capped.add(h.owner);
  }
}
