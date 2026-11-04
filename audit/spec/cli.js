#!/usr/bin/env node
// SS6: the machine drafts the spec, a human approves it, the provers prove it.
//
//   node audit/spec/cli.js draft <file.sol> --contract <Name> [--docs a.md,b.md] [--llm] [--with review.json] [--out <spec.json>]
//        heuristics (no AI) + the optional LLM step (only with ANTHROPIC_API_KEY and --llm):
//        writes <spec.json> and <spec.md> for review; every property "proposed". --with merges a reviewer's
//        harness, prover settings and extra properties ({harness, prover, properties, reject})
//   node audit/spec/cli.js approve <spec.json> --reviewer <name> (--all | --ids a,b) [--reject c,d]
//        marks properties approved / rejected and records the spec hash
//   node audit/spec/cli.js gen <spec.json> [--out <dir>]      the Halmos / forge / SMTChecker artifacts only
//   node audit/spec/cli.js prove <spec.json> [--out <dir>] [--tools halmos,forge,smtchecker] [--code <hex|file>]
//        generates, runs the pinned tools (audit/tools/install.sh), writes proof.json + PROOF.md;
//        exit 0 only when every approved property is proven, 1 when a counterexample was found, 2 otherwise
//   node audit/spec/cli.js hash <spec.json>                    the spec hash (what ProofRegistry records)
//   node audit/spec/cli.js outcome <proof.json>                the runners' tuple for ProofRegistry
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { analyze, findSolc } from './lib/analyze.js';
import { draft } from './lib/heuristics.js';
import { propose } from './lib/llm.js';
import { toMarkdown, specHash, validateSpec, harnessViewNames } from './lib/spec.js';
import { generate } from './lib/gen.js';
import { prove, outcomeOf } from './lib/prove.js';
import { REPO } from './lib/analyze.js';
import { getters } from './lib/analyze.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);
const die = (m, code = 2) => { console.error(m); process.exit(code); };
const writeSpec = (path, spec) => {
  writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
  writeFileSync(path.replace(/\.json$/, '.md'), toMarkdown(spec));
};
const modelOf = (spec) => analyze(join(REPO, spec.target.root, spec.target.file), spec.target.contract, { solc: findSolc() });
const validationModel = (spec, model) => ({ functions: model.functions.filter((f) => f.kind === 'function' && !f.view).map((f) => f.name), views: Object.keys(getters(model.abi)), harnessViews: harnessViewNames(spec.harness?.views) });

