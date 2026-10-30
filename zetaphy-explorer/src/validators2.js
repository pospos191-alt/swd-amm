// Validators, deeper: the list (sort, filter, uptime, Nakamoto coefficient) and one
// validator's page (#/validator/<valoper>): uptime and missed blocks from the commit
// signatures of the last N blocks, its slashing record, self-bond, delegators,
// commission changes, its PQ vote key and how often its ML-DSA-44 signature was in
// the block certificates. No indexer: everything is read from the node, bounded.
// The pure functions at the top are unit tested; the pages take the app's view kit `c`.
import { toBech32, fromBech32, hexToBytes } from '../vendor/zetaphy-lib.js';
import { TTL } from './rpc.js';
import { decodeTx, normalizeEvents } from './cosmos.js';
import { safeText, short, groupDigits, percent, toValoper, toBig, utcTime, ago, formatZtphy, fromBase64 } from './format.js';

export const VALCONS_PREFIX = 'zetaphyvalcons';
export const WINDOWS = [50, 100, 200];

/** A CometBFT commit signature's state: 'commit' | 'nil' | 'absent' (block_id_flag 2 / 3 / 1, numbers or names). */
export function commitFlag(sig) {
  const f = sig?.block_id_flag;
  if (f === 2 || f === '2' || f === 'BLOCK_ID_FLAG_COMMIT') return 'commit';
  if (f === 3 || f === '3' || f === 'BLOCK_ID_FLAG_NIL') return 'nil';
  return 'absent';
}

/**
 * What block B tells about block B-1: who signed its commit (last_commit) and, when tx[0]
 * is a MsgPQCertificate, whose ML-DSA-44 signatures it carries.
 * -> { height (the committed block, B-1), sigs: Map(consAddr upper -> state), certSigners: Set | null }
 */
export function parseWindowBlock(b) {
  const blk = b?.block;
  const lc = blk?.last_commit;
  const height = Number(lc?.height ?? (Number(blk?.header?.height ?? 0) - 1));
  const sigs = new Map();
  for (const s of Array.isArray(lc?.signatures) ? lc.signatures : []) {
    const a = String(s?.validator_address ?? '').toUpperCase();
    if (a) sigs.set(a, commitFlag(s));
  }
  let certSigners = null;
  const tx0 = blk?.data?.txs?.[0];
  if (tx0) {
    try {
      const d = decodeTx(fromBase64(tx0));
      const att = d.isCertificate ? d.messages[0].certificate?.attestations : null;
      if (att) certSigners = new Set(att.map((x) => x.address));
    } catch { /* not a certificate */ }
  }
  return { height, sigs, certSigners, hasCommit: !!lc };
}

/**
 * Uptime of one validator (consensus address, upper hex) over parsed blocks:
 * { signed, missed, nil, out, total, pct (0–100, null when never in the set), strip: [{ height, state }] }.
 * state: 'signed' | 'missed' (absent) | 'nil' (voted nil, counts as missed) | 'out' (not in the set: not counted).
 */
export function uptime(entries, address) {
  const a = String(address ?? '').toUpperCase();
  const strip = []; let signed = 0; let missed = 0; let nil = 0; let out = 0;
  for (const e of [...entries].sort((x, y) => x.height - y.height)) {
    if (!e.hasCommit && !e.sigs.size) continue;
    const s = e.sigs.get(a);
    const state = s === 'commit' ? 'signed' : s === 'nil' ? 'nil' : s === 'absent' ? 'missed' : 'out';
    if (state === 'signed') signed++; else if (state === 'nil') nil++; else if (state === 'missed') missed++; else out++;
    strip.push({ height: e.height, state });
  }
  const total = signed + missed + nil;
  return { signed, missed, nil, out, total, pct: total ? Math.round((signed * 10000) / total) / 100 : null, strip };
}

