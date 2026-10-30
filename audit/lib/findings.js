// Turns each tool's raw output into one list of findings with one severity
// scale (critical / high / medium / low / info) and a stable id.
//
// The id ("fingerprint") is   <tool>:<rule>:<file>:<12 hex>
// where the hex is a hash of the tool, rule, file and the TEXT of the flagged
// line (whitespace collapsed) plus the tool's own description with line
// numbers removed. Adding lines above a finding does not change its id;
// editing the flagged line itself does (and the finding must be looked at
// again, which is the point). Two identical findings in one file get #2, #3.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const rank = (s) => SEVERITIES.indexOf(s);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Removes line references (#12, #L3-L9, :42) and absolute paths from tool text. */
export const stripLines = (s) => norm(s).replace(/#L?\d+(-L?\d+)?/g, '').replace(/\.(sol|go):\d+(:\d+)?/g, '.$1').replace(/\/[^\s()]*\/(?=[\w-]+\.(sol|go)\b)/g, '');

export function fingerprint({ tool, rule, file, lineText, detail }) {
  const h = createHash('sha256').update([tool, rule, file ?? '', norm(lineText), stripLines(detail)].join('\u0000')).digest('hex').slice(0, 12);
  return `${tool}:${rule}:${file ?? '-'}:${h}`;
}

/** Gives every finding its id; identical ones in a file are numbered in line order. */
export function assignIds(findings, lineOf) {
  const count = new Map();
  const sorted = [...findings].sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  for (const f of sorted) {
    const base = fingerprint({ ...f, lineText: f.lineText ?? lineOf(f.file, f.line) });
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    f.id = n === 1 ? base : `${base}#${n}`;
  }
  return findings;
}

/** Removes exact duplicates (the same issue reported by overlapping runs). */
export function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = [f.tool, f.rule, f.file, f.line, stripLines(f.detail)].join('|');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ---------------------------------------------------------------- Solidity

/** Slither --json. Paths in it are relative to the project root it ran in. */
export function parseSlither(json, projectRoot, isExcluded) {
  const out = [];
  for (const r of json?.results?.detectors ?? []) {
    const el = (r.elements ?? []).find((e) => e.source_mapping?.filename_relative) ?? {};
    const sm = el.source_mapping ?? {};
    const rel = sm.filename_relative;
    if (!rel || isExcluded(rel) || /(^|\/)(vendor|node_modules|lib)\//.test(rel)) continue;
    const impact = r.impact;
    let severity = { High: 'high', Medium: 'medium', Low: 'low' }[impact] ?? 'info';
    // a High-impact detector with Low confidence is a lead, not a verdict
    if (severity === 'high' && r.confidence === 'Low') severity = 'medium';
    out.push({
      tool: 'slither', rule: r.check, severity, confidence: r.confidence?.toLowerCase(),
      file: `${projectRoot}/${rel}`, line: sm.lines?.[0] ?? null,
      title: r.check, detail: norm(r.description).slice(0, 600),
    });
  }
  return out;
}

/** Aderyn JSON report (high_issues / low_issues). */
export function parseAderyn(json, projectRoot, isExcluded) {
  const out = [];
  for (const [key, severity] of [['high_issues', 'high'], ['low_issues', 'low']]) {
    for (const issue of json?.[key]?.issues ?? []) {
      for (const i of issue.instances ?? []) {
        if (isExcluded(i.contract_path) || /(^|\/)(vendor|node_modules|lib)\//.test(i.contract_path)) continue;
        out.push({
          tool: 'aderyn', rule: issue.detector_name, severity, file: `${projectRoot}/${i.contract_path}`, line: i.line_no ?? null,
          title: issue.title, detail: norm(`${issue.title}. ${i.hint ?? ''}`).slice(0, 600),
        });
      }
    }
  }
  return out;
}

/** Semgrep --json (Decurity rules). Paths relative to the target root. */
export function parseSemgrep(json, isExcludedPath) {
  const out = [];
  for (const r of json?.results ?? []) {
    if (isExcludedPath(r.path)) continue;
    const md = r.extra?.metadata ?? {};
    const rule = String(r.check_id).replace(/^.*?solidity\.(security|best-practice|performance)\./, '');
    let severity;
    if (md.impact) {
      severity = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }[md.impact] ?? 'info';
      if (severity === 'high' && md.confidence === 'LOW') severity = 'medium';
    } else severity = { ERROR: 'high', WARNING: 'medium', INFO: 'low' }[r.extra?.severity] ?? 'info';
    out.push({ tool: 'semgrep', rule, severity, file: r.path, line: r.start?.line ?? null, title: rule, detail: norm(r.extra?.message).slice(0, 600) });
  }
  return out;
}

/** solc SMTChecker messages (tools/smtchecker.js). Unproved = not a finding. */
export function parseSmt(json) {
  const out = [];
  const unproved = [];
  for (const r of json?.results ?? []) {
    for (const m of r.messages ?? []) {
      const msg = m.message ?? '';
      if (/could not be proved|unproved|Use the option/i.test(msg) && !/happens here/.test(msg)) {
        if (/^(CHC|BMC):\s*\d+ verification condition/.test(msg)) unproved.push({ file: r.file, message: msg.split('\n')[0] });
        continue;
      }
      const kind = msg.match(/^(?:CHC|BMC): (Assertion violation|Overflow|Underflow|Division by zero|Out of bounds access|Empty array "pop")/);
      if (!kind) continue;
      // "happens here" comes with a counterexample; "might happen" means the
      // solver ran out of time on that target (unproved), not that it found one.
      const definite = /happens here/.test(msg);
      const severity = !definite ? 'info' : kind[1] === 'Assertion violation' ? 'high' : 'low';
      const file = m.file ? `${r.root}/${m.file}` : r.file;
      out.push({
        tool: 'smtchecker', rule: kind[1].toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, ''), severity, file, line: m.line,
        title: `${kind[1]} ${definite ? 'happens' : 'might happen'}`,
        detail: norm(msg.split('\n').slice(0, 1).join(' ')),
        counterexample: msg.split('\n').slice(1, 12).join('\n'),
      });
    }
  }
  return { findings: out, unproved };
}

// ---------------------------------------------------------------- Go

const zetaphyLine = (zl, rel, line) => {
  const z = zl?.[rel];
  if (!z) return false;
  return z === 'all' || (Array.isArray(z) && z.includes(Number(line)));
};

/** gosec -fmt json, kept to lines the ZETAPHY patches added. */
export function parseGosec(json, src, zl) {
  const out = [];
  for (const i of json?.Issues ?? []) {
    const rel = relative(src, i.file);
    const line = Number(String(i.line).split('-')[0]);
    if (!zetaphyLine(zl, rel, line)) continue;
    let severity = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }[i.severity] ?? 'info';
    if (severity === 'high' && i.confidence === 'LOW') severity = 'medium';
    out.push({
      tool: 'gosec', rule: i.rule_id, severity, file: `zetaphy-chain:${rel}`, line, title: `${i.rule_id} ${i.details}`,
      detail: norm(i.details), lineText: String(i.code ?? '').split('\n').find((l) => l.startsWith(`${line}:`))?.replace(/^\d+:/, '') ?? null,
    });
  }
  return out;
}

