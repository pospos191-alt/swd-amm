// "Human" ≠ unique human: VouchRegistry adds an optional level on top of LabelRegistry's passkey label.
// 0 none / agent, 1 passkey human (NOT proven unique), 2 vouched unique human (N vouches from vouched-unique
// humans, rate-limited, bound to the vouchee's passkey, revocable, flaggable, bannable with strikes for the
// vouchers). Passkeys are real P-256 assertions checked by the precompile stand-in, as in labels.test.js.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { id as textHash } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, passkey } from './helpers/precompiles.js';

const DAY = 86_400;
const NAMES = ['gov', 'g1', 'g2', 'g3', 'alice', 'bob', 'carol', 'dave', 'sybil', 'bot', 'operator'];
let c, labels, v, reg;
const addr = (n) => c.acct[n].toString();
const keys = {};

async function prove(who, key = passkey('app.sawasdeecoin.com')) {
  keys[who] = key;
  const ch = await labels.call('humanChallenge', [addr(who)]);
  await labels.send(who, 'proveHumanP256', [key.x, key.y, key.assert(ch)]);
}
const level = async (who) => Number(await v.call('levelOf', [addr(who)]));

beforeEach(async () => {
  c = await createChain(NAMES, {}, { precompiles: PRECOMPILES });
  reg = await c.deploy('AgentRegistry', [addr('gov'), 10n * ZETA, 1n * ZETA], 'gov');
  const wa = await c.deploy('WebAuthnVerifier', [], 'gov');
  labels = await c.deploy('LabelRegistry', [addr('gov'), reg.address, wa.address, passkey('app.sawasdeecoin.com').rpIdHash, 400 * DAY], 'gov');
  v = await c.deploy('VouchRegistry', [labels.address, addr('gov')], 'gov');
  for (const n of ['g1', 'g2', 'g3', 'alice', 'bob', 'carol', 'dave', 'sybil']) await prove(n);
  await v.send('gov', 'setGenesis', [[addr('g1'), addr('g2'), addr('g3')], true]);
});

test('levels: none, passkey human (not unique), vouched unique after N vouches and a refresh; a vouch is live', async () => {
  assert.equal(await level('bot'), 0); // no label
  assert.equal(await level('alice'), 1); // a passkey says nothing about uniqueness
  assert.equal(await level('g1'), 2); // bootstrap set
  await v.send('g1', 'vouch', [addr('alice')]);
  await v.send('g2', 'vouch', [addr('alice')]);
  await v.send('alice', 'refresh', [addr('alice')]);
  assert.equal(await level('alice'), 1, 'two of three vouches');
  await v.send('g3', 'vouch', [addr('alice')]);
  assert.equal(await level('alice'), 1, 'counted once refreshed');
  await v.send('bob', 'refresh', [addr('alice')]); // anyone may refresh
  assert.equal(await level('alice'), 2);
  const s = await v.call('status', [addr('alice')]);
  assert.deepEqual([s[0], s[1], s[2]], [2n, 3n, 3n]);
  assert.deepEqual((await v.call('vouchersOf', [addr('alice')])).length, 3);
  // withdrawing a vouch takes effect at once (no refresh needed)
  await v.send('g3', 'unvouch', [addr('alice')]);
  assert.equal(await level('alice'), 1);
  await assert.rejects(v.send('g3', 'unvouch', [addr('alice')]), /NoVouch/);
});

test('who may vouch, and how often: only vouched-unique humans, aged, one per cooldown, a few open at once; never oneself or a non-human', async () => {
  await assert.rejects(v.send('alice', 'vouch', [addr('bob')]), /NotUnique/);
  await assert.rejects(v.send('g1', 'vouch', [addr('g1')]), /Self/);
  await assert.rejects(v.send('g1', 'vouch', [addr('bot')]), /NotPasskeyHuman/);
  await v.send('g1', 'vouch', [addr('alice')]);
  await assert.rejects(v.send('g1', 'vouch', [addr('bob')]), /TooSoon/); // cooldown 7 days
  c.advance(7 * DAY);
  await assert.rejects(v.send('g1', 'vouch', [addr('alice')]), /AlreadyVouched/);
  await v.send('g1', 'vouch', [addr('bob')]);
  // alice becomes unique, but may vouch only after 30 days
  await v.send('g2', 'vouch', [addr('alice')]);
  await v.send('g3', 'vouch', [addr('alice')]);
  await v.send('alice', 'refresh', [addr('alice')]);
  assert.equal(await level('alice'), 2);
  await assert.rejects(v.send('alice', 'vouch', [addr('carol')]), /TooSoon/);
  const next = (await v.call('status', [addr('alice')]))[9];
  assert.ok(next >= c.now() + 29n * 86_400n);
  c.advance(30 * DAY);
  await v.send('alice', 'vouch', [addr('carol')]);
  // at most maxActiveVouches open (set to 2 here)
  await v.send('gov', 'setParams', [3, 2, 0, 30 * DAY, 5, 2]);
  await assert.rejects(v.send('g1', 'vouch', [addr('carol')]), /TooManyVouches/); // g1: alice, bob
  await v.send('g1', 'unvouch', [addr('bob')]);
  await v.send('g1', 'vouch', [addr('carol')]);
  // an AI agent is level 0 even with a passkey
  await reg.send('operator', 'register', [addr('dave'), textHash('pq'), textHash('c'), '0x' + '00'.repeat(20)], 10n * ZETA);
  assert.equal(await level('dave'), 0);
  await assert.rejects(v.send('g2', 'vouch', [addr('dave')]), /NotPasskeyHuman/);
});

