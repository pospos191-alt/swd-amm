// Investigator on volunteer runner machines (NeuroJobs). A runner already
// runs Neuro's rules for each job and commits the rules-only verdict
// (zetaphy-network/src/worker.js); this adds the money-flow investigation
// next to it, as advisory data:
//   1. read new JobRequested events from NeuroJobs on ZETAPHY (eth_getLogs)
//   2. run the pipeline (agent/pipeline.js) on each job's target
//   3. sign the result as a Neuro message of kind "verdict"
//      (zetaphy-network/src/neuromsg.js: EIP-712, signed by the runner key)
//   4. hand the signed envelope to `post` (default: append to an outbox file
//      that other Neuro instances can fetch and verify with verifyMessage)
// It never sends a transaction: the on-chain verdict stays the rules-only
// commit-reveal of worker.js, because a graph depends on each runner's RPC
// and block (like the trade test, it is not part of the consensus).
import { TOPIC, hexBlock, toNum, topicAddr, abiString, bytes32String, isEvmAddress } from '../graph/util.js';
import { CHAINS } from '../src/chains.js';
import { investigate } from './pipeline.js';

const NEURO_MSG_CHAINS = new Set(['zetaphy', 'eth', 'bsc', 'base', 'arbitrum', 'sol', 'sui', 'aptos', 'osmosis', 'neutron', 'near', 'starknet', 'bitcoin', 'ton']);

/** JobRequested logs -> [{ id, chain, target, block }] (malformed ones dropped). */
export function jobsFromLogs(logs) {
  const out = [];
  for (const l of logs) {
    if (String(l.topics?.[0]).toLowerCase() !== TOPIC.jobRequested || (l.topics?.length ?? 0) < 3) continue;
    try {
      const chain = bytes32String(l.topics[2]);
      const target = abiString(l.data, 0);
      if (!/^[\x21-\x7e]{1,200}$/.test(target)) continue;
      out.push({ id: BigInt(l.topics[1]).toString(), chain, target, block: toNum(l.blockNumber) });
    } catch { /* not ours to read */ }
  }
  return out;
}

/** The neuromsg "verdict" payload for an investigation report. */
export function verdictPayload(report, jobId) {
  const signals = report.signals.filter((s) => s.severity === 'high' || s.severity === 'medium').map((s) => `${s.source}/${s.id}`);
  const summary = `level=${report.level} confidence=${report.confidence} signals=${signals.join(',') || '-'}`.slice(0, 280);
  return {
    chain: report.target.chain, address: report.target.address, verdictHash: '0x' + report.reportHash,
    score: Math.max(0, Math.min(100, Math.round(report.score))), summary, ...(jobId != null ? { jobId: String(jobId) } : {}),
  };
}

/**
 * @param {object} p
 * @param {{call: Function}} p.rpc          ZETAPHY EVM client (graph/clients.js)
 * @param {string} p.jobs                   NeuroJobs address
 * @param {(payload) => Promise<object>} p.sign  e.g. (payload) => neuromsg.signMessage(wallet, { ..., kind: 'verdict', payload })
 * @param {(envelope, report) => Promise<void>} p.post
 * @param {{cursor?: number}} [p.state]     persisted by the caller between ticks
 * @param {number} [p.maxPerTick=3]   [p.window=5000] blocks read per tick
 * @param {Function} [p.investigateFn]  [p.zetaphyChain]  ZETAPHY reader config for jobs on 'zetaphy'
 */
export function createGraphRunner({ rpc, jobs, sign, post, state = {}, maxPerTick = 3, window = 5_000, investigateFn = investigate, zetaphyChain = null, log = () => {} }) {
  if (!isEvmAddress(jobs)) throw new Error('NeuroJobs address required');
  state.cursor ??= 0;
  state.done ??= [];
  return {
    state,
    async tick() {
      const head = toNum(await rpc.call('eth_blockNumber', []));
      const from = state.cursor ? state.cursor + 1 : Math.max(0, head - window);
      const to = Math.min(head, from + window - 1);
      if (from > to) return [];
      const logs = await rpc.call('eth_getLogs', [{ address: jobs, topics: [TOPIC.jobRequested], fromBlock: hexBlock(from), toBlock: hexBlock(to) }]) ?? [];
      const results = [];
      for (const job of jobsFromLogs(logs)) {
        if (results.length >= maxPerTick) break;
        if (state.done.includes(job.id)) continue;
        if (!NEURO_MSG_CHAINS.has(job.chain) || (!CHAINS[job.chain] && !(job.chain === 'zetaphy' && zetaphyChain))) { log(`job ${job.id}: chain ${job.chain} not covered`); state.done.push(job.id); continue; }
        const report = await investigateFn({ chain: job.chain, address: job.target, ...(job.chain === 'zetaphy' && zetaphyChain ? { chainConfig: zetaphyChain } : {}) });
        const envelope = await sign(verdictPayload(report, job.id));
        await post(envelope, report);
        state.done.push(job.id);
        state.done = state.done.slice(-500);
        results.push({ job, level: report.level, reportHash: report.reportHash });
        log(`job ${job.id}: ${job.chain} ${job.target} level=${report.level} confidence=${report.confidence}`);
      }
      // Only move past this window once every job in it is handled.
      if (results.length < maxPerTick) state.cursor = to;
      return results;
    },
  };
}

/** Default `post`: one JSON envelope per line in `file` (Node only). */
export async function outboxPost(file) {
  const { appendFile } = await import('node:fs/promises');
  return async (envelope) => { await appendFile(file, JSON.stringify(envelope) + '\n', { mode: 0o600 }); };
}
