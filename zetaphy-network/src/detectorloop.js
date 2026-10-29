// The evolving-detector loop, end to end (docs/future/markets.md, item 26). One call runs one pass; a schedule
// (.github/workflows/markets.yml `detectors`) runs it every few hours, so a full DetectorPool round needs no
// hand work:
//   1. breed   (once per pool round): parents = the living organisms whose spec is in the population folder
//              (else the seed); zetaphy-neuro/ml/detectors/mutate.js evolve() mutates them; a child is kept only
//              if its Brier on HELD-OUT labelled rows beats its parent's (the curated held-out file when given,
//              else the deterministic 30% split). Seeded by the pool's round number: reproducible.
//   2. submit  each new child: its Foresight model id and a DetectorPool organism with the testnet stake
//              (content-addressed spec file <first 16 hex of specHash>.json; the URI is uriBase + that name).
//   3. forecast every open Foresight event of RiskForecasts (or `events`): each of OUR living organisms
//              commits p = predict(spec, features of the event's token); the salt is derived from the key.
//   4. reveal  after an event's commit deadline: p is recovered from the on-chain commitment by trying the
//              10,001 possible values with the derived salt, so nothing is stored between runs and a changed
//              token cannot change what is revealed.
//   5. score   resolved events: ForesightRegistry.scoreMany for every living organism's model.
//   6. settle  DetectorPool.scoreRound once the round has ended (pay winners, slash and retire losers).
// Every pass writes a manifest (inputs' hashes, the round's seed, the parents, the children, every prediction
// with the features it used, every action), so anyone can recompute it offline (checkManifest).
// TESTNET ONLY: refuses any chain but 77390 (and 31337 / 1337 with devnet: true).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Contract, getAddress, ZeroHash, parseEther } from 'ethers';
import { artifact, foresightCommitment, derivedSalt, modelIdOf, readQuestions } from './markets.js';
import { evolve } from '../../zetaphy-neuro/ml/detectors/mutate.js';
import { checkSpec, specHash, predict, toBps, seedSpec } from '../../zetaphy-neuro/ml/detectors/spec.js';

const OUTCOME = ['open', 'no', 'yes', 'void'];
export const modelOf = (hash) => modelIdOf(`detector ${hash}`);
const sha = (x) => '0x' + createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

/** The specs of the population folder, by specHash. */
export function readPopulation(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try { const s = checkSpec(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))); out.set(specHash(s), s); } catch { /* not a spec */ }
  }
  return out;
}

/** Recovers p (basis points) from a Foresight commitment and its derived salt: 10,001 tries at most. */
export function recoverP(eventId, modelId, salt, commitment) {
  for (let p = 0; p <= 10_000; p++) if (foresightCommitment(eventId, modelId, p, salt) === commitment) return p;
  return null;
}

/** The predictions a set of specs makes for a set of events (pure: what the manifest records and checks). */
export function predictionsOf(specs, events) {
  const out = [];
  for (const e of events) for (const [hash, spec] of specs) out.push({ event: e.eventId, specHash: hash, modelId: modelOf(hash), bps: toBps(predict(spec, e.f ?? {})) });
  return out;
}

/** Recomputes a manifest's children and predictions from its own inputs; returns the differences ([] = same). */
export function checkManifest(m, { rows, held = null }) {
  const diff = [];
  if (m.inputs.rowsHash !== sha(rows)) diff.push('rows differ from the manifest\'s');
  if (m.breed) {
    const res = evolve({ parents: m.breed.parents.map((p) => ({ organism: p.organism, spec: p.spec })), rows, held, round: m.round, n: m.breed.n, seed: m.breed.seed });
    const a = res.children.map((c) => c.specHash);
    if (JSON.stringify(a) !== JSON.stringify(m.breed.children.map((c) => c.specHash))) diff.push(`children ${a.join(',')} != ${m.breed.children.map((c) => c.specHash).join(',')}`);
  }
  const specs = new Map(m.specs.map((s) => [specHash(s), checkSpec(s)]));
  const p = predictionsOf(specs, m.events);
  if (JSON.stringify(p) !== JSON.stringify(m.predictions)) diff.push('predictions differ');
  return diff;
}

