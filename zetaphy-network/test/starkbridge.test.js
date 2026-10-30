// Trustless ZETAPHY -> Ethereum bridge (prototype) on two in-memory chains:
// lock on "ZETAPHY" (ZetaphyOutbox) -> STARK light-client proof (src/starklc) -> StarkLightClient on
// "Ethereum" (StarkVerifier) -> state proof (IAVL + multistore + outbox tree) -> ZetaphyBridgeInbox
// releases. Forged proofs, wrong roots, replays, stale validator sets and forged signatures fail.
// Gas numbers are printed (see docs/future/trustless-bridge.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, hexlify, getCreateAddress, getBytes, toUtf8Bytes, keccak256 } from 'ethers';
import { createChain } from './helpers/evm.js';
import { tokenKitArtifacts } from './helpers/hyperlanekit.js';
import { MLDSA_VERIFIER, mldsaVerifierPrecompile, zetaphyBlock, compileHelper } from './helpers/starkbridge.js';
import {
  buildSet, prove, encodeProof, decodeProof, verifyProof, statementMessage, blockStatement, proveBlock, proveHandoff, handoffMessage, collectFromNode,
} from '../src/starklc/index.js';
import { testValidators, signAll } from '../src/starklc/fixtures.js';
import { headerHash, appHashProof, messageLeaf, outboxProof, releaseArgs, applyIavlProof, applyMultistoreOps, buildIavl, storageKey } from '../src/starkbridge/index.js';

const ZCHAIN = 'zetaphy-bridge-1';
const ZETA_EVM_ID = 7001n;
const ETH_ID = 1n;
const abi = AbiCoder.defaultAbiCoder();
const chainBytes = (s) => hexlify(toUtf8Bytes(s));
const WINDOW = 3600;
const BOND = 10n ** 17n;
const GAS = {}; // name -> { exec, calldata, total }; measure() also performs the call (state changes stay)

/** The custom error a call reverts with, decoded with every bridge contract's errors (also bubbled ones). */
const ERRORS = new Interface(['StarkVerifier', 'StarkLightClient', 'ZetaphyBridgeInbox'].flatMap((n) =>
  JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).abi.filter((f) => f.type === 'error')));
async function revertName(chain, from, contract, fn, args, value = 0n) {
  const r = await chain.rawCall(from, contract.address, contract.iface.encodeFunctionData(fn, args), value);
  assert.equal(r.ok, false, `${fn} should revert`);
  try { return ERRORS.parseError(r.returnHex)?.name ?? 'revert'; } catch { return 'revert'; }
}

/** Intrinsic calldata gas (EIP-2028: 16 per non-zero byte, 4 per zero byte) of a 0x... string. */
const calldataGas = (hex) => { const b = getBytes(hex); let g = 0; for (const x of b) g += x ? 16 : 4; return g; };
/** EIP-7623 floor: 21000 + 10 per token (zero byte = 1 token, non-zero = 4). */
const floorGas = (hex) => { const b = getBytes(hex); let t = 0; for (const x of b) t += x ? 4 : 1; return 21000 + 10 * t; };
async function measure(name, contract, from, fn, args, value = 0n) {
  const { exec, data } = await contract.gas(from, fn, args, value);
  GAS[name] = { exec, calldata: calldataGas(data), total: Math.max(21000 + calldataGas(data) + exec, floorGas(data)), bytes: getBytes(data).length };
  return GAS[name];
}

