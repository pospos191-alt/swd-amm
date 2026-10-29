// The evolving-detector loop end to end (docs/future/markets.md, item 26): breed on held-out labelled rows,
// submit, forecast every open event, reveal from the derived salt (p recovered from the commitment), score,
// settle the pool round: one function, run repeatedly like the schedule does, with real signed transactions
// against an in-memory chain at chain id 77390. Deterministic: a second world gives the same children and
// predictions, and the manifest re-checks offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { keccak256, parseEther } from 'ethers';
import { createRpcChain, serveRpc, ZETA } from './helpers/rpcchain.js';
import { detectorRound, checkManifest, recoverP, modelOf } from '../src/detectorloop.js';
import { foresightCommitment, derivedSalt } from '../src/markets.js';

const DAY = 86400;
const H = (s) => keccak256(new TextEncoder().encode(s));

/** Labelled rows: a trap when the sell simulation fails, or a hash guard with a high rules level (as ml/test). */
function rows(n, tag) {
  let x = 0x2545f491;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
  return Array.from({ length: n }, (_, i) => {
    const f = { m_sim_cannot_sell: rnd() < 0.2 ? 1 : 0, p_hash_guard: rnd() < 0.3 ? Math.round(rnd() * 100) / 100 : 0, r_level: Math.floor(rnd() * 4), o_size: Math.round(rnd() * 300) / 100 };
    const label = f.m_sim_cannot_sell === 1 || (f.p_hash_guard >= 0.5 && f.r_level >= 2) ? 1 : 0;
    for (const k of Object.keys(f)) if (f[k] === 0) delete f[k];
    return { id: `${tag}-${i}`, label, f };
  });
}
const TRAIN = rows(500, 'fit');
const HELD = rows(200, 'held').map((r, i) => ({ ...r, id: `held-${i}` }));
const TOKENS = { scam1: { m_sim_cannot_sell: 1, r_level: 3 }, scam2: { p_hash_guard: 0.9, r_level: 3 }, ok1: { o_size: 1.2 }, ok2: { r_level: 1 } };

async function world() {
  const c = await createRpcChain({ accounts: 4 });
  const [gov, res, runner, funder] = c.signers;
  const fs = await c.deploy('ForesightRegistry', [gov.address], gov);
  await (await fs.setResolver(res.address, true)).wait();
  const pool = await c.deploy('DetectorPool', [gov.address, await fs.getAddress()], gov);
  await (await pool.connect(funder).fund({ value: 20n * ZETA })).wait();
  const t = c.now();
  const addr = {};
  const events = [];
  for (const name of Object.keys(TOKENS)) {
    addr[name] = '0x' + H(name).slice(26);
    await (await fs.connect(res).openEvent(H(`event ${name}`), t + 3600n, t + 2n * 3600n)).wait();
    events.push({ eventId: events.length + 1, token: addr[name] });
  }
  const featuresOf = async (token) => TOKENS[Object.keys(addr).find((k) => addr[k] === token)];
  return { c, gov, res, runner, fs, pool, events, addr, featuresOf };
}

