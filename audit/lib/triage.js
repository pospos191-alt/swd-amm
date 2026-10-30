// audit/triage.yml: the human decisions about findings. Only people edit it;
// the pipeline reads it and never writes it.
//
// Format (a small YAML subset, parsed here without dependencies):
//
//   findings:
//     - id: slither:reentrancy-eth:zetaphy-dex/contracts/ZetaphyPair.sol:3f2a9c0d1e7b
//       status: false-positive          # fixed | false-positive | accepted-risk
//       reason: "the external call is to a token the pair itself holds; ..."
//       decided_by: owner               # who decided (a GitHub login or name)
//       date: 2026-10-30
//
// Strings may be plain, 'single' or "double" quoted, or a folded block
// (`reason: >` followed by more-indented lines). Comments start with #.

export const STATUSES = ['fixed', 'false-positive', 'accepted-risk'];

function scalar(v) {
  v = v.trim();
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); if (!m) throw new Error('quote'); return JSON.parse(`"${m[1]}"`); }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); if (!m) throw new Error('quote'); return m[1].replace(/''/g, "'"); }
  return v.replace(/\s+#.*$/, '').trim();
}

/** Parses triage.yml text. Returns {entries, errors}. */
export function parseTriage(text) {
  const entries = [];
  const errors = [];
  let cur = null;
  let block = null; // {key, indent, lines}
  const lines = text.split('\n');
  const flush = () => { if (block) { cur[block.key] = block.lines.join(' ').trim(); block = null; } };
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (block) {
      const ind = raw.match(/^ */)[0].length;
      if (raw.trim() === '' || ind > block.indent) { if (raw.trim()) block.lines.push(raw.trim()); return; }
      flush();
    }
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*(#.*)?$/.test(line)) return;
    if (/^findings:\s*(\[\s*\])?\s*(#.*)?$/.test(line)) return;
    let m = line.match(/^(\s*)-\s+(\w+):\s*(.*)$/);
    if (m) { cur = { _line: n }; entries.push(cur); }
    else m = line.match(/^(\s*)(\w+):\s*(.*)$/);
    if (!m || !cur) { errors.push(`triage.yml:${n}: cannot read "${raw.trim()}"`); return; }
    const [, indent, key, value] = m;
    if (/^[>|]-?\s*$/.test(value)) { block = { key, indent: indent.length, lines: [] }; return; }
    try { cur[key] = scalar(value); } catch { errors.push(`triage.yml:${n}: bad quoted string`); }
  });
  flush();
  const seen = new Set();
  for (const e of entries) {
    const where = `triage.yml:${e._line}`;
    if (!e.id) errors.push(`${where}: missing id`);
    if (!STATUSES.includes(e.status)) errors.push(`${where}: status must be one of ${STATUSES.join(', ')} (got "${e.status ?? ''}")`);
    if (!e.reason || e.reason.length < 15) errors.push(`${where}: a concrete reason is required`);
    if (!e.decided_by) errors.push(`${where}: decided_by (who decided) is required`);
    if (e.id && seen.has(e.id)) errors.push(`${where}: duplicate id ${e.id}`);
    seen.add(e.id);
  }
  return { entries, errors };
}

/**
 * Applies the decisions to findings (adds .status / .triage).
 * open: no decision; a finding still detected after being marked "fixed" is
 * open again (note says so). Returns the decisions that matched nothing
 * (stale: fixed for real, or code moved so the fingerprint changed).
 */
export function applyTriage(findings, entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const used = new Set();
  for (const f of findings) {
    const e = byId.get(f.id);
    if (!e) { f.status = 'open'; continue; }
    used.add(e.id);
    f.triage = { status: e.status, reason: e.reason, decided_by: e.decided_by, date: e.date ?? '' };
    if (e.status === 'fixed') { f.status = 'open'; f.note = `marked fixed by ${e.decided_by} but still detected`; } else f.status = e.status;
  }
  return entries.filter((e) => !used.has(e.id));
}

/** The status names of the machine-readable output (--json). */
export const jsonStatus = (s) => (s === 'accepted-risk' ? 'accepted' : s);
