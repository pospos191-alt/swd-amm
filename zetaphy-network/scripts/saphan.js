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
//
// Token routes (tokens born on ZETAPHY, contracts/SaphanTokens.sol; the table's `tokens`):
//   node scripts/saphan.js token-check --token <key> --chain <name>
//       read only: the destination (as check) and the token on ZETAPHY (code, decimals() as in the table)
//   node scripts/saphan.js token-prepare --token <key> --chain <name> [--multisig 0x… --timelock 0x…]
//       the destination's roles (the chain's v2 multisig and timelock when deployed, else new ones) and our ISM;
//       then where the synthetic will be (syntheticAt)
//   node scripts/saphan.js token-vault --token <key> --chain <name> --expect 0x<syntheticAt> [--governance --guardian --threats 0x…|none]
//       on ZETAPHY: the ISM of Hyperlane's validators for the destination, then the ZetaphyTokenVault (paused: closed)
//   node scripts/saphan.js token-synthetic --token <key> --chain <name> --vault 0x… --expect 0x… --multisig 0x… --timelock 0x… --ism 0x… [--governance 0x…]
//       the SaphanSyntheticToken exactly at --expect (paused: closed); refuses if the deployer's nonce moved
//
//   node scripts/saphan.js whitelist          the relayer's HYP_WHITELIST for every deployed route (+ the v1 lockbox, + token routes)
//   node scripts/saphan.js pending            per two-way route: the outbox's sends on ZETAPHY vs releases the lockbox recorded;
//                                             per token route: messages each way the other end has not recorded
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
import { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, getAddress, getCreateAddress, formatEther, parseEther, parseUnits, zeroPadValue, AbiCoder, id as keccakId } from 'ethers';
import { loadChains, chainOf, sortAddresses, loadRoutes, loadTokenRoutes, tokenOf, tokenRouteList, relayerWhitelist, bytes32, NATIVE_ERC20 } from '../src/saphan.js';

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

// ---------------------------------------------------------------- token routes (tokens born on ZETAPHY)

const ERC20_READ = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)'];
/** The deploy settings tuple of both ends (SaphanTokenEndpoint.Config). */
const endpointConfig = (o) => [o.mailbox, o.remoteDomain, BigInt(o.remoteChainId), bytes32(o.remote), o.hook ?? ZERO, o.originToken, o.ism, o.governance, o.guardian ?? ZERO,
  o.dailyLimit, o.delay];

/** Read only, on ZETAPHY: the token is a contract (or the native precompile) whose decimals() matches the table. */
export async function tokenCheck(t, k, zp) {
  const tok = new Contract(k.address, ERC20_READ, zp);
  const code = await zp.getCode(k.address);
  const decimals = await tok.decimals().then(Number, () => null);
  const symbol = await tok.symbol().catch(() => null);
  const problems = [];
  if (code === '0x' && getAddress(k.address) !== getAddress(NATIVE_ERC20)) problems.push('no contract at the address');
  if (decimals !== k.decimals) problems.push(`decimals() is ${decimals}, the table says ${k.decimals}`);
  if (k.transferable === false) problems.push(`not transferable: ${k.why}`);
  return { token: k.key, address: getAddress(k.address), code: code !== '0x', decimals, symbol, totalSupply: String(await tok.totalSupply().catch(() => '?')), problems };
}

/**
 * On ZETAPHY: the multisig ISM of Hyperlane's validators for the destination (the same one the v2 HyperlaneLane of that
 * chain uses: the factory returns it), then the ZetaphyTokenVault, sending to the synthetic at `expect` (where the
 * destination's deployer nonce puts it). Deployed paused (closed). governance / guardian / threats: the table's ZETAPHY
 * timelock, guardian multisig and ThreatRegistry unless given (the dry run gives its own key).
 */