/** How many certificates in the window carry this validator's ML-DSA-44 signature: { included, certs }. */
export function certInclusion(entries, address) {
  const a = String(address ?? '').toUpperCase();
  let certs = 0; let included = 0;
  for (const e of entries) if (e.certSigners) { certs++; if (e.certSigners.has(a)) included++; }
  return { included, certs };
}

/**
 * Nakamoto coefficient: the fewest validators whose voting power together is at least 1/3
 * of the total (enough to halt the chain). powers: BigInt / number / string list. 0 when no power.
 */
export function nakamoto(powers) {
  const ps = powers.map((p) => BigInt(p)).filter((p) => p > 0n).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const total = ps.reduce((n, p) => n + p, 0n);
  if (!total) return 0;
  let acc = 0n;
  for (let i = 0; i < ps.length; i++) { acc += ps[i]; if (acc * 3n >= total) return i + 1; }
  return ps.length;
}

/** A cosmos.Dec ("0.050000000000000000") as a number (NaN when not one). */
export const decNum = (s) => (/^-?\d+(\.\d+)?$/.test(String(s ?? '').trim()) ? Number(s) : NaN);

/** Filter rows: q matches moniker / operator / consensus address; status 'all' | 'active' | 'inactive' | 'jailed'. */
export function filterRows(rows, { q = '', status = 'all' } = {}) {
  const s = String(q).trim().toLowerCase();
  return rows.filter((r) => {
    if (status === 'active' && !r.active) return false;
    if (status === 'inactive' && (r.active || r.jailed)) return false;
    if (status === 'jailed' && !r.jailed) return false;
    if (!s) return true;
    return [r.moniker, r.operator, r.address].some((x) => String(x ?? '').toLowerCase().includes(s));
  });
}

/** Sort rows by 'power' | 'commission' | 'uptime' | 'moniker' | 'pq'; dir 1 ascending, -1 descending. */
export function sortRows(rows, key = 'power', dir = -1, uptimes = new Map()) {
  const val = (r) => {
    switch (key) {
      case 'commission': return decNum(r.commission);
      case 'uptime': return uptimes.get(r.address)?.pct ?? -1;
      case 'moniker': return String(r.moniker ?? '').toLowerCase();
      case 'pq': return r.voteKey?.registered ? 1 : 0;
      default: return r.power ?? 0n;
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a); const y = val(b);
    const c = x > y ? 1 : x < y ? -1 : 0;
    return c * dir || (b.power > a.power ? 1 : b.power < a.power ? -1 : 0);
  });
}

