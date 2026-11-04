// Saphan PR 5, cross-chain reads (contracts/SaphanReads.sol): "what is value V on chain X at block B".
//   lane answers:   SaphanReadResponder on X runs a view call and sends (result, block, time) through X's Mailbox;
//                   ZETAPHY's Mailbox checks the route's ISM (Hyperlane's validators) before SaphanReads records it.
//   proven answers: a slot / account of X against X's state root at block B (a light client; here KitStateRoots),
//                   with real Merkle-Patricia proofs taken from the test EVM's own state (eth_getProof format).
//   the other way:  SaphanZetaphyReads on X proves a ZETAPHY storage slot from ZETAPHY's state (IAVL + multistore)
//                   at a height the STARK light client finalized (here KitLightClient; the STARK is in starkbridge.test.js).
// The caller pays a bounty; answers carry their block; stale answers are refused.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getCreateAddress, keccak256, AbiCoder, hexlify, toBeHex } from 'ethers';
import { createChain } from './helpers/evm.js';
import { compileHelper, zetaphyBlock } from './helpers/starkbridge.js';
import { saphanWorld, pr5Kit, withAbi, SEPOLIA, ZETAPHY, CHAIN, E, ZERO, b32 } from './helpers/saphanroute.js';
import { validator } from './helpers/hyperlanekit.js';
import { stateProofArgs } from '../src/saphanproofs.js';
import * as R from '../src/saphanreads.js';

const abi = AbiCoder.defaultAbiCoder();
let c, w, r, k;
const a = (n) => c.acct[n].toString();
const TARGET = () => new Interface(k.KitReadTarget.abi);

async function setup({ withRoots = true } = {}) {
  r = await w.route(SEPOLIA);
  k = pr5Kit();
  const roots = withRoots ? await c.deployRaw(k.KitStateRoots, [], 'gov') : null;
  const reads = await c.deployRaw(withAbi('SaphanReads'), [CHAIN, w.zMailbox.address, SEPOLIA, r.hypIsm.address, roots?.address ?? ZERO], 'rdeploy');
  const responder = await c.deployRaw(withAbi('SaphanReadResponder'), [r.mailbox.address, ZETAPHY, reads.address], 'rdeploy');
  await assert.rejects(reads.send('attacker', 'setResponder', [a('attacker')]));
  await reads.send('rdeploy', 'setResponder', [responder.address]);
  await assert.rejects(reads.send('rdeploy', 'setResponder', [a('attacker')]), 'set once');
  const target = await c.deployRaw(k.KitReadTarget, [], 'bob');
  return { reads, responder, roots, target };
}

/** bob answers target.call(data) on X; returns the message the relayer would carry (and the X block of the answer). */
let lastAnswerBlock;
async function answer(s, data, who = 'bob') {
  const fee = await s.responder.call('quote', [s.target.address, data]);
  lastAnswerBlock = c.blockNumber();
  await s.responder.send(who, 'answer', [s.target.address, data], fee);
  return w.lastMessage(r.mailbox);
}

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'carol', 'attacker', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor', 'rdeploy']);
  w = await saphanWorld(c);
});

