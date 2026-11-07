// SWD Guard: a full-width warning on a domain from the phishing list. Runs only on the listed domains (manifest
// matches for the bundled list; the updated list only if the user granted the optional all-sites permission).
(function () {
  "use strict";
  if (window.top !== window || window.__swdGuardPhish) return;
  window.__swdGuardPhish = true;
  const G = globalThis.SWDG;
  const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
  const KEY = "swd-guard-continue:" + G.normalizeHost(location.hostname);
  try {
    if (sessionStorage.getItem(KEY) === "1") return;
  } catch {}

  function show() {
    const el = document.createElement("swd-guard-warning");
    el.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = el.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .bg { position: fixed; inset: 0; background: rgba(60, 4, 8, .96); display: flex; align-items: center; justify-content: center;
            font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", sans-serif; color: #fff; padding: 16px; }
      .card { max-width: 560px; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      p { margin: 0 0 12px; color: #fecaca; }
      .host { font-family: ui-monospace, monospace; color: #fff; word-break: break-all; }
      .btns { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
      button { font: inherit; border-radius: 8px; padding: 10px 16px; cursor: pointer; border: 1px solid #fca5a5; }
      .leave { background: #fff; color: #7f1d1d; font-weight: 700; border-color: #fff; }
      .stay { background: transparent; color: #fecaca; }`;
    const bg = document.createElement("div");
    bg.className = "bg";
    bg.setAttribute("role", "alertdialog");
    const card = document.createElement("div");
    card.className = "card";
    const h1 = document.createElement("h1");
    h1.textContent = "⚠ " + t("phishTitle");
    const p0 = document.createElement("p");
    p0.className = "host";
    p0.textContent = location.hostname;
    const p1 = document.createElement("p");
    p1.textContent = t("phishBody");
    const p2 = document.createElement("p");
    p2.textContent = t("phishNever");
    const btns = document.createElement("div");
    btns.className = "btns";
    const leave = document.createElement("button");
    leave.className = "leave";
    leave.textContent = t("phishLeave");
    leave.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else location.replace("about:blank");
    });
    const stay = document.createElement("button");
    stay.className = "stay";
    stay.textContent = t("phishContinue");
    stay.addEventListener("click", () => {
      try {
        sessionStorage.setItem(KEY, "1");
      } catch {}
      el.remove();
    });
    btns.append(leave, stay);
    card.append(h1, p0, p1, p2, btns);
    bg.append(card);
    root.append(style, bg);
    document.documentElement.append(el);
    leave.focus();
  }
  if (document.documentElement) show();
  else document.addEventListener("DOMContentLoaded", show, { once: true });
})();
