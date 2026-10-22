// Shared setup for the DLMM unit tests (UNAUDITED contracts in
// contracts/dlmm/): an in-memory chain (helpers/evm.js) with WZETAPHY, the
// DLMM factory and router, presets and a few test tokens.

import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { createChain, ZETA } from './evm.js';

export { ZETA };
export const ONE = 10n ** 18n;
export const MAX = 2n ** 256n - 1n;
export const Q128 = 1n << 128n;
const NAMES = ['ZetaphyDlmmFactory', 'ZetaphyDlmmPair', 'ZetaphyDlmmRouter', 'ZetaphyDlmmPairDeployer', 'WZETAPHY', 'TestToken',
  'DlmmMathHarness', 'DlmmReentrantToken', 'DlmmRebaseToken', 'MockRunners', 'GasHogRegistry'];
const ART_DIR = new URL('../../artifacts/', import.meta.url);
const raw = Object.fromEntries(NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`${n}.json`, ART_DIR), 'utf8'))]));
raw.ThreatRegistry = JSON.parse(readFileSync(new URL('../../../zetaphy-network/artifacts/ThreatRegistry.json', import.meta.url), 'utf8'));

// Every contract's errors in every interface, so an error bubbling up from the
// pair through the router is reported by name.
const allErrors = [];
for (const a of Object.values(raw)) for (const e of a.abi) if (e.type === 'error' && !allErrors.some((x) => x.name === e.name)) allErrors.push(e);
export function art(name) {
  const a = raw[name];
  return { abi: [...a.abi.filter((e) => e.type !== 'error'), ...allErrors], bytecode: a.bytecode, deployedBytecode: a.deployedBytecode };
}

/** Presets used by the tests: bin step -> preset (bps). */
export const PRESETS = {
  1: { baseFeeBps: 1, maxDynamicFeeBps: 0, variableFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, maxVolatilityAccumulator: 0, enabled: true },
  10: { baseFeeBps: 10, maxDynamicFeeBps: 0, variableFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, maxVolatilityAccumulator: 0, enabled: true },
  // with the volatility fee: 0.25% base, up to +1%
  25: { baseFeeBps: 25, maxDynamicFeeBps: 100, variableFeeControl: 2_000, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5_000, maxVolatilityAccumulator: 100_000, enabled: true },
  100: { baseFeeBps: 100, maxDynamicFeeBps: 0, variableFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, maxVolatilityAccumulator: 0, enabled: true },
};
const tuple = (p) => [p.baseFeeBps, p.maxDynamicFeeBps, p.variableFeeControl, p.filterPeriod, p.decayPeriod, p.reductionFactor, p.maxVolatilityAccumulator, p.enabled];
export const presetTuple = tuple;

export async function setupDlmm(extra = []) {
  const c = await createChain(['gov', 'alice', 'bob', 'carol', 'feeTo', 'w1', 'w2', 'w3', 'mallory', ...extra]);
  const addr = (n) => c.acct[n].toString();
  const weth = await c.deployRaw(art('WZETAPHY'), [], 'gov');
  const factory = await c.deployRaw(art('ZetaphyDlmmFactory'), [addr('gov')], 'gov');
  const router = await c.deployRaw(art('ZetaphyDlmmRouter'), [factory.address, weth.address], 'gov');
  for (const [step, p] of Object.entries(PRESETS)) await factory.send('gov', 'setPreset', [Number(step), tuple(p)]);
  const token = (name, sym, fee = 0, supply = 10n ** 12n * ONE) => c.deployRaw(art('TestToken'), [name, sym, 18, supply, fee], 'alice');
  // Sorted so that X < Y (X is the lower address).
  const t1 = await token('Token A', 'TKA');
  const t2 = await token('Token B', 'TKB');
  const [X, Y] = BigInt(t1.address) < BigInt(t2.address) ? [t1, t2] : [t2, t1];
  const Z = await token('Token C', 'TKC');
  const pairAt = (address) => ({ ...wrap(c, address, art('ZetaphyDlmmPair')), address });
  const deadline = () => c.now() + 600n;
  for (const t of [X, Y, Z]) {
    await t.send('alice', 'approve', [router.address, MAX]);
    for (const w of ['bob', 'carol', 'mallory']) {
      await t.send('alice', 'transfer', [addr(w), 10n ** 9n * ONE]);
      await t.send(w, 'approve', [router.address, MAX]);
    }
  }
  return { c, addr, weth, factory, router, X, Y, Z, token, pairAt, deadline };
}

