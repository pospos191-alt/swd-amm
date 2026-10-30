#!/usr/bin/env node
// A small mutation tester: how good are the existing tests at noticing a bug?
// It plants one small bug at a time (a "mutant") in a core contract, rebuilds
// that contract's artifacts, and runs the tests that use it. A mutant the
// tests catch is "killed"; one they miss "survives" and shows a line whose
// behaviour no test pins down. Score = killed / (killed + survived).
//
//   node audit/tools/mutate.js --target <repo> --out <out> --scope audit/scope.json [--max 30] [--solc <bin>] [--test-timeout 600]
//
// Like Gambit, the operators are syntactic (no type information); mutants
// that do not compile ("stillborn") and mutants whose runtime bytecode equals
// the original's ("equivalent") are not counted. Mutants are spread evenly
// over the file (deterministic: the same commit gives the same mutants).
// Runs IN PLACE (contracts/ and artifacts/ of the project are rewritten and
// restored after each mutant; a crash is repaired at the next start from the
// backup in <out>/raw/mutation/backup.json). CI checkouts are throwaway; on a
// workstation, run it on a clean tree.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sourceClosure, loadScope } from '../lib/scope.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const target = resolve(opt('--target', '.'));
const out = resolve(opt('--out', 'audit/out'));
const solc = opt('--solc', process.env.SOLC || 'solc');
const maxPerFile = Number(opt('--max', 30));
const testTimeout = Number(opt('--test-timeout', 600));
const only = opt('--only', null);

/** Mutation operators: [name, regex on one code line, replacement]. */
export const OPERATORS = [
  ['binop + -> -', / \+ /, ' - '], ['binop - -> +', / - /, ' + '],
  ['binop * -> /', / \* /, ' / '], ['binop / -> *', / \/ /, ' * '],
  ['rel < -> <=', / < /, ' <= '], ['rel <= -> <', / <= /, ' < '],
  ['rel > -> >=', / > /, ' >= '], ['rel >= -> >', / >= /, ' > '],
  ['rel == -> !=', / == /, ' != '], ['rel != -> ==', / != /, ' == '],
  ['logic && -> ||', / && /, ' || '], ['logic || -> &&', / \|\| /, ' && '],
  ['assign += -> -=', / \+= /, ' -= '], ['assign -= -> +=', / -= /, ' += '],
  ['require -> true', /\brequire\((.*)\);/, (l) => l.replace(/\brequire\(.*\);/, 'require(true);')],
  ['if-cond -> false', /\bif \((.+)\) (revert|return)\b/, (l) => l.replace(/\bif \((.+)\) (revert|return)\b/, 'if (false) $2')],
  ['delete state update', /^\s*[\w.[\]]+\s*(\+|-)?=\s*[^=].*;\s*$/, (l) => l.replace(/^(\s*)(.*)$/, '$1/* mutant: deleted */')],
];

/** Every mutant of a source: [{line, op, text}], skipping comments, imports, pragmas, declarations. */
export function mutants(src) {
  const lines = src.split('\n');
  const all = [];
  let block = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (block) { if (t.includes('*/')) block = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) block = true; return; }
    if (!t || t.startsWith('//') || t.startsWith('*') || /^(pragma|import|event|error|emit|interface|contract|library|function|modifier|constructor|struct|enum|mapping)\b/.test(t)) return;
    if (/\b(constant|immutable)\b/.test(t)) return;
    const code = l.replace(/\/\/.*$/, '');
    for (const [op, re, rep] of OPERATORS) {
      if (!re.test(code)) continue;
      const text = typeof rep === 'function' ? rep(code) : code.replace(re, rep);
      if (text !== code) all.push({ line: i + 1, op, text });
    }
  });
  return all;
}

/** n mutants spread evenly over the list. */
export const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.floor((k * list.length) / n)]));

/** Runtime bytecode without the CBOR metadata tail (which changes with any source edit). */
export function stripMetadata(hex) {
  const h = hex.replace(/^0x/, '');
  if (h.length < 4) return h;
  const len = parseInt(h.slice(-4), 16);
  return len * 2 + 4 > h.length ? h : h.slice(0, h.length - 4 - len * 2);
}

/** Compiles the whole project (factories embed their children's creation code), with one file replaced. */
function compile(projectRoot, project, files, file, content) {
  const { sources } = sourceClosure(projectRoot, files, project.remappings ?? []);
  sources[file] = { content };
  const input = { language: 'Solidity', sources, settings: { ...project.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const res = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 }));
  if ((res.errors ?? []).some((e) => e.severity === 'error')) return null;
  const byName = {};
  for (const [src, cs] of Object.entries(res.contracts ?? {})) for (const [n, c] of Object.entries(cs)) if (c.evm?.bytecode?.object) byName[`${src}:${n}`] = { src, name: n, ...c };
  return byName;
}