/** ML-DSA-44 gas estimate (one FIPS 204 verification in Solidity) from measured primitives. */
async function mldsaGasEstimate(eth) {
  const art = compileHelper('MLDSACost.sol').MLDSACost;
  const probe = await eth.deployRaw(art, [], 'relayer');
  assert.equal(await probe.call('keccakEmpty'), keccak256('0x')); // our Keccak-f[1600] is right
  const g = async (fn, n) => (await probe.gas('relayer', fn, [n])).exec;
  const perm = (await g('permutations', 20) - await g('permutations', 0)) / 20;
  const ntt = (await g('ntts', 4) - await g('ntts', 0)) / 4;
  const pw = (await g('pointwise', 8) - await g('pointwise', 0)) / 8;
  // FIPS 204 ML-DSA-44 verify: ExpandA 16 polys x 5 SHAKE128 blocks = 80 permutations, tr = H(pk)
  // 10, mu 1, SampleInBall 2, c~' = H(mu || w1Encode) 7: ~100 permutations. NTT: z (4), c (1),
  // t1 (4), inverse (4) = 13. Pointwise: A*z 16 + c*t1 4 + c*... ~ 24 polys. Decoding pk/sig,
  // hints, range checks and w1Encode ~ 4,000 coefficient operations at ~60 gas.
  const est = Math.round(100 * perm + 13 * ntt + 24 * pw + 4000 * 60);
  return { perm: Math.round(perm), ntt: Math.round(ntt), pw: Math.round(pw), est };
}

async function setup({ trustedProver = false } = {}) {
  const zeta = await createChain(['alice', 'bob'], {}, { chainId: ZETA_EVM_ID });
  const precompile = Object.assign((x) => mldsaVerifierPrecompile(x), { gas: 0n });
  const eth = await createChain(['relayer', 'watcher', 'gov', 'guardian', 'user', 'prover'], {}, { precompiles: { [MLDSA_VERIFIER]: precompile }, txGasLimit: 200_000_000n });
  const kit = tokenKitArtifacts();
  // ZETAPHY: token, outbox, lockbox (its destination is the inbox's future address on Ethereum)
  const zToken = await zeta.deployRaw(kit.KitToken, ['Test USD', 'tUSD', 6], 'alice');
  const outbox = await zeta.deploy('ZetaphyOutbox', [], 'alice');
  // Ethereum: verifier, light client, token, inbox
  const set0 = buildSet(testValidators(4, { label: 'bridge-e0' }));
  const vals0 = testValidators(4, { label: 'bridge-e0' });
  const verifier = await eth.deploy('StarkVerifier', [], 'relayer');
  const lc = await eth.deploy('StarkLightClient', [verifier.address, MLDSA_VERIFIER, chainBytes(ZCHAIN), hexlify(set0.root), set0.logN, set0.logBlowup,
    WINDOW, BOND, 128, 100, trustedProver ? eth.acct.prover.toString() : '0x' + '00'.repeat(20)], 'relayer');
  const eToken = await eth.deployRaw(kit.KitToken, ['Test USD', 'tUSD', 6], 'relayer');
  const inboxAddr = getCreateAddress({ from: eth.acct.gov.toString(), nonce: await eth.nonce('gov') });
  const lockbox = await zeta.deploy('ZetaphyLockbox', [zToken.address, outbox.address, ETH_ID, inboxAddr], 'alice');
  const inbox = await eth.deploy('ZetaphyBridgeInbox', [lc.address, ZETA_EVM_ID, outbox.address, lockbox.address, eToken.address,
    eth.acct.gov.toString(), eth.acct.guardian.toString(), 10_000n * 10n ** 6n], 'gov');
  assert.equal(inbox.address.toLowerCase(), inboxAddr.toLowerCase());
  await eToken.send('relayer', 'mint', [inbox.address, 1_000_000n * 10n ** 6n]); // collateral on Ethereum
  await zToken.send('alice', 'mint', [zeta.acct.alice.toString(), 1_000n * 10n ** 6n]);
  await zToken.send('alice', 'approve', [lockbox.address, 2n ** 255n]);
  return { zeta, eth, precompile, zToken, outbox, lockbox, verifier, lc, eToken, inbox, set0, vals0, leaves: [], messages: [] };
}

/** Locks on ZETAPHY; returns the message (as the inbox wants it) and keeps the outbox leaves. */
async function lock(ctx, amount, recipient, from = 'alice') {
  await ctx.lockbox.send(from, 'lock', [amount, recipient]);
  const nonce = BigInt(ctx.leaves.length);
  const payload = abi.encode(['address', 'uint256'], [recipient, amount]);
  const m = { srcChainId: ZETA_EVM_ID, outbox: ctx.outbox.address, nonce, sender: ctx.lockbox.address, dstChainId: ETH_ID, receiver: ctx.inbox.address, payload };
  ctx.leaves.push(messageLeaf(m));
  ctx.messages.push(m);
  return m;
}

