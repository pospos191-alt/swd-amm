**English** | [ภาษาไทย](README.th.md)

# Neuro ZETAPHY — Tier 1 (read and explain contracts)

The first job in the "ZETAPHY Chain plan": a contract reader that tells you, in plain language, what powers a token contract on
**Ethereum, BNB Chain, Base, Arbitrum, Solana, Sui, Aptos, TON, NEAR, Starknet, Osmosis, Neutron, and Runes tokens on Bitcoin** gives its owner (mint more tokens,
block wallets, pause transfers, change taxes, upgrade the code, etc.). It explains in 9 languages: English, Chinese, Spanish, Korean, Japanese,
Russian, Vietnamese, Thai, and Indonesian. Cost: $0.

- **Read-only**: it uses only `eth_getCode`, `eth_getStorageAt`, `eth_call` (EVM, including one `eth_call` with a
  state override for the buy/sell simulation, see below), `eth_gasPrice`, and
  `getGenesisHash`, `getAccountInfo` (Solana), query-only GraphQL (Sui), GET to
  `#[view]` functions (Aptos), and GET from tonapi.io (TON), through free public endpoints. It never asks to connect a wallet.
  There is no code that sends transactions (`src/rpc.js` rejects every other method and checks that the endpoint really is mainnet).
- **Fixed rules, no AI**: the result is the same every time. A `reportHash` lets other machines re-check it
  (per weakness no. 1 in the plan: work must be re-checkable).
- **Does not trust text from the contract**: token names/symbols are stripped of control characters and shown as text only.
  A name that contains a link gets a warning that the name contains a link. Every name is shown "as written in the contract", not as something Neuro confirms.
- **States code facts, does not judge people**: every message says what the code can do or what the simulation produced.
  It does not use words like "fraud" or "scam". Every report has a 9-language disclaimer, a report ID, a verdict ID,
  and the CLI command to re-check it, plus a link to how to respond / request a correction (`web/legal.html`, full policy in [`docs/LEGAL.md`](../docs/LEGAL.md))

## Usage

```bash
npm install
node cli.js bsc 0x...            # explain in Thai
node cli.js base 0x... --lang th  # Thai (default English; also zh es ko ja ru vi id)
node cli.js sui 0x...::coin::COIN # token on Sui
node cli.js aptos 0x...           # Fungible Asset on Aptos (or 0x...::module::Name)
node cli.js ton EQ...             # jetton on TON
node cli.js near token.near        # contract/token on NEAR
node cli.js starknet 0x...        # Cairo contract on Starknet
node cli.js bitcoin DOG•GO•TO•THE•MOON  # Rune token on Bitcoin (or ID 840000:3)
node cli.js osmosis osmo1...      # CosmWasm (Rust) contract or factory/osmo1.../name
node cli.js zetaphy-wasm zetaphy1... --rest https://<ZETAPHY node>/rest   # CosmWasm contract on ZETAPHY (you specify the node)
node cli.js arbitrum 0x... --json # full report
npm run web                       # open the web page at http://localhost:8080/
```

The web page (`web/`) is pure static files. The user's browser calls the public RPC itself.
Shareable link: `/web/?chain=bsc&address=0x...` · Stats page: `/web/stats.html`

## Host on the web for free (Vercel)

1. Go to vercel.com → **Add New → Project** → choose this repo
2. Set **Root Directory** to `zetaphy-neuro` (no build settings needed, `vercel.json` is already there) → **Deploy**
3. Turn on the user counter (optional, but needed to measure gate 1,000 users per month):
   - A store, one of:
     - **Cloudflare D1** (free: 100,000 rows written and 5 million read a day; used first when set).
       In the Cloudflare dashboard: **Storage & Databases → D1 → Create** (any name), copy its
       **Database ID**; copy your **Account ID** (account home page); **My Profile → API Tokens →
       Create Token → Custom token**, permission **Account · D1 · Edit**, your account only.
       In Vercel add `NEURO_D1_ACCOUNT_ID`, `NEURO_D1_DATABASE_ID` and `NEURO_D1_TOKEN` (Sensitive).
       The tables are created on the first request
     - **Upstash for Redis**: tab **Storage → Create → Upstash for Redis** (free plan), then Connect it
       to this project. The system sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you
   - **Settings → Environment Variables**: add `USAGE_SALT` as a random string of 16 or more characters
     (for example the output of `openssl rand -hex 32`). Never put it in the repo or paste it in chat
   - **Redeploy**, then open `/web/stats.html` to see this month's number against the 1,000 target