function main() {
  const backupFile = join(out, 'raw', 'mutation', 'backup.json');
  mkdirSync(join(out, 'raw', 'mutation'), { recursive: true });
  const restore = (b) => { for (const [p, c] of Object.entries(b)) writeFileSync(p, c); };
  if (existsSync(backupFile)) { restore(JSON.parse(readFileSync(backupFile, 'utf8'))); rmSync(backupFile); console.log('mutate: restored files left by an interrupted run'); }

  const scope = JSON.parse(readFileSync(opt('--scope', join(target, 'audit/scope.json')), 'utf8'));
  const results = [];
  for (const { file: path } of scope.core.mutation) {
    if (only && !path.includes(only)) continue;
    const project = scope.projects.find((p) => path.startsWith(p.root + '/'));
    const projectRoot = join(target, project.root);
    const file = path.slice(project.root.length + 1);
    const original = readFileSync(join(projectRoot, file), 'utf8');
    const projFiles = loadScope(target, { projects: [project] }).projects[0].files;
    const base = compile(projectRoot, project, projFiles, file, original);
    const names = Object.values(base ?? {}).filter((c) => c.src === file && c.evm.deployedBytecode.object).map((c) => c.name);
    const artDir = join(projectRoot, 'artifacts');
    const artPaths = readdirSync(artDir).filter((f) => f.endsWith('.json')).map((f) => join(artDir, f));
    // the tests that load one of these artifacts (not the reproducible-build test, which any edit fails)
    const testDir = join(projectRoot, 'test');
    const tests = readdirSync(testDir).filter((f) => f.endsWith('.test.js') && f !== 'build.test.js')
      .filter((f) => { const s = readFileSync(join(testDir, f), 'utf8'); return names.some((n) => new RegExp(`['"\`/]${n}['".]`).test(s)); })
      .map((f) => join('test', f));
    const entry = { file: path, contracts: names, tests, killed: 0, survived: 0, stillborn: 0, equivalent: 0, timeouts: 0, survivors: [], seconds: 0 };
    results.push(entry);
    if (!tests.length) { entry.note = 'no test file loads these contracts'; continue; }
    const runTests = () => spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd: projectRoot, encoding: 'utf8', timeout: testTimeout * 1000 });
    const t0 = Date.now();
    const sane = runTests();
    if (sane.status !== 0) { entry.note = 'the tests fail on the unmutated code; nothing measured'; entry.seconds = Math.round((Date.now() - t0) / 1000); continue; }
    const backup = Object.fromEntries([[join(projectRoot, file), original], ...artPaths.map((p) => [p, readFileSync(p, 'utf8')])]);
    writeFileSync(backupFile, JSON.stringify(backup));
    const lines = original.split('\n');
    const chosen = spread(mutants(original), maxPerFile);
    try {
      for (const m of chosen) {
        const mutated = lines.map((l, i) => (i + 1 === m.line ? m.text : l)).join('\n');
        const c = compile(projectRoot, project, projFiles, file, mutated);
        if (!c) { entry.stillborn++; continue; }
        // equivalent: the mutated file's contracts run the same code (metadata aside)
        const changed = Object.keys(base).filter((k) => base[k].src === file && c[k]
          && stripMetadata(c[k].evm.deployedBytecode.object) !== stripMetadata(base[k].evm.deployedBytecode.object));
        if (!changed.length) { entry.equivalent++; continue; }
        // rewrite every artifact whose code changed: the mutated contract and any that embeds it (a factory)
        writeFileSync(join(projectRoot, file), mutated);
        for (const k of Object.keys(base)) {
          if (!c[k] || c[k].evm.bytecode.object === base[k].evm.bytecode.object) continue;
          const p = join(artDir, `${c[k].name}.json`);
          if (!backup[p]) continue;
          const art = JSON.parse(backup[p]);
          if (art.sourceName !== c[k].src) continue;
          art.abi = c[k].abi; art.bytecode = '0x' + c[k].evm.bytecode.object; art.deployedBytecode = '0x' + c[k].evm.deployedBytecode.object;
          writeFileSync(p, JSON.stringify(art, null, 2) + '\n');
        }
        const r = runTests();
        if (r.error?.code === 'ETIMEDOUT') { entry.timeouts++; entry.killed++; } else if (r.status === 0) {
          entry.survived++; entry.survivors.push({ line: m.line, op: m.op, original: lines[m.line - 1].trim(), mutant: m.text.trim() });
        } else entry.killed++;
        restore(backup);
      }
    } finally { restore(backup); rmSync(backupFile, { force: true }); }
    entry.seconds = Math.round((Date.now() - t0) / 1000);
    const counted = entry.killed + entry.survived;
    entry.score = counted ? entry.killed / counted : null;
    console.log(`mutate ${path}: ${entry.killed} killed, ${entry.survived} survived, ${entry.stillborn} stillborn, ${entry.equivalent} equivalent (${entry.seconds}s)`);
  }
  const k = results.reduce((s, r) => s + r.killed, 0);
  const s = results.reduce((s2, r) => s2 + r.survived, 0);
  writeFileSync(join(out, 'raw', 'mutation', 'results.json'), JSON.stringify({ maxPerFile, score: k + s ? k / (k + s) : null, results }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