/** A ZETAPHY block whose state holds the outbox's current root; proven by `set` with `signers`. */
async function blockWithOutbox(ctx, height, { set = ctx.set0, signers = ctx.vals0, reveal = 'all', salt = 'a', sigs } = {}) {
  const root = await ctx.outbox.call('root');
  const blk = zetaphyBlock({ chainId: ZCHAIN, height, slots: [{ address: ctx.outbox.address, slot: 0n, value: root }], salt });
  const statement = blockStatement(ZCHAIN, height, blk.blockHash);
  const signatures = sigs ?? signAll(signers, statementMessage(statement));
  const proof = prove({ set, statement, signatures, reveal, checkSignatures: !sigs });
  return { ...blk, root, bytes: encodeProof(proof), proof };
}

const submitArgs = (b) => [hexlify(b.bytes), hexlify(b.appHash), b.aunts.map((a) => hexlify(a))];

async function finalizeBlock(ctx, b) {
  await ctx.lc.send('relayer', 'submit', submitArgs(b), BOND);
  const id = (await ctx.lc.call('claimCount')) - 1n;
  ctx.eth.advance(WINDOW + 1);
  await ctx.lc.send('watcher', 'finalize', [id]);
  return id;
}

test('CometBFT header hash and app_hash proof: JS and Solidity match a real devnet block', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pqcert-devnet.json', import.meta.url), 'utf8'));
  const eth = await createChain(['a']);
  const verifier = await eth.deploy('StarkVerifier', [], 'a');
  const lc = await eth.deploy('StarkLightClient', [verifier.address, MLDSA_VERIFIER, chainBytes('x'), '0x' + '11'.repeat(32), 3, 4, 60, 0, 128, 100, '0x' + '00'.repeat(20)], 'a');
  for (const H of ['13', '14']) {
    const h = fx.block[H].block.header;
    assert.equal(Buffer.from(headerHash(h)).toString('hex').toUpperCase(), fx.block[H].block_id.hash);
    const p = appHashProof(h);
    const got = await lc.call('appHashRoot', [hexlify(p.appHash), p.aunts.map((a) => hexlify(a))]);
    assert.equal(got.slice(2).toUpperCase(), fx.block[H].block_id.hash);
    // another field's value in the app_hash position does not hash to the block
    const wrong = await lc.call('appHashRoot', ['0x' + h.last_results_hash.toLowerCase(), p.aunts.map((a) => hexlify(a))]);
    assert.notEqual(wrong.slice(2).toUpperCase(), fx.block[H].block_id.hash);
  }
});

