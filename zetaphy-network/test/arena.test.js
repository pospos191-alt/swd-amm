// RedBlueArena: commit-reveal entries; k-of-n bonded runners with commit-reveal results in a pinned sandbox;
// slashing of runners that disagree with the quorum or never reveal; the challenge path; bounties and bonds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, getAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { arenaCommitment, contentHash, arenaResultArgs, arenaResultKey, arenaResultCommitment } from '../src/markets.js';

const H = (s) => keccak256(new TextEncoder().encode(s));
const SANDBOX = H('sandbox: @ethereumjs/evm 3.1.1, solc 0.8.26, block 1');
const DAY = 86400;

async function setup({ seats = 3, quorum = 2 } = {}) {
  const c = await createChain(['gov', 'r1', 'r2', 'r3', 'r4', 'red1', 'red2', 'red3', 'blue1', 'blue2', 'eve']);
  const A = (n) => getAddress(c.acct[n].toString());
  const arena = await c.deploy('RedBlueArena', [A('gov')], 'gov');
  for (const r of ['r1', 'r2', 'r3', 'r4']) {
    await arena.send('gov', 'setRunner', [A(r), true]);
    await arena.send(r, 'bondRunner', [], 10n * ZETA);
  }
  await arena.send('gov', 'setParams', [1n * ZETA, 1n * ZETA, quorum]);
  await arena.send('gov', 'setRunnerParams', [seats, 10n * ZETA, 5000, 500, 5n * ZETA, DAY, 7 * DAY]);
  const t = c.now();
  await arena.send('gov', 'openRound', [t + 100n, t + 200n, t + 300n, t + 400n, 6000, SANDBOX], 100n * ZETA);
  /** commits an entry; returns its reveal args */
  const enter = async (who, side, content) => {
    const ch = contentHash(content); const salt = H(`salt ${who}`);
    const ev = await arena.send(who, 'commit', [1n, side, arenaCommitment(arena.address, 1, side, A(who), ch, salt)], 1n * ZETA);
    const index = ev.find((e) => e?.name === 'Committed').args.index;
    return [1n, side, index, ch, salt, `ipfs://${who}`];
  };
  /** a runner's sealed result, then its reveal args */
  const seal = async (who, args) => {
    const salt = H(`result salt ${who}`);
    await arena.send(who, 'commitResult', [1n, arenaResultCommitment(arena.address, 1, A(who), arenaResultKey(SANDBOX, args), salt)]);
    return [1n, ...args, salt];
  };
  return { c, A, arena, enter, seal };
}

async function entries({ c, arena, enter }) {
  const red1 = await enter('red1', 0, '{"source":"contract A {}"}');
  const red2 = await enter('red2', 0, '{"source":"contract B {}"}');
  await enter('red3', 0, '{"source":"contract C {}"}');
  const blue1 = await enter('blue1', 1, '{"rules":[]}');
  const blue2 = await enter('blue2', 1, '{"rules":[1]}');
  c.advance(100);
  for (const [who, args] of [['red1', red1], ['red2', red2], ['blue1', blue1], ['blue2', blue2]]) await arena.send(who, 'reveal', args);
  c.advance(100);
}
// red1 valid + evaded, red2 valid but caught; blue1 caught red2 (+1), blue2 flagged benign (-2)
const GOOD = arenaResultArgs({ red: [{ index: 0, valid: true, evaded: true }, { index: 1, valid: true, evaded: false }, { index: 2, valid: false, evaded: false }], blue: [{ index: 0, score: 1 }, { index: 1, score: -2 }] });
const BAD = [1n, 1n, [0, 0]]; // a lazy or dishonest result