/** staticcheck -f json (one object per line), kept to ZETAPHY lines. */
export function parseStaticcheck(text, src, zl) {
  const out = [];
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    const rel = relative(src, d.location?.file ?? '');
    if (!zetaphyLine(zl, rel, d.location?.line)) continue;
    const severity = /^SA/.test(d.code) ? 'medium' : 'info';
    out.push({ tool: 'staticcheck', rule: d.code, severity, file: `zetaphy-chain:${rel}`, line: d.location.line, title: `${d.code} ${norm(d.message).slice(0, 80)}`, detail: norm(d.message) });
  }
  return out;
}

/** govulncheck -format json (a stream of JSON objects). Only vulnerable code actually called is high. */
export function parseGovulncheck(text) {
  const objs = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; } else if (c === '}' && --depth === 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } }
  }
  const osv = new Map(objs.filter((o) => o.osv).map((o) => [o.osv.id, o.osv]));
  const best = new Map();
  for (const { finding } of objs.filter((o) => o.finding)) {
    const t = finding.trace?.[0] ?? {};
    const level = t.function ? 3 : t.package ? 2 : 1;
    const prev = best.get(finding.osv);
    if (!prev || level > prev.level) best.set(finding.osv, { level, finding, t });
  }
  return [...best.values()].map(({ level, finding, t }) => {
    const o = osv.get(finding.osv) ?? {};
    return {
      tool: 'govulncheck', rule: finding.osv, severity: level === 3 ? 'high' : level === 2 ? 'low' : 'info',
      file: 'zetaphy-chain:go.mod', line: null, lineText: `${t.module}@${t.version}`,
      title: `${finding.osv} in ${t.module}@${t.version}${level === 3 ? ` (called: ${t.package}.${t.function})` : level === 2 ? ' (package imported, vulnerable symbol not called)' : ' (module required, not imported)'}`,
      detail: `${norm(o.summary)} fixed in ${finding.fixed_version ?? 'no fixed version'}`,
    };
  });
}

