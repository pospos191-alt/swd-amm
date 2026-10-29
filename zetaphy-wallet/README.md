**English** | [ภาษาไทย](README.th.md)

# ZETAPHY PQ Wallet

A web wallet for **native PQ accounts** on ZETAPHY testnet
- The account is controlled by an ML-DSA-44 key (FIPS 204) only. There is no ECDSA key at all
- Transactions are Cosmos SDK messages (`MsgSend`, `MsgDelegate`, `MsgEVMCall`, etc.) whose ML-DSA signatures the chain verifies itself
- It is a static site with no server-side code

> **For testnet only, not real money**
> The seed is the wallet's only key. If you lose it or forget the password, the funds are lost forever

## Why it is separate from zetaphy-neuro

zetaphy-neuro promises users that it "never touches keys". This wallet has to hold keys, so it is a separate Vercel project with its own domain

## What it can do

- Create a new key (32-byte seed from `crypto.getRandomValues`) or import a seed (hex)
- Or **use MetaMask (ZETAPHY Snap)**: the ML-DSA-44 key lives in MetaMask, not in this page (see `zetaphy-snap/README.md`)
  - Click "Connect MetaMask": `wallet_requestSnaps`, then `zetaphy_getAccount`. The web page computes the address from the public key itself. It does not trust the address the snap reports
  - The snap ID comes from `<meta name="zetaphy-snap-id">` in `index.html` (default `npm:@zetaphy/snap`).
    During development, enter `local:http://localhost:8080` in "Advanced settings" (the account will differ from the npm one)
  - Send, token send, stake, and deploy are passed to the snap as messages (`zetaphy_signTx`). The snap shows the details and signs when the user confirms.
    The web page builds the tx around the signature itself and compares it with what the snap returns. If they do not match, it does not send
  - There is no seed backup file: MetaMask's Secret Recovery Phrase is the backup
  - While the snap is not yet on MetaMask's allowlist, you must use MetaMask Flask
- Shows the `zetaphy1…` and `0x…` addresses (the same account) and the balance
- Send to a `0x…` or `zetaphy1…` address, showing the amount and fee to confirm before signing
- ERC-20 tokens (like `zetaphy pq native token-balance` / `token-send`)
  - Enter the contract address to show the symbol, decimals, and the account's balance. Read with `eth_call` through the same RPC. The browser remembers the last token address
  - Sending is a `/zetaphy.pq.v1.MsgEVMCall` that calls `transfer(address,uint256)` (the calldata is encoded in the page itself, without ethers)
  - If the contract reverts, the whole transaction fails but the fee is still paid. So the page simulates with `eth_call` before showing the confirm screen, and `callEVM` simulates again before signing. If it would revert or `transfer` returns `false`, it does not sign or send
  - Fee = (EVM gas, default 200000 + 400000) × gas price, paid in ZETAPHY
- Stake (like `zetaphy pq native stake` / `unstake` / `rewards`)
  - Enter a validator `zetaphyvaloper1…` (checksum is checked), then click Stake, Unstake, or Claim rewards. Every button has a confirm screen before signing
  - The staked amount is not shown yet
- Create a contract (deploy, like `zetaphy pq native deploy`)
  - Paste the creation bytecode (hex including constructor arguments). The confirm screen shows the code size and keccak-256 of the code
  - Simulates with `eth_call` before showing the confirm screen, and `deploy` simulates again before signing. Sent as a `MsgEVMCall` with no `to`, then shows the new contract address
- Lock a MetaMask account to this wallet (quantum lock, permanent)
  - You must tick to accept the warning first, then confirm again in the window that shows both accounts
  - Uses `window.ethereum`: `eth_requestAccounts`, then `eth_sendTransaction` `{to: 0x…5051, value: 0x0, data: this wallet's 0x address}`
  - Checks first that this wallet has sent a transaction before (the chain knows its public key), that MetaMask is on chain 77390, and that the account is not already locked
  - After locking, that account's MetaMask key can no longer be used on ZETAPHY. If this wallet's seed is lost, that account is lost too
- Accounts this wallet controls
  - Enter the address of a locked account. The page asks `zetaphy_pqAccount` to confirm that `quantumLockedTo` really is this wallet before using it
  - While "acting on behalf of this account", ZETAPHY sends, token sends, and stake/unstake/claim rewards are sent as `MsgEVMCall` with `as_owner`
    - Funds and tokens come out of the locked account, the fee is paid by this wallet, and staking goes through the precompiles `0x…0800` / `0x…0801`
  - The browser remembers the list of addresses (per wallet). The real state is read from the chain every time
- Download a seed backup file
  - It is unencrypted hex and can be used directly as `~/.zetaphy/pq.seed` for `zetaphy pq native`
