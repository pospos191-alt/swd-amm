// ZETAPHY Saphan Gateway (contracts/SaphanGateway.sol): calls across chains in one transaction, with refunds.
//   X -> ZETAPHY: SaphanSourceGateway.depositAndCall locks to the call's deposit address; the route (lane + lane2,
//                 quarantine) mints there; ZetaphyGateway.execute empties it once and calls the target.
//   ZETAPHY -> X: ZetaphyGateway.withdrawAndCall burns through the outbox toward a deposit address of the source
//                 Gateway; after the lockbox's delay, SaphanSourceGateway.execute pays the target (or revertTo).
// The route is the one of saphan.test.js (one EVM plays every chain; each chain has its own Mailbox).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { AbiCoder, Interface, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256, solidityPacked, getCreate2Address, hexlify, toUtf8Bytes } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain } from './helpers/evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';
import * as G from '../src/saphangateway.js';

const ZETAPHY = 77390;
const SEPOLIA = 11155111;
const CHAIN = 1n;
const Q = 600;
const DELAY = 3600;
const E = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const ROUTE_IN = encodeBytes32String('airlock');
const ROUTE_OUT = encodeBytes32String('out');
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
const abi = AbiCoder.defaultAbiCoder();
const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const TOKEN = new Interface(artifact('BridgedToken').abi);
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
const HYP = validator(1);
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));

let gk;
function gatewayKit() {
  if (gk) return gk;
  const file = 'GatewayKit.sol';
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./helpers/${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  gk = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, x]) => [n, { abi: x.abi, bytecode: '0x' + x.evm.bytecode.object }]));
  return gk;
}

let c, kit, zMailbox;
const a = (n) => c.acct[n].toString();
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock')], bytecode: kit.KitMailbox.bytecode });
const outboxArt = () => { const x = artifact('HyperlaneOutbox'); return { abi: [...x.abi, ...errorsOf('BridgeGuard')], bytecode: x.bytecode }; };
const withErrors = (name, ...more) => { const x = artifact(name); return { abi: [...x.abi, ...errorsOf(...more)], bytecode: x.bytecode }; };

async function route(domain) {
  const r = { domain };
  r.mailbox = await c.deployRaw(mailboxArt(), [domain], 'gov');
  r.guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await r.guard.send('gov', 'createToken', ['ETH from Sepolia (bridged, testnet)', 'sepETH', 18]);
  r.token = await r.guard.call('token');
  r.airlock = await c.deploy('BridgeAirlock', [r.guard.address, ROUTE_IN, a('gov'), 2, Q], 'gov');
  r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  r.lane = await c.deploy('HyperlaneLane', [r.airlock.address, a('gov'), zMailbox.address, domain, '0x' + '00'.repeat(32), 0, ZERO, r.hypIsm.address], 'gov');
  r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [OURS.map((w) => w.address), 2], 'odeploy');
  const lbAt = getCreateAddress({ from: a('odeploy'), nonce: await c.nonce('odeploy') });
  r.outbox = await c.deployRaw(outboxArt(), [r.guard.address, ROUTE_OUT, zMailbox.address, domain, CHAIN, b32(lbAt), ZERO], 'gov');
  r.lockbox = await c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    r.ourIsm.address, a('gov'), a('guardian'), 5n * E, DELAY], 'odeploy');
  assert.equal(r.lockbox.address.toLowerCase(), lbAt.toLowerCase());
  await r.lane.send('gov', 'setConfig', [zMailbox.address, domain, b32(r.lockbox.address), CHAIN, r.lockbox.address]);
  await r.airlock.send('gov', 'setLane', [r.lane.address, true]);
  await r.airlock.send('gov', 'setLane', [a('lane2'), true]);
  await r.guard.send('gov', 'setAudit', AUDIT);
  await r.guard.send('gov', 'setGuardian', [a('guardian'), true]);
  await r.guard.send('gov', 'setRoute', [ROUTE_IN, r.airlock.address, 100n * E, true]);
  await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, 100n * E, true]);
  // the Gateways: ZETAPHY's first, then the source one naming it, then ZETAPHY's learns the source one (once)
  r.zgw = await c.deployRaw(withErrors('ZetaphyGateway', 'BridgeAirlock', 'BridgeGuard'), [r.token, r.outbox.address, r.airlock.address, r.lockbox.address, CHAIN], 'gdeploy');
  r.sgw = await c.deployRaw(withErrors('SaphanSourceGateway', 'HyperlaneLockBoxV2'), [r.lockbox.address, r.zgw.address, r.token, CHAIN], 'gdeploy');
  await r.zgw.send('gdeploy', 'setRemote', [r.sgw.address]);
  return r;
}

