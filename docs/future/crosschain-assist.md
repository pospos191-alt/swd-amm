**English** | [ภาษาไทย](crosschain-assist.th.md)

# Cross-chain security and assistants (testnet)

Workstream `fut-crosschain`. Eight items: the Neuro cross-chain security oracle (18), herd immunity (28),
"Neuro-checked" certificates (19), quantum-safe AI attestations (30), parametric hack insurance (32), the pre-sign
assistant (20), the governance assistant (21) and the validator assistant (22).

Everything here is **testnet only**. Nothing holds real money. Nothing needs an always-on server: the work happens in
contracts, in the browser (the hub), on runners and validators people already run, or in GitHub Actions.

| # | Item | Status | Where |
|---|---|---|---|
| 18 | Neuro cross-chain security oracle | **Built, tested on local chains, deploy-ready.** The workflow's `deploy` mode (sender, receivers, wire, record, verify) waits for the ZETAPHY RPC (paused until 1 November). Osmosis: contract, build workflow and commands ready, not uploaded | `contracts/NeuroOracle.sol`, `src/neurooracle.js`, `scripts/neuro-oracle.js`, `scripts/saphan-dryrun.js --neuro-oracle`, `.github/workflows/neuro-oracle.yml`, `.github/workflows/neuro-oracle-osmo.yml`, `cosmwasm/neuro-oracle-osmo/`, `zetaphy-chain/hyperlane/neuro-oracle.json` |
| 28 | Herd immunity + coverage per chain | **Built**: the pusher and the coverage meter (CLI and hub). Shows "not deployed" until 18 is deployed | `src/neurooracle.js`, `zetaphy immune push/coverage`, hub **Immunity** tab |
| 19 | "Neuro-checked" certificate | **Built**: contract, CLI, DEX `--attest`, wallet bar and swap page badge, hub lookup. Not deployed yet | `contracts/NeuroAttest.sol`, `zetaphy certify`, `zetaphy-dex/cli.js deploy --attest`, `walletbar.js`, `zetaphy-dex/web` |
| 30 | Quantum-safe AI attestations | **Built**: ML-DSA-44 archive, on-chain anchor, CLI verifier, browser verifier, tamper tests | `zetaphy-hub/pqattest.js`, `src/pqattest.js`, `contracts/NeuroAttest.sol` (`NeuroAnchor`), `zetaphy attest-pq` |
| 32 | Parametric hack insurance (testnet) | **Prototype contract and the deterministic replay tool, with tests** (in-memory EVM and anvil). Not deployed | `contracts/HackInsurance.sol`, `src/replay.js`, `zetaphy insurance replay/vote`, `.github/workflows/insurance-replay.yml` |
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
  - `wire --sender 0x… --receivers a=0x…,b=0x… [--handover]`: sets each missing route. With `--handover`, governance then goes to the ZETAPHY timelock. Once the timelock governs the sender, `wire` does not send anything for a new route: it prints the call as a timelock proposal (`proposals`: `to`, `data`) for `timelock.yml`.
  - `verify --chain <name>`: read only. Reads back every address of `neuro-oracle.json` on both chains: the sender's registry, NeuroJobs, Mailbox, route and governance; the mirror's Mailbox, origin domain and chain id, sender, ISM (the factory's address for our validators, and its validator set and threshold), governance, guardian, and that it is not paused. Exit 1 on any mismatch.
  - `record --chain <name> …`: writes the deploy results into `neuro-oracle.json`.
  - `coverage`.
- `zetaphy-chain/hyperlane/neuro-oracle.json` is committed with `sender: null` (nothing deployed). The deploy fills it in as `{ sender, zetaphy: { threats, jobs, mailbox, governance, tx, fromBlock }, receivers: { <chain>: { oracle, ism, governance, guardian, tx, fromBlock, workflowRun } } }`. Three readers follow it with no other change:
  - the hub's **Immunity** tab (`zetaphy-hub/build.mjs` `immuneMirrors`);
  - `neuro-oracle.js coverage`;
  - the relayer: `saphan.js whitelist` / `relayer-env` add `{ originDomain: 77390, senderAddress: <sender>, destinationDomain: <chain> }` per mirror to `HYP_WHITELIST`, and the chain to `HYP_RELAYCHAINS`. Without this our validators would sign the messages but nobody would relay them.
- `.github/workflows/neuro-oracle.yml` modes:
  - **check**: read only.
  - **dry_run**: on local chains. Pull requests run it for Base Sepolia.
  - **verify**: read only, any time; the deploy's verify step against the file on the branch.
  - **deploy**: the real testnets. A manual run on `main`, job environment `testnet-deploy` (the owner approves; key `ZETAPHY_DEPLOYER_KEY`, referenced by name only; docs/SECRETS-HARDENING.md). Same pattern as `saphan-route.yml`'s deploy job.
  - `chain = all` runs every chain of the table in one run.

#### Runbook: the deploy after 2026-11-01 (the owner presses one button)

Before (once):

1. `saphan-chains.json` `zetaphyValidators.validators` holds the address of `ZETAPHY_VALIDATOR_KEY` (**saphan-route** `mode = check` prints it). The deploy refuses an empty list.
2. The deployer `0x6af5…a245` has ZETAPHY testnet coins and faucet ETH on each chain: at least a quarter of `faucetEth` in the table (0.1 Sepolia, 0.02 Base Sepolia, 0.02 Arbitrum Sepolia). **neuro-oracle** `mode = check` shows the balances.
3. The environment `testnet-deploy` exists with the secret `ZETAPHY_DEPLOYER_KEY`, branch `main` only, the owner as reviewer (docs/SECRETS-HARDENING.md, section 3).

The button: **Actions → neuro-oracle → Run workflow** on `main`, `chain = all`, `mode = deploy`, `handover = true` → **Review deployments → Approve**. The job then:

1. **Preflight** (read only). The ZETAPHY RPC must answer chain id `0x12e4e`, else nothing is deployed (until 1 November it does not answer). It also checks the deployer's balance on ZETAPHY and on every chain, and that our validators are set.
2. **Sender** on ZETAPHY, reading the table's ThreatRegistry and NeuroJobs. It is skipped when `neuro-oracle.json` already has one.
3. **Receivers.** Per chain: our ISM through the chain's factory, then NeuroOracle. Governance is the chain's v2 timelock and the guardian its multisig (the Saphan route's when deployed, else new ones). A chain already in the file is skipped.
4. **Wire.** `setReceiver` per new chain, then (with `handover`) the sender's governance goes to the ZETAPHY timelock.
5. **Record** into `neuro-oracle.json`.
6. **Verify.** The read-back above for every chain, plus the relayer whitelist entries and the coverage meter.
7. **Push** the file to the branch `neuro-oracle/all`. This happens even when verify failed, so that deployed addresses are never lost. The log prints the compare link. Open the pull request and merge it: the hub, coverage and the relayer pick the file up from `main`.

Afterwards:

- Run **hyperlane-relayer** once by hand (or wait for its schedule) so that pushes are relayed.
- Push the flags with `zetaphy immune push --sender <sender>` (item 28).
- **Adding a chain later** (after the hand-over): run `mode = deploy` for that chain. The receiver is deployed and recorded, and `wire` prints the `setReceiver` call as a timelock proposal. Verify fails on the route until the proposal is scheduled and executed (**timelock** workflow, `schedule` then `execute` after the delay). Then **neuro-oracle** `mode = verify` passes.
- One chain at a time instead of `all`: deploy with `handover = false` for each chain, merge each pull request before the next run (the file on `main` carries the sender), and hand over at the end (`mode = deploy`, `handover = true`, a chain already recorded: only the hand-over runs).

#### Osmosis: build, store and instantiate

The build is `.github/workflows/neuro-oracle-osmo.yml`, on pull requests touching the contract or by hand. It runs:

- `cargo test`;
- the optimized wasm from `cosmwasm/optimizer:0.17.0`, pinned by digest `sha256:7e0b9229…7f85`. That image uses Rust 1.86.0. The older 0.16.x images (Rust 1.81) cannot read the lockfile, because some current dependencies use edition 2024;
- `artifacts/checksums.txt`, and a check that the wasm is at most 819200 bytes;
- `cosmwasm-check` 2.1.4;
- an artifact `neuro-oracle-osmo-wasm` holding the wasm and its checksum.

Then a person with an Osmosis testnet key and a little testnet OSMO stores and instantiates it on osmo-test-5. This is free: testnet OSMO comes from the faucet. Commands, with `NODE=https://rpc.testnet.osmosis.zone:443`:

```sh
# 0. uploads must be open to everyone on the testnet (else it takes a testnet governance proposal)
osmosisd q wasm params --node $NODE            # code_upload_access: Everybody
# 1. store the wasm from the workflow's artifact, after comparing its sha256 with checksums.txt
osmosisd tx wasm store neuro_oracle_osmo.wasm --from <key> --chain-id osmo-test-5 --node $NODE \
  --gas auto --gas-adjustment 1.4 --gas-prices 0.025uosmo -y
osmosisd q tx <txhash> --node $NODE -o json | jq -r '.events[] | select(.type=="store_code") | .attributes[] | select(.key=="code_id") | .value'
osmosisd q wasm code-info <code_id> --node $NODE  # data_hash = the sha256 of checksums.txt
# 2. the sender as ibc-hooks sees it: the chain's own answer, compared with ibcHooksSender() before trusting either
ZSENDER=$(node -e 'import("./src/neurooracle.js").then(m => console.log(m.zetaphyBech32(process.argv[1])))' <NeuroOracleSender 0x…>)
osmosisd q ibc-hooks wasm-sender <osmosis channel-N> $ZSENDER --node $NODE
node -e 'import("./src/neurooracle.js").then(m => console.log(m.ibcHooksSender(process.argv[1], process.argv[2])))' <channel-N> $ZSENDER
# 3. instantiate: admin = our Osmosis-side admin (pause, setHookSender), no wasm admin (no migration; a fix is a new contract)
osmosisd tx wasm instantiate <code_id> '{"admin":"osmo1<admin>","hook_sender":"<osmo1… from step 2>","src_chain":77390}' \
  --label zetaphy-neuro-oracle --no-admin --from <key> --chain-id osmo-test-5 --node $NODE \
  --gas auto --gas-adjustment 1.4 --gas-prices 0.025uosmo -y
osmosisd q wasm list-contract-by-code <code_id> --node $NODE
```

4. On ZETAPHY, governance (the timelock after the hand-over) calls `setIbcRoute("channel-N", "osmo1<contract>", 600)` on the sender. `channel-N` here is ZETAPHY's side of the Saphan Osmosis channel (`zetaphy-chain/ibc`, `ROUTE=osmosis`).
5. Check: `zetaphy immune push` with a flag, then `osmosisd q wasm contract-state smart osmo1<contract> '{"stats":{}}'`.

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
- **Dry run on two real local chains.** `node scripts/saphan-dryrun.js --chain basesepolia --neuro-oracle --kit` ran against two `zetaphyd` devnets (chain ids 77390 and 84532, `scripts/devnet.sh`). The kit Mailbox and ISM stand in for Hyperlane core. It prints `NEURO ORACLE DRY RUN OK`, including the refusals and 100.0% coverage. Without `--kit` it uses the real Mailboxes and ISM factory, which is the workflow's dry_run. That path is still **not run here**: it forks a public testnet RPC, which this environment cannot reach (anvil itself is now installed here, at the pinned 1.2.3). The pull request CI runs it.
- `cargo test` in `cosmwasm/neuro-oracle-osmo` (`npm run test:cosmwasm`), 3 tests: sender check, newest-round rule, pause, key format, and parsing the memo ZETAPHY builds. Passes again with this change.
- **The deploy steps** (added with the `deploy` mode):
  - The dry run (`saphan-dryrun.js --neuro-oracle`) now also runs what the deploy runs after the contracts exist: `recordDeployment`, then `verifyDeployment` (17 read-back checks before the hand-over), the hand-over to a timelock stand-in, `verify` again, and a new route after the hand-over coming out as a timelock proposal. With `--kit` on two local anvils (77390 and 84532): `NEURO ORACLE DRY RUN OK`.
  - The deploy job's shell steps themselves were run against three local anvils (ZETAPHY 77390, Base Sepolia 84532, Sepolia 11155111) with a stand-in ISM factory, three times: first deploy of one chain, a second run adding a chain with `handover`, and a re-run (nothing to do). All steps pass, verify passes, and neuro-oracle.json comes out as the hub reads it. That run is not committed (it needs a local HTTPS stand-in for the table's RPCs).
  - `test/saphanconfig.test.js`: the committed `neuro-oracle.json` (no sender) gives no relayer entry and the hub shows "not deployed"; records merge (sender kept, one per chain, refusals); the relayer whitelist and settings carry ZETAPHY → each mirror; the hub's `immuneMirrors` reads the same file.

### Limits

- A DEX on another chain must **choose** to call `check(token)`. We cannot make Uniswap call it.
- On a pause the mirror fails open (it answers "not flagged"). This keeps DEXes working when our validators are compromised, at the cost of protection during the pause.
- The mirror is only as current as the last push. See 28 for how fast that is.
- The ICS-20 path spends 1 azetaphy per message. If the Osmosis execution fails, the transfer is refunded and the message is lost. The pusher does not track IBC deliveries; resend with another `pushIbc`.
- The optimized wasm (`cosmwasm/optimizer`) and `cosmwasm-check` run only in `neuro-oracle-osmo.yml` on GitHub: this sandbox has no Docker daemon, and installing `cosmwasm-check` was not allowed here. A plain `cargo build --target wasm32-unknown-unknown` with Rust 1.86.0 (the optimizer's toolchain) does build (245 KB before `wasm-opt`). The contract is not on osmo-test-5.
- The relayer's schedule gate (`saphan.js gate`) watches the bridge routes, not the oracle. Oracle messages are whitelisted and relayed whenever the relayer runs; after a push, run **hyperlane-relayer** by hand if nothing else is moving.

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

### The deterministic replay: Neuro's forensic report (`src/replay.js`, `zetaphy insurance`)

A claim names the transactions and the block range. The replay turns them into a report whose hash every honest runner computes identically. That hash is the `reportHash` the claim files and the votes restate.

1. **Fetch.** Each claimed transaction and its receipt come from the chain's RPC. Every one must be in `[fromBlock, toBlock]`. `toBlock` must also be at least `--confirmations` blocks (default 12) behind the head: a load-balanced public RPC may not have the newest blocks yet, and those can still reorg.
2. **Fork and replay.** anvil forks the chain at `fromBlock - 1`. The foundry version is pinned to **v1.2.3**, the same as the workflows, and another version is refused. Only the claimed transactions are replayed, in chain order:
   - Each runs in a block with its original number, timestamp, base fee and coinbase (anvil `--no-mining --order fifo`, empty blocks in between), sent from the original sender (impersonated), with the original data, value, gas and fees.
   - Other transactions of the range are left out on purpose. The report says what these transactions did.
3. **Balance deltas** of the target:
   - before: the fork state (`evm_snapshot` / `evm_revert`); after: the state after the replay;
   - assets counted: the native coin, every ERC-20 given with `--tokens`, and every ERC-20 a replayed transaction moved to or from the target (from its `Transfer` logs).
4. **Prices**, in wei of the chain's native coin. There are only two sources:
   - prices given explicitly: `--price 0x<token>=1.5` means 1.5 native coins per whole token;
   - on-chain data read **at the fork state**, before the exploit: a ZetaphyOracle's `price(token) / price(native asset)`, both in USD with 18 decimals (`--price-oracle 0x… --native-asset 0x<WZETAPHY>`).

   An asset with neither, or one the oracle refuses (stale, paused, tripped), is listed in `unpriced` and counts zero. The pricing inputs are part of the report, so a different pricing gives a different hash.
5. **Loss** = max(0, −(sum of the priced deltas)), in wei. Values are truncated toward zero per asset.
6. **Canonical JSON**:
   - keys sorted, no whitespace, printable ASCII only;
   - every integer a decimal string; no floats, no wall clock, no host, path or tool output;
   - fields: the evidence (with `evidenceHash` and `targetKey` exactly as `HackInsurance` computes them), the fork block and its hash, per transaction the original block, index, timestamp, status and the replay's status (`matchesOriginal`), the assets with before, after, delta, price and value, `unpriced`, and `loss`.

   The file is written as exactly those bytes, so `keccak256(file)` is the report hash.

Commands (testnet only):

```sh
zetaphy insurance replay --target 0x<covered contract> --tx 0x…,0x… --from-block N --to-block M \
  [--price 0x<token>=1.5 | --price-oracle 0x<ZetaphyOracle> --native-asset 0x<WZETAPHY>] [--tokens 0x…] \
  [--source-rpc <another EVM chain> --chain-id <its id>] [--confirmations 12] [--anvil <path>] [--out report.json]
zetaphy insurance hash report.json                  # recompute and check a report (evidence fields, hash)
zetaphy insurance claim --insurance 0x… --cover <id> --report report.json [--uri <where the report is published>]
zetaphy insurance vote --insurance 0x… --claim <id> --report <the claimant's report> [--accept-explicit-prices] [--dry-run]
```

**The committee voter** (`vote`) works like this:

1. It reads the claim, its cover and its `ClaimEvidence` event.
2. It takes the pricing inputs from the runner's own flags, or else from the claimant's report. A report that prices by hand is refused, and no vote is sent, unless the runner passes `--accept-explicit-prices` after checking those prices.
3. It replays the evidence itself and checks:
   - the target is the cover's;
   - the evidence hash is the claim's;
   - every transaction ends as it did on chain;
   - no transaction is after the cover's end;
   - the loss is not zero;
   - the recomputed hash and loss equal the claim's.
4. It votes approve (restating the hash and loss) only if every check passes, else reject.

### Tests

- `test/insurance.test.js`, 7 tests: pool and premium, capacity, approval and capped payout, rejection on a different replay, evidence rules, both dispute outcomes, expiry and LP withdrawal delay, daily cap.
- `test/replay.test.js`, 7 tests on the in-memory EVM. The "fork" is the same deterministic setup rebuilt, and the incident is a scripted test fixture (`test/helpers/ReplayKit.sol`: a vault whose `sweep()` lacks its owner check; three fixture transactions, one valid only at its own timestamp, with unrelated noise in between). They cover:
  - canonical JSON;
  - `targetKey` and `evidenceHash` equal to the contract's;
  - loss = 50 native + 2 tokens × 1.5 = 53. Two runs give byte-identical reports and hashes. Tokens are found from the logs, the unpriced token is listed, and the noise is not replayed. A replay at the wrong time shows `matchesOriginal: false` and gives another hash;
  - on-chain prices (a price stub) give the same loss as explicit prices but another hash;
  - refusals: outside the range, too close to the head, wrong chain, unknown transaction;
  - tamper detection;
  - the committee on the real `HackInsurance`: runners recompute and approve, so the claim is **Approved**; a claim with loss + 1 gets rejected by both runners, so it is **Rejected**. A transaction after the cover's end is rejected.
- `npm run test:anvil` (`scripts/insurance-replay-e2e.js`; CI: `.github/workflows/insurance-replay.yml` with foundry v1.2.3). This is the same incident on a local anvil chain (77390), through the CLI:
  - two `zetaphy insurance replay` runs, each forking with a fresh anvil, give byte-identical files, the same hash, `keccak256(file)` = the hash, and loss 53;
  - an oracle-priced run;
  - `claim`, then two runners' `vote`, so the claim is **Approved**; a claim with a tampered loss gets two `vote` rejections, so it is **Rejected**.

  It ran here with anvil 1.2.3 (installed from the pinned release): `INSURANCE REPLAY E2E OK`.



### Not done, and why

- Covers only contracts on ZETAPHY: block numbers are this chain's. (The replay tool itself works on any EVM chain with an RPC that serves the fork block.)
- Replay limits:
  - Only the claimed transactions are replayed. An exploit that needs another transaction of the range (the attacker's setup, a price move) must claim it too; at most 16.
  - Fidelity: `PREVRANDAO` and the hashes of the rebuilt blocks are anvil's, not the original ones. A contract that reads them can behave differently, and then `matchesOriginal` turns false and runners reject.
  - Determinism needs the same anvil (pinned, enforced) and an RPC that serves the fork block honestly. A runner should replay against its own node or an RPC it trusts: an RPC that lies about state gives another report, and the votes disagree rather than agree on a lie.
  - Counted: the native coin and ERC-20 balances. Not counted: NFTs, LP or lending positions, or approvals left behind.
- No risk pricing.
- No protection against a governance mistake in disputes.
- The incident's block timestamps are not checked against the cover's end on chain. The replay report carries each transaction's original timestamp and `zetaphy insurance vote` rejects any after the cover's end.
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
| zetaphy-network | `npm test` after `npm run build` (with items 18 deploy-ready and 32 replay) | 566 / 566 pass, 0 fail, 0 cancelled (new: replay 7, saphanconfig 1) |
| zetaphy-network | `npm run test:anvil` (`scripts/insurance-replay-e2e.js`, anvil 1.2.3) | INSURANCE REPLAY E2E OK |
| zetaphy-network | `saphan-dryrun.js --neuro-oracle --kit` on two local anvils (77390, 84532), with record / verify / hand-over | NEURO ORACLE DRY RUN OK |
| neuro-oracle-osmo | `cargo test` (again); `cargo +1.86.0 build --release --target wasm32-unknown-unknown` | 3 / 3 pass; builds |
| zetaphy-hub | `npm test`; e2e `hub`, `safety`, `mine`, `assist` | 50 / 50; e2e all pass |
| zetaphy-dex | `npm test` | 111 / 111 pass (new: badge 2) |
| zetaphy-launch | `npm test` | 20 / 20 pass |

## What remains (in order)

1. After 2026-11-01:
   - press the button: **neuro-oracle** → `chain = all`, `mode = deploy`, `handover = true` (the runbook in 18), then merge the `neuro-oracle/all` pull request (the relayer whitelist and the hub follow from the file)
   - deploy NeuroAttest and NeuroAnchor, and put them in the launch state and `deployments.json`
2. Run the workflow's real-core dry run (anvil + Hyperlane CLI) at least once: on any pull request touching the oracle, or by hand.
3. Osmosis: run **neuro-oracle-osmo**, then store, instantiate and `setIbcRoute` by the commands in 18 (needs an Osmosis testnet key and the Saphan Osmosis channel).
4. Insurance (32): deploy HackInsurance on the testnet only when there are runners who will run `zetaphy insurance vote` with anvil 1.2.3.
5. Pass the pre-sign hooks from the DEX and NFT apps too.
6. An on-chain list of runner PQ keys, so "trusted signer" does not depend on the reader's list.
