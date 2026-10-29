// Neuro federated learning: the gate a candidate head passes before it may be
// proposed to governance.
//
// Poisoning that survives the trimmed mean would most likely try to LOWER
// scores of real scams (an attacker wants its token to look fine). The gate
// replays labelled canary rows nobody can submit to: the recorded red-team
// evasions the current model catches (ml/data/redteam/evasions.jsonl minus
// known-gaps.json) and, in CI, the held-out rows of the synthetic corpus.
//  - every row marked `strict` (a recorded evasion the current model catches)
//    that the current head shows at medium+ must stay medium+;
//  - on all rows, recall at the medium threshold must not fall by more than
//    `maxRecallDrop` and the false-alarm rate must not rise by more than
//    `maxFprRise`.

import { headProbability } from './head.js';

/**
 * @param {object} model
 * @param {object} current  current head (zeroHead() for the plain model)
 * @param {object} candidate
 * @param {Array<{id?:string, f:object, label:0|1, strict?:boolean}>} rows
 * @returns {{ok:boolean, reasons:string[], stats:object}}
 */
export function gateHead(model, current, candidate, rows, { maxFprRise = 0.1, maxRecallDrop = 0.01 } = {}) {
  const th = model.thresholds?.medium ?? 0.8;
  const reasons = [];
  let pos = 0; let neg = 0; let tpC = 0; let tpN = 0; let fpC = 0; let fpN = 0;
  const lost = [];
  for (const r of rows) {
    const pc = headProbability(model, current, r.f);
    const pn = headProbability(model, candidate, r.f);
    if (r.label === 1) {
      pos++;
      if (pc >= th) tpC++;
      if (pn >= th) tpN++;
      if (r.strict && pc >= th && pn < th) lost.push(r.id ?? '?');
    } else {
      neg++;
      if (pc >= th) fpC++;
      if (pn >= th) fpN++;
    }
  }
  const recallC = pos ? tpC / pos : 1;
  const recallN = pos ? tpN / pos : 1;
  const fprC = neg ? fpC / neg : 0;
  const fprN = neg ? fpN / neg : 0;
  if (lost.length) reasons.push(`${lost.length} recorded evasion(s) fell below medium: ${lost.slice(0, 5).join(', ')}`);
  if (recallN < recallC - maxRecallDrop - 1e-12) reasons.push(`recall fell ${recallC.toFixed(3)} -> ${recallN.toFixed(3)}`);
  if (fprN > fprC + maxFprRise + 1e-12) reasons.push(`false alarms rose ${fprC.toFixed(3)} -> ${fprN.toFixed(3)}`);
  return { ok: reasons.length === 0, reasons, stats: { pos, neg, recallC, recallN, fprC, fprN, lost: lost.length } };
}
