// Saphan PR 5, intents with Neuro risk (contracts/SaphanIntents.sol): "I give A on chain X, I want >= B on chain Y
// by T". A solver pays the recipient on Y with its own money (SaphanFillRelay) and is repaid A on ZETAPHY once the
// fill is proven (its Hyperlane message), or optimistically (a bonded claim nobody challenged). A false claim loses
// its bond. Neuro's score and the ThreatRegistry gate (refuse) or delay risky recipients.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { createChain } from './helpers/evm.js';
import { saphanWorld, pr5Kit, tokenKitArtifacts, withAbi, SEPOLIA, BASE, ZETAPHY, CHAIN, E, ZERO, HYP } from './helpers/saphanroute.js';
import * as I from '../src/saphanintents.js';

const BOND = E;
const CBOND = E / 2n;
const WINDOW = 600n;
const DISPUTE = 3600n;
const GRACE = 1800n;
const RISK_DELAY = 900n;
let c, w, sep, yMailbox, intents, relay, scores, threats, k;
const a = (n) => c.acct[n].toString();
const TOK = new Interface(tokenKitArtifacts().KitToken.abi);

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'carol', 'solver', 'liar', 'watcher', 'attacker', 'relayer', 'lane2', 'odeploy', 'gdeploy', 'executor', 'ideploy']);
  w = await saphanWorld(c);
  opened = 0n;
  k = pr5Kit();
  sep = await w.route(SEPOLIA);
  yMailbox = await w.newMailbox(BASE);
  const yIsm = await c.deployRaw(w.kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  scores = await c.deployRaw(k.KitScores, [], 'gov');
  threats = await c.deployRaw(k.KitAddressThreats, [], 'gov');
  intents = await c.deployRaw(withAbi('SaphanIntents'), [scores.address, threats.address, w.zMailbox.address, yIsm.address, BOND, CBOND, WINDOW, DISPUTE, GRACE, RISK_DELAY], 'ideploy');
  relay = await c.deployRaw(withAbi('SaphanFillRelay'), [yMailbox.address, ZETAPHY, intents.address], 'ideploy');
  await assert.rejects(intents.send('attacker', 'setRelay', [BASE, a('attacker')]));
  await intents.send('ideploy', 'setRelay', [BASE, relay.address]);
  await assert.rejects(intents.send('ideploy', 'setRelay', [BASE, a('attacker')]), 'once per chain');
});

const order = (o = {}) => ({ tokenIn: sep.token, amountIn: E, dstDomain: BASE, tokenOut: ZERO, recipient: a('bob'), minOut: (9n * E) / 10n,
  deadline: c.now() + 3600n, refundTo: a('alice'), ...o });
let opened = 0n;
/** alice opens an intent from Sepolia in one transaction (depositAndCall to SaphanIntents); returns its id. */
async function openFromSepolia(o = order(), who = 'alice') {
  const d = await w.depositAndCall(sep, intents.address, { amount: o.amountIn, who, data: I.orderData(o), revertTo: a(who) });
  const ev = await sep.zgw.send('executor', 'execute', [d.p, true, d.n]);
  if (ev.find((e) => e?.name === 'CallFailed')) return { refused: true, ev };
  return { id: I.intentId(CHAIN, intents.address, opened++), ev };
}
/** A solver fills on Base: pays the recipient now, the message goes to ZETAPHY (returned, not yet relayed). */
async function fillOnBase(id, { solver = 'solver', recipient = a('bob'), amount = (95n * E) / 100n, repayTo = a(solver) } = {}) {
  const fee = await relay.call('quote', [id, recipient, amount, repayTo]);
  await relay.send(solver, 'fill', [id, recipient, amount, repayTo], amount + fee);
  return w.lastMessage(yMailbox);
}

test('opened from Sepolia in one transaction; a solver pays on Base at once; its fill message repays it on ZETAPHY', async () => {
  const { id } = await openFromSepolia();
  const it = await intents.call('intentOf', [id]);
  assert.equal(I.STATUS[Number(it.status)], 'Open');
  assert.equal(await sep.bal(intents.address), E, 'A is in escrow on ZETAPHY');
  assert.equal(I.fillProblem(it, { domain: BASE, recipient: a('bob'), amountOut: E, now: c.now() }), null);
  assert.match(I.fillProblem(it, { domain: BASE, recipient: a('carol'), amountOut: E, now: c.now() }), /recipient/);
  const bobBefore = await c.balance('bob');
  const m = await fillOnBase(id);
  assert.equal((await c.balance('bob')) - bobBefore, (95n * E) / 100n, 'the recipient is paid on Y at once, by the solver');
  await assert.rejects(fillOnBase(id, { solver: 'carol' }), /Filled/, 'one fill per intent on Y');
  await assert.rejects(relay.send('solver', 'fill', ['0x' + '11'.repeat(32), a('bob'), E, a('solver')], E + 1n), /Fee/, 'the value is exact');
  // the fill's message, checked by the ISM (Hyperlane's validators), repays the solver
  await w.process(m);
  assert.equal(I.STATUS[Number((await intents.call('intentOf', [id])).status)], 'Filled');
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
  await intents.send('solver', 'claim', [sep.token]);
  assert.equal(await sep.bal('solver'), E, 'repaid A (token(Sepolia)), which it can bridge out through the route');
  await assert.rejects(intents.send('solver', 'claim', [sep.token]), /Nothing/);
  await assert.rejects(w.process(m), 'a message is delivered once');
  // only the relay of Base speaks for Base
  await yMailbox.send('attacker', 'dispatch(uint32,bytes32,bytes)', [ZETAPHY, '0x' + intents.address.slice(2).padStart(64, '0'), '0x']);
  await assert.rejects(w.process(await w.lastMessage(yMailbox)), /WrongSender/);
  await assert.rejects(intents.send('attacker', 'handle', [BASE, '0x' + relay.address.slice(2).padStart(64, '0'), '0x']), /NotMailbox/);
});

