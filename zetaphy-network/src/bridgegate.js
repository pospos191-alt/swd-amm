// The opening gates of the lock/mint bridge (zetaphy bridge open, deploy-bridge).
// The bridge is deployed CLOSED (its route disabled). Enabling the route needs:
//   1. 2+ lanes in BridgeAirlock with distinct controllers (on-chain too:
//      BridgeGuard.setRoute(enabled) requires airlock.independentLanes() >= 2),
//      no lane key or admin that is the deployer, no EOA lane except on a devnet;
//   2. an audit report: https url + sha256, recorded on-chain (BridgeGuard.setAudit;
//      setRoute(enabled) reverts AuditMissing without it);
//   3. NeuroJobs.activeWorkers() >= minRunners (default 10);
//   4. guardian(s) and governance that are multisigs (Safe or SimpleMultisig:
//      threshold >= 2, owners >= 3, none the deployer), not the same multisig,
//      no owner in both; or the chain's gov module for governance; or a
//      ZetaphyTimelock (24 h+ delay, its own only admin) whose proposers pass
//      the same checks. EOAs only on a devnet or with --allow-eoa-for-testing;
//   5. a daily limit at most the starter cap (1,000 tokens) unless --raise-cap,
//      and never above BridgeGuard.maxDailyLimit (raised only after a 7-day timelock);
//   6. --i-understand-real-funds on anything but a devnet.
// These functions read the chain and return problems (strings); they send nothing.

import { Interface, getAddress, id, ZeroHash } from 'ethers';

export const STARTER_UNITS = 1000n;
export const MIN_RUNNERS = 10;
export const GOV_MODULE = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** A loopback RPC (127.x, localhost, ::1). */
export function isLoopback(rpcUrl) {
  try {
    const h = new URL(String(rpcUrl)).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch { return false; }
}

/**
 * A devnet: only with --devnet AND a loopback RPC. The devnet and the testnet share
 * EVM chain id 77390, so the chain id cannot tell them apart; --devnet on a public
 * RPC is refused rather than ignored.
 */
export function devnetOf(rpcUrl, opt = {}) {
  if (!opt.devnet) return false;
  if (!isLoopback(rpcUrl)) throw new Error('--devnet is only for a local devnet (an RPC on 127.0.0.1 / localhost)');
  return true;
}

/** An https url and a 32-byte sha256 (0x optional) → { url, sha } or throws. */
export function auditArgs(url, sha) {
  const u = String(url ?? '');
  if (!/^https:\/\/[^\s]{3,192}$/.test(u)) throw new Error('--audit-report must be an https:// url (at most 200 characters) of the published audit report');
  const h = String(sha ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h) || /^0+$/.test(h)) throw new Error('--audit-sha256 must be the sha256 of the report file (64 hex), e.g. sha256sum report.pdf');
  return { url: u, sha: '0x' + h };
}

const MSIG = new Interface([
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', // Safe
  'function ownerCount() view returns (uint256)', 'function owners(uint256) view returns (address)', 'function threshold() view returns (uint8)', // SimpleMultisig
]);

async function tryCall(provider, to, fn, args = []) {
  try {
    const ret = await provider.call({ to, data: MSIG.encodeFunctionData(fn, args) });
    if (!ret || ret === '0x') return undefined;
    return MSIG.decodeFunctionResult(fn, ret)[0];
  } catch { return undefined; }
}

/** What an admin address is: { address, kind: gov-module|eoa|safe|simple|contract, owners?, threshold? }. */
export async function multisigInfo(provider, address) {
  const a = getAddress(address);
  if (same(a, GOV_MODULE)) return { address: a, kind: 'gov-module' };
  if ((await provider.getCode(a)) === '0x') return { address: a, kind: 'eoa' };
  const safeOwners = await tryCall(provider, a, 'getOwners');
  const safeThreshold = await tryCall(provider, a, 'getThreshold');
  if (safeOwners && safeThreshold != null) return { address: a, kind: 'safe', owners: [...safeOwners].map(getAddress), threshold: Number(safeThreshold) };
  const n = await tryCall(provider, a, 'ownerCount');
  const t = await tryCall(provider, a, 'threshold');
  if (n != null && t != null && n <= 50n) {
    const owners = [];
    for (let i = 0n; i < n; i++) owners.push(getAddress(await tryCall(provider, a, 'owners', [i])));
    return { address: a, kind: 'simple', owners, threshold: Number(t) };
  }
  // a ZetaphyTimelock (OpenZeppelin TimelockController + role enumeration): its delay, admins and proposers
  const tl = await timelockInfo(provider, a);
  if (tl) return tl;
  return { address: a, kind: 'contract' };
}

const TL = new Interface(['function getMinDelay() view returns (uint256)', 'function getRoleMemberCount(bytes32) view returns (uint256)',
  'function getRoleMember(bytes32, uint256) view returns (address)']);
