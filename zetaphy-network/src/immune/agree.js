// k-of-n agreement before anything is flagged (docs/future/immune-network.md, "Trust model").
//
//   sentinel: report (finding + evidence bundle, sentinel.js toReport) -> NeuroJobs.request("immune", jobTarget(report))
//   runners:  the job's 3 seats (lottery over the n bonded runners, NeuroControl) each fetch the bundle by its
//             content hash, check the hash, RE-RUN the detector on the bundle's inputs (detectors.js reverify) and
//             commit-reveal findingHash(finding) when it reproduces, or rejectHash(evidenceHash) when it does not
//   registry: ImmuneRegistry.attest(jobId, finding) only if >= minAgreed runners revealed findingHash(finding)
//   appeal:   anyone opens a NeuroJobs challenge (bond >= 2x fee) claiming rejectHash; a fresh round of runners
//             re-runs it; if it overturns, the round-1 runners lose 50% of their bond (CHALLENGE_SLASH_BPS) and
//             ImmuneRegistry.lift(key) clears the flag on every mirror. A flag that stands may still be cleared later
//             by an "immune-clear" job (clearHash(key, round)), e.g. when an exploited protocol recovered its funds.
import { AbiCoder, keccak256, toUtf8Bytes, encodeBytes32String } from 'ethers';
import { verifyBundle } from './evidence.js';
import { reverify } from './detectors.js';
import { vaccineIntact } from './vaccines.js';

const abi = AbiCoder.defaultAbiCoder();
export const CHAIN_FLAG = 'immune';
export const CHAIN_CLEAR = 'immune-clear';
const ZERO32 = '0x' + '00'.repeat(32);
export const FINDING_TYPE = 'tuple(uint64 chainId, bytes32 subject, bytes32 codeHash, uint8 kind, uint8 severity, bool everyChain, uint32 ttl, bytes32 evidenceHash, bytes32 vaccine)';

/** The ImmuneFinding struct as a tuple (ethers order). */
export const findingTuple = (f) => [BigInt(f.chainId), f.subject, f.codeHash ?? ZERO32, Number(f.kind), Number(f.severity), !!f.everyChain, Number(f.ttl), f.evidenceHash, f.vaccine ?? ZERO32];

/** = ImmuneRegistry.findingHash(f): the verdict the runners commit to. */
export const findingHash = (f) => keccak256(abi.encode(['string', FINDING_TYPE], ['zetaphy.immune.finding.v1', findingTuple(f)]));
/** = ImmuneRegistry.clearHash(key, round): the verdict of an appeal ("immune-clear") job. */
export const clearHash = (key, round) => keccak256(abi.encode(['string', 'bytes32', 'uint32'], ['zetaphy.immune.clear.v1', key, round]));
/** What a runner reveals when the evidence does NOT reproduce the finding (never equal to a findingHash). */
export const rejectHash = (evidenceHash) => keccak256(abi.encode(['string', 'bytes32'], ['zetaphy.immune.reject.v1', evidenceHash]));
/** NeuroJobs commitment: keccak256(abi.encode(verdict, worker, salt)). */
export const commitment = (verdict, worker, salt) => keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [verdict, worker, salt]));
/** NeuroJobs' bytes32 chain of a job ("immune", "immune-clear"). */
export const chainTag = (s) => encodeBytes32String(s);

// ---------------------------------------------------------------- keys (ThreatRegistry's / ImmuneRegistry's derivations)

export const codeKey = (codeHash) => keccak256(abi.encode(['string', 'bytes32'], ['zetaphy.threat.code', codeHash]));
export const addressKey = (chainId, address) => keccak256(abi.encode(['string', 'uint256', 'address'], ['zetaphy.threat.address', BigInt(chainId), address]));
export function accountKey(chainId, account32) {
  if (BigInt(account32) >> 160n === 0n) return addressKey(chainId, '0x' + account32.slice(-40));
  return keccak256(abi.encode(['string', 'uint256', 'bytes32'], ['zetaphy.threat.account', BigInt(chainId), account32]));
}
/** Every key attest() sets for a finding (the order attest uses). */
export function keysOf(f) {
  const out = [accountKey(f.chainId, f.subject)];
  if (f.everyChain) out.push(addressKey(0, '0x' + f.subject.slice(-40)));
  const empty = keccak256('0x');
  if (f.codeHash && f.codeHash !== ZERO32 && f.codeHash !== empty) out.push(codeKey(f.codeHash));
  return out;
}

