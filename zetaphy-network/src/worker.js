// Node runner loop for the NeuroJobs market.
//   1. find open jobs with a free seat
//   2. run Neuro on this machine, compute the verdict
//   3. commit keccak256(verdict, me, salt); reveal once seats are full or
//      the commit window closes
// The salt and verdict are saved to disk BEFORE the commit is sent, so a
// crash or restart can always reveal (a commit that is never revealed costs
// part of the bond).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { AbiCoder, keccak256, hexlify, randomBytes, decodeBytes32String } from 'ethers';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

export const OPEN = 1n;

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
 */
export function createWorker({ jobs, me, stateFile, zetaphyChain, read = readContract, chainTime, log = () => {} }) {
  const state = loadState(stateFile);
  let commitWindow = null;

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

  async function tick() {
    commitWindow ??= BigInt(await jobs.commitWindow());
    const now = await chainTime();
    const count = Number(await jobs.jobCount());
    const ids = new Set(Object.keys(state.seats).map(Number));
    for (let id = state.cursor; id < count; id++) ids.add(id);
    const done = [];

    for (const id of [...ids].sort((a, b) => a - b)) {
      const job = await jobs.getJob(id);
      const seat = state.seats[id];
      const windowOver = now >= job.created + commitWindow;
      if (job.status !== OPEN) { if (seat) done.push(`job ${id}: closed`); delete state.seats[id]; continue; }

      if (!seat) {
        if (job.commits >= 3n || windowOver) continue;
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
        try {
          await (await jobs.reveal(id, seat.verdict, seat.salt)).wait();
          seat.revealed = true;
          saveState(stateFile, state);
          done.push(`job ${id}: revealed`);
        } catch (e) {
          // Usually the job closed between our read and the reveal (a quorum
          // formed). The next tick sees it closed and forgets the seat.
          done.push(`job ${id}: reveal not sent (${e.shortMessage ?? e.message})`);
        }
      }
    }
    // Everything below `count` has been looked at; jobs still worth retrying
    // stay reachable because the cursor only moves past jobs that are full,
    // closed or ours.
    let cursor = state.cursor;
    while (cursor < count) {
      const j = await jobs.getJob(cursor);
      const full = j.status !== OPEN || j.commits >= 3n || now >= j.created + commitWindow || state.seats[cursor];
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
