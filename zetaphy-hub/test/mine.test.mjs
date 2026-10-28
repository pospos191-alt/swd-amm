// The browser proof-of-work faucet: the hash and the search match what the node checks
// (evmd/zetaphy_faucetpow.go: sha256(chainId u64be || blockHash || address || nonce u64be), leading zero bits),
// and the Earn faucet form's request helper tells "node paused" from the node's own refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256, zeroBits, powPrefix, powMessage, powOk, search, nonceHex, expectedTries } from '../mine-core.js';
import { mineAddress, chanceBy, clock, rate } from '../mine.js';
import { askFaucet } from '../pages.js';

test('sha256 is SHA-256 (every padding case)', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 68, 119, 120, 128, 300]) {
    const b = randomBytes(n);
    assert.equal(Buffer.from(sha256(b)).toString('hex'), createHash('sha256').update(b).digest('hex'), `${n} bytes`);
  }
});

test('the proof message: chainId (8, big-endian) || block hash || address || nonce (8, big-endian)', () => {
  const p = powPrefix(77390, `0x${'ab'.repeat(32)}`, '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245');
  const m = powMessage(p, 0x01020304, 0x05060708);
  assert.equal(Buffer.from(m).toString('hex'),
    `0000000000012e4e${'ab'.repeat(32)}6af57fc3633dd0f7907f7900dbd4a2822f43a2450102030405060708`);
  assert.equal(nonceHex(0x01020304, 0x05060708), '0x0102030405060708');
  assert.equal(nonceHex(0, 1), '0x0000000000000001');
  assert.throws(() => powPrefix(77390, '0x12', '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245'));
});

test('search finds the first nonce with enough zero bits, the same one node:crypto agrees on', () => {
  const p = powPrefix(77390, `0x${'5c'.repeat(32)}`, `0x${'12'.repeat(20)}`);
  for (const bits of [1, 8, 14]) {
    const lo = search(p, 7, bits, 0, 1 << 24);
    assert.ok(lo >= 0);
    const h = createHash('sha256').update(powMessage(p, 7, lo)).digest();
    assert.ok(zeroBits(h) >= bits, `${bits} bits`);
    assert.ok(powOk(p, 7, lo, bits));
    for (let i = 0; i < lo; i++) assert.ok(!powOk(p, 7, i, bits), `missed ${i}`);
  }
  // more than 32 bits: the second word counts too (no proof in a short range)
  assert.equal(search(p, 7, 40, 0, 1000), -1);
  assert.equal(zeroBits(new Uint8Array([0, 0, 0, 0, 0x10])), 35);
  assert.equal(zeroBits(new Uint8Array(32)), 256);
  assert.equal(expectedTries(30), 2 ** 30);
});

test('page helpers: address forms, chance, times', () => {
  assert.equal(mineAddress(' 0x6af57fC3633dD0F7907f7900dbd4A2822F43a245 '), '0x6af57fC3633dD0F7907f7900dbd4A2822F43a245');
  assert.equal(mineAddress('zetaphy1dt6hlsmr8hg00yrl0yqdh49zsgh58gj9jh7u0d'), '0x6af57fc3633dd0f7907f7900dbd4a2822f43a245');
  for (const bad of ['', '0x12', 'cosmos1dt6hlsmr8nwlmepl0yqdhfp22qhn6gj9x3j6zk', null]) assert.equal(mineAddress(bad), null);
  assert.equal(chanceBy(0, 20), 0);
  assert.ok(Math.abs(chanceBy(2 ** 20, 20) - (1 - Math.exp(-1))) < 1e-12);
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(NaN), '–');
  assert.equal(rate(2.38e6), '2.38 MH/s');
  assert.equal(rate(110_000), '110 kH/s');
});

test('askFaucet: the tx hash; the node\'s own reason; "down" when the node cannot be reached', async () => {
  const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
  assert.deepEqual(await askFaucet('https://n', '0x1', reply(200, { result: { txHash: `0x${'ab'.repeat(32)}` } })), { txHash: `0x${'ab'.repeat(32)}` });
  await assert.rejects(askFaucet('https://n', '0x1', reply(200, { error: { message: 'this address already has ZETAPHY' } })), (e) => !e.down && /already has/.test(e.message));
  // rpc-guard answers 429 with a JSON-RPC error: the reason is shown, not "HTTP 429"
  await assert.rejects(askFaucet('https://n', '0x1', reply(429, { error: { message: 'at most 3 grants a day' } })), (e) => !e.down && /3 grants/.test(e.message));
  await assert.rejects(askFaucet('https://n', '0x1', reply(502, '<html>')), (e) => e.down);
  await assert.rejects(askFaucet('https://n', '0x1', async () => { throw new TypeError('Failed to fetch'); }), (e) => e.down);
});
