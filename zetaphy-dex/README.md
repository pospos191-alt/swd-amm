**English** | [ภาษาไทย](README.th.md)

# ZETAPHY DEX (ZETAPHY Swap)

An AMM token exchange (x·y = k formula) with liquidity pools for the **ZETAPHY** chain (Cosmos EVM,
EVM chain id `77390`, chain id `zetaphy_77390-1`, native coin ZETAPHY, wallet ticker **ZTPHY**, 18 decimals)

> ⚠️ **Testnet only. The coins have no value. The contracts have not passed a security audit (unaudited).** Read the "Risks" section before use.

- Contracts, build scripts, deploy CLI and test suite: this folder (`zetaphy-dex/`)
- Web page: `web/`, published at **https://swap.sawasdeecoin.com/** (its own Vercel project on its own origin)
  The old address `https://swd-amm.sawasdeecoin.com/zetaphy/` redirects (308) here

## Structure

| File | Purpose |
|---|---|
| `contracts/ZetaphyFactory.sol` | Creates pools (CREATE2), one pool per token pair, and stores the values governance can set (`feeTo`, `threatRegistry`) |
| `contracts/ZetaphyPair.sol` | x·y = k pool + LP token (ZLP) |
| `contracts/ZetaphyRouter.sol` | Functions users call: add/remove liquidity, swap (multi-hop), deadline, slippage, fee-on-transfer tokens, Neuro check |
| `contracts/WZETAPHY.sol` | WETH-style wrapped native (used in tests and on other chains without the precompile) |
| `contracts/TestToken.sol` | Test token (no value) for testnet |
| `contracts/test/*.sol` | Contracts used only in tests (flash borrower, reentrancy token, mock runners, `RevertProbe` to check balances after a revert, gas-burning registry, `ForceSend`) |
| `artifacts/*.json` | Compile output (committed so the CLI does not need a compiler). `npm run build -- --check` checks that it matches the source |
| `cli.js` | Deploy and governance settings |
| `test/` | Unit tests (in-memory EVM), fuzz, browser e2e, integration on a real devnet |
| `web/` | Web page (plain HTML/CSS/JS, no third-party code) and `web/vercel.json` (CSP and security headers) |

## Design

**Formula and contracts:** Uses the Uniswap V2 math (whitepaper), which is proven in production, but the code is **completely rewritten
under the MIT license** (no Uniswap GPL code was copied). Solidity 0.8.26, optimizer 200, evm `cancun`, same as the rest of the repo.
Router function names and argument order match V2 (for example `swapExactETHForTokens`) so wallets that decode V2 display them correctly.
"ETH" in function names means the chain's native coin (ZETAPHY).

- A **0.3%** fee on the amount paid goes to the pool (liquidity providers earn it)
- **Protocol fee** is off by default. Governance turns it on with `setFeeTo(addr)`: 1/6 of the growth of √k (= 0.05% of volume) as LP to `feeTo`
- **TWAP:** `price0CumulativeLast` / `price1CumulativeLast` (UQ112.112 × seconds)
- **Reentrancy lock** on every function that changes pool state
- `skim` / `sync`
- **MINIMUM_LIQUIDITY:** 1000 smallest units of the first LP are locked at `address(0)` forever
- The router checks **deadline** and **slippage** (amountOutMin / amountInMax / amountAMin / amountBMin) in every function
- Supports **fee-on-transfer tokens** through the `…SupportingFeeOnTransferTokens` functions
- **Flash swap:** `swap(..., data)` sends the tokens first and then calls `zetaphyDexCall`; they must be returned with the fee within the same transaction
- **First deposit (differs from V2):** while nobody holds LP in the pool (`totalSupply == 0`), the router uses the amounts the user enters (desired) directly,
  even if the pool already has reserves (someone transferred tokens in and called `sync`). So the first depositor sets the price, and any balance transferred in earlier goes to the first depositor
  (they get all the LP except the 1000 that are locked). An attacker cannot set the price for the first depositor and only loses the tokens they transferred in. The web page also treats this as a new pool (see the web page section)

