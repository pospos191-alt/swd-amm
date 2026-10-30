// Runner peers for self-healing (docs/future/self-healing.md): a proposer shares a trip proposal
// {protocol, block range, evidence hash, mask}; every peer RE-COMPUTES the evidence from its own
// view of the chain (detect.js: collect + evaluate) and signs the on-chain digest only when its own
// result is anomalous and hashes to the same evidence. The proposer checks each signature and
// submits k of them (CircuitBreaker.tripWithSignatures, signers ascending).
//
// The exchange is simulated in memory here (a real deployment would carry it over the runners'
// existing transport, e.g. Neuro messages); what matters is that a peer never signs what it did
// not recompute. `behavior: 'colluding'` makes a peer sign anything: the abuse tests use it.
import { getBytes, verifyMessage, getAddress } from 'ethers';
import { collect, evaluate, tripDigest, DETECTOR_ID } from './detect.js';

/**
 * A runner peer. o: { wallet (ethers Wallet: the runner's guardian key), provider, breaker (address),
 *   configs: { protocolAddress: watchConfig }, behavior: 'honest' | 'colluding' | 'silent' }
 */
export function createPeer({ wallet, provider, breaker, configs, behavior = 'honest' }) {
  const cfgOf = (p) => configs[getAddress(p)];
  const cache = {};
  return {
    address: getAddress(wallet.address),
    behavior,
    /** Reviews a proposal: { ok, signature } or { ok: false, reason }. */
    async review(p) {
      if (behavior === 'silent') return { ok: false, reason: 'no answer' };
      const digest = tripDigest({ ...p, breaker, detectorId: p.detectorId ?? DETECTOR_ID });
      if (behavior !== 'colluding') {
        const cfg = cfgOf(p.protocol);
        if (!cfg) return { ok: false, reason: 'not watching this protocol' };
        const r = evaluate(cfg, await collect(provider, cfg, p.fromBlock, p.toBlock, { cache }), p.fromBlock, p.toBlock);
        if (!r.anomalous) return { ok: false, reason: 'no anomaly in my view of the chain' };
        if (r.evidenceHash !== p.evidenceHash) return { ok: false, reason: 'my evidence differs' };
        if (r.mask !== p.mask) return { ok: false, reason: 'selector mask differs' };
      }
      return { ok: true, signature: await wallet.signMessage(getBytes(digest)) };
    },
  };
}

/**
 * Sends a proposal to the peers and keeps the valid signatures (checked with verifyMessage).
 * Returns { signers (ascending), sigs, refused: [{ peer, reason }] }; at most `max` signatures.
 */
export async function gatherSignatures(proposal, peers, { breaker, max = 16 } = {}) {
  const digest = tripDigest({ ...proposal, breaker, detectorId: proposal.detectorId ?? DETECTOR_ID });
  const got = [];
  const refused = [];
  const answers = await Promise.all(peers.map(async (peer) => [peer, await peer.review(proposal).catch((e) => ({ ok: false, reason: e.message }))]));
  for (const [peer, a] of answers) {
    if (!a.ok) { refused.push({ peer: peer.address, reason: a.reason }); continue; }
    let who = null;
    try { who = getAddress(verifyMessage(getBytes(digest), a.signature)); } catch { /* garbage */ }
    if (who !== peer.address) { refused.push({ peer: peer.address, reason: 'bad signature' }); continue; }
    if (!got.some((g) => g.signer === who)) got.push({ signer: who, sig: a.signature });
  }
  got.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const keep = got.slice(0, max);
  return { signers: keep.map((g) => g.signer), sigs: keep.map((g) => g.sig), refused };
}
