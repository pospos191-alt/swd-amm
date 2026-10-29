// The AI analyst: context -> prompt -> the user's own model -> validated JSON.
// Used by the web page (web/ai-panel.js) and by runners (zetaphy-network
// src/llmreview.js). Advisory only: the result never changes Neuro's level,
// findings, verdict or reportHash.

import { buildContext } from './context.js';
import { buildPrompt } from './prompt.js';
import { REPORT_SCHEMA, ANSWER_SCHEMA, validateReport, validateAnswer, contradictsRules } from './schema.js';
import { complete } from './providers.js';

/** Context budget by provider: small local models get a smaller window. */
export const BUDGETS = { anthropic: 9000, openai: 7000, ollama: 2800, browser: 6000 };

/**
 * @param {object} report  Neuro report
 * @param {object} settings  {provider, key?, model?, baseUrl?}
 * @param {object} [opts]  {lang, code, source, knowledge, fetchImpl, signal, budgetTokens, ctx}
 *   knowledge: on-chain records about this contract (ai/onchain.js lookup()), an extra evidence source
 * @returns {Promise<{ctx:object, result:object, model:string, level:string, contradicts:boolean}>}
 */
export async function runAnalyst(report, settings, { lang = 'en', code = null, source = null, knowledge = null, fetchImpl, signal, budgetTokens, ctx = null, timeoutMs } = {}) {
  const c = ctx ?? buildContext(report, { code, source, knowledge, budgetTokens: budgetTokens ?? BUDGETS[settings?.provider] ?? 6000 });
  const { system, user } = buildPrompt(c, { task: 'report', lang });
  const out = await complete(settings, { system, user, schema: REPORT_SCHEMA, fetchImpl, signal, timeoutMs, local: { task: 'report', ctx: c, report, lang, code } });
  const result = validateReport(out.text, c);
  const level = report?.analysis?.level ?? 'info';
  return { ctx: c, result, model: out.model, level, contradicts: contradictsRules(result, level) };
}

/** A follow-up question about the same contract (same context). */
export async function askAnalyst(ctx, report, settings, { question, history = [], lang = 'en', fetchImpl, signal, timeoutMs } = {}) {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('empty question');
  const { system, user } = buildPrompt(ctx, { task: 'answer', lang, question: q, history });
  const out = await complete(settings, { system, user, schema: ANSWER_SCHEMA, fetchImpl, signal, timeoutMs, local: { task: 'answer', ctx, report, lang, question: q } });
  const result = validateAnswer(out.text, ctx);
  const level = report?.analysis?.level ?? 'info';
  return { result, model: out.model, level, contradicts: contradictsRules(result, level) };
}
