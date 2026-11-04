// Saphan PR 4, S6 (contracts/SaphanSealedOrders.sol, src/saphansealed.js): an intent sealed to the chosen solver's
// post-quantum key (X-Wing: ML-KEM-768 + X25519), committed on chain with its escrow, revealed by that solver only
// within a window (the commitment binds every field), opened as an ordinary SaphanIntents intent; refunds on timeout.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getBytes, hexlify } from 'ethers';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChain } from './helpers/evm.js';
import { saphanWorld, pr5Kit, tokenKitArtifacts, withAbi, SEPOLIA, BASE, ZETAPHY, CHAIN, E, ZERO, HYP } from './helpers/saphanroute.js';
import * as I from '../src/saphanintents.js';
import * as S from '../src/saphansealed.js';
import { calldataGas } from '../src/saphanagg.js';

const WINDOW = 600n;
let c, w, sep, intents, sealed, scores, threats, k, solverKey;
const a = (n) => c.acct[n].toString();
const TOK = new Interface(tokenKitArtifacts().KitToken.abi);
const SOLVER_SEED = '0x' + '5e'.repeat(32);

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'carol', 'solver', 'mallory', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor', 'ideploy']);
  w = await saphanWorld(c);
  k = pr5Kit();
  sep = await w.route(SEPOLIA);
  const yMailbox = await w.newMailbox(BASE);
  const yIsm = await c.deployRaw(w.kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  scores = await c.deployRaw(k.KitScores, [], 'gov');
  threats = await c.deployRaw(k.KitAddressThreats, [], 'gov');
  intents = await c.deployRaw(withAbi('SaphanIntents'), [scores.address, threats.address, w.zMailbox.address, yIsm.address, E, E / 2n, 600n, 3600n, 1800n, 900n], 'ideploy');
  const relay = await c.deployRaw(withAbi('SaphanFillRelay'), [yMailbox.address, ZETAPHY, intents.address], 'ideploy');
  await intents.send('ideploy', 'setRelay', [BASE, relay.address]);
  sealed = await c.deployRaw(withAbi('SaphanSealedOrders', 'SaphanIntents'), [intents.address], 'gov');
  solverKey = S.solverKey(SOLVER_SEED);
  await sealed.send('solver', 'setSolverKey', [solverKey.publicKey]);
});

const order = (o = {}) => ({ tokenIn: sep.token, amountIn: E, dstDomain: BASE, tokenOut: ZERO, recipient: a('bob'), minOut: (9n * E) / 10n,
  deadline: c.now() + 3600n, refundTo: a('alice'), ...o });
const ctx = () => ({ chainId: CHAIN, contract: sealed.address, solver: a('solver') });

/** alice seals `o` for the solver, with her tokens on ZETAPHY. Returns { id, s, ev }. */
async function commit(o = order(), who = 'alice') {
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  await sep.tok(who, 'approve', [sealed.address, o.amountIn]);
  const ev = await sealed.send(who, 'commit', [a('solver'), o.tokenIn, o.amountIn, o.refundTo, WINDOW, s.commitment, s.ciphertext]);
  return { id: ev.find((e) => e?.name === 'Committed').args.id, s, ev };
}

/** The solver reads the Committed event and decrypts it. */
function solverOpens(ev, secretKey = solverKey.secretKey) {
  const x = ev.find((e) => e?.name === 'Committed').args;
  return S.openOrder({ ...ctx(), secretKey, commitment: x.commitment, ciphertext: x.ciphertext });
}

test('JS: sealed to the solver\'s X-Wing key, only it opens; the commitment is the contract\'s; fixed size', async () => {
  const o = order();
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  assert.equal(getBytes(s.ciphertext).length, S.CIPHERTEXT_BYTES);
  assert.equal(await sealed.call('CIPHERTEXT_BYTES'), BigInt(S.CIPHERTEXT_BYTES));
  assert.equal(await sealed.call('commitmentOf', [a('solver'), I.orderTuple(o), s.salt]), s.commitment);
  const opened = S.openOrder({ ...ctx(), secretKey: solverKey.secretKey, commitment: s.commitment, ciphertext: s.ciphertext });
  assert.equal(opened.salt, s.salt);
  assert.equal(opened.order.recipient, o.recipient);
  assert.equal(opened.order.minOut, o.minOut);
  // another key, another contract, a flipped byte, a commitment it was not sealed under: nothing
  assert.equal(S.openOrder({ ...ctx(), secretKey: S.solverKey('0x' + '01'.repeat(32)).secretKey, commitment: s.commitment, ciphertext: s.ciphertext }), null);
  assert.equal(S.openOrder({ ...ctx(), contract: a('carol'), secretKey: solverKey.secretKey, commitment: s.commitment, ciphertext: s.ciphertext }), null);
  const bad = getBytes(s.ciphertext); bad[1300] ^= 1;
  assert.equal(S.openOrder({ ...ctx(), secretKey: solverKey.secretKey, commitment: s.commitment, ciphertext: hexlify(bad) }), null);
  assert.equal(S.openOrder({ ...ctx(), secretKey: solverKey.secretKey, commitment: '0x' + '11'.repeat(32), ciphertext: s.ciphertext }), null);
  // two seals of one order look unrelated (fresh salt and KEM randomness)
  const s2 = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  assert.notEqual(s2.commitment, s.commitment);
  assert.notEqual(s2.ciphertext, s.ciphertext);
});

