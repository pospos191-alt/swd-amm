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

test('no quorum: job fails and the fee goes back to the requester', async () => {
  const id = await newJob(ZETA);
  await commitAs('w1', id, V1);
  await commitAs('w2', id, V2);
  c.advance(WINDOW);
  await revealAs('w1', id, V1);
  const ev = await revealAs('w2', id, V2);
  assert.ok(ev.some((e) => e.name === 'JobFailed'));
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
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
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
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
  // The late third reveal on a finished job is refused.
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
  assert.equal(await jobs.call('credit', [addr('user')]), ZETA);
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
  const eligibleNow = async () => (await Promise.all(names.map((n) => j3.call('eligible', [0, c3.acct[n].toString()])))).filter(Boolean).length;
  const first = await eligibleNow();
  assert.ok(first >= 1 && first <= 15, `about 6 of 30 should qualify at first, got ${first}`);
  for (const n of names) {
    if (!(await j3.call('eligible', [0, c3.acct[n].toString()]))) {
      await assert.rejects(j3.send(n, 'commit', [0, V1]), /NotChosen/);
      break;
    }
  }
  c3.advance(80); // two thirds of the window: four times as many qualify
  assert.ok(await eligibleNow() > first);
});

test('a runner that registers after the job was requested cannot take a seat on it', async () => {
  const id = await newJob();
  const c4acct = 'owner';
  await jobs.send(c4acct, 'register', [], BOND); // joins now, after the request
  assert.equal(await jobs.call('eligible', [id, addr(c4acct)]), false);
  await assert.rejects(jobs.send(c4acct, 'commit', [id, V1]), /NotChosen/);
  c.advance(1);
  const later = await newJob();
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
  await nj.send('gov', 'fund', [], 1000n * ZETA);
  for (const n of names) await nj.send(n, 'register', [], bond[n] ?? BOND);
  k.advance(1);
  const ad = (n) => k.acct[n].toString();
  const s = {};
  const req = async (fee = MIN_FEE) => { await nj.send('user', 'request', [CHAIN, TARGET], fee); return (await nj.call('jobCount')) - 1n; };
  const cm = async (w, id, v) => { s[w] = hexlify(randomBytes(32)); await nj.send(w, 'commit', [id, commitment(v, ad(w), s[w])]); };
  const rv = (w, id, v) => nj.send(w, 'reveal', [id, v, s[w]]);
  /** a job where `seats` commit and reveal the given verdicts (all reveals sent) */
  const run = async (votes, fee = MIN_FEE) => {
    const id = await req(fee);
    for (const [w, v] of votes) await cm(w, id, v);
    k.advance(WINDOW);
    for (const [w, v] of votes) await rv(w, id, v).catch(() => {});
    return id;
  };
  return { k, ctl, nj, ad, req, cm, rv, run };
}

test('setControl: only the deployer, once, before the first job', async () => {
  const ctl = await c.deploy('NeuroControl', [addr('owner'), addr('owner'), 8, 2], 'owner');
  await assert.rejects(jobs.send('user', 'setControl', [ctl.address]), /NotDeployer/);
  const fresh = await c.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'owner');
  await fresh.send('owner', 'setControl', [ctl.address]);
  await assert.rejects(fresh.send('owner', 'setControl', [ctl.address]), /BadValue/);
  await newJob(); // `jobs` already has a job: too late
  await assert.rejects(jobs.send('owner', 'setControl', [ctl.address]), /BadValue/);
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
  await assert.rejects(g.rv('w3', id, V1), /Closed/);
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

test('a failed job refunds 100% of the fee: nothing burned, nothing to the fund', async () => {
  const g = await governed(['w1', 'w2', 'w3']);
  const id = await g.run([['w1', V1], ['w2', V2]], ZETA);
  assert.equal((await g.nj.call('getJob', [id])).status, 3n);
  assert.equal(await g.nj.call('credit', [g.ad('user')]), ZETA);
  assert.equal(await g.nj.call('credit', [g.ad('fund')]), 0n);
  assert.equal(await g.nj.call('totalBurned'), 0n);
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

test('quarantine: K=2 rejected verdicts in a row; the defender seat is vacated; only governance releases', async () => {
  const names = ['d1', 'd2', 'd3', 'd4'];
  const g = await governed(names, { regrow: 4, bond: { d1: 3n * BOND } }); // d1 can afford two penalties
  for (const d of names) await g.ctl.send('gov', 'approveDefender', [g.ad(d)]);
  await g.nj.send('user', 'regrow');
  g.k.advance(1);
  assert.equal(await g.nj.call('QUARANTINE_AFTER'), 2n);
  // rejected, agreed, rejected: the streak was reset, no quarantine
  await g.run([['d1', V2], ['d2', V1], ['d3', V1]]);
  await g.run([['d1', V1], ['d2', V1], ['d3', V1]]);
  await g.run([['d1', V2], ['d2', V1], ['d3', V1]]);
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), false);
  // a second rejection in a row: quarantined
  const id = await g.req();
  for (const [w, v] of [['d1', V2], ['d2', V1], ['d3', V1]]) await g.cm(w, id, v);
  await g.rv('d1', id, V2);
  await g.rv('d2', id, V1);
  const ev = await g.rv('d3', id, V1);
  assert.ok(ev.some((e) => e?.name === 'Quarantined' && e.args.worker.toLowerCase() === g.ad('d1').toLowerCase()));
  assert.ok(ev.some((e) => e?.name === 'DefenderVacated' && e.args.seat === 0n));
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), true);
  assert.equal((await g.nj.call('defenders'))[0], '0x' + '00'.repeat(20));
  assert.equal((await g.nj.call('workers', [g.ad('d1')])).active, true); // still bonded, just not trusted
  g.k.advance(1);
  const next = await g.req();
  assert.equal(await g.nj.call('eligible', [next, g.ad('d1')]), false);
  await assert.rejects(g.nj.send('d1', 'commit', [next, V1]), /NotChosen/);
  // regrow does not seat a quarantined runner
  g.k.advance(3600);
  let r = await g.nj.send('user', 'regrow');
  assert.equal(r.filter((e) => e?.name === 'DefenderSeated').length, 0);
  // governance releases it; regrow seats it again
  await assert.rejects(g.ctl.send('d1', 'release', [g.ad('d1')]), /NotGovernance/);
  await g.ctl.send('gov', 'release', [g.ad('d1')]);
  assert.equal(await g.nj.call('quarantined', [g.ad('d1')]), false);
  r = await g.nj.send('user', 'regrow');
  assert.ok(r.some((e) => e?.name === 'DefenderSeated' && e.args.worker.toLowerCase() === g.ad('d1').toLowerCase()));
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
