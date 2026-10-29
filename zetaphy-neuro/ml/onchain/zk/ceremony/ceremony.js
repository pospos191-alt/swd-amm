#!/usr/bin/env node
// Multi-party phase-2 (Groth16, circuit-specific) trusted-setup ceremony for Neuro's zkML circuit.
// docs/future/onchain-ml.md, "zkML ceremony", has the procedure for the owner and for contributors.
//
//   cd zetaphy-neuro/ml/onchain/zk && npm ci            (snarkjs pinned in package.json + lock)
//   node ceremony/ceremony.js status
//   node ceremony/ceremony.js init                      owner, once: initial zkey + transcript (deterministic)
//   node ceremony/ceremony.js contribute --name "Ada" --github ada [--in prev.zkey] [--url <release asset url>]
//   node ceremony/ceremony.js declare-beacon --chain ethereum --block N [--iterations 10]   owner, in advance
//   node ceremony/ceremony.js finalize [--hash <block hash>]   applies the named block's hash as the random beacon
//   node ceremony/ceremony.js verify [--download]       the whole chain: transcript links + snarkjs zkey verify
//   node ceremony/ceremony.js check-pr --base old.json --head new.json --author login --owner login [--repo-dir .]
//   node ceremony/ceremony.js export [--check] [--install]   NeuroScoreVerifier.sol from the FINAL zkey
//   node ceremony/ceremony.js rehearse [--contributors 2]    the whole flow on one machine (tests / CI only)
//
// Only ONE honest contributor is needed: as long as one participant's random value was destroyed, nobody, not even
// all the other participants together, can make a false proof verify. Everyone else may be dishonest.
//
// Files: the transcript is committed (ceremony/transcript.json); zkeys are NOT (11 MB each). Each contributor
// publishes theirs as a GitHub release asset (their fork's release is fine) and its URL goes in the transcript;
// the neuro-zk-ceremony workflow downloads it, checks the sha256 and runs the full verification before a PR can merge.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, rmSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { dirname, relative, resolve } from 'node:path';
import * as snarkjs from 'snarkjs';
import {
  FORMAT, tip, checkChain, nextEntry, beaconEntry, initLink, checkAppend, checkDeclare, mixEntropy, parseVerifyLog,
  parseCircuitHash, matchZkey, validName, GITHUB_LOGIN, ZKEY_URL,
} from '../../../../../zetaphy-hub/ceremony-core.js';
import { OUT, CEREMONY, p, fileHash, getPtau, buildCircuit, phase1, model, solidityVerifier, PINNED_SNARKJS, SNARKJS_VERSION } from '../lib.js';

export const TRANSCRIPT = p(new URL('transcript.json', CEREMONY));
export const ZKEYS = p(new URL('ceremony', OUT));
export const R1CS = p(new URL('neuro_score.r1cs', OUT));
export const zkeyName = (i) => `neuro_score_${String(i).padStart(4, '0')}.zkey`;
const DEFAULT_RPC = { ethereum: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'], zetaphy: ['https://rpc.sawasdeecoin.com'] };
const MAX_ZKEY = 64 * 1024 * 1024;

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f, t) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(t, null, 1) + '\n'); };
const hexOf = (b) => Buffer.from(b).toString('hex');

/** A snarkjs logger that keeps every message (verify's contribution list is only logged). */
function capture(echo = false) {
  const lines = [];
  const f = (lvl) => (m) => { lines.push(String(m)); if (echo || lvl === 'error') console.log(m); };
  return { lines, logger: { debug: () => {}, info: f('info'), warn: f('warn'), error: f('error') } };
}

function check() {
  if (SNARKJS_VERSION !== PINNED_SNARKJS) throw new Error(`snarkjs ${SNARKJS_VERSION} installed, the ceremony is pinned to ${PINNED_SNARKJS}: run npm ci`);
}

