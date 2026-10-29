// Builds the money-flow graph of a token or contract:
//   deployer (and the contract that created it, if any)
//   -> the deployer's funding trail (N hops back, graph/walk.js)
//   -> the first wallets that received the token, and who funded them
//   -> wallets funded by the same source (graph/cluster.js)
//   -> liquidity added to / removed from its pool, per address
//   -> the deployer's earlier contracts, and their liquidity
//   -> links to addresses Neuro already knows (graph/knownbad.js)
// then fixed rules turn those facts into signals (graph/signals.js).
//
// Bounded on purpose: a request budget and a deadline (graph/util.js), hop
// limits, and at most `receivers` wallets sampled. When a bound or a source
// stops it, the graph says so (`partial`, `notes`) and keeps what it has.
import { CHAINS } from '../src/chains.js';
import { createBudget, BudgetError, lc, DEAD, pct, canonical, sha256Hex } from './util.js';
import { createEvmClient, createSolanaClient, createBlockscout, createCosmosClient } from './clients.js';
import { createEvmProvider } from './evm.js';
import { createSolanaProvider } from './solana.js';
import { createCosmosProvider } from './cosmos.js';
import { sourcesFor, ZETAPHY } from './sources.js';
import { walkFunding, createWalkMemo } from './walk.js';
import { clusterByFunder } from './cluster.js';
import { createKnownBad } from './knownbad.js';
import { deriveSignals, levelOf } from './signals.js';

export const GRAPH_VERSION = 1;

/** Providers for a chain from its free sources (or throws if the chain is not covered). */
export function providerFor(chainKey, { fetchImpl, budget, cache, src: override } = {}) {
  const src = override ?? sourcesFor(chainKey);
  if (!src) throw new Error(`money-flow graph does not cover ${chainKey}`);
  const common = { fetchImpl, budget, cache };
  if (src.kind === 'evm') {
    const rpc = createEvmClient(src.rpcs, src.chainId, common);
    const blockscout = src.blockscout ? createBlockscout(src.blockscout, common) : null;
    const cosmos = src.rest ? createCosmosClient(src.rest, common) : null;
    return createEvmProvider({ rpc, blockscout, cosmos, src });
  }
  if (src.kind === 'solana') return createSolanaProvider({ rpc: createSolanaClient(src.rpcs, src.genesisHash, common), src });
  if (src.kind === 'cosmwasm') return createCosmosProvider({ rest: createCosmosClient(src.rest, common) });
  throw new Error(`money-flow graph does not cover ${chainKey}`);
}

/**
 * @param {string} chainKey
 * @param {string} address
 * @param {object} [o]
 * @param {object} [o.provider]        inject (tests); default from graph/sources.js
 * @param {object} [o.registryRpc]     EVM client on ZETAPHY for ThreatRegistry (default: created; false = off)
 * @param {object} [o.memory]          graph/knownbad.js createVerdictMemory
 * @param {Map}    [o.knownList]       extra known addresses
 * @param {number} [o.maxHops=3]       deployer funding trail
 * @param {number} [o.receiverHops=2]  receivers' funding trails
 * @param {number} [o.receivers=12]    wallets sampled
 * @param {number} [o.sybilMinSize=3]
 * @param {number} [o.priorLimit=5]    earlier contracts listed; [o.priorLpChecks=2] of them checked for liquidity
 * @param {number} [o.maxRequests=220] [o.timeMs=60000]
 * @param {(stage:string) => void} [o.onProgress]
 */
