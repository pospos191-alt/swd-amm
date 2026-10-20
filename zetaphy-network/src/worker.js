// Node runner loop for the NeuroJobs market.
//   1. find open jobs with a free seat
//   2. run Neuro on this machine, compute the verdict
//   3. commit keccak256(verdict, me, salt); reveal once seats are full or
//      the commit window closes
// The salt and verdict are saved to disk BEFORE the commit is sent, so a
// crash or restart can always reveal (a commit that is never revealed costs
// part of the bond).
// Governance (NeuroControl): a runner only takes jobs whose recorded skill is
// its own skill id (src/skill.js: the Neuro code it runs), and takes no new
// jobs while Neuro is paused; seats it already holds are still revealed.
// Jobs requested before NeuroJobs had a NeuroControl carry skill 0, so they
// are skipped too (they expire and refund).
// After a quorum, a seat not yet revealed may still reveal until the job's
// settleAt (jobInfo); once that has passed, a runner that sat on the job calls
// settle(id), which penalizes the seats that never revealed.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { AbiCoder, keccak256, hexlify, randomBytes, decodeBytes32String } from 'ethers';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

export const OPEN = 1n;
export const DONE = 2n;
/** Chain keys this runner can read: what `zetaphy deploy` votes into NeuroControl's allowlist. */
export const SUPPORTED_CHAINS = ['zetaphy', ...Object.keys(CHAINS)];

export const commitmentOf = (verdict, worker, salt) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [verdict, worker, salt]));

