// Audit-as-a-Service intake for code that is NOT verified on an explorer: a public GitHub repo at a full commit.
// The pipeline compiles it (audit/run.sh --target <dir>: audit/tools/compile.js writes each contract's runtime
// bytecode), and the intake binds the source to the deployed code by comparing that bytecode with what the chain
// runs. No match, no certificate: auditors would review source that is not the deployed code.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo", "github.com/owner/repo" or "https://github.com/owner/repo(.git)" -> { owner, repo, url }. */
export function parseRepo(s) {
  const m = /^(?:https:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(s ?? '').trim());
  if (!m || !OWNER.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') throw new Error('repo: owner/name on GitHub (e.g. acme/vault)');
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

/** A full 40-hex commit (a branch or tag can move after the audit; a commit cannot). */
export function parseCommit(s) {
  const c = String(s ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(c)) throw new Error('commit: the full 40-character git commit hash (branches and tags move)');
  return c;
}

/** The source reference AaaS hashes into Target.sourceHash: github.com/<owner>/<repo>@<commit>. */
export const repoRef = (r, commit) => `github.com/${r.owner}/${r.repo}@${commit}`;

/**
 * Fetches exactly that commit into `dir` (git, shallow, no credentials: public repos only).
 * `run(cmd, args, {cwd})` replaces the process in tests.
 */
export async function checkoutRepo({ repo, commit, dir, run = runGit }) {
  const r = typeof repo === 'string' ? parseRepo(repo) : repo;
  const c = parseCommit(commit);
  mkdirSync(dir, { recursive: true });
  const steps = [['init', '-q'], ['remote', 'add', 'origin', `${r.url}.git`], ['fetch', '-q', '--depth', '1', 'origin', c], ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']];
  for (const a of steps) await run('git', a, { cwd: dir });
  const head = String(await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();
  if (head !== c) throw new Error(`checked out ${head}, not ${c}`);
  return { dir, ref: repoRef(r, c) };
}

function runGit(cmd, args, { cwd }) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`git ${args[0]}: ${err.trim().slice(0, 300)}`))));
  });
}

/** Runtime bytecode without the trailing CBOR metadata (its length is the last 2 bytes), lowercase, no 0x. */
export function stripMetadata(code) {
  const h = String(code).replace(/^0x/i, '').toLowerCase();
  if (h.length < 4) return h;
  const len = parseInt(h.slice(-4), 16);
  const cut = (len + 2) * 2;
  if (len < 1 || cut > h.length) return h;
  // the metadata map starts with 0xa1..0xa5 (a CBOR map of 1..5 entries)
  return /^a[1-5]$/.test(h.slice(h.length - cut, h.length - cut + 2)) ? h.slice(0, h.length - cut) : h;
}

/** Every compiled contract's runtime code from a pipeline output dir (<out>/raw/compile/*.runtime.json). */
export function compiledRuntimes(outDir) {
  const dir = join(outDir, 'raw', 'compile');
  const all = {};
  if (!existsSync(dir)) return all;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.runtime.json'))) Object.assign(all, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return all;
}

/**
 * Which compiled contract the on-chain code is. 'exact': same bytes (same EXTCODEHASH). 'metadata': same code,
 * only the metadata hash differs (another path or comment; the code is the same). Contracts with immutables
 * differ in their immutable slots and do not match here: verify them on Sourcify (it handles immutables) first.
 * runtimes: { "file:Name": 0x… }, onchain: 0x… runtime code. Returns { match, contract } (match: exact|metadata|none).
 */
export function matchCompiled(runtimes, onchain, codeHashOf) {
  const want = String(onchain).toLowerCase();
  const wantHash = codeHashOf(want);
  for (const [name, code] of Object.entries(runtimes)) if (codeHashOf(String(code).toLowerCase()) === wantHash) return { match: 'exact', contract: name };
  const bare = stripMetadata(want);
  for (const [name, code] of Object.entries(runtimes)) if (stripMetadata(code) === bare && bare.length) return { match: 'metadata', contract: name };
  return { match: 'none', contract: null };
}
