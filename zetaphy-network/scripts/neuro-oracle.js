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
//   node scripts/neuro-oracle.js wire --sender 0x… --receivers <name>=0x…[,<name>=0x…] [--handover] [--governance 0x<ZETAPHY timelock>]
//       on ZETAPHY: sender.setReceiver per chain (skipped when already set); with --handover, then governance to the
//       timelock (default: the table's). Once handed over, a new route is a timelock proposal: printed as `proposals`
//       ({ to, data }) instead of sent (.github/workflows/timelock.yml schedules it)
//   node scripts/neuro-oracle.js verify --chain <name> [--governance any|deployer|timelock]
//       read only, after a deploy: every address of neuro-oracle.json read back on both chains (the sender's registry,
//       NeuroJobs, Mailbox and route; the mirror's Mailbox, origin, sender, ISM = our validators' set and threshold,
//       governance, guardian, not paused). `ok` false (exit 1) on any mismatch
//   node scripts/neuro-oracle.js record --chain <name> [--sender-json f] --receiver-json f [--wire-json f] --zfrom N --ofrom N [--run id]
//       writes the deploy results into neuro-oracle.json (what the hub, the coverage meter and the relayer whitelist read)
//   node scripts/neuro-oracle.js coverage
//       read only: the share of ZETAPHY's flags each deployed mirror holds (neuro-oracle.json)
//
// Deployments are written to zetaphy-chain/hyperlane/neuro-oracle.json by the workflow's deploy mode (a manual run,
// environment testnet-deploy; the testnet deploy waits for the ZETAPHY RPC, paused until 2026-11-01).
// env: KEYFILE (deployer key file, never printed), DEPLOYER (check, verify),
// ORIGIN_RPC, ZETAPHY_RPC, SAPHAN_CHAINS / SAPHAN_ROUTES / NEURO_ORACLE (other files, e.g. a dry run's).
import { readFileSync, writeFileSync } from 'node:fs';
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

/**
 * On ZETAPHY: the route to each receiver (skipped when already set), then, when `governance` is given, governance to it.
 * When this key no longer governs the sender (handed over already), a missing route is returned as a timelock
 * proposal { chain, to, data } instead of being sent.
 */
export async function wire(t, signer, senderAddr, receivers, governance = null) {
  const s = new Contract(senderAddr, art('NeuroOracleSender').abi, signer);
  const me = getAddress(await signer.getAddress());
  const gov = getAddress(await s.governance());
  const routes = [], proposals = [];
  for (const [name, oracle] of Object.entries(receivers)) {
    const c = chainOf(t, name);
    if ((await s.receivers(c.domain)).toLowerCase() === bytes32(oracle)) { routes.push(name); continue; }
    if (gov !== me) { proposals.push({ chain: name, to: getAddress(senderAddr), data: s.interface.encodeFunctionData('setReceiver', [c.domain, bytes32(oracle)]) }); continue; }
    await (await s.setReceiver(c.domain, bytes32(oracle))).wait();
    if ((await s.receivers(c.domain)).toLowerCase() !== bytes32(oracle)) throw new Error(`route to ${name} not set`);
    routes.push(name);
  }
  let handedOver = false;
  if (governance && gov === me && getAddress(governance) !== me) {
    await (await s.setGovernance(getAddress(governance))).wait();
    handedOver = true;
  }
  return { sender: getAddress(senderAddr), routes, proposals, governance: getAddress(await s.governance()), handedOver };
}

const ISM_READ = ['function moduleType() view returns (uint8)', 'function validatorsAndThreshold(bytes) view returns (address[], uint8)'];

/**
 * Read only, after a deploy: the sender on ZETAPHY and the mirror on `name`, as recorded in `d` (neuro-oracle.json),
 * read back against the chain table. { ok, checks: [{ what, ok, got, want }] }. o.governance: what the sender's
 * governance must be: 'timelock' (handed over; o.timelock or the table's), 'deployer' (o.deployer) or 'any'.
 * o.factoryIsm false: skip the factory address check (a dry run with the test kit's ISM).
 */
