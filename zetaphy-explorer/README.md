**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Explorer (explorer.sawasdeecoin.com)

Block explorer for the ZETAPHY chain (Cosmos SDK v0.54 + Cosmos EVM v0.7.3, chain id `zetaphy_77390-1`, EVM chain id 77390)
It is a **fully static site**: no server, no database, no indexer. The user's browser reads data directly from the node's public RPC/REST,
so it can be hosted on Vercel for free

## What it has

| Page | Shows |
|---|---|
| Home `#/` | chain id, block height, total supply (decreases when fees are burned and when coins sent to `0x…dEaD` are burned, with the amount burned in ~1 hr), staked amount and ratio, number of validators and % of voting power with a PQ vote key, latest blocks, latest transactions |
| Block `#/block/<number>` | header, block proposer (validator name), transactions with status, this block's **quantum-resistant ML-DSA-44 certificate** (in tx[0] of the next block): signers, signed power versus required, and **real signature verification in the browser** with `zetaphy-network/src/pqcert.js` |
| Transaction `#/tx/<hash>` | EVM: from/to/value/gas/fee/status/logs, decodes ERC-20 / ERC-721 / ERC-1155 transfers (Transfer, TransferSingle, TransferBatch) · Cosmos: decodes every message, including ZETAPHY messages (`MsgEVMCall`, `MsgQuantumLock`, `MsgPQVoteKey`, `MsgPQCertificate`, `MsgSetPQEvidence`), signer key type (ML-DSA-44), memo, fee, events |
| Address `#/address/<0x… or zetaphy1…>` | both formats (same 20 bytes), balance, nonce / sequence, whether it is a contract, ML-DSA-44 account, **quantum lock** (the `quantumLockedTo` field of `zetaphy_pqAccount`), other coins, staked amount, token balances, latest transactions, status in **ThreatRegistry** |
| Token `#/token/<0x…>` | ERC-20 / ERC-721 / ERC-1155: name, symbol, decimals, supply, Neuro report link (URL is configurable), ThreatRegistry, latest transfers |
| Validator `#/validators` | voting power, status, commission, **whether a PQ vote key is registered** (reads the `zetaphypq` store with `abci_query`) |
| Settings `#/settings` | node URL (stored in this browser), ThreatRegistry, Neuro report URL, number of blocks to scan |

The search box accepts: block number, transaction hash (EVM `0x…` or Cosmos hex), block hash, address `0x…` / `zetaphy1…`, `zetaphyvaloper1…`

Thai/English (EN/Thai button), light/dark theme, works on mobile (tables become cards)

### No indexer

Recent history comes from **scanning the latest N blocks in the browser** (default 100 blocks ≈ 8 minutes at ~5 seconds per block, configurable 1–1000)
The page always states the scanned range. Older transactions can be opened by hash or block number, but they will not appear in an address's "Latest transactions" list

- Transactions are read in ranges of 50 blocks (CometBFT `tx_search` by height range). Completed ranges are cached, so only the top range is queried again
  If the node has tx indexing turned off, it reads block by block instead (limited to at most 40 blocks per round)
- An address's token balances are found from Transfer events in the same range (`eth_getLogs`), then `balanceOf` is read live
  (`MsgEVMCall` logs are not in `eth_getLogs`, per the zetaphy-chain README, so this may be incomplete)
- All requests go through one queue: at most 4 concurrent requests, at most 8 requests/second, in-memory cache (confirmed blocks and transactions are kept long; "latest" data expires in 4 seconds), duplicate pending requests share the same response
- The home page refreshes every 6 seconds, only while the tab is open

### Quantum-resistant certificate (ML-DSA-44)

Block H+1 has tx[0] = `MsgPQCertificate`, which aggregates the validators' ML-DSA-44 signatures for block H. The block page calls `verifyBlock` from
`zetaphy-network/src/pqcert.js` (bundled in `vendor/zetaphy-lib.js`), which:
checks the block's header and data hash against the signed hash, reads the validator set and vote keys at height H, verifies every signature with `@noble/post-quantum`,
and then applies the same rule as the node: `3 × signed power > 2 × total power − 3 × power without a key`

