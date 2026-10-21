// Fixes from the security review, on the in-memory EVM (npm test):
//   M3  a donation + sync before the first deposit cannot set the first LP's price;
//   L5  the registry query has a gas cap and fails closed; zero lifts it;
//   L9  stray native coins in the router: governance-only sweep(to);
//   S1  RevertProbe (used on the devnet against the native precompile) reports
//       unchanged balances after a reverted router call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ethereumjs/util';
import { Interface } from 'ethers';
import { setupDex, art, sqrt, ONE } from './helpers/dex.js';

const ZERO = '0x' + '00'.repeat(20);
const MAX = 2n ** 256n - 1n;
const bal = (t, who) => t.call('balanceOf', [who]);

test('M3: reserves from a donation + sync with no LP minted: addLiquidity takes the desired amounts; the first LP gets the donation and loses nothing', async () => {
  const { router, factory, A, B, addr, deadline, pairAt } = await setupDex();
  // The attacker makes the pair, donates at a 1:100 price and syncs.
  await factory.send('carol', 'createPair', [A.address, B.address]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  await A.send('bob', 'transfer', [pair.address, 1n * ONE]);
  await B.send('bob', 'transfer', [pair.address, 100n * ONE]);
  await pair.send('carol', 'sync');
  assert.equal(await pair.call('totalSupply'), 0n);
  const [r0, r1] = await pair.call('getReserves');
  assert.ok(r0 > 0n && r1 > 0n, 'reserves are not zero');
  // The victim wants 1000 A + 1000 B, with min = desired (what the page sends for a pool without LP).
  const a0 = await bal(A, addr('alice'));
  const b0 = await bal(B, addr('alice'));
  await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 1000n * ONE, 1000n * ONE, 1000n * ONE, addr('alice'), deadline()]);
  assert.equal(a0 - (await bal(A, addr('alice'))), 1000n * ONE, 'exactly the desired A');
  assert.equal(b0 - (await bal(B, addr('alice'))), 1000n * ONE, 'exactly the desired B (not quoted at the donated 1:100 price)');
  const lp = await bal(pair, addr('alice'));
  // The pair mints for balance - reserve (the deposit), but the first LP owns every LP token but the locked 1000,
  // so the donated reserves are theirs too.
  assert.equal(lp, sqrt(1000n * ONE * 1000n * ONE) - 1000n);
  assert.equal(await pair.call('totalSupply'), lp + 1000n);
  // Taking it all out again gives back at least what went in (plus most of the donation).
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, lp, 0, 0, addr('alice'), deadline()]);
  assert.ok((await bal(A, addr('alice'))) >= a0, 'A back');
  assert.ok((await bal(B, addr('alice'))) >= b0 + 99n * ONE, 'B back, plus the donation');
  // Once LP exists, the pool's price applies again (V2 behaviour).
  await router.send('bob', 'addLiquidity', [A.address, B.address, 10n * ONE, 10n * ONE, 0, 0, addr('bob'), deadline()]);
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, 10n * ONE, 10n * ONE, 10n * ONE, 10n * ONE, addr('bob'), deadline()]), /Insufficient[AB]Amount/);
});