test('StarkVerifier (Solidity) agrees with the JS verifier, also on a real devnet certificate', async () => {
  const eth = await createChain(['a'], {}, { txGasLimit: 200_000_000n });
  const v = await eth.deploy('StarkVerifier', [], 'a');
  const CH = 'zetaphy-test-1';
  const vs = testValidators(6, { keyless: 3 });
  const set = buildSet(vs);
  const st = blockStatement(CH, 77, new Uint8Array(32).fill(5));
  const sigs = signAll(vs.filter((x) => x.pubKey), statementMessage(st));
  const pin = (s) => [hexlify(s.root), s.logN, s.logBlowup];
  for (const [mode, minSig] of [['all', 128], ['sample', 40], ['none', 0]]) {
    const bytes = encodeProof(prove({ set, statement: st, signatures: sigs, reveal: mode, sigBits: 40 }));
    const js = verifyProof(bytes, { pin: set.pin, chainId: CH, minSigBits: minSig });
    const r = await v.call('verify', [hexlify(bytes), pin(set), chainBytes(CH), minSig, 100]);
    assert.deepEqual([r.S, r.T, r.U, r.C, r.ok, r.pqMajority, Number(r.revealed)], [js.S, js.T, js.U, js.C, js.ok, js.pqMajority, js.revealed], mode);
    assert.equal(r.message, hexlify(statementMessage(st)));
    if (mode === 'none') await assert.rejects(v.call('verify', [hexlify(bytes), pin(set), chainBytes(CH), 128, 100]), /ProofRejected/);
    if (mode === 'sample') await assert.rejects(v.call('verify', [hexlify(bytes), pin(set), chainBytes(CH), 128, 100]), /ProofRejected/);
  }
  // tampered bytes: a spread of positions over the whole proof, all rejected by both verifiers
  const bytes = encodeProof(prove({ set, statement: st, signatures: sigs, reveal: 'sample', sigBits: 20 }));
  const step = Math.floor(bytes.length / 40);
  for (let i = 3; i < bytes.length; i += step) {
    const b = bytes.slice(); b[i] ^= 0x04;
    assert.throws(() => verifyProof(b, { pin: set.pin, chainId: CH, minSigBits: 20 }), undefined, `js byte ${i}`);
    await assert.rejects(v.call('verify', [hexlify(b), pin(set), chainBytes(CH), 20, 100]), /ProofRejected/, `sol byte ${i}`);
  }
  // wrong set root, wrong chain, weak parameters
  const good = encodeProof(prove({ set, statement: st, signatures: sigs, reveal: 'all' }));
  const other = buildSet(vs.map((x, i) => (i ? x : { ...x, power: x.power + 1n })));
  await assert.rejects(v.call('verify', [hexlify(good), pin(other), chainBytes(CH), 128, 100]), /ProofRejected/);
  await assert.rejects(v.call('verify', [hexlify(good), pin(set), chainBytes('other-1'), 128, 100]), /ProofRejected/);
  await assert.rejects(v.call('verify', [hexlify(good), pin(set), chainBytes(CH), 128, 129]), /ProofRejected/);
  // the Go-built certificate of a real two-validator devnet (fixtures/pqcert-devnet.json)
  const fx = JSON.parse(readFileSync(new URL('./fixtures/pqcert-devnet.json', import.meta.url), 'utf8'));
  const rpc = async (method, params) => (method === 'block' ? fx.block[params.height] : method === 'validators' ? fx.validators[params.height] : fx.abci_query[params.data.slice(2)]);
  const data = await collectFromNode(rpc, 13);
  const real = proveBlock(data);
  const r = await v.call('verify', [hexlify(real.bytes), pin(real.set), chainBytes('zetaphy-pqcert-1'), 128, 100]);
  assert.equal(r.ok, true); assert.equal(r.S, 10_000_000n);
  assert.equal(r.hash.slice(2).toUpperCase(), fx.block['13'].block_id.hash);
});

