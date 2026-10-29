# ZETAPHY hub

Every ZETAPHY app on one page and one screen, at **https://app.sawasdeecoin.com** ([ภาษาไทย](README.th.md)).

| Tab | What it is |
| --- | --- |
| Overview | Live chain numbers (block, block time, validators, staked), the latest blocks, one-click "add network" (MetaMask / Keplr), the testnet faucet and the endpoints |
| Wallet | The post-quantum wallet (`zetaphy-wallet`) |
| Swap | The AMM + DLMM DEX (`zetaphy-dex/web`) |
| Stake & vote | **New.** Validators, your stake and rewards, proposals. Stake / unstake / claim / vote are sent from MetaMask to the chain's precompiles (staking `0x…0800`, distribution `0x…0801`, gov `0x…0805`) |
| Earn | **New.** A tab per way to get ZETAPHY, easiest first (`?tab=earn&way=…`): **Free coins** (a faucet form; the curl command under "from a terminal"), **Mine in browser**, **Run a validator** (the validator guide `validators.html` itself, in a frame with the hub's colours: one copy of its text and code), **Stake**, **Add liquidity**, **Neuro runner** (ZETAPHY's "mining": no proof-of-work, the reward is for useful contract checks; the live bond, runner count and job pool from NeuroJobs). Each tab: what you get / need / how long, numbered steps, one big button |
| Validator guide | `validators.html` (also in the menu): topics as tabs — Start, Check it works, Get ZETAPHY (faucet form), Restart / fix, Rewards, Keys & safety, Advanced — with the open tab in the address (`#start`, `#check`, `#get`, `#fix`, `#rewards`, `#keys`, `#advanced`; old `#resume` still works) and arrow keys. Its download buttons point at the release of the current `setup-node.sh` (`zetaphyd-<sha256[:12]>`, filled in by `build.mjs`) |
| Mine | **New.** "Mine testnet ZETAPHY": the proof-of-work faucet in the browser (see below). Not real mining. A second mode, **Useful work**, does Neuro scan jobs and bug hunts in Web Workers instead (`work.js`; [docs/future/useful-work.md](../docs/future/useful-work.md)); practice only until its contracts are deployed |
| Agents | **New.** AI agents (testnet, `agents.js`): say what you want and sign only the limits (Proof of Intent: your own model drafts, you review, `IntentExecutor` enforces); person-or-agent labels with an on-chain passkey proof; agent bonds and liability; freeze an agent wallet with your passkey. See `docs/future/agents.md` |
| NFT | The NFT marketplace (`zetaphy-nft/web`) |
| Explorer | The block explorer (`zetaphy-explorer`) |
| Analytics | **New.** Supply, block time, transactions per minute, staked share; charts of transactions per block and time between blocks (last 60), the genesis split and validator voting power |
| DeFi | **New.** Every DEX pool with its reserves and price (read from the contracts), DLMM pools, Neuro job count |
| Leaderboard | **New.** Top ZETAPHY holders (module accounts named) and validators by stake |
| Developers | **New.** API endpoints with curl examples (EVM JSON-RPC, CometBFT, REST, faucet), chain registry files, the CLI, every contract address |
| Neuro | Neuro contract checks (`zetaphy-neuro/web`); its `/api/*` is proxied to neuro.sawasdeecoin.com |
| Governance | **New.** Open proposals and the ZetaphyTimelock queue in plain words: parameter changes compared with the current ones, EVM calls simulated with `eth_call` (as the gov module / the timelock), risky changes flagged (`govassist.js`; docs/future/crosschain-assist.md) |
| Immunity | **New.** Coverage of Neuro's flags on other chains (NeuroOracle mirrors), the Neuro-checked certificate lookup, and a quantum-safe (ML-DSA-44) attestation verifier that runs in the browser (`assist.js`, `pqattest.js`) |
| (signing summary) | Before every transaction the summary also simulates it on the latest block (balance changes through a state-override probe, `presign.js`) and, if a model is set up in Neuro, can ask your own AI to explain it |

## How it works

- `node build.mjs` copies the hub and every app into `dist/` (`/wallet/`, `/swap/`, `/nft/`, `/explorer/`, `/neuro/web/`). The apps are shown in **same-origin frames**, so they share one wallet storage and the hub can restyle them.
- `embed.css` gives every app the hub's colours and hides its own brand bar, language button and footer. `hub.js` folds long hints into an "i" icon whose text shows on hover or focus. Links to another app's site open that app's tab instead.
- The apps are unchanged: opened on their own sites (wallet.sawasdeecoin.com and the others) they look as before.
- Language: one menu of 8 (English, 中文, Español, 한국어, 日本語, Русский, Tiếng Việt, ไทย; English by default). The words live in `i18n.js` (hub and tabs) and `pages-i18n.js` (data pages); a missing one shows in English. The hub writes each app's own language setting and reloads the frames.
- Explanations: every number, button and step has hover text (`data-tip` / `data-tip-key`). The page text itself stays short.
- The node comes from `zetaphy-explorer/config.json` (written by the launch), saved as `dist/hub-config.json`.
- Saphan's EVM routes (Hyperlane) come from the chain table `zetaphy-chain/hyperlane/saphan-chains.json` and the deployed routes in `saphan-routes.json` (also in `dist/hub-config.json`): a chain added to the table appears on the Saphan page as planned, then closed or open.
- Saphan's token routes (tokens born on ZETAPHY going out, docs/SAPHAN-TOKENS.md) come from the `tokens` of the same table and of `saphan-routes.json` (`saphanTokens` in `dist/hub-config.json`): the Saphan page lists each token per destination chain (BZTPHY as staying on ZETAPHY), and the wallet bar shows under a held token (and under ZETAPHY) where it can go out.

