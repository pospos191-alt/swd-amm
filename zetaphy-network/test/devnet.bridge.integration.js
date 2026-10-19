// The Neuro bridge across two real chains (both zetaphyd devnets):
//   source chain S (EVM id 4097) holds a LockBox;
//   ZETAPHY Z (77390) holds BridgeGuard + BridgeAirlock + NeuroLane + a decoy.
// Three node runners watch S with `zetaphy bridge watch` and attest; a second
// lane (standing in for Hyperlane) attests too; after the quarantine the
// money enters ZETAPHY. An attacker who touched the decoy gets nothing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, Contract, ContractFactory, parseEther, NonceManager } from 'ethers';

const ZP = 19045, SP = 19445; // a devnet also uses its port +100..+103
const Z = `http://127.0.0.1:${ZP}`, S = `http://127.0.0.1:${SP}`;
const root = mkdtempSync(join(tmpdir(), 'zetaphy-bridge-'));
const names = ['gov', 'user', 'r1', 'r2', 'r3', 'hyperlane', 'alice', 'attacker'];
const W = Object.fromEntries(names.map((n) => [n, Wallet.createRandom()]));
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
let zp, sp, jobsAddr, cfg;

function cli(actor, args, rpc = Z) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('../cli.js', import.meta.url).pathname, ...args, '--rpc', rpc], {
      env: { ...env, ZETAPHY_HOME: join(root, actor) }, timeout: 90_000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

before(() => {
  for (const [n, w] of Object.entries(W)) {
    mkdirSync(join(root, n), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, n, 'worker.key'), w.privateKey + '\n', { mode: 0o600 });
  }
  const all = Object.values(W).map((w) => w.address);
  const devnet = new URL('../scripts/devnet.sh', import.meta.url).pathname;
  execFileSync(devnet, [join(root, 'z'), String(ZP), ...all], { stdio: 'inherit', env });
  execFileSync(devnet, [join(root, 's'), String(SP), ...all], { stdio: 'inherit', env: { ...env, EVM_CHAIN_ID: '4097', COSMOS_CHAIN_ID: 'source-local-1' } });
  zp = new JsonRpcProvider(Z, undefined, { staticNetwork: true });
  sp = new JsonRpcProvider(S, undefined, { staticNetwork: true });
});
after(() => { for (const d of ['z', 's']) { try { process.kill(Number(readFileSync(join(root, d, 'node.pid'), 'utf8'))); } catch {} } });

test('assets cross only with two independent lanes, after quarantine, and never to a decoy-marked attacker', { timeout: 600_000 }, async () => {
  // ZETAPHY side: NeuroJobs, three runners with a track record.
  const d = await cli('gov', ['deploy', '--fund', '100', '--window', '8', '--timeout', '60', '--unbond', '120']);
  jobsAddr = /deployed at (0x[0-9a-fA-F]{40})/.exec(d.out)[1];
  for (const r of ['r1', 'r2', 'r3']) assert.equal((await cli(r, ['node', 'register', '--jobs', jobsAddr])).code, 0);
  await cli('user', ['job', 'request', 'zetaphy', jobsAddr, '--fee', '1', '--jobs', jobsAddr]);
  const jobs = new Contract(jobsAddr, art('NeuroJobs').abi, zp);
  for (let i = 0; i < 40 && (await jobs.getJob(0)).status === 1n; i++) {
    await Promise.all(['r1', 'r2', 'r3'].map((r) => cli(r, ['node', 'start', '--once', '--jobs', jobsAddr])));
  }
  assert.equal((await jobs.getJob(0)).status, 2n, 'runners need one accepted verdict first');

  const b = await cli('gov', ['deploy-bridge', '--jobs', jobsAddr, '--quarantine', '8', '--lane', W.hyperlane.address]);
  assert.equal(b.code, 0, b.out);
  cfg = Object.fromEntries([...b.out.matchAll(/^(\w+) (0x[0-9a-fA-F]{40})$/gm)].map((m) => [m[1], m[2]]));

  // Source side: a LockBox; Alice locks 5, the attacker pokes the decoy on ZETAPHY then locks 7.
  const lb = await new ContractFactory(art('LockBox').abi, art('LockBox').bytecode, W.gov.connect(sp)).deploy();
  await lb.waitForDeployment();
  const lockbox = new Contract(await lb.getAddress(), art('LockBox').abi, sp);
  await (await lockbox.connect(W.alice.connect(sp)).lock(W.alice.address, { value: parseEther('5') })).wait();
  const decoy = new Contract(cfg.DecoyBridge, art('DecoyBridge').abi, W.attacker.connect(zp));
  await (await decoy.mint(W.attacker.address, parseEther('1000000'), { gasLimit: 300000n })).wait();
  await (await lockbox.connect(W.attacker.connect(sp)).lock(W.attacker.address, { value: parseEther('7') })).wait();

  // The "Hyperlane" lane attests both locks independently.
  // NonceManager: Cosmos EVM can report the pending nonce a moment late.
  const airlock = new Contract(cfg.BridgeAirlock, art('BridgeAirlock').abi, new NonceManager(W.hyperlane.connect(zp)));
  const srcId = 4097n;
  await (await airlock.attest(srcId, lockbox.target, 0n, W.alice.address, W.alice.address, parseEther('5'))).wait();
  await (await airlock.attest(srcId, lockbox.target, 1n, W.attacker.address, W.attacker.address, parseEther('7'))).wait();

  // Runners watch S and attest; then, after the quarantine, release.
  const watch = (r, extra = []) => cli(r, ['bridge', 'watch', '--once', '--source-rpc', S, '--lockbox', lockbox.target, '--confirmations', '1',
    '--airlock', cfg.BridgeAirlock, '--neuroLane', cfg.NeuroLane, ...extra]);
  const token = new Contract(cfg.BridgedToken, art('BridgedToken').abi, zp);
  const logs = [];
  for (let i = 0; i < 30 && (await token.balanceOf(W.alice.address)) === 0n; i++) {
    const outs = await Promise.all(['r1', 'r2', 'r3'].map((r) => watch(r, ['--release'])));
    logs.push(...outs.map((o) => o.out));
    await new Promise((res) => setTimeout(res, 2000));
  }
  assert.equal(await token.balanceOf(W.alice.address), parseEther('5'), logs.join('\n'));
  assert.equal(await token.balanceOf(W.attacker.address), 0n);
  assert.equal(await airlock.tripped(W.attacker.address), true);
  assert.match(logs.join('\n'), /attested lock #0/);
  console.log(`alice received 5 bridged USDC via 2 lanes + quarantine; attacker (decoy-marked) received 0`);
});
