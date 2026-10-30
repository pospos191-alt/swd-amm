#!/usr/bin/env node
// Merges every tool's output (written by audit/run.sh to <out>/raw/) into one
// audit report: audit/REPORT.md, a Thai summary audit/REPORT.th.md, a SARIF
// file for GitHub code scanning, and <out>/findings.json.
//
//   node audit/report.js <out> [--md <path>] [--th <path>] [--sarif <path>]
//                              [--triage audit/triage.yml] [--baseline audit/baseline.json]
//                              [--gate] [--write-baseline <path>]
//   node audit/report.js --json <out>      one JSON object on stdout (for other programs):
//     { commit, codeHashes: {contract: 0x<keccak of runtime code>}, findings: [{ id, tool, rule,
//       severity, file, line, title, status }], invariants: { passed, failed, notRun }, mutationScore }
//
// --gate: exit 1 when a High or Critical finding is open (not in triage.yml)
// and new (not in the baseline: the open findings a person already saw in an
// earlier reviewed report), or when triage.yml is malformed. Medium and below
// never block. Nothing here ever writes triage.yml.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import {
  SEVERITIES, rank, assignIds, dedupe, makeLineReader, parseSlither, parseAderyn, parseSemgrep, parseSmt,
  parseGosec, parseStaticcheck, parseGovulncheck, parseNpmAudit, parseOsv,
} from './lib/findings.js';
import { parseTriage, applyTriage, jsonStatus } from './lib/triage.js';

/** Findings whose decision is provisional (triage.yml "owner to confirm"): decided for the gate, shown as pending. */
export const pendingOf = (r) => r.findings.filter((f) => f.status !== 'open' && f.triage?.pending);

const HERE = dirname(new URL(import.meta.url).pathname);
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const readText = (p, d = '') => { try { return readFileSync(p, 'utf8'); } catch { return d; } };
const files = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : []);

