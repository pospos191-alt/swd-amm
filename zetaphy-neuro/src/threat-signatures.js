// Neuro's similarity dataset, for "similar to flagged code" warnings
// (src/similarity.js). Versioned with the code: the skill id hashes every
// file in src/, so changing this list is a new skill that runners vote in
// (NeuroControl.approveSkill) before any verdict depends on it.
//
// It ships EMPTY: no contract has been flagged by runners yet, and test
// contracts are not flagged code. (The test suite uses its own reference
// samples, test/fixtures/reference-samples.generated.js.)
//
// The ThreatRegistry on ZETAPHY stores only keys, not code, so it cannot say
// what flagged code LOOKED like. Each entry here does: an fp1 key plus a
// compact signature (distinctive selectors + MinHash of opcode 4-grams), and
// its provenance:
//   flag: { key, reportHash }   the ThreatRegistry key the code is flagged
//                               under and the reportHash of the flag's evidence
//                               (both 0x + 32 bytes). Only entries with this
//                               reference are shown as "flagged by Neuro
//                               runners"; an entry without it (flag: null) is
//                               shown as "similar to a reference sample".
//
// Adding a flagged contract:
//   node cli.js signature <evm chain> <address> --reason cannot-sell-in-simulation \
//     --flag-key 0x<ThreatRegistry key> --report-hash 0x<evidence reportHash>
// (--reason: a ThreatRegistry code fact, src/threat-reasons.js; check the flag
// with evidenceOf(key) on the ThreatRegistry first) and paste the printed entry
// into ADDED below, then propose the new skill.
// Entries made against an older baseline are skipped (rebuild them).

import { BASELINE } from './threat-signatures.generated.js';
import { loadBaseline } from './similarity.js';

export const THREAT_SIGNATURES_VERSION = 2;

// Entries for real flagged contracts, from `node cli.js signature`.
export const ADDED = [
];

/** {baseline, entries} as closestFlagged() takes it. */
export const THREAT_SIGNATURES = {
  version: THREAT_SIGNATURES_VERSION,
  baseline: loadBaseline(BASELINE),
  entries: [...ADDED],
};
