// Shared by the popup and the options page: i18n of [data-i18n] elements and the result card.
(function () {
  "use strict";
  const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
  const COLORS = { high: "#e5484d", medium: "#f59e0b", low: "#a3b10a", info: "#10b981", none: "#6b7280" };
  function localize(root = document) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  };
  /** fills `box` with a result from the service worker (textContent only) */
  function resultCard(box, res, kind) {
    box.hidden = false;
    box.replaceChildren();
    if (!res || !res.ok) {
      box.append(el("div", { className: "lvl" }, el("span", { className: "dot", style: `background:${COLORS.none}` }), t("badgeUnavailable")));
      if (res && res.error) box.append(el("div", { className: "muted", textContent: res.error }));
      return;
    }
    if (kind === "tx" && !res.found) {
      box.append(el("div", { className: "lvl", textContent: t("txNotFound") }));
      return;
    }
    const lvl = res.level || "none";
    box.append(el("div", { className: "lvl" }, el("span", { className: "dot", style: `background:${COLORS[lvl]}` }), `${t("badgeLabel")}: ${res.level ? t("level_" + res.level) : "?"}`));
    if (res.symbol || res.title) box.append(el("div", { className: "muted", textContent: [res.symbol, res.title].filter(Boolean).join(" · ") }));
    if (res.level === "high") box.append(el("div", { className: "muted", style: "color:#e5484d;font-weight:600", textContent: t("warnHigh") }));
    else if (res.level === "medium") box.append(el("div", { className: "muted", style: "color:#f59e0b;font-weight:600", textContent: t("warnMedium") }));
    if (res.lines && res.lines.length) box.append(el("ul", {}, ...res.lines.slice(0, 6).map((l) => el("li", { textContent: l.text }))));
    if (res.permalink && res.permalink.startsWith(SWDG.API_BASE + "/"))
      box.append(el("p", {}, el("a", { href: res.permalink, target: "_blank", rel: "noopener noreferrer", textContent: t("openReport") })));
    box.append(el("div", { className: "muted", textContent: t("notAdvice") }));
  }
  globalThis.SWDG_UI = { t, localize, el, resultCard };
})();
