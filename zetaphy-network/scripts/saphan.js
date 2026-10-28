#!/usr/bin/env node
// ZETAPHY Saphan, EVM routes v2: the source-chain side of one route, for any chain in
// zetaphy-chain/hyperlane/saphan-chains.json (src/saphan.js). Used by the saphan-route workflow.
//
//   node scripts/saphan.js check --chain <name>
//       read only: the source chain's Mailbox, merkle tree hook and ISM factory, the lock fee,
//       our validator ISM's address (made by the factory, the same for the same validators),
//       the deployer's balance and nonce. JSON on the last line.
//   node scripts/saphan.js origin-prepare --chain <name> [--multisig 0x… --timelock 0x…]
//       the source chain's own roles: a SimpleMultisig (guardian, proposer) and a ZetaphyTimelock
//       (governance), and our multisig ISM for origin ZETAPHY (the factory, unless it exists);
//       then the address the lockbox will get (deployer + nonce). Reuses what --multisig / --timelock name.
//   node scripts/saphan.js zetaphy-ism --chain <name>
//       on ZETAPHY: the multisig ISM of Hyperlane's validators for that source chain (ZETAPHY's
//       factory, unless it exists), for the route's HyperlaneLane.
//   node scripts/saphan.js origin-lockbox --chain <name> --lane 0x… --outbox 0x… --expect 0x… --multisig 0x… --timelock 0x… --ism 0x…
//       the HyperlaneLockBoxV2; refuses if the deployer's nonce moved (the ZETAPHY side points at --expect).
//   node scripts/saphan.js whitelist          the relayer's HYP_WHITELIST for every deployed route (+ the v1 lockbox)
//   node scripts/saphan.js pending            per two-way route: the outbox's sends on ZETAPHY vs releases the lockbox recorded
//   node scripts/saphan.js relayer-env [--sepolia-v1-from <block>] [--validator yes]
//       the relayer's settings for every deployed route (no secrets): chains, whitelist, where to start reading
//   node scripts/saphan.js gate --state <file>  the relayer workflow's "anything to do?": run the relayer while a lockbox
//       locked something in the last 2 days (its nonce changed; source-chain RPCs only), and the validator too while a
//       ZETAPHY -> source release waits (outbox nonce > lockbox received: one eth_call per route on ZETAPHY)
//
// env: ORIGIN_RPC (comma-separated; default: the chain table's), ZETAPHY_RPC (zetaphy-ism, pending),
// KEYFILE (the deployer key file, never printed), DEPLOYER (check), SAPHAN_CHAINS / SAPHAN_ROUTES
// (another chain table / routes file, e.g. a dry run's).
import { readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, getAddress, getCreateAddress, formatEther, parseEther, zeroPadValue, AbiCoder, id as keccakId } from 'ethers';
import { loadChains, chainOf, sortAddresses, loadRoutes, relayerWhitelist, bytes32 } from '../src/saphan.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ZERO = '0x' + '00'.repeat(20);
const MAILBOX = ['function localDomain() view returns (uint32)', 'function defaultHook() view returns (address)', 'function requiredHook() view returns (address)',
  'function quoteDispatch(uint32,bytes32,bytes,bytes,address) view returns (uint256)'];
const HOOK = ['function hookType() view returns (uint8)', 'function mailbox() view returns (address)', 'function count() view returns (uint32)'];
const FACTORY = ['function deploy(address[] _values, uint8 _threshold) returns (address)', 'function getAddress(address[] _values, uint8 _threshold) view returns (address)'];
const ISM = ['function moduleType() view returns (uint8)', 'function validatorsAndThreshold(bytes) view returns (address[], uint8)'];
const MESSAGE_ID_MULTISIG = 5;     // IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG
const MERKLE_TREE_HOOK_TYPE = 3;   // IPostDispatchHook.Types.MERKLE_TREE