/**
 * One pass of the loop. o: {
 *   signer (ethers signer; with dryRun it only plans), foresight, pool (addresses), forecasts (RiskForecasts, optional),
 *   events (optional: [{ eventId, token }] in place of reading RiskForecasts), featuresOf(token) -> { feature: value },
 *   privateKey (salts), dir (population folder: parents in, children out), rows (labelled rows), held (optional
 *   curated held-out rows), n (children per round, 6), stake (wei, 1 ZETAPHY), uriBase, breed (true), submit (true),
 *   dryRun, devnet, log, out (manifest file) }
 */
export async function detectorRound(o) {
  const log = o.log ?? (() => {});
  const provider = o.signer.provider;
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 77390n && !(o.devnet && [31337n, 1337n].includes(chainId))) throw new Error(`chain ${chainId}: the detector loop runs on the ZETAPHY testnet (77390) only`);
  const me = getAddress(await o.signer.getAddress());
  const fs = new Contract(o.foresight, artifact('ForesightRegistry').abi, o.signer);
  const pool = new Contract(o.pool, artifact('DetectorPool').abi, o.signer);
  const now = Number((await provider.getBlock('latest')).timestamp);
  const round = Number(await pool.round());
  const actions = [];
  const act = async (label, c, fn, args, value = 0n) => {
    try { await c[fn].staticCall(...args, { value }); } catch (e) { actions.push({ label, skipped: e.shortMessage ?? e.message }); return false; }
    if (o.dryRun) { actions.push({ label, planned: true }); log(`would ${label}`); return true; }
    const r = await (await c[fn](...args, { value })).wait();
    actions.push({ label, tx: r.hash });
    log(label);
    return true;
  };
  const rows = o.rows ?? [];
  const manifest = { format: 'zetaphy-detector-round/1', chainId: Number(chainId), pool: o.pool, foresight: o.foresight, round, me, at: now, inputs: { rowsHash: sha(rows), rows: rows.length, heldHash: o.held ? sha(o.held) : null }, breed: null, specs: [], events: [], predictions: [], actions };

  // living organisms and their specs
  const population = readPopulation(o.dir);
  const alive = [];
  const n = Number(await pool.aliveCount());
  for (let i = 0; i < n; i++) {
    const id = Number(await pool.aliveIds(i));
    const g = await pool.organism(id);
    alive.push({ id, author: getAddress(g.author), modelId: g.modelId, specHash: g.specHash, spec: population.get(g.specHash) ?? null, lastBrier: Number(g.lastBrier) });
  }

  // 1-2. breed once per pool round (a child of this round already registered by us = done), then submit
  const bredThisRound = alive.some((a) => a.author === me && a.spec?.name?.startsWith(`r${round}-`));
  if (o.breed !== false && rows.length && !bredThisRound) {
    const parents = alive.filter((a) => a.spec).sort((a, b) => (a.lastBrier || 1e9) - (b.lastBrier || 1e9) || a.id - b.id).slice(0, 8).map((a) => ({ organism: a.id, spec: a.spec }));
    if (!parents.length) parents.push(...[...population.values()].map((s) => ({ organism: 0, spec: s })));
    if (!parents.length) parents.push({ organism: 0, spec: seedSpec() });
    const seed = 'neuro-detectors';
    const res = evolve({ parents, rows, held: o.held ?? null, round, n: o.n ?? 6, seed });
    manifest.breed = { seed, n: o.n ?? 6, heldRows: res.heldRows, parents: parents.map((p) => ({ organism: p.organism, specHash: specHash(p.spec), spec: p.spec })), children: res.children.map(({ spec, ...c }) => ({ ...c, name: spec.name })) };
    mkdirSync(o.dir, { recursive: true });
    for (const c of res.children) {
      writeFileSync(`${o.dir}/${c.specHash.slice(2, 18)}.json`, JSON.stringify(c.spec, null, 1) + '\n');
      population.set(c.specHash, c.spec);
      if (o.submit === false) continue;
      const modelId = modelOf(c.specHash);
      if (getAddress(await fs.modelOwner(modelId)) !== me) await act(`register model ${c.specHash.slice(0, 10)}`, fs, 'registerModel', [modelId]);
      const parentOrganism = parents.find((p) => specHash(p.spec) === c.parent)?.organism ?? 0;
      const ok = await act(`register organism ${c.spec.name}`, pool, 'register', [modelId, c.specHash, parentOrganism, `${String(o.uriBase ?? '').replace(/\/$/, '')}/${c.specHash.slice(2, 18)}.json`], BigInt(o.stake ?? parseEther('1')));
      if (ok && !o.dryRun) alive.push({ id: null, author: me, modelId, specHash: c.specHash, spec: c.spec, lastBrier: 0 });
    }
  }

  // events: RiskForecasts questions with a Foresight event (or the given list)
  let events = o.events;
  if (!events) {
    events = [];
    if (o.forecasts) for (const q of await readQuestions(provider, o.forecasts)) if (q.foresightId > 0) events.push({ eventId: q.foresightId, token: q.token });
  }
  const mine = alive.filter((a) => a.author === me && a.spec);
  manifest.specs = mine.map((a) => a.spec);
  const salt = (eventId, modelId) => derivedSalt(o.privateKey, eventId, modelId);
  for (const e of events) {
    const ev = await fs.events(e.eventId);
    const info = { eventId: Number(e.eventId), token: e.token, commitEnd: Number(ev.commitEnd), revealEnd: Number(ev.revealEnd), outcome: OUTCOME[Number(ev.outcome)] };
    // 3. forecast (commit) while open
    if (info.outcome === 'open' && now < info.commitEnd && mine.length) {
      info.f = await o.featuresOf(e.token);
      for (const p of predictionsOf(new Map(mine.map((a) => [a.specHash, a.spec])), [info])) {
        manifest.predictions.push(p);
        const f = await fs.forecasts(p.event, p.modelId);
        if (f.commitment !== ZeroHash) continue;
        await act(`commit event ${p.event} ${p.specHash.slice(0, 10)} ${p.bps}`, fs, 'commit', [p.event, p.modelId, foresightCommitment(p.event, p.modelId, p.bps, salt(p.event, p.modelId))]);
      }
    }
    // 4. reveal after the commit deadline
    if (now >= info.commitEnd && now < info.revealEnd) {
      for (const a of alive.filter((x) => x.author === me)) {
        const f = await fs.forecasts(info.eventId, a.modelId);
        if (f.commitment === ZeroHash || f.revealed) continue;
        const bps = recoverP(info.eventId, a.modelId, salt(info.eventId, a.modelId), f.commitment);
        if (bps == null) { actions.push({ label: `reveal event ${info.eventId}`, skipped: 'commitment not made with this key' }); continue; }
        await act(`reveal event ${info.eventId} ${a.specHash.slice(0, 10)} ${bps}`, fs, 'reveal', [info.eventId, a.modelId, bps, salt(info.eventId, a.modelId)]);
      }
    }
    // 5. score resolved events (anyone's organisms: scores are public)
    if (info.outcome === 'yes' || info.outcome === 'no') {
      const ids = [];
      for (const a of alive) {
        const f = await fs.forecasts(info.eventId, a.modelId);
        if (f.commitment !== ZeroHash && !f.scored && (f.revealed || now >= info.revealEnd)) ids.push(a.modelId);
      }
      if (ids.length) await act(`score event ${info.eventId} (${ids.length})`, fs, 'scoreMany', [info.eventId, ids]);
    }
    manifest.events.push(info);
  }

  // 6. settle the pool round
  if (now >= Number(await pool.roundEnd())) await act(`score pool round ${round}`, pool, 'scoreRound', []);
  if (o.out) { mkdirSync(String(o.out).replace(/\/[^/]*$/, '') || '.', { recursive: true }); writeFileSync(o.out, JSON.stringify(manifest, null, 1) + '\n'); }
  return manifest;
}

export { sha as hashOf };
