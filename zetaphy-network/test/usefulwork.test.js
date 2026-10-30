// Useful work (docs/future/useful-work.md): browser scan jobs with a PoW stamp, redundancy and
// commit-reveal (UsefulWork), the workers' reputation (WorkerReputation), bug-hunting bounties
// verified by runners (BugBounty + the deliberately vulnerable VulnerableVault) and the issuance
// share for verified work behind a timelock (UsefulIssuance). The browser's own code
// (zetaphy-hub/work-core.js, fuzz-core.js, mine-core.js) computes the stamps, verdicts and findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeBytes32String, keccak256 as ethKeccak, toUtf8Bytes, ZeroHash, ZeroAddress, getAddress, AbiCoder, hexlify } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain, ZETA } from './helpers/evm.js';
import { workMocks } from './helpers/workmocks.js';
import { neuro, k, scanVerdict, verifyFinding, hunt, findStamp, jobCommitment, canaryCommitment, findingCommitment, findingHash } from '../src/usefulwork.js';
import { calldata, decodeArgs, encodeArgs, JOB_TUPLE, JOB_FIELDS, named, bytes32String, parseBytes32String, PARAM_FIELDS, BOUNTY_TUPLE, FINDING_TUPLE } from '../../zetaphy-hub/work-core.js';
import { findingBytes, ACTORS } from '../../zetaphy-hub/fuzz-core.js';
import { vulnerableVaultSpec, specText, SPEC_FILE, sampleScan, SAMPLE_FILE } from '../scripts/bounty-spec.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const DAY = 86400;
const BITS = 10;
const DEPOSIT = ZETA / 10n;
const PARAMS = {
  stampBits: BITS, stampSeats: 10, stampLife: DAY, seatsPerDay: 50, seats: 3, quorum: 2, commitWindow: 600, revealWindow: 600,
  seatDeposit: DEPOSIT, subsidy: ZETA, priorityScore: 0, priorityWindow: 0,
};
const VAULT_CODE = art('VulnerableVault').deployedBytecode;
const STABLE_CODE = art('TestStable').deployedBytecode;
const codeHash = (code) => ethKeccak(code);
const salt = (n) => '0x' + n.toString(16).padStart(64, '0');
const ZB = (s) => encodeBytes32String(s);

async function world({ params = PARAMS, issuance = false } = {}) {
  const c = await createChain(['gov', 'poster', 'feeder', 'w1', 'w2', 'w3', 'w4', 'faucet', 'sybil']);
  const A = (n) => c.acct[n].toString();
  const m = workMocks();
  const runners = await c.deployRaw(m.MockRunners, [], 'gov');
  const ident = await c.deployRaw(m.MockIdentity, [], 'gov');
  const rep = await c.deploy('WorkerReputation', [A('gov'), runners.address, ident.address], 'gov');
  let iss = null, tl = null;
  if (issuance) {
    tl = await c.deploy('ZetaphyTimelock', [2 * DAY, [A('gov')], [ZeroAddress], ZeroAddress], 'gov');
    iss = await c.deploy('UsefulIssuance', [tl.address, A('faucet')], 'gov');
  }
  const uw = await c.deploy('UsefulWork', [A('gov'), rep.address, iss ? iss.address : ZeroAddress, params], 'gov');
  await rep.send('gov', 'setReporter', [uw.address, true]);
  await uw.send('gov', 'setFeeder', [A('feeder'), true]);
  const govern = async (target, fn, args) => {
    const data = target.iface.encodeFunctionData(fn, args);
    await tl.send('gov', 'schedule', [target.address, 0, data, ZeroHash, ZeroHash, 2 * DAY]);
    c.advance(2 * DAY);
    return tl.send('w4', 'execute', [target.address, 0, data, ZeroHash, ZeroHash]);
  };
  return { c, A, runners, ident, rep, uw, iss, tl, govern };
}

/** A worker earns seats: PoW over the contract's stamp seed, as the browser does. */
async function stampFor(w, who, bits = BITS) {
  const h = w.c.blockNumber() - 1n;
  const seed = await w.uw.call('stampSeed', [h]);
  const nonce = findStamp(1, seed, w.A(who), bits); // the test EVM's chain id is 1
  return w.uw.send(who, 'stamp', [h, nonce]);
}

const scan = (code, target = '0x' + '12'.repeat(20), chain = 'zetaphy') => scanVerdict({ chain, target, code, codeHash: codeHash(code) });

