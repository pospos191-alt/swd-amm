**English** | [ภาษาไทย](crosschain-assist.th.md)

# Cross-chain security and assistants (testnet)

Workstream `fut-crosschain`. Eight items: the Neuro cross-chain security oracle (18), herd immunity (28),
"Neuro-checked" certificates (19), quantum-safe AI attestations (30), parametric hack insurance (32), the pre-sign
assistant (20), the governance assistant (21) and the validator assistant (22).

Everything here is **testnet only**. Nothing holds real money. Nothing needs an always-on server: the work happens in
contracts, in the browser (the hub), on runners and validators people already run, or in GitHub Actions.

| # | Item | Status | Where |
|---|---|---|---|
| 18 | Neuro cross-chain security oracle | **Built and tested on local chains**. EVM testnet deploy waits for 1 November. Osmosis has a working contract and memo path, not deployed | `contracts/NeuroOracle.sol`, `src/neurooracle.js`, `scripts/neuro-oracle.js`, `scripts/saphan-dryrun.js --neuro-oracle`, `.github/workflows/neuro-oracle.yml`, `cosmwasm/neuro-oracle-osmo/` |
| 28 | Herd immunity + coverage per chain | **Built**: the pusher and the coverage meter (CLI and hub). Shows "not deployed" until 18 is deployed | `src/neurooracle.js`, `zetaphy immune push/coverage`, hub **Immunity** tab |
| 19 | "Neuro-checked" certificate | **Built**: contract, CLI, DEX `--attest`, wallet bar and swap page badge, hub lookup. Not deployed yet | `contracts/NeuroAttest.sol`, `zetaphy certify`, `zetaphy-dex/cli.js deploy --attest`, `walletbar.js`, `zetaphy-dex/web` |
| 30 | Quantum-safe AI attestations | **Built**: ML-DSA-44 archive, on-chain anchor, CLI verifier, browser verifier, tamper tests | `zetaphy-hub/pqattest.js`, `src/pqattest.js`, `contracts/NeuroAttest.sol` (`NeuroAnchor`), `zetaphy attest-pq` |
| 32 | Parametric hack insurance (testnet) | **Prototype contract with tests**. Not deployed. The replay tool that makes the forensic report is not part of this workstream | `contracts/HackInsurance.sol` |
| 20 | Pre-sign assistant | **Built**: a simulation of balance changes on a real ZETAPHY node (state-override probe) and an optional AI explanation | `zetaphy-hub/presign.js`, `tools/PresignProbe.sol`, `wallet-safety.js` (`simulate` / `explain`) |
| 21 | Governance assistant | **Built**: proposals and the timelock queue, decoded, simulated and flagged, in 8 languages | `zetaphy-hub/govassist.js`, hub **Governance** tab |
| 22 | Validator assistant | **Built**: `zetaphy-validator status` diagnostics with plain-language advice | `zetaphy-chain/join-validator.sh` (`diagnose`, `jail_eta`) |

Paths without a folder are under `zetaphy-network/`.

---

## 18 · Neuro cross-chain security oracle

### What was built

```
ZETAPHY                                                       Sepolia / Base Sepolia / Arbitrum Sepolia
ThreatRegistry (runner quorum) ─┐
NeuroJobs (settled verdicts) ───┴─ read by NeuroOracleSender ── Hyperlane ──▶ NeuroOracle (DEXes call check(token))
                                         │                  verified by OUR validators' multisig ISM (as Saphan)
                                         └── ICS-20 + memo (ibc-hooks) ──▶ CosmWasm neuro-oracle-osmo (osmo-test-5)
```

