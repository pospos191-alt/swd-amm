// Saphan PR 6, item S2: a property test of the whole route in the normal suite (the Foundry invariants and Halmos
// proofs of the same properties are in audit/invariants/saphan/). Random sequences (seeded, so a failure replays) of
// locks, attestations (an honest lane and a lying one), releases, burns through the outbox, deliveries, replays,
// claims, vetoes, pauses and time, on the real contracts. After EVERY step:
//   P1  the lockbox never releases more than was locked: balance == locked == locks - claims >= 0
//   P2  supply on ZETAPHY <= locked - in flight out: exactly locked - supply - (burned - claimed) == locks never minted
//   P3  each message body is released once: a second claim or a second delivery of the same body is refused
//   P4  daily limits: per UTC day, claimed <= the lockbox's limit and minted <= the guard's route limit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Address } from '@ethereumjs/util';
import { routeWorld, relayIn, relayOut, lastReleaseId, CHAIN, Q, E } from './helpers/saphanroutekit.js';

const TOKEN = new Interface(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const USERS = ['u1', 'u2', 'u3'];
const LOCKBOX_LIMIT = 5n * E;
const GUARD_LIMIT = 6n * E;

/** xorshift32: the same seed, the same sequence. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return { int: (n) => next() % n, pick: (l) => l[next() % l.length], amount: () => BigInt(1 + (next() % 30)) * E / 10n };
}

async function run(seed, steps) {
  const r = await routeWorld(USERS, { lockboxLimit: LOCKBOX_LIMIT, guardLimit: GUARD_LIMIT });
  const { c, a } = r;
  const R = rng(seed);
  const g = { locked: 0n, minted: 0n, burned: 0n, claimed: 0n, unminted: 0n, dayClaimed: {}, dayMinted: {}, log: [], err: {} };
  const pending = [];          // attested-or-not locks on ZETAPHY: { t, amount, minted }
  const releases = [];         // { id, message, amount, claimed }
  const day = () => String(c.now() / 86400n);
  const supply = () => c.callAt(r.token, TOKEN, 'totalSupply', []);
  const bal = (u) => c.callAt(r.token, TOKEN, 'balanceOf', [a(u)]);
  const tryTx = async (p) => { try { await p; return true; } catch (e) { g.err[e.message] = (g.err[e.message] ?? 0) + 1; return false; } };

  const actions = {
    async lock() {
      const u = R.pick(USERS), amount = R.amount();
      const fee = await r.lockbox.call('quoteLock', [a(u), amount]);
      if (!await tryTx(r.lockbox.send(u, 'lock', [a(u), amount], amount + fee))) return;
      const n = (await r.lockbox.call('nonce')) - 1n;
      g.locked += amount; g.unminted += amount;
      await relayIn(r);
      pending.push({ t: [CHAIN, r.lockbox.address, n, a(u), a(u), amount], amount, minted: false });
    },
    async attest() {
      const open = pending.filter((x) => !x.minted);
      const p = open.length && R.pick(open);
      if (p) await tryTx(r.airlock.send('lane2', 'attest', p.t));
    },
    async lie() {                                     // the second lane attests a transfer that never happened
      const p = pending.length && R.pick(pending);
      if (!p) return;
      const forged = [...p.t]; forged[5] = p.amount * 10n;
      await tryTx(r.airlock.send('lane2', 'attest', forged));
      await tryTx(r.airlock.send('relayer', 'release', forged));
    },
    async release() {
      const p = pending.length && (R.int(4) ? pending.find((x) => !x.minted) : R.pick(pending)); // mostly the oldest open one, sometimes any (a re-release)
      if (!p) return;
      const before = await supply();
      if (await tryTx(r.airlock.send('relayer', 'release', p.t))) {
        const m = (await supply()) - before;
        assert.ok(!p.minted, 'P3: a transfer minted twice');
        assert.equal(m, p.amount);
        p.minted = true; g.minted += m; g.unminted -= m;
        g.dayMinted[day()] = (g.dayMinted[day()] ?? 0n) + m;
      }
    },
    async burn() {
      const u = R.pick(USERS);
      const b = await bal(u);
      if (b === 0n) return;
      const amount = b / BigInt(1 + R.int(3));
      const fee = await r.outbox.call('quoteSend', [a(u), amount]);
      if (!await tryTx(r.outbox.send(u, 'send', [a(u), amount], fee))) return;
      g.burned += amount;
      const message = await r.zMailbox.call('lastMessage');
      await relayOut(r);
      releases.push({ id: await lastReleaseId(r), message, amount, claimed: false });
      // P3: the same body delivered again is refused (Mailbox and lockbox both)
      assert.equal(await tryTx(relayOut(r)), false, 'P3: a release delivered twice');
    },
    async flow() {                                    // the common path: attest the oldest open lock, wait out the quarantine, release
      const p = pending.find((x) => !x.minted);
      if (!p) return;
      await tryTx(r.airlock.send('lane2', 'attest', p.t));
      c.advance(Q);
      await actions.release();
    },
    async claim() {
      const x = releases.length && (R.int(4) ? releases.find((y) => !y.claimed) : R.pick(releases));
      if (!x) return;
      const to = Address.fromString(await r.lockbox.call('releases', [x.id]).then((v) => v[0]));
      const before = await c.balance(to);
      if (await tryTx(r.lockbox.send('relayer', 'claim', [x.id]))) {
        assert.ok(!x.claimed, 'P3: a release paid twice');
        assert.equal((await c.balance(to)) - before, x.amount);
        x.claimed = true; g.claimed += x.amount;
        g.dayClaimed[day()] = (g.dayClaimed[day()] ?? 0n) + x.amount;
      } else if (x.claimed) assert.ok(true);
    },
    async veto() { const x = releases.length && R.pick(releases); if (x) await tryTx(r.lockbox.send('guardian', 'veto', [x.id])); },
    async liftVeto() { const x = releases.length && R.pick(releases); if (x) await tryTx(r.lockbox.send('gov', 'liftVeto', [x.id])); },
    async pause() { await tryTx(R.int(2) ? r.lockbox.send('guardian', 'pause', []) : r.guard.send('gov', 'pause', [])); },
    async unpause() { await tryTx(r.lockbox.send('gov', 'unpause', [])); await tryTx(r.guard.send('gov', 'unpause', [])); },
    async time() { c.advance(R.pick([60, Q, 3600, 6 * 3600, 86400])); },
  };
  const names = Object.keys(actions);
  const weights = { flow: 3, lock: 4, attest: 3, release: 3, burn: 3, claim: 4, time: 4, lie: 1, veto: 1, liftVeto: 1, pause: 1, unpause: 2 };
  const bag = names.flatMap((n) => Array(weights[n]).fill(n));

  for (let i = 0; i < steps; i++) {
    const act = R.pick(bag);
    g.log.push(act);
    await actions[act]();
    const where = `seed ${seed}, step ${i} (${act}); sequence: ${g.log.join(' ')}`;
    const locked = await r.lockbox.call('locked');
    const s = await supply();
    // P1
    assert.equal(await c.balance(Address.fromString(r.lockbox.address)), locked, `P1 balance != locked: ${where}`);
    assert.equal(locked, g.locked - g.claimed, `P1 locked != locks - claims: ${where}`);
    assert.ok(g.claimed <= g.locked, `P1 released more than locked: ${where}`);
    // P2
    assert.equal(s, g.minted - g.burned, `P2 supply != mints - burns: ${where}`);
    assert.ok(s + (g.burned - g.claimed) <= locked, `P2 supply + in flight > locked: ${where}`);
    assert.equal(locked - s - (g.burned - g.claimed), g.unminted, `P2 the gap is not exactly the unminted locks: ${where}`);
    // P4
    for (const [d, v] of Object.entries(g.dayClaimed)) assert.ok(v <= LOCKBOX_LIMIT, `P4 lockbox day ${d}: ${v}: ${where}`);
    for (const [d, v] of Object.entries(g.dayMinted)) assert.ok(v <= GUARD_LIMIT, `P4 guard day ${d}: ${v}: ${where}`);
  }
  return { g, minted: pending.filter((p) => p.minted).length, claims: releases.filter((x) => x.claimed).length };
}

test('route properties P1-P4 hold over random sequences (3 seeds x 80 steps, on the real contracts)', async () => {
  let minted = 0, claims = 0;
  for (const seed of [1, 7, 2026]) {
    const out = await run(seed, 80);
    minted += out.minted; claims += out.claims;
  }
  // the sequences must actually reach the interesting states
  console.log(`saphan route properties: ${minted} mints, ${claims} claims over 240 steps`);
  assert.ok(minted >= 10, `only ${minted} mints`);
  assert.ok(claims >= 3, `only ${claims} claims`);
});
