// ZETAPHY Saphan, EVM routes v2: the chain table (zetaphy-chain/hyperlane/saphan-chains.json) and
// what the deployed routes look like (saphan-routes.json). Used by scripts/saphan.js, the
// saphan-route and hyperlane-relayer workflows and the hub's build (zetaphy-hub/build.mjs reads the
// same files). Adding a source chain = an entry in the table + a saphan-route workflow run.
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, zeroPadValue, keccak256, solidityPacked, getBytes, concat, toBeHex } from 'ethers';

export const CHAINS_FILE = new URL('../../zetaphy-chain/hyperlane/saphan-chains.json', import.meta.url);
export const ROUTES_FILE = new URL('../../zetaphy-chain/hyperlane/saphan-routes.json', import.meta.url);
/** The guard's route ids (bytes32 strings): the airlock's inbound route, the outbox's outbound-only route. */
export const ROUTE_IN = 'airlock';
export const ROUTE_OUT = 'out';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[a-z0-9]{1,31}$/;
const SYMBOL = /^[\w.-]{1,12}$/;

/** Ascending by value: the order a multisig ISM is deployed with (and signatures must follow). */
export const sortAddresses = (list) => [...list].map((a) => getAddress(a)).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));

/** Every problem with a chain table (empty when it is usable). */
export function chainProblems(t) {
  const p = [];
  const addr = (v, at) => { if (!ADDR.test(String(v ?? '')) || !isAddress(String(v))) p.push(`${at}: not a 0x address`); };
  const z = t?.zetaphy ?? {};
  if (z.chainId !== 77390 || z.domain !== 77390) p.push('zetaphy: chainId and domain must be 77390');
  for (const k of ['mailbox', 'merkleTreeHook', 'validatorAnnounce', 'staticMessageIdMultisigIsmFactory', 'neuroJobs', 'neuroControl', 'threats', 'timelock', 'guardian']) addr(z[k], `zetaphy.${k}`);
  const zv = t?.zetaphyValidators ?? {};
  if (!Array.isArray(zv.validators)) p.push('zetaphyValidators.validators: a list');
  else {
    zv.validators.forEach((v, i) => addr(v, `zetaphyValidators.validators[${i}]`));
    if (new Set(zv.validators.map((v) => String(v).toLowerCase())).size !== zv.validators.length) p.push('zetaphyValidators: a validator twice');
    if (zv.validators.length && !(Number.isInteger(zv.threshold) && zv.threshold >= 1 && zv.threshold <= zv.validators.length)) p.push('zetaphyValidators.threshold: 1..number of validators');
  }
  const o = t?.origin ?? {};
  if (!Array.isArray(o.owners) || !o.owners.length) p.push('origin.owners: the source-chain multisig owners');
  else o.owners.forEach((v, i) => addr(v, `origin.owners[${i}]`));
  if (!(Number.isInteger(o.threshold) && o.threshold >= 1 && o.threshold <= (o.owners?.length ?? 0))) p.push('origin.threshold: 1..number of owners');
  if (!(Number.isInteger(o.timelockDelay) && o.timelockDelay >= 3600)) p.push('origin.timelockDelay: seconds, at least 3600');
  const ids = new Set([77390]), domains = new Set([77390]);
  for (const [name, c] of Object.entries(t?.chains ?? {})) {
    const at = `chains.${name}`;
    if (!NAME.test(name)) p.push(`${at}: a name of a-z 0-9 (the Hyperlane registry's)`);
    for (const k of ['chainId', 'domain']) if (!(Number.isInteger(c[k]) && c[k] > 0 && c[k] < 2 ** 32)) p.push(`${at}.${k}: a positive integer below 2^32`);
    if (ids.has(c.chainId)) p.push(`${at}.chainId ${c.chainId}: used twice`);
    if (domains.has(c.domain)) p.push(`${at}.domain ${c.domain}: used twice`);
    ids.add(c.chainId); domains.add(c.domain);
    for (const k of ['mailbox', 'merkleTreeHook', 'validatorAnnounce', 'staticMessageIdMultisigIsmFactory']) addr(c[k], `${at}.${k}`);
    if (!Array.isArray(c.rpc) || !c.rpc.length || c.rpc.some((u) => !/^https:\/\/[^\s]+$/.test(u))) p.push(`${at}.rpc: https URLs`);
    if (!Array.isArray(c.validators) || !c.validators.length) p.push(`${at}.validators: Hyperlane's validators for this origin`);
    else c.validators.forEach((v, i) => addr(v, `${at}.validators[${i}]`));
    if (!(Number.isInteger(c.threshold) && c.threshold >= 1 && c.threshold <= (c.validators?.length ?? 0))) p.push(`${at}.threshold: 1..number of validators`);
    if (!SYMBOL.test(String(c.token?.symbol ?? '')) || !String(c.token?.name ?? '').trim() || c.token?.decimals !== 18) p.push(`${at}.token: name, symbol (1-12 of A-Z a-z 0-9 _ . -), decimals 18`);
    const l = c.limits ?? {};
    for (const k of ['zetaphyDailyLimit', 'releaseDailyLimit']) if (!/^\d+(\.\d+)?$/.test(String(l[k] ?? ''))) p.push(`${at}.limits.${k}: whole tokens, e.g. "1"`);
    for (const k of ['releaseDelay', 'quarantine']) if (!(Number.isInteger(l[k]) && l[k] >= 0 && l[k] <= 30 * 86400)) p.push(`${at}.limits.${k}: seconds, at most 30 days`);
    if (!(typeof c.estimateBlockTime === 'number' && c.estimateBlockTime > 0)) p.push(`${at}.estimateBlockTime: seconds`);
  }
  return p;
}