/** The first RPC of the list that answers the expected chain id. */
export async function providerFor(urls, chainId) {
  for (const url of String(urls ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const p = new JsonRpcProvider(url, BigInt(chainId), { staticNetwork: true });
      if (BigInt(await p.send('eth_chainId', [])) === BigInt(chainId)) return p;
      p.destroy();
    } catch { /* next */ }
  }
  throw new Error(`no RPC answered chain ${chainId}`);
}

async function step(label, fn) {
  try { return await fn(); } catch (e) { throw new Error(`${label}: ${e.shortMessage ?? e.message}`); }
}

/** A multisig ISM from a Hyperlane StaticMessageIdMultisigIsmFactory: its address (CREATE2 of the sorted validators and threshold). */
export async function factoryIsm(p, factory, validators, threshold) {
  if ((await p.getCode(factory)) === '0x') throw new Error(`no ISM factory at ${factory}`);
  const v = sortAddresses(validators);
  const at = getAddress(await step('factory.getAddress', () => new Contract(factory, FACTORY, p).getFunction('getAddress')(v, threshold)));
  return { at, deployed: (await p.getCode(at)) !== '0x', validators: v, threshold };
}

/** Deploys the ISM through the factory unless it exists, then reads it back. */
export async function ensureIsm(p, signer, factory, validators, threshold) {
  const x = await factoryIsm(p, factory, validators, threshold);
  if (!x.deployed) await (await new Contract(factory, FACTORY, signer).deploy(x.validators, x.threshold)).wait();
  const ism = new Contract(x.at, ISM, p);
  const [vs, th] = await step('ism.validatorsAndThreshold', () => ism.validatorsAndThreshold('0x'));
  const t = Number(await ism.moduleType());
  if (t !== MESSAGE_ID_MULTISIG || Number(th) !== x.threshold || vs.map(getAddress).join() !== x.validators.join()) {
    throw new Error(`the ISM at ${x.at} reads back type ${t}, ${th} of [${vs.join(', ')}], not ${x.threshold} of [${x.validators.join(', ')}]`);
  }
  return { ism: x.at, created: !x.deployed };
}

/** The merkle tree hook of the source Mailbox: the tree Hyperlane's validators for that chain sign. */
async function merkleHook(p, c) {
  const h = new Contract(c.merkleTreeHook, HOOK, p);
  const code = await p.getCode(c.merkleTreeHook);
  if (code === '0x') throw new Error(`no merkle tree hook at ${c.merkleTreeHook}`);
  const type = await h.hookType().then(Number, () => null);
  const mb = await h.mailbox().then(getAddress, () => null);
  const count = await h.count().then(Number, () => null);
  if (mb !== getAddress(c.mailbox) || count == null || (type != null && type !== MERKLE_TREE_HOOK_TYPE)) {
    throw new Error(`${c.merkleTreeHook} is not the Mailbox's merkle tree hook (type ${type}, mailbox ${mb}, count ${count})`);
  }
  return { hook: getAddress(c.merkleTreeHook), treeCount: count };
}

const sampleBody = (c, who) => AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], [c.chainId, who, 0, who, who, 1n]);

export async function check(t, c, p, deployer) {
  const mb = new Contract(c.mailbox, MAILBOX, p);
  const domain = Number(await step('Mailbox.localDomain', () => mb.localDomain()));
  if (domain !== c.domain) throw new Error(`the ${c.name} Mailbox's localDomain is ${domain}, not ${c.domain}`);
  const { hook, treeCount } = await merkleHook(p, c);
  const fee = await step('Mailbox.quoteDispatch with the merkle tree hook', () => mb.quoteDispatch(t.zetaphy.domain, zeroPadValue(deployer, 32), sampleBody(c, deployer), '0x', hook));
  const ours = t.zetaphyValidators;
  const ism = ours.validators.length ? await factoryIsm(p, c.staticMessageIdMultisigIsmFactory, ours.validators, ours.threshold) : null;
  const nonce = await p.getTransactionCount(deployer, 'latest');
  const pending = await p.getTransactionCount(deployer, 'pending');
  return {
    chain: c.name, chainId: c.chainId, domain, mailbox: getAddress(c.mailbox), hook, treeCount, requiredHook: await mb.requiredHook().catch(() => null),
    feePerLock: formatEther(fee), ourIsm: ism ? { address: ism.at, deployed: ism.deployed, validators: ism.validators, threshold: ism.threshold } : null,
    ourValidatorsSet: ours.validators.length > 0, deployer, balance: formatEther(await p.getBalance(deployer)), nonce, pendingTxs: pending - nonce,
  };
}

