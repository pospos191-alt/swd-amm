import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';

const BOND = 100n * ZETA, REWARD = 1n * ZETA, MIN_FEE = ZETA / 10n;
const WINDOW = 120, TIMEOUT = 600, UNBOND = 3600, CAP = 1000n * ZETA;
const CHAIN = encodeBytes32String('bsc');
const TARGET = '0xc1ed4b78071e7c9a84958d8be0215a10984fc28f';
const V1 = '0x' + '11'.repeat(32), V2 = '0x' + '22'.repeat(32);

// Runners get 90% of the fee (5% burned, 5% community fund).
const RUN = (fee) => fee - 2n * ((fee * 500n) / 10_000n);
// A failed or expired job refunds the fee minus 5% (burned).
const REFUND = (fee) => fee - (fee * 500n) / 10_000n;
const commitment = (verdict, worker, salt) => keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [verdict, worker, salt]));

let c, jobs, salts;
beforeEach(async () => {
  c = await createChain(['owner', 'user', 'w1', 'w2', 'w3', 'w4']);
  jobs = await c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'owner');
  await jobs.send('owner', 'fund', [], 1000n * ZETA);
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], BOND);
  c.advance(1); // runners must be registered before a job is requested
  salts = {};
});

const addr = (w) => c.acct[w].toString();
async function commitAs(w, id, verdict) {
  salts[w] = hexlify(randomBytes(32));
  await jobs.send(w, 'commit', [id, commitment(verdict, addr(w), salts[w])]);
}
const revealAs = (w, id, verdict) => jobs.send(w, 'reveal', [id, verdict, salts[w]]);
const newJob = async (fee = MIN_FEE) => { await jobs.send('user', 'request', [CHAIN, TARGET], fee); return (await jobs.call('jobCount')) - 1n; };

test('constructor refuses unsafe timing', async () => {
  await assert.rejects(c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, TIMEOUT - 1, CAP], 'owner'));
  await assert.rejects(c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, TIMEOUT, TIMEOUT, UNBOND, CAP], 'owner'));
});

test('two of three agree: job done, both paid fee share + reward, dissenter penalized', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  await commitAs('w3', id, V1);
  await assert.rejects(commitAs('w4', id, V1), /NoSeat/);
  await revealAs('w1', id, V1);
  await revealAs('w2', id, V2);
  const ev = await revealAs('w3', id, V1);
  assert.ok(ev.some((e) => e.name === 'Finalized' && e.args.verdict === V1));
  const j = await jobs.call('getJob', [id]);
  assert.equal(j.status, 2n);
  assert.equal(j.result, V1);
  // reward per winner: min(jobReward, fee / 4)
  assert.equal(await jobs.call('credit', [addr('w1')]), RUN(ZETA) / 2n + ZETA / 4n);
  assert.equal(await jobs.call('credit', [addr('w3')]), RUN(ZETA) / 2n + ZETA / 4n);
  assert.equal(await jobs.call('credit', [addr('w2')]), 0n);
  const w2 = await jobs.call('workers', [addr('w2')]);
  assert.equal(w2.bond, BOND - BOND / 10n);
  assert.equal(w2.active, false); // below the bond now
  assert.equal(await jobs.call('activeWorkers'), 3n);
});

test('cannot reveal before all seats are taken or the window closes (no copying)', async () => {
  const id = await newJob();
  await commitAs('w1', id, V1);
  await assert.rejects(revealAs('w1', id, V1), /TooEarly/);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
});

test('a reveal that does not match the commitment is refused', async () => {
  const id = await newJob();
  for (const w of ['w1', 'w2', 'w3']) await commitAs(w, id, V1);
  await assert.rejects(jobs.send('w1', 'reveal', [id, V2, salts.w1]), /BadReveal/);
  await assert.rejects(jobs.send('w4', 'reveal', [id, V1, salts.w1]), /NoSeat/);
});

test('copying a revealed verdict does not work: commitments bind the runner', async () => {
  const id = await newJob();
  await commitAs('w1', id, V1);
  // w2 reuses w1's exact commitment: it cannot open it under its own address.
  await jobs.send('w2', 'commit', [id, commitment(V1, addr('w1'), salts.w1)]);
  await commitAs('w3', id, V2);
  await revealAs('w1', id, V1);
  await assert.rejects(jobs.send('w2', 'reveal', [id, V1, salts.w1]), /BadReveal/);
});

test('no quorum: job fails and the fee minus the 5% slice goes back to the requester', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
  const ev = await revealAs('w2', id, V2);
  assert.ok(ev.some((e) => e.name === 'JobFailed'));
  assert.equal(await jobs.call('credit', [addr('user')]), REFUND(ZETA));
  assert.equal(await jobs.call('totalBurned'), ZETA - REFUND(ZETA));
});

test('timeout: anyone can expire; a runner that never revealed is penalized', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V1);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
  await assert.rejects(jobs.send('w4', 'expire', [id]), /TooEarly/);
  c.advance(TIMEOUT);
  const ev = await jobs.send('w4', 'expire', [id]);
  assert.ok(ev.some((e) => e.name === 'Penalized' && e.args.worker.toLowerCase() === addr('w2').toLowerCase()));
  assert.ok(ev.some((e) => e.name === 'Missed' && e.args.worker.toLowerCase() === addr('w2').toLowerCase()));
  assert.equal(await jobs.call('strikes', [addr('w2')]), 1n);
  assert.equal(await jobs.call('credit', [addr('user')]), REFUND(ZETA));
  await assert.rejects(revealAs('w2', id, V1), /Closed/);
});

test('fee below the minimum, empty or oversized target are refused', async () => {
  await assert.rejects(jobs.send('user', 'request', [CHAIN, TARGET], MIN_FEE - 1n), /BadValue/);
  await assert.rejects(jobs.send('user', 'request', [CHAIN, ''], MIN_FEE), /BadValue/);
  await assert.rejects(jobs.send('user', 'request', [CHAIN, 'x'.repeat(331)], MIN_FEE), /BadValue/);
});

test('a Move coin type fits as a target', async () => {
  const sui = `0x${'ab'.repeat(32)}::usdc::USDC`;
  const before = await jobs.call('jobCount', []);
  await jobs.send('user', 'request', [CHAIN, sui], MIN_FEE);
  assert.equal(await jobs.call('jobCount', []), before + 1n);
});

test('only bonded runners take seats; leaving waits for the unbond delay', async () => {
  const id = await newJob();
  await assert.rejects(jobs.send('user', 'commit', [id, V1]), /NotWorker/);
  await assert.rejects(jobs.send('owner', 'register', [], BOND - 1n), /BadValue/);
  await jobs.send('w4', 'requestUnbond');
  await assert.rejects(commitAs('w4', id, V1), /NotWorker/);
  await assert.rejects(jobs.send('w4', 'withdrawBond'), /TooEarly/);
  c.advance(UNBOND);
  await jobs.send('w4', 'withdrawBond');
  assert.equal(await jobs.call('credit', [addr('w4')]), BOND);
});

test('withdraw pays out credit exactly once', async () => {
  const id = await newJob(ZETA);
  for (const w of ['w1', 'w2', 'w3']) await commitAs(w, id, V1);
  await revealAs('w1', id, V1);
  await revealAs('w2', id, V1);
  const before = await c.balance('w1');
  await jobs.send('w1', 'withdraw');
  assert.equal(await c.balance('w1') - before, RUN(ZETA) / 2n + ZETA / 4n);
  await assert.rejects(jobs.send('w1', 'withdraw'), /Nothing/);
  // The third seat may still reveal during the grace (no fee share, no penalty)...
  await revealAs('w3', id, V1);
  assert.equal(await jobs.call('credit', [addr('w3')]), 0n);
  assert.equal((await jobs.call('workers', [addr('w3')])).bond, BOND);
  // ...but only once.
  await assert.rejects(revealAs('w3', id, V1), /Closed/);
});

test('rewards stop when the pool is empty; fees still pay', async () => {
  const c2 = await createChain(['owner', 'user', 'w1', 'w2']);
  const j2 = await c2.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'owner');
  for (const w of ['w1', 'w2']) await j2.send(w, 'register', [], BOND);
  c2.advance(1);
  await j2.send('user', 'request', [CHAIN, TARGET], ZETA);
  const s = {};
  for (const w of ['w1', 'w2']) {
    s[w] = hexlify(randomBytes(32));
    await j2.send(w, 'commit', [0, commitment(V1, c2.acct[w].toString(), s[w])]);
  }
  c2.advance(WINDOW);
  for (const w of ['w1', 'w2']) await j2.send(w, 'reveal', [0, V1, s[w]]);
  assert.equal(await j2.call('credit', [c2.acct.w1.toString()]), RUN(ZETA) / 2n);
});

