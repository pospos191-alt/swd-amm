// Watch list and labels, per browser: addresses with a nickname (localStorage,
// every access in try/catch: storage may be blocked or empty), watched
// transactions that flip from pending to confirmed, and in-page toasts. Nothing
// leaves the browser. Pure store logic (no DOM) is unit-tested in Node.
import { h, append } from './dom.js';
import { toAddress, safeText, short } from './format.js';

export const WATCH_KEY = 'zetaphy-explorer:watch';
export const WATCH_TX_KEY = 'zetaphy-explorer:watch-txs';
export const MAX_WATCH = 50;
export const MAX_WATCH_TXS = 20;
export const MAX_NICK = 40;

const readJson = (storage, key) => { try { const v = JSON.parse(storage?.getItem(key) ?? 'null'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeJson = (storage, key, v) => { try { storage?.setItem(key, JSON.stringify(v)); return true; } catch { return false; } };

/** A nickname as stored and shown: safeText, at most MAX_NICK characters, no ellipsis. */
export const cleanNick = (s) => [...safeText(s, 400)].slice(0, MAX_NICK).join('').trim();

/**
 * Watched addresses: [{ address (EIP-55 0x), name }]. Invalid stored entries are dropped
 * on read, so a hand-edited or old value can never put anything odd on the page.
 */
export function createWatchStore(storage) {
  const listeners = new Set();
  const load = () => {
    const out = []; const seen = new Set();
    for (const e of readJson(storage, WATCH_KEY)) {
      const a = toAddress(e?.address);
      if (!a || seen.has(a.lower)) continue;
      seen.add(a.lower);
      out.push({ address: a.hex, name: cleanNick(e?.name ?? '') });
      if (out.length >= MAX_WATCH) break;
    }
    return out;
  };
  const save = (list) => { const ok = writeJson(storage, WATCH_KEY, list); for (const f of listeners) f(list); return ok; };
  const find = (addr) => { const a = toAddress(addr); return a ? load().find((e) => e.address.toLowerCase() === a.lower) ?? null : null; };
  return {
    list: load,
    has: (addr) => !!find(addr),
    get: find,
    /** The nickname of a watched address ('' if none or not watched). */
    nameOf: (addr) => find(addr)?.name ?? '',
    /** Adds or renames; false when the address is invalid or the list is full. */
    set(addr, name = '') {
      const a = toAddress(addr);
      if (!a) return false;
      const list = load();
      const i = list.findIndex((e) => e.address.toLowerCase() === a.lower);
      if (i >= 0) list[i] = { address: a.hex, name: cleanNick(name) };
      else { if (list.length >= MAX_WATCH) return false; list.push({ address: a.hex, name: cleanNick(name) }); }
      return save(list);
    },
    remove(addr) {
      const a = toAddress(addr);
      if (!a) return false;
      return save(load().filter((e) => e.address.toLowerCase() !== a.lower));
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** A tx hash as typed: { hash (as the node knows it: 0x… EVM or upper hex CometBFT), evm } or null. */
export function txHashParam(s) {
  const q = String(s ?? '').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(q)) return null;
  return /^0x/i.test(q) ? { hash: '0x' + q.slice(2).toLowerCase(), evm: true } : { hash: q.toUpperCase(), evm: false };
}

/**
 * Watched transactions: [{ hash, evmHash?, status: 'pending' | 'confirmed' | 'failed', height? }].
 * check(entry) -> { height, ok } once the tx is in a block, null while it is not.
 */
export function createTxWatch(storage, check) {
  const load = () => readJson(storage, WATCH_TX_KEY).map((e) => {
    const p = txHashParam(e?.hash);
    if (!p) return null;
    const evmHash = txHashParam(e?.evmHash)?.evm ? txHashParam(e.evmHash).hash : undefined;
    const status = ['pending', 'confirmed', 'failed'].includes(e?.status) ? e.status : 'pending';
    const height = /^\d{1,19}$/.test(String(e?.height ?? '')) ? String(e.height) : undefined;
    return { hash: p.hash, evmHash, status, height };
  }).filter(Boolean).slice(0, MAX_WATCH_TXS);
  const save = (list) => writeJson(storage, WATCH_TX_KEY, list.slice(0, MAX_WATCH_TXS));
  const listeners = new Set();
  let checking = null;
  return {
    list: load,
    /** fn(landed) after every check that found txs in a block. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add(hash, evmHash) {
      const p = txHashParam(hash);
      if (!p) return false;
      const list = load().filter((e) => e.hash !== p.hash);
      list.unshift({ hash: p.hash, evmHash: txHashParam(evmHash)?.hash, status: 'pending' });
      return save(list);
    },
    remove(hash) { const p = txHashParam(hash); return p ? save(load().filter((e) => e.hash !== p.hash)) : false; },
    /** Checks every pending one; returns the entries that just landed. One check at a time. */
    async checkAll() {
      if (checking) return checking;
      checking = (async () => {
        const list = load(); const landed = [];
        for (const e of list) {
          if (e.status !== 'pending') continue;
          let r = null;
          try { r = await check(e); } catch { r = null; }
          if (r && /^\d{1,19}$/.test(String(r.height))) {
            e.status = r.ok === false ? 'failed' : 'confirmed'; e.height = String(r.height);
            landed.push({ ...e });
          }
        }
        if (landed.length) {
          // keep entries removed or added meanwhile as they are now
          const now = load();
          for (const l of landed) { const x = now.find((e) => e.hash === l.hash); if (x) Object.assign(x, l); }
          save(now);
          for (const f of listeners) { try { f(landed); } catch { /* a view went away */ } }
        }
        return landed;
      })().finally(() => { checking = null; });
      return checking;
    },
  };
}

// ---- toasts (in-page notifications; nothing is sent anywhere) ----

let toastBox = null;
/** Shows a short message at the bottom of the page for 8 s: text, and an optional internal link. */
export function toast(text, link) {
  if (typeof document === 'undefined') return null;
  if (!toastBox || !toastBox.isConnected) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': '×', on: { click: () => n.remove() } }, '×');
  const n = h('div', { class: 'toast' }, h('span', null, safeText(text, 300)), link ? [' ', h('a', { href: link.href }, safeText(link.text, 80))] : null, close);
  append(toastBox, n);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  setTimeout(() => n.remove(), 8000);
  return n;
}

// ---- views ----

/** "Watch" / "Stop watching" and a nickname field, for the address page. */
export function watchControls(ctx, a) {
  const { t, watch } = ctx;
  const box = h('div', { class: 'watch-controls' });
  const render = () => {
    const e = watch.get(a.hex);
    const input = h('input', { id: 'watch-name', class: 'watch-name', value: e?.name ?? '', maxlength: String(MAX_NICK), placeholder: t('watchNickname'), 'aria-label': t('watchNickname'), autocomplete: 'off', spellcheck: 'false' });
    const save = h('button', { type: 'submit', class: e ? 'secondary' : '' }, e ? t('watchRename') : t('watchAdd'));
    const form = h('form', { class: 'watch-form', on: { submit: (ev) => {
      ev.preventDefault();
      const ok = watch.set(a.hex, input.value);
      render();
      toast(ok ? t('watchSaved', { a: cleanNick(input.value) || short(a.hex, 8, 6) }) : t('watchFull', { n: MAX_WATCH }));
    } } }, input, save,
    e ? h('button', { type: 'button', class: 'secondary', on: { click: () => { watch.remove(a.hex); render(); } } }, t('watchRemove')) : null);
    box.replaceChildren(form, h('p', { class: 'hint' }, t('watchHint')));
  };
  render();
  return box;
}

/**
 * Home page: the watched addresses with their activity in the scanned blocks
 * (r: chain.recentTxs result), or nothing when the list is empty.
 */
export function watchedCard(ctx, r) {
  const { t, watch, addrLink, hashLink, blockLink, routeLink } = ctx;
  const list = watch.list();
  if (!list.length) return null;
  const rows = list.slice(0, 20).map((e) => {
    const lower = e.address.toLowerCase();
    const mine = r ? r.txs.filter((x) => x.addresses?.has(lower)) : [];
    const last = mine[0];
    return [
      h('span', null, e.name ? h('strong', { class: 'nick' }, e.name, ' ') : null, addrLink(e.address)),
      r ? String(mine.length) : '…',
      last ? h('span', null, hashLink(last.hash), ' · ', blockLink(last.height), ' ', h('span', { class: 'small dim' }, safeText(last.label, 40))) : t('watchNoActivity'),
      routeLink(`address/${e.address}`, t('watchHistory')),
    ];
  });
  return ctx.card(t('watchTitle'), ctx.table([t('address'), t('watchTxsInRange'), t('watchLast'), ''], rows),
    r ? ctx.note(t('watchRangeNote', { from: r.from, to: r.to })) : null);
}
