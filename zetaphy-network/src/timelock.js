// The ZetaphyTimelock (OpenZeppelin TimelockController + role enumeration), from JavaScript:
// operation ids, the calldata a multisig or a gov vote needs, function names for
// selectors (monitor alerts, `zetaphy timelock status`), and the on-chain role check
// the launch tool runs after the handover.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { Interface, AbiCoder, keccak256, id as hashText, getAddress, ZeroHash, ZeroAddress, isHexString } from 'ethers';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const TIMELOCK_ABI = art('ZetaphyTimelock').abi;
export const TIMELOCK = new Interface(TIMELOCK_ABI);
export const ROLES = {
  admin: ZeroHash,                       // DEFAULT_ADMIN_ROLE
  proposer: hashText('PROPOSER_ROLE'),
  executor: hashText('EXECUTOR_ROLE'),
  canceller: hashText('CANCELLER_ROLE'),
};
/** 48 hours: the default delay. Less than MIN_DELAY (24 h) only on a devnet. */
export const DEFAULT_DELAY = 48 * 3600;
export const MIN_DELAY = 24 * 3600;
/** OpenZeppelin's operation states. */
export const STATES = ['Unset', 'Waiting', 'Ready', 'Done'];

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const coder = AbiCoder.defaultAbiCoder();

/** A salt: 0x + 64 hex as is, other text hashed (so "raise-cap-2026-11" is a fine salt), none = zero. */
export function saltOf(s) {
  if (s == null || s === '' || s === true) return ZeroHash;
  return isHexString(String(s), 32) ? String(s) : hashText(String(s));
}

/** TimelockController.hashOperation, computed locally. */
export function operationId({ target, value = 0n, data, predecessor = ZeroHash, salt = ZeroHash }) {
  return keccak256(coder.encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], [getAddress(target), BigInt(value), data, predecessor, salt]));
}

/** The timelock's own calldata for schedule / execute / cancel. */
export function scheduleData({ target, value = 0n, data, predecessor = ZeroHash, salt = ZeroHash, delay }) {
  return TIMELOCK.encodeFunctionData('schedule', [getAddress(target), BigInt(value), data, predecessor, salt, BigInt(delay)]);
}
export function executeData({ target, value = 0n, data, predecessor = ZeroHash, salt = ZeroHash }) {
  return TIMELOCK.encodeFunctionData('execute', [getAddress(target), BigInt(value), data, predecessor, salt]);
}
export function cancelData(id) { return TIMELOCK.encodeFunctionData('cancel', [id]); }

let names = null;
/** selector (0x + 8 hex) -> "name(types)" of every function in this repo's contract artifacts (network, DEX, NFT). */
export function selectorNames() {
  if (names) return names;
  names = new Map();
  for (const pkg of ['zetaphy-network', 'zetaphy-dex', 'zetaphy-nft']) {
    const dir = new URL(`../../${pkg}/artifacts/`, import.meta.url);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      let abi;
      try { abi = JSON.parse(readFileSync(new URL(f, dir), 'utf8')).abi; } catch { continue; }
      if (!Array.isArray(abi)) continue;
      for (const fr of new Interface(abi).fragments) if (fr.type === 'function' && !names.has(fr.selector)) names.set(fr.selector, fr.format('sighash'));
    }
  }
  return names;
}

/** "setRoute(bytes32,address,uint128,bool)" for calldata, or the bare selector when unknown. */
export function callName(data) {
  const sel = String(data ?? '').slice(0, 10).toLowerCase();
  return selectorNames().get(sel) ?? (sel.length === 10 ? sel : '(no calldata: a plain transfer)');
}

/** Members of a role (the timelock enumerates them). */
export async function roleMembers(timelock, role) {
  const n = Number(await timelock.getRoleMemberCount(role));
  const out = [];
  for (let i = 0; i < n; i++) out.push(getAddress(await timelock.getRoleMember(role, i)));
  return out;
}

/** Every role's members: { admin, proposer, executor, canceller }. */
export async function rolesOf(timelock) {
  const r = {};
  for (const [k, v] of Object.entries(ROLES)) r[k] = await roleMembers(timelock, v);
  return r;
}

/**
 * Checks a deployed timelock is what the launch wants: the delay, the timelock as its own and
 * only admin, the proposers (= cancellers) exactly `proposers`, the executor open (address 0)
 * or exactly `executors`, and none of them an EOA (except on a devnet; the gov module, a module
 * account without code, is fine). `forbidden` (the deployer) holds nothing.
 * Returns { problems: [string], roles }.
 */
export async function checkTimelock(provider, timelock, { minDelay, proposers, executors = null, forbidden = [], devnet = false, govModule = null }) {
  const problems = [];
  const address = getAddress(String(timelock.target));
  const roles = await rolesOf(timelock);
  const delay = await timelock.getMinDelay();
  if (BigInt(delay) !== BigInt(minDelay)) problems.push(`timelock delay is ${delay} s, not ${minDelay} s`);
  if (roles.admin.length !== 1 || !same(roles.admin[0], address)) problems.push(`timelock admin role: ${roles.admin.join(', ') || 'nobody'} (must be the timelock itself only)`);
  const setEq = (a, b) => a.length === b.length && a.every((x) => b.some((y) => same(x, y)));
  if (!setEq(roles.proposer, proposers)) problems.push(`proposers ${roles.proposer.join(', ') || 'none'}, expected ${proposers.join(', ')}`);
  if (!setEq(roles.canceller, proposers)) problems.push(`cancellers ${roles.canceller.join(', ') || 'none'}, expected ${proposers.join(', ')}`);
  const wantExec = executors ?? [ZeroAddress];
  if (!setEq(roles.executor, wantExec)) problems.push(`executors ${roles.executor.join(', ') || 'none'}, expected ${wantExec.join(', ')}`);
  for (const f of forbidden) for (const [k, list] of Object.entries(roles)) if (list.some((x) => same(x, f))) problems.push(`${f} still holds the timelock's ${k} role`);
  for (const [k, list] of Object.entries(roles)) {
    for (const a of list) {
      if (same(a, ZeroAddress) || same(a, address) || (govModule && same(a, govModule))) continue;
      if ((await provider.getCode(a)) === '0x' && !devnet) problems.push(`${k} ${a} is an EOA (a single key): use a multisig or the gov module`);
    }
  }
  return { problems, roles };
}