If you skip step 3, the web page still works normally. It just does not count users.

## User counter (`api/usage.js`, `server/usage.js`)

- It does not store IPs, browsers, or the contract addresses checked. Each user is turned into an HMAC value
  of (month, IP, browser) with a secret key, then added to a HyperLogLog, which stores only a count.
  When a new month starts, all values change, so users cannot be linked across months
- It does not count if the browser sets Do Not Track or Global Privacy Control
- It counts at most 200 checks per person per day. The numbers are estimates (~1% error),
  and someone who keeps changing IP can still inflate them. Use them as a signal, not as verified numbers
- Each check also sends its result level only (`high`, `medium`, `low` or `info`; never the contract). The checker page
  shows the all-time totals under the form: contracts checked, risky contracts flagged (high + medium) and high risk found.
  Totals add up the monthly counters since 2026-10; the result levels are counted from this release on

## Recognising tokens created by the ZETAPHY launcher

Neuro recognises "code templates" by a code fingerprint (`src/fingerprint.js`): it masks the values that differ
between tokens (addresses, immutable values) and hashes the rest. Every token from the same template
therefore gets the same value. To register one:

```bash
node cli.js fingerprint bsc 0x<one token created by ZETAPHY on BNB Chain>
```

The command prints a ready-to-paste entry. Put it in `src/templates.js`. Repeat for Base and Arbitrum.

You don't have to run the command: check that token on the web page and open "Details" to see the
**code fingerprint** (`fp1:...`). Send that value with the chain and token address to register it.
Once recognised, Neuro shows "matches a ZETAPHY token template" and shows the tax rule as "can only decrease"
(once `tax-decrease-only` is added after reading the tax-setting code). If the code has a power that the template says it does not have,
it warns at high level immediately instead of trusting the template data.

## Code similar to flagged code, and unknown patterns

Fixed rules only catch what they know by name. Code copied from flagged code with renamed functions, an added getter,
or slightly moved conditions gets a new fingerprint. So Neuro measures how **close** the code is to code in the dataset (`src/similarity.js`).
It is still fixed rules: integer hashes only, no AI, no randomness. Every machine gets the same number.

- Strip the data of every PUSH (addresses, constants, jump positions) and the compiler metadata, leaving only the opcode sequence
- Strip the parts that honest tokens share (baseline in `scripts/baseline-tokens.sol`: minimal ERC-20, ERC-20 + Ownable + mint,
  and OpenZeppelin v5 style: ERC20, + Pausable, + Permit, + Burnable, + Capped, Ownable2Step, AccessControl, and a plain blacklist,
  compiled with solc 0.8.26 with the optimizer both on and off). Otherwise, library code not in the baseline could push an honest token above 60% similarity
- Compare what is left: MinHash (128 values) of the set of 4 consecutive opcodes, and Jaccard of the remaining selectors.
  Score = max(opcode, (opcode + selector) / 2), so renaming functions does not escape it
- A score from 60% gives a low warning, 75% medium (exactly the same code = 100%). The remaining code must have at least 8 sets, otherwise it is not compared
- **Supporting information, not evidence:** the highest level is medium, except when the fingerprint exactly matches an entry with an on-chain flag reference, which is high
- **Wording depends on the source:** it shows "similar to code flagged by Neuro runners" (`similar-flagged`) only for entries that reference an on-chain flag
  (`flag: { key, reportHash }` is the key in ThreatRegistry and the reportHash of the flagging evidence). Entries without a reference
  show "similar to a reference sample in Neuro's dataset" (`similar-reference`) and say clearly that it is not flagged code
