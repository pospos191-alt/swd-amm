// The frontier contracts (docs/future/*.md) that were built and tested but had no deploy path, plus the deploys that
// existed only as separate commands (the open audit network, HackInsurance, offline trading): one run deploys every
// one still missing on the ZETAPHY testnet, one transaction at a time from one key, and hands nothing to that key.
// Every contract with a governance role takes the ZetaphyTimelock in its constructor; the others have no owner.
// A run that stops half way resumes: each record keeps what is deployed, and the transaction in flight is noted
// (`pending`) before it is sent, so a re-run adopts a contract that landed after the stop instead of deploying a twin.
// The SS tier of the open audit network (SS_STEPS) and Saphan's ZETAPHY-side contracts (SAPHAN_STEPS) follow, each in
// its own record, wired to the addresses the earlier parts recorded.
// What is deliberately NOT deployed, and why, is FRONTIER_SKIPPED, SS_SKIPPED and SAPHAN_SKIPPED (docs/future/deploy.md,
// "The frontier button").
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, Interface, ZeroAddress, getAddress, getCreateAddress, parseEther } from 'ethers';
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
  // the SS tier and Saphan parts (their own records; the addresses come from the records written before them)
  certificate: 'the AuditCertificate (deployments/audit-77390.json auditCertificate: the audit network part)',
  network: 'the AuditNetwork (deployments/audit-77390.json auditNetwork: the audit network part)',
  insurance: 'HackInsurance (deployments/frontier-77390.json hackInsurance)',
  breaker: 'the CircuitBreaker (deployments/frontier-77390.json circuitBreaker)',
  immune: 'the ImmuneRegistry (deployments/frontier-77390.json immuneRegistry)',
  neuro: 'NeuroScore (deployments/ai-77390.json neuroScore: run ai-deploy first)',
  reviewHolds: 'a ThreatRegistry with review holds (underReview / holdForReview / setVaccines, PR #115): the launch ThreatRegistry '
    + 'predates them, so with it every score would read as degraded (at most 500), and without it the score would not see its flags',
  poseidon: 'PoseidonT3 (deployments/frontier-77390.json poseidonT3)',
  zkVerifier: 'the ZkIdentityVerifier (deployments/frontier-77390.json zkIdentityVerifier)',
  routeIsm: "the Saphan route's ISM on ZETAPHY (zetaphy-chain/hyperlane/saphan-routes.json routes.<chain>.zetaphy.ism)",
  routeToken: "the Saphan route's token on ZETAPHY (zetaphy-chain/hyperlane/saphan-routes.json routes.<chain>.zetaphy.bridgedToken)",
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

/** Defaults of the SS tier and Saphan parts (testnet ZETAPHY amounts), each from the contract's doc or tests. */
export const SS_DEFAULTS = {
  firewallUncertifiedBps: 1000,  // invariant-firewall.md SS2: 10 % a day for an uncertified protocol above a threshold (the timelock may set 1..50 %)
  exploitSubmitBond: 1,          // red-team.md: exploit submit bond 1 ZTPHY
  exploitWindow: 3600,           // red-team.md: commit / reveal window 1 h each
  exploitRunnerBps: 1000,        // red-team.md: the runners' cut 10 %
  runnerMinAgreed: 1,            // `zetaphy deploy-redteam`'s default: a runner's agreed NeuroJobs jobs (ExploitMarket, EconomicBounds, ProofRegistry)
  proofWindow: 86400,            // specs-and-proofs.md: commit 1 h..30 d, reveal 1 h..7 d (test/proofs.test.js: 1 day each)
  proofMinFee: 1,                // test/proofs.test.js: 1 ZTPHY per proof
  // Saphan (test/saphanintents.test.js, test/saphanprivacy.test.js)
  intentClaimBond: 1, intentChallengeBond: 0.5, intentChallengeWindow: 600, intentDisputePeriod: 3600, intentGrace: 1800, intentRiskDelay: 900,
  privacyDenomination: 0.01,     // SAPHAN-PR6.md F: one pool per token and amount (e.g. 0.01 sepETH)
  deployerSetters: false,        // SaphanReads, SaphanIntents: a once-only setter stays with the deploy key (see SAPHAN_STEPS)
};