const PROPOSER_ROLE = id('PROPOSER_ROLE');
async function timelockInfo(provider, a) {
  const call = async (fn, args = []) => { try { const r = await provider.call({ to: a, data: TL.encodeFunctionData(fn, args) }); return r && r !== '0x' ? TL.decodeFunctionResult(fn, r)[0] : undefined; } catch { return undefined; } };
  const delay = await call('getMinDelay');
  const n = await call('getRoleMemberCount', [PROPOSER_ROLE]);
  if (delay == null || n == null || n > 20n) return null;
  const members = async (role, count) => { const out = []; for (let i = 0n; i < count; i++) out.push(getAddress(await call('getRoleMember', [role, i]))); return out; };
  const proposers = await members(PROPOSER_ROLE, n);
  const admins = await members(ZeroHash, (await call('getRoleMemberCount', [ZeroHash])) ?? 0n);
  const infos = [];
  for (const p of proposers) infos.push(await multisigInfo(provider, p));
  return { address: a, kind: 'timelock', delay: Number(delay), proposers: infos, admins };
}

/** Problems of one multisig: threshold >= 2, owners >= 3, distinct, none the deployer. */
export function multisigProblems(info, { deployer, label }) {
  const p = [];
  if (info.kind !== 'safe' && info.kind !== 'simple') return p;
  const owners = info.owners ?? [];
  if (info.threshold < 2) p.push(`${label} ${info.address}: threshold ${info.threshold}, needs at least 2`);
  if (owners.length < 3) p.push(`${label} ${info.address}: ${owners.length} owner(s), needs at least 3 (each on its own hardware wallet)`);
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) p.push(`${label} ${info.address}: an owner is listed twice`);
  if (info.threshold > owners.length) p.push(`${label} ${info.address}: threshold ${info.threshold} above its ${owners.length} owners`);
  if (deployer && owners.some((o) => same(o, deployer))) p.push(`${label} ${info.address}: the deployer key ${deployer} is one of its owners`);
  return p;
}

/**
 * Roles: governance (one or more addresses that must each be a multisig or the gov module)
 * and guardians (multisigs). Returns { problems, warnings, infos }.
 */
export async function roleChecks(provider, { governance = [], guardians = [] }, { deployer, devnet = false, allowEoa = false } = {}) {
  const problems = [], warnings = [], infos = [];
  const look = async (addr, role) => { const i = { ...(await multisigInfo(provider, addr)), role }; infos.push(i); return i; };
  const govInfos = [];
  for (const g of new Set(governance.map((x) => getAddress(x)))) govInfos.push(await look(g, 'governance'));
  const guardInfos = [];
  for (const g of new Set(guardians.map((x) => getAddress(x)))) guardInfos.push(await look(g, 'guardian'));
  if (!guardInfos.length) problems.push('no guardian: set a guardian multisig (it can pause the bridge, never unpause)');
  // governance behind a ZetaphyTimelock: the delay holds (24 h+), the timelock is its own only admin,
  // and its proposers are checked like governance (multisigs or the gov module)
  for (const t of govInfos.filter((x) => x.kind === 'timelock')) {
    if (t.delay < 86400 && !devnet) problems.push(`governance ${t.address} is a timelock with a ${t.delay} s delay: at least 86400 (24 h)`);
    if (t.admins.length !== 1 || !same(t.admins[0], t.address)) problems.push(`governance ${t.address} is a timelock whose admin role is ${t.admins.join(', ') || 'nobody'}: it must be its own only admin`);
    if (!t.proposers.length) problems.push(`governance ${t.address} is a timelock without proposers`);
    for (const p of t.proposers) govInfos.push({ ...p, role: `governance (proposer of timelock ${t.address})` });
  }
  for (const i of [...govInfos.filter((x) => x.kind !== 'timelock'), ...guardInfos]) {
    const label = i.role;
    if (i.kind === 'gov-module') {
      if (i.role === 'guardian') warnings.push(`guardian ${i.address} is the gov module: a pause would need a vote (slow); prefer a guardian multisig`);
      continue;
    }
    if (i.kind === 'eoa') {
      if (devnet || allowEoa) warnings.push(`${label} ${i.address} is a single key (EOA): allowed only ${devnet ? 'on this devnet' : 'because of --allow-eoa-for-testing'}`);
      else problems.push(`${label} ${i.address} is a single key (EOA, no code): use a multisig (Safe or SimpleMultisig) whose owners are hardware wallets${i.address && deployer && same(i.address, deployer) ? ' (this is the deployer key)' : ''}`);
      continue;
    }
    if (i.kind === 'contract') { problems.push(`${label} ${i.address}: a contract that is neither a Safe nor a SimpleMultisig (cannot read its owners and threshold)`); continue; }
    problems.push(...multisigProblems(i, { deployer, label }));
  }
  for (const g of govInfos.filter((x) => x.kind !== 'timelock')) {
    for (const d of guardInfos) {
      if (same(g.address, d.address)) { problems.push(`guardian and governance are the same address ${g.address}: use two different multisigs`); continue; }
      const shared = (g.owners ?? []).filter((o) => (d.owners ?? []).some((x) => same(x, o)));
      if (shared.length) problems.push(`owner(s) ${shared.join(', ')} hold keys in both the governance multisig ${g.address} and the guardian multisig ${d.address}: one person, one key`);
    }
  }
  return { problems, warnings, infos };
}