/** The initial zkey (groth16 setup: deterministic from r1cs + phase 1) and a new transcript. */
export async function init({ transcript = TRANSCRIPT, dir = ZKEYS, r1cs = R1CS, ptau, ph = phase1(), modelHash = model().hash, minContributions = 3, rehearsal = false, beaconRpc = DEFAULT_RPC, force = false } = {}) {
  check();
  if (existsSync(transcript) && !force) throw new Error(`${transcript} exists (the ceremony is already initialised)`);
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${zkeyName(0)}`;
  const { lines, logger } = capture();
  await snarkjs.zKey.newZKey(r1cs, ptau, out, logger);
  const csHash = parseCircuitHash(lines);
  const zkeySha256 = await fileHash(out);
  const t = {
    format: FORMAT,
    ...(rehearsal ? { rehearsal: 'REHEARSAL on one machine: every contribution was made by the same party. Testnet only, never a production setup.' } : {}),
    circuit: { name: 'neuro_score', modelHash, csHash, r1csSha256: await fileHash(r1cs) },
    phase1: { name: ph.name, file: ph.file, url: ph.url, sha256: ph.sha256, blake2b: ph.blake2b, power: ph.power },
    snarkjs: PINNED_SNARKJS,
    minContributions,
    beaconRpc,
    init: { zkeySha256, zkeyBytes: statSync(out).size, link: await initLink(csHash, ph.sha256, zkeySha256) },
    beacon: null,
    contributions: [],
  };
  write(transcript, t);
  return t;
}

/** Path of the tip zkey, checked against the transcript (sha256). */
async function tipZkey(t, dir, inPath, { r1cs = R1CS, ptau } = {}) {
  const tp = tip(t);
  const f = inPath ?? `${dir}/${zkeyName(tp.index)}`;
  // the initial zkey is deterministic: the first contributor can rebuild it instead of downloading it
  if (!existsSync(f) && tp.index === 0 && ptau) { mkdirSync(dir, { recursive: true }); await snarkjs.zKey.newZKey(r1cs, ptau, f, capture().logger); }
  if (!existsSync(f)) throw new Error(`${f} missing: download the latest zkey (${t.contributions.at(-1)?.url ?? 'run init'}) and pass --in`);
  const sha = await fileHash(f);
  if (sha !== tp.zkeySha256) throw new Error(`${f} is not the latest zkey of the transcript (sha256 ${sha}, want ${tp.zkeySha256})`);
  return f;
}

/** One contribution: fresh randomness (CSPRNG + optional typed text), never written anywhere, then the new zkey. */
export async function contribute({ transcript = TRANSCRIPT, dir = ZKEYS, name, github, url, inPath, typed = '', r1cs = R1CS, ptau } = {}) {
  check();
  const t = read(transcript);
  if (tip(t).final) throw new Error('the ceremony is final');
  if (t.beacon) throw new Error('the beacon is named: contributions are closed');
  if (!validName(name)) throw new Error('--name: 1-64 printable characters (public)');
  if (!GITHUB_LOGIN.test(github ?? '')) throw new Error('--github: your GitHub login (the PR must come from it)');
  const index = tip(t).index + 1;
  url ??= `https://github.com/${github}/swd-amm/releases/download/zk-ceremony-${index}/${zkeyName(index)}`;
  if (!ZKEY_URL.test(url)) throw new Error('--url: a GitHub release asset URL ending in .zkey');
  const from = await tipZkey(t, dir, inPath, { r1cs, ptau });
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${zkeyName(index)}`;
  const entropy = await mixEntropy(new Uint8Array(randomBytes(64)), typed, String(process.hrtime.bigint()));
  const t0 = performance.now();
  const hash = await snarkjs.zKey.contribute(from, out, name, entropy, capture().logger);
  const ms = performance.now() - t0;
  const entry = await nextEntry(t, { name, github, contributionHash: hexOf(hash), zkeySha256: await fileHash(out), zkeyBytes: statSync(out).size, url });
  t.contributions.push(entry);
  write(transcript, t);
  return { entry, out, ms };
}

/** The owner names the beacon block before it exists. */
export async function declareBeacon({ transcript = TRANSCRIPT, chain, block, iterationsExp = 10, now } = {}) {
  const base = read(transcript);
  const head = { ...base, beacon: { chain, block, iterationsExp } };
  const problems = checkDeclare(base, head, base.rehearsal ? ['rehearsal'] : ['ethereum', 'zetaphy']);
  if (!base.rehearsal) {
    const latest = now ?? (await latestBlock(base, chain)).number;
    const ahead = base.minBlocksAhead?.[chain] ?? (chain === 'ethereum' ? 300 : 1800);
    if (block < latest + ahead) problems.push(`block ${block} is not far enough ahead: latest is ${latest}, name one >= ${latest + ahead}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  write(transcript, head);
  return head;
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  if (j.error || !j.result) throw new Error(`${url} ${method}: ${JSON.stringify(j.error ?? 'no result')}`);
  return j.result;
}

