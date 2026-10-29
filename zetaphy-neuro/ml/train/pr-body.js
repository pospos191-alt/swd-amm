#!/usr/bin/env node
// Markdown body for the weekly "new model candidate" pull request.
//   node ml/train/pr-body.js <candidate metrics.json> [red-team report.json] [fresh red-team report.json] [public-sources.json]

import { readFileSync, existsSync } from 'node:fs';

const read = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const [metricsPath, rtPath, freshPath, pubPath] = process.argv.slice(2);
const m = read(metricsPath);
if (!m) { console.error('usage: pr-body.js <metrics.json> [redteam.json] [fresh.json] [public-sources.json]'); process.exit(2); }
const rt = read(rtPath);
const fresh = read(freshPath);
const pub = read(pubPath);
const cur = m.current?.heldOut?.model ?? {};
const cand = m.heldOut.model;
const row = (name, k) => `| ${name} | ${cur[k] ?? '-'} | ${cand[k] ?? '-'} |`;
const pct = (a, n) => (n ? `${Math.round((a / n) * 100)}%` : '-');

const lines = [
  `Weekly Neuro ML run proposes model \`${m.modelId}\` (${m.bytes} bytes, ${m.trees} trees, ${m.features} features).`,
  '',
  `**Decision:** ${m.decision.why}. Nothing is deployed until a person merges this.`,
  '',
  '### Held-out set (same rows for both models)',
  '',
  `| metric | current \`${m.current?.modelId ?? 'none'}\` | candidate |`, '|---|---:|---:|',
  row('AUC', 'auc'), row('recall @ 1% FPR', 'recallAt1Fpr'), row('recall @ 5% FPR', 'recallAt5Fpr'), row('Brier', 'brier'), row('ECE', 'ece'),
  '',
  `Code-only (market facts removed) AUC ${m.heldOut.codeOnly.auc}, recall @ 1% FPR ${m.heldOut.codeOnly.recallAt1Fpr}. Rules alone AUC ${m.heldOut.rulesOnly.auc}.`,
  `"Medium or higher" alarm: rules recall ${m.heldOut.alarm.rules.recall} / FPR ${m.heldOut.alarm.rules.fpr}; with the model recall ${m.heldOut.alarm.combined.recall} / FPR ${m.heldOut.alarm.combined.fpr}. Rows lowered by the model: ${m.heldOut.loweredByModel} (must be 0).`,
  '',
  `Data: ${m.data.rows} rows (${Object.entries(m.data.sources).map(([k, v]) => `${k} ${v}`).join(', ')}).`,
];
if (m.leaveFamilyOut) {
  lines.push('', '### Leave-one-scam-family-out (harder: the family is never seen in training)', '', '| family | recall @ 1% FPR | rules alarm | rules + model alarm |', '|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(m.leaveFamilyOut)) lines.push(`| ${k} | ${v.recallAt1Fpr} | ${v.rulesAlarm} | ${v.combinedAlarm} |`);
}
for (const [title, r] of [['Red team against the current model (new evasions were added to the training data)', rt], ['Fresh red team against the candidate (not trained on)', fresh]]) {
  if (!r) continue;
  lines.push('', `### ${title}`, '', `Seed \`${r.seed}\`: ${r.total} scam variants; caught by rules + simulation ${pct(r.caughtRules, r.total)}, with the model ${pct(r.caughtCombined, r.total)}; evasions ${r.evasions.length}.`);
}
if (pub) {
  lines.push('', '### Public data', '', '| source | licence | listed | rows | note |', '|---|---|---:|---:|---|');
  for (const s of pub) lines.push(`| ${s.repo} | ${s.license ?? '?'} | ${s.listed ?? '-'} | ${s.rows ?? 0} | ${s.skipped ?? ''} |`);
}
lines.push('', '> All numbers come from synthetic tokens built by Neuro\'s own generators (and synthetic market facts), so they are optimistic for real contracts. The model can only raise the level the rules show, and is never part of the network verdict.');
console.log(lines.join('\n'));
