# SWD Guard (Chrome extension)

A Manifest V3 Chrome extension from SWD (SAWASDEE COIN) that warns people **before** they touch a risky token or a
phishing site. Plain JavaScript, no build step, no dependencies, no remote code.

ภาษาไทย: [README.th.md](README.th.md) · Store checklist (Thai): [STORE_CHECKLIST.th.md](STORE_CHECKLIST.th.md) · [PRIVACY.md](PRIVACY.md)

## What it does

| Feature | How |
| --- | --- |
| **SWD Audit badge** on token pages of solscan.io, jup.ag, birdeye.so, dexscreener.com, pump.fun | The token address is read from the page URL (DEX Screener: from the page's explorer link). The service worker calls `GET /api/audit?chain=&address=&lang=`; a small card (closed Shadow DOM, bottom-right) shows the level, and for medium / high the top findings and a warning. |
| **Popup**: audit any address, transaction or link | Solana addresses / signatures are detected automatically; for `0x…` the user picks Ethereum, BNB Chain, Base or Arbitrum. Calls `/api/audit` or `/api/audit/tx`. On a token page it audits that token at once. |
| **Phishing warning** | A full-page warning (Leave / Continue) on domains in the bundled list `data/phishing-domains.json`. The popup also flags the current site if it is listed, or if it **looks like SWD but is not `*.sawasdeecoin.com`**. |
| **Updated list** (opt-in, off by default) | Once a day it downloads the same JSON from this public repo (`raw.githubusercontent.com/.../data/phishing-domains.json`): data only, validated (domain names, max 2000). The popup always uses it; the full-page warning on these extra domains needs the optional "all sites" permission, which the user can grant / remove on the settings page. |
| **8 languages** | th, en, zh (zh_CN), ja, ko, vi, es, ru via `chrome.i18n` (`_locales/`). The API answers in the browser's language too. |

Supported chains for the badge: Solana, Ethereum, BNB Chain, Base, Arbitrum (the chains these sites list). The popup
reaches the same chains; the SWD website covers all 14.

## Permissions (and why)

| Permission | Why | Install warning |
| --- | --- | --- |
| `host_permissions: https://swd-zetaphy.sawasdeecoin.com/*` | the SWD Audit API | yes (one site) |
| content scripts on solscan.io, jup.ag, birdeye.so, dexscreener.com, pump.fun | to draw the badge | yes (these sites) |
| content script on the bundled phishing domains | to draw the warning | yes (listed as "and N other sites") |
| `storage` | settings (sync), the updated list (local), a 10-minute result cache (session) | no |
| `activeTab` | the popup reads the current tab's URL only when the user clicks the icon | no |
| `scripting` | to register the warning for the updated list, only if the user granted "all sites" | no |
| `alarms` | the daily list update | no |
| `optional_host_permissions: all sites` | **optional**, asked only from the settings page, for warnings on the updated list | asked at that time |

No `tabs`, `cookies`, `webRequest`, `history`, `<all_urls>` by default, no `externally_connectable`, no access to
wallets or keys. Every page string from the API is inserted with `textContent` (checked by `scripts/check.mjs`, which
also refuses `eval`, `new Function`, `innerHTML` and remote `<script>`).

## Files

```
manifest.json            MV3 manifest
_locales/<8 langs>/      UI text
src/common.js            pure helpers (URL → token, input classification, domain matching); unit-tested
src/background.js        service worker: API calls, cache, list update, dynamic warning script
src/content-token.js     the badge
src/content-phish.js     the phishing warning
src/popup.*, src/ui.js   popup
src/options.*            settings
data/phishing-domains.json   bundled phishing list (also the "updated list" source on GitHub)
icons/                   16/32/48/128 px (scripts/make-icons.py)
scripts/check.mjs        static release checks
scripts/sync-manifest.mjs    copies the bundled list into the manifest's matches
scripts/zip.sh           builds dist/swd-guard-<version>.zip for the Chrome Web Store
test/common.test.mjs     unit tests (node:test)
test/e2e.playwright.mjs  optional: loads the extension in Chromium with every request mocked
```

## Develop

```bash
cd integrations/chrome-swd-guard
npm test                       # unit tests + static checks (no install needed)
node test/e2e.playwright.mjs   # optional, needs Playwright + Chromium
```

Load it unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → choose this folder.

### Editing the phishing list

1. Edit `data/phishing-domains.json` (lowercase host names; an entry covers its subdomains). Add a domain only after
   it has been reported and checked; remove false positives quickly.
2. `node scripts/sync-manifest.mjs` (updates the manifest's matches), then `npm test`.
3. Merge to `main`: users with "updated list" on get it within a day. The bundled copy (and the full-page warning
   without the optional permission) updates with the next store release.

The bundled entries are SWD-lookalike names on common drainer patterns (claim / airdrop / connect); review them
before the first release.

## Release

```bash
sh scripts/zip.sh    # → dist/swd-guard-0.1.0.zip (only manifest, _locales, icons, src, data)
```

Bump `version` in `manifest.json` (and `package.json`) for each upload. Then follow
[STORE_CHECKLIST.th.md](STORE_CHECKLIST.th.md).
