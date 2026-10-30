// QuantumRescue (contracts/QuantumRescue.sol) and its off-chain side (src/qsafe/rescue.js): a classical
// account pre-commits to an ML-DSA key before Q-day and is rescued to that key after it. Real ML-DSA-44
// keys and signatures (helpers/precompiles.js runs FIPS 204 at 0x…0900); the chain's 0x…0901 is a stand-in.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { qsafeKit } from './helpers/qsafekit.js';
import { commitmentOf, controllerOf, rescueDigest, revealArgs, rescueState, newSecret } from '../src/qsafe/rescue.js';

const CHAIN_ID = 1; // the in-memory EVM runs with mainnet's chain id
const MATURITY = 10;
const key = mldsaKey();
const other = mldsaKey();
const CTRL = controllerOf(key.publicKey);
const Z32 = '0x' + '00'.repeat(32);

let c, sec, r, alice, bob;
beforeEach(async () => {
  c = await createChain(['gov', 'alice', 'bob', 'relay', 'mallory'], { ctrl: CTRL }, { precompiles: PRECOMPILES });
  sec = await c.deployRaw(qsafeKit().MockSecurity, [], 'gov');
  r = await c.deploy('QuantumRescue', [sec.address, c.acct.gov.toString(), MATURITY], 'gov');
  alice = c.acct.alice.toString();
  bob = c.acct.bob.toString();
});

const cm = (account, secret, publicKey = key.publicKey) => commitmentOf({ chainId: CHAIN_ID, contract: r.address, account, publicKey, secret });
async function setQdayIn(blocks) {
  const h = c.blockNumber() + BigInt(blocks);
  await r.send('gov', 'setLocalQday', [h]);
  return h;
}
async function passQday(h) { if (c.blockNumber() < h) c.mine(Number(h - c.blockNumber())); }

test('the JS commitment, controller and reveal digest match the contract', async () => {
  const secret = newSecret();
  assert.equal(await r.call('commitmentOf', [alice, keccak256(key.publicKey), secret]), cm(alice, secret));
  assert.equal(await r.call('pqAddress', [key.publicKey]), CTRL);
  assert.equal(await r.call('rescueDigest', [alice, CTRL]), rescueDigest({ chainId: CHAIN_ID, contract: r.address, account: alice, controller: CTRL }));
});

test('commit before Q-day, reveal after it with the ML-DSA key (relayed by anyone)', async () => {
  const secret = newSecret();
  await r.send('alice', 'commit', [cm(alice, secret)]);
  assert.equal(await r.call('effectiveCommitment', [alice]), Z32, 'not yet mature');
  c.mine(MATURITY);
  assert.equal(await r.call('effectiveCommitment', [alice]), cm(alice, secret));

  const { args, controller } = revealArgs({ chainId: CHAIN_ID, contract: r.address, account: alice, key, secret });
  await assert.rejects(r.send('relay', 'reveal', args), /QdayNotYet/);
  const h = await setQdayIn(150);
  assert.equal(await r.call('qdayHeight'), h);
  await passQday(h);
  assert.equal(await r.call('qdayReached'), true);

  await assert.rejects(r.send('relay', 'reveal', [alice, key.publicKey, newSecret(), args[3]]), /WrongReveal/);
  await assert.rejects(r.send('relay', 'reveal', [alice, other.publicKey, secret, other.sign(Z32)]), /WrongReveal/);
  await assert.rejects(r.send('relay', 'reveal', [alice, key.publicKey, secret, other.sign(rescueDigest({ chainId: CHAIN_ID, contract: r.address, account: alice, controller }))]), /BadSignature/);
  await assert.rejects(r.send('relay', 'reveal', [alice, key.publicKey.slice(0, -2), secret, args[3]]), /BadKey/);

  const ev = await r.send('relay', 'reveal', args);
  assert.ok(ev.some((e) => e?.name === 'Rescued' && e.args.controller === CTRL));
  assert.equal(await r.call('controllerOf', [alice]), CTRL);
  assert.equal(await r.call('rescueKeyHash', [alice]), keccak256(key.publicKey));
  await assert.rejects(r.send('relay', 'reveal', args), /AlreadyRescued/);
});

test('the ML-DSA account itself may reveal without a signature', async () => {
  const secret = newSecret();
  await r.send('alice', 'commit', [cm(alice, secret)]);
  c.mine(MATURITY);
  await passQday(await setQdayIn(120));
  await assert.rejects(r.send('mallory', 'reveal', [alice, key.publicKey, secret, '0x']), /BadSignature/);
  await r.send('ctrl', 'reveal', [alice, key.publicKey, secret, '0x']);
  assert.equal(await r.call('controllerOf', [alice]), CTRL);
});

test('after Q-day nobody can commit, and a commitment that matures after Q-day does not count', async () => {
  const h = await setQdayIn(110);
  c.mine(Number(h - c.blockNumber()) - 4); // 4 blocks before Q-day: too late to mature
  const secret = newSecret();
  await r.send('bob', 'commit', [cm(bob, secret)]);
  await passQday(h);
  await assert.rejects(r.send('bob', 'commit', [cm(bob, secret)]), /QdayPassed/);
  c.mine(MATURITY * 2);
  assert.equal(await r.call('effectiveCommitment', [bob]), Z32);
  const { args } = revealArgs({ chainId: CHAIN_ID, contract: r.address, account: bob, key, secret });
  await assert.rejects(r.send('relay', 'reveal', args), /NoCommitment/);
});