async function deployArt(name, args, signer) {
  const a = art(name);
  const k = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await k.waitForDeployment();
  return k;
}

/**
 * The source chain's guardian multisig, its timelock (governance) and our ISM; then where the lockbox will be.
 * `signer`: the deployer, connected to the source chain (one NonceManager per chain and run).
 */
export async function originPrepare(t, c, p, signer, o = {}) {
  const ours = t.zetaphyValidators;
  if (!ours.validators.length) throw new Error('zetaphyValidators.validators is empty in the chain table: add the address of ZETAPHY_VALIDATOR_KEY first (saphan-route check prints it)');
  const me = await signer.getAddress();
  const owners = (o.owners ?? t.origin.owners).map(getAddress);
  const threshold = o.threshold ?? t.origin.threshold;
  if (owners.some((x) => x === getAddress(me))) throw new Error('the deployer may not be an owner of the source-chain multisig');
  let multisig = o.multisig ? getAddress(o.multisig) : null;
  if (multisig && (await p.getCode(multisig)) === '0x') throw new Error(`no multisig at ${multisig}`);
  if (!multisig) multisig = getAddress((await deployArt('SimpleMultisig', [owners, threshold], signer)).target);
  const ms = new Contract(multisig, art('SimpleMultisig').abi, p);
  const got = await Promise.all(owners.map((x) => ms.isOwner(x)));
  if (got.includes(false) || Number(await ms.threshold()) !== threshold) throw new Error(`the multisig ${multisig} is not ${threshold}-of [${owners.join(', ')}]`);
  let timelock = o.timelock ? getAddress(o.timelock) : null;
  if (timelock && (await p.getCode(timelock)) === '0x') throw new Error(`no timelock at ${timelock}`);
  // proposer (and canceller): the multisig; executor: anyone; admin: the timelock itself (no admin key)
  if (!timelock) timelock = getAddress((await deployArt('ZetaphyTimelock', [t.origin.timelockDelay, [multisig], [ZERO], ZERO], signer)).target);
  const tl = new Contract(timelock, art('ZetaphyTimelock').abi, p);
  const PROPOSER = keccakId('PROPOSER_ROLE');
  const ADMIN = '0x' + '00'.repeat(32);
  if (!(await tl.hasRole(PROPOSER, multisig)) || (await tl.hasRole(ADMIN, me)) || Number(await tl.getMinDelay()) < 3600) {
    throw new Error(`the timelock ${timelock} does not have the multisig as proposer, or the deployer as no admin, or a delay of 1 h+`);
  }
  const { ism, created } = await ensureIsm(p, signer, c.staticMessageIdMultisigIsmFactory, ours.validators, ours.threshold);
  const nonce = await signer.getNonce('pending'); // what this signer's next transaction uses
  return { chain: c.name, multisig, timelock, timelockDelay: Number(await tl.getMinDelay()), ism, ismCreated: created, deployer: me, nonce, lockboxAt: getCreateAddress({ from: me, nonce }) };
}

/** On ZETAPHY: the multisig ISM of Hyperlane's validators for this source chain (for its HyperlaneLane). */
export async function zetaphyIsm(t, c, zp, signer) {
  return { chain: c.name, ...(await ensureIsm(zp, signer, t.zetaphy.staticMessageIdMultisigIsmFactory, c.validators, c.threshold)) };
}