test('requestFor sends a refund to the named user, not the payer', async () => {
  await jobs.send('owner', 'requestFor', [addr('user'), CHAIN, TARGET], ZETA);
  const id = (await jobs.call('jobCount')) - 1n;
  c.advance(TIMEOUT);
  await jobs.send('w4', 'expire', [id]);
  assert.equal(await jobs.call('credit', [addr('user')]), REFUND(ZETA));
  assert.equal(await jobs.call('credit', [addr('owner')]), 0n);
  await assert.rejects(jobs.send('owner', 'requestFor', ['0x' + '00'.repeat(20), CHAIN, TARGET], ZETA), /BadValue/);
});

test('seats go by a bond-weighted lottery, not first come; it widens as the window passes', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `r${i}`);
  const c3 = await createChain(['owner', 'user', ...names]);
  const j3 = await c3.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, 120, TIMEOUT, UNBOND, CAP], 'owner');
  for (const n of names) await j3.send(n, 'register', [], BOND);
  c3.advance(1);
  await j3.send('user', 'request', [CHAIN, TARGET], MIN_FEE);
  const lazy = (await j3.call('jobInfo', [0])).rand; // computed before anyone stores it
  assert.notEqual(lazy, '0x' + '00'.repeat(32));
  const drawn = (await j3.send('user', 'draw', [0])).find((e) => e?.name === 'Drawn');
  assert.equal(drawn.args.rand, lazy); // storing it changes nothing
  await assert.rejects(j3.send('user', 'draw', [0]), /Nothing/); // once
  const eligibleNow = async () => (await Promise.all(names.map((n) => j3.call('eligible', [0, c3.acct[n].toString()])))).filter(Boolean).length;
  const first = await eligibleNow();
  assert.ok(first >= 1 && first <= 15, `about 6 of 30 should qualify at first, got ${first}`);
  for (const n of names) {
    if (!(await j3.call('eligible', [0, c3.acct[n].toString()]))) {
      await assert.rejects(j3.send(n, 'commit', [0, V1]), /NotChosen/);
      break;
    }
  }
  c3.advance(40); // a third of the window: twice as many qualify
  assert.ok(await eligibleNow() > first);
  c3.advance(40); // the last third: every runner, so seats fill whatever the draw
  assert.equal(await eligibleNow(), names.length);
});

test('a runner that registers after the job was requested cannot take a seat on it', async () => {
  const id = await newJob();
  const c4acct = 'owner';
  await jobs.send(c4acct, 'register', [], BOND); // joins now, after the request
  assert.equal(await jobs.call('eligible', [id, addr(c4acct)]), false);
  await assert.rejects(jobs.send(c4acct, 'commit', [id, V1]), /NotChosen/);
  c.advance(1);
  const later = await newJob();
  await jobs.send('user', 'draw', [later]);
  assert.equal(await jobs.call('eligible', [later, addr(c4acct)]), true); // fine for later jobs
});

test('pool rewards: at most a quarter of the fee per winner, and a daily cap', async () => {
  const c5 = await createChain(['owner', 'user', 'w1', 'w2', 'w3']);
  const j5 = await c5.deploy('NeuroJobs', [BOND, 10n * ZETA, MIN_FEE, WINDOW, TIMEOUT, UNBOND, ZETA], 'owner'); // cap: 1 ZETAPHY a day
  await j5.send('owner', 'fund', [], 100n * ZETA);
  for (const w of ['w1', 'w2', 'w3']) await j5.send(w, 'register', [], BOND);
  c5.advance(1);
  const s = {};
  const run = async () => {
    await j5.send('user', 'request', [CHAIN, TARGET], ZETA);
    const id = (await j5.call('jobCount')) - 1n;
    for (const w of ['w1', 'w2']) {
      s[w] = hexlify(randomBytes(32));
      await j5.send(w, 'commit', [id, commitment(V1, c5.acct[w].toString(), s[w])]);
    }
    c5.advance(WINDOW);
    for (const w of ['w1', 'w2']) await j5.send(w, 'reveal', [id, V1, s[w]]);
  };
  await run(); // 2 winners x min(10, 1/4) = 0.5 ZETAPHY of the 1/day cap
  assert.equal(await j5.call('credit', [c5.acct.w1.toString()]), RUN(ZETA) / 2n + ZETA / 4n);
  await run(); // reaches the cap exactly
  await run(); // over the cap: fee only
  assert.equal(await j5.call('credit', [c5.acct.w1.toString()]), 3n * (RUN(ZETA) / 2n) + 2n * (ZETA / 4n));
  c5.advance(86400);
  await run(); // a new day
  assert.equal(await j5.call('credit', [c5.acct.w1.toString()]), 4n * (RUN(ZETA) / 2n) + 3n * (ZETA / 4n));
});

test('totalActiveBond follows joins, penalties and leaving', async () => {
  assert.equal(await jobs.call('totalActiveBond'), 4n * BOND);
  await jobs.send('w4', 'requestUnbond');
  assert.equal(await jobs.call('totalActiveBond'), 3n * BOND);
  const id = await newJob();
  await commitAs('w1', id, V1); await commitAs('w2', id, V1); await commitAs('w3', id, V2);
  await revealAs('w3', id, V2); await revealAs('w1', id, V1); await revealAs('w2', id, V1);
  assert.equal(await jobs.call('totalActiveBond'), 2n * BOND); // w3 penalized below the bond: out
});

// ---- NeuroControl: fee split, elastic bodies, immune system, stop button, skills ----

const SKILL = '0x' + 'ab'.repeat(32), SKILL2 = '0x' + 'cd'.repeat(32);
const DEAD = Address.fromString('0x000000000000000000000000000000000000dEaD');

/** NeuroJobs wired to a NeuroControl (governance 'gov', community fund 'fund'). */
async function governed(names, { maxBodies = 8, regrow = 4, bond = {} } = {}) {
  const k = await createChain(['gov', 'fund', 'guardian', 'user', ...names]);
  const ctl = await k.deploy('NeuroControl', [k.acct.gov.toString(), k.acct.fund.toString(), maxBodies, regrow], 'gov');
  const nj = await k.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'gov');
  await nj.send('gov', 'setControl', [ctl.address]);
  await ctl.send('gov', 'approveSkill', [SKILL]);
  await ctl.send('gov', 'setActiveSkill', [SKILL]);
  await ctl.send('gov', 'approveChains', [[CHAIN]]);
  await nj.send('gov', 'fund', [], 1000n * ZETA);
  for (const n of names) await nj.send(n, 'register', [], bond[n] ?? BOND);
  k.advance(1);
  const ad = (n) => k.acct[n].toString();
  const s = {};
  const req = async (fee = MIN_FEE) => { await nj.send('user', 'request', [CHAIN, TARGET], fee); return (await nj.call('jobCount')) - 1n; };
  const cm = async (w, id, v) => { s[w] = hexlify(randomBytes(32)); await nj.send(w, 'commit', [id, commitment(v, ad(w), s[w])]); };
  const rv = (w, id, v) => nj.send(w, 'reveal', [id, v, s[w]]);
  /** a job where `seats` commit and reveal the given verdicts (all reveals sent);
   *  allDefenders: only defenders sit, so the 2nd and 3rd wait out the first third of the window */
  const run = async (votes, fee = MIN_FEE, { allDefenders = false } = {}) => {
    const id = await req(fee);
    for (const [i, [w, v]] of votes.entries()) {
      if (allDefenders && i === 1) k.advance(WINDOW / 3);
      await cm(w, id, v);
    }
    k.advance(WINDOW);
    for (const [w, v] of votes) await rv(w, id, v).catch(() => {});
    return id;
  };
  return { k, ctl, nj, ad, req, cm, rv, run };
}

