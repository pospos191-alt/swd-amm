#!/usr/bin/env node
// Neuro federated learning: aggregate one round into a candidate head.
//
// Runs in a scheduled GitHub Actions job (.github/workflows/neuro-fl.yml) or on
// any runner; no server. Deterministic: anyone can rerun it on the same round
// and get the same head, byte for byte, before voting on it.
//
//   node scripts/fl-aggregate.js --round 3 [--inbox dir] [--rpc URL --rounds 0xFederatedRounds]
//   (without --round but with --rpc/--rounds: the last round whose reveal phase is over)
//        [--rows held-out.jsonl] [--out out/fl]
//        [--registry 0xModelEpochs --gov-bech32 zetaphy1… --activation H --uri https://…/manifest.json]
//        [--deployment zetaphy-neuro/ml/fl/deployment.json]   (default: that file; its `rounds` and `rpc` are
//          used when --rounds / --rpc are not given, so the weekly job needs no variables once it is committed)
//        [--min-updates 20]   (fewer only on a devnet or in tests: robust aggregation needs many updates)
//
// Inputs: signed envelopes (*.json in --inbox) and/or Revealed events of the
// round on chain. Every update must be computed on the committed head
// (zetaphy-neuro/ml/fl/head.json) with its round's clip and noise.
// Outputs in --out: head.json (candidate), manifest.json, decision.json,
// body.md (pull request text) and, with --registry, proposal.json (the gov
// proposal that schedules the manifest in the ModelEpochs).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Contract } from 'ethers';
import { checkModel } from '../../zetaphy-neuro/ml/model.js';
import { checkHead, applyDelta, sealHead, zeroHead } from '../../zetaphy-neuro/ml/fl/head.js';
import { aggregateRound, DEFAULT_AGG } from '../../zetaphy-neuro/ml/fl/aggregate.js';
import { gateHead } from '../../zetaphy-neuro/ml/fl/gate.js';
import { buildManifest } from '../../zetaphy-neuro/ml/fl/registry.js';
import { DEFAULT_PRIVACY, epsilonOf, rhoPerRound } from '../../zetaphy-neuro/ml/fl/dp.js';
import { checkDeployment } from '../../zetaphy-neuro/ml/fl/deployment.js';
import { verifyEnvelope, readRevealed, ROUNDS_ABI } from '../src/fl.js';
import { scheduleProposal } from '../src/modelepochs.js';

const NEURO = new URL('../../zetaphy-neuro/', import.meta.url);

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
  return o;
}

const jsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Canary rows: recorded red-team evasions the model catches (strict) + optional held-out rows. */
export function canaryRows(rowsPath) {
  const ev = jsonl(new URL('ml/data/redteam/evasions.jsonl', NEURO));
  const gaps = new Set(JSON.parse(readFileSync(new URL('ml/data/redteam/known-gaps.json', NEURO), 'utf8')).gaps.map((g) => g.id));
  const rows = ev.filter((r) => !gaps.has(r.id)).map((r) => ({ id: r.id, f: r.f, label: 1, strict: true }));
  if (rowsPath && existsSync(rowsPath)) rows.push(...jsonl(rowsPath).map((r) => ({ id: r.id, f: r.f, label: r.label })));
  return rows;
}

/**
 * The whole step, without I/O beyond what is passed in (tests call this).
 * @returns {Promise<{decision:object, head:object|null, manifest:object|null}>}
 */
export async function aggregateToCandidate({ model, modelBytes, head, submissions, round, privacy = DEFAULT_PRIVACY, agg = {}, canaries }) {
  const roundSpec = { headHash: head.hash, round, dim: head.dim, clip: privacy.clip, z: privacy.z };
  const res = aggregateRound(submissions, roundSpec, { ...DEFAULT_AGG, ...agg });
  const decision = {
    round, head: head.id, accepted: res.accepted.length, rejected: res.rejected, method: agg.method ?? DEFAULT_AGG.method,
    trim: agg.trim ?? DEFAULT_AGG.trim, privacy: { clip: privacy.clip, z: privacy.z, epsilonPerRound: epsilonOf(rhoPerRound(privacy.z), privacy.delta ?? 1e-5) },
  };
  if (!res.delta) return { decision: { ...decision, better: false, why: res.why }, head: null, manifest: null };
  const cand = await sealHead(applyDelta(head, res.delta, 1));
  // The gate compares with the governance-approved trees alone (theta = 0), so
  // small losses cannot ratchet round after round.
  const gate = gateHead(model, zeroHead(model), cand, canaries);
  const out = { ...decision, candidate: cand.id, gate };
  if (!gate.ok) return { decision: { ...out, better: false, why: gate.reasons.join('; ') }, head: null, manifest: null };
  const headBytes = new TextEncoder().encode(JSON.stringify(cand) + '\n');
  const manifest = await buildManifest({ model, modelBytes, head: cand, headBytes });
  return { decision: { ...out, better: true, manifestHash: '0x' + manifest.hash }, head: cand, headBytes, manifest };
}

