// ZETAPHY Offline Cash (docs/future/offline-cash.md): ZetaphyOfflineCash in the in-memory EVM with the real ML-DSA-44
// precompile (helpers/precompiles.js, @noble/post-quantum), every chain built and signed by the shared logic
// (zetaphy-hub/cash-core.js) the hub and the CLI use. Issue, pass on, redeem, double-spends paid from the right bond,
// lockUntil, bond accounting, swap tickets (atomic), replay, and the hashes against the contract's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES } from './helpers/precompiles.js';
import { core, NODE_CRYPTO as C, holderFromSeed } from '../src/offlinecash.js';

const DAY = 86400;
const seed = (n) => new Uint8Array(32).fill(n);
const ISSUER = holderFromSeed(seed(1));
const [A, B, X, C2, D, P, Q, W] = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => holderFromSeed(seed(n)));

async function world({ bond = 30n * ZETA, lockDays = 30 } = {}) {
  const c = await createChain(['issuer', 'relayer', 'alice', 'bob', 'xavier', 'carol', 'dave', 'bonder'], {}, { precompiles: PRECOMPILES });
  const cash = await c.deploy('ZetaphyOfflineCash', [], 'issuer');
  const a = (n) => c.acct[n].toString().toLowerCase();
  const lockUntil = Number(c.now()) + lockDays * DAY;
  if (bond) await cash.send('issuer', 'bondIssuer', [BigInt(lockUntil + 31 * DAY)], bond);
  const bal = (n) => c.balance(n);
  return { c, cash, a, lockUntil, bal };
}
/** Issues notes; returns their bundles (chain id 1: the in-memory EVM). */
async function issue(w, values, lockUntil = w.lockUntil, key = ISSUER.key) {
  const ev = await w.cash.send('issuer', 'issue', [key, BigInt(lockUntil), values], values.reduce((s, v) => s + v, 0n));
  return ev.filter((e) => e?.name === 'NoteIssued').map((e) => ({ v: 1, chainId: 1, contract: w.cash.address.toLowerCase(),
    note: { id: String(e.args.id), issuer: w.a('issuer'), value: String(e.args.value), lockUntil: Number(e.args.lockUntil), issuerKey: e.args.issuerKey }, links: [] }));
}
const args = (b) => { const x = core.cleanBundle(b); return [BigInt(x.note.id), x.links.map((l) => [l.to, l.cond, l.pk, l.sig]), [x.terminal.payout, BigInt(x.terminal.fee), x.terminal.pk, x.terminal.sig]]; };
const redeem = (w, from, b) => w.cash.send(from, 'redeem', args(b));
const pass = (b, from, to) => core.passOn(C, b, from, to.key);
const term = (b, from, payout, fee = 0n) => core.signTerminal(C, b, from, payout, fee);
const evt = (ev, name) => ev.find((e) => e?.name === name);
/** A link signed with no wallet checks (a cheater's tool: passOn refuses to pass on a swap leg). */
function rawPass(b, from, to) {
  const w = core.walk(C, b);
  const h = core.linkHash(C, w.domain, w.bundle.note.id, w.seq, w.prevs[w.seq], to.key);
  return { ...w.bundle, links: [...w.bundle.links, { to: to.key, cond: core.ZERO32, pk: core.hex(from.pk), sig: core.hex(from.sign(core.bytes(h))) }] };
}