**Native coin on ZETAPHY:** We checked that the precompile `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` is the Cosmos EVM WERC20
(`precompiles/werc20`): it has ERC-20 style `transfer` / `approve` / `transferFrom` / `balanceOf`, where **the balance is the account's native balance itself**,
`deposit()` immediately returns the coins to the caller (so the "wrap" does nothing), and `withdraw()` does nothing (it only checks the balance).
The router only uses `deposit` / `withdraw` / `transfer` / `balanceOf`, so it can use the precompile as `WETH()` directly. **There is no need to deploy WZETAPHY on ZETAPHY**
(`cli.js deploy` checks for the precompile first and picks it automatically). Tested on a real devnet: the pool's native balance = the pool's reserve exactly.

**Neuro (a key ZETAPHY feature):**

- *On-chain (optional):* governance sets `factory.setThreatRegistry(<ThreatRegistry>)` (default `0` = off).
  When on, the router **refuses buys (swap in) and liquidity adds** for tokens whose ThreatRegistry flag is already "enforced"
  (`isContractEnforced(token)`: the token's address on this chain, or its code byte for byte) with the error `TokenEnforced(token, reason)`.
  **Selling to the native coin (ZTPHY) and removing liquidity do not query the registry, so they always work.** Holders are never stuck.
  (Selling token X for token Y still queries the registry about Y.)
  If the configured registry does not respond, responds in the wrong format, or uses more gas than `REGISTRY_GAS` (100,000 per query), the router **refuses (fail closed,
  `RegistryUnavailable`) for the whole router**: every token buy and every liquidity add stops until governance sets the registry to `0`
  (unblocks immediately) or changes it to one that responds. When it is set, the factory checks that the address can answer `isContractEnforced` within the same gas (to catch typos),
  but it cannot prove that it will keep answering in the future.
- *Neuro model score (optional, OFF by default):* governance sets `factory.setNeuroScore(<NeuroScore>, threshold)`
  (`node cli.js set-neuro-score <addr> --min-p 0.8`; `0x0` = off). When on, the router **refuses buys (swap in)** of a token whose
  current score under NeuroScore's active model is `>= threshold` (`TokenScoreTooHigh(token, score)`; the score is a calibrated logit x 1e7,
  a statistical estimate, not a finding). A token with no score under the active model is let through. Selling and liquidity never ask the
  scorer. Fails closed like the registry (`ScoreUnavailable`, `SCORE_GAS` = 50,000). Design, gas and limits: `docs/future/onchain-ml.md`.
- *Web page:* checks tokens before buying, before adding liquidity, and before importing by address, using the same keys as the ZETAPHY wallet
  (`zetaphy-network/src/vaccine.js`): address/code (`isContractFlagged`/`isContractEnforced`), Neuro fp1 fingerprint
  (`isFlagged`/`isEnforced`), and the target code behind proxies (EIP-1167, EIP-1967). A flag that is not yet enforced = **warning**, and the user must tick to confirm;
  an enforced flag = **refused**. The registry the web page uses is `neuroRegistry` in `deployments.json` or `factory.threatRegistry()`
- Neutral wording per `docs/LEGAL.md` (states facts about the code, does not judge intent), and shows the message
  **"Automated code analysis data, not an accusation"** every time Neuro results are shown

**What governance can and cannot do (stated plainly):**

- *Can:* set `feeTo`, set/disable `threatRegistry`, `router.sweep(to)` (forward native coins that strayed into the router, see below),
  transfer governance rights (two steps: `setGovernance` then `acceptGovernance`)
