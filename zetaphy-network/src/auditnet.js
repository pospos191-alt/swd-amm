// The open audit network (docs/future/audit-network.md), off-chain side: what a runner does for a request's
// automated tier, and the helpers auditors and judges use. The shared logic (tuples, commitments, the
// pipeline adapter, the canonical result) is zetaphy-hub/audit-core.js, the same file the hub's Audit tab runs.
//
// A runner's job (`zetaphy audit run <id>`):
//   1. fetch the target's runtime code and check keccak256(code) is the request's codeHash (on ZETAPHY:
//      EXTCODEHASH); for EVM chains, the verified source from Sourcify when it has it, else the repo commit;
//   2. run the pipeline through its adapter: `node audit/report.js --json <outdir>` (Slither, Aderyn, Semgrep,
//      SMTChecker, Echidna/Medusa, Halmos, mutation testing, triage.yml), checked strictly (audit-core.js);
//   3. run Neuro's rules on the exact code (free; the same code-only scan as a useful-work job);
//   4. hash the CANONICAL result and commit (resultHash, critical+high, invariants failed / not run, mutation)
//      to AuditRunners; reveal after the contest. 2 of 3 runners must agree.
//   5. optionally (only when the runner's owner configured a model), an LLM review: advisory "AI findings"
//      saved next to the result, NEVER part of the hash. An auditor may submit them as ordinary findings,
//      which the judges then decide like any other: AI alone never certifies or fails a contract.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import * as core from '../../zetaphy-hub/audit-core.js';
import { randomSalt } from '../../zetaphy-hub/work-core.js';

export const k = neuroKeccak;
export { core, randomSalt };

/** keccak256 of runtime code as 0x hex (EXTCODEHASH of a contract with that code). */
export const codeHashOf = (code) => core.keccakHex(k, code);

/** The Neuro chain key of an EVM chain id (eth, bsc, base, arbitrum, zetaphy), or null. */
export function chainKeyOf(chainId) {
  for (const [key, c] of Object.entries(CHAINS)) if (c.kind === 'evm' && Number(c.id) === Number(chainId)) return key;
  return null;
}

// ------------------------------------------------------------------ the pipeline adapter

/**
 * Runs `node audit/report.js --json <outDir>` in `repoDir` and returns the checked pipeline JSON.
 * `run` (tests) replaces the process: (cmd, args, {cwd}) => Promise<stdout string>.
 */
export async function runPipeline({ repoDir, outDir, run = runProcess, timeoutMs = 6 * 3600_000 }) {
  const script = join(repoDir, 'audit', 'report.js');
  if (run === runProcess && !existsSync(script)) throw new Error(`no audit pipeline at ${script} (audit/report.js): the automated tier needs it`);
  mkdirSync(outDir, { recursive: true });
  const stdout = await run(process.execPath, [script, '--json', outDir], { cwd: repoDir, timeoutMs });
  let j;
  try { j = JSON.parse(stdout); } catch { throw new Error('audit/report.js --json did not print JSON'); }
  return core.validatePipeline(j);
}

function runProcess(cmd, args, { cwd, timeoutMs }) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); fail(new Error('the pipeline timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) p.kill('SIGKILL'); });
    p.on('error', (e) => { clearTimeout(t); fail(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? ok(out) : fail(new Error(`audit/report.js exited ${code}`)); });
  });
}

// ------------------------------------------------------------------ source and code