test('a vouch binds the passkey: moving the label to another passkey voids the vouches', async () => {
  for (const g of ['g1', 'g2', 'g3']) await v.send(g, 'vouch', [addr('alice')]);
  await v.send('alice', 'refresh', [addr('alice')]);
  assert.equal(await level('alice'), 2);
  await prove('alice', passkey('app.sawasdeecoin.com')); // a new passkey: perhaps someone else now
  assert.equal(await level('alice'), 1);
  assert.equal((await v.call('status', [addr('alice')]))[1], 0n);
  await v.send('alice', 'refresh', [addr('alice')]);
  assert.equal((await v.call('people', [addr('alice')])).uniqueSince, 0n);
});

test('accountability: flags suspend, governance clears unfounded flags, a ban strikes the vouchers, two strikes ban a voucher', async () => {
  await v.send('gov', 'setParams', [2, 5, 0, 0, 2, 2]); // 2 vouches, no waits, 2 flags suspend, 2 strikes ban
  for (const who of ['alice', 'bob', 'sybil']) {
    await v.send('g1', 'vouch', [addr(who)]);
    await v.send('g2', 'vouch', [addr(who)]);
    await v.send(who, 'refresh', [addr(who)]);
    assert.equal(await level(who), 2);
  }
  // flags
  await v.send('g3', 'flag', [addr('alice')]);
  assert.equal(await level('alice'), 2);
  await assert.rejects(v.send('g3', 'flag', [addr('alice')]), /AlreadyFlagged/);
  await assert.rejects(v.send('carol', 'flag', [addr('alice')]), /NotUnique/);
  await v.send('bob', 'flag', [addr('alice')]);
  assert.equal(await level('alice'), 1, 'suspended');
  await assert.rejects(v.send('alice', 'vouch', [addr('carol')]), /NotUnique/); // a suspended account cannot vouch
  await v.send('bob', 'unflag', [addr('alice')]);
  assert.equal(await level('alice'), 2);
  await v.send('bob', 'flag', [addr('alice')]);
  await assert.rejects(v.send('bob', 'clearFlags', [addr('alice')]), /NotGovernance/);
  await v.send('gov', 'clearFlags', [addr('alice')]);
  assert.equal(await level('alice'), 2);
  // bans: g1 and g2 vouched for sybil and for bob; governance bans both after evidence
  const ev = await v.send('gov', 'ban', [addr('sybil'), textHash('evidence: same face in two meetups')]);
  assert.equal(ev.filter((e) => e?.name === 'Struck').length, 2);
  assert.equal(await level('sybil'), 1);
  assert.equal(await level('g1'), 2); // one strike
  await v.send('gov', 'ban', [addr('bob'), textHash('evidence 2')]);
  assert.equal(await level('g1'), 1, 'two strikes: the voucher is banned');
  assert.equal(await level('g2'), 1);
  // alice's vouches came from g1 and g2: they no longer count
  assert.equal(await level('alice'), 1);
  await assert.rejects(v.send('g1', 'vouch', [addr('carol')]), /NotUnique/);
  await assert.rejects(v.send('g3', 'vouch', [addr('sybil')]), /IsBanned/);
  await assert.rejects(v.send('alice', 'ban', [addr('g3'), textHash('x')]), /NotGovernance/);
  await v.send('gov', 'unban', [addr('g1')]);
  assert.equal(await level('g1'), 2);
});

test('governance alone sets the bootstrap set and the bounded parameters', async () => {
  await assert.rejects(v.send('alice', 'setGenesis', [[addr('alice')], true]), /NotGovernance/);
  await assert.rejects(v.send('alice', 'setParams', [3, 5, 0, 0, 5, 2]), /NotGovernance/);
  await assert.rejects(v.send('gov', 'setParams', [1, 5, 0, 0, 5, 2]), /BadParams/); // one vouch is not a web
  await assert.rejects(v.send('gov', 'setParams', [3, 17, 0, 0, 5, 2]), /BadParams/);
  await assert.rejects(v.send('gov', 'setParams', [3, 5, 0, 0, 1, 2]), /BadParams/); // one flag cannot suspend
  await v.send('gov', 'setGenesis', [[addr('g3')], false]);
  assert.equal(await level('g3'), 1);
  assert.equal(await level('g1'), 2);
});
