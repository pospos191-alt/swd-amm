// The frontier contracts (docs/future/*.md) that were built and tested but had no deploy path, plus the deploys that
// existed only as separate commands (the open audit network, HackInsurance, offline trading): one run deploys every
// one still missing on the ZETAPHY testnet, one transaction at a time from one key, and hands nothing to that key.
// Every contract with a governance role takes the ZetaphyTimelock in its constructor; the others have no owner.
// A run that stops half way resumes: each record keeps what is deployed, and the transaction in flight is noted
// (`pending`) before it is sent, so a re-run adopts a contract that landed after the stop instead of deploying a twin.
// What is deliberately NOT deployed, and why, is FRONTIER_SKIPPED (docs/future/deploy.md, "The frontier button").
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, getAddress, getCreateAddress, parseEther } from 'ethers';
import { assistDeployArgs, ASSIST_DEFAULTS } from './assistdeploy.js';
import { deployAuditNetwork } from './auditnetops.js';
import { deployOffline, checkOffline } from './offlinedeploy.js';

export { fromLaunchState } from './aideploy.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const hasGovernance = (contract) => art(contract).abi.some((f) => f.type === 'function' && f.name === 'governance' && f.inputs.length === 0);

/** ZETAPHY's security precompile (Q-day height; src/pqtx.js SECURITY_PRECOMPILE). QuantumRescue reads qday() from it. */
export const SECURITY_PRECOMPILE = '0x0000000000000000000000000000000000000901';

/** Defaults (testnet ZETAPHY amounts). Each one is documented where the contract is (docs/future/*.md). */
export const FRONTIER_DEFAULTS = {
  immuneMinAgreed: 2,            // immune-network.md: k = 2 of the 3 NeuroJobs seats (zetaphy-chain/hyperlane/immune-network.json)
  guardianBond: 10, claimBond: 5, // self-healing.md: the guardian bond a runner posts, the bond for a false-trip claim (coins)
  breakerMinQuorum: 3, breakerMinAgreed: 1,
  rescueMaturity: 720,           // quantum-safe-settlement.md 4.4: blocks before a rescue commitment counts (the hub's e2e value)
  rootTtl: 3600,                 // zk-identity.md: a replaced root stays valid 1 hour
  insuranceQuorum: ASSIST_DEFAULTS.quorum, insuranceMinAgreed: ASSIST_DEFAULTS.minAgreed, // deploy-assist insurance's defaults
  pqValidators: [], pqThreshold: 1, // PQMultisigIsm: ML-DSA-44 validator key hashes; none exist yet, so it is skipped
  txTimeoutMs: 15 * 60_000,      // the testnet node is slow (5-15 s blocks)
};

/** Why an input is needed, for the skip messages. */
const NEED = {
  jobs: 'NeuroJobs (launch state neuroJobs)',
  threats: 'the ThreatRegistry (launch state threatRegistry)',
  mailbox: "ZETAPHY's Hyperlane Mailbox (zetaphy-chain/hyperlane/saphan-chains.json zetaphy.mailbox)",
  labels: 'the LabelRegistry (deployments/ai-77390.json labelRegistry: run ai-deploy first)',
  vouch: 'the VouchRegistry (deployments/ai-77390.json vouchRegistry: run ai-deploy first)',
  pqValidators: 'an ML-DSA-44 validator set (none exists yet; pass --pq-validators 0x<keyHash>,…)',
};

/**
 * Every frontier step: the record key, the contract, its doc, the inputs it needs (`needs`: launch-state / config
 * addresses that must have code; `after`: record keys of earlier steps) and its constructor. Order matters.
 */
