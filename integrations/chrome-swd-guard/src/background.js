// SWD Guard service worker. The only place that calls the network:
//   - SWD Audit API (host permission: swd-zetaphy.sawasdeecoin.com) for the token badge and the popup,
//   - the updated phishing list (DATA only, a JSON list of domain names; opt-in, off by default).
// Nothing here reads page content, cookies, wallets or keys. Results are cached in chrome.storage.session (memory).
"use strict";
importScripts("common.js");
const { API, apiLang, cleanDomainList, matchPatterns, listedDomain, lookalike, validAddress } = self.SWDG;

const LIST_URL = "https://raw.githubusercontent.com/pospos191-alt/zetaphy/main/integrations/chrome-swd-guard/data/phishing-domains.json";
const CACHE_MS = 10 * 60 * 1000;
const DEFAULTS = { badges: true, updatedList: false };
const DYNAMIC_ID = "swd-guard-phish-updated";
const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };

let bundled = null; // { domains, official }
async function bundledList() {
  if (!bundled) {
    const j = await (await fetch(chrome.runtime.getURL("data/phishing-domains.json"))).json();
    bundled = { domains: cleanDomainList(j), official: cleanDomainList({ domains: j.official }) };
  }
  return bundled;
}

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) });

async function cached(key, ttl, load) {
  const store = chrome.storage.session;
  const hit = (await store.get(key))[key];
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  await store.set({ [key]: { at: Date.now(), value } });
  return value;
}

const inflight = new Map();
async function getJson(url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const r = await fetch(url, { headers: { accept: "application/json" }, credentials: "omit", signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || !body.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
    return body;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const lineList = (lines, n) =>
  (Array.isArray(lines) ? lines : []).slice(0, n).map((l) => ({ severity: str(l && l.severity, 10), text: str(l && l.text) }));
const level = (v) => (["info", "low", "medium", "high"].includes(v) ? v : null);

async function audit(chain, address, lang) {
  if (!validAddress(chain, address)) return { ok: false, error: "bad_address" };
  const key = `a:${chain}:${address}:${lang}`;
  try {
    return await cached(key, CACHE_MS, async () => {
      const { audit: a } = await getJson(API.audit(chain, address, lang));
      return {
        ok: true,
        level: level(a.level),
        title: str(a.title, 120),
        symbol: str(a.token && a.token.symbol, 16),
        lines: lineList(a.lines, 8),
        permalink: str(a.permalink, 600) || API.permalink(chain, address),
        disclaimer: str(a.disclaimer),
      };
    });
  } catch (e) {
    return { ok: false, error: str(String(e && e.message), 200) };
  }
}

async function txCheck(chain, hash, lang) {
  const key = `t:${chain}:${hash}:${lang}`;
  try {
    return await cached(key, CACHE_MS, async () => {
      const { tx } = await getJson(API.tx(chain, hash, lang));
      return {
        ok: true,
        found: !!tx.found,
        level: level(tx.overall) || level(tx.level),
        title: str(tx.title, 120),
        lines: lineList([...(tx.lines || []), ...(tx.notes || [])], 8),
        permalink: str(tx.permalink, 600),
        disclaimer: str(tx.disclaimer),
      };
    });
  } catch (e) {
    return { ok: false, error: str(String(e && e.message), 200) };
  }
}

async function updatedDomains() {
  const { updated } = await chrome.storage.local.get("updated");
  return updated && Array.isArray(updated.domains) ? updated.domains : [];
}

async function refreshList() {
  const s = await settings();
  if (!s.updatedList) return { ok: false, error: "disabled" };
  try {
    const r = await fetch(LIST_URL, { credentials: "omit", cache: "no-cache", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const domains = cleanDomainList(await r.json());
    await chrome.storage.local.set({ updated: { domains, at: Date.now() } });
    await syncDynamicScript();
    return { ok: true, count: domains.length };
  } catch (e) {
    return { ok: false, error: str(String(e && e.message), 200) };
  }
}

/** The updated list can show the banner only with the optional "all sites" permission; otherwise the popup still checks it. */
async function syncDynamicScript() {
  const s = await settings();
  const have = await chrome.permissions.contains(ALL_SITES);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_ID] });
  if (!s.updatedList || !have) return;
  const { domains: built } = await bundledList();
  const extra = (await updatedDomains()).filter((d) => !built.includes(d));
  if (!extra.length) return;
  await chrome.scripting.registerContentScripts([
    { id: DYNAMIC_ID, matches: matchPatterns(extra), js: ["src/common.js", "src/content-phish.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true },
  ]);
}

async function phishCheck(host) {
  const { domains, official } = await bundledList();
  const s = await settings();
  const all = s.updatedList ? [...domains, ...(await updatedDomains())] : domains;
  return { listed: listedDomain(host, all), lookalike: lookalike(host, official) };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // only this extension's own pages and content scripts can send messages (no externally_connectable)
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return false;
  const lang = apiLang(msg.lang || chrome.i18n.getUILanguage());
  const run = {
    audit: () => audit(String(msg.chain), String(msg.address), lang),
    tx: () => txCheck(String(msg.chain), String(msg.hash), lang),
    phishCheck: () => phishCheck(String(msg.host || "")),
    refreshList: () => refreshList(),
    syncList: () => syncDynamicScript().then(() => ({ ok: true })),
    settings: () => settings(),
  }[msg.type];
  if (!run) return false;
  run().then(reply, (e) => reply({ ok: false, error: String(e && e.message) }));
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create("refresh-list", { periodInMinutes: 24 * 60 });
  await syncDynamicScript();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "refresh-list") refreshList();
});
chrome.permissions.onRemoved.addListener(() => syncDynamicScript());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.updatedList) (changes.updatedList.newValue ? refreshList() : syncDynamicScript());
});
