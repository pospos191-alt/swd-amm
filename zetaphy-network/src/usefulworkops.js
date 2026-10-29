// Putting useful work (docs/future/useful-work.md, item 5) on the real testnet:
//   deployUsefulWork  WorkerReputation + UsefulIssuance (optional) + UsefulWork + BugBounty, wired, PAUSED,
//                     every admin role handed to the ZetaphyTimelock; returns the timelock proposals that
//                     open them (and fund the issuance buckets), to be scheduled by the timelock's proposers.
//   feedRound         one run of the job feeder (a GitHub Actions schedule): reveals the canaries whose
//                     commits closed, settles what is ready, and posts new scan jobs for contracts it has
//                     not posted lately (a share of them canaries: a hidden commitment to Neuro's own
//                     answer). Stateless: canary salts are derived from the feeder key, so nothing has to
//                     be stored between runs.
// Testnet only: both refuse any chain but 77390 (or 31337 / 1337 for a local devnet with `devnet: true`).
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, Interface, AbiCoder, keccak256, getAddress, encodeBytes32String, decodeBytes32String, parseEther, ZeroAddress, ZeroHash } from 'ethers';
import { scheduleData, executeData, operationId } from './timelock.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const coder = AbiCoder.defaultAbiCoder();
export const TESTNET = 77390n;
const DEVNETS = [31337n, 1337n];
const E = (x) => parseEther(String(x));
const DAY = 86400;
/** The smallest timelock delay accepted (UsefulIssuance itself insists on 2 days). */
export const MIN_TIMELOCK_DELAY = 2 * DAY;

/** Launch defaults: cheap, slow and careful until the seat lottery exists (see "The economics, honestly"). */
export const DEFAULT_PARAMS = {
  stampBits: 22, stampSeats: 6, stampLife: DAY, seatsPerDay: 12, seats: 3, quorum: 2, commitWindow: 3600, revealWindow: 3600,
  seatDeposit: E('0.01'), subsidy: E('0.005'), priorityScore: 0, priorityWindow: 0,
};
export const DEFAULT_BOUNTY = { quorum: 3, minAgreed: 5, findingDeposit: E('0.1'), revealWindow: DAY, judgeWindow: 3 * DAY };
/** UsefulIssuance buckets: 60% scans, 40% bug bounties, small caps. */
export const DEFAULT_BUCKETS = [{ name: 'usefulWork', bps: 6000, cap: E(500) }, { name: 'bugBounty', bps: 4000, cap: E(500) }];

async function checkChain(provider, devnet) {
  const id = (await provider.getNetwork()).chainId;
  if (id === TESTNET || (devnet && DEVNETS.includes(id))) return id;
  throw new Error(`chain ${id}: useful work is deployed on the ZETAPHY testnet (77390) only${devnet ? ' or a local devnet (31337 / 1337)' : ''}`);
}

/** The addresses the launch state already knows (zetaphy-launch/state/77390.json): timelock, NeuroJobs, identity, guardian, vault. */
export function launchDefaults(file = new URL('../../zetaphy-launch/state/77390.json', import.meta.url)) {
  let st;
  try { st = JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const step of Object.values(st.steps ?? {})) Object.assign(out, step.out ?? {});
  return { timelock: out.timelock, jobs: out.neuroJobs, identity: out.neuroIdentity, guardian: out.guardianMultisig, rewardVault: out.rewardVault };
}

/**
 * Deploys and wires useful work, paused, owned by the timelock.
 * @param o.signer        the deployer (a temporary admin: every role ends with the timelock)
 * @param o.timelock      ZetaphyTimelock (getMinDelay() >= 2 days)
 * @param o.jobs          NeuroJobs (BugBounty's runners, WorkerReputation's runner record)
 * @param o.identity      NeuroIdentity (ERC-8004 link), optional
 * @param o.feeder        the job feeder's address (a scheduled Action's key), optional
 * @param o.guardian      may pause both markets (never unpause), optional (a multisig)
 * @param o.overflow      UsefulIssuance's overflow (unclaimed shares), required when o.issuance
 * @param o.issuance      deploy UsefulIssuance too (default true)
 */