export async function tokenVault(t, k, c, zp, signer, o) {
  if (!k.destinations.includes(c.name)) throw new Error(`token ${k.key}: ${c.name} is not one of its destinations (${k.destinations.join(', ') || 'none'})`);
  if (k.transferable === false) throw new Error(`token ${k.key} cannot be moved: ${k.why}`);
  const chk = await tokenCheck(t, k, zp);
  if (chk.problems.length) throw new Error(`token ${k.key} on ZETAPHY: ${chk.problems.join('; ')}`);
  const { ism } = await zetaphyIsm(t, c, zp, signer);
  const governance = getAddress(o.governance ?? t.zetaphy.timelock), guardian = getAddress(o.guardian ?? t.zetaphy.guardian);
  const threats = o.threats === 'none' ? ZERO : getAddress(o.threats ?? t.zetaphy.threats);
  const args = [endpointConfig({ mailbox: t.zetaphy.mailbox, remoteDomain: c.domain, remoteChainId: c.chainId, remote: o.expect, hook: ZERO, // the Mailbox default hook (merkle tree), as HyperlaneOutbox
    originToken: k.address, ism, governance, guardian, dailyLimit: parseUnits(k.limits.releaseDailyLimit, k.decimals), delay: k.limits.releaseDelay }),
  k.decimals, parseUnits(k.limits.lockCap, k.decimals), threats];
  const v = await deployArt('ZetaphyTokenVault', args, signer);
  const addr = getAddress(v.target);
  const ok = (await v.paused()) && getAddress(await v.originToken()) === getAddress(k.address) && (await v.remote()).toLowerCase() === bytes32(o.expect)
    && Number(await v.remoteDomain()) === c.domain && getAddress(await v.interchainSecurityModule()) === getAddress(ism) && getAddress(await v.governance()) === governance;
  if (!ok) throw new Error('the deployed vault does not read back as configured');
  const rc = await v.deploymentTransaction()?.wait();
  return { token: k.key, chain: c.name, vault: addr, ism, governance, guardian, threats, tx: rc?.hash ?? null, block: rc?.blockNumber ?? null };
}

/** On the destination: the SaphanSyntheticToken exactly at `expect`, minted only by `vault` (deployed paused). */
export async function tokenSynthetic(t, k, c, p, signer, o) {
  const me = await signer.getAddress();
  const nonce = await signer.getNonce('pending');
  const at = getCreateAddress({ from: me, nonce });
  if (getAddress(at) !== getAddress(o.expect)) throw new Error(`the deployer's ${c.name} nonce moved: the synthetic would be ${at}, not ${o.expect} (the vault on ZETAPHY sends to ${o.expect}); nothing deployed`);
  for (const x of ['ism', 'timelock', 'multisig']) if ((await p.getCode(o[x])) === '0x') throw new Error(`no contract at --${x} ${o[x]}`);
  const { hook } = await merkleHook(p, c);
  const governance = getAddress(o.governance ?? o.timelock);
  const args = [k.synthetic.name, k.synthetic.symbol, k.decimals, endpointConfig({ mailbox: c.mailbox, remoteDomain: t.zetaphy.domain, remoteChainId: t.zetaphy.chainId,
    remote: o.vault, hook, originToken: k.address, ism: o.ism, governance, guardian: o.multisig, dailyLimit: parseUnits(k.limits.mintDailyLimit, k.decimals),
    delay: k.limits.mintDelay }), parseUnits(k.limits.supplyCap, k.decimals)];
  const s = await deployArt('SaphanSyntheticToken', args, signer);
  const addr = getAddress(s.target);
  if (addr !== getAddress(o.expect)) throw new Error(`deployed at ${addr}, expected ${o.expect}`);
  const ok = (await s.paused()) && (await s.remote()).toLowerCase() === bytes32(o.vault) && Number(await s.remoteDomain()) === t.zetaphy.domain
    && getAddress(await s.interchainSecurityModule()) === getAddress(o.ism) && getAddress(await s.governance()) === governance && (await s.guardian(o.multisig))
    && Number(await s.decimals()) === k.decimals && getAddress(await s.originToken()) === getAddress(k.address);
  if (!ok) throw new Error('the deployed synthetic does not read back as configured');
  const rc = await s.deploymentTransaction()?.wait();
  return { token: k.key, chain: c.name, synthetic: addr, symbol: k.synthetic.symbol, tx: rc?.hash ?? null, block: rc?.blockNumber ?? null };
}

