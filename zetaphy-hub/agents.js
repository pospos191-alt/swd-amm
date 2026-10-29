// The Agents page (a data page of pages.js): AI agents on ZETAPHY, testnet.
//  1. Proof of Intent: say what you want; a model of YOUR choice (Neuro's AI layer, bring your own key)
//     drafts an intent; you check every field; you sign it (EIP-712 in your wallet) and hand the signed
//     JSON to any solver (`zetaphy intent execute`). IntentExecutor reverts unless the effects match.
//  2. Human or agent: the label of an account (LabelRegistry), and "prove I'm a person" with a passkey,
//     checked on chain by the P-256 precompile.
//  3. AI agents: who answers for an agent (AgentRegistry): operator, bond, constitution, actions, claims.
//  4. Agent wallet guardrails: an AgentPolicyWallet's state; freeze it with your passkey.
// Contract addresses come from hub-config.json (contracts.intentExecutor, labelRegistry, agentRegistry)
// or are typed in. Everything shown is set with textContent; the model's answer is data, checked by
// intent-core.js, and never signed without the user pressing Sign after the review.
import { isEvmAddress, short, formatZeta, parseUnits } from './chainlib.js';
import { withFallback } from './i18n.js';
import { AGENTS } from './agents-i18n.js';
import { KINDS, KIND_NAMES, typedData, targetsHash, checkIntent, newNonce, buildIntentPrompt, intentFromModel, describe, MODEL_SCHEMA, ZERO_HASH } from './intent-core.js';
import {
  SEL, callAddr, callUint, encodeProveHuman, encodeFreezeWithPasskey, encodeSetEmergencyKeys, encodeApprove, encodeAllowance, encodeGetAmountsOut,
  uintAt, bytes32At, lastOfArray, decodeAgent, p256FromSpki, rsFromDer, toHex, fromHex, b64url, rpIdHash,
} from './agents-lib.js';

const EVM_CHAIN_ID = 77390;
const AI_SETTINGS = 'neuro-ai-settings'; // the same settings and key as Neuro's AI panel (same origin)
const AI_KEY = 'neuro-ai-key';
const PASSKEY = 'zetaphy-hub:passkey'; // public data only: credential id and public key
const L = (ctx) => withFallback(AGENTS, ctx.lang);
const safe = (f) => { try { return f(); } catch { return null; } };
const store = { local: () => safe(() => globalThis.localStorage), session: () => safe(() => globalThis.sessionStorage) };
const sget = (s, k) => safe(() => s?.getItem(k)) ?? null;
const sset = (s, k, v) => safe(() => (v == null ? s?.removeItem(k) : s?.setItem(k, v)));
const say = (node, text, cls = '') => { if (node) { node.textContent = text; node.className = `msg ${cls}`; } };
const call = (ctx, to, data) => ctx.evmCall('eth_call', [{ to, data }, 'latest']);