export async function deployUsefulWork(o) {
  const { signer } = o;
  const provider = signer.provider;
  const chainId = await checkChain(provider, o.devnet);
  const me = await signer.getAddress();
  const timelock = getAddress(o.timelock ?? '');
  const jobs = getAddress(o.jobs ?? '');
  const tl = new Contract(timelock, art('ZetaphyTimelock').abi, provider);
  let delay;
  try { delay = Number(await tl.getMinDelay()); } catch { throw new Error(`${timelock} is not a ZetaphyTimelock (getMinDelay failed)`); }
  if (delay < MIN_TIMELOCK_DELAY) throw new Error(`the timelock's delay is ${delay} s; useful work needs at least ${MIN_TIMELOCK_DELAY} s (2 days)`);
  if ((await provider.getCode(jobs)) === '0x') throw new Error(`no NeuroJobs at ${jobs}`);
  const params = { ...DEFAULT_PARAMS, ...(o.params ?? {}) };
  const bp = { ...DEFAULT_BOUNTY, ...(o.bounty ?? {}) };
  const log = o.log ?? (() => {});
  const deploy = async (name, args) => {
    const c = await new ContractFactory(art(name).abi, art(name).bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    log(`${name} ${await c.getAddress()}`);
    return c;
  };
  const tx = async (p, what) => { const r = await (await p).wait(); log(`  ${what}`); return r; };
  const startBlock = await provider.getBlockNumber();

  const rep = await deploy('WorkerReputation', [me, jobs, o.identity ? getAddress(o.identity) : ZeroAddress]);
  let iss = null;
  if (o.issuance !== false) {
    if (!o.overflow) throw new Error('UsefulIssuance needs an overflow address (--overflow 0x…, e.g. the RewardVault)');
    iss = await deploy('UsefulIssuance', [timelock, getAddress(o.overflow)]);
  }
  const issAddr = iss ? await iss.getAddress() : ZeroAddress;
  const uw = await deploy('UsefulWork', [me, await rep.getAddress(), issAddr, params]);
  const bb = await deploy('BugBounty', [jobs, bp.quorum, bp.minAgreed, me, await rep.getAddress(), issAddr, bp.findingDeposit, bp.revealWindow, bp.judgeWindow]);
  const [uwA, bbA, repA] = await Promise.all([uw.getAddress(), bb.getAddress(), rep.getAddress()]);

  // paused first: nothing can be posted or taken before governance opens it
  await tx(uw.setPaused(true), 'UsefulWork paused');
  await tx(bb.setPaused(true), 'BugBounty paused');
  await tx(rep.setReporter(uwA, true), 'reputation: UsefulWork reports');
  await tx(rep.setReporter(bbA, true), 'reputation: BugBounty reports');
  if (o.feeder) await tx(uw.setFeeder(getAddress(o.feeder), true), `feeder ${o.feeder}`);
  if (o.guardian) {
    await tx(uw.setGuardian(getAddress(o.guardian)), `UsefulWork guardian ${o.guardian}`);
    await tx(bb.setGuardian(getAddress(o.guardian)), `BugBounty guardian ${o.guardian}`);
  }
  for (const [c, n] of [[uw, 'UsefulWork'], [bb, 'BugBounty'], [rep, 'WorkerReputation']]) await tx(c.setGovernance(timelock), `${n} governance -> timelock`);

  // check what was left behind
  for (const [c, n] of [[uw, 'UsefulWork'], [bb, 'BugBounty'], [rep, 'WorkerReputation']]) {
    if (getAddress(await c.governance()) !== timelock) throw new Error(`${n}: governance is not the timelock`);
  }
  if (!(await uw.paused()) || !(await bb.paused())) throw new Error('not paused');
  if (iss && getAddress(await iss.governance()) !== timelock) throw new Error('UsefulIssuance: governance is not the timelock');

  const contracts = { usefulWork: uwA, bugBounty: bbA, workerReputation: repA, ...(iss ? { usefulIssuance: issAddr } : {}) };
  const proposals = openProposals({ contracts, delay, buckets: o.buckets ?? DEFAULT_BUCKETS, salt: o.salt ?? `useful-work-open-${startBlock}` });
  return {
    format: 'zetaphy-useful-work/1', chainId: Number(chainId), deployer: me, deployedAt: new Date().toISOString(), startBlock,
    timelock, timelockDelay: delay, neuroJobs: jobs, identity: o.identity ?? null, feeder: o.feeder ?? null, guardian: o.guardian ?? null,
    overflow: o.overflow ?? null, paused: true, contracts,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    bounty: Object.fromEntries(Object.entries(bp).map(([k, v]) => [k, String(v)])),
    proposals,
  };
}

/** The timelock operations that open useful work: issuance buckets (if any), then unpause both markets. */
export function openProposals({ contracts, delay, buckets = DEFAULT_BUCKETS, salt = 'useful-work-open' }) {
  const ops = [];
  const saltOf = (i) => keccak256(new TextEncoder().encode(`${salt}:${i}`));
  const add = (target, iface, fn, args, what) => {
    const data = iface.encodeFunctionData(fn, args);
    const op = { target, value: '0', data, predecessor: ZeroHash, salt: saltOf(ops.length) };
    ops.push({ what, ...op, id: operationId(op), schedule: scheduleData({ ...op, delay }), execute: executeData(op) });
  };
  const ifc = (n) => new Interface(art(n).abi);
  if (contracts.usefulIssuance) {
    const b = buckets.map((x) => ({ sink: contracts[x.name] ?? x.sink, bps: x.bps, cap: x.cap, accrued: 0n }));
    add(contracts.usefulIssuance, ifc('UsefulIssuance'), 'setBuckets', [b], `UsefulIssuance.setBuckets (${buckets.map((x) => `${x.name} ${x.bps / 100}%`).join(', ')})`);
  }
  add(contracts.usefulWork, ifc('UsefulWork'), 'setPaused', [false], 'UsefulWork.setPaused(false): open scan jobs');
  add(contracts.bugBounty, ifc('BugBounty'), 'setPaused', [false], 'BugBounty.setPaused(false): open bug bounties');
  return ops;
}

// ------------------------------------------------------------------ the feeder

/** The salt of a canary: secret without the feeder key, recomputed at reveal time (nothing stored). */
export function canarySalt(privateKey, usefulWork, jobId) {
  return keccak256(coder.encode(['string', 'bytes32', 'address', 'uint256'], ['zetaphy canary salt', keccak256(privateKey), getAddress(usefulWork), BigInt(jobId)]));
}
export const canaryCommitmentOf = (verdict, salt, id) => keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [verdict, salt, BigInt(id)]));