test('lane answer: a view call on X answered through Hyperlane, with its block; the requester\'s bounty goes to the answerer', async () => {
  const s = await setup();
  await s.target.send('bob', 'set', [42n]);
  const data = TARGET().encodeFunctionData('value');
  const q = R.callQuery(CHAIN, s.target.address, data);
  assert.equal(q, await s.reads.call('callQuery', [s.target.address, data]));
  // alice asks (and pays): an answer from block >= now, within an hour
  const minBlock = c.blockNumber();
  const ev = await s.reads.send('alice', 'requestCall', [s.target.address, data, minBlock, 3600n], E / 10n);
  const req = ev.find((e) => e?.name === 'Requested').args;
  assert.equal(req.query, q);
  assert.equal(req.data, data, 'answerers find the question in the event');
  await assert.rejects(s.reads.call('read', [q, 0n, 3600n]), /NoAnswer/);
  await assert.rejects(s.reads.send('carol', 'collect', [req.id]), /NotReady/);
  const m = await answer(s, data);
  const answeredAt = lastAnswerBlock;
  // nobody but the Mailbox hands answers in, and only the ISM's validators' signatures pass
  await assert.rejects(s.reads.send('attacker', 'handle', [SEPOLIA, b32(s.responder.address), '0x']), /NotMailbox/);
  await assert.rejects(w.process(m, [validator(9)]));
  const got = await w.process(m);
  assert.ok(got.length >= 1);
  const [res, blockNumber] = await s.reads.call('readCall', [s.target.address, data, minBlock, 3600n]);
  assert.equal(abi.decode(['uint256'], res)[0], 42n);
  assert.equal(blockNumber, answeredAt, 'the answer carries the X block it is from');
  // the bounty: whoever brought the answer (bob, attested on X), collected by anyone, claimed by bob
  await s.reads.send('carol', 'collect', [req.id]);
  await assert.rejects(s.reads.send('carol', 'collect', [req.id]), /BadRequest/);
  assert.equal(await s.reads.call('credit', [a('bob')]), E / 10n);
  const before = await c.balance('bob');
  await s.reads.send('bob', 'claim', []);
  assert.equal((await c.balance('bob')) - before, E / 10n);
  await assert.rejects(s.reads.send('bob', 'claim', []), /NotReady/);
});

test('stale answers are refused: too old a block, too old a time; an older answer never replaces a newer one', async () => {
  const s = await setup();
  const data = TARGET().encodeFunctionData('value');
  const q = R.callQuery(CHAIN, s.target.address, data);
  await s.target.send('bob', 'set', [1n]);
  const m1 = await answer(s, data);
  const b1 = lastAnswerBlock;
  c.advance(60);
  await s.target.send('bob', 'set', [2n]);
  const m2 = await answer(s, data);
  const b2 = lastAnswerBlock;
  await w.process(m2);
  // the older answer arrives late: consumed (the Mailbox is not blocked) but ignored
  const ev = await w.process(m1);
  assert.equal(ev.length >= 1, true);
  const [ok, res, bn] = await s.reads.call('read', [q, 0n, 3600n]);
  assert.ok(ok);
  assert.equal(abi.decode(['uint256'], res)[0], 2n);
  assert.equal(bn, b2);
  assert.ok(b2 > b1);
  // the caller decides what is fresh enough
  await assert.rejects(s.reads.call('read', [q, b2 + 1n, 3600n]), /Stale/);
  c.advance(3601);
  await assert.rejects(s.reads.call('read', [q, 0n, 3600n]), /Stale/);
  await s.reads.call('read', [q, 0n, 7200n]);
  // only the responder may speak for X: an answer body sent by anyone else on X is refused
  const fake = abi.encode(['address', 'bytes32', 'uint64', 'uint64', 'bool', 'bytes', 'address'],
    [s.target.address, keccak256(data), b2 + 100n, c.now() + 86400n, true, abi.encode(['uint256'], [9n]), a('attacker')]);
  await r.mailbox.send('attacker', 'dispatch(uint32,bytes32,bytes)', [ZETAPHY, b32(s.reads.address), fake]);
  await assert.rejects(w.process(await w.lastMessage(r.mailbox)), /WrongSender/);
});

