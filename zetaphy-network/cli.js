#!/usr/bin/env node
// zetaphy: one command for ZETAPHY testnet node runners and users.
//
//   zetaphy node start                 check the machine, then run Neuro jobs
//   zetaphy node register [--bond N]   put up the runner bond (ZETAPHY)
//   zetaphy node status                address, bond, earnings
//   zetaphy node withdraw              move earnings to the runner's wallet
//   zetaphy node unbond | withdraw-bond
//   zetaphy job request <chain> <address> [--fee N]   ask the network to check a contract
//   zetaphy job get <id>
//   zetaphy deploy [--bond 100 --reward 1 --min-fee 0.1 --window 120 --timeout 600 --unbond 3600]
//
// Settings: --rpc / ZETAPHY_RPC (ZETAPHY testnet JSON-RPC), --jobs / ZETAPHY_JOBS
// (NeuroJobs address). They are saved to ~/.zetaphy/config.json on first use.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, ContractFactory, formatEther, parseEther, encodeBytes32String, NonceManager } from 'ethers';
import { HOME, loadOrCreateKey } from './src/keys.js';
import { detectHardware, pickProfile } from './src/hardware.js';
import { createWorker } from './src/worker.js';

const ART = JSON.parse(readFileSync(new URL('./artifacts/NeuroJobs.json', import.meta.url), 'utf8'));
const STATUS = ['none', 'open', 'done', 'failed'];
const EVM_CHAIN_ID = 77390n;

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i]; }
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function settings(opt, env) {
  const file = join(HOME, 'config.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const s = { rpc: opt.rpc ?? env.ZETAPHY_RPC ?? saved.rpc, jobs: opt.jobs ?? env.ZETAPHY_JOBS ?? saved.jobs };
  if (s.rpc !== saved.rpc || s.jobs !== saved.jobs) {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(s, null, 2));
  }
  return s;
}

async function connect(s, { needJobs = true } = {}) {
  if (!s.rpc) throw new Error('set the ZETAPHY testnet RPC: --rpc http://<node>:8545 (or ZETAPHY_RPC)');
  const provider = new JsonRpcProvider(s.rpc, undefined, { staticNetwork: false, polling: true, pollingInterval: 1000 });
  const net = await provider.getNetwork();
  if (net.chainId !== EVM_CHAIN_ID) throw new Error(`that RPC is chain ${net.chainId}, not ZETAPHY testnet (${EVM_CHAIN_ID})`);
  const { wallet, created, file } = loadOrCreateKey();
  const signer = new NonceManager(wallet.connect(provider));
  const me = await wallet.getAddress();
  let jobs = null;
  if (needJobs) {
    if (!s.jobs) throw new Error('set the NeuroJobs address: --jobs 0x... (or ZETAPHY_JOBS)');
    if ((await provider.getCode(s.jobs)) === '0x') throw new Error(`no contract at ${s.jobs}`);
    jobs = new Contract(s.jobs, ART.abi, signer);
  }
  return { provider, signer, me, created, file, jobs };
}

const zeta = (wei) => `${formatEther(wei)} ZETAPHY`;

