// Shared setup for the DEX unit tests: an in-memory chain (helpers/evm.js) with
// WZETAPHY, the factory, the router and a few test tokens.

import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { createChain, ZETA } from './evm.js';

export { ZETA };
export const ART_DIR = new URL('../../artifacts/', import.meta.url);
const NAMES = ['ZetaphyFactory', 'ZetaphyPair', 'ZetaphyRouter', 'WZETAPHY', 'TestToken', 'FlashBorrower', 'ReentrantToken', 'MockRunners', 'RevertProbe', 'GasHogRegistry', 'ForceSend'];
const raw = Object.fromEntries(NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`${n}.json`, ART_DIR), 'utf8'))]));
raw.ThreatRegistry = JSON.parse(readFileSync(new URL('../../../zetaphy-network/artifacts/ThreatRegistry.json', import.meta.url), 'utf8'));

// Every contract's errors in every interface, so an error bubbling up from a
// pair through the router (e.g. K) is reported by name.
const allErrors = [];
for (const a of Object.values(raw)) for (const e of a.abi) if (e.type === 'error' && !allErrors.some((x) => x.name === e.name)) allErrors.push(e);
export function art(name) {
  const a = raw[name];
  return { abi: [...a.abi.filter((e) => e.type !== 'error'), ...allErrors], bytecode: a.bytecode, deployedBytecode: a.deployedBytecode };
}

export const ONE = 10n ** 18n;
export const sqrt = (y) => { if (y < 4n) return y === 0n ? 0n : 1n; let z = y, x = y / 2n + 1n; while (x < z) { z = x; x = (y / x + x) / 2n; } return z; };
export const amountOut = (ain, rin, rout) => (ain * 997n * rout) / (rin * 1000n + ain * 997n);
export const amountIn = (aout, rin, rout) => (rin * aout * 1000n) / ((rout - aout) * 997n) + 1n;

export async function setupDex(extra = []) {
  const c = await createChain(['gov', 'alice', 'bob', 'carol', 'feeTo', 'w1', 'w2', 'w3', ...extra]);
  const addr = (n) => c.acct[n].toString();
  const weth = await c.deployRaw(art('WZETAPHY'), [], 'gov');
  const factory = await c.deployRaw(art('ZetaphyFactory'), [addr('gov')], 'gov');
  const router = await c.deployRaw(art('ZetaphyRouter'), [factory.address, weth.address], 'gov');
  const token = (name, sym, fee = 0) => c.deployRaw(art('TestToken'), [name, sym, 18, 10_000_000n * ONE, fee], 'alice');
  const A = await token('Token A', 'TKA');
  const B = await token('Token B', 'TKB');
  const C = await token('Token C', 'TKC');
  const pairAt = (address) => ({ ...wrap(c, address, art('ZetaphyPair')), address });
  const deadline = () => c.now() + 600n;
  for (const t of [A, B, C]) {
    await t.send('alice', 'approve', [router.address, 2n ** 256n - 1n]);
    await t.send('alice', 'transfer', [addr('bob'), 1_000_000n * ONE]);
    await t.send('bob', 'approve', [router.address, 2n ** 256n - 1n]);
  }
  return { c, addr, weth, factory, router, A, B, C, token, pairAt, deadline };
}

/** send/call on an address the test did not deploy itself (e.g. a pair made by the factory). */
export function wrap(c, address, a) {
  const iface = new Interface(a.abi);
  return {
    send: (from, fn, args = [], value = 0n) => c.sendTo(from, address, iface, fn, args, value),
    call: (fn, args = []) => c.callAt(address, iface, fn, args),
  };
}

/** Pair reserves as [r0, r1]. */
export async function reserves(pair) {
  const r = await pair.call('getReserves');
  return [r[0], r[1]];
}