test('a reverting call is answered as reverted; too long a result counts as a failed call; the answerer cannot starve a read', async () => {
  const s = await setup();
  const boom = TARGET().encodeFunctionData('boom');
  await w.process(await answer(s, boom));
  const [ok] = await s.reads.call('read', [R.callQuery(CHAIN, s.target.address, boom), 0n, 3600n]);
  assert.equal(ok, false);
  await assert.rejects(s.reads.call('readCall', [s.target.address, boom, 0n, 3600n]), /CallReverted/);
  const big = TARGET().encodeFunctionData('big');
  await w.process(await answer(s, big));
  const [okBig, resBig] = await s.reads.call('read', [R.callQuery(CHAIN, s.target.address, big), 0n, 3600n]);
  assert.equal(okBig, false);
  assert.equal(resBig, '0x');
  // given less gas than the read's fixed budget, the answer is refused outright (no "reverted" answer is made)
  const gc = await c.deployRaw(k.KitGasCaller, [], 'bob');
  const iface = new Interface(withAbi('SaphanReadResponder').abi);
  const val = TARGET().encodeFunctionData('value');
  const res = await c.rawTx('attacker', gc.address, gc.iface.encodeFunctionData('call', [s.responder.address, iface.encodeFunctionData('answer', [s.target.address, val]), 200_000n]));
  assert.equal(res.ok, false);
  assert.equal(iface.parseError(res.returnHex)?.name, 'LowGas');
  // the Mailbox fee is exact
  await r.mailbox.send('gov', 'setFee', [5n]);
  await assert.rejects(s.responder.send('bob', 'answer', [s.target.address, val], 4n), /Fee/);
  await assert.rejects(s.responder.send('bob', 'answer', [s.target.address, val], 6n), /Fee/);
  await s.responder.send('bob', 'answer', [s.target.address, val], 5n);
});

test('an unanswered request is refunded to its requester after it expires (and only then, only to it)', async () => {
  const s = await setup();
  const data = TARGET().encodeFunctionData('value');
  await assert.rejects(s.reads.send('alice', 'requestCall', [s.target.address, data, 0n, 3600n], 0n), /BadRequest/);
  await assert.rejects(s.reads.send('alice', 'requestCall', [s.target.address, data, 0n, 8n * 86400n], 1n), /BadRequest/);
  const ev = await s.reads.send('alice', 'requestCall', [s.target.address, data, c.blockNumber() + 1000n, 600n], E);
  const id = ev.find((e) => e?.name === 'Requested').args.id;
  // an answer too old for the request does not earn its bounty
  await w.process(await answer(s, data));
  await assert.rejects(s.reads.send('bob', 'collect', [id]), /NotReady/);
  await assert.rejects(s.reads.send('alice', 'cancel', [id]), /NotReady/);
  c.advance(601);
  await assert.rejects(s.reads.send('attacker', 'cancel', [id]), /BadRequest/);
  await s.reads.send('alice', 'cancel', [id]);
  const before = await c.balance('alice');
  await s.reads.send('alice', 'claim', []);
  assert.equal((await c.balance('alice')) - before, E);
});

