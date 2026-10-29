// The phase-2 ceremony tool on a tiny circuit + tiny local phase 1 (seconds, not minutes): the full flow verifies;
// every way to cheat that a contribution PR could try is refused (bad zkey, skipped step, wrong phase 1, edited
// history, someone else's entry, a beacon named late or with the wrong hash, a non-owner naming the beacon).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as snarkjs from 'snarkjs';
import { makeTiny, tinyCeremony, TINY } from './tiny.js';
import { contribute, declareBeacon, finalize, verify, checkPr, blockOf, latestBlock, zkeyName, exportVerifier } from '../ceremony/ceremony.js';
import { checkChain, checkAppend, mixEntropy, parseVerifyLog, entryLink, tip, ZKEY_URL } from '../../../../../zetaphy-hub/ceremony-core.js';
import { fileHash, phase1 } from '../lib.js';

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const url = (who, i) => `https://github.com/${who}/swd-amm/releases/download/zk-ceremony-${i}/${zkeyName(i)}`;

/** A fresh tiny ceremony with `n` contributions; returns its paths and transcript. */
async function ceremony(name, n = 2) {
  const dir = `${TINY}t-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const c = await tinyCeremony(dir);
  for (let i = 1; i <= n; i++) await contribute({ transcript: c.transcript, dir, name: `person ${i}`, github: `person${i}`, url: url(`person${i}`, i), typed: `typed ${i}` });
  return { ...c, t: read(c.transcript) };
}

/** checkPr with zkeys "downloaded" from a local folder instead of GitHub. */
const prCheck = (c, base, head, more = {}) => checkPr({
  base, head, author: more.author ?? head.contributions.at(-1)?.github, owner: 'owner', dir: `${c.dir}/pr`, r1cs: c.r1cs, ptau: c.ptau, modelHash: null,
  fetchZkey: (u, dest) => { mkdirSync(`${c.dir}/pr`, { recursive: true }); copyFileSync(more.from ?? `${c.dir}/${zkeyName(head.contributions.at(-1).index)}`, dest); },
  ...more,
});

test('the pinned phase 1 is a public prepared file of the Perpetual Powers of Tau, pinned by sha256 + blake2b', () => {
  const ph = phase1();
  assert.match(ph.url, /^https:\/\/pse-trusted-setup-ppot\.s3\.eu-central-1\.amazonaws\.com\/pot28_0080\/ppot_0080_15\.ptau$/);
  assert.match(ph.sha256, /^[0-9a-f]{64}$/);
  assert.match(ph.blake2b, /^[0-9a-f]{128}$/);
  assert.equal(ph.power, 15);
  const t = read(new URL('../ceremony/transcript.json', import.meta.url));
  assert.equal(t.phase1.sha256, ph.sha256);
  assert.equal(t.phase1.blake2b, ph.blake2b);
  assert.equal(t.circuit.modelHash, read(new URL('../../model.fixed.json', import.meta.url)).hash);
  assert.equal(t.snarkjs, read(new URL('../package.json', import.meta.url)).devDependencies.snarkjs);
  assert.match(t.snarkjs, /^\d+\.\d+\.\d+$/, 'snarkjs pinned exactly');
});

test('the committed public transcript is well formed and its chain checks', async () => {
  const t = read(new URL('../ceremony/transcript.json', import.meta.url));
  assert.deepEqual(await checkChain(t), []);
  assert.ok(t.minContributions >= 2);
  assert.equal(t.rehearsal, undefined, 'the public transcript is not a rehearsal');
});

test('full flow: init, 2 contributions, beacon; snarkjs verify + the hash chain pass; a non-final zkey cannot be exported', { timeout: 120_000 }, async () => {
  const c = await ceremony('flow', 2);
  let v = await verify({ t: c.t, dir: c.dir, r1cs: c.r1cs, ptau: c.ptau });
  assert.deepEqual(v.problems, []);
  assert.equal(v.final, false);
  await assert.rejects(exportVerifier({ t: c.t, zkey: `${c.dir}/${zkeyName(2)}`, outDir: `${c.dir}/x` }), /not final/);
  await declareBeacon({ transcript: c.transcript, chain: 'ethereum', block: 1000, iterationsExp: 10, now: 100 });
  const hash = 'ab'.repeat(32);
  await finalize({ transcript: c.transcript, dir: c.dir, blockHash: hash });
  const t = read(c.transcript);
  assert.equal(tip(t).final, true);
  v = await verify({ t, dir: c.dir, r1cs: c.r1cs, ptau: c.ptau });
  assert.deepEqual(v.problems, []);
  assert.equal(v.final, true);
  // snarkjs logs the zkey's own contributions, which match the transcript one by one
  const lines = [];
  await snarkjs.zKey.verifyFromR1cs(c.r1cs, c.ptau, `${c.dir}/${zkeyName(3)}`, { info: (m) => lines.push(m), debug() {}, warn() {}, error() {} });
  const logged = parseVerifyLog(lines);
  assert.deepEqual(logged.map((x) => x.hash), t.contributions.map((e) => e.contributionHash));
  assert.equal(logged[2].beaconHash, hash);
  assert.equal(logged[2].iterationsExp, 10);
  // contributions are closed once the beacon is named
  await assert.rejects(contribute({ transcript: c.transcript, dir: c.dir, name: 'late', github: 'late', typed: 'x' }), /final/);
});

test('the hash chain: any edit, reorder, removal or swapped zkey breaks it', async () => {
  const c = await ceremony('chain', 2);
  assert.deepEqual(await checkChain(c.t), []);
  const edits = {
    name: (t) => { t.contributions[0].name = 'someone else'; },
    github: (t) => { t.contributions[0].github = 'mallory'; },
    hash: (t) => { t.contributions[0].contributionHash = '0'.repeat(128); },
    zkey: (t) => { t.contributions[1].zkeySha256 = 'f'.repeat(64); },
    reorder: (t) => { t.contributions.reverse(); },
    drop: (t) => { t.contributions.shift(); },
    init: (t) => { t.init.zkeySha256 = 'e'.repeat(64); },
    phase1: (t) => { t.phase1.sha256 = 'd'.repeat(64); },
    url: (t) => { t.contributions[0].url = 'https://evil.example/x.zkey'; },
  };
  for (const [k, f] of Object.entries(edits)) {
    const t = clone(c.t);
    f(t);
    assert.ok((await checkChain(t)).length > 0, k);
  }
  // recomputing the links after an edit does not help: snarkjs' own record inside the zkey disagrees (next test)
  assert.equal(c.t.contributions[1].link, await entryLink(c.t.contributions[0].link, c.t.contributions[1]));
});

test('verify refuses a zkey that is not the transcript\'s, a skipped step, and a setup from another phase 1', { timeout: 120_000 }, async () => {
  const c = await ceremony('bad', 2);
  // 1. the file on disk is another zkey (contribution 1's) under contribution 2's name
  copyFileSync(`${c.dir}/${zkeyName(1)}`, `${c.dir}/${zkeyName(2)}`);
  let v = await verify({ t: c.t, dir: c.dir, r1cs: c.r1cs, ptau: c.ptau, rebuildInit: false });
  assert.match(v.problems.join(), /sha256 is not the transcript's/);
  // 2. a "contribution 2" built on the init zkey, skipping contribution 1, with a consistent-looking transcript entry
  const skip = `${c.dir}/skip.zkey`;
  const h = await snarkjs.zKey.contribute(`${c.dir}/${zkeyName(0)}`, skip, 'person 2', 'skip entropy');
  copyFileSync(skip, `${c.dir}/${zkeyName(2)}`);
  const t = clone(c.t);
  Object.assign(t.contributions[1], { contributionHash: Buffer.from(h).toString('hex'), zkeySha256: await fileHash(skip) });
  t.contributions[1].link = await entryLink(t.contributions[0].link, t.contributions[1]);
  assert.deepEqual(await checkChain(t), []);
  v = await verify({ t, dir: c.dir, r1cs: c.r1cs, ptau: c.ptau, rebuildInit: false });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /the zkey has 1 contributions, the transcript 2/);
  // 3. a zkey from another phase 1 (a forged setup the attacker knows the secrets of)
  const { otherPtau } = await makeTiny();
  await snarkjs.zKey.newZKey(c.r1cs, otherPtau, `${c.dir}/forged0.zkey`);
  await snarkjs.zKey.contribute(`${c.dir}/forged0.zkey`, `${c.dir}/forged.zkey`, 'person 1', 'forged');
  copyFileSync(`${c.dir}/forged.zkey`, `${c.dir}/${zkeyName(1)}`);
  const f = clone(c.t);
  f.contributions = f.contributions.slice(0, 1);
  f.contributions[0].zkeySha256 = await fileHash(`${c.dir}/forged.zkey`);
  f.contributions[0].link = await entryLink(f.init.link, f.contributions[0]);
  v = await verify({ t: f, dir: c.dir, r1cs: c.r1cs, ptau: c.ptau, rebuildInit: false });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /snarkjs zkey verify refused/);
});

test('check-pr: a good contribution by its author passes; someone else\'s entry, two entries, edited history, a bad zkey are refused', { timeout: 180_000 }, async () => {
  const c = await ceremony('pr', 1);
  const base = clone(c.t);
  await contribute({ transcript: c.transcript, dir: c.dir, name: 'person 2', github: 'person2', url: url('person2', 2), typed: 'x' });
  const head = read(c.transcript);
  let r = await prCheck(c, base, head);
  assert.deepEqual(r.problems, []);
  assert.equal(r.kind, 'contribution');
  r = await prCheck(c, base, head, { author: 'mallory' });
  assert.match(r.problems.join(), /not the PR author/);
  const edited = clone(head);
  edited.contributions[0].name = 'renamed';
  r = await prCheck(c, base, edited);
  assert.ok(r.problems.length);
  const settings = clone(head);
  settings.minContributions = 1;
  assert.match((await checkAppend(base, settings)).problems.join(), /only contributions may change/);
  const two = clone(head);
  two.contributions = [];
  assert.match((await checkAppend(base, two)).problems.join(), /exactly one/);
  // the uploaded file is not the one the entry names
  r = await prCheck(c, base, head, { from: `${c.dir}/${zkeyName(1)}` });
  assert.ok(r.problems.length);
  // an entry whose hashes match a zkey that is NOT built on the previous step
  const evil = `${c.dir}/evil.zkey`;
  const eh = await snarkjs.zKey.contribute(`${c.dir}/${zkeyName(0)}`, evil, 'person 2', 'evil');
  const e = clone(head);
  Object.assign(e.contributions[1], { contributionHash: Buffer.from(eh).toString('hex'), zkeySha256: await fileHash(evil), zkeyBytes: readFileSync(evil).length });
  e.contributions[1].link = await entryLink(e.contributions[0].link, e.contributions[1]);
  r = await prCheck(c, base, e, { from: evil });
  assert.match(r.problems.join(), /contributions/);
});

test('beacon: only the owner names it, far enough ahead; the final step must carry that block\'s hash and the block must come after the declaration', { timeout: 180_000 }, async () => {
  const c = await ceremony('beacon', 2);
  const base = clone(c.t);
  const head = { ...clone(base), beacon: { chain: 'ethereum', block: 5000, iterationsExp: 10 } };
  assert.deepEqual((await prCheck(c, base, head, { author: 'owner', chainNow: 4000 })).problems, []);
  assert.match((await prCheck(c, base, head, { author: 'person1', chainNow: 4000 })).problems.join(), /only the owner/);
  assert.match((await prCheck(c, base, head, { author: 'owner', chainNow: 4900 })).problems.join(), /not far enough ahead/);
  const few = { ...clone(base), contributions: base.contributions.slice(0, 1) };
  assert.match((await prCheck(c, few, { ...clone(few), beacon: head.beacon }, { author: 'owner', chainNow: 1 })).problems.join(), /fewer than minContributions/);
  // a git history: the declaration is merged at time 1000
  const repo = `${c.dir}/repo`;
  mkdirSync(repo, { recursive: true });
  const git = (args, env = {}) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']);
  writeFileSync(`${repo}/transcript.json`, JSON.stringify(base));
  git(['add', '.']); git(['commit', '-qm', 'open'], { GIT_COMMITTER_DATE: '@500 +0000', GIT_AUTHOR_DATE: '@500 +0000' });
  writeFileSync(c.transcript, JSON.stringify(head));
  writeFileSync(`${repo}/transcript.json`, JSON.stringify(head));
  git(['add', '.']); git(['commit', '-qm', 'beacon'], { GIT_COMMITTER_DATE: '@1000 +0000', GIT_AUTHOR_DATE: '@1000 +0000' });
  const blockHash = 'cd'.repeat(32);
  await finalize({ transcript: c.transcript, dir: c.dir, blockHash });
  const fin = read(c.transcript);
  const ok = await prCheck(c, head, fin, { repoDir: repo, basePath: `${repo}/transcript.json`, blockInfo: { hash: blockHash, timestamp: 2000 } });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.kind, 'beacon');
  assert.match((await prCheck(c, head, fin, { repoDir: repo, basePath: `${repo}/transcript.json`, blockInfo: { hash: 'ee'.repeat(32), timestamp: 2000 } })).problems.join(), /hash is/);
  assert.match((await prCheck(c, head, fin, { repoDir: repo, basePath: `${repo}/transcript.json`, blockInfo: { hash: blockHash, timestamp: 900 } })).problems.join(), /not after the declaration/);
});

test('beacon block from RPCs: all answering RPCs must agree', async () => {
  let second = '0x' + 'aa'.repeat(32);
  const srv = (hash) => createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const q = JSON.parse(b);
      const result = q.method === 'eth_blockNumber' ? '0x10' : { hash: typeof hash === 'function' ? hash() : hash, timestamp: '0x64', number: q.params[0] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    });
  });
  const a = srv('0x' + 'AA'.repeat(32));
  const b = srv(() => second);
  await Promise.all([a, b].map((s) => new Promise((ok) => s.listen(0, '127.0.0.1', ok))));
  const t = { beaconRpc: { ethereum: [`http://127.0.0.1:${a.address().port}`, `http://127.0.0.1:${b.address().port}`] } };
  try {
    assert.deepEqual(await blockOf(t, 'ethereum', 5), { hash: 'aa'.repeat(32), timestamp: 100 });
    assert.deepEqual(await latestBlock(t, 'ethereum'), { number: 16 });
    second = '0x' + 'bb'.repeat(32);
    await assert.rejects(blockOf(t, 'ethereum', 5), /disagree/);
  } finally { a.close(); b.close(); }
});