test('setControl: only the deployer, once; a request slipped in first cannot block it', async () => {
  const ctl = await c.deploy('NeuroControl', [addr('owner'), addr('owner'), 8, 2], 'owner');
  await assert.rejects(jobs.send('user', 'setControl', [ctl.address]), /NotDeployer/);
  const fresh = await c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'owner');
  await fresh.send('owner', 'setControl', [ctl.address]);
  await assert.rejects(fresh.send('owner', 'setControl', [ctl.address]), /BadValue/);
  // Front-run: someone requests a job before the deployer wires in NeuroControl.
  const early = await newJob(ZETA);
  await jobs.send('owner', 'setControl', [ctl.address]);
  assert.equal((await jobs.call('control')).toLowerCase(), ctl.address.toString().toLowerCase());
  await assert.rejects(jobs.send('owner', 'setControl', [ctl.address]), /BadValue/);
  // That job carries skill 0: runners that follow governance skip it, so it
  // expires and refunds the requester (minus the 5% slice).
  assert.equal((await jobs.call('jobInfo', [early])).skill, '0x' + '00'.repeat(32));
  c.advance(TIMEOUT);
  await jobs.send('w1', 'expire', [early]);
  assert.equal(await jobs.call('credit', [addr('user')]), REFUND(ZETA));
});

test('fee split: 90% runners, 5% burned, 5% community fund, to the wei', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  const fee = ZETA + 7n; // odd on purpose: the 3-way split leaves dust
  const deadBefore = await g.k.balance(DEAD);
  const id = await g.req(fee);
  for (const w of ['w1', 'w2', 'w3']) await g.cm(w, id, V1);
  await g.rv('w1', id, V1);
  const ev = await g.rv('w2', id, V1);
  const burn = (fee * 500n) / 10_000n, fundCut = (fee * 500n) / 10_000n, runners = fee - burn - fundCut;
  const share = runners / 2n, dust = runners - share * 2n;
  assert.ok(ev.some((e) => e?.name === 'Finalized')); // the quorum formed at w2's reveal
  await g.rv('w3', id, V1); // late, in the grace: judged, but the fee is already shared
  assert.equal(await g.nj.call('credit', [g.ad('w3')]), 0n);
  const reward = fee / 4n < REWARD ? fee / 4n : REWARD; // pool reward on top, capped at fee/4
  assert.equal(await g.nj.call('credit', [g.ad('w1')]), share + reward);
  assert.equal(await g.nj.call('credit', [g.ad('w2')]), share + reward);
  assert.equal(await g.nj.call('credit', [g.ad('fund')]), fundCut + dust);
  assert.equal(await g.k.balance(DEAD) - deadBefore, burn);
  assert.equal(await g.nj.call('totalBurned'), burn);
  assert.equal(share * 2n + burn + fundCut + dust, fee);
  // The community fund withdraws like a runner.
  await g.nj.send('fund', 'withdraw');
  assert.equal(await g.nj.call('credit', [g.ad('fund')]), 0n);
});

test('fee split with three winners: the dust goes to the community fund', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  const fee = ZETA + 1n;
  const id = await g.run([['w1', V1], ['w2', V1]]); // quorum at w2's reveal; w3 never committed
  assert.equal((await g.nj.call('getJob', [id])).status, 2n);
  const id2 = await g.req(fee);
  for (const w of ['w1', 'w2', 'w3']) await g.cm(w, id2, V1);
  g.k.advance(WINDOW);
  const fundBefore = await g.nj.call('credit', [g.ad('fund')]);
  const before = await Promise.all(['w1', 'w2'].map((w) => g.nj.call('credit', [g.ad(w)])));
  await g.rv('w1', id2, V1);
  const ev = await g.rv('w2', id2, V1);
  const fs = ev.find((e) => e?.name === 'FeeSplit');
  const burn = (fee * 500n) / 10_000n;
  assert.equal(fs.args.burned, burn);
  assert.equal(fs.args.runners + fs.args.burned + fs.args.community, fee);
  assert.equal(await g.nj.call('credit', [g.ad('fund')]) - fundBefore, fs.args.community);
  const after = await Promise.all(['w1', 'w2'].map((w) => g.nj.call('credit', [g.ad(w)])));
  const reward = (fee / 4n < REWARD ? fee / 4n : REWARD);
  assert.equal(after[0] - before[0] + after[1] - before[1], fs.args.runners + 2n * reward);
});

test('a failed job refunds 95% of the fee: 5% burned, nothing to the fund', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  const deadBefore = await g.k.balance(DEAD);
  const id = await g.run([['w1', V1], ['w2', V2]], ZETA);
  assert.equal((await g.nj.call('getJob', [id])).status, 3n);
  assert.equal(await g.nj.call('credit', [g.ad('user')]), REFUND(ZETA));
  assert.equal(await g.nj.call('credit', [g.ad('fund')]), 0n);
  assert.equal(await g.nj.call('totalBurned'), ZETA - REFUND(ZETA));
  assert.equal(await g.k.balance(DEAD) - deadBefore, ZETA - REFUND(ZETA));
});

test('elastic bodies: 4 + ceil(requests per minute / 6), capped, fading back to 4 over 30 minutes', async () => {
  const g = await governed(['w1', 'w2', 'w3'], { maxBodies: 8 });
  // Line the clock up with the start of a minute.
  g.k.advance(60 - Number(g.k.now() % 60n));
  assert.equal(await g.nj.call('bodies'), 4n);
  let id;
  for (let i = 0; i < 7; i++) id = await g.req();
  assert.equal(await g.nj.call('bodies'), 6n); // 7 a minute: 4 + ceil(7/6)
  const info = await g.nj.call('jobInfo', [id]);
  assert.equal(info.skill, SKILL);
  assert.equal(info.bodies_, 6n);
  assert.equal(info.drawn, 6n); // no defenders seated: all by lottery
  for (let i = 0; i < 6; i++) await g.req();
  assert.equal(await g.nj.call('bodies'), 7n); // 13 a minute
  for (let i = 0; i < 20; i++) await g.req();
  assert.equal(await g.nj.call('load'), 33n * 30n);
  assert.equal(await g.nj.call('bodies'), 8n); // 4 + 6 = 10, capped at maxBodies 8
  await g.ctl.send('gov', 'setMaxBodies', [12]);
  assert.equal(await g.nj.call('bodies'), 10n);
  // No more requests: 33 a minute fades linearly over 30 minutes.
  g.k.advance(60);
  assert.equal(await g.nj.call('bodies'), 10n); // 33*29/30 still needs 6 extra
  g.k.advance(60 * 14); // 15 minutes idle: 33*15/30 = 16.5 a minute -> 3
  assert.equal(await g.nj.call('bodies'), 7n);
  g.k.advance(60 * 14); // 29 minutes idle: 1.1 a minute -> 1
  assert.equal(await g.nj.call('bodies'), 5n);
  g.k.advance(60); // 30 minutes: back to the 4 defenders
  assert.equal(await g.nj.call('bodies'), 4n);
  assert.equal(await g.nj.call('load'), 0n);
});

test('a new minute does not drop the body count: the busy minute keeps counting while it fades', async () => {
  const g = await governed(['w1', 'w2', 'w3'], { maxBodies: 50 });
  g.k.advance(60 - Number(g.k.now() % 60n));
  for (let i = 0; i < 30; i++) await g.req();
  assert.equal(await g.nj.call('bodies'), 9n);
  g.k.advance(60);
  await g.req(); // 1 in the new minute; 30 from the last one still count (29/30 of them)
  assert.equal(await g.nj.call('bodies'), 9n);
  // An attacker who wants many bodies pays minFee for every request.
  assert.equal(await g.nj.call('credit', [g.ad('user')]), 0n);
});

test('allowlist: requests for chains governance has not approved revert and do not grow the bodies', async () => {
  const g = await governed(['w1', 'w2', 'w3'], { maxBodies: 50 });
  g.k.advance(60 - Number(g.k.now() % 60n));
  const FAKE = encodeBytes32String('nonexistent');
  for (let i = 0; i < 30; i++) await assert.rejects(g.nj.send('user', 'request', [FAKE, TARGET], MIN_FEE), /UnknownChain/);
  await assert.rejects(g.nj.send('user', 'requestFor', [g.ad('user'), FAKE, TARGET], MIN_FEE), /UnknownChain/);
  assert.equal(await g.nj.call('load'), 0n);
  assert.equal(await g.nj.call('bodies'), 4n);
  assert.equal(await g.nj.call('jobCount'), 0n);
  // Governance adds and removes chain keys.
  await assert.rejects(g.ctl.send('user', 'approveChain', [FAKE]), /NotGovernance/);
  await g.ctl.send('gov', 'approveChain', [FAKE]);
  await g.req(); // CHAIN still fine
  await g.nj.send('user', 'request', [FAKE, TARGET], MIN_FEE);
  await g.ctl.send('gov', 'removeChain', [CHAIN]);
  await assert.rejects(g.req(), /UnknownChain/);
  await assert.rejects(g.ctl.send('gov', 'removeChain', [CHAIN]), /NotApproved/);
});

