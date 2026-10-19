// End-to-end on a real ZETAPHY chain (zetaphyd, 1 s blocks): deploy NeuroJobs,
// three runners register, a user posts a job, the runners run Neuro on their
// own, commit, reveal, reach 2-of-3 and get paid. Needs the zetaphyd binary,
// so it is not part of `npm test`; run with `npm run test:devnet`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, formatEther } from 'ethers';

const PORT = 18645;
const RPC = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-devnet-'));
const actors = Object.fromEntries(['deployer', 'user', 'w1', 'w2', 'w3'].map((n) => [n, Wallet.createRandom()]));
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
  for (const [n, w] of Object.entries(actors)) {
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
  const jobsAddr = /deployed at (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
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