- **`NeuroOracleSender`** (ZETAPHY) holds no key and makes no decision.
  - `push(domain, keys)` reads the current state of each ThreatRegistry key: round, flagged, reason, `enforcedFrom`, `heldFrom`. It then dispatches that state through ZETAPHY's Mailbox to the `NeuroOracle` governance registered for that domain.
  - Anyone can call it and pays the Hyperlane quote. Any amount above the quote is sent back.
  - The caller cannot send a false message, because the contract reads the contents itself.
  - `pushVerdict(domain, jobId)` relays a settled NeuroJobs verdict: 2-of-3 runners agreed and no challenge is open or still possible.
  - `pending(domain, keys)` tells which keys a destination still lacks.
  - `snapshot(start, n)` pages through the registry's flag history; the coverage meter uses it.
- **`NeuroOracle`** (each EVM testnet) uses the same pattern as `HyperlaneLockBoxV2`:
  - `handle` accepts only the configured Mailbox, origin ZETAPHY and the one sender.
  - Its `interchainSecurityModule()` is the multisig ISM of **our** validators (`zetaphyValidators` in `saphan-chains.json`), made by the chain's Hyperlane factory.
  - Each key keeps the newest state by the registry's round. The round goes up on every flag and every clear, so an old or replayed message cannot roll a key back.
  - A fast-lane enforcement (`enforceNow`) keeps the same round but moves enforcement earlier, and the mirror applies that too.
  - DEX views:
    - `check(token)`: is the token's address on this chain flagged, or its code (the same `addressKey` / `codeKey` as the registry)?
    - `isFlagged(fp1)` / `isEnforced(fp1)`: the same for Neuro's fingerprint.
    - `verdictOf(chain, target)`: the relayed NeuroJobs verdict.
  - Roles: governance is the chain's v2 timelock. Guardians can pause. While paused, deliveries wait at the Mailbox and the views answer "not flagged". That fails open, so a DEX keeps working, and `paused()` tells it the mirror is not current.
- **Osmosis.** An ICS-20 memo cannot run anything on Osmosis without a contract, so we use **ibc-hooks plus a small CosmWasm contract**:
  - `pushIbc(keys)` calls ZETAPHY's ICS-20 precompile (`0x…0802`). It transfers 1 azetaphy with a memo built on chain from the registry: `{"wasm":{"contract":…,"msg":{"mirror":{"src_chain":77390,"items":[…]}}}}`.
  - Osmosis' ibc-hooks runs that message with a sender derived from (Osmosis' channel, our sender's `zetaphy1…` address).
  - The contract (`cosmwasm/neuro-oracle-osmo`) accepts only that derived sender, `src_chain` 77390 and 64-hex keys. It applies the same newest-round rule and has `pause` and `admin`.
  - The derivation is implemented in `ibcHooksSender()`.
  - The trust is Osmosis' IBC light client of ZETAPHY plus our contract. No committee is involved.
  - We chose this over interchain accounts (ICA). ICA needs ZETAPHY's ICA controller and a controller-side owner key or governance per message. ibc-hooks needs neither.

### Deployment (saphan-route style)

- `scripts/neuro-oracle.js`:
  - `check --chain <name>`: read only.
  - `sender`: on ZETAPHY.
  - `receiver --chain <name> --sender 0x…`: our ISM through the factory, then NeuroOracle with the chain's v2 timelock and multisig, or new ones made the way `origin-prepare` makes them.
  - `wire --sender 0x… --receivers a=0x…,b=0x…`: sets the routes, then hands governance to the ZETAPHY timelock.
  - `coverage`.
