// Useful work on the real testnet (docs/future/useful-work.md, item 5): `zetaphy deploy-useful-work` deploys
// the four contracts PAUSED and hands every admin role to the timelock; the proposals it prints open them
// after the delay; the job feeder (a scheduled Action) posts scan jobs and canaries, reveals the canaries
// with salts derived from its key (nothing stored) and settles. Real signed transactions (ethers) against
// an in-memory chain at chain id 77390.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContractFactory, keccak256, getAddress, ZeroHash, parseEther } from 'ethers';
import { createRpcChain, ZETA } from './helpers/rpcchain.js';
import { workMocks } from './helpers/workmocks.js';
import { deployUsefulWork, openProposals, feedRound, canarySalt, canaryCommitmentOf, launchDefaults, MIN_TIMELOCK_DELAY, newContracts } from '../src/usefulworkops.js';
import { scanVerdict } from '../src/usefulwork.js';

const DAY = 86400;
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));

async function setup({ delay = 2 * DAY } = {}) {
  const c = await createRpcChain({ accounts: 6 });
  const [deployer, proposer, feeder, guardian, anyone, overflow] = c.signers;
  const m = workMocks();
  const jobs = await new ContractFactory(m.MockRunners.abi, m.MockRunners.bytecode, deployer).deploy();
  await jobs.waitForDeployment();
  const tl = await c.deploy('ZetaphyTimelock', [delay, [proposer.address], ['0x0000000000000000000000000000000000000000'], '0x0000000000000000000000000000000000000000'], deployer);
  return { c, deployer, proposer, feeder, guardian, anyone, overflow, jobs: await jobs.getAddress(), tl, timelock: await tl.getAddress() };
}

/** Schedules and (after the delay) executes the proposals, as the timelock's proposer would. */
async function runProposals(w, proposals) {
  for (const p of proposals) await (await w.tl.connect(w.proposer).schedule(p.target, 0, p.data, p.predecessor, p.salt, await w.tl.getMinDelay())).wait();
  w.c.advance(Number(await w.tl.getMinDelay()) + 1);
  for (const p of proposals) await (await w.tl.connect(w.anyone).execute(p.target, 0, p.data, p.predecessor, p.salt)).wait();
}

test('deploy-useful-work: paused, owned by the timelock, guardian can only pause; the proposals open it', async () => {
  const w = await setup();
  const logs = [];
  const d = await deployUsefulWork({ signer: w.deployer, timelock: w.timelock, jobs: w.jobs, feeder: w.feeder.address, guardian: w.guardian.address, overflow: w.overflow.address, log: (l) => logs.push(l) });
  assert.equal(d.chainId, 77390);
  assert.equal(d.paused, true);
  const uw = w.c.at('UsefulWork', d.contracts.usefulWork, w.anyone);
  const bb = w.c.at('BugBounty', d.contracts.bugBounty, w.anyone);
  const rep = w.c.at('WorkerReputation', d.contracts.workerReputation, w.anyone);
  const iss = w.c.at('UsefulIssuance', d.contracts.usefulIssuance, w.anyone);
  for (const x of [uw, bb, rep, iss]) assert.equal(getAddress(await x.governance()), w.timelock);
  assert.equal(await uw.paused(), true);
  assert.equal(await bb.paused(), true);
  assert.equal(await uw.feeders(w.feeder.address), true);
  assert.equal(await rep.reporters(d.contracts.usefulWork), true);
  assert.equal(await rep.reporters(d.contracts.bugBounty), true);
  // the deployer kept nothing
  await assert.rejects(uw.connect(w.deployer).setPaused.staticCall(false), (e) => uw.interface.parseError(e.data)?.name === 'NotGovernance');
  await assert.rejects(bb.connect(w.guardian).setPaused.staticCall(false), (e) => bb.interface.parseError(e.data)?.name === 'NotGovernance', 'the guardian cannot unpause');
  // paused: nothing can be posted or stamped
  await assert.rejects(uw.connect(w.feeder).postFeeder.staticCall('0x' + '7a'.repeat(1) + '00'.repeat(31), 'x', ZeroHash.replace(/0$/, '1'), 0, false, ZeroHash, { value: ZETA }), (e) => uw.interface.parseError(e.data)?.name === 'Paused');
  await assert.rejects(bb.connect(w.anyone).post.staticCall(keccak256('0x01'), 'bounties/x.json', DAY, { value: ZETA }), (e) => bb.interface.parseError(e.data)?.name === 'Paused');
  // the proposals: buckets, then unpause both
  assert.deepEqual(d.proposals.map((p) => p.what.split(' ')[0]), ['UsefulIssuance.setBuckets', 'UsefulWork.setPaused(false):', 'BugBounty.setPaused(false):']);
  for (const p of d.proposals) assert.equal(p.id, await w.tl.hashOperation(p.target, 0, p.data, p.predecessor, p.salt));
  await runProposals(w, d.proposals);
  assert.equal(await uw.paused(), false);
  assert.equal(await bb.paused(), false);
  assert.equal((await iss.buckets()).length, 2);
  // the guardian's brake: pause at once, no delay
  await (await bb.connect(w.guardian).setPaused(true)).wait();
  assert.equal(await bb.paused(), true);
  assert.ok(logs.some((l) => /UsefulWork paused/.test(l)));
});