export async function verifyDeployment(t, d, name, zp, p, o = {}) {
  const checks = [];
  const eq = (what, got, want) => checks.push({ what, ok: String(got).toLowerCase() === String(want).toLowerCase(), got: String(got), want: String(want) });
  const c = chainOf(t, name);
  const r = d?.receivers?.[name];
  if (!d?.sender || !r?.oracle) {
    return { ok: false, checks: [{ what: `neuro-oracle.json has the sender and a receiver for ${name}`, ok: false, got: JSON.stringify({ sender: d?.sender ?? null, oracle: r?.oracle ?? null }), want: 'addresses' }] };
  }
  // ZETAPHY: the sender
  const s = new Contract(d.sender, art('NeuroOracleSender').abi, zp);
  eq('ZETAPHY: sender has code', (await zp.getCode(d.sender)) !== '0x', true);
  eq("ZETAPHY: sender.threats = the ThreatRegistry", getAddress(await s.threats()), d.zetaphy?.threats ?? t.zetaphy.threats);
  eq('ZETAPHY: sender.jobs = NeuroJobs', getAddress(await s.jobs()), d.zetaphy?.jobs ?? t.zetaphy.neuroJobs);
  eq('ZETAPHY: sender.mailbox = the Mailbox', getAddress(await s.mailbox()), d.zetaphy?.mailbox ?? t.zetaphy.mailbox);
  eq(`ZETAPHY: sender route to ${name} (domain ${c.domain})`, (await s.receivers(c.domain)).toLowerCase(), bytes32(r.oracle));
  const g = getAddress(await s.governance());
  const want = o.governance === 'deployer' ? o.deployer : o.governance === 'any' ? g : (o.timelock ?? t.zetaphy.timelock);
  eq(`ZETAPHY: sender governance (${o.governance ?? 'timelock'})`, g, want);
  // the chain: the mirror
  const k = new Contract(r.oracle, art('NeuroOracle').abi, p);
  eq(`${name}: oracle has code`, (await p.getCode(r.oracle)) !== '0x', true);
  eq(`${name}: oracle.mailbox = the chain's Mailbox`, getAddress(await k.mailbox()), c.mailbox);
  eq(`${name}: oracle.zetaphyDomain`, Number(await k.zetaphyDomain()), t.zetaphy.domain);
  eq(`${name}: oracle.zetaphyChainId`, BigInt(await k.zetaphyChainId()), BigInt(t.zetaphy.chainId));
  eq(`${name}: oracle.remoteSender = the sender`, (await k.remoteSender()).toLowerCase(), bytes32(d.sender));
  const ism = getAddress(await k.interchainSecurityModule());
  if (r.ism) eq(`${name}: oracle ISM = the recorded ISM`, ism, r.ism);
  const ours = t.zetaphyValidators;
  if (o.factoryIsm !== false && ours.validators.length) {
    const f = await factoryIsm(p, c.staticMessageIdMultisigIsmFactory, ours.validators, ours.threshold);
    eq(`${name}: oracle ISM = the factory's ISM of our validators`, ism, f.at);
  }
  try {
    const [vs, th] = await new Contract(ism, ISM_READ, p).validatorsAndThreshold('0x');
    eq(`${name}: ISM validators = zetaphyValidators`, [...vs].map((x) => getAddress(x)).sort().join(','), [...ours.validators].map((x) => getAddress(x)).sort().join(','));
    eq(`${name}: ISM threshold`, Number(th), ours.threshold);
  } catch (e) { checks.push({ what: `${name}: ISM answers validatorsAndThreshold`, ok: false, got: e.shortMessage ?? e.message, want: 'an answer' }); }
  if (r.governance) eq(`${name}: oracle governance = the chain's timelock`, getAddress(await k.governance()), r.governance);
  if (r.guardian) eq(`${name}: the chain's multisig is a guardian`, await k.guardian(r.guardian), true);
  eq(`${name}: oracle not paused`, await k.paused(), false);
  return { ok: checks.every((x) => x.ok), checks };
}

export const ABOUT = 'Neuro cross-chain security oracle (docs/future/crosschain-assist.md, item 18): NeuroOracleSender on ZETAPHY and the NeuroOracle mirror per chain. Written by .github/workflows/neuro-oracle.yml (mode deploy); read by the hub (Immunity tab), neuro-oracle.js coverage and the relayer whitelist. Testnets only.';

