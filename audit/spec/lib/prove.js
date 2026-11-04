// Runs the machine checks of an approved spec and writes proof.json / PROOF.md.
//
// A property is "proven" only when a prover (Halmos, the SMTChecker, or for `cei` the AST check)
// proved it and no tool found a counterexample. A tool that is not installed is "not-installed",
// a run that timed out or crashed is "unknown": neither ever counts as proven. A Halmos
// counterexample is replayed as a concrete forge test; "replayed: true" means a real EVM run hit
// the same failed assert.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { analyze, findSolc, REPO } from './analyze.js';
import { generate, replaySource } from './gen.js';
import { specHash, canonical, keccakText, hashBytes32Array, TOOL } from './spec.js';
import { keccak256 } from '../../../zetaphy-neuro/src/keccak.js';

const run = (cmd, args, { cwd, wallSec = 600, env = process.env } = {}) => new Promise((done) => {
  let child;
  try { child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { done({ code: -1, out: '', err: String(e), missing: true }); return; }
  let out = ''; let err = ''; let timedOut = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, wallSec * 1000);
  child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: String(e), missing: e.code === 'ENOENT' }); });
  child.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut }); });
});

const version = (cmd, args, re) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(re)?.[1] ?? null; } catch { return null; } };
const fileHash = (p) => '0x' + Buffer.from(keccak256(readFileSync(p))).toString('hex');
const tail = (s, n = 1500) => String(s ?? '').slice(-n);

export function toolVersions(bins = {}) {
  return {
    forge: version(bins.forge ?? 'forge', ['--version'], /forge(?: Version:)? (\S+)/),
    halmos: version(bins.halmos ?? 'halmos', ['--version'], /halmos (\S+)/),
    solc: version(bins.solc ?? process.env.SOLC ?? 'solc', ['--version'], /Version: (\S+)/),
  };
}

/**
 * @param specPath  an approved spec
 * @param opts.out  the work directory (default: <spec dir>/<Contract>.proof)
 * @param opts.tools  'halmos,forge,smtchecker' subset; opts.bins: {forge, halmos, solc}
 * @param opts.code  the deployed runtime code (hex) to compare with what was proven
 */
