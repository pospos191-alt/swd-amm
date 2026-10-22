**English** | [ภาษาไทย](SECURITY-CORE.th.md)

# ZETAPHY: security in the chain's core (security core)

This document explains the 3 security rules that live in the chain itself (not only in wallets or contracts): what they change for users
and validators, and what stops these rules from becoming a tool for censorship

| | What it does | Who turns it on | Default |
|---|---|---|---|
| **Q-day** | From the voted height, the chain refuses transactions signed with ECDSA (MetaMask-style keys) | governance vote | Off (no date set yet) |
| **Threat gate** | A transaction that calls a contract with an "enforced" Neuro flag needs the account owner's consent first | governance vote | Off |
| **IBC hold** | Inbound IBC transfers above a threshold are held for a period before reaching the account | governance vote | Off (no threshold) |

All three are **off until there is a vote**. Every setting is a public proposal (`gov.sh`), and the values in use can be viewed at any time:
`gov.sh security` or JSON-RPC `zetaphy_securityStatus` or `zetaphy security status`

---

## 1. Q-day: preparing to move accounts to quantum-resistant signatures

**What Q-day is** — the date when the network stops trusting ECDSA (secp256k1) signatures, because a large enough quantum computer could forge
signatures for keys whose public key has been revealed. governance sets the block height (`gov.sh qday <height>`)
in advance. Until that date everything works as before

**From Q-day:**
- Every kind of Ethereum transaction (MetaMask, Rabby, etc., which always sign with ECDSA) is refused at submission
- Cosmos transactions pass only when every signer is an ML-DSA-44 key (or a multisig made only of ML-DSA-44 keys)
- ECDSA signatures that contracts verify themselves (`ecrecover`: permit, meta-transactions, and P-256 through precompile `0x…0100`: passkeys) no longer have any effect
- ECDSA accounts that **have not migrated** are frozen: the funds stay where they are and nobody can move them (including someone who can forge signatures). governance
  may add a recovery method later by vote
- Permissions given before Q-day (ERC-20 allowances, authz, fee grants) still work, because they were given while signatures were still trustworthy.
  You should revoke unused allowances before Q-day

### What users should do (before Q-day)
1. Create an ML-DSA-44 account in the ZETAPHY wallet (the `zetaphy-wallet` web page or the ZETAPHY Snap in MetaMask), then send
   at least one transaction (so the chain learns the public key)
2. In the **"Lock MetaMask account to this wallet"** card, lock your existing MetaMask account to that ML-DSA-44 account (quantum lock,
   permanent) — the 0x address, balance, tokens, stake and contract rights stay where they are, but from then on they can be controlled only through the ML-DSA-44 account,
   which keeps working after Q-day
3. Press the **"Get ready for Q-day → Check my MetaMask account"** button to see the status: migrated / migrating /
   not migrated (and whether the key has ever been used on chain)

On the CLI: `zetaphy security migration <address>` and `zetaphy pq native lock-ecdsa --yes`

### If you miss Q-day: commit–reveal migration (only for keys never used on chain)
Accounts that **have never sent a transaction and never had a signature verified on chain** (e.g. wallets that have only received funds) can still migrate after Q-day:
1. The MetaMask wallet signs an account-migration message **locally only** (no transaction is sent)
2. The new ML-DSA-44 account records a **commitment** (a hash value that reveals nothing about the old key) — this can be done before Q-day
3. Wait at least `reveal_delay` blocks (set by governance, default 720 blocks), then **reveal** after Q-day
4. Wait another `reveal_delay` blocks; the old account then belongs to the ML-DSA-44 account (like a quantum lock)

These two waiting periods stop anyone who sees the data at reveal time from getting ahead: a commitment created after seeing the data is too new,
and during the waiting period the older commitment wins. **Committing as soon as Q-day is announced is the safest**
Accounts whose key has already been used on chain cannot use this route — they must lock before Q-day

In the wallet: the "Get ready for Q-day" card has "Step 1" and "Step 2" buttons (MetaMask will ask to sign a message, not a transaction)
CLI: `zetaphy security qday-commit`, then `zetaphy security qday-reveal`

### validator
- Block votes already carry ML-DSA signatures (stage 5), but an **operator account** that is ECDSA cannot send transactions after Q-day
  — quantum-lock the operator account first, then manage the validator through `MsgEVMCall as_owner` (staking,
  distribution, slashing, gov precompiles) and the `validator_owner` field of `MsgPQVoteKey`