test('commit on ZETAPHY: escrow + ciphertext, nothing of the order in clear; the solver reveals it into SaphanIntents', async (tc) => {
  await w.bridgeIn(sep, 'alice', 2n * E);
  const o = order();
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  await sep.tok('alice', 'approve', [sealed.address, E]);
  const args = [a('solver'), sep.token, E, a('alice'), WINDOW, s.commitment, s.ciphertext];
  const g = await sealed.gas('alice', 'commit', args);
  const ev = await sealed.send('alice', 'commit', args).catch(() => null);
  assert.equal(ev, null, 'the escrow was spent by the gas probe: approve again');
  await sep.tok('alice', 'approve', [sealed.address, E]);
  const ev2 = await sealed.send('alice', 'commit', args);
  const x = ev2.find((e) => e?.name === 'Committed').args;
  const id = x.id;
  assert.equal(id, S.sealedId(CHAIN, sealed.address, 1n));
  assert.equal(x.keyHash, solverKey.keyHash);
  assert.ok(!JSON.stringify(ev2.map((e) => e?.args?.toArray?.().map(String))).includes(a('bob').slice(2).toLowerCase()), 'the recipient is not in the event');
  assert.equal(await sep.bal(sealed.address), 2n * E, 'escrow (the gas probe\'s commit too)');
  const st = await sealed.call('sealedOf', [id]);
  assert.equal(S.STATUS[Number(st.status)], 'Sealed');

  const opened = solverOpens(ev2);
  assert.ok(opened);
  // nobody else reveals; the solver cannot change a field
  await assert.rejects(sealed.send('mallory', 'reveal', [id, I.orderTuple(opened.order), opened.salt]), /NotSolver/);
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple({ ...opened.order, minOut: 1n }), opened.salt]), /Mismatch/);
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple({ ...opened.order, recipient: a('mallory') }), opened.salt]), /Mismatch/);
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple(opened.order), '0x' + '00'.repeat(32)]), /Mismatch/);
  const rev = await c.rawTx('solver', sealed.address, sealed.iface.encodeFunctionData('reveal', [id, I.orderTuple(opened.order), opened.salt]));
  assert.ok(rev.ok);
  const logs = rev.logs.map((l) => { try { return sealed.iface.parseLog(l); } catch { return null; } });
  assert.ok(logs.find((e) => e?.name === 'Revealed'), 'the order and salt are public now: anyone checks the commitment');
  const intentId = logs.find((e) => e?.name === 'IntentOpened').args.intentId;
  assert.equal(intentId, I.intentId(CHAIN, intents.address, 0n));
  const rg = { exec: rev.gas, data: sealed.iface.encodeFunctionData('reveal', [id, I.orderTuple(opened.order), opened.salt]) };
  const st2 = await sealed.call('sealedOf', [id]);
  assert.equal(S.STATUS[Number(st2.status)], 'Revealed');
  const it = await intents.call('intentOf', [intentId]);
  assert.equal(I.STATUS[Number(it.status)], 'Open');
  assert.equal(it.order.recipient.toLowerCase(), a('bob').toLowerCase());
  assert.equal(it.order.refundTo.toLowerCase(), a('alice').toLowerCase());
  assert.equal(await sep.bal(intents.address), E, 'the escrow moved to SaphanIntents');
  assert.equal(await sealed.call('accounted', [sep.token]), E, 'the other sealed order is still held');
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple(opened.order), opened.salt]), /WrongStatus/);
  await assert.rejects(sealed.send('alice', 'refund', [id]), /WrongStatus/);
  tc.diagnostic(`SaphanSealedOrders gas: commit ${g.exec + 21000 + calldataGas(g.data)}, reveal (opens the intent) ${rg.exec + 21000 + calldataGas(rg.data)}`);
});