export function loadState(file) {
  if (!existsSync(file)) return { cursor: 0, seats: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveState(file, state) {
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file); // atomic: never a half-written state file
}

/**
 * @param {object} p
 * @param {import('ethers').Contract} p.jobs     NeuroJobs bound to the runner's wallet
 * @param {string} p.me                          runner address
 * @param {string} p.stateFile
 * @param {object} p.zetaphyChain                {kind:'evm', id, name, rpcs} for chain key "zetaphy"
 * @param {(chainKey: string, target: string, opts: object) => Promise<object>} [p.read]  Neuro reader (tests inject)
 * @param {() => Promise<bigint>} p.chainTime    latest block timestamp
 * @param {(line: string) => void} [p.log]
 * @param {string|null} [p.skill]                this runner's skill id (bytes32 hex); null = take any job
 * @param {() => Promise<boolean>} [p.paused]    NeuroControl.paused(); omitted = never paused
 */
export function createWorker({ jobs, me, stateFile, zetaphyChain, read = readContract, chainTime, log = () => {}, skill = null, paused = null }) {
  const state = loadState(stateFile);
  let commitWindow = null;
  const foreign = new Set(); // jobs of another skill: never ours
  let wasPaused = false;

  function readerFor(chainKey) {
    // sourcify:false: a verdict must depend only on the chain, not on whether
    // a third party has the source yet, or two runners could disagree.
    if (chainKey === 'zetaphy') return zetaphyChain ? { chainConfig: zetaphyChain, sourcify: false } : null;
    return CHAINS[chainKey] ? { sourcify: false } : null;
  }

  async function tryCommit(id, job, now) {
    let chainKey;
    try { chainKey = decodeBytes32String(job.chain); } catch { return 'skip: bad chain name'; }
    const opts = readerFor(chainKey);
    if (!opts) return `skip: chain ${chainKey} not supported here`;
    const report = await read(chainKey, job.target, opts);
    const verdict = await verdictOf(report);
    const salt = hexlify(randomBytes(32));
    state.seats[id] = { verdict, salt, revealed: false };
    saveState(stateFile, state); // before the transaction, see top of file
    try {
      await (await jobs.commit(id, commitmentOf(verdict, me, salt))).wait();
    } catch (e) {
      delete state.seats[id]; // seat not taken: nothing to reveal
      saveState(stateFile, state);
      throw e;
    }
    return `committed (level ${report.analysis?.level}, ${now - job.created}s after request)`;
  }

  /** jobInfo().settleAt: end of the reveal grace after a quorum, 0n when nothing is pending. */
  async function settleAtOf(id) {
    if (!jobs.jobInfo) return 0n;
    return BigInt((await jobs.jobInfo(id)).settleAt ?? 0n);
  }

  async function sendReveal(id, seat, late) {
    try {
      await (await jobs.reveal(id, seat.verdict, seat.salt)).wait();
      seat.revealed = true;
      saveState(stateFile, state);
      return `job ${id}: revealed${late ? ' (after the quorum, inside the grace)' : ''}`;
    } catch (e) {
      // Usually the job closed between our read and the reveal (a quorum
      // formed): the next tick reveals inside the grace, or forgets the seat.
      return `job ${id}: reveal not sent (${e.shortMessage ?? e.message})`;
    }
  }

  async function tick() {
    commitWindow ??= BigInt(await jobs.commitWindow());
    const now = await chainTime();
    const count = Number(await jobs.jobCount());
    const ids = new Set(Object.keys(state.seats).map(Number));
    for (let id = state.cursor; id < count; id++) ids.add(id);
    const done = [];
    const stopped = paused ? await paused() : false;
    if (stopped !== wasPaused) done.push(stopped ? 'Neuro is paused by governance: no new jobs (seats already taken are still revealed)' : 'Neuro is running again');
    wasPaused = stopped;

    for (const id of [...ids].sort((a, b) => a - b)) {
      const job = await jobs.getJob(id);
      const seat = state.seats[id];
      const windowOver = now >= job.created + commitWindow;
      if (job.status !== OPEN) {
        const settleAt = seat && job.status === DONE ? await settleAtOf(id) : 0n;
        if (settleAt !== 0n && now < settleAt && !seat.revealed) { done.push(await sendReveal(id, seat, true)); continue; }
        if (settleAt !== 0n && now < settleAt) continue; // grace still running: settle afterwards
        if (settleAt !== 0n && seat.revealed) {
          try {
            await (await jobs.settle(id)).wait();
            done.push(`job ${id}: settled (seats that never revealed are penalized)`);
          } catch (e) { done.push(`job ${id}: settle not sent (${e.shortMessage ?? e.message})`); }
        }
        if (seat) done.push(`job ${id}: closed`);
        delete state.seats[id];
        continue;
      }

      if (!seat) {
        if (job.commits >= 3n || windowOver || stopped || foreign.has(id)) continue;
        if (skill) {
          const info = await jobs.jobInfo(id);
          if (String(info.skill).toLowerCase() !== skill.toLowerCase()) {
            foreign.add(id);
            done.push(`job ${id}: skip: skill ${info.skill} is not this runner's (${skill})`);
            continue;
          }
        }
        // Seats go by a bond-weighted lottery; the pool of eligible runners
        // widens during the window, so check again on later ticks.
        if (!(await jobs.eligible(id, me))) continue;
        try {
          done.push(`job ${id}: ${await tryCommit(id, job, now)}`);
        } catch (e) {
          // Another runner took the last seat first, or the target chain is down: retry next tick.
          done.push(`job ${id}: not committed (${e.shortMessage ?? e.message})`);
          continue;
        }
      } else if (!seat.revealed && (job.commits >= 3n || windowOver)) {
        done.push(await sendReveal(id, seat, false));
      }
    }
    // Everything below `count` has been looked at; jobs still worth retrying
    // stay reachable because the cursor only moves past jobs that are full,
    // closed or ours.
    let cursor = state.cursor;
    while (cursor < count) {
      const j = await jobs.getJob(cursor);
      const full = j.status !== OPEN || j.commits >= 3n || now >= j.created + commitWindow || state.seats[cursor] || foreign.has(cursor);
      if (!full) break;
      cursor++;
    }
    state.cursor = cursor;
    saveState(stateFile, state);
    for (const line of done) log(line);
    return done;
  }

  return { tick, state };
}
