// ThreatRegistry.Reason (zetaphy-network/contracts/ThreatRegistry.sol), by its
// number: what the code does, or did in a reproducible test. Never a claim about
// intent. The same list as zetaphy-network/src/vaccine.js REASONS (a test there
// checks it). A threatLookup that reads the registry turns the number it gets
// into one of these codes with reasonCode(n); the src/lang/*.js REASON maps
// describe each code.
export const THREAT_REASONS = ['none', 'cannot-sell-in-simulation', 'unlimited-mint', 'owner-can-block-transfers',
  'owner-can-move-holder-funds', 'same-name-as-known-token', 'sweeps-approved-tokens', 'other'];

/** Reason number -> code ('other' for a number this code does not know, undefined for 0 / none). */
export function reasonCode(n) {
  const i = Number(n);
  if (!Number.isInteger(i) || i <= 0) return undefined;
  return THREAT_REASONS[i] ?? 'other';
}