- `.github/workflows/neuro-oracle.yml` has the modes **check** and **dry_run** only. On pull requests it runs dry_run for Base Sepolia.
- **The deploy is after 2026-11-01.** It has three steps (sender, receivers, wire), and the result goes into `zetaphy-chain/hyperlane/neuro-oracle.json` as `{ sender, receivers: { <chain>: { oracle } } }`. The hub reads that file. A `deploy` mode will be added then. It needs the `testnet-deploy` environment, as in `saphan-route.yml`.
- **The relayer must whitelist the sender:** `{ originDomain: 77390, senderAddress: <sender>, destinationDomain: <chain> }` in `HYP_WHITELIST` (`src/saphan.js relayerWhitelist` needs this entry added once deployed). Otherwise our validators sign the messages but nobody relays them.
- Osmosis:
  1. Build the wasm with `cosmwasm/optimizer` (the code needs no feature beyond `cosmwasm-std` 2.1).
  2. Upload it to osmo-test-5.
  3. Instantiate with `hook_sender = osmosisd q ibc-hooks wasm-sender <osmosis channel> <zetaphy1… of the sender>`. Compare that result with `ibcHooksSender()` before trusting either.
  4. On ZETAPHY, governance calls `setIbcRoute("channel-N", "osmo1…", 600)`.
  5. The IBC channel to osmo-test-5 is the Saphan Osmosis route (`zetaphy-chain/ibc`, `ROUTE=osmosis`).

### Tests

- `test/neurooracle.test.js`: 10 tests on the in-memory EVM. Messages are signed as Hyperlane checkpoints and processed by a Mailbox that checks a message-id multisig ISM. They cover:
  - warn and enforce timing
  - `check(token)` by address and by code
  - refusals: forged signer, 1 of 2, replay, foreign sender, other origin, direct call
  - out-of-order delivery
  - fast lane
  - pause
  - verdicts
  - coverage
  - the IBC memo and the ibc-hooks sender
  - roles
- **Dry run on two real local chains.** `node scripts/saphan-dryrun.js --chain basesepolia --neuro-oracle --kit` ran against two `zetaphyd` devnets (chain ids 77390 and 84532, `scripts/devnet.sh`). The kit Mailbox and ISM stand in for Hyperlane core. It prints `NEURO ORACLE DRY RUN OK`, including the refusals and 100.0% coverage. Without `--kit` it uses the real Mailboxes and ISM factory, which is the workflow's dry_run. That path was **not run here**, because it needs anvil and the Hyperlane CLI, which this environment does not have.
- `cargo test` in `cosmwasm/neuro-oracle-osmo` (`npm run test:cosmwasm`), 3 tests: sender check, newest-round rule, pause, key format, and parsing the memo ZETAPHY builds.

### Limits

- A DEX on another chain must **choose** to call `check(token)`. We cannot make Uniswap call it.
- On a pause the mirror fails open (it answers "not flagged"). This keeps DEXes working when our validators are compromised, at the cost of protection during the pause.
- The mirror is only as current as the last push. See 28 for how fast that is.
- The ICS-20 path spends 1 azetaphy per message. If the Osmosis execution fails, the transfer is refunded and the message is lost. The pusher does not track IBC deliveries; resend with another `pushIbc`.
- The wasm build was not checked for size or for `cosmwasm-check` here (only native tests ran), and the contract is not on osmo-test-5.

---

## 28 · Herd immunity

### What was built

- **The pusher:** `zetaphy immune push --sender 0x… [--once] [--interval 30] [--max-fee 0.1]`. A runner can run it next to `zetaphy node start`, or a GitHub Actions schedule can run it with `--once`.
  - The first round pushes every currently flagged key.
  - Later rounds read only the registry events since the last block (`Flagged`, `Cleared`, `FastEnforced`, `HeldNow`, `Protected`).
  - For each route it pushes the keys that are still `pending`, in batches of 32.
  - A fee above `--max-fee` is refused and the keys are retried next round.
  - State is kept in `~/.zetaphy/immune-<sender>.json`.
- **Coverage per chain** = (keys flagged on ZETAPHY now whose mirror holds the same round) / (keys flagged on ZETAPHY now). It is rounded down to 0.1%, so a mirror missing 1 key of 1000 never shows 100%.
  - CLI: `zetaphy immune coverage --sender … --mirror <name>=<rpc>@0x…` and `node scripts/neuro-oracle.js coverage`.
  - Hub: the **Immunity** tab reads the chain RPCs in `saphan-chains.json` straight from the browser.

