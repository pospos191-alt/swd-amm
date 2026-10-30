// Self-healing demo on the in-memory chain (docs/future/self-healing.md): the same reentrancy drain
// against the same vault, with self-healing OFF, ON with runner trips, and ON with only the on-chain
// invariant cap; prints funds lost/saved, detection latency, false positives on the benign workload.
//   node scripts/selfheal-demo.js [benignBlocks=200] [seed=7]
// Testnet prototype: everything runs locally with throwaway keys.
import { runDemo } from '../test/helpers/selfhealdemo.js';

const benignBlocks = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 7);
const rows = [];
for (const [name, o] of [['off', { selfHealing: false }], ['runners', { mode: 'runners' }], ['invariant (cap 2000/10min)', { mode: 'invariant', cap: 2000 }], ['invariant (tight cap 600/10min)', { mode: 'invariant', cap: 600 }]]) {
  const r = await runDemo({ ...o, benignBlocks, seed });
  rows.push({
    run: name, vaultAtRisk: r.vaultBeforeZeta, lost: r.lossZeta, attacksOk: r.attack.ok, attacksStopped: r.attack.reverted,
    trip: r.tripKind ?? '-', latencyBlocks: r.latencyBlocks == null ? '-' : r.latencyBlocks < 0 ? 'before attack (false trip)' : r.latencyBlocks, heldOutflows: r.heldCount,
    blocksScanned: r.evaluatedBenign || '-', zScoreOnlyAlerts: r.benignOutliers, falseTrips: r.falseTrips,
    honestWithdrawsOk: `${r.attack.honest.ok}/${r.attack.honest.ok + r.attack.honest.failed}`,
  });
}
const off = rows[0].lost;
for (const r of rows) r.saved = r.run === 'off' ? '-' : Math.round((off - r.lost) * 100) / 100;
console.table(rows);
