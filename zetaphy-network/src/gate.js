// Gate 1 check (plan: before stage 1 -> 2): the chain ran 30 days with no
// stalled blocks, and at least 10 independent people run Neuro.
// Reads only public chain data. "Independent people" cannot be proven
// on-chain (one person can hold many addresses), so the address count is an
// upper bound that a human still has to confirm.

export const GATE1 = { days: 30, runners: 10, blockSeconds: 5, maxGapSeconds: 60 };

/**
 * @param {import('ethers').Provider} provider
 * @param {import('ethers').Contract} jobs  NeuroJobs (read-only is fine)
 * @param {{sampleEvery?: number, logChunk?: number}} [o]
 */
export async function gate1(provider, jobs, { sampleEvery = 2000, logChunk = 1000, gate = GATE1 } = {}) {
  const latest = await provider.getBlock('latest');
  const first = await provider.getBlock(1);
  const days = (latest.timestamp - first.timestamp) / 86400;

  // Stalls: sample block times every `sampleEvery` blocks; a stall shows up as
  // a sample interval much longer than sampleEvery x block time.
  let worstGap = 0;
  let prev = first;
  for (let h = 1 + sampleEvery; h <= latest.number; h += sampleEvery) {
    const b = await provider.getBlock(h);
    worstGap = Math.max(worstGap, (b.timestamp - prev.timestamp) - sampleEvery * gate.blockSeconds);
    prev = b;
  }
  if (prev.number !== latest.number) {
    worstGap = Math.max(worstGap, (latest.timestamp - prev.timestamp) - (latest.number - prev.number) * gate.blockSeconds);
  }

  // Runners: addresses that revealed at least one verdict in the window.
  const since = Math.max(0, latest.number - Math.ceil((gate.days * 86400) / gate.blockSeconds));
  const filter = jobs.filters.Revealed();
  const runners = new Set();
  for (let from = since; from <= latest.number; from += logChunk) {
    const logs = await jobs.queryFilter(filter, from, Math.min(from + logChunk - 1, latest.number));
    for (const l of logs) runners.add(l.args.worker.toLowerCase());
  }

  const checks = [
    { name: `running ${gate.days}+ days`, ok: days >= gate.days, value: `${days.toFixed(1)} days` },
    { name: 'no stalled blocks', ok: worstGap <= gate.maxGapSeconds, value: `worst extra gap ~${Math.max(0, Math.round(worstGap))} s (sampled)` },
    { name: `${gate.runners}+ runners revealing verdicts`, ok: runners.size >= gate.runners, value: `${runners.size} addresses (confirm they are different people)` },
  ];
  return { passed: checks.every((c) => c.ok), checks, height: latest.number };
}