const lastMessage = (mb) => mb.call('lastMessage');
async function relayIn(r) { const m = await lastMessage(r.mailbox); return zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP]), m]); }
async function relayOut(r) { const m = await lastMessage(zMailbox); return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]); }
async function lastRelease() { const m = await lastMessage(zMailbox); return keccak256('0x' + m.slice(2 + 77 * 2)); }
const bal = (r, who) => c.callAt(r.token, TOKEN, 'balanceOf', [who.startsWith('0x') ? who : a(who)]);
const tuple = (res) => res.toArray(true);

/** alice calls `target` on ZETAPHY from the source chain; the lock is relayed and attested by both lanes, the quarantine passes. */
async function depositAndCall(r, target, { amount = E, fee = E / 100n, gas = 300_000n, revertTo = ZERO, callOnRevert = false, abortTo = ZERO,
  data = '0x1234', message = '0x', who = 'alice' } = {}) {
  const quote = await r.sgw.call('quoteDeposit', [amount]);
  const ev = await r.sgw.send(who, 'depositAndCall', [target, data, amount, fee, gas, revertTo, callOnRevert, abortTo, message], amount + quote + 7n);
  const d = ev.find((e) => e?.name === 'DepositAndCall').args;
  const n = (await r.lockbox.call('nonce')) - 1n;
  await relayIn(r);
  await r.airlock.send('lane2', 'attest', [CHAIN, r.lockbox.address, n, r.sgw.address, d.depositAddress, amount]);
  c.advance(Q);
  return { p: tuple(d.call), n, at: d.depositAddress, hash: d.callHash };
}

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'attacker', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor']);
  kit = kitArtifacts();
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
});

test('X -> ZETAPHY: one transaction locks, the route mints to the call\'s address, execute runs it once; the executor is paid in the token', async () => {
  const r = await route(SEPOLIA);
  const callee = await c.deployRaw(gatewayKit().KitCallee, [r.zgw.address], 'bob');
  const aliceBefore = await c.balance('alice');
  const { p, n, at, hash } = await depositAndCall(r, callee.address, { amount: 2n * E, fee: E / 50n });
  // what alice paid on X: the amount and the Mailbox fee (0 here); the extra 7 wei came back
  assert.equal(aliceBefore - (await c.balance('alice')), 2n * E);
  assert.equal(await r.lockbox.call('locked'), 2n * E);
  // the deposit address is the call's: CREATE2 of the ZETAPHY Gateway, salt = the call's hash
  const code = keccak256(solidityPacked(['bytes', 'bytes'], [artifact('SaphanDepositAddress').bytecode, abi.encode(['address'], [r.token])]));
  assert.equal(at, getCreate2Address(r.zgw.address, hash, code));
  assert.equal(at, await r.zgw.call('depositAddress', [p]));
  assert.equal(hash, await r.zgw.call('hashIn', [p]));
  assert.equal(G.hashIn(p), hash);
  assert.equal(G.depositAddressOf(artifact('SaphanDepositAddress').bytecode, r.zgw.address, hash, r.token), at);
  // before the airlock releases, nothing to run (and the address is not burned)
  await assert.rejects(r.zgw.send('executor', 'execute', [p, false, n]), /NotFunded/);
  // a wrong lock nonce names another transfer: the airlock refuses
  await assert.rejects(r.zgw.send('executor', 'execute', [p, true, n + 5n]), /NotReady/);
  const ev = await r.zgw.send('executor', 'execute', [p, true, n]);
  const x = ev.find((e) => e?.name === 'Executed').args;
  assert.equal(x.amount, 2n * E - E / 50n);
  assert.equal(await callee.call('calls'), 1n);
  assert.equal((await callee.call('lastSender')).toLowerCase(), a('alice').toLowerCase());
  assert.equal(await callee.call('lastSrc'), CHAIN);
  assert.equal(await callee.call('lastData'), '0x1234');
  assert.equal(await bal(r, callee.address), 2n * E - E / 50n);
  assert.equal(await bal(r, 'executor'), E / 50n, 'gas paid in what moved: no ZTPHY needed by alice');
  assert.equal(await bal(r, r.zgw.address), 0n);
  assert.notEqual(await c.getCode(at), '0x', 'the address is used up');
  // each call runs once
  await assert.rejects(r.zgw.send('executor', 'execute', [p, false, n]), /NotFunded/);
});