// ------------------------------------------------------------------ the browser's shared code
test('work-core: the ABI codec matches ethers, and the commitments match the contracts', async () => {
  const w = await world();
  const coder = AbiCoder.defaultAbiCoder();
  const vals = [7n, [1n, 2n], ['0x' + 'aa'.repeat(32)], 'héllo', '0x0102', true, w.A('w1')];
  const types = ['uint256', 'uint256[]', 'bytes32[]', 'string', 'bytes', 'bool', 'address'];
  assert.equal(encodeArgs(types, vals), coder.encode(types, vals));
  const back = decodeArgs(types, coder.encode(types, vals));
  assert.deepEqual(back.slice(0, 6), vals.slice(0, 6));
  assert.equal(getAddress(back[6]), w.A('w1'));
  assert.equal(calldata(k, 'commitMany(uint256[],bytes32[])', [[1n], [ZeroHash]]), w.uw.iface.encodeFunctionData('commitMany', [[1n], [ZeroHash]]));
  const v = '0x' + '77'.repeat(32);
  assert.equal(jobCommitment(k, v, w.A('w1'), salt(5), 9n), await w.uw.call('commitmentOf', [v, w.A('w1'), salt(5), 9n]));
  assert.equal(bytes32String('zetaphy'), ZB('zetaphy'));
  assert.equal(parseBytes32String(ZB('bsc')), 'bsc');
  // the Job tuple the page decodes is the contract's
  const fn = w.uw.iface.getFunction('getJob');
  assert.equal(`(${fn.outputs[0].components.map((p) => p.type).join(',')})`, JOB_TUPLE);
  assert.deepEqual(fn.outputs[0].components.map((p) => p.name), JOB_FIELDS);
  assert.deepEqual(w.uw.iface.getFunction('params').outputs.map((p) => p.name), PARAM_FIELDS);
  const bb = new (await import('ethers')).Interface(art('BugBounty').abi);
  assert.equal(`(${bb.getFunction('getBounty').outputs[0].components.map((p) => p.type).join(',')})`, BOUNTY_TUPLE);
  assert.equal(`(${bb.getFunction('getFinding').outputs[0].components.map((p) => p.type).join(',')})`, FINDING_TUPLE);
});

test('the code-only scan: same code, same verdict; any other code or a changed code is refused or differs', async () => {
  const a = await scan(VAULT_CODE);
  const b = await scan(VAULT_CODE);
  assert.match(a.verdict, /^0x[0-9a-f]{64}$/);
  assert.equal(a.verdict, b.verdict, 'deterministic');
  assert.notEqual((await scan(STABLE_CODE)).verdict, a.verdict);
  await assert.rejects(scanVerdict({ chain: 'zetaphy', target: '0x' + '12'.repeat(20), code: VAULT_CODE, codeHash: codeHash(STABLE_CODE) }), /changed/);
  await assert.rejects(scanVerdict({ chain: 'sol', target: '0x' + '12'.repeat(20), code: VAULT_CODE, codeHash: codeHash(VAULT_CODE) }), /not an EVM chain/);
  assert.ok(a.report.unknownSelectors.includes('8129fc1c'), 'the scan reads the dispatcher (initialize())');
  // same verdict for a job on another EVM chain key reading the same code? no: the chain is part of it
  assert.notEqual((await scan(VAULT_CODE, '0x' + '12'.repeat(20), 'bsc')).verdict, a.verdict);
});

// ------------------------------------------------------------------ UsefulWork
test('stamp: a PoW over a recent block seed buys seats; weak, reused, stale or borrowed stamps do not', async () => {
  const w = await world();
  await assert.rejects(w.uw.send('w1', 'commit', [0n, ZeroHash], DEPOSIT), /BadJob/);
  const ev = await stampFor(w, 'w1');
  assert.ok(ev.some((e) => e?.name === 'Stamped'));
  assert.equal((await w.uw.call('credits', [w.A('w1')])).seats, 10n);
  // the same proof twice
  const h = w.c.blockNumber() - 1n;
  const seed = await w.uw.call('stampSeed', [h]);
  const nonce = findStamp(1, seed, w.A('w2'), BITS);
  await w.uw.send('w2', 'stamp', [h, nonce]);
  await assert.rejects(w.uw.send('w2', 'stamp', [h, nonce]), /StampUsed/);
  // another address cannot use w2's proof (the address is in the hash)
  let failed = 0;
  try { await w.uw.send('w3', 'stamp', [h, nonce]); } catch (e) { failed++; assert.match(e.message, /StampWeak|StampUsed/); }
  assert.equal(failed, 1);
  // too few zero bits: a nonce that is not a proof
  const h2 = w.c.blockNumber() - 1n;
  const seed2 = await w.uw.call('stampSeed', [h2]);
  const good = findStamp(1, seed2, w.A('w3'), BITS);
  await assert.rejects(w.uw.send('w3', 'stamp', [h2, good + 1n]), /StampWeak/);
  // a block older than 256 blocks, or a future one
  w.c.mine(300);
  await assert.rejects(w.uw.send('w3', 'stamp', [h2, good]), /StampTooOld/);
  await assert.rejects(w.uw.send('w3', 'stamp', [w.c.blockNumber() + 5n, 0n]), /StampTooOld/);
  // a faucet proof (sha256 over the raw block hash) is not a stamp: the seed is keccak(blockhash, this)
  assert.notEqual(seed2, ZeroHash);
});

