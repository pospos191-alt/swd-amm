// The red team's engine (docs/future/red-team.md): attack PLANS, their compilation into an exploit bundle
// (src/redteam/exploit.js), evaluation on a fork (src/redteam/fork.js) and minimization.
//
// A plan is what a strategy proposes:
//   { strategy, title, steps: [ { eoa: { to, data, value } }
//                              | { contract: { calls: [Call], value, callback?: { calls: [Call], times, ret } } } ] }
//   Call = { to, data, value?, balanceOf?, patchAt? } (RedTeamAttacker.Call: patch one word with a live balance)
// A plan that uses the attack contract deploys it first (the bundle's first transaction) and sweeps what it holds
// back to the attacker last. Everything is deterministic: the same fork, plan and attacker give the same bundle.
import { readFileSync } from 'node:fs';
import { Interface, getCreateAddress, getAddress, MaxUint256 } from 'ethers';
import { BUNDLE_KIND, runBundle, checkBundle } from './exploit.js';

export const ATTACKER = JSON.parse(readFileSync(new URL('./attacker.json', import.meta.url), 'utf8'));
export const ATTACKER_IFACE = new Interface(ATTACKER.abi);
export const NATIVE = '0x0000000000000000000000000000000000000000';
/** The attacker EOA the red team uses on a fork when no submitter is given (no key: a fork needs none). */
export const DEFAULT_ATTACKER = '0x00000000000000000000000000000000000a77a1';
export const DEFAULT_FUNDING = 1000n * 10n ** 18n;
const lower = (a) => getAddress(a).toLowerCase();

const callTuple = (c) => [lower(c.to), BigInt(c.value ?? 0), c.data ?? '0x', c.balanceOf ? lower(c.balanceOf) : NATIVE, Number(c.patchAt ?? 0)];

/** The attack contract's address on this fork for this attacker (it is always the bundle's first transaction). */
export async function attackerContractOf(world, attacker) {
  return getCreateAddress({ from: getAddress(attacker), nonce: await world.nonce(attacker) }).toLowerCase();
}

/** Compiles a plan into an exploit bundle (exploit.js) for `ctx` ({ world, attacker, funding, sweep }). */
export function compilePlan(plan, ctx) {
  const usesContract = plan.steps.some((s) => s.contract);
  const txs = [];
  if (usesContract) txs.push({ to: null, data: ATTACKER.bytecode, value: '0' });
  for (const s of plan.steps) {
    if (s.eoa) { txs.push({ to: s.eoa.to, data: s.eoa.data, value: String(s.eoa.value ?? 0) }); continue; }
    const c = s.contract;
    if (c.callback) txs.push({ to: ctx.attackerContract, data: ATTACKER_IFACE.encodeFunctionData('arm', [c.callback.calls.map(callTuple), BigInt(c.callback.times ?? 1), c.callback.ret ?? '0x']), value: '0' });
    txs.push({ to: ctx.attackerContract, data: ATTACKER_IFACE.encodeFunctionData('run', [c.calls.map(callTuple)]), value: String(c.value ?? 0) });
  }
  if (usesContract) txs.push({ to: ctx.attackerContract, data: ATTACKER_IFACE.encodeFunctionData('sweep', [ctx.sweep ?? []]), value: '0' });
  return checkBundle({ kind: BUNDLE_KIND, v: 1, chainId: ctx.world.chainId, target: ctx.target.address, forkBlock: ctx.world.forkBlock,
    attacker: ctx.attacker, funding: String(ctx.funding), txs });
}

/** Did a run show an exploit? loss >= minLoss on the target's asset, or a suite invariant broken. */
export function successOf(run, ctx) {
  const minLoss = BigInt(ctx.target.minLoss ?? 1n);
  if (run.loss >= minLoss && run.loss > 0n) return { kind: 'loss', loss: run.loss };
  if (run.broken.length) return { kind: 'invariant', invariant: run.broken[0], loss: run.loss };
  return null;
}

/** Runs a plan on the fork: { bundle, run, success }. */
export async function evaluate(plan, ctx) {
  const bundle = compilePlan(plan, ctx);
  const run = await runBundle(ctx.world, bundle, { asset: ctx.target.asset ?? NATIVE, suite: ctx.target.suite ?? null, tokens: ctx.sweep ?? [] });
  ctx.stats.runs += 1;
  return { bundle, run, success: successOf(run, ctx) };
}

/** Shrinks a successful plan: drops steps and contract calls while the result stays at least as bad. */
export async function minimize(plan, first, ctx) {
  const still = (r) => r.success && r.success.kind === first.success.kind && (first.success.kind === 'invariant' ? r.success.invariant === first.success.invariant : r.run.loss >= first.run.loss);
  let best = plan, bestR = first;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < best.steps.length && best.steps.length > 1; i++) {
      const p = { ...best, steps: best.steps.filter((_, j) => j !== i) };
      const r = await evaluate(p, ctx);
      if (still(r)) { best = p; bestR = r; changed = true; break; }
    }
    if (changed) continue;
    for (let i = 0; i < best.steps.length && !changed; i++) {
      const c = best.steps[i].contract;
      if (!c || c.calls.length < 2) continue;
      for (let j = 0; j < c.calls.length; j++) {
        const steps = best.steps.map((s, k) => (k === i ? { contract: { ...c, calls: c.calls.filter((_, m) => m !== j) } } : s));
        const r = await evaluate({ ...best, steps }, ctx);
        if (still(r)) { best = { ...best, steps }; bestR = r; changed = true; break; }
      }
    }
  }
  return { plan: best, result: bestR };
}

/** Builds the context every strategy gets. target: { address, abi, asset?, tokens?, env?, history?, suite?, minLoss? }. */
export async function makeContext(world, target, { attacker = DEFAULT_ATTACKER, funding = DEFAULT_FUNDING } = {}) {
  const iface = target.abi instanceof Interface ? target.abi : new Interface(target.abi);
  const t = { ...target, address: lower(target.address), iface, asset: target.asset ? lower(target.asset) : NATIVE };
  const sweep = [...new Set([...(t.asset !== NATIVE ? [t.asset] : []), ...(target.tokens ?? []).map(lower),
    ...(target.env?.pairs ?? []).flatMap((p) => [lower(p.token0), lower(p.token1)])])];
  return {
    world, target: t, attacker: lower(attacker), funding: BigInt(funding), sweep,
    attackerContract: await attackerContractOf(world, attacker),
    stats: { runs: 0 },
    MaxUint256,
  };
}