test('a changed call (target, amount, sender, data, fee) has another address: it finds no tokens and moves nothing', async () => {
  const r = await route(SEPOLIA);
  const kitc = gatewayKit().KitCallee;
  const callee = await c.deployRaw(kitc, [r.zgw.address], 'bob');
  const evil = await c.deployRaw(kitc, [r.zgw.address], 'attacker');
  const { p, n } = await depositAndCall(r, callee.address);
  await r.airlock.send('relayer', 'release', [CHAIN, r.lockbox.address, n, r.sgw.address, await r.zgw.call('depositAddress', [p]), E]);
  const forged = [
    Object.assign([...p], { 4: evil.address }),                // target
    Object.assign([...p], { 3: a('attacker') }),               // sender
    Object.assign([...p], { 6: E }),                           // fee: everything to the executor
    Object.assign([...p], { 11: '0xdead' }),                   // data
    Object.assign([...p], { 8: a('attacker') }),               // revertTo
  ];
  for (const f of forged) await assert.rejects(r.zgw.send('attacker', 'execute', [f, false, n]), /NotFunded|BadCall/);
  // another source Gateway, chain or a call naming this one but not sent through it
  await assert.rejects(r.zgw.send('attacker', 'execute', [Object.assign([...p], { 1: a('attacker') }), false, n]), /WrongGateway/);
  await assert.rejects(r.zgw.send('attacker', 'execute', [Object.assign([...p], { 0: 5n }), false, n]), /WrongGateway/);
  await r.zgw.send('executor', 'execute', [p, false, n]);
  assert.equal(await callee.call('calls'), 1n);
  assert.equal(await bal(r, evil.address), 0n);
});

test('the executor cannot starve the target: gas for it and what follows is checked first', async () => {
  const r = await route(SEPOLIA);
  const callee = await c.deployRaw(gatewayKit().KitCallee, [r.zgw.address], 'bob');
  const { p, n } = await depositAndCall(r, callee.address, { gas: 40_000_000n });
  await assert.rejects(r.zgw.send('executor', 'execute', [p, true, n]), /LowGas/);
  assert.equal(await r.zgw.call('depositAddress', [p]) !== ZERO, true);
});

test('a failing call goes back to X: plainly to revertTo after the lockbox\'s delay', async () => {
  const r = await route(SEPOLIA);
  const callee = await c.deployRaw(gatewayKit().KitCallee, [r.zgw.address], 'bob');
  await callee.send('bob', 'setFail', [true]);
  const { p, n } = await depositAndCall(r, callee.address, { amount: 3n * E, fee: E / 10n, revertTo: a('bob') });
  const ev = await r.zgw.send('executor', 'execute', [p, true, n]);
  assert.ok(ev.find((e) => e?.name === 'CallFailed'));
  const rv = ev.find((e) => e?.name === 'Reverted').args;
  assert.equal(rv.amount, 3n * E - E / 10n);
  assert.equal(await bal(r, callee.address), 0n, 'the target\'s tokens were taken back with its failed call');
  assert.equal(await bal(r, 'executor'), E / 10n, 'the executor is paid either way');
  assert.equal(await c.callAt(r.token, TOKEN, 'totalSupply'), E / 10n, 'the refund burned');
  const before = await c.balance('bob');
  await relayOut(r);
  const id = await lastRelease();
  c.advance(DELAY);
  await r.lockbox.send('relayer', 'claim', [id]);
  assert.equal((await c.balance('bob')) - before, 3n * E - E / 10n);
});