/** Consensus address (upper hex) -> zetaphyvalcons1…; '' when not 20 bytes. */
export function valcons(addrHex) {
  try { const b = hexToBytes(String(addrHex)); return b.length === 20 ? toBech32(b, VALCONS_PREFIX) : ''; } catch { return ''; }
}
export function valconsToHex(v) {
  try { return Array.from(fromBech32(String(v), VALCONS_PREFIX), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase(); } catch { return ''; }
}

/** Slash events in a block's results (finalize_block_events / begin_block_events): [{ address, power, reason, jailed }]. */
export function slashEvents(results) {
  const evs = normalizeEvents([...(results?.finalize_block_events ?? []), ...(results?.begin_block_events ?? [])]);
  return evs.filter((e) => e.type === 'slash').map((e) => {
    const get = (k) => e.attributes.find((a) => a.key === k)?.value ?? '';
    return { address: get('address'), power: get('power'), reason: get('reason'), jailed: get('jailed'), burned: get('burned_coins') };
  });
}

// ---- the window of recent blocks (shared by the list and the validator page) ----

const parsed = new Map(); // block height B -> parseWindowBlock(B)

/** Parsed info for the commits of blocks [latest-n, latest-1] (blocks latest-n+1 … latest are read). */
export async function loadWindow(chain, latest, n, onProgress) {
  const top = Number(latest);
  const lo = Math.max(2, top - n + 1);
  const hs = []; for (let b = top; b >= lo; b--) hs.push(b);
  let done = 0;
  const out = await Promise.all(hs.map(async (b) => {
    let e = parsed.get(b);
    if (!e) {
      try { e = parseWindowBlock(await chain.block(b)); } catch { e = { height: b - 1, sigs: new Map(), certSigners: null, hasCommit: false }; }
      parsed.set(b, e);
      if (parsed.size > 2000) parsed.delete(parsed.keys().next().value);
    }
    onProgress?.(++done, hs.length);
    return e;
  }));
  return { entries: out, from: lo - 1, to: top - 1 };
}

// ---- view helpers ----

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

/** The missed-blocks heat strip: one cell per block, oldest left (inline SVG, colours from CSS classes). */
export function heatStrip(strip, labels) {
  const w = 6; const gap = 1; const n = Math.max(1, strip.length);
  const s = svgEl('svg', { class: 'heat-strip', viewBox: `0 0 ${n * (w + gap)} 14`, preserveAspectRatio: 'none', role: 'img', 'aria-label': labels.aria });
  strip.forEach((x, i) => s.append(svgEl('rect', { x: i * (w + gap), y: 0, width: w, height: 14, rx: 1, class: `hs-${x.state}` },
    svgEl('title', {}, `#${groupDigits(x.height)} · ${labels[x.state]}`))));
  return s;
}

const pctText = (x) => (x == null ? '—' : `${x.toFixed(2)}%`);
const rateText = (r) => { const n = decNum(r); return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—'; };

function stripLabels(t) {
  return { aria: t('vdStripAria'), signed: t('vdSigned'), missed: t('vdMissed'), nil: t('vdNil'), out: t('vdNotInSet') };
}

function legend(h, t) {
  return h('p', { class: 'heat-legend small dim' }, ...['signed', 'missed', 'nil', 'out'].map((k) => h('span', null, h('span', { class: `swatch hs-${k}` }), ' ', stripLabels(t)[k], ' ')));
}

// ---- #/validators: the list ----

export async function pageValidatorList(c, view) {
  const { t, h, chain } = c;
  const st = await chain.status();
  const rows = await c.getValidators(st.height);
  const active = rows.filter((r) => r.active);
  const total = active.reduce((n, r) => n + r.power, 0n);
  const keyed = active.filter((r) => r.voteKey?.registered).reduce((n, r) => n + r.power, 0n);
  const nk = nakamoto(active.map((r) => r.power));
  const nkPq = nakamoto(active.filter((r) => r.voteKey?.registered).map((r) => r.power));
  const state = { q: '', status: 'all', key: 'power', dir: -1, uptimes: new Map() };
  const n = Math.min(50, Math.max(1, Number(st.height) - 1));
  const upNote = h('p', { class: 'note' }, t('vdUptimeLoading', { n }));
  const body = h('div');
  const search = h('input', { type: 'search', placeholder: t('vdFilter'), 'aria-label': t('vdFilter'), class: 'v2-filter', on: { input: (e) => { state.q = e.target.value; draw(); } } });
  const statusSel = h('select', { class: 'lang-select', 'aria-label': t('status'), on: { change: (e) => { state.status = e.target.value; draw(); } } },
    ...[['all', t('vdAll')], ['active', t('active')], ['inactive', t('inactive')], ['jailed', t('jailed')]].map(([v, l]) => h('option', { value: v }, l)));
  const sortBtn = (key, label) => h('button', { type: 'button', class: 'th-sort', data: { sort: key }, on: { click: () => { state.dir = state.key === key ? -state.dir : (key === 'moniker' ? 1 : -1); state.key = key; draw(); } } }, label);

  c.append(view, [
    h('h1', null, t('validators')),
    c.card(null, c.kv([
      [t('activeValidators'), String(active.length)],
      [t('totalPower'), groupDigits(total.toString())],
      [t('pqKeyPower'), `${groupDigits(keyed.toString())} (${percent(keyed, total || 1n)})`],
      [t('atHeight'), c.blockLink(st.height)],
      [t('vdNakamoto'), h('span', { class: 'nakamoto' }, String(nk))],
      [t('vdNakamotoPq'), String(nkPq)],
    ]), c.note(t('pqKeyExplain')), c.note(t('vdNakamotoNote'))),
    c.card(null, h('div', { class: 'row v2-tools' }, search, statusSel), body, upNote),
  ]);

  function draw() {
    const list = sortRows(filterRows(rows, state), state.key, state.dir, state.uptimes);
    const arrow = (k) => (state.key === k ? (state.dir > 0 ? ' ▲' : ' ▼') : '');
    const cols = [['#'], [t('validator'), 'moniker'], [t('operator')], [t('power'), 'power'], [t('status')], [t('commission'), 'commission'], [t('vdUptime'), 'uptime'], [t('voteKey'), 'pq']];
    const rowsOut = list.map((r, i) => {
      const u = state.uptimes.get(r.address);
      return [
        String(i + 1),
        r.operator ? c.routeLink(`validator/${r.operator}`, safeText(r.moniker || '—', 40), { class: 'moniker' }) : safeText(r.moniker || '—', 40),
        r.operator ? h('span', null, h('span', { class: 'mono small', title: r.operator }, short(r.operator, 18, 6)), ' ', toValoper(r.operator)?.account ? c.routeLink(`address/${toValoper(r.operator).account.hex}`, t('accountLink'), { class: 'small' }) : null) : '—',
        r.active ? `${groupDigits(r.power.toString())} (${percent(r.power, total || 1n)})` : '0',
        r.jailed ? c.badge(t('jailed'), 'bad') : r.active ? c.badge(t('active'), 'ok') : c.badge(t('inactive'), ''),
        r.commission ? rateText(r.commission).replace(/(\.\d)0%$/, '$1%') : '—',
        u ? h('span', { class: u.pct != null && u.pct < 95 ? 'warn-text' : '' }, pctText(u.pct)) : '…',
        r.voteKey?.registered ? h('span', null, c.badge(t('registered'), 'ok'), r.voteKey.since ? h('span', { class: 'small dim' }, ` ${t('sinceBlock', { h: groupDigits(r.voteKey.since) })}`) : null)
          : r.voteKey?.registered === false ? c.badge(t('notRegistered'), 'warn') : c.badge('?', ''),
      ];
    });
    // Own table (not c.table): the headers are sort buttons, the phone labels stay text.
    c.fill(body, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'v2-table' },
      h('thead', null, h('tr', null, cols.map(([label, key]) => h('th', { scope: 'col', 'aria-sort': key && state.key === key ? (state.dir > 0 ? 'ascending' : 'descending') : null }, key ? sortBtn(key, label + arrow(key)) : label)))),
      h('tbody', null, rowsOut.map((cells) => h('tr', null, cells.map((x, j) => h('td', { 'data-label': cols[j][0] }, x))))))) : c.note(t('none')));
  }
  draw();
  loadWindow(chain, st.height, n).then((w) => {
    for (const r of rows) if (r.address) state.uptimes.set(r.address, uptime(w.entries, r.address));
    if (!view.isConnected) return;
    upNote.textContent = t('vdUptimeNote', { n: groupDigits(w.to - w.from + 1), from: groupDigits(w.from), to: groupDigits(w.to) });
    draw();
  }).catch((e) => { upNote.textContent = `${t('error')}: ${safeText(e.message, 200)}`; });
}