export async function buildFlowGraph(chainKey, address, o = {}) {
  const t0 = Date.now();
  const budget = o.budget ?? createBudget({ maxRequests: o.maxRequests ?? 220, timeMs: o.timeMs ?? 60_000 });
  const src = o.src ?? sourcesFor(chainKey);
  const provider = o.provider ?? providerFor(chainKey, { fetchImpl: o.fetchImpl, budget, cache: o.cache, src });
  const token = lc(address);
  const progress = o.onProgress ?? (() => {});
  const notes = [];
  let partial = false;
  let stopped = false;

  /** Runs one stage; a failure or an exhausted budget is noted, not thrown. */
  const stage = async (name, fn, fallback = null) => {
    if (stopped) { partial = true; return fallback; }
    progress(name);
    try { return await fn(); } catch (e) {
      partial = true;
      if (e instanceof BudgetError) { stopped = true; notes.push(`${name}: ${e.message}`); } else notes.push(`${name}: ${String(e?.message ?? e).slice(0, 120)}`);
      return fallback;
    }
  };

  const memo = createWalkMemo();
  const walkOpts = (hops) => ({ funderOf: provider.funderOf, profile: provider.profile, maxHops: hops, memo });

  const creation = await stage('creation', () => provider.creation(token));
  const deployer = creation?.deployer ? lc(creation.deployer) : null;
  const creatorIsContract = !!(creation?.creator && deployer && lc(creation.creator) !== deployer);
  const walkStage = async (name, start, hops) => {
    const w = await stage(name, () => walkFunding(start, walkOpts(hops)));
    if (w?.stop === 'budget') { stopped = true; partial = true; notes.push(`${name}: ${w.error}`); }
    if (w?.stop === 'error') { partial = true; notes.push(`${name}: ${w.error}`); }
    return w;
  };
  const deployerWalk = deployer ? await walkStage('deployer-funding', deployer, o.maxHops ?? 3) : null;
  const deployerProfile = deployer ? await stage('deployer-profile', () => memo.profile.get(deployer) ?? provider.profile(deployer)) : null;
  const pairInfo = await stage('pool', () => provider.findPair(token));
  const pair = pairInfo?.pair ?? null;

  const exclude = new Set([token, ...(pair ? [pair] : []), ...DEAD, ...(src?.dex ? [lc(src.dex.router)] : [])]);
  const early = await stage('receivers', () => provider.earlyReceivers(token, creation?.block ?? undefined, { limit: o.receivers ?? 12, exclude }));
  const receivers = early?.receivers ?? [];

  const receiverWalks = [];
  for (const r of receivers) {
    if (stopped) { partial = true; break; }
    if (lc(r.addr) === deployer) continue;
    const w = await walkStage('receiver-funding', r.addr, o.receiverHops ?? 2);
    if (w) receiverWalks.push(w);
  }
  const hubs = [...new Set([deployerWalk, ...receiverWalks].filter((w) => w?.stop === 'hub').map((w) => w.origin))];
  for (const [a, p] of memo.profile) { const v = await Promise.resolve(p).catch(() => null); if (v?.hub && !hubs.includes(a)) hubs.push(a); }
  const clusters = clusterByFunder(receiverWalks, { hubs: new Set(hubs), minSize: o.sybilMinSize ?? 3, ignore: exclude });

  const liquidity = pair ? await stage('liquidity', () => provider.liquidity(pair, creation?.block ?? undefined)) : null;
  const lpHolding = pair && deployer ? await stage('lp-holding', () => provider.lpHolding(pair, deployer)) : null;

  const priors = deployer && !creatorIsContract ? (await stage('prior-contracts', () => provider.priorContracts(deployer, { exclude: new Set([token]), limit: o.priorLimit ?? 5 }), [])) : [];
  let lpChecks = o.priorLpChecks ?? 2;
  for (const p of priors) {
    if (lpChecks <= 0 || stopped) break;
    const pp = await stage('prior-pool', () => provider.findPair(p.addr));
    if (!pp?.pair) continue;
    lpChecks--;
    const l = await stage('prior-liquidity', () => provider.liquidity(pp.pair, p.block ?? undefined));
    if (!l) continue;
    const mine = l.providers.filter((x) => x.addr === deployer || deployerWalk?.hops.some((h) => h.from === x.addr));
    const added = mine.reduce((s, x) => s + BigInt(x.added), 0n);
    const removed = mine.reduce((s, x) => s + BigInt(x.removed), 0n);
    p.lp = { pair: pp.pair, removedShare: pct(removed, added), removeTxs: mine.flatMap((x) => x.removeTxs).slice(0, 4) };
  }

  // Known addresses: the deployer side first (it matters most if the registry budget runs out).
  const chain = CHAINS[chainKey];
  const registryRpc = o.registryRpc === false ? null
    : o.registryRpc ?? (chain?.kind === 'evm' ? createEvmClient([ZETAPHY.rpc], ZETAPHY.chainId, { fetchImpl: o.fetchImpl, budget, cache: o.cache }) : null);
  const knownBad = createKnownBad({ registryRpc, chainId: chain?.kind === 'evm' ? chain.id : null, chain: chainKey, memory: o.memory ?? null, list: o.knownList ?? null });
  const toCheck = [deployer, creation?.creator, ...(deployerWalk?.hops ?? []).map((h) => h.from), ...priors.map((p) => p.addr),
    ...clusters.map((c) => c.source), ...(liquidity?.providers ?? []).flatMap((p) => [p.addr, ...p.receivers]), ...receivers.map((r) => r.addr)]
    .filter(Boolean).map(lc).filter((a, i, all) => all.indexOf(a) === i && !hubs.includes(a));
  const known = await stage('known-addresses', () => knownBad.check(toCheck), new Map());
  notes.push(...knownBad.notes, ...(provider.notes ?? []));
  if ((provider.notes ?? []).length) partial = true;

  const facts = {
    creation, creatorIsContract, deployerWalk, deployerProfile, pair, receivers, mints: early?.mints ?? [], receiverWalks, clusters, hubs,
    liquidity, lpHolding, priors, known, partial, notes: [...new Set(notes)],
  };
  const signals = deriveSignals(facts);
  const { nodes, edges } = toNodesAndEdges(token, facts);
  const graph = {
    version: GRAPH_VERSION, chain: chainKey, address: token, level: levelOf(signals), signals, nodes, edges,
    creation, deployerWalk, receivers, clusters, hubs, liquidity, lpHolding, priors,
    known: Object.fromEntries(known), partial, notes: facts.notes,
    stats: { requests: budget.used, ms: Date.now() - t0, receiversSampled: receiverWalks.length },
  };
  // What the rules saw, hashed: two machines that read the same facts get the same id.
  graph.graphHash = await sha256Hex(canonical({ v: GRAPH_VERSION, chain: chainKey, address: token, signals: signals.map((s) => ({ id: s.id, severity: s.severity, evidence: s.evidence })) }));
  return graph;
}