/**
 * The NeuroJobs target string of a report (<= 330 chars): where a runner fetches the bundle and what it claims.
 * immune:<chainId>:<cid of the evidence bundle>:<findingHash>
 */
export const jobTarget = (report) => `immune:${report.finding.chainId}:${report.cid}:${findingHash(report.finding)}`;
export function parseTarget(t) {
  const m = /^immune:(\d{1,12}):(b[a-z2-7]{58,60}):(0x[0-9a-f]{64})$/.exec(String(t));
  return m ? { chainId: Number(m[1]), cid: m[2], findingHash: m[3] } : null;
}

/**
 * A runner's vote on a report it fetched: { verdict, ok, reason }. It never trusts the sentinel:
 *   1. the bundle must hash to finding.evidenceHash (content addressing)
 *   2. a vaccine shipped with it must be intact and be the finding's `vaccine`
 *   3. the bundle's detector, re-run on the bundle's own inputs, must reproduce the finding (detectors.js reverify)
 * `vaccines`: the runner's VaccineSet (clone findings reference a vaccine by id, from the feed).
 */
export function runnerVote(report, { vaccines = null } = {}) {
  const f = report?.finding;
  const no = (reason) => ({ verdict: rejectHash(f?.evidenceHash ?? ZERO32), ok: false, reason });
  if (!f || !report.bundle) return no('no finding or bundle');
  if (!verifyBundle(report.bundle, f.evidenceHash)) return no('the bundle does not hash to evidenceHash');
  if (report.bundle.vaccine && (!vaccineIntact(report.bundle.vaccine) || report.bundle.vaccine.id !== f.vaccine)) return no('the shipped vaccine is not intact or not the finding\'s');
  if (Number(f.ttl) < 86400 || Number(f.ttl) > 180 * 86400) return no('ttl out of range');
  const r = reverify(report.bundle, { ...f, codeHash: f.codeHash ?? ZERO32 }, { vaccines });
  return r.ok ? { verdict: findingHash(f), ok: true, reason: null } : no(r.reason);
}

/**
 * Off-chain tally with NeuroJobs' rules (3 seats, the first verdict revealed by `quorum` seats wins), for the
 * simulation and for a runner's dry-run: votes [{ runner, verdict }] in reveal order -> { result, agreedBy, at }.
 */
export function tally(votes, { quorum = 2 } = {}) {
  const seen = new Map();
  for (const [i, v] of votes.slice(0, 3).entries()) {
    const n = (seen.get(v.verdict) ?? 0) + 1;
    seen.set(v.verdict, n);
    if (n >= quorum) {
      const agreedBy = votes.slice(0, 3).filter((x) => x.verdict === v.verdict).length;
      return { result: v.verdict, agreedBy, at: i };
    }
  }
  return { result: null, agreedBy: 0, at: -1 };
}

/**
 * What a false flag costs (NeuroJobs constants): each round-1 runner that revealed the overturned verdict loses
 * CHALLENGE_SLASH_BPS (50%) of its bond, half of that goes to the challenger, the rest to the challenge round's
 * honest seats. Bonds as bigint wei.
 */
export function falseFlagCost({ bonds, slashBps = 5000n }) {
  const slashed = bonds.map((b) => (BigInt(b) * slashBps) / 10_000n);
  const total = slashed.reduce((a, b) => a + b, 0n);
  return { perRunner: slashed, total, toChallenger: total / 2n, toRound: total - total / 2n };
}

export { keccak256, toUtf8Bytes };