test('callOnRevert: the refund calls revertTo.onSaphanRevert on X with the call\'s nonce and message', async () => {
  const r = await route(SEPOLIA);
  const k = gatewayKit();
  const callee = await c.deployRaw(k.KitCallee, [r.zgw.address], 'bob');
  await callee.send('bob', 'setFail', [true]);
  const back = await c.deployRaw(k.KitReceiver, [r.sgw.address], 'bob');
  const message = hexlify(toUtf8Bytes('order 42'));
  const { p, n } = await depositAndCall(r, callee.address, { amount: E, fee: 0n, revertTo: back.address, callOnRevert: true, message });
  const ev = await r.zgw.send('executor', 'execute', [p, true, n]);
  const rv = ev.find((e) => e?.name === 'Reverted').args;
  assert.equal(rv.withCall, true);
  const sent = ev.find((e) => e?.name === 'OutCallSent').args;
  assert.equal(sent.callHash, rv.outHash);
  assert.equal(G.hashOut(G.revertOutCall(p, { zetaphyGateway: r.zgw.address, outNonce: 0n, amount: E })), rv.outHash);
  // the REVERT out call, as the executor on X rebuilds it
  const o = tuple(await r.zgw.call('outCall', [0n, a('alice'), back.address, E, 0n, p[7], back.address, 1, abi.encode(['uint256', 'bytes'], [p[2], message])]));
  assert.equal(await r.sgw.call('hashOut', [o]), rv.outHash);
  await relayOut(r);
  const id = await lastRelease();
  await assert.rejects(r.lockbox.send('executor', 'claim', [id]), /NotReady/);
  await assert.rejects(r.sgw.send('executor', 'execute', [o]), /NotFunded/);
  c.advance(DELAY);
  await r.lockbox.send('executor', 'claim', [id]);   // the lockbox pays the deposit address
  await r.sgw.send('executor', 'execute', [o]);
  assert.equal(await back.call('got'), E);
  assert.equal(await back.call('revertNonce'), p[2]);
  assert.equal(await back.call('revertMessage'), message);
  assert.equal((await back.call('revertSender')).toLowerCase(), a('alice').toLowerCase());
});

test('abort: when the way back is closed, the tokens wait on ZETAPHY for abortTo', async () => {
  const r = await route(SEPOLIA);
  const callee = await c.deployRaw(gatewayKit().KitCallee, [r.zgw.address], 'bob');
  await callee.send('bob', 'setFail', [true]);
  const { p, n } = await depositAndCall(r, callee.address, { amount: E, fee: 0n, abortTo: a('bob') });
  await r.guard.send('guardian', 'disableRoute', [ROUTE_OUT]);                    // outbound closed
  const ev = await r.zgw.send('executor', 'execute', [p, true, n]);
  assert.equal(ev.find((e) => e?.name === 'Aborted').args.amount, E);
  assert.equal(await r.zgw.call('aborted', [a('bob')]), E);
  await assert.rejects(r.zgw.send('alice', 'claimAborted', []));
  await r.zgw.send('bob', 'claimAborted', []);
  assert.equal(await bal(r, 'bob'), E);
  assert.equal(await r.zgw.call('aborted', [a('bob')]), 0n);
});

test('a refund to X needs its Mailbox fee from the executor (it cannot push the user into abort by paying nothing)', async () => {
  const r = await route(SEPOLIA);
  const callee = await c.deployRaw(gatewayKit().KitCallee, [r.zgw.address], 'bob');
  await callee.send('bob', 'setFail', [true]);
  const { p, n } = await depositAndCall(r, callee.address, { amount: E, fee: 0n });
  await zMailbox.send('gov', 'setFee', [1000n]);
  await assert.rejects(r.zgw.send('executor', 'execute', [p, true, n]), /Fee/);
  const before = await c.balance('executor');
  await r.zgw.send('executor', 'execute', [p, true, n], 5000n);
  assert.equal(before - (await c.balance('executor')), 1000n, 'only the fee; the rest came back');
});

