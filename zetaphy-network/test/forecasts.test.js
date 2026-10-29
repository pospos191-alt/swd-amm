// Proof of Foresight (ForesightRegistry) and risk forecasts (RiskForecasts) on the in-memory EVM,
// with the real ZETAPHY DEX pair as the liquidity fact and a ThreatRegistry stand-in for flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, AbiCoder } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { dexArt } from './helpers/mocks.js';
import { marketMocks } from './helpers/markets.js';
import { foresightCommitment, modelIdOf, exportRows, toJsonl, rewardsTree, verifyReward, arenaCommitment, derivedSalt } from '../src/markets.js';

test('markets.js: the derived salt is fixed per key, event and model, and differs otherwise', () => {
  const k1 = '0x' + '11'.repeat(32); const k2 = '0x' + '22'.repeat(32); const m = modelIdOf('x');
  assert.equal(derivedSalt(k1, 1, m), derivedSalt(k1, 1n, m));
  assert.notEqual(derivedSalt(k1, 1, m), derivedSalt(k2, 1, m));
  assert.notEqual(derivedSalt(k1, 1, m), derivedSalt(k1, 2, m));
  assert.notEqual(derivedSalt(k1, 1, m), derivedSalt(k1, 1, modelIdOf('y')));
  assert.throws(() => foresightCommitment(1, m, 10_001, k1), /basis points/);
});

const ZERO = '0x' + '00'.repeat(20);
const S = (n) => keccak256(new TextEncoder().encode(`salt ${n}`));
const HOUR = 3600;
const DAY = 86400;

async function foresightSetup() {
  const c = await createChain(['gov', 'res', 'ann', 'ben', 'eve']);
  const A = (n) => c.acct[n].toString();
  const fs = await c.deploy('ForesightRegistry', [A('gov')], 'gov');
  return { c, A, fs };
}

test('foresight: only approved resolvers open events; commit before, reveal after; Brier on chain', async () => {
  const { c, A, fs } = await foresightSetup();
  const now = () => c.now();
  await assert.rejects(fs.send('res', 'openEvent', [keccak256('0x01'), now() + 100n, now() + 200n]), /NotResolver/);
  await fs.send('gov', 'setResolver', [A('res'), true]);
  await assert.rejects(fs.send('res', 'openEvent', [keccak256('0x01'), now() + 100n, now() + 50n]), /BadTimes/);
  await fs.send('res', 'openEvent', [keccak256('0x01'), now() + 100n, now() + 200n]);
  const id = 1n;
  const mA = modelIdOf('model ann'); const mB = modelIdOf('model ben');
  await fs.send('ann', 'registerModel', [mA]);
  await assert.rejects(fs.send('eve', 'registerModel', [mA]), /Taken/);
  await fs.send('ben', 'registerModel', [mB]);
  // only the model's owner commits for it
  await assert.rejects(fs.send('eve', 'commit', [id, mA, foresightCommitment(id, mA, 8000, S(1))]), /NotModelOwner/);
  const cA = foresightCommitment(id, mA, 8000, S(1));
  assert.equal(cA, await fs.call('commitmentOf', [id, mA, 8000, S(1)]), 'JS commitment = contract');
  await fs.send('ann', 'commit', [id, mA, cA]);
  // ben copies ann's commitment: it cannot be revealed for his model (the model id is in the hash)
  await fs.send('ben', 'commit', [id, mB, cA]);
  await assert.rejects(fs.send('ann', 'reveal', [id, mA, 8000, S(1)]), /NotYet/);
  c.advance(100);
  await assert.rejects(fs.send('ann', 'commit', [id, mA, cA]), /Closed/);
  await assert.rejects(fs.send('ann', 'reveal', [id, mA, 7000, S(1)]), /BadReveal/);
  await fs.send('eve', 'reveal', [id, mA, 8000, S(1)]); // anyone holding the salt may reveal
  await assert.rejects(fs.send('ben', 'reveal', [id, mB, 8000, S(1)]), /BadReveal/);
  await assert.rejects(fs.send('ann', 'score', [id, mA]), /NothingToScore/); // not resolved
  await assert.rejects(fs.send('eve', 'resolve', [id, 2]), /NotResolver/);
  await fs.send('res', 'resolve', [id, 2]); // Yes
  await assert.rejects(fs.send('res', 'resolve', [id, 1]), /Closed/);
  const ev = await fs.send('eve', 'score', [id, mA]);
  assert.equal(ev.find((e) => e?.name === 'Scored').args.brier, 2000n * 2000n); // (0.8 - 1)^2 = 0.04
  await assert.rejects(fs.send('eve', 'score', [id, mA]), /NothingToScore/);
  // ben's unrevealed forecast scores 1.0, but only after the reveal deadline
  await assert.rejects(fs.send('eve', 'score', [id, mB]), /NotYet/);
  c.advance(100);
  await fs.send('eve', 'scoreMany', [id, [mA, mB]]);
  const [nB, meanB] = await fs.call('brierOf', [mB]);
  assert.equal(nB, 1n); assert.equal(meanB, 100_000_000n);
  const tB = await fs.call('tracks', [mB]);
  assert.equal(tB.unrevealed, 1n);
  // skill: (0.25 - 0.04) / 0.25 = 84% of the way to perfect, shrunk by 1/(1+10)
  assert.equal(await fs.call('skill', [mA]), (8400n * 1n) / 11n);
  assert.equal(await fs.call('skill', [mB]), 0n);
});

