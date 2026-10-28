// Turns investigation reports into GitHub issues labelled `neuro-alert`:
// which ones to open (dedupe, threshold, throttle) and what they say. Pure
// functions; agent/scan-pools.js does the network part.
//
// Issues only hold values Neuro checked itself: chain keys, hex addresses,
// transaction hashes, finding / signal ids, levels and numbers. No token
// names, no model text, nothing a token's author wrote.
import { levelRank } from './pipeline.js';
import { signalText } from '../graph/i18n.js';

export const ALERT_LABEL = 'neuro-alert';
const MARK = /<!-- neuro-alert-key: ([a-z0-9-]{1,32}:[0-9a-zA-Z]{20,64}) -->/;

/** One key per target, the same however the address is written. */
export const alertKey = (chain, address) => `${String(chain).toLowerCase()}:${/^0x/i.test(address) ? address.toLowerCase() : address}`;

/** The key an existing issue carries (in a hidden marker in its body), or null. */
export const keyOfIssue = (issue) => MARK.exec(String(issue?.body ?? ''))?.[1] ?? null;

/** Is this report worth an alert? Default: level high with a confidence of at least 0.5. */
export const shouldAlert = (report, { minLevel = 'high', minConfidence = 0.5 } = {}) =>
  levelRank(report.level) >= levelRank(minLevel) && report.confidence >= minConfidence;

/**
 * @param {object[]} reports      investigation reports (agent/pipeline.js)
 * @param {object[]} existing     issues already labelled neuro-alert (open and closed): { body, created_at }
 * @param {{maxPerRun?: number, maxPerDay?: number, now?: number, minLevel?: string, minConfidence?: number}} [o]
 * @returns {{ create: object[], skipped: Array<{key, reason}> }}
 *   reasons: 'below-threshold', 'duplicate' (an issue exists, open or closed), 'repeat' (twice in this run), 'throttled'
 */
export function planAlerts(reports, existing, { maxPerRun = 3, maxPerDay = 10, now = Date.now(), minLevel, minConfidence } = {}) {
  const have = new Set(existing.map(keyOfIssue).filter(Boolean));
  const dayAgo = now - 24 * 3600_000;
  let today = existing.filter((i) => Date.parse(i.created_at ?? '') >= dayAgo).length;
  const create = [];
  const skipped = [];
  const seen = new Set();
  // Most serious first, so throttling drops the least serious.
  const ordered = [...reports].sort((a, b) => levelRank(b.level) - levelRank(a.level) || b.score - a.score || b.confidence - a.confidence);
  for (const r of ordered) {
    const key = alertKey(r.target.chain, r.target.address);
    if (!shouldAlert(r, { minLevel, minConfidence })) { skipped.push({ key, reason: 'below-threshold' }); continue; }
    if (have.has(key)) { skipped.push({ key, reason: 'duplicate' }); continue; }
    if (seen.has(key)) { skipped.push({ key, reason: 'repeat' }); continue; }
    if (create.length >= maxPerRun || today >= maxPerDay) { skipped.push({ key, reason: 'throttled' }); continue; }
    seen.add(key);
    today++;
    create.push(r);
  }
  return { create, skipped };
}

const HEXISH = /^(0x[0-9a-f]{40}|0x[0-9a-f]{64})$/;
const cell = (v) => String(v ?? '').replace(/[|`\r\n<>@]/g, ' ').slice(0, 80);

/** Issue title and body for one report. `explorer(chain, value, kind)` -> https link or null. */
export function issueFor(report, { explorer = () => null, repoNote = '' } = {}) {
  const { chain, address } = report.target;
  const key = alertKey(chain, address);
  const link = (v, kind) => { const u = explorer(chain, v, kind); return u && /^https:\/\/[^\s()<>]+$/.test(u) ? `[\`${v}\`](${u})` : `\`${v}\``; };
  const lines = [];
  lines.push(`Neuro's scheduled scan of new pools on ZETAPHY found a **${report.level}** result for \`${address}\` on \`${chain}\` (score ${report.score}/100, confidence ${report.confidence}).`);
  lines.push('');
  lines.push('| Step | Status |');
  lines.push('|---|---|');
  for (const s of report.steps) lines.push(`| ${cell(s.name)} | ${cell(s.status)} |`);
  lines.push('');
  lines.push('**Signals (high and medium):**');
  lines.push('');
  for (const s of report.signals.filter((x) => x.severity === 'high' || x.severity === 'medium').slice(0, 15)) {
    const text = s.source === 'graph' ? ` — ${cell(signalText(s, 'en')).replace(/\s+/g, ' ')}` : '';
    const ev = (s.evidence ?? []).filter((e) => HEXISH.test(String(e.value))).slice(0, 4).map((e) => link(e.value, e.kind)).join(', ');
    lines.push(`- \`${cell(s.source)}/${cell(s.id)}\` (${cell(s.severity)})${text}${ev ? ` · evidence: ${ev}` : ''}`);
  }
  lines.push('');
  lines.push(`Contract: ${link(address, 'address')} · report \`${report.reportHash.slice(0, 16)}\`${report.rules?.reportHash ? ` · rules report \`${String(report.rules.reportHash).slice(0, 16)}\`` : ''}`);
  lines.push('');
  lines.push(`Re-check: \`cd zetaphy-neuro && node agent/cli.js investigate ${chain} ${address}\``);
  lines.push('');
  lines.push('_Automated, reproducible analysis of public chain data: what the code and the money flow show, not an accusation against any person or project. The contract owner can respond or ask for a correction (see `docs/LEGAL.md`)._');
  if (repoNote) lines.push('', repoNote);
  lines.push('', `<!-- neuro-alert-key: ${key} -->`);
  return { title: `Neuro alert: ${report.level} result for ${address.slice(0, 10)}… on ${chain}`, body: lines.join('\n'), labels: [ALERT_LABEL] };
}