/** send/call on an address the test did not deploy itself (e.g. a pair made by the factory). */
export function wrap(c, address, a) {
  const iface = new Interface(a.abi);
  return {
    iface,
    send: (from, fn, args = [], value = 0n) => c.sendTo(from, address, iface, fn, args, value),
    call: (fn, args = []) => c.callAt(address, iface, fn, args),
  };
}

/** Liquidity params for router.addLiquidity (a tuple in ABI order). */
export function lp({ X, Y, binStep, activeId, slip = 0, deltas, ax, ay, minX = 0n, minY = 0n, to, deadline }) {
  return [X.address ?? X, Y.address ?? Y, binStep, activeId, slip, deltas, ax, ay, minX, minY, to, deadline];
}

/**
 * A spot-like distribution around the active bin: `n` bins of X above (and
 * the active bin's X half), `n` bins of Y below (and its Y half), `perBin` each.
 */
export function spot(n, perBin) {
  const deltas = [];
  const ax = [];
  const ay = [];
  for (let d = -n; d <= n; d++) {
    deltas.push(d);
    ax.push(d > 0 ? perBin : d === 0 ? perBin / 2n : 0n);
    ay.push(d < 0 ? perBin : d === 0 ? perBin / 2n : 0n);
  }
  return { deltas, ax, ay };
}

/** Creates the X/Y pair at `activeId` and adds `spot(n, perBin)` from alice. */
export async function seededPair(d, { binStep = 10, activeId = 0, n = 5, perBin = 100n * ONE } = {}) {
  const { router, factory, X, Y, addr, deadline, pairAt } = d;
  const s = spot(n, perBin);
  await router.send('alice', 'addLiquidity', [lp({ X, Y, binStep, activeId, deltas: s.deltas, ax: s.ax, ay: s.ay, to: addr('alice'), deadline: deadline() })]);
  return pairAt(await factory.call('getPair', [X.address, Y.address, binStep]));
}

export const path = (steps, tokens) => [steps, tokens.map((t) => t.address ?? t)];

/** Every bin with liquidity, from the pair's bitmap (walks up from the lowest). */
export async function liveBins(pair, from = -(1 << 23) + 1) {
  const out = [];
  let [id, found] = await pair.call('getNextNonEmptyBin', [false, from - 1]);
  while (found) {
    const [x, y] = await pair.call('getBin', [id]);
    out.push({ id: Number(id), x, y, supply: await pair.call('totalSupply', [id]) });
    [id, found] = await pair.call('getNextNonEmptyBin', [false, id]);
  }
  return out;
}

export const ceilDiv = (a, b) => (a + b - 1n) / b;

/** The pair's per-bin math in BigInt (same rounding), for exact expectations. */
export function binSwapJS(binOut, price, feeBps, amountIn, swapForY) {
  const netNeeded = swapForY ? ceilDiv(binOut << 128n, price) : ceilDiv(binOut * price, Q128);
  const grossNeeded = ceilDiv(netNeeded * 10_000n, 10_000n - feeBps);
  if (amountIn >= grossNeeded) return { inUsed: grossNeeded, out: binOut, fee: grossNeeded - netNeeded };
  const fee = ceilDiv(amountIn * feeBps, 10_000n);
  const net = amountIn - fee;
  const out = swapForY ? (net * price) / Q128 : (net << 128n) / price;
  return { inUsed: amountIn, out, fee };
}
