// Neuro lane watcher: turns a node runner into one voice of the Neuro bridge.
// Reads Locked events from the source chain's LockBox, waits for enough
// confirmations, attests each transfer once to NeuroLane on ZETAPHY, and
// (optionally) releases transfers whose quarantine is over.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { AbiCoder, keccak256 } from 'ethers';

const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { fromBlock: 0, pending: [] });
function save(f, s) { writeFileSync(f + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(f + '.tmp', f); }
const LOG_CHUNK = 1000;
const voteKey = (id) => keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['attest', id]));

/**
 * @param {object} p
 * @param {import('ethers').Contract} p.lockbox   LockBox on the source chain (read-only)
 * @param {import('ethers').Contract} p.lane      NeuroLane on ZETAPHY, bound to the runner wallet
 * @param {import('ethers').Contract} p.airlock   BridgeAirlock on ZETAPHY, bound to the runner wallet
 * @param {string} p.me
 * @param {bigint} p.srcChainId
 * @param {number} p.confirmations  blocks to wait on the source chain before attesting
 * @param {boolean} [p.release]     also release transfers that are ready
 */
export function createLaneWatcher({ lockbox, lane, airlock, me, srcChainId, confirmations, stateFile, release = false, chainTime, log = () => {} }) {
  const state = load(stateFile);

  const parse = (raw) => [BigInt(raw[0]), raw[1], BigInt(raw[2]), raw[3], raw[4], BigInt(raw[5])];

  async function tick() {
    const out = [];
    // 1. New locks, once they are `confirmations` deep on the source chain.
    const head = await lockbox.runner.provider.getBlockNumber();
    const safe = head - confirmations;
    if (safe >= state.fromBlock) {
      // Chunks: public nodes cap the block span of one eth_getLogs (2,000 on ZETAPHY).
      for (let from = state.fromBlock; from <= safe; from += LOG_CHUNK) {
        const to = Math.min(from + LOG_CHUNK - 1, safe);
        const events = await lockbox.queryFilter(lockbox.filters.Locked(), from, to);
        for (const e of events) state.pending.push([srcChainId, lockbox.target, e.args.nonce, e.args.sender, e.args.to, e.args.amount].map(String));
        state.fromBlock = to + 1;
        save(stateFile, state);
      }
    }
    const threshold = release ? await airlock.threshold() : 0n;
    const now = release ? await chainTime() : 0n;
    const keep = [];
    for (const raw of state.pending) {
      const t = parse(raw);
      const id = await airlock.transferId(...t);
      // 2. Attest (retried every tick until it lands or the lane is done).
      const key = voteKey(id);
      if (!(await lane.votedBy(key, me)) && !(await lane.done(key))) {
        try {
          // The vote that completes the quorum also calls the airlock: an
          // estimate taken before another runner's vote landed is too low.
          const gasLimit = (await lane.attest.estimateGas(...t)) * 2n + 100_000n;
          await (await lane.attest(...t, { gasLimit })).wait();
          out.push(`attested lock #${t[2]}: ${t[5]} to ${t[4]}`);
        } catch (err) {
          out.push(`lock #${t[2]}: not attested yet (${err.revert?.name ?? err.shortMessage ?? err.message})`);
        }
      }
      // 3. Release once enough lanes agreed and the quarantine is over.
      if (release) {
        const [count, released, vetoed, readyAt] = await airlock.status(id);
        if (released || vetoed) continue; // finished: forget it
        if (count >= threshold && readyAt > 0n && now >= readyAt) {
          try {
            await (await airlock.release(...t)).wait();
            out.push(`released lock #${t[2]} to ${t[4]}`);
            continue;
          } catch (err) {
            const why = err.revert?.name ?? err.shortMessage ?? err.message;
            out.push(`lock #${t[2]}: not released (${why})`);
            if (/Blocked/.test(why)) continue; // decoy-marked: never passes, stop retrying
          }
        }
      }
      keep.push(raw);
    }
    state.pending = keep;
    save(stateFile, state);
    for (const l of out) log(l);
    return out;
  }

  return { tick, state };
}
