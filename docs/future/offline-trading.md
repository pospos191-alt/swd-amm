# Offline trading: signed cheques and offline swap orders

**Testnet only.** No real money. The contracts have not been audited.

This lets people pay and trade on ZETAPHY while they have no internet. Each feature needs the network only at the
start (to set up) and at the end (to settle). Everything in between works with no network: signing, passing a
QR code or text, and checking.

| | Online once | Offline | Online again |
|---|---|---|---|
| **Cheques** (`ZetaphyCheques`) | payer opens a channel: deposit + a dedicated offline signer key | payer signs cheques; payee checks them | payee cashes the best cheque; payer takes the rest back after expiry |
| **Swap orders** (`ZetaphyOfflineOrders`) | maker approves the orders contract for the token | maker signs an order; anyone checks it | anyone relays it (fills it on ZETAPHY Swap) and earns the fee |

In the hub, all of this is on the **Offline** tab (`zetaphy-hub/offline.js`). Bonded bearer notes passed hand to hand, and
frames for SMS / LoRa / QR, are in [Offline Cash and Mesh](offline-cash.md).

## 1. Cheques: one-way payment channels

`zetaphy-network/contracts/ZetaphyCheques.sol`

- `open(payee, token, amount, expiry, signer)`. `token` 0 means native ZETAPHY, sent as `msg.value`.
  `signer` is the key whose cheques count: a dedicated key, not the payer's wallet.
  The hub creates this key in the browser.
- `topUp(id, amount)` and `extend(id, expiry)`: payer only, and only before closing starts.
- **Cheque** = EIP-712 `Cheque(uint256 channelId, uint256 cumulativeAmount)`. The domain is
  `ZETAPHY Cheques` / `1` with the chain id and the contract address. The amount is the running **total** promised
  to the payee, so each new cheque replaces the previous one.
- `cash(id, cumulative, sig)`: anyone may submit it, but the money always goes to the payee. It pays
  `min(cumulative, deposit) − paid`. It never pays more than the deposit. If the payer tops up later, the same
  cheque can pay the rest.
- `startClose(id)`: payer only, from the expiry onwards. It starts a **24-hour challenge window**. During that
  window the payee can still cash. After it, `withdraw(id)` gives the payer the rest.
- `release(id)`: the payee gives up the rest early, so the payer can withdraw at once. Cash first.
- Security: there is no owner and no fee. Every entry point is `nonReentrant`, and state changes before any transfer
  (CEI). ERC-20 calls accept tokens that return nothing but refuse `false`, reverts and addresses with no code.
  **Fee-on-transfer tokens are refused**: the contract measures the balance it received. Signatures must be 65 bytes
  with low `s` and `v` = 27/28 (0/1 accepted), so they cannot be malleated.

### What the payee checks offline (`zetaphy-hub/offline-core.js` `verifyCheque`)

The payee checks against its own snapshot of the channel, read from the chain at its last sync. It never trusts
what the cheque claims about the channel. A cheque is accepted only if all of these hold:

- the signature recovers to the channel's `signer`;
- the chain id and the contract match;
- the total is **higher** than the best cheque this device already holds, and higher than what was already paid;
- some of the new amount is within the **deposit as of the last sync**. The page shows that time, the expiry and
  the "cash by" time (expiry + 24 h).

There are also warnings for these cases: the total is above the deposit, the channel expires within an hour or
has expired, the sync is more than a day old, or the channel pays someone other than the connected wallet.

## 2. Offline swap orders

`zetaphy-network/contracts/ZetaphyOfflineOrders.sol`

- EIP-712 `Order{maker, tokenIn, tokenOut, amountIn, minAmountOut, deadline, nonce, relayerFee}`. The domain is
  `ZETAPHY Offline Orders` / `1` with the chain id and the contract address.
- `fill(order, sig, path)`: anyone may call it. It does these steps in order:
  1. Pulls exactly `amountIn` from the maker. This needs an approve first, or an EIP-2612 permit through
     `fillWithPermit`. Fee-on-transfer tokens are refused.
  2. Swaps on the ZETAPHY Swap router with `amountOutMin = minAmountOut + relayerFee`.
  3. Pays the maker everything except the fee, and checks the maker really received at least `minAmountOut`.
  4. Pays the caller the fee.

  There are no partial fills. The relayer may choose the route (`path`, at most 3 hops, empty means the direct
  pool), but the maker's minimum still holds.
- `tokenOut = 0` means native ZETAPHY: the coins are unwrapped. To **sell** native ZETAPHY offline, use the wrapped
  coin (on chain 77390, the native ERC-20 at `0xEeee…EEeE`, shown as `ZTPHY*` in the hub).
- Replay protection is a per-maker **nonce bitmap**. The maker can cancel nonces with `cancel(nonce)` or
  `cancelWord(wordPos, mask)`. A failed fill does not use up the nonce.
- No owner. The router is fixed in the constructor.

**Why not reuse `IntentExecutor`?** We read it and decided against it. Its SWAP intents make the maker sign the
list of solver call targets, so the maker would have to know the router and the plan offline. It has no relayer
fee paid out of the output, and its nonces are a plain mapping rather than a bitmap. A small dedicated contract with
the router fixed is easier to check and easier to sign offline.

## 3. The hub's Offline tab

- **Offline key**: a secp256k1 key made in the browser. It is stored only **encrypted**: AES-GCM-256 with a key
  from PBKDF2-SHA256 (600,000 iterations; at least 310,000 is required to decrypt). The key's address is bound as
  AES-GCM additional data. The passphrase must be at least 10 characters. The key stays unlocked in memory only,
  and locks itself after 15 minutes. You can export and import the encrypted backup. Every read and write of storage
  is in try/catch.