export const FRONTIER_STEPS = [
  { key: 'immuneRegistry', contract: 'ImmuneRegistry', doc: 'immune-network', needs: ['jobs', 'threats'],
    args: (x) => [x.jobs, x.threats, x.o.immuneMinAgreed, x.gov] },
  { key: 'immuneBroadcaster', contract: 'ImmuneBroadcaster', doc: 'immune-network', needs: ['mailbox'], after: ['immuneRegistry'],
    args: (x) => [x.r.immuneRegistry, x.mailbox, x.gov] },
  { key: 'circuitBreaker', contract: 'CircuitBreaker', doc: 'self-healing', needs: ['jobs'],
    args: (x) => [x.jobs, x.gov, parseEther(String(x.o.guardianBond)), parseEther(String(x.o.claimBond)), x.o.breakerMinQuorum, x.o.breakerMinAgreed] },
  { key: 'quantumRescue', contract: 'QuantumRescue', doc: 'quantum-safe-settlement', args: (x) => [SECURITY_PRECOMPILE, x.gov, BigInt(x.o.rescueMaturity)] },
  { key: 'pqSettlement', contract: 'PQSettlement', doc: 'quantum-safe-settlement', args: () => [] },
  { key: 'pqMultisigIsm', contract: 'PQMultisigIsm', doc: 'quantum-safe-settlement', needs: ['pqValidators'],
    args: (x) => [x.gov, x.pqValidators, x.o.pqThreshold] },
  { key: 'zetaphyOutbox', contract: 'ZetaphyOutbox', doc: 'trustless-bridge', args: () => [] },
  { key: 'poseidonT3', contract: 'PoseidonT3', doc: 'zk-identity', args: () => [] },
  { key: 'zkIdentityVerifier', contract: 'ZkIdentityVerifier', doc: 'zk-identity', args: () => [],
    note: 'DEV trusted setup (one party, DEV_SETUP = true): testnet only; a public phase-2 ceremony must replace it before mainnet' },
  { key: 'zkIdentityRegistry', contract: 'ZkIdentityRegistry', doc: 'zk-identity', needs: ['labels', 'vouch'], after: ['poseidonT3', 'zkIdentityVerifier'],
    args: (x) => [x.r.poseidonT3, x.r.zkIdentityVerifier, x.labels, x.vouch, x.gov, BigInt(x.o.rootTtl)],
    note: 'proofs check against the DEV-setup ZkIdentityVerifier (testnet only)' },
  { key: 'privatePoll', contract: 'PrivatePoll', doc: 'zk-identity', after: ['zkIdentityRegistry'], args: (x) => [x.r.zkIdentityRegistry] },
  { key: 'hackInsurance', contract: 'HackInsurance', doc: 'crosschain-assist', needs: ['jobs'],
    args: (x) => assistDeployArgs('insurance', { gov: x.gov, jobs: x.jobs, quorum: x.o.insuranceQuorum, minAgreed: x.o.insuranceMinAgreed })[1],
    note: 'TESTNET ONLY: testnet ZETAPHY has no value; never real money (`zetaphy deploy-assist insurance`)' },
];

/** What the button deliberately leaves out, and why (no safety check is worked around to deploy these). */
export const FRONTIER_SKIPPED = [
  { what: 'TrainingPool, TrainingMarket (useful-work-training.md)', reason: 'their constructors require governance to be a timelock with getMinDelay() >= 2 days (_checkTimelock); the testnet timelock keeps a 0 delay' },
  { what: 'UsefulWork, UsefulIssuance, BugBounty, WorkerReputation (useful-work.md)', reason: '`zetaphy deploy-useful-work` and UsefulIssuance refuse a timelock with getMinDelay() < 2 days; the testnet timelock keeps a 0 delay' },
  { what: 'ProvenVerdicts (proven-verdicts.md)', reason: "needs the public zkML ceremony's final key (zetaphy-neuro/ml/onchain/zk/**); the ceremony is not finished" },
  { what: 'StarkLightClient, StarkVerifier (stark-light-client.md)', reason: 'they verify ZETAPHY from another chain: deployed there, with a genesis pin and checkpoints of the real chain' },
  { what: 'BtcLightClient', reason: 'needs a real Bitcoin checkpoint header (hash, height, time, bits) and a relayer feeding headers' },
  { what: 'ZetaphyBridgeInbox (trustless-bridge.md)', reason: 'lives on the destination chain, behind a STARK light client of ZETAPHY' },
  { what: 'ZetaphyLockbox (trustless-bridge.md)', reason: 'one per token and destination receiver on another chain; deployed with that route' },
  { what: 'ImmuneMirror (immune-network.md)', reason: "one per other chain (that chain's Mailbox, our ISM); deployed per chain, then ImmuneBroadcaster.setReceiver through the timelock" },
  { what: 'PrivateAirdrop (zk-identity.md)', reason: 'one per airdrop: funded by its sponsor, registers its own scope' },
  { what: 'ImmuneGuardedRouter', reason: 'an example integration of ImmuneGuard (its owner is the deployer)' },
  { what: 'Encrypted mempool (encrypted-mempool.md)', reason: 'a chain module, not a contract: it needs a chain upgrade' },
  { what: 'NeuroJobs, StableGateway, RewardVault, BridgeAirlock and the other launch contracts', reason: 'already deployed by launch-testnet; redeploying them would mean rewiring everything that points at them (out of scope)' },
];