test('arena: entries commit before, reveal after; the k-of-n runners\' result is judged; red, blue and runners paid', async () => {
  const w = await setup();
  const { c, A, arena, enter, seal } = w;
  const r = await arena.call('rounds', [1n]);
  assert.equal(r.redPool, 60n * ZETA); assert.equal(r.bluePool, 40n * ZETA);
  assert.equal((await arena.call('judging', [1n])).sandbox, SANDBOX);
  await assert.rejects(arena.send('red1', 'commit', [1n, 0, H('x')], 2n * ZETA), /BadInput/); // wrong bond
  const red1 = await enter('red1', 0, '{"source":"x"}');
  await assert.rejects(arena.send('red1', 'reveal', red1), /WrongPhase/);
  c.advance(100);
  await assert.rejects(arena.send('red1', 'commit', [1n, 0, H('late')], 1n * ZETA), /WrongPhase/);
  await assert.rejects(arena.send('eve', 'reveal', red1), /BadReveal/); // not the author
  await assert.rejects(arena.send('red1', 'reveal', [...red1.slice(0, 3), H('other content'), ...red1.slice(4)]), /BadReveal/);
  await assert.rejects(arena.send('r1', 'commitResult', [1n, H('too early')]), /WrongPhase/); // entries still revealing
  // (the full flow on a fresh round)
  const v = await setup();
  await entries(v);
  assert.deepEqual(GOOD, [3n, 1n, [1, -2]]);
  await assert.rejects(v.arena.send('eve', 'commitResult', [1n, H('x')]), /NotRunner/);
  const s1 = await v.seal('r1', GOOD);
  const s2 = await v.seal('r2', GOOD);
  const s3 = await v.seal('r3', BAD);
  await assert.rejects(v.seal('r4', GOOD), /Full/, 'n = 3 seats');
  await assert.rejects(v.arena.send('r1', 'revealResult', s1), /WrongPhase/, 'reveals open after the commits');
  v.c.advance(100);
  await assert.rejects(v.arena.send('r1', 'revealResult', [1n, 7n, 1n, [1, -2], s1.at(-1)]), /BadInput/, 'red3 never revealed');
  await assert.rejects(v.arena.send('r1', 'revealResult', [1n, 3n, 1n, [1, -1], s1.at(-1)]), /BadReveal/, 'not what it committed');
  for (const [who, s] of [['r1', s1], ['r2', s2], ['r3', s3]]) await v.arena.send(who, 'revealResult', s);
  await assert.rejects(v.arena.send('r1', 'revealResult', s1), /BadReveal/);
  await assert.rejects(v.arena.send('eve', 'finalize', [1n]), /WrongPhase/);
  v.c.advance(100);
  const ev = await v.arena.send('eve', 'finalize', [1n]);
  const slashed = ev.filter((e) => e?.name === 'RunnerSlashed');
  assert.deepEqual(slashed.map((e) => [e.args.runner, e.args.amount]), [[v.A('r3'), 5n * ZETA]], 'the disagreeing runner loses half its bond');
  assert.equal((await v.arena.call('stakes', [v.A('r3')])).bond, 5n * ZETA);
  const rr = await v.arena.call('rounds', [1n]);
  assert.equal(rr.judged, true); assert.equal(rr.redValid, 3n); assert.equal(rr.redEvaded, 1n);
  assert.deepEqual((await v.arena.call('blueScores', [1n])).map(Number), [1, -2]);
  await assert.rejects(v.arena.send('eve', 'settle', [1n]), /WrongPhase/, 'the challenge window is open');
  v.c.advance(DAY);
  await v.arena.send('eve', 'settle', [1n]);
  // pools minus the runners' 5%: red 57, blue 38
  assert.equal(await v.arena.call('owed', [v.A('red1')]), 58n * ZETA, 'bond + the whole red pool');
  assert.equal(await v.arena.call('owed', [v.A('red2')]), 1n * ZETA, 'valid but caught: bond back');
  assert.equal(await v.arena.call('owed', [v.A('red3')]), 0n, 'unrevealed: bond lost');
  assert.equal(await v.arena.call('owed', [v.A('blue1')]), 39n * ZETA);
  assert.equal(await v.arena.call('owed', [v.A('blue2')]), 1n * ZETA);
  // runners r1, r2: (3 + 2 fee + 5 slashed) / 2 each
  assert.equal(await v.arena.call('owed', [v.A('r1')]), 5n * ZETA);
  assert.equal(await v.arena.call('owed', [v.A('r2')]), 5n * ZETA);
  assert.equal(await v.arena.call('owed', [v.A('r3')]), 0n);
  assert.equal(await v.arena.call('carry'), 1n * ZETA, "red3's bond carries over");
  // the next round starts with the carry
  const t = v.c.now();
  await v.arena.send('gov', 'openRound', [t + 100n, t + 200n, t + 300n, t + 400n, 5000, SANDBOX], 9n * ZETA);
  const r2 = await v.arena.call('rounds', [2n]);
  assert.equal(r2.redPool + r2.bluePool, 10n * ZETA);
});

