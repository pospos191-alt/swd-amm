// The EVM transaction page's deep view: summary in plain words with risk flags,
// decoded input, revert reason, gas and fee split, internal calls (callTracer),
// who gained / who lost (prestateTracer diff + token transfers) and decoded logs.
// The analysis is in txdeep.js (pure); this file only builds DOM, with text nodes.
// `ui` is the page context app.js passes (t, h, links, cards, the node, …).
import {
  decodeInput, decodeLogWith, decodeRevertWith, flattenCalls, nativeFlows, netNative, balanceChanges, tokenDeltas, gasInfo,
  summarize, threatTargets, receiptTransfers, isUnsupported,
} from './txdeep.js';
import { arrayOf } from './abi.js';
import { checkThreats } from './threat.js';
import { decodeTransfer } from './evm.js';
import { safeText, tokenText, formatUnits, formatZtphy, groupDigits, short, toBig } from './format.js';
import { TTL } from './rpc.js';

const MAX_TREE_DECODE = 40;

/** A source badge: verified (Sourcify) / known (this repo's contract) / guessed (selector or bytecode match). */
export function sourceBadge(ui, source, { viaProxy = false } = {}) {
  const { t, badge, h } = ui;
  const k = source === 'verified' ? ['srcVerified', 'ok'] : source === 'known' ? ['srcKnown', 'pq'] : ['srcGuessed', 'warn'];
  return h('span', { class: 'src-badge', 'data-source': source ?? 'guessed', title: t(`${k[0]}Help`) }, badge(t(k[0]), k[1]), viaProxy ? h('span', { class: 'small dim' }, ` ${t('srcViaProxy')}`) : null);
}

/** t(key) with {placeholders} replaced by nodes (links) or text. */
export function tNodes(ui, key, vars) {
  const tpl = ui.t(key);
  const out = [];
  let last = 0;
  for (const m of tpl.matchAll(/\{(\w+)\}/g)) {
    out.push(tpl.slice(last, m.index));
    const v = vars[m[1]];
    out.push(v == null ? '' : v);
    last = m.index + m[0].length;
  }
  out.push(tpl.slice(last));
  return out;
}

/** An asset { kind, token, value } as text ("1,234.5 tUSD", "10 ZETAPHY"); a promise (token info is read). */
export async function assetText(ui, a) {
  if (!a) return '';
  if (a.kind === 'native') return formatZtphy(a.value ?? 0n, { maxFrac: 6 });
  const i = await ui.tokenInfo(a.token).catch(() => ({}));
  const sym = tokenText(i.symbol, 16, short(a.token, 6, 4));
  if (a.kind === 'erc20') return `${i.decimals != null ? formatUnits(a.value, i.decimals, { maxFrac: 6 }) : groupDigits(String(a.value))} ${sym}`;
  return `${groupDigits(String(a.value))} × ${sym}`;
}

/** A decoded value: addresses as links, lists and tuples nested, bytes shortened, text sanitised. */
export function valueView(ui, p, v, depth = 0) {
  const { h, addrLink } = ui;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'hashed' in v) return h('span', { class: 'mono small', title: ui.t('xtHashedHelp') }, `keccak ${short(v.hashed, 10, 6)}`);
  const a = arrayOf(p);
  if ((a || p.type === 'tuple') && Array.isArray(v)) {
    if (depth > 4) return '…';
    const parts = v.slice(0, 50).map((x, i) => {
      const sub = a ? a.inner : p.components[i];
      return h('li', null, !a && sub?.name ? h('span', { class: 'dim' }, `${safeText(sub.name, 40)}: `) : null, valueView(ui, sub ?? { type: 'bytes' }, x, depth + 1));
    });
    return h('ol', { class: ['vals', a ? 'vals-list' : 'vals-tuple'], start: a ? '0' : null }, parts, v.length > 50 ? h('li', null, `… +${v.length - 50}`) : null);
  }
  if (p.type === 'address' && typeof v === 'string') return addrLink(v);
  if (typeof v === 'bigint') {
    if (v === (1n << 256n) - 1n) return h('span', { class: 'mono', title: v.toString() }, 'MAX (2²⁵⁶−1)');
    const s = v.toString();
    return h('span', { class: 'mono', title: v >= 10n ** 15n ? `${formatUnits(v, 18, { maxFrac: 6 })} (÷10^18)` : null }, groupDigits(s));
  }
  if (typeof v === 'boolean') return String(v);
  if (p.type === 'string') return h('span', { class: 'str' }, `"${safeText(v, 300)}"`);
  const s = String(v);
  return h('span', { class: 'mono small break' }, s.length > 260 ? `${s.slice(0, 258)}… (${groupDigits((s.length - 2) / 2)} bytes)` : s);
}