/** Asks every configured RPC; all that answer must agree; at least one must answer. */
async function agreed(t, chain, method, params, pick) {
  const urls = t.beaconRpc?.[chain] ?? DEFAULT_RPC[chain] ?? [];
  const got = [];
  for (const u of urls) { try { got.push(pick(await rpc(u, method, params))); } catch (e) { console.error(`  ${u}: ${e.message}`); } }
  if (!got.length) throw new Error(`no ${chain} RPC answered (${urls.join(', ')})`);
  if (got.some((g) => JSON.stringify(g) !== JSON.stringify(got[0]))) throw new Error(`${chain} RPCs disagree: ${JSON.stringify(got)}`);
  return got[0];
}
export const latestBlock = (t, chain) => agreed(t, chain, 'eth_blockNumber', [], (n) => ({ number: Number(BigInt(n)) }));
/** { hash (64 hex, no 0x), timestamp } of a block. */
export const blockOf = (t, chain, n) => agreed(t, chain, 'eth_getBlockByNumber', ['0x' + n.toString(16), false], (b) => ({ hash: b.hash.slice(2).toLowerCase(), timestamp: Number(BigInt(b.timestamp)) }));

/** The final step: the named block's hash, iterated 2^iterationsExp times (snarkjs zkey beacon). */
export async function finalize({ transcript = TRANSCRIPT, dir = ZKEYS, inPath, blockHash, url } = {}) {
  check();
  const t = read(transcript);
  if (!t.beacon) throw new Error('no beacon named: run declare-beacon first (before the block exists)');
  if (tip(t).final) throw new Error('already final');
  if (!blockHash) blockHash = (await blockOf(t, t.beacon.chain, t.beacon.block)).hash;
  blockHash = blockHash.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(blockHash)) throw new Error('block hash: 64 hex');
  const index = tip(t).index + 1;
  url ??= `https://github.com/pospos191-alt/swd-amm/releases/download/zk-ceremony-final/${zkeyName(index)}`;
  const from = await tipZkey(t, dir, inPath);
  const out = `${dir}/${zkeyName(index)}`;
  const t0 = performance.now();
  const hash = await snarkjs.zKey.beacon(from, out, 'Final beacon', blockHash, t.beacon.iterationsExp, capture().logger);
  if (!hash) throw new Error('snarkjs zkey beacon failed');
  const entry = await beaconEntry(t, { blockHash, contributionHash: hexOf(hash), zkeySha256: await fileHash(out), zkeyBytes: statSync(out).size, url });
  t.contributions.push(entry);
  write(transcript, t);
  return { entry, out, ms: performance.now() - t0 };
}