test('a fill that does not match the intent (another recipient) is rejected, not repaid; the intent stays open, then refunds', async () => {
  const { id } = await openFromSepolia();
  // the message is consumed (the Mailbox is not blocked) but changes nothing
  const ev = await w.process(await fillOnBase(id, { recipient: a('carol') }));
  assert.ok(ev.length >= 1);
  assert.equal(I.STATUS[Number((await intents.call('intentOf', [id])).status)], 'Open');
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), 0n);
  await assert.rejects(intents.send('alice', 'refund', [id]), /TooEarly/);
  c.advance(3600 + Number(GRACE) + 1);
  await intents.send('carol', 'refund', [id]);
  await intents.send('alice', 'claim', [sep.token]);
  assert.equal(await sep.bal('alice'), E);
});

test('optimistic: a bonded claim nobody challenges is repaid after the window; the bond comes back', async () => {
  const { id } = await openFromSepolia();
  await assert.rejects(intents.send('solver', 'claimFill', [id, a('solver')], BOND - 1n), /Bond/);
  await intents.send('solver', 'claimFill', [id, a('solver')], BOND);
  await assert.rejects(intents.send('carol', 'claimFill', [id, a('carol')], BOND), /WrongStatus/);
  await assert.rejects(intents.send('carol', 'settle', [id]), /TooEarly/);
  c.advance(Number(WINDOW) + 1);
  await assert.rejects(intents.send('watcher', 'challenge', [id], CBOND), /TooLate/);
  await intents.send('carol', 'settle', [id]);
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
  const before = await c.balance('solver');
  await intents.send('solver', 'withdrawBonds', []);
  assert.equal((await c.balance('solver')) - before, BOND);
});

test('a false claim: challenged, no fill message comes, the claimer\'s bond goes to the challenger; the intent opens again', async () => {
  const { id } = await openFromSepolia(order({ deadline: c.now() + 4n * 3600n }));
  await intents.send('liar', 'claimFill', [id, a('liar')], BOND);
  await assert.rejects(intents.send('watcher', 'challenge', [id], CBOND + 1n), /Bond/);
  await intents.send('watcher', 'challenge', [id], CBOND);
  await assert.rejects(intents.send('attacker', 'challenge', [id], CBOND), /WrongStatus/);
  await assert.rejects(intents.send('liar', 'settle', [id]), /WrongStatus/, 'a challenged claim never settles by time');
  await assert.rejects(intents.send('watcher', 'timeout', [id]), /TooEarly/);
  c.advance(Number(DISPUTE) + 1);
  const ev = await intents.send('watcher', 'timeout', [id]);
  assert.ok(ev.find((e) => e?.name === 'Slashed'));
  assert.equal(await intents.call('bonds', [a('watcher')]), BOND + CBOND);
  assert.equal(await intents.call('bonds', [a('liar')]), 0n);
  assert.equal(I.STATUS[Number((await intents.call('intentOf', [id])).status)], 'Open');
  // an honest solver still fills it before the deadline
  await w.process(await fillOnBase(id));
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
});

test('a true claim that was challenged: the fill message proves it; the challenger\'s bond goes to the solver', async () => {
  const { id } = await openFromSepolia();
  const m = await fillOnBase(id);
  await intents.send('solver', 'claimFill', [id, a('solver')], BOND);
  await intents.send('watcher', 'challenge', [id], CBOND);
  await w.process(m);
  assert.equal(await intents.call('bonds', [a('solver')]), BOND + CBOND);
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
  await assert.rejects(intents.send('watcher', 'timeout', [id]), /WrongStatus/);
});

