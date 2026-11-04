// Saphan self-healing watcher (docs/SAPHAN-PR6.md item G). One tick() per route:
//   1. stuck messages: ZETAPHY -> X releases the outbox sent but the lockbox never recorded (outbox nonce > lockbox
//      received), and X -> ZETAPHY locks the lane never delivered, for longer than `stuckAfter`: replay the delivery
//      (the relayer re-sends the message: Hyperlane's process() is idempotent per message, the lockbox and lane refuse
//      replays, so a replay can only help), with exponential backoff, at most `maxReplays` times;
//   2. heartbeats: nothing heard from ZETAPHY for `beatAfter` (long before the 14-day escape): send one
//      (SaphanCheckpointer.beat(), anyone may);
//   3. anomalies: under-backing (reserves bps below `minBps`), a mint spike (minted in the last hour > `spikeFactor` x
//      the hourly baseline and above `minSpike`), or a message still stuck after every replay: TRIP the route's
//      CircuitBreaker with evidence (one attestation from this runner; the breaker's quorum of runners decides).
// The watcher never moves money and never unpauses; every decision is in the returned log. Reading and acting are
// injected (`read`, `act`), so the same loop runs on chain adapters (routeReader / breakerTripper below) or on mocks.
import { createHash } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';

export const DETECTOR = 'saphan-heal/1';
export const DETECTOR_ID = keccak256(toUtf8Bytes(DETECTOR));
export const DEFAULTS = { stuckAfter: 1800, maxReplays: 3, beatAfter: 20 * 3600, beatEvery: 3600, minBps: 9950, spikeFactor: 10, minSpike: 10n ** 18n };

const canonical = (v) => {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
export const evidenceHash = (e) => '0x' + createHash('sha256').update(canonical(e)).digest('hex');

/**
 * o: { routes: [names], read: async (route) => status, act: { replay(route, kind, range), beat(route), trip(route, evidence) },
 *      now: () => unix seconds, options }
 * status: { outboxNonce, lockboxReceived, lockNonce, lockDelivered, lastHeard, reservesBps, mintedLastHour, hourlyBaseline }
 *   (missing fields skip their check)
 */
export function createSaphanWatcher(o) {
  const opt = { ...DEFAULTS, ...(o.options ?? {}) };
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const mem = Object.fromEntries(o.routes.map((r) => [r, { stuck: {}, lastBeat: 0, tripped: false }]));
  const log = [];

  async function attempt(route, kind, fn) {
    try { const res = await fn(); log.push({ t: now(), route, kind, ok: true, res }); return true; }
    catch (e) { log.push({ t: now(), route, kind, ok: false, error: e.message }); return false; }
  }

  /** One gap (sent - recorded) of `dir`: replays it when stuck long enough; true when given up (an anomaly). */
  async function gap(route, dir, isStuck, range) {
    const m = mem[route].stuck;
    const key = `${dir}:${range.to}`;
    if (!isStuck) { delete m[dir]; return false; }
    if (!m[dir] || m[dir].key !== key) m[dir] = { key, since: now(), replays: 0, next: now() + opt.stuckAfter };
    const s = m[dir];
    if (now() < s.next) return false;
    if (s.replays >= opt.maxReplays) return true;
    s.replays += 1;
    s.next = now() + opt.stuckAfter * 2 ** s.replays;
    await attempt(route, `replay-${dir}`, () => o.act.replay(route, dir, range));
    return false;
  }

  async function tick() {
    const actions = [];
    for (const route of o.routes) {
      const before = log.length;
      let st;
      try { st = await o.read(route); } catch (e) { log.push({ t: now(), route, kind: 'read', ok: false, error: e.message }); continue; }
      const anomalies = [];
      if (st.outboxNonce != null && st.lockboxReceived != null) {
        const sent = BigInt(st.outboxNonce), got = BigInt(st.lockboxReceived);
        if (await gap(route, 'out', sent > got, { from: got, to: sent - 1n })) anomalies.push({ id: 'stuck-out', sent, recorded: got });
      }
      if (st.lockNonce != null && st.lockDelivered != null) {
        const n = BigInt(st.lockNonce);
        if (await gap(route, 'in', n > 0n && !st.lockDelivered, { from: n - 1n, to: n - 1n })) anomalies.push({ id: 'stuck-in', nonce: n - 1n });
      }
      if (st.lastHeard != null && now() - Number(st.lastHeard) >= opt.beatAfter && now() - mem[route].lastBeat >= opt.beatEvery) {
        mem[route].lastBeat = now();
        await attempt(route, 'beat', () => o.act.beat(route));
      }
      if (st.reservesBps != null && BigInt(st.reservesBps) < BigInt(opt.minBps)) anomalies.push({ id: 'under-backed', bps: BigInt(st.reservesBps) });
      if (st.mintedLastHour != null && st.hourlyBaseline != null) {
        const m = BigInt(st.mintedLastHour), b = BigInt(st.hourlyBaseline);
        if (m >= BigInt(opt.minSpike) && m > b * BigInt(opt.spikeFactor)) anomalies.push({ id: 'mint-spike', minted: m, baseline: b });
      }
      if (anomalies.length && !mem[route].tripped) {
        const evidence = { detector: DETECTOR, route, at: now(), anomalies };
        const hash = evidenceHash(evidence);
        if (await attempt(route, 'trip', () => o.act.trip(route, { evidence, hash }))) mem[route].tripped = true;
      } else if (anomalies.length) log.push({ t: now(), route, kind: 'anomaly', ok: true, res: anomalies.map((a) => a.id) });
      actions.push(...log.slice(before));
    }
    return actions;
  }

  /** After governance handled a trip (released or expired): the route may trip again. */
  const reset = (route) => { mem[route].tripped = false; mem[route].stuck = {}; };
  return { tick, reset, log, state: mem };
}

/**
 * Reads a deployed route with ethers contracts (any of them may be omitted):
 *   outbox (HyperlaneOutbox on ZETAPHY), lockbox (HyperlaneLockBoxV2 on X), lane (HyperlaneLane on ZETAPHY: delivered(id)),
 *   minted: async () => ({ lastHour, baseline }) (e.g. from the guard's Inbound events)
 */
export function routeReader({ outbox, lockbox, lane, minted }) {
  return async () => {
    const st = {};
    if (outbox && lockbox) { st.outboxNonce = await outbox.nonce(); st.lockboxReceived = await lockbox.received(); }
    if (lockbox) {
      st.lastHeard = await lockbox.lastHeard();
      const n = await lockbox.nonce();
      st.lockNonce = n;
      if (lane && n > 0n) st.lockDelivered = await lane.delivered(await lockbox.transferIds(n - 1n));
      const r = await lockbox.reserves();
      if (r[1] > 0n) st.reservesBps = r[3];
    }
    if (minted) { const m = await minted(); st.mintedLastHour = m.lastHour; st.hourlyBaseline = m.baseline; }
    return st;
  };
}

/** act.trip for a route that opted in to CircuitBreaker: this runner attests the evidence (the quorum trips it). */
export function breakerTripper({ breaker, protocol, mask, provider }) {
  return async (route, { hash }) => {
    const head = BigInt(await provider.getBlockNumber());
    const tx = await breaker.attest(protocol, { fromBlock: head - 1n, toBlock: head - 1n, evidenceHash: hash, detectorId: DETECTOR_ID, mask });
    await tx.wait?.();
    return { protocol, evidenceHash: hash, tx: tx.hash };
  };
}
