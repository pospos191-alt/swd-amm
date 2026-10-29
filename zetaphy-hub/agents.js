// The Agents page (a data page of pages.js): AI agents on ZETAPHY, testnet.
//  1. Proof of Intent: pick a template (swap, send, stake, approve with a cap, bridge) and fill it in, or say
//     what you want and let a model of YOUR choice (Neuro's AI layer, bring your own key) draft the fields.
//     The form is validated strictly (intent-core.js validateBuilder/buildIntent), shown as one sentence and
//     as rows, and SIMULATED on the latest block before signing (IntentExecutor.simulate through eth_call;
//     the approval transaction goes through the hub's pre-sign assistant, presign.js). You sign it (EIP-712
//     in your wallet) and hand the signed JSON to any solver (`zetaphy intent execute`), or for an allowance
//     to the spender (`zetaphy intent spend`). IntentExecutor enforces the limits, the expiry and your own
//     daily spend cap (settable here). The model is advisory: nothing it says is kept unless it checks out.
//  2. Human or agent: the label of an account (LabelRegistry), "prove I'm a person" with a passkey (P-256
//     precompile), and the optional uniqueness level (VouchRegistry): passkey human (NOT proven unique) or
//     vouched unique human; vouch for someone, withdraw a vouch, update a status.
//  3. AI agents: who answers for an agent (AgentRegistry): operator, bond, constitution, actions, claims.
//  4. Agent wallet guardrails: an AgentPolicyWallet's state; freeze it with your passkey.
// Contract addresses come from hub-config.json (contracts.intentExecutor, labelRegistry, vouchRegistry,
// agentRegistry) or are typed in. Everything shown is set with textContent.
import { isEvmAddress, short, formatZeta, formatUnits } from './chainlib.js';
import { withFallback } from './i18n.js';
import { AGENTS } from './agents-i18n.js';
import {
  KIND_NAMES, BUILDER_FIELDS, typedData, checkIntent, newNonce, buildIntentPrompt, intentFromModel, describe, summary, buildIntent, planFor,
  encodeSimulate, decodeSimulation, encodeSetSpendCap, encodeCapLeft, MODEL_SCHEMA,
} from './intent-core.js';
import {
  SEL, callAddr, callUint, encodeProveHuman, encodeFreezeWithPasskey, encodeSetEmergencyKeys, encodeApprove, encodeAllowance, encodeGetAmountsOut,
  uintAt, bytes32At, lastOfArray, decodeAgent, decodeVouchStatus, p256FromSpki, rsFromDer, toHex, fromHex, b64url, rpIdHash,
} from './agents-lib.js';
import { revertReason } from './presign.js';
import { rawSender } from './assist.js';

