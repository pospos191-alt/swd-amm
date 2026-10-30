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

/**
 * batch(calls) -> [result | Error] (rpc.js evmBatch) or null; single(method, params) -> result.
 * Returns { lookup(address) -> Promise<Result>, peek(address), flushes }, where Result is
 *   { state: 'unset' } | { state: 'error' } | { state: 'clean' | 'flagged', flags: [{ what, enforced, reason, reasonName }] }
 */
export function createRisk({ batch = null, single, registry, chainId, wait = 30, maxBatch = 30 } = {}) {
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

  async function run(items) {
    const addrs = items.map(([a]) => a);
    let first; let second = []; let ans2 = [];
    try {
      first = await callMany(addrs.flatMap((a) => {
        const q = threatQueries(chainId, a, '0x')[0];
        return [{ method: 'eth_getCode', params: [a, 'latest'] }, ethCall(q.warn), ethCall(q.enforced)];
      }));
      addrs.forEach((a, i) => {
        const code = first[3 * i];
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
        const own = readThreat(first[3 * i + 1], first[3 * i + 2]);
        if (own.flagged) flags.push({ what: 'address', ...own });
        second.forEach((s, j) => {
          if (s.i !== i) return;
          const x = readThreat(ans2[2 * j], ans2[2 * j + 1]);
          if (x.flagged) flags.push({ what: s.what, ...x });
        });
        for (const f of flags) f.reasonName = REASONS[f.reason] ?? `#${f.reason}`;
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
    if (!registry) return Promise.resolve({ state: 'unset' });
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

/** The worst flag first: enforced before warnings, then the address flag. */
export const topFlag = (r) => (r?.flags ?? []).slice().sort((x, y) => Number(y.enforced) - Number(x.enforced))[0] ?? null;

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
    const why = reasonText(f.reason);
    el.append(h('span', { class: ['badge', 'badge-warn', 'risk-badge'], title: `${t(f.enforced ? 'riskEnforced' : 'riskFlagged')}: ${why[lang] ?? why.en} (${f.reasonName}) · ${DISCLAIMER[lang] ?? DISCLAIMER.en}` },
      `⚠ ${t(f.enforced ? 'riskEnforced' : 'riskFlagged')} · ${f.reasonName}`));
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
    const f = topFlag(r); const why = reasonText(f.reason);
    return h('span', null, badge(t(f.enforced ? 'riskEnforced' : 'riskFlagged'), 'warn'), ' ', `${why[lang] ?? why.en} (${f.reasonName})`,
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
