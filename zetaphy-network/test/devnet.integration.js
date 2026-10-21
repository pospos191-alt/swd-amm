// End-to-end on a real ZETAPHY chain (zetaphyd, 1 s blocks): deploy NeuroJobs,
// three runners register, a user posts a job, the runners run Neuro on their
// own, commit, reveal, reach 2-of-3 and get paid; a challenge then opens round
// 2 with two fresh runners (w4, w5). Needs the zetaphyd binary,
// so it is not part of `npm test`; run with `npm run test:devnet`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, formatEther } from 'ethers';

const PORT = 18645;
const RPC = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-devnet-'));
const actors = Object.fromEntries(['deployer', 'user', 'w1', 'w2', 'w3', 'relay', 'w4', 'w5'].map((n) => [n, Wallet.createRandom()]));
// 'poor' holds no ZETAPHY at all: it is NOT funded at genesis.
const poor = Wallet.createRandom();
const RELAY_PORT = PORT + 7;
let jobsAddr;
const ART = JSON.parse(readFileSync(new URL('../artifacts/NeuroJobs.json', import.meta.url), 'utf8'));

function cli(actor, args) {
  const home = join(root, actor);
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', RPC], {
      env: { ...process.env, ZETAPHY_HOME: home, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }, timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

before(() => {
  for (const [n, w] of Object.entries({ ...actors, poor })) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  execFileSync(new URL('../scripts/devnet.sh', import.meta.url).pathname,
    [join(root, 'chain'), String(PORT), ...Object.values(actors).map((w) => w.address)],
    { stdio: 'inherit', env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
});

after(() => {
  try { process.kill(Number(readFileSync(join(root, 'chain', 'node.pid'), 'utf8'))); } catch {}
});

test('a job goes from request to a paid 2-of-3 verdict on a real ZETAPHY chain', { timeout: 300_000 }, async () => {
  const d = await cli('deployer', ['deploy', '--fund', '1000', '--window', '10', '--timeout', '60', '--unbond', '120']);
  assert.equal(d.code, 0, d.out);
  jobsAddr = /deployed at (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const withJobs = (a) => [...a, '--jobs', jobsAddr];

  for (const w of ['w1', 'w2', 'w3']) {
    const r = await cli(w, withJobs(['node', 'register']));
    assert.equal(r.code, 0, r.out);
  }
  const req = await cli('user', withJobs(['job', 'request', 'zetaphy', jobsAddr, '--fee', '3']));
  assert.match(req.out, /job 0 requested/, req.out);

  // Runners act independently; each round every runner does one pass.
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const jobs = new Contract(jobsAddr, ART.abi, provider);
  const logs = [];
  let job;
  for (let round = 0; round < 40; round++) {
    const outs = await Promise.all(['w1', 'w2', 'w3'].map((w) => cli(w, withJobs(['node', 'start', '--once']))));
    logs.push(...outs.map((o) => o.out));
    job = await jobs.getJob(0);
    if (job.status !== 1n) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(job.status, 2n, `job not done:\n${logs.join('\n')}`);
  assert.match(job.result, /^0x[0-9a-f]{64}$/);
  assert.notEqual(BigInt(job.result), 0n);

  // Every runner computed the same verdict, so each paid one got fee/2 or fee/3 + 1 reward.
  let paid = 0;
  for (const w of ['w1', 'w2', 'w3']) {
    const credit = await jobs.credit(actors[w].address);
    if (credit > 0n) paid++;
    const s = await cli(w, withJobs(['node', 'status']));
    assert.match(s.out, /verdicts: \d+ agreed, 0 rejected/, s.out);
  }
  assert.ok(paid >= 2, 'at least two runners were paid');

  const before = await provider.getBalance(actors.w1.address);
  const credit = await jobs.credit(actors.w1.address);
  if (credit > 0n) {
    const r = await cli('w1', withJobs(['node', 'withdraw']));
    assert.equal(r.code, 0, r.out);
    const gained = (await provider.getBalance(actors.w1.address)) - before;
    assert.ok(gained > credit - 10n ** 16n, `withdrew ${formatEther(gained)} of ${formatEther(credit)}`);
  }
  console.log(`job 0 verdict ${job.result}, ${paid} runners paid`);
});

test('a challenge opens round 2 with fresh runners, drawn from blockhash(challenge block + 1); it confirms the verdict', { timeout: 300_000 }, async () => {
  const withJobs = (a) => [...a, '--jobs', jobsAddr];
  for (const w of ['w4', 'w5']) {
    const r = await cli(w, withJobs(['node', 'register']));
    assert.equal(r.code, 0, r.out);
  }
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const jobs = new Contract(jobsAddr, ART.abi, provider);
  const req = await cli('user', withJobs(['job', 'request', 'zetaphy', jobsAddr]));
  const id = BigInt(/job (\d+) requested/.exec(req.out)?.[1] ?? NaN);
  // Round 1: w1-w3 only (w4 and w5 stay free for round 2).
  const { job, logs } = await runUntilDone(id, jobs);
  assert.equal(job.status, 2n, logs.join('\n'));
  assert.notEqual((await jobs.jobInfo(id)).rand, '0x' + '00'.repeat(32), 'round 1 was drawn');
  await assert.rejects(Promise.resolve().then(async () => { const r = await cli('user', withJobs(['job', 'challenge', String(id)])); if (r.code) throw new Error(r.out); }), /--verdict/);
  // The challenger names the verdict it says is right (here a wrong one: round 2 confirms).
  const ch = await cli('user', withJobs(['job', 'challenge', String(id), '--verdict', '0x' + '77'.repeat(32)]));
  assert.equal(ch.code, 0, ch.out);
  assert.match(ch.out, /challenged with 1\.0 ZETAPHY/);
  const outs = [];
  let info;
  for (let round = 0; round < 40; round++) {
    outs.push(...(await Promise.all(['w4', 'w5'].map((w) => cli(w, withJobs(['node', 'start', '--once']))))).map((o) => o.out));
    info = await jobs.challengeInfo(id);
    if (info.state !== 1n) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(info.state, 2n, `round 2 not confirmed:\n${outs.join('\n')}`);
  assert.match(outs.join('\n'), /committed in round 2/);
  const g = await cli('user', withJobs(['job', 'get', String(id)]));
  assert.match(g.out, /"confirmedBy": [45]/, g.out); // 2 (or 3) in round 1 + 2 in round 2
  assert.match(g.out, /"challenge": "confirmed"/, g.out);
  // The challenger's 1 ZETAPHY went to round 2 (half) and round 1's winners (half).
  assert.equal(await jobs.credit(actors.w4.address), 10n ** 18n / 4n);
  console.log(`job ${id}: challenged, round 2 (w4, w5) confirmed ${job.result}`);
});

async function runUntilDone(id, jobs) {
  const logs = [];
  for (let round = 0; round < 40; round++) {
    const outs = await Promise.all(['w1', 'w2', 'w3'].map((w) => cli(w, ['node', 'start', '--once', '--jobs', jobsAddr])));
    logs.push(...outs.map((o) => o.out));
    const job = await jobs.getJob(id);
    if (job.status !== 1n) return { job, logs };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { job: await jobs.getJob(id), logs };
}

test('stage 2: a user with no ZETAPHY pays in test USDC through a relay', { timeout: 300_000 }, async () => {
  // No DEX pool on this chain for ZetaphyOracle's TWAP: the labeled testnet fallback (devnet.timelock.integration.js prices through the oracle)
  const d = await cli('deployer', ['deploy-stable', '--jobs', jobsAddr, '--reserve', '100', '--testnet-fixed-price', '0.01']);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /TESTNET FIXED PRICE 0\.01 per ZETAPHY/);
  const gateway = /StableGateway (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const usdc = /tUSDC (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  const usdt = /tUSDT (0x[0-9a-fA-F]{40})/.exec(d.out)[1];

  const relay = spawn(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'relay', 'start', '--rpc', RPC,
    '--gateway', gateway, '--usdc', usdc, '--usdt', usdt, '--port', String(RELAY_PORT), '--host', '127.0.0.1'],
  { env: { ...process.env, ZETAPHY_HOME: join(root, 'relay'), NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
  try {
    await new Promise((resolve, reject) => {
      relay.stdout.on('data', (b) => { if (/relay for/.test(String(b))) resolve(); });
      relay.on('exit', (code) => reject(new Error(`relay exited ${code}`)));
    });
    const URL_ = `http://127.0.0.1:${RELAY_PORT}`;
    const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    assert.equal(await provider.getBalance(poor.address), 0n);

    const f = await cli('poor', ['faucet', 'usdc', '--relay', URL_]);
    assert.equal(f.code, 0, f.out);
    const r = await cli('poor', ['job', 'request-stable', 'zetaphy', jobsAddr, '--relay', URL_, '--fee', '0.5', '--jobs', jobsAddr]);
    assert.equal(r.code, 0, r.out);
    const id = BigInt(/job (\d+) requested/.exec(r.out)[1]);

    const jobs = new Contract(jobsAddr, ART.abi, provider);
    const { job, logs } = await runUntilDone(id, jobs);
    assert.equal(job.status, 2n, logs.join('\n'));
    assert.equal(job.requester, poor.address);
    assert.equal(await provider.getBalance(poor.address), 0n, 'the user never needed ZETAPHY');
    console.log(`stage 2: job ${id} paid in tUSDC by an address with 0 ZETAPHY, verdict ${job.result}`);
  } finally {
    relay.kill();
  }
});

test('stage 2: an upgrade is proposed, voted on chain and scheduled', { timeout: 120_000 }, async () => {
  const chainHome = join(root, 'chain');
  const env = { ...process.env, ZETAPHYD: 'zetaphyd', NODE_HOME: chainHome, KEYS_DIR: chainHome, NODE: `tcp://127.0.0.1:${PORT + 100}`, CHAIN_ID: 'zetaphy-local-1' };
  const gov = (...a) => execFileSync(new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname, a, { env, encoding: 'utf8' });
  const status = JSON.parse(execFileSync('zetaphyd', ['status', '--node', env.NODE], { encoding: 'utf8' }));
  const height = Number(status.sync_info.latest_block_height) + 100000;
  const out = gov('propose-upgrade', 'v2-devnet', String(height), 'Integration test upgrade');
  const id = /proposal (\d+) submitted/.exec(out)[1];
  assert.match(gov('vote', id, 'yes'), /voted yes/);
  let st;
  for (let i = 0; i < 40; i++) {
    st = JSON.parse(gov('status', id));
    if (st.status !== 'PROPOSAL_STATUS_VOTING_PERIOD') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(st.status, 'PROPOSAL_STATUS_PASSED');
  const plan = JSON.parse(gov('plan'));
  assert.equal(plan.plan.name, 'v2-devnet');
  assert.equal(plan.plan.height, String(height));
});

test('gate 1 report reads the chain and counts revealing runners', { timeout: 60_000 }, async () => {
  const r = await cli('w1', ['gate', '--jobs', jobsAddr, '--block-seconds', '1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /gate 1 at block \d+: not yet/);
  assert.match(r.out, /· running 30\+ days/);
  assert.match(r.out, /✓ no stalled blocks/);
  assert.match(r.out, /3 addresses|2 addresses/);
});

test('stage 2: the reward pool sits in a vault that pays 10% a year', { timeout: 60_000 }, async () => {
  const d = await cli('deployer', ['deploy-vault', '--jobs', jobsAddr, '--validators', actors.w3.address, '--validators-share', '30', '--fund', '500']);
  assert.equal(d.code, 0, d.out);
  const vault = /RewardVault (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  assert.match(d.out, /70% to 0x[0-9a-fA-F]{40}, 30% to/);
  const st = await cli('w1', ['vault', 'status', '--vault', vault]);
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /pool: 500\.0 ZETAPHY \(day 0\); vested now: 0\.0 ZETAPHY; next year: 50\.0 ZETAPHY/);
  const rel = await cli('w1', ['vault', 'release', '--vault', vault]);
  assert.match(rel.out, /nothing vested yet/, 'day 0: nothing to pay');
});

test('stage 2: half of every fee is burned, so the supply shrinks', { timeout: 60_000 }, async () => {
  const chainHome = join(root, 'chain');
  const supply = () => BigInt(JSON.parse(execFileSync(process.env.ZETAPHYD ?? 'zetaphyd', ['q', 'bank', 'total-supply-of', 'azetaphy',
    '--node', `tcp://127.0.0.1:${PORT + 100}`, '-o', 'json', '--home', chainHome], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } })).amount.amount);
  const provider = new JsonRpcProvider(RPC);
  const w = new Wallet(actors.user.privateKey, provider);
  await new Promise((r) => setTimeout(r, 3000)); // let earlier fees settle
  const before = supply();
  let fees = 0n;
  // Count nonces here: right after a block the node's pending nonce can lag
  // by one, and ethers would then reuse a spent nonce ("nonce too low").
  const nonce = await provider.getTransactionCount(w.address, 'latest');
  for (let i = 0; i < 3; i++) {
    const r = await (await w.sendTransaction({ to: Wallet.createRandom().address, value: 1n, nonce: nonce + i })).wait();
    fees += r.gasUsed * r.gasPrice;
  }
  await new Promise((r) => setTimeout(r, 4000));
  const burned = before - supply();
  assert.ok(burned > 0n, 'supply went down');
  // Each block burns floor(fees/2): a few wei of rounding across blocks.
  const half = fees / 2n;
  assert.ok(burned >= half - 3n && burned <= half + 3n, `burned ${burned} of fees ${fees}`);
});
