// Saphan PR 5, one account on every chain (contracts/SaphanAccounts.sol): the same address on every Saphan chain
// (factory at the same address, CREATE2 with salt = owner), used by its owner directly on ZETAPHY and, on any other
// chain, only through that chain's Saphan Gateway from ZETAPHY (withdrawAndCall to the account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Address } from '@ethereumjs/util';
import { execFileSync } from 'node:child_process';
import { createChain } from './helpers/evm.js';
import { saphanWorld, pr5Kit, withAbi, artifact, SEPOLIA, BASE, ZETAPHY, DELAY, E, ZERO } from './helpers/saphanroute.js';
import * as A from '../src/saphanaccounts.js';

const NAMES = ['gov', 'guardian', 'alice', 'bob', 'carol', 'attacker', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor', 'fdeploy'];
const ACCOUNT = () => withAbi('SaphanAccount');
const accountCode = () => artifact('SaphanAccount').bytecode;

test('the same account address on ZETAPHY, Sepolia and Base; JS derives it; the owner uses it directly on ZETAPHY only', async () => {
  const chains = {};
  for (const id of [ZETAPHY, SEPOLIA, BASE]) chains[id] = await createChain(NAMES, {}, { chainId: id });
  const a = (n) => chains[ZETAPHY].acct[n].toString();
  const factories = {};
  for (const [id, c] of Object.entries(chains)) {
    // a factory must know its chain's Gateway, except on ZETAPHY, which has none
    const gw = Number(id) === ZETAPHY ? ZERO : a('gdeploy');
    await assert.rejects(c.deploy('SaphanAccountFactory', [ZETAPHY, Number(id) === ZETAPHY ? a('gdeploy') : ZERO], 'gov'));
    assert.equal(await c.nonce('fdeploy'), 0n);
    factories[id] = await c.deploy('SaphanAccountFactory', [ZETAPHY, gw], 'fdeploy');
  }
  const f = A.factoryAddress(a('fdeploy'));
  const expected = A.accountAddress(f, a('alice'), accountCode());
  for (const [id, fac] of Object.entries(factories)) {
    assert.equal(fac.address.toLowerCase(), f.toLowerCase(), `factory on ${id}`);
    assert.equal(await fac.call('accountOf', [a('alice')]), expected, `account on ${id}`);
    await fac.send('bob', 'deploy', [a('alice')]); // anyone may deploy it; it is alice's
    await fac.send('bob', 'deploy', [a('alice')]); // twice is fine
    assert.notEqual(await chains[id].getCode(expected), '0x');
  }
  assert.notEqual(A.accountAddress(f, a('bob'), accountCode()), expected);
  // the CLI derives the same, offline
  const cli = JSON.parse(execFileSync('node', [new URL('../scripts/saphan.js', import.meta.url).pathname, 'account', '--owner', a('alice'), '--deployer', a('fdeploy')], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(cli.account, expected);
  assert.equal(cli.factory, f);
  // on ZETAPHY: alice runs calls from her account, bob cannot
  const z = chains[ZETAPHY];
  const k = pr5Kit();
  const t = await z.deployRaw(k.KitAccountTarget, [], 'carol');
  await z.transfer('alice', expected, 2n * E);
  const iface = new Interface(ACCOUNT().abi);
  const T = new Interface(k.KitAccountTarget.abi);
  const calls = [[t.address, E, T.encodeFunctionData('poke', [7n])]];
  await assert.rejects(z.sendTo('bob', expected, iface, 'execute', [calls]), /NotOwner/);
  await z.sendTo('alice', expected, iface, 'execute', [calls]);
  assert.equal(await t.call('x'), 7n);
  assert.equal((await t.call('lastCaller')).toLowerCase(), expected.toLowerCase());
  assert.equal(await t.call('lastValue'), E);
  // all or nothing
  await assert.rejects(z.sendTo('alice', expected, iface, 'execute', [[[t.address, 0n, T.encodeFunctionData('poke', [8n])], [t.address, 0n, T.encodeFunctionData('nope')]]]), /CallFailed/);
  assert.equal(await t.call('x'), 7n);
  // on Sepolia, alice's own key has no power over it (only her calls from ZETAPHY through the Gateway)
  const s = chains[SEPOLIA];
  await assert.rejects(s.sendTo('alice', expected, iface, 'execute', [[]]), /NotOwner/);
  await assert.rejects(s.sendTo('attacker', expected, iface, 'onSaphanCall(uint256,address,bytes)', [ZETAPHY, a('alice'), A.accountCalls([])]), /NotGateway/);
});

test('used from ZETAPHY through the Gateway: alice\'s withdrawAndCall runs calls from her account on the other chain', async () => {
  const c = await createChain(NAMES);
  const a = (n) => c.acct[n].toString();
  const w = await saphanWorld(c);
  // the test EVM plays both sides: the source Gateway is told ZETAPHY's chain id (77390), as on a real route
  const r = await w.route(SEPOLIA, { zetaphyChainId: BigInt(ZETAPHY) });
  const factory = await c.deploy('SaphanAccountFactory', [ZETAPHY, r.sgw.address], 'fdeploy');
  const account = A.accountAddress(factory.address, a('alice'), accountCode());
  await factory.send('carol', 'deploy', [a('alice')]);
  const k = pr5Kit();
  const t = await c.deployRaw(k.KitAccountTarget, [], 'carol');
  const T = new Interface(k.KitAccountTarget.abi);
  await w.bridgeIn(r, 'alice', 3n * E);
  await w.bridgeIn(r, 'bob', E);

  /** `who` on ZETAPHY sends `amount` to the account on Sepolia with `calls`; it is delivered and run there. */
  async function control(who, calls, amount) {
    assert.ok((await r.tok(who, 'approve', [r.zgw.address, amount])).ok);
    const ev = await r.zgw.send(who, 'withdrawAndCall', A.controlArgs({ account, calls, amount }), await r.zgw.call('quoteWithdraw', [amount]));
    const oc = ev.find((e) => e?.name === 'OutCallSent').args.call.toArray(true);
    await w.relayOut(r);
    const id = await w.lastRelease();
    c.advance(DELAY);
    await r.lockbox.send('relayer', 'claim', [id]);
    return r.sgw.send('executor', 'execute', [oc]);
  }

  const carolBefore = await c.balance('carol');
  const ev = await control('alice', [{ target: t.address, value: E / 2n, data: T.encodeFunctionData('poke', [42n]) }, { target: a('carol'), value: E }], 2n * E);
  assert.ok(ev.find((e) => e?.name === 'Executed'));
  assert.equal(await t.call('x'), 42n);
  assert.equal((await t.call('lastCaller')).toLowerCase(), account.toLowerCase(), 'the call came from the account');
  assert.equal((await c.balance('carol')) - carolBefore, E);
  assert.equal(await c.balance(Address.fromString(account)), E / 2n, 'the rest stays in the account');
  // bob sending a call to alice's account: refused by the account; the Gateway keeps the ETH for revertTo (the account)
  const bad = await control('bob', [{ target: a('bob'), value: E / 2n }], E);
  assert.ok(bad.find((e) => e?.name === 'CallFailed'));
  assert.equal(await r.sgw.call('owed', [account]), E);
  // anyone moves it into the account (SaphanSourceGateway.claim pays its caller: the account)
  const iface = new Interface(ACCOUNT().abi);
  await c.sendTo('carol', account, iface, 'pullRefunds', []);
  assert.equal(await r.sgw.call('owed', [account]), 0n);
  assert.equal(await c.balance(Address.fromString(account)), E / 2n + E);
  await assert.rejects(c.sendTo('carol', account, iface, 'pullRefunds', []), 'nothing left');
});
