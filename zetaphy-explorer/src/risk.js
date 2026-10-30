// Neuro risk badges: the ThreatRegistry flag of every address or token the pages
// render, looked up in batches (one JSON-RPC batch request per ~30 ms of rendering,
// through rpc.js's queue and cache) and remembered for the visit.
// Per address: the address flag, and for a contract also its code and Neuro
// fingerprint flags (proxies are followed only by the full check on the address
// page, threat.js). A flag is a reproducible fact about code, never an accusation
// (docs/LEGAL.md): the badge says "Flagged by Neuro" with the neutral category text.
import { h } from './dom.js';
import { threatQueries, readThreat, REASONS, reasonText, DISCLAIMER } from '../vendor/zetaphy-lib.js';

const ADDR = /^0x[0-9a-f]{40}$/;
/** isFlagged(uint256,address) of an IImmuneFeed (zetaphy-network/contracts/ImmuneGuard.sol). */
export const IMMUNE_IS_FLAGGED = '0x3f68ab60';
export const IMMUNE_SEVERITY = { 1: 'info', 2: 'suspicious', 3: 'high', 4: 'critical' };
/** isFlagged's answer -> { flagged, severity, evidenceHash } | null (not an answer). */
export function readImmune(hex) {
  const b = typeof hex === 'string' ? hex.replace(/^0x/, '') : '';
  if (b.length < 256 || /[^0-9a-f]/i.test(b)) return null;
  const w = (i) => BigInt(`0x${b.slice(64 * i, 64 * (i + 1))}`);
  if (w(0) > 1n || w(1) > 4n) return null;
  return { flagged: w(0) === 1n, severity: Number(w(1)), evidenceHash: `0x${b.slice(192, 256)}` };
}
/** The words a flag is shown with: an immune flag (a quorum of bonded runners) or a ThreatRegistry category. */
const flagWords = (f, t, lang) => {
  if (f.what === 'immune') return { label: t('riskImmune'), why: `${t('riskImmuneTip')} (${f.reasonName})` };
  const why = reasonText(f.reason);
  return { label: t(f.enforced ? 'riskEnforced' : 'riskFlagged'), why: `${why[lang] ?? why.en} (${f.reasonName})` };
};

/**
 * batch(calls) -> [result | Error] (rpc.js evmBatch) or null; single(method, params) -> result.
 * Returns { lookup(address) -> Promise<Result>, peek(address), flushes }, where Result is
 *   { state: 'unset' } | { state: 'error' } | { state: 'clean' | 'flagged', flags: [{ what, enforced, reason, reasonName }] }
 */
export function createRisk({ batch = null, single, registry, chainId, immune = '', wait = 30, maxBatch = 30 } = {}) {
  const cache = new Map(); const done = new Map();
  let pending = new Map(); let timer = null;
  const counters = { flushes: 0, requests: 0 };
  let useBatch = !!batch;

  async function callMany(calls) {
    if (!calls.length) return [];
    counters.requests++;
    if (useBatch) {
      try { return await batch(calls); } catch { useBatch = false; } // node without batches: one by one
    }
    return Promise.all(calls.map((c) => single(c.method, c.params).catch((e) => (e instanceof Error ? e : new Error(String(e))))));
  }
  const ethCall = (data) => ({ method: 'eth_call', params: [{ to: registry, data }, 'latest'] });

  // The immune network (docs/future/immune-network.md): ImmuneRegistry.isFlagged(chainId, address) on ZETAPHY, a
  // 4th call per address in the same batch; an unreadable answer adds nothing (the ThreatRegistry result stands).
  const immuneCall = (a) => ({ method: 'eth_call', params: [{ to: immune, data: IMMUNE_IS_FLAGGED + BigInt(chainId).toString(16).padStart(64, '0') + a.slice(2).padStart(64, '0') }, 'latest'] });
  const II = registry ? 3 : 1;                                   // where the immune answer sits per address
  const P = 1 + (registry ? 2 : 0) + (immune ? 1 : 0);           // calls per address in the first batch

  async function run(items) {
    const addrs = items.map(([a]) => a);
    let first; let second = []; let ans2 = [];
    try {
      first = await callMany(addrs.flatMap((a) => {
        const q = threatQueries(chainId, a, '0x')[0];
        const own = registry ? [{ method: 'eth_getCode', params: [a, 'latest'] }, ethCall(q.warn), ethCall(q.enforced)] : [{ method: 'eth_getCode', params: [a, 'latest'] }];
        return immune ? [...own, immuneCall(a)] : own;
      }));
      if (registry) addrs.forEach((a, i) => {
        const code = first[P * i];
        if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(code)) return;
        for (const q of threatQueries(chainId, a, code).slice(1)) second.push({ i, what: q.what, warn: q.warn, enforced: q.enforced });
      });
      ans2 = await callMany(second.flatMap((s) => [ethCall(s.warn), ethCall(s.enforced)]));
    } catch {
      for (const [a, resolve] of items) { cache.delete(a); resolve({ state: 'error' }); }
      return;
    }
    items.forEach(([a, resolve], i) => {
      let r;
      try {
        const flags = [];
        if (registry) {
          const own = readThreat(first[P * i + 1], first[P * i + 2]);
          if (own.flagged) flags.push({ what: 'address', ...own });
        }
        if (immune) {
          const im = readImmune(first[P * i + II]);
          if (im?.flagged) flags.push({ what: 'immune', enforced: im.severity >= 3, reason: null, severity: im.severity, evidenceHash: im.evidenceHash });
        }
        second.forEach((s, j) => {
          if (s.i !== i) return;
          const x = readThreat(ans2[2 * j], ans2[2 * j + 1]);
          if (x.flagged) flags.push({ what: s.what, ...x });
        });
        for (const f of flags) f.reasonName = f.what === 'immune' ? IMMUNE_SEVERITY[f.severity] ?? `#${f.severity}` : REASONS[f.reason] ?? `#${f.reason}`;
        r = { state: flags.length ? 'flagged' : 'clean', flags };
      } catch { r = { state: 'error' }; cache.delete(a); }
      done.set(a, r);
      resolve(r);
    });
  }

  async function flush() {
    timer = null;
    counters.flushes++;
    const items = [...pending.entries()]; pending = new Map();
    for (let i = 0; i < items.length; i += maxBatch) await run(items.slice(i, i + maxBatch));
  }

  function lookup(address) {
    const a = String(address ?? '').toLowerCase();
    if (!registry && !immune) return Promise.resolve({ state: 'unset' });
    if (!ADDR.test(a)) return Promise.resolve({ state: 'error' });
    if (cache.has(a)) return cache.get(a);
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    cache.set(a, p); pending.set(a, resolve);
    if (!timer) timer = setTimeout(flush, wait);
    return p;
  }

  return { lookup, peek: (a) => done.get(String(a ?? '').toLowerCase()) ?? null, counters };
}