export async function prove(specPath, opts = {}) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const sh = specHash(spec);
  if (!spec.approval?.specHash) throw new Error('the spec is not approved: run `approve` first');
  if (spec.approval.specHash !== sh) throw new Error(`the spec changed after approval (approved ${spec.approval.specHash}, now ${sh}): approve it again`);
  const bins = { forge: opts.bins?.forge ?? 'forge', halmos: opts.bins?.halmos ?? 'halmos', solc: opts.bins?.solc ?? process.env.SOLC ?? 'solc' };
  const want = new Set(String(opts.tools ?? 'halmos,forge,smtchecker').split(','));
  const tools = toolVersions(bins);
  const model = analyze(join(REPO, spec.target.root, spec.target.file), spec.target.contract, { solc: findSolc(bins.solc) });
  const work = resolve(opts.out ?? join(resolve(specPath, '..'), `${spec.target.contract}.proof`));
  for (const d of ['test', 'out', 'cache']) rmSync(join(work, d), { recursive: true, force: true }); // a clean build every time
  mkdirSync(work, { recursive: true });
  const g = generate(spec, model, work);
  const approved = spec.properties.filter((p) => p.status === 'approved');
  const res = Object.fromEntries(approved.map((p) => [p.id, []])); // property -> [{tool, status, ...}]
  const runs = {};

  // ---- static: checks-effects-interactions on the AST
  for (const p of approved.filter((x) => x.kind === 'cei')) {
    const f = model.functions.find((x) => x.name === p.check.function);
    if (!f) { res[p.id].push({ tool: 'spec-ast', status: 'error', detail: 'function not found' }); continue; }
    const guarded = f.lockVars.length > 0 || f.nonReentrantMod;
    if (!f.writeAfterCall.length || guarded) res[p.id].push({ tool: 'spec-ast', status: 'proven', detail: guarded ? `behind a reentrancy lock (${f.lockVars.join(', ') || 'modifier'})` : 'no storage write after the first external call' });
    else res[p.id].push({ tool: 'spec-ast', status: 'counterexample', detail: `storage written after an external call: ${f.writeAfterCall.map((w) => `${w.var} line ${w.line}${w.via ? ` (in ${w.via})` : ''}`).join(', ')}`, counterexample: f.writeAfterCall });
  }

  // ---- build (forge), needed by halmos and the fuzzer
  const halmosChecks = Object.entries(g.checks);
  let built = null;
  if ((want.has('halmos') || want.has('forge')) && halmosChecks.length + approved.filter((p) => p.kind === 'invariant').length) {
    if (!tools.forge) built = { status: 'not-installed' };
    else {
      const b = await run(bins.forge, ['build', '--ast', '--root', work], { cwd: work, wallSec: 900 });
      writeFileSync(join(work, 'build.log'), b.out + b.err);
      built = b.code === 0 ? { status: 'ok' } : { status: 'error', detail: 'forge build failed: see build.log' };
    }
    runs.build = built;
  }

  // ---- Halmos: every check_*
  if (want.has('halmos') && halmosChecks.length) {
    const hp = spec.prover?.halmos ?? {};
    let status; let parsed = null; let detail = null;
    if (!tools.halmos) status = 'not-installed';
    else if (built?.status !== 'ok') status = built?.status === 'not-installed' ? 'not-installed' : 'error';
    else {
      const jf = join(work, 'halmos.json');
      rmSync(jf, { force: true });
      const r = await run(bins.halmos, ['--root', work, '--contract', 'SpecChecks', '--loop', String(Number(hp.loop ?? 3)),
        '--solver-timeout-assertion', String(Number(hp.solverTimeoutMs ?? 60000)), '--json-output', jf], { cwd: work, wallSec: Number(hp.wallSec ?? 1800) });
      runs.halmos = { code: r.code, timedOut: !!r.timedOut };
      writeFileSync(join(work, 'halmos.log'), r.out + r.err);
      if (r.timedOut) status = 'timeout';
      else if (existsSync(jf)) { parsed = JSON.parse(readFileSync(jf, 'utf8')); status = 'ran'; }
      else { status = 'error'; detail = tail(r.out + r.err); }
    }
    const results = new Map();
    if (parsed) for (const list of Object.values(parsed.test_results ?? {})) for (const t of list) results.set(t.name.split('(')[0], t);
    const models = {};
    for (const [pid, names] of halmosChecks) for (const n of names) {
      const t = results.get(n);
      let st; let extra = {};
      if (!t) st = status === 'ran' ? 'error' : status;
      else if (t.exitcode === 0 && !(t.num_bounded_loops > 0)) st = 'proven';
      else if (t.exitcode === 0) { st = 'unknown'; extra.detail = `${t.num_bounded_loops} loop(s) cut at --loop ${hp.loop ?? 3}: not a full proof`; }
      else if (t.exitcode === 1 && t.models?.some((m) => m.is_valid !== false)) {
        st = 'counterexample';
        const m = t.models.find((x) => x.is_valid !== false).model;
        const words = {};
        for (const [k, v] of Object.entries(m)) { const mm = k.match(/^p_w\[(\d+)\]_/); if (mm) words[mm[1]] = BigInt(v.value ?? 0).toString(); }
        extra.counterexample = words; extra.trace = g.explain(n, words); models[n] = words;
      } else { st = 'unknown'; extra.detail = `halmos exit code ${t.exitcode}${t.exitcode === 1 ? ' (counterexample not validated)' : ''}`; }
      if (detail && !extra.detail) extra.detail = detail;
      res[pid].push({ tool: 'halmos', check: n, status: st, ...extra });
    }
    // replay each counterexample in forge
    if (Object.keys(models).length && tools.forge) {
      writeFileSync(join(work, 'test/SpecReplay.t.sol'), replaySource(model, models, g.nmax));
      const r = await run(bins.forge, ['test', '--root', work, '--match-contract', 'SpecReplay', '--json'], { cwd: work, wallSec: 600 });
      runs.replay = { code: r.code };
      writeFileSync(join(work, 'replay.log'), r.out + r.err);
      let rep = {};
      try { rep = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* compile error: none replayed */ }
      const passed = new Set();
      for (const suite of Object.values(rep)) for (const [name, tr] of Object.entries(suite.test_results ?? {})) if (tr.status === 'Success') passed.add(name.replace(/^test_replay_/, '').split('(')[0]);
      for (const list of Object.values(res)) for (const e of list) if (e.tool === 'halmos' && e.status === 'counterexample') e.replayed = passed.has(e.check);
    }
  }

  // ---- forge: the invariants under the stateful fuzzer (evidence, never a proof)
  const invs = approved.filter((p) => p.kind === 'invariant');
  if (want.has('forge') && invs.length) {
    if (built?.status !== 'ok') for (const p of invs) res[p.id].push({ tool: 'forge', status: built?.status === 'not-installed' ? 'not-installed' : 'error' });
    else {
      const r = await run(bins.forge, ['test', '--root', work, '--match-contract', 'SpecInvariants', '--json'], { cwd: work, wallSec: 1800 });
      let rep = {};
      try { rep = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* none */ }
      const byName = {};
      for (const suite of Object.values(rep)) for (const [name, tr] of Object.entries(suite.test_results ?? {})) byName[name.split('(')[0]] = tr;
      for (const p of invs) {
        const tr = byName[`invariant_${p.id.replace(/[^A-Za-z0-9_]/g, '_')}`];
        if (!tr) res[p.id].push({ tool: 'forge', status: 'error', detail: tail(r.out + r.err, 600) });
        else if (tr.status === 'Success') res[p.id].push({ tool: 'forge', status: 'fuzz-passed', detail: `no violation in ${spec.prover?.forge?.runs ?? 256} runs x depth ${spec.prover?.forge?.depth ?? 20}` });
        else res[p.id].push({ tool: 'forge', status: 'counterexample', replayed: true, detail: tail(tr.reason ?? '', 300), counterexample: tr.counterexample ?? null });
      }
    }
  }

  // ---- SMTChecker (CHC): the state invariants, unbounded
  const smtProps = Object.entries(g.smt);
  if (want.has('smtchecker') && smtProps.length) {
    const sp = spec.prover?.smtchecker ?? {};
    const solcBin = tools.solc ? bins.solc : null;
    const sources = { ...model.sources, 'smt/SpecSMT.sol': { content: g.files['smt/SpecSMT.sol'] } };
    const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      modelChecker: { engine: sp.engine ?? 'chc', contracts: { 'smt/SpecSMT.sol': [`__Spec_${model.name}`] }, targets: ['assert'], timeout: Number(sp.timeoutMs ?? 60000), showUnproved: true, solvers: ['z3'] },
      outputSelection: { '*': { '': [] } } } };
    writeFileSync(join(work, 'smt/input.json'), JSON.stringify(input));
    let msgs = null; let st = null; let detail = null;
    if (!solcBin) st = 'not-installed';
    else {
      const r = await new Promise((done) => {
        // no shell: solc reads the input file on stdin, its address space capped at 4 GiB by prlimit (util-linux)
        const input = openSync(join(work, 'smt/input.json'), 'r');
        const child = spawn('prlimit', [`--as=${4 * 1024 ** 3}`, '--', solcBin, '--standard-json'], { stdio: [input, 'pipe', 'pipe'] });
        closeSync(input);
        let out = ''; let to = false;
        child.stdout.on('data', (d) => { out += d; });
        const timer = setTimeout(() => { to = true; child.kill('SIGKILL'); }, Number(sp.wallSec ?? 600) * 1000);
        child.on('error', (e) => { clearTimeout(timer); done({ out: String(e.message), code: -1, to }); });
        child.on('close', (code) => { clearTimeout(timer); done({ out, code, to }); });
      });
      if (r.to) st = 'timeout';
      else {
        try { msgs = JSON.parse(r.out).errors ?? []; } catch { st = 'error'; detail = tail(r.out); }
        if (msgs?.some((m) => m.severity === 'error')) { st = 'error'; detail = msgs.filter((m) => m.severity === 'error').map((m) => m.message).join('; '); msgs = null; }
        if (msgs?.some((m) => /solver.*not (available|found)|z3.*not/i.test(m.message))) { st = 'not-installed'; detail = 'z3 (libz3.so.4.12) not found: LD_LIBRARY_PATH from audit/tools/install.sh'; msgs = null; }
      }
    }
    const src = g.files['smt/SpecSMT.sol'];
    for (const [pid, fn] of smtProps) {
      if (!msgs) { res[pid].push({ tool: 'smtchecker', status: st, ...(detail ? { detail } : {}) }); continue; }
      const start = src.indexOf(`function ${fn}(`);
      const end = src.indexOf('\n', start);
      const mine = msgs.filter((m) => m.sourceLocation?.file === 'smt/SpecSMT.sol' && m.sourceLocation.start >= start && m.sourceLocation.start < end);
      const viol = mine.find((m) => /Assertion violation happens/.test(m.message));
      const maybe = mine.find((m) => /might happen|could not be proved|unproved/i.test(m.message));
      const other = msgs.find((m) => /CHC analysis was not possible|Error trying to invoke SMT solver/i.test(m.message));
      if (viol) res[pid].push({ tool: 'smtchecker', status: 'counterexample', replayed: false, detail: tail(viol.message, 1500) });
      else if (maybe) res[pid].push({ tool: 'smtchecker', status: 'unknown', detail: 'CHC could not prove it in the time given' });
      else if (other) res[pid].push({ tool: 'smtchecker', status: /invoke SMT solver/.test(other.message) ? 'not-installed' : 'unknown', detail: tail(other.message, 300) });
      else res[pid].push({ tool: 'smtchecker', status: 'proven', detail: 'CHC: holds in every reachable state (unbounded)' });
    }
  }

  // ---- verdict per property
  const properties = approved.map((p) => {
    const by = res[p.id];
    const hal = by.filter((e) => e.tool === 'halmos');
    // a proof: every Halmos check of the property proved, or the SMTChecker / the AST check proved it whole
    const proved = (hal.length && hal.every((e) => e.status === 'proven')) || by.some((e) => (e.tool === 'smtchecker' || e.tool === 'spec-ast') && e.status === 'proven');
    let status;
    if (by.some((e) => e.status === 'counterexample')) status = 'counterexample';
    else if (proved) status = 'proven';
    else if (by.length && by.every((e) => e.status === 'not-installed')) status = 'not-installed';
    else status = 'unknown';
    return { id: p.id, kind: p.kind, title: p.title, scope: p.scope ?? null, status, by };
  });
  const summary = {
    properties: properties.length,
    proven: properties.filter((p) => p.status === 'proven').length,
    counterexamples: properties.filter((p) => p.status === 'counterexample').length,
    unknown: properties.filter((p) => p.status === 'unknown' || p.status === 'not-installed').length,
  };
  summary.allProven = summary.properties > 0 && summary.proven === summary.properties;

  // runtime code hash of what was proven (immutables zeroed, as compiled)
  let runtimeHash = null; let codeMatch = null;
  const art = join(work, 'out', model.file.split('/').pop(), `${model.name}.json`);
  if (existsSync(art)) {
    const a = JSON.parse(readFileSync(art, 'utf8'));
    const code = Buffer.from(String(a.deployedBytecode?.object ?? '').replace(/^0x/, ''), 'hex');
    runtimeHash = '0x' + Buffer.from(keccak256(code)).toString('hex');
    if (opts.code) {
      const dep = Buffer.from(String(opts.code).replace(/^0x/, ''), 'hex');
      for (const refs of Object.values(a.deployedBytecode?.immutableReferences ?? {})) for (const r of refs) dep.fill(0, r.start, r.start + r.length);
      codeMatch = dep.equals(code);
    }
  }
  // (foundry.toml is left out: it names this machine's forge-std path)
  const artifactFiles = ['test/Spec.t.sol', 'smt/SpecSMT.sol'].filter((f) => existsSync(join(work, f)));
  const artifacts = artifactFiles.map((f) => ({ path: f, hash: fileHash(join(work, f)) }));
  const toolsString = Object.entries(tools).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; ');
  const canonicalResult = {
    kind: 'zetaphy-proof-result', v: 1, specHash: sh, sourceHash: spec.target.sourceHash, runtimeHash,
    tools: toolsString, artifacts: artifacts.map((a) => a.hash),
    properties: properties.map((p) => ({ id: p.id, status: p.status })),
  };
  const proof = {
    schema: 'zetaphy.proof/1', by: TOOL, contract: spec.target.contract, file: `${spec.target.root}/${spec.target.file}`,
    specHash: sh, sourceHash: spec.target.sourceHash, runtimeHash, codeMatch, tools,
    artifacts, artifactsHash: hashBytes32Array(artifacts.map((a) => a.hash)),
    recipe: {
      install: 'bash audit/tools/install.sh <dir> fast  # forge 1.2.3, halmos 0.3.3 (pip, hashed), solc 0.8.26 (sha256-checked)',
      run: `node audit/spec/cli.js prove ${relative(REPO, resolve(specPath))}`,
      halmos: `halmos --root <work> --contract SpecChecks --loop ${spec.prover?.halmos?.loop ?? 3} --solver-timeout-assertion ${spec.prover?.halmos?.solverTimeoutMs ?? 60000}`,
    },
    summary, properties, resultHash: keccakText(canonical(canonicalResult)),
    runs,
  };
  proof.recipeHash = keccakText(canonical(proof.recipe));
  writeFileSync(join(work, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  writeFileSync(join(work, 'PROOF.md'), proofMarkdown(proof));
  return { proof, work };
}

/** The runners' tuple for ProofRegistry (resultHash, proven, counterexamples, unknown). */
export const outcomeOf = (proof) => ({ resultHash: proof.resultHash, proven: proof.summary.proven, counterexamples: proof.summary.counterexamples, unknown: proof.summary.unknown });

export function proofMarkdown(proof) {
  const L = [`# Proof run: ${proof.contract}`, '',
    `Spec hash \`${proof.specHash}\`, source hash \`${proof.sourceHash}\`, runtime code hash (immutables zeroed) \`${proof.runtimeHash ?? 'not built'}\`.`,
    `Tools: ${Object.entries(proof.tools).map(([k, v]) => `${k} ${v ?? '**not installed**'}`).join(', ')}.`, '',
    `**${proof.summary.proven} of ${proof.summary.properties} properties proven**, ${proof.summary.counterexamples} with a counterexample, ${proof.summary.unknown} unknown or not run.`,
    'A "proven" property holds for every input within its stated scope; "not-installed" and "unknown" are never counted as proven.', '',
    '| Property | Kind | Result | Evidence |', '|---|---|---|---|'];
  for (const p of proof.properties) {
    const ev = p.by.map((e) => `${e.tool}${e.check ? ` \`${e.check}\`` : ''}: ${e.status}${e.replayed === true ? ' (replayed in forge)' : ''}`).join('<br>');
    L.push(`| \`${p.id}\` | ${p.kind} | **${p.status}** | ${ev} |`);
  }
  L.push('');
  for (const p of proof.properties.filter((x) => x.status === 'counterexample')) {
    L.push(`## Counterexample: \`${p.id}\``, '', p.title, '');
    for (const e of p.by.filter((x) => x.status === 'counterexample')) {
      if (e.detail) L.push(`- ${e.tool}: ${e.detail.replace(/\n/g, ' ')}`);
      if (e.counterexample && e.tool === 'halmos') {
        L.push(`- ${e.tool} \`${e.check}\`${e.replayed ? ' (replayed concretely in forge: the same assert fails)' : ''}: from the setup state,`);
        for (const [i, s] of (e.trace ?? []).entries()) L.push(`  ${i + 1}. ${s}`);
      }
    }
    L.push('');
  }
  L.push(`Artifacts hash \`${proof.artifactsHash}\`, result hash \`${proof.resultHash}\`, recipe hash \`${proof.recipeHash}\`.`, '',
    'Reproduce: `' + proof.recipe.install + '` then `' + proof.recipe.run + '`.', '');
  return L.join('\n');
}
