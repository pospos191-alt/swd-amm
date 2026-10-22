// Neuro on the DLMM router (contracts/dlmm/, UNAUDITED), the same rules as
// the constant-product router (test/neuro.test.js): with
// dlmmFactory.threatRegistry set by governance (zero = off), the router
// refuses to swap into, or add liquidity with, a token whose flag is ENFORCED
// in the real ThreatRegistry; it fails closed when the registry does not
// answer; selling and removing liquidity always work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { setupDlmm, seededPair, lp, spot, path, art, ONE, MAX } from './helpers/dlmm.js';

const ZERO = '0x' + '00'.repeat(20);
const UNLIMITED_MINT = 2; // ThreatRegistry.Reason.UnlimitedMint
const EVIDENCE = ['0x' + 'e7'.repeat(32), 'neuro:report'];
const HOUR = 3600;

async function setup() {
  const d = await setupDlmm();
  const { c, addr, router, X, Y, Z, deadline } = d;
  const runners = await c.deployRaw(art('MockRunners'), [], 'gov');
  for (const w of ['w1', 'w2', 'w3']) await runners.send('gov', 'set', [addr(w), true]);
  const reg = await c.deployRaw(art('ThreatRegistry'), [runners.address, 2, 1, addr('gov'), HOUR], 'gov');
  const pXY = await seededPair(d, { n: 3, perBin: 100n * ONE });
  const [a, b] = BigInt(Y.address) < BigInt(Z.address) ? [Y, Z] : [Z, Y];
  const s = spot(3, 100n * ONE);
  await router.send('alice', 'addLiquidity', [lp({ X: a, Y: b, binStep: 10, activeId: 0, ...s, to: addr('alice'), deadline: deadline() })]);
  const flag = async (key) => { for (const w of ['w1', 'w2']) await reg.send(w, 'vote', [key, true, UNLIMITED_MINT, ...EVIDENCE]); };
  return { ...d, reg, flag, pXY };
}

test('governance sets the DLMM registry; a non-registry is refused; zero switches it off', async () => {
  const { factory, reg, addr } = await setup();
  assert.equal(await factory.call('threatRegistry'), ZERO);
  await assert.rejects(factory.send('alice', 'setThreatRegistry', [reg.address]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setThreatRegistry', [addr('bob')]), /NotARegistry/);
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  assert.equal(await factory.call('threatRegistry'), ZERO);
});

test('an enforced flag: buying the token and adding liquidity with it are refused (TokenEnforced); selling it and removing liquidity work', async () => {
  const { factory, reg, flag, router, X, Y, Z, addr, deadline, c, pXY } = await setup();
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  await flag(await reg.call('addressKey', [1n, Y.address]));
  // Flagged but not enforced yet: allowed (the web app warns).
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
  c.advance(HOUR);
  const refused = /TokenEnforced/;
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [ONE, MAX, path([10], [X, Y]), addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10, 10], [X, Y, Z]), addr('bob'), deadline()]), refused, 'through it (multi-hop)');
  const s = spot(1, ONE);
  await assert.rejects(router.send('bob', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, ...s, to: addr('bob'), deadline: deadline() })]), refused);
  const err = await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]).catch((e) => e);
  const parsed = new Interface(art('ZetaphyDlmmRouter').abi).parseError(err.data);
  assert.equal(parsed.args[0].toLowerCase(), Y.address.toLowerCase());
  assert.equal(parsed.args[1], BigInt(UNLIMITED_MINT));
  // Holders are not locked in.
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [Y, X]), addr('bob'), deadline()]);
  await pXY.send('alice', 'setApprovalForAll', [router.address, true]);
  const sh = await pXY.call('balanceOf', [addr('alice'), 1]);
  await router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, [1], [sh / 2n], 0, 0, addr('alice'), deadline()]);
  // Off again: everything goes through.
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
});

test('a registry that stops answering in time: swaps into a token and adds fail closed (RegistryUnavailable); removing still works', async () => {
  const { factory, router, X, Y, addr, deadline, c, pXY } = await setup();
  const hog = await c.deployRaw(art('GasHogRegistry'), [], 'gov');
  await factory.send('gov', 'setThreatRegistry', [hog.address]);
  await hog.send('gov', 'setBurn', [150_000n]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]), /RegistryUnavailable/);
  const s = spot(1, ONE);
  await assert.rejects(router.send('bob', 'addLiquidity', [lp({ X, Y, binStep: 10, activeId: 0, ...s, to: addr('bob'), deadline: deadline() })]), /RegistryUnavailable/);
  await pXY.send('alice', 'setApprovalForAll', [router.address, true]);
  const sh = await pXY.call('balanceOf', [addr('alice'), 1]);
  await router.send('alice', 'removeLiquidity', [X.address, Y.address, 10, [1], [sh / 2n], 0, 0, addr('alice'), deadline()]);
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, path([10], [X, Y]), addr('bob'), deadline()]);
});