const EVM_CHAIN_ID = 77390;
const AI_SETTINGS = 'neuro-ai-settings'; // the same settings and key as Neuro's AI panel (same origin)
const AI_KEY = 'neuro-ai-key';
const PASSKEY = 'zetaphy-hub:passkey'; // public data only: credential id and public key
const MAX_UINT = 2n ** 256n - 1n;
const L = (ctx) => withFallback(AGENTS, ctx.lang);
const safe = (f) => { try { return f(); } catch { return null; } };
const store = { local: () => safe(() => globalThis.localStorage), session: () => safe(() => globalThis.sessionStorage) };
const sget = (s, k) => safe(() => s?.getItem(k)) ?? null;
const sset = (s, k, v) => safe(() => (v == null ? s?.removeItem(k) : s?.setItem(k, v)));
const say = (node, text, cls = '') => { if (node) { node.textContent = text; node.className = `msg ${cls}`; } };
const call = (ctx, to, data, from) => ctx.evmCall('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Tokens the intent form offers: the hub's known ERC-20s with known decimals. */
export function intentTokens(cfg) {
  const out = [];
  for (const t of cfg?.tokens ?? []) if (isEvmAddress(t.address) && t.symbol && Number.isInteger(t.decimals)) out.push({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  return out;
}

// ---------------------------------------------------------------- 1. intent
let draft = null;   // { intent, executor, targets, route, tokens, sim, signAnyway } being reviewed, or null
let signed = null;

/** Form input ids per builder field. */
const FIELD_IDS = { tokenIn: 'ag-tin', amount: 'ag-amount', tokenOut: 'ag-tout', minOut: 'ag-min', recipient: 'ag-to', minutes: 'ag-mins', days: 'ag-days', contract: 'ag-targets' };

function aiSettings() {
  let s = {};
  try { s = JSON.parse(sget(store.local(), AI_SETTINGS) ?? '{}') ?? {}; } catch { s = {}; }
  return { provider: ['anthropic', 'openai', 'ollama'].includes(s.provider) ? s.provider : 'anthropic', model: typeof s.model === 'string' ? s.model : '',
    endpoint: typeof s.endpoint === 'string' ? s.endpoint : '', key: sget(store.session(), AI_KEY) ?? sget(store.local(), AI_KEY) ?? '' };
}

/** Shows the fields the chosen template takes, with that template's words. */
function applyTemplate(ctx, root) {
  const t = L(ctx);
  const kind = root.querySelector('#ag-kind')?.value ?? 'swap';
  const spec = BUILDER_FIELDS[kind];
  const take = new Set([...spec.required, ...spec.optional]);
  for (const [field, id] of Object.entries(FIELD_IDS)) {
    const input = root.querySelector(`#${id}`);
    const label = root.querySelector(`label[for="${id}"]`);
    if (!input) continue;
    input.hidden = !take.has(field);
    if (label) label.hidden = !take.has(field);
  }
  const lab = (id, text) => { const n = root.querySelector(`label[for="${id}"]`); if (n) n.textContent = text; };
  lab('ag-amount', kind === 'approve' ? t.capLabel : kind === 'send' || kind === 'bridge' ? t.amountExact : t.amountIn);
  lab('ag-tin', kind === 'swap' || kind === 'stake' ? t.tokenIn : t.token);
  lab('ag-to', kind === 'approve' ? t.spenderLabel : kind === 'bridge' ? t.remoteLabel : t.recipient);
  root.querySelector('#ag-to').placeholder = kind === 'swap' || kind === 'stake' ? t.recipientMe : '0x…';
  lab('ag-targets', kind === 'stake' ? t.vaultLabel : kind === 'bridge' ? t.bridgeLabel : t.routerLabel);
  const contract = root.querySelector('#ag-targets');
  if (kind === 'swap' && !contract.value) contract.value = ctx.cfg?.dex?.router ?? '';
  root.querySelector('#ag-template-note').textContent = t.tpl[kind] ?? '';
}

function intentCard(ctx, t) {
  const el = ctx.el;
  const tokens = intentTokens(ctx.cfg);
  const s = aiSettings();
  const opt = (v, text, sel) => el('option', { value: v, text, selected: sel || null });
  const tokSel = (id) => el('select', { id }, opt('', '—'), ...tokens.map((k) => opt(k.address, k.symbol)));
  const field = (label, node, tip) => [el('label', { for: node.id, text: label, 'data-tip': tip ?? null }), node];
  const card = el('div', { class: 'card ag-card' },
    el('div', { class: 'card-head' }, el('h2', { text: t.intentTitle }), el('span', { class: 'info', tabindex: 0, 'data-tip': t.tipIntent, text: 'i' })),
    el('p', { class: 'dim small', text: t.intentHow }),
    el('textarea', { id: 'ag-text', rows: 2, maxlength: 600, placeholder: t.placeholder, 'aria-label': t.intentTitle }),
    el('details', { class: 'ag-model' }, el('summary', { text: t.model }),
      el('div', { class: 'sp-form' },
        ...field(t.provider, el('select', { id: 'ag-provider' }, opt('anthropic', 'Anthropic', s.provider === 'anthropic'), opt('openai', t.openai, s.provider === 'openai'), opt('ollama', t.ollama, s.provider === 'ollama'))),
        ...field(t.modelId, el('input', { id: 'ag-model', value: s.model, placeholder: 'claude-sonnet-5-5', spellcheck: 'false' })),
        ...field(t.endpoint, el('input', { id: 'ag-endpoint', value: s.endpoint, placeholder: 'https://…/v1', spellcheck: 'false' })),
        ...field(t.apiKey, el('input', { id: 'ag-key', type: 'password', value: s.key, autocomplete: 'off', spellcheck: 'false' })),
        el('p', { class: 'dim small ag-wide', text: t.keyNote }))),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', id: 'ag-draft', text: t.draftAi, onclick: () => draftWithAi(ctx) }),
      el('span', { class: 'dim small', text: t.orForm })),
    el('p', { class: 'msg', id: 'ag-ai-msg', role: 'status', 'aria-live': 'polite' }),
    el('div', { class: 'sp-form', id: 'ag-form' },
      ...field(t.template, el('select', { id: 'ag-kind', onchange: () => { applyTemplate(ctx, card); clearReview(); } },
        opt('swap', t.kSwap), opt('send', t.kSend), opt('stake', t.kStake), opt('approve', t.kApprove), opt('bridge', t.kBridge))),
      el('p', { class: 'dim small ag-wide', id: 'ag-template-note' }),
      ...field(t.tokenIn, tokSel('ag-tin')),
      ...field(t.amountIn, el('input', { id: 'ag-amount', inputmode: 'decimal', placeholder: '10', autocomplete: 'off' })),
      ...field(t.tokenOut, tokSel('ag-tout')),
      ...field(t.minOut, el('input', { id: 'ag-min', inputmode: 'decimal', placeholder: '19.5', autocomplete: 'off' }), t.tipMinOut),
      ...field(t.recipient, el('input', { id: 'ag-to', class: 'mono', placeholder: t.recipientMe, spellcheck: 'false' })),
      ...field(t.deadlineMin, el('input', { id: 'ag-mins', inputmode: 'numeric', value: '30' })),
      ...field(t.days, el('input', { id: 'ag-days', inputmode: 'numeric', value: '7' })),
      ...field(t.routerLabel, el('input', { id: 'ag-targets', class: 'mono', value: ctx.cfg?.dex?.router ?? '', placeholder: '0x…', spellcheck: 'false' }), t.tipTargets),
      ...field(t.executor, el('input', { id: 'ag-exe', class: 'mono', value: ctx.cfg?.contracts?.intentExecutor ?? '', placeholder: '0x…', spellcheck: 'false' }))),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost', id: 'ag-review', text: t.review, onclick: () => review(ctx) })),
    el('div', { id: 'ag-review-out' }),
    el('p', { class: 'msg', id: 'ag-msg', role: 'status', 'aria-live': 'polite' }));
  applyTemplate(ctx, card);
  return card;
}

function clearReview() {
  draft = null; signed = null;
  document.querySelector('#ag-review-out')?.replaceChildren();
}

function fillForm(ctx, root, d, tokens) {
  const set = (id, v) => { const n = root.querySelector(`#${id}`); if (n && v != null) n.value = v; };
  const tok = (a) => tokens.find((k) => k.address.toLowerCase() === String(a).toLowerCase());
  set('ag-kind', d.kind);
  applyTemplate(ctx, root);
  set('ag-tin', d.tokenIn);
  set('ag-tout', d.tokenOut);
  const fmt = (v, a) => { const k = tok(a); if (v == null || !k) return ''; const one = 10n ** BigInt(k.decimals); const f = (v % one).toString().padStart(k.decimals, '0').replace(/0+$/, ''); return `${v / one}${f ? `.${f}` : ''}`; };
  set('ag-amount', fmt(d.maxIn, d.tokenIn));
  set('ag-min', fmt(d.minOut, d.tokenOut));
  set('ag-to', d.recipient && d.recipient.toLowerCase() === String(ctx.account?.() ?? '').toLowerCase() && d.kind !== 'send' ? '' : d.recipient);
  set('ag-mins', String(Math.max(1, Math.round((d.deadline - Date.now() / 1000) / 60))));
}

async function quoteOf(ctx, tin, tout, amount) {
  const router = ctx.cfg?.dex?.router;
  if (!isEvmAddress(router)) return null;
  try { return lastOfArray(await call(ctx, router, encodeGetAmountsOut(amount, [tin.address, tout.address]))); } catch { return null; }
}

async function draftWithAi(ctx) {
  const t = L(ctx);
  const root = document.querySelector('.page-agents');
  const out = root.querySelector('#ag-ai-msg');
  const text = root.querySelector('#ag-text').value.trim();
  if (!text) { say(out, t.needText, 'bad'); return; }
  const settings = { provider: root.querySelector('#ag-provider').value, model: root.querySelector('#ag-model').value.trim(),
    baseUrl: root.querySelector('#ag-endpoint').value.trim(), key: root.querySelector('#ag-key').value.trim() };
  sset(store.local(), AI_SETTINGS, JSON.stringify({ provider: settings.provider, model: settings.model, endpoint: settings.baseUrl }));
  sset(store.session(), AI_KEY, settings.key || null);
  const tokens = intentTokens(ctx.cfg);
  say(out, t.thinking);
  const btn = root.querySelector('#ag-draft');
  btn.disabled = true;
  try {
    const { complete } = await import('./neuro/ai/providers.js');
    const { system, user } = buildIntentPrompt(text, tokens);
    const { text: answer } = await complete(settings, { system, user, schema: settings.provider === 'anthropic' ? MODEL_SCHEMA : undefined, timeoutMs: 120_000 });
    const account = ctx.account() ?? '';
    let r = intentFromModel(answer, { tokens, account });
    if (r.draft && r.problems.includes('minOut') && r.draft.kind === 'swap' && r.draft.maxIn) {
      const tin = tokens.find((k) => k.address === r.draft.tokenIn), tout = tokens.find((k) => k.address === r.draft.tokenOut);
      const q = tin && tout ? await quoteOf(ctx, tin, tout, r.draft.maxIn) : null;
      if (q) r = intentFromModel(answer, { tokens, account, quote: () => q });
    }
    if (!r.draft) { say(out, `${t.aiNoIntent}${r.unclear ? ` ${r.unclear}` : ''}`, 'bad'); return; }
    fillForm(ctx, root, r.draft, tokens);
    say(out, `${t.aiDrafted}${r.problems.length ? ` ${t.fixFields}: ${r.problems.map((p) => t.f[p] ?? p).join(', ')}.` : ''}${r.unclear ? ` ${t.aiUnclear}: ${r.unclear}` : ''}`, r.problems.length ? 'bad' : 'ok');
    review(ctx);
  } catch (e) {
    say(out, `${t.aiFailed}: ${String(e?.message ?? e).slice(0, 200)}`, 'bad');
  } finally { btn.disabled = false; }
}

/** The visible form fields -> the builder input (strings only; empty optional fields left out). */
export function formInput(root) {
  const kind = root.querySelector('#ag-kind')?.value ?? '';
  const spec = BUILDER_FIELDS[kind];
  if (!spec) return { kind };
  const input = { kind };
  for (const f of [...spec.required, ...spec.optional]) {
    const v = root.querySelector(`#${FIELD_IDS[f]}`)?.value.trim() ?? '';
    if (v !== '' || spec.required.includes(f)) input[f] = v;
  }
  return input;
}

/** The form -> { intent, executor, targets, route, tokens } or { problems }. */
async function formIntent(ctx, root) {
  const tokens = intentTokens(ctx.cfg);
  const executor = root.querySelector('#ag-exe')?.value.trim() ?? '';
  const { keccak256 } = await import('./neuro/src/keccak.js');
  const r = buildIntent(formInput(root), { account: ctx.account() ?? '', tokens, nonce: newNonce(), keccak: keccak256 });
  const problems = [...(r.problems ?? [])];
  if (!isEvmAddress(executor)) problems.push('executor');
  return { ...r, executor, tokens, problems };
}

async function review(ctx) {
  const t = L(ctx);
  const root = document.querySelector('.page-agents');
  const box = root.querySelector('#ag-review-out');
  const msg = root.querySelector('#ag-msg');
  clearReview();
  const r = await formIntent(ctx, root);
  if (r.problems.length) {
    say(msg, `${t.fixFields}: ${[...new Set(r.problems)].map((p) => t.f[p] ?? p).join(', ')}`, 'bad');
    return;
  }
  draft = { ...r, sim: null, signAnyway: false };
  const el = ctx.el;
  const locale = ctx.lang === 'en' ? 'en-GB' : ctx.lang;
  const kind = KIND_NAMES[Number(r.intent.kind)];
  const rows = describe(r.intent, r.tokens, locale);
  const kindName = { swap: t.kSwap, send: t.kSend, stake: t.kStake, approve: t.kApprove, bridge: t.kBridge };
  const tokenSym = r.tokens.find((k) => k.address === r.intent.tokenIn)?.symbol ?? r.intent.tokenIn;
  box.replaceChildren(
    el('h3', { text: t.checkAll }),
    el('p', { class: 'ag-summary', id: 'ag-summary', text: summary(r.intent, r.tokens, t.sum, locale) }),
    el('table', { class: 'mn-table ag-review' }, el('tbody', {}, ...rows.map(([k, val]) => el('tr', {}, el('th', { text: t.rows[k] ?? k }), el('td', { class: 'mono', text: k === 'kind' ? kindName[val] ?? val : val }))),
      el('tr', {}, el('th', { text: t.executor }), el('td', { class: 'mono', text: r.executor })),
      el('tr', {}, el('th', { text: t.targets }), el('td', { class: 'mono', text: r.targets.join(', ') || '—' })))),
    el('p', { class: 'warnline small', text: kind === 'approve' ? t.enforcedApprove : kind === 'bridge' ? t.enforcedBridge : t.enforced }),
    el('h3', { text: t.simTitle }),
    el('p', { class: 'msg', id: 'ag-sim', role: 'status', 'aria-live': 'polite', text: '…' }),
    el('p', { class: 'dim small', text: t.simAdvisory }),
    el('div', { class: 'sp-form' },
      el('label', { for: 'ag-cap', text: fill(t.capLabelFor, { token: tokenSym }), 'data-tip': t.tipCap }),
      el('div', { class: 'row' }, el('input', { id: 'ag-cap', inputmode: 'decimal', placeholder: t.capNone, autocomplete: 'off' }),
        el('button', { type: 'button', class: 'btn ghost', id: 'ag-cap-set', text: t.capSet, onclick: () => setCap(ctx) })),
      el('p', { class: 'dim small ag-wide', id: 'ag-cap-left' })),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn ghost', id: 'ag-approve', text: t.approve, onclick: () => approveIn(ctx) }),
      el('button', { type: 'button', class: 'btn ghost', id: 'ag-simulate', text: t.simulate, onclick: () => simulate(ctx) }),
      el('button', { type: 'button', class: 'btn', id: 'ag-sign', text: t.sign, onclick: () => signDraft(ctx) })),
    el('div', { id: 'ag-signed' }));
  say(msg, '');
  await Promise.all([simulate(ctx), showCap(ctx)]);
}

/** IntentExecutor.simulate() through eth_call from the user: what would happen on the latest block, nothing sent. */
async function simulate(ctx) {
  const t = L(ctx);
  const out = document.querySelector('#ag-sim');
  const d = draft;
  if (!d || !out) return null;
  const kind = KIND_NAMES[Number(d.intent.kind)];
  let res;
  try {
    const plan = kind === 'approve' ? { targets: [], spender: `0x${'0'.repeat(40)}`, calls: [] } : planFor(d.intent, d.route);
    const send = rawSender(ctx.ep().evm);
    const j = await send('eth_call', [{ from: d.intent.user, to: d.executor, data: encodeSimulate(d.intent, plan) }, 'latest']);
    const data = j?.error?.data ?? (typeof j?.error?.message === 'string' && /0x[0-9a-f]{8}/i.test(j.error.message) ? j.error.message.match(/0x[0-9a-f]+/i)[0] : null);
    const dec = decodeSimulation(data);
    if (dec?.ok) res = { ok: true, ...dec };
    else if (dec) res = { ok: false, error: dec.error, args: dec.args, needsAllow: dec.error === 'TokenFailed' };
    else if (j?.error) res = { ok: false, reason: revertReason(data ?? '') || String(j.error.message ?? '').slice(0, 200) };
    else res = { ok: false, unavailable: true, reason: t.simNoAnswer };
  } catch (e) { res = { ok: false, unavailable: true, reason: String(e?.message ?? e).slice(0, 200) }; }
  if (draft !== d) return null; // the form changed meanwhile
  d.sim = res;
  d.signAnyway = false;
  const tok = (a) => d.tokens.find((k) => k.address.toLowerCase() === String(a).toLowerCase());
  const amt = (v, a) => { const k = tok(a); return k ? `${formatUnits(v, k.decimals, k.decimals)} ${k.symbol}` : String(v); };
  if (res.ok) {
    say(out, kind === 'approve' ? t.simOkApprove : kind === 'bridge' ? fill(t.simOkBridge, { spent: amt(res.spent, d.intent.tokenIn) })
      : fill(t.simOk, { spent: amt(res.spent, d.intent.tokenIn), received: amt(res.received, d.intent.tokenOut) }), 'ok');
  } else if (res.needsAllow) say(out, t.simNeedsAllow, 'bad');
  else if (res.unavailable) say(out, fill(t.simUnavailable, { reason: res.reason }), 'bad');
  else say(out, fill(t.simFail, { reason: res.error ? `${t.errors[res.error] ?? res.error}` : res.reason }), 'bad');
  return res;
}

async function showCap(ctx) {
  const t = L(ctx);
  const d = draft;
  const out = document.querySelector('#ag-cap-left');
  if (!d || !out) return;
  try {
    const left = uintAt(await call(ctx, d.executor, encodeCapLeft(d.intent.user, d.intent.tokenIn)));
    const k = d.tokens.find((x) => x.address === d.intent.tokenIn);
    out.textContent = left === MAX_UINT ? `${t.capLeft}: ${t.capNone}` : `${t.capLeft}: ${formatUnits(left, k?.decimals ?? 18, k?.decimals ?? 18)} ${k?.symbol ?? ''}`;
  } catch { out.textContent = ''; }
}

async function setCap(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-msg');
  const d = draft;
  if (!d) return;
  const k = d.tokens.find((x) => x.address === d.intent.tokenIn);
  const v = document.querySelector('#ag-cap').value.trim();
  const { parseUnits } = await import('./chainlib.js');
  let perDay;
  try { perDay = v === '' || v === '0' ? 0n : parseUnits(v, k.decimals); } catch { say(msg, `${t.fixFields}: ${t.f.amount}`, 'bad'); return; }
  try {
    await ctx.send(d.executor, encodeSetSpendCap(d.intent.tokenIn, perDay), t.capAction);
    say(msg, t.capOk, 'ok');
    await Promise.all([showCap(ctx), simulate(ctx)]);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function approveIn(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-msg');
  if (!draft) return;
  try {
    const have = uintAt(await call(ctx, draft.intent.tokenIn, encodeAllowance(draft.intent.user, draft.executor)));
    if (have < BigInt(draft.intent.maxIn)) {
      say(msg, '…');
      // the hub's send() shows its pre-sign summary and simulation (presign.js) before the wallet opens
      await ctx.send(draft.intent.tokenIn, encodeApprove(draft.executor, draft.intent.maxIn), t.approveAction);
    }
    say(msg, t.approved, 'ok');
    await simulate(ctx);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function signDraft(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-msg');
  const d = draft;
  if (!d) return;
  const problems = checkIntent(d.intent);
  if (problems.length) { say(msg, `${t.fixFields}: ${problems.map((p) => t.f[p] ?? p).join(', ')}`, 'bad'); return; }
  if (!d.sim) await simulate(ctx); // never sign what was not simulated
  if (!d.sim?.ok && !d.signAnyway) {
    d.signAnyway = true;
    say(msg, t.signAnyway, 'bad');
    return;
  }
  try {
    const sig = await ctx.signTyped(typedData(d.intent, d.executor, EVM_CHAIN_ID));
    const kind = KIND_NAMES[Number(d.intent.kind)];
    signed = JSON.stringify({ executor: d.executor, chainId: EVM_CHAIN_ID, intent: d.intent, auth: { sigType: 0, sig, pqPublicKey: '0x' }, route: d.route }, null, 2);
    const el = ctx.el;
    const cmd = kind === 'approve' ? 'zetaphy intent spend signed-intent.json --to 0x… --amount <base units>' : 'zetaphy intent execute signed-intent.json';
    document.querySelector('#ag-signed').replaceChildren(
      el('h3', { text: t.signedTitle }),
      el('div', { class: 'code' }, el('pre', { class: 'mono', text: signed }), ctx.copyBtn(signed)),
      el('p', { class: 'dim small', text: kind === 'approve' ? t.spenderHow : t.solverHow }),
      el('div', { class: 'code' }, el('pre', { class: 'mono', text: cmd }), ctx.copyBtn(cmd)));
    say(msg, t.signedOk, 'ok');
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

// ---------------------------------------------------------------- passkeys
function savedPasskey() {
  try { const p = JSON.parse(sget(store.local(), PASSKEY) ?? 'null'); return p && p.id && p.x && p.y ? { id: p.id, x: BigInt(p.x), y: BigInt(p.y) } : null; } catch { return null; }
}

async function ensurePasskey() {
  const have = savedPasskey();
  if (have) return have;
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'ZETAPHY', id: location.hostname },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'ZETAPHY passkey', displayName: 'ZETAPHY passkey' },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256, what the precompile checks
    authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
    attestation: 'none', timeout: 120_000,
  } });
  const spki = cred.response.getPublicKey?.();
  if (!spki) throw new Error('this browser does not return the passkey public key');
  const { x, y } = p256FromSpki(spki);
  const p = { id: b64url(new Uint8Array(cred.rawId)), x: x.toString(), y: y.toString() };
  sset(store.local(), PASSKEY, JSON.stringify(p));
  return { id: p.id, x, y };
}

/** A passkey assertion over `challengeHex`, as the contracts take it. */
async function assertWith(pk, challengeHex) {
  const idBytes = Uint8Array.from(atob(pk.id.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const a = await navigator.credentials.get({ publicKey: {
    challenge: fromHex(challengeHex), rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: idBytes }], userVerification: 'required', timeout: 120_000,
  } });
  const { r, s } = rsFromDer(a.response.signature);
  return { authenticatorData: toHex(new Uint8Array(a.response.authenticatorData)), clientDataJSON: toHex(new Uint8Array(a.response.clientDataJSON)), r, s };
}

// ---------------------------------------------------------------- 2. labels, 3. agents, 4. wallets
function addrCard(ctx, t, { id, title, tip, cfgKey, placeholder, button, onCheck, extra = [], fields = [], note = null }) {
  const el = ctx.el;
  return el('div', { class: 'card ag-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title }), el('span', { class: 'info', tabindex: 0, 'data-tip': tip, text: 'i' })),
    el('div', { class: 'sp-form' },
      el('label', { for: `${id}-c`, text: t.contract }), el('input', { id: `${id}-c`, class: 'mono', value: ctx.cfg?.contracts?.[cfgKey] ?? '', placeholder: '0x…', spellcheck: 'false' }),
      ...fields,
      el('label', { for: `${id}-q`, text: placeholder }), el('input', { id: `${id}-q`, class: 'mono', value: ctx.account?.() ?? '', placeholder: '0x…', spellcheck: 'false' })),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost', text: button, onclick: () => onCheck(ctx) }), ...extra),
    el('div', { id: `${id}-out` }),
    note ? el('p', { class: 'dim small', text: note }) : null,
    el('p', { class: 'msg', id: `${id}-msg`, role: 'status', 'aria-live': 'polite' }));
}
const val = (id) => document.querySelector(`#${id}`)?.value.trim() ?? '';
const kv = (ctx, rows) => ctx.el('dl', { class: 'kv3' }, rows.flatMap(([k, v]) => [ctx.el('dt', { text: k }), ctx.el('dd', { class: 'mono', text: v })]));

async function checkLabel(ctx) {
  const t = L(ctx);
  const [c, a, vr] = [val('ag-lab-c'), val('ag-lab-q'), val('ag-lab-v')];
  const out = document.querySelector('#ag-lab-out');
  const msg = document.querySelector('#ag-lab-msg');
  if (!isEvmAddress(c) || !isEvmAddress(a) || (vr && !isEvmAddress(vr))) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const label = Number(uintAt(await call(ctx, c, callAddr(SEL.labelOf, a))));
    const el = ctx.el;
    let pill = [t.labelNone, t.labelHuman, t.labelAgent][label] ?? '?';
    let cls = label === 1 ? 'passed' : label === 2 ? 'voting' : '';
    const lines = [];
    if (label === 1 && isEvmAddress(vr)) {
      const st = decodeVouchStatus(await call(ctx, vr, callAddr(SEL.vouchStatus, a)));
      pill = st.level === 2 ? t.levelUnique : t.levelPasskey;
      cls = st.level === 2 ? 'passed' : '';
      lines.push(fill(t.vouchCount, { n: st.vouches, need: st.needed }));
      if (st.banned) lines.push(t.levelBanned);
      else if (st.flags >= st.flagsToSuspend) lines.push(t.levelSuspended);
      else if (st.flags > 0) lines.push(fill(t.flagCount, { n: st.flags, max: st.flagsToSuspend }));
      if (st.level === 1 && st.vouches >= st.needed && !st.banned) lines.push(t.needsRefresh);
    } else if (label === 1) pill = t.levelPasskey; // without the uniqueness registry: still say it is not proven unique
    out.replaceChildren(el('p', {}, el('span', { class: `pill ${cls}`, id: 'ag-lab-level', text: pill }), el('span', { class: 'mono small', text: ` ${short(a)}` })),
      ...lines.map((l) => el('p', { class: 'dim small', text: l })));
    say(msg, '');
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

/** vouch / unvouch / refresh on VouchRegistry for the address in the box. */
async function vouchAct(ctx, what) {
  const t = L(ctx);
  const [vr, a] = [val('ag-lab-v'), val('ag-lab-q')];
  const msg = document.querySelector('#ag-lab-msg');
  if (!isEvmAddress(vr) || !isEvmAddress(a)) { say(msg, t.badAddr, 'bad'); return; }
  const data = callAddr(SEL[what], a);
  const action = { vouch: t.vouchAction, unvouch: t.unvouchAction, refresh: t.refreshAction }[what];
  try {
    await ctx.send(vr, data, action);
    say(msg, { vouch: t.vouchOk, unvouch: t.unvouchOk, refresh: t.refreshOk }[what], 'ok');
    checkLabel(ctx);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function proveHuman(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-lab-msg');
  const c = val('ag-lab-c');
  if (!isEvmAddress(c)) { say(msg, t.badAddr, 'bad'); return; }
  try {
    if (!window.PublicKeyCredential) throw new Error(t.noPasskeys);
    const account = ctx.account() ?? await ctx.connect();
    const pk = await ensurePasskey();
    const challenge = bytes32At(await call(ctx, c, callAddr(SEL.humanChallenge, account)));
    say(msg, t.touchPasskey);
    const assertion = await assertWith(pk, challenge);
    await ctx.send(c, encodeProveHuman(pk.x, pk.y, assertion), t.proveAction);
    say(msg, t.provedOk, 'ok');
    document.querySelector('#ag-lab-q').value = account;
    checkLabel(ctx);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function checkAgent(ctx) {
  const t = L(ctx);
  const [c, q] = [val('ag-ag-c'), val('ag-ag-q')];
  const msg = document.querySelector('#ag-ag-msg');
  if (!isEvmAddress(c) || !(isEvmAddress(q) || /^\d{1,12}$/.test(q))) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const id = isEvmAddress(q) ? uintAt(await call(ctx, c, callAddr(SEL.agentOfAccount, q))) : BigInt(q);
    if (!id) { document.querySelector('#ag-ag-out').replaceChildren(ctx.el('p', { class: 'dim', text: t.noAgent })); say(msg, ''); return; }
    const a = decodeAgent(await call(ctx, c, callUint(SEL.agents, id)));
    if (/^0x0{40}$/.test(a.operator)) { document.querySelector('#ag-ag-out').replaceChildren(ctx.el('p', { class: 'dim', text: t.noAgent })); return; }
    document.querySelector('#ag-ag-out').replaceChildren(kv(ctx, [
      [t.agentId, String(id)], [t.operator, a.operator], [t.account, a.account], [t.bond, `${formatZeta(a.bond)} ZTPHY`],
      [t.constitution, a.constitution], [t.pqKey, a.pqKeyHash], [t.actions, String(a.actions)], [t.openClaims, String(a.openClaims)],
      [t.status, a.unbondAt ? `${t.unbonding} ${new Date(Number(a.unbondAt) * 1000).toLocaleString()}` : t.active]]));
    say(msg, '');
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function checkWallet(ctx) {
  const t = L(ctx);
  const w = val('ag-w-q');
  const msg = document.querySelector('#ag-w-msg');
  if (!isEvmAddress(w)) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const [frozen, left, px] = await Promise.all([call(ctx, w, SEL.frozen), call(ctx, w, callAddr(SEL.remaining, '0x0000000000000000000000000000000000000000')), call(ctx, w, SEL.passkeyX)]);
    document.querySelector('#ag-w-out').replaceChildren(kv(ctx, [
      [t.status, uintAt(frozen) ? t.frozen : t.running], [t.leftToday, `${formatZeta(uintAt(left))} ZTPHY`], [t.emergencyPasskey, uintAt(px) ? t.set : t.notSet]]));
    say(msg, '');
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function freezeWallet(ctx) {
  const t = L(ctx);
  const w = val('ag-w-q');
  const msg = document.querySelector('#ag-w-msg');
  if (!isEvmAddress(w)) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const pk = savedPasskey();
    if (!pk) throw new Error(t.noSavedPasskey);
    const ch = bytes32At(await call(ctx, w, SEL.freezeChallenge));
    say(msg, t.touchPasskey);
    const assertion = await assertWith(pk, ch);
    await ctx.send(w, encodeFreezeWithPasskey(assertion), t.freezeAction);
    say(msg, t.frozenOk, 'ok');
    checkWallet(ctx);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function setEmergencyPasskey(ctx) {
  const t = L(ctx);
  const w = val('ag-w-q');
  const msg = document.querySelector('#ag-w-msg');
  if (!isEvmAddress(w)) { say(msg, t.badAddr, 'bad'); return; }
  try {
    const pk = await ensurePasskey();
    const pqKeyHash = bytes32At(await call(ctx, w, SEL.pqKeyHash)); // keep the ML-DSA key as it is
    await ctx.send(w, encodeSetEmergencyKeys(pqKeyHash, pk.x, pk.y, await rpIdHash()), t.emergencyAction);
    say(msg, t.emergencyOk, 'ok');
    checkWallet(ctx);
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

export default {
  render(root, ctx) {
    const t = L(ctx);
    const el = ctx.el;
    draft = null; signed = null;
    root.replaceChildren(
      el('p', { class: 'dim small sp-intro', text: t.intro }),
      el('div', { class: 'ag-grid' },
        intentCard(ctx, t),
        el('div', { class: 'ag-col' },
          addrCard(ctx, t, { id: 'ag-lab', title: t.labelTitle, tip: t.tipLabel, cfgKey: 'labelRegistry', placeholder: t.address, button: t.check, onCheck: checkLabel,
            fields: [el('label', { for: 'ag-lab-v', text: t.vouchContract, 'data-tip': t.tipVouch }),
              el('input', { id: 'ag-lab-v', class: 'mono', value: ctx.cfg?.contracts?.vouchRegistry ?? '', placeholder: t.optional, spellcheck: 'false' })],
            extra: [el('button', { type: 'button', class: 'btn', id: 'ag-prove', text: t.prove, onclick: () => proveHuman(ctx) }),
              el('button', { type: 'button', class: 'btn ghost', id: 'ag-vouch', text: t.vouch, onclick: () => vouchAct(ctx, 'vouch') }),
              el('button', { type: 'button', class: 'btn ghost', id: 'ag-unvouch', text: t.unvouch, onclick: () => vouchAct(ctx, 'unvouch') }),
              el('button', { type: 'button', class: 'btn ghost', id: 'ag-refresh', text: t.refresh, onclick: () => vouchAct(ctx, 'refresh') })],
            note: t.uniqueNote }),
          addrCard(ctx, t, { id: 'ag-ag', title: t.agentTitle, tip: t.tipAgent, cfgKey: 'agentRegistry', placeholder: t.agentQuery, button: t.check, onCheck: checkAgent }),
          (() => {
            const card = addrCard(ctx, t, { id: 'ag-w', title: t.walletTitle, tip: t.tipWallet, cfgKey: 'agentPolicyWallet', placeholder: t.walletAddr, button: t.check, onCheck: checkWallet,
              extra: [el('button', { type: 'button', class: 'btn', id: 'ag-freeze', text: t.freeze, onclick: () => freezeWallet(ctx) }),
                el('button', { type: 'button', class: 'btn ghost', id: 'ag-emerg', text: t.useAsEmergency, onclick: () => setEmergencyPasskey(ctx) })] });
            // the wallet card has no contract field of its own: the wallet IS the contract
            card.querySelector('#ag-w-c')?.previousElementSibling?.remove();
            card.querySelector('#ag-w-c')?.remove();
            if (!card.querySelector('#ag-w-q').value || card.querySelector('#ag-w-q').value === (ctx.account?.() ?? '')) card.querySelector('#ag-w-q').value = '';
            return card;
          })())),
      el('p', { class: 'warnline small', text: t.limits }));
  },
};
