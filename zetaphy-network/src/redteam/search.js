// The red team's search over call sequences (docs/future/red-team.md): seeded random sequences of the target's
// functions (1..maxSteps steps, from the attacker EOA or through the attack contract, optionally re-entering from
// the contract's callback), with arguments from the dictionary (src/redteam/strategies.js), mutated from a corpus
// of sequences that got further (more successful calls, any loss). The same seed, fork and options give the same
// run, so a finding is reproducible.
import { mutating, argTuples, amountsOf } from './strategies.js';
import { evaluate } from './engine.js';

/** xorshift128+ seeded from a number: deterministic, fast. */
export function rng(seed = 1) {
  let a = BigInt(seed) * 0x9e3779b97f4a7c15n & 0xffffffffffffffffn || 1n, b = a ^ 0xdeadbeefcafebaben;
  const next = () => {
    let x = a, y = b;
    a = y; x ^= (x << 23n) & 0xffffffffffffffffn; x ^= x >> 17n; x ^= y ^ (y >> 26n); b = x;
    return (a + b) & 0xffffffffffffffffn;
  };
  return { int: (n) => Number(next() % BigInt(n)), pick: (arr) => arr[Number(next() % BigInt(arr.length))], bool: () => (next() & 1n) === 1n };
}

function randomStep(r, ctx, fns, amounts) {
  const f = r.pick(fns);
  const viaContract = r.bool();
  const who = viaContract ? ctx.attackerContract : ctx.attacker;
  const tuples = argTuples(f, ctx, who, amounts, 12);
  if (!tuples.length) return null;
  const args = r.pick(tuples);
  const small = amounts.filter((a) => a > 0n && a <= ctx.funding / 4n);
  const value = f.stateMutability === 'payable' && small.length ? r.pick(small) : 0n;
  const call = { to: ctx.target.address, data: ctx.target.iface.encodeFunctionData(f, args), value };
  if (!viaContract) return { eoa: call };
  const step = { contract: { value, calls: [call] } };
  const plain = fns.filter((x) => x.stateMutability !== 'payable');
  if (plain.length && r.int(3) === 0) {
    const g = r.pick(plain);
    const ga = g && argTuples(g, ctx, ctx.attackerContract, amounts, 12);
    if (ga?.length) step.contract.callback = { calls: [{ to: ctx.target.address, data: ctx.target.iface.encodeFunctionData(g, r.pick(ga)) }], times: 1 + r.int(7), ret: '0x' };
  }
  return step;
}

/**
 * Searches up to `runs` sequences; returns the first success (with stopOnFirst) as { plan, result }, else null.
 * onRun(i, result) is called after each sequence.
 */
export async function search(ctx, { seed = 1, runs = 500, maxSteps = 4, onRun = () => {} } = {}) {
  const r = rng(seed);
  const fns = mutating(ctx.target.iface);
  if (!fns.length) return null;
  const amounts = await amountsOf(ctx);
  const corpus = [];
  for (let i = 0; i < runs; i++) {
    let steps;
    if (corpus.length && r.int(3) > 0) {
      const base = r.pick(corpus).steps.slice();
      const op = r.int(3);
      if (op === 0 && base.length < maxSteps) base.splice(r.int(base.length + 1), 0, randomStep(r, ctx, fns, amounts));
      else if (op === 1 && base.length > 1) base.splice(r.int(base.length), 1);
      else base[r.int(base.length)] = randomStep(r, ctx, fns, amounts);
      steps = base.filter(Boolean);
    } else {
      steps = Array.from({ length: 1 + r.int(maxSteps) }, () => randomStep(r, ctx, fns, amounts)).filter(Boolean);
    }
    if (!steps.length) continue;
    const plan = { strategy: 'search', title: `random sequence (seed ${seed}, run ${i})`, steps };
    const res = await evaluate(plan, ctx);
    onRun(i, res);
    if (res.success) return { plan, result: res };
    const okCount = res.run.txs.filter((t) => t.ok).length;
    if (okCount === res.run.txs.length && corpus.length < 64) corpus.push(plan);
  }
  return null;
}
