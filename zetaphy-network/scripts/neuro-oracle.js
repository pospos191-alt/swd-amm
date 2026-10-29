#!/usr/bin/env node
// Neuro cross-chain security oracle (docs/future/crosschain-assist.md, item 18): the deploy steps, saphan-route style,
// for every chain of zetaphy-chain/hyperlane/saphan-chains.json. Used by .github/workflows/neuro-oracle.yml.
//
//   node scripts/neuro-oracle.js check --chain <name>
//       read only: the chain's Mailbox (localDomain), our validators' ISM there (the factory's address for them),
//       the deployer's balance and nonce, the chain's v2 route roles if deployed. JSON on the last line.
//   node scripts/neuro-oracle.js sender [--governance 0x…]
//       on ZETAPHY: NeuroOracleSender reading the table's ThreatRegistry and NeuroJobs, sending through its Mailbox;
//       governance stays the deployer until `wire` hands it over
//   node scripts/neuro-oracle.js receiver --chain <name> --sender 0x… [--multisig 0x… --timelock 0x…]
//       on the chain: our ISM (the factory, unless it exists) and NeuroOracle (governance: the chain's timelock,
//       guardian: its multisig; the v2 route's when deployed, else new ones as saphan.js origin-prepare)
//   node scripts/neuro-oracle.js wire --sender 0x… --receivers <name>=0x…[,<name>=0x…] [--governance 0x<ZETAPHY timelock>]
//       on ZETAPHY: sender.setReceiver per chain, then governance to the timelock
//   node scripts/neuro-oracle.js coverage
//       read only: the share of ZETAPHY's flags each deployed mirror holds (neuro-oracle.json)
//
// Deployments are written to zetaphy-chain/hyperlane/neuro-oracle.json by the workflow (after 2026-11-01; until
// then the workflow runs check and dry_run only). env: KEYFILE (deployer key file, never printed), DEPLOYER (check),
// ORIGIN_RPC, ZETAPHY_RPC, SAPHAN_CHAINS / SAPHAN_ROUTES / NEURO_ORACLE (other files, e.g. a dry run's).
import { readFileSync } from 'node:fs';
import { Wallet, Contract, ContractFactory, NonceManager, getAddress, formatEther, zeroPadValue } from 'ethers';
import { loadChains, chainOf, loadRoutes, bytes32 } from '../src/saphan.js';
import { providerFor, factoryIsm, ensureIsm, originPrepare } from './saphan.js';
import { senderContract, oracleContract, measure, coverageText } from '../src/neurooracle.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const ORACLE_FILE = new URL('../../zetaphy-chain/hyperlane/neuro-oracle.json', import.meta.url);
const MAILBOX = ['function localDomain() view returns (uint32)'];
const ZERO = '0x' + '00'.repeat(20);

export function loadOracles(file = process.env.NEURO_ORACLE || ORACLE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { sender: null, receivers: {} }; }
}

async function deployArt(name, args, signer) {
  const a = art(name);
  const k = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await k.waitForDeployment();
  return k;
}

/** Read only, on the destination chain. */
export async function oracleCheck(t, c, p, deployer) {
  const domain = Number(await new Contract(c.mailbox, MAILBOX, p).localDomain());
  if (domain !== c.domain) throw new Error(`the ${c.name} Mailbox's localDomain is ${domain}, not ${c.domain}`);
  const ours = t.zetaphyValidators;
  const ism = ours.validators.length ? await factoryIsm(p, c.staticMessageIdMultisigIsmFactory, ours.validators, ours.threshold) : null;
  const route = loadRoutes()[c.name]?.origin ?? null;
  return { chain: c.name, chainId: c.chainId, domain, mailbox: getAddress(c.mailbox), ourIsm: ism ? { address: ism.at, deployed: ism.deployed } : null,
    ourValidatorsSet: ours.validators.length > 0, routeRoles: route ? { multisig: route.multisig, timelock: route.timelock } : null,
    deployer, balance: formatEther(await p.getBalance(deployer)), nonce: await p.getTransactionCount(deployer, 'latest') };
}

/** On ZETAPHY: the sender (governance: the deployer until wire). */
export async function deploySender(t, zp, signer, o = {}) {
  const threats = getAddress(o.threats ?? t.zetaphy.threats);
  const jobs = o.jobs === 'none' ? ZERO : getAddress(o.jobs ?? t.zetaphy.neuroJobs);
  const mailbox = getAddress(o.mailbox ?? t.zetaphy.mailbox);
  for (const [k, v] of [['threats', threats], ['mailbox', mailbox]]) if ((await zp.getCode(v)) === '0x') throw new Error(`no ${k} contract at ${v} on ZETAPHY`);
  const me = await signer.getAddress();
  const k = await deployArt('NeuroOracleSender', [threats, jobs, mailbox, o.governance ? getAddress(o.governance) : me], signer);
  const s = senderContract(getAddress(k.target), zp);
  if (getAddress(await s.threats()) !== threats) throw new Error('the sender does not read back its registry');
  return { sender: getAddress(k.target), threats, jobs, mailbox, governance: o.governance ?? me, tx: k.deploymentTransaction()?.hash ?? null };
}

