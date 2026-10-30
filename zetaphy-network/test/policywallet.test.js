// Guardrails for AI-driven wallets (AgentPolicyWallet) and the AI co-signer (CosignCommittee +
// src/cosign.js): caps per period, allow-lists, timelock or committee co-signatures above a threshold,
// emergency freeze by the owner's account, passkey (P-256) or ML-DSA-44 key. Co-signatures: k-of-n ECDSA,
// or one FROST threshold signature (RFC 9591; DKG without a dealer, src/frost.js) checked on chain.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, id as textHash, Interface, ZeroHash } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, passkey, mldsaKey } from './helpers/precompiles.js';
import { dexArt, agentKit } from './helpers/mocks.js';
import { runDkg } from './helpers/frost.js';
import { cosignDigest, signCosign, combine, review, touched } from '../src/cosign.js';
import { signRound1, signingPackage, signRound2, aggregateShares } from '../src/frost.js';

const HOUR = 3600, DAY = 86_400;
const NATIVE = '0x' + '00'.repeat(20);
const MODEL = textHash('anthropic/claude-sonnet-5-5'), PROMPT = textHash('rebalance');
const TOKEN = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)', 'function transferFrom(address,address,uint256)',
  'function increaseAllowance(address,uint256)', 'function setApprovalForAll(address,bool)']);
const runners = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
let c, w, committee, tok, sink, key, pq;
const addr = (n) => c.acct[n].toString();

beforeEach(async () => {
  c = await createChain(['owner', 'agent', 'gov', 'bob', 'thief', 'relay'], {}, { precompiles: PRECOMPILES });
  const wa = await c.deploy('WebAuthnVerifier', [], 'gov');
  committee = await c.deploy('CosignCommittee', [addr('gov'), runners.map((r) => r.address), 2n], 'gov');
  w = await c.deploy('AgentPolicyWallet', [addr('owner'), addr('agent'), committee.address, wa.address, BigInt(DAY), BigInt(HOUR)], 'owner');
  await w.sendValue('owner', 100n * ZETA);
  tok = await c.deployRaw(dexArt('TestToken'), ['Token', 'TK', 18, 10_000n * ZETA, 0], 'owner');
  await tok.send('owner', 'transfer', [w.address, 5000n * ZETA]);
  sink = await c.deployRaw(agentKit().Sink, [], 'owner');
  await w.send('owner', 'setLimit', [NATIVE, 10n * ZETA, 3n * ZETA]);
  await w.send('owner', 'setLimit', [tok.address, 1000n * ZETA, 300n * ZETA]);
  await w.send('owner', 'setAllowed', [addr('bob'), false, true]);
  await w.send('owner', 'setAllowed', [sink.address, true, false]);
  await w.send('owner', 'setAllowedCall', [sink.address, sink.iface.getFunction('poke').selector, true]); // APW-1: per (target, selector)
  key = passkey('app.sawasdeecoin.com');
  pq = mldsaKey();
  await w.send('owner', 'setEmergencyKeys', [pq.keyHash, key.x, key.y, key.rpIdHash]);
});

const exec = (to, value, data = '0x', from = 'agent') => w.send(from, 'execute', [to, value, data, MODEL, PROMPT]);
const xfer = (to, amount) => TOKEN.encodeFunctionData('transfer', [to, amount]);

test('native: allow-listed recipients only, per-action threshold, a cap per period that resets', async () => {
  const before = await c.balance('bob');
  const ev = await exec(addr('bob'), 2n * ZETA);
  assert.equal(await c.balance('bob') - before, 2n * ZETA);
  const a = ev.find((e) => e?.name === 'AgentAction');
  assert.equal(a.args.modelHash, MODEL);
  assert.equal(a.args.promptHash, PROMPT);
  await assert.rejects(exec(addr('thief'), 1n), /NotAllowed/);
  await assert.rejects(exec(addr('bob'), 1n, '0x', 'thief'), /NotAgent/);
  await assert.rejects(exec(addr('bob'), 4n * ZETA), /NeedsDelayOrCosign/);
  await exec(addr('bob'), 3n * ZETA);
  await exec(addr('bob'), 3n * ZETA);
  await assert.rejects(exec(addr('bob'), 3n * ZETA), /OverCap/); // 2+3+3+3 > 10
  assert.equal(await w.call('remaining', [NATIVE]), 2n * ZETA);
  c.advance(DAY);
  await exec(addr('bob'), 3n * ZETA);
});