test('defenders: regrow fills the 4 seats from the voted roster, at most maxRegrowPerHour an hour', async () => {
  const names = ['d1', 'd2', 'd3', 'd4', 'd5', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  const g = await governed(names, { regrow: 2 });
  await assert.rejects(jobs.send('user', 'regrow'), /NoControl/); // without a NeuroControl there are no defenders
  for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) await g.ctl.send('gov', 'approveDefender', [g.ad(d)]);
  g.k.advance(3600 - Number(g.k.now() % 3600n)); // start of an hour
  let ev = await g.nj.send('user', 'regrow');
  assert.equal(ev.filter((e) => e?.name === 'DefenderSeated').length, 2);
  ev = await g.nj.send('user', 'regrow');
  assert.equal(ev.filter((e) => e?.name === 'DefenderSeated').length, 0); // hourly cap
  g.k.advance(3600);
  ev = await g.nj.send('user', 'regrow');
  assert.equal(ev.filter((e) => e?.name === 'DefenderSeated').length, 2);
  const seated = [...await g.nj.call('defenders')].map((x) => x.toLowerCase());
  assert.deepEqual(seated, ['d1', 'd2', 'd3', 'd4'].map((d) => g.ad(d).toLowerCase()));
  g.k.advance(1);
  // Defenders always count among the bodies and are always eligible; the lottery draws the rest.
  const id = await g.req();
  const info = await g.nj.call('jobInfo', [id]);
  assert.equal(info.bodies_, 5n); // this request itself: 4 + ceil(1/6)
  assert.equal(info.drawn, 1n);   // 4 of the 5 bodies are the defenders
  await g.nj.send('user', 'draw', [id]);
  for (const d of ['d1', 'd2', 'd3', 'd4']) assert.equal(await g.nj.call('eligible', [id, g.ad(d)]), true);
  const others = ['d5', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  const drawnNow = async () => (await Promise.all(others.map((r) => g.nj.call('eligible', [id, g.ad(r)])))).filter(Boolean).length;
  const first = await drawnNow();
  assert.ok(first <= 4, `about 1 of 9 others drawn at first, got ${first}`);
  g.k.advance(WINDOW * 2 / 3 + 1); // seats not filled: the lottery widens to at least SEATS x 4
  assert.ok(await drawnNow() > first);
  // Governance removes d2 from the roster: the next regrow vacates its seat and seats d5.
  await g.ctl.send('gov', 'removeDefender', [g.ad('d2')]);
  assert.equal(await g.nj.call('isDefender', [g.ad('d2')]), false);
  g.k.advance(3600);
  ev = await g.nj.send('user', 'regrow');
  assert.ok(ev.some((e) => e?.name === 'DefenderVacated' && e.args.worker.toLowerCase() === g.ad('d2').toLowerCase()));
  assert.ok(ev.some((e) => e?.name === 'DefenderSeated' && e.args.worker.toLowerCase() === g.ad('d5').toLowerCase() && e.args.seat === 1n));
});

test('quarantine: 2 strikes within the last 5 judged seats; the runner is out at once; only governance releases', async () => {
  const names = ['d1', 'd2', 'd3', 'd4'];
  const g = await governed(names, { regrow: 4, bond: { d1: 3n * BOND } }); // d1 can afford two penalties
  for (const d of names) await g.ctl.send('gov', 'approveDefender', [g.ad(d)]);
  await g.nj.send('user', 'regrow');
  g.k.advance(1);
  assert.equal(await g.nj.call('QUARANTINE_AFTER'), 2n);
  assert.equal(await g.nj.call('STRIKE_WINDOW'), 5n);
  // rejected, then agreed: one strike, no quarantine
  // Only defenders here: one sits at once, the others after the first third of the window.
  await g.run([['d1', V2], ['d2', V1], ['d3', V1]], MIN_FEE, { allDefenders: true });
  await g.run([['d1', V1], ['d2', V1], ['d3', V1]], MIN_FEE, { allDefenders: true });
  assert.equal(await g.nj.call('strikes', [g.ad('d1')]), 1n);
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), false);
  // A second rejection within the window (not in a row): quarantined.
  const activeBefore = await g.nj.call('activeWorkers');
  const bondBefore = await g.nj.call('totalActiveBond');
  const id = await g.req();
  await g.cm('d1', id, V2);
  g.k.advance(WINDOW / 3);
  for (const [w, v] of [['d2', V1], ['d3', V1]]) await g.cm(w, id, v);
  await g.rv('d1', id, V2);
  await g.rv('d2', id, V1);
  const ev = await g.rv('d3', id, V1);
  assert.ok(ev.some((e) => e?.name === 'Quarantined' && e.args.worker.toLowerCase() === g.ad('d1').toLowerCase()));
  assert.ok(ev.some((e) => e?.name === 'DefenderVacated' && e.args.seat === 0n));
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), true);
  assert.equal((await g.nj.call('defenders'))[0], '0x' + '00'.repeat(20));
  // Out at once: not active (ThreatRegistry, NeuroLane, NeuroValidation read this), not in the totals, unbonding.
  const w = await g.nj.call('workers', [g.ad('d1')]);
  const left = 3n * BOND - (3n * BOND) / 10n - (3n * BOND - (3n * BOND) / 10n) / 10n; // two 10% penalties
  assert.equal(w.active, false);
  assert.equal(w.bond, left);
  assert.equal(w.unbondAt, g.k.now() + BigInt(UNBOND));
  assert.equal(await g.nj.call('activeWorkers'), activeBefore - 1n);
  assert.equal(await g.nj.call('totalActiveBond'), bondBefore - (3n * BOND) / 10n * 9n / 10n - left);
  g.k.advance(1);
  const next = await g.req();
  assert.equal(await g.nj.call('eligible', [next, g.ad('d1')]), false);
  await assert.rejects(g.nj.send('d1', 'commit', [next, V1]), /NotWorker/);
  await assert.rejects(g.nj.send('d1', 'requestUnbond'), /NotWorker/);
  // regrow does not seat a quarantined runner
  g.k.advance(3600);
  let r = await g.nj.send('user', 'regrow');
  assert.equal(r.filter((e) => e?.name === 'DefenderSeated').length, 0);
  // The bond (minus penalties) comes out after the unbond delay; the address cannot register again.
  const earned = await g.nj.call('credit', [g.ad('d1')]);
  await g.nj.send('d1', 'withdrawBond');
  assert.equal(await g.nj.call('credit', [g.ad('d1')]) - earned, left);
  await assert.rejects(g.nj.send('d1', 'register', [], BOND), /InQuarantine/);
  // governance releases it; it registers again and regrow seats it
  await assert.rejects(g.ctl.send('d1', 'release', [g.ad('d1')]), /NotGovernance/);
  await g.ctl.send('gov', 'release', [g.ad('d1')]);
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), false);
  await g.nj.send('d1', 'register', [], BOND);
  assert.equal(await g.nj.call('strikes', [g.ad('d1')]), 0n); // a clean slate
  r = await g.nj.send('user', 'regrow');
  assert.ok(r.some((e) => e?.name === 'DefenderSeated' && e.args.worker.toLowerCase() === g.ad('d1').toLowerCase()));
});

test('strikes are a sliding window: one lie, four honest seats and another lie is not quarantine; the next lie is', async () => {
  const g = await governed(['liar', 'w2', 'w3'], { bond: { liar: 3n * BOND } });
  await g.run([['liar', V2], ['w2', V1], ['w3', V1]]);
  for (let i = 0; i < 4; i++) await g.run([['liar', V1], ['w2', V1], ['w3', V1]]);
  await g.run([['liar', V2], ['w2', V1], ['w3', V1]]); // the first lie has left the window
  assert.equal(await g.nj.call('strikes', [g.ad('liar')]), 1n);
  assert.equal(await g.nj.call('quarantined', [g.ad('liar')]), false);
  await g.run([['liar', V2], ['w2', V1], ['w3', V1]]);
  assert.equal(await g.nj.call('quarantined', [g.ad('liar')]), true);
});