test('ZETAPHY -> X: withdrawAndCall burns, the lockbox pays the call\'s address after the delay, execute calls the receiver with ETH', async () => {
  const r = await route(SEPOLIA);
  const k = gatewayKit();
  const callee = await c.deployRaw(k.KitCallee, [r.zgw.address], 'bob');
  const recv = await c.deployRaw(k.KitReceiver, [r.sgw.address], 'bob');
  // alice gets 2 sepETH on ZETAPHY through a call to a contract that just keeps them... then a plain route mint:
  const { p, n } = await depositAndCall(r, callee.address, { amount: 2n * E, fee: 0n });
  await r.zgw.send('executor', 'execute', [p, true, n]);
  // the callee holds the tokens; give alice some the plain way for the way back
  const lockFee = await r.lockbox.call('quoteLock', [a('alice'), 2n * E]);
  await r.lockbox.send('alice', 'lock', [a('alice'), 2n * E], 2n * E + lockFee);
  const ln = (await r.lockbox.call('nonce')) - 1n;
  await relayIn(r);
  const t = [CHAIN, r.lockbox.address, ln, a('alice'), a('alice'), 2n * E];
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
  assert.ok((await c.rawTx('alice', r.token, TOKEN.encodeFunctionData('approve', [r.zgw.address, 2n * E]))).ok);
  const ev = await r.zgw.send('alice', 'withdrawAndCall', [recv.address, '0xbeef', 3n * E / 2n, E / 100n, 200_000n, a('alice')]);
  const s = ev.find((e) => e?.name === 'OutCallSent').args;
  assert.equal(await bal(r, 'alice'), E / 2n);
  const o = tuple(s.call);
  assert.deepEqual(o, tuple(await r.zgw.call('outCall', [s.nonce, a('alice'), recv.address, 3n * E / 2n, E / 100n, 200_000n, a('alice'), 0, '0xbeef'])));
  assert.equal(await r.sgw.call('depositAddress', [o]), s.depositAddress);
  // the executor's own arithmetic (src/saphangateway.js) agrees with the contracts
  assert.equal(G.hashOut(o), s.callHash);
  assert.equal(G.depositAddressOf(artifact('SaphanDepositAddress').bytecode, r.sgw.address, s.callHash, ZERO), s.depositAddress);
  await relayOut(r);
  const id = await lastRelease();
  await assert.rejects(r.sgw.send('executor', 'execute', [o]), /NotFunded/);
  c.advance(DELAY);
  const exBefore = await c.balance('executor');
  await r.lockbox.send('relayer', 'claim', [id]);
  assert.equal(await c.balance(Address.fromString(s.depositAddress)), 3n * E / 2n, 'the lockbox paid the call\'s address');
  await r.sgw.send('executor', 'execute', [o]);
  assert.equal(await recv.call('got'), 3n * E / 2n - E / 100n);
  assert.equal((await recv.call('lastSender')).toLowerCase(), a('alice').toLowerCase());
  assert.equal(await recv.call('lastSrc'), CHAIN);
  assert.equal(await recv.call('lastData'), '0xbeef');
  assert.equal((await c.balance('executor')) - exBefore, E / 100n, 'the executor is paid in ETH on X');
  await assert.rejects(r.sgw.send('executor', 'execute', [o]), /NotFunded|BadCall/);
  assert.equal(await r.sgw.call('owed', [a('alice')]), 0n, 'a call that went through owes nothing');
  // a forged out call (another target) has another address: nothing there
  await assert.rejects(r.sgw.send('attacker', 'execute', [Object.assign([...o], { 5: a('attacker') })]), /NotFunded/);
  await assert.rejects(r.sgw.send('attacker', 'execute', [Object.assign([...o], { 2: a('attacker') })]), /WrongGateway/);
});

test('ZETAPHY -> X: a failing receiver leaves the ETH for revertTo on X, who claims it', async () => {
  const r = await route(SEPOLIA);
  const k = gatewayKit();
  const recv = await c.deployRaw(k.KitReceiver, [r.sgw.address], 'bob');
  await recv.send('bob', 'setFail', [true]);
  const refuser = await c.deployRaw(k.KitRefuser, [], 'bob');
  // alice gets 2 sepETH on ZETAPHY the plain way
  const lockFee = await r.lockbox.call('quoteLock', [a('alice'), 2n * E]);
  await r.lockbox.send('alice', 'lock', [a('alice'), 2n * E], 2n * E + lockFee);
  const t = [CHAIN, r.lockbox.address, 0n, a('alice'), a('alice'), 2n * E];
  await relayIn(r);
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
  assert.ok((await c.rawTx('alice', r.token, TOKEN.encodeFunctionData('approve', [r.zgw.address, 2n * E]))).ok);
  const before = await c.balance('bob');
  for (const revertTo of [a('bob'), refuser.address]) {
    const ev = await r.zgw.send('alice', 'withdrawAndCall', [recv.address, '0x', E, 0n, 100_000n, revertTo]);
    const s = ev.find((e) => e?.name === 'OutCallSent').args;
    const o = tuple(s.call);
    await relayOut(r);
    const id = await lastRelease();
    c.advance(DELAY);
    await r.lockbox.send('relayer', 'claim', [id]);
    const x = await r.sgw.send('executor', 'execute', [o]);
    assert.ok(x.find((e) => e?.name === 'CallFailed'));
  }
  assert.equal(await r.sgw.call('owed', [a('bob')]), E);
  assert.equal(await r.sgw.call('owed', [refuser.address]), E);
  await assert.rejects(r.sgw.send('attacker', 'claim', []));
  await r.sgw.send('bob', 'claim', []);
  assert.ok((await c.balance('bob')) - before > E - E / 100n, 'bob has it (less his gas)');
  assert.equal(await r.sgw.call('owed', [a('bob')]), 0n);
  assert.equal(await recv.call('got'), 0n);
  // what is owed stays in the Gateway through later calls (a caller gets only its own change back)
  const ev = await r.sgw.send('alice', 'depositAndCall', [a('bob'), '0x', E / 10n, 0n, 1n, ZERO, false, ZERO, '0x'], E);
  assert.ok(ev.find((e) => e?.name === 'DepositAndCall'));
  assert.equal(await c.balance(Address.fromString(r.sgw.address)), E, 'the refuser\'s E is still there');
  assert.equal(await r.sgw.call('owed', [refuser.address]), E);
});

