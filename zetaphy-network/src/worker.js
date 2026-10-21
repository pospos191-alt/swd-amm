// Node runner loop for the NeuroJobs market.
//   1. find open jobs with a free seat
//   2. run Neuro on this machine, compute the verdict
//   3. commit keccak256(verdict, me, salt); reveal once seats are full or
//      the commit window closes
// The salt and verdict are saved to disk BEFORE the commit is sent, so a
// crash or restart can always reveal (a commit that is never revealed costs
// part of the bond).
// Lottery: a round's lottery is keccak(seed, blockhash(start block + 1),
// round), fixed by a block nobody picks; eligible() computes it from block
// start + 2 on, so a runner just checks eligible() every tick. jobInfo().rand
// is 0 until then (or when the hash fell out of the 256-block window: the
// runner then calls draw(id), which moves the round to a new block).
// Gas: estimates run against the latest block while the transaction lands in
// a later one (another minute of the load meter, a draw stored meanwhile),
// so every send gets 50% headroom; an estimate refused with TooEarly (the
// lottery block is not there yet) waits a block and tries again.
// Governance (NeuroControl): a runner only takes jobs whose recorded skill is
// its own skill id (src/skill.js: the Neuro code it runs), and takes no new
// jobs while Neuro is paused; seats it already holds are still revealed.
// Jobs requested before NeuroJobs had a NeuroControl carry skill 0, so they
// are skipped too (they expire and refund).
// After a quorum, a seat not yet revealed may still reveal until the job's
// settleAt (jobInfo); once that has passed, a runner that sat on the job calls
// settle(id), which penalizes the seats that never revealed.
// Challenges: a challenged job opens round 2 (3 fresh seats, same lottery,
// commit-reveal, 2 of 3). The runner takes round-2 seats like round-1 seats
// (challengeEligible / challengeCommit / challengeReveal), with the same
// grace and settle afterwards.
// Defenders: a runner on the defender roster sends heartbeat() about every
// defenderTimeout/4, or it loses its seat (gas only).
// Watcher (opt-in, `zetaphy node start --watch-verdicts`): re-runs Neuro on
// finalized jobs still inside their challenge window and challenges a verdict
// that differs from its own (claiming its own verdict), spending at most
// maxPerDay on challenge bonds a day (chain time). It closes its round with
// challengeExpire if it runs out of time (80% of the bond back). A challenge
// that ended Disputed (no quorum) may be challenged again inside the new
// window (up to the contract's cap): the watcher does so if it still
// disagrees, so a self-challenge that goes nowhere cannot lock out real ones.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { AbiCoder, keccak256, hexlify, randomBytes, decodeBytes32String, formatEther } from 'ethers';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { readContract } from '../../zetaphy-neuro/src/reader.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

export const OPEN = 1n;
export const DONE = 2n;
/** NeuroJobs.ChallengeState */
export const CH = { NONE: 0n, OPEN: 1n, CONFIRMED: 2n, OVERTURNED: 3n, DISPUTED: 4n };
const ZERO32 = '0x' + '00'.repeat(32);
/** Chain keys this runner can read: what `zetaphy deploy` votes into NeuroControl's allowlist. */
export const SUPPORTED_CHAINS = ['zetaphy', ...Object.keys(CHAINS)];

export const commitmentOf = (verdict, worker, salt) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'], [verdict, worker, salt]));

export function loadState(file) {
  const s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { cursor: 0, seats: {}, chCursor: 0, seats2: {}, watchCursor: 0, watch: { day: 0, spent: '0', mine: [] }, ...s };
}

function saveState(file, state) {
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file); // atomic: never a half-written state file
}

const msgOf = (e) => e.shortMessage ?? e.message;

