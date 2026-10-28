// Evaluation metrics for the risk model. All deterministic.

/** ROC AUC (ties count half). */
export function auc(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b] || a - b);
  let rankSum = 0; let pos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[idx[k]]) { rankSum += avg; pos++; }
    i = j + 1;
  }
  const neg = y.length - pos;
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/**
 * Recall at a fixed false-positive rate: the threshold is the lowest score
 * that keeps the share of benign rows at or above it <= fpr.
 */
export function recallAtFpr(scores, y, fpr) {
  const neg = scores.filter((_, i) => !y[i]).sort((a, b) => b - a);
  const pos = scores.filter((_, i) => y[i]);
  if (!neg.length || !pos.length) return { recall: null, threshold: null, fpr: null };
  const allowed = Math.floor(fpr * neg.length);
  // threshold strictly above the (allowed)-th highest benign score
  const t = allowed < neg.length ? neg[allowed] : -Infinity;
  const recall = pos.filter((s) => s > t).length / pos.length;
  const realFpr = neg.filter((s) => s > t).length / neg.length;
  return { recall, threshold: t, fpr: realFpr };
}

export function brier(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2;
  return s / p.length;
}

export function logloss(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(Math.max(p[i], 1e-12), 1 - 1e-12);
    s -= y[i] ? Math.log(q) : Math.log(1 - q);
  }
  return s / p.length;
}

/** Expected calibration error over equal-width bins. */
export function ece(p, y, bins = 10) {
  const n = new Array(bins).fill(0); const conf = new Array(bins).fill(0); const acc = new Array(bins).fill(0);
  for (let i = 0; i < p.length; i++) {
    const b = Math.min(bins - 1, Math.floor(p[i] * bins));
    n[b]++; conf[b] += p[i]; acc[b] += y[i];
  }
  let e = 0;
  for (let b = 0; b < bins; b++) if (n[b]) e += (n[b] / p.length) * Math.abs(conf[b] / n[b] - acc[b] / n[b]);
  return e;
}

const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

/** The metric set reported for a model on one labelled set of probabilities. */
export function evaluate(p, y) {
  const at1 = recallAtFpr(p, y, 0.01);
  const at5 = recallAtFpr(p, y, 0.05);
  const pos = y.reduce((s, v) => s + v, 0);
  return {
    n: y.length, positives: pos, negatives: y.length - pos,
    auc: r4(auc(p, y)),
    recallAt1Fpr: r4(at1.recall), thresholdAt1Fpr: r4(at1.threshold),
    recallAt5Fpr: r4(at5.recall), thresholdAt5Fpr: r4(at5.threshold),
    brier: r4(brier(p, y)), logloss: r4(logloss(p, y)), ece: r4(ece(p, y)),
  };
}