// ---- #/validator/<valoper> ----

export async function pageValidator(c, view, param) {
  const { t, h, chain, api } = c;
  const vo = toValoper(decodeURIComponent(param ?? ''));
  if (!vo) { c.append(view, c.errorBox(t('vdBadValoper'))); return; }
  const st = await chain.status();
  const rows = await c.getValidators(st.height).catch(() => []);
  const row = rows.find((r) => r.operator === vo.valoper) ?? null;
  let v = null;
  try { v = (await api.rest(`cosmos/staking/v1beta1/validators/${encodeURIComponent(vo.valoper)}`, TTL.short))?.validator ?? null; } catch (e) { if (!row) throw e; }
  const active = rows.filter((r) => r.active);
  const total = active.reduce((n, r) => n + r.power, 0n);
  const cons = row?.address || '';
  const vc = valcons(cons);
  const moniker = safeText(v?.description?.moniker ?? row?.moniker ?? '', 60) || short(vo.valoper, 18, 6);
  const website = String(v?.description?.website ?? '');
  const com = v?.commission ?? {};
  const rates = com.commission_rates ?? {};
  const jailed = !!(v?.jailed ?? row?.jailed);
  const statusText = String(v?.status ?? row?.status ?? '');

  const pq = pqKeyCard(c, row);
  // the slashing and commission reads go out before the window's block reads (one queue)
  const slashBox = slashingCard(c, cons, vc);
  const comBox = commissionCard(c, vo, rates.rate);
  c.append(view, [
    h('h1', null, moniker, ' ', jailed ? c.badge(t('jailed'), 'bad') : row?.active ? c.badge(t('active'), 'ok') : c.badge(t('inactive'), '')),
    h('p', null, c.routeLink('validators', `← ${t('validators')}`)),
    c.card(t('overview'), c.kv([
      [t('operator'), h('span', { class: 'mono break' }, vo.valoper, ' ', c.copyBtn(vo.valoper))],
      [t('account'), c.addrLink(vo.account.hex, { full: true })],
      [t('consAddress'), cons ? h('span', { class: 'mono break' }, cons, vc ? h('span', { class: 'small dim' }, ` · ${vc}`) : null) : '—'],
      [t('status'), safeText(statusText.replace('BOND_STATUS_', '').toLowerCase(), 30) || '—'],
      [t('power'), row?.active ? `${groupDigits(row.power.toString())} (${percent(row.power, total || 1n)})` : '0'],
      [t('vdTokens'), v?.tokens ? formatZtphy(v.tokens, { maxFrac: 2 }) : '—'],
      [t('commission'), h('span', null, rateText(rates.rate), h('span', { class: 'small dim' }, ` · ${t('vdMaxRate')} ${rateText(rates.max_rate)} · ${t('vdMaxChange')} ${rateText(rates.max_change_rate)}`))],
      [t('vdCommissionUpdated'), com.update_time ? `${utcTime(com.update_time)} (${ago(com.update_time, Date.now(), c.lang)})` : '—'],
      [t('vdMinSelf'), v?.min_self_delegation ? formatZtphy(v.min_self_delegation, { maxFrac: 18 }) : '—'],
      [t('vdSelfBond'), c.slot(api.rest(`cosmos/staking/v1beta1/validators/${encodeURIComponent(vo.valoper)}/delegations/${encodeURIComponent(vo.account.bech32)}`, TTL.short)
        .then((r) => toBig(r?.delegation_response?.balance?.amount) ?? 0n).catch(() => 0n),
      (x) => `${formatZtphy(x, { maxFrac: 4 })}${v?.tokens && toBig(v.tokens) ? ` (${percent(x, toBig(v.tokens))})` : ''}`, { inline: true })],
      [t('vdDelegators'), c.slot(api.rest(`cosmos/staking/v1beta1/validators/${encodeURIComponent(vo.valoper)}/delegations?pagination.limit=1&pagination.count_total=true`, TTL.minute),
        (r) => (r?.pagination?.total != null ? groupDigits(String(toBig(r.pagination.total) ?? '?')) : '?'), { inline: true })],
      website && /^https:\/\//i.test(website) ? [t('vdWebsite'), h('a', { href: website, target: '_blank', rel: 'noopener noreferrer' }, safeText(website, 80))] : null,
      v?.description?.details ? [t('vdDetails'), safeText(v.description.details, 280)] : null,
    ])),
    pq.box,
    uptimeCard(c, st.height, cons, pq.cert),
    slashBox,
    comBox,
  ]);
}