test('foresight: the resolver closes commits early; void events are not scored', async () => {
  const { c, A, fs } = await foresightSetup();
  await fs.send('gov', 'setResolver', [A('res'), true]);
  await fs.send('res', 'openEvent', [keccak256('0x02'), c.now() + 1000n, c.now() + 1500n]);
  const m = modelIdOf('m'); await fs.send('ann', 'registerModel', [m]);
  c.advance(10);
  await fs.send('res', 'closeCommits', [1n]);
  const e = await fs.call('events', [1n]);
  assert.equal(e.commitEnd, c.now()); assert.equal(e.revealEnd - e.commitEnd, 500n);
  await assert.rejects(fs.send('ann', 'commit', [1n, m, foresightCommitment(1n, m, 5000, S(2))]), /Closed/);
  await fs.send('res', 'openEvent', [keccak256('0x03'), c.now() + 1000n, c.now() + 1500n]);
  await fs.send('ann', 'commit', [2n, m, foresightCommitment(2n, m, 5000, S(3))]);
  await fs.send('res', 'resolve', [2n, 3]); // void: closes commits at once
  c.advance(1);
  await fs.send('ann', 'reveal', [2n, m, 5000, S(3)]);
  await assert.rejects(fs.send('ann', 'score', [2n, m]), /NothingToScore/);
});

/** DEX pool + flags stand-in + Foresight + RiskForecasts. */
async function riskSetup() {
  const c = await createChain(['gov', 'ann', 'ben', 'cat', 'keeper', 'dev']);
  const A = (n) => c.acct[n].toString();
  const factory = await c.deployRaw(dexArt('ZetaphyFactory'), [A('gov')], 'gov');
  const tok = await c.deployRaw(dexArt('TestToken'), ['Rug', 'RUG', 18, 10n ** 30n, 0], 'dev');
  const usd = await c.deployRaw(dexArt('TestToken'), ['Test USD', 'tUSD', 18, 10n ** 30n, 0], 'dev');
  await factory.send('gov', 'createPair', [tok.address, usd.address]);
  const pairAddr = await factory.call('getPair', [tok.address, usd.address]);
  const pairIface = new Interface(dexArt('ZetaphyPair').abi);
  const pair = { address: pairAddr, send: (from, fn, args = []) => c.sendTo(from, pairAddr, pairIface, fn, args), call: (fn, args = []) => c.callAt(pairAddr, pairIface, fn, args) };
  await tok.send('dev', 'transfer', [pairAddr, 1_000_000n * ZETA]);
  await usd.send('dev', 'transfer', [pairAddr, 1000n * ZETA]);
  await pair.send('dev', 'mint', [A('dev')]);
  const flags = await c.deployRaw(marketMocks().MockFlags, [], 'gov');
  const fs = await c.deploy('ForesightRegistry', [A('gov')], 'gov');
  const rf = await c.deploy('RiskForecasts', [A('gov'), flags.address, fs.address], 'gov');
  await fs.send('gov', 'setResolver', [rf.address, true]);
  /** The dev pulls `bps` of the liquidity (burns that share of its LP tokens). */
  const pull = async (bps) => {
    const lp = await pair.call('balanceOf', [A('dev')]);
    await pair.send('dev', 'transfer', [pairAddr, (lp * BigInt(bps)) / 10_000n]);
    await pair.send('dev', 'burn', [A('dev')]);
  };
  return { c, A, tok, usd, pair, pull, flags, fs, rf };
}