- Not detected does not mean safe. The fixed rules and the buy/sell simulation still run as normal
- It is part of the verdict that runners must agree on, because it depends only on the code and the dataset (`verdict` and `reportHash` are stable)
- Covers EVM bytecode only: other chains are read from on-chain settings, not code, and it is not yet done for Stylus WASM

The dataset lives in the code itself (`src/threat-signatures.js`), because ThreatRegistry stores only keys, not code.
Each entry is a fingerprint + a short signature (remaining selectors + MinHash) of about 1 KB + the source (`flag`)
- **The real dataset starts empty.** No contract has been flagged by runners yet, and test contracts are not flagged code
- Reference samples for the test suite (ScamToken, QuietHoneypot, NotLaunched, HiddenPowers, Killable, with the optimizer both on and off)
  are in `test/fixtures/reference-samples.generated.js`. They are used in tests only, are not in `src/`, and so are not in the skill.
  Regenerate both the baseline and the samples with `npm run threat-signatures`. Nothing is fetched from the internet
- To add a contract that is really flagged in ThreatRegistry: check `evidenceOf(key)` first, then
  `node cli.js signature bsc 0x... --reason cannot-sell-in-simulation --flag-key 0x<key> --report-hash 0x<reportHash>`, then paste the entry into `ADDED`
  (`--reason` takes a code-fact code from ThreatRegistry per `src/threat-reasons.js`. The report shows it as neutral wording, see `REASON` in `src/lang/*.js`.
  Without `--flag-key` / `--report-hash`, the entry is shown only as a "reference sample")
  The skill (skill id) is a hash of all of `src/`. A new dataset (or a new baseline) is therefore a new skill and must pass a governance vote before runners can use it

The signal **"Neuro doesn't recognise this pattern yet, be careful"** (low level): 2 or more functions with unknown names
that make up half or more of all functions (or no known functions at all), and the code can move value (CALL, CREATE, SELFDESTRUCT, etc.).
It does not mean the code has a problem, but Neuro will not say "no risk found" when it simply does not recognise the code.

## What is checked

**Solana** (`src/solana.js`) reads the token account (mint) directly: mint authority, freeze authority,
Token-2022 extensions (permanent delegate that can move tokens from any wallet, transfer fee, transfer hook,
new accounts frozen by default, paused transfers, closable mint), the token name from Metaplex and whether the name can be changed,
and the program's upgrade authority

**Sui** (`src/sui.js`) A token is a Move type `0xpackage::module::Name`. Power lives in objects:
who holds `TreasuryCap` (unlimited minting), regulated tokens with `DenyCap` (block wallets
and pause the whole system), who holds `UpgradeCap` (change the code), and the upgrade policy. These are found from the transaction that
published the package. It then reads the public/entry function names in the token's module (mint, blacklist, pause,
set_fee, burn_from, etc.)

**Aptos** (`src/aptos.js`) supports both legacy Coin and Fungible Asset: it reads the ABI of the creator's code
to find which structures hold `MintRef`/`MintCapability` (mint more), `TransferRef`/`FreezeCapability`
(freeze and move other people's tokens), `BurnRef`/`BurnCapability` (burn other people's tokens), `managed_coin`,
extra code on deposit/withdraw (dispatch hook), the package upgrade policy, and function names as for Sui

**TON** (`src/ton.js`) reads the jetton master through tonapi.io: whether more tokens can be minted, whether the admin is still present or has renounced,
tonapi warning labels / verified lists (shown as tonapi's labels, not Neuro's findings), and frozen contracts. It checks the address checksum before any network call
and rejects testnet addresses. It also checks the jetton wallet of the largest holder: if tonapi does not recognise it as
a standard wallet, it warns at high level, because custom wallet code can refuse transfers, so you can buy but may not be able to sell

Limits for Sui/Aptos: checks are based on function names and on-chain data. It does not yet read the body of every function.

**Contract languages** Neuro reads the code that actually runs on-chain, not the source, so it depends on what the language compiles to:

