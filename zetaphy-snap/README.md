**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Snap for MetaMask (`@zetaphy/snap`)

MetaMask can only sign ECDSA. This snap adds a **native PQ account (ML-DSA-44, FIPS 204)** on the ZETAPHY chain for MetaMask users
- The key is created inside MetaMask from the user's Secret Recovery Phrase (SRP). If you have backed up MetaMask, you can recover this account
- A site asking for a signature can only send a "structured message" (send, stake, contract call, deploy, quantum lock handover). The snap builds the transaction itself,
  shows it in plain words in a MetaMask window, and signs only when the user confirms
- The snap does not sign bytes the user cannot read, does not send the seed or secret key anywhere, and signing uses no network (the site sends the transaction to the node)
- **Vaccine in plain MetaMask** (transaction insight): for every EVM transaction on every chain that the user is about to confirm in MetaMask,
  the snap checks the destination against ZETAPHY's `ThreatRegistry`. No ZETAPHY wallet site is needed (see [Vaccine](#vaccine-check-every-transaction-in-metamask))

> **For testnet only, not real money**
> This snap has not been audited yet and is not yet on MetaMask's allowlist (see [Publishing](#publishing-the-real-situation))

## Where the account comes from

```
entropy = snap_getEntropy({ version: 1, salt: "zetaphy-mldsa44-v1" })   // 32 bytes
(publicKey, secretKey) = ml_dsa44.keygen(entropy)                        // @noble/post-quantum
address = sha256("zetaphy/mldsa44\0" || publicKey)[0:20]                 // pqAddress in pqtx.js
```

- `snap_getEntropy` is MetaMask's SIP-6: BIP-32 (secp256k1) from the SRP under `m/1399742832'/…`,
  where the rest of the path comes from keccak256 of the **snap ID** and the salt. Other snaps cannot request this entropy
- **The account depends on the snap ID**
  - `npm:@zetaphy/snap` always gives the same account for the same SRP (reinstalling or moving to another device gives the same account)
  - The development snap (`local:http://localhost:8080`) gets a **different account**. Do not use a local snap for funds you want to keep
  - If the npm package name changes, everyone's account changes
