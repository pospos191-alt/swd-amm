**English** | [ภาษาไทย](README.th.md)

# ZETAPHY NFT: create and trade NFTs on the ZETAPHY chain

A system for creating NFT collections and an NFT marketplace for the ZETAPHY chain (Cosmos EVM, EVM chain id `77390`, chain id `zetaphy_77390-1`, ZETAPHY coin uses ticker `ZTPHY` in EVM wallets, 18 decimals)
The web app is static with no server, hosted for free on Vercel at `nft.sawasdeecoin.com`

> **Warning: use on testnet only.** None of the contracts have passed an external security audit.
> Do not use with money or assets of real value. See the [Risks](#risks) section.

## What is in this folder

| Part | Files |
|---|---|
| Contracts (Solidity 0.8.26) | `contracts/CollectionBase.sol`, `ZetaphyERC721.sol`, `ZetaphyERC1155.sol`, `NFTFactory.sol` (includes `ERC721Deployer` / `ERC1155Deployer`), `NFTMarketplace.sol`, `interfaces/Interfaces.sol` |
| Compiled files (committed) | `artifacts/*.json` (abi, bytecode, standard-JSON input for verifying on the explorer) |
| Scripts | `scripts/build.js` (compile, `--check` checks that artifacts match the source), `scripts/build-web.js` (bundles `web/vendor/zetaphy-lib.js`), `scripts/serve.js` (serves the web app locally with the real CSP) |
| CLI | `cli.js` (create keys, deploy, view info, governance commands), `src/keys.js` |
| Web | `web/index.html`, `web/app.js`, `web/style.css`, `web/lib/*.js`, `web/vendor/zetaphy-lib.js`, `web/deployments.json`, `web/vercel.json`, `web/logo.svg` |
| Tests | `test/*.test.js` (unit), `test/web.e2e.js` (browser), `test/devnet.integration.js` (real chain), `test/helpers/` |

## Design

### Contracts

**NFTFactory** Anyone can create a collection. The caller owns the collection. The factory has no owner, charges no fee, and cannot control collections.
- `createERC721(config)` / `createERC1155(config)`, where `config` is name, symbol, base URI (empty = set a per-token URI at mint),
  contract URI, EIP-2981 royalty receiver and rate (**max 10%**), max supply (0 = unlimited; ERC-1155 counts per token id),
  whether public mint is open, and the mint price
- `isCollection(address)` tells whether a collection was created by this factory (the web app shows "Created by the ZETAPHY factory" or "External contract")
- The factory's deployers are split out into `ERC721Deployer` / `ERC1155Deployer` so that each contract stays well below the 24 KB limit

**ZetaphyERC721 / ZetaphyERC1155** Written in-house and kept simple (no local OpenZeppelin, and no paid dependencies)
- ERC-165 only reports interfaces that are actually implemented: 721 = `0x01ffc9a7, 0x80ac58cd, 0x5b5e139f, 0x2a55205a`, 1155 = `0x01ffc9a7, 0xd9b67a26, 0x0e89341c, 0x2a55205a`, and answers `false` for `0xffffffff`
- Safe transfer and safe mint check contract receivers (`onERC721Received` / `onERC1155Received` / `onERC1155BatchReceived` must return the correct magic value; a revert with a message passes the message through; an empty revert or a missing function = `InvalidReceiver`)
- The owner can always mint; public mint must pay exactly `price × quantity`. The funds stay in the contract until the owner calls `withdraw` (no funds are sent during mint)
- Max supply: can be lowered, or set from unlimited, but cannot be raised, and cannot go below what has already been minted; ERC-721 mint reserves the id before calling the receiver callback, so it cannot exceed max supply even with nested calls
- Per-token URIs cannot be changed; base URI / contract URI can be changed until the owner calls `freezeMetadata()`
- **Move counter (`transferCount`)** used by the marketplace to close old listings:
  ERC-721 `transferCount(tokenId)` increases every time that token is minted, transferred (including transfers to self) or burned (the value remains after burn);
  ERC-1155 `transferCount(holder, id)` increases every time units of `id` **leave** `holder` (single transfer, every entry in a batch, burn, and sales through the marketplace). **Incoming** units (transfers in, mint) and transfers of 0 units or to self are not counted —
  receiving can never make an old listing buyable again, and if it were counted, anyone could kill any seller's listing just by sending (or public-minting) them 1 unit
  Gas cost: no extra storage writes — 721 stores the counter (uint96) in the same slot as the owner (address), 1155 stores the counter (upper 64 bits) in the same word as the balance (lower 192 bits)
  so it adds only about 100-160 gas per transfer (measured in the test suite: 721 transfer 33,509 → 33,617; 1155 transfer 10,308 → 10,463). A 721 burn writes a non-zero value into the existing slot instead of clearing it (no gas refund from clearing the slot)
  Limit of the packing: ERC-1155 can mint at most 2^192 − 1 units per id (`MaxSupplyReached`)
- All settings are stored in storage (no immutables), so every collection of the same type from the factory has the same code (code hash) and can be checked once for all
- `renounceOwnership` sends all funds held in the contract (public mint funds, or funds anyone forced in, for example with `selfdestruct`) to the renouncing owner in the same transaction (clears the owner first, then sends the funds: checks-effects-interactions). So nobody else can send 1 wei to block the renouncement, and no funds are left stuck with nobody able to withdraw them

**NFTMarketplace**
- Fixed-price listings in ZETAPHY **without depositing the NFT with the marketplace**: the NFT stays in the seller's wallet until sold. The seller calls `setApprovalForAll` (or `approve` per token for 721)
- ERC-721 (quantity 1) and ERC-1155 (price per unit, partial buys allowed, remaining quantity decreases as units sell)
- Every sale splits the funds: protocol fee `feeBps` (default 1%, governance can set it, **max 5%**) to `feeRecipient`;
  the EIP-2981 royalty reported by the collection, **capped at 10% of the price** (if `royaltyInfo` reverts, uses more than 50,000 gas, answers in the wrong format, or the receiver is zero = no royalty); the rest goes to the seller. Everything rounds down; leftover wei goes to the seller
- **Pull payment**: every share is recorded in `owed[address]`, and the owner calls `withdraw()` or `withdrawTo(address)` themselves. A receiver that rejects funds therefore cannot block a sale
  For a royalty receiver that is a contract which can receive funds but cannot call `withdraw` itself: anyone can call `withdrawFor(receiver)`. The funds go only to `receiver` (the caller gets nothing)
- **Reentrancy guard** on `buy`, `makeOffer`, `cancelOffer`, `acceptOffer`, `withdrawTo`, `withdrawFor`; state is read with view (staticcall) and the NFT is sent after state is recorded
- Cancel (`cancel`), cancel all of your own listings in one transaction (`cancelAll` with a nonce), expiry (`expiry`, max 365 days)
- **Listings that are no longer valid**: if the seller transfers the NFT away or revokes the approval, buying reverts (`SellerLacksToken` / `NotApproved`; factory collections whose token moved away: `TokenMoved`), and `listingStatus(id, qty)` gives the reason. The web app hides these listings
- **One valid listing per (seller, collection, tokenId)**: every listing records the nonce `tokenNonceOf[seller][collection][tokenId]` when listed, and this nonce is increased (all old listings for that token can never be bought again, status `Replaced`) when
  the same token is listed again, on a `buy` that sells out the listing, on `acceptOffer` (for the offer's acceptor), and every time the marketplace sends a token to a receiver (buyer) — so a seller who gets a token back later cannot be bought from at the old price again
  ERC-1155: a partial buy does not expire the existing listing, but accepting an offer, or receiving more units through the marketplace, cancels the existing listing for that id (you can list again right away)
- **Transfers outside the marketplace (factory collections only, `factory.isCollection(c)`)**: at listing time, the marketplace records the collection's `transferCount` (721: of the token; 1155: of the seller) in the listing (`moves`, `tracked`)
  `buy` only succeeds while the value is unchanged. If it differs, it reverts with `TokenMoved` and `listingStatus` is permanently `Moved` — so a token that left the seller outside the marketplace and later came back does not make the old listing buyable again
  A partial ERC-1155 buy through the marketplace also moves units out of the seller (counter +1), so `buy` raises the listing's expected value by 1 in the same transaction (not when the seller buys from themselves, because no units move)
  Extra gas in the marketplace (measured in the test suite): `list` about +1,800–2,000, `buy` 721 about +1,500, partial `buy` 1155 about +5,300 each
  External collections cannot be forced to have a counter: they still use the old nonce approach (`tracked = false`). See "Risks"
- **Seller protection**: `acceptOffer(id, minProceeds)` reverts (`ProceedsTooLow`) if the seller's proceeds are less than `minProceeds` (the web app computes it from the offer amount, fee and royalty shown on screen). So it is safe from fees/royalties that rise before the transaction is included in a block, and from an RPC that shows a fake offer amount
  A listing records the seller's proceeds per unit at listing time (`minUnitProceeds`). If the fee or royalty rises after that, buying reverts and `listingStatus` is `TermsChanged` until the seller lists again; the buyer always pays `msg.value` = price × quantity exactly (nothing is added)
- Offers: the buyer deposits ZETAPHY with the marketplace, the NFT holder can accept the offer, and the buyer can cancel at any time (including after expiry). Funds are returned to `owed`
- After the transfer, the marketplace checks that the buyer really received the NFT (protects against tokens that pretend to transfer); the contract type is checked with ERC-165 following EIP-165
- EIP-712 signed listing: **not implemented** (only on-chain listings)

### Neuro (a key ZETAPHY feature)

- Governance sets the `ThreatRegistry` address (`zetaphy-network/contracts/ThreatRegistry.sol`) for the marketplace with `setThreatRegistry` (zero = off)
- The marketplace **refuses** listing, buying, making offers and accepting offers for collections with an "enforced" flag (past `enforceDelay` or through the urgent path) with the error `CollectionRefused(reason)`:
  factory collections (`factory.isCollection(c)`; the factory address is set when the marketplace is deployed and cannot be changed) only check flags on their own address (`isAddressEnforced(chainid, c)`); external contracts check both address and code (`isContractEnforced(c)`)
  Cancelling and withdrawing funds always work. If the registry cannot answer, the marketplace refuses (fail closed) until governance fixes it or sets it to zero
- The web app queries the registry in 3 more ways, like the ZETAPHY wallet (`zetaphy-network/src/vaccine.js`): address, code hash and fp1 fingerprint, in both the warning view (`is*Flagged`) and the enforced view (`is*Enforced`)
  - A new flag that is not yet enforced: shows a yellow warning box with a factual reason about the code, and trading is still allowed
  - An enforced flag: red box, disables the list/buy/offer buttons (factory collections flagged on the shared code or fingerprint: shown as a warning that this is a flag on code shared by all collections, trading is not disabled, matching the marketplace)
  - Every box has the message **"Automated code analysis data, not an accusation"** and how to re-check. Wording is neutral per `docs/LEGAL.md` (tests check that words like scam / fraud are not used)
- The web app shows whether a collection was created by the trusted factory or is an **external contract** (with a warning that the code is unknown)
- **Important for governance**: factory collections of the same type share the same code. If someone flags that code hash (for example with the reason "unlimited minting possible", because the owner can mint when no max supply is set), every collection is marked at once in wallets and the explorer
  The marketplace no longer applies code flags to factory collections (see above), but ThreatRegistry governance should still call `ThreatRegistry.setProtected([codeKey(hash721), codeKey(hash1155)], true)`:
  `deploy` writes `collectionCodeHashes` and `collectionCodeKeys` into the deployments JSON; if the deployer key is the governance of the registry passed with `--registry`, the CLI protects them automatically (`codeKeysProtected: true`)
  Otherwise it prints a "NEXT STEP" with both keys, and governance runs `node cli.js gov protect-code --key-file <ThreatRegistry governance key>` (`gov set-registry` prints this step as well). Per-address flags (`addressKey`) still work as usual
  (`test/neuro.test.js` tests against the real ThreatRegistry: code flags do not stop factory collections, but do stop copies of the same code deployed outside the factory, and address flags still stop them)

### Images and metadata (free, $0)

- token URI supports `ipfs://` (opened through a public https gateway, changeable on the settings page), `https://` and `data:`. `http:`, `javascript:` and others are not opened
- Metadata is read up to 256 KB, 10 second timeout, no cookie/referrer sent; image data URIs up to 2 MB
- Images are shown only in `<img>`. SVG is shown as `img src` (scripts in SVG do not run). SVG is never inserted directly into the page. `animation_url` is not loaded
- Names, descriptions and traits are inserted only with `textContent`, with control, bidi and invisible characters stripped and length limited
- CSP in `web/vercel.json`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'` …

### Web app (`web/`)

- Fully static, no server, no scripts from elsewhere. The only libraries used (`@noble/hashes` + the read parts of vaccine) are bundled at `web/vendor/zetaphy-lib.js`,
  and `test/bundle.test.js` rebuilds it in memory and compares it with the committed file (reproducible with `package-lock.json`), like zetaphy-wallet
- Hand-written ABI encode/decode (`web/lib/abi.js`), tested against ethers
- Pages: Explore (latest listings from `Listed` events + latest collections), Collection, Item (buy/list/offer/cancel), Create collection, Mint, My NFTs (from Transfer/TransferSingle/TransferBatch events to your address, then checks you still hold them), Settings
- Browser-side event search: at most 2,000 blocks per query (per the node's limit; if the node refuses, the range is halved), up to the configured number of blocks (default 50,000; press "Search older blocks" to extend), cached in localStorage
- Wallets via EIP-6963 (same pattern as `zetaphy-wallet/wallets.js`). Adds/switches to the ZETAPHY network (ticker ZTPHY) automatically, then reads `eth_chainId` again after switching; simulates transactions with `eth_call` before sending and turns errors into readable messages
- Before every `eth_sendTransaction`, the web app asks the wallet for `eth_chainId` again and does not send if it is not 77390, and also puts `chainId: 0x12e4e` in the transaction
- Factory/marketplace addresses come only from the web app's `deployments.json`. The fields to edit them on the settings page exist only in developer mode (`?dev=1` in the URL), with a red warning. Before approving (`setApprovalForAll`) a marketplace that is not the one in `deployments.json`, you must type the last 6 characters of the address to confirm
- External collections: the item page warns "Old listings may become buyable again if you get the item back. Cancel listings you no longer want";
  listing/accepting offers for external ERC-721 uses `approve(marketplace, tokenId)` for that token only (the next transfer clears it, so a token you get back is not approved again automatically) instead of `setApprovalForAll`;
  ERC-1155 only has `setApprovalForAll` (the standard has no per-token approval). The web app shows this message in the listing form; factory collections still use `setApprovalForAll` because the counter already closes old listings
- Item page: the seller sees their own old listings that can no longer be bought (sold, replaced, token moved) with a "Cancel my old listings" button, and after accepting an offer the web app offers to cancel the token's other listings; the accept-offer button shows the amount you will receive (used as `minProceeds`)
- "Search older blocks" (`?older=N`) is limited to 20 times the search range and at most 4,000,000 blocks per search
- **Privacy**: images and metadata load directly from the links chosen by the collection creator (any https site or an IPFS gateway). Those servers see the viewer's IP address and the time of viewing (no cookie/referrer sent). The web app itself stores no data — this message is shown on the settings page and in the IPFS help box
- Thai/English, light/dark mode, works on mobile (tested at 360px width), SAWASDEE COIN branding

## Install and test

```bash
cd zetaphy-nft
npm ci
npm run build -- --check      # artifacts match contracts/ (npm run build to recompile)
npm test                      # all unit tests (contracts in @ethereumjs/evm, web libraries, bundle, keys)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e        # headless browser + mock node on a real EVM + mock wallet
flock /tmp/ci-test/devnet.lock env ZETAPHYD=/path/to/zetaphyd PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:devnet
npm run serve                 # serves the web app at http://localhost:8091 with the same CSP as Vercel
```

`test:devnet` uses `zetaphy-network/scripts/devnet.sh` to start a temporary real chain (port `DEVNET_PORT`, default 25545), deploys with the CLI, creates collections, mints, lists, buys (ERC-721 and ERC-1155),
withdraws funds, tests invalid listings and registry refusals, then opens the web app to find listings from the real node's `eth_getLogs` and buy through a wallet that signs real transactions

## Deploying the contracts

1. Create a deployer key (stored locally only; the key is never printed):
   ```bash
   node cli.js key new                          # ~/.zetaphy/deployer.key (mode 0600, created with O_EXCL and never written through a symlink); shows only the address
   ZETAPHY_PASSPHRASE='…' node cli.js key new   # or store it encrypted (keystore) as deployer.key.json
   ```
   Use another file with `--key-file` or `ZETAPHY_KEY_FILE`; or pass the key via the env `ZETAPHY_PRIVATE_KEY` (testnet only)
2. Fund that address with testnet ZETAPHY (testnet faucet)
3. Deploy and write the file for the web app:
   ```bash
   node cli.js deploy --rpc https://<testnet rpc> \
     [--governance 0x…] [--fee-bps 100] [--fee-recipient 0x…] \
     [--registry 0x<ThreatRegistry>] [--public-rpc https://<rpc used by the web app>] \
     --out web/deployments.json
   node cli.js info                             # check the values in use on-chain
   ```
   The CLI checks that the EVM chain id is 77390 (use `--any-chain` to skip), then commit `web/deployments.json`
   The marketplace is deployed with the factory address (5th constructor argument, cannot be changed), and the CLI protects the code keys itself or prints the governance steps as described in the Neuro section
4. Governance commands (use the governance key):
   ```bash
   node cli.js gov set-fee 100 0x<recipient>         # max 500 (5%)
   node cli.js gov set-registry 0x<ThreatRegistry>  # 0 = disable the check
   node cli.js gov set-governance 0x<multisig>
   node cli.js gov protect-code [--registry 0x…]   # use the ThreatRegistry governance key: protect the code keys of factory collections
   ```
   It is recommended to transfer governance to a multisig (for example zetaphy-network's `SimpleMultisig`) or the chain's gov module, and to protect the collection code hashes in ThreatRegistry as described in the Neuro section

## Deploying the web app on Vercel (free)

1. Go to vercel.com with a Hobby (free) account → **Add New… → Project** → import this repository from GitHub
2. Project settings:
   - **Root Directory**: `zetaphy-nft/web`
   - **Framework Preset**: Other
   - Build/Install/Output: no need to set; `web/vercel.json` already defines them (no build step; `vendor/zetaphy-lib.js` is already committed)
3. Press Deploy. Every push to the main branch makes Vercel redeploy automatically
4. Or use the CLI: `npx vercel --cwd zetaphy-nft/web` (and `--prod` when ready)

`web/vercel.json` adds security headers (CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS …) to every file

## Subdomain `nft.sawasdeecoin.com`

1. At the DNS provider for `sawasdeecoin.com`, add the record:
   | Type | Name | Value |
   |---|---|---|
   | CNAME | `nft` | `cname.vercel-dns.com` |

   If you use Cloudflare, set it to **DNS only** (grey cloud) so Vercel can issue the SSL certificate
2. In Vercel: Project → **Settings → Domains** → Add `nft.sawasdeecoin.com`
3. Wait for Vercel to check DNS and issue HTTPS automatically (usually a few minutes). If it shows "Invalid Configuration", check that the CNAME is correct and the proxy is not on
4. No cost (Vercel Hobby + an existing DNS record)

The RPC the web app uses must be https and send CORS headers (`Access-Control-Allow-Origin`), which Caddy in `zetaphy-chain/setup-node.sh` already does

## Free image and metadata storage (IPFS)

Images and JSON files are too large to store on-chain. Upload them to IPFS, then paste the CID or `ipfs://CID/1.json` on the Mint page (a bare CID is converted to `ipfs://` for you)
This project has no accounts or keys for any service. Creators can choose whatever suits them:

1. **Your own IPFS node** — IPFS Desktop or Kubo (free, open source). Add a folder, copy the CID, and keep the machine running, or have others pin it too
2. **Free tier of a pinning service** — for example Pinata or Filebase free tier (creators sign up themselves; check the service's latest limits)
3. **Services like NFT.Storage / Storacha** when a free tier is available — upload in the browser and copy the CID
4. **data: URI** — small images (small SVG/PNG) or JSON can be embedded directly in the token URI with no file hosting, but it is stored on-chain so it costs more gas (limit 8 KB per URI)

Files on IPFS are only available while someone still pins them. The gateway the web app uses can be changed on the settings page (default `https://ipfs.io/ipfs/`)
Example metadata:
```json
{ "name": "Siam Cat #1", "description": "…", "image": "ipfs://bafy…/1.png", "attributes": [{ "trait_type": "Color", "value": "Gold" }] }
```

## Risks

- **Not audited and for testnet use only.** The contracts are written in-house without audited libraries (none available offline). There is a test suite, but it is not a substitute for an audit
- Listings without depositing the NFT: sales through the marketplace (buy/accept offer), listing again, and getting a token back through the marketplace permanently expire old listings
  **Factory collections**: transfers outside the marketplace also permanently close old listings (counter `transferCount`, status `Moved`), even if the token later comes back to the seller
  ERC-1155: any unit that leaves the seller outside the marketplace (even if enough remain to sell) makes the listing for that id invalid; you must list again
  **External collections**: the marketplace cannot see transfers outside the marketplace. If the seller **transfers it away themselves outside the marketplace** and gets it back outside the marketplace too, an old unexpired listing becomes buyable again **at the old price, by anyone**, if the approval is still in place
  (`setApprovalForAll` also covers tokens you get back). You should `cancel` or `cancelAll` before transferring out — the web app warns on the item page, shows invalid old listings with a cancel button,
  and uses per-token `approve` for external ERC-721 (a transfer clears that approval); external ERC-1155 only has `setApprovalForAll`, so the risk remains. If you already approved the whole collection before (for example from another site), per-token approve does not help
- Governance can change the fee (max 5%) and the registry at any time, including while listings are active (listings where the seller would get less cannot be bought, `TermsChanged`, until listed again); a registry that cannot answer halts trading (fail closed)
- A listing records `minUnitProceeds` from the terms at the time the `list` transaction is included in a block (not a value from the screen). If the fee rises between pressing list and the transaction being included, cancel and list again
- Metadata and images load from any server the creator chooses, which reveals the viewer's IP to that server
- EIP-2981 royalties depend on what the collection reports (capped at 10%); external collections may behave differently from the standard — the web app warns, and the marketplace checks that the buyer really got the NFT, but other behaviour of external contracts is not guaranteed
- Collection owners can change the base URI until they freeze it; files on IPFS/https may disappear if nobody pins them
- Neuro flags are automated code analysis data, not an accusation, and not investment advice; the on-chain check covers address and code (the fp1 fingerprint is computed off-chain, so the web app checks it additionally; for proxy contracts the target the proxy points to is not checked yet)
- Event search is limited by block range. Very old listings may not show until you press "Search older blocks"

## Not done yet

- EIP-712 signed listings (signed off-chain listings) — only on-chain listings
- Auctions, collection-level offers, payment with ERC-20 tokens
- Proxy checks (EIP-1967/1167) for external collections in the web app (the ZETAPHY wallet does this) and detailed display of flag evidence/statements
- Not yet deployed on a real testnet, and Vercel/DNS are not set up yet (follow the steps above)