test('cash: the hashes, the domain and the calldata are the contract\'s own', async () => {
  const w = await world();
  const [n] = await issue(w, [5n * ZETA]);
  const dom = core.domainOf(C, 1, w.cash.address);
  assert.equal(await w.cash.call('DOMAIN'), dom);
  const root = core.noteRoot(C, dom, n.note);
  assert.equal(await w.cash.call('noteRoot', [1n]), root);
  assert.equal(await w.cash.call('linkHash', [1n, 0n, root, A.key, core.ZERO32]), core.linkHash(C, dom, 1, 0, root, A.key));
  assert.equal(await w.cash.call('terminalHash', [root, w.a('alice'), 7n]), core.terminalHash(C, dom, root, w.a('alice'), 7n));
  const t = { noteA: 1, seqA: 2, prevA: root, toA: A.key, payoutA: w.a('alice'), noteB: 3, seqB: 0, prevB: '0x' + '11'.repeat(32), toB: B.key, payoutB: w.a('bob'), deadline: 123 };
  assert.equal(await w.cash.call('ticketId', [[t.noteA, t.seqA, t.prevA, t.toA, t.payoutA, t.noteB, t.seqB, t.prevB, t.toB, t.payoutB, t.deadline]]), core.ticketId(C, dom, t));
  for (const [name, sig] of [['NoteIssued', core.SIGS.noteIssued], ['IssuerBonded', core.SIGS.issuerBonded], ['HolderBonded', core.SIGS.holderBonded]]) {
    assert.equal(w.cash.iface.getEvent(name).topicHash, core.topicOf(C, sig), name);
  }
  const b = term(pass(n, ISSUER, A), A, w.a('alice'), 1n);
  assert.equal(core.encodeRedeem(C, b), w.cash.iface.encodeFunctionData('redeem', args(b)));
  assert.equal(core.encodeBondHolder(C, A.key, 99n), w.cash.iface.encodeFunctionData('bondHolder', [A.key, 99n]));
  assert.equal(core.selectorOf(C, core.SIGS.settleSwap), w.cash.iface.getFunction('settleSwap').selector);
  const nt = core.decodeNotes(await w.c.rawCallHex(w.cash.address, core.encodeNotes(C, 1n)));
  assert.deepEqual(nt, { issuer: w.a('issuer'), value: String(5n * ZETA), lockUntil: w.lockUntil, done: false, issuerKey: ISSUER.key });
});

test('cash: issuing needs a bond of 150% locked past lockUntil + 30 days; lockUntil 1 to 366 days; exact value', async () => {
  const w = await world({ bond: 0n });
  const lu = BigInt(w.lockUntil);
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, lu, [10n * ZETA]], 10n * ZETA), /BondTooSmall/);
  await w.cash.send('issuer', 'bondIssuer', [lu + BigInt(29 * DAY)], 15n * ZETA);
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, lu, [10n * ZETA]], 10n * ZETA), /BondLocked/, 'bond unlocks before the claim window ends');
  await assert.rejects(w.cash.send('issuer', 'bondIssuer', [lu], 0n), /BadLock/, 'never earlier');
  await w.cash.send('issuer', 'bondIssuer', [lu + BigInt(30 * DAY)], 0n);
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, lu, [10n * ZETA]], 9n * ZETA), /BadValue/);
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, lu, [10n * ZETA, 0n]], 10n * ZETA), /BadValue/);
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, BigInt(Number(w.c.now()) + 3600), [ZETA]], ZETA), /BadLock/, 'under a day');
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, BigInt(Number(w.c.now()) + 367 * DAY), [ZETA]], ZETA), /BadLock/);
  await assert.rejects(w.cash.send('issuer', 'issue', [core.ZERO32, lu, [ZETA]], ZETA), /BadNote/);
  await w.cash.send('issuer', 'issue', [ISSUER.key, lu, [5n * ZETA, 5n * ZETA]], 10n * ZETA); // 15 bond = 150% of 10
  await assert.rejects(w.cash.send('issuer', 'issue', [ISSUER.key, lu, [1n]], 1n), /BondTooSmall/, 'one wei more is over 150%');
  const [bond, , out, healthy] = await w.cash.call('issuerCover', [w.a('issuer')]);
  assert.deepEqual([bond, out, healthy], [15n * ZETA, 10n * ZETA, true]);
  assert.equal(await w.cash.call('noteCount'), 2n);
  await assert.rejects(w.cash.send('issuer', 'withdrawIssuerBond', []), /BondLocked/, 'the bond stays for the claim window');
});