test('ERC-20: capped tokens only, transfers to listed recipients, approvals to listed contracts; pulls refused', async () => {
  await exec(tok.address, 0n, xfer(addr('bob'), 100n * ZETA));
  assert.equal(await tok.call('balanceOf', [addr('bob')]), 100n * ZETA);
  await assert.rejects(exec(tok.address, 0n, xfer(addr('thief'), 1n)), /NotAllowed/);
  await assert.rejects(exec(tok.address, 0n, xfer(addr('bob'), 301n * ZETA)), /NeedsDelayOrCosign/);
  await exec(tok.address, 0n, TOKEN.encodeFunctionData('approve', [sink.address, 200n * ZETA])); // counts toward the cap
  await assert.rejects(exec(tok.address, 0n, TOKEN.encodeFunctionData('approve', [addr('thief'), 1n])), /NotAllowed/);
  for (const d of [TOKEN.encodeFunctionData('transferFrom', [w.address, addr('thief'), 1n]), TOKEN.encodeFunctionData('increaseAllowance', [sink.address, 1n]),
    TOKEN.encodeFunctionData('setApprovalForAll', [sink.address, true])]) await assert.rejects(exec(tok.address, 0n, d), /Forbidden/);
  const other = await c.deployRaw(dexArt('TestToken'), ['Other', 'OT', 18, 1000n * ZETA, 0], 'owner');
  await other.send('owner', 'transfer', [w.address, 10n * ZETA]);
  await assert.rejects(exec(other.address, 0n, xfer(addr('bob'), 1n)), /NoLimit/);
  // contract calls: allow-listed contracts only; value counts as native spending
  await exec(sink.address, 1n * ZETA, sink.iface.encodeFunctionData('poke', ['0x01']));
  assert.equal(await sink.call('calls'), 1n);
  await assert.rejects(exec(addr('thief'), 0n, sink.iface.encodeFunctionData('poke', ['0x01'])), /NotAllowed/);
  // APW-1: a function of an allowed contract runs only if that (target, selector) pair is allowed, and
  // transfer-like functions (ERC-721/1155 safeTransferFrom, ERC-777 send, transferAndCall, DAI move/pull, ...)
  // can never be allowed
  const NFT = new Interface(['function safeTransferFrom(address,address,uint256)', 'function transferAndCall(address,uint256,bytes)', 'function pull(address,uint256)']);
  await w.send('owner', 'setAllowed', [tok.address, true, false]);
  for (const d of [NFT.encodeFunctionData('safeTransferFrom', [w.address, addr('thief'), 1n]), NFT.encodeFunctionData('transferAndCall', [addr('thief'), 1n, '0x']),
    NFT.encodeFunctionData('pull', [w.address, 1n])]) {
    await assert.rejects(exec(tok.address, 0n, d), /Forbidden/);
    await assert.rejects(w.send('owner', 'setAllowedCall', [tok.address, d.slice(0, 10), true]), /Forbidden/);
  }
  await assert.rejects(exec(tok.address, 0n, TOKEN.encodeFunctionData('setApprovalForAll', [sink.address, true]).replace(/^0xa22cb465/, '0x12345678')), /SelectorNotAllowed/);
  assert.equal(await w.call('remaining', [tok.address]), 700n * ZETA);
});

test('above the threshold, path 1: the timelock (the owner may cancel; a freeze stops it)', async () => {
  const ev = await w.send('agent', 'queue', [addr('bob'), 5n * ZETA, '0x', MODEL, PROMPT]);
  const q = ev.find((e) => e?.name === 'Queued').args;
  const args = [q.seq, addr('bob'), 5n * ZETA, '0x', MODEL, PROMPT];
  await assert.rejects(w.send('agent', 'executeQueued', args), /NotReady/);
  c.advance(HOUR);
  const before = await c.balance('bob');
  await w.send('agent', 'executeQueued', args);
  assert.equal(await c.balance('bob') - before, 5n * ZETA);
  await assert.rejects(w.send('agent', 'executeQueued', args), /NotQueued/);
  await assert.rejects(w.send('agent', 'queue', [addr('thief'), 5n * ZETA, '0x', MODEL, PROMPT]), /NotAllowed/);

  const ev2 = await w.send('agent', 'queue', [addr('bob'), 5n * ZETA, '0x', MODEL, PROMPT]);
  const q2 = ev2.find((e) => e?.name === 'Queued').args;
  await assert.rejects(w.send('agent', 'cancel', [q2.id]), /NotOwner/);
  await w.send('owner', 'cancel', [q2.id]);
  c.advance(HOUR);
  await assert.rejects(w.send('agent', 'executeQueued', [q2.seq, addr('bob'), 5n * ZETA, '0x', MODEL, PROMPT]), /NotQueued/);
  // a queued action still counts against the cap when it runs
  const ev3 = await w.send('agent', 'queue', [addr('bob'), 6n * ZETA, '0x', MODEL, PROMPT]);
  c.advance(HOUR);
  await assert.rejects(w.send('agent', 'executeQueued', [ev3.find((e) => e?.name === 'Queued').args.seq, addr('bob'), 6n * ZETA, '0x', MODEL, PROMPT]), /OverCap/);
});

