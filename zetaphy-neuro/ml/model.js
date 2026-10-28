// Neuro ML, stage 2: inference for the exported model (ml/model.json).
//
// Plain JS, no dependencies: runs the same in a browser, a Neuro runner and
// Node. The model is gradient-boosted decision trees (logistic loss) with a
// Platt calibration on top. Each tree is a flat array of nodes
// [feature, threshold, left, right, value]; a leaf has feature -1. A row
// goes left when x[feature] <= threshold.
//
// Every internal node also stores the value its subtree would predict, so
// the logit splits exactly into bias + a sum of per-feature contributions
// (the path attribution of Saabas): that is the "why" shown to users.

const NODE = 5;

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Throws on a model this code cannot run. */
export function checkModel(model) {
  if (!model || model.format !== 'neuro-ml-gbdt/1') throw new Error('unsupported model format');
  if (!Array.isArray(model.features) || !Array.isArray(model.trees)) throw new Error('bad model');
  for (const t of model.trees) {
    if (!Array.isArray(t) || t.length % NODE !== 0 || t.length === 0) throw new Error('bad tree');
  }
  return model;
}

/** Named features (or a vector in model.features order) -> vector in model order. */
function vectorOf(model, x) {
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return x;
  return model.features.map((n) => (Number.isFinite(x[n]) ? x[n] : 0));
}

/** Raw margin (logit before calibration). Exactly what the trainer computes. */
export function margin(model, x) {
  const v = vectorOf(model, x);
  let z = model.base;
  for (const t of model.trees) {
    let i = 0;
    while (t[i] >= 0) i = (v[t[i]] <= t[i + 1] ? t[i + 2] : t[i + 3]) * NODE;
    z += t[i + 4];
  }
  return z;
}

/** Calibrated probability of "risky". */
export function probability(model, x) {
  const z = margin(model, x);
  const c = model.calib ?? { a: 1, b: 0 };
  return sigmoid(c.a * z + c.b);
}

/**
 * Probability plus the features that pushed it up or down.
 * @returns {{p:number, margin:number, bias:number, contributions:Array<{feature:string, value:number, logit:number}>}}
 *   contributions sorted by |logit| (calibrated logit units), all non-zero ones
 */
export function explainPrediction(model, x) {
  const v = vectorOf(model, x);
  const contrib = new Float64Array(model.features.length);
  let bias = model.base;
  let z = model.base;
  for (const t of model.trees) {
    bias += t[4];
    let i = 0;
    while (t[i] >= 0) {
      const f = t[i];
      const next = (v[f] <= t[i + 1] ? t[i + 2] : t[i + 3]) * NODE;
      contrib[f] += t[next + 4] - t[i + 4];
      i = next;
    }
    z += t[i + 4];
  }
  const c = model.calib ?? { a: 1, b: 0 };
  const contributions = [];
  for (let f = 0; f < contrib.length; f++) {
    if (contrib[f] !== 0) contributions.push({ feature: model.features[f], value: v[f], logit: contrib[f] * c.a });
  }
  contributions.sort((p, q) => Math.abs(q.logit) - Math.abs(p.logit) || (p.feature < q.feature ? -1 : 1));
  return { p: sigmoid(c.a * z + c.b), margin: z, bias: c.a * bias + c.b, contributions };
}

/** Level the model alone would give: the highest threshold its probability reaches, else null. */
export function modelLevel(model, p) {
  const th = model.thresholds ?? {};
  for (const level of ['high', 'medium', 'low']) if (th[level] != null && p >= th[level]) return level;
  return null;
}
