// Governance (#/gov, #/gov/<id>): x/gov v1 proposals from the node's REST, their
// messages decoded with the explorer's own decoder (the proposal's protobuf bytes,
// read with abci_query; the REST JSON when that is refused), the tally against the
// quorum / threshold / veto rules from the gov params, a live countdown, the votes
// (paginated) and the deposits. For "what would this change do", it links to the
// hub's governance assistant (simulation with eth_call). Read only: nothing is signed here.
import { protoFields, bytesToHex } from '../vendor/zetaphy-lib.js';
import { TTL } from './rpc.js';
import { decodeAny, decodeMessage } from './cosmos.js';
import { safeText, groupDigits, utcTime, ago, formatCoin, formatZtphy, toBig, fromBase64, heightParam } from './format.js';

export const STATUS_KEYS = {
  PROPOSAL_STATUS_DEPOSIT_PERIOD: 'govDeposit', PROPOSAL_STATUS_VOTING_PERIOD: 'govVoting', PROPOSAL_STATUS_PASSED: 'govPassed',
  PROPOSAL_STATUS_REJECTED: 'govRejected', PROPOSAL_STATUS_FAILED: 'govFailedStatus',
};
const STATUS_NUM = ['', 'PROPOSAL_STATUS_DEPOSIT_PERIOD', 'PROPOSAL_STATUS_VOTING_PERIOD', 'PROPOSAL_STATUS_PASSED', 'PROPOSAL_STATUS_REJECTED', 'PROPOSAL_STATUS_FAILED'];
export const OPTION_KEYS = { VOTE_OPTION_YES: 'govYes', VOTE_OPTION_NO: 'govNo', VOTE_OPTION_ABSTAIN: 'govAbstain', VOTE_OPTION_NO_WITH_VETO: 'govVeto' };

