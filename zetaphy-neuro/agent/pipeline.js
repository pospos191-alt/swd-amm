// The investigator: a fixed, multi-step pipeline (an "agent" with no free
// will) that, given a token or contract, runs in this order:
//   1. rules     the contract rules (src/reader.js, trade test off here)
//   2. honeypot  the buy-then-sell test (src/honeypot.js), EVM tokens with a pool
//   3. graph     the money-flow graph (graph/build.js)
//   4. ml        optional hook: ml.score(features)        (agent/hooks.js)
//   5. llm       optional hook: llm.review(context)       (agent/hooks.js)
// then writes one report with a level, a 0-100 score, a confidence (how much
// of the evidence could actually be gathered) and every signal with its
// evidence. Each step has its own timeout; a step that fails or times out is
// recorded and the next one still runs. Same inputs, same report: nothing
// here is random, and the optional hooks can raise the level at most to
// "medium" (ml) or not at all (llm), never lower it.
//
// Runs anywhere Neuro runs, with no server: the web page (watch list, "Investigate"),
// a volunteer runner (agent/runner.js) and a scheduled GitHub Actions job
// (agent/scan-pools.js).
import { readContract } from '../src/reader.js';
import { simulateTrade } from '../src/honeypot.js';
import { simFindings } from '../src/analyze.js';
import { createRpc } from '../src/rpc.js';
import { CHAINS } from '../src/chains.js';
import { buildFlowGraph } from '../graph/build.js';
import { graphSupported } from '../graph/sources.js';
import { levelOf as graphLevel } from '../graph/signals.js';
import { withTimeout, canonical, sha256Hex, plain } from '../graph/util.js';
import { getHooks } from './hooks.js';

export const AGENT_VERSION = 1;
export const STEPS = ['rules', 'honeypot', 'graph', 'ml', 'llm'];
export const DEFAULT_TIMEOUTS = { rules: 30_000, honeypot: 25_000, graph: 90_000, ml: 10_000, llm: 30_000 };
const RANK = { info: 0, good: 0, low: 1, medium: 2, high: 3 };
const maxLevel = (...ls) => ls.filter(Boolean).reduce((m, l) => (RANK[l] > RANK[m] ? l : m), 'info');
// Core evidence weights for the confidence; ml / llm count only when a hook is set.
const WEIGHT = { rules: 0.4, honeypot: 0.2, graph: 0.4, ml: 0.1, llm: 0.1 };
const BASE_SCORE = { high: 80, medium: 50, low: 20, info: 5, good: 5 };
export const ML_ADVISORY_AT = 0.8;

/** Plain numbers for an ML model: counts and one-hot ids, never text. */
export function featuresOf(ctx) {
  const f = {};
  const findings = ctx.rules?.analysis?.findings ?? [];
  for (const s of ['high', 'medium', 'low', 'good', 'info']) f[`rules_${s}`] = findings.filter((x) => x.severity === s).length;
  for (const x of findings) f[`f:${x.id}`] = 1;
  const sim = ctx.honeypot;
  f.sim_ran = sim && sim.stage ? 1 : 0;
  f.sim_buy_tax = Number(sim?.buyTax ?? -1);
  f.sim_sell_tax = Number(sim?.sellTax ?? -1);
  f.sim_cannot_sell = sim?.stage === 'sell-failed' ? 1 : 0;
  const g = ctx.graph;
  for (const s of g?.signals ?? []) f[`g:${s.id}`] = Math.max(f[`g:${s.id}`] ?? 0, RANK[s.severity] ?? 0);
  f.graph_partial = g?.partial ? 1 : 0;
  f.graph_receivers = g?.receivers?.length ?? 0;
  f.graph_cluster_max = Math.max(0, ...(g?.clusters ?? []).map((c) => c.members.length));
  f.graph_deployer_hops = g?.deployerWalk?.hops?.length ?? 0;
  f.graph_prior_count = g?.priors?.length ?? 0;
  f.graph_known = Object.keys(g?.known ?? {}).length;
  const lp = (g?.signals ?? []).find((s) => s.id === 'lp-removed');
  f.lp_removed_share = lp ? Number(lp.params.share) : 0;
  return f;
}