/**
 * Open audit network, SS tier (PR #115; docs/future/invariant-firewall.md, red-team.md, specs-and-proofs.md,
 * immune-score.md): record deployments/ss-77390.json. Wired to the audit network (audit-77390.json), the frontier
 * contracts (CircuitBreaker, HackInsurance, ImmuneRegistry), NeuroJobs, NeuroScore and the ThreatRegistry.
 */
export const SS_STEPS = [
  { key: 'invariantFirewall', contract: 'InvariantFirewall', doc: 'invariant-firewall', needs: ['certificate'],
    args: (x) => [x.certificate, x.gov, x.o.firewallUncertifiedBps],
    note: 'contract layer only: the node-level check (CHAIN-FIREWALL.md) stays off until the zetaphy-firewall upgrade and a governance vote name this address' },
  { key: 'exploitMarket', contract: 'ExploitMarket', doc: 'red-team', needs: ['jobs'],
    args: (x) => [x.jobs, x.gov, parseEther(String(x.o.exploitSubmitBond)), x.o.exploitWindow, x.o.exploitWindow, x.o.exploitRunnerBps, x.o.runnerMinAgreed] },
  { key: 'economicBounds', contract: 'EconomicBounds', doc: 'red-team', needs: ['network', 'certificate', 'jobs'],
    args: (x) => [x.network, x.certificate, x.jobs, x.o.runnerMinAgreed] },
  { key: 'proofRegistry', contract: 'ProofRegistry', doc: 'specs-and-proofs', needs: ['jobs', 'certificate'],
    args: (x) => [x.jobs, ZeroAddress, x.certificate, x.gov,
      { commitWindow: x.o.proofWindow, revealWindow: x.o.proofWindow, minFee: parseEther(String(x.o.proofMinFee)), minAgreed: x.o.runnerMinAgreed }],
    note: 'no WorkerReputation (not deployed: it needs a 2-day timelock), so proof runs are not reported to one' },
  { key: 'immuneVaccines', contract: 'ImmuneVaccines', doc: 'immune-score', needs: ['network', 'certificate', 'insurance', 'threats'],
    args: (x) => [x.network, x.certificate, x.insurance, x.reviewHolds ? x.threats : ZeroAddress, x.gov],
    note: (x) => (x.reviewHolds
      ? 'holds need the timelock to call ThreatRegistry.setVaccines(immuneVaccines); until then an exact or body match reverts (NotVaccines)'
      : 'built without a ThreatRegistry (the launch one has no review holds): matches are recorded and owners notified, nothing is held') },
  { key: 'securityScore', contract: 'SecurityScore', doc: 'immune-score', needs: ['certificate', 'network', 'breaker', 'neuro', 'threats', 'immune', 'reviewHolds'],
    after: ['immuneVaccines'], args: (x) => [x.certificate, x.network, x.breaker, x.neuro, x.r.immuneVaccines, x.threats, x.immune] },
];

export const SS_SKIPPED = [
  { what: 'ScoredCollateral (immune-score.md)', reason: 'an example collateral helper: a lending protocol deploys its own with its tiers (no lending protocol exists yet)' },
  { what: 'Node-level invariant firewall (CHAIN-FIREWALL.md, PR #117)', reason: 'a chain module, not a contract: on after the zetaphy-firewall upgrade and a governance vote (security-proposal invariant-firewall <InvariantFirewall>)' },
];

/**
 * Saphan's ZETAPHY-side contracts (PRs #113, #114, #116; docs/SAPHAN-PR4.md, SAPHAN-PR5.md, SAPHAN-PR6.md): record
 * deployments/saphan-77390.json, built on one deployed route (default Sepolia: zetaphy-chain/hyperlane/saphan-routes.json).
 * A step with `deployerRole` leaves the deploy key a once-only setter by the contract's design (no governance path), so
 * the button deploys it only when asked (--deployer-setters); by default the deploy key keeps no role.
 */