test('L5: the registry gets REGISTRY_GAS; one that needs more fails closed for buys and adds, never for selling or removing; zero lifts it', async () => {
  const { router, factory, A, B, weth, addr, deadline, c, pairAt } = await setupDex();
  assert.equal(await router.call('REGISTRY_GAS'), 100_000n);
  assert.equal(await factory.call('REGISTRY_GAS'), 100_000n);
  const W = weth.address;
  await router.send('alice', 'addLiquidityETH', [A.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  const hog = await c.deployRaw(art('GasHogRegistry'), [], 'gov');
  await hog.send('gov', 'setBurn', [150_000n]);
  await assert.rejects(factory.send('gov', 'setThreatRegistry', [hog.address]), /NotARegistry/, 'too slow when set');
  await hog.send('gov', 'setBurn', [0n]);
  await factory.send('gov', 'setThreatRegistry', [hog.address]);
  await router.send('bob', 'swapExactETHForTokens', [0, [W, A.address], addr('bob'), deadline()], ONE);
  // The registry later stops answering in time: buying and adding stop router-wide.
  await hog.send('gov', 'setBurn', [150_000n]);
  await assert.rejects(router.send('bob', 'swapExactETHForTokens', [0, [W, A.address], addr('bob'), deadline()], ONE), /RegistryUnavailable/);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /RegistryUnavailable/);
  await assert.rejects(router.send('bob', 'addLiquidity', [A.address, B.address, ONE, ONE, 0, 0, addr('bob'), deadline()]), /RegistryUnavailable/);
  // Selling into the native coin and removing liquidity still work.
  await router.send('bob', 'swapExactTokensForETH', [ONE, 0, [A.address, W], addr('bob'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, ONE, 0, 0, addr('alice'), deadline()]);
  // Governance lifts it by switching the check off.
  await factory.send('gov', 'setThreatRegistry', [ZERO]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
});

test('L9: stray native coins in the router: only governance can sweep them, to a nonzero address', async () => {
  const { router, factory, c, addr } = await setupDex();
  const routerAddr = Address.fromString(router.address);
  const fs = new Interface(art('ForceSend').abi);
  const r = await c.rawSend(addr('bob'), undefined, art('ForceSend').bytecode + fs.encodeDeploy([router.address]).slice(2), 3n * ONE);
  assert.ok(r.ok);
  assert.equal(await c.balance(routerAddr), 3n * ONE, 'arrived without receive()');
  await assert.rejects(router.send('bob', 'sweep', [addr('bob')]), /NotGovernance/);
  await assert.rejects(router.send('gov', 'sweep', [ZERO]), /ZeroAddress/);
  const before = await c.balance('carol');
  const logs = await router.send('gov', 'sweep', [addr('carol')]);
  assert.equal((await c.balance('carol')) - before, 3n * ONE);
  assert.equal(await c.balance(routerAddr), 0n);
  assert.equal(logs.find((l) => l?.name === 'Swept')?.args.amount, 3n * ONE);
  // After a governance handover, the new governance sweeps.
  await factory.send('gov', 'setGovernance', [addr('bob')]);
  await factory.send('bob', 'acceptGovernance');
  await router.send('bob', 'sweep', [addr('bob')]);
  await assert.rejects(router.send('gov', 'sweep', [addr('gov')]), /NotGovernance/);
});

test('S1 probe: a router call that moves native coins and then reverts leaves every balance as it was (WZETAPHY here; the devnet test runs it on the precompile)', async () => {
  const { router, A, weth, addr, deadline, c, factory } = await setupDex();
  const W = weth.address;
  await router.send('alice', 'addLiquidityETH', [A.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  const pair = await factory.call('getPair', [A.address, W]);
  const probe = await c.deployRaw(art('RevertProbe'), [], 'bob');
  const ri = new Interface(art('ZetaphyRouter').abi);
  // Wraps and swaps (native into the pair, A out), then fails the minimum: reverted.
  const call = { target: router.address, value: ONE, data: ri.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [MAX, [W, A.address], probe.address, deadline()]) };
  const n0 = await c.balance('bob');
  const logs = await probe.send('bob', 'probe', [[call], false, W, pair], ONE);
  const ev = logs.find((l) => l?.name === 'Probed');
  assert.equal(ev.args.reverted, true);
  const failed = probe.iface.parseError(ev.args.revertData);
  assert.equal(failed.name, 'Failed');
  assert.equal(ri.parseError(failed.args.data).name, 'InsufficientOutputAmount', 'reverted after the coins moved');
  assert.deepEqual([...ev.args.afterwards], [...ev.args.before], 'balances unchanged');
  assert.equal(await c.balance('bob'), n0, 'the value came back (no gas price on this chain)');
  assert.equal(await bal(A, probe.address), 0n);
  // undo = true: a call that succeeds is undone as well.
  const ok = { ...call, data: ri.encodeFunctionData('swapExactETHForTokens', [0, [W, A.address], probe.address, deadline()]) };
  const ev2 = (await probe.send('bob', 'probe', [[ok], true, W, pair], ONE)).find((l) => l?.name === 'Probed');
  assert.equal(ev2.args.revertData.slice(0, 10), probe.iface.getError('Undo').selector);
  assert.deepEqual([...ev2.args.afterwards], [...ev2.args.before]);
  // undo = false: the same call keeps its effects (the probe sees them).
  const ev3 = (await probe.send('bob', 'probe', [[ok], false, W, pair], ONE)).find((l) => l?.name === 'Probed');
  assert.equal(ev3.args.reverted, false);
  assert.equal(ev3.args.afterwards.watchWrapped - ev3.args.before.watchWrapped, ONE, 'the pair got the coin');
  assert.ok((await bal(A, probe.address)) > 0n);
});
