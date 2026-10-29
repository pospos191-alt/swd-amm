// "Do useful work": one Web Worker (work.js starts and stops it). It only does the job the page
// gives it and nothing on its own; closing or leaving the page ends it.
//   in:  { scan: { id, chain, target, code?, codeHash } }  Neuro's code-only rules scan of one contract
//        { fuzz: { spec, specText, seed, runs, corpus? } }  a coverage-guided bug hunt on a bounty's spec
//   out: { id, verdict, level, findings }  |  { id, error }
//        { fuzzRuns, coverage, corpus }  every 50 sequences;
//        { found, kinds, violations, profit, runs, repro }  for each new kind of bug (the hunt goes on);
//        { fuzzDone, runs, coverage, findings, corpus }  at the end  |  { error }
// Neuro's reader comes from ./neuro/src/ (the same code the runners use); the EVM for the hunt from
// ./vendor/evm.js, loaded only when a hunt starts.
import { readContract } from './neuro/src/reader.js';
import { verdictOf } from './neuro/src/verdict.js';
import { keccak256 } from './neuro/src/keccak.js';
import { CHAINS } from './neuro/src/chains.js';
import { createRpc } from './neuro/src/rpc.js';
import { codeVerdict, scanChain } from './work-core.js';
import { fuzz, reproducer } from './fuzz-core.js';

const neuro = { readContract, verdictOf, keccak256, CHAINS };

async function scan({ id, chain, target, code, codeHash }) {
  try {
    if (!code) {
      // another chain: read the code from Neuro's public RPCs for it (the page reads ZETAPHY itself)
      const cfg = scanChain(chain, CHAINS);
      if (!cfg || !cfg.rpcs?.length) throw new Error(`chain ${chain}: no RPC`);
      code = await createRpc(cfg.rpcs, cfg.id).call('eth_getCode', [target, 'latest']);
    }
    const { verdict, report } = await codeVerdict(neuro, { chain, target, code, codeHash });
    const a = report.analysis ?? {};
    postMessage({ id, verdict, level: a.rulesLevel ?? a.level ?? null, findings: (a.findings ?? []).map((f) => `${f.id}:${f.severity}`) });
  } catch (e) {
    postMessage({ id, error: String(e?.message ?? e) });
  }
}

async function hunt({ spec, specText, seed, runs, corpus }) {
  try {
    const m = await import('./vendor/evm.js');
    const lib = { ...m, keccak256 };
    const res = await fuzz(lib, spec, {
      seed, runs, corpus: corpus ?? [], stopOnFirst: false,
      onProgress: (p) => postMessage({ fuzzRuns: p.runs, coverage: p.coverage, corpus: p.corpus }),
      onFinding: async (f) => {
        const repro = await reproducer(lib, spec, specText ?? null, { finding: f.finding, seed, runs: f.run });
        postMessage({ found: f.finding, kinds: f.kinds, violations: f.violations, profit: String(f.profit), runs: f.run, coverage: f.coverage, repro: JSON.stringify(repro, null, 1) });
      },
    });
    postMessage({ fuzzDone: true, runs: res.runs, coverage: res.coverage, findings: res.findings.length, corpus: res.corpus.map((c) => ({ steps: c.steps })) });
  } catch (e) {
    postMessage({ error: String(e?.message ?? e) });
  }
}

onmessage = ({ data }) => {
  if (data?.scan) scan(data.scan);
  else if (data?.fuzz) hunt(data.fuzz);
};