const isSet = (k, v) => (k === 'pqValidators' ? Array.isArray(v) && v.length > 0 : ADDR.test(String(v ?? '')));

/** The skip reason of a step given the inputs and the record (null = deployable now). */
async function whyNot(step, x, provider) {
  for (const k of step.needs ?? []) {
    if (!isSet(k, x[k])) return `needs ${NEED[k]}`;
    if (k !== 'pqValidators' && (await provider.getCode(x[k])) === '0x') return `needs ${NEED[k]}: no code at ${x[k]}`;
  }
  const missing = (step.after ?? []).filter((k) => !x.r[k]);
  if (missing.length) return `needs ${missing.join(', ')} (not deployed)`;
  return null;
}

/**
 * Settles the transaction an earlier run noted as in flight: waits for it if the node still has it, then keeps the
 * contract if its address has code. Returns the adopted key or null.
 */
async function settlePending(provider, rec, timeout, log) {
  const p = rec.pending;
  if (!p) return null;
  if ((await provider.getCode(p.address)) === '0x' && p.hash) {
    const tx = await provider.getTransaction(p.hash).catch(() => null);
    if (tx) await provider.waitForTransaction(p.hash, 1, timeout).catch(() => null);
  }
  delete rec.pending;
  if ((await provider.getCode(p.address)) === '0x') { log(`${p.key}: the transaction of the stopped run did not land; deploying again`); return null; }
  rec.contracts[p.key] = getAddress(p.address);
  const rc = p.hash ? await provider.getTransactionReceipt(p.hash).catch(() => null) : null;
  rec.blocks[p.key] = rc?.blockNumber ?? null;
  log(`${p.key}: ${p.contract} ${p.address} (landed after the stopped run)`);
  return p.key;
}

/** Deploys one contract at the key's next nonce, noting it as `pending` (saved) before sending. */
async function deployOne(ctx, step, args) {
  const { signer, me, provider, rec, save, timeout } = ctx;
  const a = art(step.contract);
  // never below the nonce after this run's last transaction (a provider may answer from a short cache)
  const nonce = Math.max(await provider.getTransactionCount(me, 'pending'), ctx.next ?? 0);
  ctx.next = nonce + 1;
  const address = getAddress(getCreateAddress({ from: me, nonce }));
  const req = await new ContractFactory(a.abi, a.bytecode, signer).getDeployTransaction(...args);
  rec.pending = { key: step.key, contract: step.contract, address, nonce, hash: null };
  save(rec);
  const tx = await signer.sendTransaction({ ...req, nonce });
  rec.pending.hash = tx.hash;
  save(rec);
  const rc = await tx.wait(1, timeout);
  if (!rc || rc.status !== 1) throw new Error(`${step.contract}: the deploy transaction ${tx.hash} failed`);
  if ((await provider.getCode(address)) === '0x') throw new Error(`${step.contract}: no code at ${address} after ${tx.hash}`);
  rec.contracts[step.key] = address;
  rec.blocks[step.key] = rc.blockNumber;
  delete rec.pending;
  save(rec);
  return address;
}

/**
 * Deploys the frontier contracts `record.contracts` does not have yet. Every one with a governance role takes `gov`
 * (the ZetaphyTimelock) in its constructor. `save(record)` is called before and after each transaction.
 * Returns { chainId, governance, timelockMinDelay, contracts, blocks, notes, skipped }.
 */
