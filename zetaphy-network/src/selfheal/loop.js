// The self-healing detector loop (docs/future/self-healing.md). One tick() reads every block since
// the last tick and, for each protocol that opted in to CircuitBreaker:
//   1. collect + evaluate (detect.js) the block against its look-back;
//   2. if anomalous and the protocol is not tripped yet: a proposal {protocol, block, evidence hash,
//      mask, epoch} goes to the runner peers (peers.js), each recomputes and signs or refuses;
//   3. with >= the policy's quorum of valid signatures, submits CircuitBreaker.tripWithSignatures.
// Every evaluated block, anomaly, proposal, refusal and trip is in the returned stats/log, so a run
// can be audited afterwards. TESTNET PROTOTYPE: a single process stands in for the runner network.
import { Contract } from 'ethers';
import { readFileSync } from 'node:fs';
import { collect, evaluate, DETECTOR_ID, watchConfig } from './detect.js';
import { gatherSignatures } from './peers.js';

export const breakerAbi = () => JSON.parse(readFileSync(new URL('../../artifacts/CircuitBreaker.json', import.meta.url), 'utf8')).abi;

/** A revert's custom-error name when the node returned its data, else ethers' message. */
export function errorName(contract, e) {
  try { const p = contract.interface.parseError(e.data ?? e.info?.error?.data ?? '0x'); if (p) return p.name; } catch { /* no data */ }
  return e.shortMessage ?? e.message;
}

/** The CircuitBreaker.Policy tuple, from a readable object (selectors as 0x… or function signatures). */
export function policyTuple(p) {
  return [p.governance, p.selectors, p.assets ?? [], (p.caps ?? []).map(BigInt), p.window, p.maxPause, p.quorum, p.invariantMask ?? 0, p.tripCapBps ?? 0, BigInt(p.holdAbove ?? 0), p.holdReview ?? 0];
}

/**
 * o: { provider, breaker (address), submitter (ethers signer that sends trips), peers ([createPeer]),
 *      protocols ([watch config objects]), fromBlock (first block to read; default: the head at the first tick),
 *      log (fn) }
 */
export function createSelfHealLoop(o) {
  const log = o.log ?? (() => {});
  const breaker = new Contract(o.breaker, breakerAbi(), o.submitter);
  const cfgs = o.protocols.map(watchConfig);
  let next = o.fromBlock ?? null;
  const stats = { evaluated: 0, anomalies: [], outliers: [], proposals: [], trips: [], refused: [] };
  const cache = {};

  async function tick() {
    const head = Number(await o.provider.getBlockNumber());
    if (next == null) next = head;
    const found = [];
    for (; next <= head; next++) {
      const b = next;
      for (const cfg of cfgs) {
        if (await breaker.isTripped(cfg.address)) continue;
        stats.evaluated += 1;
        const r = evaluate(cfg, await collect(o.provider, cfg, b, b, { cache }), b, b);
        // a volume outlier alone (what a plain z-score monitor would alert on) is recorded, never tripped on
        if (!r.anomalous) { if (r.signals.some((s) => s.id === 'volume')) stats.outliers.push({ protocol: cfg.address, block: b, signals: r.signals.map((s) => s.id) }); continue; }
        stats.anomalies.push({ protocol: cfg.address, block: b, signals: r.signals.map((s) => s.id) });
        log(`selfheal: block ${b} anomalous for ${cfg.address}: ${r.signals.map((s) => s.id).join(', ')}`);
        if (BigInt(b) <= await breaker.lastToBlock(cfg.address)) continue; // already covered by a trip
        const pol = await breaker.policyOf(cfg.address);
        const proposal = {
          chainId: (await o.provider.getNetwork()).chainId, protocol: cfg.address, epoch: await breaker.epoch(cfg.address),
          fromBlock: b, toBlock: b, evidenceHash: r.evidenceHash, detectorId: DETECTOR_ID, mask: r.mask,
        };
        stats.proposals.push({ protocol: cfg.address, block: b, evidenceHash: r.evidenceHash, mask: r.mask });
        const { signers, sigs, refused } = await gatherSignatures(proposal, o.peers, { breaker: o.breaker });
        stats.refused.push(...refused.map((x) => ({ ...x, block: b })));
        if (signers.length < Number(pol.quorum)) { log(`selfheal: only ${signers.length}/${pol.quorum} signatures for block ${b}`); continue; }
        const ev = [b, b, r.evidenceHash, DETECTOR_ID, r.mask];
        try {
          // explicit gas: estimating against the head would see toBlock == block.number (the trip lands in a later block)
          const tx = await breaker.tripWithSignatures(cfg.address, ev, signers, sigs, { gasLimit: 3_000_000n });
          const rc = await tx.wait();
          const trip = { protocol: cfg.address, evidenceBlock: b, tripBlock: rc.blockNumber, signers, mask: r.mask, evidenceHash: r.evidenceHash, evidence: r.evidence };
          stats.trips.push(trip);
          found.push(trip);
          log(`selfheal: TRIPPED ${cfg.address} in block ${rc.blockNumber} (evidence block ${b}, ${signers.length} signers, mask ${r.mask})`);
        } catch (e) {
          log(`selfheal: trip refused: ${errorName(breaker, e)}`);
        }
      }
    }
    return found;
  }
  return { tick, stats, configs: cfgs, get next() { return next; } };
}

