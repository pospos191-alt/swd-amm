// Proof of Intent: IntentExecutor runs a solver's calls and reverts unless the effects match what the
// user signed (balance deltas, recipient, min-out, deadline, nonce, listed targets). Swaps go through the
// real ZETAPHY DEX (zetaphy-dex artifacts); signatures are EIP-712 (ethers) or real ML-DSA-44.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, TypedDataEncoder, AbiCoder, keccak256 } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { dexArt, agentKit } from './helpers/mocks.js';
import { compile, executeArgs, signIntent, signIntentPq, hashTargets, intentDigest, signedJson, readSigned, intentOf, TYPES } from '../src/intent.js';
import { typedData, domain } from '../../zetaphy-hub/intent-core.js';

const user = Wallet.createRandom();
const ROUTER = new Interface(['function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', 'function transferFrom(address,address,uint256)']);
const DRAIN = new Interface(['function drain(address,address,address,uint256)']);
let c, tA, tB, router, exe, chainId;
const addr = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['deployer', 'solver', 'bob', 'thief', 'gov'], { user: user.address }, { precompiles: PRECOMPILES });
  chainId = 1n; // the in-memory chain's id
  tA = await c.deployRaw(dexArt('TestToken'), ['Token A', 'TKA', 18, 1_000_000n * ZETA, 0], 'deployer');
  tB = await c.deployRaw(dexArt('TestToken'), ['Token B', 'TKB', 18, 1_000_000n * ZETA, 0], 'deployer');
  const factory = await c.deployRaw(dexArt('ZetaphyFactory'), [addr('gov')], 'deployer');
  router = await c.deployRaw(dexArt('ZetaphyRouter'), [factory.address, tA.address], 'deployer');
  for (const t of [tA, tB]) await t.send('deployer', 'approve', [router.address, 2n ** 255n]);
  await router.send('deployer', 'addLiquidity', [tA.address, tB.address, 1000n * ZETA, 2000n * ZETA, 0n, 0n, addr('deployer'), c.now() + 600n]);
  await tA.send('deployer', 'transfer', [user.address, 100n * ZETA]);
  exe = await c.deploy('IntentExecutor', [], 'deployer');
});

const quote = async (amountIn) => (await router.call('getAmountsOut', [amountIn, [tA.address, tB.address]]))[1];

async function swapIntent({ maxIn = 10n * ZETA, minOut, recipient = addr('bob'), targets = [router.address], nonce = 1n, deadline = c.now() + 600n } = {}) {
  minOut ??= ((await quote(maxIn)) * 99n) / 100n;
  return { user: user.address, kind: 2, tokenIn: tA.address, maxIn, tokenOut: tB.address, minOut, recipient, targetsHash: hashTargets(targets), nonce, deadline };
}
const approve = (amount) => tA.send('user', 'approve', [exe.address, amount]);
const run = (intent, auth, plan) => exe.send('solver', 'execute', executeArgs(intent, auth, plan));

test('swap: the solver compiles the intent, the executor checks the effects; nothing stays behind', async () => {
  const intent = await swapIntent();
  await approve(intent.maxIn);
  const auth = await signIntent(user, intent, exe.address, chainId);
  const before = await tB.call('balanceOf', [addr('bob')]);
  const ev = await run(intent, auth, compile(intent, { router: router.address }));
  const got = (await tB.call('balanceOf', [addr('bob')])) - before;
  assert.ok(got >= intent.minOut);
  assert.equal(await tA.call('balanceOf', [user.address]), 90n * ZETA);
  assert.equal(await tA.call('balanceOf', [exe.address]), 0n);
  assert.equal(await tB.call('balanceOf', [exe.address]), 0n);
  assert.equal(await tA.call('allowance', [exe.address, router.address]), 0n);
  const done = ev.find((e) => e?.name === 'IntentExecuted');
  assert.equal(done.args.spent, 10n * ZETA);
  assert.equal(done.args.received, got);
  assert.equal(await exe.call('digest', [Object.values(intent)]), intentDigest(intent, exe.address, chainId));
});

test('the hub\'s eth_signTypedData_v4 payload hashes to the contract digest', async () => {
  const intent = await swapIntent();
  const td = typedData(intent, exe.address, chainId);
  const { EIP712Domain, ...types } = td.types;
  assert.equal(TypedDataEncoder.hash(td.domain, types, td.message), await exe.call('digest', [Object.values(intent)]));
  assert.deepEqual(domain(exe.address, chainId), td.domain);
  assert.deepEqual(types, TYPES);
  assert.equal(hashTargets([router.address]), keccak256(AbiCoder.defaultAbiCoder().encode(['address[]'], [[router.address]])));
});