/** What the agent does to get co-signatures: each runner reviews and signs; the agent combines. */
async function cosigned(to, value, data, { signers = runners.slice(0, 2), deadline = c.now() + 600n, level = 'low' } = {}) {
  const read = async (_chain, address) => ({ chain: 'zetaphy', address, analysis: { level, findings: [] }, functions: [] });
  const r = await review({ to, data, read, hasCode: async (a) => a.toLowerCase() === to.toLowerCase() || a.toLowerCase() === sink.address.toLowerCase() });
  const nonce = await w.call('cosignNonce');
  const digest = cosignDigest({ chainId: 1n, wallet: w.address, nonce, to, value, data, reportHash: r.reportHash, deadline });
  assert.equal(digest, await w.call('cosignDigest', [to, value, data, r.reportHash, deadline]));
  const sigs = combine(digest, signers.map((s) => signCosign(s.privateKey, digest)));
  return { r, args: [to, value, data, MODEL, PROMPT, r.reportHash, deadline, sigs] };
}

test('above the threshold, path 2: k-of-n runner co-signatures after Neuro checks; caps still apply', async () => {
  const { r, args } = await cosigned(tok.address, 0n, xfer(addr('bob'), 500n * ZETA));
  assert.equal(r.ok, true);
  assert.deepEqual(r.reports.map((x) => x.role), ['target']); // bob has no code: nothing to read
  await w.send('agent', 'executeCosigned', args);
  assert.equal(await tok.call('balanceOf', [addr('bob')]), 500n * ZETA);
  await assert.rejects(w.send('agent', 'executeCosigned', args), /BadCosign/); // the nonce moved on
  const one = await cosigned(addr('bob'), 5n * ZETA, '0x', { signers: [runners[0]] });
  await assert.rejects(w.send('agent', 'executeCosigned', one.args), /BadCosign/);
  const strangers = await cosigned(addr('bob'), 5n * ZETA, '0x', { signers: [Wallet.createRandom(), Wallet.createRandom()] });
  await assert.rejects(w.send('agent', 'executeCosigned', strangers.args), /BadCosign/);
  const dup = await cosigned(addr('bob'), 5n * ZETA, '0x', { signers: [runners[0]] });
  dup.args[7] = [dup.args[7][0], dup.args[7][0]];
  await assert.rejects(w.send('agent', 'executeCosigned', dup.args), /BadCosign/);
  const late = await cosigned(addr('bob'), 5n * ZETA, '0x', { deadline: c.now() - 1n });
  await assert.rejects(w.send('agent', 'executeCosigned', late.args), /Expired/);
  const tooMuch = await cosigned(tok.address, 0n, xfer(addr('bob'), 600n * ZETA));
  await assert.rejects(w.send('agent', 'executeCosigned', tooMuch.args), /OverCap/); // 500 + 600 > 1000
  const ok = await cosigned(addr('bob'), 5n * ZETA, '0x', { signers: [runners[2], runners[1]] });
  await w.send('agent', 'executeCosigned', ok.args);
});

test('runners refuse when Neuro rates what the action touches high; governance alone sets the committee', async () => {
  const bad = await cosigned(sink.address, 0n, sink.iface.encodeFunctionData('poke', ['0x']), { level: 'high' });
  assert.equal(bad.r.ok, false);
  assert.match(bad.r.reasons[0], /level high/);
  const medium = await review({ to: sink.address, data: '0x', strict: true, read: async () => ({ analysis: { level: 'medium', findings: [] } }), hasCode: async () => true });
  assert.equal(medium.ok, false);
  const noCode = await review({ to: addr('thief'), data: '0x1234', read: async () => ({}), hasCode: async () => false });
  assert.match(noCode.reasons[0], /no code/);
  const failing = await review({ to: sink.address, read: async () => { throw new Error('rpc down'); }, hasCode: async () => true });
  assert.match(failing.reasons[0], /could not read/);
  assert.deepEqual(touched(tok.address, TOKEN.encodeFunctionData('approve', [sink.address, 1n])).map((t) => t.role), ['target', 'spender']);
  await assert.rejects(committee.send('owner', 'setMembers', [[addr('owner')], 1n]), /NotGovernance/);
  await assert.rejects(committee.send('gov', 'setMembers', [[addr('owner')], 2n]), /BadMembers/);
  await committee.send('gov', 'setMembers', [[runners[0].address], 1n]);
  const solo = await cosigned(addr('bob'), 5n * ZETA, '0x', { signers: [runners[0]] });
  await w.send('agent', 'executeCosigned', solo.args);
});

