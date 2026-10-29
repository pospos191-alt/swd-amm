// Generated samples -> compiled -> deployed and listed on the local DEX ->
// Neuro's own readContract() (rules + trade simulation) -> features.

import { readContract } from '../../src/reader.js';
import { CHAINS } from '../../src/chains.js';
import { extractFeatures } from '../features.js';
import { sourceFile } from '../data/solgen.js';
import { createChain, compileSources, DEPLOYER, word } from './chain.js';

// Fixed plan for the simulation (src/honeypot.js simPlan): every run of the corpus sees the same trade.
export const SIM_SEED = '0x' + '6e6575726f2d6d6c'.repeat(4);
const DEX = CHAINS.bsc.dex;
const POOL_WEI = 10n ** 20n;

/** Compiles samples in batches; a batch that fails is retried one by one, bad samples are reported, not fatal. */
export function compileSamples(samples, { optimize = true, batch = 40 } = {}) {
  const bins = {};
  const errors = [];
  for (let i = 0; i < samples.length; i += batch) {
    const part = samples.slice(i, i + batch);
    try {
      Object.assign(bins, compileSources({ 'gen.sol': sourceFile(part) }, { optimize }));
    } catch {
      for (const s of part) {
        try { Object.assign(bins, compileSources({ 'gen.sol': sourceFile([s]) }, { optimize })); } catch (e) { errors.push({ id: s.id, error: String(e.message).slice(0, 400) }); }
      }
    }
  }
  return { bins, errors };
}

/** A fresh local chain with the DEX installed. */
export async function freshChain() {
  const chain = await createChain();
  chain.addPool = await chain.installDex(DEX);
  return chain;
}

/**
 * Deploys, lists and reads one compiled sample. Returns the report and the code read.
 * @param {object} chain  from freshChain()
 */
export async function deployAndRead(chain, sample, bins) {
  const addrs = [];
  for (const d of sample.deploy) {
    const code = bins[d.contract];
    if (!code) throw new Error(`not compiled: ${d.contract}`);
    const args = d.args.map((a) => (a.ref != null ? word(addrs[a.ref]) : a.deployer ? word(DEPLOYER) : word(a.hex))).join('');
    addrs.push(await chain.deployCode(code, args));
  }
  const token = addrs[addrs.length - 1].toLowerCase();
  const pair = await chain.addPool(token, sample.tokenPool, POOL_WEI);
  for (const c of sample.setup) {
    await chain.send(token, c.sig, c.args.map((a) => (a === 'pair' ? pair : a)));
  }
  const report = await readContract('bsc', token, { rpc: chain.rpc, simulate: true, sourcify: false, simSeed: SIM_SEED });
  const code = await chain.getCode(token);
  const impl = report.proxy?.implementation;
  const logicCode = impl ? await chain.getCode(impl) : null;
  return { token, pair, report, code, logicCode };
}

/** Sparse copy of a feature map (zeros dropped, 6 significant digits). */
export function sparse(features) {
  const out = {};
  for (const [k, v] of Object.entries(features)) if (v !== 0) out[k] = Number(v.toPrecision(6));
  return out;
}

/**
 * Runs samples end to end. `marketOf(sample)` gives optional market facts.
 * @returns {Promise<{rows:Array, errors:Array}>}
 */
export async function runSamples(samples, { optimize = true, marketOf = () => null, chain = null, onRow = null } = {}) {
  const { bins, errors } = compileSamples(samples, { optimize });
  const c = chain ?? await freshChain();
  const rows = [];
  for (const s of samples) {
    if (errors.some((e) => e.id === s.id)) continue;
    try {
      const { report, code, logicCode } = await deployAndRead(c, s, bins);
      const market = marketOf(s);
      const f = extractFeatures({ report, code, logicCode, market });
      const row = {
        id: s.id, label: s.label, family: s.family, mutations: s.mutations, tell: s.tell ?? undefined, opt: optimize,
        src: 'synthetic-sol', rulesLevel: report.analysis.rulesLevel ?? report.analysis.level, level: report.analysis.level,
        sim: report.sim?.stage ?? null, findings: report.analysis.findings.map((x) => `${x.id}:${x.severity}`), f: sparse(f),
      };
      rows.push(row);
      if (onRow) onRow(row, { report, code, logicCode, sample: s });
    } catch (e) {
      errors.push({ id: s.id, error: String(e.message).slice(0, 400) });
    }
  }
  return { rows, errors };
}