test('a seat that does not reveal after the quorum: grace for the late, then settle() penalizes and strikes it', async () => {
  const g = await governed(['liar', 'w2', 'w3'], { bond: { liar: 3n * BOND } });
  // An honest runner a few seconds late: it reveals inside the grace, no penalty.
  let id = await g.req();
  for (const [w, v] of [['liar', V1], ['w2', V1], ['w3', V1]]) await g.cm(w, id, v);
  await g.rv('w2', id, V1);
  await g.rv('w3', id, V1);
  const info = await g.nj.call('jobInfo', [id]);
  assert.equal(info.settleAt, g.k.now() + BigInt(WINDOW));
  g.k.advance(WINDOW - 5);
  await g.rv('liar', id, V1);
  assert.equal((await g.nj.call('workers', [g.ad('liar')])).bond, 3n * BOND);
  assert.equal((await g.nj.call('workers', [g.ad('liar')])).agreed, 1n);
  assert.equal((await g.nj.call('jobInfo', [id])).settleAt, 0n); // everyone revealed: nothing pending
  await assert.rejects(g.nj.send('user', 'settle', [id]), /Nothing/);

  // A liar that sees the honest pair agree and keeps quiet.
  for (let round = 0; round < 2; round++) {
    id = await g.req();
    for (const [w, v] of [['liar', V2], ['w2', V1], ['w3', V1]]) await g.cm(w, id, v);
    await g.rv('w2', id, V1);
    await g.rv('w3', id, V1);
    await assert.rejects(g.nj.send('user', 'settle', [id]), /TooEarly/);
    g.k.advance(WINDOW);
    await assert.rejects(g.rv('liar', id, V2), /Closed/); // the grace is over
    const bond = (await g.nj.call('workers', [g.ad('liar')])).bond;
    const ev = await g.nj.send('user', 'settle', [id]);
    assert.ok(ev.some((e) => e?.name === 'Missed' && e.args.worker.toLowerCase() === g.ad('liar').toLowerCase()));
    assert.ok(ev.some((e) => e?.name === 'Penalized' && e.args.amount === bond / 10n));
    await assert.rejects(g.nj.send('user', 'settle', [id]), /Nothing/);
  }
  assert.equal(await g.nj.call('quarantined', [g.ad('liar')]), true); // two strikes
  assert.equal((await g.nj.call('workers', [g.ad('liar')])).active, false);
  // A lie revealed late is judged as a lie.
  const g2 = await governed(['liar', 'w2', 'w3'], { bond: { liar: 3n * BOND } });
  const id2 = await g2.req();
  for (const [w, v] of [['liar', V2], ['w2', V1], ['w3', V1]]) await g2.cm(w, id2, v);
  await g2.rv('w2', id2, V1);
  await g2.rv('w3', id2, V1);
  const ev2 = await g2.rv('liar', id2, V2);
  assert.ok(ev2.some((e) => e?.name === 'Penalized'));
  assert.equal((await g2.nj.call('workers', [g2.ad('liar')])).rejected, 1n);
  assert.equal(await g2.nj.call('strikes', [g2.ad('liar')]), 1n);
});

test('quarantine: seats already taken still reveal; quarantine while unbonding does not double-count', async () => {
  const g = await governed(['liar', 'w2', 'w3'], { bond: { liar: 3n * BOND } });
  await g.run([['liar', V2], ['w2', V1], ['w3', V1]]); // strike 1
  const a = await g.req(), b = await g.req();
  const saltB = {};
  for (const w of ['liar', 'w2', 'w3']) { // seats on job b, taken before the quarantine
    saltB[w] = hexlify(randomBytes(32));
    await g.nj.send(w, 'commit', [b, commitment(V1, g.ad(w), saltB[w])]);
  }
  for (const w of ['liar', 'w2', 'w3']) await g.cm(w, a, w === 'liar' ? V2 : V1);
  await g.nj.send('liar', 'requestUnbond'); // already leaving when the quarantine hits
  const total = await g.nj.call('totalActiveBond'), count = await g.nj.call('activeWorkers');
  const unbondAt = (await g.nj.call('workers', [g.ad('liar')])).unbondAt;
  for (const w of ['liar', 'w2', 'w3']) await g.rv(w, a, w === 'liar' ? V2 : V1);
  assert.equal(await g.nj.call('quarantined', [g.ad('liar')]), true);
  assert.equal(await g.nj.call('totalActiveBond'), total);
  assert.equal(await g.nj.call('activeWorkers'), count);
  assert.equal((await g.nj.call('workers', [g.ad('liar')])).unbondAt, unbondAt); // unchanged
  // Its seat on job b still reveals, and is judged as usual.
  const ev = await g.nj.send('liar', 'reveal', [b, V1, saltB.liar]);
  assert.ok(ev.some((e) => e?.name === 'Revealed'));
  await g.nj.send('w2', 'reveal', [b, V1, saltB.w2]);
  assert.equal((await g.nj.call('getJob', [b])).status, 2n);
  assert.ok(await g.nj.call('credit', [g.ad('liar')]) > 0n);
});

test('stop button: pause blocks requests and commits, not reveals, expiry or withdrawals', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  await g.ctl.send('gov', 'setGuardian', [g.ad('guardian'), true]);
  const done = await g.run([['w1', V1], ['w2', V1]], ZETA); // w1 and w2 earned something
  assert.equal((await g.nj.call('getJob', [done])).status, 2n);
  const open = await g.req(ZETA);
  await g.cm('w1', open, V1);
  const timedOut = await g.req(ZETA);
  await g.ctl.send('guardian', 'pause');
  await assert.rejects(g.nj.send('user', 'request', [CHAIN, TARGET], MIN_FEE), /Paused/);
  await assert.rejects(g.nj.send('w2', 'requestFor', [g.ad('user'), CHAIN, TARGET], MIN_FEE), /Paused/);
  await assert.rejects(g.cm('w2', open, V1), /Paused/);
  g.k.advance(WINDOW);
  await g.rv('w1', open, V1); // a seat taken before the pause can still reveal
  const before = await g.k.balance('w1');
  await g.nj.send('w1', 'withdraw'); // earnings still come out
  assert.ok(await g.k.balance('w1') > before);
  g.k.advance(TIMEOUT);
  await g.nj.send('user', 'expire', [timedOut]); // refunds still work
  await g.nj.send('user', 'withdraw');
  await g.nj.send('w3', 'requestUnbond'); // runners can still leave
  await assert.rejects(g.ctl.send('guardian', 'unpause'), /NotGovernance/);
  await g.ctl.send('gov', 'unpause');
  await g.req();
});

test('every job records the voted skill it was requested under; no active skill, no jobs', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  const a1 = await g.req();
  await g.ctl.send('gov', 'approveSkill', [SKILL2]);
  await g.ctl.send('gov', 'setActiveSkill', [SKILL2]);
  const a2 = await g.req();
  assert.equal((await g.nj.call('jobInfo', [a1])).skill, SKILL);
  assert.equal((await g.nj.call('jobInfo', [a2])).skill, SKILL2);
  const ev = await g.nj.send('user', 'request', [CHAIN, TARGET], MIN_FEE);
  assert.ok(ev.some((e) => e?.name === 'JobSized' && e.args.skill === SKILL2));
  // A control with no skill voted in yet refuses requests.
  const k = await createChain(['gov', 'user']);
  const ctl = await k.deploy('NeuroControl', [k.acct.gov.toString(), k.acct.gov.toString(), 8, 2], 'gov');
  const nj = await k.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'gov');
  await nj.send('gov', 'setControl', [ctl.address]);
  await assert.rejects(nj.send('user', 'request', [CHAIN, TARGET], MIN_FEE), /NoSkill/);
});

// ---- lottery bound to a block hash, bond snapshot, defender cap, bond holds, challenge rounds ----

const R1 = '0x' + 'a1'.repeat(32), R2 = '0x' + 'b2'.repeat(32);
const H1 = '0x' + 'c3'.repeat(32), H2 = '0x' + 'd4'.repeat(32);
const V3 = '0x' + '33'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);
const ev = (evs, name) => evs.filter((e) => e?.name === name);

/** A contract that requests (or challenges) and draws in the same transaction, so in the same block. */
async function sameBlockHelper(k) {
  const solc = (await import('solc')).default;
  const src = `pragma solidity 0.8.26;
interface J { function request(bytes32, string calldata) external payable returns (uint256); function draw(uint256) external;
  function challenge(uint256, bytes32) external payable; function commit(uint256, bytes32) external; }
contract Same {
  error TooEarly();
  function requestAndDraw(J j, bytes32 c, string calldata t) external payable { uint256 id = j.request{value: msg.value}(c, t); j.draw(id); }
  function challengeAndDraw(J j, uint256 id, bytes32 claim) external payable { j.challenge{value: msg.value}(id, claim); j.draw(id); }
}`;
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'S.sol': { content: src } },
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const s = out.contracts['S.sol'].Same;
  return k.deployRaw({ abi: s.abi, bytecode: '0x' + s.evm.bytecode.object }, [], 'user');
}