test('inputs: no target, a fee over the amount, a missing remote; setRemote once by the deployer only', async () => {
  const r = await route(SEPOLIA);
  await assert.rejects(r.sgw.send('alice', 'depositAndCall', [ZERO, '0x', E, 0n, 1n, ZERO, false, ZERO, '0x'], 2n * E), /BadCall/);
  await assert.rejects(r.sgw.send('alice', 'depositAndCall', [a('bob'), '0x', E, 2n * E, 1n, ZERO, false, ZERO, '0x'], 2n * E), /BadCall/);
  await assert.rejects(r.sgw.send('alice', 'depositAndCall', [a('bob'), '0x', E, 0n, 1n, ZERO, false, ZERO, '0x'], E - 1n), /Fee/);
  await assert.rejects(r.zgw.send('gdeploy', 'setRemote', [a('attacker')]));
  const z2 = await c.deploy('ZetaphyGateway', [r.token, r.outbox.address, r.airlock.address, r.lockbox.address, CHAIN], 'gdeploy');
  await assert.rejects(z2.send('attacker', 'setRemote', [a('attacker')]));
  await assert.rejects(z2.send('alice', 'withdrawAndCall', [a('bob'), '0x', E, 0n, 1n, a('alice')]), /WrongGateway/);
});

test('the executor\'s plan (src/saphangateway.js): runs what is funded or due, waits for the rest, skips what ran', async () => {
  const r = await route(SEPOLIA);
  const k = gatewayKit();
  const callee = await c.deployRaw(k.KitCallee, [r.zgw.address], 'bob');
  const one = await depositAndCall(r, callee.address);
  const two = await depositAndCall(r, callee.address, { amount: E / 2n });
  const code = artifact('SaphanDepositAddress').bytecode;
  const read = {
    usedOnZetaphy: async (at) => (await c.getCode(at)) !== '0x',
    tokenBalance: (at) => bal(r, at),
    airlockReady: async (p, at, n) => (await c.staticCall(a('executor'), r.zgw.address, r.zgw.iface.encodeFunctionData('execute', [Object.values(G.inCall(p)), true, n]))).ok,
  };
  const args = { depositInitCode: code, zetaphyGateway: r.zgw.address, sourceGateway: r.sgw.address, remoteToken: r.token, now: c.now(), read };
  // the first is released by someone; the second is due at the airlock
  await r.airlock.send('relayer', 'release', [CHAIN, r.lockbox.address, one.n, r.sgw.address, one.at, E]);
  let pl = await G.plan({ ...args, inbound: [{ call: one.p, lockNonce: one.n }, { call: two.p, lockNonce: two.n }, { call: Object.assign([...two.p], { 5: 9n * E }), lockNonce: two.n }] });
  assert.deepEqual(pl.run.map((x) => [x.at, x.args[1]]), [[one.at, false], [two.at, true]]);
  assert.equal(pl.wait.length, 1, 'a call nobody locked waits');
  for (const x of pl.run) await r.zgw.send('executor', x.fn, x.args);
  assert.equal(await callee.call('calls'), 2n);
  pl = await G.plan({ ...args, inbound: [{ call: one.p, lockNonce: one.n }, { call: two.p, lockNonce: two.n }] });
  assert.deepEqual(pl, { run: [], wait: [] }, 'what ran is skipped');
});

test('deploy script: a read right after a deploy waits out a lagging RPC node (empty answer), not other errors', async () => {
  const { settled } = await import('../scripts/saphan.js');
  let n = 0;
  const empty = () => Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA' });
  assert.equal(await settled('read', async () => { if (++n < 3) throw empty(); return 7; }, { ms: 1 }), 7);
  assert.equal(n, 3);
  await assert.rejects(settled('read', async () => { throw new Error('execution reverted'); }, { ms: 1 }), /read: execution reverted/);
  n = 0;
  await assert.rejects(settled('read', async () => { n++; throw empty(); }, { tries: 4, ms: 1 }), /read: could not decode/);
  assert.equal(n, 4, 'gives up after its tries');
});