test('three browsers scan, commit, reveal and agree: each gets its deposit and a third of the fee; reputation rises', async () => {
  const w = await world();
  await w.uw.send('poster', 'post', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0], 3n * ZETA);
  for (const x of ['w1', 'w2', 'w3']) await stampFor(w, x);
  const { verdict } = await scan(VAULT_CODE);
  for (const [i, x] of ['w1', 'w2', 'w3'].entries()) {
    await w.uw.send(x, 'commit', [0n, jobCommitment(k, verdict, w.A(x), salt(i + 1), 0n)], DEPOSIT);
  }
  assert.equal(await w.uw.call('phase', [0n]), 1n, 'seats full: reveal');
  await assert.rejects(stampFor(w, 'w4').then(() => w.uw.send('w4', 'commit', [0n, salt(9)], DEPOSIT)), /Closed/);
  // a copier cannot reuse another's commitment: it is bound to the worker
  await assert.rejects(w.uw.send('w1', 'reveal', [0n, verdict, salt(2)]), /BadReveal/);
  for (const [i, x] of ['w1', 'w2', 'w3'].entries()) await w.uw.send(x, 'reveal', [0n, verdict, salt(i + 1)]);
  const before = await w.c.balance('w1');
  const ev = await w.uw.send('w4', 'settle', [0n]);
  const s = ev.find((e) => e?.name === 'Settled');
  assert.equal(s.args.result, verdict);
  assert.equal(s.args.agreed, 3n);
  assert.equal(s.args.paidEach, ZETA);
  assert.equal(await w.uw.call('owed', [w.A('w1')]), ZETA + DEPOSIT);
  await w.uw.send('w1', 'withdraw');
  assert.equal(await w.c.balance('w1'), before + ZETA + DEPOSIT);
  const job = named(JOB_FIELDS, await w.uw.call('getJob', [0n]));
  assert.equal(job.result, verdict);
  assert.equal(job.settled, true);
  assert.equal((await w.rep.call('recordOf', [w.A('w2')])).agreed, 1n);
  assert.equal(await w.rep.call('scoreOf', [w.A('w2')]), 1000n / 6n); // 1 good, prior 5
});

test('a wrong answer, a missing reveal, and no majority', async () => {
  const w = await world();
  for (const x of ['w1', 'w2', 'w3']) await stampFor(w, x);
  const { verdict } = await scan(VAULT_CODE);
  const wrong = '0x' + 'ee'.repeat(32);
  // job 0: w3 lies; job 1: w3 never reveals; job 2: everyone differs
  for (let id = 0n; id < 3n; id++) await w.uw.send('poster', 'post', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0], ZETA);
  const answers = { 0: [verdict, verdict, wrong], 1: [verdict, verdict, verdict], 2: [verdict, wrong, '0x' + 'dd'.repeat(32)] };
  for (const id of [0, 1, 2]) {
    for (const [i, x] of ['w1', 'w2', 'w3'].entries()) await w.uw.send(x, 'commit', [BigInt(id), jobCommitment(k, answers[id][i], w.A(x), salt(10 * id + i + 1), BigInt(id))], DEPOSIT);
    for (const [i, x] of ['w1', 'w2', 'w3'].entries()) {
      if (id === 1 && x === 'w3') continue;
      await w.uw.send(x, 'reveal', [BigInt(id), answers[id][i], salt(10 * id + i + 1)]);
    }
  }
  await w.uw.send('w4', 'settle', [0n]);
  await assert.rejects(w.uw.send('w4', 'settle', [1n]), /TooEarly/, 'w3 may still reveal');
  w.c.advance(601);
  await w.uw.send('w4', 'settle', [1n]);
  const ev = await w.uw.send('w4', 'settle', [2n]);
  assert.equal(ev.find((e) => e?.name === 'Settled').args.result, ZeroHash);
  const r3 = await w.rep.call('recordOf', [w.A('w3')]);
  assert.deepEqual([r3.agreed, r3.disagreed, r3.missed], [0n, 1n, 1n]);
  // w1: half of 1 ZETA twice + deposits back 3 times (job 2: no accepted answer, deposit back)
  assert.equal(await w.uw.call('owed', [w.A('w1')]), ZETA + 3n * DEPOSIT);
  assert.equal(await w.uw.call('owed', [w.A('poster')]), ZETA, 'no majority: the fee goes back');
  assert.equal(await w.uw.call('reserve'), 2n * DEPOSIT, "w3's two lost deposits fund subsidies");
  assert.ok((await w.rep.call('scoreOf', [w.A('w3')])) === 0n);
});