test('risk forecast, liquidity drop: forecasts, the rug is seen and confirmed, accurate forecasters paid', async () => {
  const { c, A, tok, pair, pull, fs, rf } = await riskSetup();
  await assert.rejects(rf.send('ann', 'open', [tok.address, ZERO, 0, 5000, 7 * DAY, 3 * DAY]), /BadPair/);
  await assert.rejects(rf.send('ann', 'open', [tok.address, pair.address, 0, 500, 7 * DAY, 3 * DAY]), /BadParams/);
  await assert.rejects(rf.send('ann', 'open', [tok.address, pair.address, 0, 5000, 7 * DAY, 8 * DAY]), /BadParams/);
  const ev = await rf.send('ann', 'open', [tok.address, pair.address, 0, 5000, 7 * DAY, 3 * DAY]);
  const opened = ev.find((e) => e?.name === 'Opened').args;
  assert.equal(opened.baseReserve, 1000n * ZETA, 'the other side (tUSD) of the pool');
  assert.equal(opened.foresightId, 1n);
  await assert.rejects(rf.send('ben', 'forecast', [1n, true], 1n), /StakeTooSmall/);
  await rf.send('ben', 'forecast', [1n, true], 1n * ZETA);
  await rf.send('cat', 'forecast', [1n, false], 3n * ZETA);
  // a model commits its probability in Foresight for the same question
  const m = modelIdOf('neuro-ml test'); await fs.send('ann', 'registerModel', [m]);
  await fs.send('ann', 'commit', [1n, m, foresightCommitment(1n, m, 9000, S(9))]);
  // 40% pulled: not yet a 50% drop
  await pull(4000);
  await rf.send('keeper', 'poke', [1n]);
  assert.equal((await rf.call('states', [1n])).seenAt, 0n);
  // the rest goes: the drop is seen; forecasts and Foresight commits stop at once
  await pull(10_000);
  assert.equal(await rf.call('holdsNow', [1n]), true);
  await assert.rejects(rf.send('ben', 'forecast', [1n, true], 1n * ZETA), /AlreadyTrue/);
  await rf.send('keeper', 'poke', [1n]);
  const st = await rf.call('states', [1n]);
  assert.equal(st.seenAt, c.now());
  assert.equal((await fs.call('events', [1n])).commitEnd, c.now(), 'Foresight commits closed');
  await fs.send('ann', 'reveal', [1n, m, 9000, S(9)]); // the reveal period starts now (revealWindow long)
  await assert.rejects(rf.send('keeper', 'propose', [1n]), /NotYet/); // must hold for confirmDelay
  c.advance(HOUR);
  await rf.send('keeper', 'propose', [1n]);
  assert.equal((await rf.call('states', [1n])).proposed, 2n); // Yes
  await assert.rejects(rf.send('keeper', 'finalize', [1n]), /NotYet/);
  c.advance(DAY);
  await assert.rejects(rf.send('cat', 'dispute', [1n], 10n * ZETA), /TooLate/);
  await rf.send('keeper', 'finalize', [1n]);
  assert.equal((await rf.call('states', [1n])).answer, 2n);
  assert.equal((await fs.call('events', [1n])).outcome, 2n, 'Foresight event resolved Yes');
  await fs.send('ann', 'score', [1n, m]);
  assert.equal((await fs.call('brierOf', [m]))[1], 1000n * 1000n);
  // ben was right: his 1 + cat's 3
  assert.equal(await rf.call('payoutOf', [1n, A('ben')]), 4n * ZETA);
  assert.equal(await rf.call('payoutOf', [1n, A('cat')]), 0n);
  await assert.rejects(rf.send('cat', 'claim', [1n, A('cat')]), /NothingToClaim/);
  await rf.send('keeper', 'claim', [1n, A('ben')]);
  await assert.rejects(rf.send('keeper', 'claim', [1n, A('ben')]), /NothingToClaim/);
  const before = await c.balance('ben');
  await rf.send('ben', 'withdraw');
  assert.equal((await c.balance('ben')) - before, 4n * ZETA);
  // labelled row for Neuro
  const q = await rf.call('questions', [1n]);
  const s = await rf.call('states', [1n]);
  const rows = exportRows([{ id: 1, token: q.token, pair: q.pair, kind: 'liquidity-drop', dropBps: 5000, createdAt: Number(q.createdAt), deadline: Number(q.deadline),
    status: 'final', answer: 'yes', yes: s.yes.toString(), no: s.no.toString() }], { contract: rf.address });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 1); assert.equal(rows[0].flagged, true); assert.equal(rows[0].crowdP, 0.25);
  assert.equal(rows[0].address, tok.address.toLowerCase());
  assert.equal(rows[0].question, 'liquidity-drop-5000bps'); assert.equal(rows[0].horizonDays, 7);
  assert.match(toJsonl(rows), /^\{.*\}\n$/);
});