test('emergency freeze: owner account, owner passkey (relayed by anyone) or owner ML-DSA-44 key; only the owner unfreezes', async () => {
  await assert.rejects(w.send('agent', 'freeze'), /NotOwner/);
  await w.send('owner', 'freeze');
  await assert.rejects(exec(addr('bob'), 1n), /IsFrozen/);
  await assert.rejects(w.send('relay', 'unfreeze'), /NotOwner/);
  await w.send('owner', 'unfreeze');
  await exec(addr('bob'), 1n);

  const ch = await w.call('freezeChallenge');
  const assertion = key.assert(ch);
  await assert.rejects(w.send('relay', 'freezeWithPasskey', [passkey('app.sawasdeecoin.com').assert(ch)]), /BadEmergencyKey/); // another passkey
  await assert.rejects(w.send('relay', 'freezeWithPasskey', [key.assert(ch, { flags: 0x01 })]), /BadEmergencyKey/); // no user verification
  await w.send('relay', 'freezeWithPasskey', [assertion]);
  assert.equal(await w.call('frozen'), true);
  await w.send('owner', 'unfreeze');
  await assert.rejects(w.send('relay', 'freezeWithPasskey', [assertion]), /BadEmergencyKey/); // used once

  const d = await w.call('freezeChallenge');
  await assert.rejects(w.send('relay', 'freezeWithPq', [mldsaKey().publicKey, pq.sign(d)]), /BadEmergencyKey/);
  await assert.rejects(w.send('relay', 'freezeWithPq', [pq.publicKey, pq.sign(ZeroHash)]), /BadEmergencyKey/);
  await w.send('relay', 'freezeWithPq', [pq.publicKey, pq.sign(d)]);
  assert.equal(await w.call('frozen'), true);
  // frozen: the queue and co-signed path stop too; the owner can still move funds out
  await assert.rejects(w.send('agent', 'queue', [addr('bob'), 5n * ZETA, '0x', MODEL, PROMPT]), /IsFrozen/);
  const before = await c.balance('owner');
  await w.send('owner', 'ownerExecute', [addr('owner'), 50n * ZETA, '0x']);
  assert.ok(await c.balance('owner') > before);
});

test('only the owner changes the policy', async () => {
  await assert.rejects(w.send('agent', 'setLimit', [NATIVE, 10n ** 30n, 10n ** 30n]), /NotOwner/);
  await assert.rejects(w.send('agent', 'setAllowed', [addr('thief'), true, true]), /NotOwner/);
  await assert.rejects(w.send('agent', 'setConfig', [addr('agent'), committee.address, 1n, 0n]), /NotOwner/);
  await assert.rejects(w.send('agent', 'setEmergencyKeys', [ZeroHash, 0n, 0n, ZeroHash]), /NotOwner/);
  // the agent cannot reach the wallet's own admin through execute either (it is not an allowed target, and calls come from the wallet, not the owner)
  await w.send('owner', 'setAllowed', [w.address, true, false]);
  const setLimit = w.iface.encodeFunctionData('setLimit', [NATIVE, 10n ** 30n, 10n ** 30n]);
  await assert.rejects(exec(w.address, 0n, setLimit), /SelectorNotAllowed/, 'an allowed target alone runs no function (APW-1)');
  await assert.rejects(w.send('agent', 'setAllowedCall', [w.address, setLimit.slice(0, 10), true]), /NotOwner/);
  await w.send('owner', 'setAllowedCall', [w.address, setLimit.slice(0, 10), true]);
  await assert.rejects(exec(w.address, 0n, setLimit), /CallFailed/);
  await assert.rejects(w.send('owner', 'setConfig', [addr('agent'), committee.address, 0n, 0n]), /BadConfig/);
});

