// Constant-product math, the same as ZetaphyRouter (0.3% fee), for quotes,
// price impact and slippage limits shown before anything is signed.

export const FEE_NUM = 997n;
export const FEE_DEN = 1000n;

export function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const x = amountIn * FEE_NUM;
  return (x * reserveOut) / (reserveIn * FEE_DEN + x);
}

export function getAmountIn(amountOut, reserveIn, reserveOut) {
  if (amountOut <= 0n || reserveIn <= 0n || amountOut >= reserveOut) return null;
  return (reserveIn * amountOut * FEE_DEN) / ((reserveOut - amountOut) * FEE_NUM) + 1n;
}

/** The fewest tokens accepted: amount less `bps` hundredths of a percent (rounded down). */
export const minWithSlippage = (amount, bps) => (amount * (10000n - BigInt(bps))) / 10000n;
/** The most tokens spent: amount plus `bps` (rounded up). */
export const maxWithSlippage = (amount, bps) => (amount * (10000n + BigInt(bps)) + 9999n) / 10000n;

/**
 * Price impact of a trade along hops [{ amountIn, amountOut, reserveIn, reserveOut }],
 * in basis points, not counting the 0.3% fee: how much worse than the pools'
 * current (mid) price the trade executes because it moves the price.
 */
export function priceImpactBps(hops) {
  // Executed / mid for each hop, multiplied: out * rIn / (in * 0.997 * rOut).
  let num = 1n, den = 1n;
  for (const h of hops) {
    if (h.amountIn <= 0n || h.reserveOut <= 0n) return 0n;
    num *= h.amountOut * h.reserveIn * FEE_DEN;
    den *= h.amountIn * h.reserveOut * FEE_NUM;
  }
  const ratio = (num * 10000n) / den;
  return ratio >= 10000n ? 0n : 10000n - ratio;
}

/** Impact levels the UI colours: <1% fine, <5% warn, otherwise high (and >=15% needs a confirmation). */
export function impactLevel(bps) {
  if (bps < 100n) return 'low';
  if (bps < 500n) return 'medium';
  if (bps < 1500n) return 'high';
  return 'severe';
}

/** Amount of B for amountA at the pool's price (for adding liquidity). */
export const quote = (amountA, reserveA, reserveB) => (reserveA > 0n ? (amountA * reserveB) / reserveA : 0n);

/** Candidate paths from `a` to `b`: direct, then through the wrapped native coin. */
export function candidatePaths(a, b, wnative) {
  const lc = (x) => x.toLowerCase();
  const paths = [[a, b]];
  if (lc(a) !== lc(wnative) && lc(b) !== lc(wnative)) paths.push([a, wnative, b]);
  return paths;
}

/** Integer square root (LP of a first deposit: sqrt(a*b) - 1000). Same as ZetaphyPair._sqrt. */
export function sqrt(y) {
  // y = 2 or 3: the Babylonian step below would stop at 2 for y = 2 (the pair returns 1).
  if (y < 4n) return y === 0n ? 0n : 1n;
  let z = y, x = y / 2n + 1n;
  while (x < z) { z = x; x = (y / x + x) / 2n; }
  return z;
}

/**
 * How the page treats a pool when adding liquidity (security finding M3):
 *   'new':      no pair, or a pair with no reserves and no LP: the user sets the price;
 *   'unseeded': a pair with reserves but no LP minted (someone donated tokens and
 *               called sync): still a new pool, and the page warns. The router takes
 *               the desired amounts as given while totalSupply is 0, so the
 *               donation cannot set the first LP's price;
 *   'live':     LP exists: amounts follow the pool's price.
 * `pool` is { reserveA, reserveB } or null; `totalSupply` the pair's LP supply.
 */
export function poolKind(pool, totalSupply) {
  if (!pool) return 'new';
  const any = pool.reserveA > 0n || pool.reserveB > 0n;
  if (totalSupply === 0n) return any ? 'unseeded' : 'new';
  return pool.reserveA > 0n && pool.reserveB > 0n ? 'live' : 'new';
}

/** addLiquidity's minimums: the desired amounts themselves unless the pool is 'live' (then less slippage). */
export const addLiquidityMins = (amountA, amountB, kind, bps) =>
  (kind === 'live' ? [minWithSlippage(amountA, bps), minWithSlippage(amountB, bps)] : [amountA, amountB]);
