// Private identity (docs/future/zk-identity.md): ZkIdentityRegistry (commitments of labelled humans in a Poseidon
// Merkle tree, roots history, binding rules, sync), ZkIdentityVerifier (Groth16, DEV setup), PrivateAirdrop and
// PrivatePoll. The proofs come from test/fixtures/zkid.json, made by zetaphy-network/zkid/setup.js for the fixed
// scenario of zkid/lib.js (alice level 1, bob level 2, carol level 1, registered in that order).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, keccak256, toUtf8Bytes, ZeroAddress } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { poseidon2, F, buildTree, leafOf, zeros, DEPTH } from '../../zetaphy-hub/zkid-core.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/zkid.json', import.meta.url), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(new URL('../../zetaphy-hub/zkid/manifest.json', import.meta.url), 'utf8'));
const SOL = readFileSync(new URL('../contracts/ZkIdentityVerifier.sol', import.meta.url), 'utf8');
const DAY = 86_400;
const TTL = 180 * DAY;
const ROOT_TTL = 3600;
const attester = Wallet.createRandom();
const P = FX.proofs;
const B = (x) => BigInt(x);
let c, labels, vouch, reg, poseidon;
const addr = (n) => c.acct[n].toString();
const cred = (n) => keccak256(toUtf8Bytes(`passkey of ${n}`));

