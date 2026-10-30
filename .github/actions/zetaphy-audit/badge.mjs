#!/usr/bin/env node
// The zetaphy-audit Action's last step (action.yml): the automated-only ("SCANNED") badge from `report.js --json`,
// the step outputs, and the gate. No npm install: zetaphy-hub/aas-core.js has no dependencies.
//   node badge.mjs <summary.json> <badge.svg> <fail-on: critical|high|none>
// Prints `key=value` lines for $GITHUB_OUTPUT; exits 1 when the gate fails. This badge is NOT a certificate:
// a certificate needs an AuditNetwork order (docs/future/audit-as-a-service.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scanBadge } from '../../../zetaphy-hub/aas-core.js';

export function badgeStep(summary, failOn = 'high') {
  if (!['critical', 'high', 'none'].includes(failOn)) throw new Error('fail-on: critical, high or none');
  const b = scanBadge(summary);
  const inv = summary?.invariants ?? {};
  const failed = failOn === 'none' ? false : failOn === 'critical' ? b.critical > 0 : b.critical + b.high > 0;
  const outputs = { status: b.status, critical: b.critical, high: b.high, 'invariants-failed': Number(inv.failed ?? 0), commit: String(summary?.commit ?? ''), gate: failed ? 'failed' : 'passed' };
  return { svg: b.svg, outputs, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [summaryPath, badgePath, failOn = 'high'] = process.argv.slice(2);
  const r = badgeStep(JSON.parse(readFileSync(summaryPath, 'utf8')), failOn);
  writeFileSync(badgePath, r.svg);
  for (const [key, v] of Object.entries(r.outputs)) process.stdout.write(`${key}=${String(v).replace(/[\r\n]/g, ' ')}\n`);
  if (r.failed) {
    process.stderr.write(`::error::zetaphy-audit: ${r.outputs.critical} critical and ${r.outputs.high} high finding(s) open (fail-on: ${failOn})\n`);
    process.exitCode = 1;
  }
}
