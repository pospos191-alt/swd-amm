// Wallet safety for the ZETAPHY sites (hub, Swap, NFT, Explorer, Neuro): one module, no dependencies,
// copied byte for byte to each site (canonical copy here; `npm run sync:shared`; test/shared.test.mjs).
//  - "Use a hardware wallet" help (Ledger / Trezor through MetaMask or Rabby, Ledger over USB,
//    Phantom / Solflare for Solana, Keplr + Ledger for Cosmos), in 8 languages.
//  - A large-balance banner (hidden for 7 days when dismissed; storage may be blocked: try/catch).
//  - Idle safety: after 30 minutes (the user can choose 30 / 60 / 120 / 240 in the help) without
//    activity in any page of the site, the page forgets the account (a site cannot lock the wallet extension; the help says so).
//  - An in-page summary before every transaction (network, from, to, value, action), with a
//    warning on unlimited token approvals and an "approve only the amount needed" choice.
// Every text goes in with textContent; styles come from wallet-safety.css (CSP style-src 'self').
import { SAFETY_TEXT, SAFETY_LANGS } from './wallet-safety-i18n.js';

export { SAFETY_TEXT, SAFETY_LANGS };
export const IDLE_MINUTES = 30;
export const IDLE_CHOICES = [30, 60, 120, 240];
const IDLE_KEY = 'zetaphy:safety:idleMinutes'; // the user's choice, shared by every page of the origin
export const BANNER_DAYS = 7;
const ACTIVE_KEY = 'zetaphy:safety:active'; // last activity (ms), shared by every page and frame of the origin
const HIDE_KEY = 'zetaphy:safety:bannerHiddenUntil';
// An approve() at or above this counts as unlimited (2^96 - 1 and up: type(uint96).max, 2^255, type(uint256).max).
export const UNLIMITED_MIN = (1n << 96n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const SEL = { approve: '0x095ea7b3', setApprovalForAll: '0xa22cb465', increaseAllowance: '0x39509351', permit: '0xd505accf' };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Reads an approval out of call data: ERC-20 approve / increaseAllowance, ERC-721/1155 setApprovalForAll. */
export function decodeApproval(data) {
  const d = typeof data === 'string' ? data.toLowerCase() : '';
  if (!/^0x[0-9a-f]*$/.test(d) || d.length < 10) return null;
  const sel = d.slice(0, 10);
  const word = (i) => d.slice(10 + i * 64, 10 + (i + 1) * 64);
  if (d.length < 10 + 128) return null;
  const spender = `0x${word(0).slice(24)}`;
  let v;
  try { v = BigInt(`0x${word(1)}`); } catch { return null; }
  if (sel === SEL.approve || sel === SEL.increaseAllowance) return { kind: 'erc20', spender, amount: v, unlimited: v >= UNLIMITED_MIN };
  if (sel === SEL.setApprovalForAll) return { kind: 'all', spender, approved: v !== 0n };
  return null;
}

/** approve(spender, amount) call data. */
export function encodeApprove(spender, amount) {
  if (!ADDR_RE.test(spender) || amount < 0n || amount > MAX_UINT256) throw new Error('bad approve');
  return `${SEL.approve}${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

/** An integer amount with `decimals` as text (at most 6 fraction digits, grouped). */
export function fmtUnits(v, decimals = 18) {
  const n = BigInt(v);
  const d = 10n ** BigInt(decimals);
  const frac = (n % d).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `${(n / d).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/**
 * The safety helpers for one page.
 * @param {object} o
 * @param {Window} o.win
 * @param {() => string} o.lang   the page's language code (one of SAFETY_LANGS; anything else is English)
 */
export function safety({ win, lang = () => 'en' }) {
  const doc = win.document;
  const store = {
    get: (k) => { try { return win.localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { win.localStorage.setItem(k, v); } catch { /* private mode / blocked */ } },
  };
  const t = (k, vars = {}) => {
    const l = SAFETY_LANGS.includes(lang()) ? lang() : 'en';
    const s = SAFETY_TEXT[l][k] ?? SAFETY_TEXT.en[k] ?? k;
    return s.replace(/\{(\w+)\}/g, (_, x) => String(vars[x] ?? ''));
  };
  const el = (tag, attrs = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c);
    return e;
  };
  function ensureCss() {
    if (doc.getElementById('ws-css')) return;
    doc.head.append(el('link', { id: 'ws-css', rel: 'stylesheet', href: new URL('./wallet-safety.css', import.meta.url).href }));
  }
  /** The idle time chosen in the help (30 / 60 / 120 / 240 minutes; anything else: 30). */
  const idleMinutes = () => { const v = Number(store.get(IDLE_KEY)); return IDLE_CHOICES.includes(v) ? v : IDLE_MINUTES; };
  const short = (a) => (ADDR_RE.test(a ?? '') ? `${a.slice(0, 8)}…${a.slice(-6)}` : String(a ?? ''));

  /** A <dialog> with a title, the body nodes and a close button; removed when closed. */
  function modal(id, title, body, { onClose } = {}) {
    ensureCss();
    doc.getElementById(id)?.remove();
    const d = el('dialog', { id, class: 'ws-dialog', 'aria-labelledby': `${id}-t` },
      el('div', { class: 'ws-head' }, el('h3', { id: `${id}-t`, text: title }),
        el('button', { type: 'button', class: 'ws-x', 'aria-label': t('close'), text: '×', onclick: () => d.close() })),
      el('div', { class: 'ws-body' }, body));
    d.addEventListener('close', () => { d.remove(); onClose?.(); });
    doc.body.append(d);
    d.showModal();
    return d;
  }

  // ------------------------------------------------------------- hardware wallet help
  /**
   * @param {object} [o]
   * @param {string[]} [o.chains]  which sections: 'evm', 'solana', 'cosmos'
   * @param {boolean} [o.ledger]   this site connects a Ledger over USB itself
   * @param {boolean} [o.snap]     mention the ZETAPHY MetaMask Snap / post-quantum wallet (ZETAPHY sites)
   */
  function openHelp({ chains = ['evm', 'cosmos'], ledger = false, snap = true } = {}) {
    const sec = (h, ...ps) => el('section', {}, el('h4', { text: h }), ps.map((p) => el('p', { text: p })));
    return modal('ws-help', t('hwTitle'), [
      el('p', { text: t('hwIntro') }),
      chains.includes('evm') ? sec(t('hwEvmH'), t('hwEvm'), ledger ? t('hwLedger') : null, t('hwTrezor')) : null,
      chains.includes('solana') ? sec(t('hwSolH'), t('hwSol')) : null,
      chains.includes('cosmos') ? sec(t('hwCosH'), t('hwCos')) : null,
      sec(t('hwCheckH'), t('hwCheck')),
      sec(t('hwLockH'), t('hwLock', { min: idleMinutes() })),
      el('label', { class: 'ws-row' }, el('span', { text: t('idleChoice') }),
        el('select', { class: 'ws-select', 'data-ws': 'idle-minutes', onchange: (e) => { store.set(IDLE_KEY, String(Number(e.target.value))); poke(); } },
          IDLE_CHOICES.map((m) => el('option', { value: String(m), selected: m === idleMinutes(), text: t('idleMins', { n: m }) })))),
      snap ? el('p', { class: 'ws-dim', text: t('hwMore') }) : null,
      el('div', { class: 'ws-row' }, el('button', { type: 'button', class: 'ws-btn', text: t('close'), onclick: () => doc.getElementById('ws-help')?.close() })),
    ]);
  }
  /** A link-styled button that opens the help. */
  const helpLink = (opts, cls = 'ws-link') => el('button', { type: 'button', class: cls, 'data-ws': 'help', text: t('hwLink'), onclick: () => openHelp(opts) });

  // ------------------------------------------------------------- large-balance banner
  const bannerHidden = () => { const v = Number(store.get(HIDE_KEY)); return Number.isFinite(v) && v > Date.now(); };
  /**
   * Shows (or removes) the banner in `host`.
   * @param {object} o
   * @param {Element} o.host
   * @param {bigint|null} o.amount   balance in base units (null: unknown / disconnected → no banner)
   * @param {bigint} o.threshold     in base units
   * @param {number} [o.decimals]
   * @param {string} o.symbol
   * @param {boolean} [o.hardware]   the account is on a hardware wallet: no banner
   * @param {object} [o.help]        openHelp() options
   */
  function balanceBanner({ host, amount, threshold, decimals = 18, symbol, hardware = false, help }) {
    if (!host) return;
    const old = host.querySelector(':scope > .ws-banner');
    if (amount == null || amount < threshold || hardware || bannerHidden()) { old?.remove(); return; }
    ensureCss();
    const b = el('div', { class: 'ws-banner', role: 'note' },
      el('span', { class: 'ws-banner-text', text: t(help?.snap === false ? 'bnTextHw' : 'bnText', { amount: fmtUnits(amount, decimals).replace(/\.\d+$/, ''), sym: symbol }) }),
      el('span', { class: 'ws-row' },
        el('button', { type: 'button', class: 'ws-btn sm', 'data-ws': 'banner-how', text: t('bnHow'), onclick: () => openHelp(help) }),
        el('button', { type: 'button', class: 'ws-btn ghost sm', 'data-ws': 'banner-hide', text: t('bnHide'), onclick: () => { store.set(HIDE_KEY, String(Date.now() + BANNER_DAYS * 86400_000)); b.remove(); } })));
    if (old) old.replaceWith(b); else host.prepend(b);
  }

  // ------------------------------------------------------------- idle safety
  let lastWrite = 0;
  let lastLocal = Date.now();
  const lastActive = () => Math.max(lastLocal, Number(store.get(ACTIVE_KEY)) || 0);
  function poke() {
    lastLocal = Date.now();
    if (lastLocal - lastWrite > 15_000) { lastWrite = lastLocal; store.set(ACTIVE_KEY, String(lastLocal)); }
  }
  let tracking = false;
  /** Records activity in this document (shared with the other pages and frames of the site). */
  function track() {
    if (tracking) return;
    tracking = true;
    poke();
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) win.addEventListener(ev, poke, { capture: true, passive: true });
  }
  /**
   * Calls onIdle() once the site has had no activity for `minutes` (default: the user's choice, 30) while active() is true.
   * @returns {{ stop(): void, check(): void }}
   */
  function idleGuard({ minutes, active, onIdle }) {
    track();
    const check = () => {
      if (!active()) return;
      if (Date.now() - lastActive() >= (minutes ?? idleMinutes()) * 60_000) {
        lastLocal = Date.now(); // the next connection starts a fresh period
        onIdle();
      }
    };
    const timer = win.setInterval(check, 20_000);
    const vis = () => { if (doc.visibilityState === 'visible') check(); };
    doc.addEventListener('visibilitychange', vis);
    win.addEventListener('focus', check);
    return { check, stop: () => { win.clearInterval(timer); doc.removeEventListener('visibilitychange', vis); win.removeEventListener('focus', check); } };
  }
  /** The small "forgot your account" notice (closes itself after a minute). */
  function idleNotice() {
    ensureCss();
    doc.getElementById('ws-idle')?.remove();
    const n = el('div', { id: 'ws-idle', class: 'ws-toast', role: 'status' },
      el('span', { text: t('idleMsg', { min: idleMinutes() }) }),
      el('button', { type: 'button', class: 'ws-btn sm', text: t('ok'), onclick: () => n.remove() }));
    doc.body.append(n);
    win.setTimeout(() => n.remove(), 60_000);
    return n;
  }

  // ------------------------------------------------------------- confirmation summary
  /**
   * The summary shown before the wallet: resolves with the call data to send (maybe changed to an
   * exact-amount approve), or null when the user cancels.
   * @param {object} o
   * @param {string} o.network        e.g. "ZETAPHY (77390)"
   * @param {string} o.from
   * @param {string} o.to
   * @param {string} [o.toLabel]      what `to` is (e.g. "Swap router", "tUSD token")
   * @param {bigint} [o.value]        native value (base units)
   * @param {number} [o.decimals]     of the native coin (18; 9 for SOL)
   * @param {string} [o.symbol]       native symbol
   * @param {string[]} [o.warnings]   more warnings to show (e.g. a Solana token approval)
   * @param {string} [o.data]
   * @param {string} [o.action]       what it does, in words
   * @param {{symbol:string, decimals:number}} [o.token]  the token when `to` is one (approvals)
   * @param {bigint} [o.exact]        the amount actually needed: offered instead of an unlimited approve
   * @param {Array<[string,string]>} [o.details]  more rows
   * @param {() => Promise<{rows?: Array<[string,string]>, warnings?: string[], note?: string}>} [o.simulate]
   *        a pre-sign simulation (the hub's presign.js): shown under "Simulation" when it resolves, in the caller's words
   * @param {() => Promise<string>} [o.explain]  an optional AI explanation (Neuro's AI layer, the user's own model): a button
   */
  function confirmTx(o) {
    return new Promise((resolve) => {
      let result = null;
      const row = (k, v, cls) => (v ? el('div', { class: `ws-kv${cls ? ` ${cls}` : ''}` }, el('span', { class: 'ws-k', text: k }), el('span', { class: 'ws-v', text: v })) : null);
      const ap = decodeApproval(o.data);
      const tok = o.token?.symbol || 'tokens';
      const dec = Number.isInteger(o.token?.decimals) ? o.token.decimals : 18;
      const warn = (o.warnings ?? []).map((w) => el('p', { class: 'ws-warn', role: 'alert', 'data-ws': 'warning', text: w }));
      const buttons = [];
      let goText = t('cfGo');
      if (ap?.kind === 'erc20') {
        if (ap.unlimited) {
          warn.push(el('p', { class: 'ws-warn', role: 'alert', 'data-ws': 'unlimited', text: t('cfUnlimited', { spender: short(ap.spender), token: tok }) }));
          if (typeof o.exact === 'bigint' && o.exact > 0n && o.exact < ap.amount) {
            buttons.push(el('button', { type: 'button', class: 'ws-btn', 'data-ws': 'exact', text: t('cfExact', { amount: `${fmtUnits(o.exact, dec)} ${tok}` }),
              onclick: () => { result = encodeApprove(ap.spender, o.exact); d.close(); } }));
            goText = t('cfAnyway');
          }
        }
      } else if (ap?.kind === 'all' && ap.approved) {
        warn.push(el('p', { class: 'ws-warn', role: 'alert', 'data-ws': 'approve-all', text: t('cfAll', { spender: short(ap.spender) }) }));
      }
      const action = o.action || (ap?.kind === 'erc20' ? t('cfApprove', { spender: short(ap.spender), amount: ap.unlimited ? '∞' : fmtUnits(ap.amount, dec), token: tok }) : '');
      const hasData = typeof o.data === 'string' && o.data.length > 2;
      // Simulation and AI explanation: filled in when they answer (the dialog never waits for them).
      const sim = o.simulate ? el('section', { class: 'ws-sim', 'data-ws': 'sim' }, el('h4', { text: t('cfSim') }), el('p', { class: 'ws-dim', 'data-ws': 'sim-wait', text: t('cfSimWait') })) : null;
      if (sim) {
        Promise.resolve().then(() => o.simulate()).then((r) => {
          sim.replaceChildren(...[el('h4', { text: t('cfSim') }),
            (r?.rows ?? []).map(([k, v]) => row(k, v)),
            (r?.warnings ?? []).map((w) => el('p', { class: 'ws-warn', role: 'alert', 'data-ws': 'sim-warning', text: w })),
            r?.note ? el('p', { class: 'ws-dim', 'data-ws': 'sim-note', text: r.note }) : null].flat().filter(Boolean));
        }, (e) => { sim.replaceChildren(el('h4', { text: t('cfSim') }), el('p', { class: 'ws-dim', 'data-ws': 'sim-note', text: String(e?.message ?? e).slice(0, 200) })); });
      }
      const ai = o.explain ? el('section', { class: 'ws-ai', 'data-ws': 'ai' }) : null;
      if (ai) {
        const btn = el('button', { type: 'button', class: 'ws-btn ghost sm', 'data-ws': 'explain', text: t('cfExplain'), onclick: async () => {
          btn.disabled = true;
          ai.replaceChildren(btn, el('p', { class: 'ws-dim', text: '…' }));
          try {
            const text = String(await o.explain()).slice(0, 1500);
            ai.replaceChildren(el('p', { class: 'ws-dim', text: t('cfExplainNote') }), el('p', { 'data-ws': 'ai-text', text }));
          } catch (e) { btn.disabled = false; ai.replaceChildren(btn, el('p', { class: 'ws-warn', text: t('cfExplainErr', { msg: String(e?.message ?? e).slice(0, 200) }) })); }
        } });
        ai.append(btn);
      }
      const d = modal('ws-confirm', t('cfTitle'), [
        row(t('cfNet'), o.network),
        row(t('cfFrom'), o.from, 'mono'),
        row(hasData ? t('cfTo') : t('cfToPlain'), o.to ? `${o.toLabel ? `${o.toLabel} · ` : ''}${o.to}` : '', 'mono'),
        row(t('cfValue'), o.value ? `${fmtUnits(o.value, o.decimals ?? 18)} ${o.symbol ?? ''}`.trim() : ''),
        row(t('cfAction'), action || (hasData ? o.data.slice(0, 10) : '')),
        (o.details ?? []).map(([k, v]) => row(k, v)),
        warn,
        sim,
        ai,
        el('p', { class: 'ws-dim', text: t('cfHint') }),
        el('div', { class: 'ws-row end' },
          el('button', { type: 'button', class: 'ws-btn ghost', 'data-ws': 'cancel', text: t('cancel'), onclick: () => d.close() }),
          buttons,
          el('button', { type: 'button', class: `ws-btn${buttons.length ? ' ghost' : ''}`, 'data-ws': 'go', text: goText, onclick: () => { result = o.data ?? '0x'; d.close(); } })),
      ], { onClose: () => resolve(result) });
      d.querySelector(buttons.length ? '[data-ws="exact"]' : '[data-ws="go"]')?.focus();
    });
  }

  // ------------------------------------------------------------- Ledger account picker
  /** Lists Ledger accounts (5 at a time) and resolves with the chosen index, or null. */
  function chooseAccount({ load }) {
    return new Promise((resolve) => {
      let chosen = null;
      let from = 0;
      const list = el('ul', { class: 'ws-accs' });
      const msg = el('p', { class: 'ws-msg', role: 'status' });
      const more = el('button', { type: 'button', class: 'ws-btn ghost sm', text: t('ldMore'), onclick: () => page() });
      async function page() {
        more.disabled = true;
        msg.textContent = '';
        try {
          for (let i = from; i < from + 5; i++) {
            const a = await load(i);
            list.append(el('li', {}, el('button', { type: 'button', class: 'ws-acc mono', 'data-index': String(i), onclick: () => { chosen = i; d.close(); } },
              el('span', { class: 'ws-dim', text: `#${i}` }), el('span', { text: a }))));
          }
          from += 5;
        } catch (e) { msg.textContent = t('ldErr', { msg: ledgerReason(e, t) }); }
        more.disabled = false;
      }
      const d = modal('ws-ledger', t('ldPick'), [el('p', { class: 'ws-dim', text: t('ldOpen') }), list, msg, el('div', { class: 'ws-row' }, more)], { onClose: () => resolve(chosen) });
      page();
    });
  }

  /** A short "confirm on the device" toast while the Ledger signs; returns a function that removes it. */
  function deviceToast() {
    ensureCss();
    const n = el('div', { class: 'ws-toast', role: 'status', 'data-ws': 'device' }, el('span', { text: t('ldOnDevice') }));
    doc.body.append(n);
    return () => n.remove();
  }

  return { t, el, idleMinutes, ensureCss, openHelp, helpLink, balanceBanner, bannerHidden, track, poke, idleGuard, idleNotice, confirmTx, chooseAccount, deviceToast };
}

/** A Ledger error in words (status words of the Ethereum app). */
export function ledgerReason(e, t) {
  const sw = e?.statusCode;
  if (sw === 0x6985 || e?.code === 4001) return t('ldRejected');
  if (sw === 0x6a80) return t('ldBlind');
  if (sw === 0x6d00 || sw === 0x6e00 || sw === 0x6e01 || sw === 0x5515 || sw === 0x6511 || /locked|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(String(e?.message))) return t('ldLocked');
  if (e?.code === 4901) return t('ldChain', { id: e.chainId ?? '' });
  return String(e?.message ?? e).slice(0, 160);
}