test('deploy-useful-work refuses a short timelock, another chain, and a missing overflow', async () => {
  const w = await setup({ delay: DAY });
  await assert.rejects(deployUsefulWork({ signer: w.deployer, timelock: w.timelock, jobs: w.jobs, overflow: w.overflow.address }), /needs at least 172800 s/);
  assert.equal(MIN_TIMELOCK_DELAY, 2 * DAY);
  const w2 = await setup();
  await assert.rejects(deployUsefulWork({ signer: w2.deployer, timelock: w2.timelock, jobs: w2.jobs }), /overflow/);
  const other = await createRpcChain({ chainId: 1, accounts: 1 });
  await assert.rejects(deployUsefulWork({ signer: other.signers[0], timelock: w.timelock, jobs: w.jobs, overflow: w.overflow.address }), /77390/);
  const noIss = await deployUsefulWork({ signer: w2.deployer, timelock: w2.timelock, jobs: w2.jobs, issuance: false });
  assert.equal(noIss.contracts.usefulIssuance, undefined);
  assert.equal(openProposals({ contracts: noIss.contracts, delay: 2 * DAY }).length, 2);
  // the launch state gives the defaults the CLI uses
  const ld = launchDefaults();
  assert.match(ld.timelock, /^0x[0-9a-fA-F]{40}$/);
  assert.match(ld.jobs, /^0x[0-9a-fA-F]{40}$/);
});

test('feeder: paused -> no jobs; open -> jobs and canaries; canaries revealed from the derived salt; settled', async () => {
  const w = await setup();
  const d = await deployUsefulWork({ signer: w.deployer, timelock: w.timelock, jobs: w.jobs, feeder: w.feeder.address, overflow: w.overflow.address });
  const uw = w.c.at('UsefulWork', d.contracts.usefulWork, w.feeder);
  // three real contracts on the chain to scan (and newContracts finds them)
  const targets = [];
  for (let i = 0; i < 3; i++) { const v = await w.c.deploy(i === 1 ? 'TestStable' : 'VulnerableVault', i === 1 ? ['Test USD', 'tUSD'] : [], w.anyone); targets.push({ chain: 'zetaphy', address: await v.getAddress() }); }
  const found = await newContracts(w.c.provider, { blocks: 30 });
  for (const t of targets) assert.ok(found.some((f) => f.address === t.address), 'newContracts sees the deployments');
  const key = w.feeder.privateKey;
  const codeOf = async (_chain, a) => w.c.provider.getCode(a);
  const verdictOf = async (job) => (await scanVerdict(job)).verdict;
  const opts = { usefulWork: uw, privateKey: key, targets, codeOf, verdictOf, fee: parseEther('0.01'), canaryEvery: 2 };
  const r0 = await feedRound(opts);
  assert.equal(r0.paused, true);
  assert.equal(r0.posted.length, 0);
  await runProposals(w, d.proposals);
  // dry run: plans, sends nothing
  const dry = await feedRound({ ...opts, dryRun: true });
  assert.equal(dry.posted.length, 3);
  assert.equal(await uw.jobCount(), 0n);
  const r1 = await feedRound(opts);
  assert.deepEqual(r1.posted.map((p) => p.canary), [false, true, false]);
  assert.equal(await uw.jobCount(), 3n);
  const job1 = await uw.getJob(1);
  const verdict1 = await verdictOf({ chain: 'zetaphy', target: targets[1].address, code: await codeOf('zetaphy', targets[1].address), codeHash: job1.codeHash });
  assert.equal(job1.canary, canaryCommitmentOf(verdict1, canarySalt(key, d.contracts.usefulWork, 1), 1), 'the canary is a commitment to Neuro\'s answer');
  // a second run posts nothing new (posted lately) and has nothing to reveal yet
  const r2 = await feedRound(opts);
  assert.equal(r2.posted.length, 0);
  assert.equal(r2.skipped.filter((s) => s.why === 'posted lately').length, 3);
  // commits close: the next run reveals the canary (salt recomputed from the key), then settles after the reveal window
  w.c.advance(3601);
  const r3 = await feedRound(opts);
  assert.deepEqual(r3.revealed, [1]);
  assert.equal((await uw.getJob(1)).canaryVerdict, verdict1);
  w.c.advance(3601);
  const r4 = await feedRound(opts);
  assert.deepEqual(r4.settled.sort(), [0, 1, 2]);
  assert.equal(await uw.phase(0), 3n);
  // a key that is not a feeder posts nothing
  const r5 = await feedRound({ ...opts, usefulWork: uw.connect(w.anyone), privateKey: w.anyone.privateKey, targets: [{ chain: 'zetaphy', address: d.contracts.bugBounty }] });
  assert.equal(r5.feeder, false);
  assert.equal(r5.posted.length, 0);
  void art;
});

