// DataDAO: labelled data submissions, a rewards round from the attribution report's merkle root, claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, getAddress } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { rewardsTree, rewardLeaf, rewardsFromReport, verifyReward } from '../src/markets.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scripts/markets.js dao-root: attribution report -> root and proofs (offline)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dao-'));
  try {
    const a = '0x' + 'aa'.repeat(20); const b = '0x' + 'bb'.repeat(20); const dao = '0x' + 'dd'.repeat(20);
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ format: 'neuro-dao-attribution/1', method: 'loo', contributors: [{ account: a, share: 0.6 }, { account: b, share: 0.4 }] }));
    const script = new URL('../scripts/markets.js', import.meta.url).pathname;
    execFileSync('node', [script, 'dao-root', '--report', join(dir, 'report.json'), '--budget', '50', '--dao', dao, '--round', '3', '--out', join(dir, 'root.json')]);
    const out = JSON.parse(readFileSync(join(dir, 'root.json'), 'utf8'));
    assert.equal(out.total, (50n * 10n ** 18n).toString());
    for (const [acct, cl] of Object.entries(out.claims)) assert.ok(verifyReward({ dao, chainId: 77390, round: 3, root: out.root }, acct, cl.amount, cl.proof));
    assert.equal(out.claims[getAddress(a)].amount, (30n * 10n ** 18n).toString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const DAY = 86400;
const H = (s) => keccak256(new TextEncoder().encode(s));

async function setup() {
  const c = await createChain(['gov', 'poster', 'ann', 'ben', 'cat', 'eve']);
  const A = (n) => getAddress(c.acct[n].toString());
  const dao = await c.deploy('DataDAO', [A('gov'), A('poster')], 'gov');
  return { c, A, dao };
}

test('data DAO: submissions are unique, bounded, and can be excluded by governance', async () => {
  const { A, dao } = await setup();
  await dao.send('ann', 'submit', [H('rows a'), 'ipfs://a', 120, 'CC0-1.0']);
  await assert.rejects(dao.send('ben', 'submit', [H('rows a'), 'ipfs://copy', 120, 'CC0-1.0']), /Duplicate/);
  await assert.rejects(dao.send('ben', 'submit', [H('rows b'), 'x'.repeat(201), 1, 'MIT']), /BadInput/);
  await assert.rejects(dao.send('ben', 'submit', [H('rows b'), 'ipfs://b', 0, 'MIT']), /BadInput/);
  await assert.rejects(dao.send('ben', 'submit', [H('rows b'), 'ipfs://b', 5, '']), /BadInput/);
  await dao.send('ben', 'submit', [H('rows b'), 'ipfs://b', 40, 'MIT']);
  assert.equal(await dao.call('submissionCount'), 2n);
  const s = await dao.call('submission', [2n]);
  assert.equal(s.contributor, A('ben')); assert.equal(s.rows, 40n); assert.equal(s.license, 'MIT');
  await assert.rejects(dao.send('ann', 'exclude', [2n, true]), /NotGovernance/);
  await dao.send('gov', 'exclude', [2n, true]);
  assert.equal((await dao.call('submission', [2n])).excluded, true);
});

test('data DAO: a round from the attribution report, veto window, merkle claims, sweep', async () => {
  const { c, A, dao } = await setup();
  await dao.send('cat', 'fund', [], 100n * ZETA);
  // attribution report -> amounts (positive shares only) -> tree
  const report = { contributors: [{ account: A('ann'), share: 0.75 }, { account: A('ben'), share: 0.25 }, { account: A('eve'), share: -0.1 }] };
  const rewards = rewardsFromReport(report, 40n * ZETA);
  assert.deepEqual(rewards.map((r) => r.amount), [30n * ZETA, 10n * ZETA]);
  const tree = rewardsTree({ dao: dao.address, chainId: 1, round: 1, rewards }); // the in-memory chain's id is 1
  assert.equal(rewardLeaf(dao.address, 1, 1, A('ann'), 30n * ZETA), await dao.call('leafOf', [1n, A('ann'), 30n * ZETA]));
  await assert.rejects(dao.send('eve', 'postRound', [tree.root, tree.total, H('report'), 'ipfs://report']), /NotPoster/);
  await assert.rejects(dao.send('poster', 'postRound', [tree.root, 101n * ZETA, H('report'), 'ipfs://report']), /NotEnoughFunds/);
  await dao.send('poster', 'postRound', [tree.root, tree.total, H('report'), 'ipfs://report']);
  assert.equal(await dao.call('available'), 60n * ZETA);
  const cl = tree.claims[A('ann')];
  await assert.rejects(dao.send('ann', 'claim', [1n, A('ann'), cl.amount, cl.proof]), /NotOpen/); // veto window
  c.advance(2 * DAY);
  await assert.rejects(dao.send('gov', 'veto', [1n]), /NotOpen/);
  await assert.rejects(dao.send('ann', 'claim', [1n, A('ann'), 31n * ZETA, cl.proof]), /BadProof/);
  await assert.rejects(dao.send('eve', 'claim', [1n, A('eve'), cl.amount, cl.proof]), /BadProof/);
  const before = await c.balance('ann');
  await dao.send('eve', 'claim', [1n, A('ann'), cl.amount, cl.proof]); // anyone can send it; ann gets the coins
  assert.equal((await c.balance('ann')) - before, 30n * ZETA);
  await assert.rejects(dao.send('ann', 'claim', [1n, A('ann'), cl.amount, cl.proof]), /AlreadyClaimed/);
  // ben never claims: after the claim period it returns to the pool
  await assert.rejects(dao.send('eve', 'sweep', [1n]), /NotOpen/);
  c.advance(60 * DAY);
  const b = tree.claims[A('ben')];
  await assert.rejects(dao.send('ben', 'claim', [1n, A('ben'), b.amount, b.proof]), /NotOpen/);
  await dao.send('eve', 'sweep', [1n]);
  assert.equal(await dao.call('available'), 70n * ZETA);
  assert.equal(await dao.call('reserved'), 0n);
});

test('data DAO: governance vetoes a wrong root before claims open', async () => {
  const { c, A, dao } = await setup();
  await dao.send('cat', 'fund', [], 10n * ZETA);
  const tree = rewardsTree({ dao: dao.address, chainId: 1, round: 1, rewards: [{ account: A('eve'), amount: 10n * ZETA }] });
  await dao.send('poster', 'postRound', [tree.root, tree.total, H('bad'), 'ipfs://bad']);
  await dao.send('gov', 'veto', [1n]);
  assert.equal(await dao.call('available'), 10n * ZETA);
  c.advance(3 * DAY);
  const cl = tree.claims[A('eve')];
  await assert.rejects(dao.send('eve', 'claim', [1n, A('eve'), cl.amount, cl.proof]), /NotOpen/);
});
