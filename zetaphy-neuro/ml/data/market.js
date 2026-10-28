// Synthetic market facts for synthetic tokens (holder concentration,
// liquidity lock, liquidity, age, verified source, holders).
//
// HONEST WARNING: these are drawn from made-up distributions that differ by
// label (scams skew to young, concentrated, unlocked, unverified). A model
// trained on them learns those made-up differences, so metrics that use
// market features are optimistic. ml/train/train.js therefore also reports
// "code-only" metrics with every market fact removed.

/** @param {object} R seeded rng; @param {0|1} label */
export function syntheticMarket(R, label) {
  if (R.bool(0.35)) return null; // many reads have no market data at all
  const m = {};
  const skew = (p) => R.float() ** p;
  if (R.bool(0.8)) m.topHolderShare = label ? 0.08 + 0.85 * skew(0.6) : 0.01 + 0.6 * skew(1.6);
  if (R.bool(0.6)) m.top10Share = Math.min(1, (m.topHolderShare ?? 0.1) + (label ? 0.4 : 0.3) * R.float());
  if (R.bool(0.7)) m.lpLocked = R.bool(label ? 0.35 : 0.6);
  if (R.bool(0.7)) m.liquidityUsd = Math.round(10 ** (label ? 2 + 3 * R.float() : 2.5 + 4 * R.float()));
  if (R.bool(0.8)) m.ageDays = Math.round(label ? 60 * skew(1.5) : 900 * skew(1.2));
  if (R.bool(0.7)) m.verified = R.bool(label ? 0.3 : 0.65) ? 1 : 0;
  if (R.bool(0.6)) m.holders = Math.round(10 ** (label ? 1 + 2.5 * R.float() : 1.5 + 3.5 * R.float()));
  return m;
}