/**
 * The deploy results merged into neuro-oracle.json's content (pure): the sender (kept when already recorded), the
 * receiver of `name`, the deploy blocks and the workflow run. The hub (immuneMirrors), the coverage meter and the
 * relayer whitelist read this file.
 */
export function recordDeployment(d, { name, sender = null, receiver = null, zfrom = null, ofrom = null, run = null, governance = null }) {
  const out = { about: d?.about ?? ABOUT, sender: d?.sender ?? null, zetaphy: d?.zetaphy ?? null, receivers: { ...(d?.receivers ?? {}) } };
  if (sender) {
    if (out.sender && getAddress(out.sender) !== getAddress(sender.sender)) throw new Error(`neuro-oracle.json already has the sender ${out.sender}, not ${sender.sender}`);
    if (!Number.isInteger(Number(zfrom)) || zfrom == null) throw new Error('--zfrom: the ZETAPHY block the sender was deployed from');
    out.sender = getAddress(sender.sender);
    out.zetaphy = { threats: getAddress(sender.threats), jobs: getAddress(sender.jobs), mailbox: getAddress(sender.mailbox), tx: sender.tx ?? null, fromBlock: Number(zfrom) };
  }
  if (!out.sender) throw new Error('no sender: record the sender first (--sender-json)');
  if (governance) out.zetaphy = { ...(out.zetaphy ?? {}), governance: getAddress(governance) };
  if (receiver) {
    if (receiver.chain !== name) throw new Error(`the receiver is for ${receiver.chain}, not ${name}`);
    if (!Number.isInteger(Number(ofrom)) || ofrom == null) throw new Error('--ofrom: the chain block the receiver was deployed from');
    out.receivers[name] = { oracle: getAddress(receiver.oracle), ism: getAddress(receiver.ism), governance: getAddress(receiver.governance), guardian: getAddress(receiver.guardian),
      tx: receiver.tx ?? null, fromBlock: Number(ofrom), ...(run ? { workflowRun: String(run) } : {}) };
  }
  out.receivers = Object.fromEntries(Object.entries(out.receivers).sort(([a], [b]) => (a < b ? -1 : 1)));
  return out;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] == null || argv[i + 1].startsWith('--') ? true : argv[++i];
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
      res = await wire(t, keySigner(zp), getAddress(o.sender), receivers, o.handover ? (o.governance ?? t.zetaphy.timelock) : null);
    } else if (cmd === 'verify') {
      const v = await verifyDeployment(t, loadOracles(), o.chain, await zetaphyP(), await chainP(o.chain),
        { governance: o.governance ?? 'timelock', deployer: process.env.DEPLOYER ? getAddress(process.env.DEPLOYER) : null });
      for (const x of v.checks) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.what}${x.ok ? '' : `: ${x.got}, expected ${x.want}`}`);
      console.log(JSON.stringify(v));
      process.exit(v.ok ? 0 : 1);
    } else if (cmd === 'record') {
      chainOf(t, o.chain);
      const j = (f) => (f ? JSON.parse(readFileSync(f, 'utf8')) : null);
      res = recordDeployment(loadOracles(), { name: o.chain, sender: j(o['sender-json']), receiver: j(o['receiver-json']), zfrom: o.zfrom, ofrom: o.ofrom,
        run: o.run, governance: j(o['wire-json'])?.governance ?? null });
      writeFileSync(process.env.NEURO_ORACLE || ORACLE_FILE, JSON.stringify(res, null, 2) + '\n');
    } else if (cmd === 'coverage') {
      const d = loadOracles();
      if (!d.sender) throw new Error('no NeuroOracleSender in neuro-oracle.json yet (deployed after 2026-11-01)');
      const mirrors = [];
      for (const [name, r] of Object.entries(d.receivers ?? {})) mirrors.push({ name, oracle: oracleContract(r.oracle, await chainP(name)) });
      res = await measure(senderContract(d.sender, await zetaphyP()), mirrors);
      for (const m of res.mirrors) console.log(`${m.name}: ${m.error ?? coverageText(m.share)}`);
    } else throw new Error('usage: neuro-oracle.js check --chain <name> | sender | receiver --chain <name> --sender 0x… | wire --sender 0x… --receivers a=0x…,b=0x… [--handover] | verify --chain <name> | record --chain <name> … | coverage');
    console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    process.exit(0);
  })().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
