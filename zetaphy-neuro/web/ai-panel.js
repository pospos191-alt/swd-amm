// AI analyst panel (bring your own model). A separate module so the main page
// (app.js) only announces each report (a "neuro:report" event) and never
// depends on this one.
//
// Keys: typed by the user, kept in sessionStorage (until the tab closes) or,
// only if the user ticks "remember", in localStorage. Sent only from this
// browser to the provider the user picked (ai/providers.js checks the URL),
// never to this site's server. Everything shown is set with textContent.

import { runAnalyst, askAnalyst } from '../ai/analyst.js';
import { fetchVerifiedSource } from '../ai/context.js';
import { DEFAULT_MODELS, OLLAMA_URL, checkEndpoint } from '../ai/providers.js';
import { aiText } from '../ai/i18n.js';
import { CHAINS } from '../src/chains.js';
import { createRpc } from '../src/rpc.js';

const SETTINGS = 'neuro-ai-settings'; // provider, model, endpoint: not secret
const KEY = 'neuro-ai-key';           // the API key: sessionStorage, or localStorage when remembered
const store = (s) => { try { return s(); } catch { return null; } };
const session = () => store(() => globalThis.sessionStorage);
const local = () => store(() => globalThis.localStorage);
const get = (s, k) => store(() => s?.getItem(k)) ?? null;
const set = (s, k, v) => store(() => (v == null ? s?.removeItem(k) : s?.setItem(k, v)));

let report = null;
let ctx = null;
let history = [];
let busy = 0; // a counter: a stale answer (new report or new run) is dropped
let root = null;

const el = (tag, props = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'hidden') e.hidden = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
};
const lang = () => document.documentElement.lang || 'en';
const $ = (id) => document.getElementById(id);

function loadSettings() {
  let s = {};
  try { s = JSON.parse(get(local(), SETTINGS) ?? '{}') ?? {}; } catch { s = {}; }
  const provider = ['anthropic', 'openai', 'ollama'].includes(s.provider) ? s.provider : 'anthropic';
  const remembered = get(local(), KEY);
  return { provider, model: typeof s.model === 'string' ? s.model : '', endpoint: typeof s.endpoint === 'string' ? s.endpoint : '', key: get(session(), KEY) ?? remembered ?? '', remember: remembered != null };
}

function saveSettings() {
  set(local(), SETTINGS, JSON.stringify({ provider: $('ai-provider').value, model: $('ai-model').value.trim(), endpoint: $('ai-endpoint').value.trim() }));
}

function saveKey() {
  const key = $('ai-key').value.trim() || null;
  if ($('ai-remember').checked) { set(local(), KEY, key); set(session(), KEY, null); } else { set(session(), KEY, key); set(local(), KEY, null); }
}