Limitation: voting power and vote keys are read from the same node (not pinned), so a dishonest node could send fake keys together with fake signatures.
So the result label says "Certificate is valid according to this node's validator keys" (not just "Certificate is valid"), and a trust note (`pqTrust`)
is always shown next to the result label. To verify without trusting any node, use `zetaphy pq verify-block --pin` in zetaphy-network

### ThreatRegistry (Neuro)

Uses the same logic as the wallet and snap (`zetaphy-network/src/vaccine.js`): checks the address itself (`isAddressFlagged/Enforced`),
the full code bytes (`isCodeFlagged/Enforced`), the Neuro fp1 fingerprint (`isFlagged/Enforced`) and the code behind proxies (EIP-1167, EIP-1967, beacon)
If flagged, it shows facts only, per `docs/LEGAL.md`: "Flagged by a Neuro runner", category (the neutral text from `REASON_TEXT`),
evidence (reportHash, URI, submitter, time), the owner's statement (`responseAt`), how to re-check, and the message
**"Automated code analysis data, not an accusation"** every time. If the registry cannot be read, nothing is shown (no guessing)
If no ThreatRegistry address is set yet, the page says "Not checked"

### Security

- No `innerHTML` (or other sinks) with any data: DOM is built with `textContent` through `src/dom.js` (links only to `#/…` or `https:`)
- Text from the chain (token names/symbols, moniker, memo, events, statements) has control characters, direction-override characters (bidi, for example U+202E) and zero-width characters stripped, and length limited (`safeText` in `src/format.js`)
- CSP in `vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and other headers (HSTS, nosniff, no-referrer, X-Frame-Options)
- No external scripts or fonts. All libraries are in `vendor/zetaphy-lib.js`, built from this repo
- Requests to the node send no cookies (`credentials: 'omit'`) and only accept `https://` URLs (except `http://localhost` for local testing)

**Why `connect-src` is `https:`:** users can change the node on the settings page, so the CSP must allow any https host.
If you want to lock it to our node only, edit `vercel.json` to, for example, `connect-src 'self' https://1-2-3-4.sslip.io`
(as a result, nodes users set themselves will be blocked by the browser)

## Setting the node URL (RPC)

There is no real node yet, so `config.json` has the placeholder value `https://<node-host>`, and the page shows a warning bar until it is set

A node installed with `zetaphy-chain/setup-node.sh` has Caddy serving https at `https://<dashed-ip>.sslip.io` (see `NODE-INFO.txt` on the server), where
- `https://<host>/` = EVM JSON-RPC
- `https://<host>/rpc/` = CometBFT RPC (heavy routes are blocked)
- `https://<host>/rest/` = Cosmos REST
- Caddy already adds CORS (`Access-Control-Allow-Origin *`), so this site can call it directly

**For everyone:** edit `config.json`, then commit/deploy

```json
{
  "node": "https://1-2-3-4.sslip.io",
  "threatRegistry": "0x…ThreatRegistry address on ZETAPHY (empty = no check)",
  "neuroReportUrl": "https://<Neuro site>/web/?chain=zetaphy&address={address}",
  "scanBlocks": 100
}
```

- `node`: the node host (the explorer appends `/`, `/rpc/`, `/rest/` itself)
- If the APIs are on separate hosts, set `evmRpc`, `cometRpc`, `rest` separately (`cometRpc` and `rest` must end with `/` because Caddy uses `handle_path /rpc/*`)
- `neuroReportUrl`: `{address}` and `{chainId}` are substituted. Empty = no link shown
  (Note: the Neuro site does not list the `zetaphy` chain yet. Set this when the site supports it)

**For your own browser only:** open the **Settings** page (`#/settings`), enter the URL and press "Test connection". The value is stored in that browser's localStorage
Press "Use site defaults" to go back to `config.json`

## Hosting on Vercel (free)