test('a canary (known-answer job) catches workers that agree on a wrong answer', async () => {
  const w = await world();
  for (const x of ['w1', 'w2', 'w3']) await stampFor(w, x);
  const { verdict } = await scan(VAULT_CODE);
  const lazy = '0x' + '00'.repeat(31) + '01'; // two colluders answer a constant without scanning
  await assert.rejects(w.uw.send('poster', 'postFeeder', [ZB('zetaphy'), '0xab', codeHash(VAULT_CODE), 0, true, ZeroHash]), /NotFeeder/);
  await w.uw.send('feeder', 'postFeeder', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0, false, canaryCommitment(k, verdict, salt(77), 0n)], 0n);
  await assert.rejects(w.uw.send('feeder', 'revealCanary', [0n, verdict, salt(77)]), /TooEarly/, 'not while seats are open');
  const ans = { w1: lazy, w2: lazy, w3: verdict };
  for (const [i, x] of ['w1', 'w2', 'w3'].entries()) await w.uw.send(x, 'commit', [0n, jobCommitment(k, ans[x], w.A(x), salt(i + 1), 0n)], DEPOSIT);
  for (const [i, x] of ['w1', 'w2', 'w3'].entries()) await w.uw.send(x, 'reveal', [0n, ans[x], salt(i + 1)]);
  await assert.rejects(w.uw.send('w4', 'settle', [0n]), /TooEarly/, 'waits for the canary');
  await assert.rejects(w.uw.send('feeder', 'revealCanary', [0n, lazy, salt(77)]), /BadReveal/);
  await w.uw.send('feeder', 'revealCanary', [0n, verdict, salt(77)]);
  const ev = await w.uw.send('w4', 'settle', [0n]);
  assert.equal(ev.find((e) => e?.name === 'Settled').args.result, verdict);
  assert.equal((await w.rep.call('recordOf', [w.A('w1')])).slashed, 1n);
  assert.equal((await w.rep.call('recordOf', [w.A('w3')])).agreed, 1n);
  assert.equal(await w.uw.call('owed', [w.A('w1')]), 0n);
  assert.equal(await w.uw.call('owed', [w.A('w3')]), DEPOSIT);
});

test('reputation gates important jobs: minScore, and the priority window for proven workers', async () => {
  const w = await world({ params: { ...PARAMS, priorityScore: 400, priorityWindow: 300 } });
  await w.runners.send('gov', 'set', [w.A('w1'), true, 20, 0]); // a NeuroJobs runner's record counts
  assert.equal(await w.rep.call('scoreOf', [w.A('w1')]), 800n); // 1000*20/25
  for (const x of ['w1', 'w2']) await stampFor(w, x);
  await w.uw.send('poster', 'post', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0], ZETA);
  await w.uw.send('poster', 'post', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 700], ZETA);
  await assert.rejects(w.uw.send('w2', 'commit', [0n, salt(1)], DEPOSIT), /LowScore/, 'priority window');
  await w.uw.send('w1', 'commit', [0n, salt(1)], DEPOSIT);
  w.c.advance(301);
  await w.uw.send('w2', 'commit', [0n, salt(2)], DEPOSIT);
  await assert.rejects(w.uw.send('w2', 'commit', [1n, salt(2)], DEPOSIT), /LowScore/, 'minScore 700');
  await w.uw.send('w1', 'commit', [1n, salt(3)], DEPOSIT);
});

test('sybil limits: no stamp no seat, seats per day, exact deposits, commitMany/revealMany in one transaction each', async () => {
  const w = await world({ params: { ...PARAMS, seatsPerDay: 2 } });
  for (let i = 0; i < 3; i++) await w.uw.send('poster', 'post', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0], ZETA);
  await assert.rejects(w.uw.send('sybil', 'commit', [0n, salt(1)], DEPOSIT), /NoCredit/);
  await stampFor(w, 'w1');
  await assert.rejects(w.uw.send('w1', 'commit', [0n, salt(1)], 0n), /BadValue/);
  const { verdict } = await scan(VAULT_CODE);
  const cs = [0n, 1n].map((id) => jobCommitment(k, verdict, w.A('w1'), salt(Number(id) + 1), id));
  await assert.rejects(w.uw.send('w1', 'commitMany', [[0n, 1n], cs], DEPOSIT), /BadValue/);
  await w.uw.send('w1', 'commitMany', [[0n, 1n], cs], 2n * DEPOSIT);
  await assert.rejects(w.uw.send('w1', 'commit', [2n, salt(3)], DEPOSIT), /DayFull/);
  assert.deepEqual([...await w.uw.call('openJobs', [0n, 10n])], [0n, 1n, 2n]);
  w.c.advance(601); // the commit window ends with one seat each: reveal
  assert.deepEqual([...await w.uw.call('openJobs', [0n, 10n])], []);
  await w.uw.send('w1', 'revealMany', [[0n, 1n], [verdict, verdict], [salt(1), salt(2)]]);
  w.c.advance(601);
  await w.uw.send('w4', 'settle', [0n]);
  // one seat cannot reach a quorum of 2: no result, deposit back, fee back
  assert.equal(named(JOB_FIELDS, await w.uw.call('getJob', [0n])).result, ZeroHash);
});

