#!/usr/bin/env node
// ZETAPHY DEX — DLMM command line (UNAUDITED contracts, testnet only).
//
//   node dlmm-cli.js deploy  --rpc <url> --key-file <file> [options]
//   node dlmm-cli.js status  --rpc <url> [--deployments <file>]
//   node dlmm-cli.js set-registry <address|0x0> --rpc <url> --key-file <file> [--deployments <file>]
//   node dlmm-cli.js set-fee-to   <address|0x0> --rpc <url> --key-file <file> [--deployments <file>]
//   node dlmm-cli.js set-governance <address> --rpc <url> --key-file <file> [--deployments <file>]
//
// The key: same rules as cli.js (a file, chmod 600, or ZETAPHY_DEX_KEY_FILE;
// never on the command line). deploy runs on ZETAPHY (EVM chain id 77390) only
// unless --any-chain.
//
// deploy: ZetaphyDlmmFactory (governance = the deployer) and ZetaphyDlmmRouter,
// and enables the default presets (bin steps 1, 10, 25, 100 bps; see
// DEFAULT_PRESETS). It adds contracts.dlmmFactory / dlmmRouter to the
// deployments file of cli.js deploy (default deployments/<chainId>.json),
// creating it if needed. Options:
//   --deployments <file>     the deployments file to read and extend
//   --wnative <addr>         wrapped native (default: the deployments file's, else on
//                            ZETAPHY the native ERC-20 precompile 0xEeee…EEeE)
//   --registry <addr>        Neuro ThreatRegistry for the router's check
//                            (default: the deployments file's threatRegistry, if set)
//   --fee-to <addr>          where protocol fees go (the protocol share stays 0 until governance sets it)
//   --governance <addr>      propose a handover (e.g. a TimelockController): it must call acceptGovernance()
//   --web [file]             also add the addresses to the web app's deployments.json
//                            (no file: web/deployments.json next to this CLI)
//   --any-chain              deploy on a chain other than ZETAPHY

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, getAddress, isAddress, keccak256 } from 'ethers';
import { parseArgs, loadKey, checkDeployChain, NATIVE_PRECOMPILE, ZETAPHY_EVM_CHAIN_ID } from './cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZERO = '0x0000000000000000000000000000000000000000';
const art = (n) => JSON.parse(readFileSync(resolve(HERE, 'artifacts', `${n}.json`), 'utf8'));

/** bin step -> [baseFeeBps, maxDynamicFeeBps, variableFeeControl, filterPeriod, decayPeriod, reductionFactor, maxVolatilityAccumulator, enabled] */
export const DEFAULT_PRESETS = {
  1: [1, 50, 2_000, 30, 600, 5_000, 100_000, true],
  10: [10, 100, 2_000, 30, 600, 5_000, 100_000, true],
  25: [25, 150, 2_000, 30, 600, 5_000, 100_000, true],
  100: [100, 300, 2_000, 30, 600, 5_000, 100_000, true],
};

const addrOpt = (v, name) => {
  if (v === undefined) return undefined;
  if (v === '0' || v === '0x0') return ZERO;
  if (!isAddress(v)) throw new Error(`${name}: not an address: ${v}`);
  return getAddress(v);
};

function connect(opt, needKey) {
  if (!opt.rpc) throw new Error('--rpc <url> is required');
  const provider = new JsonRpcProvider(opt.rpc, undefined, { staticNetwork: false, polling: true, pollingInterval: 1000 });
  const signer = needKey ? new Wallet(loadKey(opt['key-file'] ?? process.env.ZETAPHY_DEX_KEY_FILE), provider) : null;
  return { provider, signer };
}

const wait = async (txp) => { const r = await (await txp).wait(); if (r.status !== 1) throw new Error('transaction failed'); return r; };
const deploymentsFile = (opt, chainId) => resolve(opt.deployments ?? resolve(HERE, 'deployments', `${chainId}.json`));
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

async function deployOne(signer, name, args, log) {
  const a = art(name);
  const k = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await k.waitForDeployment();
  log(`${name} ${await k.getAddress()}`);
  return new Contract(await k.getAddress(), a.abi, signer);
}

