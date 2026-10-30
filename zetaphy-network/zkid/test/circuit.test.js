// The identity circuit, with the prover files the hub ships (zetaphy-hub/zkid/: identity.wasm, identity.zkey,
// manifest.json with the verification key): valid proofs verify; a wrong root, a wrong nullifier, a level below
// minLevel, a non-member or a non-binary path cannot be proven; a changed scope, signal or minLevel does not verify;
// one identity gives one nullifier per scope and unrelated nullifiers across scopes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as snarkjs from 'snarkjs';
import { HUB_ZKID, p, fileHash, PEOPLE, leavesAfter, SCOPES, RECIPIENTS, airdropSignal } from '../lib.js';
import { proofInput, buildTree, nullifierOf, newIdentity, commitment, leafOf } from '../../../zetaphy-hub/zkid-core.js';

const M = JSON.parse(readFileSync(new URL('manifest.json', HUB_ZKID), 'utf8'));
const WASM = p(new URL(M.wasm.file, HUB_ZKID));
const ZKEY = p(new URL(M.zkey.file, HUB_ZKID));
const LEAVES = leavesAfter(3);
const sig1 = airdropSignal(RECIPIENTS.r1, 0n);
const prove = (input) => snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
const verify = (pub, proof) => snarkjs.groth16.verify(M.vkey, pub, proof);
after(async () => { await globalThis.curve_bn128?.terminate?.(); }); // snarkjs' worker threads would keep the process alive
const inputFor = (who, { scope = SCOPES.airdrop, signalHash = sig1, minLevel = 1, leaves = LEAVES } = {}) => proofInput({ id: PEOPLE[who].id, leaves, scope, signalHash, minLevel }).input;

test('the shipped prover files are the ones in the manifest; the Solidity verifier carries the same key', async () => {
  assert.equal(await fileHash(WASM), M.wasm.sha256);
  assert.equal(await fileHash(ZKEY), M.zkey.sha256);
  const sol = readFileSync(new URL('../../contracts/ZkIdentityVerifier.sol', import.meta.url), 'utf8');
  for (const n of [M.vkey.vk_alpha_1[0], M.vkey.vk_beta_2[0][0], M.vkey.vk_delta_2[1][1], ...M.vkey.IC.map((x) => x[0])]) assert.ok(sol.includes(n), n);
  assert.match(sol, new RegExp(`ZKEY_SHA256 = 0x${M.zkey.sha256}`));
  assert.equal(M.vkey.nPublic, 5);
});

test('the generated Poseidon copies (browser, Solidity) are up to date with circomlib', () => {
  const r = spawnSync(process.execPath, [p(new URL('../gen-poseidon.js', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

let good;
test('a member proves membership, level and its scope nullifier; the public signals are what the JS computes', async () => {
  const input = inputFor('alice');
  good = await prove(input);
  assert.equal(await verify(good.publicSignals, good.proof), true);
  assert.deepEqual(good.publicSignals, [String(buildTree(LEAVES).root), String(nullifierOf(PEOPLE.alice.id, SCOPES.airdrop)), String(SCOPES.airdrop), String(sig1), '1']);
  // bob (level 2) proves level >= 2
  const b = await prove(inputFor('bob', { minLevel: 2 }));
  assert.equal(await verify(b.publicSignals, b.proof), true);
});

test('changed public signals do not verify: scope, signal (front-running), minLevel, root, nullifier', async () => {
  for (let i = 0; i < 5; i++) {
    const pub = good.publicSignals.slice();
    pub[i] = String(BigInt(pub[i]) + 1n);
    assert.equal(await verify(pub, good.proof), false, `public signal ${i}`);
  }
  const otherRecipient = good.publicSignals.slice();
  otherRecipient[3] = String(airdropSignal(RECIPIENTS.r4, 0n));
  assert.equal(await verify(otherRecipient, good.proof), false);
});

test('statements that are false cannot be proven (the witness fails)', async () => {
  // wrong root
  await assert.rejects(prove({ ...inputFor('alice'), root: String(buildTree(leavesAfter(2)).root) }));
  // a nullifier for another scope
  await assert.rejects(prove({ ...inputFor('alice'), nullifier: String(nullifierOf(PEOPLE.alice.id, SCOPES.poll)) }));
  // the right nullifier but the scope swapped
  await assert.rejects(prove({ ...inputFor('alice'), scope: String(SCOPES.poll) }));
  // level 1 claiming minLevel 2 (the JS refuses first; the circuit refuses too)
  assert.throws(() => inputFor('alice', { minLevel: 2 }), /level-too-low/);
  await assert.rejects(prove({ ...inputFor('alice'), minLevel: '2' }));
  // claiming a higher level than registered: the leaf (C, 2) is not in the tree
  await assert.rejects(prove({ ...inputFor('alice'), level: '2' }));
  // a non-member, even with a member's path
  const stranger = newIdentity();
  assert.throws(() => proofInput({ id: stranger, leaves: LEAVES, scope: SCOPES.airdrop, signalHash: sig1, minLevel: 1 }), /not-in-tree/);
  await assert.rejects(prove({ ...inputFor('alice'), secret: String(stranger.secret), nullifierKey: String(stranger.nullifierKey), nullifier: String(nullifierOf(stranger, SCOPES.airdrop)) }));
  // a non-binary path index
  const bad = inputFor('alice');
  await assert.rejects(prove({ ...bad, pathIndices: ['2', ...bad.pathIndices.slice(1)] }));
});

test('one nullifier per person per scope; unrelated across scopes; a removed leaf (0) proves nothing', async () => {
  const again = await prove(inputFor('alice', { signalHash: airdropSignal(RECIPIENTS.r4, 0n) }));
  assert.equal(await verify(again.publicSignals, again.proof), true);
  assert.equal(again.publicSignals[1], good.publicSignals[1], 'same scope: same nullifier (the app refuses the second)');
  const other = await prove(inputFor('alice', { scope: SCOPES.poll }));
  assert.notEqual(other.publicSignals[1], good.publicSignals[1], 'another scope: another nullifier');
  // carol removed (leaf 0): her identity is no longer in the tree
  const removed = LEAVES.slice(); removed[2] = 0n;
  assert.throws(() => proofInput({ id: PEOPLE.carol.id, leaves: removed, scope: SCOPES.airdrop, signalHash: sig1, minLevel: 1 }), /not-in-tree/);
  assert.equal(LEAVES[2], leafOf(commitment(PEOPLE.carol.id), 1));
});