test('cli: zetaphy deploy-useful-work and zetaphy work feed --dry-run, through a JSON-RPC node', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync, writeFileSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const w = await setup();
  const dir = mkdtempSync(`${tmpdir()}/uwcli-`);
  process.env.ZETAPHY_HOME = dir;
  writeFileSync(`${dir}/worker.key`, w.feeder.privateKey, { mode: 0o600 });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const one = async (p) => { try { return { jsonrpc: '2.0', id: p.id, result: await w.c.handle(p.method, p.params ?? []) }; } catch (e) { return { jsonrpc: '2.0', id: p.id, error: e.rpc ?? { code: -32000, message: e.message } }; } };
      const q = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q)));
    });
  });
  await new Promise((r) => server.listen(18096, '127.0.0.1', r));
  try {
    const { main } = await import('../cli.js');
    const out = [];
    const env = { ZETAPHY_RPC: 'http://127.0.0.1:18096' };
    const file = `${dir}/useful-work.json`;
    assert.equal(await main(['deploy-useful-work', '--timelock', w.timelock, '--jobs', w.jobs, '--overflow', w.overflow.address, '--feeder', w.feeder.address, '--out', file], env, (l) => out.push(l)), 0);
    const d = JSON.parse(rf(file, 'utf8'));
    assert.equal(d.paused, true);
    assert.equal(d.feeder, w.feeder.address);
    assert.match(out.join('\n'), /deployed PAUSED and handed to the timelock/);
    assert.match(out.join('\n'), /zetaphy timelock schedule --to 0x[0-9a-fA-F]{40} --data 0x/);
    out.length = 0;
    assert.equal(await main(['work', 'feed', '--useful-work', d.contracts.usefulWork, '--new-blocks', '20', '--dry-run'], env, (l) => out.push(l)), 0);
    assert.match(out.join('\n'), /paused: no new jobs/);
    assert.match(out.at(-1), /"paused":true/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflows: the feeder and the detector loop take keys only from GitHub Environments; actions pinned', () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}`, import.meta.url), 'utf8');
  const jobOf = (text, name) => {
    const i = text.indexOf(`\n  ${name}:\n`);
    assert.ok(i >= 0, name);
    const rest = text.slice(i + 1);
    const j = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
    return j < 0 ? rest : rest.slice(0, j + 1);
  };
  const uw = wf('useful-work.yml');
  assert.match(uw, /^permissions: \{\}$/m);
  assert.match(jobOf(uw, 'feed'), /environment: testnet-automation/);
  assert.match(jobOf(uw, 'feed'), /secrets\.USEFUL_WORK_FEEDER_KEY/);
  assert.match(jobOf(uw, 'feed'), /--dry-run/, 'no key: a dry run');
  assert.match(jobOf(uw, 'deploy'), /environment: testnet-deploy/);
  assert.match(jobOf(uw, 'deploy'), /deploy-useful-work/);
  const mk = wf('markets.yml');
  assert.match(jobOf(mk, 'detectors'), /environment: testnet-automation/);
  assert.match(jobOf(mk, 'detectors'), /detectors-round/);
  for (const text of [uw, mk]) {
    for (const m of text.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{64}/, 'no key material');
  }
});