test('a solver that sends the output elsewhere, or under min-out, is reverted', async () => {
  const intent = await swapIntent();
  await approve(intent.maxIn);
  const auth = await signIntent(user, intent, exe.address, chainId);
  const plan = compile(intent, { router: router.address });
  plan.calls[0].data = ROUTER.encodeFunctionData('swapExactTokensForTokens', [intent.maxIn, 0n, [tA.address, tB.address], addr('thief'), intent.deadline]);
  await assert.rejects(run(intent, auth, plan), /ReceivedTooLittle/);
  const greedy = await swapIntent({ minOut: (await quote(10n * ZETA)) + 1n, nonce: 2n });
  await assert.rejects(run(greedy, await signIntent(user, greedy, exe.address, chainId), compile(greedy, { router: router.address })), /ReceivedTooLittle|CallFailed/);
  assert.equal(await tA.call('balanceOf', [user.address]), 100n * ZETA);
});

test('calls only to the targets the user signed; never to the tokens; never transferFrom', async () => {
  const intent = await swapIntent();
  await approve(intent.maxIn);
  const auth = await signIntent(user, intent, exe.address, chainId);
  const good = compile(intent, { router: router.address });
  await assert.rejects(run(intent, auth, { ...good, targets: [addr('thief')] }), /BadIntent/); // not the signed list
  await assert.rejects(run(intent, auth, { ...good, calls: [{ target: addr('thief'), data: '0x' }] }), /TargetNotAllowed/);
  await assert.rejects(run(intent, auth, { ...good, calls: [{ target: router.address, data: ROUTER.encodeFunctionData('transferFrom', [user.address, addr('thief'), 1n]) }] }), /ForbiddenCall/);
  await assert.rejects(run(intent, auth, { ...good, calls: [{ target: router.address, data: tA.iface.encodeFunctionData('approve', [addr('thief'), 1n]) }] }), /ForbiddenCall/);
  // a list that names the token itself is still refused
  const sneaky = await swapIntent({ targets: [router.address, tA.address], nonce: 2n });
  const sAuth = await signIntent(user, sneaky, exe.address, chainId);
  await assert.rejects(run(sneaky, sAuth, { targets: [router.address, tA.address], spender: router.address,
    calls: [{ target: tA.address, data: tA.iface.encodeFunctionData('transfer', [addr('thief'), 1n]) }] }), /ForbiddenCall/);
});

test('a listed contract that pulls more of the user\'s tokens (an old approval) is caught by the balance check', async () => {
  const drainer = await c.deployRaw(agentKit().Drainer, [], 'deployer');
  await tA.send('user', 'approve', [drainer.address, 2n ** 255n]); // an approval from long ago
  const intent = await swapIntent({ targets: [router.address, drainer.address] });
  await approve(intent.maxIn);
  const auth = await signIntent(user, intent, exe.address, chainId);
  const plan = compile(intent, { router: router.address });
  plan.targets = [router.address, drainer.address];
  plan.calls.push({ target: drainer.address, data: DRAIN.encodeFunctionData('drain', [tA.address, user.address, addr('thief'), 50n * ZETA]) });
  await assert.rejects(run(intent, auth, plan), /SpentTooMuch/);
  assert.equal(await tA.call('balanceOf', [addr('thief')]), 0n);
});

test('unspent input goes back to the user', async () => {
  const intent = await swapIntent({ minOut: ((await quote(5n * ZETA)) * 99n) / 100n });
  await approve(intent.maxIn);
  const plan = compile(intent, { router: router.address });
  plan.calls[0].data = ROUTER.encodeFunctionData('swapExactTokensForTokens', [5n * ZETA, 0n, [tA.address, tB.address], addr('bob'), intent.deadline]);
  const ev = await run(intent, await signIntent(user, intent, exe.address, chainId), plan);
  assert.equal(ev.find((e) => e?.name === 'IntentExecuted').args.spent, 5n * ZETA);
  assert.equal(await tA.call('balanceOf', [user.address]), 95n * ZETA);
});