test('cash: passed hand to hand offline (issuer -> A -> B -> C), C cashes through a relayer; replay and old chains pay nothing', async () => {
  const w = await world();
  const [n] = await issue(w, [4n * ZETA]);
  const b1 = pass(n, ISSUER, A), b2 = pass(b1, A, B), b3 = pass(b2, B, C2);
  const v = core.walk(C, b3);
  assert.ok(v.ok, v.problems.join());
  assert.equal(v.holder, C2.key);
  assert.throws(() => pass(b2, A, X), /not the holder/, 'only the current holder can pass it on');
  const cashOut = term(b3, C2, w.a('carol'), ZETA / 10n);
  const [carol, relayer] = [await w.bal('carol'), await w.bal('relayer')];
  const ev = await redeem(w, 'relayer', cashOut);
  assert.deepEqual([evt(ev, 'Redeemed').args.amount, evt(ev, 'Redeemed').args.fee, evt(ev, 'Redeemed').args.links], [4n * ZETA - ZETA / 10n, ZETA / 10n, 3n]);
  assert.equal(await w.bal('carol') - carol, 4n * ZETA - ZETA / 10n);
  assert.equal(await w.bal('relayer') - relayer, ZETA / 10n);
  assert.equal(await w.cash.call('outstanding', [w.a('issuer')]), 0n);
  await assert.rejects(redeem(w, 'relayer', cashOut), /AlreadyPaid/, 'the same chain again');
  await assert.rejects(redeem(w, 'relayer', term(b2, B, w.a('bob'))), /OwnDoubleSpend/, 'B passed it on, then tries to cash it himself');
  // signatures: a chain with a link signed by the wrong key, a broken signature, a changed payout
  const [m] = await issue(w, [ZETA]);
  const bad = pass(m, ISSUER, A);
  const forged = { ...bad, links: [{ ...bad.links[0], pk: core.hex(B.pk) }] };
  await assert.rejects(redeem(w, 'relayer', { ...forged, terminal: term(bad, A, w.a('alice')).terminal }), /WrongKey/);
  const sig = core.bytes(bad.links[0].sig); sig[5] ^= 1;
  await assert.rejects(redeem(w, 'relayer', { ...term(bad, A, w.a('alice')), links: [{ ...bad.links[0], sig: core.hex(sig) }] }), /BadSignature/);
  const t = term(bad, A, w.a('alice'));
  await assert.rejects(redeem(w, 'relayer', { ...t, terminal: { ...t.terminal, payout: w.a('xavier') } }), /BadSignature/, 'payout bound by the holder');
  await assert.rejects(redeem(w, 'relayer', { ...t, terminal: { ...t.terminal, fee: '2' } }), /BadSignature/, 'fee bound too');
  // the issuer itself may cash an unspent note directly (no links)
  const before = await w.bal('issuer');
  await redeem(w, 'relayer', term(m, ISSUER, w.a('issuer')));
  assert.equal(await w.bal('issuer') - before, ZETA);
  // ...after passing it to A: that is the issuer's double-spend, A is paid from the issuer bond
  const evI = await redeem(w, 'relayer', t);
  assert.deepEqual([evt(evI, 'FraudPaid').args.cheater, evt(evI, 'FraudPaid').args.issuerBond], [ISSUER.key, true]);
});

test('cash: the issuer double-spends a note: the earliest chain wins, the victim is paid from the ISSUER bond', async () => {
  const w = await world();
  const [n] = await issue(w, [6n * ZETA]);
  const toA = pass(n, ISSUER, A), toX = pass(n, ISSUER, X);
  const split = core.findSplit(C, toA, toX);
  assert.deepEqual([split.seq, split.cheater, split.issuer], [0, ISSUER.key, true]);
  await redeem(w, 'relayer', term(toX, X, w.a('xavier'))); // X is first on chain: X gets the note's value
  const alice = await w.bal('alice');
  const ev = await redeem(w, 'relayer', term(toA, A, w.a('alice')));
  const f = evt(ev, 'FraudPaid');
  assert.deepEqual([f.args.cheater, f.args.seq, f.args.paid, f.args.shortfall, f.args.issuerBond], [ISSUER.key, 0n, 6n * ZETA, 0n, true]);
  assert.equal(await w.bal('alice') - alice, 6n * ZETA);
  assert.equal((await w.cash.call('issuerBonds', [w.a('issuer')]))[2], 24n * ZETA, 'bond 30 - 6');
  await assert.rejects(redeem(w, 'relayer', term(toA, A, w.a('alice'))), /AlreadyPaid/, 'a victim is paid once');
  await assert.rejects(redeem(w, 'relayer', term(toA, A, w.a('bob'))), /OwnDoubleSpend/, 'a second cash-out with another payout is the victim\'s own double-spend');
  // a third copy: another victim, paid too (first come, first served while the bond lasts)
  await redeem(w, 'relayer', term(pass(n, ISSUER, B), B, w.a('bob')));
  assert.equal((await w.cash.call('issuerBonds', [w.a('issuer')]))[2], 18n * ZETA);
});

