// DetectorPool: detector organisms scored each round by their Foresight Brier scores; winners paid, losers slashed and retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, getAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { foresightCommitment, modelIdOf } from '../src/markets.js';

const DAY = 86400;
const H = (s) => keccak256(new TextEncoder().encode(s));

async function setup() {
  const c = await createChain(['gov', 'res', 'ann', 'ben', 'cat', 'eve', 'funder']);
  const A = (n) => getAddress(c.acct[n].toString());
  const fs = await c.deploy('ForesightRegistry', [A('gov')], 'gov');
  await fs.send('gov', 'setResolver', [A('res'), true]);
  const pool = await c.deploy('DetectorPool', [A('gov'), fs.address], 'gov');
  /** n events: each model (owner, id) forecasts p[i] for event i; outcomes[i] true = Yes. */
  let salt = 0;
  const forecastRound = async (models, outcomes) => {
    const first = Number(await fs.call('eventCount')) + 1;
    for (let i = 0; i < outcomes.length; i++) await fs.send('res', 'openEvent', [H(`ev${first + i}`), c.now() + 100n, c.now() + 200n]);
    const plan = [];
    for (const [owner, id, ps] of models) {
      for (let i = 0; i < outcomes.length; i++) {
        const ev = BigInt(first + i); const s = H(`s${salt++}`);
        await fs.send(owner, 'commit', [ev, id, foresightCommitment(ev, id, ps[i], s)]);
        plan.push([owner, ev, id, ps[i], s]);
      }
    }
    c.advance(100);
    for (const [owner, ev, id, p, s] of plan) await fs.send(owner, 'reveal', [ev, id, p, s]);
    for (let i = 0; i < outcomes.length; i++) await fs.send('res', 'resolve', [BigInt(first + i), outcomes[i] ? 2 : 1]);
    for (const [, ev, id] of plan) await fs.send('eve', 'score', [ev, id]);
  };
  return { c, A, fs, pool, forecastRound };
}

test('detector pool: register needs the Foresight model, a stake and room', async () => {
  const { A, fs, pool } = await setup();
  const m = modelIdOf('det a');
  await assert.rejects(pool.send('ann', 'register', [m, H('spec a'), 0, 'ipfs://a'], 1n * ZETA), /NotModelOwner/);
  await fs.send('ann', 'registerModel', [m]);
  await assert.rejects(pool.send('ann', 'register', [m, H('spec a'), 0, 'ipfs://a'], ZETA / 2n), /BadInput/);
  await assert.rejects(pool.send('ann', 'register', [m, H('spec a'), 5, 'ipfs://a'], 1n * ZETA), /BadInput/); // no such parent
  await pool.send('ann', 'register', [m, H('spec a'), 0, 'ipfs://a'], 1n * ZETA);
  await assert.rejects(pool.send('ann', 'register', [m, H('spec a2'), 1, 'ipfs://a2'], 1n * ZETA), /ModelInUse/);
  const o = await pool.call('organism', [1]);
  assert.equal(o.author, A('ann')); assert.equal(o.alive, true); assert.equal(o.stake, 1n * ZETA);
  // a child of organism 1
  const m2 = modelIdOf('det a child'); await fs.send('ann', 'registerModel', [m2]);
  const ev = await pool.send('ann', 'register', [m2, H('spec a child'), 1, 'ipfs://a2'], 1n * ZETA);
  assert.equal(ev.find((e) => e?.name === 'Born').args.parent, 1n);
});

