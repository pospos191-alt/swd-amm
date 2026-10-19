import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes, Interface } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';

const ROUTE = encodeBytes32String('airlock/zetaphy');
const Q = 600; // quarantine seconds
const SRC = 97n; // a source chain id
const LOCKBOX = '0x' + 'b0'.repeat(20);
const art = (n) => new Interface(JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8')).abi);
const tokenIface = art('BridgedToken');

let c, jobs, guard, airlock, lane, decoy, token;
const a = (n) => c.acct[n].toString();

async function provenRunners(names) {
  for (const w of names) await jobs.send(w, 'register', [], 100n * ZETA);
  c.advance(1);
  const V = '0x' + '11'.repeat(32);
  for (let i = 0; i < names.length; i += 2) {
    const seats = [names[i], names[(i + 1) % names.length], names[(i + 2) % names.length]];
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [id, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
}

beforeEach(async () => {
  c = await createChain(['gov', 'user', 'r1', 'r2', 'r3', 'r4', 'hyperlane', 'guardian', 'alice', 'attacker']);
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  await provenRunners(['r1', 'r2', 'r3', 'r4']);
  guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await guard.send('gov', 'createToken', ['USD Coin (bridged)', 'USDC', 6]);
  token = await guard.call('token');
  airlock = await c.deploy('BridgeAirlock', [guard.address, ROUTE, a('gov'), 2, Q], 'gov');
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 1_000_000n * 10n ** 6n, true]);
  lane = await c.deploy('NeuroLane', [jobs.address, airlock.address, 2, 1], 'gov');
  decoy = await c.deploy('DecoyBridge', [airlock.address, 'ZETAPHY Bridge v1'], 'gov');
  await airlock.send('gov', 'setLane', [lane.address, true]);
  await airlock.send('gov', 'setLane', [a('hyperlane'), true]);
  await airlock.send('gov', 'setVetoer', [lane.address, true]);
  await airlock.send('gov', 'setVetoer', [a('guardian'), true]);
  await airlock.send('gov', 'setDecoy', [decoy.address, true]);
});

const tx = (nonce, to = 'alice', amount = 500n * 10n ** 6n, sender = 'alice') => [SRC, LOCKBOX, BigInt(nonce), a(sender), a(to), amount];
const neuro = async (t, runners = ['r1', 'r2']) => { for (const r of runners) await lane.send(r, 'attest', t); };
const bal = (who) => c.callAt(token, tokenIface, 'balanceOf', [a(who)]);

test('two independent lanes (Hyperlane + Neuro runners) and the quarantine, then the money enters', async () => {
  const t = tx(0);
  await airlock.send('hyperlane', 'attest', t);
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // one lane is not enough
  await neuro(t);                                                       // 2 runners -> the Neuro lane attests
  await assert.rejects(airlock.send('user', 'release', t), /NotReady/); // quarantine
  c.advance(Q);
  await airlock.send('user', 'release', t);
  assert.equal(await bal('alice'), 500n * 10n ** 6n);
  await assert.rejects(airlock.send('user', 'release', t), /Blocked/);  // once only
});

test('one hacked bridge alone cannot create money, however long it waits', async () => {
  const t = tx(1, 'attacker', 10n ** 12n, 'attacker');
  await airlock.send('hyperlane', 'attest', t);
  await assert.rejects(airlock.send('hyperlane', 'attest', t), /Twice/);
  c.advance(30 * 86400);
  await assert.rejects(airlock.send('attacker', 'release', t), /NotReady/);
  // lanes that saw different details do not add up
  await neuro(tx(1, 'attacker', 10n ** 12n + 1n, 'attacker'));
  await assert.rejects(airlock.send('attacker', 'release', t), /NotReady/);
});

test('Neuro runners or a guardian can veto during the quarantine', async () => {
  const t1 = tx(2), t2 = tx(3);
  for (const t of [t1, t2]) { await airlock.send('hyperlane', 'attest', t); await neuro(t); }
  const id1 = await airlock.call('transferId', t1);
  await lane.send('r3', 'voteVeto', [id1, 'source tx not final']);
  await lane.send('r4', 'voteVeto', [id1, 'source tx not final']);
  await airlock.send('guardian', 'veto', [await airlock.call('transferId', t2), 'manual hold']);
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', t1), /Blocked/);
  await assert.rejects(airlock.send('user', 'release', t2), /Blocked/);
  await assert.rejects(airlock.send('attacker', 'veto', [id1, 'x']), /NotVetoer/);
});

test('decoy bridges mark the attacker; marked transfers never come out; the real bridge keeps working', async () => {
  const decoyIface = art('DecoyBridge');
  await c.sendTo('attacker', decoy.address, decoyIface, 'mint', [a('attacker'), 10n ** 30n]);
  assert.equal(await airlock.call('tripped', [a('attacker')]), true);
  assert.equal(await guard.call('paused'), false); // a decoy never stops the bridges
  const bad = tx(4, 'alice', 1n, 'attacker');       // sent by the marked address
  const good = tx(5);
  for (const t of [bad, good]) { await airlock.send('hyperlane', 'attest', t); await neuro(t); }
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', bad), /Blocked/);
  await airlock.send('user', 'release', good);
  await assert.rejects(airlock.send('attacker', 'trip', [a('alice')]), /NotDecoy/);
  await airlock.send('gov', 'untrip', [a('attacker')]); // governance can lift a mistaken mark
  assert.equal(await airlock.call('tripped', [a('attacker')]), false);
});

test('only lanes attest; only proven runners speak for the Neuro lane; BridgeGuard limits still apply', async () => {
  await assert.rejects(airlock.send('attacker', 'attest', tx(6)), /NotLane/);
  await assert.rejects(lane.send('user', 'attest', tx(6)), /NotRunner/);
  await lane.send('r1', 'attest', tx(6));
  await assert.rejects(lane.send('r1', 'attest', tx(6)), /Twice/);
  await guard.send('gov', 'setRoute', [ROUTE, airlock.address, 100n, true]); // tiny daily limit
  const t = tx(7, 'alice', 101n);
  await airlock.send('hyperlane', 'attest', t); await neuro(t);
  c.advance(Q);
  await assert.rejects(airlock.send('user', 'release', t)); // OverLimit inside BridgeGuard
});

test('a decoy marks only its direct caller, so nobody can get an innocent user marked', async () => {
  // A lure contract that pokes the decoy when someone calls it.
  const decoyIface = art('DecoyBridge');
  await c.sendTo('alice', decoy.address, decoyIface, 'withdraw', [1]);
  assert.equal(await airlock.call('tripped', [a('alice')]), true); // calling it directly does mark you
  await airlock.send('gov', 'untrip', [a('alice')]);
  const lure = await c.deploy('Lure', [decoy.address], 'attacker');
  await c.sendTo('alice', lure.address, art('Lure'), 'claimAirdrop', []);
  assert.equal(await airlock.call('tripped', [a('alice')]), false);
  assert.equal(await airlock.call('tripped', [lure.address]), true);
});