function pqKeyCard(c, row) {
  const { t, h } = c;
  const k = row?.voteKey;
  const cert = h('span', { class: 'v2-cert' }, '…');
  const box = c.card(t('vdPqTitle'), c.kv([
    [t('voteKey'), k?.registered ? h('span', null, c.badge(t('registered'), 'ok'), k.since ? ` ${t('sinceBlock', { h: groupDigits(k.since) })}` : '', k.rotated ? ` · ${t('vdRotated')}` : '')
      : k?.registered === false ? c.badge(t('notRegistered'), 'warn') : c.badge('?', '')],
    [t('vdCertIncluded'), cert],
  ]), c.note(t('vdCertNote')));
  return { box, cert };
}

function uptimeCard(c, latest, cons, certEl) {
  const { t, h, chain } = c;
  const body = h('div');
  const maxN = Math.max(1, Number(latest) - 1);
  const choices = WINDOWS.filter((x) => x < maxN).concat(maxN <= 200 ? [maxN] : []);
  const sel = h('select', { class: 'lang-select win-select', 'aria-label': t('vdWindow'), on: { change: (e) => run(Number(e.target.value)) } },
    ...choices.map((x) => h('option', { value: String(x) }, t('vdLastN', { n: groupDigits(x) }))));
  const first = Math.min(100, maxN);
  sel.value = String(choices.includes(first) ? first : choices[choices.length - 1]);
  const box = c.card(t('vdUptimeTitle'), h('div', { class: 'row' }, h('label', null, t('vdWindow'), ' ', sel)), body);
  let token = 0;
  function run(n) {
    const my = ++token;
    const prog = h('p', { class: 'loading', role: 'status' }, t('loading'));
    c.fill(body, prog);
    if (!cons) { c.fill(body, c.note(t('vdNoCons'), 'warn')); return; }
    loadWindow(chain, latest, n, (d, all) => { prog.textContent = t('vdReading', { d, n: all }); }).then((w) => {
      if (my !== token) return;
      const u = uptime(w.entries, cons);
      const ci = certInclusion(w.entries, cons);
      if (certEl) certEl.textContent = ci.certs ? `${groupDigits(ci.included)} / ${groupDigits(ci.certs)} (${percent(ci.included, ci.certs)})` : t('vdNoCerts');
      c.fill(body,
        c.kv([
          [t('vdUptime'), h('strong', { class: 'v2-uptime' }, pctText(u.pct))],
          [t('vdSigned'), groupDigits(u.signed)],
          [t('vdMissed'), groupDigits(u.missed + u.nil)],
          u.out ? [t('vdNotInSet'), groupDigits(u.out)] : null,
        ]),
        heatStrip(u.strip, stripLabels(t)),
        legend(h, t),
        c.note(t('vdUptimeNote', { n: groupDigits(w.to - w.from + 1), from: groupDigits(w.from), to: groupDigits(w.to) }), 'info'),
        u.missed + u.nil ? h('details', null, h('summary', null, t('vdMissedList')), h('p', { class: 'mono small' },
          ...u.strip.filter((x) => x.state === 'missed' || x.state === 'nil').slice(-60).flatMap((x) => [c.blockLink(String(x.height)), ' ']))) : null);
    }).catch((e) => { if (my === token) c.fill(body, c.errorBox(e)); });
  }
  run(Number(sel.value));
  return box;
}