let current = null;
/** The risk source the badges use (set when the node changes). */
export const setRisk = (r) => { current = r; };
export const getRisk = () => current;

/** The worst flag first: enforced before warnings, an immune flag before a ThreatRegistry one, then the address flag. */
export const topFlag = (r) => (r?.flags ?? []).slice().sort((x, y) => Number(y.enforced) - Number(x.enforced) || Number(y.what === 'immune') - Number(x.what === 'immune'))[0] ?? null;

/**
 * An inline badge after an address or token: empty while loading, when clean or
 * when the registry cannot be read (nothing is claimed); "Flagged by Neuro" and the
 * category when flagged. t: the page's texts, lang: its language.
 */
export function riskBadge(address, { t, lang }) {
  const el = h('span', { class: 'risk-slot' });
  if (!current) return el;
  current.lookup(address).then((r) => {
    if (r.state !== 'flagged') return;
    const f = topFlag(r);
    const w = flagWords(f, t, lang);
    el.append(h('span', { class: ['badge', 'badge-warn', 'risk-badge'], 'data-flag': f.what, title: `${w.label}: ${w.why} · ${DISCLAIMER[lang] ?? DISCLAIMER.en}` },
      `⚠ ${w.label} · ${f.reasonName}`));
  });
  return el;
}

/**
 * The "risk summary" box of the address and token pages: this address's own flag,
 * how many of its recent counterparties (from the scanned blocks) are flagged, and
 * the link to Neuro's report (cfg.neuroReportUrl). counterparties: Promise<[0x lower]>.
 */
export function riskSummaryCard(ui, a, { counterparties = Promise.resolve([]), isToken = false } = {}) {
  const { t, lang, card, kv, badge, note, addrLink, slot } = ui;
  const link = ui.neuroLink(a.hex);
  const own = slot(current ? current.lookup(a.lower) : Promise.resolve({ state: 'unset' }), (r) => {
    if (r.state === 'unset') return t('threatUnset');
    if (r.state === 'error') return t('riskUnreadable');
    if (r.state === 'clean') return badge(t('threatClean'), 'ok');
    const f = topFlag(r); const w = flagWords(f, t, lang);
    return h('span', null, badge(w.label, 'warn'), ' ', w.why,
      h('span', { class: 'disclaimer' }, ' · ', DISCLAIMER[lang] ?? DISCLAIMER.en));
  }, { inline: true });
  const others = slot(Promise.resolve(counterparties).then(async (list) => {
    const uniq = [...new Set(list.map((x) => String(x).toLowerCase()))].filter((x) => x !== a.lower && ADDR.test(x)).slice(0, 30);
    const rs = current ? await Promise.all(uniq.map((x) => current.lookup(x))) : [];
    return { uniq, flagged: uniq.filter((_, i) => rs[i]?.state === 'flagged') };
  }), ({ uniq, flagged }) => (!uniq.length ? t('riskNoCounterparties')
    : h('span', null, t('riskCounterparties', { f: flagged.length, n: uniq.length }), flagged.length ? h('span', null, ': ', flagged.slice(0, 5).flatMap((x, i) => (i ? [', ', addrLink(x)] : [addrLink(x)]))) : null)), { inline: true });
  return card(t('riskTitle'),
    kv([
      [t(isToken ? 'riskOwnToken' : 'riskOwn'), own],
      [t('riskCounterpartiesLabel'), others],
      [t('neuroReport'), link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, t('openNeuro')) : t('neuroUnset')],
    ]),
    note(t('riskSummaryNote'), 'info'));
}