## Mine testnet ZETAPHY (the proof-of-work faucet)

Like [pk910's Sepolia PoW faucet](https://sepolia-faucet.pk910.de), people earn free **testnet** coins with a few minutes of their
browser's work, so one person cannot drain the faucet with many addresses or IPs. It is **not mining**: ZETAPHY is proof of
stake, the work secures nothing, the coins have no value, and only `sha256` puzzles for this faucet are computed (no other coin).

- No server of its own: the node checks proofs (`zetaphy_faucetPow`, `zetaphy-chain/README.md`). The page reads
  `zetaphy_faucetPowInfo` (difficulty, reward, grants left) and the newest block (`eth_getBlockByNumber`), then Web Workers
  (`mine-worker.js`, a same-origin module allowed by `script-src 'self'`; no eval, no wasm) search nonces with a pure-JS SHA-256
  (`mine-core.js`: the first 64 bytes' state is computed once, each try is one compression). When a proof is found it is claimed
  automatically; the transaction links to the explorer.
- Nothing runs until **Start**. It **pauses while the browser tab is hidden or another hub page is open** and goes on when you
  come back (each try is an independent chance, so a pause loses nothing); it stops on Stop, when a proof is found, or when the page
  is left or redrawn (a language change). Threads: 1 to the number of cores (at most 8), **default 2**; one is enough on battery.
- The proof's block is refreshed every 20 s once it is half the allowed age (100 blocks, ~8 min), so a slow search never builds
  on a block the node no longer accepts.

**Difficulty: 30 zero bits** (2^30 ≈ 1.07 billion tries on average). Measured here, headless Chromium 141 on a 2.1 GHz Xeon VM
(4 vCPU, shared): pure-JS SHA-256 in a Web Worker **2.38 MH/s** with one worker, ~1.8–2.3 MH/s each with 2–4 workers;
WebCrypto `crypto.subtle.digest` (batches of 2000 promises, one worker) **0.11 MH/s**, 20× slower (one async call per hash), so
the page uses the pure-JS code. Node.js 22 on the same machine: 2.65 MH/s. That is about 7.5 min with 1 thread and ~4.4 min with
2 threads on this VM; a current laptop core is roughly 1.5× faster (≈ 3.5 MH/s): **~2.6 min with 2 threads, ~5 min with 1**.
Phones are 2–4× slower. The time is random (exponential): 1 in 10 searches takes more than 2.3× the average.
An operator can change it without a new release (`<home>/config/faucet-pow-bits`, 12–48).

## Every tab: how it works, what to do next, and jobs that keep running

- **How it works** (`flow.js`, words in `flow-i18n.js`): above every tab, four steps as icons that light up
  one after another, then the tabs to go to next. It can be folded; the browser remembers.
- **AI map** tab (`aimap.js`): all 35 AI features (docs/future/) as picture cards, grouped, with their status
  (works now, practice, waiting for a contract, inside the chain, command line) and an Open button that goes
  where each one lives.
- **Running jobs:** mining, useful-work scans and bug hunts keep going while other tabs are open, and both
  Mine modes stay alive when you switch between them. The tab gets a green dot and the top bar a "Running"
  pill that leads back. Pause and Stop still work as before; a new language redraws the page and stops them.

## Search engines (`seo.mjs`)

- **What is ZETAPHY?** `/about/` and `/about/<lang>.html` in all 8 languages: plain HTML built from
  `about-content.mjs`, so search engines read it without running scripts. The hub's sidebar links to it.
- Every site has `robots.txt`, `sitemap.xml`, a canonical link to its own domain, a share card (`og.png`)
  and the IndexNow key file. The hub's are written by `build.mjs`; the other sites' are committed
  (`node seo.mjs --write` after changing `SITES`; a test checks them).
- **Bing, Yandex, Seznam, Naver:** after a deploy, `node seo.mjs --indexnow` tells them about every page.
- **Google:** finds the sitemaps through robots.txt. To speed it up, the owner of sawasdeecoin.com adds a
  *Domain* property in Google Search Console (one DNS TXT record covers every site) and submits each
  `https://<site>/sitemap.xml`.

## Deploy (Vercel, free)

Project root `zetaphy-hub`, framework "Other". `vercel.json` sets the build, the headers (frames only from this site; scripts only from this site) and the Neuro API rewrite. Domain: `app.sawasdeecoin.com` (Cloudflare: CNAME `app` → `cname.vercel-dns.com`, DNS only).

## Tests

```
npm ci
npm test            # calldata vs ethers, bech32, amounts, dist/ contents, headers, the PoW hash vs node:crypto
npm run test:e2e    # Chromium: every tab against a mocked node, one screen, hover text, stake/vote, mobile;
                    # mining a proof (low difficulty, the site's CSP) and the faucet forms;
                    # useful work: practice scan + hunt, and the real contracts in an in-memory EVM
npm run build:evm   # rebuilds vendor/evm.js (EthereumJS EVM for the bug-hunting worker)
```