test('cash: a later holder double-spends: paid from THAT holder\'s bond; no bond, no pay; a partial bond pays what it has', async () => {
  const w = await world();
  const [n1, n2] = await issue(w, [5n * ZETA, 5n * ZETA]);
  // A has no holder bond: B (the victim) is not paid, the issuer bond is not touched
  const a1 = pass(n1, ISSUER, A);
  await redeem(w, 'relayer', term(pass(a1, A, X), X, w.a('xavier')));
  await assert.rejects(redeem(w, 'relayer', term(pass(a1, A, B), B, w.a('bob'))), /BondEmpty/);
  // A bonds 3 (owner: bonder); a second victim gets 3, shortfall 2
  const until = BigInt(w.lockUntil + 31 * DAY);
  await w.cash.send('bonder', 'bondHolder', [A.key, until], 3n * ZETA);
  await assert.rejects(w.cash.send('alice', 'bondHolder', [A.key, until], ZETA), /NotBondOwner/);
  const bob = await w.bal('bob');
  const ev = await redeem(w, 'relayer', term(pass(a1, A, B), B, w.a('bob')));
  const f = evt(ev, 'FraudPaid');
  assert.deepEqual([f.args.cheater, f.args.seq, f.args.paid, f.args.shortfall, f.args.issuerBond], [A.key, 1n, 3n * ZETA, 2n * ZETA, false]);
  assert.equal(await w.bal('bob') - bob, 3n * ZETA);
  assert.equal((await w.cash.call('issuerBonds', [w.a('issuer')]))[2], 30n * ZETA, 'the issuer answers only for its own signatures');
  // the victim's branch is now recorded: down it, B passes on twice -> the second is B's fraud
  const a2 = pass(n2, ISSUER, A);
  await w.cash.send('bonder', 'bondHolder', [A.key, until], 10n * ZETA);
  await w.cash.send('bob', 'bondHolder', [B.key, until], 10n * ZETA);
  await redeem(w, 'relayer', term(pass(a2, A, X), X, w.a('xavier')));
  const b2 = pass(a2, A, B);
  const ev2 = await redeem(w, 'relayer', term(pass(b2, B, C2), C2, w.a('carol')));
  assert.equal(evt(ev2, 'FraudPaid').args.cheater, A.key, 'C is A\'s victim');
  const ev3 = await redeem(w, 'relayer', term(pass(b2, B, D), D, w.a('dave')));
  assert.deepEqual([evt(ev3, 'FraudPaid').args.cheater, evt(ev3, 'FraudPaid').args.seq], [B.key, 2n], 'D is B\'s victim: B split the already-compensated branch');
  await assert.rejects(redeem(w, 'relayer', term(pass(b2, B, D), D, w.a('dave'))), /AlreadyPaid/);
  // the holder who cashed it himself after passing it on is the cheater; he cannot claim against himself
  const [n3] = await issue(w, [ZETA]);
  const a3 = pass(n3, ISSUER, A);
  await redeem(w, 'relayer', term(a3, A, w.a('alice')));
  const evC = await redeem(w, 'relayer', term(pass(a3, A, B), B, w.a('bob')));
  assert.deepEqual([evt(evC, 'FraudPaid').args.cheater, evt(evC, 'FraudPaid').args.seq], [A.key, 1n]);
});

test('cash: lockUntil: no reclaim before; after it the issuer takes back what nobody cashed; claims end 30 days later', async () => {
  const w = await world();
  const [n1, n2, n3] = await issue(w, [ZETA, 2n * ZETA, 3n * ZETA]);
  await assert.rejects(w.cash.send('issuer', 'reclaim', [[1n]]), /NotUnlocked/);
  await assert.rejects(w.cash.send('alice', 'reclaim', [[1n]]), /NotIssuer/);
  w.c.advance(30 * DAY + 1);
  // after lockUntil a holder can still cash a note the issuer has not reclaimed
  await redeem(w, 'relayer', term(pass(n2, ISSUER, A), A, w.a('alice')));
  const before = await w.bal('issuer');
  await w.cash.send('issuer', 'reclaim', [[1n]]);
  assert.equal(await w.bal('issuer') - before, ZETA);
  await assert.rejects(w.cash.send('issuer', 'reclaim', [[1n]]), /NoteDone/);
  await assert.rejects(w.cash.send('issuer', 'reclaim', [[2n]]), /NoteDone/);
  // a holder of a reclaimed note has nothing to claim (expiry is not fraud)
  await assert.rejects(redeem(w, 'relayer', term(pass(n1, ISSUER, A), A, w.a('alice'))), /NothingToClaim/);
  // fraud claims stop at lockUntil + 30 days
  const x3 = pass(n3, ISSUER, X);
  await redeem(w, 'relayer', term(x3, X, w.a('xavier')));
  w.c.advance(30 * DAY);
  await assert.rejects(redeem(w, 'relayer', term(pass(n3, ISSUER, A), A, w.a('alice'))), /ClaimWindowOver/);
  assert.equal(await w.cash.call('outstanding', [w.a('issuer')]), 0n);
  w.c.advance(2 * DAY);
  const b0 = await w.bal('issuer');
  await w.cash.send('issuer', 'withdrawIssuerBond', []);
  assert.equal(await w.bal('issuer') - b0, 30n * ZETA);
  assert.equal(await w.c.balance(Address.fromString(w.cash.address)), 0n, 'nothing left behind');
});

