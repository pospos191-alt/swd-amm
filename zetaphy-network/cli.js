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
//   zetaphy job request-stable <chain> <address> --relay URL [--token usdc --fee 0.1 --tip 0.01]
//                                      pay in test USDC/USDT through a relay: no ZETAPHY needed
//   zetaphy faucet <usdc|usdt> --relay URL   test stablecoins for this wallet (the relay pays gas)
//   zetaphy relay start [--port 8080 --min-tip 0.01]   serve users who pay in stablecoins
//   zetaphy gate                       progress toward gate 1 (30 days, no stalls, 10+ runners)
//   zetaphy pq new [--hybrid]          quantum-safe wallet (ML-DSA); --hybrid also needs this machine's ECDSA key
//   zetaphy pq address                 the wallet's address (fund it before or after it exists)
//   zetaphy pq send <to> <amount>      move ZETAPHY out of it, signed with ML-DSA
//   zetaphy deploy-pq                  deploy the QuantumWalletFactory
//   zetaphy deploy [--bond 100 --reward 1 --min-fee 0.1 --window 120 --timeout 600 --unbond 3600]
//   zetaphy deploy-stable [--price 0.01 --reserve 1000]  test USDC/USDT + StableGateway
//
// Settings: --rpc / ZETAPHY_RPC (ZETAPHY testnet JSON-RPC), --jobs / ZETAPHY_JOBS
// (NeuroJobs address). They are saved to ~/.zetaphy/config.json on first use.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, ContractFactory, formatEther, parseEther, parseUnits, formatUnits, encodeBytes32String, NonceManager, Signature } from 'ethers';
import { HOME, loadOrCreateKey } from './src/keys.js';
import { detectHardware, pickProfile } from './src/hardware.js';
import { createWorker } from './src/worker.js';
import { createRelay } from './src/relay.js';
import { gate1 } from './src/gate.js';
import { loadOrCreatePq, VARIANT as PQ_VARIANT } from './src/pq.js';