/** Everything the raw outputs say, normalized. Exported for the tests. */
export function collect(out, { triageText = '', baselineIds = [] } = {}) {
  const raw = join(out, 'raw');
  const meta = readJson(join(raw, 'meta.json'), {});
  const scope = readJson(join(raw, 'scope.json'), { projects: [] });
  const target = meta.target ?? scope.target ?? '.';
  const excludedPath = (p) => scope.projects.some((pr) => Object.keys(pr.excluded ?? {}).some((x) => p === `${pr.root === '.' ? '' : pr.root + '/'}${x}`));
  const projectOf = (name) => scope.projects.find((p) => p.name === name);
  const prefix = (root) => (root === '.' ? '' : root);
  const strip = (f) => f.replace(/^\//, '');
  let findings = [];
  const notes = [];

  // compile: hashes + artifact drift
  const contracts = [];
  for (const f of files(join(raw, 'compile'), /^(?!.*runtime).*\.json$/)) {
    const c = readJson(f, {});
    for (const x of c.contracts ?? []) {
      contracts.push({ ...x, project: c.project, path: `${prefix(c.root) ? prefix(c.root) + '/' : ''}${x.file}` });
      if (x.artifactMatch === false && !x.excluded) {
        findings.push({ tool: 'compile', rule: 'artifact-drift', severity: 'medium', file: `${c.root}/artifacts/${x.name}.json`, line: null, lineText: x.name,
          title: `artifacts/${x.name}.json is not what ${x.file} compiles to`, detail: 'the CLIs deploy the committed artifact: run the project build and commit it' });
      }
    }
    for (const e of c.errors ?? []) notes.push(`compile error in ${c.project}: ${String(e).split('\n')[0]}`);
  }

  for (const f of files(join(raw, 'slither'), /\.json$/)) {
    const name = f.split('/').pop().split('__')[0];
    const p = projectOf(name);
    if (!p) continue;
    findings.push(...parseSlither(readJson(f), prefix(p.root), (rel) => !!p.excluded?.[rel]).map((x) => ({ ...x, file: strip(x.file) })));
  }
  for (const f of files(join(raw, 'aderyn'), /\.json$/)) {
    const p = projectOf(f.split('/').pop().replace(/\.json$/, ''));
    if (!p) continue;
    findings.push(...parseAderyn(readJson(f), prefix(p.root), (rel) => !!p.excluded?.[rel]).map((x) => ({ ...x, file: strip(x.file) })));
  }
  const sg = readJson(join(raw, 'semgrep', 'results.json'));
  if (sg) findings.push(...parseSemgrep(sg, excludedPath));
  const smt = parseSmt(readJson(join(raw, 'smtchecker', 'results.json'), {}));
  findings.push(...smt.findings);

  // Go (chain patches)
  const src = readText(join(raw, 'go', 'src.txt')).trim();
  const zl = readJson(join(raw, 'go', 'zetaphy-lines.json'), {});
  if (src) {
    for (const f of files(join(raw, 'go'), /^gosec-.*\.json$/)) findings.push(...parseGosec(readJson(f), src, zl));
    for (const f of files(join(raw, 'go'), /^staticcheck-.*\.json$/)) findings.push(...parseStaticcheck(readText(f), src, zl));
  }
  if (existsSync(join(raw, 'go', 'govulncheck.json'))) findings.push(...parseGovulncheck(readText(join(raw, 'go', 'govulncheck.json'))));
  if (readText(join(raw, 'go', 'race.result')).trim() === 'fail') {
    findings.push({ tool: 'go-race', rule: 'data-race', severity: 'high', file: 'zetaphy-chain:crypto/mldsa44', line: null, lineText: 'race',
      title: 'go test -race failed on the ZETAPHY packages', detail: readText(join(raw, 'go', 'race.txt')).slice(0, 400) });
  }

  // dependencies: npm audit (prod) first; OSV adds what npm did not report
  const npmGhsa = new Set();
  for (const f of files(join(raw, 'deps'), /^npm-.*\.json$/)) {
    const dir = f.split('/').pop().replace(/^npm-|\.json$/g, '').replace(/_/g, '/');
    const list = parseNpmAudit(readJson(f), `${dir}/package-lock.json`);
    list.forEach((x) => npmGhsa.add(`${x.file}|${x.ghsa}`));
    findings.push(...list);
  }
  const osv = readJson(join(raw, 'deps', 'osv.json'));
  if (osv) {
    for (const x of parseOsv(osv, target)) {
      if (npmGhsa.has(`${x.file}|${x.ghsa}`)) continue;
      if (/package-lock\.json$/.test(x.file) && files(join(raw, 'deps'), /^npm-/).length) {
        // npm audit --omit=dev did not report it: a development/build-time dependency
        if (rank(x.severity) < rank('medium')) x.severity = 'medium';
        x.title += ' (dev/build dependency)';
      }
      findings.push(x);
    }
  }

  // invariant suites
  const inv = readJson(join(raw, 'invariants', 'summary.json'), null);
  for (const s of inv?.suites ?? []) {
    if (!s.failed) continue;
    for (const t of (s.note || 'unknown').split(',')) {
      findings.push({ tool: s.tool, rule: 'property-violated', severity: 'high', file: s.dir, line: null, lineText: t,
        title: `${s.tool}: ${t} fails`, detail: `a stated invariant / property does not hold: see raw/invariants/ for the counterexample` });
    }
  }

  findings = dedupe(findings);
  const lineOf = makeLineReader([['zetaphy-chain:', src || '/nonexistent'], ['', target]]);
  for (const f of findings) if (f.line && !f.snippet) f.snippet = (f.lineText ?? lineOf(f.file, f.line)).trim().slice(0, 160);
  assignIds(findings, lineOf);
  const triage = parseTriage(triageText);
  const stale = applyTriage(findings, triage.entries);
  const baseline = new Set(baselineIds);
  for (const f of findings) f.known = baseline.has(f.id);
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.tool.localeCompare(b.tool) || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  const blocking = findings.filter((f) => f.status === 'open' && rank(f.severity) <= rank('high') && !f.known);

  const tools = readText(join(raw, 'tools.tsv')).trim().split('\n').slice(1).filter(Boolean).map((l) => {
    const [tool, status, seconds, version, note] = l.split('\t');
    return { tool, status, seconds: Number(seconds), version, note };
  });
  const codeHashes = {};
  const audited = contracts.filter((c) => !c.excluded);
  for (const c of audited) {
    const dup = audited.filter((x) => x.name === c.name).length > 1;
    codeHashes[dup ? `${c.path}:${c.name}` : c.name] = c.runtimeHash;
  }
  const mutation = readJson(join(raw, 'mutation', 'results.json'), null);
  const neuro = readJson(join(raw, 'neuro', 'results.json'), null);
  const smtRaw = readJson(join(raw, 'smtchecker', 'results.json'), null);
  return {
    meta, scope, tools, contracts, codeHashes, findings, blocking, stale, triageErrors: triage.errors, notes,
    invariants: inv ?? { passed: 0, failed: 0, notRun: 0, suites: [] }, mutation, neuro, smt: smtRaw, unproved: smt.unproved,
    go: { status: readText(join(raw, 'go', 'status.txt')).trim().split('\n').filter(Boolean), race: readText(join(raw, 'go', 'race.result')).trim() },
    seconds: Number(readText(join(raw, 'seconds.txt')).trim()) || null,
  };
}

/** The machine-readable summary (--json). The shape the Audit Network adapter checks strictly
 *  (zetaphy-hub/audit-core.js validatePipeline): strings are strings and lines whole numbers (0 = none). */
export function toJson(r) {
  return {
    commit: r.meta.commit ?? 'unknown',
    codeHashes: r.codeHashes,
    findings: r.findings.map((f) => ({ id: f.id, tool: f.tool, rule: String(f.rule ?? ''), severity: f.severity, file: String(f.file ?? ''),
      line: Number.isInteger(f.line) && f.line > 0 ? f.line : 0, title: String(f.title ?? '').slice(0, 2000), status: jsonStatus(f.status) })),
    invariants: { passed: r.invariants.passed ?? 0, failed: r.invariants.failed ?? 0, notRun: r.invariants.notRun ?? 0 },
    mutationScore: r.mutation?.score ?? null,
  };
}

// ---------------------------------------------------------------- Markdown

// Markdown table cell: backslashes first, then pipes; newlines become spaces
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const count = (list, sev) => list.filter((f) => f.severity === sev).length;

function link(f, linkBase) {
  if (!f.file) return '-';
  const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
  if (!linkBase || f.file.startsWith('zetaphy-chain:') || !/\.(sol|json|lock)$/.test(f.file)) return `\`${loc}\``;
  return `[\`${loc}\`](${linkBase}${f.file}${f.line ? `#L${f.line}` : ''})`;
}

function statusText(f) {
  if (f.triage && f.status !== 'open' && f.triage.pending) return `**${f.status}, PENDING OWNER CONFIRMATION** (proposed by ${esc(f.triage.decided_by)}${f.triage.date ? `, ${f.triage.date}` : ''}): ${esc(f.triage.reason)}`;
  if (f.triage && f.status !== 'open') return `**${f.status}** (${esc(f.triage.decided_by)}${f.triage.date ? `, ${f.triage.date}` : ''}): ${esc(f.triage.reason)}`;
  if (f.note) return `open (${esc(f.note)})`;
  return f.known ? 'open (known: in baseline, awaiting triage)' : 'open (NEW)';
}

export function toMarkdown(r, { linkBase = '../' } = {}) {
  const date = (r.meta.started ?? new Date().toISOString()).slice(0, 10);
  const open = r.findings.filter((f) => f.status === 'open');
  const L = [];
  const p = (...x) => L.push(...x);
  p(`# ZETAPHY in-house audit report`, '');
  p(`> Automated audit of commit \`${r.meta.commit}\`, ${r.meta.tier} tier, ${r.meta.started ?? ''}.`,
    `> This is a machine-generated report from free open-source tools and our own scripts. It is **not** an independent audit and does not replace one (see [What this does NOT prove](#what-this-does-not-prove-as-of-${date})).`, '');

  p('## Summary', '');
  const pending = pendingOf(r);
  p('| Severity | All | Open | Open & new (not in baseline) | Triaged (confirmed) | Triaged, pending owner confirmation |', '|---|---:|---:|---:|---:|---:|');
  for (const s of SEVERITIES) {
    const all = r.findings.filter((f) => f.severity === s);
    const fresh = rank(s) <= rank('high') ? all.filter((f) => f.status === 'open' && !f.known).length : '-';
    const pend = count(pending, s);
    p(`| ${s[0].toUpperCase() + s.slice(1)} | ${all.length} | ${count(open, s)} | ${fresh} | ${all.filter((f) => f.status !== 'open').length - pend} | ${pend} |`);
  }
  p('');
  p(`- **Gate (PR tier):** ${r.blocking.length ? `FAILS: ${r.blocking.length} new untriaged High/Critical finding(s)` : 'passes: no new untriaged High/Critical finding'}${r.triageErrors.length ? `; triage.yml has ${r.triageErrors.length} error(s)` : ''}.`);
  if (pending.length) {
    const ph = pending.filter((f) => rank(f.severity) <= rank('high')).length;
    p(`- **Pending owner confirmation:** ${pending.length} triage decision(s) in \`triage.yml\` are provisional ("owner to confirm"), ${ph} of them High/Critical. They count as decided for the gate and \`--json\`, exactly like confirmed ones, and are labelled **PENDING OWNER CONFIRMATION** below. The owner confirms one by putting their own name in \`decided_by\`, or rejects it by deleting the entry (the finding is then open again).`);
  }
  p(`- **Invariant / property suites:** ${r.invariants.passed} passed, ${r.invariants.failed} failed, ${r.invariants.notRun} not run.`);
  const mk = (r.mutation?.results ?? []).reduce((a, m) => a + m.killed + m.survived, 0);
  p(`- **Mutation score:** ${r.mutation?.score != null ? `${(r.mutation.score * 100).toFixed(1)}% of ${mk} non-equivalent mutants (${r.mutation.results.length} contract${r.mutation.results.length === 1 ? '' : 's'}) caught by the tests` : 'not measured in this run (deep tier)'}.`);
  const aud = r.contracts.filter((c) => !c.excluded);
  p(`- **Contracts compiled:** ${aud.length} audited contracts with code (${aud.filter((c) => c.artifactMatch === true).length} committed artifacts match the source exactly, ${aud.filter((c) => c.artifactMatch === false).length} do not).`);
  if (r.seconds) p(`- **Run time:** ${Math.round(r.seconds / 60)} min ${r.seconds % 60} s.`);
  for (const n of r.notes) p(`- ${n}`);
  p('');

  p('## Scope', '');
  p(`Commit \`${r.meta.commit}\` · target \`${r.meta.mode === 'repo' ? 'this repository (audit/scope.json)' : r.meta.target}\` · compiler ${r.scope.solc ?? '?'}`, '');
  p('| Project | Files in scope | Code lines (no comments/blank) | Excluded (why) |', '|---|---:|---:|---|');
  let totalLoc = 0;
  for (const pr of r.scope.projects) {
    const inScope = pr.files.filter((f) => !pr.excluded[f]);
    const loc = inScope.reduce((s, f) => s + (pr.loc?.[f] ?? 0), 0);
    totalLoc += loc;
    p(`| ${pr.name} | ${inScope.length} | ${loc} | ${Object.entries(pr.excluded).map(([f, w]) => `\`${f}\`: ${esc(w)}`).join('<br>') || '-'} |`);
  }
  p(`| **Total** | ${r.scope.projects.reduce((s, pr) => s + pr.files.filter((f) => !pr.excluded[f]).length, 0)} | ${totalLoc} | |`, '');
  if (r.meta.mode === 'repo') p('Chain code: the ZETAPHY patches in `zetaphy-chain/setup-node.sh`, applied to the pinned Cosmos EVM source; only lines those patches add are reported. JS/TS web apps: covered by CodeQL, not here (their npm dependencies are).', '');

  p('## Methodology', '');
  p('| Step | Tool | Status | Time | Version / note |', '|---|---|---|---:|---|');
  const what = {
    compile: 'compile every contract; runtime code hash; committed artifacts = source?',
    slither: 'static analysis, all ~100 detectors (Trail of Bits)',
    aderyn: 'static analysis, AST detectors (Cyfrin)',
    semgrep: 'pattern rules from real exploits (Decurity smart-contract rules)',
    smtchecker: 'formal checks built into solc: assert, overflow, division by zero, bounds',
    invariants: 'invariant / property suites: forge (fuzz), halmos (symbolic), medusa / echidna',
    mutation: 'plant small bugs, see if the tests notice (score)',
    neuro: 'our own Neuro scanner on our own bytecode (dogfooding)',
    go: 'chain patches: staticcheck, gosec, govulncheck, go test -race',
    'osv-scanner': 'known vulnerabilities in every lockfile (OSV database)',
    'npm-audit': 'known vulnerabilities in production npm dependencies',
  };
  for (const t of r.tools) p(`| ${what[t.tool] ?? ''} | ${t.tool} | ${t.status} | ${t.seconds}s | ${esc(t.version)}${t.note ? ` · ${esc(t.note)}` : ''} |`);
  p('', 'Severity scale (README.md): **Critical** funds can be stolen or frozen now; **High** a likely path to loss or a broken core guarantee; **Medium** loss under specific conditions, or a guarantee weakened; **Low** best practice / defence in depth; **Info** style, gas, notes. Tools\' own levels are mapped to this scale (lib/findings.js); a High-impact detector with low confidence is reported as Medium.', '');

  p('## Findings', '');
  p('Every finding has a stable id (tool:rule:file:hash of the flagged line). To record a decision, add the id to `audit/triage.yml` (see README.md: only people do this).', '');
  if (r.meta.mode !== 'target' && existsSync(join(HERE, 'review-notes.md'))) p('Hand-written review notes on the open High findings (dated; they may be older than this run): [review-notes.md](review-notes.md).', '');
  for (const s of ['critical', 'high']) {
    const list = r.findings.filter((f) => f.severity === s);
    const openList = list.filter((f) => f.status === 'open');
    const done = list.filter((f) => f.status !== 'open');
    p(`### ${s[0].toUpperCase() + s.slice(1)} (${list.length}: ${openList.length} open, ${done.length} triaged)`, '');
    if (!list.length) p('None.', '');
    for (const f of openList) {
      p(`#### ${esc(f.title)}`, '');
      p(`- id: \`${f.id}\``, `- where: ${link(f, linkBase)}${f.snippet ? ` — \`${esc(f.snippet)}\`` : ''}`, `- tool: ${f.tool} (${f.rule}${f.confidence ? `, confidence ${f.confidence}` : ''})`, `- status: ${statusText(f)}`);
      if (f.detail) p(`- detail: ${esc(f.detail)}`);
      if (f.counterexample) p('', '```', f.counterexample, '```');
      p('');
    }
    if (done.length) {
      p(`<details><summary>${done.length} triaged ${s} finding(s)</summary>`, '', '| Where | Tool / rule | Decision |', '|---|---|---|');
      for (const f of done) p(`| ${link(f, linkBase)} | ${f.tool} / ${esc(f.rule)} | ${statusText(f)} <br>\`${f.id}\` |`);
      p('', '</details>', '');
    }
  }
  const med = r.findings.filter((f) => f.severity === 'medium');
  p(`### Medium (${med.length})`, '');
  if (med.length) {
    p('| Where | Tool / rule | Finding | Status |', '|---|---|---|---|');
    for (const f of med) p(`| ${link(f, linkBase)} | ${f.tool} / ${esc(f.rule)} | ${esc(f.title).slice(0, 80)}${f.detail && f.detail !== f.title ? ` — ${esc(f.detail).slice(0, 140)}` : ''} <br>\`${f.id}\` | ${f.status === 'open' && !f.triage ? 'open' : statusText(f)} |`);
  } else p('None.');
  p('');
  for (const s of ['low', 'info']) {
    const list = r.findings.filter((f) => f.severity === s);
    p(`### ${s === 'low' ? 'Low' : 'Info'} (${list.length})`, '');
    if (!list.length) { p('None.', ''); continue; }
    p('Grouped by rule; every instance with its id is in `findings.json` of the workflow artifact.', '');
    p('| Tool / rule | Count | Example |', '|---|---:|---|');
    const groups = new Map();
    for (const f of list) { const k = `${f.tool} / ${f.rule}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) p(`| ${esc(k)} | ${g.length} | ${link(g[0], linkBase)} ${esc(g[0].title).slice(0, 90)} |`);
    p('');
  }
  if (r.stale.length) {
    p('### Triage entries that matched nothing', '', 'The finding is gone (fixed, or the flagged line changed so its id changed). Remove the entry, or re-triage the new id.', '');
    for (const e of r.stale) p(`- \`${e.id}\` (${e.status}, ${e.decided_by})`);
    p('');
  }
  if (r.triageErrors.length) { p('### triage.yml errors', ''); for (const e of r.triageErrors) p(`- ${esc(e)}`); p(''); }

  p('## Formal checks (SMTChecker)', '');
  if (r.smt?.results?.length) {
    p('| Contract file | Engine | Result | Counterexamples | Unproved targets | Time |', '|---|---|---|---:|---:|---:|');
    for (const x of r.smt.results) p(`| \`${x.file}\` | ${x.engine} | ${x.status} | ${x.messages.filter((m) => /happens here/.test(m.message)).length} | ${x.messages.filter((m) => /might happen/.test(m.message)).length} | ${x.seconds}s |`);
    p('', 'A counterexample is a concrete input the solver found (BMC checks each function alone, without the contract\'s state invariants, so its arithmetic ones are often unreachable; they are Low findings). An unproved target means the solver ran out of time: NOT a pass and NOT a bug (Info). A contract that hit the time or memory cap reports nothing.', '');
    if (r.unproved.length) p(`Summaries: ${r.unproved.map((u) => `\`${u.file}\`: ${esc(u.message)}`).join('; ')}.`, '');
  } else p('Not run.', '');

  p('## Coverage', '');
  p('**Invariant / property suites** (`*/audit/invariants/`):', '');
  if (r.invariants.suites?.length) {
    p('| Suite | Tool | Passed | Failed | Not run | Note |', '|---|---|---:|---:|---:|---|');
    for (const s of r.invariants.suites) p(`| \`${s.dir}\` | ${s.tool} | ${s.passed} | ${s.failed} | ${s.notRun} | ${esc(s.note)} |`);
  } else p('No suite found.');
  p('');
  p('**Mutation testing** (custom mutator, `audit/tools/mutate.js`):', '');
  if (r.mutation?.results?.length) {
    p('| Contract | Killed | Survived | Score | Stillborn | Equivalent | Tests used |', '|---|---:|---:|---:|---:|---:|---|');
    for (const m of r.mutation.results) p(`| \`${m.file}\` | ${m.killed} | ${m.survived} | ${m.score != null ? (m.score * 100).toFixed(0) + '%' : '-'} | ${m.stillborn} | ${m.equivalent} | ${m.tests.map((t) => t.replace('test/', '')).join(', ') || esc(m.note)} |`);
    const surv = r.mutation.results.flatMap((m) => m.survivors.map((s) => ({ ...s, file: m.file })));
    if (surv.length) {
      p('', 'Surviving mutants: a test that fails on each of these would make the suite stronger.', '', '| Where | Change no test noticed |', '|---|---|');
      for (const s of surv.slice(0, 60)) p(`| \`${s.file}:${s.line}\` | \`${esc(s.original)}\` → \`${esc(s.mutant)}\` |`);
    }
  } else p('Not run in this tier (weekly deep run).');
  p('');
  p('**Line coverage of the existing tests:** not measured. The project test suites run contracts on an in-process EVM through `node --test` helpers, which solidity-coverage and `forge coverage` cannot instrument; the mutation score above is the measure of test strength used instead. Suites under `*/audit/invariants/` that use Foundry can add `forge coverage` later.', '');

  p('## Neuro on our own bytecode (dogfooding)', '');
  if (r.neuro?.results?.length) {
    const lv = r.neuro.results.reduce((m, x) => ({ ...m, [x.level]: (m[x.level] ?? 0) + 1 }), {});
    p(`Neuro read ${r.neuro.results.length} of our contracts (offline, bytecode only): ${Object.entries(lv).map(([k, v]) => `${v} ${k}`).join(', ')}. This is what users of the explorer and wallet would see. A high verdict names a power (pause, mint, an owner that can move funds): it must be documented for users, or it is a Neuro false positive to fix in Neuro. Not counted as vulnerabilities.`, '');
    p('| Contract | Neuro verdict | What Neuro reports |', '|---|---|---|');
    for (const x of r.neuro.results.filter((y) => y.level === 'high' || y.level === 'medium')) p(`| ${x.name} (\`${x.file}\`) | ${x.level} | ${x.findings.filter((y) => !/:info$|:low$/.test(y)).join(', ')} |`);
  } else p('Not run.');
  p('');

  if (r.meta.mode === 'repo') {
    p('## Chain code (Go)', '');
    p(r.go.status.length ? r.go.status.map((s) => `- ${esc(s)}`).join('\n') : '- not run in this tier (it runs when `zetaphy-chain/` changes, and weekly)');
    p('');
  }

  p('## Code hashes', '', 'keccak-256 of each audited contract\'s runtime bytecode, as compiled here. A deployed contract whose `EXTCODEHASH` differs is not the code this report covers.', '');
  p('<details><summary>' + Object.keys(r.codeHashes).length + ' contracts</summary>', '', '| Contract | Runtime code hash |', '|---|---|');
  for (const [k, v] of Object.entries(r.codeHashes)) p(`| ${esc(k)} | \`${v}\` |`);
  p('', '</details>', '');

  p(`## What this does NOT prove (as of ${date})`, '');
  p('- **No finding is not "secure".** Static analysers know patterns; they miss business-logic bugs (wrong fee maths, a price that can be pushed, a missing check that only the design says must exist), which is where most money is lost.',
    '- **Economic and cross-contract attacks are not modelled**: flash-loan price manipulation, oracle manipulation, MEV / sandwiching, governance capture, griefing that costs the attacker little.',
    '- **The SMTChecker proves only what it reports as proved**, within its time budget, and only the built-in properties (assert, arithmetic, bounds). "Unproved" means unknown.',
    '- **Fuzzing and invariants** test only the properties someone wrote down, for the number of runs given. Suites that are missing are counted as "not run", never as passed.',
    '- **Mutation testing** samples a few dozen mutants of a few contracts; a high score means the tests notice those kinds of edits, not that they are complete.',
    '- **Deployment and operations are out of scope**: who holds the owner / admin keys, the multisig and timelock settings actually deployed, constructor arguments, upgrade procedures, the RPC and front-ends. The code hashes above let you check that what is deployed is what was analysed.',
    '- **The chain**: only the ZETAPHY patches are analysed, not Cosmos EVM / CometBFT / ibc-go themselves, and consensus-level behaviour (liveness, validator collusion) is not tested here.',
    '- **Tools have bugs and blind spots**, and the versions used are pinned (audit/tools/install.sh); a newer rule set may find more.',
    '- **Before mainnet with real funds, an independent audit by people is still required** (SECURITY.md). This pipeline makes that audit cheaper and keeps regressions out between audits; it does not replace it.', '');
  return L.join('\n');
}

