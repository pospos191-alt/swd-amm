// Neuro's flagged-code dataset, for "similar to flagged code" warnings
// (src/similarity.js). Versioned with the code: the skill id hashes every
// file in src/, so changing this list is a new skill that runners vote in
// (NeuroControl.approveSkill) before any verdict depends on it.
//
// The ThreatRegistry on ZETAPHY stores only fp1 keys, not code, so it cannot
// say what flagged code LOOKED like. Each entry here does: an fp1 key plus a
// compact signature (distinctive selectors + MinHash of opcode 4-grams).
//
// Adding a flagged contract:
//   node cli.js signature <evm chain> <address> --reason cannot-sell-in-simulation
// (--reason: a ThreatRegistry code fact, src/threat-reasons.js)
// and paste the printed entry into ADDED below, then propose the new skill.
// Entries made against an older baseline are skipped (rebuild them).

import { BASELINE, SEEDS } from './threat-signatures.generated.js';
import { loadBaseline } from './similarity.js';

export const THREAT_SIGNATURES_VERSION = 1;

// Entries for real flagged contracts, from `node cli.js signature`.
export const ADDED = [
];

/** {baseline, entries} as closestFlagged() takes it. */
export const THREAT_SIGNATURES = {
  version: THREAT_SIGNATURES_VERSION,
  baseline: loadBaseline(BASELINE),
  entries: [...SEEDS, ...ADDED],
};