/** Tokens the intent form offers: the hub's known ERC-20s with known decimals. */
export function intentTokens(cfg) {
  const out = [];
  for (const t of cfg?.tokens ?? []) if (isEvmAddress(t.address) && t.symbol && Number.isInteger(t.decimals)) out.push({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  return out;
}

// ---------------------------------------------------------------- 1. intent
let draft = null;   // the intent being reviewed (strings), or null
let signed = null;

function aiSettings() {
  let s = {};
  try { s = JSON.parse(sget(store.local(), AI_SETTINGS) ?? '{}') ?? {}; } catch { s = {}; }
  return { provider: ['anthropic', 'openai', 'ollama'].includes(s.provider) ? s.provider : 'anthropic', model: typeof s.model === 'string' ? s.model : '',
    endpoint: typeof s.endpoint === 'string' ? s.endpoint : '', key: sget(store.session(), AI_KEY) ?? sget(store.local(), AI_KEY) ?? '' };
}

function intentCard(ctx, t) {
  const el = ctx.el;
  const tokens = intentTokens(ctx.cfg);
  const s = aiSettings();
  const opt = (v, text, sel) => el('option', { value: v, text, selected: sel || null });
  const tokSel = (id) => el('select', { id, 'aria-label': t[id === 'ag-tin' ? 'tokenIn' : 'tokenOut'] }, opt('', '—'), ...tokens.map((k) => opt(k.address, k.symbol)));
  const field = (label, node, tip) => [el('label', { for: node.id, text: label, 'data-tip': tip ?? null }), node];
  return el('div', { class: 'card ag-card' },
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
      ...field(t.kind, el('select', { id: 'ag-kind' }, opt('swap', t.kSwap), opt('send', t.kSend), opt('stake', t.kStake))),
      ...field(t.tokenIn, tokSel('ag-tin')),
      ...field(t.amountIn, el('input', { id: 'ag-amount', inputmode: 'decimal', placeholder: '10' })),
      ...field(t.tokenOut, tokSel('ag-tout')),
      ...field(t.minOut, el('input', { id: 'ag-min', inputmode: 'decimal', placeholder: '19.5' }), t.tipMinOut),
      ...field(t.recipient, el('input', { id: 'ag-to', class: 'mono', placeholder: t.recipientMe, spellcheck: 'false' })),
      ...field(t.deadlineMin, el('input', { id: 'ag-mins', inputmode: 'numeric', value: '30' })),
      ...field(t.executor, el('input', { id: 'ag-exe', class: 'mono', value: ctx.cfg?.contracts?.intentExecutor ?? '', placeholder: '0x…', spellcheck: 'false' })),
      ...field(t.targets, el('input', { id: 'ag-targets', class: 'mono', value: ctx.cfg?.dex?.router ?? '', placeholder: '0x…, 0x…', spellcheck: 'false' }), t.tipTargets)),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost', id: 'ag-review', text: t.review, onclick: () => review(ctx) })),
    el('div', { id: 'ag-review-out' }),
    el('p', { class: 'msg', id: 'ag-msg', role: 'status', 'aria-live': 'polite' }));
}

function fillForm(root, d, tokens) {
  const set = (id, v) => { const n = root.querySelector(`#${id}`); if (n && v != null) n.value = v; };
  const tok = (a) => tokens.find((k) => k.address.toLowerCase() === String(a).toLowerCase());
  set('ag-kind', d.kind);
  set('ag-tin', d.tokenIn);
  set('ag-tout', d.tokenOut);
  const fmt = (v, a) => { const k = tok(a); if (v == null || !k) return ''; const one = 10n ** BigInt(k.decimals); const f = (v % one).toString().padStart(k.decimals, '0').replace(/0+$/, ''); return `${v / one}${f ? `.${f}` : ''}`; };
  set('ag-amount', fmt(d.maxIn, d.tokenIn));
  set('ag-min', fmt(d.minOut, d.tokenOut));
  set('ag-to', d.recipient);
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
    fillForm(root, r.draft, tokens);
    say(out, `${t.aiDrafted}${r.problems.length ? ` ${t.fixFields}: ${r.problems.map((p) => t.f[p] ?? p).join(', ')}.` : ''}${r.unclear ? ` ${t.aiUnclear}: ${r.unclear}` : ''}`, r.problems.length ? 'bad' : 'ok');
    review(ctx);
  } catch (e) {
    say(out, `${t.aiFailed}: ${String(e?.message ?? e).slice(0, 200)}`, 'bad');
  } finally { btn.disabled = false; }
}