| Language | How it is read |
|---|---|
| Solidity, Yul, Vyper, Huff | EVM bytecode (source language does not matter) + verified source from Sourcify (`src/sourcify.js`) used to name unknown functions + a real buy-then-sell-back simulation through the chain's main DEX (`src/honeypot.js`) that catches "can buy, can't sell" tokens and hidden taxes whatever the functions are named |
| Rust/C++ on Arbitrum (Stylus) | Unpacks the WASM code (brotli) to read it, finds selectors of known functions (mint, pause, blacklist, etc.) and delegate_call/create2 calls, then applies the same rules as EVM (`src/stylus.js`). If it cannot unpack it, it says it cannot check yet |
| Rust on Solana (Anchor) | Reads the instruction list from the on-chain IDL (`src/anchor.js`), finds instructions that need an admin signature, and dangerous instructions |
| Rust on NEAR | Reads function names directly from the WASM code's exports (mint, pause, upgrade, etc.), whether the contract account still has a full-access key (can deploy new code), and NEP-141 token data (`src/near.js`) |
| Cairo (Starknet) | Reads the ABI the contract published on-chain: function names and whether they can change state (mint, pause, upgrade, etc.), the owner, Cairo 0 proxies, and token data (`src/starknet.js`) |
| Rust on CosmWasm (Osmosis, Neutron, ZETAPHY via `--rest`) | Admin who can change the code (migrate), code change history, CW20 minter, Token Factory admin, and before-send hook (`src/cosmwasm.js`) |
| Bitcoin (Runes) | No contract code. Reads the token rules from ord (ordinals.com, free, no key needed): whether minting is still open, the creator's premine, turbo (`src/bitcoin.js`) · BRC-20 is not supported yet, because Hiro's free API shut down in Mar 2026 and the rest need a key |
| Move (Sui, Aptos) | Function names and powers in the code |
| FunC/Tact (TON) | Jetton data decoded by tonapi |

For EIP-7702 wallets (plain wallets set to run another contract's code), it says which contract's code runs.
Runners in the Neuro network turn Sourcify off (`sourcify: false`) so the verdict depends on on-chain data only.

**EVM** (Ethereum, BNB Chain, Base, Arbitrum):

| Finding | Level |
|---|---|
| Token name (as written in the contract) contains a link/website name | High |
| Code can be upgraded (EIP-1967 / beacon / `upgradeTo`) | High |
| Mint more tokens, block wallets, pause transfers | High (low if the owner has renounced) |
| Change tax, trading on/off switch, per-transaction cap | Medium (low if renounced) |
| `SELFDESTRUCT` instruction | High |
| `DELEGATECALL` outside a proxy, role-based permission system | Medium |
| EIP-1167 clone, current owner, tax exemption for some wallets | Info |
| Matches a registered ZETAPHY template | Good (tax can only decrease = low) |
| Official contracts of USDT, USDC, WETH, etc. (`src/known-tokens.js`) | Good, and lowers the issuer's powers to "low", naming the issuer |
| Uses the same symbol as an official token, but is not the registered address | High |
| Matches a template but has a power the template says it does not have | High |
| Buy/sell simulation: can buy but cannot sell, or selling returns almost nothing | High |
| Buy/sell simulation: buy or sell tax above 50% | High (10% or more = medium) |
| Simulated buy then sell back works, tax below 10% both ways | Good (with a warning that this is the result at this block, and the owner may change it later) |
| No pool on the main DEX / RPC does not allow override / buy failed | Info (says the simulation was skipped, never says "safe") |

**Buy/sell simulation (buy-then-sell-back test, `src/honeypot.js`)** The same method as honeypot.is, but using only `eth_call`:
1. Find the Uniswap V2 style pool of the token paired with the chain's wrapped native token (`factory.getPair(token, WETH)`)
   on the main DEX: Uniswap V2 (Ethereum, Base, Arbitrum) and PancakeSwap V2 (BNB Chain). Configured at `dex` in `src/chains.js`
2. If there is a pool, call `eth_call` once with a state override (the third parameter) that places the helper contract
   `contracts/TradeSim.sol` at a throwaway address with a small amount of the native token (about 0.01 ETH / 0.05 BNB ±25%). The helper contract
   checks that the router points to the correct factory and WETH, buys through `swapExactETHForTokensSupportingFeeOnTransferTokens`,
   compares the amount received with `getAmountsOut` (= buy tax), then sells back 90–99.9% (random) through
   `swapExactTokensForETHSupportingFeeOnTransferTokens` and compares the money received with the price the router quotes (= sell tax).
   A sell that reverts is caught with try/catch and reported as a result, not an error
3. The state override exists only for that one call. Nothing is signed or sent, and on-chain state does not change.
   If the RPC does not support override or there is no pool, it says the simulation was skipped

**Tokens cannot recognise the test** This code is public, so a token could be written to "behave well only when it sees Neuro's test".
Now the values a token can see are chosen fresh every time (`simPlan` in `src/honeypot.js`). Network jobs use values from `jobSimSeed(job id, round lottery)`,
so every runner in the same round runs the same test, and anyone can re-run it: `node cli.js bsc 0x… --sim-seed 0x<seed>`
Security details are kept separately for the team.


The helper contract's bytecode is stored in `src/tradesim.generated.js` (compiled with solc 0.8.26 for Paris, no PUSH0,
so it runs on every chain). Edit `contracts/TradeSim.sol`, then run `npm run tradesim` (`test/honeypot.test.js` checks they match).
Official tokens in `src/known-tokens.js` are not simulated. Simulation results do not count in the Neuro network's verdict
(`src/verdict.js`), because they depend on each runner's block and RPC.
Limits: the simulation runs from a contract, not a plain wallet. A token that blocks buys from contracts shows "buy failed",
and a token that blocks selling only in the same block as the buy also shows "cannot sell" (the message states this limit). Pools of V3 type and other DEXes (such as Aerodrome on Base) are not supported yet

