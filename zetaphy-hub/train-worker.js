// "Useful work → training" (work.js starts it): one Web Worker that runs a practice training job of the
// training market (docs/future/useful-work-training.md) and nothing else; closing or leaving the page ends it.
//   in:  { train: { seed?, checks? } }
//   out: { phase: 'base' | 'train' | 'check' | 'eval', segment?, of? }  progress
//        { done: { root, treesHash, segments, rows, verified: [{ segment, ok }], metrics, candidate, base, ms } }
//        { error }
// The code is train-core.js, the same the runners (zetaphy-network/src/trainwork) run: integer randomness and
// + - * / only, so this browser's checkpoint root is bit for bit the one Node computes (the e2e test checks it).
import { keccak256 } from './neuro/src/keccak.js';
import { practiceJob } from './train-core.js';

onmessage = ({ data }) => {
  if (!data?.train) return;
  try {
    const t0 = Date.now();
    const r = practiceJob(keccak256, { seed: data.train.seed ?? 'practice', checks: data.train.checks ?? 2, on: (e) => postMessage(e) });
    postMessage({ done: { ...r, ms: Date.now() - t0 } });
  } catch (e) {
    postMessage({ error: String(e?.message ?? e) });
  }
};