const LANE = new Interface([
  'function governance() view returns (address)', 'function owner() view returns (address)', 'function admin() view returns (address)',
  'function runners() view returns (address)', 'function mailbox() view returns (address)', 'function interchainSecurityModule() view returns (address)',
]);
async function laneRead(provider, lane, fn) {
  try { const r = await provider.call({ to: lane, data: LANE.encodeFunctionData(fn) }); return r && r !== '0x' ? getAddress(LANE.decodeFunctionResult(fn, r)[0]) : null; } catch { return null; }
}

/**
 * The airlock's lanes: [{ lane, kind, controller, admin, extra }] and problems:
 * 2+ independent lanes (on-chain count), no EOA lane except on a devnet / with
 * allowEoa, no controller or admin that is the deployer, and no lane admin that
 * controls another lane.
 */
export async function laneChecks(provider, airlock, { deployer, devnet = false, allowEoa = false } = {}) {
  const problems = [], warnings = [], lanes = [];
  for (const l of await airlock.lanes()) {
    const lane = getAddress(l);
    const eoa = (await provider.getCode(lane)) === '0x';
    const controller = getAddress(await airlock.laneControllerOf(lane));
    const admin = eoa ? null : (await laneRead(provider, lane, 'governance')) ?? (await laneRead(provider, lane, 'owner')) ?? (await laneRead(provider, lane, 'admin'));
    const runners = eoa ? null : await laneRead(provider, lane, 'runners');
    const mailbox = eoa ? null : await laneRead(provider, lane, 'mailbox');
    const kind = eoa ? 'key (EOA)' : runners ? 'NeuroLane' : mailbox ? 'HyperlaneLane' : 'contract';
    lanes.push({ lane, kind, controller, admin, ...(mailbox ? { ism: await laneRead(provider, lane, 'interchainSecurityModule') } : {}) });
    if (eoa) {
      if (devnet || allowEoa) warnings.push(`lane ${lane} is a single key (EOA): allowed only ${devnet ? 'on this devnet' : 'because of --allow-eoa-for-testing'}`);
      else problems.push(`lane ${lane} is a single key (EOA): a real lane is a contract (NeuroLane, HyperlaneLane)`);
    }
    if (deployer && same(controller, deployer)) problems.push(`lane ${lane}: its controller is the deployer key ${deployer}`);
    if (deployer && admin && same(admin, deployer)) problems.push(`lane ${lane}: its admin (governance) is still the deployer key ${deployer}: hand it to a multisig`);
  }
  for (const a of lanes) for (const b of lanes) {
    if (a !== b && a.admin && same(a.admin, b.controller)) problems.push(`lane ${a.lane}'s admin ${a.admin} controls lane ${b.lane}: the lanes are not independent`);
  }
  const independent = Number(await airlock.independentLanes());
  if (independent < 2) problems.push(`${independent} independent lane(s) in the airlock (distinct controllers): needs 2, e.g. NeuroLane + HyperlaneLane`);
  return { problems, warnings, lanes, independent };
}

/** Daily limit (whole tokens) against the starter cap and the on-chain hard cap (token units). */
export function capProblems({ limitUnits, decimals, raiseCap = false, maxDailyLimit = null }) {
  const p = [];
  const units = BigInt(limitUnits);
  const starter = STARTER_UNITS * 10n ** BigInt(decimals);
  if (units > starter && !raiseCap) p.push(`daily limit above the starter cap (${STARTER_UNITS} tokens): pass --raise-cap if governance decided so`);
  if (maxDailyLimit != null && units > BigInt(maxDailyLimit)) p.push(`daily limit above BridgeGuard.maxDailyLimit (${maxDailyLimit} units): raise the cap first (zetaphy bridge cap propose: x2 per step, 7 days each)`);
  if (units === 0n) p.push('daily limit 0: nothing could cross');
  return p;
}

/** NeuroJobs.activeWorkers() >= min. */
export async function runnerProblems(jobs, min) {
  const n = Number(await jobs.activeWorkers());
  return { active: n, problems: n >= min ? [] : [`${n} active Neuro runner(s) in NeuroJobs, needs at least ${min} independent runners`] };
}

