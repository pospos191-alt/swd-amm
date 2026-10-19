import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, encodeBase58, randomBytes } from 'ethers';
import { sumHolders, takeSnapshot } from '../airdrop/snapshot.js';
import { allocate, POOL } from '../airdrop/allocate.js';
import { buildTree, verify } from '../airdrop/merkle.js';

const MINT = 'So11111111111111111111111111111111111111112';
const key = () => encodeBase58(randomBytes(32));
const acct = (owner, amount, mint = MINT) => ({ account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount: String(amount) } } } } } });

test('snapshot sums every token account per owner, across both token programs', () => {
  const [a, b, c, vault] = [key(), key(), key(), key()];
  const holders = sumHolders([[acct(a, 5), acct(b, 7), acct(a, 3), acct(c, 0), acct(b, 99, key())], [acct(c, 2), acct(vault, 1000)]], MINT, new Set([vault]));
  assert.deepEqual(holders.map((h) => [h.owner, h.amount]), [[a, 8n], [b, 7n], [c, 2n]]);
});

test('takeSnapshot asks for finalized data of the given mint only', async () => {
  const calls = [];
  const fetchImpl = async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push([method, params]);
    return { json: async () => ({ result: method === 'getSlot' ? 123 : [acct('8'.repeat(32), 10)] }) };
  };
  const s = await takeSnapshot({ mint: MINT, rpcUrl: 'https://rpc.example', fetchImpl });
  assert.equal(s.slot, 123);
  assert.deepEqual(s.holders, [{ owner: '8'.repeat(32), amount: '20' }]); // one account per program
  assert.equal(calls[1][1][1].filters[0].memcmp.bytes, MINT);
  assert.equal(calls[1][1][1].commitment, 'finalized');
  await assert.rejects(takeSnapshot({ mint: '0xabc', rpcUrl: 'x', fetchImpl }), /Solana address/);
});

test('allocation is pro-rata, never exceeds the pool, and reports dust', () => {
  const snap = { holders: [{ owner: 'A', amount: '1' }, { owner: 'B', amount: '2' }, { owner: 'C', amount: '3' }] };
  const exact = Object.fromEntries(allocate(snap, { pool: 600n }).allocations.map((a) => [a.owner, a.zetaphy]));
  assert.deepEqual(exact, { A: '100', B: '200', C: '300' });
  const r = allocate(snap); // the real 200M pool: rounding leaves dust, which is reported
  const sum = r.allocations.reduce((t, a) => t + BigInt(a.zetaphy), 0n);
  assert.equal(sum + BigInt(r.dust), POOL);
  assert.ok(BigInt(r.dust) < 3n);
});

test('whale cap: capped holders get the cap, others share the rest', () => {
  const snap = { holders: [{ owner: 'W', amount: '900' }, { owner: 'A', amount: '50' }, { owner: 'B', amount: '50' }] };
  const r = allocate(snap, { pool: 1000n, capBps: 4000 }); // cap 400
  const z = Object.fromEntries(r.allocations.map((a) => [a.owner, BigInt(a.zetaphy)]));
  assert.equal(z.W, 400n);
  assert.equal(z.A, 300n);
  assert.equal(z.B, 300n);
  assert.equal(r.dust, '0');
});

test('dust filter drops tiny holders', () => {
  const r = allocate({ holders: [{ owner: 'A', amount: '5' }, { owner: 'B', amount: '1000' }] }, { pool: 100n, minAmount: 10n });
  assert.deepEqual(r.allocations.map((a) => a.owner), ['B']);
  assert.equal(r.allocations[0].zetaphy, '100');
});

test('every claim proves against the root; a changed amount or owner does not', () => {
  const allocations = Array.from({ length: 7 }, (_, i) => ({ owner: key(), zetaphy: String((i + 1) * 1000) }));
  const { root, claims } = buildTree(allocations);
  for (const a of allocations) assert.ok(verify(root, a.owner, a.zetaphy, claims[a.owner].proof));
  const a0 = allocations[0];
  assert.ok(!verify(root, a0.owner, '999999', claims[a0.owner].proof));
  assert.ok(!verify(root, allocations[1].owner, a0.zetaphy, claims[a0.owner].proof));
  assert.throws(() => buildTree([allocations[0], allocations[0]]), /duplicate/);
  assert.ok(Wallet); // ethers loaded
});