test('detector pool: winners paid from slashes + pool, losers slashed then retired, idle ones retired', async () => {
  const { c, A, fs, pool, forecastRound } = await setup();
  await pool.send('funder', 'fund', [], 20n * ZETA);
  const ids = {};
  for (const n of ['ann', 'ben', 'cat', 'eve']) {
    ids[n] = modelIdOf(`det ${n}`);
    await fs.send(n, 'registerModel', [ids[n]]);
    await pool.send(n, 'register', [ids[n], H(`spec ${n}`), 0, `ipfs://${n}`], 10n * ZETA);
  }
  await assert.rejects(pool.send('eve', 'scoreRound'), /NotYet/);
  const outcomes = [true, false, true, true];
  // ann: sharp and right; ben: mostly right; cat: confidently wrong; eve: does not forecast
  await forecastRound([
    ['ann', ids.ann, [9000, 1000, 9000, 9000]],
    ['ben', ids.ben, [7000, 3000, 6000, 7000]],
    ['cat', ids.cat, [1000, 9000, 2000, 1000]],
  ], outcomes);
  c.advance(7 * DAY);
  const ev = await pool.send('eve', 'scoreRound');
  const won = ev.filter((e) => e?.name === 'Won');
  const slashed = ev.filter((e) => e?.name === 'Slashed');
  assert.equal(won.length, 2); assert.equal(slashed.length, 1);
  assert.equal(slashed[0].args.amount, 2n * ZETA); // 20% of cat's 10
  // budget = rewardPerRound (10) + slashed (2) = 12, split by (0.25 - brier) x n
  const wA = (25_000_000n - 1_000_000n) * 4n; // ann's brier 0.01
  const bB = (3000n ** 2n * 3n + 4000n ** 2n) / 4n; // ben: 0.09, 0.09, 0.16, 0.09 -> mean
  const wB = (25_000_000n - bB) * 4n;
  assert.equal(await pool.call('owed', [A('ann')]), (12n * ZETA * wA) / (wA + wB));
  assert.equal(await pool.call('owed', [A('ben')]), (12n * ZETA * wB) / (wA + wB));
  assert.equal((await pool.call('organism', [3])).strikes, 1n);
  assert.equal((await pool.call('organism', [3])).stake, 8n * ZETA);
  // two more bad rounds: cat retired with what is left; eve idles out after 4 rounds
  for (let r = 0; r < 3; r++) {
    await forecastRound([['ann', ids.ann, [9000, 1000, 9000]], ['cat', ids.cat, [1000, 9000, 1000]]], [true, false, true]);
    c.advance(7 * DAY);
    await pool.send('eve', 'scoreRound');
  }
  const cat = await pool.call('organism', [3]);
  assert.equal(cat.alive, false);
  assert.equal(cat.stake, 0n);
  assert.equal(await pool.call('owed', [A('cat')]), 8n * ZETA - (8n * ZETA) / 5n - ((8n * ZETA - (8n * ZETA) / 5n) / 5n), 'what was left after three slashes');
  assert.equal((await pool.call('organism', [4])).alive, false, 'eve idled 4 rounds');
  assert.equal(await pool.call('owed', [A('eve')]), 10n * ZETA, 'idle: stake back, not slashed');
  assert.equal(await pool.call('aliveCount'), 2n);
  const before = await c.balance('cat');
  await pool.send('cat', 'withdraw');
  assert.ok((await c.balance('cat')) > before);
});

test('detector pool: an exit takes effect only after the next round is scored', async () => {
  const { c, A, fs, pool, forecastRound } = await setup();
  const m = modelIdOf('det x'); await fs.send('ann', 'registerModel', [m]);
  await pool.send('ann', 'register', [m, H('x'), 0, 'ipfs://x'], 10n * ZETA);
  await forecastRound([['ann', m, [100, 9900, 100]]], [true, false, true]); // very wrong
  await assert.rejects(pool.send('ben', 'requestExit', [1]), /NotAuthor/);
  await pool.send('ann', 'requestExit', [1]);
  assert.equal((await pool.call('organism', [1])).alive, true);
  c.advance(7 * DAY);
  await pool.send('eve', 'scoreRound');
  assert.equal((await pool.call('organism', [1])).alive, false);
  assert.equal(await pool.call('owed', [A('ann')]), 8n * ZETA, 'slashed for the round it tried to leave in');
});
