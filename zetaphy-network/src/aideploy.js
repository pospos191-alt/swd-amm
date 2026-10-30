// The AI-map contracts that had no deploy step (docs/future/*.md; the hub's AI map, zetaphy-hub/flow.js):
// one run deploys every one still missing, in order, and hands each to governance (the ZetaphyTimelock). The
// deploy key keeps no role: contracts take the timelock in the constructor, except two that are deployed with the
// key as governance only long enough to wire them, then handed over: ForesightRegistry (accepts RiskForecasts as a
// resolver) and AgentRegistry (approves the ConstitutionChecker, AR-2: only governance-approved checkers).
// A run that stops half way resumes: the record keeps what is already deployed and those are skipped.
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, getAddress, parseEther, sha256, toUtf8Bytes } from 'ethers';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86400;

/** Defaults: the agent bond and claim deposit (testnet ZETAPHY), the passkey label's life, the model epoch. */
export const AI_DEFAULTS = {
  agentBond: 10, claimDeposit: 1, humanTtlDays: 400, hubHost: 'app.sawasdeecoin.com',
  epochLength: 14_400, epochMinDelay: 14_400, // one day at 6 s blocks (docs/future/federated.md)
};

/**
 * Every step: the record key(s) it writes, the AI-map items it serves, and how it deploys. `needs` are record
 * keys or inputs it reads. Order matters: later steps read earlier addresses.
 */
export const AI_STEPS = [
  { key: 'modelRegistry', items: [1, 2], contract: 'ModelRegistry', args: (x) => [x.gov] },
  { key: 'neuroScore', items: [3], contract: 'NeuroScore', args: (x) => [x.gov] },
  { key: 'modelEpochs', items: [35], contract: 'ModelEpochs', args: (x) => [x.gov, BigInt(x.o.epochLength), BigInt(x.o.epochMinDelay)] },
  { key: 'signalBoard', items: [2, 7], contract: 'SignalBoard', args: () => [] },
  { key: 'webauthn', items: [9, 25], contract: 'WebAuthnVerifier', args: () => [] },
  { key: 'cosignCommittee', items: [9, 14], contract: 'CosignCommittee', args: (x) => [x.gov, x.o.committee?.length ? x.o.committee : [x.gov], BigInt(x.o.committee?.length ? (x.o.threshold ?? 1) : 1)] },
  { key: 'constitutionChecker', items: [23], contract: 'ConstitutionChecker', args: () => [] },
  { key: 'agentRegistry', items: [23], contract: 'AgentRegistry', args: (x) => [x.me, parseEther(String(x.o.agentBond)), parseEther(String(x.o.claimDeposit))] },
  { key: 'labelRegistry', items: [25], contract: 'LabelRegistry', args: (x) => [x.gov, x.r.agentRegistry, x.r.webauthn, sha256(toUtf8Bytes(x.o.hubHost)), BigInt(x.o.humanTtlDays * DAY)] },
  { key: 'vouchRegistry', items: [25], contract: 'VouchRegistry', args: (x) => [x.r.labelRegistry, x.gov] },
  { key: 'intentExecutor', items: [24], contract: 'IntentExecutor', args: () => [] },
  { key: 'foresight', items: [29], contract: 'ForesightRegistry', args: (x) => [x.me] },
  { key: 'riskForecasts', items: [15], contract: 'RiskForecasts', args: (x) => [x.gov, x.threats, x.r.foresight], needs: ['threats'] },
  { key: 'detectorPool', items: [26], contract: 'DetectorPool', args: (x) => [x.gov, x.r.foresight] },
  { key: 'dataDao', items: [16], contract: 'DataDAO', args: (x) => [x.gov, x.o.poster ?? x.gov] },
  { key: 'arena', items: [27], contract: 'RedBlueArena', args: (x) => [x.gov] },
  { key: 'neuroAttest', items: [19], contract: 'NeuroAttest', args: (x) => [x.jobs, x.gov], needs: ['jobs'] },
  { key: 'neuroAnchor', items: [30], contract: 'NeuroAnchor', args: () => [] },
];

/** The keys the launch state gives this run: the timelock (governance), NeuroJobs and the ThreatRegistry. */
export function fromLaunchState(state) {
  const out = {};
  for (const st of Object.values(state?.steps ?? {})) Object.assign(out, st.out ?? {});
  const pick = (k) => (ADDR.test(String(out[k] ?? '')) ? getAddress(out[k]) : null);
  return { gov: pick('timelock'), jobs: pick('neuroJobs'), threats: pick('threatRegistry') };
}

/**
 * Deploys what `record.contracts` does not have yet. `save(record)` is called after each contract, so a stop
 * half way loses nothing. Returns the record: { chainId, governance, contracts: {key: address}, blocks: {key: n} }.
 */