test('end to end: lock on ZETAPHY -> STARK proof -> Ethereum light client -> tokens released; replay, wrong roots and forged messages fail', async () => {
  const ctx = await setup();
  const user = ctx.eth.acct.user.toString();
  const m0 = await lock(ctx, 250n * 10n ** 6n, user);
  const m1 = await lock(ctx, 40n * 10n ** 6n, user);
  // a message from another ZETAPHY contract (bob calls the outbox directly) to the inbox
  await ctx.outbox.send('bob', 'send', [ETH_ID, ctx.inbox.address, abi.encode(['address', 'uint256'], [user, 999n * 10n ** 6n])]);
  const forged = { srcChainId: ZETA_EVM_ID, outbox: ctx.outbox.address, nonce: 2n, sender: ctx.zeta.acct.bob.toString(), dstChainId: ETH_ID, receiver: ctx.inbox.address, payload: abi.encode(['address', 'uint256'], [user, 999n * 10n ** 6n]) };
  ctx.leaves.push(messageLeaf(forged));
  // the JS tree is the contract's tree
  assert.equal(hexlify(outboxProof(ctx.leaves, 0).root), await ctx.outbox.call('root'));

  const H = 1000n;
  const b = await blockWithOutbox(ctx, H);
  // the evm-store and multistore proofs reproduce the app hash off-chain too
  const { iavl, storeOps } = b.prove(ctx.outbox.address);
  assert.equal(hexlify(applyMultistoreOps('evm', applyIavlProof(iavl), storeOps)), hexlify(b.appHash));

  // not final yet: nothing can be released
  const args0 = releaseArgs({ height: H, iavl, storeOps, message: m0, outbox: outboxProof(ctx.leaves, 0) });
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.inbox, 'release', args0), 'Unknown');
  await measure('LC.submit block n=4 all (optimistic)', ctx.lc, 'relayer', 'submit', submitArgs(b), BOND);
  await assert.rejects(ctx.lc.send('watcher', 'finalize', [0n]), /WindowOpen/);
  ctx.eth.advance(WINDOW + 1);
  const relayerBefore = await ctx.eth.balance('relayer');
  await ctx.lc.send('watcher', 'finalize', [0n]);
  assert.equal(await ctx.eth.balance('relayer'), relayerBefore + BOND); // bond back
  assert.equal(await ctx.lc.call('appHashAt', [H]), hexlify(b.appHash));

  await measure('Inbox.release (IAVL + multistore + outbox path)', ctx.inbox, 'relayer', 'release', args0);
  assert.equal(await ctx.eToken.call('balanceOf', [user]), 250n * 10n ** 6n);
  // replay
  await assert.rejects(ctx.inbox.send('relayer', 'release', args0), /AlreadyConsumed/);
  // the second message from the same header
  await ctx.inbox.send('watcher', 'release', releaseArgs({ height: H, iavl, storeOps, message: m1, outbox: outboxProof(ctx.leaves, 1) }));
  assert.equal(await ctx.eToken.call('balanceOf', [user]), 290n * 10n ** 6n);
  // a real outbox message, but not from the lockbox: refused
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ height: H, iavl, storeOps, message: forged, outbox: outboxProof(ctx.leaves, 2) })), /BadMessage/);
  // the lockbox's sender on a message that is not in the tree: wrong outbox path
  const fake = { ...forged, sender: ctx.lockbox.address };
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ height: H, iavl, storeOps, message: fake, outbox: outboxProof(ctx.leaves, 2) })), /BadStateProof/);
  // wrong roots: another outbox root in the IAVL proof, another app hash, a tampered IAVL op, an unknown height
  const lyingIavl = { ...iavl, value: getBytes(outboxProof([...ctx.leaves, messageLeaf(fake)], 0).root) };
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ height: H, iavl: lyingIavl, storeOps, message: m1, outbox: outboxProof(ctx.leaves, 1) })), /BadStateProof|AlreadyConsumed/);
  const m2 = await lock(ctx, 5n * 10n ** 6n, user);
  const b2 = await blockWithOutbox(ctx, H + 5n, { salt: 'b' });
  await finalizeBlock(ctx, b2);
  const p2 = b2.prove(ctx.outbox.address);
  const good2 = { height: H + 5n, iavl: p2.iavl, storeOps: p2.storeOps, message: m2, outbox: outboxProof(ctx.leaves, 3) };
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ ...good2, height: H })), /BadStateProof/); // header H does not hold m2
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.inbox, 'release', releaseArgs({ ...good2, height: H + 1n })), 'Unknown');
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.inbox, 'release', releaseArgs({ ...good2, iavl: { ...p2.iavl, value: getBytes(b.root) } })), 'BadStateProof');
  const badOp = { ...p2.iavl, path: p2.iavl.path.map((o, i) => (i ? o : { prefix: Uint8Array.of(0, ...o.prefix.subarray(1)), suffix: o.suffix })) };
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ ...good2, iavl: badOp })), /BadStateProof/);
  // another contract's slot 0 (the token's) is not the outbox root
  const tokenSlot = buildIavl([{ key: storageKey(ctx.zToken.address, 0n), value: getBytes(b.root) }], 1).prove(storageKey(ctx.zToken.address, 0n));
  await assert.rejects(ctx.inbox.send('relayer', 'release', releaseArgs({ ...good2, iavl: tokenSlot })), /BadStateProof/);
  await ctx.inbox.send('relayer', 'release', releaseArgs(good2));
  assert.equal(await ctx.eToken.call('balanceOf', [user]), 295n * 10n ** 6n);
});