test('cash: holder bonds: owner only, locked until `until`, never earlier', async () => {
  const w = await world();
  const until = BigInt(Number(w.c.now()) + 10 * DAY);
  await assert.rejects(w.cash.send('alice', 'bondHolder', [core.ZERO32, until], ZETA), /BadBond/);
  const ev = await w.cash.send('alice', 'bondHolder', [A.key, until], 2n * ZETA);
  assert.deepEqual([evt(ev, 'HolderBonded').args.amount, evt(ev, 'HolderBonded').args.until], [2n * ZETA, until]);
  await assert.rejects(w.cash.send('alice', 'bondHolder', [A.key, until - 1n], ZETA), /BadLock/);
  await assert.rejects(w.cash.send('alice', 'withdrawHolderBond', [A.key]), /BondLocked/);
  await assert.rejects(w.cash.send('bob', 'withdrawHolderBond', [A.key]), /NotBondOwner/);
  w.c.advance(10 * DAY + 1);
  const b0 = await w.bal('alice');
  await w.cash.send('alice', 'withdrawHolderBond', [A.key]);
  assert.equal(await w.bal('alice') - b0, 2n * ZETA);
  await assert.rejects(w.cash.send('alice', 'withdrawHolderBond', [A.key]), /BondEmpty/);
});