/**
 * On the destination: our ISM (the factory, or o.ism as given: the kit in a local dry run) and the NeuroOracle.
 * governance / guardian: the chain's v2 timelock and multisig (o.timelock / o.multisig, else the route's, else new ones).
 */
export async function deployReceiver(t, c, p, signer, o) {
  const sender = getAddress(o.sender);
  let ism = o.ism ? getAddress(o.ism) : null;
  if (!ism) ({ ism } = await ensureIsm(p, signer, c.staticMessageIdMultisigIsmFactory, t.zetaphyValidators.validators, t.zetaphyValidators.threshold));
  let { multisig, timelock } = { ...(loadRoutes()[c.name]?.origin ?? {}), ...o };
  if (!multisig || !timelock) ({ multisig, timelock } = await originPrepare(t, c, p, signer, { multisig, timelock }));
  const k = await deployArt('NeuroOracle', [c.mailbox, t.zetaphy.domain, BigInt(t.zetaphy.chainId), zeroPadValue(sender, 32), ism, timelock, multisig], signer);
  const addr = getAddress(k.target);
  const ok = getAddress(await k.mailbox()) === getAddress(c.mailbox) && Number(await k.zetaphyDomain()) === t.zetaphy.domain
    && (await k.remoteSender()).toLowerCase() === bytes32(sender) && getAddress(await k.interchainSecurityModule()) === getAddress(ism)
    && getAddress(await k.governance()) === getAddress(timelock) && (await k.guardian(multisig));
  if (!ok) throw new Error('the deployed NeuroOracle does not read back as configured');
  return { chain: c.name, oracle: addr, ism, governance: timelock, guardian: multisig, tx: k.deploymentTransaction()?.hash ?? null };
}

/** On ZETAPHY: the routes to each receiver, then governance to the timelock (when given). */
export async function wire(t, signer, senderAddr, receivers, governance = null) {
  const s = new Contract(senderAddr, art('NeuroOracleSender').abi, signer);
  for (const [name, oracle] of Object.entries(receivers)) {
    const c = chainOf(t, name);
    await (await s.setReceiver(c.domain, bytes32(oracle))).wait();
    if ((await s.receivers(c.domain)).toLowerCase() !== bytes32(oracle)) throw new Error(`route to ${name} not set`);
  }
  if (governance) await (await s.setGovernance(getAddress(governance))).wait();
  return { sender: senderAddr, routes: Object.keys(receivers), governance: governance ?? await signer.getAddress() };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}
const keySigner = (p) => new NonceManager(new Wallet(readFileSync(String(process.env.KEYFILE), 'utf8').trim()).connect(p));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  (async () => {
    const t = loadChains();
    const zetaphyP = () => providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
    const chainP = (name) => { const c = chainOf(t, name); return providerFor(process.env.ORIGIN_RPC || c.rpc.join(','), c.chainId); };
    let res;
    if (cmd === 'check') res = await oracleCheck(t, chainOf(t, o.chain), await chainP(o.chain), getAddress(String(process.env.DEPLOYER ?? '')));
    else if (cmd === 'sender') { const zp = await zetaphyP(); res = await deploySender(t, zp, keySigner(zp), o); }
    else if (cmd === 'receiver') { const p = await chainP(o.chain); res = await deployReceiver(t, chainOf(t, o.chain), p, keySigner(p), o); }
    else if (cmd === 'wire') {
      const zp = await zetaphyP();
      const receivers = Object.fromEntries(String(o.receivers ?? '').split(',').filter(Boolean).map((x) => x.split('=')));
      res = await wire(t, keySigner(zp), getAddress(o.sender), receivers, o.governance ?? t.zetaphy.timelock);
    } else if (cmd === 'coverage') {
      const d = loadOracles();
      if (!d.sender) throw new Error('no NeuroOracleSender in neuro-oracle.json yet (deployed after 2026-11-01)');
      const mirrors = [];
      for (const [name, r] of Object.entries(d.receivers ?? {})) mirrors.push({ name, oracle: oracleContract(r.oracle, await chainP(name)) });
      res = await measure(senderContract(d.sender, await zetaphyP()), mirrors);
      for (const m of res.mirrors) console.log(`${m.name}: ${m.error ?? coverageText(m.share)}`);
    } else throw new Error('usage: neuro-oracle.js check --chain <name> | sender | receiver --chain <name> --sender 0x… | wire --sender 0x… --receivers a=0x…,b=0x… | coverage');
    console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    process.exit(0);
  })().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