- **Use ZETAPHY with other wallets** (`wallets.js`; details and a table of which wallets work are in `zetaphy-chain/wallets/README.md`)
  - Shows every EVM wallet in the browser via EIP-6963 (name and icon: MetaMask, Rabby, Coinbase, OKX, Trust, Brave, Phantom, etc.)
    - Older wallets and in-app mobile browsers: `window.ethereum`, `window.binancew3w.ethereum` (Binance Wallet), `window.phantom.ethereum`
    - Icons are shown only as `data:image/…` (CSP `img-src 'self' data:`). Names are shown as plain text with control and bidi characters removed
  - The user picks the wallet (remembered). The chosen wallet is used for "Add ZETAPHY", "Connect wallet", quantum lock, and Snap mode
    - Snap mode asks `wallet_getSnaps` first. If the wallet is not MetaMask, it tells the user to choose MetaMask
  - "Add ZETAPHY to this wallet": `wallet_addEthereumChain` (EIP-3085), then `wallet_switchEthereumChain`
    - The RPC comes from the RPC field above and must be https or localhost
    - If the wallet refuses (for example 4200 in Binance Wallet or Phantom), it explains why and shows the values for adding it manually
    - The EVM-side symbol is `ZTPHY` because MetaMask and chainlist accept at most 6 characters
  - Shows the values for adding it manually in any wallet: network name, RPC, chain ID, symbol, decimals
  - "Add to Keplr / Leap / Cosmostation": `experimentalSuggestChain(chainInfo)`, then `enable`, and shows the `zetaphy1…` address the wallet returns
    - rpc = `<host>/rpc`, rest = `<host>/rest`, from the same host as the RPC field
  - Mobile: in a wallet app's browser, the wallet appears in the list by itself. If opened from a regular browser, there is an "Open in app" link
  - WalletConnect: the button is disabled until there is a projectId (see the section below)
- 8 languages (English by default): English, 中文, Español, 한국어, 日本語, Русский, Tiếng Việt, ไทย

## Vaccine: never sign transactions to flagged code

Before signing a ZETAPHY send, a token send (checking both the token contract and the recipient), and EVM transactions this page builds for other wallets (quantum lock), the page checks the destination against `ThreatRegistry` (see zetaphy-network/README.md Step 4)
- Reads the code with `eth_getCode` and computes the Neuro fingerprint (`fp1`, the same code as `zetaphy-neuro/src/fingerprint.js`, included in the bundle) and the keccak-256 of the code
- Queries `isFlagged(fp1)`, `isCodeFlagged(codehash)`, and `isAddressFlagged(77390, destination)` (warning), together with `isEnforced` / `isCodeEnforced` / `isAddressEnforced` (enforced: flagged for longer than `enforceDelay`, or through the fast track)
- Proxies (best effort): checks the real code behind a proxy the same way, namely the EIP-1967 implementation slot, the EIP-1967 beacon (and its `implementation()`), and the target of an EIP-1167 minimal proxy, up to 3 levels deep. Other proxy types (custom slots, target chosen at call time) cannot be seen
  - The views queried and the proxy following come from `zetaphy-network/src/vaccine.js` (included in the bundle), the same code ZETAPHY Snap uses to check every transaction in plain MetaMask
- Checks when you click "Check before sending" and checks again when you confirm before signing, both with the key in this page and in MetaMask Snap mode (so the snap is never even asked to sign)
- **Flag enforced: does not sign.** Shows the address, what was flagged (fingerprint / byte-for-byte code / address), and the reason. There is no skip button
  - This includes **newly raised flags that went through the fast track** (runners reached `fastQuorum`, or governance / guardian called `enforceNow`): the registry says they are enforced immediately, so the wallet refuses immediately, not just warns