## Two tiers of rules: public (consensus) and early warning (private)

| | Public rules (`src/`) | Early warning (`server/earlywarning.js`) |
|---|---|---|
| Who runs it | Every network runner + the web page + CLI | The project's server only (`api/early-warning.js`) |
| Where the rules live | This repo (skill id = hash of `src/`) | Private repo `pospos191-alt/zetaphy-private` → `rules/pack.json` |
| Part of the on-chain verdict | Yes | **No**, advisory only |
| What users see | The full code facts | Category (reason), level, and an opaque reference ID `ew-…`; not the rule itself |

Why: a new rule published right away tells token makers what to change, but consensus rules must be the same public code for everyone.
So new rules are held in the private pack for about 30 days (or until that wave dies down) and then published: signature rules move into `ADDED`
in `src/threat-signatures.js`, which is a new skill and needs a `NeuroControl.approveSkill` vote. The policy and rule formats are in
`zetaphy-private/rules/README.md` (a workflow there opens an issue every week when rules are due).

- Rule types: `signature` (fingerprint + MinHash, same as `threat-signatures.js`, uses `closestFlagged`), `selectors`
  (a set of selectors / function names that appear together), `bytecode` (bytes that must be present, or an opcode sequence such as `ORIGIN * EQ`). Code behind a proxy is checked too
- The web page sends only `{chain, address}` to `POST /api/early-warning` after the check finishes (EVM only). If there is a result, an
  "Early warning" box appears, separate from the 9-language results. The risk level at the top does not change
- The server stores nothing: it caches answers per (chain, address) in memory for 5 minutes, counts rate with an HMAC of the IP, and does not log the rule pack or token

**Setup on Vercel** (Settings → Environment Variables, then Redeploy). Choose one:
- `NEURO_RULES_TOKEN` = a GitHub fine-grained token that can access only `zetaphy-private`, with **Contents: Read-only** permission
  (optional: `NEURO_RULES_REPO` defaults to `pospos191-alt/zetaphy-private`, `NEURO_RULES_PATH` defaults to `rules/pack.json`).
  The server re-reads it every ~10 minutes, so editing rules does not need a new deploy. If it cannot fetch, it keeps using the last pack it fetched
