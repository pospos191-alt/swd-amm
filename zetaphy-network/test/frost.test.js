// FROST(secp256k1, SHA-256), RFC 9591: src/frost.js against the RFC's test vectors (Appendix E.5, as published
// with the Zcash Foundation's frost-secp256k1 2.1.0: test/fixtures/frost-secp256k1-rfc9591.json) and that crate's
// DKG vectors (test/fixtures/frost-secp256k1-dkg.json); a full DKG (no dealer) → two-round signing → aggregate;
// and the on-chain verifier (FrostSecp256k1 via FrostVerifier) on the RFC signature and ours, plus forgeries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256 } from 'ethers';
import { createChain } from './helpers/evm.js';
import { runDkg } from './helpers/frost.js';
import {
  N, serS, serE, desE, desS, unhex, toHex, commit, bindingFactors, signShare, verifyShare, aggregate, verify, evalPoly, lagrange,
  checkKnowledge, dkgRound1, dkgRound2, dkgRound3, signRound1, signingPackage, signRound2, aggregateShares, challenge, Point,
} from '../src/frost.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/frost-secp256k1-rfc9591.json', import.meta.url), 'utf8'));
const D = JSON.parse(readFileSync(new URL('./fixtures/frost-secp256k1-dkg.json', import.meta.url), 'utf8'));
const S = (h) => BigInt(`0x${h}`);
const hx = (b) => Buffer.from(b).toString('hex');

test('RFC 9591 E.5 vectors: shares, nonces, commitments, binding factors, signature shares, signature', () => {
  const inp = V.inputs;
  const msg = unhex(inp.message);
  const coeffs = [S(inp.group_secret_key), ...inp.share_polynomial_coefficients.map(S)];
  const groupPk = Point.BASE.multiply(coeffs[0]);
  assert.equal(hx(serE(groupPk)), inp.verifying_key_key);
  for (const p of inp.participant_shares) assert.equal(hx(serS(evalPoly(coeffs, p.identifier))), p.participant_share);
  const share = (id) => S(inp.participant_shares.find((p) => p.identifier === id).participant_share);

  const r1 = V.round_one_outputs.outputs;
  const commitments = [], nonces = {};
  for (const o of r1) {
    const c = commit(share(o.identifier), { hiding: unhex(o.hiding_nonce_randomness), binding: unhex(o.binding_nonce_randomness) });
    assert.equal(hx(serS(c.nonces.hiding)), o.hiding_nonce);
    assert.equal(hx(serS(c.nonces.binding)), o.binding_nonce);
    assert.equal(hx(serE(c.commitments.hiding)), o.hiding_nonce_commitment);
    assert.equal(hx(serE(c.commitments.binding)), o.binding_nonce_commitment);
    nonces[o.identifier] = c.nonces;
    commitments.push({ id: BigInt(o.identifier), ...c.commitments });
  }
  const factors = bindingFactors(groupPk, commitments, msg);
  for (const o of r1) assert.equal(hx(serS(factors.find((f) => f.id === BigInt(o.identifier)).rho)), o.binding_factor);

  const shares = [];
  for (const o of V.round_two_outputs.outputs) {
    const z = signShare({ id: o.identifier, signingShare: share(o.identifier), groupPk, nonces: nonces[o.identifier], commitments, msg });
    assert.equal(hx(serS(z)), o.sig_share);
    assert.ok(verifyShare({ id: o.identifier, share: z, verifyingShare: Point.BASE.multiply(share(o.identifier)), groupPk, commitments, msg }));
    assert.equal(verifyShare({ id: o.identifier, share: (z + 1n) % N, verifyingShare: Point.BASE.multiply(share(o.identifier)), groupPk, commitments, msg }), false);
    shares.push({ id: o.identifier, share: z });
  }
  const sig = aggregate({ groupPk, commitments, msg, shares });
  assert.equal(hx(sig), V.final_output.sig);
  assert.ok(verify(groupPk, msg, sig));
  assert.equal(verify(groupPk, unhex('74657375'), sig), false);
  // Lagrange coefficients of {1,3} at 0 recombine the secret
  assert.equal((lagrange([1, 3], 1) * share(1) + lagrange([1, 3], 3) * share(3)) % N, coeffs[0]);
});