export async function originLockbox(t, c, p, signer, o) {
  const me = await signer.getAddress();
  const nonce = await signer.getNonce('pending'); // what this signer's next transaction uses
  const at = getCreateAddress({ from: me, nonce });
  if (getAddress(at) !== getAddress(o.expect)) throw new Error(`the deployer's ${c.name} nonce moved: the lockbox would be ${at}, not ${o.expect} (the ZETAPHY side points at ${o.expect}); nothing deployed`);
  for (const k of ['ism', 'timelock', 'multisig']) if ((await p.getCode(o[k])) === '0x') throw new Error(`no contract at --${k} ${o[k]}`);
  const { hook } = await merkleHook(p, c);
  const limit = parseEther(String(c.limits.releaseDailyLimit));
  const args = [c.mailbox, t.zetaphy.domain, BigInt(t.zetaphy.chainId), bytes32(o.lane), bytes32(o.outbox), hook, o.ism, o.timelock, o.multisig, limit, c.limits.releaseDelay];
  const k = await deployArt('HyperlaneLockBoxV2', args, signer);
  const addr = getAddress(k.target);
  if (addr !== getAddress(o.expect)) throw new Error(`deployed at ${addr}, expected ${o.expect}`);
  const ok = getAddress(await k.mailbox()) === getAddress(c.mailbox) && Number(await k.zetaphyDomain()) === t.zetaphy.domain
    && (await k.recipient()).toLowerCase() === bytes32(o.lane) && (await k.remoteSender()).toLowerCase() === bytes32(o.outbox)
    && getAddress(await k.hook()) === hook && getAddress(await k.interchainSecurityModule()) === getAddress(o.ism)
    && getAddress(await k.governance()) === getAddress(o.timelock) && (await k.guardian(o.multisig)) && (await k.dailyLimit()) === limit;
  if (!ok) throw new Error('the deployed lockbox does not read back as configured');
  const rc = await k.deploymentTransaction()?.wait();
  return { chain: c.name, lockbox: addr, tx: rc?.hash ?? null, block: rc?.blockNumber ?? null, fee: formatEther(await k.quoteLock(me, 1n)) };
}

/** Per two-way route: sends on ZETAPHY (outbox nonce) vs releases recorded on the source chain (lockbox received). */
export async function pending(t, routes, zp, originProvider) {
  const out = {};
  for (const [name, r] of Object.entries(routes)) {
    if (!r?.zetaphy?.hyperlaneOutbox || !t.chains[name]) continue;
    const sent = Number(await new Contract(r.zetaphy.hyperlaneOutbox, ['function nonce() view returns (uint256)'], zp).nonce());
    const op = await originProvider(name);
    const lb = new Contract(r.origin.lockbox, ['function received() view returns (uint256)', 'function nonce() view returns (uint256)'], op);
    const received = Number(await lb.received());
    out[name] = { sent, received, waiting: sent - received, locks: Number(await lb.nonce()) };
  }
  return out;
}