function slashingCard(c, cons, vc) {
  const { t, h, api, chain } = c;
  const info = h('div', null, c.loading());
  const hist = h('div', null, c.loading());
  if (!vc) { c.fill(info, c.note(t('vdNoCons'), 'warn')); c.fill(hist, ''); return c.card(t('vdSlashTitle'), info); }
  Promise.all([
    api.rest(`cosmos/slashing/v1beta1/signing_infos/${vc}`, TTL.short).then((r) => r?.val_signing_info ?? null),
    api.rest('cosmos/slashing/v1beta1/params', TTL.minute).then((r) => r?.params ?? null).catch(() => null),
  ]).then(([si, p]) => {
    const jailedUntil = si?.jailed_until && Date.parse(si.jailed_until) > 0 ? si.jailed_until : null;
    c.fill(info, c.kv([
      [t('vdMissedCounter'), si ? `${groupDigits(String(si.missed_blocks_counter ?? '0'))}${p?.signed_blocks_window ? ` / ${groupDigits(String(p.signed_blocks_window))}` : ''}` : '—'],
      p?.min_signed_per_window ? [t('vdMinSigned'), rateText(p.min_signed_per_window)] : null,
      [t('vdStartHeight'), si?.start_height ? c.blockLink(String(si.start_height)) : '—'],
      [t('vdJailedUntil'), jailedUntil ? `${utcTime(jailedUntil)}` : t('none')],
      [t('vdTombstoned'), si?.tombstoned ? c.badge(t('yes'), 'bad') : t('no')],
      p?.slash_fraction_downtime ? [t('vdSlashDowntime'), rateText(p.slash_fraction_downtime)] : null,
      p?.slash_fraction_double_sign ? [t('vdSlashDouble'), rateText(p.slash_fraction_double_sign)] : null,
    ]));
  }).catch((e) => c.fill(info, c.note(`${t('vdNoSigningInfo')} (${safeText(e.message, 120)})`, 'warn')));
  // Slash events: CometBFT block_search over finalize-block events (needs the node's indexer).
  api.comet('block_search', { query: `slash.address='${vc}'`, page: '1', per_page: '20', order_by: 'desc' }, TTL.minute).then(async (r) => {
    const heights = (r?.blocks ?? []).map((b) => String(b?.block?.header?.height ?? '')).filter(Boolean).slice(0, 20);
    const rowsOut = [];
    for (const hgt of heights) {
      const res = await chain.blockResults(hgt).catch(() => null);
      for (const e of slashEvents(res)) if (!e.address || e.address === vc) rowsOut.push([c.blockLink(hgt), safeText(e.reason || '—', 40), e.jailed ? safeText(e.jailed, 60) : '—', groupDigits(safeText(e.power || '—', 30))]);
    }
    c.fill(hist, c.table([t('block'), t('vdReason'), t('jailed'), t('power')], rowsOut, { empty: t('vdNoSlashes') }), c.note(t('vdSlashNote')));
  }).catch(() => c.fill(hist, c.note(t('vdSlashUnavailable'), 'warn')));
  return c.card(t('vdSlashTitle'), info, h('h3', null, t('vdSlashHistory')), hist);
}

