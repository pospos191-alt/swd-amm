// Saphan PR 5, multi-chain bundles (contracts/SaphanBundles.sol): money from several routes gathers in escrow on
// ZETAPHY (each leg proven by its route: a Gateway call, attested by the lanes, with the tokens really here), then
// ONE ZETAPHY transaction runs every step (calls on ZETAPHY and calls to other chains through the Gateway), or none;
// past the deadline every funded leg is owed back (pull).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain } from './helpers/evm.js';
import { compileHelper } from './helpers/starkbridge.js';
import { saphanWorld, pr5Kit, tokenKitArtifacts, withAbi, SEPOLIA, BASE, CHAIN, DELAY, E, ZERO } from './helpers/saphanroute.js';
import * as B from '../src/saphanbundles.js';

let c, w, sep, base, usd, bundles, target, k;
const a = (n) => c.acct[n].toString();
const USD = new Interface(tokenKitArtifacts().KitToken.abi);
const usdBal = (who) => c.callAt(usd.address, USD, 'balanceOf', [who.startsWith('0x') ? who : a(who)]);

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'carol', 'attacker', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor']);
  w = await saphanWorld(c);
  k = pr5Kit();
  sep = await w.route(SEPOLIA, { symbol: 'sepETH' });
  base = await w.route(BASE, { symbol: 'baseETH' });
  usd = await c.deployRaw(tokenKitArtifacts().KitToken, ['Test USD', 'tUSD', 6], 'gov');
  await usd.send('gov', 'mint', [a('carol'), 1000n]);
  bundles = await c.deployRaw(withAbi('SaphanBundles', 'ZetaphyGateway'), [], 'gov');
  target = await c.deployRaw(k.KitBundleTarget, [bundles.address], 'gov');
});

/** A swap-like bundle: alice brings 1 sepETH from Sepolia, bob 2 baseETH from Base, carol 300 tUSD on ZETAPHY.
 *  Steps: the target on ZETAPHY gets the sepETH and the tUSD; bob's receiver on Base gets the baseETH back as ETH. */
async function swapBundle({ deadline = c.now() + 3600n, receiver } = {}) {
  const legs = [
    { srcChainId: CHAIN, gateway: sep.zgw.address, token: sep.token, sender: a('alice'), amount: E, refundTo: a('alice') },
    { srcChainId: CHAIN, gateway: base.zgw.address, token: base.token, sender: a('bob'), amount: 2n * E, refundTo: a('bob') },
    { srcChainId: CHAIN, gateway: ZERO, token: usd.address, sender: a('carol'), amount: 300n, refundTo: a('carol') },
  ];
  const actions = [
    { target: target.address, token: sep.token, amount: E, gasLimit: 200_000n, data: '0xaa' },
    { target: target.address, token: usd.address, amount: 300n, gasLimit: 200_000n, data: '0xbb' },
  ];
  const outs = [{ gateway: base.zgw.address, token: base.token, target: receiver ?? a('bob'), amount: 2n * E, maxFee: 0n, gasLimit: 300_000n, revertTo: a('bob'), data: '0xcc' }];
  const spec = { legs, actions, outs, deadline };
  assert.deepEqual(B.imbalance(spec), []);
  const ev = await bundles.send('alice', 'create', B.createArgs(spec));
  const id = ev.find((e) => e?.name === 'Created').args.id;
  assert.equal((await bundles.call('bundles', [id])).planHash, B.planHash(spec));
  return { id, spec };
}

/** A leg from another chain: its sender's depositAndCall to SaphanBundles, then the executor runs it on ZETAPHY. */
async function fundFrom(r, who, id, leg, amount) {
  const d = await w.depositAndCall(r, bundles.address, { amount, who, data: B.legData(id, leg), revertTo: a(who) });
  return r.zgw.send('executor', 'execute', [d.p, true, d.n]);
}