function build() {
  const s = loadSettings();
  const provider = el('select', { id: 'ai-provider' });
  for (const p of ['anthropic', 'openai', 'ollama']) provider.add(new Option(p, p));
  provider.value = s.provider;
  const settings = el('details', { id: 'ai-settings' }, [
    el('summary', { 'data-ai': 'settings' }),
    el('label', { for: 'ai-provider', 'data-ai': 'provider' }), provider,
    el('label', { for: 'ai-endpoint', 'data-ai': 'endpoint', id: 'ai-endpoint-label' }),
    el('input', { id: 'ai-endpoint', spellcheck: 'false', autocomplete: 'off', inputmode: 'url', maxlength: '300' }),
    el('label', { for: 'ai-model', 'data-ai': 'model' }),
    el('input', { id: 'ai-model', spellcheck: 'false', autocomplete: 'off', maxlength: '100' }),
    el('label', { for: 'ai-key', 'data-ai': 'key', id: 'ai-key-label' }),
    el('input', { id: 'ai-key', type: 'password', spellcheck: 'false', autocomplete: 'off', maxlength: '300' }),
    el('label', { class: 'ai-check', id: 'ai-remember-label' }, [el('input', { id: 'ai-remember', type: 'checkbox' }), el('span', { 'data-ai': 'remember' })]),
    el('p', { class: 'ai-warn', id: 'ai-remember-warn', 'data-ai': 'rememberWarn' }),
    el('button', { type: 'button', id: 'ai-forget', 'data-ai': 'forget' }),
    el('p', { class: 'ai-help', id: 'ai-help', 'data-ai': 'ollamaHelp' }),
  ]);
  root = el('section', { id: 'ai', class: 'ai' }, [
    el('h2', {}, [el('span', { 'data-ai': 'title' }), ' ', el('span', { class: 'ai-badge', 'data-ai': 'badge' })]),
    el('p', { class: 'ai-intro', 'data-ai': 'intro' }),
    settings,
    el('button', { type: 'button', id: 'ai-run', 'data-ai': 'run' }),
    el('p', { id: 'ai-status', role: 'status', 'aria-live': 'polite' }),
    el('div', { id: 'ai-out', hidden: true }),
    el('form', { id: 'ai-ask', hidden: true, autocomplete: 'off' }, [
      el('label', { for: 'ai-question', 'data-ai': 'ask' }),
      el('input', { id: 'ai-question', maxlength: '500', spellcheck: 'true' }),
      el('button', { type: 'submit', id: 'ai-ask-go', 'data-ai': 'askBtn' }),
    ]),
    el('ol', { id: 'ai-answers' }),
  ]);
  const anchor = $('disclaimer');
  if (anchor?.parentNode) anchor.parentNode.insertBefore(root, anchor); else $('result')?.append(root);
  $('ai-model').value = s.model;
  $('ai-endpoint').value = s.endpoint;
  $('ai-key').value = s.key;
  $('ai-remember').checked = s.remember;
  provider.addEventListener('change', () => { $('ai-model').value = ''; $('ai-endpoint').value = ''; saveSettings(); showFields(); });
  $('ai-model').addEventListener('change', saveSettings);
  $('ai-endpoint').addEventListener('change', saveSettings);
  $('ai-key').addEventListener('input', saveKey);
  $('ai-remember').addEventListener('change', saveKey);
  $('ai-forget').addEventListener('click', () => {
    $('ai-key').value = ''; $('ai-remember').checked = false;
    set(local(), KEY, null); set(session(), KEY, null);
    status(aiText(lang()).forgotten);
  });
  $('ai-run').addEventListener('click', run);
  $('ai-ask').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  label();
  showFields();
}

function showFields() {
  const p = $('ai-provider').value;
  $('ai-endpoint').hidden = $('ai-endpoint-label').hidden = p === 'anthropic';
  for (const id of ['ai-key', 'ai-key-label', 'ai-remember-label', 'ai-remember-warn', 'ai-forget']) $(id).hidden = p === 'ollama';
  $('ai-help').hidden = p !== 'ollama';
  $('ai-model').placeholder = DEFAULT_MODELS[p];
  $('ai-endpoint').placeholder = p === 'ollama' ? OLLAMA_URL : 'https://…/v1';
}

function label() {
  const t = aiText(lang());
  for (const e of root.querySelectorAll('[data-ai]')) e.textContent = t[e.dataset.ai];
  const names = { anthropic: t.pAnthropic, openai: t.pOpenai, ollama: t.pOllama };
  for (const o of $('ai-provider').options) o.textContent = names[o.value];
}

function status(text, error = false) {
  $('ai-status').textContent = text;
  $('ai-status').className = error ? 'error' : '';
}

function settingsNow() {
  const provider = $('ai-provider').value;
  const endpoint = $('ai-endpoint').value.trim();
  const s = { provider, model: $('ai-model').value.trim() || DEFAULT_MODELS[provider], key: provider === 'ollama' ? '' : $('ai-key').value.trim() };
  if (provider !== 'anthropic') {
    s.baseUrl = checkEndpoint(endpoint || (provider === 'ollama' ? OLLAMA_URL : ''));
    // The key never goes to this site: refuse an endpoint on our own origin.
    if (new URL(s.baseUrl).origin === location.origin) throw new Error('the endpoint must be the model provider, not this site');
  }
  return s;
}

/** The code that runs (implementation behind a proxy), for opcode offsets; null when unavailable. */
async function codeOf(r) {
  const c = CHAINS[r.chain];
  if (!c || c.kind !== 'evm' || r.kind === 'tx' || !r.address) return null;
  try {
    return await createRpc(c.rpcs, c.id).call('eth_getCode', [r.proxy?.implementation ?? r.address, 'latest']);
  } catch { return null; }
}

function evidenceNote(list, t) {
  return el('small', { class: 'evidence', text: `${t.evidence}: ${list.join(', ')}` });
}