export const SAPHAN_STEPS = [
  { key: 'saphanBundles', contract: 'SaphanBundles', doc: 'SAPHAN-PR5', args: () => [] },
  { key: 'saphanOfflineTransfers', contract: 'SaphanOfflineTransfers', doc: 'SAPHAN-PR6', args: () => [] },
  { key: 'saphanLiquidityBounds', contract: 'SaphanLiquidityBounds', doc: 'SAPHAN-PR6', args: (x) => [x.gov],
    note: "for routes whose vault is on ZETAPHY (ZetaphyTokenVault: tokens born here; none yet): the timelock sets the bounds and the rebalancer. The Sepolia lockbox's one lives on Sepolia" },
  { key: 'saphanPrivacyPool', contract: 'SaphanPrivacyPool', doc: 'SAPHAN-PR6', needs: ['poseidon', 'zkVerifier', 'routeToken'],
    args: (x) => [x.poseidon, x.zkVerifier, x.routeToken, parseEther(String(x.o.privacyDenomination))],
    note: (x) => `token(${x.routeName}) ${x.routeToken}, ${x.o.privacyDenomination} per note; DEV trusted setup (ZkIdentityVerifier): testnet only, protects nothing of value` },
  { key: 'saphanReads', contract: 'SaphanReads', doc: 'SAPHAN-PR5', needs: ['mailbox', 'routeIsm'],
    args: (x) => [x.routeChainId, x.mailbox, x.routeDomain, x.routeIsm, ZeroAddress],
    deployerRole: 'setResponder(SaphanReadResponder on the source chain), once',
    note: (x) => `reads of ${x.routeName} (chain ${x.routeChainId}) answered through the route's ISM; no state-root source: proven reads off` },
  { key: 'saphanIntents', contract: 'SaphanIntents', doc: 'SAPHAN-PR5', needs: ['neuro', 'threats', 'mailbox', 'routeIsm'],
    args: (x) => [x.neuro, x.threats, x.mailbox, x.routeIsm, parseEther(String(x.o.intentClaimBond)), parseEther(String(x.o.intentChallengeBond)),
      x.o.intentChallengeWindow, x.o.intentDisputePeriod, x.o.intentGrace, x.o.intentRiskDelay],
    deployerRole: 'setRelay(domain, SaphanFillRelay), once per chain',
    note: (x) => `fill messages checked by the ${x.routeName} route's ISM (fills on ZETAPHY and on ${x.routeName})` },
  { key: 'saphanSealedOrders', contract: 'SaphanSealedOrders', doc: 'SAPHAN-PR4', after: ['saphanIntents'], args: (x) => [x.r.saphanIntents] },
];

const SOURCE_CHAIN = 'source chain: saphan-route';
export const SAPHAN_SKIPPED = [
  { what: 'SaphanAccountFactory (SAPHAN-PR5.md)', reason: 'the same account address on every chain needs the factory deployed by one fresh key as its first transaction on every chain; the deploy key has used its first nonces' },
  { what: 'SaphanRecoveryClaims (SAPHAN-PR6.md S10)', reason: "one per incident: the timelock deploys it after the snapshot, with that incident's token, sweep target and claim period" },
  { what: 'SaphanBtcWithdrawals (SAPHAN-PR6.md S7)', reason: 'needs a BtcLightClient on ZETAPHY (not deployed: it needs a real Bitcoin checkpoint header and a header relayer)' },
  { what: 'SaphanAggLane (SAPHAN-PR4.md S1)', reason: "needs an ML-DSA-44 committee (key hashes and a threshold); none exists yet. Then the airlock's governance adds it as a lane through the timelock" },
  { what: 'SaphanReadResponder, SaphanZetaphyReads (SAPHAN-PR5.md)', reason: SOURCE_CHAIN },
  { what: 'SaphanFillRelay (SAPHAN-PR5.md)', reason: SOURCE_CHAIN },
  { what: 'SaphanSourceGateway, SaphanAccountFactory on the source chains (SAPHAN-PR5.md)', reason: SOURCE_CHAIN },
  { what: "SaphanLiquidityBounds for the Sepolia lockbox (SAPHAN-PR6.md S9: one per source chain, that chain's timelock)", reason: SOURCE_CHAIN },
  { what: 'SaphanReleaseVerifier (SAPHAN-PROOFS.md)', reason: SOURCE_CHAIN },
];

