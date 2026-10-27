**English** | [ภาษาไทย](README.th.md)

# ZETAPHY and wallets

How to add ZETAPHY Testnet to commonly used wallets, the wallet config files, and the listing steps (chainlist, Keplr, chain-registry)

> testnet only; test coins with no value

## Network values

One node serves everything on a single https host, `https://<IP with dots replaced by dashes>.sslip.io` (Caddy sits in front of the node).
In this document that host is called `HOST`, e.g. IP `1.2.3.4` → `HOST` = `1-2-3-4.sslip.io`

| What | Value |
|---|---|
| EVM JSON-RPC (MetaMask, etc.) | `https://HOST` (also has `zetaphy_*`) |
| CometBFT RPC (Keplr, Leap) | `https://HOST/rpc` (e.g. `https://HOST/rpc/status`) |
| Cosmos REST / LCD (Keplr, Leap) | `https://HOST/rest` |
| Node files | `https://HOST/zetaphy/` (`genesis.json`, `peer`, `keplr.json`, `evm-chain.json`) |
| Network name | `ZETAPHY Testnet` |
| EVM chain ID | `77390` (`0x12e4e`) |
| Coin symbol in EVM wallets | `ZTPHY` (see the next section) |
| Decimals | 18 |
| Cosmos chain-id | `zetaphy_77390-1` |
| denom | `azetaphy` (1 ZETAPHY = 10^18 azetaphy) |
| bech32 | `zetaphy`, `zetaphyvaloper`, `zetaphyvalcons` (and `…pub`) |
| Keys | eth_secp256k1, coin type 60: the `0x…` and `zetaphy1…` addresses are the same 20 bytes |
| Gas price | minimum 1 gwei (1000000000 azetaphy), EIP-1559 style |
| block explorer | none yet (leave empty) |

### Why the symbol in EVM wallets is `ZTPHY`, not `ZETAPHY`

`ZETAPHY` is 7 characters long, but
- MetaMask rejects `wallet_addEthereumChain` when `nativeCurrency.symbol` is longer than 6 characters
  (`Expected 1-6 character string 'nativeCurrency.symbol'` in `app/scripts/lib/rpc-method-middleware/handlers/ethereum-chain-utils.ts` of metamask-extension)
- ethereum-lists/chains (which chainlist.org reads) does not accept symbols of 7 or more characters (`NativeCurrencySymbolMustHaveLessThan7Chars`)

