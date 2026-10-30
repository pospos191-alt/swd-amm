#!/usr/bin/env node
// solc's built-in formal checker (SMTChecker) on the core contracts: tries to
// PROVE that no input makes an assert fail, divides by zero, indexes out of
// bounds or over/underflows; when it finds a counterexample it prints it.
// "Could not be proved" is NOT a finding (time ran out) and is reported as
// such, separately.
//
//   node audit/tools/smtchecker.js --target <repo> --out <out> --scope audit/scope.json [--tier fast|deep] [--solc <bin>]
// Fast tier: BMC engine (bounded, each function on its own: it does not know
// the contract's state invariants, so its overflow reports are often
// unreachable in practice), the first 4 core contracts, 1 s per query, 5 min
// per contract, 4 at once. Deep tier: CHC engine (whole contract, state across
// transactions), every core contract, 60 s per query, 15 min per contract
// (SMT_WALL=1800 in run.sh for the long budget),
// 3 at once. Each contract runs in its own solc process with a wall clock and
// a memory cap (z3 can eat all memory); one that hits either reports nothing
// ("time-budget" / "out-of-memory"), which is not a pass.
// Needs z3 4.12 (libz3.so.4.12) on LD_LIBRARY_PATH: tools/install.sh installs it (pip z3-solver).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { sourceClosure } from '../lib/scope.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const target = resolve(opt('--target', '.'));
const out = resolve(opt('--out', 'audit/out'));
const tier = opt('--tier', 'fast');
const solc = opt('--solc', process.env.SOLC || 'solc');
const scope = JSON.parse(readFileSync(opt('--scope', join(target, 'audit/scope.json')), 'utf8'));
const deep = tier === 'deep';
const files = deep ? scope.core.smtchecker : scope.core.smtchecker.slice(0, 4);
const wallSec = Number(opt('--wall', deep ? 900 : 300));
const parallel = Number(opt('--jobs', deep ? 3 : 4));
const memKb = Number(opt('--mem-kb', (deep ? 4 : 3) * 1024 * 1024));
mkdirSync(join(out, 'raw', 'smtchecker'), { recursive: true });

const run = (input) => new Promise((done) => {
  const t0 = Date.now();
  const child = spawn('bash', ['-c', `ulimit -v ${memKb}; exec "$0" --standard-json`, solc], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let timedOut = false;
  child.stdout.on('data', (d) => { stdout += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, wallSec * 1000);
  child.on('close', (code, signal) => { clearTimeout(timer); done({ stdout, code, signal, timedOut, secs: Math.round((Date.now() - t0) / 1000) }); });
  child.stdin.end(JSON.stringify(input));
});

async function check(path) {
  const project = scope.projects.find((p) => path.startsWith(p.root + '/'));
  const file = path.slice(project.root.length + 1);
  const root = join(target, project.root);
  const { sources } = sourceClosure(root, [file], project.remappings ?? []);
  const names = [...sources[file].content.matchAll(/^\s*(?:abstract\s+)?(?:contract|library)\s+(\w+)/gm)].map((m) => m[1]);
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      ...project.settings,
      modelChecker: {
        engine: deep ? 'chc' : 'bmc',
        contracts: { [file]: names },
        targets: ['assert', 'divByZero', 'outOfBounds', 'overflow', 'underflow', 'popEmptyArray'],
        timeout: deep ? 60000 : 1000,
        showUnproved: true,
        solvers: ['z3'],
      },
      outputSelection: { '*': { '': [] } },
    },
  };
  const r = await run(input);
  let status = 'done';
  let messages = [];
  if (r.timedOut) status = 'time-budget';
  else if (r.signal || r.code) status = 'out-of-memory-or-crash';
  else {
    try {
      const o = JSON.parse(r.stdout);
      messages = (o.errors ?? []).map((e) => ({
        code: e.errorCode, severity: e.severity, message: e.message, file: e.sourceLocation?.file,
        line: e.sourceLocation && sources[e.sourceLocation.file] ? sources[e.sourceLocation.file].content.slice(0, e.sourceLocation.start).split('\n').length : null,
      })).filter((m) => /^(BMC|CHC):/.test(m.message) || ['8158', '7649'].includes(m.code) || m.severity === 'error');
      if ((o.errors ?? []).some((e) => e.severity === 'error')) status = 'compile-error';
      if (messages.some((m) => m.code === '8158' || m.code === '7649')) status = 'no-solver';
    } catch { status = 'bad-output'; }
  }
  console.log(`smtchecker ${path}: ${status}, ${messages.length} messages, ${r.secs}s`);
  return { file: `${project.root}/${file}`, root: project.root, engine: input.settings.modelChecker.engine, contracts: names, status, seconds: r.secs, messages };
}

const queue = [...files];
const results = [];
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  while (queue.length) { const f = queue.shift(); results.push(await check(f)); }
}));
results.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
writeFileSync(join(out, 'raw', 'smtchecker', 'results.json'), JSON.stringify({ tier, results }, null, 1));
