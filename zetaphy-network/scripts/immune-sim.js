#!/usr/bin/env node
// The immune network end to end on simulated chains (test/helpers/immunesim.js) plus the seeded latency model
// over every covered chain (src/immune/propagate.js simulate). Prints simulated seconds per stage.
//   node scripts/immune-sim.js [--source sepolia] [--trials 500] [--json report.json]
import { writeFileSync } from 'node:fs';
import { runScenario } from '../test/helpers/immunesim.js';
import { simulate } from '../src/immune/propagate.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const s = await runScenario({ log: (m) => console.log(`  ${m}`) });
const model = simulate({ source: opt('--source', 'sepolia'), trials: Number(opt('--trials', 500)) });
const report = {
  e2e: { stages: s.stages, mirrors: s.mirrors, routerB: s.routerB, clone: s.clone, falseFlag: { ...s.falseFlag, slashed: s.falseFlag.slashed.map((x) => ({ ...x, before: String(x.before), after: String(x.after) })) }, gas: s.gas, median: s.median },
  model,
};
console.log(`\nend to end (simulated seconds): detect ${s.stages.detect} · agree ${s.stages.agree} · registry ${s.stages.registry} · mirror B ${s.mirrors.B.total} · mirror C ${s.mirrors.C.total} (median ${s.median})`);
console.log(`model, attack on ${model.source} (${model.trials} trials): median ${model.median}s, p90 ${model.p90}s; stages ${JSON.stringify(model.stages)}`);
for (const c of model.perChain) console.log(`  ${c.key.padEnd(16)} ${c.mirror.padEnd(9)} median ${String(c.median).padStart(5)}s  p90 ${String(c.p90).padStart(5)}s`);
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(report, null, 1) + '\n');