/** The v1 Sepolia lockbox (bridge-testnet.json), still relayed to its HyperlaneLane. */
function v1Lockbox() {
  try { return JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/bridge-testnet.json', import.meta.url), 'utf8'))?.sepolia?.hyperlaneLockBox ?? null; } catch { return null; }
}
const v1Whitelist = () => (v1Lockbox() ? [{ originDomain: 11155111, senderAddress: bytes32(v1Lockbox()), destinationDomain: 77390 }] : []);

/**
 * The relayer's environment (no secrets) for the deployed routes: which chains, the whitelist, and the
 * block each chain is read from (the route's deploy block; ZETAPHY: the bridge's, unless our validator
 * runs, whose merkle tree must be read from the Mailbox's start: agent-config.json index.from).
 */
export function relayerEnv(t, routes, v1, { sepoliaV1From = null, zetaphyV1From = null, validator = false } = {}) {
  const from = {};
  const at = (name, b) => { if (Number.isInteger(b) && b >= 0) from[name] = Math.min(from[name] ?? b, b); };
  if (v1) at('sepolia', sepoliaV1From);
  at('zetaphy', zetaphyV1From);
  const names = new Set(v1 ? ['sepolia'] : []);
  for (const [name, r] of Object.entries(routes)) {
    if (!t.chains[name] || !r?.origin?.lockbox) continue;
    names.add(name);
    at(name, r.origin.fromBlock);
    at('zetaphy', r.zetaphy?.fromBlock);
  }
  const lines = [`HYP_RELAYCHAINS=${[...names, 'zetaphy'].join(',')}`, `HYP_WHITELIST=${JSON.stringify(relayerWhitelist(t, routes, v1 ? [{ originDomain: 11155111, senderAddress: bytes32(v1), destinationDomain: 77390 }] : []))}`,
    'HYP_CHAINS_ZETAPHY_INDEX_CHUNK=499'];
  for (const n of names) {
    if (from[n] == null) throw new Error(`no start block for ${n}: saphan-routes.json needs origin.fromBlock (or --sepolia-v1-from)`);
    lines.push(`HYP_CHAINS_${n.toUpperCase()}_INDEX_FROM=${from[n]}`);
  }
  if (!validator && from.zetaphy != null) lines.push(`HYP_CHAINS_ZETAPHY_INDEX_FROM=${from.zetaphy}`);
  return lines;
}

/**
 * Should the relayer (and our validator) run now? `state` (kept between runs) remembers each lockbox's
 * nonce and when it last changed. Inbound: a lockbox that locked within `window` seconds; for a v2
 * lockbox only while its latest lock has not reached its HyperlaneLane yet (transferIds(n-1) vs
 * delivered(id): one call on ZETAPHY, and only inside the window). Outbound: a two-way route whose outbox
 * sent more than its lockbox recorded. A chain that does not answer counts as active (relay anyway);
 * ZETAPHY not answering stops the outbound check only.
 */
export async function relayGate({ t, routes, v1, originProvider, zetaphyProvider, state, now, window = 2 * 86400 }) {
  const s = { lockboxes: { ...(state?.lockboxes ?? {}) } };
  const reasons = [];
  let inbound = false, outbound = false;
  const boxes = [...(v1 ? [['sepolia', v1, null]] : []),
    ...Object.entries(routes).filter(([n, r]) => t.chains[n] && r?.origin?.lockbox).map(([n, r]) => [n, r.origin.lockbox, r.zetaphy?.hyperlaneLane ?? null])];
  let zp = null;
  const zetaphy = async () => (zp ??= await zetaphyProvider());
  for (const [name, box, lane] of boxes) {
    const key = `${name}:${getAddress(box)}`;
    let n;
    try { n = Number(await new Contract(box, ['function nonce() view returns (uint256)'], await originProvider(name)).nonce()); }
    catch (e) { inbound = true; reasons.push(`${key}: no answer (${(e.shortMessage ?? e.message).slice(0, 60)}), relaying anyway`); continue; }
    const prev = s.lockboxes[key];
    if (!prev || prev.nonce !== n) s.lockboxes[key] = { nonce: n, changedAt: prev || n > 0 ? now : 0 };
    if (!(n > 0 && now - s.lockboxes[key].changedAt < window)) continue;
    if (lane) {
      try {
        const id = await new Contract(box, ['function transferIds(uint256) view returns (bytes32)'], await originProvider(name)).transferIds(n - 1);
        if (await new Contract(lane, ['function delivered(bytes32) view returns (bool)'], await zetaphy()).delivered(id)) { reasons.push(`${key}: lock ${n - 1} delivered`); continue; }
      } catch (e) { reasons.push(`${key}: delivery check failed (${(e.shortMessage ?? e.message).slice(0, 60)})`); }
    }
    inbound = true; reasons.push(`${key}: lock ${n - 1} within the window, not seen delivered`);
  }
  const twoWay = Object.entries(routes).filter(([n, r]) => t.chains[n] && r?.zetaphy?.hyperlaneOutbox && r?.origin?.lockbox);
  if (twoWay.length) {
    try {
      const w = await pending(t, Object.fromEntries(twoWay), await zetaphy(), originProvider);
      for (const [name, x] of Object.entries(w)) if (x.waiting > 0) { outbound = true; reasons.push(`${name}: ${x.waiting} release(s) from ZETAPHY not delivered yet`); }
    } catch (e) { reasons.push(`outbound check failed (${(e.shortMessage ?? e.message).slice(0, 80)}): validator not started`); }
  }
  return { run: inbound || outbound, validator: outbound, reasons, state: s };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}
const keySigner = (p) => new NonceManager(new Wallet(readFileSync(String(process.env.KEYFILE), 'utf8').trim()).connect(p));
const needAddr = (o, ks) => { for (const k of ks) if (!/^0x[0-9a-fA-F]{40}$/.test(String(o[k] ?? ''))) throw new Error(`--${k} 0x… is needed`); };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  (async () => {
    const t = loadChains();
    const originP = (name) => { const c = chainOf(t, name); return providerFor(process.env.ORIGIN_RPC || c.rpc.join(','), c.chainId); };
    let res;
    if (cmd === 'whitelist') res = relayerWhitelist(t, loadRoutes(), v1Whitelist());
    else if (cmd === 'relayer-env') {
      let zv1 = null;
      try { zv1 = JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/bridge-testnet.json', import.meta.url), 'utf8'))?.zetaphy?.fromBlock ?? null; } catch { /* none */ }
      const lines = relayerEnv(t, loadRoutes(), v1Lockbox(), { sepoliaV1From: o['sepolia-v1-from'] != null ? Number(o['sepolia-v1-from']) : null, zetaphyV1From: zv1, validator: o.validator === 'yes' });
      console.log(lines.join('\n'));
      process.exit(0);
    } else if (cmd === 'gate') {
      if (!o.state) throw new Error('gate --state <file> (kept between runs)');
      let state = null;
      try { state = JSON.parse(readFileSync(o.state, 'utf8')); } catch { /* first run */ }
      const cache = {};
      res = await relayGate({ t, routes: loadRoutes(), v1: v1Lockbox(), state, now: Math.floor(Date.now() / 1000),
        originProvider: async (n) => (cache[n] ??= await providerFor(t.chains[n].rpc.join(','), t.chains[n].chainId)),
        zetaphyProvider: () => providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId) });
      writeFileSync(o.state, JSON.stringify(res.state));
    }
    else if (cmd === 'pending') {
      const zp = await providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
      const cache = {};
      res = await pending(t, loadRoutes(), zp, async (n) => (cache[n] ??= await providerFor(t.chains[n].rpc.join(','), t.chains[n].chainId)));
    } else if (cmd === 'zetaphy-ism') {
      const zp = await providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
      res = await zetaphyIsm(t, chainOf(t, o.chain), zp, keySigner(zp));
    } else {
      const c = chainOf(t, o.chain);
      const p = await originP(o.chain);
      if (cmd === 'check') res = await check(t, c, p, getAddress(String(process.env.DEPLOYER ?? '')));
      else if (cmd === 'origin-prepare') res = await originPrepare(t, c, p, keySigner(p), { multisig: o.multisig, timelock: o.timelock });
      else if (cmd === 'origin-lockbox') { needAddr(o, ['lane', 'outbox', 'expect', 'multisig', 'timelock', 'ism']); res = await originLockbox(t, c, p, keySigner(p), o); }
      else throw new Error('usage: saphan.js check|origin-prepare|zetaphy-ism|origin-lockbox --chain <name> … | whitelist | pending');
    }
    console.log(JSON.stringify(res));
    process.exit(0);
  })().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
