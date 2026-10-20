// Neuro lane watcher: turns a node runner into one voice of the Neuro bridge.
// Reads Locked events from the source chain's LockBox, waits for enough
// confirmations, attests each transfer once to NeuroLane on ZETAPHY, and
// (optionally) releases transfers whose quarantine is over.
// Vaccine: a transfer whose source sender, source contract or ZETAPHY
// recipient is flagged in the ThreatRegistry (BridgeAirlock.flaggedParty) is
// neither attested nor released; it stays pending and goes through if the
// flag is cleared or governance protects the key. "Flagged" here means
// enforced: the registry's enforceDelay has passed (Neuro's warnings come
// sooner). If the check cannot be made, nothing is attested (fail closed).
// Nothing is attested while Neuro is paused (NeuroControl), or while the
// pause switch cannot be read (laneControl).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { AbiCoder, keccak256 } from 'ethers';

const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { fromBlock: 0, pending: [] });
function save(f, s) { writeFileSync(f + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(f + '.tmp', f); }
const LOG_CHUNK = 1000;
const PARTY = ['', 'source sender', 'source contract', 'ZETAPHY recipient'];
/** A revert's error name. Cosmos EVM returns the revert data quoted ("\"0x…\""), which ethers leaves undecoded. */
function why(err, contract) {
  if (err.revert?.name) return err.revert.name;
  for (const d of [err.data, err.info?.error?.data]) {
    const hex = /0x[0-9a-fA-F]{8,}/.exec(String(d ?? ''))?.[0];
    if (!hex) continue;
    try { const e = contract.interface?.parseError(hex); if (e) return e.name; } catch { /* not this contract's error */ }
  }
  return err.shortMessage ?? err.message;
}
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * NeuroLane's pause switch (its control() address, then that NeuroControl's
 * paused()), read fail closed: each read is retried, and if it still fails
 * paused() throws, so the watcher attests nothing that tick and tries again
 * the next. A lane built with control = 0 has no switch: paused() is false.
 * @param {{control: () => Promise<string>}} lane
 * @param {(address: string) => {paused: () => Promise<boolean>}} connect
 */
export function laneControl(lane, connect, { tries = 3, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  let addr = null;
  let ctl = null;
  const retry = async (what, fn) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { last = e; if (i + 1 < tries) await wait(1000 * (i + 1)); }
    }
    throw new Error(`could not read ${what}: ${last?.shortMessage ?? last?.message ?? last}`);
  };
  return {
    async paused() {
      if (addr === null) {
        addr = String(await retry('NeuroLane.control()', () => lane.control()));
        if (addr.toLowerCase() === ZERO) log('warning: this NeuroLane has no NeuroControl (control = 0): no pause switch to check');
        else ctl = connect(addr);
      }
      if (!ctl) return false;
      return Boolean(await retry('NeuroControl.paused()', () => ctl.paused()));
    },
    address: () => addr,
  };
}

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
 * @param {{paused: () => Promise<boolean>}|null} [p.control]  NeuroControl: no attesting while it says paused
 */
export function createLaneWatcher({ lockbox, lane, airlock, me, srcChainId, confirmations, stateFile, release = false, control = null, chainTime, log = () => {} }) {
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
    // Neuro paused, or the switch unreadable: attest nothing this tick (fail closed).
    let paused = false;
    if (control) {
      try { paused = await control.paused(); } catch { paused = null; }
      if (paused !== false) out.push(paused ? 'Neuro is paused: not attesting' : 'could not read NeuroControl: not attesting');
    }
    const keep = [];
    for (const raw of state.pending) {
      const t = parse(raw);
      const id = await airlock.transferId(...t);
      // Vaccine: is the sender, the source contract or the recipient flagged? (-1: could not check)
      let flagged;
      try { flagged = Number(await airlock.flaggedParty(t[0], t[1], t[3], t[4])); } catch { flagged = -1; }
      const held = flagged > 0 ? `${PARTY[flagged] ?? 'a party'} is flagged in the ThreatRegistry (enforced), held until the flag is cleared`
        : 'could not check the ThreatRegistry';
      // 2. Attest (retried every tick until it lands or the lane is done).
      const key = voteKey(id);
      if (paused === false && !(await lane.votedBy(key, me)) && !(await lane.done(key))) {
        if (flagged !== 0) out.push(`lock #${t[2]}: not attested (${held})`);
        else try {
          // The vote that completes the quorum also calls the airlock: an
          // estimate taken before another runner's vote landed is too low.
          const gasLimit = (await lane.attest.estimateGas(...t)) * 2n + 100_000n;
          await (await lane.attest(...t, { gasLimit })).wait();
          out.push(`attested lock #${t[2]}: ${t[5]} to ${t[4]}`);
        } catch (err) {
          out.push(`lock #${t[2]}: not attested yet (${why(err, lane)})`);
        }
      }
      // 3. Release once enough lanes agreed and the quarantine is over.
      if (release) {
        const [count, released, vetoed, readyAt] = await airlock.status(id);
        if (released || vetoed) continue; // finished: forget it
        if (count >= threshold && readyAt > 0n && now >= readyAt) {
          if (flagged !== 0) { out.push(`lock #${t[2]}: not released (${held})`); keep.push(raw); continue; }
          try {
            // Estimate first: a NonceManager signer takes a nonce before it estimates,
            // so a release that reverts there would leave a gap the next tx waits behind.
            const gasLimit = (await airlock.release.estimateGas(...t)) * 2n + 50_000n;
            await (await airlock.release(...t, { gasLimit })).wait();
            out.push(`released lock #${t[2]} to ${t[4]}`);
            continue;
          } catch (err) {
            const name = why(err, airlock);
            out.push(`lock #${t[2]}: not released (${name})`);
            if (/Blocked/.test(name)) continue; // decoy-marked or vetoed: never passes, stop retrying
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