test('detector loop: breed on held-out rows, submit, forecast, reveal, score, settle; idempotent passes', { timeout: 300_000 }, async () => {
  const w = await world();
  const dir = mkdtempSync(`${tmpdir()}/detectors-`);
  try {
    const base = { signer: w.runner, foresight: await w.fs.getAddress(), pool: await w.pool.getAddress(), events: w.events, featuresOf: w.featuresOf, privateKey: w.runner.privateKey, dir, rows: TRAIN, held: HELD, n: 3, stake: parseEther('1'), uriBase: 'https://example.org/population' };
    // pass 1: breed (no parents yet: the seed), submit each child, commit its forecasts
    const m1 = await detectorRound({ ...base, out: `${dir}/m1.json` });
    assert.equal(m1.round, 1);
    assert.equal(m1.breed.heldRows, HELD.length, 'judged on the curated held-out rows');
    const kids = m1.breed.children;
    assert.ok(kids.length >= 1);
    for (const k of kids) assert.ok(k.brierHeld < k.parentHeld, 'only children that beat the parent on held-out rows');
    assert.equal(Number(await w.pool.aliveCount()), kids.length);
    assert.equal(readdirSync(dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).length, kids.length, 'content-addressed spec files');
    assert.equal(m1.predictions.length, kids.length * 4);
    for (const p of m1.predictions) {
      const f = await w.fs.forecasts(p.event, p.modelId);
      assert.equal(f.commitment, foresightCommitment(p.event, p.modelId, p.bps, derivedSalt(w.runner.privateKey, p.event, p.modelId)));
    }
    const scam = m1.predictions.filter((p) => p.event === 1).map((p) => p.bps);
    const ok = m1.predictions.filter((p) => p.event === 3).map((p) => p.bps);
    assert.ok(Math.min(...scam) > Math.max(...ok), 'the scam token gets the higher probability');
    assert.ok(JSON.parse(readFileSync(`${dir}/m1.json`, 'utf8')).breed);
    // pass 2, same time: nothing new to do (bred this round, already committed)
    const m2 = await detectorRound(base);
    assert.equal(m2.breed, null);
    assert.equal(m2.actions.filter((a) => a.tx).length, 0);
    // pass 3, after the commit deadline: every forecast revealed (p recovered from the commitment)
    w.c.advance(3600);
    const m3 = await detectorRound(base);
    assert.equal(m3.actions.filter((a) => a.tx && /^reveal/.test(a.label)).length, kids.length * 4);
    for (const p of m1.predictions) assert.equal(Number((await w.fs.forecasts(p.event, p.modelId)).p), p.bps);
    // the resolver answers from chain facts: the scams happened, the others did not
    for (const [i, name] of Object.keys(TOKENS).entries()) await (await w.fs.connect(w.res).resolve(i + 1, name.startsWith('scam') ? 2 : 1)).wait();
    // pass 4: scored
    const m4 = await detectorRound(base);
    assert.equal(m4.actions.filter((a) => a.tx && /^score event/.test(a.label)).length, 4);
    const [n] = await w.fs.brierOf(modelOf(kids[0].specHash));
    assert.equal(n, 4n);
    // pass 5, after the pool round: scoreRound pays the winners (Brier < 0.25 over >= 3 forecasts)
    w.c.advance(7 * DAY);
    const m5 = await detectorRound({ ...base, breed: false });
    assert.ok(m5.actions.some((a) => a.tx && /score pool round 1/.test(a.label)));
    assert.equal(await w.pool.round(), 2n);
    assert.ok((await w.pool.owed(w.runner.address)) > 0n, 'the detectors earned their round');
    // the manifest re-checks offline from its own inputs
    assert.deepEqual(checkManifest(m1, { rows: TRAIN, held: HELD }), []);
    const tampered = JSON.parse(JSON.stringify(m1));
    tampered.predictions[0].bps += 1;
    assert.deepEqual(checkManifest(tampered, { rows: TRAIN, held: HELD }), ['predictions differ']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detector loop: reproducible (a second world gives the same children and predictions); dry run sends nothing', { timeout: 300_000 }, async () => {
  const run = async (dryRun) => {
    const w = await world();
    const dir = mkdtempSync(`${tmpdir()}/detectors-`);
    try {
      const m = await detectorRound({ signer: w.runner, foresight: await w.fs.getAddress(), pool: await w.pool.getAddress(), events: w.events, featuresOf: w.featuresOf, privateKey: w.runner.privateKey, dir, rows: TRAIN, held: HELD, n: 3, uriBase: 'https://x', dryRun });
      return { m, alive: Number(await w.pool.aliveCount()) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const a = await run(false);
  const b = await run(true);
  assert.deepEqual(b.m.breed.children, a.m.breed.children);
  assert.equal(b.alive, 0, 'dry run: nothing registered');
  assert.ok(b.m.actions.every((x) => !x.tx));
  assert.equal(recoverP(1, H('m'), H('s'), foresightCommitment(1, H('m'), 1234, H('s'))), 1234);
  assert.equal(recoverP(1, H('m'), H('other'), foresightCommitment(1, H('m'), 1234, H('s'))), null);
});

test('detector loop CLI: markets.js detectors-round on the testnet node (dry run, then --send)', { timeout: 300_000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const w = await world();
  const node = await serveRpc(w.c, 18098);
  const dir = mkdtempSync(`${tmpdir()}/detectors-cli-`);
  try {
    writeFileSync(`${dir}/key`, w.runner.privateKey, { mode: 0o600 });
    writeFileSync(`${dir}/rows.jsonl`, TRAIN.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(`${dir}/held.jsonl`, HELD.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(`${dir}/events.json`, JSON.stringify(w.events.map((e) => ({ ...e, f: TOKENS[Object.keys(w.addr).find((k) => w.addr[k] === e.token)] }))));
    const script = new URL('../scripts/markets.js', import.meta.url).pathname;
    const args = ['detectors-round', '--pool', await w.pool.getAddress(), '--foresight', await w.fs.getAddress(), '--events', `${dir}/events.json`,
      '--dir', `${dir}/population`, '--rows', `${dir}/rows.jsonl`, '--held', `${dir}/held.jsonl`, '--n', '2', '--uri-base', 'https://example.org/p', '--out', `${dir}/manifest.json`];
    const env = { ...process.env, ZETAPHY_RPC: node.url, KEYFILE: `${dir}/key` };
    const dry = JSON.parse((await promisify(execFile)(process.execPath, [script, ...args], { env })).stdout);
    assert.ok(dry.children >= 1 && dry.sent === 0);
    assert.equal(Number(await w.pool.aliveCount()), 0);
    const sent = JSON.parse((await promisify(execFile)(process.execPath, [script, ...args, '--send'], { env })).stdout);
    assert.ok(sent.sent > 0);
    assert.equal(Number(await w.pool.aliveCount()), sent.children);
    assert.equal(JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')).format, 'zetaphy-detector-round/1');
  } finally {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