test('not revealed in time: the solver is too late, anyone triggers the refund, refundTo pulls it', async () => {
  await w.bridgeIn(sep, 'alice', E);
  const { id, ev } = await commit(order({ refundTo: a('carol') }));
  const opened = solverOpens(ev);
  await assert.rejects(sealed.send('bob', 'refund', [id]), /TooEarly/);
  c.advance(Number(WINDOW) + 1);
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple(opened.order), opened.salt]), /TooLate/);
  await sealed.send('bob', 'refund', [id]);
  await assert.rejects(sealed.send('bob', 'refund', [id]), /WrongStatus/);
  await assert.rejects(sealed.send('alice', 'claim', [sep.token]), /Nothing/, 'only refundTo');
  await sealed.send('carol', 'claim', [sep.token]);
  assert.equal(await sep.bal('carol'), E);
  assert.equal(await sealed.call('accounted', [sep.token]), 0n);
});

test('an order SaphanIntents refuses (risky recipient) cannot be revealed; it is refunded after the window', async () => {
  await w.bridgeIn(sep, 'alice', E);
  const { id, ev } = await commit();
  await scores.send('gov', 'set', [a('bob'), true, 3]);
  const opened = solverOpens(ev);
  await assert.rejects(sealed.send('solver', 'reveal', [id, I.orderTuple(opened.order), opened.salt]), /Risky/);
  assert.equal(S.STATUS[Number((await sealed.call('sealedOf', [id])).status)], 'Sealed');
  assert.equal(await sep.bal(intents.address), 0n);
  c.advance(Number(WINDOW) + 1);
  await sealed.send('bob', 'refund', [id]);
  await sealed.send('alice', 'claim', [sep.token]);
  assert.equal(await sep.bal('alice'), E);
});

/** The Gateway runs a call from Sepolia; its logs and SaphanSealedOrders' logs, parsed. */
async function execute(d) {
  const r = await c.rawTx('executor', sep.zgw.address, sep.zgw.iface.encodeFunctionData('execute', [d.p, true, d.n]));
  assert.ok(r.ok);
  return r.logs.map((l) => { for (const i of [sealed.iface, sep.zgw.iface]) { try { const x = i.parseLog(l); if (x) return x; } catch {} } return null; });
}

test('sealed from Sepolia in one transaction (depositAndCall), then revealed', async () => {
  const o = order();
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  const data = S.sealedCallData({ solver: a('solver'), refundTo: a('alice'), window: WINDOW, commitment: s.commitment, ciphertext: s.ciphertext });
  const d = await w.depositAndCall(sep, sealed.address, { amount: E, data, revertTo: a('alice') });
  const ev = await execute(d);
  assert.ok(!ev.find((e) => e?.name === 'CallFailed'));
  const sealedEv = ev.find((e) => e?.name === 'Committed');
  assert.ok(sealedEv, 'Committed');
  const id = sealedEv.args.id;
  assert.equal(sealedEv.args.srcChainId, CHAIN);
  const opened = solverOpens(ev);
  await sealed.send('solver', 'reveal', [id, I.orderTuple(opened.order), opened.salt]);
  assert.equal(await sep.bal(intents.address), E);
  // a seal for a solver without a key fails, and the Gateway keeps it for the refund on Sepolia
  const bad = S.sealedCallData({ solver: a('carol'), refundTo: a('alice'), window: WINDOW, commitment: s.commitment, ciphertext: s.ciphertext });
  const d2 = await w.depositAndCall(sep, sealed.address, { amount: E, data: bad, revertTo: a('alice') });
  const ev2 = await execute(d2);
  assert.ok(ev2.find((e) => e?.name === 'CallFailed'));
});

test('ZETAPHY fills: reveal, open and fill in one transaction (never public before it is filled)', async () => {
  const tk = tokenKitArtifacts().KitToken;
  const usd = await c.deployRaw(tk, ['Test USD', 'tUSD', 6], 'gov');
  const zt = await c.deployRaw(tk, ['Wanted', 'WNT', 18], 'gov');
  await usd.send('gov', 'mint', [a('alice'), 500n]);
  await zt.send('gov', 'mint', [a('solver'), 1000n]);
  const o = order({ tokenIn: usd.address, amountIn: 500n, dstDomain: Number(CHAIN), tokenOut: zt.address, minOut: 400n });
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  await usd.send('alice', 'approve', [sealed.address, 500n]);
  const ev = await sealed.send('alice', 'commit', [a('solver'), usd.address, 500n, a('alice'), WINDOW, s.commitment, s.ciphertext]);
  const id = ev.find((e) => e?.name === 'Committed').args.id;
  const opened = solverOpens(ev);
  await zt.send('solver', 'approve', [sealed.address, 400n]);
  await threats.send('gov', 'setHeld', [a('solver'), true]);
  await assert.rejects(sealed.send('solver', 'revealAndFillLocal', [id, I.orderTuple(opened.order), opened.salt, 400n, a('solver')]), /SolverHeld/);
  await threats.send('gov', 'setHeld', [a('solver'), false]);
  await assert.rejects(sealed.send('solver', 'revealAndFillLocal', [id, I.orderTuple(opened.order), opened.salt, 399n, a('solver')]), /BadOrder/);
  await sealed.send('solver', 'revealAndFillLocal', [id, I.orderTuple(opened.order), opened.salt, 400n, a('solver')]);
  assert.equal(await c.callAt(zt.address, TOK, 'balanceOf', [a('bob')]), 400n);
  await intents.send('solver', 'claim', [usd.address]);
  assert.equal(await c.callAt(usd.address, TOK, 'balanceOf', [a('solver')]), 500n);
  assert.equal(await c.callAt(zt.address, TOK, 'balanceOf', [sealed.address]), 0n);
});