test('bad parameters are refused; only governance sets them', async () => {
  const w = await world();
  for (const bad of [{ seats: 1 }, { seats: 6 }, { quorum: 1 }, { stampBits: 4 }, { stampBits: 60 }, { priorityWindow: 600 }, { revealWindow: 0 }]) {
    await assert.rejects(w.uw.send('gov', 'setParams', [{ ...PARAMS, ...bad }]), /BadParams/, JSON.stringify(bad));
  }
  await assert.rejects(w.uw.send('w1', 'setParams', [PARAMS]), /NotGovernance/);
  await assert.rejects(w.uw.send('w1', 'setFeeder', [w.A('w1'), true]), /NotGovernance/);
});

// ------------------------------------------------------------------ WorkerReputation
test('reputation: only reporters write; governance slashes; ERC-8004 summary for a linked agent', async () => {
  const w = await world();
  await assert.rejects(w.rep.send('w1', 'record', [w.A('w2'), 0, ZeroHash]), /NotReporter/);
  await assert.rejects(w.rep.send('w1', 'setReporter', [w.A('w1'), true]), /NotGovernance/);
  await w.rep.send('gov', 'setReporter', [w.A('feeder'), true]);
  for (let i = 0; i < 15; i++) await w.rep.send('feeder', 'record', [w.A('w2'), 0, ZeroHash]);
  assert.equal(await w.rep.call('scoreOf', [w.A('w2')]), 750n); // 15 / 20
  await w.rep.send('gov', 'slash', [w.A('w2'), ZeroHash]);
  assert.equal(await w.rep.call('scoreOf', [w.A('w2')]), 1000n * 15n / 25n);
  await assert.rejects(w.rep.send('w2', 'linkAgent', [7n]), /NotAgentOwner/);
  await w.ident.send('gov', 'set', [7n, w.A('w2')]);
  await w.rep.send('w2', 'linkAgent', [7n]);
  const [count, avg] = await w.rep.call('getSummary', [7n]);
  assert.equal(count, 20n); // 15 good + 5 (one slash)
  assert.equal(avg, 60n);
  // the agent moves to another worker: the link follows the owner
  await w.ident.send('gov', 'set', [7n, w.A('w3')]);
  await w.rep.send('w3', 'linkAgent', [7n]);
  assert.equal(await w.rep.call('agentOfWorker', [w.A('w2')]), 0n);
  assert.equal(getAddress(await w.rep.call('workerOfAgent', [7n])), w.A('w3'));
});