- *Can stop buys through the router:* because the registry check is fail closed, governance (or a registry chosen by governance)
  can make the router refuse every buy and every liquidity add, with a registry that stops responding or answers "enforced" for every token.
  Selling to the native coin and removing liquidity still work, and the pool itself does not query the registry (calling the pool directly always works). Set the registry to `0` to unblock
- *Cannot:* move anyone's funds, stop the pool itself, or change the 0.3% fee. The contracts have no proxy and cannot be upgraded
- Governance should be transferred to a multisig (for example `SimpleMultisig` in zetaphy-network) after deploy

**Native coins that stray into the router:** `receive()` accepts native coins only from WETH, but on ZETAPHY anyone can transfer native coins into the router through
the precompile's `transfer` (or self-destruct) without going through `receive()`. Those coins have no owner in the router: governance can call
`router.sweep(to)` to send the router's entire native balance to `to`. This is safe because the router does not hold user funds across transactions
(every function forwards or returns all tokens within the same transaction; a test checks that the router's balance is 0 after every kind of swap).

## Build and test

```bash
cd zetaphy-dex
npm install
npm run build            # compile -> artifacts/  (npm run build -- --check: check that artifacts match the source)
npm test                 # unit + fuzz + build check + web libs + CLI (in-memory EVM, no node needed)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:web          # web page in Chromium + mock wallet + mock RPC (real in-memory EVM)
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet        # deploy on a real devnet, swap ZTPHY <-> test tokens, Neuro
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:web:devnet    # the same web page against a real devnet
```

Devnet tests use port `ZDEX_DEVNET_PORT` (default 24545 and ~110 after it) and start a temporary node with `zetaphy-network/scripts/devnet.sh`.
Coverage: add/remove liquidity, swaps in both directions (exact in / exact out), multi-hop, price impact, LP fee and protocol fee,
minimum liquidity, K invariant, flash swap, reentrancy (every pool function), deadline, slippage, fee-on-transfer tokens,
registry refusals (real ThreatRegistry), TWAP, skim/sync, governance, and invariant fuzzing (seed is configurable: `ZDEX_FUZZ_SEED`, `ZDEX_FUZZ_STEPS`).

Tests from the security review (`test/security.test.js`, `test/web-lib.test.js`, web e2e and devnet):
first deposit after a donation + `sync` (M3), a registry that uses too much gas fails closed and is unblocked with `0` (L5), `sweep` (L9),
the CLI refuses key files readable by others and chains other than 77390 (L7), the web page with overwritten localStorage (M4), chain id check before signing (L1),
and on a real devnet (S1): `RevertProbe` calls the router/pool that move native coins through the precompile and then revert (below the router minimum,
pool K check fails, and its own revert after a successful swap). The native and precompile balances of the pool and of the contract return to exactly the same values
both inside the transaction and after it, and `deposit{value}` called by a contract really returns the coins to that contract.

## Deploying the contracts

Use testnet-only keys, stored in a file. **Never paste keys into chat or onto the command line.** The CLI only accepts `--key-file <file>`
(or the `ZETAPHY_DEX_KEY_FILE` variable). The file is a hex private key or a keystore JSON (decrypted with `ZETAPHY_PASSPHRASE`).
**The CLI refuses key files that group or others can read/write** (it tells you to `chmod 600 <file>`).
`deploy` only works on ZETAPHY (EVM chain id 77390). If the RPC reports another chain id it refuses, unless you pass `--any-chain`.

```bash
cd zetaphy-dex
# 1) deploy (on ZETAPHY it uses the native precompile as WETH automatically)
node cli.js deploy --rpc https://<ZETAPHY rpc> --key-file ~/.zetaphy/dex-deployer.key \
  --public-rpc https://<rpc used by the web page> \
  --registry <ThreatRegistry address, if you want to enable the on-chain check> \
  --test-tokens \
  --web            # no file name = web/deployments.json
# 2) view status
node cli.js status --rpc https://<rpc>
# 3) set/disable the Neuro registry later (must be governance), turn the protocol fee on/off
node cli.js set-registry <0xRegistry|0x0> --rpc https://<rpc> --key-file <file>
node cli.js set-fee-to  <0xAddr|0x0>     --rpc https://<rpc> --key-file <file>
# 4) transfer governance to a multisig (the multisig must call acceptGovernance())
node cli.js deploy ... --governance <0xMultisig>     # or call setGovernance yourself later
```

Other options: `--wnative deploy` (deploy WZETAPHY instead of the precompile, for other chains; use with `--any-chain`), `--fee-to`, `--out <file>`.
Output is written to `deployments/<chainId>.json` and (with `--web`) to `web/deployments.json`, which the web page reads (`--web <file>` writes elsewhere instead).
`--test-tokens` creates tUSD and tSWD (no value) with pools against ZTPHY, and `mint-test <token> <to> <amount>` hands out more.

After deploy, commit `web/deployments.json` (it has no secrets, only contract addresses and the public RPC). Vercel redeploys the web page automatically.

## Web page on Vercel

The web page is in `web/` and is deployed as **its own separate Vercel project** at **https://swap.sawasdeecoin.com/**
(fully static, no server, no build step). So it does not share an origin with the test-ui site, which has a looser CSP (`'unsafe-inline'`, scripts from a CDN).
The main site header (`test-ui/index.html`) has a "ZETAPHY Swap" link to `https://swap.sawasdeecoin.com/` (opens a new tab, `rel="noopener"`),
and `test-ui/vercel.json` permanently redirects (308) `/zetaphy` and `/zetaphy/*` to the same path on `swap.sawasdeecoin.com`, so old links still work.

First-time setup (the owner does this once):

1. Vercel → **Add New… → Project** → import the existing `swd-amm` repo (a new project, separate from the test-ui project)
2. **Root Directory: `zetaphy-dex/web`**, Framework Preset: **Other**, no Build Command / Output Directory needed (leave empty), then Deploy
   (`web/vercel.json` adds the CSP and security headers to every path)
3. DNS for `sawasdeecoin.com`: add the record **CNAME `swap` → `cname.vercel-dns.com`**
   (if the domain's DNS is on Vercel itself, skip this step; Vercel creates it for you)
4. In the new project → **Settings → Domains** → add **`swap.sawasdeecoin.com`** and wait for the status Valid Configuration (Vercel issues the HTTPS certificate automatically)
5. Check: `curl -sI https://swap.sawasdeecoin.com/ | grep -i content-security-policy` must start with `default-src 'none'; script-src 'self'`
   and `curl -sI https://swd-amm.sawasdeecoin.com/zetaphy/` must return 308 to `https://swap.sawasdeecoin.com/`

- Configuration: `web/deployments.json` (from `cli.js deploy --web`) and `web/tokenlist.json`
  (Uniswap token list format: `{ chainId: 77390, address, name, symbol, decimals }`)
- The RPC the web page uses must be https and allow CORS so browsers can call it (same as zetaphy-wallet uses). Users can change the RPC in "Settings",
  but if it is not the RPC from `deployments.json`, the web page shows a warning bar the whole time (with a button to go back to the default) and **does not pass that RPC to the wallet**
  (`wallet_addEthereumChain` always uses the RPC from `deployments.json`). If there is no RPC, the web page reads through the connected wallet when it is on ZETAPHY
- A pool that has reserves but no LP holders yet (someone transferred tokens in and called `sync`): the web page treats it as a new pool and does not compute the other side's amount from the reserves.
  The user enters both sides, the page shows the warning "This pool has a token balance but nobody holds LP yet — you set the price", and sends **minimum = the amount entered**
  (so the router reverts if the ratio changes). On the contract side, the router also uses the entered amounts directly when `totalSupply == 0` (see "Design")
- Before every `eth_sendTransaction`, the web page asks the wallet for `eth_chainId` again. If it is not 77390 it does not send, and it puts `chainId: 0x12e4e` in the transaction
- Before buying and before adding liquidity, it queries Neuro again (no cache) when the user presses confirm
- Security: `web/vercel.json` sets a strict CSP on every path (`default-src 'none'; script-src 'self'; style-src 'self'`,
  no inline, no scripts from elsewhere, `connect-src` only https and localhost, `frame-ancestors 'none'`)
  plus HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` and COOP `same-origin`.
  The web page only uses `textContent`, filters token names/symbols (strips control/bidi/zero-width characters, limits length, warns about names that duplicate the list)
  and **approves exactly the amount needed**, not unlimited. No third-party libraries (hand-written ABI encoder, selectors precomputed and checked by tests)
- Wallets: EIP-6963 (MetaMask, Rabby, OKX, Trust, Binance Wallet, Coinbase, Brave, Phantom, etc.) and legacy providers
  (`window.ethereum`, `window.binancew3w`). Adds the network with `wallet_addEthereumChain` (ticker ZTPHY). On mobile without a wallet there are links to open in a wallet app
- 8 languages (English, 中文, Español, 한국어, 日本語, Русский, Tiếng Việt, ไทย; English by default), light/dark mode, works on mobile (tested at 360 px width)

**Values stored in localStorage are not trusted (M4):** the DEX page used to live at `/zetaphy/` on the same origin as test-ui, which has a looser CSP.
If that site had an XSS hole, a script could write the DEX page's localStorage. The DEX page has now moved to its own `swap.sawasdeecoin.com`
(the browser separates storage, DOM and service workers by origin), but it still strictly checks every value it reads back (`web/lib/storage.js`),
because localStorage values can still be written by other means (browser extensions, old profiles, future bugs), and it does not trust those values for anything involving money:

- Stored slippage must be an integer of 1–500 bps (**max 5%**), otherwise 0.5% is used. If it is **above 1%**, the user must tick to confirm again every time before
  swap / add / remove liquidity (the confirmation is not stored)
- A stored RPC must be in exactly the form the web page saves itself (https or localhost). If it is not the default, a warning bar shows the whole time and it is not passed to the wallet
- The "Fee-on-transfer token" switch is not stored (it is off every time the page opens)
- Self-imported tokens: only entries for chain 77390 that pass the checks are read back, no duplicates, at most 50 entries. They show the label
  **"Self-imported, not on the list"** in the token picker and in the list, show a warning with the contract address when selected, and Neuro is queried again on confirm
- Wallet id, language and theme must match the defined formats

- View locally: `cd zetaphy-dex && python3 -m http.server -d web 8000` (or any static server with `web/` as root), then open
  `http://localhost:8000/` (this server does not send the `vercel.json` headers; `npm run test:web` tests under the real CSP)

## Risks

- **Not yet security audited.** Use on testnet only. The coins have no value. This is not investment advice
- The first liquidity provider sets the initial price. Small pools move price sharply (price impact) and can be front-run / sandwiched: set a tight slippage.
  For a pool with very little LP but a price off the market (someone made a tiny first deposit at an odd price), the web page calculates using that pool's price. Always check the price before adding liquidity
- The TWAP of a low-liquidity pool is easy to distort. Do not use it as a price oracle without extra safeguards
- Fee-on-transfer / rebase tokens / tokens whose owner can block transfers may make transactions fail or return less than shown
  (turn on the "Fee-on-transfer token" option in Settings)
- Neuro results are only as good as the data in ThreatRegistry: "no flag found" does not mean safe, and a flag is automated code analysis, not an accusation
- When the on-chain check is on, if the registry stops responding (or uses more than 100,000 gas), all buys/liquidity adds through the router are refused until
  governance fixes it or sets it to `0` (selling to the native coin and removing liquidity always work). This is a deliberate fail-closed design, not a defect
- Anyone can send native coins straight into a pool via bank send (balance above reserve): `skim` takes them out, `sync` updates the reserves to match
- No `permit` (EIP-2612) for LP: removing liquidity needs an approve first (the web page approves exactly the amount being removed)

## License

MIT (see `LICENSE`). Completely rewritten, with no code from Uniswap (GPL-3.0). Only the math formulas published in the whitepaper are used.

## DLMM (liquidity split into price bins) — ⚠️ not yet security audited (UNAUDITED)

> ⚠️ **This section is new, not yet audited, and for testnet only.** Test tokens have no value. This is not investment advice.

DLMM is a pool that splits liquidity into **price bins**. Each bin has a fixed price. Liquidity providers choose the price range where they place their tokens
(concentrated liquidity). It is a port of our own DLMM design on Solana (`programs/swd_amm/src/dlmm.rs`
and the volatility-based fee from `swdmm_math.rs`) to Solidity, **completely rewritten under MIT**
(checked: Trader Joe Liquidity Book `traderjoe-xyz/joe-v2` uses the MIT license, but **no one's code was copied**).
It is fully separate from the existing x·y = k AMM (the existing Factory / Pair / Router were not modified).

| File | Purpose |
|---|---|
| `contracts/dlmm/DlmmMath.sol` | 128.128 fixed-point math (price of each bin, 512-bit mulDiv) and a bitmap to find the next bin with liquidity |
| `contracts/dlmm/ZetaphyDlmmPair.sol` | DLMM pool (bins, swaps across bins, deposit/withdraw, fees, per-bin share accounting) and `ZetaphyDlmmPairDeployer` (holds the pool code) |
| `contracts/dlmm/ZetaphyDlmmFactory.sol` | Creates 1 pool per (token pair, bin step) and stores the values governance can set |
| `contracts/dlmm/ZetaphyDlmmRouter.sol` | Functions users call: add/remove liquidity over a range, swap (exact in / exact out, multi-hop), native coin, Neuro check |
| `contracts/test/DlmmTestHelpers.sol` | Contracts for tests only |
| `dlmm-cli.js` | Deploy DLMM (factory + router + default presets) and governance settings |
| `web/dlmm.js`, `web/lib/dlmm.js` | DLMM tab on the web page (choose pair/bin step, view bins around the price, add/remove liquidity over a range, swap) |
| `test/dlmm*.test.js`, `test/web.dlmm.e2e.js`, `test/devnet.dlmm.integration.js` | Tests (see below) |

**How it works**

- **Bin price:** bin number `id` has price `(1 + binStep/10000)^id` (unit: tokenY per tokenX in smallest units, ignoring decimals).
  `binStep` is in bps, for example 10 = 0.1% apart per bin. Computed in 128.128 fixed point. Prices range from 2⁻⁹⁶ to 2⁹⁶
  (bins outside this range cannot be used). tokenX is the token with the lower address
- The **active bin** is the current price: bins above the price hold only X (X is sold when the price rises to them), bins below hold only Y,
  and the active bin can hold both. Deposits must follow this rule
- A **swap** starts at the active bin and moves one bin with liquidity at a time (empty bins are skipped instantly using the bitmap). Within each bin the price does not move.
  At most 100 bins can be crossed per swap (if more are needed, split it into several swaps). If liquidity is not enough, the whole transaction reverts (no partial fill)
- **Rounding always favours the pool:** amounts the user pays and fees round up; amounts received and shares received round down
- **Shares are per bin** (internal ERC-1155-style accounting with no callback): the first deposit into an empty bin gets shares = `x·price + y·2¹²⁸`.
  Later deposits get shares proportionally, and a bin only accepts tokens in its existing X:Y ratio; the excess is returned to the depositor.
  Withdrawals get the bin's share in proportion to shares held. Deposit/withdraw/transfer at most 100 bins at a time
- **Fee** = base fee (per the bin step preset) + **volatility fee** (the more bins the price has just crossed,
  the higher it is; it decays over time and has a cap). The total is at most 10%. Fees stay in the bin where the trade happened (they belong to that bin's LPs),
  except the **protocol share** (default 0, max 50% of the fee), which anyone can trigger with `collectProtocolFees()` to send it to `feeTo`
- **Internal accounting:** the pool remembers its own balances. Tokens transferred in directly (donations) do not change bins or price. `skim(to)` takes out the excess
- **No flash swaps and no callbacks.** Every state-changing function has a reentrancy lock

**Router** (`ZetaphyDlmmRouter`): every function has a `deadline` and user slippage bounds:

- `addLiquidity(params)` / `addLiquidityNATIVE(params)`: specify bins **relative to the active bin** (`deltaIds`) with X and Y amounts for each bin
  (distribution shapes such as spot / curve / bid-ask are up to the web page), `activeIdDesired` + `idSlippage` (how many bins the price may move),
  `amountXMin` / `amountYMin` (minimum amounts actually used). Any part a bin does not accept is returned immediately (native coin returned as native coin).
  If the whole pool is still empty, the router sets the active bin to `activeIdDesired` before depositing in the same transaction (**the first depositor sets the price**)
- `removeLiquidity` / `removeLiquidityNATIVE`: you must first call `pair.setApprovalForAll(router, true)` (allows the router to burn your shares;
  revoke with `false`), along with `amountXMin` / `amountYMin`
- `swapExactTokensForTokens`, `swapTokensForExactTokens`, `swapExactNATIVEForTokens`, `swapNATIVEForExactTokens`,
  `swapExactTokensForNATIVE`, `swapTokensForExactNATIVE`: path `path = (binSteps[], tokens[])`, multi-hop is supported.
  Quotes: `getAmountsOut` / `getAmountsIn` (or `pair.getSwapOut` / `pair.getSwapIn`)
- The native coin (NATIVE) uses `WNATIVE` the same way as the existing router: on ZETAPHY it is the precompile `0xEeee…EEeE` (tested on a real devnet)
- **Fee-on-transfer tokens are not supported** (the router refuses with `FeeOnTransferNotSupported`) and **rebase tokens are not supported**
  (if the pool's balance drops on its own, the pool will not pay out more than it holds: `BalanceBelowReserves`)

**Neuro:** same rules as the existing router. When governance sets `dlmmFactory.setThreatRegistry(<ThreatRegistry>)`, the router refuses buys (swap in)
and liquidity adds for tokens whose flag is already "enforced" (`TokenEnforced(token, reason)`), and fails closed (`RegistryUnavailable`)
if the registry does not respond. Selling to the native coin and removing liquidity always work. Automated code analysis, not an accusation.

**Governance (stated plainly):** all admin functions are under **a single `governance` role**, so everything can be handed over to a TimelockController
(or a multisig) in two steps: `setGovernance(<timelock>)`, then have the timelock execute `acceptGovernance()`

- *Can:* enable/edit/disable presets (bin step + fee) for **new pools**, set `feeTo`, set the protocol share (≤ 50% of the fee)
  for new and existing pools, set/disable `threatRegistry` (which can stop buys through the router if the registry stops responding, same as the existing router),
  `router.sweep(to)` (native coins that strayed into the router)
- *Cannot:* move anyone's funds, stop a pool, change the fee or bin step of an existing pool, or upgrade the contracts (no proxy)

**Deploy and web page**

```bash
cd zetaphy-dex
# deploy factory + router (WNATIVE = precompile on ZETAPHY) + presets 1/10/25/100 bps
# then add contracts.dlmmFactory / dlmmRouter to the cli.js deployments file and (with --web) web/deployments.json
node dlmm-cli.js deploy --rpc <url> --key-file <file> [--web] [--governance <timelock>] [--fee-to <addr>]
node dlmm-cli.js status --rpc <url>
node dlmm-cli.js set-registry <ThreatRegistry|0x0> --rpc <url> --key-file <file>
```

Key file rules are the same as `cli.js` (file only, chmod 600, no keys on the command line), and deploy only works on chain 77390 unless you pass `--any-chain`.
Default presets: bin step 1 / 10 / 25 / 100 bps, base fee equal to the bin step, max volatility fee +50 / +100 / +150 / +300 bps.

The **DLMM** tab on the web page reads `contracts.dlmmFactory` / `contracts.dlmmRouter` from `web/deployments.json` (missing = shows that it is not deployed yet).
It uses the same wallet, RPC, Neuro check (refuses tokens with an enforced flag, warns and asks for a tick to confirm when there is a flag) and slippage/deadline values as the existing page.
It approves exactly the tokens that will be used, and only asks for `setApprovalForAll` when removing liquidity (with a button to revoke the permission).

**Tests**

```bash
cd zetaphy-dex
npm run build && npm test     # includes DLMM tests: dlmm.math / dlmm / dlmm.security / dlmm.neuro / dlmm.fuzz / dlmm.web-lib / dlmm.cli
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:web                          # includes the DLMM tab (web.dlmm.e2e.js)
ZDLMM_FUZZ_SEED=1,2,3,4 ZDLMM_FUZZ_STEPS=200 node --test test/dlmm.fuzz.test.js     # extra fuzzing (multiple seeds allowed)
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet:dlmm  # on a real devnet (port ZDLMM_DEVNET_PORT, default 24745)
```

Coverage: prices against exactly computed values, price range edges, 512-bit mulDiv, bitmap, swaps matching a BigInt model to every wei, minimal exact-out,
volatility fee, protocol fee, multi-hop, native coin, slippage/deadline, first deposit, reentrancy, donations,
fee-on-transfer/rebase tokens, edge bins, bin-crossing limit, Neuro, and fuzzing that checks invariants at every step
(sum of bins = reserve, pool holds all tokens, total shares = totalSupply, value per share of a bin never decreases).

**Gas (approximate)**

| Operation | In-memory EVM (execution gas, excluding 21,000 + calldata) | Real devnet (transaction gasUsed, via the native coin precompile) |
|---|---|---|
| swap within 1 bin | ~60,700 | 143,594 (ZTPHY → tUSD), 139,044 (tUSD → ZTPHY) |
| swap exact-out (1 bin, with change refund) | — | 160,986 |
| swap across 6 / 21 / 50 bins | ~106,800 / ~243,300 / ~508,900 | 179,551 (25 ZTPHY across several bins) |
| swap at max crossing (100 times) | ~1,000,700 | — |
| 2-hop swap | — | 198,427 |
| add liquidity in a new bin | ~77,000–80,000 per bin | 5,458,820 (21 bins including creating a new pool ~3.6M) |
| remove liquidity from 21 bins | — | 455,540 |

(The devnet column uses the default `dlmm-cli.js` presets, which include the volatility fee; the in-memory column uses a preset with no volatility fee.)

**Not done yet:** DLMM TWAP/oracle (do not use the active bin price as an oracle), automatic swap routing across multiple pools in the web page (the DLMM tab swaps within the selected pool; the router already supports multi-hop),
and not yet deployed on testnet.

**Risks (for users):** not yet audited; the first liquidity provider of a pool sets the initial price, so always check the active bin before depositing
(set a tight `idSlippage`); liquidity in a narrow price range turns entirely into the other token when the price moves through it (impermanent loss
can be higher than in an x·y = k pool); a large swap that needs to cross more than 100 bins must be split into several swaps; set a tight slippage because you can be front-run / sandwiched;
`setApprovalForAll(router)` lets the router burn your shares in every bin of that pool on your behalf (the router only uses it for the caller themselves); revoke it when you stop using it.
Security details are kept separately for the team.