export function loadChains(file = process.env.SAPHAN_CHAINS || CHAINS_FILE) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  const p = chainProblems(t);
  if (p.length) throw new Error(`saphan chain table ${file}:\n  - ${p.join('\n  - ')}`);
  return t;
}

export function loadRoutes(file = process.env.SAPHAN_ROUTES || ROUTES_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')).routes ?? {}; } catch { return {}; }
}

/** One source chain's entry (with its name), or an error naming the known ones. */
export function chainOf(t, name) {
  const c = t.chains[String(name ?? '')];
  if (!c) throw new Error(`unknown source chain ${name}: one of ${Object.keys(t.chains).join(', ')}`);
  return { name, ...c };
}

export const bytes32 = (a) => zeroPadValue(getAddress(a), 32).toLowerCase();

/**
 * The relayer's whitelist (HYP_WHITELIST) for the deployed routes: source lockbox -> its HyperlaneLane on
 * ZETAPHY, and (two-way routes) the HyperlaneOutbox on ZETAPHY -> that lockbox. Plus `extra` entries
 * (e.g. the v1 Sepolia lockbox). Nothing else is relayed, so nobody can spend the relayer's gas.
 */
export function relayerWhitelist(t, routes, extra = []) {
  const out = [...extra];
  for (const [name, r] of Object.entries(routes)) {
    const c = t.chains[name];
    if (!c || !r?.origin?.lockbox) continue;
    out.push({ originDomain: c.domain, senderAddress: bytes32(r.origin.lockbox), destinationDomain: t.zetaphy.domain });
    if (r.zetaphy?.hyperlaneOutbox) out.push({ originDomain: t.zetaphy.domain, senderAddress: bytes32(r.zetaphy.hyperlaneOutbox), destinationDomain: c.domain });
  }
  return out;
}

/** The routes as the hub shows them: every chain of the table, with its deployment (if any). Public data only. */
export function hubRoutes(t, routes) {
  return Object.entries(t.chains).map(([name, c]) => {
    const r = routes[name] ?? null;
    return {
      name, displayName: c.displayName, chainId: c.chainId, explorer: c.explorer ?? '', symbol: c.token.symbol,
      state: !r ? 'planned' : r.state === 'OPEN' ? 'open' : 'closed',
      twoWay: !!r?.zetaphy?.hyperlaneOutbox,
      ...(r ? { lockbox: r.origin.lockbox, token: r.zetaphy.bridgedToken, outbox: r.zetaphy.hyperlaneOutbox ?? null } : {}),
    };
  });
}

/**
 * What a Hyperlane validator signs for a message-id multisig ISM, as relayer metadata:
 * origin merkle tree hook (32) | root (32) | index (4) | signatures (65 each), each over
 * CheckpointLib.digest(origin, hook, root, index, messageId) (hyperlane-monorepo
 * solidity/contracts/libs/CheckpointLib.sol). `signers`: ethers Wallets in the ISM's validator
 * order. Used by the dry run (scripts/saphan-dryrun.js) and the tests; the real relayer reads the
 * validators' signed checkpoints instead.
 */
export function messageIdMetadata(message, signers, { merkleTreeHook, root = '0x' + '42'.repeat(32), index = 0 } = {}) {
  const origin = Number(BigInt('0x' + message.slice(2 + 10, 2 + 18)));
  const hook32 = zeroPadValue(merkleTreeHook ?? '0x' + '77'.repeat(20), 32);
  const domainHash = keccak256(solidityPacked(['uint32', 'bytes32', 'string'], [origin, hook32, 'HYPERLANE']));
  const inner = keccak256(solidityPacked(['bytes32', 'bytes32', 'uint32', 'bytes32'], [domainHash, root, index, keccak256(message)]));
  return concat([hook32, root, toBeHex(index, 4), ...signers.map((w) => w.signMessageSync(getBytes(inner)))]);
}