export async function deployFrontier({ signer, gov, jobs = null, threats = null, mailbox = null, labels = null, vouch = null,
  record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
  if (!ADDR.test(String(gov ?? ''))) throw new Error('governance: the ZetaphyTimelock address (the launch state has none)');
  gov = getAddress(gov);
  const provider = signer.provider;
  const me = getAddress(await signer.getAddress());
  if (gov === me) throw new Error('governance must be the timelock, not the deploy key');
  if ((await provider.getCode(gov)) === '0x') throw new Error(`governance ${gov} has no code: not a timelock`);
  const chainId = Number((await provider.getNetwork()).chainId);
  const rec = record ?? { chainId, governance: gov, contracts: {}, blocks: {} };
  if (rec.chainId !== chainId) throw new Error(`the record is for chain ${rec.chainId}, the node is ${chainId}`);
  if (getAddress(rec.governance) !== gov) throw new Error(`the record's governance is ${rec.governance}, not ${gov}`);
  rec.contracts ??= {}; rec.blocks ??= {};
  const opts = { ...FRONTIER_DEFAULTS, ...o };
  try { rec.timelockMinDelay = Number(await new Contract(gov, art('ZetaphyTimelock').abi, provider).getMinDelay()); } catch { rec.timelockMinDelay = null; }
  const ctx = { signer, me, provider, rec, save, timeout: opts.txTimeoutMs };
  await settlePending(provider, rec, opts.txTimeoutMs, log);
  save(rec);
  const x = { gov, me, jobs, threats, mailbox, labels, vouch, pqValidators: opts.pqValidators, r: rec.contracts, o: opts };
  const skipped = [];
  for (const step of FRONTIER_STEPS) {
    if (only && !only.includes(step.key)) continue;
    if (rec.contracts[step.key]) { log(`${step.key}: already at ${rec.contracts[step.key]}`); continue; }
    const why = await whyNot(step, x, provider);
    if (why) { skipped.push({ what: `${step.contract} (${step.key})`, reason: why }); log(`${step.key}: skipped (${why})`); continue; }
    const addr = await deployOne(ctx, step, step.args(x));
    log(`${step.key}: ${step.contract} ${addr} (block ${rec.blocks[step.key]})${hasGovernance(step.contract) ? ` governance ${gov}` : ', no owner'}${step.note ? ` [${step.note}]` : ''}`);
  }
  rec.notes = Object.fromEntries(FRONTIER_STEPS.filter((s) => s.note && rec.contracts[s.key]).map((s) => [s.key, s.note]));
  rec.skipped = [...skipped, ...FRONTIER_SKIPPED];
  save(rec);
  return rec;
}

/**
 * The whole button, in order, one transaction at a time: the frontier contracts, then the open audit network
 * (src/auditnetops.js, its own record), then offline trading (src/offlinedeploy.js, its own record). A part whose
 * record is complete is skipped; an unfinished audit network resumes at the nonces it planned (kept in the frontier
 * record as `auditPlan`). Returns { frontier, audit, offline, skipped: [{ what, reason }] }.
 *
 * @param p.records   { frontier, audit, offline }: the records so far (or null each)
 * @param p.saves     { frontier(rec), audit(rec), offline(rec) }: write each record
 * @param p.treasury  the audit network's treasury (default: the RewardVault)
 * @param p.router    the ZETAPHY Swap router (offline orders)
 */
export async function deployEverything({ signer, gov, jobs = null, threats = null, mailbox = null, labels = null, vouch = null, treasury = null, router = null,
  records = {}, saves = {}, o = {}, parts = ['frontier', 'audit', 'offline'], log = () => {} }) {
  const save = { frontier: () => {}, audit: () => {}, offline: () => {}, ...saves };
  const provider = signer.provider;
  const out = { frontier: records.frontier ?? null, audit: records.audit ?? null, offline: records.offline ?? null, skipped: [] };
  const frontier = (only) => deployFrontier({ signer, gov, jobs, threats, mailbox, labels, vouch, record: out.frontier, o, only, save: save.frontier, log });
  const audit = async () => {
    const fr = out.frontier;
    if (out.audit?.contracts?.auditNetwork) {
      if (out.audit.chainId !== fr.chainId || getAddress(out.audit.governance) !== getAddress(fr.governance)) throw new Error(`the audit record is for chain ${out.audit.chainId} / governance ${out.audit.governance}`);
      log(`audit network: already at ${out.audit.contracts.auditNetwork}`);
      if (fr.auditPlan) { delete fr.auditPlan; save.frontier(fr); }
      return;
    }
    const why = !isSet('jobs', jobs) ? `needs ${NEED.jobs}` : !isSet('jobs', treasury) ? 'needs a treasury (launch state rewardVault, or --treasury)'
      : (await provider.getCode(jobs)) === '0x' ? `needs ${NEED.jobs}: no code at ${jobs}` : null;
    if (why) { out.skipped.push({ what: 'AuditNetwork, AuditRunners, AuditJudges, AuditCertificate', reason: why }); log(`audit network: skipped (${why})`); return; }
    const res = await deployAuditNetwork({ signer, governance: fr.governance, treasury: getAddress(treasury), jobs: getAddress(jobs),
      startNonce: fr.auditPlan?.nonce ?? null, onPlan: (p) => { fr.auditPlan = p; save.frontier(fr); }, log: (l) => log(`audit network: ${l}`) });
    out.audit = res;
    save.audit(res);
    delete fr.auditPlan;
    save.frontier(fr);
  };
  // the record (and a transaction a stopped run left in flight) first; an audit network a stopped run left half
  // deployed is finished before anything else, while its planned nonces are still the key's next ones
  out.frontier = await frontier([]);
  let auditDone = false;
  if (parts.includes('audit') && out.frontier.auditPlan) { await audit(); auditDone = true; }
  if (parts.includes('frontier')) out.frontier = await frontier(null);
  if (parts.includes('audit') && !auditDone) await audit();

  if (parts.includes('offline')) {
    if (out.offline && ['zetaphyCheques', 'offlineOrders', 'offlineCash'].every((k) => out.offline.contracts?.[k])) log('offline trading: already deployed');
    else if (!isSet('jobs', router) || (await provider.getCode(router)) === '0x') {
      const reason = `needs the ZETAPHY Swap router (zetaphy-dex/web/deployments.json contracts.router)${isSet('jobs', router) ? `: no code at ${router}` : ''}`;
      out.skipped.push({ what: 'ZetaphyCheques, ZetaphyOfflineOrders, ZetaphyOfflineCash', reason });
      log(`offline trading: skipped (${reason})`);
    } else {
      out.offline = await deployOffline({ signer, router, record: out.offline, save: save.offline, log: (l) => log(`offline trading: ${l}`) });
      save.offline(out.offline);
    }
  }
  out.skipped.push(...out.frontier.skipped);
  return out;
}

/**
 * Reads everything back: code at every address, and every governance() equal to the frontier record's governance
 * (the timelock). Returns [{ part, key, address, governance, ok }]; the check fails if any is not ok.
 */
export async function checkEverything(provider, { frontier = null, audit = null, offline = null } = {}) {
  const out = [];
  const gov = frontier?.governance ? getAddress(frontier.governance) : null;
  const one = async (part, key, contract, address) => {
    const code = ADDR.test(String(address ?? '')) ? await provider.getCode(address) : '0x';
    let governance = null;
    let ok = code !== '0x';
    if (ok && hasGovernance(contract)) {
      governance = getAddress(await new Contract(address, art(contract).abi, provider).governance());
      ok = governance === (part === 'audit' ? getAddress(audit.governance) : gov) && (!gov || governance === gov);
    }
    out.push({ part, key, address: address ?? null, governance, ok });
  };
  if (frontier) for (const s of FRONTIER_STEPS) if (frontier.contracts?.[s.key]) await one('frontier', s.key, s.contract, frontier.contracts[s.key]);
  if (audit) {
    for (const [key, contract] of [['auditNetwork', 'AuditNetwork'], ['auditRunners', 'AuditRunners'], ['auditJudges', 'AuditJudges'], ['auditCertificate', 'AuditCertificate']]) {
      await one('audit', key, contract, audit.contracts?.[key]);
    }
  }
  if (offline) for (const r of await checkOffline(provider, offline)) out.push({ part: 'offline', key: r.key, address: r.address, governance: null, ok: r.ok });
  if (frontier?.pending) out.push({ part: 'frontier', key: frontier.pending.key, address: frontier.pending.address, governance: null, ok: false });
  return out;
}

/** The quantum-safe record the hub reads (deployments/qsafe-77390.json), from the frontier record; null if none deployed. */
export function qsafeRecord(fr) {
  const contracts = Object.fromEntries(['quantumRescue', 'pqSettlement', 'pqMultisigIsm'].filter((k) => fr?.contracts?.[k]).map((k) => [k, fr.contracts[k]]));
  return Object.keys(contracts).length ? { chainId: fr.chainId, governance: fr.governance, contracts } : null;
}

/**
 * zetaphy-chain/hyperlane/immune-network.json with the registry, broadcaster and NeuroJobs filled in. Never replaces
 * a different address already there (throws: that file names another deployment).
 */
export function immuneNetworkUpdate(file, fr, jobs) {
  const next = { ...file };
  for (const [k, v] of [['registry', fr?.contracts?.immuneRegistry], ['broadcaster', fr?.contracts?.immuneBroadcaster], ['jobs', fr?.contracts?.immuneRegistry ? jobs : null]]) {
    if (!ADDR.test(String(v ?? ''))) continue;
    if (file[k] && getAddress(file[k]) !== getAddress(v)) throw new Error(`immune-network.json ${k} is ${file[k]}, not ${v}`);
    next[k] = getAddress(v);
  }
  return next;
}