- Or `NEURO_PRIVATE_RULES` = the rule pack itself as JSON (or base64 of JSON). You must Redeploy every time you edit it
- Not set at all: it returns `{ "warnings": [], "configured": false }` and the web page works as before
- Rate limits (12 per minute, 300 per day per IP) use the user counter's store (D1 or Redis) if it and `USAGE_SALT` are set
  (shared across all instances). Otherwise they are counted in each instance's memory
- Try it locally: `NEURO_PRIVATE_RULES="$(cat ../../zetaphy-private/rules/pack.json)" npm run web`

**Limits (stated plainly)**
- Early warning is advisory and can be wrong. It is not part of the on-chain verdict, and nobody can re-check it until the rules are published
  (unlike the public rules). So the wording only says "matches a watched pattern" plus a neutral category, and does not judge the token
- For this tier, users must trust the project's server, and the server sees the contract address being checked (it does not store it)

Limits of the function-name rules: checks are based on known function names (`src/signatures.js`) in the on-chain code.
Not detected does not mean safe.
Add new names in `src/signatures.js`, then run `npm run selectors`

## Tests

```bash
npm test          # compile real sample contracts (test/helpers/contracts.sol) and run them on a local EVM
                  # with the optimizer both on and off + fingerprints/templates + user counter
                  # + buy/sell simulation with a mock DEX (Uniswap V2) at the real PancakeSwap addresses
                  # + code similar to flagged code (lightly edited copies must be warned, ordinary tokens must not)
                  # + a token that allows selling only when it sees the test (SimAware) + early warning tier (test/earlywarning.test.js)
npm run test:web  # open the web page in Chromium, answering RPC from a test chain, no internet
```

## Status

