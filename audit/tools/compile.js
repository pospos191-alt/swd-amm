#!/usr/bin/env node
// Compiles every audited project with the native solc (pinned in run.sh) and
// records, per contract, the keccak-256 of its runtime bytecode (what a chain
// stores, and what an auditor's report is tied to). In this repository it also
// checks that each committed artifacts/<Name>.json was built from the source
// as it is now (the CLIs deploy those artifacts, not the .sol files).
//
//   node audit/tools/compile.js --target <dir> --out <out dir> [--scope audit/scope.json] [--solc <binary>]
// Writes <out>/raw/scope.json and <out>/raw/compile/<project>.json.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadScope, sourceClosure, countLoc } from '../lib/scope.js';
import { keccak256 } from '../../zetaphy-neuro/src/keccak.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const target = resolve(opt('--target', '.'));
const out = resolve(opt('--out', 'audit/out'));
const scopeFile = opt('--scope', null);
const solc = opt('--solc', process.env.SOLC || 'solc');

const hex = (b) => Buffer.from(b).toString('hex');
export const codeHash = (runtimeHex) => '0x' + hex(keccak256(Buffer.from(runtimeHex.replace(/^0x/, ''), 'hex')));

const scope = loadScope(target, scopeFile ? JSON.parse(readFileSync(scopeFile, 'utf8')) : null);
mkdirSync(join(out, 'raw', 'compile'), { recursive: true });
const solcVersion = execFileSync(solc, ['--version'], { encoding: 'utf8' }).match(/Version: (\S+)/)?.[1] ?? 'unknown';

const scopeOut = { mode: scope.mode, target, solc: solcVersion, projects: [] };
for (const p of scope.projects) {
  const root = join(target, p.root);
  const { sources, missing } = sourceClosure(root, p.files, p.remappings);
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      ...p.settings,
      // no remappings here: sourceClosure already gave every import its unit name and content
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  let res;
  try {
    res = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 }));
  } catch (e) { res = { errors: [{ severity: 'error', formattedMessage: String(e.message) }] }; }
  const errors = (res.errors ?? []).filter((e) => e.severity === 'error').map((e) => e.formattedMessage);
  const warnings = (res.errors ?? []).filter((e) => e.severity === 'warning').map((e) => ({
    file: e.sourceLocation?.file, start: e.sourceLocation?.start, code: e.errorCode, message: e.message,
  }));
  const contracts = [];
  const runtimes = {};
  for (const [file, byName] of Object.entries(res.contracts ?? {})) {
    if (!p.files.includes(file)) continue; // dependency code: no hash of its own
    for (const [name, c] of Object.entries(byName)) {
      const runtime = c.evm?.deployedBytecode?.object ?? '';
      if (!runtime) continue; // interfaces / abstract contracts
      let artifactMatch = null;
      const art = join(root, 'artifacts', `${name}.json`);
      if (scope.mode === 'repo' && existsSync(art)) {
        try {
          const a = JSON.parse(readFileSync(art, 'utf8'));
          if (a.sourceName === file) artifactMatch = (a.deployedBytecode ?? '').replace(/^0x/, '') === runtime;
        } catch { /* unreadable artifact: unknown */ }
      }
      contracts.push({ file, name, runtimeHash: codeHash(runtime), size: runtime.length / 2, excluded: !!p.excluded[file], artifactMatch });
      runtimes[`${file}:${name}`] = '0x' + runtime;
    }
  }
  // line offsets -> line numbers for the warnings (report.js wants lines)
  for (const w of warnings) if (w.file && sources[w.file] && w.start >= 0) w.line = sources[w.file].content.slice(0, w.start).split('\n').length;
  const loc = Object.fromEntries(p.files.map((f) => [f, countLoc(sources[f]?.content ?? '')]));
  writeFileSync(join(out, 'raw', 'compile', `${p.name}.json`), JSON.stringify({ project: p.name, root: p.root, solc: solcVersion, errors, missing, warnings, contracts }, null, 1));
  writeFileSync(join(out, 'raw', 'compile', `${p.name}.runtime.json`), JSON.stringify(runtimes));
  scopeOut.projects.push({ name: p.name, root: p.root, files: p.files, excluded: p.excluded, remappings: p.remappings, loc });
  console.log(`compile ${p.name}: ${contracts.length} contracts, ${errors.length} errors${missing.length ? `, missing imports: ${missing.join(', ')}` : ''}`);
}
writeFileSync(join(out, 'raw', 'scope.json'), JSON.stringify(scopeOut, null, 1));