test('above the threshold, path 2 with FROST: a DKG group key set by governance, one 65-byte threshold signature; k-of-n stays as fallback', async () => {
  const { r3 } = runDkg(2, 3);
  const group = r3[0].group;
  await assert.rejects(committee.send('owner', 'setFrostKey', ['0x' + group.groupKey]), /NotGovernance/);
  await assert.rejects(committee.send('gov', 'setFrostKey', ['0x02' + 'ff'.repeat(32)]), /BadFrostKey/);
  await assert.rejects(committee.send('gov', 'setFrostKey', ['0x' + group.groupKey.slice(0, 64)]), /BadFrostKey/);
  /** Two members commit, the agent builds the package, each signs the digest it computed itself, the agent aggregates. */
  async function frostSigned(to, value, data, { signers = [r3[0].key, r3[2].key], deadline = c.now() + 600n, grp = group } = {}) {
    const read = async (_chain, address) => ({ chain: 'zetaphy', address, analysis: { level: 'low', findings: [] }, functions: [] });
    const r = await review({ to, data, read, hasCode: async () => false });
    const digest = cosignDigest({ chainId: 1n, wallet: w.address, nonce: await w.call('cosignNonce'), to, value, data, reportHash: r.reportHash, deadline });
    const rounds = signers.map((key) => ({ key, ...signRound1(key) }));
    const pkg = signingPackage({ group: grp, digest, commitments: rounds.map((x) => x.commitment) });
    const sig = aggregateShares({ group: grp, pkg, shares: rounds.map((x) => signRound2({ key: x.key, nonces: x.nonces, pkg, expectDigest: digest })) });
    return [to, value, data, MODEL, PROMPT, r.reportHash, deadline, sig];
  }
  const early = await frostSigned(addr('bob'), 5n * ZETA, '0x');
  await assert.rejects(w.send('agent', 'executeCosignedFrost', early), /BadCosign/); // no group key yet
  await committee.send('gov', 'setFrostKey', ['0x' + group.groupKey]);
  const before = await c.balance('bob');
  const ev = await w.send('agent', 'executeCosignedFrost', early);
  assert.equal(await c.balance('bob') - before, 5n * ZETA);
  assert.equal(ev.find((e) => e?.name === 'AgentAction').args.path, 3n);
  await assert.rejects(w.send('agent', 'executeCosignedFrost', early), /BadCosign/); // the nonce moved on
  const other = await frostSigned(addr('bob'), 4n * ZETA, '0x', { signers: [r3[1].key, r3[2].key] });
  const tampered = [...other];
  tampered[1] = 3n * ZETA; // another amount than the members signed
  await assert.rejects(w.send('agent', 'executeCosignedFrost', tampered), /BadCosign/);
  await assert.rejects(w.send('thief', 'executeCosignedFrost', other), /NotAgent/);
  const late = await frostSigned(addr('bob'), 4n * ZETA, '0x', { deadline: c.now() - 1n });
  await assert.rejects(w.send('agent', 'executeCosignedFrost', late), /Expired/);
  await w.send('agent', 'executeCosignedFrost', other);
  // another group's signature does not count
  const stranger = runDkg(2, 3, 'cd'.repeat(16));
  const foreign = await frostSigned(addr('bob'), 1n * ZETA, '0x', { signers: [stranger.r3[0].key, stranger.r3[1].key], grp: stranger.r3[0].group });
  await assert.rejects(w.send('agent', 'executeCosignedFrost', foreign), /BadCosign/);
  // caps still apply
  const tooMuch = await frostSigned(tok.address, 0n, xfer(addr('bob'), 1001n * ZETA));
  await assert.rejects(w.send('agent', 'executeCosignedFrost', tooMuch), /OverCap/);
  // the k-of-n path keeps working next to it
  const ok = await cosigned(addr('bob'), 1n * ZETA, '0x');
  await w.send('agent', 'executeCosigned', ok.args);
  c.advance(DAY); // 5 + 4 + 1 used the native cap of this period
  const { exec: gas } = await w.gas('agent', 'executeCosignedFrost', await frostSigned(addr('bob'), 1n * ZETA, '0x'));
  assert.ok(gas < 80_000, `gas ${gas}`);
  await committee.send('gov', 'setFrostKey', ['0x']);
  assert.equal(await committee.call('frostKeyX'), 0n);
  await assert.rejects(w.send('agent', 'executeCosignedFrost', await frostSigned(addr('bob'), 1n * ZETA, '0x')), /BadCosign/);
});