/** Whether a ThreatRegistry has review holds (PR #115): underReview answers. The launch one predates them. */
export async function hasReviewHolds(provider, threats) {
  if (!ADDR.test(String(threats ?? ''))) return false;
  const iface = new Interface(['function underReview(bytes32) view returns (bool, bytes32, uint64)']);
  try {
    const out = await provider.call({ to: threats, data: iface.encodeFunctionData('underReview', ['0x' + '00'.repeat(32)]) });
    iface.decodeFunctionResult('underReview', out);
    return true;
  } catch { return false; }
}

const FLAGS = new Set(['pqValidators', 'reviewHolds']);
const isSet = (k, v) => (FLAGS.has(k) ? (Array.isArray(v) ? v.length > 0 : v === true) : ADDR.test(String(v ?? '')));

/** The skip reason of a step given the inputs and the record (null = deployable now). */
async function whyNot(step, x, provider) {
  for (const k of step.needs ?? []) {
    if (!isSet(k, x[k])) return `needs ${NEED[k]}`;
    if (!FLAGS.has(k) && (await provider.getCode(x[k])) === '0x') return `needs ${NEED[k]}: no code at ${x[k]}`;
  }
  if (step.deployerRole && !x.o.deployerSetters) {
    return `gives the deploy key ${step.deployerRole} (the contract has no governance path for it); deployed only with --deployer-setters (workflow input deployer_setters)`;
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
 * Runs one plan (`steps`, then `fixedSkips`) against its record: deploys every step the record does not have yet.
 * Every one with a governance role takes `gov` (the ZetaphyTimelock) in its constructor. `save(record)` is called
 * before and after each transaction. `inputs` are the addresses (and flags) the steps' `needs` name.
 * Returns the record { chainId, governance, timelockMinDelay, contracts, blocks, notes, skipped[, deployerRoles] }.
 */
async function deployPlan({ steps, fixedSkips, signer, gov, inputs = {}, record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
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
  const opts = { ...FRONTIER_DEFAULTS, ...SS_DEFAULTS, ...o };
  try { rec.timelockMinDelay = Number(await new Contract(gov, art('ZetaphyTimelock').abi, provider).getMinDelay()); } catch { rec.timelockMinDelay = null; }
  const ctx = { signer, me, provider, rec, save, timeout: opts.txTimeoutMs };
  await settlePending(provider, rec, opts.txTimeoutMs, log);
  save(rec);
  const x = { ...inputs, gov, me, pqValidators: opts.pqValidators, r: rec.contracts, o: opts };
  const noteOf = (s) => (typeof s.note === 'function' ? s.note(x) : s.note);
  const notes = { ...(rec.notes ?? {}) };
  const skipped = [];
  for (const step of steps) {
    if (only && !only.includes(step.key)) continue;
    if (rec.contracts[step.key]) { log(`${step.key}: already at ${rec.contracts[step.key]}`); continue; }
    const why = await whyNot(step, x, provider);
    if (why) { skipped.push({ what: `${step.contract} (${step.key})`, reason: why }); log(`${step.key}: skipped (${why})`); continue; }
    const addr = await deployOne(ctx, step, step.args(x));
    const note = noteOf(step);
    if (note) notes[step.key] = note;
    if (step.deployerRole) { rec.deployerRoles = { ...(rec.deployerRoles ?? {}), [step.key]: `${me}: ${step.deployerRole}` }; save(rec); }
    log(`${step.key}: ${step.contract} ${addr} (block ${rec.blocks[step.key]})${hasGovernance(step.contract) ? ` governance ${gov}` : ', no owner'}`
      + `${step.deployerRole ? ` (the deploy key keeps ${step.deployerRole})` : ''}${note ? ` [${note}]` : ''}`);
  }
  // a static note of a step deployed by an earlier run (a dynamic one is kept from the run that deployed it)
  for (const s of steps) if (rec.contracts[s.key] && typeof s.note === 'string') notes[s.key] ??= s.note;
  rec.notes = Object.fromEntries(steps.filter((s) => notes[s.key] && rec.contracts[s.key]).map((s) => [s.key, notes[s.key]]));
  rec.skipped = [...skipped, ...fixedSkips];
  save(rec);
  return rec;
}

/**
 * Deploys the frontier contracts `record.contracts` does not have yet. Every one with a governance role takes `gov`
 * (the ZetaphyTimelock) in its constructor. `save(record)` is called before and after each transaction.
 * Returns { chainId, governance, timelockMinDelay, contracts, blocks, notes, skipped }.
 */
export async function deployFrontier({ signer, gov, jobs = null, threats = null, mailbox = null, labels = null, vouch = null,
  record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
  return deployPlan({ steps: FRONTIER_STEPS, fixedSkips: FRONTIER_SKIPPED, signer, gov, inputs: { jobs, threats, mailbox, labels, vouch },
    record, o, only, save, log });
}

/**
 * The SS tier (SS_STEPS, record deployments/ss-77390.json). `audit` and `frontier` are those parts' records (their
 * governance must be `gov`); `neuro` is NeuroScore (ai-77390.json). Whether the ThreatRegistry has review holds is
 * read from the chain (hasReviewHolds).
 */
export async function deploySs({ signer, gov, jobs = null, threats = null, neuro = null, audit = null, frontier = null,
  record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
  const same = (r) => r?.governance && ADDR.test(String(gov ?? '')) && getAddress(r.governance) === getAddress(gov);
  const a = same(audit) ? audit.contracts ?? {} : {};
  const f = same(frontier) ? frontier.contracts ?? {} : {};
  const reviewHolds = await hasReviewHolds(signer.provider, threats);
  return deployPlan({ steps: SS_STEPS, fixedSkips: SS_SKIPPED, signer, gov, record, o, only, save, log,
    inputs: { jobs, threats, neuro, reviewHolds, certificate: a.auditCertificate ?? null, network: a.auditNetwork ?? null,
      insurance: f.hackInsurance ?? null, breaker: f.circuitBreaker ?? null, immune: f.immuneRegistry ?? null } });
}

/**
 * Saphan's ZETAPHY-side contracts (SAPHAN_STEPS, record deployments/saphan-77390.json). `route` is one deployed route:
 * { name, chainId, domain, ism, token } (its ISM and token on ZETAPHY); `frontier` gives PoseidonT3 and the
 * ZkIdentityVerifier. The route is written into the record; a record made for another route is refused.
 */
export async function deploySaphan({ signer, gov, threats = null, mailbox = null, neuro = null, route = null, frontier = null,
  record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
  const f = frontier?.governance && ADDR.test(String(gov ?? '')) && getAddress(frontier.governance) === getAddress(gov) ? frontier.contracts ?? {} : {};
  const r = route ?? {};
  if (record?.route && r.name && record.route !== r.name) throw new Error(`the Saphan record is for the route ${record.route}, not ${r.name}`);
  const keep = (rec) => { if (r.name) rec.route ??= r.name; save(rec); };
  return deployPlan({ steps: SAPHAN_STEPS, fixedSkips: SAPHAN_SKIPPED, signer, gov, record, o, only, save: keep, log,
    inputs: { threats, mailbox, neuro, poseidon: f.poseidonT3 ?? null, zkVerifier: f.zkIdentityVerifier ?? null,
      routeName: r.name ?? '(none)', routeChainId: r.chainId ?? null, routeDomain: r.domain ?? null, routeIsm: r.ism ?? null, routeToken: r.token ?? null } });
}

/**
 * The whole button, in order, one transaction at a time: the frontier contracts, then the open audit network
 * (src/auditnetops.js, its own record), then offline trading (src/offlinedeploy.js, its own record). A part whose
 * record is complete is skipped; an unfinished audit network resumes at the nonces it planned (kept in the frontier
 * record as `auditPlan`). Then the SS tier (deploySs) and Saphan's ZETAPHY side (deploySaphan), each in its own record.
 * Returns { frontier, audit, offline, ss, saphan, skipped: [{ what, reason }] }.
 *
 * @param p.records   { frontier, audit, offline, ss, saphan }: the records so far (or null each)
 * @param p.saves     { frontier(rec), audit(rec), offline(rec), ss(rec), saphan(rec) }: write each record
 * @param p.treasury  the audit network's treasury (default: the RewardVault)
 * @param p.router    the ZETAPHY Swap router (offline orders)
 * @param p.neuro     NeuroScore (ai-77390.json): SecurityScore, SaphanIntents
 * @param p.route     a deployed Saphan route { name, chainId, domain, ism, token } (its ISM and token on ZETAPHY)
 */
export async function deployEverything({ signer, gov, jobs = null, threats = null, mailbox = null, labels = null, vouch = null, treasury = null, router = null,
  neuro = null, route = null, records = {}, saves = {}, o = {}, parts = ['frontier', 'audit', 'offline', 'ss', 'saphan'], log = () => {} }) {
  const save = { frontier: () => {}, audit: () => {}, offline: () => {}, ss: () => {}, saphan: () => {}, ...saves };
  const provider = signer.provider;
  const out = { frontier: records.frontier ?? null, audit: records.audit ?? null, offline: records.offline ?? null,
    ss: records.ss ?? null, saphan: records.saphan ?? null, skipped: [] };
  const frontier = (only) => deployFrontier({ signer, gov, jobs, threats, mailbox, labels, vouch, record: out.frontier, o, only, save: save.frontier, log });
  const ss = async (only) => { out.ss = await deploySs({ signer, gov, jobs, threats, neuro, audit: out.audit, frontier: out.frontier, record: out.ss, o, only,
    save: save.ss, log: (l) => log(`ss: ${l}`) }); };
  const saphan = async (only) => { out.saphan = await deploySaphan({ signer, gov, threats, mailbox, neuro, route, frontier: out.frontier, record: out.saphan, o, only,
    save: save.saphan, log: (l) => log(`saphan: ${l}`) }); };
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
  // every record's transaction in flight is settled before any new one is sent: a dropped one's nonce (and so its
  // address) is reused by the next deploy, which must not be taken for the dropped contract
  if (out.ss?.pending) await ss([]);
  if (out.saphan?.pending) await saphan([]);
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
  // the SS tier needs the audit network's and the frontier's records; Saphan needs the frontier's (PoseidonT3, the verifier)
  if (parts.includes('ss')) await ss(null);
  if (parts.includes('saphan')) await saphan(null);
  out.skipped.push(...out.frontier.skipped, ...(out.ss?.skipped ?? []), ...(out.saphan?.skipped ?? []));
  return out;
}

/**
 * Reads everything back: code at every address, and every governance() equal to the frontier record's governance
 * (the timelock). Returns [{ part, key, address, governance, ok }]; the check fails if any is not ok.
 */
export async function checkEverything(provider, { frontier = null, audit = null, offline = null, ss = null, saphan = null } = {}) {
  const out = [];
  const gov = frontier?.governance ? getAddress(frontier.governance) : null;
  const one = async (part, key, contract, address) => {
    const code = ADDR.test(String(address ?? '')) ? await provider.getCode(address) : '0x';
    let governance = null;
    let ok = code !== '0x';
    if (ok && hasGovernance(contract)) {
      governance = getAddress(await new Contract(address, art(contract).abi, provider).governance());
      const own = { audit, ss, saphan }[part];
      ok = governance === (own ? getAddress(own.governance) : gov) && (!gov || governance === gov);
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
  for (const [part, rec, steps] of [['ss', ss, SS_STEPS], ['saphan', saphan, SAPHAN_STEPS]]) {
    if (rec) for (const s of steps) if (rec.contracts?.[s.key]) await one(part, s.key, s.contract, rec.contracts[s.key]);
  }
  for (const [part, rec] of [['frontier', frontier], ['ss', ss], ['saphan', saphan]]) {
    if (rec?.pending) out.push({ part, key: rec.pending.key, address: rec.pending.address, governance: null, ok: false });
  }
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