test('risk forecast: a dip that does not hold is not a Yes; after the deadline the answer is No', async () => {
  const { c, A, tok, usd, pair, pull, rf } = await riskSetup();
  await rf.send('ann', 'open', [tok.address, pair.address, 0, 5000, 2 * DAY, DAY]);
  await rf.send('ben', 'forecast', [1n, true], 2n * ZETA);
  await rf.send('cat', 'forecast', [1n, false], 2n * ZETA);
  c.advance(DAY);
  await assert.rejects(rf.send('ben', 'forecast', [1n, true], 1n * ZETA), /ForecastsClosed/);
  await pull(6000);
  await rf.send('keeper', 'poke', [1n]);
  assert.notEqual((await rf.call('states', [1n])).seenAt, 0n);
  // liquidity comes back before the hour is up
  await usd.send('dev', 'transfer', [pair.address, 900n * ZETA]);
  await tok.send('dev', 'transfer', [pair.address, 900_000n * ZETA]);
  await pair.send('dev', 'mint', [A('dev')]);
  c.advance(HOUR);
  await rf.send('keeper', 'poke', [1n]);
  assert.equal((await rf.call('states', [1n])).seenAt, 0n, 'reset: it did not hold');
  await assert.rejects(rf.send('keeper', 'propose', [1n]), /NotYet/);
  c.advance(DAY + HOUR + 1);
  await rf.send('keeper', 'propose', [1n]);
  assert.equal((await rf.call('states', [1n])).proposed, 1n); // No
  c.advance(DAY);
  await rf.send('keeper', 'finalize', [1n]);
  assert.equal(await rf.call('payoutOf', [1n, A('cat')]), 4n * ZETA);
});