/** A fresh market with `n` equal runners and one request; returns helpers to list the eligible set. */
async function lotteryMarket({ n = 30, salt, noHash = false } = {}) {
  const names = Array.from({ length: n }, (_, i) => `r${i}`);
  const k = await createChain(['owner', 'user', 'whale', ...names]);
  if (salt) k.setBlockHashSalt(salt);
  if (noHash) k.noBlockHash();
  const nj = await k.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'owner');
  for (const x of names) await nj.send(x, 'register', [], BOND);
  k.advance(1);
  await nj.send('user', 'request', [CHAIN, TARGET], MIN_FEE);
  const set = async (id = 0) => {
    const out = [];
    for (const x of names) if (await nj.call('eligible', [id, k.acct[x].toString()])) out.push(x);
    return out.join(',');
  };
  return { k, nj, names, set, rand: async (id = 0) => (await nj.call('jobInfo', [id])).rand };
}

test('lottery: rand = keccak(seed, blockhash(request block + 1), round): another block hash, another set; PREVRANDAO changes nothing', async () => {
  const a = await lotteryMarket({ salt: H1 });
  const b = await lotteryMarket({ salt: H2 });
  const a2 = await lotteryMarket({ salt: H1 });
  a2.k.setPrevRandao(R1);
  const a3 = await lotteryMarket({ salt: H1 });
  a3.k.setPrevRandao(R2);
  const ra = await a.rand(), sa = await a.set();
  assert.notEqual(ra, ZERO32);
  assert.notEqual(ra, await b.rand());
  assert.notEqual(sa, await b.set(), 'another block hash picks another eligible set');
  assert.equal(await a2.rand(), ra); // same block hash, other PREVRANDAO: same lottery
  assert.equal(await a3.rand(), ra);
  assert.equal(await a3.set(), sa);
});

test('lottery: no re-roll: a NotChosen commit retried block after block, or a draw timed to suit, gets the same draw', async () => {
  const m = await lotteryMarket({ salt: H1 });
  const rand0 = await m.rand();
  const set0 = await m.set();
  const out = m.names.find((x) => !set0.split(',').includes(x));
  for (let i = 0; i < 5; i++) {
    m.k.setPrevRandao(hexlify(randomBytes(32)));
    m.k.mine(1 + i * 7);
    await assert.rejects(m.nj.send(out, 'commit', [0, V1]), /NotChosen/); // the revert does not re-roll anything
    assert.equal(await m.rand(), rand0);
  }
  assert.equal(await m.set(), set0);
  // A contract that draws only when it likes the result has nothing to choose from either.
  const drawn = ev(await m.nj.send('user', 'draw', [0]), 'Drawn');
  assert.equal(drawn[0].args.rand, rand0);
  assert.equal(await m.set(), set0);
});

test('lottery: a request and its draw (or first commit) cannot share a block, nor use the very next one', async () => {
  const same = await sameBlockHelper(c);
  await assert.rejects(same.send('user', 'requestAndDraw', [jobs.address, CHAIN, TARGET], MIN_FEE), /TooEarly/);
  assert.equal(await jobs.call('jobCount'), 0n);
  const id = await newJob();
  await commitAs('w1', id, V1); // the first commit stores the draw
  await assert.rejects(jobs.send('user', 'draw', [id]), /Nothing/);
});

test('lottery: 256 blocks without a stored draw: draw() moves the round to a new block (a new hash decides)', async () => {
  const m = await lotteryMarket({ salt: H1 });
  const rand0 = await m.rand();
  m.k.mine(300); // blockhash(request block + 1) is gone
  assert.equal(await m.rand(), ZERO32);
  assert.equal(await m.set(), '');
  await assert.rejects(m.nj.send('r0', 'commit', [0, V1]), /TooEarly/);
  const re = ev(await m.nj.send('user', 'draw', [0]), 'Redrawn');
  assert.equal(re.length, 1);
  const rand1 = await m.rand();
  assert.notEqual(rand1, ZERO32);
  assert.notEqual(rand1, rand0);
  assert.equal(ev(await m.nj.send('user', 'draw', [0]), 'Drawn')[0].args.rand, rand1);
});

test('lottery: a chain whose BLOCKHASH is 0 still draws, with a fixed fallback (as predictable as the request)', async () => {
  const a = await lotteryMarket({ noHash: true });
  const b = await lotteryMarket({ noHash: true });
  b.k.setPrevRandao(R1);
  assert.notEqual(await a.rand(), ZERO32);
  assert.equal(await a.rand(), await b.rand());
  assert.equal(await a.set(), await b.set());
  await a.nj.send('user', 'draw', [0]);
});

test('snapshot: a big bond registered (or a bond leaving) after the request does not change who is drawn', async () => {
  const m = await lotteryMarket({ salt: H1 });
  const set0 = await m.set();
  const total0 = await m.nj.call('totalActiveBond');
  await m.nj.send('whale', 'register', [], 1000n * BOND); // 33x everyone else together
  await m.nj.send('r29', 'requestUnbond');
  assert.notEqual(await m.nj.call('totalActiveBond'), total0);
  const set1 = await m.set();
  assert.equal(set1, set0.split(',').filter((x) => x !== 'r29').join(','), 'only the runner that left drops out');
  assert.equal(await m.nj.call('eligible', [0, m.k.acct.whale.toString()]), false); // joined after the job
});

test('defenders: at most one per round in every phase while other runners are active; with only defenders they fill the seats', async () => {
  const g = await governed(['d1', 'd2', 'r1', 'r2', 'r3']);
  for (const d of ['d1', 'd2']) await g.ctl.send('gov', 'approveDefender', [g.ad(d)]);
  await g.nj.send('user', 'regrow');
  g.k.advance(1);
  const a = await g.req();
  assert.equal(await g.nj.call('eligible', [a, g.ad('d2')]), true); // no defender on it yet
  await g.cm('d1', a, V1);
  for (const step of [0, WINDOW / 3, WINDOW / 3]) { // first, second and last third
    g.k.advance(step);
    assert.equal(await g.nj.call('eligible', [a, g.ad('d2')]), false);
    await assert.rejects(g.cm('d2', a, V1), /NotChosen/);
  }
  await g.cm('r1', a, V1); // the last third: every non-defender runner
  await g.cm('r2', a, V1);
  // Only defenders active: no cap, at once.
  const h = await governed(['d1', 'd2', 'd3']);
  for (const d of ['d1', 'd2', 'd3']) await h.ctl.send('gov', 'approveDefender', [h.ad(d)]);
  await h.nj.send('user', 'regrow');
  h.k.advance(1);
  const b = await h.req();
  for (const d of ['d1', 'd2', 'd3']) await h.cm(d, b, V1);
  assert.equal((await h.nj.call('getJob', [b])).commits, 3n);
});

test('a runner deactivated by a penalty starts unbonding: its bond comes out after the delay and the hold (or it tops up)', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1); await commitAs('w2', id, V2); await commitAs('w3', id, V1);
  await revealAs('w1', id, V1); await revealAs('w2', id, V2); await revealAs('w3', id, V1);
  const w2 = await jobs.call('workers', [addr('w2')]);
  assert.equal(w2.active, false);
  assert.equal(w2.unbondAt, c.now() + BigInt(UNBOND)); // the timer runs: the rest is not stuck
  const free = w2.heldUntil > w2.unbondAt ? w2.heldUntil : w2.unbondAt; // the delay, and the challenge window's hold
  c.advance(Number(free - c.now()) - 1);
  await assert.rejects(jobs.send('w2', 'withdrawBond'), /TooEarly/);
  c.advance(1);
  await jobs.send('w2', 'withdrawBond');
  assert.equal(await jobs.call('credit', [addr('w2')]), BOND - BOND / 10n);
  // Topping up instead: register() again cancels the unbonding.
  const id2 = await newJob(ZETA);
  await commitAs('w1', id2, V1); await commitAs('w3', id2, V2); await commitAs('w4', id2, V1);
  await revealAs('w1', id2, V1); await revealAs('w3', id2, V2); await revealAs('w4', id2, V1);
  assert.notEqual((await jobs.call('workers', [addr('w3')])).unbondAt, 0n);
  await jobs.send('w3', 'register', [], BOND / 10n);
  const w3 = await jobs.call('workers', [addr('w3')]);
  assert.equal(w3.active, true);
  assert.equal(w3.unbondAt, 0n);
  assert.equal(w3.bond, BOND);
});

