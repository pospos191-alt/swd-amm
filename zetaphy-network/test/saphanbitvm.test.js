// Saphan PR 6, item S7 (PROTOTYPE): optimistic BTC withdrawals, BitVM2-style. An operator fronts BTC, claims the
// escrowed bridged BTC on ZETAPHY; anyone challenges within the window; a challenged operator proves the payment by SPV
// (KitBtcClient here: BtcLightClient's proofs of work are tested in btclc.test.js) or is slashed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import { kit } from './helpers/saphankits.js';
import { paymentTx, txidOf, commitmentScript, judgeClaim, parseOutputs, rawTx, SATS_TO_WEI } from '../src/saphanbitvm.js';

const E = 10n ** 18n;
const HOUR = 3600, DAY = 86400;
const BOND = E, CBOND = E / 10n;
const SCRIPT = '0x0014' + 'ab'.repeat(20);              // P2WPKH of the holder
const SATS = 1_000_000n;                                // 0.01 BTC
const BLOCK = '0x' + '42'.repeat(32);
let c, token, spv, w;
const a = (n) => c.acct[n].toString();
const st = async (id) => (await w.call('withdrawal', [id])).state;

beforeEach(async () => {
  c = await createChain(['gov', 'holder', 'op', 'op2', 'watcher', 'anyone']);
  token = await c.deployRaw(kit('TokenKit.sol').KitToken, ['BTC (bridged, testnet)', 'zBTC', 18], 'gov');
  spv = await c.deployRaw(kit('SafetyKit.sol').KitBtcClient, [], 'gov');
  w = await c.deploy('SaphanBtcWithdrawals', [spv.address, token.address, 6, BOND, CBOND, DAY, DAY, DAY, 1000], 'gov');
  await token.send('gov', 'mint', [a('holder'), E]);
  await token.send('holder', 'approve', [w.address, E]);
  await w.send('op', 'bond', [], 2n * BOND);
  await w.send('op2', 'bond', [], BOND);
  await spv.send('gov', 'setKnown', [BLOCK]);
});

async function requested(sats = SATS) {
  const ev = await w.send('holder', 'request', [sats * SATS_TO_WEI, SCRIPT]);
  const r = ev.find((e) => e?.name === 'Requested');
  assert.equal(r.args.btcScript, SCRIPT);
  return r.args.id;
}
const pay = (id, operator = a('op'), sats = SATS, script = SCRIPT) => paymentTx({ id, operator, script, sats });

test('happy path: operator fronts BTC, claims, nobody challenges, it is reimbursed after the window; bond locked meanwhile', async () => {
  const id = await requested();
  assert.equal(await token.call('balanceOf', [w.address]), SATS * SATS_TO_WEI);
  const tx = pay(id);
  await w.send('op', 'claim', [id, txidOf(tx), 0]);
  assert.equal(await st(id), 2n);
  assert.equal(await w.call('lockedBond', [a('op')]), BOND);
  await assert.rejects(w.send('op', 'unbond', [2n * BOND]), /NoBond/, 'a pending claim holds its bond');
  await assert.rejects(w.send('anyone', 'finalize', [id]), /TooEarly/);
  c.advance(DAY);
  await assert.rejects(w.send('watcher', 'challenge', [id], CBOND), /TooLate/);
  await w.send('anyone', 'finalize', [id]);
  assert.equal(await st(id), 4n);
  assert.equal(await w.call('lockedBond', [a('op')]), 0n);
  await w.send('op', 'withdraw', []);
  assert.equal(await token.call('balanceOf', [a('op')]), SATS * SATS_TO_WEI);
  await assert.rejects(w.send('op', 'withdraw', []), /Nothing/);
  await w.send('op', 'unbond', [2n * BOND]);
  assert.equal(await w.call('escrowed', []), 0n);
});

test('challenged, then proven by SPV: the operator is reimbursed and takes the challenger\'s bond', async () => {
  const id = await requested();
  const tx = pay(id);
  await w.send('op', 'claim', [id, txidOf(tx), 0]);
  await assert.rejects(w.send('watcher', 'challenge', [id], CBOND - 1n), /BadBond/);
  await w.send('watcher', 'challenge', [id], CBOND);
  await assert.rejects(w.send('anyone', 'finalize', [id]), /BadState/, 'a challenged claim never finalizes by time');
  await assert.rejects(w.send('anyone', 'prove', [id, tx, '0x' + '43'.repeat(32), 0, []]), /Error/, 'unknown block (the SPV client reverts)');
  await w.send('anyone', 'prove', [id, tx, BLOCK, 0, []]);
  assert.equal(await st(id), 4n);
  assert.equal(await w.call('owedNative', [a('op')]), CBOND);
  const before = await c.balance('op');
  await w.send('op', 'withdraw', []);
  assert.ok((await c.balance('op')) - before === CBOND);
  assert.equal(await token.call('balanceOf', [a('op')]), SATS * SATS_TO_WEI);
});

