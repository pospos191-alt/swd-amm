// What the AI analyst must answer, and the check every answer passes before
// it is shown or signed. The schema goes to the provider (structured output
// where supported); the validator runs on our side whatever the provider did,
// because a model that read hostile text may answer anything.
//
// The validator:
//   - accepts only the known fields and types, cuts every string to a limit
//     and cleans it (ai/sanitize.js modelText: no invisible characters, no
//     live links, no markup);
//   - keeps a risk or a "second look" finding only if it cites at least one
//     evidence id that exists in the context it was given (F3, SEL:0x…,
//     OP:0x…, SIM, SRC1:L20, U1, META:owner);
//   - never produces a verdict: the level shown is always the fixed rules'
//     (contradictsRules() flags an answer that reads as "safe" against them).

import { modelText, looksLikeInjection } from './sanitize.js';

export const AGREEMENT = ['agrees', 'more-concerned', 'less-concerned'];
export const CONFIDENCE = ['low', 'medium', 'high'];

const str = { type: 'string' };
const evid = { type: 'array', items: str };
const item = (extra = {}, req = []) => ({
  type: 'object', additionalProperties: false,
  required: ['title', 'detail', 'evidence', ...req],
  properties: { title: str, detail: str, evidence: evid, ...extra },
});

/** JSON Schema of the analyst report (sent as the provider's output format). */
export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'agreement', 'risks', 'attackerCan', 'userShould', 'secondLook'],
  properties: {
    summary: str,
    agreement: { type: 'string', enum: AGREEMENT },
    risks: { type: 'array', items: item() },
    attackerCan: { type: 'array', items: str },
    userShould: { type: 'array', items: str },
    secondLook: { type: 'array', items: item({ confidence: { type: 'string', enum: CONFIDENCE } }, ['confidence']) },
  },
};

/** JSON Schema of an answer to a follow-up question. */
export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['answer', 'confidence', 'evidence'],
  properties: { answer: str, confidence: { type: 'string', enum: CONFIDENCE }, evidence: evid },
};

export const LIMITS = { summary: 1200, title: 120, detail: 600, line: 300, answer: 1500, risks: 8, lines: 6, secondLook: 6, evidence: 6 };

/** Is `e` an evidence id present in this context? Returns its normal form or null. */
export function checkEvidence(e, ctx) {
  const s = String(e ?? '').trim().replace(/\s+/g, '');
  if (!s || s.length > 40) return null;
  const op = /^OP:0x([0-9a-f]+)$/i.exec(s);
  if (op) { const n = `OP:0x${op[1].toLowerCase().replace(/^0+(?=.)/, '')}`; return ctx.evidence.has(n) ? n : null; }
  const sel = /^SEL:0x([0-9a-f]{8})$/i.exec(s);
  if (sel) { const n = `SEL:0x${sel[1].toLowerCase()}`; return ctx.evidence.has(n) ? n : null; }
  const src = /^SRC(\d{1,3}):L(\d{1,6})(?:-L?(\d{1,6}))?$/i.exec(s);
  if (src) {
    const shown = ctx.sourceLines?.get(Number(src[1]));
    const from = Number(src[2]);
    const to = src[3] ? Number(src[3]) : from;
    if (!shown || to < from || to - from > 200) return null;
    for (let n = from; n <= to; n++) if (shown.has(n)) return `SRC${src[1]}:L${from}${to !== from ? `-L${to}` : ''}`;
    return null;
  }
  return ctx.evidence.has(s) ? s : null;
}

const evidenceList = (v, ctx) => (Array.isArray(v) ? [...new Set(v.map((e) => checkEvidence(e, ctx)).filter(Boolean))].slice(0, LIMITS.evidence) : []);
const text = (v, max) => (typeof v === 'string' ? modelText(v, max) : '');
const enumOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

/**
 * Parses a model's raw text as JSON. Accepts a bare object, or one wrapped in
 * a ```json fence or surrounded by prose (small local models do that).
 */
export function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '').trim();
  try { return JSON.parse(s); } catch { /* try harder */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* next */ } }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fail below */ } }
  throw new Error('the model did not answer with JSON');
}

/**
 * Validates and cleans an analyst report against the context it was made from.
 * @returns {{summary:string, agreement:string, risks:Array, attackerCan:string[], userShould:string[], secondLook:Array, dropped:number, suspicious:boolean}}
 */
export function validateReport(raw, ctx) {
  const o = parseJson(raw);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('the AI answer is not an object');
  if (typeof o.summary !== 'string' || !o.summary.trim()) throw new Error('the AI answer has no summary');
  let dropped = 0;
  const items = (list, max, withConfidence) => (Array.isArray(list) ? list : []).slice(0, max).flatMap((x) => {
    if (!x || typeof x !== 'object') { dropped++; return []; }
    const evidence = evidenceList(x.evidence, ctx);
    const title = text(x.title, LIMITS.title);
    if (!evidence.length || !title) { dropped++; return []; }
    return [{ title, detail: text(x.detail, LIMITS.detail), evidence, ...(withConfidence ? { confidence: enumOf(x.confidence, CONFIDENCE, 'low') } : {}) }];
  });
  const lines = (list) => (Array.isArray(list) ? list : []).slice(0, LIMITS.lines).map((x) => text(x, LIMITS.line)).filter(Boolean);
  const out = {
    summary: text(o.summary, LIMITS.summary),
    agreement: enumOf(o.agreement, AGREEMENT, 'agrees'),
    risks: items(o.risks, LIMITS.risks, false),
    attackerCan: lines(o.attackerCan),
    userShould: lines(o.userShould),
    secondLook: items(o.secondLook, LIMITS.secondLook, true),
  };
  out.dropped = dropped;
  out.suspicious = [out.summary, ...out.attackerCan, ...out.userShould, ...out.risks.map((r) => r.detail), ...out.secondLook.map((r) => r.detail)].some(looksLikeInjection);
  return out;
}

/** Validates and cleans an answer to a follow-up question. */
export function validateAnswer(raw, ctx) {
  const o = parseJson(raw);
  if (!o || typeof o !== 'object' || typeof o.answer !== 'string' || !o.answer.trim()) throw new Error('the AI answer has no text');
  const answer = text(o.answer, LIMITS.answer);
  return { answer, confidence: enumOf(o.confidence, CONFIDENCE, 'low'), evidence: evidenceList(o.evidence, ctx), suspicious: looksLikeInjection(answer) };
}

// "It is safe", "no risk", "safe to buy" and the same in Neuro's other languages.
const SAFE_CLAIM = /\b(is|looks|seems|appears)\s+(completely\s+|totally\s+|perfectly\s+|100%\s+)?(safe|legit(imate)?|trustworthy)\b|\bno\s+(real\s+)?risks?\b|\bsafe\s+to\s+(buy|invest|hold|use)\b|\bnot\s+a\s+(scam|honeypot)\b|(?<!ไม่)ปลอดภัย|(?<!不)安全的?(代币|合约)?$|es\s+segur[oa]|안전합니다|安全です|безопасен|an\s+toàn\s+để|\baman\s+untuk\b/im;

/**
 * True when the AI's text reads as more reassuring than the fixed rules
 * allow. The page then shows that the rules' level stands; nothing the AI
 * says changes the level, the verdict or the reportHash.
 */
export function contradictsRules(result, level) {
  if (!['high', 'medium'].includes(level)) return false;
  if (result.agreement === 'less-concerned') return true;
  const t = 'answer' in result ? result.answer : result.summary;
  return SAFE_CLAIM.test(String(t ?? ''));
}