const isTooEarly = (e) => /TooEarly/.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.revert?.name ?? ''}`)
  || e?.data === '0x085de625'; // TooEarly()

/** The provider of an ethers contract method, if any (to wait for the next block). */
const providerOf = (fn) => fn?._contract?.runner?.provider ?? null;

/** Waits until the chain has a block after `from` (at most ~tries x 500 ms). */
async function nextBlock(provider, from, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await provider.getBlockNumber() > from) return;
  }
}

/** Sends a contract call with 50% gas headroom: the estimate runs on the latest block,
 *  the transaction lands in a later one (runners often commit in the same block; the
 *  load meter may have moved to another minute), and an exact estimate then runs out
 *  of gas. An estimate refused with TooEarly (the lottery block is not there yet) waits
 *  for the next block and tries again, a few times, instead of giving up. */
export async function send(fn, ...args) {
  if (typeof fn.estimateGas !== 'function') return fn(...args);
  const n = fn.fragment?.inputs?.length;
  const overrides = n != null && args.length > n ? args.pop() : {};
  const provider = providerOf(fn);
  for (let attempt = 0; ; attempt++) {
    let gas;
    try {
      gas = await fn.estimateGas(...args, overrides);
    } catch (e) {
      if (!isTooEarly(e) || !provider || attempt >= 3) throw e;
      await nextBlock(provider, await provider.getBlockNumber());
      continue;
    }
    return fn(...args, { ...overrides, gasLimit: gas + gas / 2n });
  }
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
 * @param {() => Promise<bigint>} [p.defenderTimeout]  NeuroControl.defenderTimeout(); omitted = no heartbeats
 * @param {() => Promise<boolean>} [p.onRoster]  NeuroControl.defenderApproved(me): heartbeat even while not seated
 * @param {{maxPerDay: bigint}|null} [p.watch]   watcher mode: challenge verdicts that differ from ours
 */
export function createWorker({ jobs, me, stateFile, zetaphyChain, read = readContract, chainTime, log = () => {}, skill = null, paused = null,
  defenderTimeout = null, onRoster = null, watch = null }) {
  const state = loadState(stateFile);
  let commitWindow = null;
  const foreign = new Set(); // jobs of another skill: never ours
  let wasPaused = false;
  const lc = (a) => String(a).toLowerCase();

  function readerFor(chainKey) {
    // sourcify:false: a verdict must depend only on the chain, not on whether
    // a third party has the source yet, or two runners could disagree.
    if (chainKey === 'zetaphy') return zetaphyChain ? { chainConfig: zetaphyChain, sourcify: false } : null;
    return CHAINS[chainKey] ? { sourcify: false } : null;
  }

  /** This machine's verdict on a job: {verdict, report} or {skip: reason}. */
  async function ourVerdict(job) {
    let chainKey;
    try { chainKey = decodeBytes32String(job.chain); } catch { return { skip: 'skip: bad chain name' }; }
    const opts = readerFor(chainKey);
    if (!opts) return { skip: `skip: chain ${chainKey} not supported here` };
    const report = await read(chainKey, job.target, opts);
    return { verdict: await verdictOf(report), report };
  }

  /** Is this job of another skill? (remembers it, and says so once) */
  async function isForeign(id, done) {
    if (!skill || !jobs.jobInfo) return false;
    if (foreign.has(id)) return true;
    const info = await jobs.jobInfo(id);
    if (lc(info.skill) === lc(skill)) return false;
    foreign.add(id);
    done.push(`job ${id}: skip: skill ${info.skill} is not this runner's (${skill})`);
    return true;
  }

  /** `rand` 0: the lottery block is not there yet (draw reverts, fine), or its hash
   *  fell out of the 256-block window unused: draw() moves the round to a new block. */
  async function drawIfNeeded(id, rand) {
    if (rand == null || rand !== ZERO32 || !jobs.draw) return;
    try { await (await send(jobs.draw, id)).wait(); } catch { /* too early, or someone drew first: fine */ }
  }

  /** Round 1 (round 2: second=true): compute, save, then commit. */
  async function tryCommit(id, job, now, second = false) {
    const v = await ourVerdict(job);
    if (v.skip) return v.skip;
    const salt = hexlify(randomBytes(32));
    const book = second ? state.seats2 : state.seats;
    book[id] = { verdict: v.verdict, salt, revealed: false, ...(second && job.round != null ? { round: job.round } : {}) };
    saveState(stateFile, state); // before the transaction, see top of file
    try {
      const c = commitmentOf(v.verdict, me, salt);
      await (await send(second ? jobs.challengeCommit : jobs.commit, id, c)).wait();
    } catch (e) {
      delete book[id]; // seat not taken: nothing to reveal
      saveState(stateFile, state);
      throw e;
    }
    return `${second ? 'committed in round 2 (challenge)' : 'committed'} (level ${v.report.analysis?.level}, ${now - (second ? job.chStart : job.created)}s after ${second ? 'the challenge' : 'request'})`;
  }

  /** jobInfo().settleAt: end of the reveal grace after a quorum, 0n when nothing is pending. */
  async function settleAtOf(id) {
    if (!jobs.jobInfo) return 0n;
    return BigInt((await jobs.jobInfo(id)).settleAt ?? 0n);
  }

  async function sendReveal(id, seat, late, second = false) {
    try {
      await (await send(second ? jobs.challengeReveal : jobs.reveal, id, seat.verdict, seat.salt)).wait();
      seat.revealed = true;
      saveState(stateFile, state);
      return `job ${id}: revealed${second ? ' in round 2' : ''}${late ? ' (after the quorum, inside the grace)' : ''}`;
    } catch (e) {
      // Usually the job closed between our read and the reveal (a quorum
      // formed): the next tick reveals inside the grace, or forgets the seat.
      return `job ${id}: reveal not sent (${msgOf(e)})`;
    }
  }

  /** A closed round we sat on: reveal inside the grace, settle after it, then forget the seat. */
  async function afterQuorum(id, seat, settleAt, now, done, second) {
    const book = second ? state.seats2 : state.seats;
    if (settleAt !== 0n && now < settleAt && !seat.revealed) { done.push(await sendReveal(id, seat, true, second)); return; }
    if (settleAt !== 0n && now < settleAt) return; // grace still running: settle afterwards
    if (settleAt !== 0n && seat.revealed) {
      try {
        await (await send(jobs.settle, id)).wait();
        done.push(`job ${id}: settled (seats that never revealed are penalized)`);
      } catch (e) { done.push(`job ${id}: settle not sent (${msgOf(e)})`); }
    }
    done.push(`job ${id}: ${second ? 'round 2 ' : ''}closed`);
    delete book[id];
  }

  async function roundOne(now, count, stopped, done) {
    const ids = new Set(Object.keys(state.seats).map(Number));
    for (let id = state.cursor; id < count; id++) ids.add(id);
    for (const id of [...ids].sort((a, b) => a - b)) {
      const job = await jobs.getJob(id);
      const seat = state.seats[id];
      const windowOver = now >= job.created + commitWindow;
      if (job.status !== OPEN) {
        if (seat) await afterQuorum(id, seat, job.status === DONE ? await settleAtOf(id) : 0n, now, done, false);
        continue;
      }
      if (!seat) {
        if (job.commits >= 3n || windowOver || stopped) continue;
        if (await isForeign(id, done)) continue;
        if (jobs.jobInfo && jobs.draw) await drawIfNeeded(id, (await jobs.jobInfo(id)).rand);
        // Seats go by a bond-weighted lottery; the pool of eligible runners
        // widens during the window, so check again on later ticks.
        if (!(await jobs.eligible(id, me))) continue;
        try {
          done.push(`job ${id}: ${await tryCommit(id, job, now)}`);
        } catch (e) {
          // Another runner took the last seat first, or the target chain is down: retry next tick.
          done.push(`job ${id}: not committed (${msgOf(e)})`);
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
  }

  /** Which challenge of job `id` is the latest (1, 2, ...); null on contracts without challengeRound. */
  async function challengeNo(id) {
    if (!jobs.challengeRound) return null;
    return Number((await jobs.challengeRound(id)).count);
  }

  /** Challenge rounds of challenged jobs: same as round 1, through the challenge* calls. */
  async function roundTwo(now, stopped, done) {
    if (!jobs.challengeCount) return;
    const n = Number(await jobs.challengeCount());
    const ids = new Set(Object.keys(state.seats2).map(Number));
    const open = [];
    for (let i = state.chCursor; i < n; i++) ids.add(Number(await jobs.challenged(i)));
    for (const id of [...ids].sort((a, b) => a - b)) {
      const ch = await jobs.challengeInfo(id);
      const no = await challengeNo(id);
      let seat = state.seats2[id];
      if (seat && seat.round != null && no != null && seat.round !== no) {
        // Our seat was in an earlier challenge round, which ended (Disputed: no grace).
        delete state.seats2[id];
        done.push(`job ${id}: round 2 closed`);
        seat = undefined;
      }
      const windowOver = now >= ch.start + commitWindow;
      if (ch.state !== CH.OPEN) {
        if (seat) await afterQuorum(id, seat, BigInt(ch.settleAt), now, done, true);
        continue;
      }
      if (!seat) {
        if (ch.commits >= 3n || windowOver) continue;
        open.push(id);
        if (stopped || await isForeign(id, done)) continue;
        await drawIfNeeded(id, ch.rand);
        if (!(await jobs.challengeEligible(id, me))) continue;
        const job = await jobs.getJob(id);
        try {
          done.push(`job ${id}: ${await tryCommit(id, { chain: job.chain, target: job.target, chStart: ch.start, round: no }, now, true)}`);
        } catch (e) { done.push(`job ${id}: not committed in round 2 (${msgOf(e)})`); }
      } else if (!seat.revealed && (ch.commits >= 3n || windowOver)) {
        done.push(await sendReveal(id, seat, false, true));
      }
    }
    // The cursor moves past challenges that no longer take seats.
    let i = state.chCursor;
    while (i < n && !open.includes(Number(await jobs.challenged(i)))) i++;
    state.chCursor = i;
  }

  /** A defender seat (or a place on the roster) needs a heartbeat about every defenderTimeout/4. */
  async function heartbeat(now, done) {
    if (!defenderTimeout || !jobs.heartbeat) return;
    const seated = [...await jobs.defenders()].some((a) => lc(a) === lc(me));
    if (!seated && !(onRoster && await onRoster())) return;
    const timeout = BigInt(await defenderTimeout());
    const last = BigInt((await jobs.workers(me)).lastSeen ?? 0n);
    if (now - last < timeout / 4n) return;
    try {
      await (await send(jobs.heartbeat)).wait();
      done.push(`heartbeat sent (defender${seated ? '' : ' on the roster'}; timeout ${timeout}s)`);
    } catch (e) { done.push(`heartbeat not sent (${msgOf(e)})`); }
  }

  /** Watcher: re-run finalized verdicts inside their challenge window; challenge ours-differs. */
  async function watcher(now, count, stopped, done) {
    if (!watch) return;
    const day = Number(now / 86400n);
    if (state.watch.day !== day) state.watch = { ...state.watch, day, spent: '0' };
    // Our own challenges that ran out of time without a round-2 quorum: get the bond back.
    for (const id of [...state.watch.mine]) {
      const ch = await jobs.challengeInfo(id);
      if (ch.state !== CH.OPEN) { state.watch.mine = state.watch.mine.filter((x) => x !== id); done.push(`job ${id}: our challenge ended: ${['', 'open', 'confirmed or overturned to another verdict (bond lost)', 'OVERTURNED (bond back + a share of the slash)', 'disputed (80% of the bond back)'][Number(ch.state)]}`); continue; }
      if (now >= ch.start + BigInt(await jobs.jobTimeout())) {
        try { await (await send(jobs.challengeExpire, id)).wait(); done.push(`job ${id}: challenge round timed out without a quorum: 80% of the bond back (verdict disputed)`); } catch (e) { done.push(`job ${id}: challengeExpire not sent (${msgOf(e)})`); }
      }
    }
    if (stopped) return; // paused: no challenges (the jobs wait for the unpause)
    let id = state.watchCursor;
    for (; id < count; id++) {
      const job = await jobs.getJob(id);
      if (job.status === OPEN) break; // not final yet: look again later
      if (job.status !== DONE) continue;
      const as = await jobs.assurance(id);
      if (as.state !== CH.NONE || now >= as.challengeUntil) continue;
      await challengeIfWrong(id, job, done);
    }
    state.watchCursor = id;
    // Challenges that ended Disputed: a new one may open inside the new window.
    if (!jobs.challengeCount) return;
    const n = Number(await jobs.challengeCount());
    let i = state.watchChCursor ?? 0;
    for (; i < n; i++) {
      const cid = Number(await jobs.challenged(i));
      const as = await jobs.assurance(cid);
      if (as.state === CH.OPEN) break; // still running: look again later
      if (as.state !== CH.DISPUTED || as.settled || now >= as.challengeUntil || state.watch.mine.includes(cid)) continue;
      await challengeIfWrong(cid, await jobs.getJob(cid), done);
      if (state.watch.mine.includes(cid)) { i++; break; } // our new round: the cursor waits behind it
    }
    state.watchChCursor = i;
  }

  /** Re-runs Neuro on a finalized job and challenges it (claiming our verdict) if we disagree. */
  async function challengeIfWrong(id, job, done) {
    if (await isForeign(id, done)) return;
    let v;
    try { v = await ourVerdict(job); } catch (e) { done.push(`job ${id}: watch: could not re-run (${msgOf(e)})`); return; }
    if (v.skip) return;
    if (lc(v.verdict) === lc(job.result)) return;
    const bond = BigInt(await jobs.challengeBondOf(id));
    const spent = BigInt(state.watch.spent);
    if (spent + bond > watch.maxPerDay) {
      done.push(`job ${id}: watch: our verdict differs, but a challenge (${formatEther(bond)} ZETAPHY) would pass today's limit (${formatEther(spent)} of ${formatEther(watch.maxPerDay)} spent)`);
      return;
    }
    try {
      await (await send(jobs.challenge, id, v.verdict, { value: bond })).wait();
      state.watch.spent = String(spent + bond);
      state.watch.mine.push(id);
      done.push(`job ${id}: watch: CHALLENGED with ${formatEther(bond)} ZETAPHY (ours ${v.verdict}, theirs ${job.result})`);
    } catch (e) { done.push(`job ${id}: watch: challenge not sent (${msgOf(e)})`); }
  }

  async function tick() {
    commitWindow ??= BigInt(await jobs.commitWindow());
    const now = await chainTime();
    const count = Number(await jobs.jobCount());
    const done = [];
    const stopped = paused ? await paused() : false;
    if (stopped !== wasPaused) done.push(stopped ? 'Neuro is paused by governance: no new jobs (seats already taken are still revealed)' : 'Neuro is running again');
    wasPaused = stopped;

    await roundOne(now, count, stopped, done);
    await roundTwo(now, stopped, done);
    await heartbeat(now, done);
    await watcher(now, count, stopped, done);
    saveState(stateFile, state);
    for (const line of done) log(line);
    return done;
  }

  return { tick, state };
}