async function label(who, credential = cred(who)) {
  const until = c.now() + 30n * BigInt(DAY);
  const deadline = c.now() + 600n;
  const nonce = await labels.call('nonces', [addr(who)]);
  const sig = await attester.signTypedData({ name: 'ZETAPHY Labels', version: '1', chainId: 1, verifyingContract: labels.address },
    { HumanAttestation: [{ name: 'account', type: 'address' }, { name: 'credentialHash', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { account: addr(who), credentialHash: credential, validUntil: until, nonce, deadline });
  await labels.send('anyone', 'attestHuman', [addr(who), credential, until, deadline, sig]);
}

beforeEach(async () => {
  c = await createChain(['gov', 'alice', 'bob', 'carol', 'dave', 'relay', 'anyone']);
  labels = await c.deploy('LabelRegistry', [addr('gov'), ZeroAddress, ZeroAddress, '0x' + '00'.repeat(32), TTL], 'gov');
  await labels.send('gov', 'setAttester', [attester.address, true]);
  vouch = await c.deploy('VouchRegistry', [labels.address, addr('gov')], 'gov');
  await vouch.send('gov', 'setGenesis', [[addr('bob')], true]);
  poseidon = await c.deploy('PoseidonT3', [], 'gov');
  const verifier = await c.deploy('ZkIdentityVerifier', [], 'gov');
  reg = await c.deploy('ZkIdentityRegistry', [poseidon.address, verifier.address, labels.address, vouch.address, addr('gov'), ROOT_TTL], 'gov');
});

/** Labels and registers the fixture's people in the fixture's order. */
async function registerAll(names = ['alice', 'bob', 'carol']) {
  for (const n of names) {
    await label(n);
    await reg.send(n, 'register', [FX.people[n].commitment]);
  }
}
const claimArgs = (pr, recipient, fee = 0n) => [recipient, fee, pr.pub[0], pr.pub[1], pr.words];

test('PoseidonT3 on chain = the browser Poseidon (zkid-poseidon.js) = circomlib (vector); gas measured', async () => {
  assert.equal(poseidon2(1n, 2n), 7853200120776062878684798364095072458815029376092732009249414926327459813530n); // circomlib's own test vector
  const cases = [[0n, 0n], [1n, 2n], [F - 1n, F - 2n], [B(FX.people.alice.commitment), 1n], [123456789n, 987654321n]];
  for (const [a, b] of cases) assert.equal(await poseidon.call('poseidon', [[a, b]]), poseidon2(a, b));
  await assert.rejects(poseidon.call('poseidon', [[F, 0n]]));
  const g = await poseidon.gas('anyone', 'poseidon', [[1n, 2n]]);
  console.log(`PoseidonT3.poseidon: execution gas ${g.exec}`);
  // the registry's empty-subtree hashes are the JS ones
  for (const h of [0, 1, 7, DEPTH]) assert.equal(await reg.call('zeroAt', [h]), zeros()[h]);
  assert.equal(await reg.call('root', []), zeros()[DEPTH]);
});

test('the verifier is the DEV key the hub ships (zkey sha256), and says so', async () => {
  const v = await c.deploy('ZkIdentityVerifier', [], 'gov');
  assert.equal(await v.call('ZKEY_SHA256', []), '0x' + MANIFEST.zkey.sha256);
  assert.equal(FX.zkeySha256, MANIFEST.zkey.sha256, 'rerun zkid/setup.js: fixture and hub files must come from the same key');
  assert.equal(await v.call('DEV_SETUP', []), true);
  assert.match(SOL.split('\n').slice(0, 3).join('\n'), /DEV setup.*Testnet only/);
});

test('registration: only a labelled human; commitments must be field elements; levels from VouchRegistry; tree = JS tree', async () => {
  await assert.rejects(reg.send('alice', 'register', [FX.people.alice.commitment]), /NotHuman/);
  await label('alice');
  await assert.rejects(reg.send('alice', 'register', [0n]), /BadCommitment/);
  await assert.rejects(reg.send('alice', 'register', [F]), /BadCommitment/);
  const g = await reg.gas('alice', 'register', [FX.people.alice.commitment]);
  console.log(`ZkIdentityRegistry.register (first member): execution gas ${g.exec}`);
  // (gas() above ran the registration)
  await label('bob');
  await reg.send('bob', 'register', [FX.people.bob.commitment]);
  assert.equal(await reg.call('root', []), B(FX.root2));
  await label('carol');
  await reg.send('carol', 'register', [FX.people.carol.commitment]);
  assert.equal(await reg.call('root', []), B(FX.root3));
  const leaves = await reg.call('leavesRange', [0n, 10n]);
  assert.deepEqual(leaves.map(B), ['alice', 'bob', 'carol'].map((n) => leafOf(B(FX.people[n].commitment), FX.people[n].level)));
  assert.equal(buildTree(leaves).root, B(FX.root3));
  const m = await reg.call('memberOf', [addr('bob')]);
  assert.equal(m.level, 2n); // genesis in VouchRegistry = vouched unique
  assert.equal((await reg.call('memberOf', [addr('alice')])).level, 1n);
  assert.equal((await reg.call('leavesRange', [5n, 2n])).length, 0);
});

test('an account, a passkey and a commitment each carry one identity', async () => {
  await registerAll(['alice']);
  const other = poseidon2(42n, 43n);
  await assert.rejects(reg.send('alice', 'register', [other]), /AlreadyMember/);
  // dave copies alice's (public) commitment while she is a member: refused
  await label('dave');
  await assert.rejects(reg.send('dave', 'register', [FX.people.alice.commitment]), /CommitmentTaken/);
  // alice's passkey moves to dave: alice loses her label; dave cannot use that passkey for a NEW identity...
  await label('dave', cred('alice'));
  assert.equal(await labels.call('labelOf', [addr('alice')]), 0n);
  await assert.rejects(reg.send('dave', 'register', [other]), /PasskeyBound/);
  // ...only for the same one (same nullifiers): alice's leaf is dropped in the same transaction
  await reg.send('dave', 'register', [FX.people.alice.commitment]);
  assert.equal((await reg.call('memberOf', [addr('alice')])).active, false);
  const leaves = await reg.call('leavesRange', [0n, 10n]);
  assert.deepEqual(leaves.map(B), [0n, leafOf(B(FX.people.alice.commitment), 1)]);
  // alice, labelled again with a new passkey, can only come back with her first commitment
  await label('alice', cred('alice-2'));
  await assert.rejects(reg.send('alice', 'register', [other]), /AccountBound/);
  await assert.rejects(reg.send('alice', 'register', [FX.people.alice.commitment]), /CommitmentTaken/);
});

test('sync: anyone moves a member to its level now (up after vouching, out when the label is gone)', async () => {
  await registerAll();
  await assert.rejects(reg.send('anyone', 'sync', [addr('alice')]), /Unchanged/);
  await vouch.send('gov', 'setGenesis', [[addr('alice')], true]);
  await reg.send('anyone', 'sync', [addr('alice')]);
  assert.equal((await reg.call('memberOf', [addr('alice')])).level, 2n);
  await labels.send('carol', 'revokeHuman', [addr('carol')]);
  const before = await reg.call('root', []);
  await reg.send('anyone', 'sync', [addr('carol')]);
  const m = await reg.call('memberOf', [addr('carol')]);
  assert.equal(m.active, false);
  const leaves = (await reg.call('leavesRange', [0n, 3n])).map(B);
  assert.equal(leaves[2], 0n);
  assert.equal(await reg.call('root', []), buildTree(leaves).root);
  await assert.rejects(reg.send('anyone', 'sync', [addr('carol')]), /NotMember/);
  // the replaced root stays valid for rootTtl, then not
  assert.equal(await reg.call('isValidRoot', [before]), true);
  c.advance(ROOT_TTL + 1);
  assert.equal(await reg.call('isValidRoot', [before]), false);
  // an expired label is removed the same way
  c.advance(31 * DAY);
  await reg.send('anyone', 'sync', [addr('bob')]);
  assert.equal((await reg.call('memberOf', [addr('bob')])).active, false);
});

async function airdrop(scope, minLevel, amount = ZETA) {
  const a = await c.deploy('PrivateAirdrop', [reg.address, scope, minLevel, amount], 'gov');
  await a.sendValue('gov', 10n * ZETA);
  return a;
}

test('PrivateAirdrop: a valid proof pays the bound recipient once; double claim, other recipient, wrong root, tampered proof refused', async () => {
  await registerAll();
  const a = await airdrop(FX.scopes.airdrop, 1);
  const r1 = FX.recipients.r1;
  assert.equal(await a.call('signalOf', [r1, 0n]), B(P.claim.pub[3]), 'the fixture signal is the contract\'s');
  // the claim is sent by an unrelated account (the relayer): nothing links it to alice's labelled account
  // a copied proof with another recipient: refused (the signal is bound)
  await assert.rejects(a.send('relay', 'claim', claimArgs(P.claim, FX.recipients.r4)), /BadProof/);
  // a proof with a changed word, or another root, or another nullifier: refused
  const bad = P.claim.words.slice(); bad[0] = String(B(bad[0]) + 1n);
  await assert.rejects(a.send('relay', 'claim', [r1, 0n, P.claim.pub[0], P.claim.pub[1], bad]), /BadProof/);
  await assert.rejects(a.send('relay', 'claim', [r1, 0n, 12345n, P.claim.pub[1], P.claim.words]), /BadProof/);
  await assert.rejects(a.send('relay', 'claim', [r1, 0n, P.claim.pub[0], B(P.claim.pub[1]) + 1n, P.claim.words]), /BadProof/);
  const g = await a.gas('relay', 'claim', claimArgs(P.claim, r1));
  console.log(`PrivateAirdrop.claim: execution gas ${g.exec}`);
  // (gas() above ran the claim)
  assert.equal(await c.balance(Address.fromString(r1)), ZETA);
  // the same person again, even with a fresh valid proof to another address: same nullifier, refused
  assert.equal(P.claimAgain.pub[1], P.claim.pub[1]);
  await assert.rejects(a.send('relay', 'claim', claimArgs(P.claimAgain, FX.recipients.r4)), /AlreadyClaimed/);
  // bob through a relayer that takes a fee bound in the proof
  const fee = B(FX.fee);
  const before = await c.balance('relay');
  await assert.rejects(a.send('relay', 'claim', claimArgs(P.relayed, FX.recipients.r2, fee + 1n)), /BadProof/);
  await a.send('relay', 'claim', claimArgs(P.relayed, FX.recipients.r2, fee));
  assert.equal(await c.balance(Address.fromString(FX.recipients.r2)), ZETA - fee);
  assert.equal(await c.balance('relay'), before + fee);
  assert.equal(await a.call('claims', []), 2n);
});

test('scopes: one owner each; nullifiers of the same person differ across scopes (unlinkable)', async () => {
  await airdrop(FX.scopes.airdrop, 1);
  await assert.rejects(c.deploy('PrivateAirdrop', [reg.address, FX.scopes.airdrop, 1, ZETA], 'anyone'), /deploy failed/);
  await assert.rejects(reg.send('anyone', 'registerScope', [FX.scopes.airdrop]), /ScopeTaken/);
  await assert.rejects(reg.send('anyone', 'registerScope', [F]), /BadScope/);
  assert.notEqual(P.claim.pub[1], P.vote.pub[1]);   // alice, two scopes
  assert.notEqual(P.claim.pub[1], P.oldRootFresh.pub[1]);
});

test('roots history: a proof against the previous root works within rootTtl, not after', async () => {
  await registerAll(['alice', 'bob']);
  assert.equal(await reg.call('root', []), B(FX.root2));
  await registerAll(['carol']);
  const a = await airdrop(FX.scopes.oldRoot, 1);
  assert.equal(P.oldRootFresh.pub[0], FX.root2);
  await a.send('relay', 'claim', claimArgs(P.oldRootFresh, FX.recipients.r3));
  c.advance(ROOT_TTL + 1);
  await assert.rejects(a.send('relay', 'claim', claimArgs(P.oldRootStale, FX.recipients.r2)), /BadProof/);
  assert.equal(await reg.call('isValidRoot', [FX.root2]), false);
  assert.equal(await reg.call('isValidRoot', [FX.root3]), true); // the current root never expires
});

test('vouched-only airdrop: minLevel 2 is enforced by the contract, not chosen by the prover', async () => {
  await registerAll();
  const a = await airdrop(FX.scopes.unique, 2);
  // carol (level 1) made a valid proof for minLevel 1: the airdrop checks it against 2, so it fails
  await assert.rejects(a.send('relay', 'claim', claimArgs(P.carolUnique, FX.recipients.r3)), /BadProof/);
  await a.send('relay', 'claim', claimArgs(P.unique, FX.recipients.r2));
  assert.equal(await c.balance(Address.fromString(FX.recipients.r2)), ZETA);
});

test('PrivatePoll: one anonymous vote per person; the choice is bound to the proof; tallies; deadline', async () => {
  await registerAll();
  const poll = await c.deploy('PrivatePoll', [reg.address], 'gov');
  const s = B(FX.scopes.poll);
  const ends = c.now() + 3600n;
  await assert.rejects(poll.send('anyone', 'createPoll', [s, keccak256(toUtf8Bytes('q')), 1, 1, ends]), /BadPoll/);
  await poll.send('anyone', 'createPoll', [s, keccak256(toUtf8Bytes('Which logo?')), 2, 1, ends]);
  const vote = (pr, option) => [s, option, pr.pub[0], pr.pub[1], pr.words];
  assert.equal(await poll.call('signalOf', [s, 1]), B(P.vote.pub[3]));
  await assert.rejects(poll.send('relay', 'vote', vote(P.vote2, 1)), /BadProof/); // bob's proof is for option 0
  const g = await poll.gas('relay', 'vote', vote(P.vote, 1));
  console.log(`PrivatePoll.vote: execution gas ${g.exec}`);
  // (gas() above ran the vote)
  await poll.send('relay', 'vote', vote(P.vote2, 0));
  await assert.rejects(poll.send('relay', 'vote', vote(P.voteAgain, 0)), /AlreadyVoted/);
  await assert.rejects(poll.send('relay', 'vote', vote(P.vote, 2)), /BadOption/);
  assert.equal(await poll.call('tally', [s, 0]), 1n);
  assert.equal(await poll.call('tally', [s, 1]), 1n);
  c.advance(3601);
  await assert.rejects(poll.send('relay', 'vote', vote(P.vote2, 0)), /Ended/);
});

test('registry.verify: refuses minLevel 0 and an unknown root even with a valid proof', async () => {
  await registerAll();
  const pr = P.claim;
  const args = (root, minLevel) => [root, pr.pub[1], pr.pub[2], pr.pub[3], minLevel, pr.words];
  assert.equal(await reg.call('verify', args(pr.pub[0], 1n)), true);
  assert.equal(await reg.call('verify', args(pr.pub[0], 0n)), false);
  assert.equal(await reg.call('verify', args(B(pr.pub[0]) + 1n, 1n)), false);
  const g = await reg.gas('anyone', 'verify', args(pr.pub[0], 1n));
  console.log(`ZkIdentityRegistry.verify (Groth16, 5 public signals): execution gas ${g.exec}`);
});