test('reveals have a hard deadline (start + jobTimeout): a late reveal cannot land after the bonds were freed', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  c.advance(TIMEOUT);
  await assert.rejects(revealAs('w1', id, V1), /Closed/);
  await jobs.send('user', 'expire', [id]);
  // Its bond stays at least until the deadline + jobTimeout (expire/settle have that long).
  assert.ok((await jobs.call('workers', [addr('w1')])).heldUntil >= c.now());
});

/** Round 1 with the given votes (every runner is eligible in the last third), then challenges by `who`. */
async function challenged(names, votes, { fee = MIN_FEE, who = 'user', bond, window, bonds = { l1: BOND * 2n, l2: BOND * 2n } } = {}) {
  const g = await governed(names, { bond: bonds });
  if (window) await g.ctl.send('gov', 'setChallengeWindow', [window]);
  const id = await g.req(fee);
  g.k.advance(WINDOW * 2 / 3);
  for (const [w, v] of votes) await g.cm(w, id, v);
  g.k.advance(WINDOW);
  for (const [w, v] of votes) await g.rv(w, id, v).catch(() => {});
  assert.equal((await g.nj.call('getJob', [id])).status, 2n);
  const result = (await g.nj.call('getJob', [id])).result;
  const need = await g.nj.call('challengeBondOf', [id]);
  const s2 = {};
  const cm2 = async (w, v) => { s2[w] = hexlify(randomBytes(32)); await g.nj.send(w, 'challengeCommit', [id, commitment(v, g.ad(w), s2[w])]); };
  const rv2 = (w, v) => g.nj.send(w, 'challengeReveal', [id, v, s2[w]]);
  const open = async (claim = result === V1 ? V2 : V1, from = who) => g.nj.send(from, 'challenge', [id, claim], bond ?? need);
  const credits = async (ws) => Promise.all(ws.map((w) => g.nj.call('credit', [g.ad(w)])));
  return { ...g, id, need, cm2, rv2, open, credits };
}
const diff = (after, before) => after.map((x, i) => x - before[i]);
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

test('challenge: overturned to the claim: 50% of the pair\'s bonds, strikes, the challenger and the round are paid, to the wei', async () => {
  const names = ['l1', 'l2', 'h1', 'r1', 'r2', 'r3', 'r4'];
  const g = await challenged(names, [['l1', V2], ['l2', V2], ['h1', V1]], { fee: ZETA, window: 7200 });
  assert.equal((await g.nj.call('getJob', [g.id])).result, V2); // the pair won round 1
  let as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.agreedBy, 2n);
  assert.equal(as.state, 0n);
  assert.equal(as.settled, false);
  assert.equal(g.need, 2n * ZETA); // max(2 x fee, 1 ZETAPHY)
  // The pair tries to leave before anyone checks: the bond is held past the challenge window.
  await g.nj.send('l1', 'requestUnbond');
  g.k.advance(UNBOND);
  await assert.rejects(g.nj.send('l1', 'withdrawBond'), /TooEarly/);
  await assert.rejects(g.nj.send('user', 'challenge', [g.id, V1], g.need - 1n), /BadValue/);
  await assert.rejects(g.open(V2), /BadValue/); // the claim must differ from the verdict
  await assert.rejects(g.open(ZERO32), /BadValue/);
  const ch = await g.open(V1);
  assert.equal(ev(ch, 'Challenged').length, 1);
  assert.equal(ev(ch, 'ChallengeClaim')[0].args.claim, V1);
  await assert.rejects(g.open(), /AlreadyIn/); // one open challenge at a time
  assert.deepEqual([...await g.nj.call('challengeRound', [g.id])], [1n, V1]);
  await g.nj.send('r1', 'draw', [g.id]);
  for (const w of ['l2', 'h1', 'user']) assert.equal(await g.nj.call('challengeEligible', [g.id, g.ad(w)]), false);
  await assert.rejects(g.cm2('l2', V1), /NotChosen/); // a round-1 seat never sits again
  g.k.advance(WINDOW * 2 / 3);
  await g.cm2('r1', V1);
  await g.cm2('r2', V1);
  await g.cm2('r3', V2);
  await assert.rejects(g.cm2('r4', V1), /NoSeat/);
  const who = ['user', 'l1', 'l2', 'h1', 'r1', 'r2', 'r3', 'fund'];
  const before = await g.credits(who);
  const bonds = await Promise.all(['l1', 'l2'].map(async (w) => (await g.nj.call('workers', [g.ad(w)])).bond));
  await g.rv2('r1', V1);
  const res = await g.rv2('r2', V1);
  assert.deepEqual(ev(res, 'ChallengeResolved').map((e) => [e.args.state, e.args.verdict]), [[3n, V1]]);
  assert.equal((await g.nj.call('getJob', [g.id])).result, V1);
  const d = diff(await g.credits(who), before);
  const slashed = bonds[0] / 2n + bonds[1] / 2n;
  for (const [i, w] of ['l1', 'l2'].entries()) {
    assert.equal((await g.nj.call('workers', [g.ad(w)])).bond, bonds[i] - bonds[i] / 2n);
    assert.equal(await g.nj.call('strikes', [g.ad(w)]), 1n);
  }
  const toChallenger = slashed / 2n, share = (slashed - toChallenger) / 3n;
  assert.deepEqual(d.slice(0, 7), [g.need + toChallenger, 0n, 0n, share, share, share, 0n]);
  assert.equal(sum(d), g.need + slashed); // nothing lost: dust to the fund
  as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.agreedBy, 3n);
  assert.equal(as.state, 3n);
  assert.equal(as.settled, true);
  await assert.rejects(g.open(V2), /AlreadyIn/); // decided: no new challenge
  const r3 = await g.rv2('r3', V2); // the round's liar, inside the grace
  assert.equal(ev(r3, 'Penalized').length, 1);
});

test('challenge: overturned to a third verdict: the challenger was wrong too and loses its whole bond, to the wei', async () => {
  const g = await challenged(['l1', 'l2', 'r1', 'r2'], [['l1', V2], ['l2', V2]], { fee: ZETA });
  await g.open(V1);
  g.k.advance(WINDOW * 2 / 3);
  await g.cm2('r1', V3);
  await g.cm2('r2', V3);
  g.k.advance(WINDOW);
  const who = ['user', 'l1', 'l2', 'r1', 'r2', 'fund'];
  const before = await g.credits(who);
  const bonds = await Promise.all(['l1', 'l2'].map(async (w) => (await g.nj.call('workers', [g.ad(w)])).bond));
  await g.rv2('r1', V3);
  const res = await g.rv2('r2', V3);
  assert.deepEqual(ev(res, 'ChallengeResolved').map((e) => [e.args.state, e.args.verdict]), [[3n, V3]]);
  const d = diff(await g.credits(who), before);
  const pot = g.need + bonds[0] / 2n + bonds[1] / 2n;
  assert.deepEqual(d.slice(0, 5), [0n, 0n, 0n, pot / 2n, pot / 2n]);
  assert.equal(sum(d), pot);
});

test('challenge: confirmed: the challenger loses its bond to the round and the round-1 winners', async () => {
  const g = await challenged(['w1', 'w2', 'r1', 'r2', 'r3'], [['w1', V1], ['w2', V1]]);
  assert.equal(g.need, ZETA); // 2 x 0.1 is below the 1 ZETAPHY floor
  await g.open();
  g.k.advance(WINDOW * 2 / 3);
  const who = ['user', 'w1', 'w2', 'r1', 'r2', 'fund'];
  const before = await g.credits(who);
  await g.cm2('r1', V1);
  await g.cm2('r2', V1);
  g.k.advance(WINDOW);
  await g.rv2('r1', V1);
  const res = await g.rv2('r2', V1);
  assert.equal(ev(res, 'ChallengeResolved')[0].args.state, 2n);
  const d = diff(await g.credits(who), before);
  assert.deepEqual(d.slice(0, 5), [0n, ZETA / 4n, ZETA / 4n, ZETA / 4n, ZETA / 4n]);
  assert.equal(sum(d), ZETA);
  const as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.agreedBy, 4n);
  assert.equal(as.state, 2n);
  assert.equal(await g.nj.call('challengeCount'), 1n);
  assert.equal(await g.nj.call('challenged', [0]), g.id);
});