/** name(type a = …, …) as a table of arguments. */
export function argsTable(ui, inputs, values) {
  const { t, table, h } = ui;
  if (!inputs.length) return ui.note(t('xtNoArgs'));
  return table(['#', t('xtArgName'), t('xtArgType'), t('xtArgValue')], inputs.map((p, i) => [
    String(i), p.name ? safeText(p.name, 64) : '—', h('span', { class: 'mono small' }, p.type === 'tuple' || p.type.startsWith('tuple[') ? `tuple${p.type.slice(5)}` : p.type), valueView(ui, p, values[i]),
  ]), { cls: 'args' });
}

const fnText = (f) => `${f.name}(${f.inputs.map((p) => `${p.type.startsWith('tuple') ? `tuple${p.type.slice(5)}` : p.type}${p.name ? ' ' + p.name : ''}`).join(', ')})`;

/** Wraps a node error: "the node has no traces" stays apart from a failure of this one call. */
async function trace(ui, hash, tracer) {
  try {
    const r = await ui.evm('debug_traceTransaction', [hash, tracer], TTL.forever);
    return { ok: true, result: r };
  } catch (e) {
    return isUnsupported(e) ? { ok: false, unsupported: true } : { ok: false, error: safeText(e?.message ?? e, 300) };
  }
}

/**
 * The deep sections of an EVM tx page: { summary, input, cards: [...], logs }.
 * Every section loads by itself; nothing waits on traces the node may not have.
 */
