// Deploying the open audit network (docs/future/audit-network.md): AuditNetwork, AuditRunners, AuditJudges and
// AuditCertificate, in that order from one key. AuditNetwork's constructor takes the three others' addresses
// computed from the deployer's next nonces, so nothing has to be bound later and no key keeps a role:
// governance is the timelock from the first block. TESTNET ONLY.
import { readFileSync } from 'node:fs';
import { ContractFactory, Interface, getCreateAddress, parseEther, ZeroAddress } from 'ethers';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const DAY = 86400;

export const NETWORK_PARAMS = Object.freeze({
  minContest: 7 * DAY, maxContest: 60 * DAY, revealWindow: 3 * DAY, judgeWindow: 7 * DAY, appealWindow: 5 * DAY, appealTimeout: 14 * DAY,
  unbondDelay: 7 * DAY, minAuditorsFloor: 3, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000, maxFindingsPerAuditor: 20,
  auditorBond: parseEther('10'), minPool: parseEther('10'),
});
export const JUDGE_PARAMS = Object.freeze({ judgeQuorum: 3, maxJudges: 21, judgeMinScore: 500, unbondDelay: 14 * DAY, judgeBond: parseEther('100'), appealBond: parseEther('10') });
export const LEVELS = Object.freeze({ validity: 180 * DAY, silverAuditors: 5, goldAuditors: 8, silverContest: 14 * DAY, goldContest: 21 * DAY, silverMutationBps: 7000, goldMutationBps: 8500 });

/**
 * @param {object} p
 * @param {import('ethers').Signer} p.signer   the deployer (keeps no role)
 * @param {string} p.governance                the ZetaphyTimelock
 * @param {string} p.treasury                  where post-certificate slashes and lost appeal bonds go
 * @param {string} p.jobs                      NeuroJobs (runner eligibility)
 * @param {string} [p.reputation]              WorkerReputation (then add AuditNetwork and AuditRunners as reporters, via the timelock)
 * @param {number} [p.startNonce]              resume: the nonce an earlier, unfinished run started from (its `plan.nonce`). The four
 *                                             addresses follow from it; those with code are kept, the rest are deployed at their nonces
 * @param {Function} [p.onPlan]                called with { nonce, contracts } before the first transaction (save it to resume)
 */
export async function deployAuditNetwork({ signer, governance, treasury, jobs, reputation = ZeroAddress, minAgreed = 1,
  params = {}, judgeParams = {}, levels = {}, startNonce = null, onPlan = () => {}, log = () => {} }) {
  if (!governance || !treasury || !jobs) throw new Error('deployAuditNetwork: governance, treasury and jobs are required');
  const me = await signer.getAddress();
  const nonce = startNonce ?? await signer.provider.getTransactionCount(me, 'pending');
  const at = (i) => getCreateAddress({ from: me, nonce: nonce + i });
  const [netA, runA, judA, certA] = [0, 1, 2, 3].map(at);
  await onPlan({ nonce, contracts: { auditNetwork: netA, auditRunners: runA, auditJudges: judA, auditCertificate: certA } });
  const deploy = async (name, args, i) => {
    if (startNonce !== null && (await signer.provider.getCode(at(i))) !== '0x') { log(`${name} ${at(i)} (already)`); return at(i); }
    const next = await signer.provider.getTransactionCount(me, 'pending');
    if (next !== nonce + i) throw new Error(`${name} must be deployed with nonce ${nonce + i} (to land at ${at(i)}), but the key's next nonce is ${next}: `
      + (next < nonce + i ? 'an earlier transaction of this run was dropped' : 'it is still pending (re-run once it is mined) or another transaction used it (then the audit network cannot be finished at these addresses)'));
    const a = art(name);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args, { nonce: nonce + i });
    await c.waitForDeployment();
    const got = await c.getAddress();
    if (got.toLowerCase() !== at(i).toLowerCase()) throw new Error(`${name} landed at ${got}, not ${at(i)}: deploy again from a key with no pending transactions`);
    log(`${name} ${got}`);
    return got;
  };
  await deploy('AuditNetwork', [governance, treasury, reputation, runA, judA, certA, { ...NETWORK_PARAMS, ...params }], 0);
  await deploy('AuditRunners', [netA, jobs, reputation, minAgreed], 1);
  await deploy('AuditJudges', [netA, reputation, governance, { ...JUDGE_PARAMS, ...judgeParams }], 2);
  await deploy('AuditCertificate', [netA, runA, judA, governance, { ...LEVELS, ...levels }], 3);
  const proposals = reputation === ZeroAddress ? [] : [netA, runA].map((r) => ({
    what: `WorkerReputation.setReporter(${r}, true)`, target: reputation,
    data: new Interface(art('WorkerReputation').abi).encodeFunctionData('setReporter', [r, true]),
  }));
  return { chainId: Number((await signer.provider.getNetwork()).chainId), contracts: { auditNetwork: netA, auditRunners: runA, auditJudges: judA, auditCertificate: certA }, governance, treasury, proposals };
}