/** The form -> an intent (strings), or a list of problems. */
async function formIntent(ctx, root) {
  const tokens = intentTokens(ctx.cfg);
  const v = (id) => root.querySelector(`#${id}`)?.value.trim() ?? '';
  const problems = [];
  const account = ctx.account();
  if (!account) problems.push('user');
  const kind = v('ag-kind');
  const tin = tokens.find((k) => k.address === v('ag-tin'));
  const tout = kind === 'send' ? tin : tokens.find((k) => k.address === v('ag-tout'));
  let maxIn = null, minOut = null;
  try { maxIn = parseUnits(v('ag-amount'), tin?.decimals ?? 18); } catch { problems.push('amountIn'); }
  if (kind === 'send') minOut = maxIn;
  else { try { minOut = parseUnits(v('ag-min'), tout?.decimals ?? 18); } catch { problems.push('minOut'); } }
  const recipient = v('ag-to') || account;
  const executor = v('ag-exe');
  if (!isEvmAddress(executor)) problems.push('executor');
  const targets = kind === 'send' ? [] : v('ag-targets').split(/[\s,]+/).filter(Boolean);
  if (targets.some((a) => !isEvmAddress(a)) || (kind !== 'send' && !targets.length)) problems.push('targets');
  const mins = Number(v('ag-mins'));
  if (!tin) problems.push('tokenIn');
  if (!tout) problems.push('tokenOut');
  if (problems.length) return { problems };
  const { keccak256 } = await import('./neuro/src/keccak.js');
  const intent = {
    user: account, kind: KINDS[kind], tokenIn: tin.address, maxIn: String(maxIn), tokenOut: tout.address, minOut: String(minOut ?? 0), recipient,
    targetsHash: targetsHash(targets, keccak256), nonce: newNonce(), deadline: String(Math.floor(Date.now() / 1000) + (Number.isInteger(mins) && mins > 0 ? mins : 30) * 60),
  };
  return { intent, executor, targets, tokens, problems: checkIntent(intent) };
}

async function review(ctx) {
  const t = L(ctx);
  const root = document.querySelector('.page-agents');
  const box = root.querySelector('#ag-review-out');
  const msg = root.querySelector('#ag-msg');
  draft = null; signed = null;
  const r = await formIntent(ctx, root);
  if (r.problems.length) {
    box.replaceChildren();
    say(msg, `${t.fixFields}: ${r.problems.map((p) => t.f[p] ?? p).join(', ')}`, 'bad');
    return;
  }
  draft = r;
  const el = ctx.el;
  const rows = describe(r.intent, r.tokens, ctx.lang === 'en' ? 'en-GB' : ctx.lang);
  box.replaceChildren(
    el('h3', { text: t.checkAll }),
    el('table', { class: 'mn-table ag-review' }, el('tbody', {}, ...rows.map(([k, val]) => el('tr', {}, el('th', { text: t.rows[k] ?? k }), el('td', { class: 'mono', text: k === 'kind' ? t[`k${val[0].toUpperCase()}${val.slice(1)}`] ?? val : val }))),
      el('tr', {}, el('th', { text: t.executor }), el('td', { class: 'mono', text: r.executor })),
      el('tr', {}, el('th', { text: t.targets }), el('td', { class: 'mono', text: r.targets.join(', ') || '—' })))),
    el('p', { class: 'warnline small', text: t.enforced }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn ghost', id: 'ag-approve', text: t.approve, onclick: () => approveIn(ctx) }),
      el('button', { type: 'button', class: 'btn', id: 'ag-sign', text: t.sign, onclick: () => signDraft(ctx) })),
    el('div', { id: 'ag-signed' }));
  say(msg, '');
}

async function approveIn(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-msg');
  if (!draft) return;
  try {
    const have = uintAt(await call(ctx, draft.intent.tokenIn, encodeAllowance(draft.intent.user, draft.executor)));
    if (have >= BigInt(draft.intent.maxIn)) { say(msg, t.approved, 'ok'); return; }
    say(msg, '…');
    await ctx.send(draft.intent.tokenIn, encodeApprove(draft.executor, draft.intent.maxIn), t.approveAction);
    say(msg, t.approved, 'ok');
  } catch (e) { say(msg, String(e?.message ?? e).slice(0, 200), 'bad'); }
}