test('entropy mixing, release-URL rule, verify-log parsing', async () => {
  const r = new Uint8Array(64).fill(7);
  const e1 = await mixEntropy(r, 'typed');
  assert.match(e1, /^[0-9a-f]{128}$/);
  assert.notEqual(e1, await mixEntropy(r, 'typed!'));
  await assert.rejects(mixEntropy(new Uint8Array(8)), /32 random bytes/);
  assert.match(url('ada', 1), ZKEY_URL);
  for (const bad of ['http://github.com/a/b/releases/download/t/x.zkey', 'https://github.com.evil/a/b/releases/download/t/x.zkey', 'https://github.com/a/b/raw/t/x.zkey', 'https://github.com/a/b/releases/download/t/x.zkey?x=1']) assert.doesNotMatch(bad, ZKEY_URL, bad);
  const lines = ['Circuit Hash: \n\t\t00 11', 'contribution #2 Final beacon:\n\t\taabbccdd 00112233\n\t\t44556677 8899aabb', 'Beacon generator: abcd', 'Beacon iterations Exp: 10', 'contribution #1 :\n\t\t01020304'];
  assert.deepEqual(parseVerifyLog(lines), [{ n: 1, name: '', hash: '01020304' }, { n: 2, name: 'Final beacon', hash: 'aabbccdd00112233445566778899aabb', beaconHash: 'abcd', iterationsExp: 10 }]);
});

// snarkjs' curve keeps worker threads: end them so the test process exits
after(async () => { await globalThis.curve_bn128?.terminate(); });