function body(d, proposal) {
  const lines = [
    `## Neuro federated head ${d.candidate} (round ${d.round})`,
    '',
    `Computed on head \`${d.head}\` from ${d.accepted} accepted updates (${d.rejected.length} rejected) with a coordinate-wise ${d.method}${d.method === 'trimmed' ? ` (${d.trim * 100}% each side)` : ''}.`,
    `Local differential privacy: clip ${d.privacy.clip}, noise multiplier ${d.privacy.z} -> epsilon ${d.privacy.epsilonPerRound.toFixed(2)} per submitted round (delta 1e-5, user level).`,
    '',
    `Gate against the plain trees: recall at medium ${d.gate.stats.recallC.toFixed(3)} -> ${d.gate.stats.recallN.toFixed(3)}, false alarms ${d.gate.stats.fprC.toFixed(3)} -> ${d.gate.stats.fprN.toFixed(3)} on ${d.gate.stats.pos + d.gate.stats.neg} canary rows.`,
    '',
    `Manifest sha256: \`${d.manifestHash}\` (what governance schedules in the ModelEpochs).`,
    '',
    'Before voting: rerun `node zetaphy-network/scripts/fl-aggregate.js` on the same round and compare the hash.',
  ];
  if (proposal) lines.push('', 'Proposal (submit with `zetaphyd tx gov submit-proposal proposal.json`): see the workflow artifact.');
  if (d.rejected.length) lines.push('', '<details><summary>Rejected updates</summary>', '', ...d.rejected.slice(0, 200).map((r) => `- ${r.sender}: ${r.why}`), '', '</details>');
  return lines.join('\n') + '\n';
}

/** The committed deployment record (ml/fl/deployment.json), or null when absent / malformed. */
export function readDeployment(path) {
  try { return checkDeployment(JSON.parse(readFileSync(path ?? new URL('ml/fl/deployment.json', NEURO), 'utf8'))); } catch { return null; }
}

async function main() {
  const o = args(process.argv.slice(2));
  const dep = readDeployment(o.deployment);
  if (!o.rounds && dep?.deployed) { o.rounds = dep.rounds; o.rpc ??= dep.rpc; }
  const provider = o.rpc ? new JsonRpcProvider(o.rpc) : null;
  if (o.round == null && provider && o.rounds) {
    const [r] = await new Contract(o.rounds, ROUNDS_ABI, provider).phaseAt(await provider.getBlockNumber());
    if (r === 0n) { console.log(JSON.stringify({ better: false, why: 'no finished round yet' })); return; }
    o.round = String(r - 1n);
  }
  if (o.round == null) { console.error('--round N is required (or --rpc and --rounds)'); process.exit(2); }
  const round = Number(o.round);
  if (o.inbox && existsSync(`${o.inbox}/round-${round}`)) o.inbox = `${o.inbox}/round-${round}`;
  const modelBytes = readFileSync(new URL('ml/model.json', NEURO));
  const model = checkModel(JSON.parse(modelBytes));
  const head = checkHead(model, JSON.parse(readFileSync(new URL('ml/fl/head.json', NEURO), 'utf8')));
  const submissions = [];
  const bad = [];
  if (o.inbox && existsSync(o.inbox)) {
    for (const f of readdirSync(o.inbox).filter((x) => x.endsWith('.json')).sort()) {
      try { submissions.push(verifyEnvelope(JSON.parse(readFileSync(`${o.inbox}/${f}`, 'utf8')))); } catch (e) { bad.push({ sender: f, why: e.message }); }
    }
  }
  if (provider && o.rounds) {
    // only the round's own blocks (public RPCs limit log ranges)
    const fr = new Contract(o.rounds, ROUNDS_ABI, provider);
    const from = Number(await fr.roundStart(round));
    const to = Number(await fr.roundStart(round + 1)) - 1;
    submissions.push(...await readRevealed(o.rounds, provider, round, { fromBlock: from, toBlock: to }));
  }
  const privacy = { ...DEFAULT_PRIVACY, ...(o.clip ? { clip: Number(o.clip) } : {}), ...(o.z ? { z: Number(o.z) } : {}) };
  const agg = o['min-updates'] ? { minUpdates: Number(o['min-updates']) } : {};
  if (agg.minUpdates != null && !(Number.isInteger(agg.minUpdates) && agg.minUpdates >= 1)) { console.error('--min-updates: a positive integer'); process.exit(2); }
  const r = await aggregateToCandidate({ model, modelBytes, head, submissions, round, privacy, agg, canaries: canaryRows(o.rows) });
  r.decision.rejected.push(...bad);
  const out = o.out ?? 'out/fl';
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/decision.json`, JSON.stringify(r.decision, null, 1) + '\n');
  let proposal = null;
  if (r.head) {
    writeFileSync(`${out}/head.json`, r.headBytes);
    writeFileSync(`${out}/manifest.json`, r.manifest.text);
    if (o.registry && o['gov-bech32'] && o.activation) {
      proposal = scheduleProposal({ registry: o.registry, hash: r.decision.manifestHash, activation: BigInt(o.activation), uri: o.uri ?? 'manifest.json',
        govBech32: o['gov-bech32'], modelId: model.id, headId: r.head.id });
      writeFileSync(`${out}/proposal.json`, JSON.stringify(proposal, null, 1) + '\n');
    }
    writeFileSync(`${out}/body.md`, body(r.decision, proposal));
  }
  console.log(JSON.stringify({ round, better: r.decision.better, why: r.decision.why ?? null, accepted: r.decision.accepted, rejected: r.decision.rejected.length,
    candidate: r.decision.candidate ?? null, manifestHash: r.decision.manifestHash ?? null }));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
