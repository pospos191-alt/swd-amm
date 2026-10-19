// Finds tokens the ZETAPHY factories created recently and verifies them,
// plus the factories themselves. Stateless: anything already verified is
// skipped, so running it often (or twice) is safe.

import { codeFingerprint } from '../../zetaphy-neuro/src/fingerprint.js';
import { verifyAddress } from './verify.js';

// 12 zero bytes, then an address. Small numbers (amounts, flags) also fit
// that shape, so values below 2^96 (8+ leading zero bytes) are dropped.
const ADDR_WORD = /^0{24}(?!0{16})[0-9a-f]{40}$/;

/** Addresses carried by a log: indexed topics and 32-byte data words that look like addresses. */
export function addressesInLog(log) {
  const words = [...(log.topics ?? []).slice(1).map((t) => t.slice(2)),
    ...((log.data ?? '0x').slice(2).match(/.{64}/g) ?? [])];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => ADDR_WORD.test(w))
    .map((w) => '0x' + w.slice(24)))];
}

/** eth_getLogs over [from, to] in chunks, halving a chunk the RPC refuses. */
export async function getLogs(rpc, { addresses, topic, from, to, chunk }) {
  const logs = [];
  let start = from;
  let size = chunk;
  while (start <= to) {
    const end = Math.min(start + size - 1, to);
    try {
      logs.push(...await rpc.call('eth_getLogs', [{
        address: addresses, topics: [topic],
        fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16),
      }]));
      start = end + 1;
    } catch (e) {
      if (size <= 50) throw e;
      size = Math.floor(size / 2);
    }
  }
  return logs;
}

/**
 * @param {object} p
 * @param {object} p.chain     entry from config.chains
 * @param {string[]} p.factories  candidate factory addresses for this chain
 * @param {{call: Function}} p.rpc
 * @param {object} p.builds
 * @param {Array} p.explorers
 * @param {string} p.topic
 * @param {number} [p.fromBlock]  default: latest - chain.lookbackBlocks
 * @param {number} [p.toBlock]    default: latest
 * @param {(line: string) => void} [p.log]
 */
export async function watchChain({ chain, factories, rpc, builds, explorers, topic, fromBlock, toBlock, log = () => {} }) {
  const out = [];
  // Keep only factories that really are there (same address on another
  // chain can be empty or someone else's contract).
  const live = [];
  for (const f of [...new Set(factories.map((a) => a.toLowerCase()))]) {
    const code = await rpc.call('eth_getCode', [f, 'latest']);
    if (!code || code === '0x') continue;
    const known = chain.factories.map((a) => a.toLowerCase()).includes(f);
    if (!known && !builds.byFingerprint(await codeFingerprint(code))) continue;
    live.push(f);
  }
  if (!live.length) { log(`${chain.name}: no ZETAPHY factory found`); return out; }

  for (const f of live) {
    const r = await verifyAddress({ chainId: chain.chainId, address: f, rpc, builds, explorers });
    if (r.status !== 'skipped') out.push({ ...r, kind: 'factory' });
  }

  const latest = Number(BigInt(await rpc.call('eth_blockNumber', [])));
  const to = toBlock ?? latest;
  const from = fromBlock ?? Math.max(0, to - chain.lookbackBlocks);
  const logs = await getLogs(rpc, { addresses: live, topic, from, to, chunk: chain.logChunk });
  log(`${chain.name}: ${live.length} factory, blocks ${from}-${to}, ${logs.length} TokenDeployed event(s)`);

  const seen = new Set(live);
  for (const l of logs) {
    for (const a of addressesInLog(l)) {
      if (seen.has(a)) continue;
      seen.add(a);
      const r = await verifyAddress({ chainId: chain.chainId, address: a, txHash: l.transactionHash, rpc, builds, explorers });
      // The creator wallet in the same event has no code: skip it quietly.
      if (r.status === 'skipped' && r.detail === 'no code at this address') continue;
      out.push({ ...r, kind: 'token', txHash: l.transactionHash });
    }
  }
  return out;
}