async function main() {
  if (cmd === 'draft') {
    const file = args[1];
    const name = opt('--contract') ?? basename(file ?? '', '.sol');
    if (!file || !existsSync(file)) die('usage: draft <file.sol> --contract <Name> [--docs a.md,b.md] [--llm] [--out spec.json]');
    const docs = (opt('--docs') ?? '').split(',').filter(Boolean).map((p) => ({ name: p, text: readFileSync(p, 'utf8') }));
    const model = analyze(file, name);
    const spec = draft(model, { docs });
    if (opt('--with')) {
      // a reviewer's file: { harness: {...}, prover: {...}, properties: [...], reject: [ids] }
      const w = JSON.parse(readFileSync(opt('--with'), 'utf8'));
      const lines = (v) => (Array.isArray(v) ? v.join('\n') : v);  // code may be written as an array of lines
      for (const k of ['setup', 'helpers', 'state', 'views']) if (w.harness?.[k] !== undefined) w.harness[k] = lines(w.harness[k]);
      for (const k of Object.keys(w.harness?.actions ?? {})) w.harness.actions[k] = lines(w.harness.actions[k]);
      if (w.harness) spec.harness = { ...spec.harness, ...w.harness, status: 'reviewed', notes: [...(w.harness.notes ?? [`harness written by a reviewer: ${opt('--with')}`])] };
      if (w.prover) spec.prover = { ...spec.prover, ...w.prover };
      for (const p of w.properties ?? []) spec.properties.push({ origin: 'human', status: 'proposed', confidence: 'reviewer', ...p });
      for (const id of w.reject ?? []) { const p = spec.properties.find((x) => x.id === id); if (p) p.status = 'rejected'; }
      spec.drafted.review = opt('--with');
    }
    if (flag('--llm')) {
      if (!process.env.ANTHROPIC_API_KEY) console.error('LLM step skipped: ANTHROPIC_API_KEY is not set (the heuristics draft is complete without it)');
      else {
        const r = await propose(model, spec, { docs });
        spec.properties.push(...r.properties);
        spec.drafted.llm = { provider: 'anthropic', model: r.model, accepted: r.properties.length, rejected: r.rejected };
      }
    }
    const out = opt('--out') ?? `${name}.spec.json`;
    writeSpec(out, spec);
    console.log(`${out}: ${spec.properties.length} properties proposed (${spec.properties.filter((p) => p.origin === 'llm').length} by the LLM), ${spec.notes.length} notes; harness ${spec.harness.status}`);
    console.log(`review ${out.replace(/\.json$/, '.md')}, then: node audit/spec/cli.js approve ${out} --reviewer <name> --ids … | --all`);
    return;
  }
  if (cmd === 'approve') {
    const path = args[1];
    const reviewer = opt('--reviewer');
    if (!path || !reviewer) die('usage: approve <spec.json> --reviewer <name> (--all | --ids a,b) [--reject c,d]');
    const spec = JSON.parse(readFileSync(path, 'utf8'));
    const ids = flag('--all') ? spec.properties.map((p) => p.id) : (opt('--ids') ?? '').split(',').filter(Boolean);
    const rej = (opt('--reject') ?? '').split(',').filter(Boolean);
    for (const id of [...ids, ...rej]) if (!spec.properties.some((p) => p.id === id)) die(`no property ${id}`);
    for (const p of spec.properties) {
      if (rej.includes(p.id)) p.status = 'rejected';
      else if (ids.includes(p.id)) p.status = 'approved';
    }
    const errs = validateSpec(spec, validationModel(spec, modelOf(spec)));
    if (errs.length) die(`the spec is not valid:\n- ${errs.join('\n- ')}`);
    if (!spec.properties.some((p) => p.status === 'approved')) die('nothing approved');
    spec.approval = { reviewer, at: new Date().toISOString().slice(0, 10), specHash: specHash(spec) };
    writeSpec(path, spec);
    console.log(`${path}: ${spec.properties.filter((p) => p.status === 'approved').length} approved, ${spec.properties.filter((p) => p.status === 'rejected').length} rejected; spec hash ${spec.approval.specHash}`);
    return;
  }
  if (cmd === 'hash') { console.log(specHash(JSON.parse(readFileSync(args[1], 'utf8')))); return; }
  if (cmd === 'outcome') { console.log(JSON.stringify(outcomeOf(JSON.parse(readFileSync(args[1], 'utf8'))))); return; }
  if (cmd === 'gen') {
    const spec = JSON.parse(readFileSync(args[1], 'utf8'));
    const out = resolve(opt('--out') ?? `${spec.target.contract}.proof`);
    const g = generate(spec, modelOf(spec), out);
    console.log(`${out}: ${Object.values(g.checks).flat().length} Halmos checks, ${Object.keys(g.smt).length} SMTChecker targets`);
    return;
  }
  if (cmd === 'prove') {
    let code = opt('--code');
    if (code && existsSync(code)) code = readFileSync(code, 'utf8').trim();
    const { proof, work } = await prove(args[1], { out: opt('--out'), tools: opt('--tools') ?? undefined, code });
    for (const p of proof.properties) console.log(`${p.status.padEnd(15)} ${p.id}  ${p.by.map((e) => `${e.tool}:${e.status}${e.replayed ? '(replayed)' : ''}`).join(' ')}`);
    const s = proof.summary;
    console.log(`\n${s.proven}/${s.properties} proven, ${s.counterexamples} counterexample(s), ${s.unknown} unknown/not run. ${work}/proof.json`);
    process.exit(s.allProven ? 0 : s.counterexamples ? 1 : 2);
  }
  die('commands: draft, approve, gen, prove, hash, outcome (see the header of audit/spec/cli.js)');
}

main().catch((e) => die(e.stack ?? String(e)));