// ------------------------------------------------------------------ UsefulIssuance
test('issuance: needs a timelock (2+ days), splits into capped buckets, sinks pull only for verified work', async () => {
  const w = await world({ issuance: true });
  const m = workMocks();
  const short = await w.c.deployRaw(m.MockShortTimelock, [], 'gov');
  await assert.rejects(w.c.deploy('UsefulIssuance', [w.A('gov'), w.A('faucet')], 'gov'), /deploy failed/, 'an EOA is not a timelock');
  await assert.rejects(w.c.deploy('UsefulIssuance', [short.address, w.A('faucet')], 'gov'), /deploy failed/, 'a 1-hour delay is too short');
  // a bucket for UsefulWork (60%, cap 100) and one for a bounty market (30%); 10% straight to overflow
  const buckets = [{ sink: w.uw.address, bps: 6000, cap: 100n * ZETA, accrued: 0n }, { sink: w.A('w4'), bps: 3000, cap: 1000n * ZETA, accrued: 0n }];
  await assert.rejects(w.iss.send('gov', 'setBuckets', [buckets]), /NotGovernance/, 'not without the timelock');
  await w.govern(w.iss, 'setBuckets', [buckets]);
  // RewardVault pays the issuance its share of each day's release through fund()
  const vault = await w.c.deploy('RewardVault', [w.A('gov'), [{ to: w.iss.address, bps: 2500, callFund: true }, { to: w.A('faucet'), bps: 7500, callFund: false }]], 'gov');
  await vault.sendValue('gov', 1_000_000n * ZETA);
  w.c.advance(365 * DAY);
  const rel = (await vault.send('w4', 'release')).find((e) => e?.name === 'Released').args.amount;
  const toIss = rel / 4n;
  const [b0, b1] = await w.iss.call('buckets');
  assert.equal(b0.accrued, 100n * ZETA, 'capped');
  assert.ok(b1.accrued > 0n && b1.accrued <= toIss * 3n / 10n);
  assert.equal(await w.iss.call('pendingOverflow'), toIss - b0.accrued - b1.accrued);
  const f0 = await w.c.balance('faucet');
  await w.iss.send('w1', 'sweepOverflow');
  assert.ok((await w.c.balance('faucet')) > f0);
  await assert.rejects(w.iss.send('w1', 'draw', [ZETA]), /NotSink/);
  // UsefulWork draws a subsidy only when a subsidized job settles with agreeing seats
  for (const x of ['w1', 'w2']) await stampFor(w, x);
  await w.uw.send('feeder', 'postFeeder', [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0, true, ZeroHash], 0n);
  const { verdict } = await scan(VAULT_CODE);
  for (const [i, x] of ['w1', 'w2'].entries()) await w.uw.send(x, 'commit', [0n, jobCommitment(k, verdict, w.A(x), salt(i + 1), 0n)], DEPOSIT);
  w.c.advance(601);
  for (const [i, x] of ['w1', 'w2'].entries()) await w.uw.send(x, 'reveal', [0n, verdict, salt(i + 1)]);
  w.c.advance(601);
  await w.uw.send('w4', 'settle', [0n]);
  assert.equal(await w.uw.call('owed', [w.A('w1')]), ZETA + DEPOSIT, 'one ZETAPHY subsidy per agreeing seat');
  assert.equal(await w.iss.call('available', [w.uw.address]), 98n * ZETA);
  // governance itself can only move to another timelock
  await assert.rejects(w.govern(w.iss, 'setGovernance', [w.A('gov')]), /NotTimelock|revert|Error/); // the timelock bubbles the revert
  // removing a bucket sends its unspent money to overflow
  const pend = await w.iss.call('pendingOverflow');
  await w.govern(w.iss, 'setBuckets', [[buckets[1]]]);
  assert.equal(await w.iss.call('pendingOverflow'), pend + 98n * ZETA);
  assert.deepEqual(w.iss.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name).filter((n) => /withdraw|mint/i.test(n)), [], 'no withdraw, no mint');
});

// ------------------------------------------------------------------ BugBounty + VulnerableVault
async function bountyWorld() {
  const w = await world({ issuance: true });
  const bb = await w.c.deploy('BugBounty', [w.runners.address, 2, 3, w.A('gov'), w.rep.address, w.iss.address, DEPOSIT, 3600, 3 * DAY], 'gov');
  await w.rep.send('gov', 'setReporter', [bb.address, true]);
  for (const r of ['w2', 'w3', 'w4']) await w.runners.send('gov', 'set', [w.A(r), true, 10, 1]);
  await w.govern(w.iss, 'setBuckets', [[{ sink: bb.address, bps: 10000, cap: 1000n * ZETA, accrued: 0n }]]);
  await w.iss.send('gov', 'fund', [], 50n * ZETA);
  return { ...w, bb };
}

test('the spec file in zetaphy-hub/bounties is the one built from the artifact', () => {
  assert.equal(readFileSync(SPEC_FILE, 'utf8'), specText(vulnerableVaultSpec()), 'run node scripts/bounty-spec.js');
  assert.equal(readFileSync(SAMPLE_FILE, 'utf8'), specText(sampleScan()), 'run node scripts/bounty-spec.js');
});