function renderReport(out, model, usedSource) {
  const t = aiText(lang());
  const r = out.result;
  const box = $('ai-out');
  const section = (key, items) => (items.length ? [el('h3', {}, [el('span', { text: t[key] }), ' ', el('span', { class: 'ai-badge', text: t.badge })]), el('ul', {}, items)] : []);
  const warn = [];
  if (out.contradicts) warn.push(el('p', { class: 'ai-warn ai-contradict', text: t.contradict }));
  if (r.suspicious) warn.push(el('p', { class: 'ai-warn ai-suspicious', text: t.suspicious }));
  box.replaceChildren(
    ...warn,
    el('h3', {}, [el('span', { text: t.summary }), ' ', el('span', { class: 'ai-badge', text: t.badge })]),
    el('p', { class: 'ai-summary', text: r.summary }),
    ...section('risks', r.risks.map((x) => el('li', {}, [el('b', { text: x.title }), ` ${x.detail}`, evidenceNote(x.evidence, t)]))),
    ...section('attacker', r.attackerCan.map((x) => el('li', { text: x }))),
    ...section('should', r.userShould.map((x) => el('li', { text: x }))),
    ...section('second', r.secondLook.map((x) => el('li', { class: `conf-${x.confidence}` }, [el('b', { text: x.title }), ` ${x.detail}`, el('small', { class: 'evidence', text: `${t.confidence}: ${t.conf[x.confidence]} · ${t.evidence}: ${x.evidence.join(', ')}` })]))),
    el('p', { class: 'ai-meta', text: [t.modelUsed.replace('{m}', model), usedSource ? t.sourceUsed : '', r.dropped ? t.dropped.replace('{n}', String(r.dropped)) : ''].filter(Boolean).join(' · ') }),
  );
  box.hidden = false;
  $('ai-ask').hidden = false;
}

async function run() {
  const t = aiText(lang());
  if (!report) return;
  let settings;
  try { settings = settingsNow(); } catch (e) { status(t.failed + e.message, true); return; }
  if (settings.provider !== 'ollama' && !settings.key) { status(t.noKey, true); $('ai-settings').open = true; return; }
  const mine = ++busy;
  const r = report;
  $('ai-run').disabled = true;
  status(t.running);
  try {
    const code = await codeOf(r);
    const source = r.source && r.chainId ? await fetchVerifiedSource(r.chainId, r.proxy?.implementation ?? r.address) : null;
    const out = await runAnalyst(r, settings, { lang: lang(), code, source });
    if (mine !== busy || r !== report) return;
    ctx = out.ctx;
    history = [];
    $('ai-answers').replaceChildren();
    renderReport(out, out.model, !!source);
    status('');
  } catch (e) {
    if (mine === busy) status(t.failed + e.message, true);
  } finally {
    if (mine === busy) $('ai-run').disabled = false;
  }
}

async function ask() {
  const t = aiText(lang());
  const q = $('ai-question').value.trim();
  if (!q || !ctx || !report) return;
  let settings;
  try { settings = settingsNow(); } catch (e) { status(t.failed + e.message, true); return; }
  const mine = ++busy;
  const r = report;
  $('ai-ask-go').disabled = true;
  status(t.running);
  try {
    const out = await askAnalyst(ctx, r, settings, { question: q, history, lang: lang() });
    if (mine !== busy || r !== report) return;
    history.push({ q, a: out.result.answer });
    const li = el('li', {}, [
      el('p', { class: 'ai-q', text: q }),
      ...(out.contradicts ? [el('p', { class: 'ai-warn ai-contradict', text: t.contradict })] : []),
      ...(out.result.suspicious ? [el('p', { class: 'ai-warn ai-suspicious', text: t.suspicious })] : []),
      el('p', {}, [el('span', { class: 'ai-badge', text: t.badge }), ' ', out.result.answer]),
      el('small', { class: 'evidence', text: `${t.confidence}: ${t.conf[out.result.confidence]}${out.result.evidence.length ? ` · ${t.evidence}: ${out.result.evidence.join(', ')}` : ''}` }),
    ]);
    $('ai-answers').append(li);
    $('ai-question').value = '';
    status('');
  } catch (e) {
    if (mine === busy) status(t.failed + e.message, true);
  } finally {
    $('ai-ask-go').disabled = false;
  }
}

// A new report: a fresh panel state (the settings and key stay).
addEventListener('neuro:report', (e) => {
  const r = e.detail?.report;
  if (!r || r === report) return;
  if (!root) build();
  report = r;
  ctx = null;
  history = [];
  busy++;
  $('ai-run').disabled = false;
  $('ai-out').hidden = true;
  $('ai-out').replaceChildren();
  $('ai-ask').hidden = true;
  $('ai-answers').replaceChildren();
  status('');
});

// The page's language menu sets <html lang>: relabel the panel when it changes.
new MutationObserver(() => { if (root) label(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
