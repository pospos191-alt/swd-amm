(async function () {
  "use strict";
  const { t, localize } = SWDG_UI;
  localize();
  const $ = (id) => document.getElementById(id);
  const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };
  const s = await chrome.storage.sync.get({ badges: true, updatedList: false });
  $("badges").checked = s.badges;
  $("updatedList").checked = s.updatedList;
  $("badges").addEventListener("change", () => chrome.storage.sync.set({ badges: $("badges").checked }));
  $("updatedList").addEventListener("change", () => {
    chrome.storage.sync.set({ updatedList: $("updatedList").checked });
    status();
  });

  let hasAll = false;
  async function status() {
    const { updated } = await chrome.storage.local.get("updated");
    $("listStatus").textContent =
      $("updatedList").checked && updated ? t("optListStatus", [String(updated.domains.length), new Date(updated.at).toLocaleString()]) : "";
    $("refresh").disabled = !$("updatedList").checked;
    hasAll = await chrome.permissions.contains(ALL_SITES);
    $("grant").textContent = t(hasAll ? "optRevokeAllSites" : "optGrantAllSites");
  }
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    const r = await chrome.runtime.sendMessage({ type: "refreshList" });
    if (!r || !r.ok) $("listStatus").textContent = t("badgeUnavailable") + (r && r.error ? ` (${r.error})` : "");
    else await status();
    $("refresh").disabled = false;
  });
  $("grant").addEventListener("click", async () => {
    // must run in the click handler (a user gesture) for Chrome to show its permission prompt
    // request() is the first call (no await before it), so it keeps the click's user gesture
    if (hasAll) await chrome.permissions.remove(ALL_SITES);
    else await chrome.permissions.request(ALL_SITES);
    await chrome.runtime.sendMessage({ type: "syncList" });
    status();
  });
  status();
})();