test('bug hunt: the browser fuzzer finds the deliberate bug; commit-reveal; runners verify; the earliest valid finding is paid', async () => {
  const w = await bountyWorld();
  const text = readFileSync(SPEC_FILE, 'utf8');
  const sh = ethKeccak(toUtf8Bytes(text));
  await w.bb.send('poster', 'post', [sh, 'bounties/vulnerable-vault.json', 7 * DAY], 10n * ZETA);
  await w.bb.send('gov', 'setSubsidy', [0n, 5n * ZETA]);
  // the hunt (same code as the browser's Web Worker)
  // the spec has several invariants: an owner takeover alone (initialize()) is a finding too; hunt on
  // until the attacker gains coins
  const all = await hunt(text, { seed: 7, runs: 2000, stopOnFirst: false, want: ['attacker-profit'] });
  assert.ok(all.findings.some((f) => f.kinds.includes('privileged-unchanged')), 'the owner takeover');
  const res = all.findings.find((f) => f.kinds.includes('attacker-profit'));
  assert.ok(res?.finding, 'found');
  assert.deepEqual(res.finding.steps.map((s) => s.sig), ['initialize()', 'sweep(address)']);
  assert.equal(res.finding.steps[1].args[0], ACTORS.attacker);
  assert.equal(res.profit, 5n * ZETA);
  const bytes = findingBytes(res.finding);
  const fh = findingHash(k, res.finding);
  // w1 commits first; a copier (sybil) commits the same finding later
  const fid = await w.bb.call('findingCount');
  await w.bb.send('w1', 'commitFinding', [0n, findingCommitment(k, fh, w.A('w1'), salt(1), 0n)], DEPOSIT);
  await w.bb.send('sybil', 'commitFinding', [0n, findingCommitment(k, fh, w.A('sybil'), salt(2), 0n)], DEPOSIT);
  // the copier cannot reuse w1's commitment as its own: it is bound to the finder
  assert.equal(await w.bb.call('commitmentOf', [fh, w.A('w1'), salt(1), 0n]), findingCommitment(k, fh, w.A('w1'), salt(1), 0n));
  await assert.rejects(w.bb.send('w1', 'commitFinding', [0n, salt(3)], 0n), /BadValue/);
  await w.bb.send('w1', 'revealFinding', [fid, hexlify(bytes), salt(1)]);
  await w.bb.send('sybil', 'revealFinding', [fid + 1n, hexlify(bytes), salt(2)]);
  // runners replay it against the spec, then attest
  const check = await verifyFinding({ specText: text, finding: bytes, expectSpecHash: sh, expectFindingHash: fh });
  assert.equal(check.valid, true);
  assert.equal((await verifyFinding({ specText: text + ' ', finding: bytes, expectSpecHash: sh })).valid, false, 'another spec');
  await assert.rejects(w.bb.send('w1', 'attest', [fid, true]), /NotRunner/, 'the finder is no runner here');
  await assert.rejects(w.bb.send('sybil', 'attest', [fid, true]), /NotRunner/);
  await w.bb.send('w2', 'attest', [fid + 1n, true]);
  await w.bb.send('w3', 'attest', [fid + 1n, true]);
  // the copier's finding is accepted, but w1 committed first and is still being judged
  await assert.rejects(w.bb.send('sybil', 'claim', [fid + 1n]), /TooEarly/);
  await w.bb.send('w2', 'attest', [fid, true]);
  await assert.rejects(w.bb.send('w2', 'attest', [fid, true]), /AlreadyVoted/);
  await w.bb.send('w4', 'attest', [fid, true]);
  const ev = await w.bb.send('w4', 'claim', [fid]);
  assert.equal(ev.find((e) => e?.name === 'BountyPaid').args.amount, 15n * ZETA, 'reward + subsidy');
  assert.equal(await w.bb.call('owed', [w.A('w1')]), 15n * ZETA + DEPOSIT);
  await w.bb.send('w4', 'claim', [fid + 1n]);
  assert.equal(await w.bb.call('owed', [w.A('sybil')]), DEPOSIT, 'a later duplicate: deposit back only');
  assert.equal((await w.rep.call('recordOf', [w.A('w1')])).bugValid, 1n);
});

test('bug hunt: same-block reveal, wrong reveal, a rejected finding, and the sponsor refund', async () => {
  const w = await bountyWorld();
  const text = readFileSync(SPEC_FILE, 'utf8');
  await w.bb.send('poster', 'post', [ethKeccak(toUtf8Bytes(text)), 'bounties/vulnerable-vault.json', DAY], 10n * ZETA);
  const bogus = { v: 1, steps: [{ sig: 'withdraw(uint256)', args: ['0'], value: '0' }] };
  const check = await verifyFinding({ specText: text, finding: findingBytes(bogus) });
  assert.equal(check.valid, false);
  const fh = findingHash(k, bogus);
  await w.bb.send('w1', 'commitFinding', [0n, findingCommitment(k, fh, w.A('w1'), salt(1), 0n)], DEPOSIT);
  await assert.rejects(w.bb.send('w1', 'revealFinding', [0n, hexlify(findingBytes(bogus)), salt(2)]), /BadReveal/);
  await w.bb.send('w1', 'revealFinding', [0n, hexlify(findingBytes(bogus)), salt(1)]);
  await w.bb.send('w2', 'attest', [0n, false]);
  await w.bb.send('w3', 'attest', [0n, false]);
  assert.equal((await w.bb.call('getFinding', [0n])).state, 4n);
  assert.equal((await w.bb.call('getBounty', [0n])).reward, 10n * ZETA + DEPOSIT, 'the wrong finding\'s deposit grows the reward');
  assert.equal((await w.rep.call('recordOf', [w.A('w1')])).bugInvalid, 1n);
  await assert.rejects(w.bb.send('poster', 'refund', [0n]), /TooEarly/);
  w.c.advance(DAY + 3600 + 3 * DAY + 1);
  await assert.rejects(w.bb.send('w1', 'commitFinding', [0n, salt(5)], DEPOSIT), /Closed/);
  await w.bb.send('w4', 'refund', [0n]);
  // BB-1: the wrong finding's deposit grew the reward for a winner; nobody won, so it is burned, not refunded
  assert.equal(await w.bb.call('owed', [w.A('poster')]), 10n * ZETA);
  assert.equal(await w.bb.call('burned'), DEPOSIT);
  await assert.rejects(w.bb.send('poster', 'commitFinding', [0n, salt(6)], DEPOSIT), /Closed|BadFinding/);
});