test('challenged and unanswered: slashed; the holder gets the escrow back + half the bond, the challenger its bond + half', async () => {
  const id = await requested();
  await w.send('op', 'claim', [id, '0x' + '99'.repeat(32), 0]); // a payment that does not exist
  await w.send('watcher', 'challenge', [id], CBOND);
  await assert.rejects(w.send('anyone', 'slash', [id]), /TooEarly/);
  c.advance(DAY + 1);
  await assert.rejects(w.send('anyone', 'prove', [id, pay(id), BLOCK, 0, []]), /TooLate/);
  await w.send('anyone', 'slash', [id]);
  assert.equal(await st(id), 5n);
  assert.equal(await w.call('bonded', [a('op')]), BOND, 'one claim\'s bond is gone');
  assert.equal(await w.call('owedToken', [a('holder')]), SATS * SATS_TO_WEI);
  assert.equal(await w.call('owedNative', [a('holder')]), BOND / 2n);
  assert.equal(await w.call('owedNative', [a('watcher')]), CBOND + BOND / 2n);
  await w.send('holder', 'withdraw', []);
  assert.equal(await token.call('balanceOf', [a('holder')]), E);
  await assert.rejects(w.send('anyone', 'slash', [id]), /BadState/);
});

test('the disprove step refuses every wrong payment: other operator (front-run), too little, other script, no commitment, wrong txid', async () => {
  const id = await requested();
  // op paid (its commitment); op2 front-runs the claim with op's txid: it cannot prove it, so it is slashed
  const tx = pay(id, a('op'));
  await w.send('op2', 'claim', [id, txidOf(tx), 0]);
  await w.send('watcher', 'challenge', [id], CBOND);
  await assert.rejects(w.send('op2', 'prove', [id, tx, BLOCK, 0, []]), /BadPayment/);
  c.advance(DAY + 1);
  await w.send('anyone', 'slash', [id]);
  assert.equal(await w.call('bonded', [a('op2')]), 0n);
  // the same payment cannot be claimed twice (one payment, one withdrawal)
  const id2 = await requested();
  await assert.rejects(w.send('op', 'claim', [id2, txidOf(tx), 0]), /PaymentUsed/);
  // each wrong payment, checked by the contract's own parser (and the watcher's JS judge agrees)
  const cases = [
    [pay(id2, a('op'), SATS - 1n), 4],
    [pay(id2, a('op'), SATS, '0x0014' + 'cd'.repeat(20)), 3],
    [rawTx({ outputs: [{ sats: SATS, script: SCRIPT }] }), 5],
    [pay(id, a('op')), 5],                              // the commitment names another withdrawal
  ];
  for (const [bad, code] of cases) {
    await assert.rejects(w.call('checkPayment', [bad, 0, SATS, keccak256(SCRIPT), id2, a('op')]), /BadPayment/);
    const j = judgeClaim({ id: id2, operator: a('op'), txid: txidOf(bad), vout: 0, sats: SATS, scriptHash: keccak256(SCRIPT) }, bad);
    assert.equal(j.challenge, true, `case ${code}: ${j.reason}`);
  }
  const good = pay(id2, a('op'));
  await w.call('checkPayment', [good, 0, SATS, keccak256(SCRIPT), id2, a('op')]);
  assert.deepEqual(judgeClaim({ id: id2, operator: a('op'), txid: txidOf(good), vout: 0, sats: SATS, scriptHash: keccak256(SCRIPT) }, good), { challenge: false, reason: 'paid' });
  assert.equal(judgeClaim({ id: id2, operator: a('op'), txid: '0x' + '00'.repeat(32), vout: 0, sats: SATS, scriptHash: keccak256(SCRIPT) }, null).challenge, true);
  // proving a claim whose txid differs from the transaction: BadPayment(6)
  await w.send('op', 'claim', [id2, '0x' + '77'.repeat(32), 0]);
  await assert.rejects(w.send('op', 'prove', [id2, good, BLOCK, 0, []]), /BadPayment/);
});

test('requests: whole sats above the minimum, a real script; unclaimed requests can be cancelled after the TTL; no OP_RETURN destination', async () => {
  await assert.rejects(w.send('holder', 'request', [SATS * SATS_TO_WEI + 1n, SCRIPT]), /BadAmount/);
  await assert.rejects(w.send('holder', 'request', [999n * SATS_TO_WEI, SCRIPT]), /BadAmount/);
  await assert.rejects(w.send('holder', 'request', [SATS * SATS_TO_WEI, '0x']), /BadScript/);
  await assert.rejects(w.send('holder', 'request', [SATS * SATS_TO_WEI, commitmentScript(0, a('op'))]), /BadScript/);
  const id = await requested();
  await assert.rejects(w.send('anyone', 'cancel', [id]), /NotHolder/);
  await assert.rejects(w.send('holder', 'cancel', [id]), /TooEarly/);
  c.advance(DAY);
  await w.send('holder', 'cancel', [id]);
  await assert.rejects(w.send('op', 'claim', [id, '0x' + '11'.repeat(32), 0]), /BadState/);
  await w.send('holder', 'withdraw', []);
  assert.equal(await token.call('balanceOf', [a('holder')]), E);
  // an operator without free bond cannot claim
  const id2 = await requested();
  await assert.rejects(w.send('anyone', 'claim', [id2, '0x' + '12'.repeat(32), 0]), /NoBond/);
  assert.deepEqual(parseOutputs(pay(id2)).map((o) => o.sats), [SATS, 0n]);
  assert.equal(getAddress(a('op')), getAddress(a('op')));
});
