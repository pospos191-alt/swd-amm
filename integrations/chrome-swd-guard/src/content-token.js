// SWD Guard: an SWD Audit badge on token pages of solscan.io, jup.ag, birdeye.so, dexscreener.com and pump.fun.
// Reads only the page URL (and, on DEX Screener, the explorer links on the page) to find the token address.
// Draws in a closed Shadow DOM, with textContent only (no HTML from the API or the page is ever inserted).
(function () {
  "use strict";
  if (window.top !== window || window.__swdGuardToken) return;
  window.__swdGuardToken = true;
  const G = globalThis.SWDG;
  const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
  const COLORS = { high: "#e5484d", medium: "#f59e0b", low: "#a3b10a", info: "#10b981", none: "#6b7280" };

  let host = null;
  let shown = ""; // "chain:address" currently displayed
  let dismissed = new Set();

  function ui() {
    if (host) return host;
    const el = document.createElement("swd-guard-badge");
    el.style.cssText = "all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 16px;";
    const root = el.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box { font: 13px/1.35 system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", sans-serif; color: #f4f4f5;
             background: #0b1f1a; border: 1px solid #1f3d35; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
             max-width: 320px; padding: 10px 12px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      .lvl { font-weight: 600; }
      .sub { color: #a1a1aa; font-size: 12px; margin-top: 4px; }
      .warn { margin-top: 6px; color: #fecaca; font-weight: 600; }
      a { color: #6ee7b7; text-decoration: none; } a:hover { text-decoration: underline; }
      button { all: unset; cursor: pointer; color: #a1a1aa; padding: 0 2px; margin-left: auto; font-size: 15px; }
      ul { margin: 6px 0 0; padding-left: 18px; color: #d4d4d8; font-size: 12px; } li { margin: 2px 0; }`;
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "status");
    root.append(style, box);
    (document.body || document.documentElement).append(el);
    host = { el, box };
    return host;
  }

  function render(key, target, res) {
    const { box } = ui();
    box.replaceChildren();
    const row = document.createElement("div");
    row.className = "row";
    const dot = document.createElement("span");
    dot.className = "dot";
    const lvl = document.createElement("span");
    lvl.className = "lvl";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = t("close");
    close.setAttribute("aria-label", t("close"));
    close.addEventListener("click", () => {
      dismissed.add(key);
      host.el.style.display = "none";
    });
    const level = res && res.ok ? res.level : null;
    dot.style.background = COLORS[level || "none"];
    lvl.textContent = res === null ? t("badgeChecking") : res.ok && level ? `${t("badgeLabel")}: ${t("level_" + level)}` : `${t("badgeLabel")}: ${t("badgeUnavailable")}`;
    row.append(dot, lvl, close);
    box.append(row);
    if (res && res.ok) {
      if (res.symbol || res.title) {
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = [res.symbol, res.title].filter(Boolean).join(" · ");
        box.append(sub);
      }
      if (level === "high" || level === "medium") {
        const w = document.createElement("div");
        w.className = "warn";
        w.textContent = t(level === "high" ? "warnHigh" : "warnMedium");
        box.append(w);
        const ul = document.createElement("ul");
        for (const l of res.lines.filter((x) => x.severity === "high" || x.severity === "medium").slice(0, 3)) {
          const li = document.createElement("li");
          li.textContent = l.text;
          ul.append(li);
        }
        if (ul.childElementCount) box.append(ul);
      }
      const sub = document.createElement("div");
      sub.className = "sub";
      const a = document.createElement("a");
      a.href = res.permalink.startsWith(G.API_BASE + "/") ? res.permalink : G.API.permalink(target.chain, target.address);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = t("openReport");
      sub.append(a, document.createTextNode(" · " + t("notAdvice")));
      box.append(sub);
    }
    host.el.style.display = "";
  }

  function findTarget() {
    const fromUrl = G.detectToken(location.href);
    if (fromUrl) return fromUrl;
    // DEX Screener pair pages: the pair is not the token; use the page's explorer link for the base token
    if (G.dexscreenerChain(location.href)) {
      for (const a of document.querySelectorAll('a[href*="/token/"]')) {
        const tk = G.tokenFromExplorerLink(a.href);
        if (tk) return tk;
      }
    }
    return null;
  }

  async function check() {
    const target = findTarget();
    const key = target ? `${target.chain}:${target.address}` : "";
    if (key === shown) return;
    shown = key;
    if (!target || dismissed.has(key)) {
      if (host) host.el.style.display = "none";
      return;
    }
    const s = await chrome.runtime.sendMessage({ type: "settings" }).catch(() => null);
    if (!s || !s.badges) return;
    render(key, target, null);
    const res = await chrome.runtime.sendMessage({ type: "audit", chain: target.chain, address: target.address, lang: chrome.i18n.getUILanguage() }).catch(() => ({ ok: false }));
    if (shown === key) render(key, target, res);
  }

  check();
  // single-page apps change the URL without a page load
  setInterval(check, 1500);
})();