- [x] Contract reader and explainer (CLI + web page) in 9 languages (`src/lang/`, `test/i18n.test.js` checks every language has every message)
- [x] Ready to host on Vercel for free (`vercel.json`)
- [x] Monthly user counter that stores no personal data + stats page against the 1,000 target
- [x] ZETAPHY token template recognition (waiting for one sample token address per chain to register)
- [x] Tried on real mainnet contracts (USDT on BNB Chain, 19 Oct 2026)
- [x] Recognises major official tokens, and warns about tokens using the same symbol at a different address
- [x] Supports Ethereum and Solana
- [x] Supports Sui, Aptos (Move language), and TON (tested with data in each chain's real format; not yet tried against mainnet from this machine)
- [ ] Native speakers to review the Chinese, Spanish, Korean, Japanese, Russian, Vietnamese, and Indonesian translations
- [x] Rust: Solana (Anchor IDL), Arbitrum Stylus, CosmWasm (Osmosis, Neutron) · Solidity/Vyper source from Sourcify
- [x] NEAR (Rust/WASM) · TON checks holders' jetton wallet code
- [x] Starknet (Cairo) · Bitcoin Runes
- [ ] BRC-20 (need a free API that does not require a key)
- [x] Read the body of Stylus WASM
- [x] Buy/sell simulation (buy-then-sell-back test) on EVM through Uniswap V2 / PancakeSwap V2, tested on a local EVM.
      Waiting for the live mainnet check (DEX addresses and RPCs that support state override) from CI
- [ ] Buy/sell simulation through V3 pools and other DEXes (Aerodrome on Base, Camelot on Arbitrum)
- [x] The simulation has no fixed values a token could recognise (random addresses / from network jobs, real gas price, non-round amounts)
- [ ] Simulate from a plain wallet over multiple transactions (`eth_simulateV1`) to close the "only contracts can sell" gap
- [x] Early warning tier (private rules during the hold period) + workflow to publish rules that are due
- [x] Warn about code similar to flagged code (EVM) + the "doesn't recognise this pattern yet" signal
- [x] Baseline from common OpenZeppelin patterns (solc 0.8.26, optimizer on/off), and the real dataset starts empty
- [ ] Add contracts really flagged on mainnet to the dataset (with the flag's key and reportHash), and extend the baseline with real OpenZeppelin tokens compiled with several solc versions
      (right now the baseline and seed entries come from solc 0.8.26 only, so copies compiled with other versions may slip through)
- [x] Neutral wording (code facts, not judging people) + 9-language disclaimer + re-check evidence in every report (`docs/LEGAL.md`)
- [ ] On-chain response/appeal channel in ThreatRegistry
- [ ] AI explanation tier (optional): send only the check results, give it no permission to call tools (weakness no. 12)

---

# Neuro ZETAPHY tier 1 (English summary)

Read-only contract reader and explainer for Ethereum, BNB Chain, Base,
Arbitrum, Solana (incl. Anchor IDLs), Sui, Aptos, TON, NEAR, Starknet, Osmosis, Neutron and Bitcoin Runes
(CosmWasm), with Sourcify verified-source lookups and Stylus / EIP-7702
detection. Fixed rules over on-chain code and data
(no AI, no wallet, no transactions), output in English, Chinese, Spanish,
Korean, Japanese, Russian, Vietnamese, Thai and Indonesian, a reproducible `reportHash`, a CLI and a static web page.
Also: a privacy-preserving monthly user counter (`api/usage.js`, Vercel +
Upstash Redis) with a stats page, and code-fingerprint templates to recognise
ZETAPHY launcher tokens (`node cli.js fingerprint <chain> <address>`).
EVM tokens also get a buy/sell test (`src/honeypot.js`): one `eth_call` with a
state override runs `contracts/TradeSim.sol`, which buys through the chain's main
Uniswap-V2-style DEX and sells straight back, so a token you can buy but not
sell, or that takes a hidden tax, is caught whatever its functions are named.
Nothing in that test is fixed for a token to recognise: the helper's and the
caller's addresses are random per check (or derived from a NeuroJobs job and
its lottery, `jobSimSeed`, so all runners of a round run the same test;
`--sim-seed` re-runs it), as are its code hash, the amounts, the share sold
and the gas limit, and the call carries a real gas price (a call without one
runs at `tx.gasprice` 0 and, on geth, `block.basefee` 0). One limit remains:
in a single `eth_call` the buyer is a contract, not `tx.origin`.
Two rule tiers: the public consensus rules in `src/` (the skill id), and an
advisory **early-warning** tier (`server/earlywarning.js`,
`POST /api/early-warning`) that runs a private, embargoed rule pack
(`zetaphy-private/rules/pack.json`, loaded from `NEURO_PRIVATE_RULES` or with a
read-only `NEURO_RULES_TOKEN`) and returns only `{reason, severity, ref}` per
match. Rules go public after about 30 days. The endpoint can be probed as an
oracle (rate limits only slow that down), and its warnings are not part of
on-chain verdicts.
EVM code is also compared with an in-repo similarity dataset
(`src/similarity.js`, `src/threat-signatures.js`, shipped empty; test reference
samples live in `test/fixtures/`): opcode 4-gram MinHash plus selector Jaccard
after removing honest library code (minimal and OpenZeppelin-style ERC-20,
Pausable, Permit, Burnable, Capped, Ownable2Step, AccessControl, blacklist),
warning from 60% similarity, informational (at most medium unless the exact
code of an on-chain flag), and worded "flagged by runners" only for entries that
cite their ThreatRegistry flag key and reportHash (otherwise "similar to a
reference sample");
and code that is mostly unnamed functions and can move value gets a low
"Neuro doesn't recognise this pattern yet" warning instead of "nothing found".
Wording states verifiable code facts ("the owner can mint new tokens", "in a
simulated buy/sell, the token could be bought but not sold"), never verdicts about
people or projects. Every report (web and CLI) shows a 9-language disclaimer, the
report ID, the rules-only verdict ID and the CLI command that reproduces it, and
links to the correction / right-of-reply process (`web/legal.html`,
[`docs/LEGAL.md`](../docs/LEGAL.md)).
Run `npm test` and `npm run test:web`.