test('legs from two routes and ZETAPHY gather; one transaction runs every step, on ZETAPHY and toward Base', async () => {
  const receiver = await c.deployRaw(compileHelper('GatewayKit.sol').KitReceiver, [base.sgw.address], 'bob');
  const { id, spec } = await swapBundle({ receiver: receiver.address });
  const plan = B.planTuple(spec);
  // not before every leg is in
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [0n]]), /NotOpen/);
  const ev1 = await fundFrom(sep, 'alice', id, 0, E);
  assert.ok(ev1.find((e) => e?.name === 'Executed'), 'the Gateway call into the bundle went through');
  assert.equal(await bundles.call('legFunded', [id, 0n]), true);
  await fundFrom(base, 'bob', id, 1, 2n * E);
  // carol's leg on ZETAPHY: only carol may pay it (the leg names her)
  await usd.send('carol', 'approve', [bundles.address, 300n]);
  await assert.rejects(bundles.send('attacker', 'fund', [id, 2n]), /WrongLeg/);
  await assert.rejects(bundles.send('carol', 'fund', [id, 0n]), /WrongLeg/, 'a leg from another chain is not paid here');
  await bundles.send('carol', 'fund', [id, 2n]);
  assert.equal((await bundles.call('bundles', [id])).status, 2n, 'Funded');
  // the plan handed in must be the one fixed at create
  const other = B.planTuple({ ...spec, actions: [{ ...spec.actions[0], data: '0xdd' }, spec.actions[1]] });
  await assert.rejects(bundles.send('executor', 'execute', [id, other, [0n]]), /WrongPlan/);
  // the executor pays the Mailbox fee of the call to Base, exactly (ZETAPHY's Mailbox charges 7 wei here)
  await w.zMailbox.send('gov', 'setFee', [7n]);
  const fee = await base.zgw.call('quoteWithdraw', [2n * E]);
  assert.equal(fee, 7n);
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [fee]], fee + 1n), /Fee/);
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [fee]]), /Fee/);
  const ev = await bundles.send('executor', 'execute', [id, plan, [fee]], fee);
  assert.equal(await c.balance(Address.fromString(bundles.address)), 0n, 'no ether stays in the bundles contract');
  assert.equal(await target.call('calls'), 2n);
  assert.equal(await sep.bal(target.address), E);
  assert.equal(await usdBal(target.address), 300n);
  assert.equal((await target.call('lastCreator')).toLowerCase(), a('alice').toLowerCase());
  assert.equal(await bundles.call('accounted', [sep.token]), 0n, 'nothing left in escrow');
  assert.equal(await bundles.call('accounted', [usd.address]), 0n);
  const sent = ev.find((e) => e?.name === 'OutSent').args;
  const oc = ev.find((e) => e?.name === 'OutCallSent').args;
  assert.equal(sent.callHash, oc.callHash, 'the step to Base is the Gateway\'s own call (its hash)');
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [fee]], fee), /NotOpen/, 'runs once');
  // on Base: the lockbox pays the call's deposit address after its delay, then the call runs
  await w.relayOut(base);
  const rid = await w.lastRelease();
  c.advance(DELAY);
  await base.lockbox.send('relayer', 'claim', [rid]);
  await base.sgw.send('executor', 'execute', [oc.call.toArray(true)]);
  assert.equal(await receiver.call('got'), 2n * E);
  const out = B.decodeOutData(await receiver.call('lastData'));
  assert.equal(out.id, id);
  assert.equal(out.creator.toLowerCase(), a('alice').toLowerCase());
  assert.equal(out.data, '0xcc');
  assert.equal((await receiver.call('lastSender')).toLowerCase(), bundles.address.toLowerCase());
});

test('all or nothing: a failing step undoes every step; past the deadline each funded leg is owed back (pull)', async () => {
  const { id, spec } = await swapBundle();
  const plan = B.planTuple(spec);
  await fundFrom(sep, 'alice', id, 0, E);
  await fundFrom(base, 'bob', id, 1, 2n * E);
  await usd.send('carol', 'approve', [bundles.address, 300n]);
  await bundles.send('carol', 'fund', [id, 2n]);
  await target.send('gov', 'setFail', [true]);
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [0n]]));
  // nothing moved: the first step's tokens are back, the call to Base was never sent, the bundle is still funded
  assert.equal(await sep.bal(target.address), 0n);
  assert.equal(await base.bal(bundles.address), 2n * E);
  assert.equal((await bundles.call('bundles', [id])).status, 2n);
  await assert.rejects(bundles.send('carol', 'refund', [id]), /TooEarly/);
  c.advance(3601);
  await target.send('gov', 'setFail', [false]);
  await assert.rejects(bundles.send('executor', 'execute', [id, plan, [0n]]), /TooLate/);
  await bundles.send('carol', 'refund', [id]);
  await assert.rejects(bundles.send('carol', 'refund', [id]), /NotOpen/);
  await assert.rejects(bundles.send('attacker', 'claim', [sep.token]), /WrongLeg/);
  await bundles.send('alice', 'claim', [sep.token]);
  await bundles.send('bob', 'claim', [base.token]);
  await bundles.send('carol', 'claim', [usd.address]);
  assert.equal(await sep.bal('alice'), E);
  assert.equal(await base.bal('bob'), 2n * E);
  assert.equal(await usdBal('carol'), 1000n);
  assert.equal(await bundles.call('accounted', [sep.token]), 0n);
});