function commissionCard(c, vo, current) {
  const { t, h, api } = c;
  const body = h('div', null, c.loading());
  const q = `message.action='/cosmos.staking.v1beta1.MsgEditValidator' AND message.sender='${vo.account.bech32}'`;
  // The operator signs MsgEditValidator from its account; the edit_validator event has the new rate.
  api.comet('tx_search', { query: q, prove: false, page: '1', per_page: '30', order_by: 'desc' }, TTL.minute).then((r) => {
    const list = [];
    for (const x of r?.txs ?? []) {
      const ev = normalizeEvents(x?.tx_result?.events).find((e) => e.type === 'edit_validator');
      const rate = ev?.attributes.find((a) => a.key === 'commission_rate')?.value;
      if (rate && rate !== '<nil>') list.push([c.blockLink(String(x.height)), rateText(rate), c.hashLink(String(x.hash ?? ''))]);
    }
    c.fill(body, c.table([t('block'), t('commission'), t('txHash')], list, { empty: t('vdNoCommissionChanges') }), c.note(t('vdCommissionNote', { r: rateText(current) })));
  }).catch(() => c.fill(body, c.note(t('vdCommissionUnavailable', { r: rateText(current) }), 'warn')));
  return c.card(t('vdCommissionTitle'), body);
}
