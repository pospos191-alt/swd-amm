#!/usr/bin/env node
// Dogfooding: our own Neuro scanner (zetaphy-neuro) reads our own contracts'
// runtime bytecode, the same way it reads any contract a user looks up
// (src/bytecode.js scan -> src/similarity.js closest flagged code ->
// src/analyze.js verdict). cli.js needs a live chain address, so this calls
// the same library functions on the bytecode compile.js produced, offline:
// no owner()/token calls, no trade simulation, no Sourcify.
//
// What it is for: Neuro's verdict is what users of the explorer/wallet will
// see for our contracts once deployed. A "high" here means our own scanner
// would warn users about us: either a real power we hold (say so in the
// docs), or a Neuro false positive (fix Neuro). It is informational in the
// report, not a vulnerability finding.
//
//   node audit/tools/neuro-dogfood.js --out <out> [--neuro <zetaphy-neuro dir>]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('--out', 'audit/out'));
const neuro = resolve(opt('--neuro', new URL('../../zetaphy-neuro', import.meta.url).pathname));
const imp = (p) => import(pathToFileURL(join(neuro, p)).href);

const { scanBytecode } = await imp('src/bytecode.js');
const { analyze } = await imp('src/analyze.js');
const { codeFingerprint } = await imp('src/fingerprint.js');
const { closestFlagged } = await imp('src/similarity.js');
const { THREAT_SIGNATURES } = await imp('src/threat-signatures.js');

const dir = join(out, 'raw', 'compile');
const results = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.runtime.json')).sort()) {
  const project = f.replace(/\.runtime\.json$/, '');
  const scope = existsSync(join(out, 'raw', 'scope.json')) ? JSON.parse(readFileSync(join(out, 'raw', 'scope.json'), 'utf8')) : null;
  const p = scope?.projects.find((x) => x.name === project);
  for (const [key, code] of Object.entries(JSON.parse(readFileSync(join(dir, f), 'utf8')))) {
    const [file, name] = key.split(':');
    if (p?.excluded?.[file]) continue;
    const scan = scanBytecode(code);
    const fingerprint = await codeFingerprint(code);
    const similar = closestFlagged(code, fingerprint, THREAT_SIGNATURES);
    const a = analyze({
      hasCode: true, functions: scan.functions, opcodes: scan.opcodes, proxy: { kind: null }, token: {},
      owner: undefined, unknownSelectors: scan.unknownSelectors, similar, dispatched: scan.selectors.length,
    });
    results.push({
      project, file: `${p?.root ?? project}/${file}`, name, level: a.level, control: a.control,
      findings: a.findings.map((x) => `${x.id}:${x.severity}`), similar: similar ? { percent: similar.percent, severity: similar.severity, flagged: similar.flagged } : null,
    });
  }
}
mkdirSync(join(out, 'raw', 'neuro'), { recursive: true });
writeFileSync(join(out, 'raw', 'neuro', 'results.json'), JSON.stringify({ neuro: 'zetaphy-neuro (src/bytecode.js + src/analyze.js, offline)', results }, null, 1));
const by = results.reduce((m, r) => ({ ...m, [r.level]: (m[r.level] ?? 0) + 1 }), {});
console.log(`neuro: ${results.length} contracts read; verdicts ${JSON.stringify(by)}`);