/** Facts for a language model: ids, levels, numbers and addresses only. */
export function contextOf(ctx, target) {
  return {
    target: { chain: target.chain, address: target.address },
    rules: ctx.rules ? { level: ctx.rules.analysis?.level, findings: (ctx.rules.analysis?.findings ?? []).map((x) => ({ id: x.id, severity: x.severity })) } : null,
    honeypot: ctx.honeypot ? { stage: ctx.honeypot.stage, buyTax: ctx.honeypot.buyTax ?? null, sellTax: ctx.honeypot.sellTax ?? null } : null,
    graph: ctx.graph ? {
      level: ctx.graph.level, partial: ctx.graph.partial,
      signals: ctx.graph.signals.map((s) => ({ id: s.id, severity: s.severity, params: Object.fromEntries(Object.entries(s.params ?? {}).filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && /^(0x[0-9a-f]+|[1-9A-HJ-NP-Za-km-z]{32,44}|[a-z]+1[0-9a-z]{20,90})$/.test(v)))) })),
    } : null,
    ml: ctx.ml ?? null,
  };
}

/**
 * @param {{chain: string, address: string, chainConfig?: object, dex?: object}} target
 *   chainConfig / dex: for chains not in src/chains.js (e.g. ZETAPHY with its DEX)
 * @param {object} [deps]
 * @param {Function} [deps.readContract]   [deps.simulateTrade]   [deps.buildGraph]   (inject for tests)
 * @param {object}   [deps.rpcFor]         (chainCfg) => read-only EVM client for the trade test
 * @param {object}   [deps.report]         a rules report already read (skips step 1's network work)
 * @param {{ml?, llm?}} [deps.hooks]       default: agent/hooks.js registry
 * @param {object}   [deps.timeouts]       per step, ms
 * @param {object}   [deps.graphOptions]   passed to buildFlowGraph
 * @param {string}   [deps.simSeed]
 * @param {(step, status) => void} [deps.onStep]
 * @param {() => number} [deps.now]
 */
export async function investigate(target, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const read = deps.readContract ?? readContract;
  const simulate = deps.simulateTrade ?? simulateTrade;
  const graphOf = deps.buildGraph ?? buildFlowGraph;
  const hooks = { ...getHooks(), ...(deps.hooks ?? {}) };
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(deps.timeouts ?? {}) };
  const onStep = deps.onStep ?? (() => {});
  const chainCfg = target.chainConfig ?? CHAINS[target.chain];
  if (!chainCfg) throw new Error(`unknown chain: ${target.chain}`);
  const ctx = {};
  const steps = [];
  const started = now();

  async function step(name, applicable, fn) {
    const t0 = now();
    if (!applicable) { steps.push({ name, status: 'skipped', ms: 0 }); onStep(name, 'skipped'); return; }
    onStep(name, 'running');
    try {
      ctx[name] = await withTimeout(fn, timeouts[name], name);
      steps.push({ name, status: 'ok', ms: now() - t0 });
      onStep(name, 'ok');
    } catch (e) {
      const status = e?.timeout ? 'timeout' : 'failed';
      steps.push({ name, status, ms: now() - t0, error: plain(e?.message ?? e, 200) });
      onStep(name, status);
    }
  }

  // 1. rules
  await step('rules', true, async () => deps.report ?? read(target.chain, target.address, {
    simulate: false, sourcify: false, ...(target.chainConfig ? { chainConfig: target.chainConfig } : {}), ...(deps.readOptions ?? {}),
  }));
  // 2. honeypot: EVM tokens on a chain with a known DEX, unless the rules found an official token
  const dex = target.dex ?? chainCfg.dex;
  const isEvm = chainCfg.kind === 'evm' || (!chainCfg.kind && /^0x[0-9a-fA-F]{40}$/.test(target.address));
  const findings = ctx.rules?.analysis?.findings ?? [];
  const official = findings.some((f) => f.id === 'known-issuer');
  const noCode = findings.some((f) => f.id === 'no-code');
  const notToken = noCode || findings.some((f) => f.id === 'not-erc20');
  await step('honeypot', isEvm && !!dex && !official && !notToken, async () => {
    const rpc = deps.rpcFor ? deps.rpcFor(chainCfg) : createRpc(chainCfg.rpcs, chainCfg.id);
    return simulate(rpc, dex, target.address.toLowerCase(), { seed: deps.simSeed });
  });
  // 3. graph
  await step('graph', !noCode && (!!deps.buildGraph || graphSupported(target.chain)), () => graphOf(target.chain, target.address, { ...(deps.graphOptions ?? {}) }));
  // 4. ml (optional)
  await step('ml', !!hooks.ml, async () => {
    const out = await hooks.ml.score(featuresOf(ctx));
    const score = typeof out === 'number' ? out : out?.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error('ml hook returned no score in [0, 1]');
    return { score, model: plain(out?.model ?? '', 60) || null, version: plain(out?.version ?? '', 30) || null };
  });
  // 5. llm (optional, advisory text only)
  await step('llm', !!hooks.llm, async () => {
    const out = await hooks.llm.review(contextOf(ctx, target));
    const summary = plain(out?.summary ?? '', 1000);
    if (!summary) throw new Error('llm hook returned no summary');
    return { summary, model: plain(out?.model ?? '', 60) || null };
  });

  return finalReport(target, ctx, steps, { hooks, started, now });
}