test('proven answers: a slot, a mapping entry and a balance of X from real Merkle-Patricia proofs under X\'s state root', async () => {
  const s = await setup();
  await s.target.send('bob', 'set', [123456789n]);
  await s.target.send('bob', 'setBalance', [a('alice'), 77n * E]);
  const root = await c.stateRoot();
  const B = 500n;
  const balSlot = R.mappingSlot(a('alice'), 1n);
  const proof = await c.getProof(s.target.address, [0n, balSlot, 9n]);
  const aliceProof = await c.getProof(a('alice'));
  const aliceBalance = await c.balance('alice');
  await s.roots.send('gov', 'set', [B, root, c.now()]); // the light client accepts X's block B (after the proofs were taken)
  // the state moves on; the proofs stay those of block B
  await s.target.send('bob', 'set', [1n]);
  const ev = await s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B, proof, 0n));
  assert.equal(ev.find((e) => e?.name === 'Answered').args.proven, true);
  const [v, bn] = await s.reads.call('readSlot', [s.target.address, b32('0x00'), B, 600n]);
  assert.equal(v, 123456789n);
  assert.equal(bn, B);
  await s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B, proof, balSlot));
  assert.equal((await s.reads.call('readSlot', [s.target.address, balSlot, 0n, 600n]))[0], 77n * E);
  // a slot never written: proven to be zero (a proof of absence)
  await s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B, proof, 9n));
  assert.equal((await s.reads.call('readSlot', [s.target.address, b32('0x09'), 0n, 600n]))[0], 0n);
  await s.reads.send('carol', 'proveAccount', R.proveAccountArgs(B, aliceProof));
  assert.equal((await s.reads.call('readBalance', [a('alice'), B, 600n]))[0], aliceBalance);
  assert.equal(R.slotQuery(CHAIN, s.target.address, 0n), await s.reads.call('slotQuery', [s.target.address, b32('0x00')]));
  // the same block again, an unknown block, a forged value, a proof of another slot
  await assert.rejects(s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B, proof, 0n)), /Older/);
  await assert.rejects(s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B + 1n, proof, 0n)), /UnknownBlock/);
  const sp = proof.storageProof[0].proof;
  const leaf = sp[sp.length - 1];
  const forged = [...sp.slice(0, -1), leaf.slice(0, -2) + (leaf.slice(-2) === '01' ? '02' : '01')];
  const args = R.proveSlotArgs(B + 0n, proof, 0n);
  args[4] = forged;
  await s.roots.send('gov', 'set', [B + 1n, root, c.now()]);
  args[0] = B + 1n;
  await assert.rejects(s.reads.send('carol', 'proveSlot', args), /BadProof/);
  const other = R.proveSlotArgs(B + 1n, proof, balSlot);
  other[2] = b32('0x00'); // the mapping entry's proof handed in for slot 0
  await assert.rejects(s.reads.send('carol', 'proveSlot', other), /BadProof/);
  const wrongAccount = R.proveSlotArgs(B + 1n, proof, 0n);
  wrongAccount[1] = a('carol');
  await assert.rejects(s.reads.send('carol', 'proveSlot', wrongAccount), /BadProof/);
  // a proven answer earns a bounty like a lane answer
  const req = (await s.reads.send('alice', 'requestSlot', [s.target.address, b32('0x00'), B + 1n, 600n], 3n)).find((e) => e?.name === 'Requested').args;
  await s.reads.send('carol', 'proveSlot', R.proveSlotArgs(B + 1n, proof, 0n));
  await s.reads.send('carol', 'collect', [req.id]);
  assert.equal(await s.reads.call('credit', [a('carol')]), 3n);
});

test('without a light client of X, proven answers are off (lane answers only)', async () => {
  const s = await setup({ withRoots: false });
  const proof = await c.getProof(s.target.address, [0n]);
  await assert.rejects(s.reads.send('carol', 'proveSlot', R.proveSlotArgs(1n, proof, 0n)), /NoLightClient/);
});

test('the other way: a ZETAPHY storage slot proven on X from ZETAPHY\'s state at a final height', async () => {
  const lc = await c.deployRaw(compileHelper('SafetyKit.sol').KitLightClient, [], 'gov');
  const proofs = await c.deploy('ZetaphyBridgeInbox', [lc.address, CHAIN, a('gov'), ZERO, a('gov'), a('gov'), ZERO, 0n], 'gov');
  const zr = await c.deployRaw(withAbi('SaphanZetaphyReads'), [lc.address, proofs.address], 'gov');
  const contract = getCreateAddress({ from: a('bob'), nonce: 7 });
  const value = toBeHex(12345n * E, 32);
  const slot = 3n;
  const blk = zetaphyBlock({ chainId: 'zetaphy_77390-1', height: 900n, slots: [{ address: contract, slot, value }] });
  await lc.send('gov', 'set', [900n, hexlify(blk.appHash)]);
  const { iavl, storeOps } = blk.prove(contract, slot);
  const [v, prefix, path, store] = stateProofArgs(iavl, storeOps);
  assert.equal(v, value);
  const args = (h, minH, slotHex, v) => [h, minH, contract, slotHex, v, prefix, path, store];
  // a wrong value, the wrong slot, a height the light client does not know, a reader wanting a newer height
  await assert.rejects(zr.call('verify', args(900n, 0n, b32('0x03'), b32('0x01'))), /BadStateProof/);
  await assert.rejects(zr.call('verify', args(900n, 0n, b32('0x04'), value)), /BadStateProof/);
  await assert.rejects(zr.call('verify', args(901n, 0n, b32('0x03'), value)), /BadStateProof/);
  await assert.rejects(zr.call('verify', args(900n, 901n, b32('0x03'), value)), /Stale/);
  assert.equal(await zr.call('verify', args(900n, 900n, b32('0x03'), value)), value);
});