test('risk forecast, flagged: confirmed at once; a dispute goes to governance; void refunds', async () => {
  const { c, A, tok, flags, rf } = await riskSetup();
  await flags.send('gov', 'setAddress', [tok.address, true]);
  await assert.rejects(rf.send('ann', 'open', [tok.address, ZERO, 1, 0, 7 * DAY, DAY]), /AlreadyTrue/);
  await flags.send('gov', 'setAddress', [tok.address, false]);
  await rf.send('ann', 'open', [tok.address, ZERO, 1, 0, 7 * DAY, DAY]);
  await rf.send('ann', 'open', [tok.address, ZERO, 1, 0, 7 * DAY, DAY]);
  for (const id of [1n, 2n]) {
    await rf.send('ben', 'forecast', [id, true], 1n * ZETA);
    await rf.send('cat', 'forecast', [id, false], 1n * ZETA);
  }
  await flags.send('gov', 'setCode', [tok.address, true]);
  await rf.send('keeper', 'propose', [1n]); // propose pokes; a flag needs no confirm time
  await rf.send('keeper', 'propose', [2n]);
  assert.equal((await rf.call('states', [1n])).proposed, 2n);
  // cat says the flag was a mistake: bond, governance decides
  await assert.rejects(rf.send('cat', 'dispute', [1n], 1n * ZETA), /BadBond/);
  await rf.send('cat', 'dispute', [1n], 10n * ZETA);
  await assert.rejects(rf.send('keeper', 'finalize', [1n]), /WrongStatus/);
  await assert.rejects(rf.send('cat', 'settleDispute', [1n, 1]), /NotGovernance/);
  await rf.send('gov', 'settleDispute', [1n, 1]); // No: the bond goes back to cat
  assert.equal(await rf.call('owed', [A('cat')]), 10n * ZETA);
  assert.equal(await rf.call('payoutOf', [1n, A('cat')]), 2n * ZETA);
  // question 2: disputed and voided by governance; the bond was not needed to change Yes... void refunds everyone
  await rf.send('ben', 'dispute', [2n], 10n * ZETA);
  await rf.send('gov', 'settleDispute', [2n, 3]);
  assert.equal(await rf.call('payoutOf', [2n, A('ben')]), 1n * ZETA);
  assert.equal(await rf.call('payoutOf', [2n, A('cat')]), 1n * ZETA);
  assert.equal(await rf.call('owed', [A('ben')]), 10n * ZETA, 'answer changed (Yes -> Void): bond back');
});

test('risk forecast: nobody on the right side gets everyone their stake back', async () => {
  const { c, A, tok, flags, rf } = await riskSetup();
  await rf.send('ann', 'open', [tok.address, ZERO, 1, 0, DAY, HOUR]);
  await rf.send('ben', 'forecast', [1n, true], 1n * ZETA);
  c.advance(DAY + 1);
  await rf.send('keeper', 'propose', [1n]);
  c.advance(DAY);
  await rf.send('keeper', 'finalize', [1n]);
  assert.equal((await rf.call('states', [1n])).answer, 1n);
  assert.equal(await rf.call('payoutOf', [1n, A('ben')]), 1n * ZETA);
  assert.equal(exportRows([{ id: 1, token: tok.address, pair: ZERO, kind: 'flagged', dropBps: 0, createdAt: 0, deadline: DAY, status: 'final', answer: 'no', yes: '1', no: '0' }])[0].label, 0);
  assert.equal(exportRows([{ id: 1, token: tok.address, pair: ZERO, kind: 'flagged', dropBps: 0, createdAt: 0, deadline: DAY, status: 'final', answer: 'void', yes: '1', no: '0' }]).length, 0, 'void questions are not data');
  void flags;
});

test('markets.js: rewards tree proofs verify; arena commitment matches the formula', () => {
  const dao = '0x' + '11'.repeat(20);
  const rewards = Array.from({ length: 5 }, (_, i) => ({ account: '0x' + String(i + 1).repeat(40).slice(0, 40), amount: BigInt(i + 1) * ZETA }));
  const t = rewardsTree({ dao, chainId: 77390, round: 1, rewards });
  assert.equal(t.total, 15n * ZETA);
  for (const [acct, cl] of Object.entries(t.claims)) assert.ok(verifyReward({ dao, chainId: 77390, round: 1, root: t.root }, acct, cl.amount, cl.proof));
  assert.ok(!verifyReward({ dao, chainId: 77390, round: 2, root: t.root }, rewards[0].account, rewards[0].amount, t.claims[Object.keys(t.claims)[0]].proof));
  assert.throws(() => rewardsTree({ dao, chainId: 1, round: 1, rewards: [rewards[0], rewards[0]] }), /one entry/);
  const h = arenaCommitment(dao, 1, 0, dao, keccak256('0x01'), keccak256('0x02'));
  assert.equal(h, keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'uint8', 'address', 'bytes32', 'bytes32'], [dao, 1, 0, dao, keccak256('0x01'), keccak256('0x02')])));
});