- **Flagged but not yet enforced: warns** in the confirm box. Sending or not is the user's decision (so a few runners cannot stop the wallet right away, and governance has time to review). If a new flag appears after the check, confirming will not sign and asks you to check again. Quantum lock has no confirm box, so it does not sign for any kind of flag
- **Every warning and refusal shows:** the category as a code fact (for example "in a simulated buy/sell, it could be bought, but could not be sold or returned very little", not an accusing label),
  the evidence (`evidenceOf`: reportHash, URI, and how to re-check with Neuro), responses (`responseAt(key, 0..2)`: kept per author, each shown with the author's address; responders appointed by governance first, then newest first, at most 3, from the flagged key and other keys of the same destination; control/bidi characters removed),
  and the line "Automated code analysis, not an accusation". If the evidence cannot be read, it says so, but that does not let a refused transaction be sent.
  Contract owners can respond or appeal on-chain (zetaphy-network/README.md Step 4). See [`docs/LEGAL.md`](../docs/LEGAL.md)
- The registry address comes from `<meta name="zetaphy-threat-registry">` in `index.html` or from "Advanced settings" under the RPC field (remembered in this browser)
- **Registry set but the check fails** (node does not respond, the address is not a registry): does not sign (fails closed)
- **Registry not set yet**: sending is allowed, but the confirm screen shows a clear warning box "destination code has not been checked yet", so the wallet is usable before there is a registry on testnet
- Not checked: deploy (there is no destination yet; the confirm screen says so) and stake (goes to a precompile, which has no code)

## WalletConnect: next step

There is no WalletConnect SDK in the bundle yet, so the WalletConnect button on the web page cannot connect yet
- The owner must sign up for a **free Reown projectId** at cloud.reown.com and add the wallet's domain to the project's allowlist
- Put the projectId in `<meta name="zetaphy-walletconnect-project-id" content="…">` in `index.html` (or in the "Advanced settings" field on the web page)
  - Once there is a projectId, the button can be clicked, but it still says this is the next step
- **Next step:** add the SDK in `src/entry.js`, then `npm run build` (and commit `vendor/pqwallet.js`), then wire it to the button
- Needed for mobile wallets when this page is opened from another browser, such as Binance Web3 Wallet outside the Binance app

## How keys are stored (security)

- The seed is stored in localStorage **encrypted only**
  - PBKDF2-SHA256 with 600,000 rounds from the password the user types, then encrypted with AES-256-GCM (WebCrypto) (`security.js` `seal` / `unseal`)
- The seed and secret key are in memory only while unlocked. Locking overwrites both `Uint8Array`s with zeros and drops every reference
  (the backup download makes a hex string, which JavaScript cannot wipe: download it only when needed)
- Every signature checks, at the moment of signing, that the wallet is still unlocked (an auto-lock in between refuses it, and nothing is sent)
- The only thing sent out is JSON-RPC to the node the user enters: addresses, balances, and signed transactions. No seed
- MetaMask Snap mode: the web page has no seed at all. It sends MetaMask (through the local `window.ethereum`) only the transaction messages to sign
- No scripts are loaded from a CDN or anywhere else. All code is in `app.js`, `security.js`, `wallets.js` and `vendor/`
- `vercel.json` sets a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`) and `X-Content-Type-Options: nosniff`
  - `connect-src *` because users enter their own node's RPC
  - WebAuthn (passkeys) needs no extra origin in the CSP

### Auto-lock

- After N minutes without keyboard / pointer activity (default 30; 30, 60, 120 or 240 in "Security"), the wallet locks itself:
  the key is wiped from memory and the unlock screen comes back. A countdown under "Lock wallet" shows the time left
- A tab hidden for longer than N minutes locks the moment it is shown again (browsers slow timers down in background tabs)
- "Lock wallet" locks at once. A transaction waiting in a confirm box is dropped by the lock

### Passphrase strength

- New wallets, imported seeds and "Change the passphrase" need **at least 12 characters and a rating of Strong** or better
- The meter under the field is an estimate made in the page (`security.js` `passwordStrength`, no library): length and character classes,
  the 2,000 most common passwords (`vendor/common-passwords.js`, from SecLists, MIT), also in leetspeak, sequences (abc, 321, qwerty),
  repeats, years, and words tied to this wallet ("zetaphy", "wallet", parts of its address). It lists what to fix
- A wallet made earlier with a weaker passphrase still unlocks; the page then suggests changing it ("Change it now"). The change re-checks
  the current passphrase against the stored blob and seals the same seed again

### Unlock with fingerprint / Face ID (passkey, WebAuthn PRF)

- "Turn on fingerprint / Face ID unlock" creates a platform passkey for this site (rpId = the page's own hostname,
  `userVerification: required`, `residentKey: preferred`) with the WebAuthn **`prf` extension**
- The PRF output for a random 32-byte input goes through HKDF-SHA256 (random salt, info `zetaphy-wallet passkey-prf v1 <address>`) to an
  AES-256-GCM key that wraps **the same seed** into a second blob (`zetaphy-wallet:passkey:v1`, bound to the address, credential ID and rpId).
  The passphrase blob stays: the passphrase is always the fallback
- Unlocking calls `navigator.credentials.get` with `prf.eval` and unwraps the seed. The PRF output is never stored; it is zeroed right after use.
  There is no server, so no assertion signature is checked: what protects the seed is that only the authenticator can compute the PRF output,
  and only after your fingerprint, face or device PIN
- Turning it off deletes the blob (and asks the passkey manager to forget the passkey where the browser supports `signalUnknownCredential`;
  otherwise delete "ZETAPHY PQ Wallet" in the device's passkey settings). "Remove the wallet from this browser" deletes it too
- **Passkeys sync.** With iCloud Keychain, Google Password Manager, 1Password and the like, the passkey also exists on your other devices
  signed in to that account. The wrapped seed stays only in this browser's storage, but anyone who controls that account and gets this browser's
  data could unlock it. Protect the passkey account as well as the passphrase
- Browser support for PRF (the page detects it with `PublicKeyCredential.getClientCapabilities()` and the extension results, and says so
  when it is missing, keeping the passphrase):
  - Chrome / Edge 116+ with Google Password Manager or Windows Hello (Windows 11), and on Android
  - Safari 18+ on macOS 15 / iOS 18 with iCloud Keychain
  - Firefox 135+ (desktop) with a provider that supports PRF
  - Some third-party passkey managers and older OS versions create the passkey without PRF: the page then reports "does not support the PRF extension"
    and stores nothing

### Large balances: a safer place for the key

When this page's account holds more than 1,000 ZETAPHY (native balance; staked coins are not counted), a banner suggests moving it.
"Hide for 7 days" hides it for that address in this browser. The in-app "How to" dialog has the same steps:

- **Native PQ account → ZETAPHY Snap (key inside MetaMask):** install MetaMask (Flask until the snap is published) and back up its Secret
  Recovery Phrase; lock this wallet and click "Connect MetaMask"; copy the zetaphy1… address it shows; unlock this wallet again and send the funds there
- **EVM accounts → hardware wallet:** connect a Ledger or Trezor to MetaMask or Rabby, add ZETAPHY Testnet with the buttons on this page,
  send the funds to the hardware account's 0x… address, and confirm every transaction on the device's own screen
- This is testnet: none of it is real money

## Using it with a node

Enter the JSON-RPC address of a ZETAPHY node (port 8545) in the RPC field. There is no default. The browser remembers it
- The web page on Vercel is https, so the RPC must be https too (browsers block http)
  - Nodes installed with `zetaphy-chain/setup-node.sh` (or `cloud-init.sh`) already have https:
    `https://<IP with dots changed to dashes>.sslip.io`, for example `https://1-2-3-4.sslip.io` (ports 80 and 443 must be open)
- The node must answer CORS (preflight `OPTIONS`) for the wallet's domain
- The web page checks `eth_chainId` to confirm it is ZETAPHY testnet (77390) every time before use
- The account exists on-chain only after it first receives funds. Before that it cannot send. The web page will tell you to fund it first

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The web page |
| `security.js` | Passphrase and passkey (WebAuthn PRF) encryption of the seed, and the passphrase strength estimate |
| `vendor/common-passwords.js` | The 2,000 most common passwords (SecLists, MIT licence in the file) for the strength estimate |
| `wallets.js` | Network settings for other wallets (EIP-3085, Keplr chain info) and EVM wallet discovery (EIP-6963), matching `zetaphy-chain/wallets/*.template.json` |
| `vendor/pqwallet.js` | Bundle of `zetaphy-network/src/pqtx.js` + `zetaphy-neuro/src/fingerprint.js` + ML-DSA-44 from `@noble/post-quantum` + `@noble/hashes` (committed, so Vercel does not need to build) |
| `src/entry.js`, `scripts/build.js` | Builds the bundle with esbuild |
| `scripts/serve.js` | Local server, using the same headers as `vercel.json` |
| `test/wallet.e2e.js` | Tests in a real browser (Playwright) |

## Commands

```
npm install
npm run build     # rebuild vendor/pqwallet.js, then commit it
npm run serve     # http://localhost:8090/ (for developers)
npm test          # headless Chromium: create key, encrypt/unlock, send, token send (and refused ones), stake, deploy,
                  # lock a MetaMask account (mock window.ethereum), act on behalf of a locked account,
                  # and MetaMask Snap mode (fake snap behind window.ethereum: wallet_requestSnaps / wallet_invokeSnap) with a mock RPC
                  # other wallets: fake wallets announcing via EIP-6963, Binance Wallet (4200), Phantom, Keplr/Leap/Cosmostation,
                  # disabled WalletConnect, and checks that the page's values match zetaphy-chain/wallets/
                  # vaccine: mock ThreatRegistry; flagged destinations refused before signing (incl. Snap mode), unflagged ones sent, fast-track flags refused immediately
                  # security: passphrase strength (refused / accepted, weak-wallet nudge, change), auto-lock with fake timers (seed zeroed),
                  # passkey unlock with Chromium's virtual authenticator (CDP WebAuthn, hasPrf) and without PRF, the large-balance banner
```

If you edit `zetaphy-network/src/pqtx.js` or `zetaphy-neuro/src/fingerprint.js`, you must `npm run build` and commit `vendor/pqwallet.js` too. CI checks that the committed file matches a fresh build

## Deploy on Vercel (free)

1. Create a new Vercel project from this repo
2. Set Root Directory to `zetaphy-wallet`
3. Nothing else to set: `vercel.json` already turns off the install and build steps
