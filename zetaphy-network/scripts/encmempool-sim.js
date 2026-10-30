#!/usr/bin/env node
// Deterministic simulation of the post-quantum threshold-encrypted mempool
// (src/encmempool, docs/future/encrypted-mempool.md): a searcher tries to sandwich a
// victim swap on a constant-product AMM with a plaintext mempool and with the
// encrypted lane, under collusion and share-withholding scenarios. All crypto is
// real (X-Wing dealings, Shamir t-of-n, ML-DSA-44 signed releases); randomness is a
// seeded stream, so every run prints the same table.
//
//   node scripts/encmempool-sim.js            # n = 4 and 21
//   node scripts/encmempool-sim.js 4 21 100   # any committee sizes (n = 100 adds ~15 s)

import { standardScenarios, blindSandwichEV, DEFAULT_MARKET as M, fmtA, fmtB } from '../src/encmempool/sim.js';

const sizes = process.argv.slice(2).map(Number).filter((x) => x > 0);
const ns = sizes.length ? sizes : [4, 21];
const price = Number(M.poolA) / Number(M.poolB); // A per B at the start

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.f(r)).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(w[i])).join(' | ') + ' |';
  console.log(line(cols.map((c) => c.h)));
  console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
  for (const r of rows) console.log(line(cols.map((c) => c.f(r))));
}

console.log(`Market: pool ${fmtA(M.poolA)} A / ${fmtB(M.poolB)} B (0.30% fee), victim swaps ${fmtA(M.victimIn)} A -> B with ${Number(M.slippageBps) / 100}% slippage tolerance,`);
console.log(`searcher gas ${fmtA(M.gasCost)} A per tx. Encrypted lane: target height 1, batch = [victim, junk envelope], ttl 3 blocks.\n`);

for (const n of ns) {
  const t0 = performance.now();
  const rows = standardScenarios(n);
  console.log(`n = ${n}, t = ${rows[1].t}, dealers d = ${rows[1].d}   (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  table(rows, [
    { h: 'scenario', f: (r) => r.name },
    { h: 'searcher reads victim early', f: (r) => (r.earlyDecrypt ? 'YES' : 'no') },
    { h: 'victim executed', f: (r) => (r.expired ? `expired @${r.expiredAt}` : `block ${r.executedAt}`) },
    { h: 'victim out (B)', f: (r) => fmtB(r.victimOut) },
    { h: 'victim loss (≈A)', f: (r) => fmtA(BigInt(Math.round(Number(r.victimLoss) * price))) },
    { h: 'searcher profit (A)', f: (r) => fmtA(r.searcherProfit) },
    { h: 'victim incl. fee (ZETAPHY)', f: (r) => (r.inclusionFee ? (Number(r.inclusionFee) / 1e18).toFixed(7) : '-') },
    { h: 'junk skipped', f: (r) => (r.mode === 'plain' ? '-' : r.garbageSkipped ? 'yes' : '-') },
    { h: 'envelope bytes', f: (r) => r.envelopeBytes || '-' },
  ]);
  console.log('');
}

console.log('Blind sandwich (encrypted lane, searcher cannot read the victim): 2000 seeded random victims,');
console.log('direction 50/50, size 1k–100k A, slippage 0.3–3%. "informed" = same victims with a plaintext mempool.');
table([5_000n, 20_000n, 60_000n].map((f) => blindSandwichEV({ front: f * 10n ** 6n })), [
  { h: 'blind front (A)', f: (r) => fmtA(r.front) },
  { h: 'mean profit blind (A)', f: (r) => fmtA(r.meanProfit) },
  { h: 'win rate', f: (r) => `${(r.winRate * 100).toFixed(1)}%` },
  { h: 'victims reverted', f: (r) => `${(r.victimRevertRate * 100).toFixed(1)}%` },
  { h: 'mean profit informed (A)', f: (r) => fmtA(r.informedMeanProfit) },
]);