/** Verified source from Sourcify (free, no key) as { files: {path: content}, sourceHash } or null. */
export async function fetchSourcify({ chainId, address, fetchImpl = globalThis.fetch, base = 'https://sourcify.dev/server' }) {
  try {
    const r = await fetchImpl(`${base}/files/any/${Number(chainId)}/${String(address).toLowerCase()}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const list = Array.isArray(j?.files) ? j.files : [];
    if (!list.length) return null;
    const files = Object.fromEntries(list.filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string').map((f) => [f.path.replace(/^.*?\/sources\//, 'sources/'), f.content]));
    return { files, status: j.status ?? null, sourceHash: sourceHashOf(files) };
  } catch {
    return null;
  }
}

/** keccak256 of the canonical JSON of {path: content}: a source hash that does not depend on file order. */
export const sourceHashOf = (files) => core.keccakHex(k, new TextEncoder().encode(core.canonical(files)));

/** Runtime code of `target` on `chainId` through `getCode(chainKey, address)`; checks the request's codeHash. */
export async function codeFor(req, getCode) {
  const key = chainKeyOf(req.chainId);
  if (!key) throw new Error(`chain ${req.chainId}: not an EVM chain Neuro reads (give the runtime bytecode with --code)`);
  const code = await getCode(key, req.target);
  if (!code || code === '0x') throw new Error(`no code at ${req.target} on ${key}`);
  if (codeHashOf(code).toLowerCase() !== String(req.codeHash).toLowerCase()) throw new Error(`the code at ${req.target} is not the requested codeHash (upgraded or redeployed): nothing to audit`);
  return { key, code };
}

// ------------------------------------------------------------------ the runner job

/**
 * One automated-tier run for request `req` ({chainId, target, codeHash, sourceHash}):
 *   pipeline: the adapter's checked JSON; neuro: { verdict, report } of the code-only scan, or null.
 * Returns { body, tuple } (tuple = what AuditRunners.commit/reveal take).
 */
export function automatedResult(req, { pipeline, neuro = null }) {
  const nf = neuro ? { verdict: neuro.verdict, findings: core.neuroFindings(neuro.report) } : null;
  const body = core.canonicalResult({ chainId: req.chainId, target: req.target, codeHash: req.codeHash, sourceHash: req.sourceHash, pipeline, neuro: nf });
  return { body, tuple: core.resultTuple(k, body) };
}

/** Neuro's code-only scan of `code` (the same as a useful-work scan job): { verdict, report }. */
export async function neuroScan(chainKey, target, code) {
  const { scanVerdict } = await import('./usefulwork.js');
  return scanVerdict({ chain: chainKey, target, code, codeHash: codeHashOf(code) });
}

/**
 * The optional AI review (advisory, never hashed): only with a model the owner configured.
 * llm = { provider: 'ollama', model, baseUrl } (local Ollama by default; free). Returns AI findings in the
 * pipeline's schema, tool "llm", status "open" — to be submitted and judged as ordinary findings.
 */
export async function aiFindings(report, llm, { fetchImpl, lang = 'en', timeoutMs = 600_000 } = {}) {
  if (!llm?.model) return [];
  const { runAnalyst } = await import('../../zetaphy-neuro/ai/analyst.js');
  const out = await runAnalyst(report, { provider: llm.provider ?? 'ollama', model: llm.model, baseUrl: llm.baseUrl }, { lang, fetchImpl, timeoutMs });
  // the analyst's risks and "second look" items (each cites evidence from the report; ai/schema.js)
  const items = [...(out?.result?.risks ?? []), ...(out?.result?.secondLook ?? [])];
  return items.slice(0, 50).map((f, i) => ({
    id: `llm:${i}`, tool: 'llm', rule: (f.evidence ?? []).join(',').slice(0, 80) || 'ai', severity: 'info',
    file: '', line: 0, title: `${String(f.title ?? '').slice(0, 120)}: ${String(f.detail ?? '').slice(0, 600)}`, status: 'open',
    model: out.model, advisory: 'AI opinion: submit it as a finding for the judges; it does not count by itself',
  }));
}

// ------------------------------------------------------------------ local secrets (salts) for commit-reveal

/** Salts stay on this machine (~/.zetaphy/audit/salts.json, 0600) until the reveal. */
export function saltStore(dir) {
  const file = join(dir, 'salts.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    file,
    get: (key) => load()[key] ?? null,
    put(key, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const all = load();
      all[key] = value;
      writeFileSync(file + '.tmp', JSON.stringify(all, null, 1), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    },
  };
}

/** Writes the run's canonical result and AI findings (if any) for publication (IPFS / the repo). */
export function saveRun(dir, id, { body, tuple, ai = [] }) {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `audit-${id}.json`);
  writeFileSync(file, JSON.stringify({ result: body, tuple, aiFindings: ai }, null, 1) + '\n');
  return file;
}

/** The pipeline's sample output (test/fixtures/audit-report.json): the adapter's contract with audit/report.js. */
export const FIXTURE = new URL('../test/fixtures/audit-report.json', import.meta.url);