const art = (n) => JSON.parse(readFileSync(new URL(`./artifacts/${n}.json`, import.meta.url), 'utf8'));
const ART = art('NeuroJobs');
const STABLE = art('TestStable');
const GATEWAY = art('StableGateway');
const QWALLET = art('QuantumWallet');
const QFACTORY = art('QuantumWalletFactory');
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
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
  const s = { ...saved, rpc: opt.rpc ?? env.ZETAPHY_RPC ?? saved.rpc, jobs: opt.jobs ?? env.ZETAPHY_JOBS ?? saved.jobs };
  for (const k of ['gateway', 'usdc', 'usdt', 'pqFactory']) if (opt[k]) s[k] = opt[k];
  if (opt.hybrid) s.pqHybrid = true;
  if (JSON.stringify(s) !== JSON.stringify(saved)) {
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

  if (group === 'gate') {
    const c = await connect(s);
    const r = await gate1(c.provider, c.jobs, opt['block-seconds'] ? { gate: { days: 30, runners: 10, maxGapSeconds: 60, blockSeconds: Number(opt['block-seconds']) } } : {});
    write(`gate 1 at block ${r.height}: ${r.passed ? 'PASSED (still confirm the runners are different people)' : 'not yet'}`);
    for (const ch of r.checks) write(`  ${ch.ok ? '✓' : '·'} ${ch.name}: ${ch.value}`);
    return 0;
  }

  if (group === 'deploy-pq') {
    const c = await connect(s, { needJobs: false });
    const k = await new ContractFactory(QFACTORY.abi, QFACTORY.bytecode, c.signer).deploy();
    await k.waitForDeployment();
    const address = await k.getAddress();
    settings({ ...opt, pqFactory: address }, {});
    write(`QuantumWalletFactory ${address}`);
    return 0;
  }

  if (group === 'pq') {
    if (!s.pqFactory) throw new Error('no QuantumWalletFactory yet: --pqFactory 0x... or "zetaphy deploy-pq"');
    const c = await connect(s, { needJobs: false });
    const pq = loadOrCreatePq();
    const ecdsaOwner = s.pqHybrid ? c.me : ZERO_ADDR;
    const factory = new Contract(s.pqFactory, QFACTORY.abi, c.signer);
    const address = await factory.predict(ecdsaOwner, PQ_VARIANT, pq.keyHash);
    const deployed = (await c.provider.getCode(address)) !== '0x';
    const mode = s.pqHybrid ? 'hybrid: ML-DSA + ECDSA' : 'post-quantum only: ML-DSA';
    if (cmd === 'new' || cmd === 'address') {
      write(`quantum-safe wallet: ${address} (${mode}, ML-DSA-${PQ_VARIANT})${deployed ? '' : ' - not deployed yet; it can receive funds already'}`);
      if (pq.created) write(`new ML-DSA seed saved to ${pq.file} (keep a backup; it is the only way to move funds)`);
      write(`balance: ${zeta(await c.provider.getBalance(address))}`);
      return 0;
    }
    if (cmd === 'send') {
      const [to, amount] = rest;
      if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '') || !amount) throw new Error('usage: zetaphy pq send <0x address> <amount>');
      if (!deployed) await (await factory.create(ecdsaOwner, PQ_VARIANT, pq.keyHash)).wait();
      const wallet = new Contract(address, QWALLET.abi, c.signer);
      const value = parseEther(String(amount));
      const deadline = BigInt((await c.provider.getBlock('latest')).timestamp) + 600n;
      const digest = await wallet.digest(to, value, '0x', deadline);
      const ecdsaSig = s.pqHybrid ? c.signer.signer.signingKey.sign(digest).serialized : '0x';
      const args = [to, value, '0x', deadline, [pq.publicKey, pq.sign(digest), ecdsaSig]];
      // Cosmos EVM charges at least half the gas limit, so ask for what it needs, not a round number.
      const gasLimit = (await wallet.execute.estimateGas(...args)) * 12n / 10n;
      const rc = await (await wallet.execute(...args, { gasLimit })).wait();
      write(`sent ${zeta(value)} to ${to} from ${address}, signed with ML-DSA-${PQ_VARIANT} (gas ${rc.gasUsed})`);
      return 0;
    }
  }

  if (group === 'deploy-stable') {
    const c = await connect(s);
    const deploy = async (a, args) => { const k = await new ContractFactory(a.abi, a.bytecode, c.signer).deploy(...args); await k.waitForDeployment(); return k.getAddress(); };
    const usdc = await deploy(STABLE, ['Test USDC (ZETAPHY testnet)', 'tUSDC']);
    const usdt = await deploy(STABLE, ['Test USDT (ZETAPHY testnet)', 'tUSDT']);
    const gwAddr = await deploy(GATEWAY, [s.jobs]);
    const gw = new Contract(gwAddr, GATEWAY.abi, c.signer);
    const price = parseUnits(String(opt.price ?? '0.01'), 6); // stablecoin per 1 ZETAPHY
    await (await gw.setPrice(usdc, price)).wait();
    await (await gw.setPrice(usdt, price)).wait();
    await (await c.signer.sendTransaction({ to: gwAddr, value: parseEther(String(opt.reserve ?? 1000)) })).wait();
    settings({ ...opt, gateway: gwAddr, usdc, usdt }, {});
    write(`tUSDC ${usdc}\ntUSDT ${usdt}\nStableGateway ${gwAddr} (price ${formatUnits(price, 6)} per ZETAPHY, reserve ${opt.reserve ?? 1000} ZETAPHY)`);
    return 0;
  }

  if (group === 'relay' && cmd === 'start') {
    if (!s.gateway) throw new Error('no StableGateway yet: run "zetaphy deploy-stable" or pass --gateway 0x...');
    const c = await connect(s, { needJobs: false });
    const gateway = new Contract(s.gateway, GATEWAY.abi, c.signer);
    const tokens = {};
    for (const k of ['usdc', 'usdt']) if (s[k]) tokens[k] = new Contract(s[k], STABLE.abi, c.signer);
    const server = createRelay({ gateway, tokens, minTip: parseUnits(String(opt['min-tip'] ?? '0.01'), 6), log: (l) => write(`${new Date().toISOString()} ${l}`) });
    const port = Number(opt.port ?? 8080);
    await new Promise((r) => server.listen(port, opt.host ?? '0.0.0.0', r));
    write(`relay for ${s.gateway} on port ${port}; relay wallet ${c.me} pays the gas`);
    if (opt.once) { server.close(); return 0; }
    return new Promise(() => {}); // runs until stopped
  }

  if (group === 'faucet') {
    if (!opt.relay) throw new Error('usage: zetaphy faucet <usdc|usdt> --relay URL');
    const { wallet } = loadOrCreateKey();
    const r = await fetch(new URL('/faucet', opt.relay), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cmd, address: wallet.address }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`faucet: ${body.error}`);
    write(`1,000 test ${cmd.toUpperCase()} sent to ${wallet.address}`);
    return 0;
  }

  if (group === 'job' && cmd === 'request-stable') {
    const [chainKey, target] = rest;
    if (!chainKey || !target || !opt.relay) throw new Error('usage: zetaphy job request-stable <chain> <address> --relay URL [--token usdc --fee 0.1 --tip 0.01]');
    const info = await (await fetch(new URL('/info', opt.relay))).json();
    const tokenKey = String(opt.token ?? 'usdc');
    const token = info.tokens?.[tokenKey];
    if (!token) throw new Error(`relay does not take ${tokenKey}`);
    const c = await connect(s, { needJobs: false });
    const gw = new Contract(info.gateway, GATEWAY.abi, c.provider);
    const stable = new Contract(token, STABLE.abi, c.provider);
    const net = await c.provider.getNetwork();
    const fee = parseEther(String(opt.fee ?? '0.1'));
    const tip = opt.tip ? parseUnits(String(opt.tip), 6) : BigInt(info.minTip);
    const cost = await gw.quote(token, fee);
    const deadline = BigInt((await c.provider.getBlock('latest')).timestamp) + 600n;
    const wallet = c.signer.signer; // the plain Wallet under the NonceManager
    const q = { user: c.me, token, chain: encodeBytes32String(chainKey), target, fee, tip, maxCost: cost + tip, nonce: await gw.nonces(c.me), deadline };
    const signature = await wallet.signTypedData(
      { name: 'ZETAPHY StableGateway', version: '1', chainId: net.chainId, verifyingContract: info.gateway },
      { JobRequest: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'chain', type: 'bytes32' }, { name: 'target', type: 'string' },
        { name: 'fee', type: 'uint256' }, { name: 'tip', type: 'uint256' }, { name: 'maxCost', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, q);
    const ps = Signature.from(await wallet.signTypedData(
      { name: await stable.name(), version: '1', chainId: net.chainId, verifyingContract: token },
      { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      { owner: c.me, spender: info.gateway, value: q.maxCost, nonce: await stable.nonces(c.me), deadline }));
    const str = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const r = await fetch(new URL('/request', opt.relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(str({ request: q, signature, permit: { value: q.maxCost, deadline, v: ps.v, r: ps.r, s: ps.s } })) });
    const body = await r.json();
    if (!r.ok) throw new Error(`relay refused: ${body.error}`);
    write(`job ${body.jobId} requested: ${chainKey} ${target}, paid ${formatUnits(cost + tip, 6)} ${tokenKey.toUpperCase()} (no ZETAPHY used)`);
    return 0;
  }

  write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(3)).join('\n'));
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
}