- The IBC relayer (Hermes) and the testnet faucet sign with ECDSA, so they also cannot send transactions after Q-day
  — IBC will stop until there is a relayer that signs with ML-DSA-44 (there is none yet), so Q-day should not yet be set on a chain that uses IBC for real
- governance should set Q-day only once most validators have locked their accounts; otherwise voting after Q-day will not be possible
  (`gov.sh qday` refuses to set a height that is too close)

---

## 2. Threat gate: consent, not censorship

Neuro runners flag contracts based on **facts about the code** that can be re-tested (e.g. can be bought but not sold in a simulation) in
`ThreatRegistry`. When governance turns on the threat gate (`gov.sh threat-gate <ThreatRegistry> on`), the chain will:
- Refuse EVM transactions (and `MsgEVMCall`) whose destination (`to`) has an **enforced** flag, with a message giving the reason
- **Unless** the account owner gives consent first: a single transaction `consent(destination, seconds)` to the precompile
  `0x0000000000000000000000000000000000000901` (can be sent directly from MetaMask), valid for at most 1 day, revocable with 0 seconds

In the wallet: the **"Consent to call a flagged contract"** card (sent from the ML-DSA-44 wallet or from MetaMask), and the ZETAPHY Snap
shows a critical-level warning with the reason, evidence, the contract owner's reply, and how to consent. CLI: `zetaphy security consent <0x…> <seconds>`