test('DKG vectors (frost-secp256k1 2.1.0): proofs of knowledge, shares from the coefficients, signing and verifying shares, group key', () => {
  const ids = [1, 2, 3];
  const inp = D.inputs;
  for (const i of ids) {
    const p = inp[i];
    const C = p.vss_commitments.map(desE);
    assert.equal(hx(serE(Point.BASE.multiply(S(p.signing_key)))), p.vss_commitments[0]);
    assert.equal(hx(serE(Point.BASE.multiply(S(p.coefficient)))), p.vss_commitments[1]);
    assert.ok(checkKnowledge(i, C[0], p.proof_of_knowledge), `pok ${i}`);
    assert.equal(checkKnowledge(i === 3 ? 1 : i + 1, C[0], p.proof_of_knowledge), false, 'a proof is bound to its identifier');
    // signing_shares[j] under participant i: what i received from j, f_j(i)
    for (const [from, s] of Object.entries(p.signing_shares)) assert.equal(hx(serS(evalPoly([S(inp[from].signing_key), S(inp[from].coefficient)], i))), s);
  }
  for (const j of ids) {
    const own = evalPoly([S(inp[j].signing_key), S(inp[j].coefficient)], j);
    const total = ids.filter((i) => i !== j).reduce((acc, i) => (acc + S(inp[j].signing_shares[i])) % N, own);
    assert.equal(hx(serS(total)), inp[j].signing_share);
    assert.equal(hx(serE(Point.BASE.multiply(total))), inp[j].verifying_share);
  }
  const gk = ids.reduce((acc, i) => acc.add(desE(inp[i].vss_commitments[0])), Point.ZERO);
  assert.equal(hx(serE(gk)), inp.verifying_key);
});

test('DKG without a dealer, then any t of n sign in two rounds; a wrong digest, a stale nonce or a bad share is refused', () => {
  const { r1, pkgs, r2, r3 } = runDkg(2, 3);
  const group = r3[0].group;
  for (const r of r3) assert.deepEqual(r.group, group, 'everyone derives the same group key and transcript');
  // the secret is never assembled, but any 2 shares interpolate to the key behind the group key
  const s = (i) => desS(r3[i - 1].key.signingShare);
  assert.ok(Point.BASE.multiply((lagrange([1, 2], 1) * s(1) + lagrange([1, 2], 2) * s(2)) % N).equals(desE(group.groupKey)));
  assert.ok(Point.BASE.multiply((lagrange([2, 3], 2) * s(2) + lagrange([2, 3], 3) * s(3)) % N).equals(desE(group.groupKey)));

  const digest = keccak256('0x1234');
  for (const signers of [[1, 2], [1, 3], [3, 2]]) {
    const rounds = signers.map((i) => ({ i, ...signRound1(r3[i - 1].key) }));
    const pkg = signingPackage({ group, digest, commitments: rounds.map((r) => r.commitment) });
    const shares = rounds.map((r) => signRound2({ key: r3[r.i - 1].key, nonces: r.nonces, pkg, expectDigest: digest }));
    const sig = aggregateShares({ group, pkg, shares });
    assert.equal(unhex(sig).length, 65);
    assert.ok(verify(desE(group.groupKey), unhex(digest), unhex(sig)));
  }
  const a = signRound1(r3[0].key), b = signRound1(r3[1].key);
  const pkg = signingPackage({ group, digest, commitments: [a.commitment, b.commitment] });
  assert.throws(() => signRound2({ key: r3[0].key, nonces: a.nonces, pkg, expectDigest: keccak256('0x99') }), /another digest/);
  assert.throws(() => signRound2({ key: r3[0].key, nonces: signRound1(r3[0].key).nonces, pkg, expectDigest: digest }), /other commitments/);
  const good = signRound2({ key: r3[1].key, nonces: b.nonces, pkg, expectDigest: digest });
  const bad = { ...signRound2({ key: r3[0].key, nonces: a.nonces, pkg, expectDigest: digest }), share: hx(serS(123n)) };
  assert.throws(() => aggregateShares({ group, pkg, shares: [bad, good] }), /participant 1 sent a bad share/);
  assert.throws(() => signingPackage({ group, digest, commitments: [a.commitment] }), /exactly 2/);

  // a tampered round 1 (bad proof of knowledge), a hidden package swap (transcript differs), a bad share
  const forged = JSON.parse(JSON.stringify(pkgs));
  forged[2].pok = forged[1].pok;
  assert.throws(() => dkgRound2({ secret: JSON.parse(JSON.stringify(r1[0].secret)), packages: forged }), /participant 3: bad proof of knowledge/);
  const other = runDkg(2, 3, 'ab'.repeat(16));
  const mixed = [pkgs[0], pkgs[1], { ...other.pkgs[2], session: pkgs[0].session }];
  assert.throws(() => dkgRound2({ secret: JSON.parse(JSON.stringify(r1[0].secret)), packages: mixed }), /participant 3: bad proof of knowledge/); // the proof binds the session
  // within one session, participant 1 shown another package of participant 3 than the others saw: the transcripts differ
  const same = runDkg(2, 3);
  const r2mixed = dkgRound2({ secret: JSON.parse(JSON.stringify(r1[0].secret)), packages: [pkgs[0], pkgs[1], same.pkgs[2]] });
  assert.notEqual(r2mixed.transcript, r2[0].transcript);
  assert.throws(() => dkgRound3({ secret: JSON.parse(JSON.stringify(r1[1].secret)), packages: pkgs, round2: [r2mixed, r2[1], r2[2]] }), /participant 1 saw other round-1 packages/);
  const r2bad = JSON.parse(JSON.stringify(r2));
  r2bad[1].shares[1] = r2bad[2].shares[1];
  assert.throws(() => dkgRound3({ secret: JSON.parse(JSON.stringify(r1[0].secret)), packages: pkgs, round2: r2bad }), /participant 2: the share does not decrypt/);
  const r2swap = JSON.parse(JSON.stringify(r2));
  r2swap[1].transcript = '00'.repeat(32);
  assert.throws(() => dkgRound3({ secret: JSON.parse(JSON.stringify(r1[0].secret)), packages: pkgs, round2: r2swap }), /transcript differs/);
});

