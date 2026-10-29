// SignalBoard (contracts/SignalBoard.sol) on an in-memory EVM: posts are events
// only, bounded in size and expiry, rate-limited per sender, with no owner; and
// the browser side (zetaphy-neuro/ai/browser/boards.js) encodes the call and
// decodes the event exactly as ethers does from the ABI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexlify, randomBytes, getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import { postCalldata, decodeSignalLog, SIGNAL_EVENT, POST_SELECTOR } from '../../zetaphy-neuro/ai/browser/boards.js';

async function setup() {
  const c = await createChain(['deployer', 'alice', 'bob']);
  const board = await c.deploy('SignalBoard', [], 'deployer');
  return { c, board, A: (n) => getAddress(c.acct[n].toString()) };
}
const T = '0x' + 'ab'.repeat(32);

test('post emits Signal(topic, to, from, expiresAt, payload); nothing else is stored; no owner', async () => {
  const { c, board, A } = await setup();
  const to = '0x' + 'cd'.repeat(16) + '00'.repeat(16);
  const payload = hexlify(randomBytes(700));
  const exp = c.now() + 300n;
  const ev = (await board.send('alice', 'post', [T, to, exp, payload])).filter(Boolean);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].name, 'Signal');
  assert.deepEqual([ev[0].args.topic, ev[0].args.to, ev[0].args.from, ev[0].args.expiresAt, ev[0].args.payload], [T, to, A('alice'), exp, payload]);
  assert.equal(board.iface.getEvent('Signal').topicHash, SIGNAL_EVENT);
  assert.equal(board.iface.getFunction('post').selector, '0x' + POST_SELECTOR);
  assert.equal(await board.call('remaining', [A('alice')]), 11n);
  assert.equal(await board.call('remaining', [A('bob')]), 12n);
  const fns = board.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name).sort();
  assert.deepEqual(fns, ['MAX_PAYLOAD', 'MAX_PER_WINDOW', 'MAX_TTL', 'WINDOW', 'post', 'rate', 'remaining']);
  // gas of a typical 1 KB offer
  const g = await board.gas('bob', 'post', [T, to, exp, hexlify(randomBytes(1024))]);
  assert.ok(g.exec < 40_000, `exec gas ${g.exec}`);
});

test('bounds: topic, payload 1..2048, expiry within (now, now + 600]', async () => {
  const { c, board } = await setup();
  const ok = hexlify(randomBytes(10));
  await assert.rejects(board.send('alice', 'post', ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), c.now() + 60n, ok]), /NoTopic/);
  await assert.rejects(board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now() + 60n, '0x']), /PayloadSize/);
  await assert.rejects(board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now() + 60n, hexlify(randomBytes(2049))]), /PayloadSize/);
  await board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now() + 60n, hexlify(randomBytes(2048))]);
  await assert.rejects(board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now(), ok]), /BadExpiry/);
  await assert.rejects(board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now() + 601n, ok]), /BadExpiry/);
  await board.send('alice', 'post', [T, '0x' + '00'.repeat(32), c.now() + 600n, ok]);
});

test('rate limit: 12 posts per sender per 60 s window; other senders unaffected; a new window resets', async () => {
  const { c, board, A } = await setup();
  const args = () => [T, '0x' + '00'.repeat(32), c.now() + 60n, '0x01'];
  for (let i = 0; i < 12; i++) await board.send('alice', 'post', args());
  await assert.rejects(board.send('alice', 'post', args()), /RateLimited/);
  assert.equal(await board.call('remaining', [A('alice')]), 0n);
  await board.send('bob', 'post', args());
  c.advance(59);
  await assert.rejects(board.send('alice', 'post', args()), /RateLimited/);
  c.advance(1);
  await board.send('alice', 'post', args());
  assert.equal(await board.call('remaining', [A('alice')]), 11n);
});

test('the browser encodes post() and decodes Signal logs exactly as the ABI does', async () => {
  const { c, board, A } = await setup();
  for (const len of [1, 31, 32, 33, 700, 2048]) {
    const bytes = randomBytes(len);
    const topic = randomBytes(32), to = randomBytes(16);
    const exp = Number(c.now()) + 100;
    const mine = postCalldata({ topic, to, expiresAt: exp, bytes });
    assert.equal(mine, board.iface.encodeFunctionData('post', [topic, hexlify(to) + '00'.repeat(16), exp, bytes]));
    const { returnHex, ok } = await c.rawCall('alice', board.address, mine);
    assert.ok(ok, returnHex);
    const res = await c.sendTo('bob', board.address, board.iface, 'post', [topic, hexlify(to) + '00'.repeat(16), exp, bytes]);
    const [, topics, data] = res.execResult.logs[0];
    const d = decodeSignalLog({ topics: topics.map((t) => hexlify(t)), data: hexlify(data), blockNumber: '0x5' });
    assert.deepEqual([d.topic, d.to, d.from, d.expiresAt, hexlify(d.bytes), d.block], [hexlify(topic).slice(2), hexlify(to).slice(2) + '00'.repeat(16), A('bob').toLowerCase(), exp, hexlify(bytes), 5]);
  }
  assert.throws(() => decodeSignalLog({ topics: ['0x' + '00'.repeat(32)], data: '0x' }), /not a Signal log/);
});