/** Downloads a release asset with curl (size-capped), returns the path. */
function download(url, dest, maxBytes = MAX_ZKEY) {
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync('curl', ['-fsSL', '--retry', '3', '--max-filesize', String(maxBytes), '-o', dest, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not download ${url}`);
  return dest;
}

/**
 * Verifies the ceremony up to entry `upTo` (default: the tip): the transcript's hash chain, the zkey's sha256, then
 * snarkjs' full zkey verification against the circuit and the pinned phase-1 file (every contribution's proof of
 * knowledge, the beacon recomputed, the key sections consistent), the zkey's own contribution list = the transcript's,
 * the circuit = the committed model, and the initial zkey rebuilt bit for bit. Returns { ok, problems, seconds }.
 */
export async function verify({ transcript = TRANSCRIPT, t = read(transcript), dir = ZKEYS, r1cs = R1CS, ptau, downloadMissing = false, upTo, modelHash, rebuildInit = true, keepInit = true } = {}) {
  check();
  const t0 = performance.now();
  const problems = [...(await checkChain(t))];
  if (problems.length) return { ok: false, problems };
  if (t.snarkjs !== PINNED_SNARKJS) problems.push(`transcript is for snarkjs ${t.snarkjs}, this tool pins ${PINNED_SNARKJS}`);
  if (modelHash && t.circuit.modelHash !== modelHash) problems.push(`transcript is for model ${t.circuit.modelHash}, the committed model is ${modelHash}: a new model needs a new ceremony`);
  if (await fileHash(r1cs) !== t.circuit.r1csSha256) problems.push('the circuit built here is not the transcript\'s (r1cs sha256 differs)');
  if (await fileHash(ptau) !== t.phase1.sha256) problems.push('phase-1 file is not the pinned one');
  const n = upTo ?? t.contributions.length;
  const sub = { ...t, contributions: t.contributions.slice(0, n) };
  const tp = tip(sub);
  if (problems.length) return { ok: false, problems };
  mkdirSync(dir, { recursive: true });
  if (rebuildInit) {
    // the initial zkey is deterministic: rebuild it and compare (kept as neuro_score_0000.zkey when absent)
    const again = `${dir}/rebuilt_init.zkey`;
    await snarkjs.zKey.newZKey(r1cs, ptau, again, capture().logger);
    if (await fileHash(again) !== t.init.zkeySha256) problems.push('the initial zkey rebuilt from the circuit and phase 1 is not the transcript\'s init');
    else if (keepInit && !existsSync(`${dir}/${zkeyName(0)}`)) renameSync(again, `${dir}/${zkeyName(0)}`);
    rmSync(again, { force: true });
  }
  const f = `${dir}/${zkeyName(tp.index)}`;
  if ((!existsSync(f) || await fileHash(f) !== tp.zkeySha256) && downloadMissing && tp.index > 0) download(sub.contributions.at(-1).url, f);
  if (!existsSync(f)) problems.push(`${f} missing (use --download)`);
  else if (await fileHash(f) !== tp.zkeySha256) problems.push(`${f}: sha256 is not the transcript's ${tp.zkeySha256}`);
  if (problems.length) return { ok: false, problems };
  const { lines, logger } = capture();
  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, f, logger);
  if (!ok) problems.push(`snarkjs zkey verify refused ${f}: ${lines.filter((l) => /invalid|not|does/i.test(l)).join(' | ') || 'see output'}`);
  else {
    if (parseCircuitHash(lines) !== t.circuit.csHash) problems.push('circuit hash in the zkey is not the transcript\'s');
    problems.push(...matchZkey(sub, parseVerifyLog(lines)));
  }
  return { ok: problems.length === 0, problems, seconds: Math.round(performance.now() - t0) / 1000, final: tp.final, zkey: f };
}

/** Committer time (unix s) of the first commit on this branch whose transcript names the beacon. */
export function declaredAt(repoDir, file) {
  const rel = relative(repoDir, resolve(file));
  const log = spawnSync('git', ['-C', repoDir, 'log', '--first-parent', '--reverse', '--format=%H %ct', '--', rel], { encoding: 'utf8' });
  if (log.status !== 0) throw new Error(log.stderr);
  for (const line of log.stdout.trim().split('\n').filter(Boolean)) {
    const [sha, ct] = line.split(' ');
    const show = spawnSync('git', ['-C', repoDir, 'show', `${sha}:${rel}`], { encoding: 'utf8' });
    try { if (show.status === 0 && JSON.parse(show.stdout).beacon) return Number(ct); } catch { /* not JSON at that commit */ }
  }
  return null;
}

/**
 * What the PR workflow runs: `base` = transcript on the target branch, `head` = the PR's. Accepts exactly one of
 *  - a contribution by the PR author (their GitHub login in the entry), zkey downloaded from its URL and fully verified;
 *  - the owner naming the beacon block (still far enough in the future);
 *  - the beacon step, whose hash is the named block's (asked of the chain), the block mined after the declaration was
 *    merged, the zkey fully verified.
 */
export async function checkPr({ base, head, author, owner, dir = ZKEYS, r1cs = R1CS, ptau, repoDir, basePath, chainNow, blockInfo, modelHash = model().hash, fetchZkey = download } = {}) {
  const problems = [];
  const declaring = !base.beacon && head.beacon && head.contributions.length === base.contributions.length;
  if (declaring) {
    problems.push(...checkDeclare(base, head));
    if (author !== owner) problems.push(`only the owner (${owner}) names the beacon`);
    if (!problems.length) {
      const latest = chainNow ?? (await latestBlock(head, head.beacon.chain)).number;
      const ahead = head.minBlocksAhead?.[head.beacon.chain] ?? (head.beacon.chain === 'ethereum' ? 300 : 1800);
      if (head.beacon.block < latest + ahead) problems.push(`beacon block ${head.beacon.block} is not far enough ahead (latest ${latest}, need >= ${latest + ahead})`);
    }
    return { kind: 'declare', problems };
  }
  const { added, problems: ap } = await checkAppend(base, head);
  problems.push(...ap);
  if (problems.length) return { kind: added?.type ?? 'invalid', problems };
  if (added.type === 'contribution' && added.github !== author) problems.push(`the entry's github "${added.github}" is not the PR author "${author}"`);
  if (added.type === 'beacon') {
    const b = blockInfo ?? await blockOf(head, head.beacon.chain, head.beacon.block);
    if (b.hash !== added.beacon.blockHash) problems.push(`block ${head.beacon.block}'s hash is ${b.hash}, not the entry's ${added.beacon.blockHash}`);
    const at = repoDir ? declaredAt(repoDir, basePath) : null;
    if (at == null) problems.push('cannot find when the beacon was declared (git history of the transcript)');
    else if (b.timestamp <= at) problems.push(`block ${head.beacon.block} (time ${b.timestamp}) is not after the declaration was merged (${at})`);
  }
  if (problems.length) return { kind: added.type, problems };
  const f = `${dir}/${zkeyName(added.index)}`;
  rmSync(f, { force: true });
  if (!Number.isSafeInteger(added.zkeyBytes) || added.zkeyBytes <= 0 || added.zkeyBytes > MAX_ZKEY) return { kind: added.type, problems: ['zkeyBytes: the zkey size in bytes (at most 64 MiB)'] };
  fetchZkey(added.url, f, added.zkeyBytes);
  if (statSync(f).size !== added.zkeyBytes) problems.push(`downloaded ${statSync(f).size} bytes, the entry says ${added.zkeyBytes}`);
  const v = await verify({ t: head, dir, r1cs, ptau, modelHash });
  problems.push(...v.problems);
  return { kind: added.type, problems, seconds: v.seconds };
}

/** NeuroScoreVerifier.sol + verification_key.json from the FINAL zkey (or a rehearsal's, labelled as such). */
export async function exportVerifier({ t, zkey, outDir = p(OUT) }) {
  const tp = tip(t);
  if (!tp.final) throw new Error('the ceremony is not final: no verifier from a non-final zkey');
  if (await fileHash(zkey) !== tp.zkeySha256) throw new Error(`${zkey} is not the final zkey`);
  const label = t.rehearsal
    ? `REHEARSAL setup: phase 1 = ${t.phase1.name}; phase 2 = ${t.contributions.length - 1} contributions made by ONE machine + a beacon.\n// Testnet only: whoever ran it could forge proofs. Production = the public ceremony in zk/ceremony/transcript.json (docs/future/onchain-ml.md).`
    : `Phase 1 = ${t.phase1.name}; phase 2 = the public ceremony in zk/ceremony/transcript.json\n// (${t.contributions.length - 1} contributions + beacon ${t.beacon.chain} block ${t.beacon.block}). Sound if at least one contributor was honest.`;
  const sol = await solidityVerifier(zkey, { zkeySha256: tp.zkeySha256, link: tp.link, label });
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/NeuroScoreVerifier.sol`, sol);
  writeFileSync(`${outDir}/verification_key.json`, JSON.stringify(vkey, null, 1));
  return { sol, vkey };
}

/** The whole flow on one machine: init, N contributions, a beacon. For tests and CI; labelled REHEARSAL. */
export async function rehearse({ dir = p(new URL('rehearsal', OUT)), contributors = 2, r1cs = R1CS, ptau, log = () => {}, prune = false } = {}) {
  rmSync(dir, { recursive: true, force: true });
  const transcript = `${dir}/transcript.json`;
  const timing = {};
  let t0 = performance.now();
  await init({ transcript, dir, r1cs, ptau, rehearsal: true, minContributions: contributors, force: true });
  timing.initSeconds = Math.round(performance.now() - t0) / 1000;
  timing.contributeSeconds = [];
  for (let i = 1; i <= contributors; i++) {
    const { ms } = await contribute({ transcript, dir, name: `rehearsal ${i}`, github: `rehearsal-${i}`, url: `https://github.com/rehearsal-${i}/swd-amm/releases/download/zk-ceremony-${i}/${zkeyName(i)}` });
    timing.contributeSeconds.push(Math.round(ms) / 1000);
    if (prune) rmSync(`${dir}/${zkeyName(i - 1)}`, { force: true }); // 11 MB each: keep only what the next step needs
    log(`rehearsal contribution ${i}: ${Math.round(ms) / 1000} s`);
  }
  await declareBeacon({ transcript, chain: 'rehearsal', block: 1, iterationsExp: 10 });
  // a rehearsal has no real chain: its "block hash" is derived from the transcript, clearly not a beacon
  const fake = (await fileHash(transcript)).slice(0, 64);
  t0 = performance.now();
  const { out } = await finalize({ transcript, dir, blockHash: fake, url: `https://github.com/rehearsal/swd-amm/releases/download/zk-ceremony-final/${zkeyName(contributors + 1)}` });
  timing.beaconSeconds = Math.round(performance.now() - t0) / 1000;
  log(`rehearsal beacon: ${timing.beaconSeconds} s`);
  return { transcript, dir, final: out, timing };
}

