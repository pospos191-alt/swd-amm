// Neuro ML: combining the learned risk score with the fixed rules.
//
// The rules stay the authority:
//  - the model can RAISE the shown level, never lower it (a "high" from the
//    rules stays "high" whatever the model says);
//  - for an official issuer's contract or a registered template (rules say
//    "good"), the model may raise to "low" at most: identity is the rules' call;
//  - the network verdict (src/verdict.js) and reportHash never include the
//    model: `rulesLevel` is pinned to what the rules (without the trade
//    simulation) decided, and no finding is added. The score lives in `ml`.

import { explainPrediction, modelLevel } from './model.js';
import { headProbability, checkHead } from './fl/head.js';
import { extractFeatures } from './features.js';
import { featureLabel } from './features.js';

export const RANK = { info: 0, good: 0, low: 1, medium: 2, high: 3 };
const LEVELS = ['info', 'low', 'medium', 'high'];
const maxLevel = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

/**
 * @param {object} analysis  report.analysis from Neuro (rules + optional simulation)
 * @param {{p:number, level:string|null, top?:Array}|null} ml  from scoreReport(); null = no model
 * @returns {object} a copy of analysis with `level` possibly raised, `rulesLevel` pinned, and `ml`
 */
export function combine(analysis, ml) {
  const rulesLevel = analysis.rulesLevel ?? analysis.level;
  if (!ml) return { ...analysis, rulesLevel };
  const identityGood = (analysis.findings ?? []).some((f) => f.id === 'known-issuer' || f.id === 'template-match');
  let raise = ml.level ?? 'info';
  if (identityGood && RANK[raise] > RANK.low) raise = 'low';
  const level = maxLevel(analysis.level, raise);
  return {
    ...analysis,
    level: LEVELS.includes(level) ? level : analysis.level,
    rulesLevel,
    ml: { ...ml, raised: RANK[level] > RANK[analysis.level] },
  };
}

/**
 * Scores a readContract() report with a model.
 * @param {object} model  parsed ml/model.json
 * @param {object} report
 * @param {{code?:string, logicCode?:string, market?:object, top?:number, lang?:'en'|'th', head?:object}} [opts]
 *   head: a federated head (ml/fl/head.json) for this model; it changes p (and so the level), while
 *   `top` still explains the trees. A head for another model is refused.
 */
export function scoreReport(model, report, opts = {}) {
  const features = extractFeatures({ report, code: opts.code, logicCode: opts.logicCode, market: opts.market });
  const e = explainPrediction(model, features);
  const head = opts.head ? checkHead(model, opts.head) : null;
  const p = head ? headProbability(model, head, features) : e.p;
  const lang = opts.lang === 'th' ? 'th' : 'en';
  const top = e.contributions.slice(0, opts.top ?? 5).map((c) => ({
    feature: c.feature,
    label: featureLabel(c.feature)[lang],
    value: Math.round(c.value * 1000) / 1000,
    effect: Math.round(c.logit * 1000) / 1000, // + raises the risk, - lowers it (calibrated logit units)
  }));
  const out = { model: model.id, p: Math.round(p * 10000) / 10000, level: modelLevel(model, p), top };
  if (head) out.head = head.id;
  return out;
}

/** Report with the model's opinion folded in (never lower than the rules). */
export function withModel(model, report, opts = {}) {
  if (!report?.analysis || !model) return report;
  return { ...report, analysis: combine(report.analysis, scoreReport(model, report, opts)) };
}