test('cash: an atomic swap ticket pays both notes or neither; its legs are not spends until settled', async () => {
  const w = await world();
  const [nA, nB, nC] = await issue(w, [2n * ZETA, 7n * ZETA, ZETA]);
  const a = pass(nA, ISSUER, P), b = pass(nB, ISSUER, Q); // P holds A, Q holds B
  const deadline = Number(w.c.now()) + DAY;
  let swap = core.newSwap(C, a, b, { toA: Q.key, toB: P.key, payoutA: w.a('bob'), payoutB: w.a('alice'), deadline });
  swap = core.signLeg(C, swap, 'A', P);
  assert.equal(core.verifySwap(C, swap, { now: Number(w.c.now()) }).complete, false, 'half signed: an offer');
  assert.throws(() => core.signLeg(C, swap, 'B', P), /not the holder/);
  swap = core.signLeg(C, swap, 'B', Q);
  const v = core.verifySwap(C, swap, { now: Number(w.c.now()) });
  assert.ok(v.ok, v.problems.join());
  const ch = core.swapChains(C, swap);
  // a leg alone can never be cashed
  await assert.rejects(redeem(w, 'relayer', term(ch.a, Q, w.a('bob'))), /UnsettledSwap/);
  const tk = (s) => { const t = s.ticket; return [t.noteA, t.seqA, t.prevA, t.toA, t.payoutA, t.noteB, t.seqB, t.prevB, t.toB, t.payoutB, t.deadline]; };
  const lk = (bb) => bb.links.map((l) => [l.to, l.cond, l.pk, l.sig]);
  assert.equal(core.encodeSettleSwap(C, swap), w.cash.iface.encodeFunctionData('settleSwap', [tk(swap), lk(ch.a), lk(ch.b)]));
  await assert.rejects(w.cash.send('relayer', 'settleSwap', [tk(swap), lk(ch.b), lk(ch.a)]), /BadTicket|BadSignature/, 'legs swapped');
  await assert.rejects(w.cash.send('relayer', 'settleSwap', [Object.assign([...tk(swap)], { 10: deadline + 1 }), lk(ch.a), lk(ch.b)]), /BadTicket/, 'a changed deadline is another ticket');
  const [bob, alice] = [await w.bal('bob'), await w.bal('alice')];
  const ev = await w.cash.send('relayer', 'settleSwap', [tk(swap), lk(ch.a), lk(ch.b)]);
  assert.equal(evt(ev, 'SwapSettled').args.ticket, v.tid);
  assert.equal(await w.bal('bob') - bob, 2n * ZETA, 'Q gets note A');
  assert.equal(await w.bal('alice') - alice, 7n * ZETA, 'P gets note B');
  await assert.rejects(w.cash.send('relayer', 'settleSwap', [tk(swap), lk(ch.a), lk(ch.b)]), /AlreadyPaid/, 'replay');
  // after settling, Q passes A on offline anyway: W is Q's victim (Q's ticket signature was his cash-out of A)
  await w.cash.send('bob', 'bondHolder', [Q.key, BigInt(w.lockUntil + 31 * DAY)], 5n * ZETA);
  const evW = await redeem(w, 'relayer', term(rawPass(ch.a, Q, W), W, w.a('dave')));
  assert.deepEqual([evt(evW, 'FraudPaid').args.cheater, evt(evW, 'FraudPaid').args.paid], [Q.key, 2n * ZETA]);

  // atomic: P double-spends note C before the swap settles -> the swap cannot settle, nothing moves, Q keeps his note
  const [nD] = await issue(w, [3n * ZETA]);
  const c1 = pass(nC, ISSUER, P), d1 = pass(nD, ISSUER, Q);
  let s2 = core.newSwap(C, c1, d1, { toA: Q.key, toB: P.key, payoutA: w.a('bob'), payoutB: w.a('alice'), deadline });
  s2 = core.signLeg(C, core.signLeg(C, s2, 'A', P), 'B', Q);
  await redeem(w, 'relayer', term(pass(c1, P, X), X, w.a('xavier'))); // P's other spend lands first
  const ch2 = core.swapChains(C, s2);
  await assert.rejects(w.cash.send('relayer', 'settleSwap', [tk(s2), lk(ch2.a), lk(ch2.b)]), /NoteDone/);
  assert.equal((await w.cash.call('notes', [BigInt(nD.note.id)]))[3], false, 'note D untouched');
  const q0 = await w.bal('bob');
  await redeem(w, 'relayer', term(d1, Q, w.a('bob'))); // Q's unsettled leg is no spend: Q cashes D normally
  assert.equal(await w.bal('bob') - q0, 3n * ZETA);
  // and an expired ticket cannot settle
  const [nE, nF] = await issue(w, [ZETA, ZETA]);
  let s3 = core.newSwap(C, pass(nE, ISSUER, P), pass(nF, ISSUER, Q), { toA: Q.key, toB: P.key, payoutA: w.a('bob'), payoutB: w.a('alice'), deadline });
  s3 = core.signLeg(C, core.signLeg(C, s3, 'A', P), 'B', Q);
  w.c.advance(DAY + 1);
  const ch3 = core.swapChains(C, s3);
  await assert.rejects(w.cash.send('relayer', 'settleSwap', [tk(s3), lk(ch3.a), lk(ch3.b)]), /Expired/);
});

test('cash: a chain signed for one contract is refused by another (domain: chain id and contract)', async () => {
  const w = await world();
  const [n] = await issue(w, [ZETA]);
  const other = await w.c.deploy('ZetaphyOfflineCash', [], 'issuer');
  await other.send('issuer', 'bondIssuer', [BigInt(w.lockUntil + 31 * DAY)], 2n * ZETA);
  await other.send('issuer', 'issue', [ISSUER.key, BigInt(w.lockUntil), [ZETA]], ZETA);
  const b = term(pass(n, ISSUER, A), A, w.a('alice'));
  await assert.rejects(other.send('relayer', 'redeem', args(b)), /BadSignature/);
  await redeem(w, 'relayer', b);
  // and the in-memory checks agree: the bundle names its contract, which a payee pins
  const r = core.receiveCheck(C, pass(n, ISSUER, A), { me: A.key, contract: other.address, evmChainId: 1, now: Number(w.c.now()) });
  assert.ok(r.problems.includes('wrongContract'));
  const iface = new Interface(['function redeem(uint256,(bytes32,bytes32,bytes,bytes)[],(address,uint96,bytes,bytes))']);
  assert.equal(iface.getFunction('redeem').selector, core.selectorOf(C, core.SIGS.redeem));
});