/** Per token route: messages each way that the other end has not recorded yet. */
export async function tokenPending(t, tokenRoutes, zp, originProvider) {
  const out = {};
  const N = ['function nonce() view returns (uint256)', 'function received() view returns (uint256)'];
  for (const [key, chain, r] of tokenRouteList(t, tokenRoutes)) {
    const v = new Contract(r.zetaphy.vault, N, zp), s = new Contract(r.destination.synthetic, N, await originProvider(chain));
    const [locks, released, sendBacks, minted] = await Promise.all([v.nonce(), v.received(), s.nonce(), s.received()]).then((x) => x.map(Number));
    out[`${key}:${chain}`] = { out: locks - minted, in: sendBacks - released, locks, sendBacks };
  }
  return out;
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
export function relayerEnv(t, routes, v1, { sepoliaV1From = null, zetaphyV1From = null, validator = false, tokenRoutes = {} } = {}) {
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
  for (const [, chain, r] of tokenRouteList(t, tokenRoutes)) {
    names.add(chain);
    at(chain, r.destination.fromBlock);
    at('zetaphy', r.zetaphy.fromBlock);
  }
  const extra = v1 ? [{ originDomain: 11155111, senderAddress: bytes32(v1), destinationDomain: 77390 }] : [];
  const lines = [`HYP_RELAYCHAINS=${[...names, 'zetaphy'].join(',')}`, `HYP_WHITELIST=${JSON.stringify(relayerWhitelist(t, routes, extra, tokenRoutes))}`,
    'HYP_CHAINS_ZETAPHY_INDEX_CHUNK=499'];
  for (const n of names) {
    if (from[n] == null) throw new Error(`no start block for ${n}: saphan-routes.json needs origin.fromBlock / destination.fromBlock (or --sepolia-v1-from)`);
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
 * Token routes: the validator (and the relayer) while a vault on ZETAPHY locked more than its synthetic recorded
 * (vault nonce vs synthetic received: one call on ZETAPHY per route); the relayer while a synthetic sent back more
 * than its vault recorded (synthetic nonce vs vault received; ZETAPHY is asked only when the synthetic's nonce is
 * above the last count the vault was seen with, kept in `state`).
 */
export async function relayGate({ t, routes, v1, originProvider, zetaphyProvider, state, now, window = 2 * 86400, tokenRoutes = {} }) {
  const s = { lockboxes: { ...(state?.lockboxes ?? {}) }, tokens: { ...(state?.tokens ?? {}) } };
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
  const N = ['function nonce() view returns (uint256)', 'function received() view returns (uint256)'];
  const short = (e) => (e.shortMessage ?? e.message).slice(0, 60);
  for (const [key, chain, r] of tokenRouteList(t, tokenRoutes)) {
    const id = `${key}:${chain}`;
    let back, minted;
    try {
      const syn = new Contract(r.destination.synthetic, N, await originProvider(chain));
      [back, minted] = (await Promise.all([syn.nonce(), syn.received()])).map(Number);
    } catch (e) { inbound = true; reasons.push(`${id}: no answer from ${chain} (${short(e)}), relaying anyway`); continue; }
    try {
      const vault = new Contract(r.zetaphy.vault, N, await zetaphy());
      if (back > (s.tokens[id]?.released ?? 0)) {
        s.tokens[id] = { released: Number(await vault.received()) };
        if (back > s.tokens[id].released) { inbound = true; reasons.push(`${id}: ${back - s.tokens[id].released} send-back(s) to ZETAPHY not delivered yet`); }
      }
      const locks = Number(await vault.nonce());
      if (locks > minted) { outbound = true; reasons.push(`${id}: ${locks - minted} lock(s) on ZETAPHY not delivered yet`); }
    } catch (e) { reasons.push(`${id}: ZETAPHY check failed (${short(e)}): validator not started`); }
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
    const zetaphyP = () => providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
    if (cmd === 'whitelist') res = relayerWhitelist(t, loadRoutes(), v1Whitelist(), loadTokenRoutes());
    else if (cmd === 'relayer-env') {
      let zv1 = null;
      try { zv1 = JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/bridge-testnet.json', import.meta.url), 'utf8'))?.zetaphy?.fromBlock ?? null; } catch { /* none */ }
      const lines = relayerEnv(t, loadRoutes(), v1Lockbox(), { sepoliaV1From: o['sepolia-v1-from'] != null ? Number(o['sepolia-v1-from']) : null, zetaphyV1From: zv1, validator: o.validator === 'yes', tokenRoutes: loadTokenRoutes() });
      console.log(lines.join('\n'));
      process.exit(0);
    } else if (cmd === 'gate') {
      if (!o.state) throw new Error('gate --state <file> (kept between runs)');
      let state = null;
      try { state = JSON.parse(readFileSync(o.state, 'utf8')); } catch { /* first run */ }
      const cache = {};
      res = await relayGate({ t, routes: loadRoutes(), tokenRoutes: loadTokenRoutes(), v1: v1Lockbox(), state, now: Math.floor(Date.now() / 1000),
        originProvider: async (n) => (cache[n] ??= await providerFor(t.chains[n].rpc.join(','), t.chains[n].chainId)),
        zetaphyProvider: () => providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId) });
      writeFileSync(o.state, JSON.stringify(res.state));
    }
    else if (cmd === 'pending') {
      const zp = await providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
      const cache = {};
      const op = async (n) => (cache[n] ??= await providerFor(t.chains[n].rpc.join(','), t.chains[n].chainId));
      res = { routes: await pending(t, loadRoutes(), zp, op), tokens: await tokenPending(t, loadTokenRoutes(), zp, op) };
    } else if (cmd === 'zetaphy-ism') {
      const zp = await providerFor(process.env.ZETAPHY_RPC || t.zetaphy.rpc.join(','), t.zetaphy.chainId);
      res = await zetaphyIsm(t, chainOf(t, o.chain), zp, keySigner(zp));
    } else if (cmd === 'token-vault') {
      needAddr(o, ['expect']);
      const zp = await zetaphyP();
      res = await tokenVault(t, tokenOf(t, o.token), chainOf(t, o.chain), zp, keySigner(zp), o);
    } else if (cmd === 'token-check') {
      const k = tokenOf(t, o.token), c = chainOf(t, o.chain);
      if (!k.destinations.includes(c.name)) throw new Error(`token ${k.key}: ${c.name} is not one of its destinations (${k.destinations.join(', ') || 'none'})`);
      res = { destination: await check(t, c, await originP(o.chain), getAddress(String(process.env.DEPLOYER ?? ''))) };
      try { res.zetaphy = await tokenCheck(t, k, await zetaphyP()); } catch (e) { res.zetaphy = { error: `ZETAPHY not reachable: ${e.shortMessage ?? e.message}` }; }
    } else {
      const c = chainOf(t, o.chain);
      const p = await originP(o.chain);
      const v2 = loadRoutes()[c.name]?.origin ?? {};
      if (cmd === 'check') res = await check(t, c, p, getAddress(String(process.env.DEPLOYER ?? '')));
      // token routes reuse the chain's v2 multisig and timelock when that route is deployed
      else if (cmd === 'token-prepare') { tokenOf(t, o.token); res = await originPrepare(t, c, p, keySigner(p), { multisig: o.multisig ?? v2.multisig, timelock: o.timelock ?? v2.timelock }); res.syntheticAt = res.lockboxAt; }
      else if (cmd === 'token-synthetic') { needAddr(o, ['vault', 'expect', 'multisig', 'timelock', 'ism']); res = await tokenSynthetic(t, tokenOf(t, o.token), c, p, keySigner(p), o); }
      else if (cmd === 'origin-prepare') res = await originPrepare(t, c, p, keySigner(p), { multisig: o.multisig, timelock: o.timelock });
      else if (cmd === 'origin-lockbox') { needAddr(o, ['lane', 'outbox', 'expect', 'multisig', 'timelock', 'ism']); res = await originLockbox(t, c, p, keySigner(p), o); }
      else throw new Error('usage: saphan.js check|origin-prepare|zetaphy-ism|origin-lockbox --chain <name> … | token-check|token-prepare|token-vault|token-synthetic --token <key> --chain <name> … | whitelist | pending');
    }
    console.log(JSON.stringify(res));
    process.exit(0);
  })().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
