**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Explorer (explorer.sawasdeecoin.com)

Block explorer for the ZETAPHY chain (Cosmos SDK v0.54 + Cosmos EVM v0.7.3, chain id `zetaphy_77390-1`, EVM chain id 77390)
It is a **fully static site**: no server, no database, no indexer. The user's browser reads data directly from the node's public RPC/REST,
so it can be hosted on Vercel for free

## What it has

| Page | Shows |
|---|---|
| Home `#/` | chain id, block height, total supply (decreases when fees are burned and when coins sent to `0x…dEaD` are burned, with the amount burned in ~1 hr), staked amount and ratio, number of validators and % of voting power with a PQ vote key, latest blocks, latest transactions (new rows fade in as blocks arrive), **live indicator**, **watched addresses** with their recent activity, **analytics** (inline SVG charts) |
| Block `#/block/<number>` | header, block proposer (validator name), transactions with status, this block's **quantum-resistant ML-DSA-44 certificate** (in tx[0] of the next block): signers, signed power versus required, and **real signature verification in the browser** with `zetaphy-network/src/pqcert.js` |
| Transaction `#/tx/<hash>` | EVM: **summary in plain words with risk flags**, from/to/value/gas/fee/status, **decoded input, logs and revert reason**, **internal calls**, **balance changes**, gas and the burned half of the fee (see below), decodes ERC-20 / ERC-721 / ERC-1155 transfers (Transfer, TransferSingle, TransferBatch) · Cosmos: decodes every message, including ZETAPHY messages (`MsgEVMCall`, `MsgQuantumLock`, `MsgPQVoteKey`, `MsgPQCertificate`, `MsgSetPQEvidence`), signer key type (ML-DSA-44), memo, fee, events |
| Address `#/address/<0x… or zetaphy1…>` | both formats (same 20 bytes), balance, nonce / sequence, whether it is a contract, ML-DSA-44 account, **quantum lock** (the `quantumLockedTo` field of `zetaphy_pqAccount`), other coins, staked amount, token balances, status in **ThreatRegistry**, **full history** (all heights, from the node's tx index) with in/out and kind filters, load more and CSV export, a **token transfers** tab, **watch / nickname**; a contract gets the **contract card** (source / Read / Write / proxy, see below) |
| Live `#/live` | new blocks as they are made (websocket, or polling), **pending transactions** (`num_unconfirmed_txs`, and `unconfirmed_txs` where the node shares it), **watch a transaction** until it is confirmed |
| Token `#/token/<0x…>` | ERC-20 / ERC-721 / ERC-1155: name, symbol, decimals, supply, Neuro report link (URL is configurable), ThreatRegistry, latest transfers, the contract card |
| Validator `#/validators` | voting power, status, commission, **whether a PQ vote key is registered** (reads the `zetaphypq` store with `abci_query`), uptime, Nakamoto coefficient, sort/filter; each validator's own page: see "More pages" below |
| Governance, holders, NFT, gas, tools | `#/gov`, `#/token/<0x…>/holders`, `#/nft/<0x…>`, `#/gas`, `#/tools`: see "More pages" below |
| Settings `#/settings` | node URL (stored in this browser), ThreatRegistry, Neuro report URL, number of blocks to scan |

The search box accepts: block number, transaction hash (EVM `0x…` or Cosmos hex), block hash, address `0x…` / `zetaphy1…`, `zetaphyvaloper1…`

Thai/English (EN/Thai button), light/dark theme, works on mobile (tables become cards)

### No indexer (and how history still reaches every block)

**Address history uses the node's own transaction index**, which covers all heights. The address page asks CometBFT `tx_search`
with event queries, newest first (`order_by "desc"`, `per_page 100`), and merges the pages:

| Query | Finds |
|---|---|
| `message.sender='<zetaphy1…>'` | Cosmos messages the address signed |
| `message.sender='<0x… EIP-55>'` | EVM txs it sent (Cosmos EVM puts the 0x sender in the `message` event) |
| `transfer.sender='<zetaphy1…>'` | coins it sent (fees included) |
| `transfer.recipient='<zetaphy1…>'` | coins it received |
| `ethereum_tx.recipient='<0x… EIP-55>'` | EVM txs sent to it |

- Only a validated address goes into a query (canonical bech32 with a good checksum, or EIP-55 0x): nothing typed can change the query
- A tx is shown only once no query can still hold a newer one, so the merged list has no gaps; a tx found by several queries is shown once.
  The page says "N transactions total" (exact once everything is loaded; before that the range from the largest single query to the sum of all)
- Filters (in / out; transfer, staking, EVM, IBC, governance) and **CSV export** work on what is loaded. The CSV is made in the browser and saved with a Blob
  (no server). Cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading `'`, so a spreadsheet never runs them as formulas
- **If the node refuses event queries** (tx index off, or `index-events` limited in `app.toml`), the page falls back to the scan below and says so
  ("Recent blocks only · scan" and the node's error)
- **Token transfers tab:** `eth_getLogs` with the address in topic 1 or topic 2 (ERC-20 / ERC-721 `Transfer`) plus ERC-1155 `TransferSingle` / `TransferBatch`,
  read backwards in **500-block windows** (the public node's limit); "Scan older blocks" goes further back; CSV export too

**Live:** new blocks come from a websocket when one is allowed: first CometBFT `wss://<node>/rpc/websocket` (`subscribe tm.event='NewBlock'`, the block's txs come with it),
then EVM `wss://<node>/ws` (`eth_subscribe newHeads`), else polling `status` every 6 s while the tab is visible. The page shows which ("Live · …").
The public node's rpc-guard closes the CometBFT websocket and `unconfirmed_txs`, so there the explorer uses the EVM socket and shows the pending count only
(`num_unconfirmed_txs`). A socket is only opened to `config.json`'s node, whose `wss://` origin is in the CSP; a node set on the Settings page uses polling.

**Watch list and labels:** watched addresses with a nickname and watched transactions are kept in this browser's localStorage only (every access in try/catch;
stored values are re-validated on read). The home page lists the watched addresses with their activity in the scanned blocks; an in-page notice appears when
a watched address is in a new block, or a watched transaction lands. Nicknames replace the short address in links (this browser only).

**Analytics** (home page) over the last `min(scanBlocks, 100)` blocks: transactions per block, block time, gas used % and base fee per block (one `eth_feeHistory` call),
most active addresses. Inline SVG with classes only (no inline styles, CSP-safe); each chart has a screen-reader title and a data table.

The latest transactions and token balances still come from **scanning the latest N blocks in the browser** (default 100 blocks ≈ 8 minutes at ~5 seconds per block, configurable 1–1000)
The page always states the scanned range. Older transactions can be opened by hash or block number, but they will not appear in an address's "Latest transactions" list

- Transactions are read in ranges of 50 blocks (CometBFT `tx_search` by height range). Completed ranges are cached, so only the top range is queried again
  If the node has tx indexing turned off, it reads block by block instead (limited to at most 40 blocks per round)
- An address's token balances are found from Transfer events in the same range (`eth_getLogs`), then `balanceOf` is read live
  (`MsgEVMCall` logs are not in `eth_getLogs`, per the zetaphy-chain README, so this may be incomplete)
- All requests go through one queue: at most 4 concurrent requests, at most 8 requests/second, in-memory cache (confirmed blocks and transactions are kept long; "latest" data expires in 4 seconds), duplicate pending requests share the same response
- The home page refreshes on each new block from the live feed (websocket or polling), only while the tab is open

### Activity this month

The home page shows this month's transactions by kind (transfers, staking, cross-chain, EVM and contracts, governance)
and the total since genesis, from Neuro's daily counts (`chainStatsUrl`, default
`https://neuro.sawasdeecoin.com/api/chain-stats`; empty turns it off). Read once per visit, not from the node.

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

### EVM transaction page (deep view) and contract card

| Section | What it shows | Where it comes from |
|---|---|---|
| Summary | one line in plain words: "0xab… swapped 10 ZETAPHY for 1,234 SWD on ZetaphyRouter", "sent 1.5 SWD to …", "transferred 5 NFT", "approved … to spend an UNLIMITED amount of …", contract creation, failure | decoded input + token Transfer logs + native moves (prestate diff, else call trace, else the tx value) |
| Risk flags ⚠ | unlimited `approve` / `increaseAllowance` (≥ 2^96−1, the same rule as `wallet-safety.js`), `setApprovalForAll(true)`, the same approvals seen in the sender's `Approval` / `ApprovalForAll` logs (multicalls, permits), the callee or an approved spender flagged in **ThreatRegistry** (neutral wording + the disclaimer) | `txdeep.js`, `threat.js` |
| Input data (decoded) | function name and named, typed arguments (lists and structs nested, addresses linked), marked **Verified** / **Known** / **Guessed** (and "via the proxy's implementation") | 1. verified ABI on **Sourcify** (v2 API, chain 77390, full or partial match) · 2. this repo's own contracts (`src/known-abi.js`, written by `npm run build` from the artifacts of zetaphy-network, zetaphy-dex and zetaphy-nft: signatures only, plus each contract's code hash and Neuro fp1 fingerprint and the addresses in the deployment records) · 3. a small common table (`src/sigs.js`: ERC-20/721/1155, permit / Permit2, wrapped native, Uniswap-v2 style router and pair, multicall, Ownable / AccessControl, proxies). A guess must decode strictly and re-encode to exactly the same bytes |
| Logs | every log decoded the same way (topic0 → event, indexed values from topics; an indexed string/bytes/struct shows its hash), token transfers as before, raw topics/data behind a toggle | same as above |
| Why it failed | `Error(string)`, `Panic(uint256)` with its meaning (overflow, division by zero, out-of-bounds index, …), custom errors by selector (callee's ABI first, then the tables), or "reverted without a reason" | callTracer `output`; without traces the call is re-run on the state before its block, and the page says so |
| Gas and fee | gas used / limit with %, effective gas price, base fee of the block, max fee / priority, fee paid in ZETAPHY, base-fee part + tip, **burned (50%)** and **to validators (50%)** | receipt + `eth_getBlockByNumber`; the 50/50 split is the chain rule in `evmd/zetaphy_feeburn.go` |
| Internal calls | call tree (CALL / DELEGATECALL / STATICCALL / CREATE…), from → to, value, gas used, decoded function, errors; calls under a failed call marked undone; internal ZETAPHY transfers listed | `debug_traceTransaction` with `callTracer`. If the node has no traces: "This node does not expose traces" (nothing is faked) |
| Balance changes | who gained / who lost: native balance before / after per address, token deltas per holder (ERC-20, ERC-721 ids, ERC-1155 ids) | `prestateTracer` with `diffMode`, else the call trace, else the tx value; tokens from Transfer logs |

Contract card (address page of a contract, and the token page):

| Tab / row | What it shows |
|---|---|
| Status | **Verified · full / partial match** on Sourcify, or **Known** (one of this repo's contracts, matched by deployment address, exact code hash or fp1 fingerprint), or a guess by selectors, or **Not verified**; "Sourcify could not be reached" is said apart from "not verified" |
| Creator | deployer, creation tx and block when Sourcify has them (no indexer otherwise, so it is left out) |
| Proxy | EIP-1967 implementation / admin / beacon slots (beacon → `implementation()`), EIP-1167 minimal proxy (and its PUSH0 form): implementation linked, its ABI used for decoding and for Read / Write |
| Code | source files (shown as text only), compiler, language, link to Sourcify; otherwise the runtime bytecode and how to verify |
| Read | every `view` / `pure` function, one form per function, `eth_call` through the node queue, outputs decoded; zero-argument views are read when the tab opens; reverts decoded |
| Write | every `nonpayable` / `payable` function through the visitor's own injected wallet (`window.ethereum`): chain id 77390 checked (switch asked), a dry-run `eth_call` first (a revert is explained before the wallet opens), the chain asked again right before signing, then the **wallet-safety confirmation** (`sf.confirmTx`, the same as the DEX / NFT / hub), then `eth_sendTransaction`. The site never holds keys |

Sourcify is read straight from the browser (`https://sourcify.dev/server`); `connect-src 'self' https:` already allows it.
If you lock `connect-src` to your node, add `https://sourcify.dev` too (or the contract card says Sourcify could not be reached).

### Security

- No `innerHTML` (or other sinks) with any data: DOM is built with `textContent` through `src/dom.js` (links only to `#/…` or `https:`)
- Text from the chain (token names/symbols, moniker, memo, events, statements) has control characters, direction-override characters (bidi, for example U+202E) and zero-width characters stripped, and length limited (`safeText` in `src/format.js`)
- CSP in `vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://ipfs.io; connect-src 'self' https: https://ipfs.io wss://rpc.sawasdeecoin.com; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and other headers (HSTS, nosniff, no-referrer, X-Frame-Options)
- No external scripts or fonts. All libraries are in `vendor/zetaphy-lib.js`, built from this repo
- Requests to the node send no cookies (`credentials: 'omit'`) and only accept `https://` URLs (except `http://localhost` for local testing)

**Why `connect-src` is `https:`:** users can change the node on the settings page, so the CSP must allow any https host.
If you want to lock it to our node only, edit `vercel.json` to, for example, `connect-src 'self' https://1-2-3-4.sslip.io`
(as a result, nodes users set themselves will be blocked by the browser)

## Insight features (what an ordinary explorer does not show)

All of them run in the browser (no indexer, no server, no AI service) on the same bounded scan as the rest of the explorer — the fund flow reads further, address by address, on demand — and every page says which blocks it read.

### Fund flow `#/flow/<address>`

Where native ZETAPHY and tokens went, followed **through every hop** until the money stops, drawn as an inline SVG graph (`src/flow.js`, no library)
- **Follow the money** expands the graph breadth first (hop by hop, the largest outflows first within a hop) with no hop limit, until no further outgoing transfer is in the data read, every branch reaches a sink (a contract, the zero / burn address, a module account, a bridge or a known exchange label) or you press **Stop**; pressing Follow again goes on from there. `#/flow/<address>?follow=1` starts it at once
- **Click any node** (or Enter) to expand it again, as often as you like: its next receivers and senders, then its older blocks
- Data, per address (the page states each address's exact range in the "Addresses in the graph" table): token Transfer logs in **500-block `eth_getLogs` windows** from the newest block backwards (**Read older blocks** reads the next window), native transfers from the scanned blocks (`recentTxs`, default 100) and from the node's **transaction index by address** (`tx_search` with the validated queries of `src/history.js`: `message.sender`, `transfer.sender`, `transfer.recipient`, `ethereum_tx.recipient`; paginated; if the node refuses event queries, the page says "scanned blocks only"). Hops reach only as far as the data read
- No silent cuts: per step at most 50 neighbours of an address are added (largest first); the rest is counted next to it with **load next 50**. Each transfer is counted once (deduplicated by tx / log), so an edge's amount is the same whichever side read it
- Cycles (money coming back to an address it passed) are found (strongly connected parts) and drawn in orange; an address is never followed twice, so a cycle cannot loop
- Readable at any size: the graph is redrawn as it grows (the browser stays responsive), a hop with many addresses shows its 12 largest and a **"+N more"** node (each click shows 50 more), every hop can be collapsed; **pan and zoom** with the mouse (drag, Ctrl + wheel) or the keyboard (focus the graph: arrows, + / −, 0 to fit); only the `viewBox` attribute changes (no inline styles, CSP)
- **Path view**: pick an address to see the shortest route of the money from the start to it (larger transfers first), highlighted in the graph and listed step by step
- Deterministic layered layout: inflows on the left, outflows on the right, one column per hop, one barycentre pass, ties by address. Edges are labelled with the amounts (one curve per pair; all assets in its tooltip), nodes with their known label and coloured by their ThreatRegistry flag. Paged tables list the addresses (with their data range and actions) and every transfer (screen readers, phones)

### Quantum exposure (address page section, `#/quantum`, `#/quantum/<address>`)

In plain words (`src/quantum.js`): is the address's **secp256k1 public key already on chain** (it sent an EVM tx — the signature reveals the key — or a Cosmos tx stored it), is it an **ML-DSA-44** account, does it have a **quantum lock** (`zetaphy_pqAccount` `quantumLockedTo`), and what to do (move to an ML-DSA-44 account or set a lock; link to the hub wallet, `hubWalletUrl` in the config, default `https://app.sawasdeecoin.com/?tab=wallet`)
Levels: post-quantum account · quantum-locked · public key exposed · key not exposed yet · contract (no key) · unknown (the node did not answer)
The dashboard `#/quantum` shows the validators with an ML-DSA-44 vote key (count and share of the voting power) and the senders of the scanned blocks by class (PQ / locked, exposed, not on chain), with the block range

### Address labels

`npm run build` writes `labels.json` (`scripts/known.js`) from this repository's records: `zetaphy-launch/state/77390.json` step outputs, `zetaphy-dex/web/deployments.json`, `zetaphy-nft/web/deployments.json`, `zetaphy-network/deployments/77390.json` (if present), `zetaphy-chain/rewards/*-testnet.json`, the Hyperlane files in `zetaphy-chain/hyperlane/` (chain table, bridge, routes, oracle, registry `addresses.yaml`), the module accounts (`sha256(name)[:20]`: fee collector, distribution, bonded pools, gov, mint, IBC transfer, evm, erc20, …), the precompiles (`0x…0800`–`0x…0806`, `0x…0900`–`0x…0902`, the quantum lock `0x…5051`, WNATIVE) and `0x…dEaD`
The first record to name an address wins (deterministic). The app loads it once; the one address-link helper shows the label next to **every** address, and the address page shows it at the top. The unit test fails when the committed `labels.json` is stale

### Cross-chain trace (tx page)

`src/crosschain.js`: for a tx that dispatched a Hyperlane (Saphan) message through ZETAPHY's Mailbox (`Dispatch` + `DispatchId`, only from the Mailbox address — anyone can emit look-alike events), the page shows the **message id** (`keccak256(message)`), the route and the destination chain, and asks the destination chain's public RPC whether it was delivered (`Mailbox.delivered(id)`), then when (`ProcessId` in its last ~9,000 blocks) with a link to that chain's explorer. Incoming messages (`Process` + `ProcessId`) show the origin chain and, best effort, the origin tx
The chain table is `crosschain.json`, built from `zetaphy-chain/hyperlane/saphan-chains.json` (https RPC URLs listed there only; several are tried in turn). IBC: packets sent / received / acknowledged / timed out from the Cosmos events, with ports, channels and sequence
CSP: `connect-src 'self' https:` already allows those RPCs. If you lock `connect-src` to your own node, `npm run build` appends the chain table's RPC origins to it in `vercel.json`

### Ask the explorer (search box)

The search box also understands short questions, in English and Thai, offline and rule based (`src/ask.js`); anything else is a normal search:

| Question | Goes to |
|---|---|
| `largest transfers today` · `โอนใหญ่ที่สุดวันนี้` | `#/ask/largest?s=86400`: largest ZETAPHY transfers and largest token transfers |
| `biggest ZETAPHY holders seen` · `ผู้ถือ ZETAPHY มากที่สุด` | `#/ask/holders`: live balances of the addresses seen in the scanned blocks (not a full rich list) |
| `txs of 0x… last hour` · `ธุรกรรมของ 0x… 30 นาที` | `#/ask/txs?address=…&s=3600` |
| `failed txs last 200 blocks` · `ธุรกรรมที่ไม่สำเร็จ` | `#/ask/failed?b=200` |
| `is 0x… safe?` · `ที่อยู่นี้ปลอดภัยไหม 0x…` | `#/ask/risk?address=…`: Neuro risk summary and quantum exposure |
| `quantum 0x…` · `flow of 0x…` · `เงินไหลไปไหน 0x…` | `#/quantum/0x…` · `#/flow/0x…` |

Time windows become blocks with the measured block time (last ≤100 blocks) and are capped at `maxScanBlocks` (1,000); the page says "Understood as: …" and which blocks it read

### Neuro risk everywhere

Every address and token the pages render gets a **"Flagged by Neuro · <category>"** badge when the ThreatRegistry flags it (address flag; for contracts also the code and fingerprint flags) — nothing when clean or unreadable (`src/risk.js`)
Lookups are **batched**: everything a page renders within ~30 ms goes out as one JSON-RPC batch (`evmBatch` in `src/rpc.js`, through the same queue and cache), a second one for contracts; results are cached for the visit; a node without batches is asked one call at a time
Address and token pages have a **risk summary** box: the address's own flag (with the disclaimer when flagged), how many recent counterparties are flagged, and the Neuro report link (`neuroReportUrl`). The full ThreatRegistry card (evidence, the owner's response, proxies) stays below

## More pages: validators, governance, holders, NFTs, gas, tools, installable app

All read the node directly (no indexer, bounded, through the same polite queue). Code: `src/validators2.js`, `src/gov.js`,
`src/holders.js`, `src/nft.js`, `src/gas.js`, `src/tools.js`, `src/pwa.js` + `sw.js`; app.js only routes to them (loaded when first opened).

| Page | Shows |
|---|---|
| Validators `#/validators` | sort (name, power, commission, uptime, PQ key) and filter (text, active / inactive / jailed), **uptime column** from the commit signatures of the last 50 blocks, **Nakamoto coefficient** (fewest validators with ≥ 1/3 of the power; also counting only PQ-keyed power) |
| Validator `#/validator/<zetaphyvaloper1…>` | uptime over the last N blocks (`last_commit` signatures of each block, N = 50/100/200), **missed-blocks heat strip** (inline SVG, one cell per block), slashing record (x/slashing `signing_infos` + params: missed in window, jailed until, tombstoned), slash/jail events (`block_search` over finalize-block `slash` events; needs the node's indexer, otherwise it says so), self-bond, delegators (REST `count_total`, count only), commission (rate, max, max change, last change) and past changes (`tx_search` of the operator's `MsgEditValidator`, rate from the `edit_validator` event), PQ vote key (registered, since, rotated) and **how many block certificates in the window carry its ML-DSA-44 signature** (tx 0 of the next block, read with the explorer's certificate decoder; the signatures are verified on each block page) |
| Governance `#/gov`, `#/gov/<id>` | x/gov v1 proposals, status, **messages decoded with the explorer's own decoder** (the proposal's protobuf via `abci_query /cosmos.gov.v1.Query/Proposal`; the REST JSON as plain text when refused), tally with % bars against **quorum / threshold / veto from the gov params** (live `tally` during voting, "if it ended now"), voting/deposit countdown, votes (paginated, weighted options), deposits and minimum, link to the hub's governance assistant (`hubGovUrl`, default `https://app.sawasdeecoin.com/?tab=gov`) for simulation |
| Holders `#/token/<0x…>/holders` | ERC-20 only: Transfer logs of the chosen recent window (1,000 / 5,000 / 20,000 blocks) in **500-block `eth_getLogs` ranges, at most 40**, net change per address, then the biggest gainers + `owner()` + the first mint's receiver are **confirmed with `balanceOf`**; top 25, % of supply, top-10 concentration, distribution bar, a warning when the owner / first-mint receiver holds ≥ 50 % or is the largest holder. The page always says "from block X to Y" |
| NFT `#/nft/<collection>`, `#/nft/<collection>/<id>` | ERC-721 `tokenURI` / ERC-1155 `uri` (`{id}` filled), metadata from `data:`, `ipfs://` (through `ipfsGateway`, default `https://ipfs.io`, settable on the Settings page) or https (`http://` upgraded; anything else refused); ids from `tokenByIndex` or recent Transfer logs; owner (`ownerOf`), transfers of the id |
| Gas `#/gas` | base fee of the next block, slow / normal / fast = median of the 10th / 50th / 90th percentile tips of recent non-empty blocks (`eth_feeHistory`), cost of common actions (send, ERC-20 send, swap, NFT mint, approve; typical gas) in ZETAPHY, base fee burned over the 20/50/100 blocks (estimate: base fee × fullness × gas limit), per-block table |
| Tools `#/tools` | decode a signed raw EVM tx (legacy / EIP-155, EIP-2930, EIP-1559): fields, hash, **sender recovered** (secp256k1 from `@noble/curves`, `vendor/zetaphy-tools-lib.js`, loaded on this page only), dry run with `eth_call` (nothing sent); **broadcast** with `eth_sendRawTransaction` only after ticking a box **and** a second click, and only for chain id 77390; check a `personal_sign` (EIP-191) signature; check an **ML-DSA-44** signature (the same `@noble/post-quantum` verifier the block certificates use); unit converter (azetaphy / gwei / ZETAPHY); address converter (0x ↔ zetaphy1 ↔ zetaphyvaloper1) |

**NFT metadata is untrusted:** only text is shown (tags stripped, control/bidi characters removed, lengths bounded), `external_url` only when https,
images only with `<img>` and only from https, `ipfs://` or `data:image/{png,jpeg,gif,webp,svg+xml,avif,bmp}` (an SVG, with or without scripts, is never put
inline, so it cannot run anything; `image_data` SVG becomes a `data:image/svg+xml` `<img>`). Images through `https://ipfs.io` load directly (it is in `img-src`);
an image on any other host is fetched only when the viewer clicks "Load image" (no cookies, no referrer, ≤ 8 MB, `image/*` only) and shown from a `blob:` URL.
Metadata fetches send no cookies and are capped at 256 KB.

**Installable (PWA):** `manifest.webmanifest` (icons `icon-192.png` / `icon-512.png`, made from `logo.svg` with `npm run icons`) and `sw.js`. The service worker
handles only this site's own GET requests for app-shell files (pages, style, scripts, icons): **node answers (any other host), `config.json` and everything else
go straight to the network and are never stored.** Network first, so a new deploy is used at once (`skipWaiting` + `clients.claim`, old caches deleted,
`sw.js` served with `Cache-Control: no-cache`); offline, a page load gets `offline.html`. Not registered inside a frame (the hub) or on plain http.

**CSP changes:** `img-src` gained `data:` (data:image NFT art), `blob:` (images fetched on request) and `https://ipfs.io` (the default gateway);
`connect-src` names `https://ipfs.io` explicitly (already covered by `https:`); `worker-src 'self'` for `sw.js`. No new script or style hosts.

**Limits (no indexer):** uptime and certificate inclusion cover only the last N blocks (one block read each); slash history needs the node's `block_search`
(CometBFT indexer) and commission history its `tx_search`; holders are only those who moved tokens in the window (older quiet holders are missed) and
`MsgEVMCall` transfers are not in `eth_getLogs`; NFT ids come from `tokenByIndex` or recent logs; burned fees are an estimate; gas amounts are typical, not exact.
All texts of these pages are in the explorer's 8 languages (en, zh, es, ko, ja, ru, vi, th; `T_MORE` in `src/i18n.js`), and the i18n test requires every key in every language.
Tests: `test/explore2.unit.test.js` and `test/explore2.e2e.js` (both run by `npm test`; the e2e files pick free ports, or `E2E_PORT` / `E2E2_PORT`).
**The `wss://` source** is derived from `config.json`'s `node` (`https://rpc.sawasdeecoin.com` → `wss://rpc.sawasdeecoin.com`). When you change the node in `config.json`,
change that entry in `vercel.json` too (a unit test fails until they match). `npm run serve` derives it from the config it serves.

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
npm run build              # rebuild vendor/zetaphy-lib.js and src/known-abi.js (when pqcert.js / pqtx.js / vaccine.js or contract artifacts change), then commit
npm run build              # rebuild vendor/zetaphy-lib.js and labels.json / crosschain.json (when pqcert.js / pqtx.js / vaccine.js or the deployment records change), then commit
npm run serve              # http://localhost:8095 with the same CSP as vercel.json
npm test                   # unit + browser (mock node)
npm run test:devnet        # against a real chain (see below)
```

- `npm test` = `test/unit.test.js` (Cosmos/EVM transaction decoders, token transfers, formatters, config, queue/cache, ThreatRegistry, scanning, i18n, CSP/sink checks),
  `test/deep.test.js` (the ABI codec against ethers, signature tables, contract recognition, proxies, Sourcify answers, call tree, balance changes, gas split, summary and risk flags) and
- `npm test` = `test/unit.test.js` (Cosmos/EVM transaction decoders, token transfers, formatters, config, queue/cache, ThreatRegistry, scanning, i18n, CSP/sink checks), `test/insight.test.js` (flow graph, quantum exposure, labels, Hyperlane/IBC, questions, batched risk badges) and
  `test/explorer.e2e.js` (Chromium via Playwright; uses `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` or `CHROMIUM_PATH`)
  The mock node in `test/mock-chain.js` also answers `debug_traceTransaction` (callTracer, prestateTracer diff; one tx without traces) and Sourcify (route interception). `EXPLORER_E2E_PORT=…` picks other ports when two checkouts test at once.
  It creates blocks with genuinely correct hashes and real ML-DSA-44 signatures (one block has a bad signature to test that it is rejected)
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
src/abi.js       ABI codec: signatures, decode / encode, events, revert reasons, form input
src/sigs.js      common signatures (ERC-20/721/1155, router, multicall, permit, …)
src/known-abi.js this repo's contract signatures (generated by npm run build, scripts/known-abi.js)
src/sigdb.js     signature lookups, recognising this repo's contracts
src/contract.js  Sourcify, proxies, ABI resolution, read calls
src/txdeep.js    tx analysis: decoding, call tree, balance changes, gas, summary, risks (pure)
src/txview.js    tx page deep view (DOM)
src/contractview.js  contract card: source, Read, Write (DOM)
src/format.js    formats numbers/addresses/time, safeText
src/dom.js       builds DOM without HTML
src/history.js   full address history (tx_search event queries, merged pages), token transfer windows, filters, CSV
src/live.js      live blocks (CometBFT / EVM websocket, polling), pending txs, the Live page
src/watch.js     watch list, nicknames, watched txs, toasts (localStorage)
src/charts.js    home page analytics (inline SVG)
src/i18n.js      UI strings (en, zh, es, ko, ja, ru, vi, th)
src/config.js    defaults, config.json, browser settings
src/flow.js      fund-flow graph (builder, layered layout, SVG page)
src/quantum.js   quantum exposure of an address, #/quantum dashboard
src/labels.js    known-address labels (labels.json)
src/risk.js      batched Neuro risk badges, risk summary box
src/crosschain.js  Hyperlane messages (delivery on the destination chain), IBC packets
src/ask.js       plain questions in the search box (EN/TH, rule based)
src/insight.css  styles of the above
scripts/known.js builds labels.json and crosschain.json (npm run build)
vendor/zetaphy-lib.js  bundle of pqcert.js, pqtx.js, vaccine.js and @noble (built with npm run build)
src/validators2.js  validators list + #/validator/<valoper>   src/gov.js  governance   src/holders.js  ERC-20 holders
src/nft.js       NFT gallery   src/gas.js  gas & fees   src/tools.js  tools   src/pwa.js  service worker registration
sw.js  manifest.webmanifest  offline.html  icon-192.png  icon-512.png   (installable app shell)
vendor/zetaphy-tools-lib.js  secp256k1 (@noble/curves) for the Tools page (npm run build)
```

---

English summary: a static, serverless ZETAPHY block explorer (no database, no indexer). The browser talks to the node's public
EVM JSON-RPC, CometBFT RPC and Cosmos REST (behind Caddy) directly, scans the last N blocks for recent history (bounded, cached,
rate-limited), verifies each block's ML-DSA-44 certificate in the browser with `pqcert.js`, decodes ZETAPHY's custom messages and
EVM token transfers, and shows ThreatRegistry flags in neutral wording with the disclaimer. Deploy on Vercel with Root Directory
`zetaphy-explorer`; point `explorer.sawasdeecoin.com` with a CNAME `explorer` → `cname.vercel-dns.com`, then add the domain in the
Vercel project. Set the node in `config.json` (`node`) or per browser on the Settings page.