/** Nodes (unique addresses, with roles) and edges (funded / deployed / received / liquidity). */
export function toNodesAndEdges(token, f) {
  const nodes = new Map();
  const edges = [];
  const node = (id, role, extra = {}) => {
    if (!id) return;
    const k = lc(id);
    const n = nodes.get(k) ?? { id: k, roles: [] };
    if (!n.roles.includes(role)) n.roles.push(role);
    // A funder on several trails keeps its nearest hop on the first trail drawn (the deployer's).
    for (const [key, v] of Object.entries(extra)) if (n[key] == null) n[key] = v;
    nodes.set(k, n);
  };
  const edge = (from, to, kind, tx = null, extra = {}) => { if (from && to) edges.push({ from: lc(from), to: lc(to), kind, tx, ...extra }); };
  const hubs = new Set(f.hubs ?? []);

  node(token, 'token');
  const dep = f.creation?.deployer;
  if (dep) {
    node(dep, 'deployer');
    if (f.creatorIsContract) { node(f.creation.creator, 'factory'); edge(dep, f.creation.creator, 'called', f.creation.tx); edge(f.creation.creator, token, 'deployed', f.creation.tx); } else edge(dep, token, 'deployed', f.creation.tx);
  }
  for (const h of f.deployerWalk?.hops ?? []) { node(h.from, hubs.has(h.from) ? 'hub' : 'funder', { hop: h.hop }); edge(h.from, h.to, 'funded', h.tx, { value: h.value }); }
  for (const r of f.receivers ?? []) { node(r.addr, 'receiver'); edge(token, r.addr, r.minted ? 'minted' : 'received', r.tx, { value: r.amount }); }
  for (const w of f.receiverWalks ?? []) for (const h of w.hops) { node(h.from, hubs.has(h.from) ? 'hub' : 'funder', { hop: h.hop }); edge(h.from, h.to, 'funded', h.tx, { value: h.value }); }
  for (const c of f.clusters ?? []) node(c.source, 'cluster-source', { clusterSize: c.members.length });
  if (f.pair) { node(f.pair, 'pool'); edge(token, f.pair, 'pool'); }
  for (const p of f.liquidity?.providers ?? []) {
    node(p.addr, 'lp-provider');
    if (BigInt(p.added) > 0n) edge(p.addr, f.pair, 'lp-add', p.addTxs[0] ?? null, { value: p.added });
    if (BigInt(p.removed) > 0n) for (const r of p.receivers.length ? p.receivers : [p.addr]) { node(r, 'lp-receiver'); edge(f.pair, r, 'lp-remove', p.removeTxs[0] ?? null, { value: p.removed }); }
  }
  for (const p of f.priors ?? []) { node(p.addr, 'prior'); edge(dep, p.addr, 'deployed', p.tx); }
  const known = f.known instanceof Map ? f.known : new Map(Object.entries(f.known ?? {}));
  for (const [a, k] of known) if (nodes.has(a)) nodes.get(a).flagged = { source: k.source, reason: k.reason ?? null };
  // Dedupe edges (the same funding hop is often on several trails).
  const seen = new Set();
  const unique = edges.filter((e) => { const k = `${e.from}>${e.to}>${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { nodes: [...nodes.values()].slice(0, 80), edges: unique.slice(0, 160) };
}