So the add-network button and the chainlist listing use `ZTPHY` (the coin name is still `ZETAPHY`). The Cosmos side (Keplr, Leap, chain-registry) has no such limit, so it stays `ZETAPHY`
- To use a different symbol (at most 6 characters), change it in 3 places together: `EVM_SYMBOL` in `zetaphy-wallet/wallets.js`, `evm-add-chain.template.json` and `ethereum-lists/eip155-77390.json` (the web wallet's tests check that they match)
- If you add the network to MetaMask by hand, you can type `ZETAPHY`, but once ZETAPHY is on chainlist, MetaMask will warn that the symbol does not match the listing
- Do not import the token at `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`, because it is the same ZETAPHY coin in ERC-20 form (you would see the balance twice)

## Which wallets work

| Wallet | Works? | How |
|---|---|---|
| MetaMask (extension, mobile) | Yes | Button, or add by hand |
| Rabby | Yes | Button, or add by hand |
| Trust Wallet | Yes | Button (the extension announces itself with EIP-6963), or add by hand in the mobile app |
| OKX Wallet | Yes | Button, or add by hand |
| Coinbase Wallet | Yes | Button, or add by hand |
| Brave Wallet, Rainbow, Zerion, Frame | Yes | Button, or add by hand |
| Ledger / Trezor | Yes, through the EVM wallets above (e.g. MetaMask), and Ledger through Keplr | See the Ledger section |
| Keplr, Leap | Yes | Button (`experimentalSuggestChain`) |
| Cosmostation | Probably (not yet tried with the real wallet) | Button (uses Cosmostation's Keplr-style interface) |
| Binance Wallet | Not confirmed yet | In the Binance app: the button, if the wallet accepts new networks. Outside the app: WalletConnect (not enabled yet) |
| Phantom | No, until Phantom adds ZETAPHY itself | - |
| Wallets with a fixed chain list | No, until the wallet adds ZETAPHY itself | - |
| Solana-only or Bitcoin-only wallets | Not at all (not an EVM or Cosmos wallet) | - |

- "Works" in this table comes from each wallet's documentation (supports `wallet_addEthereumChain` or lets you add a network by hand)
  - The MetaMask side was checked against its source code
  - The buttons on the web page are tested with mock wallets in `zetaphy-wallet/test/wallet.e2e.js`; they have not yet been tried with every real wallet
- **Quantum-resistant** options are only 2 (see the sections near the end): ML-DSA-44 keys in the ZETAPHY web wallet, and ZETAPHY Snap in MetaMask

## 1. EVM wallets (MetaMask, Rabby, Trust, OKX, Coinbase, etc.)

### With the button in the ZETAPHY web wallet (`zetaphy-wallet`)

1. Open the web wallet page, set the RPC address to `https://HOST`, and click save
2. Scroll down to "Use ZETAPHY with other wallets"
   - The page shows every EVM wallet in the browser, with name and icon (EIP-6963)
   - For older wallets that do not announce themselves, the page uses `window.ethereum` instead
3. Click the wallet you want to use (the page remembers it), then click **"Add ZETAPHY to this wallet"**
   - The page sends `wallet_addEthereumChain` (EIP-3085), then `wallet_switchEthereumChain` to `0x12e4e`
   - The wallet shows a window asking you to confirm
4. If the wallet refuses to add it, the page shows the reason the wallet gave, then opens the values for adding it by hand
5. "Connect this wallet" shows the address of the account in that wallet as both `0x…` and `zetaphy1…`, the network the wallet is on, and the balance

The selected wallet is also used for "Lock account … to this wallet" (quantum lock)
ZETAPHY Snap mode works with MetaMask only: the page asks `wallet_getSnaps` first, and if the wallet does not support it, the page tells you to choose MetaMask

The same file (with `HOST` filled in) is on the node at `https://HOST/zetaphy/evm-chain.json`, for other websites that want to make the same kind of button

### Add by hand (works with every EVM wallet that lets you add a network yourself)

Fill in these 5 fields; the others can be left empty:

| Field | Value |
|---|---|
| Network name | `ZETAPHY Testnet` |
| RPC URL | `https://HOST` |
| Chain ID | `77390` |
| Currency symbol | `ZTPHY` |
| Block explorer URL | (leave empty) |

Menu path in each wallet (menu names may differ between versions):
- **MetaMask:** click the network name at the top → **Add a custom network** → fill in → Save
- **Rabby:** More → **Custom Network** → Add
- **Trust Wallet (mobile app):** Settings → Networks/Preferences → **Add custom network** (or the + button) → choose EVM → fill in
  Steps follow Trust's help article (support.trustwallet.com/en/articles/717170)
- **OKX Wallet:** Network settings → **Add custom network** → fill in
- **Coinbase Wallet:** Settings → Networks → **+ / Add custom network** → fill in

## 2. Ledger (through MetaMask, EVM transactions)

1. In Ledger Live, install the **Ethereum** app on the Ledger device
2. MetaMask → account menu → **Add hardware wallet** → Ledger → choose an account
3. Add ZETAPHY Testnet in MetaMask (button or by hand, as in section 1)
4. Send ZETAPHY as usual
   - Ledger shows chain ID 77390 (Ledger does not know this chain's name; this is normal)
   - Transactions with data need **Blind signing** turned on in the Ledger Ethereum app,
     e.g. ERC-20 token transfers or a quantum lock (sending to `0x…5051`)
- The key in a Ledger is ECDSA like other EVM wallets, so it is not quantum-resistant.
  You can lock that account to a PQ wallet, after which the Ledger key can no longer be used with ZETAPHY
- **Ledger through Keplr also works**
  - The chain-id `zetaphy_77390-1` is Ethermint style (`<name>_77390-<n>`), and `keplr.json` has the `force-enable-evm-ledger` feature as Keplr requires
  - Keplr → Connect Ledger → choose the **Ethermint/EVM** app on the Ledger (uses the Ethereum app), then sign with EIP-712
  - The chain already verifies this kind of EIP-712 signature in the test suite, but it has not yet been tried with a real Ledger device

## 3. Cosmos wallets (Keplr, Leap, Cosmostation)

In the ZETAPHY web wallet, click **"Add to Keplr"**, **"Add to Leap"** or **"Add to Cosmostation"**
- The page sends the chain info with `experimentalSuggestChain`, then `enable("zetaphy_77390-1")`
- It then shows the `zetaphy1…` address the wallet returns (and the `0x…` form of the same account)
- Cosmostation uses `window.cosmostation.providers.keplr` (Cosmostation's Keplr-style interface)

The chain info is `keplr-chain-info.template.json` (the node publishes a version with HOST filled in at `https://HOST/zetaphy/keplr.json`):
- `rpc` = `https://HOST/rpc`, `rest` = `https://HOST/rest`, `bip44.coinType` = 60
- `gasPriceStep` = 1e9 / 2e9 / 4e9 azetaphy
- `features`: `eth-address-gen`, `eth-key-sign` and **`eth-secp256k1-cosmos`**
  - The last one is required for chains built from github.com/cosmos/evm (according to the keplr-chain-registry guide)
  - This chain's pubkey type is `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey`.
    Without this feature Keplr uses `/ethermint.crypto.v1.ethsecp256k1.PubKey`, which the chain cannot decode, so no transaction from Keplr would go through
  - Tested on a live chain with `npm run test:devnet:cosmoswallet` in `zetaphy-network`
- `evm: {chainId: 77390, rpc: "https://HOST"}` lets newer Keplr versions use the EVM side too
- `isTestnet: true`

What the node must have (setup-node.sh does this):
- `/rpc` forwards to CometBFT RPC through rpc-guard: the read methods wallets use and `broadcast_tx_sync/async` (no websocket)
- `/rest` forwards to Cosmos REST
- Both must be https: Keplr does not accept http

## 4. Mobile

- **Easiest way:** open the ZETAPHY web wallet page in the **browser inside the wallet app**
  (MetaMask Mobile, Trust, OKX, Coinbase Wallet, Binance app)
  - These apps inject `window.ethereum` into the page, so the page sees the wallet in its list just like on a computer, and you can click "Add ZETAPHY to this wallet" right away
- If you open the page in a normal mobile browser, the page shows "Open in app" links for MetaMask, Trust Wallet, Coinbase Wallet and OKX Wallet
- Add by hand in the app: use the 5 fields from section 1 (Trust Wallet: Settings → Networks → Add custom network)
- **WalletConnect** (connecting a mobile wallet from another browser) is still off; see the next section

### WalletConnect: next steps

The WalletConnect button on the page cannot be clicked until there is a projectId, and the page does not contain WalletConnect code yet
1. The owner signs up for a free projectId at **cloud.reown.com** (Reown is the former WalletConnect)
   - Add the web wallet's domain to the project's allowlist
2. Put the projectId in `<meta name="zetaphy-walletconnect-project-id" content="…">` of `zetaphy-wallet/index.html`,
   or in the page's "Advanced settings" box (remembered in that browser)
3. The next step is to add the WalletConnect SDK to the bundle (`zetaphy-wallet/src/entry.js` → `npm run build`) and wire it to this button
   - The CSP already has `connect-src *`, so it can reach the WalletConnect relay

## 5. Binance

- **In the Binance app (DApp browser of Binance Web3 Wallet):**
  - The wallet injects `window.binancew3w.ethereum` into the page, and the page shows it as "Binance Wallet"
  - If the wallet announces itself with EIP-6963 (rdns `com.binance.wallet`, or a name containing Binance), it is shown too
  - The add-network and quantum lock buttons work the same way as for other EVM wallets
  - **Not confirmed yet** whether Binance Wallet allows adding new networks. If it refuses (e.g. error 4200 or rejects the chain), the page says this wallet may not accept new networks yet, and opens the values for adding it by hand
- **Outside the Binance app:** Binance Web3 Wallet connects with WalletConnect v2, which first needs a Reown projectId and the SDK (see the WalletConnect section)
- **Getting Binance (the exchange) to support ZETAPHY deposits/withdrawals** is a business listing application with Binance; code cannot do it

## 6. Phantom

Phantom does not let you add networks by hand; it only supports chains Phantom has chosen
(Solana, Ethereum, Polygon, Bitcoin, Base, HyperEVM, Robinhood Chain, according to help.phantom.com/hc/en-us/articles/46595961428627)
- So Phantom cannot be used with ZETAPHY until Phantom adds ZETAPHY itself, which is a business request to Phantom, not code
- The page still shows Phantom in the list if it finds it (EIP-6963 rdns `app.phantom` or `window.phantom.ethereum`)
  - When selected, the page first warns that Phantom cannot add networks and suggests another wallet
  - If you click add and Phantom refuses, the page explains it the same way as for Binance

## 7. Which wallets are quantum-resistant

| Wallet | Signature | Quantum-resistant |
|---|---|---|
| ZETAPHY web wallet (key in the web page) | ML-DSA-44 (FIPS 204) | Yes |
| ZETAPHY Snap in MetaMask | ML-DSA-44 (key created inside MetaMask from the Secret Recovery Phrase) | Yes |
| MetaMask, Rabby, Trust, OKX, Coinbase, Binance, Ledger, Keplr, Leap, Cosmostation, etc. | ECDSA secp256k1 | No |

Why other wallets are not quantum-resistant:
- ECDSA is safe because the secret key cannot in practice be derived from the public key
- But a large enough quantum computer can do it with Shor's algorithm
- The public key is revealed on chain from the account's first transaction, so anyone who stores it can wait and break it later
- These wallets only work with ECDSA keys; adding the ZETAPHY network does not change the signature type

The protection on ZETAPHY is the **quantum lock**:
- Move control of an ECDSA account (e.g. in MetaMask or Ledger) to an ML-DSA wallet
- After locking, the chain no longer accepts ECDSA signatures for that account
- Done from the "Lock account … to this wallet" card in the web wallet, with the selected EVM wallet

## 8. Files in this folder

| File | Used for |
|---|---|
| `evm-add-chain.template.json` | Parameters of `wallet_addEthereumChain` (EIP-3085). Do not add other keys, because MetaMask rejects them |
| `keplr-chain-info.template.json` | Chain info for `experimentalSuggestChain` (Keplr, Leap, Cosmostation) |
| `chain-registry/zetaphytestnet/` | `chain.json`, `assetlist.json`, `images/zetaphy.svg` for `testnets/` of cosmos/chain-registry |
| `ethereum-lists/eip155-77390.json` | For `_data/chains/` of ethereum-lists/chains (chainlist.org) |

- Fill in `HOST` with the node's https name (without `https://`):
  ```bash
  sed 's/HOST/1-2-3-4.sslip.io/g' keplr-chain-info.template.json > keplr.json
  ```
- `chain-registry/zetaphytestnet/chain.json` also has `NODE_ID`, which is the part before `@` in the file `https://HOST/zetaphy/peer`
- The web page (`zetaphy-wallet/wallets.js`) builds the same set of values itself from the RPC address the user enters; tests check that every field matches the templates
- The `keplr.json` and `evm-chain.json` that `setup-node.sh` publishes should match these templates
  (symbol `ZTPHY`, `features` has `eth-secp256k1-cosmos`, `isTestnet: true`)
- The folder name is `zetaphytestnet`, not `zetaphy-testnet`, because chain-registry requires:
  - `chain_name` must match the folder name
  - Image URLs must be `[a-z0-9]+` (no chain name in the whole registry has a dash)

Checked (20 Oct 2026):
- `chain.json` and `assetlist.json` pass the chain-registry schema, `validate_data.mjs` and `@chain-registry/cli validate`.
  No other chain uses this chain-id or prefix
- `eip155-77390.json` passes the ethereum-lists schema, the rules in `processor/Main.kt`, and prettier.
  77390 is still free in ethereum-lists (there is no `eip155-77390.json` file), and no other chain uses this name or shortName

## 9. Listing: chainlist, Keplr, chain-registry

### Required first

- **A public node that is always up**
  - Answers `eth_chainId` = `0x12e4e`
  - `https://HOST/rpc/status` reports network `zetaphy_77390-1`
  - `https://HOST/rest/cosmos/base/tendermint/v1beta1/node_info` responds
  - The registries check these connections when accepting the PR
- **A domain name that does not change** (recommended)
  - `sslip.io` is tied to the IP; if the machine's IP changes, every listing breaks at once
  - Use your own domain (A record pointing to the IP) and let Caddy request a certificate for that name
- **The owner's GitHub account** for forking and opening PRs
- If there are several public nodes, put all of them in the RPC list: a single node is a single point of failure

### chainlist.org (PR to ethereum-lists/chains)

chainlist.org and chainid.network read their lists from github.com/ethereum-lists/chains
MetaMask also uses this data to warn when the name or symbol does not match
1. Open https://github.com/ethereum-lists/chains/pulls and search for `77390` to make sure no other PR is asking for this chain ID
   - The first PR to be merged gets the chain ID
2. Click **Fork**, then clone your fork:
   ```bash
   git clone https://github.com/<your account>/chains.git && cd chains
   git checkout -b add-zetaphy-testnet
   ```
3. Copy the file and fill in HOST:
   ```bash
   sed 's/HOST/<https name of the node>/g' <this repo>/zetaphy-chain/wallets/ethereum-lists/eip155-77390.json > _data/chains/eip155-77390.json
   ```
   - `faucets` is left empty, because the ZETAPHY faucet is a JSON-RPC method (`zetaphy_faucet`), not a web page
   - If there is a faucet web page, you can add its URL
   - `infoURL` points to github.com/pospos191-alt/zetaphy-chain; if the project has a website, use that instead
4. (Optional) Icon:
   - Add `_data/icons/zetaphy.json` following the format in the ethereum-lists README
   - The file must be on IPFS, fetchable with `ipfs get`, and smaller than 250 kB
   - Then put `"icon": "zetaphy"` in the chain file
5. Check before submitting:
   ```bash
   npx prettier --check _data/chains/eip155-77390.json
   ./gradlew run                      # requires Java 17 or later
   ./gradlew run --args="rpcConnect"  # connects to the real RPC and compares the chain ID
   ```
6. Commit, then open a PR titled `Add ZETAPHY Testnet (77390)` and wait for CI to go green
   - If you made fixes for CI, click re-request review
7. After merge, chainid.network updates by itself, then chainlist.org shows ZETAPHY Testnet with an "Add to MetaMask" button

### Keplr (PR to chainapsis/keplr-chain-registry)

Keplr has its own registry at github.com/chainapsis/keplr-chain-registry and accepts testnets (`isTestnet: true`)
It **does not read from cosmos/chain-registry**; a separate PR is needed
1. Fork, then clone https://github.com/chainapsis/keplr-chain-registry
2. Create `cosmos/zetaphy-testnet.json`
   - The file name is the chain-id with the version number `-1` removed
   - Use `keplr-chain-info.template.json` with HOST filled in, and add:
     ```json
     "chainSymbolImageUrl": "https://raw.githubusercontent.com/chainapsis/keplr-chain-registry/main/images/zetaphy-testnet/chain.png",
     "nodeProvider": { "name": "ZETAPHY", "email": "<contact email for node matters>", "website": "<project website>" }
     ```
   - Keep `"isTestnet": true`, and do not add `coinGeckoId` (testnets cannot have it)
3. Add the image `images/zetaphy-testnet/chain.png` as a 256×256 PNG.
   Keplr crops it to a circle; you can convert the image from `chain-registry/zetaphytestnet/images/zetaphy.svg` to PNG
4. Check:
   ```bash
   yarn install
   yarn validate cosmos/zetaphy-testnet.json
   ```
   - It connects to the real RPC, websocket, REST and EVM RPC, so the node must be up
5. Commit, then open a PR
   - After merge, Keplr shows ZETAPHY Testnet in its chain list (with a "Community-Driven" label)

### cosmos/chain-registry (PR to testnets/)

github.com/cosmos/chain-registry is the central data source that many Cosmos tools read (cosmos-kit, explorers, Skip, etc.)
1. Fork, then clone https://github.com/cosmos/chain-registry
2. Copy the folder, then fill in HOST and NODE_ID:
   ```bash
   cp -r <this repo>/zetaphy-chain/wallets/chain-registry/zetaphytestnet testnets/
   sed -i 's/HOST/<https name of the node>/g; s/NODE_ID/<node id from https://HOST/zetaphy/peer>/' testnets/zetaphytestnet/chain.json
   sed -i 's/HOST/<https name of the node>/g' testnets/zetaphytestnet/assetlist.json
   ```
   - If there are several nodes, you can add them to `apis` and `peers`
   - (Optional) Add a square PNG in `images/` and reference it in `images` of both files.
     Every image in the folder must be referenced
3. Check (the same way as their CI):
   ```bash
   npx @chain-registry/cli@1.47.0 validate --registryDir . --logLevel error
   (cd .github/workflows/utility && node validate_data.mjs NO_API)
   ```
4. Commit, then open a PR titled `Add ZETAPHY Testnet (zetaphy_77390-1)`
   - Once there is a tagged release, add `codebase.recommended_version` and `compatible_versions`

### Leap and Cosmostation

- The `experimentalSuggestChain` button on the web page works right away without waiting for a listing
- To appear as a built-in chain in the wallet:
  - **Leap:** uses Cosmos chain data from cosmos/chain-registry. Submit that PR first, then contact the Leap team (Leap's process is not confirmed yet)
  - **Cosmostation:** their chainlist repo (now moved to github.com/CosmosLabsKR/chainlist) is only for adding assets and endpoints of chains Cosmostation already supports.
    Adding a new chain requires contacting the Cosmostation team (contact details are at the end of that repo's README)
