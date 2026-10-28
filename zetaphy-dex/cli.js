#!/usr/bin/env node
// ZETAPHY DEX command line: deploy the contracts and manage their governance settings.
//
//   node cli.js deploy  --rpc <url> --key-file <file> [options]
//   node cli.js status  --rpc <url> [--deployments <file>]
//   node cli.js set-registry <address|0x0> --rpc <url> --key-file <file> [--deployments <file>]
//   node cli.js set-fee-to   <address|0x0> --rpc <url> --key-file <file> [--deployments <file>]
//   node cli.js set-neuro-score <NeuroScore|0x0> [--min-p 0.8] --rpc <url> --key-file <file> [--deployments <file>]
//                            the router's optional buy check (off by default): refuse buying a token whose
//                            current NeuroScore probability is >= --min-p (stored as the calibrated logit x 1e7)
//   node cli.js mint-test <token> <to> <amount> --rpc <url> --key-file <file>
//
// The key: a file holding a 0x… private key, or an Ethereum keystore JSON (then
// ZETAPHY_PASSPHRASE decrypts it). --key-file can also come from
// ZETAPHY_DEX_KEY_FILE. A key is never taken on the command line or asked for.
// A key file that other users can read (group or world) is refused: chmod 600 it.
// Use a testnet-only key: this DEX is unaudited.
//
// deploy options:
//   --wnative <addr|deploy>  the wrapped native coin. Default on ZETAPHY (EVM chain id 77390):
//                            the native ERC-20 precompile 0xEeee…EEeE (checked first);
//                            elsewhere: deploy WZETAPHY.
//   --governance <addr>      hand governance over to this address (it must call acceptGovernance)
//   --registry <addr>        Neuro ThreatRegistry for the router's check (default: off)
//   --fee-to <addr>          switch the protocol fee on (default: off)
//   --test-tokens            also deploy two test tokens (no value) and seed a pool with each
//   --public-rpc <https url> the RPC URL the web app should use (written to the deployments file)
//   --out <file>             default deployments/<chainId>.json
//   --web [file]             also write the web app's deployments.json; with no file: web/deployments.json
//                            (next to this CLI, whatever the current directory)
//   --any-chain              deploy on a chain other than ZETAPHY (EVM chain id 77390); refused without it

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, parseUnits, formatUnits, getAddress, isAddress, keccak256 } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
export const NATIVE_PRECOMPILE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ZETAPHY_EVM_CHAIN_ID = 77390n;
const ZERO = '0x0000000000000000000000000000000000000000';
export const WEB_DEPLOYMENTS = resolve(HERE, 'web', 'deployments.json');
const art = (n) => JSON.parse(readFileSync(resolve(HERE, 'artifacts', `${n}.json`), 'utf8'));

export function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['test-tokens', 'help', 'any-chain'].includes(k)) opt[k] = true;
      // --web takes an optional file: bare --web means the page's own deployments.json.
      else if (k === 'web' && (i + 1 >= argv.length || argv[i + 1].startsWith('--'))) opt.web = WEB_DEPLOYMENTS;
      else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); opt[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, opt };
}

/** The signer's key, from a file (plain hex or keystore JSON). Never from argv. */
export function loadKey(file) {
  if (!file) throw new Error('no key: pass --key-file <file> or set ZETAPHY_DEX_KEY_FILE (never a key on the command line)');
  const st = statSync(file);
  if (process.platform !== 'win32' && (st.mode & 0o077)) {
    throw new Error(`${file} is readable or writable by other users (mode ${(st.mode & 0o777).toString(8)}): run chmod 600 ${file}`);
  }
  const text = readFileSync(file, 'utf8').trim();
  if (text.startsWith('{')) {
    const pass = process.env.ZETAPHY_PASSPHRASE;
    if (!pass) throw new Error(`${file} is an encrypted keystore: set ZETAPHY_PASSPHRASE`);
    return Wallet.fromEncryptedJsonSync(text, pass).privateKey;
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(text)) throw new Error(`${file} does not hold a 32-byte hex private key`);
  return text.startsWith('0x') ? text : '0x' + text;
}

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

/** True if `addr` answers like the native ERC-20 (18 decimals, a symbol). */
async function isNativeErc20(provider, addr) {
  const c = new Contract(addr, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)'], provider);
  try {
    const [d] = await Promise.all([c.decimals(), c.symbol(), c.balanceOf(ZERO)]);
    return d === 18n;
  } catch { return false; }
}