/** The final report from the steps' outputs (exported for tests). */
export async function finalReport(target, ctx, steps, { hooks = {}, started = 0, now = () => Date.now() } = {}) {
  const signals = [];
  const rulesFindings = ctx.rules?.analysis?.findings ?? [];
  for (const f of rulesFindings) signals.push({ source: 'rules', id: f.id, severity: f.severity, params: f.params ?? {} });
  const sim = ctx.honeypot ?? null;
  const simF = simFindings(sim);
  for (const f of simF) signals.push({ source: 'honeypot', id: f.id, severity: f.severity, params: f.params ?? {} });
  for (const s of ctx.graph?.signals ?? []) signals.push({ source: 'graph', ...s });

  let level = maxLevel(ctx.rules?.analysis?.level, ...simF.map((f) => f.severity), ctx.graph ? graphLevel(ctx.graph.signals) : null);
  if (ctx.ml && ctx.ml.score >= ML_ADVISORY_AT) {
    signals.push({ source: 'ml', id: 'ml-high-score', severity: RANK[level] < RANK.medium ? 'medium' : 'info', params: { score: ctx.ml.score, model: ctx.ml.model } });
    if (RANK[level] < RANK.medium) level = 'medium';
  }
  const highs = signals.filter((s) => s.severity === 'high').length;
  const mediums = signals.filter((s) => s.severity === 'medium').length;
  const score = Math.min(100, BASE_SCORE[level] + (RANK[level] >= RANK.high ? Math.min(20, (highs - 1) * 5) : 0) + (RANK[level] === RANK.medium ? Math.min(15, (mediums - 1) * 5) : 0));

  const status = Object.fromEntries(steps.map((s) => [s.name, s.status]));
  let total = WEIGHT.rules + WEIGHT.honeypot + WEIGHT.graph;
  let got = 0;
  if (status.rules === 'ok') got += WEIGHT.rules;
  if (status.honeypot === 'ok' && sim && !['no-override', 'error'].includes(sim.stage)) got += WEIGHT.honeypot;
  else if (status.honeypot === 'skipped' && ctx.rules) total -= WEIGHT.honeypot; // not applicable (no pool / not EVM / official token)
  if (status.graph === 'ok') got += ctx.graph?.partial ? WEIGHT.graph / 2 : WEIGHT.graph;
  for (const h of ['ml', 'llm']) if (hooks[h]) { total += WEIGHT[h]; if (status[h] === 'ok') got += WEIGHT[h]; }
  const confidence = total > 0 ? Math.round((got / total) * 100) / 100 : 0;

  const report = {
    kind: 'neuro-investigation', version: AGENT_VERSION,
    target: { chain: target.chain, address: target.address.toLowerCase?.() ?? target.address },
    level: ctx.rules || ctx.graph ? level : 'unknown', score, confidence,
    signals, steps,
    rules: ctx.rules ? { level: ctx.rules.analysis?.level, reportHash: ctx.rules.reportHash ?? null } : null,
    honeypot: sim ? { stage: sim.stage, dex: sim.dex ?? null, pair: sim.pair ?? null, buyTax: sim.buyTax ?? null, sellTax: sim.sellTax ?? null } : null,
    graph: ctx.graph ?? null,
    ml: ctx.ml ?? null,
    review: ctx.llm ?? null, // advisory text from the llm hook: shown as such, never part of the level
    at: new Date(now()).toISOString(), ms: now() - started,
  };
  report.reportHash = await sha256Hex(canonical({
    v: AGENT_VERSION, target: report.target, level: report.level,
    signals: signals.map((s) => ({ source: s.source, id: s.id, severity: s.severity, evidence: s.evidence ?? null })),
    steps: steps.map((s) => [s.name, s.status]),
  }));
  return report;
}

/** Levels in order of seriousness (exported for the watch list / alerts). */
export const levelRank = (l) => (l === 'unknown' ? -1 : RANK[l] ?? 0);