test('arena: a challenge upheld by governance replaces the result and slashes the runners that posted it', async () => {
  const v = await setup();
  await entries(v);
  // r1 and r2 collude on a wrong result; r3 is honest
  const s1 = await v.seal('r1', BAD); const s2 = await v.seal('r2', BAD); const s3 = await v.seal('r3', GOOD);
  v.c.advance(100);
  for (const [who, s] of [['r1', s1], ['r2', s2], ['r3', s3]]) await v.arena.send(who, 'revealResult', s);
  v.c.advance(100);
  await v.arena.send('eve', 'finalize', [1n]);
  assert.equal((await v.arena.call('rounds', [1n])).redValid, 1n, 'the colluding quorum won at first');
  assert.equal((await v.arena.call('stakes', [v.A('r3')])).bond, 5n * ZETA, 'and slashed the honest runner');
  await assert.rejects(v.arena.send('eve', 'challenge', [1n, ...BAD], 5n * ZETA), /BadInput/, 'naming the same result');
  await assert.rejects(v.arena.send('eve', 'challenge', [1n, ...GOOD], 1n * ZETA), /BadInput/, 'the challenge bond');
  await v.arena.send('eve', 'challenge', [1n, ...GOOD], 5n * ZETA);
  await assert.rejects(v.arena.send('red1', 'challenge', [1n, ...GOOD], 5n * ZETA), /WrongPhase/, 'one challenge per round');
  v.c.advance(DAY);
  await assert.rejects(v.arena.send('eve', 'settle', [1n]), /WrongPhase/, 'waits for governance');
  await assert.rejects(v.arena.send('eve', 'resolveChallenge', [1n, true]), /NotGovernance/);
  // governance re-ran the pinned sandbox and got GOOD
  await v.arena.send('gov', 'resolveChallenge', [1n, true]);
  const rr = await v.arena.call('rounds', [1n]);
  assert.equal(rr.redValid, 3n); assert.equal(rr.redEvaded, 1n);
  assert.equal((await v.arena.call('stakes', [v.A('r1')])).bond, 5n * ZETA);
  assert.equal((await v.arena.call('stakes', [v.A('r2')])).bond, 5n * ZETA);
  // the challenger: its bond + half of the two new slashes (10 / 2)
  assert.equal(await v.arena.call('owed', [v.A('eve')]), 10n * ZETA);
  await v.arena.send('eve', 'settle', [1n]);
  // r3 alone agreed with the final result: the fee (5) + r3's own earlier slash (5) + the other half (5)
  assert.equal(await v.arena.call('owed', [v.A('r3')]), 15n * ZETA);
  assert.equal(await v.arena.call('owed', [v.A('red1')]), 58n * ZETA);
});