export async function deploy(opt, log = console.log) {
  const { provider, signer } = connect(opt, true);
  try {
    const net = await provider.getNetwork();
    checkDeployChain(net.chainId, opt['any-chain']);
    const me = await signer.getAddress();
    const file = deploymentsFile(opt, net.chainId);
    const d = readJson(file) ?? { name: 'ZETAPHY DEX', chainId: Number(net.chainId), contracts: {}, tokens: [] };
    d.contracts ??= {};
    let wnative = opt.wnative ?? d.contracts.wnative ?? (net.chainId === ZETAPHY_EVM_CHAIN_ID ? NATIVE_PRECOMPILE : undefined);
    if (!wnative || !isAddress(wnative)) throw new Error('--wnative <address> is required here (no deployments file with one, not ZETAPHY)');
    wnative = getAddress(wnative);
    log(`chain ${net.chainId}, deployer ${me}, wrapped native ${wnative}`);
    const factory = await deployOne(signer, 'ZetaphyDlmmFactory', [me], log);
    const router = await deployOne(signer, 'ZetaphyDlmmRouter', [await factory.getAddress(), wnative], log);
    for (const [step, p] of Object.entries(DEFAULT_PRESETS)) {
      await wait(factory.setPreset(Number(step), p));
      log(`preset: bin step ${step} bps, base fee ${p[0]} bps, volatility fee up to +${p[1]} bps`);
    }
    const registry = addrOpt(opt.registry, '--registry') ?? (isAddress(d.contracts.threatRegistry ?? '') && d.contracts.threatRegistry !== ZERO ? getAddress(d.contracts.threatRegistry) : undefined);
    if (registry && registry !== ZERO) { await wait(factory.setThreatRegistry(registry)); log(`threat registry ${registry}`); }
    const feeTo = addrOpt(opt['fee-to'], '--fee-to');
    if (feeTo && feeTo !== ZERO) { await wait(factory.setFeeTo(feeTo)); log(`protocol fees go to ${feeTo} (share 0 until governance sets one)`); }
    const gov = addrOpt(opt.governance, '--governance');
    if (gov && gov !== me) { await wait(factory.setGovernance(gov)); log(`governance handover proposed to ${gov}: it must call acceptGovernance()`); }
    const codeHash = await factory.PAIR_CODE_HASH();
    if (codeHash !== keccak256(art('ZetaphyDlmmPair').bytecode)) throw new Error('PAIR_CODE_HASH does not match artifacts/ZetaphyDlmmPair.json');
    const add = { dlmmFactory: await factory.getAddress(), dlmmRouter: await router.getAddress(), dlmmPairCodeHash: codeHash };
    d.contracts = { ...d.contracts, ...add, wnative: d.contracts.wnative ?? wnative };
    d.dlmm = { unaudited: true, governance: me, pendingGovernance: gov && gov !== me ? gov : undefined, presets: Object.keys(DEFAULT_PRESETS).map(Number), deployedAt: new Date().toISOString() };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    log(`deployments written to ${file}`);
    if (opt.web) {
      const webFile = resolve(opt.web === true ? resolve(HERE, 'web', 'deployments.json') : opt.web);
      const w = readJson(webFile) ?? { name: 'ZETAPHY DEX', chainId: Number(net.chainId), contracts: null, tokens: [] };
      w.contracts = { ...(w.contracts ?? {}), ...add };
      writeFileSync(webFile, JSON.stringify(w, null, 2) + '\n');
      log(`web app config extended: ${webFile}`);
    }
    return d;
  } finally { provider.destroy(); }
}

function readDeployments(opt, chainId) {
  const d = readJson(deploymentsFile(opt, chainId));
  if (!d?.contracts?.dlmmFactory) throw new Error(`no dlmmFactory in ${deploymentsFile(opt, chainId)}: run dlmm-cli.js deploy first`);
  return d;
}

async function status(opt, log) {
  const { provider } = connect(opt, false);
  try {
    const net = await provider.getNetwork();
    const d = readDeployments(opt, net.chainId);
    const f = new Contract(d.contracts.dlmmFactory, art('ZetaphyDlmmFactory').abi, provider);
    const steps = (await f.presetSteps()).map(Number).sort((a, b) => a - b);
    log(JSON.stringify({ chainId: Number(net.chainId), dlmmFactory: d.contracts.dlmmFactory, dlmmRouter: d.contracts.dlmmRouter, governance: await f.governance(),
      pendingGovernance: await f.pendingGovernance(), feeTo: await f.feeTo(), threatRegistry: await f.threatRegistry(),
      defaultProtocolShareBps: Number(await f.defaultProtocolShareBps()), presets: steps, pairs: Number(await f.allPairsLength()) }, null, 2));
  } finally { provider.destroy(); }
}

async function govSet(fn, value, opt, log) {
  const { provider, signer } = connect(opt, true);
  try {
    const net = await provider.getNetwork();
    const d = readDeployments(opt, net.chainId);
    const f = new Contract(d.contracts.dlmmFactory, art('ZetaphyDlmmFactory').abi, signer);
    const a = addrOpt(value, fn);
    if (a === undefined) throw new Error(`${fn} <address|0x0>`);
    await wait(f[fn](a));
    log(`${fn}(${a}) done`);
  } finally { provider.destroy(); }
}

const HELP = (() => {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  return lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
})();

export async function main(argv, log = console.log) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  if (opt.key) throw new Error('--key is not accepted: put the key in a file (chmod 600) and pass --key-file');
  switch (cmd) {
    case 'deploy': return deploy(opt, log);
    case 'status': return status(opt, log);
    case 'set-registry': return govSet('setThreatRegistry', pos[0], opt, log);
    case 'set-fee-to': return govSet('setFeeTo', pos[0], opt, log);
    case 'set-governance': return govSet('setGovernance', pos[0], opt, log);
    default: log(HELP); if (cmd && cmd !== 'help' && cmd !== '--help') throw new Error(`unknown command ${cmd}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
