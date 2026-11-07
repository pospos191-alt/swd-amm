# SWD Guard — Privacy policy

_Last updated: 2026-11-07_

SWD Guard is a browser extension published by SWD (SAWASDEE COIN). It is built to collect as little as possible.

**What leaves your browser**

- When you open a token page on solscan.io, jup.ag, birdeye.so, dexscreener.com or pump.fun, or when you check
  something in the popup, SWD Guard sends **that token address or transaction hash** and your language code to the
  SWD Audit API at `https://swd-zetaphy.sawasdeecoin.com`. The request carries no cookies and no identifier. The
  API, like any web server, sees your IP address; it uses it only for rate limiting.
- If you turn on "updated phishing list", SWD Guard downloads a public file from `raw.githubusercontent.com` once a
  day. Nothing about you is sent.

**What SWD Guard never does**

- It never reads, stores or sends wallet contents, seed phrases, private keys, passwords, form data, cookies or
  your browsing history.
- It does not read the content of the pages you visit (on DEX Screener it reads only the explorer link of the
  token on the page, to know which token it is).
- It has no analytics, no ads and no tracking, and it does not sell or share data.
- It loads no code from the internet; all of its code is in the package you install.

**Stored on your device**

Your settings (Chrome sync storage), the downloaded phishing list (local storage) and a 10-minute cache of audit
results (session memory, cleared when the browser closes). Uninstalling the extension removes them.

**Results**

SWD Audit results are automated, rule-based checks. They are not financial advice and not a guarantee. "No risk
found by the rules" does not mean "safe".

Contact: through https://swd-zetaphy.sawasdeecoin.com or an issue at https://github.com/pospos191-alt/zetaphy.