export function toThai(r) {
  const date = (r.meta.started ?? '').slice(0, 10);
  const open = r.findings.filter((f) => f.status === 'open');
  const th = { critical: 'วิกฤต (Critical)', high: 'สูง (High)', medium: 'กลาง (Medium)', low: 'ต่ำ (Low)', info: 'ข้อมูล (Info)' };
  const L = [];
  L.push('# รายงานตรวจสอบอัตโนมัติ ZETAPHY (สรุปภาษาไทย)', '');
  L.push(`> ตรวจ commit \`${r.meta.commit}\` ระดับ ${r.meta.tier === 'deep' ? 'ละเอียด (deep, รายสัปดาห์)' : 'เร็ว (fast, ทุก PR)'} เมื่อ ${r.meta.started ?? ''}`,
    '> รายงานนี้สร้างโดยเครื่องมือฟรีโอเพนซอร์สและสคริปต์ของเราเอง **ไม่ใช่การ audit อิสระ และใช้แทนการ audit โดยผู้เชี่ยวชาญภายนอกไม่ได้** รายละเอียดเต็มอยู่ใน [REPORT.md](REPORT.md)', '');
  L.push('## สรุปจำนวนสิ่งที่พบ', '', '| ระดับ | ทั้งหมด | ยังเปิดอยู่ | เปิดอยู่และเป็นของใหม่ |', '|---|---:|---:|---:|');
  for (const s of SEVERITIES) {
    const all = r.findings.filter((f) => f.severity === s);
    L.push(`| ${th[s]} | ${all.length} | ${count(open, s)} | ${rank(s) <= rank('high') ? all.filter((f) => f.status === 'open' && !f.known).length : '-'} |`);
  }
  L.push('', `- **ด่านตรวจ PR:** ${r.blocking.length ? `ไม่ผ่าน — มีสิ่งที่พบระดับสูง/วิกฤตใหม่ที่ยังไม่ได้ตัดสิน ${r.blocking.length} รายการ` : 'ผ่าน — ไม่มีสิ่งที่พบระดับสูง/วิกฤตใหม่ที่ยังไม่ได้ตัดสิน'}`);
  const pend = pendingOf(r);
  if (pend.length) L.push(`- **รอเจ้าของยืนยัน:** การตัดสินใน triage.yml ${pend.length} รายการ (ระดับสูง/วิกฤต ${pend.filter((f) => rank(f.severity) <= rank('high')).length}) เป็นการตัดสินชั่วคราว ("owner to confirm") — ด่านตรวจ PR และ --json นับเหมือนตัดสินแล้ว แต่ในรายงานติดป้าย "รอเจ้าของยืนยัน" เจ้าของยืนยันโดยใส่ชื่อตัวเองใน decided_by หรือปฏิเสธโดยลบรายการ`);
  L.push(`- **ชุดทดสอบ invariant / property:** ผ่าน ${r.invariants.passed} · ไม่ผ่าน ${r.invariants.failed} · ยังไม่ได้รัน ${r.invariants.notRun}`);
  L.push(`- **คะแนน mutation testing:** ${r.mutation?.score != null ? `${(r.mutation.score * 100).toFixed(1)}%` : 'ไม่ได้วัดในรอบนี้ (วัดในรอบ deep รายสัปดาห์)'}`);
  L.push(`- **สัญญาที่คอมไพล์:** ${r.contracts.filter((c) => !c.excluded).length} ตัว · artifacts ที่ commit ไว้ตรงกับซอร์ส ${r.contracts.filter((c) => c.artifactMatch === true).length} ตัว ไม่ตรง ${r.contracts.filter((c) => c.artifactMatch === false).length} ตัว`, '');
  const hi = r.findings.filter((f) => rank(f.severity) <= rank('high') && f.status === 'open');
  const hiDone = r.findings.filter((f) => rank(f.severity) <= rank('high') && f.status !== 'open').length;
  const hiPend = pend.filter((f) => rank(f.severity) <= rank('high')).length;
  L.push('## รายการระดับสูง/วิกฤตที่ยังเปิดอยู่', '', `(ตัดสินแล้ว ${hiDone} รายการ ในจำนวนนี้รอเจ้าของยืนยัน ${hiPend} รายการ — ดูเหตุผลใน REPORT.md / triage.yml)`, '');
  if (!hi.length) L.push('ไม่มี', '');
  for (const f of hi) L.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${f.tool}/${f.rule}: ${esc(f.title)} — สถานะ: ${f.status === 'open' ? (f.known ? 'เปิดอยู่ (รู้แล้ว รอตัดสิน)' : '**เปิดอยู่ (ใหม่)**') : f.status}`);
  L.push('', '## วิธีอ่านและจัดการ', '',
    '1. ดูรายการระดับสูง/วิกฤตก่อน อ่านโค้ดตรงบรรทัดที่ระบุ แล้วตัดสินว่าเป็นปัญหาจริงหรือไม่',
    '2. ถ้าจริง: แก้โค้ดใน PR แยก แล้วเพิ่มใน `audit/triage.yml` เป็น `fixed` (เมื่อแก้แล้วเครื่องมือจะไม่พบอีก)',
    '3. ถ้าไม่จริง: เพิ่มเป็น `false-positive` พร้อมเหตุผลที่ตรวจสอบได้ และชื่อผู้ตัดสิน (`decided_by`)',
    '4. ถ้ายอมรับความเสี่ยง: `accepted-risk` พร้อมเหตุผล — ระบบไม่เคยใส่สถานะเหล่านี้เอง มีแต่คนเท่านั้นที่แก้ไฟล์นี้', '');
  L.push(`## สิ่งที่รายงานนี้พิสูจน์ไม่ได้ (ณ ${date})`, '',
    '- ไม่พบปัญหา ≠ ปลอดภัย: เครื่องมือรู้จักแค่รูปแบบที่เคยเห็น พลาดบั๊กเชิงตรรกะธุรกิจได้ง่าย',
    '- ไม่ได้จำลองการโจมตีเชิงเศรษฐศาสตร์ (flash loan, ปั่นราคา oracle, MEV, ยึด governance)',
    '- SMTChecker พิสูจน์ได้เฉพาะที่รายงานว่าพิสูจน์แล้ว ภายในเวลาที่กำหนด',
    '- fuzzing/invariant ทดสอบเฉพาะคุณสมบัติที่มีคนเขียนไว้ ชุดที่ยังไม่มีนับเป็น "ยังไม่ได้รัน" ไม่ใช่ "ผ่าน"',
    '- ไม่ครอบคลุมการ deploy และการดูแลกุญแจ owner/admin, multisig, timelock ที่ใช้จริง',
    '- **ก่อนใช้ mainnet กับเงินจริง ยังต้องมีการ audit อิสระโดยคน** (ดู SECURITY.md)', '');
  return L.join('\n');
}