test('the deliberately vulnerable vault really is vulnerable on the EVM (and honest use works)', async () => {
  const c = await createChain(['deployer', 'victim', 'attacker']);
  const v = await c.deploy('VulnerableVault', [], 'deployer');
  await v.send('victim', 'deposit', [], 5n * ZETA);
  await v.send('victim', 'withdraw', [ZETA]);
  await assert.rejects(v.send('attacker', 'withdraw', [ZETA]), /Error|revert/);
  const before = await c.balance('attacker');
  await v.send('attacker', 'initialize');
  await v.send('attacker', 'sweep', [c.acct.attacker.toString()]);
  assert.equal(await c.balance('attacker'), before + 4n * ZETA);
  assert.equal(await c.balance(Address.fromString(v.address)), 0n);
});

test('pause: stamps, posts and seats stop; reveals, settle and withdraw go on; the guardian only pauses', async () => {
  const w = await world();
  const { verdict } = await scan(VAULT_CODE);
  const job = [ZB('zetaphy'), '0x' + '12'.repeat(20), codeHash(VAULT_CODE), 0];
  await w.uw.send('poster', 'post', job, ZETA);
  for (const who of ['w1', 'w2']) {
    await stampFor(w, who);
    await w.uw.send(who, 'commit', [0n, jobCommitment(k, verdict, w.A(who), salt(1), 0n)], DEPOSIT);
  }
  await assert.rejects(w.uw.send('w4', 'setGuardian', [w.A('w4')]), /NotGovernance/);
  await w.uw.send('gov', 'setGuardian', [w.A('w4')]);
  await w.uw.send('w4', 'setPaused', [true]);
  assert.equal(await w.uw.call('paused'), true);
  await assert.rejects(w.uw.send('w4', 'setPaused', [false]), /NotGovernance/, 'the guardian cannot unpause');
  await assert.rejects(stampFor(w, 'w3'), /Paused/);
  await assert.rejects(w.uw.send('poster', 'post', job, ZETA), /Paused/);
  await assert.rejects(w.uw.send('feeder', 'postFeeder', [...job, true, ZeroHash], ZETA), /Paused/);
  await assert.rejects(w.uw.send('w3', 'commit', [0n, salt(9)], DEPOSIT), /Paused/);
  w.c.advance(601); // the commit window closes: the seated workers reveal while paused
  for (const who of ['w1', 'w2']) await w.uw.send(who, 'reveal', [0n, verdict, salt(1)]);
  w.c.advance(601);
  await w.uw.send('w3', 'settle', [0n]);
  assert.ok((await w.uw.call('owed', [w.A('w1')])) > DEPOSIT);
  await w.uw.send('w1', 'withdraw');
  await w.uw.send('gov', 'setPaused', [false]);
  await w.uw.send('poster', 'post', job, ZETA);
});

test('cli: zetaphy work verify-finding replays a finding offline', async () => {
  const { main } = await import('../cli.js');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/uw-`);
  try {
    const good = `${dir}/good.json`, bad = `${dir}/bad.json`;
    writeFileSync(good, JSON.stringify({ v: 1, steps: [{ sig: 'initialize()', args: [], value: '0' }, { sig: 'sweep(address)', args: [ACTORS.attacker], value: '0' }] }));
    writeFileSync(bad, JSON.stringify({ v: 1, steps: [{ sig: 'deposit()', args: [], value: '5' }, { sig: 'withdraw(uint256)', args: ['5'], value: '0' }] }));
    const out = [];
    assert.equal(await main(['work', 'verify-finding', SPEC_FILE.pathname, good], {}, (l) => out.push(l)), 0);
    assert.match(out.join('\n'), /^VALID/);
    assert.equal(await main(['work', 'verify-finding', SPEC_FILE.pathname, bad], {}, (l) => out.push(l)), 1);
    assert.match(out.at(-1), /NOT VALID/);
    assert.equal(typeof neuro.readContract, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
