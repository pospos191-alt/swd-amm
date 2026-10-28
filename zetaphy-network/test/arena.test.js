// RedBlueArena: commit-reveal entries, runner quorum on the result, bounties and bonds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, getAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { arenaCommitment, contentHash, arenaResultArgs } from '../src/markets.js';

const H = (s) => keccak256(new TextEncoder().encode(s));

async function setup() {
  const c = await createChain(['gov', 'r1', 'r2', 'red1', 'red2', 'red3', 'blue1', 'blue2', 'eve']);
  const A = (n) => getAddress(c.acct[n].toString());
  const arena = await c.deploy('RedBlueArena', [A('gov')], 'gov');
  await arena.send('gov', 'setRunner', [A('r1'), true]);
  await arena.send('gov', 'setRunner', [A('r2'), true]);
  await arena.send('gov', 'setParams', [1n * ZETA, 1n * ZETA, 2]);
  const t = c.now();
  await arena.send('gov', 'openRound', [t + 100n, t + 200n, t + 300n, 6000], 100n * ZETA);
  /** commits an entry; returns its reveal args */
  const enter = async (who, side, content) => {
    const ch = contentHash(content); const salt = H(`salt ${who}`);
    const ev = await arena.send(who, 'commit', [1n, side, arenaCommitment(arena.address, 1, side, A(who), ch, salt)], 1n * ZETA);
    const index = ev.find((e) => e?.name === 'Committed').args.index;
    return [1n, side, index, ch, salt, `ipfs://${who}`];
  };
  return { c, A, arena, enter };
}

test('arena: commit before, reveal after; runners must agree; red evaders and blue catchers paid', async () => {
  const { c, A, arena, enter } = await setup();
  const r = (await arena.call('rounds', [1n]));
  assert.equal(r.redPool, 60n * ZETA); assert.equal(r.bluePool, 40n * ZETA);
  await assert.rejects(arena.send('red1', 'commit', [1n, 0, H('x')], 2n * ZETA), /BadInput/); // wrong bond
  const red1 = await enter('red1', 0, '{"source":"contract A {}"}');
  const red2 = await enter('red2', 0, '{"source":"contract B {}"}');
  const red3 = await enter('red3', 0, '{"source":"contract C {}"}');
  const blue1 = await enter('blue1', 1, '{"rules":[]}');
  const blue2 = await enter('blue2', 1, '{"rules":[1]}');
  await assert.rejects(arena.send('red1', 'reveal', red1), /WrongPhase/);
  c.advance(100);
  await assert.rejects(arena.send('red1', 'commit', [1n, 0, H('late')], 1n * ZETA), /WrongPhase/);
  await assert.rejects(arena.send('eve', 'reveal', red1), /BadReveal/); // not the author
  await assert.rejects(arena.send('red1', 'reveal', [...red1.slice(0, 3), H('other content'), ...red1.slice(4)]), /BadReveal/);
  await arena.send('red1', 'reveal', red1);
  await arena.send('red2', 'reveal', red2);
  await arena.send('blue1', 'reveal', blue1);
  await arena.send('blue2', 'reveal', blue2);
  // red3 never reveals
  assert.deepEqual((await arena.call('counts', [1n])).map(Number), [3, 2]);
  await assert.rejects(arena.send('r1', 'postResult', [1n, 1n, 1n, [3, 1]]), /WrongPhase/); // still revealing
  c.advance(100);
  // the runner's result: red1 valid + evaded, red2 valid but caught; blue1 caught red2 (+1), blue2 flagged benign (-2)
  const result = { red: [{ index: 0, valid: true, evaded: true }, { index: 1, valid: true, evaded: false }, { index: 2, valid: false, evaded: false }], blue: [{ index: 0, score: 1 }, { index: 1, score: -2 }] };
  const args = arenaResultArgs(result);
  assert.deepEqual(args, [3n, 1n, [1, -2]]);
  await assert.rejects(arena.send('eve', 'postResult', [1n, ...args]), /NotRunner/);
  await assert.rejects(arena.send('r1', 'postResult', [1n, 7n, 1n, [1, -2]]), /BadInput/); // red3 not revealed
  await assert.rejects(arena.send('r1', 'postResult', [1n, 1n, 2n, [1, -2]]), /BadInput/); // evaded but not valid
  await assert.rejects(arena.send('r1', 'postResult', [1n, 3n, 1n, [1]]), /BadInput/);
  await arena.send('r1', 'postResult', [1n, ...args]);
  await assert.rejects(arena.send('r1', 'postResult', [1n, ...args]), /AlreadyPosted/);
  assert.equal((await arena.call('rounds', [1n])).judged, false, 'quorum is 2');
  await arena.send('r2', 'postResult', [1n, ...args]);
  assert.equal((await arena.call('rounds', [1n])).judged, true);
  await assert.rejects(arena.send('eve', 'settle', [1n]), /WrongPhase/);
  c.advance(100);
  await arena.send('eve', 'settle', [1n]);
  await assert.rejects(arena.send('eve', 'settle', [1n]), /WrongPhase/);
  assert.equal(await arena.call('owed', [A('red1')]), 61n * ZETA, 'bond + the whole red pool');
  assert.equal(await arena.call('owed', [A('red2')]), 1n * ZETA, 'valid but caught: bond back');
  assert.equal(await arena.call('owed', [A('red3')]), 0n, 'unrevealed: bond lost');
  assert.equal(await arena.call('owed', [A('blue1')]), 41n * ZETA);
  assert.equal(await arena.call('owed', [A('blue2')]), 1n * ZETA);
  assert.equal(await arena.call('carry'), 1n * ZETA, "red3's bond carries over");
  const before = await c.balance('red1');
  await arena.send('red1', 'withdraw');
  assert.equal((await c.balance('red1')) - before, 61n * ZETA);
  // the next round starts with the carry
  const t = c.now();
  await arena.send('gov', 'openRound', [t + 100n, t + 200n, t + 300n, 5000], 9n * ZETA);
  const r2 = await arena.call('rounds', [2n]);
  assert.equal(r2.redPool + r2.bluePool, 10n * ZETA);
});

test('arena: no result by the judge deadline voids the round (revealed bonds back, pools carried)', async () => {
  const { c, A, arena, enter } = await setup();
  const red1 = await enter('red1', 0, 'a');
  await enter('blue1', 1, 'b');
  c.advance(100);
  await arena.send('red1', 'reveal', red1);
  c.advance(100);
  await arena.send('r1', 'postResult', [1n, 1n, 1n, [0]]);
  await arena.send('r2', 'postResult', [1n, 1n, 0n, [0]]); // runners disagree: no quorum
  c.advance(100);
  const ev = await arena.send('eve', 'settle', [1n]);
  assert.equal(ev.find((e) => e?.name === 'Settled').args.void, true);
  assert.equal(await arena.call('owed', [A('red1')]), 1n * ZETA);
  assert.equal(await arena.call('owed', [A('blue1')]), 0n);
  assert.equal(await arena.call('carry'), 101n * ZETA);
});
