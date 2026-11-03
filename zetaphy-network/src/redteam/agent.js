// SS3, the AI red team (docs/future/red-team.md): an agent that keeps attacking certified contracts on a LOCAL
// fork and, when an attack works, builds the S1 ExploitMarket submission for it.
//
//   redTeam(world, target, opts)   one pass over one target: every strategy of the library (strategies.js), the
//                                  optional LLM's proposals, then the seeded search (search.js). Each success is
//                                  minimized (engine.js) and returned as a finding with its exploit bundle.
//   llmPlans(ctx, settings)        OPTIONAL: asks a model (a local Ollama by default, or any provider of
//                                  zetaphy-neuro/ai/providers.js) for plans in a small JSON language; every plan is
//                                  checked against the ABI and run on the fork like any other. Without a model
//                                  configured nothing changes: the deterministic strategies and the search run alone.
//   submissionOf(finding, …)       the ExploitMarket.submit arguments and the bundle to hand to the runners.
//   certifiedTargets(provider, …)  the targets: every contract with a valid AuditCertificate on this chain.
// Nothing here sends a transaction to a chain: the fork is local, and `zetaphy redteam submit` (src/redteamcli.js)
// is a separate, explicit step.
import { readFileSync, readdirSync } from 'node:fs';
import { Interface, Contract, keccak256, getAddress, ZeroHash } from 'ethers';
import { STRATEGIES, mutating } from './strategies.js';
import { makeContext, evaluate, minimize } from './engine.js';
import { search } from './search.js';
import { bundleHash, invariantKey } from './exploit.js';

const lower = (a) => getAddress(a).toLowerCase();

/**
 * One pass of the red team over one target on a fork.
 * @returns {{ findings: object[], stats: { runs: number, plans: Record<string, number> } }}
 */
export async function redTeam(world, target, { strategies = STRATEGIES, seed = 1, runs = 300, attacker, funding, llm = null, maxPlans = 800, log = () => {} } = {}) {
  const ctx = await makeContext(world, target, { ...(attacker ? { attacker } : {}), ...(funding != null ? { funding } : {}) });
  const findings = [];
  const plans = {};
  const record = async (plan, res) => {
    const m = await minimize(plan, res, ctx);
    const f = findingOf(m.plan, m.result, ctx);
    findings.push(f);
    log(`  FOUND (${f.strategy}): ${f.title}: ${f.kind === 'loss' ? `loss ${f.loss} of ${f.asset}` : `invariant ${f.invariant} broken`}`);
  };
  // each strategy: every plan (up to maxPlans), keeping the worst damage found (an invariant break, or the
  // largest loss; it stops early once the whole balance is gone)
  const all = await ctx.world.balance(ctx.target.address);
  for (const s of strategies) {
    let n = 0, best = null;
    for await (const plan of s.plans(ctx)) {
      if (++n > maxPlans) break;
      const res = await evaluate(plan, ctx);
      if (!res.success) continue;
      if (!best || res.run.loss > best.res.run.loss) best = { plan, res };
      if (res.success.kind === 'invariant' || (ctx.target.asset === '0x0000000000000000000000000000000000000000' && res.run.loss >= all)) break;
    }
    if (best) await record(best.plan, best.res);
    plans[s.id] = n;
    log(`  ${s.id}: ${n} plan(s) tried${findings.some((f) => f.strategy === s.id) ? ', found' : ''}`);
  }
  if (llm) {
    let proposed = [];
    try { proposed = await llmPlans(ctx, llm); } catch (e) { log(`  llm: skipped (${e.message})`); }
    plans.llm = proposed.length;
    for (const plan of proposed) {
      const res = await evaluate(plan, ctx);
      if (res.success) { await record(plan, res); break; }
    }
  }
  if (runs > 0) {
    const hit = await search(ctx, { seed, runs });
    plans.search = runs;
    if (hit) await record(hit.plan, hit.result);
  }
  return { findings, stats: { runs: ctx.stats.runs, plans }, ctx };
}

function findingOf(plan, res, ctx) {
  return {
    strategy: plan.strategy, title: plan.title, kind: res.success.kind,
    loss: res.run.loss.toString(), asset: ctx.target.asset, invariant: res.success.invariant ?? null,
    attackerGain: Object.fromEntries(Object.entries(res.run.attackerGain).map(([k, v]) => [k, v.toString()])),
    target: ctx.target.address, chainId: ctx.world.chainId, forkBlock: ctx.world.forkBlock,
    bundle: res.bundle, bundleHash: bundleHash(res.bundle), plan,
  };
}

/** ExploitMarket.submit(listing, forkBlock, bundleHash, invariant, claimedLoss) for a finding. */
export function submissionOf(finding, { listing }) {
  const invariant = finding.kind === 'invariant' ? invariantKey(finding.invariant) : ZeroHash;
  return {
    listing: String(listing), forkBlock: String(finding.forkBlock), bundleHash: finding.bundleHash, invariant,
    claimedLoss: finding.kind === 'loss' ? finding.loss : '0', bundle: finding.bundle,
  };
}