test('forged proofs and the circuit breaker: tampered STARK, stale validator set, forged signature (challenge), rate limit and pause', async () => {
  const ctx = await setup({ trustedProver: true });
  const user = ctx.eth.acct.user.toString();
  await ctx.zToken.send('alice', 'mint', [ctx.zeta.acct.alice.toString(), 100_000n * 10n ** 6n]);
  const m0 = await lock(ctx, 6_000n * 10n ** 6n, user);
  const m1 = await lock(ctx, 6_000n * 10n ** 6n, user);

  // 1. forged STARK bytes: refused at submission
  const b = await blockWithOutbox(ctx, 10n);
  const bad = b.bytes.slice(); bad[bad.length - 100] ^= 1;
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.lc, 'submit', [hexlify(bad), hexlify(b.appHash), b.aunts.map((a) => hexlify(a))], BOND), 'ProofRejected');
  // a wrong app hash for the certified block
  await assert.rejects(ctx.lc.send('relayer', 'submit', [hexlify(b.bytes), '0x' + '22'.repeat(32), b.aunts.map((a) => hexlify(a))], BOND), /BadAppHash/);
  // too few signers (2 of 4): the proof is valid but the chain's rule fails
  const weak = await blockWithOutbox(ctx, 11n, { signers: ctx.vals0.slice(2), salt: 'w' });
  await assert.rejects(ctx.lc.send('relayer', 'submit', submitArgs(weak), BOND), /RuleFails/);
  // mode none: only the trusted prover (trusted for ML-DSA validity)
  const none = await blockWithOutbox(ctx, 12n, { reveal: 'none', salt: 'n' });
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.lc, 'submit', submitArgs(none), BOND), 'ProofRejected'); // 0 signature bits < 128
  await measure('LC.submit block n=4 none (trusted prover)', ctx.lc, 'prover', 'submit', submitArgs(none), BOND);

  // 2. forged signature, optimistic: validator 0 did not sign; the prover put junk in its place
  const honestTwo = ctx.vals0.slice(1);
  const forgedBlk = zetaphyBlock({ chainId: ZCHAIN, height: 13n, slots: [{ address: ctx.outbox.address, slot: 0n, value: await ctx.outbox.call('root') }], salt: 'f' });
  const stF = blockStatement(ZCHAIN, 13n, forgedBlk.blockHash);
  const junk = new Map([...signAll(honestTwo.slice(0, 1), statementMessage(stF)), [ctx.set0.validators.find((v) => v.address === ctx.vals0[0].address).address, new Uint8Array(2420).fill(7)],
    ...signAll(honestTwo.slice(1), statementMessage(stF))]);
  const forgedProof = prove({ set: ctx.set0, statement: stF, signatures: junk, reveal: 'all', checkSignatures: false });
  const fb = { ...forgedBlk, bytes: encodeProof(forgedProof) };
  // the STARK is fine (the accounting is right for the committed bitmap) ...
  await ctx.lc.send('relayer', 'submit', submitArgs(fb), BOND);
  const fid = (await ctx.lc.call('claimCount')) - 1n;
  // ... submitChecked would have refused it at once
  await assert.rejects(ctx.lc.send('relayer', 'submitChecked', submitArgs(fb)), /SignatureInvalid/);
  // ... and a watcher proves the bad signature during the window
  const dec = decodeProof(fb.bytes);
  const digests = dec.reveals.flatMap((r) => [hexlify(getBytes('0x' + r.vals[1].toString(16).padStart(64, '0'))), hexlify(getBytes('0x' + r.vals[5].toString(16).padStart(64, '0')))]);
  const badIdx = dec.reveals.findIndex((r) => r.sig.every((x) => x === 7));
  const goodIdx = badIdx === 0 ? 1 : 0;
  const msg = hexlify(statementMessage(stF));
  await assert.rejects(ctx.lc.send('watcher', 'challenge', [fid, goodIdx, digests, hexlify(dec.reveals[goodIdx].sig), hexlify(dec.reveals[goodIdx].pk), msg]), /SignatureValid/);
  await assert.rejects(ctx.lc.send('watcher', 'challenge', [fid, badIdx, digests, hexlify(dec.reveals[goodIdx].sig), hexlify(dec.reveals[badIdx].pk), msg]), /BadDispute/);
  const est = await mldsaGasEstimate(ctx.eth);
  ctx.precompile.gas = BigInt(est.est);
  const before = await ctx.eth.balance('watcher');
  await measure('LC.challenge (one ML-DSA-44 check, estimated)', ctx.lc, 'watcher', 'challenge', [fid, badIdx, digests, hexlify(dec.reveals[badIdx].sig), hexlify(dec.reveals[badIdx].pk), msg]);
  assert.equal(await ctx.eth.balance('watcher'), before + BOND); // the forger's bond
  ctx.eth.advance(WINDOW + 1);
  await assert.rejects(ctx.lc.send('watcher', 'finalize', [fid]), /NotPending/);
  await assert.rejects(ctx.lc.call('appHashAt', [13n]), /Unknown|revert/);
  console.log(`ML-DSA-44 in Solidity, measured parts: Keccak-f[1600] ${est.perm} gas, NTT-256 ${est.ntt} gas, 256 pointwise ${est.pw} gas -> one verification ~ ${(est.est / 1e6).toFixed(1)} M gas (estimate)`);
  GAS['ML-DSA-44 verify in Solidity (estimate)'] = { exec: est.est, calldata: 0, total: est.est, bytes: 0 };

  // 3. submitChecked: every revealed signature verified now, final at once (no window, no bond)
  const checked = await blockWithOutbox(ctx, 20n, { salt: 'c' });
  await measure('LC.submitChecked block n=4 all (4 ML-DSA checks, est.)', ctx.lc, 'relayer', 'submitChecked', submitArgs(checked));
  ctx.precompile.gas = 3000n;
  assert.equal(await ctx.lc.call('appHashAt', [20n]), hexlify(checked.appHash));

  // 4. rate limit and circuit breaker (daily limit 10,000 tUSD)
  const p = checked.prove(ctx.outbox.address);
  const rel = (m) => releaseArgs({ height: 20n, iavl: p.iavl, storeOps: p.storeOps, message: m, outbox: outboxProof(ctx.leaves, Number(m.nonce)) });
  await ctx.inbox.send('relayer', 'pause', []).catch(() => {}); // not a guardian: refused, nothing changes
  assert.equal(await ctx.inbox.call('paused'), false);
  await ctx.inbox.send('guardian', 'pause', []);
  await assert.rejects(ctx.inbox.send('relayer', 'release', rel(m0)), /BridgePaused/);
  await assert.rejects(ctx.inbox.send('guardian', 'unpause', []), /NotGovernance/);
  await ctx.inbox.send('gov', 'unpause', []);
  await ctx.inbox.send('relayer', 'release', rel(m0));
  await assert.rejects(ctx.inbox.send('relayer', 'release', rel(m1)), /OverLimit/); // 12,000 > 10,000 today
  ctx.eth.advance(86_400);
  await ctx.inbox.send('relayer', 'release', rel(m1)); // retried the next day: nothing lost
  assert.equal(await ctx.eToken.call('balanceOf', [user]), 12_000n * 10n ** 6n);
  await ctx.inbox.send('guardian', 'lowerLimit', [1n]);
  await assert.rejects(ctx.inbox.send('gov', 'proposeLimit', [10n ** 12n])); // more than x2
  await ctx.inbox.send('gov', 'proposeLimit', [2n]);
  await assert.rejects(ctx.inbox.send('relayer', 'applyLimit', []), /TooEarly/);

  // 5. stale validator set: hand off to epoch 1, then epoch 0's signatures no longer count
  const vals1 = testValidators(5, { label: 'bridge-e1' });
  const set1 = buildSet(vals1);
  const ho = proveHandoff({ set: ctx.set0, nextSet: set1, chainId: ZCHAIN, epoch: 1, signatures: signAll(ctx.vals0, handoffMessage(ZCHAIN, 1, set1)) });
  const hoArgs = [hexlify(ho.bytes), '0x' + '00'.repeat(32), Array(4).fill('0x' + '00'.repeat(32))];
  await measure('LC.submit handoff n=4 all (optimistic)', ctx.lc, 'relayer', 'submit', hoArgs, BOND);
  const hid = (await ctx.lc.call('claimCount')) - 1n;
  ctx.eth.advance(WINDOW + 1);
  await ctx.lc.send('watcher', 'finalize', [hid]);
  assert.equal(await ctx.lc.call('epoch'), 1n);
  assert.equal(await ctx.lc.call('setRoot'), hexlify(set1.root));
  const stale = await blockWithOutbox(ctx, 30n, { salt: 's' }); // signed by epoch 0
  assert.equal(await revertName(ctx.eth, 'relayer', ctx.lc, 'submit', submitArgs(stale), BOND), 'ProofRejected');
  const fresh = await blockWithOutbox(ctx, 30n, { set: set1, signers: vals1, salt: 's' });
  await ctx.lc.send('relayer', 'submit', submitArgs(fresh), BOND);
  // a second handoff to epoch 1 or a skipped epoch is refused
  const skip = proveHandoff({ set: set1, nextSet: ctx.set0, chainId: ZCHAIN, epoch: 3, signatures: signAll(vals1, handoffMessage(ZCHAIN, 3, ctx.set0)) });
  await assert.rejects(ctx.lc.send('relayer', 'submit', [hexlify(skip.bytes), hoArgs[1], hoArgs[2]], BOND), /WrongEpoch/);

  // 6. equivocation: two final hashes for one height freeze the client
  const twin = await blockWithOutbox(ctx, 30n, { set: set1, signers: vals1, salt: 't' });
  await ctx.lc.send('relayer', 'submit', submitArgs(twin), BOND);
  const n = await ctx.lc.call('claimCount');
  ctx.eth.advance(WINDOW + 1);
  await ctx.lc.send('watcher', 'finalize', [n - 2n]);
  await ctx.lc.send('watcher', 'finalize', [n - 1n]);
  assert.equal(await ctx.lc.call('frozen'), true);
  await assert.rejects(ctx.lc.call('appHashAt', [30n]), /Frozen|revert/);
});