// ---------------------------------------------------------------- CLI
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const has = (name) => process.argv.includes(`--${name}`);

async function ask(q) {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
}

async function main() {
  const cmd = process.argv[2];
  const transcript = arg('transcript', TRANSCRIPT);
  const dir = arg('dir', ZKEYS);
  const needCircuit = ['init', 'verify', 'check-pr', 'rehearse', 'export'].includes(cmd)
    || (cmd === 'contribute' && !has('in') && existsSync(transcript) && tip(read(transcript)).index === 0 && !existsSync(`${dir}/${zkeyName(0)}`));
  let ptau;
  if (needCircuit) {
    if (!existsSync(R1CS) || has('rebuild')) { console.log('building the circuit…'); await buildCircuit(); }
    ptau = await getPtau();
  }
  switch (cmd) {
    case 'status': {
      const t = read(transcript);
      const problems = await checkChain(t);
      console.log(`${t.rehearsal ? 'REHEARSAL ' : ''}ceremony for model ${t.circuit.modelHash}`);
      console.log(`phase 1: ${t.phase1.name} (sha256 ${t.phase1.sha256.slice(0, 16)}…)`);
      for (const e of t.contributions) console.log(`  #${e.index} ${e.type} "${e.name}"${e.github ? ` @${e.github}` : ''} ${e.contributionHash.slice(0, 16)}… ${e.url}`);
      console.log(`beacon: ${t.beacon ? `${t.beacon.chain} block ${t.beacon.block}, 2^${t.beacon.iterationsExp} iterations` : 'not named yet'}`);
      console.log(tip(t).final ? 'FINAL' : `open: next contribution is #${tip(t).index + 1}`);
      console.log(problems.length ? `transcript problems:\n  ${problems.join('\n  ')}` : 'transcript chain: ok');
      process.exit(problems.length ? 1 : 0);
    }
    case 'init': {
      const t = await init({ transcript, dir, ptau, minContributions: Number(arg('min', 3)) });
      console.log(`initialised: ${dir}/${zkeyName(0)} sha256 ${t.init.zkeySha256}\nPublish it as a release asset; commit ${transcript}.`);
      break;
    }
    case 'contribute': {
      const name = arg('name');
      const github = arg('github');
      console.log('Your contribution adds a secret random value and then forgets it. Only one honest contributor is needed for the setup to be safe.');
      const typed = arg('entropy') ?? await ask('Type some random text (mixed with 64 bytes from the OS CSPRNG; it is never saved): ');
      const { entry, out, ms } = await contribute({ transcript, dir, name, github, url: arg('url'), inPath: arg('in'), typed, ptau });
      console.log(`\ncontribution #${entry.index} done in ${Math.round(ms) / 1000} s\n  zkey: ${out}\n  sha256: ${entry.zkeySha256}\n  contribution hash: ${entry.contributionHash}\n`);
      console.log(`Next:\n 1. create a release in your fork (tag zk-ceremony-${entry.index}) and upload ${out} as an asset, so it is at\n    ${entry.url}\n 2. open a PR that changes only zetaphy-neuro/ml/onchain/zk/ceremony/transcript.json (now updated here).\n    The "Neuro zkML ceremony" workflow downloads your zkey and verifies the whole chain.\n 3. Delete nothing important: your random value was only in memory and is gone when this process exits.`);
      break;
    }
    case 'declare-beacon': {
      const h = await declareBeacon({ transcript, chain: arg('chain', 'ethereum'), block: Number(arg('block')), iterationsExp: Number(arg('iterations', 10)) });
      console.log(`beacon named: ${h.beacon.chain} block ${h.beacon.block}. Merge this before that block exists.`);
      break;
    }
    case 'finalize': {
      const { entry, out, ms } = await finalize({ transcript, dir, inPath: arg('in'), blockHash: arg('hash'), url: arg('url') });
      console.log(`final zkey ${out} (${Math.round(ms) / 1000} s), sha256 ${entry.zkeySha256}; beacon ${entry.beacon.blockHash}. Upload it to ${entry.url}.`);
      break;
    }
    case 'verify': {
      const t = read(transcript);
      const v = await verify({ t, dir, ptau, downloadMissing: has('download'), modelHash: model().hash });
      console.log(v.ok ? `ceremony verified (${t.contributions.length} steps${v.final ? ', final' : ', not final yet'}) in ${v.seconds} s` : `REFUSED:\n  ${v.problems.join('\n  ')}`);
      process.exit(v.ok ? 0 : 1);
    }
    case 'check-pr': {
      const base = read(arg('base'));
      const head = read(arg('head'));
      // --base is the transcript file inside the target-branch checkout (--repo-dir): its git history dates the beacon
      const r = await checkPr({ base, head, author: arg('author'), owner: arg('owner'), dir, ptau, repoDir: arg('repo-dir'), basePath: arg('base') });
      console.log(r.problems.length ? `REFUSED (${r.kind}):\n  ${r.problems.join('\n  ')}` : `accepted: ${r.kind}${r.seconds ? ` (verified in ${r.seconds} s)` : ''}`);
      process.exit(r.problems.length ? 1 : 0);
    }
    case 'export': {
      const t = read(transcript);
      const v = await verify({ t, dir, ptau, downloadMissing: has('download'), modelHash: model().hash });
      if (!v.ok) { console.log(`REFUSED:\n  ${v.problems.join('\n  ')}`); process.exit(1); }
      const { sol } = await exportVerifier({ t, zkey: v.zkey });
      const committed = new URL('../../../../../zetaphy-network/contracts/NeuroScoreVerifier.sol', import.meta.url);
      if (has('check')) {
        const same = readFileSync(committed, 'utf8') === sol;
        console.log(same ? 'the committed NeuroScoreVerifier.sol is exactly the one from the final zkey' : 'the committed NeuroScoreVerifier.sol is NOT the one from the final zkey');
        process.exit(same ? 0 : 1);
      }
      if (has('install')) { copyFileSync(new URL('NeuroScoreVerifier.sol', OUT), committed); console.log('installed zetaphy-network/contracts/NeuroScoreVerifier.sol (run npm run build there)'); }
      else console.log(`written ${p(OUT)}NeuroScoreVerifier.sol`);
      break;
    }
    case 'rehearse': {
      const r = await rehearse({ contributors: Number(arg('contributors', 2)), ptau, log: console.log });
      const v = await verify({ transcript: r.transcript, dir: r.dir, ptau });
      console.log(v.ok ? `rehearsal verified in ${v.seconds} s: ${r.transcript}` : `rehearsal REFUSED: ${v.problems.join('; ')}`);
      process.exit(v.ok ? 0 : 1);
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
  process.exit(0); // snarkjs keeps worker threads alive
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
