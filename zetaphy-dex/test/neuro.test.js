// Neuro: with factory.threatRegistry set (by governance; zero = off), the
// router refuses to swap into, or add liquidity with, a token whose flag is
// ENFORCED in the real ThreatRegistry (zetaphy-network/artifacts). A flag that
// is not enforced yet only warns (the web app shows it); selling and removing
// liquidity always work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, Interface } from 'ethers';
import { bytesToHex } from '@ethereumjs/util';
import { setupDex, art, ONE } from './helpers/dex.js';

const MAX = 2n ** 256n - 1n;
const ZERO = '0x' + '00'.repeat(20);
const UNLIMITED_MINT = 2; // ThreatRegistry.Reason.UnlimitedMint
const EVIDENCE = ['0x' + 'e7'.repeat(32), 'neuro:report'];
const HOUR = 3600;

async function setup() {
  const d = await setupDex();
  const { c, addr, router, A, B, C, weth, deadline } = d;
  const runners = await c.deployRaw(art('MockRunners'), [], 'gov');
  for (const w of ['w1', 'w2', 'w3']) await runners.send('gov', 'set', [addr(w), true]);
  // quorum 2, flags enforced one hour after they are set
  const reg = await c.deployRaw(art('ThreatRegistry'), [runners.address, 2, 1, addr('gov'), HOUR], 'gov');
  await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  await router.send('alice', 'addLiquidity', [B.address, C.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  await router.send('alice', 'addLiquidityETH', [B.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  const flag = async (key) => { for (const w of ['w1', 'w2']) await reg.send(w, 'vote', [key, true, UNLIMITED_MINT, ...EVIDENCE]); };
  return { ...d, reg, flag, W: weth.address };
}

test('governance sets the registry; a typo (an address that is not a registry) is refused; zero switches it off', async () => {
  const { factory, reg, addr, weth } = await setup();
  assert.equal(await factory.call('threatRegistry'), ZERO, 'off by default');
  await assert.rejects(factory.send('alice', 'setThreatRegistry', [reg.address]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setThreatRegistry', [addr('bob')]), /NotARegistry/);
  await assert.rejects(factory.send('gov', 'setThreatRegistry', [weth.address]), /NotARegistry/);
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  assert.equal((await factory.call('threatRegistry')).toLowerCase(), reg.address.toLowerCase());
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  assert.equal(await factory.call('threatRegistry'), ZERO);
});

test('a flagged token: warned (not refused) until the flag is enforced; then swaps into it and adding liquidity are refused, selling and removing still work', async () => {
  const { factory, reg, flag, router, A, B, C, W, addr, deadline, c, pairAt } = await setup();
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  const key = await reg.call('addressKey', [1n, B.address]); // the in-memory chain's id is 1
  await flag(key);
  assert.equal((await reg.call('isContractFlagged', [B.address]))[0], true);
  assert.equal((await reg.call('isContractEnforced', [B.address]))[0], false);
  // Flagged, not enforced: the router lets it through (the UI warns).
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);

  c.advance(HOUR);
  const [enf, reason] = await reg.call('isContractEnforced', [B.address]);
  assert.equal(enf, true);
  assert.equal(reason, BigInt(UNLIMITED_MINT));
  const refused = /TokenEnforced/;
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [ONE, MAX, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address, C.address], addr('bob'), deadline()]), refused, 'through it (multi-hop) too');
  await assert.rejects(router.send('bob', 'swapExactETHForTokens', [0, [W, B.address], addr('bob'), deadline()], ONE), refused);
  await assert.rejects(router.send('bob', 'swapETHForExactTokens', [ONE, [W, B.address], addr('bob'), deadline()], 10n * ONE), refused);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapExactETHForTokensSupportingFeeOnTransferTokens', [0, [W, B.address], addr('bob'), deadline()], ONE), refused);
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, ONE, ONE, 0, 0, addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'addLiquidityETH', [B.address, ONE, 0, 0, addr('bob'), deadline()], ONE), refused);
  // The error names the token and the reason.
  const iface = new Interface(art('ZetaphyRouter').abi);
  const err = await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]).catch((e) => e);
  const parsed = iface.parseError(err.data);
  assert.equal(parsed.name, 'TokenEnforced');
  assert.equal(parsed.args[0].toLowerCase(), B.address.toLowerCase());
  assert.equal(parsed.args[1], BigInt(UNLIMITED_MINT));

  // Holders are never locked in: selling B, and removing liquidity, work.
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [B.address, A.address], addr('bob'), deadline()]);
  await router.send('bob', 'swapExactTokensForETH', [ONE, 0, [B.address, W], addr('bob'), deadline()]);
  await router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, 0, [B.address, C.address], addr('bob'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, ONE, 0, 0, addr('alice'), deadline()]);
  const bw = pairAt(await factory.call('getPair', [B.address, W]));
  await bw.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidityETH', [B.address, ONE, 0, 0, addr('alice'), deadline()]);
  // Other tokens are unaffected.
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [B.address, C.address], addr('bob'), deadline()]);

  // Off again (zero): everything goes through.
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
});

test('a code flag covers every copy of the same code (codeKey of extcodehash), at any address', async () => {
  const { factory, reg, flag, router, A, addr, deadline, c, token } = await setup();
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  // Same constructor arguments from the same deployer: byte-identical runtime code.
  const copy1 = await token('Copy One', 'CP1');
  const copy2 = await token('Copy Two', 'CP2');
  const code = await c.code(copy1.address);
  assert.equal(code, await c.code(copy2.address));
  const ch = keccak256(code);
  await flag(await reg.call('codeKey', [ch]));
  c.advance(HOUR);
  for (const t of [copy1, copy2]) {
    await t.send('alice', 'approve', [router.address, MAX]);
    await assert.rejects(router.send('alice', 'addLiquidity', [A.address, t.address, ONE, ONE, 0, 0, addr('alice'), deadline()]), /TokenEnforced/);
  }
  void bytesToHex;
});

test('the fast lane: a flag with fastQuorum support is enforced at once', async () => {
  const { factory, reg, router, A, B, addr, deadline, c } = await setup();
  await factory.send('gov', 'setThreatRegistry', [reg.address]);
  const runners = await c.deployRaw(art('MockRunners'), [], 'gov');
  for (const w of ['w1', 'w2', 'w3', 'carol']) await runners.send('gov', 'set', [addr(w), true]);
  const fast = await c.deployRaw(art('ThreatRegistry'), [runners.address, 2, 1, addr('gov'), HOUR], 'gov');
  await factory.send('gov', 'setThreatRegistry', [fast.address]);
  const key = await fast.call('addressKey', [1n, B.address]);
  for (const w of ['w1', 'w2', 'w3', 'carol']) await fast.send(w, 'vote', [key, true, UNLIMITED_MINT, ...EVIDENCE]); // fastQuorum = 4
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /TokenEnforced/);
  void reg;
});