export async function deployAi({ signer, gov, jobs = null, threats = null, record = null, o = {}, only = null, save = () => {}, log = () => {} }) {
  if (!ADDR.test(String(gov ?? ''))) throw new Error('governance: the ZetaphyTimelock address (the launch state has none)');
  gov = getAddress(gov);
  const me = getAddress(await signer.getAddress());
  if (gov === me) throw new Error('governance must be the timelock, not the deploy key');
  const chainId = Number((await signer.provider.getNetwork()).chainId);
  const rec = record ?? { chainId, governance: gov, contracts: {}, blocks: {} };
  if (rec.chainId !== chainId) throw new Error(`the record is for chain ${rec.chainId}, the node is ${chainId}`);
  if (getAddress(rec.governance) !== gov) throw new Error(`the record's governance is ${rec.governance}, not ${gov}`);
  rec.contracts ??= {}; rec.blocks ??= {};
  const x = { gov, me, jobs, threats, r: rec.contracts, o: { ...AI_DEFAULTS, ...o } };
  for (const step of AI_STEPS) {
    if (only && !only.includes(step.key)) continue;
    if (rec.contracts[step.key]) { log(`${step.key}: already at ${rec.contracts[step.key]}`); continue; }
    const missing = (step.needs ?? []).filter((k) => !ADDR.test(String(x[k] ?? '')));
    if (missing.length) { log(`${step.key}: skipped (needs ${missing.join(', ')} from the launch state)`); continue; }
    const a = art(step.contract);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...step.args(x));
    const rc = await c.deploymentTransaction().wait();
    const addr = getAddress(await c.getAddress());
    rec.contracts[step.key] = addr;
    rec.blocks[step.key] = rc.blockNumber;
    log(`${step.key}: ${step.contract} ${addr} (block ${rc.blockNumber})`);
    if (step.key === 'riskForecasts') await wireForesight(signer, rec, gov, log);
    save(rec);
    if (step.key === 'agentRegistry') { await wireAgentRegistry(signer, rec, gov, log); save(rec); }
  }
  // A run that stopped between deploying AgentRegistry and handing it over finishes the job here
  if (rec.contracts.agentRegistry) await wireAgentRegistry(signer, rec, gov, log);
  // Foresight with no RiskForecasts this run (no ThreatRegistry): still hand it over, governance can add the resolver
  if (rec.contracts.foresight) await handOverForesight(signer, rec, gov, log);
  save(rec);
  return rec;
}

async function wireForesight(signer, rec, gov, log) {
  const fs = new Contract(rec.contracts.foresight, art('ForesightRegistry').abi, signer);
  if ((await fs.governance()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) return;
  await (await fs.setResolver(rec.contracts.riskForecasts, true)).wait();
  log('foresight: RiskForecasts accepted as a resolver');
}

/** Approves the ConstitutionChecker (when deployed) while the key is governance, then hands AgentRegistry over. */
async function wireAgentRegistry(signer, rec, gov, log) {
  const reg = new Contract(rec.contracts.agentRegistry, art('AgentRegistry').abi, signer);
  const g = getAddress(await reg.governance());
  if (g === gov) return;
  if (g !== getAddress(await signer.getAddress())) throw new Error(`AgentRegistry governance is ${g}: neither the key nor the timelock`);
  const chk = rec.contracts.constitutionChecker;
  if (chk && !(await reg.approvedChecker(chk))) {
    await (await reg.setChecker(chk, true)).wait();
    log(`agentRegistry: ConstitutionChecker ${chk} approved`);
  }
  await (await reg.setGovernance(gov)).wait();
  log(`agentRegistry: governance handed to ${gov}`);
}

async function handOverForesight(signer, rec, gov, log) {
  const fs = new Contract(rec.contracts.foresight, art('ForesightRegistry').abi, signer);
  const g = getAddress(await fs.governance());
  if (g === gov) return;
  if (g !== getAddress(await signer.getAddress())) throw new Error(`ForesightRegistry governance is ${g}: neither the key nor the timelock`);
  await (await fs.setGovernance(gov)).wait();
  log(`foresight: governance handed to ${gov}`);
}

/** Reads every deployed contract's governance back: [{ key, governance, ok }] (contracts with no governance are left out). */
export async function checkGovernance(provider, rec) {
  const out = [];
  for (const step of AI_STEPS) {
    const a = rec.contracts?.[step.key];
    if (!a) continue;
    const abi = art(step.contract).abi;
    if (!abi.some((f) => f.type === 'function' && f.name === 'governance' && f.inputs.length === 0)) continue;
    const g = getAddress(await new Contract(a, abi, provider).governance());
    out.push({ key: step.key, governance: g, ok: g === getAddress(rec.governance) });
  }
  return out;
}
