// Model providers for the AI analyst. Every call goes from the user's own
// machine (browser or runner) straight to the provider the user chose, with
// the user's own key. Neuro's server never sees the key, the prompt or the
// answer, and there is no server-held key.
//
//   anthropic  https://api.anthropic.com/v1/messages (browser CORS needs the
//              anthropic-dangerous-direct-browser-access header)
//   openai     any OpenAI-compatible /chat/completions endpoint (https, or
//              http on this machine only)
//   ollama     a local Ollama, OpenAI-compatible at http://localhost:11434/v1

import { modelText } from './sanitize.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o-mini', ollama: 'qwen2.5-coder:7b' };
export const OLLAMA_URL = 'http://localhost:11434/v1';
// Server-side refusal fallback (a security review can trip a classifier): only these models take it.
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ProviderError extends Error {}

/**
 * An endpoint the key may be sent to: https anywhere, or plain http only to
 * this machine. No user:password@ in the URL. Returns the URL without a
 * trailing slash, or throws.
 */
export function checkEndpoint(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { throw new ProviderError('endpoint is not a URL'); }
  if (u.username || u.password) throw new ProviderError('endpoint must not contain a user name or password');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
    throw new ProviderError('endpoint must be https, or http on this machine (localhost)');
  }
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

/** A model id: letters, digits and . _ : / - only (it ends up in a JSON body and in logs). */
export function checkModel(model) {
  const m = String(model ?? '').trim();
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(m)) throw new ProviderError('model name: letters, digits and . _ : / - only');
  return m;
}

async function post(fetchImpl, url, headers, body, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onAbort);
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw new ProviderError(ctrl.signal.aborted ? 'the model took too long or was stopped' : `could not reach the model (${modelText(e?.message ?? 'network error', 120)})`);
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.error ?? '';
      const why = res.status === 401 || res.status === 403 ? 'the provider refused the key' : res.status === 429 ? 'rate limited by the provider' : `HTTP ${res.status}`;
      throw new ProviderError(`${why}${msg ? `: ${modelText(typeof msg === 'string' ? msg : JSON.stringify(msg), 200)}` : ''}`);
    }
    if (!json) throw new ProviderError('the provider did not answer with JSON');
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Anthropic Messages API, called directly with the user's key. Returns the text the model wrote. */
export async function callAnthropic({ key, model = DEFAULT_MODELS.anthropic, system, user, schema, fetchImpl = globalThis.fetch, url = ANTHROPIC_URL, timeoutMs = 180_000, signal, maxTokens = 16000 }) {
  if (!key) throw new ProviderError('no API key');
  const m = checkModel(model);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': String(key).trim(),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = { model: m, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  if (schema) body.output_config = { format: { type: 'json_schema', schema } };
  if (FALLBACK_MODELS.has(m)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  const json = await post(fetchImpl, checkEndpoint(url), headers, body, timeoutMs, signal);
  if (json.stop_reason === 'refusal') throw new ProviderError('the model declined to review this contract');
  if (json.stop_reason === 'max_tokens') throw new ProviderError('the answer was cut off (max tokens)');
  const text = (json.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
  if (!text) throw new ProviderError('the model returned no text');
  return { text, model: typeof json.model === 'string' ? json.model : m };
}

/** OpenAI-compatible /chat/completions (OpenAI, OpenRouter, LM Studio, Ollama's /v1, …). */
export async function callOpenAICompatible({ baseUrl, key = '', model, system, user, fetchImpl = globalThis.fetch, timeoutMs = 300_000, signal, json = true }) {
  const base = checkEndpoint(baseUrl);
  const m = checkModel(model);
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${String(key).trim()}`;
  const body = { model: m, stream: false, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (json) body.response_format = { type: 'json_object' };
  const out = await post(fetchImpl, `${base}/chat/completions`, headers, body, timeoutMs, signal);
  const choice = out.choices?.[0];
  if (choice?.finish_reason === 'length') throw new ProviderError('the answer was cut off (max tokens)');
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text) throw new ProviderError('the model returned no text');
  return { text, model: typeof out.model === 'string' ? out.model : m };
}

/**
 * One entry point for every provider.
 * @param {{provider:'anthropic'|'openai'|'ollama', key?:string, model?:string, baseUrl?:string}} settings
 */
export function complete(settings, { system, user, schema, fetchImpl, signal, timeoutMs }) {
  const p = settings?.provider;
  if (p === 'anthropic') return callAnthropic({ key: settings.key, model: settings.model || DEFAULT_MODELS.anthropic, system, user, schema, fetchImpl, signal, ...(timeoutMs ? { timeoutMs } : {}) });
  if (p === 'openai' || p === 'ollama') {
    return callOpenAICompatible({
      baseUrl: settings.baseUrl || (p === 'ollama' ? OLLAMA_URL : ''), key: p === 'ollama' ? '' : settings.key,
      model: settings.model || DEFAULT_MODELS[p], system, user, fetchImpl, signal, ...(timeoutMs ? { timeoutMs } : {}),
    });
  }
  throw new ProviderError('choose a provider');
}