test('arena: a rejected challenge pays the runners; an unanswered one lapses with the bond back', async () => {
  const v = await setup();
  await entries(v);
  const s = [await v.seal('r1', GOOD), await v.seal('r2', GOOD)];
  v.c.advance(100);
  await v.arena.send('r1', 'revealResult', s[0]);
  await v.arena.send('r2', 'revealResult', s[1]);
  v.c.advance(100);
  await v.arena.send('eve', 'finalize', [1n]);
  await v.arena.send('eve', 'challenge', [1n, ...BAD], 5n * ZETA);
  await v.arena.send('gov', 'resolveChallenge', [1n, false]);
  await assert.rejects(v.arena.send('gov', 'resolveChallenge', [1n, true]), /WrongPhase/);
  v.c.advance(DAY);
  await v.arena.send('eve', 'settle', [1n]);
  assert.equal(await v.arena.call('owed', [v.A('eve')]), 0n);
  assert.equal(await v.arena.call('owed', [v.A('r1')]), (5n * ZETA + 5n * ZETA) / 2n, 'fee + the lost challenge bond');
  // another round: governance never answers
  const w = await setup();
  await entries(w);
  const t = [await w.seal('r1', GOOD), await w.seal('r2', GOOD)];
  w.c.advance(100);
  await w.arena.send('r1', 'revealResult', t[0]);
  await w.arena.send('r2', 'revealResult', t[1]);
  w.c.advance(100);
  await w.arena.send('eve', 'finalize', [1n]);
  await w.arena.send('eve', 'challenge', [1n, ...BAD], 5n * ZETA);
  await assert.rejects(w.arena.send('eve', 'expireChallenge', [1n]), /WrongPhase/);
  w.c.advance(8 * DAY + 1);
  await w.arena.send('eve', 'expireChallenge', [1n]);
  assert.equal(await w.arena.call('owed', [w.A('eve')]), 5n * ZETA);
  await w.arena.send('eve', 'settle', [1n]);
  assert.equal((await w.arena.call('rounds', [1n])).redValid, 3n, 'the result stands');
});

test('arena: no quorum voids the round; silent runners are slashed anyway; bonds and seats are enforced', async () => {
  const v = await setup();
  await entries(v);
  const s1 = await v.seal('r1', GOOD); const s2 = await v.seal('r2', BAD); await v.seal('r3', GOOD);
  v.c.advance(100);
  await v.arena.send('r1', 'revealResult', s1);
  await v.arena.send('r2', 'revealResult', s2); // r3 never reveals
  await assert.rejects(v.arena.send('r3', 'requestUnbond'), /Busy/, 'seated in an open round');
  v.c.advance(100);
  const ev = await v.arena.send('eve', 'finalize', [1n]);
  assert.deepEqual(ev.filter((e) => e?.name === 'RunnerSlashed').map((e) => [e.args.runner, e.args.revealed]), [[v.A('r3'), false]], 'only the silent runner');
  const r = await v.arena.call('rounds', [1n]);
  assert.equal(r.judged, false);
  await assert.rejects(v.arena.send('eve', 'challenge', [1n, ...GOOD], 5n * ZETA), /WrongPhase/, 'nothing judged to challenge');
  await v.arena.send('eve', 'settle', [1n]);
  assert.equal(await v.arena.call('owed', [v.A('red1')]), 1n * ZETA, 'void: revealed bonds back');
  assert.equal(await v.arena.call('owed', [v.A('red3')]), 0n);
  assert.equal(await v.arena.call('carry'), 100n * ZETA + 1n * ZETA + 5n * ZETA, 'pools + the unrevealed bond + the slash');
  // bonds: a runner below the bond cannot take a seat; unbonding waits
  await v.arena.send('r4', 'requestUnbond');
  await assert.rejects(v.arena.send('r4', 'withdrawBond'), /WrongPhase/);
  v.c.advance(14 * DAY);
  await v.arena.send('r4', 'withdrawBond');
  assert.equal((await v.arena.call('stakes', [v.A('r4')])).bond, 0n);
  // params: quorum must stay above half the seats
  await assert.rejects(v.arena.send('gov', 'setRunnerParams', [5, 10n * ZETA, 5000, 500, 5n * ZETA, DAY, 7 * DAY]), /BadInput/);
  await assert.rejects(v.arena.send('gov', 'setParams', [ZETA, ZETA, 1]), /BadInput/);
  await assert.rejects(v.arena.send('gov', 'openRound', [v.c.now() + 10n, v.c.now() + 20n, v.c.now() + 30n, v.c.now() + 40n, 5000, '0x' + '00'.repeat(32)]), /BadInput/, 'a sandbox is required');
  const low = await setup();
  await low.arena.send('gov', 'setRunnerParams', [3, 20n * ZETA, 5000, 500, 5n * ZETA, DAY, 7 * DAY]);
  await entries(low);
  await assert.rejects(low.seal('r1', GOOD), /LowBond/);
});