- Never change the salt `zetaphy-mldsa44-v1` (everyone's account would change). If a new scheme is needed, add a v2 alongside it
- If MetaMask has several SRPs, the snap uses the primary SRP (it does not pass `source`)
- The account can be recovered outside MetaMask with SRP + snap ID + salt (SIP-6). The test file computes it this way itself and compares with the snap.
  This means anyone who gets the SRP also gets this account, just like the ECDSA accounts in MetaMask
- The same seed formula (32-byte seed → keygen → address) is used by the CLI and the wallet site:
  seed `0x00..1f` → `0x6DA134EbFcb035273E87954f0641bD920ED073Ba` / `zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r`

## Permissions

| Permission | What it is used for |
|---|---|
| `snap_getEntropy` | Create the ML-DSA-44 key from the SRP |
| `snap_dialog` | Confirmation window before every signature |
| `endowment:rpc` (`dapps: true`, `snaps: false`) | Lets sites call `zetaphy_getAccount`, `zetaphy_signTx`, and `zetaphy_get/setThreatSource` |
| `endowment:transaction-insight` (`allowTransactionOrigin: false`) | Vaccine: checks the destination of every EVM transaction before the user confirms. It does not request the transaction's origin site, because it is not used (sends out as little data as possible) |
| `endowment:signature-insight` (`allowSignatureOrigin: false`) | Vaccine for EIP-712 signatures: checks the contract the signature is for, and the spender / operator / zone / recipient of Permit, Permit2, and Seaport-style orders |
| `endowment:ethereum-provider` | Reads the destination code (`eth_getCode`) and proxy slots (`eth_getStorageAt`, `eth_call` of `implementation()`) through MetaMask itself, only when MetaMask is already on that chain. **Never switches the user's network** (does not call `wallet_switchEthereumChain`). On a different chain = says "couldn't check this chain" |
| `endowment:network-access` | Queries `ThreatRegistry` through ZETAPHY's public RPC with read-only `eth_call` (one batch POST per transaction, and one more to read evidence and responses when there is a flag). Contacts nothing else |
| `snap_manageState` | Remembers the threat source (RPC + registry address) set by the ZETAPHY wallet site (not encrypted, because nothing in it is secret) |

- The key has nothing to do with the network: `snap_getEntropy` is used only when signing. The only part that uses the network is transaction insight
- `snap_manageState` stores only the threat source. It does not store the seed, keys, or transaction history
- `dapps: true` means any site can **request** to connect, but MetaMask asks the user to approve each site (`wallet_requestSnaps`),
  and every confirmation window says which site is asking
- Domains are not restricted yet, because the wallet site's real domain is not final. Once it is final, change it to
  `"endowment:rpc": { "allowedOrigins": ["https://<wallet domain>"] }` before publishing (you must rebuild after changing it)

## API for sites

```js
const snapId = 'npm:@zetaphy/snap';
await ethereum.request({ method: 'wallet_requestSnaps', params: { [snapId]: {} } });
const invoke = (method, params) => ethereum.request({ method: 'wallet_invokeSnap', params: { snapId, request: { method, params } } });

const acct = await invoke('zetaphy_getAccount');
// { publicKey: '0x…' (1312 bytes), address: 'zetaphy1…', hex: '0x…' }  nothing secret
```

### `zetaphy_signTx`

```js
const signed = await invoke('zetaphy_signTx', {
  chainId: 'zetaphy_77390-1',   // must start with zetaphy- (chains other than testnet show a warning in the window)
  accountNumber: '12', sequence: '4',          // from zetaphy_pqAccount
  gasLimit: '400000', gasPrice: '1200000000',  // fee = gasLimit × gasPrice (azetaphy)
  memo: '',                                    // optional, at most 256 characters, no control characters
  lang: 'th',                                  // 'th' or 'en' (window language)
  messages: [{ type: 'send', to: 'zetaphy1…', amount: '1250000000000000000' }],
});
// if the user confirms: { signature, txHex, txHash, bodyBytes, authInfoBytes } (hex)
// if the user cancels: error code 4001, no signature
// then the site sends it itself: zetaphy_sendCosmosTx(signed.txHex)
```

Every number is a decimal string (or a number no larger than 2^53). Bytes are hex `0x…`. The sender is always the snap's account; the site cannot set it.
Unknown fields are rejected (`-32602`) before any window appears.

| `type` | Fields | Window shows |
|---|---|---|
| `send` | `to`, `amount`, `denom?` | Recipient (zetaphy1… and 0x…), amount and denom |
| `delegate`, `undelegate` | `validator`, `amount`, `denom?` | Validator, amount (undelegate has a note about the unbonding period) |
| `withdrawRewards` | `validator` | Validator |
| `evmCall` | `to`, `data?`, `value?`, `gasLimit?`, `asOwner?` | Contract, function (decoded for ERC-20 `transfer`/`approve`/`transferFrom` and the stake/rewards precompiles; if unknown, shows selector + call data with a warning), ZETAPHY sent, EVM gas, `as_owner` |
| `evmDeploy` | `initCode`, `value?`, `gasLimit?`, `asOwner?` | "Create contract", code size and keccak-256 of the code |
| `quantumLock` | `owner`, `controller` | The locked account, the new controller, a warning that control is given up |

At the bottom of the window: maximum fee, gas × price, total your account pays (ZETAPHY amount in the messages + fee; for as_owner it comes out of the locked account), memo, chain id, account number / sequence, the signing account, and the requesting site

- The snap builds the messages with `messageFromIntent` from `zetaphy-network/src/pqtx.js` (the same code as the CLI and the wallet site) before showing the window.
  The window reads values from the built messages and signs that same set of messages
- In `pqtx.js` every message has an `intent` (the same message as JSON), and `pqClient` accepts `signTx` instead of `sign`:
  `client.send({ publicKey, signTx: (req) => invoke('zetaphy_signTx', req), to, amount })`
  `pqClient` checks first as before, then builds the tx itself around the returned signature. If the snap's `txHex` does not match what was requested, it does not send

## Use with the wallet site (`zetaphy-wallet`)

The "Use MetaMask (ZETAPHY Snap)" card on the start page
- The snap ID comes from `<meta name="zetaphy-snap-id">` in `index.html` (default `npm:@zetaphy/snap`). It can be changed in "Advanced settings" during development
- The web page computes the address from the public key itself. It does not trust the address the snap reports
- Send, token send, stake, and deploy are signed through `zetaphy_signTx`. The in-browser key mode (seed encrypted with a password) still works as before

## Vaccine: check every transaction in MetaMask

Before the user confirms any EVM transaction in MetaMask (every chain, every site), the snap shows the ZETAPHY Neuro check result in the snap's tab
1. **Addresses checked (only these):**
   - Transaction: `to` and the addresses the call names: the first argument of `approve` / `increaseAllowance` (the approved spender), `setApprovalForAll` (the operator approved for everything), `transfer` (the recipient),
     the second argument of `transferFrom` / `safeTransferFrom` (ERC-20, 721, 1155: the recipient), and Permit2 `approve(token, spender, …)` (the approved spender)
   - Batch: decodes `multicall(bytes[])`, `multicall(deadline, bytes[])`, and Multicall3 `aggregate` / `aggregate3` (including the targets of the inner calls), then reads the inner calls the same way.
     Other formats (Safe `execTransaction`, Universal Router `execute`, …) are not decoded. The insight says "inner calls not checked" (in Thai and English)
   - Other addresses in the call data are not checked. So a "no flag found" result always lists what was checked, and never says "safe"
   - EIP-712 signatures (`eth_signTypedData_v3/v4`): `domain.verifyingContract` and `spender` (EIP-2612 / DAI Permit, Permit2), `operator`, `zone`, and the recipients in `consideration`
     (Seaport-style orders) on `domain.chainId`. The signer's address (and offerer) is not sent out. `personal_sign` has no insight
2. **On the transaction's chain** (through the snap's `ethereum.request`, only when MetaMask is on that chain; it does not switch networks): reads the code of each destination, then follows to the real code behind proxies of type EIP-1167 (and the PUSH0 form), EIP-1967 implementation, and beacon, up to 3 levels
   - MetaMask on a different chain: the code cannot be read. It still asks about flags on the address. If no flag is found, it shows "couldn't check this chain" (in Thai and English) (it does not say there is no flag)
   - Uses the same code as the wallet site: `zetaphy-network/src/vaccine.js` (`proxyTargets`, `threatQueries`)