1. vercel.com → **Add New → Project** → choose this repo
2. Set **Root Directory** to `zetaphy-explorer` (Framework Preset: Other). No build settings needed: `vercel.json` already says no install/build and serves the whole folder
   (`vendor/zetaphy-lib.js` is already committed)
3. **Deploy**, then open `https://<project>.vercel.app` and check that the page loads and the CSP works (DevTools → Network → Response headers)

### Connecting the subdomain `explorer.sawasdeecoin.com`

1. At the DNS provider for `sawasdeecoin.com`, add the record
   - Type: `CNAME` · Name/Host: `explorer` · Value/Target: `cname.vercel-dns.com` · TTL: default (or 300)
   - If you use Cloudflare, set Proxy status to **DNS only** (grey cloud) so Vercel can issue the SSL certificate
2. In Vercel: Project → **Settings → Domains** → **Add** → type `explorer.sawasdeecoin.com` → Add
3. Wait until Vercel shows "Valid Configuration" (usually a few minutes). The HTTPS certificate is issued automatically

## Development and testing

```bash
cd zetaphy-explorer
npm install                # devDependencies: esbuild, @noble/*, playwright-core, ethers (tests only)
npm run build              # rebuild vendor/zetaphy-lib.js (when pqcert.js / pqtx.js / vaccine.js change), then commit
npm run serve              # http://localhost:8095 with the same CSP as vercel.json
npm test                   # unit + browser (mock node)
npm run test:devnet        # against a real chain (see below)
```

- `npm test` = `test/unit.test.js` (Cosmos/EVM transaction decoders, token transfers, formatters, config, queue/cache, ThreatRegistry, scanning, i18n, CSP/sink checks) and
  `test/explorer.e2e.js` (Chromium via Playwright; uses `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` or `CHROMIUM_PATH`)
  The mock node in `test/mock-chain.js` creates blocks with genuinely correct hashes and real ML-DSA-44 signatures (one block has a bad signature to test that it is rejected)
- `npm run test:devnet` starts a devnet chain with `zetaphy-network/scripts/devnet.sh` (binary `/tmp/ci-test/zetaphyd-v4` or `ZETAPHYD=…`) on ports 23545–23648,
  always run under `flock /tmp/ci-test/devnet.lock`, and then: enables vote extensions, registers vote keys, sends EVM transactions, creates an ERC-20, creates a ThreatRegistry with 2 runners flagging the token,
  and checks every page in the browser

## Structure

```
index.html  style.css  favicon.svg  config.json  vercel.json  .vercelignore
src/app.js       pages and navigation (hash routes)
src/chain.js     node queries + scanning of the latest blocks
src/rpc.js       queue (rate/concurrency limited) + cache
src/cosmos.js    decodes TxRaw/TxBody/AuthInfo and messages (including ZETAPHY's)
src/evm.js       decodes ERC-20/721/1155 transfers, ABI strings, raw EVM tx (RLP), reads token info
src/threat.js    ThreatRegistry (vaccine.js)
src/format.js    formats numbers/addresses/time, safeText
src/dom.js       builds DOM without HTML
src/i18n.js      UI strings (en, zh, es, ko, ja, ru, vi, th)
src/config.js    defaults, config.json, browser settings
vendor/zetaphy-lib.js  bundle of pqcert.js, pqtx.js, vaccine.js and @noble (built with npm run build)
```

---

English summary: a static, serverless ZETAPHY block explorer (no database, no indexer). The browser talks to the node's public
EVM JSON-RPC, CometBFT RPC and Cosmos REST (behind Caddy) directly, scans the last N blocks for recent history (bounded, cached,
rate-limited), verifies each block's ML-DSA-44 certificate in the browser with `pqcert.js`, decodes ZETAPHY's custom messages and
EVM token transfers, and shows ThreatRegistry flags in neutral wording with the disclaimer. Deploy on Vercel with Root Directory
`zetaphy-explorer`; point `explorer.sawasdeecoin.com` with a CNAME `explorer` → `cname.vercel-dns.com`, then add the domain in the
Vercel project. Set the node in `config.json` (`node`) or per browser on the Settings page.