async function signDraft(ctx) {
  const t = L(ctx);
  const msg = document.querySelector('#ag-msg');
  if (!draft) return;
  const problems = checkIntent(draft.intent);
  if (problems.length) { say(msg, `${t.fixFields}: ${problems.join(', ')}`, 'bad'); return; }
  try {
    const sig = await ctx.signTyped(typedData(draft.intent, draft.executor, EVM_CHAIN_ID));
    const route = KIND_NAMES[draft.intent.kind] === 'swap' ? { router: draft.targets[0] } : KIND_NAMES[draft.intent.kind] === 'stake' ? { vault: draft.targets[0] } : {};
    signed = JSON.stringify({ executor: draft.executor, chainId: EVM_CHAIN_ID, intent: draft.intent, auth: { sigType: 0, sig, pqPublicKey: '0x' }, route }, null, 2);
    const el = ctx.el;
    document.querySelector('#ag-signed').replaceChildren(
      el('h3', { text: t.signedTitle }),
      el('div', { class: 'code' }, el('pre', { class: 'mono', text: signed }), ctx.copyBtn(signed)),
      el('p', { class: 'dim small', text: t.solverHow }),
      el('div', { class: 'code' }, el('pre', { class: 'mono', text: 'zetaphy intent execute signed-intent.json' }), ctx.copyBtn('zetaphy intent execute signed-intent.json')));
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
function addrCard(ctx, t, { id, title, tip, cfgKey, placeholder, button, onCheck, extra = [] }) {
  const el = ctx.el;
  return el('div', { class: 'card ag-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title }), el('span', { class: 'info', tabindex: 0, 'data-tip': tip, text: 'i' })),
    el('div', { class: 'sp-form' },
      el('label', { for: `${id}-c`, text: t.contract }), el('input', { id: `${id}-c`, class: 'mono', value: ctx.cfg?.contracts?.[cfgKey] ?? '', placeholder: '0x…', spellcheck: 'false' }),
      el('label', { for: `${id}-q`, text: placeholder }), el('input', { id: `${id}-q`, class: 'mono', value: ctx.account?.() ?? '', placeholder: '0x…', spellcheck: 'false' })),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost', text: button, onclick: () => onCheck(ctx) }), ...extra),
    el('div', { id: `${id}-out` }),
    el('p', { class: 'msg', id: `${id}-msg`, role: 'status', 'aria-live': 'polite' }));
}
const val = (id) => document.querySelector(`#${id}`)?.value.trim() ?? '';
const kv = (ctx, rows) => ctx.el('dl', { class: 'kv3' }, rows.flatMap(([k, v]) => [ctx.el('dt', { text: k }), ctx.el('dd', { class: 'mono', text: v })]));

async function checkLabel(ctx) {
  const t = L(ctx);
  const [c, a] = [val('ag-lab-c'), val('ag-lab-q')];
  const out = document.querySelector('#ag-lab-out');
  if (!isEvmAddress(c) || !isEvmAddress(a)) { say(document.querySelector('#ag-lab-msg'), t.badAddr, 'bad'); return; }
  try {
    const label = Number(uintAt(await call(ctx, c, callAddr(SEL.labelOf, a))));
    const name = [t.labelNone, t.labelHuman, t.labelAgent][label] ?? '?';
    out.replaceChildren(ctx.el('p', {}, ctx.el('span', { class: `pill ${label === 1 ? 'passed' : label === 2 ? 'voting' : ''}`, text: name }), ctx.el('span', { class: 'mono small', text: ` ${short(a)}` })));
    say(document.querySelector('#ag-lab-msg'), '');
  } catch (e) { say(document.querySelector('#ag-lab-msg'), String(e?.message ?? e).slice(0, 200), 'bad'); }
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
            extra: [el('button', { type: 'button', class: 'btn', id: 'ag-prove', text: t.prove, onclick: () => proveHuman(ctx) })] }),
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