export function toSarif(r, { repoRelative = true } = {}) {
  const runs = new Map();
  // Medium and above: Low / Info stay in the report and findings.json, not in the code-scanning UI.
  for (const f of r.findings.filter((x) => x.status === 'open' && rank(x.severity) <= rank('medium') && x.file && !x.file.startsWith('zetaphy-chain:'))) {
    if (!runs.has(f.tool)) runs.set(f.tool, { rules: new Map(), results: [] });
    const run = runs.get(f.tool);
    const ruleId = `${f.tool}/${f.rule}`;
    if (!run.rules.has(ruleId)) run.rules.set(ruleId, { id: ruleId, name: f.rule, shortDescription: { text: String(f.title).slice(0, 200) } });
    run.results.push({
      ruleId,
      level: rank(f.severity) <= rank('high') ? 'error' : f.severity === 'medium' ? 'warning' : 'note',
      message: { text: `[${f.severity}] ${f.title}${f.detail ? `: ${f.detail}` : ''} (audit id ${f.id})`.slice(0, 1000) },
      locations: [{ physicalLocation: { artifactLocation: { uri: f.file, uriBaseId: repoRelative ? '%SRCROOT%' : undefined }, region: f.line ? { startLine: f.line } : undefined } }],
      partialFingerprints: { 'zetaphyAuditId/v1': f.id },
      properties: { severity: f.severity, tool: f.tool },
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [...runs].map(([tool, run]) => ({
      tool: { driver: { name: `zetaphy-audit/${tool}`, informationUri: 'https://github.com/pospos191-alt/swd-amm/tree/main/audit', rules: [...run.rules.values()] } },
      automationDetails: { id: `zetaphy-audit/${tool}/` },
      results: run.results,
    })),
  };
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const valued = ['--md', '--th', '--sarif', '--triage', '--baseline', '--write-baseline'];
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  const out = resolve(positional[0] ?? join(HERE, 'out'));
  const json = args.includes('--json');
  const triagePath = opt('--triage', join(HERE, 'triage.yml'));
  const baselinePath = opt('--baseline', join(HERE, 'baseline.json'));
  const r = collect(out, { triageText: readText(triagePath), baselineIds: readJson(baselinePath, { ids: [] }).ids ?? [] });
  if (json) {
    process.stdout.write(JSON.stringify(toJson(r)) + '\n');
  } else {
    const repoMode = r.meta.mode !== 'target';
    const md = resolve(opt('--md', repoMode ? join(HERE, 'REPORT.md') : join(out, 'REPORT.md')));
    const thPath = resolve(opt('--th', md.replace(/\.md$/, '.th.md')));
    const sarif = resolve(opt('--sarif', join(out, 'audit.sarif')));
    const linkBase = repoMode ? `${relative(dirname(md), resolve(HERE, '..')) || '.'}/` : '';
    mkdirSync(dirname(md), { recursive: true });
    writeFileSync(md, toMarkdown(r, { linkBase }) + '\n');
    writeFileSync(thPath, toThai(r) + '\n');
    writeFileSync(sarif, JSON.stringify(toSarif(r, { repoRelative: repoMode }), null, 1));
    writeFileSync(join(out, 'findings.json'), JSON.stringify({ ...toJson(r), all: r.findings }, null, 1));
    const c = (s) => r.findings.filter((f) => f.severity === s).length;
    console.log(`report: ${md}\n  critical ${c('critical')} · high ${c('high')} · medium ${c('medium')} · low ${c('low')} · info ${c('info')} · new untriaged high/critical: ${r.blocking.length}`);
  }
  const wb = opt('--write-baseline', null);
  if (wb) {
    const ids = r.findings.filter((f) => f.status === 'open' && rank(f.severity) <= rank('high')).map((f) => f.id).sort();
    writeFileSync(wb, JSON.stringify({ _comment: 'Open High/Critical findings a person has seen in a reviewed report (audit/README.md "Baseline"). NOT triage: they stay open in every report until triage.yml decides them. Only the weekly report PR (merged by a person) updates this file.', commit: r.meta.commit, generated: r.meta.started, ids }, null, 1) + '\n');
  }
  if (args.includes('--gate')) {
    for (const e of r.triageErrors) console.error(`::error file=audit/triage.yml::${e}`);
    const pend = pendingOf(r);
    if (pend.length) console.error(`::warning file=audit/triage.yml::${pend.length} triage decision(s) (${pend.filter((f) => rank(f.severity) <= rank('high')).length} High/Critical) are pending owner confirmation ("owner to confirm"); the gate counts them as decided, like confirmed ones`);
    for (const f of r.blocking) console.error(`::error${f.file && !f.file.includes(':') ? ` file=${f.file},line=${f.line ?? 1}` : ''}::[${f.severity}] ${f.title} (id ${f.id}): new and untriaged; fix it, or record a decision in audit/triage.yml`);
    if (r.blocking.length || r.triageErrors.length) process.exit(1);
  }
}