/**
 * One feeder run. o: { usefulWork (Contract with signer), privateKey, targets: [{ chain, address }],
 *   codeOf(chain, address) -> 0x code, verdictOf({ chain, target, code, codeHash }) -> 0x verdict,
 *   maxJobs (5), fee (wei per job), canaryEvery (3: every 3rd posted job is a canary; 0 = none),
 *   subsidized (false), lookback (200 recent jobs checked for duplicates), dryRun, log }.
 * Returns { paused, revealed: [ids], settled: [ids], posted: [{ id, chain, target, canary }], skipped: [...] }.
 */
export async function feedRound(o) {
  const uw = o.usefulWork;
  const log = o.log ?? (() => {});
  const me = await uw.runner.getAddress();
  const addr = await uw.getAddress();
  await checkChain(uw.runner.provider, o.devnet);
  const out = { paused: await uw.paused(), feeder: await uw.feeders(me), revealed: [], settled: [], posted: [], skipped: [] };
  const send = async (what, fn, ...args) => {
    if (o.dryRun) { log(`would ${what}`); return null; }
    const r = await (await fn(...args)).wait();
    log(what);
    return r;
  };
  const n = Number(await uw.jobCount());
  const from = Math.max(0, n - (o.lookback ?? 200));
  const recent = new Set();
  // 1-2. canaries to reveal, jobs to settle (both allowed while paused, so nothing stays stuck)
  for (let id = from; id < n; id++) {
    const j = await uw.getJob(id);
    recent.add(`${decodeBytes32String(j.chain)}:${String(j.target).toLowerCase()}:${j.codeHash}`);
    if (j.settled) continue;
    const ph = Number(await uw.phase(id));
    if (getAddress(j.poster) === getAddress(me) && j.canary !== ZeroHash && !j.canaryRevealed && ph >= 1) {
      const chain = decodeBytes32String(j.chain);
      try {
        const code = await o.codeOf(chain, j.target);
        const verdict = await o.verdictOf({ chain, target: j.target, code, codeHash: j.codeHash });
        const salt = canarySalt(o.privateKey, addr, id);
        if (canaryCommitmentOf(verdict, salt, id) !== j.canary) { out.skipped.push({ id, why: 'canary no longer matches (code changed?)' }); }
        else { await send(`reveal canary of job ${id}`, uw.revealCanary, id, verdict, salt); out.revealed.push(id); }
      } catch (e) { out.skipped.push({ id, why: `canary: ${e.shortMessage ?? e.message}` }); }
    }
    if (Number(await uw.phase(id)) === 2 || ph === 2) {
      try { await uw.settle.staticCall(id); await send(`settle job ${id}`, uw.settle, id); out.settled.push(id); } catch { /* not yet */ }
    }
  }
  // 3. new jobs
  if (out.paused) { log('UsefulWork is paused: no new jobs (governance opens it through the timelock)'); return out; }
  if (!out.feeder) { log(`${me} is not a feeder of ${addr}: no new jobs`); return out; }
  const fee = BigInt(o.fee ?? E('0.01'));
  const every = Number(o.canaryEvery ?? 3);
  let next = n;
  for (const t of o.targets ?? []) {
    if (out.posted.length >= (o.maxJobs ?? 5)) break;
    const chain = String(t.chain), target = String(t.address);
    let code;
    try { code = await o.codeOf(chain, target); } catch (e) { out.skipped.push({ target, why: e.message }); continue; }
    if (!code || code === '0x') { out.skipped.push({ target, why: 'no code' }); continue; }
    const codeHash = keccak256(code);
    if (recent.has(`${chain}:${target.toLowerCase()}:${codeHash}`)) { out.skipped.push({ target, why: 'posted lately' }); continue; }
    const canaryJob = every > 0 && out.posted.length % every === every - 1;
    let canary = ZeroHash;
    if (canaryJob) {
      const verdict = await o.verdictOf({ chain, target, code, codeHash });
      canary = canaryCommitmentOf(verdict, canarySalt(o.privateKey, addr, next), next);
    }
    const r = await send(`post ${chain}:${target}${canaryJob ? ' (canary)' : ''}`, uw.postFeeder, encodeBytes32String(chain), target, codeHash, 0, !!o.subsidized, canary, { value: fee });
    let id = next;
    if (r) {
      const ev = r.logs.map((l) => { try { return uw.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Posted');
      id = Number(ev.args.id);
      if (canaryJob && id !== next) throw new Error(`job id ${id}, expected ${next}: another poster raced the canary (it will not reveal)`);
    }
    out.posted.push({ id, chain, target, canary: canaryJob });
    recent.add(`${chain}:${target.toLowerCase()}:${codeHash}`);
    next = id + 1;
  }
  return out;
}

/** Contracts created in recent blocks of ZETAPHY (feeder targets): [{ chain: 'zetaphy', address }]. */
export async function newContracts(provider, { blocks = 200, max = 20 } = {}) {
  const top = await provider.getBlockNumber();
  const out = [];
  for (let b = top; b > Math.max(0, top - blocks) && out.length < max; b--) {
    const blk = await provider.getBlock(b, true);
    for (const tx of blk?.prefetchedTransactions ?? []) {
      if (tx.to) continue;
      const rc = await provider.getTransactionReceipt(tx.hash);
      if (rc?.contractAddress) out.push({ chain: 'zetaphy', address: rc.contractAddress });
    }
  }
  return out;
}