async function deployOne(signer, name, args, log) {
  const a = art(name);
  const k = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await k.waitForDeployment();
  const address = await k.getAddress();
  log(`${name} ${address}`);
  return new Contract(address, a.abi, signer);
}

const wait = async (txp) => { const r = await (await txp).wait(); if (r.status !== 1) throw new Error('transaction failed'); return r; };

/** deploy runs on ZETAPHY (77390) only, unless --any-chain says otherwise. */
export function checkDeployChain(chainId, anyChain) {
  if (chainId !== ZETAPHY_EVM_CHAIN_ID && !anyChain) {
    throw new Error(`the RPC is on chain id ${chainId}, not ZETAPHY (${ZETAPHY_EVM_CHAIN_ID}); pass --any-chain to deploy there anyway`);
  }
}

export async function deploy(opt, log = console.log) {
  const { provider, signer } = connect(opt, true);
  try {
    return await deployWith(provider, signer, opt, log);
  } finally { provider.destroy(); }
}

async function deployWith(provider, signer, opt, log) {
  const net = await provider.getNetwork();
  checkDeployChain(net.chainId, opt['any-chain']);
  const me = await signer.getAddress();
  log(`chain ${net.chainId}, deployer ${me}, balance ${formatUnits(await provider.getBalance(me), 18)}`);

  let wnative = opt.wnative;
  if (!wnative) wnative = net.chainId === ZETAPHY_EVM_CHAIN_ID ? NATIVE_PRECOMPILE : 'deploy';
  let wnativeKind;
  if (wnative === 'deploy') {
    wnative = await (await deployOne(signer, 'WZETAPHY', [], log)).getAddress();
    wnativeKind = 'WZETAPHY';
  } else {
    wnative = getAddress(wnative);
    if (!(await isNativeErc20(provider, wnative))) throw new Error(`${wnative} does not answer as an 18-decimal ERC-20 (no native precompile here? use --wnative deploy)`);
    wnativeKind = wnative === NATIVE_PRECOMPILE ? 'native-precompile' : 'erc20';
    log(`wrapped native: ${wnative} (${wnativeKind})`);
  }

  const factory = await deployOne(signer, 'ZetaphyFactory', [me], log);
  const router = await deployOne(signer, 'ZetaphyRouter', [await factory.getAddress(), wnative], log);
  const registry = addrOpt(opt.registry, '--registry');
  if (registry && registry !== ZERO) { await wait(factory.setThreatRegistry(registry)); log(`threat registry ${registry}`); }
  const feeTo = addrOpt(opt['fee-to'], '--fee-to');
  if (feeTo && feeTo !== ZERO) { await wait(factory.setFeeTo(feeTo)); log(`protocol fee on, to ${feeTo}`); }

  const tokens = [];
  if (opt['test-tokens']) {
    const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
    for (const [name, symbol, supply, seedNative] of [['Test USD (testnet, no value)', 'tUSD', 10_000_000n, 100n], ['Test SWD (testnet, no value)', 'tSWD', 100_000_000n, 100n]]) {
      const t = await deployOne(signer, 'TestToken', [name, symbol, 18, supply * 10n ** 18n, 0], log);
      const ta = await t.getAddress();
      tokens.push({ address: ta, name, symbol, decimals: 18, test: true });
      // Seed a pool: 1000 tokens per native coin (exact approval, not unlimited).
      const amount = seedNative * 1000n * 10n ** 18n;
      await wait(t.approve(await router.getAddress(), amount));
      await wait(router.addLiquidityETH(ta, amount, amount, seedNative * 10n ** 18n, me, deadline(), { value: seedNative * 10n ** 18n }));
      log(`pool ${symbol}/ZTPHY seeded: ${formatUnits(amount, 18)} ${symbol} + ${seedNative} ZTPHY`);
    }
  }

  const gov = addrOpt(opt.governance, '--governance');
  if (gov && gov !== me) { await wait(factory.setGovernance(gov)); log(`governance handover proposed to ${gov}: it must call acceptGovernance()`); }

  const out = {
    name: 'ZETAPHY DEX',
    chainId: Number(net.chainId),
    cosmosChainId: net.chainId === ZETAPHY_EVM_CHAIN_ID ? 'zetaphy_77390-1' : undefined,
    rpc: opt['public-rpc'] ?? (/^https:\/\//.test(opt.rpc) ? opt.rpc : ''),
    contracts: {
      factory: await factory.getAddress(),
      router: await router.getAddress(),
      wnative,
      wnativeKind,
      pairCodeHash: await factory.PAIR_CODE_HASH(),
      threatRegistry: await factory.threatRegistry(),
    },
    governance: me,
    pendingGovernance: gov && gov !== me ? gov : undefined,
    feeTo: await factory.feeTo(),
    tokens,
    deployedAt: new Date().toISOString(),
    artifactsHash: keccak256(Buffer.from(['ZetaphyFactory', 'ZetaphyPair', 'ZetaphyRouter'].map((n) => art(n).bytecode).join(''))),
  };
  if (out.contracts.pairCodeHash !== keccak256(art('ZetaphyPair').bytecode)) throw new Error('PAIR_CODE_HASH does not match artifacts/ZetaphyPair.json');
  const file = resolve(opt.out ?? resolve(HERE, 'deployments', `${net.chainId}.json`));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  log(`deployments written to ${file}`);
  if (opt.web) { writeFileSync(resolve(opt.web), JSON.stringify(out, null, 2) + '\n'); log(`web app config written to ${resolve(opt.web)}`); }
  return out;
}

function readDeployments(opt, chainId) {
  const file = opt.deployments ?? resolve(HERE, 'deployments', `${chainId}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function status(opt, log) {
  const { provider } = connect(opt, false);
  const net = await provider.getNetwork();
  const d = readDeployments(opt, net.chainId);
  const f = new Contract(d.contracts.factory, art('ZetaphyFactory').abi, provider);
  const n = await f.allPairsLength();
  log(JSON.stringify({ chainId: Number(net.chainId), factory: d.contracts.factory, router: d.contracts.router, wnative: d.contracts.wnative,
    governance: await f.governance(), pendingGovernance: await f.pendingGovernance(), feeTo: await f.feeTo(), threatRegistry: await f.threatRegistry(), pairs: Number(n) }, null, 2));
  const pairAbi = art('ZetaphyPair').abi;
  for (let i = 0n; i < n && i < 50n; i++) {
    const p = new Contract(await f.allPairs(i), pairAbi, provider);
    const [r0, r1] = await p.getReserves();
    log(`pair ${await p.getAddress()}: ${await p.token0()} ${formatUnits(r0, 18)} / ${await p.token1()} ${formatUnits(r1, 18)}`);
  }
}

async function govSet(fn, value, opt, log) {
  const { provider, signer } = connect(opt, true);
  const net = await provider.getNetwork();
  const d = readDeployments(opt, net.chainId);
  const f = new Contract(d.contracts.factory, art('ZetaphyFactory').abi, signer);
  const a = addrOpt(value, fn);
  if (a === undefined) throw new Error(`${fn} <address|0x0>`);
  await wait(f[fn](a));
  log(`${fn}(${a}) done`);
}

/** Probability -> NeuroScore's fixed score (calibrated logit x 1e7), as in zetaphy-neuro/ml/onchain/fixed.js. */
export function scoreThresholdOf(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) throw new Error(`--min-p: a probability strictly between 0 and 1, got ${p}`);
  return BigInt(Math.round(Math.log(x / (1 - x)) * 1e7));
}

async function setNeuroScore(value, opt, log) {
  const a = addrOpt(value, 'set-neuro-score');
  if (a === undefined) throw new Error('set-neuro-score <address|0x0> [--min-p 0.8]');
  const threshold = a === ZERO ? 0n : scoreThresholdOf(opt['min-p'] ?? '0.8');
  const { provider, signer } = connect(opt, true);
  const net = await provider.getNetwork();
  const d = readDeployments(opt, net.chainId);
  const f = new Contract(d.contracts.factory, art('ZetaphyFactory').abi, signer);
  await wait(f.setNeuroScore(a, threshold));
  log(`setNeuroScore(${a}, ${threshold}) done`);
}

async function mintTest(pos, opt, log) {
  const [token, to, amount] = pos;
  if (!isAddress(token) || !isAddress(to) || !amount) throw new Error('mint-test <token> <to> <amount>');
  const { signer } = connect(opt, true);
  const t = new Contract(token, art('TestToken').abi, signer);
  await wait(t.mint(to, parseUnits(amount, await t.decimals())));
  log(`minted ${amount} ${await t.symbol()} to ${to}`);
}

// The header comment, up to the first line that is not a comment.
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
    case 'set-neuro-score': return setNeuroScore(pos[0], opt, log);
    case 'mint-test': return mintTest(pos, opt, log);
    default: log(HELP); if (cmd && cmd !== 'help' && cmd !== '--help') throw new Error(`unknown command ${cmd}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