**What prevents misuse**
- Only **enforced** flags count (past enforceDelay or the fast lane). Warning flags and held flags do not cause refusals
- Keys protected by governance (the protocol's own contracts, e.g. the bridge) cannot be flagged, so there is no way to make withdrawals from the protocol's
  contracts get stuck, and a cleared flag (cleared by vote, or by a successful appeal) stops refusals immediately
- Everyone can always proceed with their own consent; nobody can block any account permanently
- System addresses (precompiles) and the registry itself (appeals, replies) are not checked; governance calls are not checked
- If the registry is unusable, the chain treats it as "no flag": the chain and users' transactions do not get stuck because of the registry
- Bounded cost: one view call to the registry per transaction, a fixed gas cap, the same result on every node
- Refused transactions do not enter the mempool (checked at submission). If one is refused when already in a block (e.g. the consent expired or was revoked while waiting),
  the transaction stays in the block and **pays the fee** (the nonce is used), but everything the transaction would do is reverted (EVM transaction: a receipt with failed status)

**Limitations** — this gate asks for consent; it does not guarantee to prevent damage in every case. The ZETAPHY wallet and Snap
already do further checks before signing. Always use your own judgement

---

## 3. IBC hold: holding large inbound transfers

governance sets a threshold per token (`gov.sh ibc-hold-rule <denom|*> <minimum amount> <bps of supply>`) and a hold period
and guardian (`gov.sh ibc-hold <seconds> [guardian]`, default 6 hours). An inbound transfer that reaches the threshold:
- Is accepted (it does not time out on the source side) but **does not reach the recipient's account yet** while held. The list can be viewed with `gov.sh ibc-holds`,
  JSON-RPC `zetaphy_ibcHolds`, `zetaphy security ibc-holds`, and the event `zetaphy_ibc_hold`
- When the time is up, the chain forwards it to the recipient by itself (through the rate limit and the other rules as normal at that time)
- While held, the guardian (e.g. a multisig) or governance can **return the funds to the sender** (`gov.sh ibc-hold-cancel <id>`
  or `cancelIBCHold(id)` at the precompile 0x…0901 for a contract-based multisig); the source chain refunds through the normal IBC mechanism
  — the guardian cannot change the recipient or seize the funds
- IBC v2 transfers that reach the threshold are refused immediately (the funds return to the source); use a normal (v1) IBC channel
- x/ratelimit (cap per time window) keeps working as before; they are used together
- The threshold for a named token: reaching the minimum amount **or** reaching the share of supply on this chain · the `*` threshold (tokens without their own threshold): the share of supply
  counts only transfers that reach the `*` minimum amount (a token that has never come in has a supply of 0; without a minimum, every transfer of that token would be held)
  The minimum is counted in each token's smallest unit (decimals differ from token to token), so it is only a threshold to filter out small transfers
- The hold list has a cap: no more than 2,000 entries at once across the whole chain, and no more than 100 entries per token. A transfer that reaches the threshold when the list is full is **refused immediately**
  (the funds return to the sender on the source chain and can be sent again later), not forwarded without a hold. The release order is still by due time

Outbound transfers, and transfers below the threshold, are unchanged

**EVM bridge (BridgeGuard / BridgeAirlock):** the "registered minters only" rule stays at the contract level and has not moved into the chain,
because the chain cannot enforce it cleanly (minting happens inside the contract's code). IBC tokens that are ERC-20s are already created only by the IBC module

---

## CosmWasm contracts (stage 7) and the three rules

Transactions that call CosmWasm (Rust) contracts are ordinary Cosmos transactions, so they fall under the same rules
(setup details: [`zetaphy-chain/README.md`](../zetaphy-chain/README.md), section "Stage 7")
- **Q-day:** after Q-day, wasm transactions must be signed with ML-DSA-44 only, like other transactions; a quantum-locked account
  cannot send wasm transactions with its old key, and contracts cannot use authz permissions that account has given
  - The ML-DSA-44 controller can act on behalf of a locked account only on the EVM side: **move cw20 tokens / CosmWasm contract admin rights
    to the ML-DSA-44 account before locking**
- **Threat gate:** applies to EVM contracts only (ThreatRegistry stores 20-byte addresses, while CosmWasm contracts have 32-byte addresses)
  CosmWasm contracts cannot call EVM contracts in their own name, and a `MsgEVMCall` that a contract issues through authz is checked by the gate when it runs
- **IBC hold:** IBC for contracts is disabled (they cannot open channels or send packets themselves). Contracts can transfer tokens via ICS-20, which goes through
  the outbound IBC cap, and tokens transferred in to a contract go through the IBC hold as normal
- **Code upload:** governance only (`gov.sh wasm-store`); error codespace `zetaphy` 30 = a message that contracts cannot send

---

## Upgrades

- A new chain (new genesis): enabled from block 1 (`app_state.zetaphypq` key `0f` = 1, set by `setup-node.sh`), but every rule is off until voted
- A chain that is already running: `gov.sh propose-upgrade zetaphy-v3 <height H> "<summary>"`, then vote; every validator switches binary at H.
  From H+1 the precompile 0x…0901 and the new rules take effect (the handler also enables v2 if it is not yet on); earlier blocks run as before
- All values are in `app_state.zetaphypq` and carry over with a genesis export

## For developers

| | |
|---|---|
| Messages | `/zetaphy.pq.v1.MsgSetQDay`, `MsgQDayCommit`, `MsgQDayReveal`, `MsgSetThreatGate`, `MsgSetIBCHold`, `MsgSetIBCHoldRule`, `MsgIBCHoldCancel` |
| precompile 0x…0901 | `consent(address,uint64)`, `consentUntil(address,address)`, `threatGate()`, `qday()`, `migration(address)`, `cancelIBCHold(uint64)`, event `Consent` |
| JSON-RPC | `zetaphy_securityStatus`, `zetaphy_migration`, `zetaphy_qdayCommitment`, `zetaphy_consent`, `zetaphy_ibcHolds` |
| event | `zetaphy_qday`, `zetaphy_qday_commit`, `zetaphy_qday_reveal`, `zetaphy_qday_migrated`, `zetaphy_threat_gate`, `zetaphy_consent`, `zetaphy_ibc_hold`, `zetaphy_ibc_hold_released`, `zetaphy_ibc_hold_cancelled`, `zetaphy_ibc_hold_stuck` |
| error | codespace `zetaphy`: 20 = Q-day, 21 = threat gate, 30 = a message that CosmWasm contracts cannot send |
| JS | `zetaphy-network/src/pqtx.js` (`qdayRevealText`, `qdayCommitment`, `consentCall`, `msgQDay*`, `pqClient().securityStatus/migration/qdayCommit/qdayReveal/consent/ibcHolds`) |
| Tests | `zetaphy-chain/fork-tests/evmd/zetaphy_security_test.go`, `fork-tests/evmd/tests/ibc/zetaphy_ibchold_test.go`, `zetaphy-network/test/devnet.security.integration.js`, `zetaphy-chain/ibc/test-ibc.sh` |

Security details are kept separately for the team.