test('on chain: FrostSecp256k1 accepts the RFC signature and ours, computes the RFC challenge, refuses forgeries', async () => {
  const c = await createChain(['a']);
  const v = await c.deploy('FrostVerifier', [], 'a');
  const pk = '0x' + V.inputs.verifying_key_key, msg = '0x' + V.inputs.message, sig = '0x' + V.final_output.sig;
  assert.equal(await v.call('verify', [pk, msg, sig]), true);
  const R = desE(V.final_output.sig.slice(0, 66));
  assert.equal(await v.call('challenge', ['0x' + V.final_output.sig.slice(0, 66), pk, msg]), challenge(R, desE(V.inputs.verifying_key_key), unhex(V.inputs.message)));
  assert.equal(await v.call('verify', [pk, '0x74657375', sig]), false, 'other message');
  const z = desS(V.final_output.sig.slice(66));
  const flip = (h, i) => { const b = unhex(h); b[i] ^= 1; return toHex(b); };
  assert.equal(await v.call('verify', [pk, msg, '0x' + V.final_output.sig.slice(0, 66) + hx(serS(z + 1n))]), false, 'z + 1');
  assert.equal(await v.call('verify', [pk, msg, flip(sig, 0)]), false, 'R with the other y');
  assert.equal(await v.call('verify', [pk, msg, flip(sig, 10)]), false, 'another R');
  assert.equal(await v.call('verify', [pk, msg, sig.slice(0, -2)]), false, 'short');
  assert.equal(await v.call('verify', [pk, msg, '0x' + V.final_output.sig.slice(0, 66) + hx(Buffer.from((N).toString(16), 'hex'))]), false, 'z = n');
  assert.equal(await v.call('verify', [flip(pk, 0), msg, sig]), false, 'the group key with the other y');
  assert.equal(await v.call('verify', ['0x02' + 'ff'.repeat(32), msg, sig]), false, 'x ≥ n');

  // our DKG + signing, many random keys (both parities of PK and R occur)
  for (let k = 0; k < 6; k++) {
    const { r3 } = runDkg(2 + (k % 2), 3);
    const group = r3[0].group;
    const digest = keccak256(`0x${k.toString(16).padStart(2, '0')}`);
    const rounds = r3.slice(0, group.threshold).map((r) => ({ key: r.key, ...signRound1(r.key) }));
    const pkg = signingPackage({ group, digest, commitments: rounds.map((r) => r.commitment) });
    const out = aggregateShares({ group, pkg, shares: rounds.map((r) => signRound2({ key: r.key, nonces: r.nonces, pkg, expectDigest: digest })) });
    assert.equal(await v.call('verify', ['0x' + group.groupKey, digest, out]), true);
    assert.equal(await v.call('verify', ['0x' + group.groupKey, keccak256('0xff'), out]), false);
    const { exec } = await v.gas('a', 'verify', ['0x' + group.groupKey, digest, out]);
    assert.ok(exec < 20_000, `gas ${exec}`);
  }
});