export async function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const { pos, opt } = parse(argv);
  const [group, cmd, ...rest] = pos;
  const s = settings(opt, env);

  if (group === 'node' && cmd === 'start') {
    const hw = await detectHardware();
    const { profile, reason } = pickProfile(hw);
    write(`machine: ${hw.cpus} CPU, ${hw.memoryGB} GB RAM${hw.gpus.length ? ', ' + hw.gpus.map((g) => g.name).join(', ') : ''}`);
    if (!profile) throw new Error(`this machine cannot run Neuro: ${reason}`);
    write(`mode: ${profile} (${reason})`);
    const c = await connect(s);
    write(`runner address: ${c.me}${c.created ? ` (new key saved to ${c.file}; testnet only)` : ''}`);
    const w = await c.jobs.workers(c.me);
    if (!w.active) {
      write(`not registered yet: run "zetaphy node register" (bond ${zeta(await c.jobs.workerBond())})`);
      return 1;
    }
    const worker = createWorker({
      jobs: c.jobs, me: c.me, stateFile: join(HOME, `jobs-${s.jobs.toLowerCase()}.json`),
      zetaphyChain: { kind: 'evm', id: Number(EVM_CHAIN_ID), name: 'ZETAPHY testnet', rpcs: [s.rpc] },
      chainTime: async () => BigInt((await c.provider.getBlock('latest')).timestamp),
      log: (l) => write(`${new Date().toISOString()} ${l}`),
    });
    write('running: waiting for jobs (Ctrl+C to stop)');
    const every = Number(opt.every ?? 5) * 1000;
    for (;;) {
      try { await worker.tick(); } catch (e) { write(`tick failed: ${e.shortMessage ?? e.message}`); }
      if (opt.once) return 0;
      await new Promise((r) => setTimeout(r, every));
    }
  }

  if (group === 'node' && cmd === 'register') {
    const c = await connect(s);
    const bond = opt.bond ? parseEther(String(opt.bond)) : await c.jobs.workerBond();
    await (await c.jobs.register({ value: bond })).wait();
    write(`registered ${c.me} with a bond of ${zeta(bond)}`);
    return 0;
  }

  if (group === 'node' && cmd === 'status') {
    const c = await connect(s);
    const w = await c.jobs.workers(c.me);
    write(`runner:   ${c.me}`);
    write(`wallet:   ${zeta(await c.provider.getBalance(c.me))}`);
    write(`bond:     ${zeta(w.bond)} (${w.active ? 'active' : w.unbondAt ? 'leaving' : 'not registered'})`);
    write(`earned:   ${zeta(await c.jobs.credit(c.me))} (withdraw with "zetaphy node withdraw")`);
    write(`verdicts: ${w.agreed} agreed, ${w.rejected} rejected`);
    write(`network:  ${await c.jobs.activeWorkers()} active runners, ${await c.jobs.jobCount()} jobs, reward pool ${zeta(await c.jobs.rewardPool())}`);
    return 0;
  }

  if (group === 'node' && ['withdraw', 'unbond', 'withdraw-bond'].includes(cmd)) {
    const c = await connect(s);
    const fn = { withdraw: 'withdraw', unbond: 'requestUnbond', 'withdraw-bond': 'withdrawBond' }[cmd];
    await (await c.jobs[fn]()).wait();
    write(`${cmd}: done`);
    return 0;
  }

  if (group === 'job' && cmd === 'request') {
    const [chainKey, target] = rest;
    if (!chainKey || !target) throw new Error('usage: zetaphy job request <chain> <address> [--fee N]');
    const c = await connect(s);
    const fee = opt.fee ? parseEther(String(opt.fee)) : await c.jobs.minFee();
    const rc = await (await c.jobs.request(encodeBytes32String(chainKey), target, { value: fee })).wait();
    const ev = rc.logs.map((l) => { try { return c.jobs.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobRequested');
    write(`job ${ev.args.id} requested: ${chainKey} ${target}, fee ${zeta(fee)}`);
    return 0;
  }

  if (group === 'job' && cmd === 'get') {
    const c = await connect(s);
    const j = await c.jobs.getJob(BigInt(rest[0] ?? cmd));
    write(JSON.stringify({ status: STATUS[Number(j.status)], target: j.target, fee: zeta(j.fee), verdict: j.result, commits: Number(j.commits), reveals: Number(j.reveals) }, null, 2));
    return 0;
  }

  if (group === 'deploy') {
    const c = await connect(s, { needJobs: false });
    const p = (k, d) => opt[k] ?? d;
    const factory = new ContractFactory(ART.abi, ART.bytecode, c.signer);
    const contract = await factory.deploy(parseEther(String(p('bond', 100))), parseEther(String(p('reward', 1))), parseEther(String(p('min-fee', 0.1))),
      BigInt(p('window', 120)), BigInt(p('timeout', 600)), BigInt(p('unbond', 3600)));
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    if (opt.fund) await (await new Contract(address, ART.abi, c.signer).fund({ value: parseEther(String(opt.fund)) })).wait();
    settings({ ...opt, jobs: address }, {});
    write(`NeuroJobs deployed at ${address}${opt.fund ? `, reward pool ${opt.fund} ZETAPHY` : ''}`);
    return 0;
  }

  write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(3)).join('\n'));
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
}