test('gas: STARK verification on the EVM by validator count and mode (in-memory EVM, Cancun)', { timeout: 600_000 }, async () => {
  const eth = await createChain(['a'], {}, { txGasLimit: 200_000_000n });
  const v = await eth.deploy('StarkVerifier', [], 'a');
  const rows = [];
  // n = 100 adds ~1 minute: STARKBRIDGE_FULL=1 node --test test/starkbridge.test.js (numbers in the doc)
  const cases = [[4, 'none'], [4, 'all'], [21, 'none'], [21, 'all'], [21, 'sample']];
  if (process.env.STARKBRIDGE_FULL) cases.push([100, 'none'], [100, 'sample']);
  for (const [n, mode] of cases) {
    const vs = testValidators(n);
    const set = buildSet(vs);
    const st = blockStatement('zetaphy-gas-1', 5, new Uint8Array(32).fill(9));
    const bytes = encodeProof(prove({ set, statement: st, signatures: signAll(vs, statementMessage(st)), reveal: mode, sigBits: 128 }));
    const args = [hexlify(bytes), [hexlify(set.root), set.logN, set.logBlowup], chainBytes('zetaphy-gas-1'), mode === 'none' ? 0 : 128, 100];
    const r = await v.call('verify', args);
    const g = await measure(`StarkVerifier n=${n} ${mode}`, v, 'a', 'verify', args);
    rows.push({ n, mode, proofKB: (bytes.length / 1024).toFixed(1), revealed: Number(r.revealed), exec: g.exec, calldata: g.calldata, total: g.total });
  }
  console.log('n | mode | proof KB | revealed | execution | calldata | tx total');
  for (const r of rows) console.log(`${r.n} | ${r.mode} | ${r.proofKB} | ${r.revealed} | ${r.exec} | ${r.calldata} | ${r.total}`);
  for (const r of rows) assert.ok(r.total < 30_000_000, `n=${r.n} ${r.mode} fits a 30 M gas block`);
});

test('gas table', async () => {
  console.log('operation | execution | calldata | tx total (incl. 21000, EIP-7623 floor)');
  for (const [k, g] of Object.entries(GAS)) console.log(`${k} | ${g.exec} | ${g.calldata} | ${g.total}`);
});