test('a leg that is late, paid twice, from the wrong sender or not really paid is refused (the Gateway refunds it)', async () => {
  const { id } = await swapBundle();
  // someone else than the leg's sender
  const ev = await fundFrom(sep, 'carol', id, 0, E);
  assert.ok(ev.find((e) => e?.name === 'CallFailed'), 'refused: the Gateway refunds carol on Sepolia');
  assert.equal(await bundles.call('legFunded', [id, 0n]), false);
  // too little
  assert.ok((await fundFrom(sep, 'alice', id, 0, E / 2n)).find((e) => e?.name === 'CallFailed'));
  await fundFrom(sep, 'alice', id, 0, E);
  // twice
  assert.ok((await fundFrom(sep, 'alice', id, 0, E)).find((e) => e?.name === 'CallFailed'));
  // a "gateway" that hands in no tokens: the leg's own gateway is the only caller, and the tokens must be here
  await assert.rejects(bundles.send('attacker', 'onSaphanCall', [CHAIN, a('bob'), base.token, 2n * E, B.legData(id, 1)]), /WrongLeg/);
  const fake = { legs: [{ srcChainId: CHAIN, gateway: a('attacker'), token: sep.token, sender: ZERO, amount: E, refundTo: a('attacker') }],
    actions: [{ target: target.address, token: sep.token, amount: E, gasLimit: 100_000n, data: '0x' }], deadline: c.now() + 600n };
  const fid = (await bundles.send('attacker', 'create', B.createArgs(fake))).find((e) => e?.name === 'Created').args.id;
  await assert.rejects(bundles.send('attacker', 'onSaphanCall', [CHAIN, a('attacker'), sep.token, E, B.legData(fid, 0)]), /Short/);
  // late
  c.advance(3601);
  assert.ok((await fundFrom(base, 'bob', id, 1, 2n * E)).find((e) => e?.name === 'CallFailed'));
});

test('create refuses a plan that does not spend exactly what the legs bring, and other bad bundles', async () => {
  const leg = { srcChainId: CHAIN, gateway: ZERO, token: usd.address, sender: a('carol'), amount: 300n, refundTo: a('carol') };
  const act = { target: target.address, token: usd.address, amount: 300n, gasLimit: 100_000n, data: '0x' };
  const dl = c.now() + 600n;
  await bundles.send('carol', 'create', B.createArgs({ legs: [leg], actions: [act], deadline: dl }));
  const bad = [
    { legs: [leg], actions: [{ ...act, amount: 299n }], deadline: dl },                       // keeps 1 back
    { legs: [leg], actions: [{ ...act, amount: 301n }], deadline: dl },                       // spends more
    { legs: [leg], actions: [{ ...act, token: sep.token }], deadline: dl },                   // another token
    { legs: [leg], actions: [], deadline: dl },                                               // no step
    { legs: [], actions: [act], deadline: dl },                                               // no leg
    { legs: [leg], actions: [act], deadline: c.now() },                                       // deadline passed
    { legs: [leg], actions: [{ ...act, target: bundles.address }], deadline: dl },            // itself as a step
    { legs: [{ ...leg, srcChainId: 5n }], actions: [act], deadline: dl },                     // "here" but another chain
    { legs: [leg], outs: [{ gateway: base.zgw.address, token: usd.address, target: a('bob'), amount: 300n, maxFee: 301n, gasLimit: 1n, revertTo: a('bob') }], deadline: dl },
  ];
  for (const b of bad) await assert.rejects(bundles.send('carol', 'create', B.createArgs(b)), /BadBundle/);
  // an out whose token is not its Gateway's is caught when it runs (the bundle then waits for its deadline)
  const wrong = { legs: [leg], outs: [{ gateway: base.zgw.address, token: usd.address, target: a('bob'), amount: 300n, maxFee: 0n, gasLimit: 1n, revertTo: a('bob') }], deadline: dl };
  const id = (await bundles.send('carol', 'create', B.createArgs(wrong))).find((e) => e?.name === 'Created').args.id;
  await usd.send('carol', 'approve', [bundles.address, 300n]);
  await bundles.send('carol', 'fund', [id, 0n]);
  await assert.rejects(bundles.send('executor', 'execute', [id, B.planTuple(wrong), [0n]]), /WrongPlan/);
});