- **QR codes**: drawn by `zetaphy-hub/vendor/qrcode.js`, which is `qrcode-generator` 2.0.4 (MIT). It is pinned by
  sha256 in `vendor/qrcode.json` and served from the site (no CDN). Each payload can also be copied as text
  (`ZCHQ1:` / `ZORD1:` + base64url JSON) or downloaded as a `.txt` file.
- **Scanning**: on browsers that have `BarcodeDetector`, you can pick a photo of the QR code (on a phone, take one
  with the camera). Elsewhere, paste the text or open the file. There is no QR decoder library, and no live camera,
  so the site's `camera=()` permission policy stays as it is.
- **Relay orders**: the page checks the order offline. Online, it then checks that the nonce is unused and runs a
  free `eth_call` of `fill` as a simulation. Submitting sends the fill from your connected wallet, through the hub's
  normal signing summary.
- **Service worker** (`zetaphy-hub/sw.js`): registered the first time the Offline tab is opened. It caches **only
  the static app shell**: the hub's own scripts, styles and icons, `hub-config.json` (public addresses), the QR
  encoder and the wallet bundle. `build.mjs` writes this list and a version hash. It never caches POST requests,
  other origins (the RPC) or `/api/`. It fetches from the network first, so online you always get the current
  files. The CSP now says `worker-src 'self'`. While the browser is offline, an "Offline" pill shows in the top bar.

## Threat model and limits

| Risk | Who | What protects / what does not |
|---|---|---|
| Payer signs more cheques than the deposit | payee | The payee counts only up to the deposit **as last synced**. The hub refuses to sign over the deposit. |
| Payer closes the channel to dodge a cheque | payee | Closing needs the expiry **and** a 24 h window in which the payee can still cash. A payee offline for more than a day after expiry can lose unpaid cheques. **Cash before expiry.** |
| Double spend across payees | payee | Impossible: each channel has one payee and its own deposit. |
| Stale snapshot | payee | The deposit never goes down before closing, but the channel may have started closing since the last sync. The page shows the "as of" time and warns when it is more than a day old. |
| Offline key stolen with its passphrase | payer | The thief can sign cheques up to the deposit, only to that channel's payee. Use a strong, unique passphrase. Keep deposits small. |
| Passphrase lost | payer | No more cheques can be signed. The deposit minus what was cashed still comes back after expiry + 24 h. |
| Browser storage cleared | both | Without the exported backup, the key is gone. The payee also loses unsaved cheques, so download the cheque file. |
| The same key on two devices | payer | Each device counts its own running total. A cheque from the device that is behind repeats a total the payee already holds, so the payee refuses it ("not newer"). Nobody loses money, but the payment fails. Sign from one device at a time. |
| Malicious QR / text | both | Strict parsing: size limit, fixed prefix, regex-checked fields. All text is shown with `textContent`. Nothing is executed. |
| Order replay | maker | The nonce bitmap. The EIP-712 domain binds the chain and the contract. |
| Relayer front-runs or picks a bad route | maker | Only `minAmountOut` (after fee) is promised. It is checked on what the maker actually received. Set it carefully, because the market can move while the order travels. |
| Order you no longer want | maker | Cancel its nonce online. Until then, **anyone holding the text can fill it**. |
| Order signed with the offline key | maker | Only that key's address can cancel. The hub cannot send transactions from it. Prefer signing orders with your wallet. |
| Fee-on-transfer / re-entering tokens | all | Refused (balance measured) and `nonReentrant`. Both are tested with malicious tokens. |
| Contract bugs | all | **Not audited. Testnet only.** |

## Deploying (testnet)

```
cd zetaphy-network
ZETAPHY_RPC=https://… KEYFILE=./testnet-key.hex node scripts/offline-deploy.js [--router 0x…]
node scripts/offline-deploy.js check
```

`scripts/offline-deploy.js` (`src/offlinedeploy.js`) deploys both contracts. Neither has an owner, so the deploy
key keeps no role. It refuses any chain except 77390. The router defaults to the ZETAPHY Swap router in
`zetaphy-dex/web/deployments.json`. The script writes `zetaphy-network/deployments/offline-77390.json`, and a re-run
resumes from there. `zetaphy-hub/build.mjs` reads that file, so after the next hub build the Offline tab uses the
addresses. Until then, the tab says the contracts are not deployed, but the offline key, cheque checking and order
signing still work.

## Tests

- `zetaphy-network/test/offline.test.js` covers both contracts:
  - happy paths, replay, wrong signer, high `s`, bad `v`, other channel, contract or chain;
  - a cheque over the deposit, then a top-up; the challenge window, expiry, release and extend;
  - cancel and `cancelWord`, the deadline, the minimum out, native out, WZETAPHY in, permit;
  - fee-on-transfer tokens refused; re-entry through a hook token and through a payee's `receive()`.

  It ends with an end-to-end run on `rpcchain`: the DEX artifacts and real signed transactions, with the hub's own
  key encryption, signing, payloads and checks.
- `zetaphy-hub/test/offline.test.mjs` checks:
  - EIP-712 hashes and calldata against ethers;
  - signatures and recovery, and the payload round trip;
  - the offline checks and the encrypted key;
  - all 8 languages, and the app-shell list.
- `zetaphy-hub/test/offline.e2e.mjs` runs Playwright with the site's CSP. After one visit it calls
  `context.setOffline(true)` and reloads. The hub then comes from the service worker, and the tab can still:
  - unlock the key and sign cheques (QR code and text);
  - check them as the payee: valid, newer only, nothing over the deposit;
  - sign and check a swap order.
