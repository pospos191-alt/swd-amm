// Reads real contracts through Neuro's own read-only reader (free public
// RPCs from src/chains.js) and turns them into training rows. Used by the
// public-dataset importer and the runner-vote importer. Read-only: Neuro's
// RPC client refuses every method that could send a transaction.

import { readContract } from '../../src/reader.js';
import { CHAINS } from '../../src/chains.js';
import { createRpc } from '../../src/rpc.js';
import { extractFeatures } from '../features.js';
import { sparse, SIM_SEED } from './pipeline.js';

/**
 * @param {Array<{address:string, label:0|1, id:string, src:string, license?:string, weight?:number, note?:string}>} items
 * @param {{chain?:string, concurrency?:number, simulate?:boolean, log?:Function}} [opts]
 */
export async function readRows(items, { chain = 'eth', concurrency = 4, simulate = false, log = () => {} } = {}) {
  const cfg = CHAINS[chain];
  if (!cfg || cfg.kind !== 'evm') throw new Error(`not an EVM chain: ${chain}`);
  const rpc = createRpc(cfg.rpcs, cfg.id);
  const rows = [];
  const errors = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const it = items[next++];
      try {
        const report = await readContract(chain, it.address.toLowerCase(), { rpc, simulate, sourcify: false, simSeed: SIM_SEED });
        if (!report.analysis || report.analysis.findings.some((f) => f.id === 'no-code')) { errors.push({ id: it.id, error: 'no code (self-destructed or EOA)' }); continue; }
        const code = await rpc.call('eth_getCode', [it.address.toLowerCase(), 'latest']);
        const impl = report.proxy?.implementation;
        const logicCode = impl ? await rpc.call('eth_getCode', [impl, 'latest']) : null;
        const f = extractFeatures({ report, code, logicCode });
        rows.push({ id: it.id, label: it.label, family: it.src, mutations: [], src: it.src, license: it.license, weight: it.weight ?? 1,
          rulesLevel: report.analysis.rulesLevel ?? report.analysis.level, level: report.analysis.level, sim: report.sim?.stage ?? null, f: sparse(f) });
        if (rows.length % 25 === 0) log(`  read ${rows.length}`);
      } catch (e) {
        errors.push({ id: it.id, error: String(e.message).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { rows, errors };
}
