(async function () {
  "use strict";
  const { t, localize, el, resultCard } = SWDG_UI;
  localize();
  const $ = (id) => document.getElementById(id);
  $("q").placeholder = t("popupInputPlaceholder");
  $("opts").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  async function run(input) {
    const c = SWDG.classifyInput(input, $("evm").value);
    const box = $("result");
    if (!c) {
      box.hidden = false;
      box.replaceChildren(el("div", { textContent: t("popupBadInput") }));
      return;
    }
    $("go").disabled = true;
    box.hidden = false;
    box.replaceChildren(el("div", { className: "muted", textContent: t("badgeChecking") }));
    const lang = chrome.i18n.getUILanguage();
    const msg = c.kind === "tx" ? { type: "tx", chain: c.chain, hash: c.value, lang } : { type: "audit", chain: c.chain, address: c.value, lang };
    const res = await chrome.runtime.sendMessage(msg).catch(() => null);
    resultCard(box, res, c.kind);
    $("go").disabled = false;
  }
  $("go").addEventListener("click", () => run($("q").value));
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run($("q").value);
  });

  // the current tab (activeTab: its URL is readable only because the user opened the popup on it)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  let url = null;
  try {
    url = tab && tab.url ? new URL(tab.url) : null;
  } catch {}
  if (url && /^https?:$/.test(url.protocol)) {
    const site = $("site");
    const r = await chrome.runtime.sendMessage({ type: "phishCheck", host: url.hostname }).catch(() => null);
    site.hidden = false;
    site.append(el("div", { className: "muted", textContent: t("popupThisSite") }), el("div", { className: "host", textContent: url.hostname }));
    if (r && r.listed) {
      site.classList.add("bad");
      site.append(el("div", { className: "title", textContent: "⚠ " + t("phishTitle") }), el("div", { textContent: t("phishNever") }));
    } else if (r && r.lookalike) {
      site.classList.add("warnc");
      site.append(el("div", { style: "font-weight:700;color:#f59e0b", textContent: "⚠ " + t("lookalikeTitle") }), el("div", { textContent: t("lookalikeBody") }));
    } else {
      site.append(el("div", { className: "muted", textContent: t("popupNotListed") }));
    }
    const token = SWDG.detectToken(url.href);
    if (token) {
      $("q").value = token.address;
      run(token.address);
    }
  }
})();