/** A cosmos.Dec string ("0.334000000000000000") as a BigInt scaled by 1e18 (null when not one). */
export function parseDec(s) {
  const m = /^(\d+)(?:\.(\d{1,18}))?\d*$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

const E18 = 10n ** 18n;
/** part / total in percent with two decimals, as a number (0 when total is 0). */
export const pct = (part, total) => (total > 0n ? Number((BigInt(part) * 10000n) / BigInt(total)) / 100 : 0);

/**
 * The x/gov v1 tally rule (cosmos-sdk x/gov/keeper/tally.go):
 *   quorum: voted / bonded >= quorum
 *   all abstain: fails;  veto: veto / voted > veto_threshold -> rejected (deposits burned)
 *   passes: yes / (voted - abstain) > threshold
 * tally { yes, no, abstain, veto } (BigInt or strings), bonded tokens, params { quorum, threshold, vetoThreshold } (Dec strings).
 * -> { voted, percents: { yes, no, abstain, veto } (of the votes), turnout (% of bonded), quorumReached, vetoed, yesShare (% of non-abstain), passing }
 */
export function tallySummary(tally, bonded, params) {
  const v = (k) => toBig(tally?.[k]) ?? 0n;
  const yes = v('yes'); const no = v('no'); const abstain = v('abstain'); const veto = v('veto');
  const voted = yes + no + abstain + veto;
  const b = toBig(bonded) ?? 0n;
  const q = parseDec(params?.quorum); const th = parseDec(params?.threshold); const vt = parseDec(params?.vetoThreshold);
  const quorumReached = q == null || b === 0n ? null : voted * E18 >= q * b;
  const nonAbstain = voted - abstain;
  const vetoed = vt == null || voted === 0n ? false : veto * E18 > vt * voted;
  const yesPass = th == null || nonAbstain === 0n ? false : yes * E18 > th * nonAbstain;
  return {
    voted,
    percents: { yes: pct(yes, voted), no: pct(no, voted), abstain: pct(abstain, voted), veto: pct(veto, voted) },
    turnout: pct(voted, b), quorumReached, vetoed, yesShare: pct(yes, nonAbstain),
    passing: quorumReached !== false && !vetoed && yesPass,
  };
}

/** REST tally (v1 names *_count; v1beta1 names without) -> { yes, no, abstain, veto } strings. */
export function normTally(x) {
  const g = (a, b) => String(x?.[a] ?? x?.[b] ?? '0');
  return { yes: g('yes_count', 'yes'), no: g('no_count', 'no'), abstain: g('abstain_count', 'abstain'), veto: g('no_with_veto_count', 'no_with_veto') };
}

/** Seconds left until `end` as { d, h, m, s, done }. */
export function countdown(end, now = Date.now()) {
  const ms = Date.parse(end) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { d: 0, h: 0, m: 0, s: 0, done: true };
  const x = Math.floor(ms / 1000);
  return { d: Math.floor(x / 86400), h: Math.floor((x % 86400) / 3600), m: Math.floor((x % 3600) / 60), s: x % 60, done: false };
}

/** Proposal protobuf (cosmos.gov.v1.Proposal) -> { id, status, messages: [decoded] } (only what the page needs). */
export function decodeProposalProto(bytes) {
  const f = protoFields(bytes);
  const id = f.find((x) => x.field === 1 && x.wire === 0)?.value ?? 0n;
  const status = Number(f.find((x) => x.field === 3 && x.wire === 0)?.value ?? 0n);
  const messages = f.filter((x) => x.field === 2 && x.wire === 2).map((x) => decodeMessage(decodeAny(x.value)));
  return { id, status: STATUS_NUM[status] ?? '', messages };
}

/** QueryProposalRequest { proposal_id = 1 } as hex (abci_query data). */
export function proposalRequestHex(id) {
  let v = BigInt(id); const out = [0x08];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return bytesToHex(Uint8Array.from(out));
}

/** A REST JSON message flattened to [key, text] pairs (bounded, sanitised): the fallback view. */
export function flattenJson(obj, prefix = '', out = [], depth = 0) {
  if (out.length >= 40) return out;
  if (obj == null || typeof obj !== 'object') { out.push([prefix || 'value', safeText(String(obj ?? ''), 300)]); return out; }
  if (depth > 4) { out.push([prefix, '…']); return out; }
  for (const [k, v] of Object.entries(obj).slice(0, 40)) {
    if (k === '@type') continue;
    const key = prefix ? `${prefix}.${safeText(k, 40)}` : safeText(k, 40);
    if (v != null && typeof v === 'object') flattenJson(v, key, out, depth + 1); else out.push([key, safeText(String(v ?? ''), 300)]);
    if (out.length >= 40) break;
  }
  return out;
}

const statusBadge = (c, s) => {
  const k = STATUS_KEYS[s];
  const kind = s === 'PROPOSAL_STATUS_PASSED' ? 'ok' : s === 'PROPOSAL_STATUS_VOTING_PERIOD' ? 'pq' : s === 'PROPOSAL_STATUS_DEPOSIT_PERIOD' ? 'warn' : 'bad';
  return c.badge(k ? c.t(k) : safeText(String(s).replace('PROPOSAL_STATUS_', '').toLowerCase(), 20) || '?', kind);
};

async function tallyParams(api) {
  const r = await api.rest('cosmos/gov/v1/params/tallying', TTL.minute);
  const p = r?.params ?? r?.tally_params ?? {};
  return { quorum: p.quorum, threshold: p.threshold, vetoThreshold: p.veto_threshold, expeditedThreshold: p.expedited_threshold };
}

/** The tally bars: one segment per option (CSSOM widths, allowed by the CSP) and quorum / threshold lines. */
function tallyView(c, tally, s, params) {
  const { t, h } = c;
  const segs = [['yes', 'govYes'], ['no', 'govNo'], ['veto', 'govVeto'], ['abstain', 'govAbstain']];
  const bar = h('div', { class: 'tally-bar', role: 'img', 'aria-label': segs.map(([k, l]) => `${t(l)} ${s.percents[k]}%`).join(', ') });
  for (const [k] of segs) { const d = h('div', { class: `tally-seg tally-${k}` }); d.style.width = `${Math.min(100, s.percents[k])}%`; bar.append(d); }
  const q = parseDec(params.quorum); const th = parseDec(params.threshold); const vt = parseDec(params.vetoThreshold);
  const dec = (x) => (x == null ? '—' : `${(Number((x * 10000n) / E18) / 100).toFixed(2)}%`);
  return h('div', { class: 'tally' },
    bar,
    h('ul', { class: 'plain tally-legend' }, segs.map(([k, l]) => h('li', null, h('span', { class: `swatch tally-${k}` }), ` ${t(l)} `, h('strong', null, `${s.percents[k].toFixed(2)}%`),
      h('span', { class: 'small dim' }, ` (${formatZtphy(toBig(tally[k]) ?? 0n, { maxFrac: 0 })})`)))),
    c.kv([
      [t('govTurnout'), h('span', null, `${s.turnout.toFixed(2)}%`, ' ', s.quorumReached == null ? '' : s.quorumReached ? c.badge(t('govQuorumMet'), 'ok') : c.badge(t('govQuorumNotMet'), 'warn'))],
      [t('govQuorum'), dec(q)],
      [t('govThreshold'), `${dec(th)} · ${t('govYesShare', { p: s.yesShare.toFixed(2) })}`],
      [t('govVetoThreshold'), dec(vt)],
      [t('govOutlook'), s.voted === 0n ? t('govNoVotes') : s.vetoed ? c.badge(t('govWouldVeto'), 'bad') : s.passing ? c.badge(t('govWouldPass'), 'ok') : c.badge(t('govWouldFail'), 'warn')],
    ]));
}

// ---- #/gov ----

export async function pageGov(c, view, param) {
  if (param && heightParam(param)) return pageProposal(c, view, heightParam(param));
  const { t, h, api } = c;
  const [list, pool] = await Promise.all([
    api.rest('cosmos/gov/v1/proposals?pagination.limit=50&pagination.reverse=true', TTL.short),
    c.chain.stakingPool().catch(() => null),
  ]);
  const params = await tallyParams(api).catch(() => ({}));
  const props = (list?.proposals ?? []).slice(0, 50);
  c.append(view, [
    h('h1', null, t('govTitle')),
    c.note(t('govIntro'), 'info'),
    c.card(null, c.table(['#', t('govProposal'), t('status'), t('govTally'), t('govEnds')], props.map((p) => {
      const tl = normTally(p.final_tally_result);
      const s = tallySummary(tl, pool?.bonded ?? 0n, params);
      const voting = p.status === 'PROPOSAL_STATUS_VOTING_PERIOD';
      const end = voting ? p.voting_end_time : p.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD' ? p.deposit_end_time : p.voting_end_time;
      return [
        c.routeLink(`gov/${safeText(p.id, 20)}`, `#${safeText(p.id, 20)}`),
        c.routeLink(`gov/${safeText(p.id, 20)}`, safeText(p.title || p.messages?.[0]?.['@type']?.split('.').pop() || '—', 90)),
        statusBadge(c, p.status),
        voting ? t('govLiveTally') : s.voted ? `${t('govYes')} ${s.percents.yes.toFixed(1)}% · ${t('govNo')} ${s.percents.no.toFixed(1)}%` : '—',
        end && Date.parse(end) > 0 ? `${utcTime(end)}` : '—',
      ];
    }), { empty: t('govNone') })),
    hubLink(c),
  ]);
}

function hubLink(c) {
  const url = String(c.cfg.hubGovUrl ?? '');
  if (!/^https:\/\//.test(url)) return null;
  return c.note(c.h('span', null, c.t('govHubNote'), ' ', c.h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, c.t('govHubLink'))), 'info');
}

// ---- #/gov/<id> ----

async function pageProposal(c, view, id) {
  const { t, h, api, chain } = c;
  const r = await api.rest(`cosmos/gov/v1/proposals/${id}`, TTL.short);
  const p = r?.proposal;
  if (!p) { c.append(view, c.errorBox(t('govNotFound'))); return; }
  const [pool, params, depParams] = await Promise.all([
    chain.stakingPool().catch(() => null),
    tallyParams(api).catch(() => ({})),
    api.rest('cosmos/gov/v1/params/deposit', TTL.minute).then((x) => x?.params ?? x?.deposit_params ?? null).catch(() => null),
  ]);
  const voting = p.status === 'PROPOSAL_STATUS_VOTING_PERIOD';
  const tally = voting ? normTally((await api.rest(`cosmos/gov/v1/proposals/${id}/tally`, TTL.latest).catch(() => null))?.tally ?? p.final_tally_result) : normTally(p.final_tally_result);
  const s = tallySummary(tally, pool?.bonded ?? 0n, p.expedited && params.expeditedThreshold ? { ...params, threshold: params.expeditedThreshold } : params);
  const clock = h('strong', { class: 'countdown' });
  const end = voting ? p.voting_end_time : p.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD' ? p.deposit_end_time : null;
  const tick = () => {
    const x = countdown(end);
    clock.textContent = x.done ? t('govEnded') : t('govLeft', { d: x.d, h: x.h, m: x.m, s: x.s });
    return x.done;
  };
  if (end) {
    tick();
    const timer = setInterval(() => { if (!clock.isConnected || tick()) clearInterval(timer); }, 1000);
  }
  const minDeposit = (depParams?.min_deposit ?? []).map(formatCoin).join(', ');
  c.append(view, [
    h('h1', null, `#${safeText(p.id, 20)} `, safeText(p.title || '', 120), ' ', statusBadge(c, p.status), p.expedited ? [' ', c.badge(t('govExpedited'), 'warn')] : null),
    h('p', null, c.routeLink('gov', `← ${t('govTitle')}`)),
    c.card(t('overview'), c.kv([
      [t('status'), statusBadge(c, p.status)],
      end ? [voting ? t('govVotingEnds') : t('govDepositEnds'), h('span', null, clock, ` · ${utcTime(end)}`)] : null,
      [t('govSubmitted'), p.submit_time ? `${utcTime(p.submit_time)} (${ago(p.submit_time, Date.now(), c.lang)})` : '—'],
      p.voting_start_time && Date.parse(p.voting_start_time) > 0 ? [t('govVotingStarted'), utcTime(p.voting_start_time)] : null,
      p.proposer ? [t('govProposer'), c.addrLink(p.proposer, { full: true })] : null,
      [t('govDeposit'), `${(p.total_deposit ?? []).map(formatCoin).join(', ') || '0'}${minDeposit ? ` · ${t('govMinDeposit', { x: minDeposit })}` : ''}`],
      p.summary ? [t('govSummary'), h('div', { class: 'gov-summary' }, safeText(p.summary, 2000))] : null,
      p.metadata ? [t('govMetadata'), h('span', { class: 'mono small break' }, safeText(p.metadata, 300))] : null,
      p.failed_reason ? [t('govFailedReason'), safeText(p.failed_reason, 300)] : null,
    ])),
    c.card(voting ? t('govLiveTallyTitle') : t('govTally'), tallyView(c, tally, s, params), c.note(t('govTallyNote'))),
    messagesCard(c, id, p),
    votesCard(c, id),
    depositsCard(c, id),
    hubLink(c),
  ]);
}

function messagesCard(c, id, p) {
  const { t, h } = c;
  const body = h('div', null, c.loading());
  c.api.comet('abci_query', { path: '/cosmos.gov.v1.Query/Proposal', data: proposalRequestHex(id), prove: false }, TTL.short).then((r) => {
    if (r?.response?.code || !r?.response?.value) throw new Error('refused');
    const outer = protoFields(fromBase64(r.response.value));
    const inner = outer.find((x) => x.field === 1 && x.wire === 2);
    const d = decodeProposalProto(inner.value);
    if (!d.messages.length && (p.messages ?? []).length) throw new Error('empty');
    c.fill(body, d.messages.length ? d.messages.map((m, i) => c.messageView(m, i)) : c.note(t('govNoMessages')));
  }).catch(() => {
    // The REST JSON (amino-like): shown as plain key / value text.
    const ms = p.messages ?? [];
    c.fill(body, ms.length ? ms.map((m, i) => h('div', { class: 'msg' }, h('h3', null, `#${i} ${safeText(String(m['@type'] ?? '').split('.').pop(), 80)}`, ' ', h('span', { class: 'mono small dim' }, safeText(m['@type'], 120))),
      c.kv(flattenJson(m)))) : c.note(t('govNoMessages')), c.note(t('govJsonNote')));
  });
  return c.card(t('messages'), body);
}

function votesCard(c, id) {
  const { t, h, api } = c;
  const list = h('div', null, c.loading());
  const more = h('button', { type: 'button', class: 'secondary', hidden: '' }, t('govMoreVotes'));
  const rows = []; let next = '';
  const optText = (v) => (v.options ?? (v.option ? [{ option: v.option, weight: '1' }] : [])).map((o) => {
    const w = parseDec(o.weight);
    return `${OPTION_KEYS[o.option] ? t(OPTION_KEYS[o.option]) : safeText(o.option, 30)}${w != null && w !== E18 ? ` ×${(Number((w * 10000n) / E18) / 10000)}` : ''}`;
  }).join(', ');
  async function load() {
    more.disabled = true;
    try {
      const key = next ? `&pagination.key=${encodeURIComponent(next)}` : '';
      const r = await api.rest(`cosmos/gov/v1/proposals/${id}/votes?pagination.limit=25&pagination.count_total=true${key}`, TTL.short);
      for (const v of r?.votes ?? []) rows.push([c.addrLink(v.voter), optText(v)]);
      next = r?.pagination?.next_key ?? '';
      const total = r?.pagination?.total && r.pagination.total !== '0' ? groupDigits(String(toBig(r.pagination.total) ?? '')) : null;
      c.fill(list, c.table([t('govVoter'), t('govOption')], rows, { empty: t('govNoVoteList') }), total ? c.note(t('govVotesShown', { n: rows.length, total })) : null);
      more.hidden = !next;
    } catch (e) { c.fill(list, c.note(`${t('govNoVoteList')} (${safeText(e.message, 120)})`, 'warn')); more.hidden = true; }
    more.disabled = false;
  }
  more.addEventListener('click', load);
  load();
  return c.card(t('govVotes'), list, more);
}

function depositsCard(c, id) {
  const { t } = c;
  return c.card(t('govDeposits'), c.slot(c.api.rest(`cosmos/gov/v1/proposals/${id}/deposits?pagination.limit=50`, TTL.short),
    (r) => c.table([t('govDepositor'), t('value')], (r?.deposits ?? []).map((d) => [c.addrLink(d.depositor), (d.amount ?? []).map(formatCoin).join(', ')]), { empty: t('none') })));
}
