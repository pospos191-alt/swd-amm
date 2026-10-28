# ZETAPHY hub

Every ZETAPHY app on one page and one screen, at **https://app.sawasdeecoin.com** ([ภาษาไทย](README.th.md)).

| Tab | What it is |
| --- | --- |
| Overview | Live chain numbers (block, block time, validators, staked), the latest blocks, one-click "add network" (MetaMask / Keplr), the testnet faucet and the endpoints |
| Wallet | The post-quantum wallet (`zetaphy-wallet`) |
| Swap | The AMM + DLMM DEX (`zetaphy-dex/web`) |
| Stake & vote | **New.** Validators, your stake and rewards, proposals. Stake / unstake / claim / vote are sent from MetaMask to the chain's precompiles (staking `0x…0800`, distribution `0x…0801`, gov `0x…0805`) |
| Earn | **New.** Every way to get ZETAPHY, easiest first, with copy-ready terminal commands: faucet, running a Neuro runner (ZETAPHY's "mining": no proof-of-work, the reward is for useful contract checks), becoming a validator, staking, liquidity. The live runner bond, runner count and job reward pool come from NeuroJobs |
| NFT | The NFT marketplace (`zetaphy-nft/web`) |
| Explorer | The block explorer (`zetaphy-explorer`) |
| Analytics | **New.** Supply, block time, transactions per minute, staked share; charts of transactions per block and time between blocks (last 60), the genesis split and validator voting power |
| DeFi | **New.** Every DEX pool with its reserves and price (read from the contracts), DLMM pools, Neuro job count |
| Leaderboard | **New.** Top ZETAPHY holders (module accounts named) and validators by stake |
| Developers | **New.** API endpoints with curl examples (EVM JSON-RPC, CometBFT, REST, faucet), chain registry files, the CLI, every contract address |
| Neuro | Neuro contract checks (`zetaphy-neuro/web`); its `/api/*` is proxied to neuro.sawasdeecoin.com |

## How it works

- `node build.mjs` copies the hub and every app into `dist/` (`/wallet/`, `/swap/`, `/nft/`, `/explorer/`, `/neuro/web/`). The apps are shown in **same-origin frames**, so they share one wallet storage and the hub can restyle them.
- `embed.css` gives every app the hub's colours and hides its own brand bar, language button and footer. `hub.js` folds long hints into an "i" icon whose text shows on hover or focus. Links to another app's site open that app's tab instead.
- The apps are unchanged: opened on their own sites (wallet.sawasdeecoin.com and the others) they look as before.
- Language: one menu of 8 (English, 中文, Español, 한국어, 日本語, Русский, Tiếng Việt, ไทย; English by default). The words live in `i18n.js` (hub and tabs) and `pages-i18n.js` (data pages); a missing one shows in English. The hub writes each app's own language setting and reloads the frames.
- Explanations: every number, button and step has hover text (`data-tip` / `data-tip-key`). The page text itself stays short.
- The node comes from `zetaphy-explorer/config.json` (written by the launch), saved as `dist/hub-config.json`.
- Saphan's EVM routes (Hyperlane) come from the chain table `zetaphy-chain/hyperlane/saphan-chains.json` and the deployed routes in `saphan-routes.json` (also in `dist/hub-config.json`): a chain added to the table appears on the Saphan page as planned, then closed or open.
- Saphan's token routes (tokens born on ZETAPHY going out, docs/SAPHAN-TOKENS.md) come from the `tokens` of the same table and of `saphan-routes.json` (`saphanTokens` in `dist/hub-config.json`): the Saphan page lists each token per destination chain (BZTPHY as staying on ZETAPHY), and the wallet bar shows under a held token (and under ZETAPHY) where it can go out.

## Deploy (Vercel, free)

Project root `zetaphy-hub`, framework "Other". `vercel.json` sets the build, the headers (frames only from this site; scripts only from this site) and the Neuro API rewrite. Domain: `app.sawasdeecoin.com` (Cloudflare: CNAME `app` → `cname.vercel-dns.com`, DNS only).

## Tests

```
npm ci
npm test            # calldata vs ethers, bech32, amounts, dist/ contents, headers
npm run test:e2e    # Chromium: every tab against a mocked node, one screen, hover text, stake/vote, mobile
```