// ---------------------------------------------------------------- dependencies

const npmSev = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'info' };

/** npm audit --json (npm 7+), production dependencies only. */
export function parseNpmAudit(json, lockfile) {
  const out = [];
  for (const [name, v] of Object.entries(json?.vulnerabilities ?? {})) {
    const adv = (v.via ?? []).filter((x) => typeof x === 'object');
    if (!adv.length) continue; // only "via" another vulnerable package: reported there
    for (const a of adv) {
      const ghsa = String(a.url ?? '').match(/GHSA-[\w-]+/)?.[0] ?? String(a.source);
      out.push({
        tool: 'npm-audit', rule: ghsa, severity: npmSev[a.severity] ?? 'medium', file: lockfile, line: null, lineText: `${name}@${v.range}`,
        title: `${name}: ${norm(a.title)}`, detail: `${name} ${a.range ?? v.range}; fix available: ${v.fixAvailable ? 'yes' : 'no'}`, ghsa,
      });
    }
  }
  return out;
}

/** osv-scanner --format json. */
export function parseOsv(json, root) {
  const out = [];
  for (const r of json?.results ?? []) {
    const file = relative(root, r.source?.path ?? '');
    for (const p of r.packages ?? []) {
      const groups = p.groups ?? [];
      for (const v of p.vulnerabilities ?? []) {
        const g = groups.find((x) => (x.ids ?? []).includes(v.id) || (x.aliases ?? []).includes(v.id));
        const score = Number(g?.max_severity);
        let severity;
        if (score >= 9) severity = 'critical'; else if (score >= 7) severity = 'high'; else if (score >= 4) severity = 'medium'; else if (score > 0) severity = 'low';
        else severity = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' }[String(v.database_specific?.severity).toUpperCase()] ?? 'medium';
        const ids = [v.id, ...(v.aliases ?? [])];
        out.push({
          tool: 'osv-scanner', rule: v.id, severity, file, line: null, lineText: `${p.package?.name}@${p.package?.version}`,
          title: `${p.package?.name}@${p.package?.version}: ${norm(v.summary ?? v.details).slice(0, 100)}`,
          detail: `${p.package?.ecosystem} ${p.package?.name}@${p.package?.version}`, ghsa: ids.find((x) => /^GHSA-/.test(x)) ?? v.id,
        });
      }
    }
  }
  return out;
}

/** Reads one line of a file (for fingerprints and snippets). */
export function makeLineReader(roots) {
  const cache = new Map();
  return (file, line) => {
    if (!file || !line) return '';
    let text = cache.get(file);
    if (text === undefined) {
      text = null;
      for (const [prefix, dir] of roots) {
        if (!file.startsWith(prefix)) continue;
        const p = join(dir, file.slice(prefix.length));
        if (existsSync(p)) { text = readFileSync(p, 'utf8').split('\n'); break; }
      }
      cache.set(file, text);
    }
    return text?.[line - 1] ?? '';
  };
}