test('bad seals and keys are refused', async () => {
  await w.bridgeIn(sep, 'alice', E);
  await assert.rejects(sealed.send('carol', 'setSolverKey', ['0x' + '11'.repeat(1184)]), /BadKey/, 'X-Wing keys are 1216 bytes');
  const o = order();
  const s = S.sealOrder({ ...ctx(), solverPublicKey: solverKey.publicKey, order: o });
  await sep.tok('alice', 'approve', [sealed.address, E]);
  const go = (x = {}) => sealed.send('alice', 'commit', [x.solver ?? a('solver'), sep.token, x.amount ?? E, x.refundTo ?? a('alice'), x.window ?? WINDOW,
    x.commitment ?? s.commitment, x.ciphertext ?? s.ciphertext]);
  await assert.rejects(go({ solver: a('carol') }), /BadKey/);
  await assert.rejects(go({ amount: 0n }), /BadSeal/);
  await assert.rejects(go({ refundTo: ZERO }), /BadSeal/);
  await assert.rejects(go({ window: 59n }), /BadSeal/);
  await assert.rejects(go({ window: 86401n }), /BadSeal/);
  await assert.rejects(go({ ciphertext: s.ciphertext + '00' }), /BadSeal/);
  await assert.rejects(go({ commitment: '0x' + '00'.repeat(32) }), /BadSeal/);
  await assert.rejects(go({ amount: 2n * E }), /PayFailed/, 'more than approved');
  await go();
  // a solver that rotates its key keeps the orders sealed to the old one
  await sealed.send('solver', 'setSolverKey', ['0x']);
  assert.equal(await sealed.call('solverKey', [a('solver')]), '0x' + '00'.repeat(32));
  assert.equal((await sealed.call('sealedOf', [S.sealedId(CHAIN, sealed.address, 0n)])).keyHash, solverKey.keyHash);
});

test('CLI (offline): sealed key / seal / open and agg batch / digest round-trip', async () => {
  const { run } = await import('../scripts/saphan-ops.js');
  const dir = mkdtempSync(join(tmpdir(), 'saphan-pr4-'));
  try {
    const seedFile = join(dir, 'solver.seed');
    const k1 = await run('sealed', 'key', { 'seed-file': seedFile });
    const k2 = await run('sealed', 'key', { 'seed-file': seedFile });
    assert.equal(k1.publicKey, k2.publicKey, 'the seed file is made once, then reused');
    const o = { tokenIn: a('carol'), amountIn: '10', dstDomain: BASE, tokenOut: ZERO, recipient: a('bob'), minOut: '9', deadline: '2000000000', refundTo: a('alice') };
    const orderFile = join(dir, 'order.json');
    writeFileSync(orderFile, JSON.stringify(o));
    const s = await run('sealed', 'seal', { contract: sealed.address, solver: a('solver'), key: k1.publicKey, order: orderFile, 'chain-id': '1' });
    const back = await run('sealed', 'open', { contract: sealed.address, solver: a('solver'), 'seed-file': seedFile, commitment: s.commitment, ciphertext: s.ciphertext, 'chain-id': '1' });
    assert.equal(back.order.recipient.toLowerCase(), a('bob').toLowerCase());
    assert.equal(back.salt, s.salt);
    assert.equal(s.commitment, await sealed.call('commitmentOf', [a('solver'), I.orderTuple({ ...o, amountIn: 10n, minOut: 9n, deadline: 2000000000n }), s.salt]));
    const bad = await run('sealed', 'open', { contract: a('carol'), solver: a('solver'), 'seed-file': seedFile, commitment: s.commitment, ciphertext: s.ciphertext });
    assert.ok(bad.error);
    const tf = join(dir, 't.json');
    writeFileSync(tf, JSON.stringify([0, 1, 2].map((n) => ({ srcChainId: '1', srcContract: a('carol'), srcNonce: String(n), sender: a('alice'), to: a('alice'), amount: '5' }))));
    const b = await run('agg', 'batch', { file: tf });
    assert.equal(b.proofs.length, 3);
    const dg = await run('agg', 'digest', { lane: a('carol'), epoch: '1', root: b.root });
    assert.match(dg.digest, /^0x[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