// ------------------------------------------------------------------------------------------- the optional LLM

const LLM_SYSTEM = `You are a smart-contract security tester working ONLY on a local fork of a testnet (no real money).
Propose attack sequences against the target contract as JSON: {"plans":[{"title":"…","steps":[{"via":"eoa"|"contract",
"calls":[{"function":"<exact signature from the ABI, e.g. withdraw(uint256)>","args":["…"],"value":"<wei>"}],
"reenter":{"function":"<signature>","args":["…"],"times":<1-15>}}]}]}. Arguments may be the words ATTACKER,
ATTACKER_CONTRACT, TARGET, TARGET_BALANCE, or decimal integers. "reenter" (contract steps only) is called back every
time the target pays the attack contract. At most 10 plans. Answer with the JSON only.`;

/** Plans proposed by a model, checked against the ABI (anything else is dropped). settings: providers.js settings. */
export async function llmPlans(ctx, settings, { fetchImpl, complete } = {}) {
  const run = complete ?? (await import('../../../zetaphy-neuro/ai/providers.js')).complete;
  const iface = ctx.target.iface;
  const fns = mutating(iface).map((f) => f.format('sighash'));
  const bal = await ctx.world.balance(ctx.target.address);
  const user = JSON.stringify({ target: ctx.target.address, functions: fns, nativeBalance: bal.toString(), asset: ctx.target.asset,
    env: ctx.target.env ?? {}, hint: 'find a sequence that makes the target lose funds or breaks an invariant' });
  const { text } = await run(settings, { system: LLM_SYSTEM, user, fetchImpl, timeoutMs: 120_000 });
  const j = JSON.parse(String(text).replace(/^```(json)?|```$/g, '').trim());
  const word = (a) => ({ ATTACKER: ctx.attacker, ATTACKER_CONTRACT: ctx.attackerContract, TARGET: ctx.target.address, TARGET_BALANCE: bal.toString() }[a] ?? a);
  const callOf = (c) => {
    const f = iface.getFunction(String(c.function));
    if (!f || !fns.includes(f.format('sighash'))) throw new Error(`not a function of the target: ${c.function}`);
    return { to: ctx.target.address, data: iface.encodeFunctionData(f, (c.args ?? []).map(word)), value: BigInt(String(c.value ?? '0')) };
  };
  const out = [];
  for (const p of (j.plans ?? []).slice(0, 10)) {
    try {
      const steps = (p.steps ?? []).slice(0, 6).map((s) => {
        const calls = (s.calls ?? []).slice(0, 8).map(callOf);
        if (s.via !== 'contract') { if (calls.length !== 1) throw new Error('an eoa step is one call'); return { eoa: calls[0] }; }
        const value = calls.reduce((a, c) => a + c.value, 0n);
        const step = { contract: { value, calls } };
        if (s.reenter) step.contract.callback = { calls: [callOf(s.reenter)], times: Math.max(1, Math.min(15, Number(s.reenter.times) || 1)), ret: '0x' };
        return step;
      });
      if (steps.length) out.push({ strategy: 'llm', title: `LLM: ${String(p.title ?? 'plan').replace(/[^\x20-\x7e]/g, '').slice(0, 80)}`, steps });
    } catch { /* a plan that does not fit the ABI is dropped */ }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- targets

const CERT_ABI = ['event CertificateIssued(uint256 indexed requestId, uint64 indexed chainId, address indexed target, bytes32 codeHash, bytes32 reportHash, uint8 level, uint64 expiresAt)',
  'function isCertified(uint64 chainId, address target) view returns (bool)'];

/** Every contract on `chainId` with a valid AuditCertificate now: [{ address, codeHash, requestId }]. */
export async function certifiedTargets(provider, certificate, { chainId, fromBlock = 0 } = {}) {
  const cert = new Contract(certificate, CERT_ABI, provider);
  const logs = await cert.queryFilter(cert.filters.CertificateIssued(null, BigInt(chainId)), fromBlock);
  const seen = new Map();
  for (const l of logs) seen.set(lower(l.args.target), { address: lower(l.args.target), codeHash: l.args.codeHash, requestId: l.args.requestId.toString() });
  const out = [];
  for (const t of seen.values()) if (await cert.isCertified(BigInt(chainId), t.address)) out.push(t);
  return out;
}

/** The ABI of a contract whose runtime code matches a repo artifact (zetaphy-network or zetaphy-dex), else null. */
export async function abiFromArtifacts(world, address, dirs = [new URL('../../artifacts/', import.meta.url), new URL('../../../zetaphy-dex/artifacts/', import.meta.url)]) {
  const h = keccak256(await world.code(address));
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try {
        const a = JSON.parse(readFileSync(new URL(f, d), 'utf8'));
        if (a.deployedBytecode && keccak256(a.deployedBytecode) === h) return { name: a.contractName, abi: a.abi };
      } catch { /* not an artifact */ }
    }
  }
  return null;
}

export { Interface };