test('someone who breaks the key just before Q-day cannot displace an older commitment', async () => {
  const secret = newSecret();
  await r.send('alice', 'commit', [cm(alice, secret)]);
  c.mine(MATURITY);
  const h = await setQdayIn(120);
  c.mine(Number(h - c.blockNumber()) - 4);
  // the attacker (holding alice's derived ECDSA key) replaces the commitment with their own ML-DSA key
  const evil = cm(alice, newSecret(), other.publicKey);
  await r.send('alice', 'commit', [evil]);
  await passQday(h);
  c.mine(MATURITY * 2);
  assert.equal(await r.call('effectiveCommitment', [alice]), cm(alice, secret), 'the older, matured commitment stays in force');
  const { args } = revealArgs({ chainId: CHAIN_ID, contract: r.address, account: alice, key, secret });
  await r.send('relay', 'reveal', args);
  assert.equal(await r.call('controllerOf', [alice]), CTRL);
});

test('a replaced (or cancelled) commitment takes over only once it is mature', async () => {
  const s1 = newSecret(), s2 = newSecret();
  await r.send('alice', 'commit', [cm(alice, s1)]);
  c.mine(MATURITY);
  await r.send('alice', 'commit', [cm(alice, s2)]);
  assert.equal(await r.call('effectiveCommitment', [alice]), cm(alice, s1));
  c.mine(MATURITY);
  assert.equal(await r.call('effectiveCommitment', [alice]), cm(alice, s2));
  await r.send('alice', 'commit', [Z32]);
  c.mine(MATURITY);
  assert.equal(await r.call('effectiveCommitment', [alice]), Z32, 'cancelled');
});

test('the chain Q-day (0x…0901) applies when earlier; classicalTrusted follows the chain migration', async () => {
  const local = await setQdayIn(500);
  const chainH = c.blockNumber() + 20n;
  await sec.send('gov', 'setQday', [chainH]);
  assert.equal(await r.call('qdayHeight'), chainH);
  assert.equal(await r.call('classicalTrusted', [alice]), true);
  await passQday(chainH);
  assert.equal(await r.call('classicalTrusted', [alice]), false);
  await sec.send('gov', 'setMigrated', [alice, true]);
  assert.equal(await r.call('classicalTrusted', [alice]), true, 'quantum-locked on the chain');
  assert.ok(local > chainH);
});

test('on a chain without the precompile only the local Q-day counts', async () => {
  const r2 = await c.deploy('QuantumRescue', ['0x000000000000000000000000000000000000dEaD', c.acct.gov.toString(), MATURITY], 'gov');
  assert.equal(await r2.call('qdayHeight'), 0n);
  const h = c.blockNumber() + 200n;
  await r2.send('gov', 'setLocalQday', [h]);
  assert.equal(await r2.call('qdayHeight'), h);
});

test('governance: only it sets the local Q-day, with notice', async () => {
  await assert.rejects(r.send('mallory', 'setLocalQday', [c.blockNumber() + 500n]), /OnlyGovernance/);
  await assert.rejects(r.send('gov', 'setLocalQday', [c.blockNumber() + 10n]), /TooSoon/);
  await assert.rejects(r.send('mallory', 'setGovernance', [bob]), /OnlyGovernance/);
  await r.send('gov', 'setGovernance', [bob]);
  assert.equal((await r.call('governance')).toLowerCase(), bob.toLowerCase());
});

test('escrow: payouts to a frozen address go to its rescued ML-DSA controller', async () => {
  const secret = newSecret();
  await r.send('alice', 'commit', [cm(alice, secret)]);
  c.mine(MATURITY);
  await r.send('bob', 'depositFor', [alice], 3n * ZETA);
  // before Q-day the account itself may still take it
  await r.send('alice', 'claim', [alice, '0x' + '00'.repeat(20), ZETA, alice]);
  await passQday(await setQdayIn(120));
  await assert.rejects(r.send('alice', 'claim', [alice, '0x' + '00'.repeat(20), ZETA, alice]), /NotAllowed/);
  await assert.rejects(r.send('ctrl', 'claim', [alice, '0x' + '00'.repeat(20), ZETA, CTRL]), /NotAllowed/, 'not rescued yet');
  await r.send('relay', 'reveal', revealArgs({ chainId: CHAIN_ID, contract: r.address, account: alice, key, secret }).args);
  const before = await c.balance('bob');
  await assert.rejects(r.send('ctrl', 'claim', [alice, '0x' + '00'.repeat(20), 3n * ZETA, bob]), /Insufficient/);
  await r.send('ctrl', 'claim', [alice, '0x' + '00'.repeat(20), 2n * ZETA, bob]);
  assert.equal(await c.balance('bob') - before, 2n * ZETA);
  assert.equal(await r.call('escrow', [alice, '0x' + '00'.repeat(20)]), 0n);
});

test('rescueState tells a wallet where an account stands', () => {
  const base = { slot: [Z32, Z32, 0n], effective: Z32, controller: '0x' + '00'.repeat(20), qday: 0n, block: 100n, maturity: 10n };
  assert.equal(rescueState(base).state, 'none');
  const C = '0x' + '11'.repeat(32);
  assert.equal(rescueState({ ...base, slot: [Z32, C, 95n] }).state, 'maturing');
  assert.equal(rescueState({ ...base, slot: [Z32, C, 95n], qday: 100n }).state, 'too-late');
  assert.equal(rescueState({ ...base, effective: C, slot: [C, Z32, 0n] }).state, 'committed');
  assert.equal(rescueState({ ...base, effective: C, slot: [C, Z32, 0n], qday: 90n }).state, 'revealable');
  assert.equal(rescueState({ ...base, qday: 90n }).state, 'frozen');
  assert.equal(rescueState({ ...base, controller: CTRL }).state, 'rescued');
});