export function evmTxDeep(ui, tx, rc) {
  const { t, h, card, note, kv, slot, badge, addrLink, hashLink } = ui;
  const resolver = ui.resolver();
  const dbP = resolver.sigdb();
  const infoOf = (a) => (a ? resolver.resolve(a).catch(() => null) : Promise.resolve(null));
  const toP = infoOf(tx.to);
  const inputP = Promise.all([toP, dbP]).then(([info, db]) => decodeInput(tx.input, info, db));
  const failed = rc ? rc.status !== '0x1' : false;
  const callTraceP = rc ? trace(ui, tx.hash, { tracer: 'callTracer' }) : Promise.resolve({ ok: false });
  const diffP = callTraceP.then((c) => (c.ok ? trace(ui, tx.hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }) : { ok: false, unsupported: c.unsupported }));
  const blockP = tx.blockNumber ? ui.evm('eth_getBlockByNumber', [tx.blockNumber, false], TTL.forever).catch(() => null) : Promise.resolve(null);
  const transfers = receiptTransfers(rc);
  const flatP = callTraceP.then((c) => (c.ok ? flattenCalls(c.result) : null));
  const gasP = blockP.then((b) => gasInfo(tx, rc, b));
  // native changes per address without the fee: from the prestate diff (fee added back to the sender), else from the calls
  const nativeP = Promise.all([diffP, flatP, gasP]).then(([d, flat, g]) => {
    if (d.ok) {
      const m = new Map(balanceChanges(d.result).map((r) => [r.address, r.delta]));
      const from = String(tx.from).toLowerCase();
      if (g.fee != null) m.set(from, (m.get(from) ?? 0n) + g.fee);
      return { map: m, how: 'prestate' };
    }
    if (flat) return { map: netNative(nativeFlows(flat.calls)), how: 'calls' };
    const v = toBig(tx.value) ?? 0n;
    return { map: v > 0n && tx.to ? netNative([{ from: String(tx.from).toLowerCase(), to: String(tx.to).toLowerCase(), value: v }]) : new Map(), how: 'top' };
  });

  // ---- summary ----
  const summaryP = Promise.all([inputP, nativeP, toP]).then(([input, nat, info]) => ({
    s: summarize({ tx, rc, input, transfers, native: nat.map, label: info?.label ?? (info?.source === 'verified' || info?.source === 'known' ? info.name : null) }),
    input, info,
  }));
  const summary = card(t('xtSummary'), slot(summaryP, ({ s, info }) => {
    const sentence = h('p', { class: 'summary-line', 'data-key': s.key });
    const fill = async () => {
      const vars = {};
      for (const [k, v] of Object.entries(s.vars)) {
        if (v == null) continue;
        if (typeof v === 'object') vars[k] = await assetText(ui, v);
        else if (/^0x[0-9a-f]{40}$/.test(v)) vars[k] = k === 'token' ? ui.routeLink(`token/${v}`, slotTokenName(ui, v)) : addrLink(v, { label: k === 'to' && info?.label && v === info.address ? info.label : undefined });
        else vars[k] = safeText(v, 80);
      }
      if (!s.vars.on) vars.on = '';
      sentence.replaceChildren(...tNodes(ui, s.key, vars).map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
    };
    sentence.textContent = '…';
    fill().catch(() => { sentence.textContent = t(s.key, {}); });
    const risks = h('div', { class: 'risks' }, s.risks.map((r) => riskLine(ui, r)));
    const threats = h('div', { class: 'risks' });
    if (ui.cfg.threatRegistry) {
      Promise.all(threatTargets(tx, s.risks).map((a) => checkThreats((m, p) => ui.evm(m, p, TTL.short), { registry: ui.cfg.threatRegistry, chainId: ui.cfg.evmChainId, address: a, code: null, maxDetails: 0 })
        .then((r) => ({ a, r })))).then((list) => {
        const flagged = list.filter((x) => x.r.state === 'flagged');
        if (!flagged.length) return;
        ui.fill(threats, flagged.map(({ a, r }) => h('p', { class: 'risk', role: 'alert', 'data-risk': 'riskThreat' }, '⚠ ',
          tNodes(ui, 'riskThreat', { address: addrLink(a), category: r.flags.map((f) => `${f.reasonText[ui.lang] ?? f.reasonText.en} (${f.reasonName})`).join(', ') }))),
        h('p', { class: 'disclaimer' }, ui.disclaimer()));
      }).catch(() => { /* the registry could not be read: nothing is claimed */ });
    }
    return h('div', null, sentence, risks, threats);
  }));

  // ---- decoded input ----
  const input = slot(inputP, (d) => {
    if (d.kind === 'none') return note(t('xtPlainTransfer'));
    if (d.kind !== 'decoded') return h('p', null, badge(t('xtUnknownFn'), ''), ' ', h('span', { class: 'mono' }, d.selector ?? d.data ?? ''), ' ', h('span', { class: 'small dim' }, t('xtUnknownFnHelp')));
    return h('div', { class: 'decoded-call' },
      h('p', null, h('strong', { class: 'mono fn-name' }, safeText(fnText(d.fragment), 400)), ' ', sourceBadge(ui, d.source, { viaProxy: d.viaProxy }), ' ', h('span', { class: 'mono small dim' }, `0x${d.fragment.selector}`)),
      argsTable(ui, d.fragment.inputs, d.values));
  });

  // ---- revert reason ----
  const revertCard = failed ? card(t('xtRevert'), slot(Promise.all([callTraceP, toP, dbP]).then(async ([c, info, db]) => {
    if (c.ok) {
      const out = c.result?.output ?? '0x';
      return { r: decodeRevertWith(out, info, db), how: 'trace', error: c.result?.error, text: c.result?.revertReason };
    }
    // no traces: re-run the call on the state before its block (other txs earlier in the block are not replayed)
    try {
      const prev = '0x' + (BigInt(tx.blockNumber) - 1n).toString(16);
      await ui.evm('eth_call', [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas }, prev], TTL.forever);
      return { r: null, how: 'replay-ok' };
    } catch (e) {
      const hex = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message ?? ''))?.[0];
      return { r: hex ? decodeRevertWith(hex, info, db) : { kind: 'text', message: safeText(e?.message ?? e, 300) }, how: 'replay' };
    }
  }), (x) => revertView(ui, x))) : null;

  // ---- gas ----
  const gasCard = rc ? card(t('xtGasTitle'), slot(gasP, (g) => h('div', null,
    kv([
      [t('xtGasUsed'), g.used != null && g.limit ? h('span', null, `${groupDigits(String(g.used))} / ${groupDigits(String(g.limit))} `, h('span', { class: 'dim' }, `(${g.usedPct}%)`), gasBar(ui, g.usedPct)) : '—'],
      [t('xtEffPrice'), g.price != null ? `${formatUnits(g.price, 9, { maxFrac: 4 })} gwei` : '—'],
      g.baseFee != null ? [t('xtBaseFee'), `${formatUnits(g.baseFee, 9, { maxFrac: 4 })} gwei`] : null,
      g.maxFee != null ? [t('xtMaxFee'), `${formatUnits(g.maxFee, 9, { maxFrac: 4 })} / ${formatUnits(g.maxPriority ?? 0n, 9, { maxFrac: 4 })} gwei`] : null,
      [t('xtFeeTotal'), g.fee != null ? formatZtphy(g.fee, { maxFrac: 18 }) : '—'],
      g.baseCost != null ? [t('xtFeeSplit1559'), t('xtFeeSplit1559Val', { base: formatZtphy(g.baseCost, { maxFrac: 18 }), tip: formatZtphy(g.tip ?? 0n, { maxFrac: 18 }) })] : null,
      [t('xtBurned'), g.burned != null ? h('span', null, '🔥 ', formatZtphy(g.burned, { maxFrac: 18 })) : '—'],
      [t('xtToValidators'), g.toValidators != null ? formatZtphy(g.toValidators, { maxFrac: 18 }) : '—'],
    ]),
    note(t('xtBurnNote'), 'info')))) : null;

  // ---- internal calls ----
  const callsCard = rc ? card(t('xtCalls'), slot(Promise.all([callTraceP, flatP, dbP]).then(([c, flat, db]) => ({ c, flat, db })), ({ c, flat, db }) => {
    if (!c.ok) return note(c.unsupported ? t('xtNoTraces') : `${t('xtTraceFailed')}: ${c.error}`, 'warn');
    return callTreeView(ui, flat, db, resolver);
  })) : null;

  // ---- who gained / who lost ----
  const changesCard = rc ? card(t('xtChanges'), slot(Promise.all([nativeP, diffP]).then(([nat, d]) => ({ nat, d })), ({ nat, d }) => {
    const rows = [];
    if (d.ok) {
      for (const r of balanceChanges(d.result)) rows.push([addrLink(r.address), 'ZETAPHY', formatZtphy(r.before, { maxFrac: 8 }), formatZtphy(r.after, { maxFrac: 8 }), deltaView(ui, formatZtphy(r.delta < 0n ? -r.delta : r.delta, { maxFrac: 8 }), r.delta)]);
    } else if (nat.map) {
      for (const [a, v] of nat.map) rows.push([addrLink(a), 'ZETAPHY', '—', '—', deltaView(ui, formatZtphy(v < 0n ? -v : v, { maxFrac: 8 }), v)]);
    }
    for (const r of tokenDeltas(transfers)) {
      const abs = r.delta < 0n ? -r.delta : r.delta;
      const name = slot(ui.tokenInfo(r.token), (i) => ui.routeLink(`token/${r.token}`, `${tokenText(i.symbol, 16, short(r.token, 6, 4))}${r.id != null ? ` #${safeText(String(r.id), 40)}` : ''}`), { inline: true });
      const amount = r.standard === 'erc20' ? slot(ui.tokenInfo(r.token), (i) => (i.decimals != null ? formatUnits(abs, i.decimals, { maxFrac: 8 }) : groupDigits(String(abs))), { inline: true }) : groupDigits(String(abs));
      rows.push([addrLink(r.holder), name, '—', '—', deltaView(ui, amount, r.delta)]);
    }
    const how = d.ok ? t('xtChangesPrestate') : nat.how === 'calls' ? t('xtChangesCalls') : d.unsupported ? t('xtChangesNoTrace') : t('xtChangesTop');
    return h('div', null, ui.table([t('address'), t('xtAsset'), t('xtBefore'), t('xtAfter'), t('xtChange')], rows, { empty: t('xtNoChanges'), cls: 'changes' }), note(how, 'info'));
  })) : null;

  // ---- logs ----
  const logs = (list) => {
    if (!list.length) return note(t('noLogs'));
    return h('ol', { class: 'logs' }, list.map((l) => {
      const tr = decodeTransfer(l);
      const ev = slot(Promise.all([infoOf(l.address), dbP]).then(([info, db]) => decodeLogWith(l, info, db)), (d) => (d ? h('div', { class: 'decoded-event' },
        h('div', null, h('strong', { class: 'mono' }, safeText(d.fragment.name, 64)), ' ', sourceBadge(ui, d.source), ' ', h('span', { class: 'small dim' }, t('emittedBy'), ' '), addrLink(l.address)),
        argsTable(ui, d.fragment.inputs, d.values)) : h('div', null, h('div', null, t('emittedBy'), ' ', addrLink(l.address), ' ', badge(t('xtUnknownEvent'), '')))));
      return h('li', null, tr ? ui.transferView(tr) : null, ev,
        h('details', { class: 'raw-log' }, h('summary', { class: 'small' }, t('xtRawLog')),
          h('div', { class: 'mono small break' }, (l.topics ?? []).map((x, i) => h('div', null, `topic${i}: ${safeText(x, 70)}`))),
          h('div', { class: 'mono small break' }, `data: ${safeText(String(l.data ?? '').slice(0, 1026), 1030)}${String(l.data ?? '').length > 1026 ? '…' : ''}`)));
    }));
  };

  return { summary, input, cards: [revertCard, gasCard, callsCard, changesCard].filter(Boolean), logs };
}

function riskLine(ui, r) {
  const { h, addrLink } = ui;
  const vars = { ...r.vars };
  for (const k of ['spender', 'token']) if (vars[k]) vars[k] = k === 'token' ? ui.routeLink(`token/${vars[k]}`, slotTokenName(ui, vars[k])) : addrLink(vars[k]);
  return h('p', { class: 'risk', role: 'alert', 'data-risk': r.key }, '⚠ ', tNodes(ui, r.key, vars));
}
const slotTokenName = (ui, a) => ui.slot(ui.tokenInfo(a), (i) => tokenText(i.symbol ?? i.name, 24, short(a, 8, 4)), { inline: true });

function deltaView(ui, text, delta) {
  return ui.h('span', { class: delta < 0n ? 'delta-neg' : 'delta-pos' }, delta < 0n ? '−' : '+', text);
}

function gasBar(ui, pct) {
  const bar = ui.h('span', { class: 'gasbar', role: 'img', 'aria-label': `${pct}%` }, ui.h('span', { class: 'gasbar-fill' }));
  bar.firstChild.style.width = `${Math.min(100, Math.max(0, pct ?? 0))}%`; // CSSOM, allowed by the CSP
  return bar;
}

/** The revert card's content. x: { r: decodeRevert result | null, how: 'trace' | 'replay' | 'replay-ok', error, text } */
export function revertView(ui, x) {
  const { t, h, note, badge } = ui;
  const how = x.how === 'trace' ? t('xtRevertFromTrace') : t('xtRevertReplay');
  if (x.how === 'replay-ok') return note(t('xtRevertReplayOk'), 'warn');
  const r = x.r;
  let body;
  if (!r || r.kind === 'empty') body = h('p', null, badge(t('xtRevertEmpty'), 'bad'), x.error ? h('span', { class: 'mono small' }, ` ${safeText(x.error, 200)}`) : null);
  else if (r.kind === 'error') body = h('p', null, badge('Error(string)', 'bad'), ' ', h('strong', { class: 'revert-msg' }, `"${safeText(r.message, 500)}"`));
  else if (r.kind === 'panic') body = h('p', null, badge(`Panic(0x${r.code.toString(16).padStart(2, '0')})`, 'bad'), ' ', t(r.key));
  else if (r.kind === 'custom') body = h('div', null, h('p', null, badge(t('xtCustomError'), 'bad'), ' ', h('strong', { class: 'mono' }, safeText(r.fragment.name, 64)), ' ', sourceBadge(ui, r.source)), argsTable(ui, r.fragment.inputs, r.values));
  else if (r.kind === 'text') body = h('p', { class: 'mono small break' }, r.message);
  else body = h('p', null, badge(t('xtRevertRaw'), 'bad'), ' ', h('span', { class: 'mono small break' }, safeText(r.data, 2100)));
  return h('div', null, body, x.error && r?.kind !== 'empty' ? h('p', { class: 'small dim' }, `EVM: ${safeText(x.error, 200)}`) : null, note(how));
}

/** The call tree: one row per call, indented by depth, callees decoded best effort. */
function callTreeView(ui, flat, db, resolver) {
  const { t, h, badge, addrLink, note } = ui;
  const decodedCallees = new Set();
  const rows = flat.calls.map((c) => {
    const row = h('li', { class: ['call', c.reverted ? 'call-reverted' : ''], 'data-depth': String(c.depth) });
    row.style.marginLeft = `${Math.min(c.depth, 12) * 14}px`; // CSSOM, allowed by the CSP
    let fn = h('span', { class: 'mono small dim' }, c.input.length >= 10 ? c.input.slice(0, 10) : '');
    if (c.to && c.input.length >= 10 && c.type !== 'CREATE' && c.type !== 'CREATE2') {
      const canDecode = decodedCallees.size < MAX_TREE_DECODE || decodedCallees.has(c.to);
      decodedCallees.add(c.to);
      fn = ui.slot((canDecode ? resolver.resolve(c.to).catch(() => null) : Promise.resolve(null)).then((info) => decodeInput(c.input, info, db)), (d) => (d.kind === 'decoded'
        ? h('span', { class: 'mono small' }, `${safeText(d.fragment.name, 64)}(${d.values.length ? '…' : ''})`, ' ', sourceBadge(ui, d.source))
        : h('span', { class: 'mono small dim' }, c.input.slice(0, 10))), { inline: true });
    }
    ui.append(row,
      badge(c.type, c.type === 'DELEGATECALL' ? 'pq' : c.type === 'STATICCALL' ? '' : 'evm'), ' ',
      c.from ? addrLink(c.from) : '?', ' → ', c.to ? addrLink(c.to) : '?', ' ',
      fn,
      c.value > 0n ? h('span', { class: 'call-value' }, ` · ${formatZtphy(c.value, { maxFrac: 8 })}`) : null,
      c.gasUsed != null ? h('span', { class: 'small dim' }, ` · ${t('xtGasShort')} ${groupDigits(String(c.gasUsed))}`) : null,
      c.error ? h('span', null, ' ', badge(safeText(c.revertReason || c.error, 80), 'bad')) : c.reverted ? h('span', null, ' ', badge(t('xtUndone'), 'warn')) : null);
    return row;
  });
  const moved = nativeFlows(flat.calls).filter((f) => f.depth > 0);
  return h('div', null,
    h('ol', { class: 'calltree' }, rows),
    flat.truncated ? note(t('xtTreeTruncated', { n: flat.calls.length }), 'warn') : null,
    moved.length ? h('div', null, h('h3', null, t('xtInternalTransfers')), ui.table([t('from'), t('to'), t('value')], moved.map((f) => [addrLink(f.from), addrLink(f.to), formatZtphy(f.value, { maxFrac: 18 })]))) : null);
}