test('no replay, deadline, cancel, and a changed intent no longer matches its signature', async () => {
  const intent = await swapIntent();
  await approve(3n * intent.maxIn);
  const auth = await signIntent(user, intent, exe.address, chainId);
  const plan = compile(intent, { router: router.address });
  await assert.rejects(run({ ...intent, minOut: 1n }, auth, plan), /BadSignature/);
  await run(intent, auth, plan);
  await assert.rejects(run(intent, auth, plan), /NonceUsed/);
  const late = await swapIntent({ nonce: 2n, deadline: c.now() + 60n });
  const lAuth = await signIntent(user, late, exe.address, chainId);
  c.advance(61);
  await assert.rejects(run(late, lAuth, compile(late, { router: router.address })), /Expired/);
  const third = await swapIntent({ nonce: 3n });
  await exe.send('user', 'cancel', [3n]);
  await assert.rejects(run(third, await signIntent(user, third, exe.address, chainId), compile(third, { router: router.address })), /NonceUsed/);
});

test('post-quantum variant: the same digest signed with a registered ML-DSA-44 key', async () => {
  const pq = mldsaKey();
  const intent = await swapIntent();
  await approve(intent.maxIn);
  const plan = compile(intent, { router: router.address });
  await assert.rejects(run(intent, signIntentPq(pq, intent, exe.address, chainId), plan), /BadSignature/); // no key registered
  await exe.send('user', 'setPqKey', [pq.keyHash]);
  await assert.rejects(run(intent, signIntentPq(mldsaKey(), intent, exe.address, chainId), plan), /BadSignature/);
  const wrongMsg = { ...signIntentPq(pq, intent, exe.address, chainId), sig: pq.sign(keccak256('0x01')) };
  await assert.rejects(run(intent, wrongMsg, plan), /BadSignature/);
  await run(intent, signIntentPq(pq, intent, exe.address, chainId), plan);
  assert.equal(await tA.call('balanceOf', [user.address]), 90n * ZETA);
});

test('send: exactly minOut to the recipient; a fee-on-transfer token short of it reverts', async () => {
  const send = { user: user.address, kind: 1, tokenIn: tA.address, maxIn: 7n * ZETA, tokenOut: tA.address, minOut: 7n * ZETA, recipient: addr('bob'),
    targetsHash: '0x' + '00'.repeat(32), nonce: 9n, deadline: c.now() + 600n };
  await approve(send.maxIn);
  const auth = await signIntent(user, send, exe.address, chainId);
  await assert.rejects(run(send, auth, { targets: [], spender: '0x' + '00'.repeat(20), calls: [{ target: router.address, data: '0x' }] }), /BadIntent/);
  await run(send, auth, compile(send));
  assert.equal(await tA.call('balanceOf', [addr('bob')]), 7n * ZETA);

  const fee = await c.deployRaw(dexArt('TestToken'), ['Fee', 'FEE', 18, 1000n * ZETA, 100], 'deployer'); // 1% fee
  await fee.send('deployer', 'transfer', [user.address, 100n * ZETA]);
  const fs = { ...send, tokenIn: fee.address, tokenOut: fee.address, nonce: 10n };
  await fee.send('user', 'approve', [exe.address, fs.maxIn]);
  await assert.rejects(run(fs, await signIntent(user, fs, exe.address, chainId), compile(fs)), /ReceivedTooLittle/);
  const self = { ...send, recipient: user.address, nonce: 11n };
  await assert.rejects(run(self, await signIntent(user, self, exe.address, chainId), compile(self)), /BadIntent/);
});

test('stake: deposit into a listed vault; the recipient gets the receipt shares', async () => {
  const vault = await c.deployRaw(agentKit().ShareVault, [tA.address], 'deployer');
  const stake = { user: user.address, kind: 3, tokenIn: tA.address, maxIn: 4n * ZETA, tokenOut: vault.address, minOut: 4n * ZETA, recipient: user.address,
    targetsHash: hashTargets([vault.address]), nonce: 5n, deadline: c.now() + 600n };
  await approve(stake.maxIn);
  await run(stake, await signIntent(user, stake, exe.address, chainId), compile(stake, { vault: vault.address }));
  assert.equal(await vault.call('balanceOf', [user.address]), 4n * ZETA);
  assert.equal(await tA.call('balanceOf', [user.address]), 96n * ZETA);
});

test('signed intent files round-trip; malformed ones are refused before any transaction', async () => {
  const intent = await swapIntent();
  const auth = await signIntent(user, intent, exe.address, chainId);
  const text = signedJson({ intent, auth, executor: exe.address, chainId, route: { router: router.address } });
  const back = readSigned(text, Number(c.now()));
  assert.deepEqual(back.intent, intentOf(intent));
  assert.equal(back.route.router, router.address);
  const bad = JSON.parse(text); bad.intent.minOut = '0';
  assert.throws(() => readSigned(JSON.stringify(bad), Number(c.now())), /minOut/);
  assert.throws(() => readSigned(text, Number(c.now()) + 3600), /deadline/);
});