### How fast

- With a pusher every 30 s, a new flag is pushed within 30 s plus one ZETAPHY block.
- Then come the Hyperlane relayer and our validator, which need the origin's finality plus their polling (seconds to minutes).
- "Within blocks" holds only while someone runs the pusher. Nothing pushes by itself: `ThreatRegistry` is deployed and cannot call the sender.
- A GitHub Actions schedule runs at most every 5 minutes. A runner's machine can run the pusher continuously.

### Tests

- `test/neurooracle.test.js` (coverage from real contracts) and `test/assist.test.js` (pusher rounds, retry, `--max-fee`).
- `zetaphy-hub/test/assist.test.mjs` (browser coverage math, unreachable mirrors) and `assist.e2e.mjs` (the Immunity tab under the site's CSP).

---

## 19 · "Neuro-checked" certificate

### What was built

- **`NeuroAttest`** (EAS-like, one schema `zetaphy.neuro-checked.v1`). An attestation records:
  - subject token
  - attester
  - time
  - Neuro report hash (the verdict hash, `zetaphy-neuro/src/verdict.js`)
  - **skill id** (the version of the Neuro code, `src/skill.js`)
  - **AI model** (`rules` when no model ran)
  - NeuroJobs job id
  - URI
- There are two ways to get one:
  - `attest(…)` by an attester governance approved, such as the launch tool's key.
  - `attestFromJob(jobId, token)` by anyone, for a **settled** NeuroJobs verdict on chain `zetaphy` about that token. The attester is then NeuroJobs itself, so no one's word is needed. A job can be used once.
- **Governance revokes** any attestation, with a reason. An attester may revoke its own.
- `badge(token)` returns the newest attestation if it is not revoked.
- Tools:
  - `zetaphy certify <token> --attest 0x…` runs Neuro on the token (reading ZETAPHY) and attests it.
  - `zetaphy certify from-job <id> <token>` and `zetaphy certify show <token>`.
  - `zetaphy deploy-assist attest`.
  - **Launch tools:** `zetaphy-dex/cli.js deploy --test-tokens --attest 0x<NeuroAttest>` certifies each token it creates.
- **Badge:**
  - The wallet bar (`walletbar.js`, option `neuroBadge`) shows "✓ Neuro-checked" next to a held token.
  - The swap page's Neuro box shows the certificate number and attester, or "revoked". This happens when `deployments.json` has `contracts.neuroAttest`.
  - The hub's Immunity tab looks up any address.
  - Every text says it is **a check, not a guarantee**. Tests check that no language says "safe".

### Tests

- `test/neuroattest.test.js`: attester rules, from-job (settled only, the right token, once, mixed-case target), revoke, NeuroAnchor.
- `test/assist.test.js`: certify and the badge text.
- `zetaphy-dex/test/badge.test.js`: badge reads and the 8 languages.

### Limits

- `attestFromJob` needs a job on chain `zetaphy`, because NeuroJobs only knows its own chain key.
- `zetaphy-launch` does not call certify itself. The DEX CLI flag does. Wiring it into the launch steps is a small follow-up once NeuroAttest is deployed.

---

## 30 · Quantum-safe AI attestations

### What was built

- **Archive format** `zetaphy.neuro-attestation.v1` (one JSON file):
  - `payload`: kind, createdAt, subject, reportHash, skill, model, and optionally the full report
  - `payloadHash`: sha256 of the payload's canonical JSON
  - `signature`: alg `ML-DSA-44`, a 1312-byte publicKey, keyHash = keccak256(publicKey) (the same key hash as `zetaphy pq` and QuantumWallet), and a 2420-byte sig over `"zetaphy.neuro-attestation.v1\n" + payloadHash`
  - `anchor` (optional): chainId, NeuroAnchor contract, hash, time, block
- `archiveHash` is the keccak256 of the canonical `{format, payloadHash, signature{alg, publicKey, sig}}`. It is what `NeuroAnchor.anchor()` records, together with the first block and time.
- **One shared module** (`zetaphy-hub/pqattest.js`, no imports, the crypto is passed in) is used by:
  - **the CLI**: `zetaphy attest-pq sign <report.json>` signs with this machine's `~/.zetaphy/pq.seed`, `verify <archive>` checks it, and `anchor <archive> --anchor 0x…` anchors it.
  - **the browser verifier**: the hub's Immunity tab. It uses ML-DSA-44 and keccak from the wallet's existing `vendor/pqwallet.js`, and SHA-256 from WebCrypto.
- The verifier also recomputes the report's verdict hash with Neuro's code (`verdict.js`), so a payload whose report was swapped is caught.

### Tests

- `test/pqattest.test.js` covers tamper detection: payload, report (even with the payloadHash recomputed), keyHash, swapped key, one changed signature character, truncated signature, format, alg, anchor time, anchor hash, an archive that was never anchored, and a re-signature by another key (still valid, but an "unknown" signer).
- `test/assist.test.js` runs sign and verify through the CLI process.
- The hub e2e signs an archive, then the page verifies it as **valid** and a tampered copy as **not valid**.

### Limits

- "Trusted signer" is a list the reader passes in (`--trusted`). There is no on-chain registry of runner PQ keys yet.
- An anchor proves an archive existed by a block, not that its content is right.

---

## 32 · Parametric hack insurance (testnet only)

### What was built: `HackInsurance`

1. **Pool.** Deposits get shares. A withdrawal waits `withdrawDelay` (7 days by default). Governance cannot set it shorter than a claim's vote window plus dispute window, so a known incident cannot be fled. Requested shares still carry losses until they are paid.
2. **Covers.** Governance lists covered targets (`targetKey(chainId, contract)`) with a cap per claim. Premium = amount × `premiumBps` × duration / year. Total active cover can be at most `maxCoverBps` of the pool (3× by default).
3. **Claim.** The holder files the exploit's transaction hashes (1–16) and block range (inside the cover, in the past), plus the hash of **Neuro's forensic report of the deterministic replay** and the loss that report computed, with a bond. `evidenceHash = keccak256(abi.encode(chainid, target, txHashes, fromBlock, toBlock))`.
4. **Committee vote.** NeuroJobs runners vote (active, with a track record, like ThreatRegistry). An approval counts only if it restates **the same report hash and loss**; anything else counts as a rejection.
   - A quorum of approvals approves the claim.
   - A quorum of rejections rejects it, and the bond goes to the pool.
   - Neither by the end of the window: the claim expires and the bond is refunded.
5. **Dispute window.** Anyone may dispute with a bond. Governance decides:
   - Overturned: the disputer gets both bonds.
   - Upheld: the payout follows.
6. **Payout** = min(loss, cover, the target's cap, `maxClaimBps` of the pool (20%), what is left of the daily cap), and never more than the pool holds. One payout per cover. Anyone can trigger it.
7. **Deploy:** `zetaphy deploy-assist insurance --jobs 0x…`.

### Tests

`test/insurance.test.js`, 7 tests: pool and premium, capacity, approval and capped payout, rejection on a different replay, evidence rules, both dispute outcomes, expiry and LP withdrawal delay, daily cap.

### Not done, and why

- The **replay tool** that turns transaction hashes and a block range into a deterministic forensic report (fork at `fromBlock-1`, re-execute, diff balances) does not exist yet. Today runners would have to build that report themselves for their votes to agree. This is the main missing piece.
- Covers only contracts on ZETAPHY: block numbers are this chain's.
- No risk pricing.
- No protection against a governance mistake in disputes.
- The incident's block timestamps are not checked against the cover's end on chain. Runners must check that in the replay.
- It must never hold real value. The doc, the contract header and the deploy command all say so.

---

## 20 · Pre-sign assistant

### What was built

The hub's signing summary (`wallet-safety.js confirmTx`) now takes `simulate` and `explain` hooks. It shows their results when they arrive, so the dialog never waits for them. `hub.js send()` passes both (`assist.js presignHooks`). The summary runs three steps, in order:

1. `eth_call` of the transaction itself, from the user: would it fail, and why (Error(string), Panic, or the selector of a custom error). `eth_estimateGas` gives the gas.
2. **One `eth_call` with a state override.** The `PresignProbe` code (`tools/PresignProbe.sol`, compiled into `presign-probe.js` by `tools/build-presign.mjs`) is put at the **user's own address**, and the call comes from the user. The probe makes the same call and reports the user's balance changes: the native coin and the tokens involved (the target, call-data addresses that have code, and the tokens the hub knows). This is Neuro's honeypot technique: a helper put in place by a state override for one read-only call.
3. **AI explanation (optional).** When the user has set up a model in Neuro's AI panel (same origin, same storage), an "Explain with AI" button sends the summary to **the user's own model**. It goes through Neuro's AI layer (`/neuro/ai/providers.js`). The prompt keeps chain text inside `<data>` as untrusted data and tells the model never to call the transaction safe. The answer is shown as advisory, with a note in 8 languages.

The words are in 8 languages: the simulation rows in `assist-i18n.js`; the dialog keys `cfSim`, `cfSimWait`, `cfExplain`, `cfExplainNote` and `cfExplainErr` in `wallet-safety-i18n.js`. These files are copied to every site with `npm run sync:shared`.

### Tested

- `zetaphy-network/test/presign.test.js`, on the in-memory EVM through a JSON-RPC stand-in:
  - the committed probe equals a fresh compile
  - a token transfer: −25 exactly, gas
  - native value
  - a call-data token watched
  - a failing call explained
  - a node that refuses overrides falls back to the plain call and says so
  - the encoding
  - the AI prompt (data kept apart, JSON and plain answers)
- **On a real ZETAPHY node** (a local `zetaphyd` devnet): the override probe reported `−7` for a TestToken transfer, plus the custom error of an over-balance transfer.
- The hub e2e checks the summary's simulation rows and the AI explanation under the site's CSP.

### Limits

- Gas is not charged in an `eth_call`.
- The result is for the latest block.
- During the call the user's account has code, so a contract that checks `extcodesize(msg.sender) == 0` or `tx.origin` may behave differently.
- Approvals, NFTs and tokens not in the list are not followed (the summary reads approvals itself).
- The ZETAPHY node does not serve `debug_traceCall` or `eth_simulateV1` (checked on the devnet); either would see every transfer.
- The DEX and NFT apps do not pass the hooks yet; only the hub does. The shared module supports them.

---

## 21 · Governance assistant

### What was built: the hub's **Governance** tab (`govassist.js`, `assist.js`)

- **Proposals** in deposit or voting (Cosmos REST), with their messages decoded:
  - `MsgUpdateParams` of gov, staking, slashing, mint, distribution, bank, evm, erc20 and feemarket: each field is **compared with the module's current parameters**. A change is flagged when a rule says it needs a careful look:
    - much shorter voting or unbonding
    - lower quorum or threshold
    - much cheaper proposals
    - fewer validators
    - harsher slashing
    - more inflation
    - higher community tax
    - transfers off
    - an EVM precompile switched off
    - EVM access control changed
    - base fee off
  - `MsgEVMCall` from the gov module: the function is named (setGovernance, upgradeTo, setIsm, grantRole, … each with a risk level), then **simulated with `eth_call` from the gov module** against the current state.
  - Software upgrades, spends and unknown messages are flagged too.
- **The ZetaphyTimelock queue:**
  - `CallScheduled` events not yet executed or cancelled (from the launch's `timelockBlock`), with `getTimestamp` for when each can run.
  - Each call is simulated **as the timelock** and flagged the same way.
- The flags say "read carefully", **never** "vote yes" or "no".
- 8 languages (`assist-i18n.js`, tab names in `i18n.js`).

### Tests

- `zetaphy-hub/test/assist.test.mjs`, with mocks:
  - every selector and topic is the keccak of its signature
  - the parameter rules
  - reading `MsgEVMCall` (base64 data, a bech32 gov module)
  - `reviewProposals` (diff plus a failing simulation from the gov module)
  - `reviewTimelock` (scheduled vs executed or cancelled, simulated as the timelock)
- `assist.e2e.mjs`: a proposal decoded and flagged in the browser, also in Thai.

### Limits

- The rules are a fixed list: a risky change outside it shows as a plain diff, not a flag.
- Legacy `MsgExecLegacyContent` proposals are not decoded.
- `eth_call` is from the current state, not the state at execution time.

---

## 22 · Validator assistant

`sudo zetaphy-validator status` now ends with **diagnostics**, each with advice in plain words:

- **Sync:** catching up, or in sync with the measured seconds per block (from the node's earliest and latest block).
- **Peers:** from `net_info`. With 0 or few peers, it advises opening port 26656.
- **Disk:** use of the node's disk. At 85% it advises freeing space; at 95% it says "urgent".
- **Missed blocks:** from `q slashing signing-info` and the slashing params.
- **Jail risk**, with a time estimate. A validator is jailed once it misses more than window − ceil(window × min_signed_per_window) blocks (`jail_eta`). The estimate is the blocks left times the block time, i.e. how long until jail if the node stopped now. The levels:
  - low / medium (under a quarter of the allowance left) / HIGH (the next miss jails)
  - JAILED (with the unjail command)
  - TOMBSTONED

Tests: `zetaphy-network/test/validatorstatus.test.js` with stand-ins for zetaphyd, curl and df. It covers the arithmetic, a healthy node, each kind of trouble with its advice, jailed, tombstoned, and not a validator yet. The existing `joinvalidator.test.js` still passes.

Limits:

- The block time is an average over the node's stored blocks.
- The diagnostics read the local node only. A node that shows "in sync" can still be on a fork; `zetaphy pq verify-block` checks that.

---

## Tests run

| Package | Command | Result |
|---|---|---|
| zetaphy-network | `npm test` | 463 / 463 pass (new: neurooracle 10, neuroattest 4, insurance 7, pqattest 5, assist 4, presign 6, validatorstatus 4) |
| zetaphy-network | dry run `saphan-dryrun.js --neuro-oracle --kit` on two local zetaphyd devnets | NEURO ORACLE DRY RUN OK |
| neuro-oracle-osmo | `cargo test` | 3 / 3 pass |
| zetaphy-hub | `npm test`; e2e `hub`, `safety`, `mine`, `assist` | 50 / 50; e2e all pass |
| zetaphy-dex | `npm test` | 111 / 111 pass (new: badge 2) |
| zetaphy-launch | `npm test` | 20 / 20 pass |

## What remains (in order)

1. After 2026-11-01:
   - deploy the sender, the receivers and wire them (`scripts/neuro-oracle.js`)
   - add the sender to the relayer whitelist
   - add the `deploy` mode to `neuro-oracle.yml` and write `neuro-oracle.json`
   - deploy NeuroAttest and NeuroAnchor, and put them in the launch state and `deployments.json`
2. Run the workflow's real-core dry run (anvil + Hyperlane CLI) at least once.
3. Osmosis:
   - build and check the wasm (`cosmwasm/optimizer`, `cosmwasm-check`)
   - upload to osmo-test-5
   - instantiate with the `wasm-sender` the chain itself reports
   - `setIbcRoute`
4. The deterministic forensic replay tool for 32. Without it, insurance votes cannot agree in practice.
5. Pass the pre-sign hooks from the DEX and NFT apps too.
6. An on-chain list of runner PQ keys, so "trusted signer" does not depend on the reader's list.