test('someone else\'s fill proves an unchallenged claim false: the claimer\'s bond goes to the real solver', async () => {
  const { id } = await openFromSepolia();
  await intents.send('liar', 'claimFill', [id, a('liar')], BOND);
  await w.process(await fillOnBase(id));
  assert.equal(await intents.call('bonds', [a('solver')]), BOND);
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
  assert.equal(await intents.call('owed', [sep.token, a('liar')]), 0n);
  c.advance(Number(WINDOW) + 1);
  await assert.rejects(intents.send('liar', 'settle', [id]), /WrongStatus/);
});

test('Neuro gates risky recipients: high risk or a ThreatRegistry hold is refused (from Sepolia: refunded); medium waits', async () => {
  await scores.send('gov', 'set', [a('carol'), true, 3]);
  await assert.rejects(intents.call('check', [I.orderTuple(order({ recipient: a('carol') }))]), /Risky/);
  const r1 = await openFromSepolia(order({ recipient: a('carol') }));
  assert.ok(r1.refused, 'the Gateway refunds alice on Sepolia');
  await threats.send('gov', 'setHeld', [a('bob'), true]);
  assert.ok((await openFromSepolia(order())).refused);
  await threats.send('gov', 'setHeld', [a('bob'), false]);
  await threats.send('gov', 'setEnforced', [a('bob'), true]);
  assert.ok((await openFromSepolia(order())).refused);
  await threats.send('gov', 'setEnforced', [a('bob'), false]);
  // medium: fills count only after the risk delay
  await scores.send('gov', 'set', [a('bob'), true, 2]);
  const { id } = await openFromSepolia(order());
  const it = await intents.call('intentOf', [id]);
  assert.equal(it.notBefore, c.now() + RISK_DELAY);
  assert.match(I.fillProblem(it, { domain: BASE, recipient: a('bob'), amountOut: E, now: c.now() }), /risk delay/);
  await assert.rejects(intents.send('solver', 'claimFill', [id, a('solver')], BOND), /TooEarly/);
  const early = await fillOnBase(id);
  await w.process(early);
  assert.equal(I.STATUS[Number((await intents.call('intentOf', [id])).status)], 'Open', 'a fill made before notBefore does not count');
  c.advance(Number(RISK_DELAY));
  // a solver the ThreatRegistry holds cannot claim
  await threats.send('gov', 'setHeld', [a('liar'), true]);
  await assert.rejects(intents.send('liar', 'claimFill', [id, a('liar')], BOND), /SolverHeld/);
  await intents.send('solver', 'claimFill', [id, a('solver')], BOND);
  c.advance(Number(WINDOW) + 1);
  await intents.send('solver', 'settle', [id]);
  assert.equal(await intents.call('owed', [sep.token, a('solver')]), E);
});

test('Y = ZETAPHY: a local fill pays the recipient and repays the solver in one transaction (risk checked again)', async () => {
  const tk = tokenKitArtifacts().KitToken;
  const usd = await c.deployRaw(tk, ['Test USD', 'tUSD', 6], 'gov');
  const zt = await c.deployRaw(tk, ['Wanted', 'WNT', 18], 'gov');
  await usd.send('gov', 'mint', [a('alice'), 500n]);
  await zt.send('gov', 'mint', [a('solver'), 1000n]);
  const o = order({ tokenIn: usd.address, amountIn: 500n, dstDomain: Number(CHAIN), tokenOut: zt.address, minOut: 400n });
  await assert.rejects(intents.send('alice', 'open', [I.orderTuple({ ...o, tokenOut: ZERO })]), /BadOrder/);
  await assert.rejects(intents.send('alice', 'open', [I.orderTuple({ ...o, dstDomain: 999 })]), /BadOrder/, 'a chain without a relay');
  await usd.send('alice', 'approve', [intents.address, 500n]);
  const ev = await intents.send('alice', 'open', [I.orderTuple(o)]);
  const id = ev.find((e) => e?.name === 'Opened').args.id;
  await assert.rejects(intents.send('solver', 'claimFill', [id, a('solver')], BOND), /WrongStatus/, 'local fills are atomic: no claims');
  await zt.send('solver', 'approve', [intents.address, 400n]);
  await assert.rejects(intents.send('solver', 'fillLocal', [id, 399n, a('solver')]), /BadOrder/);
  // the recipient became high risk since the intent opened: the fill is refused
  await scores.send('gov', 'set', [a('bob'), true, 3]);
  await assert.rejects(intents.send('solver', 'fillLocal', [id, 400n, a('solver')]), /Risky/);
  await scores.send('gov', 'set', [a('bob'), true, 1]);
  await intents.send('solver', 'fillLocal', [id, 400n, a('solver')]);
  assert.equal(await c.callAt(zt.address, TOK, 'balanceOf', [a('bob')]), 400n);
  await intents.send('solver', 'claim', [usd.address]);
  assert.equal(await c.callAt(usd.address, TOK, 'balanceOf', [a('solver')]), 500n);
  await assert.rejects(intents.send('solver', 'fillLocal', [id, 400n, a('solver')]), /WrongStatus/);
});