test('challenge: no quorum keeps 20% for the seats that revealed; the verdict stands, Disputed; a fresh round may be opened by anyone', async () => {
  const names = ['w1', 'w2', 'r1', 'r2', 'r3', 'r4', 'c1', 'c2'];
  const g = await challenged(names, [['w1', V1], ['w2', V1]], { who: 'c1', window: 7200 });
  // A self-serving challenge (c1): nobody agrees in its round.
  await g.open(V2);
  await assert.rejects(g.cm2('c1', V1), /NotChosen/); // never the challenger
  g.k.advance(WINDOW * 2 / 3);
  await g.cm2('r1', V1);
  await g.cm2('r2', V2);
  g.k.advance(WINDOW);
  const who = ['c1', 'r1', 'r2', 'fund'];
  const before = await g.credits(who);
  await g.rv2('r1', V1);
  const out = await g.rv2('r2', V2); // all revealed, none agree
  assert.equal(ev(out, 'ChallengeResolved')[0].args.state, 4n);
  const keep = g.need * 2000n / 10_000n;
  const d = diff(await g.credits(who), before);
  assert.deepEqual(d.slice(0, 3), [g.need - keep, keep / 2n, keep / 2n]);
  assert.equal(sum(d), g.need);
  let as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.state, 4n);
  assert.equal(as.settled, false); // may be challenged again
  assert.equal(as.challengeUntil, g.k.now() + 7200n); // a new window
  // The round-1 pair's bonds stay through the new window (and its round), past the unbond delay.
  const held = (await g.nj.call('workers', [g.ad('w1')])).heldUntil;
  assert.ok(held >= as.challengeUntil + 2n * BigInt(TIMEOUT));
  await g.nj.send('w1', 'requestUnbond');
  g.k.advance(UNBOND);
  await assert.rejects(g.nj.send('w1', 'withdrawBond'), /TooEarly/);
  // A real challenger opens round 3: fresh seats, never anyone from rounds 1-2 nor a challenger.
  await g.open(V2, 'c2');
  assert.deepEqual([...await g.nj.call('challengeRound', [g.id])], [2n, V2]);
  assert.equal(await g.nj.call('challengeCount'), 2n);
  g.k.advance(WINDOW * 2 / 3); // the last third: every runner that may sit at all
  for (const w of ['w1', 'w2', 'r1', 'r2', 'c1', 'c2']) assert.equal(await g.nj.call('challengeEligible', [g.id, g.ad(w)]), false, w);
  for (const w of ['r3', 'r4']) assert.equal(await g.nj.call('challengeEligible', [g.id, g.ad(w)]), true, w);
  await assert.rejects(g.cm2('r1', V1), /NotChosen/);
  await g.cm2('r3', V1);
  await g.cm2('r4', V1);
  g.k.advance(WINDOW);
  const who3 = ['c2', 'w1', 'w2', 'r3', 'r4', 'fund'];
  const b3 = await g.credits(who3);
  await g.rv2('r3', V1);
  await g.rv2('r4', V1); // confirmed: c2 loses its bond
  const d3 = diff(await g.credits(who3), b3);
  assert.deepEqual(d3.slice(0, 5), [0n, g.need / 4n, g.need / 4n, g.need / 4n, g.need / 4n]);
  as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.state, 2n);
  assert.equal(as.agreedBy, 4n);
  assert.equal(as.settled, true);
  await assert.rejects(g.open(V2, 'c1'), /AlreadyIn/);
});

test('challenge: rounds with nobody: 20% to the community fund; after MAX_CHALLENGES (3 rounds in all) the verdict is final', async () => {
  const g = await challenged(['w1', 'w2', 'r1'], [['w1', V1], ['w2', V1]]);
  assert.equal(await g.nj.call('MAX_CHALLENGES'), 2n);
  const keep = g.need * 2000n / 10_000n;
  for (let i = 0; i < 2; i++) {
    await g.open();
    await assert.rejects(g.nj.send('user', 'challengeExpire', [g.id]), /TooEarly/);
    g.k.advance(TIMEOUT);
    const before = await g.credits(['user', 'fund']);
    await g.nj.send('r1', 'challengeExpire', [g.id]);
    assert.deepEqual(diff(await g.credits(['user', 'fund']), before), [g.need - keep, keep]);
    assert.equal((await g.nj.call('assurance', [g.id])).state, 4n);
  }
  const as = await g.nj.call('assurance', [g.id]);
  assert.equal(as.settled, true);
  await assert.rejects(g.open(), /Closed/);
});

test('challenge: a challenge round reveal has a hard deadline; silent seats are penalized at challengeExpire', async () => {
  const g = await challenged(['w1', 'w2', 'r1', 'r2', 'r3'], [['w1', V1], ['w2', V1]], { who: 'r3' });
  await g.open();
  g.k.advance(WINDOW * 2 / 3);
  await g.cm2('r1', V1);
  await g.cm2('r2', V2);
  g.k.advance(WINDOW);
  await g.rv2('r1', V1);
  g.k.advance(TIMEOUT);
  await assert.rejects(g.rv2('r2', V2), /Closed/); // too late: the round is over
  const before = await g.credits(['r3', 'r1']);
  const out = await g.nj.send('user', 'challengeExpire', [g.id]);
  assert.ok(ev(out, 'Missed').some((e) => e.args.worker.toLowerCase() === g.ad('r2').toLowerCase()));
  const keep = g.need * 2000n / 10_000n;
  assert.deepEqual(diff(await g.credits(['r3', 'r1']), before), [g.need - keep, keep]);
  assert.equal((await g.nj.call('getJob', [g.id])).result, V1);
});

test('challenge: an overturned runner deactivated by the slash unbonds; its bond comes out after the hold', async () => {
  const g = await challenged(['l1', 'l2', 'r1', 'r2'], [['l1', V2], ['l2', V2]], { bonds: {} });
  await g.open(V1);
  g.k.advance(WINDOW * 2 / 3);
  await g.cm2('r1', V1);
  await g.cm2('r2', V1);
  g.k.advance(WINDOW);
  await g.rv2('r1', V1);
  await g.rv2('r2', V1);
  const w = await g.nj.call('workers', [g.ad('l1')]);
  assert.equal(w.bond, BOND / 2n);
  assert.equal(w.active, false);
  assert.equal(w.unbondAt, g.k.now() + BigInt(UNBOND)); // not stuck
  g.k.advance(Number((w.heldUntil > w.unbondAt ? w.heldUntil : w.unbondAt) - g.k.now()));
  const before = await g.nj.call('credit', [g.ad('l1')]);
  await g.nj.send('l1', 'withdrawBond');
  assert.equal(await g.nj.call('credit', [g.ad('l1')]) - before, BOND / 2n);
});

test('challenge: only a done job, inside the window, not while paused, not drawn in the challenge block', async () => {
  const g = await challenged(['w1', 'w2', 'r1'], [['w1', V1], ['w2', V1]]);
  const open = await g.req();
  await assert.rejects(g.nj.send('user', 'challenge', [open, V2], ZETA), /Closed/);
  await g.ctl.send('gov', 'pause');
  await assert.rejects(g.open(), /Paused/);
  await g.ctl.send('gov', 'unpause');
  const same = await sameBlockHelper(g.k);
  await assert.rejects(same.send('user', 'challengeAndDraw', [g.nj.address, g.id, V2], g.need), /TooEarly/);
  g.k.advance(TIMEOUT); // the window defaults to jobTimeout
  await assert.rejects(g.open(), /Closed/);
  assert.equal((await g.nj.call('assurance', [g.id])).settled, true);
});

test('NeuroJobsChallenges refuses direct calls; NeuroJobs fits the code size limit', async () => {
  const logic = await jobs.call('challengeLogic');
  const art = JSON.parse((await import('node:fs')).readFileSync(new URL('../artifacts/NeuroJobsChallenges.json', import.meta.url), 'utf8'));
  const { Interface } = await import('ethers');
  await assert.rejects(c.sendTo('user', logic, new Interface(art.abi), 'challengeExpire', [0]), /NotDeployer/);
  const main = JSON.parse((await import('node:fs')).readFileSync(new URL('../artifacts/NeuroJobs.json', import.meta.url), 'utf8'));
  assert.ok((main.deployedBytecode.length - 2) / 2 <= 24_576);
  assert.ok((main.bytecode.length - 2) / 2 <= 49_152);
});

test('gas: a request costs more when the load meter rolls to another minute (why every send is padded)', async () => {
  const g = await governed(['w1']);
  g.k.advance(60 - Number(g.k.now() % 60n));
  const gas = async () => (await g.k.sendTo('user', g.nj.address, g.nj.iface, 'request', [CHAIN, TARGET], MIN_FEE)).execResult.executionGasUsed;
  await gas();
  g.k.advance(61);
  const a = await gas();
  g.k.advance(5);
  const b = await gas();
  assert.notEqual(a, b, 'an exact estimate from one minute can be short in another');
});