3. **Ask ZETAPHY** with a single JSON-RPC batch: `eth_chainId` (must be 77390), then `eth_call` to `ThreatRegistry` for each destination, at both the warning and enforced levels
   - `isAddressFlagged` / `isAddressEnforced(chainId of the transaction, address)`
   - `isCodeFlagged` / `isCodeEnforced(keccak256(code))`
   - `isFlagged` / `isEnforced(fp1)`: the Neuro fingerprint (`fp1`) is computed inside the snap (a copy of the formula from `zetaphy-neuro/src/fingerprint.js` in `vaccine.js`, without pulling in the whole bytecode reader; tests compare it with Neuro's byte for byte)

4. **Only when there is a flag**, ask another batch: `evidenceOf(key)` for each flag (reportHash and URI) and `responseAt(key, 0..2)` for every key of that destination
   (responses are kept per author and shown with the author's address; responders appointed by governance first, then newest first, at most 3)
   If this query fails, it still warns as before and says the evidence could not be read

Every flag shows its category as a code fact (not an accusing label), the evidence and how to re-check it, responses (if any, with the author's address), and the line
"Automated code analysis, not an accusation" (in Thai and English). Contract owners can respond or appeal on-chain
(zetaphy-network/README.md Step 4). See [`docs/LEGAL.md`](../docs/LEGAL.md)

Results shown in MetaMask (Thai and English together, because the insight does not know the user's language):

| Result | Shown |
|---|---|
| Flag already enforced (past `enforceDelay` or through the fast track) | Level `critical`: MetaMask asks for an extra confirmation, with a warning, the address, the reason, and what was flagged (address / code / fp1 / code behind proxy) |
| Flagged but not yet enforced | A warning box, not critical |
| Not flagged | "no flag on what was checked" (in Thai and English) with the list of addresses checked, saying that only the destination and the spender/recipient named by the call were checked, and "inner calls not checked" if any |
| Could not check (RPC down, RPC is not ZETAPHY, registry not set yet, could not read code on that chain, MetaMask on a different chain) | "ZETAPHY Neuro couldn't check this transaction" and the reason (does not say safe) |
| Contract creation (no `to`) | Says there is no destination to check |

- If the code cannot be read but the address is flagged, that flag is still shown
- When using a threat source set by the wallet site (`zetaphy_setThreatSource`): **every insight says so**, with the RPC and registry address
- The snap does not reject transactions itself (insight cannot). The final decision is the user's. This differs from the ZETAPHY wallet site, which does not sign at all when a flag is enforced

### Privacy (data sent out)

- **Before the user confirms**, the snap sends **the addresses checked (destination, spender, recipient), chain id, code hash (keccak-256), and fp1** to the ZETAPHY RPC.
  That RPC provider therefore sees **the destination address, chain id, time, and the user's IP** before confirmation
- It **does not send** the user's address, amounts, the full call data, or the origin site (`allowTransactionOrigin: false`, `allowSignatureOrigin: false`)
  **But it can be linked back:** once the transaction lands on-chain, the destination, chain, and time the RPC saw can be matched to that transaction, and so to the user's account (and the IP to that account).
  The same applies to signatures if they are used on-chain. Users who do not want this should use a ZETAPHY RPC they trust (or their own), or turn the snap off
- Reading code on the transaction's chain goes through the RPC that MetaMask already uses
- If you don't want to send this: turn off the snap's permission in MetaMask or do not install the snap (the wallet site's signing is not affected)

### Threat source (RPC and ThreatRegistry)

- Build-time values are in `snap.config.js` (`environment`). **They are currently placeholder values that do not work yet**: RPC `https://rpc.zetaphy.invalid`, registry `0x000…0`.
  So every transaction shows "could not check: no ThreatRegistry configured" until the owner puts in real values and rebuilds (the shasum changes, so the manifest must be committed)
- The ZETAPHY wallet site can change the source with `zetaphy_setThreatSource`, only from an origin in `ZETAPHY_WALLET_ORIGINS` (default `https://wallet.zetaphy.invalid`; put in the real domain once known),
  and the user must confirm in a MetaMask window every time. Other sites get error 4100

```js
await invoke('zetaphy_setThreatSource', { rpc: 'https://<ZETAPHY RPC>', registry: '0x<ThreatRegistry>' }); // or { reset: true }
await invoke('zetaphy_getThreatSource'); // { rpc, registry, overridden } wallet site origin only; other sites get error 4100
```

- `zetaphy_getThreatSource` can be read only by the wallet site: the value is not secret, but the fact that a user set their own source is data that can identify (fingerprint) the user, so other sites are not allowed to read it
- The RPC must be `https://` (except `http://localhost` / `127.0.0.1` during development), at most 256 characters, with no user:password in the link
- The wallet site does not yet call `zetaphy_setThreatSource` automatically (for now, call it yourself or set the values at build time)

## Commands

```
npm ci
npm run build     # mm-snap build: dist/bundle.js and the shasum in snap.manifest.json (commit the manifest)
npm test          # Jest + @metamask/snaps-jest: runs dist/bundle.js in a simulated MetaMask (build first)
npm run serve     # serves the snap at http://localhost:8080 for MetaMask Flask (snap ID local:http://localhost:8080)
```

- `dist/` is not committed, but `snap.manifest.json` is. CI rebuilds and checks that the shasum in the manifest matches.
  If you edit `src/`, `snap.config.js`, `zetaphy-network/src/pqtx.js`, or `zetaphy-network/src/vaccine.js`, you must `npm run build` and commit the manifest too
- The `@noble/*` packages that `pqtx.js` imports are resolved from this package's `node_modules` (`snap.config.js`, `test/resolver.js`),
  so the bundle depends only on this `package-lock.json`
- `package.json` has `overrides` pinning `@metamask/snaps-utils` 12.6.0, `snaps-controllers` 21.1.1, `snaps-execution-environments` 11.3.1,
  because the next releases (Oct 2026) use `@metamask/utils` 12, which is ESM-only, so Jest (CommonJS) cannot load snaps-jest

### What is tested (`test/snap.test.js`)

- Address formula: seed `0x00..1f` gives the known value, through the `accountFromSeed` function the snap actually uses
- `zetaphy_getAccount` equals ML-DSA-44 of the SIP-6 entropy computed independently from SRP + snap ID + salt; the same SRP gives the same account, a different SRP gives a different account; no part of the secret key is in the response
- Window text for every type: send (and other denoms, other chains), delegate/undelegate/rewards, evmCall (ERC-20, unknown function, unlimited approve, plain transfer), as_owner + stake precompile, deploy, handover, multiple messages, Thai language
- Cancel: error 4001, no signature
- The signature verifies with `ml_dsa44.verify` on a SignDoc rebuilt with `cosmjs-types`, and the messages decode correctly
- 31 kinds of malformed input are rejected with `-32602` before any window; an unknown method gets `-32601`

`test/insight.test.js` (vaccine: the transaction's chain is mocked with `snap.mockJsonRpc`; the ZETAPHY RPC is a small JSON-RPC server on 127.0.0.1)
- `fp1` in the snap equals zetaphy-neuro's `codeFingerprint` byte for byte
- Defaults (no registry yet): "could not check"
- `zetaphy_setThreatSource`: other origins get 4100, malformed input gets -32602, cancel gets 4001; once set, `getThreatSource` sees it (wallet site only, other sites 4100); `reset` returns to defaults
- Not flagged: "no flag on what was checked" with the list checked, sends one batch, and what is sent is only the destination address, chain id, code hash, and fp1 (no user address)
- Call data: recipient of `transferFrom` / `safeTransferFrom` (second argument), spender of Permit2 `approve`, operator of `setApprovalForAll`, decoding `multicall` / `aggregate3`, `execute` says "inner calls not checked", malformed call data says so too
- No network switching: MetaMask on a different chain = "couldn't check this chain", and `wallet_switchEthereumChain` is never called (an address flag still shows critical)
- A custom threat source is shown in every insight (not flagged, warning, enforced, could not check); build-time values are not shown
- Multiple responses: shown with the author's address, responders appointed by governance first
- Signature insight: a flagged Permit spender = critical, Permit2 (v3) = warning, Seaport-style orders check zone and recipients and do not send the signer's address, no chain id or a different chain = could not check (no chain switching), `personal_sign` has no insight
- Enforced flags (address, code hash, fp1): `critical` with Thai/English reasons; flags not yet enforced: warning, not critical
- A flagged spender in `approve`: critical; reading destinations from call data (approve, setApprovalForAll, transfer, increaseAllowance)
- Proxies: EIP-1167, EIP-1967 implementation, beacon pointing to flagged code = critical; the same proxy in front of clean code = not flagged
- Could not check: RPC returns 500, RPC is not ZETAPHY, could not read code on-chain (but a flagged address still shows critical)
- Jest runs test files one at a time (`maxWorkers: 1`) because snaps-jest uses fixed port 18096

Not testable on this machine: the real window in MetaMask Flask (snaps-jest checks the UI structure but does not actually render it), and sending a snap-signed transaction to a real chain
(the same transaction formula has been tested against a real chain in `zetaphy-network/test/devnet.pq.integration.js`)

## Publishing (the real situation)

- **Right now it can be installed only in MetaMask Flask** (the developer build), from `npm run serve` (snap ID `local:http://localhost:8080`),
  or from npm after it is published
- Regular MetaMask (not Flask) can install it only once the snap is **published on npm and on MetaMask's allowlist**,
  because `snap_getEntropy` and `endowment:rpc` are protected permissions that require review
- Publishing on npm requires the project owner's npm account. **The owner must do this themselves** (this code does not have, and should not have, an npm token)
- The allowlist requires review by the MetaMask team (at least two people), and because the snap uses `snap_getEntropy` (key management),
  **it needs an audit report from an external firm approved by MetaMask** (the list is at https://github.com/MetaMask/snaps/wiki/Audits), which costs money.
  The audit report will be made public, and every new version must apply to the allowlist again

### Steps for the project owner

1. **npm account**: sign up at https://www.npmjs.com, turn on 2FA, then create an organization named `zetaphy` (free for public packages)
   - If the name `zetaphy` is taken, use your own scope and update the name to match everywhere: `name` in `package.json`,
     `source.location.npm.packageName` in `snap.manifest.json`, `<meta name="zetaphy-snap-id">` in `zetaphy-wallet/index.html`,
     and `DEFAULT_SNAP_ID` in `zetaphy-wallet/app.js` (the package name is part of the snap ID: changing it after there are users changes their accounts)
2. **Domain** (recommended): once the wallet site's real domain is known, change `endowment:rpc` to `allowedOrigins` (see the Permissions section)
3. **Version**: set `version` in `package.json` and `snap.manifest.json` to match, then
   ```
   cd zetaphy-snap
   npm ci
   npm run build && npm test
   git add snap.manifest.json && git commit    # new shasum (CI checks it)
   ```
4. **Check the files to be published**: `npm pack --dry-run` must contain only `dist/bundle.js`, `images/icon.svg`, `snap.manifest.json`, `package.json`, `README.md`
5. **Publish**: `npm login`, then `npm publish --access public` (`prepublishOnly` builds and checks the manifest once more)
   - After publishing, that name+version cannot be changed. To change it, release a new version
6. **Test in Flask**: open the wallet site in MetaMask Flask and click "Use MetaMask (ZETAPHY Snap)" (snap ID `npm:@zetaphy/snap`).
   Try send, stake, and deploy on testnet, and check the text in the window
7. **Request the allowlist** (if you want it usable in regular MetaMask):
   - Put the real vaccine values in `snap.config.js` (ZETAPHY RPC, ThreatRegistry, wallet site domain), then rebuild
   - Remove logs and unused permissions (none right now), and scan with [Snapper](https://github.com/sayfer-io/Snapper)
   - `endowment:network-access`, `endowment:ethereum-provider`, `endowment:transaction-insight`, and `endowment:signature-insight` must be explained in the allowlist request (see the permissions table and the Privacy section)
   - Hire an auditor from MetaMask's list to audit the snap's `src/` and `zetaphy-network/src/pqtx.js` with `@noble/post-quantum` (the key management modules).
     Fix every finding of medium or higher, and keep the audited commit and the fix commits
   - Fill in the form at https://go.metamask.io/snaps-directory-request (the name must match `proposedName`, which is "ZETAPHY Post-Quantum",
     and must not contain the words MetaMask, Snap, Meta, Mask). Attach the audit report, GitHub and npm links, support contact details, and demo images and video
   - Every new version must be submitted through https://go.metamask.io/snaps-directory-update-request
8. Once on the allowlist, update the "can be installed only in MetaMask Flask" text in the wallet site (`snapFlask` in `app.js`)

## Files

| File | What it is |
|---|---|
| `src/index.jsx` | `onRpcRequest`: `zetaphy_getAccount`, `zetaphy_signTx`, `zetaphy_get/setThreatSource`; `onTransaction` (vaccine) |
| `src/threats.js`, `src/insight.jsx` | Vaccine: destinations, reading code/proxies on that chain, querying ThreatRegistry, and the view shown in MetaMask |
| `../zetaphy-network/src/vaccine.js` | Shared with the wallet site: registry views, proxy following, fp1 |
| `src/account.js` | seed → ML-DSA-44 → address (same formula as the CLI and the wallet site) |
| `src/request.js` | Strict validation of `zetaphy_signTx` parameters |
| `src/describe.js`, `src/dialog.jsx` | Confirmation window text (Thai/English) and rendering |
| `src/pqtx.js` | re-export of `zetaphy-network/src/pqtx.js` |
| `snap.manifest.json`, `snap.config.js`, `images/icon.svg` | manifest (shasum), build, icon |
| `test/snap.test.js`, `test/insight.test.js`, `jest.config.js`, `test/resolver.js` | Tests with snaps-jest |
