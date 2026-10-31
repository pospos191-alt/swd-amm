# AI agents on ZETAPHY: identity, intents, labels, guardrails, co-signing (testnet)

[ภาษาไทย](agents.th.md)

Five pieces, all **testnet only, nothing with real money**. They are contracts in
`zetaphy-network/contracts/`, runner/solver code in `zetaphy-network/src/`, and one hub page
(**Agents** tab, `zetaphy-hub/agents.js`, 8 languages). None of them is deployed yet: the hub reads
their addresses from `hub-config.json` (`contracts.intentExecutor`, `labelRegistry`, `agentRegistry`,
`agentPolicyWallet`, `vouchRegistry`, written by `build.mjs` from the launch state once deployed) or lets the user type them.

| # | Item | Status | Where |
|---|------|--------|-------|
| 23 | Agent identity & liability | **done (prototype)** | `AgentRegistry.sol` (+ `ConstitutionChecker`), `test/agents.test.js` |
| 24 | Proof of Intent | **done (prototype)**: structured builder (5 templates, strict schema), simulation before signing, expiry + per-intent and daily spend caps on chain; NL parsing stays advisory by design | `IntentExecutor.sol`, `zetaphy-hub/intent-core.js`, `src/intent.js`, hub Agents page, `test/intents.test.js`, `zetaphy-hub/test/agents*.mjs` |
| 25 | Human-or-agent labels | **done (prototype)** + optional uniqueness level (web-of-trust vouching); "human" ≠ unique human, full Sybil resistance **not solved** | `WebAuthnVerifier.sol`, `HumanAgentLabels.sol` (`LabelRegistry`, `VouchRegistry`, `LabelFaucet`, `LabelSwapGate`), `test/labels.test.js`, `test/vouch.test.js` |
| 25+ | Private identity (zero-knowledge) over the labels: prove "labelled person", "level ≥ X", "once per scope" without revealing the account; DEV trusted setup, not post-quantum | **done (prototype)**, see [zk-identity.md](zk-identity.md) | `ZkIdentityRegistry.sol`, `ZkIdentityVerifier.sol`, `PrivateAirdrop.sol`, `PrivatePoll.sol`, `zkid/`, hub `zkid.js`, `test/zkid.test.js` |
| 9 | Guardrails for AI wallets | **done (prototype)** | `AgentPolicyWallet.sol`, `test/policywallet.test.js` |
| 14 | AI co-signer | **done (prototype)**: FROST threshold Schnorr (RFC 9591, secp256k1) with a dealerless DKG and an on-chain verifier; k-of-n ECDSA kept as fallback | `CosignCommittee` + `FrostSecp256k1` (in `AgentPolicyWallet.sol`), `src/frost.js`, `src/cosign.js`, `zetaphy cosign`, `test/frost.test.js`, `test/policywallet.test.js` |

The chain node patch (`zetaphy-chain/setup-node.sh`) is **not changed**. Everything uses what the
chain already has:

- **ML-DSA precompile `0x…0900`** (ZETAPHY's FIPS 204 verifier; input `variant ‖ msg32 ‖ pk ‖ sig`).
- **P-256 precompile `0x…0100`**: cosmos/evm's `p256` (RIP-7212 interface: `hash ‖ r ‖ s ‖ x ‖ y` → `uint256(1)`),
  already in `active_static_precompiles` in `setup-node.sh`. So passkeys are verified **on chain**; no
  Solidity P-256 code is needed.

Tests run on the in-memory EVM (`test/helpers/evm.js`), which now accepts JS precompiles
(`createChain(names, funded, { precompiles })`). `test/helpers/precompiles.js` puts a **real** ML-DSA-44
verifier (`@noble/post-quantum`, the same input format as the chain's precompile) at `0x…0900` and a
BigInt P-256 verifier at `0x…0100`, and has a test "authenticator" that builds WebAuthn assertions
exactly like a browser (authenticatorData, clientDataJSON, DER→(r,s)). So the tests sign with real
ML-DSA-44 keys and real P-256 passkeys; only the chain's Go precompiles themselves are not exercised
here (they have their own devnet tests).

---

## 23. AI agent identity & liability — `AgentRegistry`

**What it is.** `register(account, pqKeyHash, constitution, checker)` with at least `minBond` testnet
ZETAPHY. The caller becomes the **operator** (who answers for the agent). The agent has:

- `account`: the EVM account it transacts from (one agent per account; used for the AGENT label);
- `pqKeyHash`: keccak256 of its **ML-DSA-44** public key (the key itself rides in calldata, as in `QuantumWallet`);
- `constitution`: keccak256 of its policy document; `checker`: an optional deterministic checker contract,
  one governance approved (`setChecker`; AR-2: otherwise an operator could pick a checker that pays itself).

**Actions with provenance.** `recordAction(id, {target, value, dataHash, modelHash, promptHash}, pk, sig)`:
the agent's ML-DSA-44 key signs `actionDigest` (chain id, registry, agent id, a per-agent sequence, the
fields), checked by the `0x…0900` precompile; anyone may relay it. The action stores the constitution and
checker **in force at that time**, so later policy changes cannot erase liability.
`modelHash` = keccak256 of the weights or of `provider/model@version`; `promptHash` = keccak256 of the full prompt.

**Claims.**
- *Deterministic*: `claimByChecker(actionId, constitutionDoc, evidence)` — anyone shows the document
  (must hash to the recorded constitution); the checker returns `(violated, victim, damage)`; the bond
  pays `min(damage, bond)` to the **victim the checker names** at once. One payout per action.
  `ConstitutionChecker` is a working example: document = `abi.encode(principal, maxValuePerAction,
  allowedTargets[], allowedModels[])`; it pays the principal for a call to an unlisted target or by an
  unlisted model (whole value) or above the cap (the excess).
- *Committee*: `fileClaim(actionId, amount, evidenceHash)` with `claimDeposit`; the claims committee
  (set by governance with `setCommittee`, ≤ 32 members, threshold) votes; threshold *yes* pays the
  claimant (≤ bond) and refunds the deposit; threshold *no*, or no decision within 7 days
  (`expireClaim`), rejects it and the deposit goes to the operator.
- Claims are open for 30 days after an action. `requestUnbond` stops new actions at once; the bond comes
  back 7 days later and only with no open claim. A bond slashed below `minBond` makes the agent inactive
  (no actions, no AGENT label) until topped up (`addBond`).

**Use.** Operators call the contract directly (ethers / `cast`); sign the digest with `src/pq.js`
(`pqFromSeed(seed).sign(digest)`). The hub's Agents page shows an agent (id or account → operator,
bond, constitution, key, actions, open claims, status).

**Limits.** The operator chooses among the approved checkers; a checker claim pays only while the
action's checker is still approved, so governance can revoke a bad one. A lazy checker finds nothing, so the committee path
exists; a victim must still be able to describe the harm in terms of a recorded action. Recording is
voluntary — an agent can act without recording (then its operator answers only off chain); pair it with
`AgentPolicyWallet` (which logs provenance for every action) or require recorded actions in the apps
that serve agents. Payouts are push transfers (a victim contract that refuses ZETAPHY blocks its own
payout). `modelHash`/`promptHash` are commitments, not proofs that that model produced the action —
proving inference (zkML / TEEs) is research-grade and not attempted.

## 24. Proof of Intent — `IntentExecutor` + intent schema + hub page

**Schema** (`zetaphy-hub/intent-core.js`, one copy for the hub and the CLI): EIP-712
`Intent(address user, uint8 kind, address tokenIn, uint256 maxIn, address tokenOut, uint256 minOut,
address recipient, bytes32 targetsHash, uint256 nonce, uint256 deadline)`, domain
`ZETAPHY IntentExecutor` v1. Kinds: **send** (tokenIn = tokenOut, exactly `minOut` to the recipient),
**swap**, **stake** (tokenOut = the vault's receipt token), **approve** (a capped, expiring allowance) and
**bridge** (both below). `targetsHash` = keccak256(abi.encode(address[]))
of the only contracts a solver may call (e.g. the DEX router).

**Signatures.** ECDSA EIP-712 (`eth_signTypedData_v4`, MetaMask) or the **PQ variant**: the same
digest signed with an ML-DSA-44 key whose hash the user registered with `setPqKey`.

**On-chain checks** (`execute(intent, auth, plan)`, anyone = the solver submits): deadline, unused nonce
(`cancel(nonce)` too), signature; then it pulls `maxIn`, approves only `plan.spender` (one of the listed
targets) for the duration, runs the calls, resets the approval, returns leftover tokenIn to the user and
forwards any tokenOut it holds to the recipient, and finally **measures balances**: the user lost
`≤ maxIn` of tokenIn, the recipient gained `≥ minOut` of tokenOut, the executor kept nothing. Calls may
go only to listed targets, never to tokenIn, the user, the executor or 0 (nor tokenOut, except for stake
where the vault is the receipt token), with no value, and never with `transferFrom`, `approve`,
`increaseAllowance`, `setApprovalForAll` or `permit` selectors. Tests use the **real ZETAPHY DEX**
(`zetaphy-dex` artifacts) and show: a solver that sends the output to itself, takes too little,
calls an unlisted contract or the token, or uses an old approval of a listed contract to pull more
of the user's tokens — each is reverted (`ReceivedTooLittle`, `TargetNotAllowed`, `ForbiddenCall`,
`SpentTooMuch`).

**Off-chain compiler** (`src/intent.js`): deterministic code, not a model. `compile(intent, {router,
path} | {vault})` builds `swapExactTokensForTokens` / `deposit` calls from the signed fields;
`zetaphy intent show | compile | execute <signed.json>` (execute runs `staticCall` first, so a bad plan
fails before gas is spent). Any other solver (including an AI) may build other plans; the executor's
checks are what protect the user.

**Natural language → intent** (hub, Agents page): the user writes what they want; **their own model**
(Neuro's AI layer, bring-your-own-model: `zetaphy-neuro/ai/providers.js`, Anthropic / OpenAI-compatible /
local Ollama; the same settings and key storage as the Neuro AI panel; the key goes only from the
browser to the provider) returns a JSON draft in a fixed schema. The user's text is fenced as data;
`intentFromModel` keeps only what checks out (tokens from the known list, parsed amounts, a minimum
received given explicitly or computed from a DEX quote and a slippage ≤ 5 %, deadline ≤ 24 h) and lists
every problem. The draft fills the form; **Review** shows every field in plain words; only then can the
user press **Allow the executor** (an `approve` for exactly `maxIn`) and **Sign intent** (the wallet's
own EIP-712 prompt). The signed JSON is copied to a solver. The page never signs or sends by itself.
The model only fills the form: everything below (strict validation, summary, simulation) applies to its
draft exactly as to a form typed by hand.

**Templates and the structured builder** (hub Agents page; `zetaphy-hub/intent-core.js`). The usable path
does not need a model: pick a template and fill in its fields.

| Template | Kind | Fields | What the executor enforces |
|---|---|---|---|
| swap | 2 | token in, amount (max), token out, minimum received, recipient (empty = you), minutes, DEX router | balances: spent ≤ max, received ≥ min; only the router |
| send | 1 | token, amount (exact), recipient, minutes | exactly the amount to the recipient |
| stake | 3 | token in, amount (max), receipt token, minimum receipts, recipient, minutes, vault | as swap, the vault may be the receipt token |
| approve with a cap | 4 | token, cap (total), spender, days (≤ 30) | `spendAllowance(intent, auth, to, amount)` by the spender only, Σ ≤ cap, until the deadline, `cancel(nonce)` ends it |
| bridge | 5 | token, amount (exact), recipient on the other chain, minutes, bridge (outbox) | exactly the amount goes into the ONE listed bridge (`send(to, amount)`, HyperlaneOutbox's interface), the executor keeps nothing |

- **Strict schema**: `validateBuilder(input)` takes only the template's fields (an unknown or missing field is
  an error), all as strings in exact formats (addresses; decimals with ≤ 15 integer digits and no more decimals
  than the token has; minutes 1…1440; days 1…30); tokens must be in the hub's token list. `buildIntent()`
  turns a valid form into the intent, the targets and the solver's route, then `checkIntent()` (kind rules:
  approve has minOut 0 and no targets; bridge has minOut = maxIn and one target) runs again before signing.
- **Human-readable summary**: one sentence per template (`summary()`, 8 languages), e.g. *“Send exactly 5 TKA
  to 0x…, valid until 14:05.”*, plus the rows (`describe()`), the executor and the allowed contracts.
- **Simulation before signing**: `IntentExecutor.simulate(intent, plan)` runs everything `execute` does except
  the signature check and **always reverts** with `Simulated(spent, received)` (or the error it would fail
  with); the page calls it with `eth_call` from the user's address (the plan from `planFor()`, the same calls
  `src/intent.js compile()` builds; the tests check they agree byte for byte) and shows “would succeed: you spend
  X, the recipient gets Y” or the reason in words. Signing always simulates first; if the simulation failed,
  the first press of Sign only warns. The “Allow the executor” approval goes through the hub's own `send()`, so it gets the
  pre-sign assistant (`presign.js`: summary, eth_call + state-override balance probe, optional AI explanation);
  revert reasons that are not the executor's own are decoded with `presign.js revertReason`.
- **Expiry and spend caps on chain**: every intent has a deadline (≤ 24 h; allowances ≤ 30 days, the page and
  `checkIntent` refuse longer); `maxIn` caps each intent; and **`setSpendCap(token, perDay)`** sets the user's own
  cap on what ALL their intents together (execute, bridge, allowance pulls) may spend of a token per rolling
  day (`capLeft(user, token)`; reverts `OverDailyCap`). The review step shows what is left today and sets the cap.
- CLI: `zetaphy intent show|compile|execute` know the new kinds (`--bridge 0x…`); `zetaphy intent spend <file>
  --to 0x… --amount n` is the spender's side of an allowance.

**Limits / what remains.** No solver market or relay is run (no always-on server): the user hands the
file to a solver (anyone with the CLI). ERC-20 only (the native coin is the ERC-20 at `0xEeee…EEeE`).
A simulation is the latest block: prices move before a solver runs it; the signed limits are the
protection, the simulation is a preview. Bridge intents send no value, so they work only on routes whose
Mailbox fee is 0 (testnet), and delivery on the other chain is the bridge's job, not checked by the
executor. A daily spend cap is set by the account itself: it bounds a leaked intent signature, a careless
allowance or a bad solver, not a stolen key (which can raise it). An allowance shares the nonce space:
executing another intent with the same nonce ends it (nonces are random 64-bit).
One input and one output token per intent; no partial fills; no solver fee field (testnet). The hub
signs ECDSA only; the PQ variant is from the CLI/SDK (`signIntentPq`) until the PQ wallet exposes
typed-data signing. The model can misread the user — the review step and the on-chain limits are the
safety, not the model.

## 25. Human-or-agent labels — `LabelRegistry`

`labelOf(account)` → 0 none, 1 **HUMAN**, 2 **AGENT**.

- **AGENT** is read live from `AgentRegistry.activeAgentOf` (bonded, not unbonding); it wins over a human label.
- **HUMAN, on chain**: `proveHumanP256(x, y, assertion)` — the passkey signs `humanChallenge(account)`
  (chain, registry, account, nonce); `WebAuthnVerifier` checks `"type":"webauthn.get"`, the base64url
  challenge in clientDataJSON, rpIdHash (sha256 of the hub's host name), user-present **and
  user-verified** flags, and the P-256 signature through the **`0x…0100` precompile**. Valid for
  `humanTtl` (≤ 400 days). One passkey (hash of x,y) labels one account at a time; moving it drops the old label.
- **HUMAN, attested**: runners approved by governance (`setAttester`) verify a WebAuthn assertion off
  chain (any relying-party library) and sign an EIP-712 `HumanAttestation(account, credentialHash,
  validUntil, nonce, deadline)`; anyone submits it with `attestHuman`. Useful for authenticators or
  flows the on-chain checker does not accept. The account, governance or any attester may `revokeHuman`.
- **Hooks**: `LabelFaucet` (an amount per label, a cooldown per account and **per passkey**) and
  `LabelSwapGate` (an hourly input cap per label, called by an allowed router/pool before a swap). Any
  contract can read `ILabels.labelOf`.
- **Hub**: Agents page → *Person or agent?*: look up a label; **Prove I'm a person (passkey)** creates
  an ES256 platform passkey (public key kept in this browser's storage; nothing secret), asks it to sign
  the challenge, and sends `proveHumanP256` from the connected wallet.

**Limits.** A human label proves *a person was present at an authenticator* — **not personhood or
uniqueness** (anyone can create many passkeys; passkeys sync between devices). Treat it as a speed bump
for simple bots. Attestation of the authenticator model (AAGUID) is not checked (passkeys usually send
none). The node's built-in faucet (`zetaphy_faucet`, in the chain patch) does **not** read labels — the
patch is out of scope here; `LabelFaucet` is the contract-level faucet that does, and the node faucet
could later `eth_call` `labelOf` before paying. The DEX contracts are not modified; `LabelSwapGate` is
for a router or pool that opts in.

### Optional uniqueness level — `VouchRegistry` (web of trust)

`levelOf(account)` states which level an address has, and the hub shows it in words:

| Level | Name | Meaning |
|---|---|---|
| 0 | none | no HUMAN label (unlabelled, or an AI agent) |
| 1 | **passkey human** | `LabelRegistry` HUMAN: a person used a passkey. **Not proven unique.** |
| 2 | **vouched unique human** | a passkey human that ≥ `vouchesNeeded` (default 3) vouched-unique humans vouched for, not suspended or banned |

Free and serverless: no stake, no fee, no oracle, no API. How it works:

- **Bootstrap**: governance (the chain's gov module / its multisig) names a genesis set (`setGenesis`), e.g.
  people who met at a meetup. Everyone else enters by vouches.
- **`vouch(who)`**: only a vouched-unique human may vouch, for a passkey human, saying “one real person, one
  account”. The vouch records the vouchee's **passkey hash**: if the label moves to another passkey, the vouch
  stops counting. **Rate limits**: one vouch per `vouchCooldown` (7 days) per voucher, at most
  `maxActiveVouches` (5) open, and a newly unique account must wait `voucherMinAge` (30 days) before vouching.
  `unvouch(who)` withdraws at any time. `refresh(a)` (anyone) records a vouchee's status once it has enough
  vouches; the level itself is computed **live**, so a vouch from an account that is banned, suspended, lost
  its HUMAN label or its own unique status stops counting at once.
- **Accountability**: `flag(a)` by vouched-unique humans; `flagsToSuspend` (5) distinct flags suspend `a`
  (level 1, cannot vouch) until flags are withdrawn or governance `clearFlags` (a new epoch, against flagging
  campaigns). Governance `ban(a, evidenceHash)` an account shown to be a duplicate or a bot (the evidence hash
  is on chain); every voucher of it gets a strike and `strikesToBan` (2) strikes ban the voucher too.
  Parameters are bounded (`vouchesNeeded` 2…16, …) and set by governance only.
- **Hub**: Agents page → *Person or agent?*: the level pill (*Person (passkey) — not proven unique* /
  *Vouched unique human* / *AI agent*), “n of N vouches count”, flags, and buttons **Vouch for this person**,
  **Withdraw my vouch**, **Update status** (each a transaction through the hub's pre-sign summary).
  `status(a)` returns everything the page shows in one call.

**Sybil-resistance analysis (honest).** What it buys: a single person cannot create a vouched identity
alone (needs N distinct vouched people); growth of fake identities is bounded and slow — a colluding ring of
k real vouched people can add at most k·5/3 fakes at first, those fakes can vouch only after 30 days and at
one vouch per week each (≤ 5 per 28 days), so a ring grows at most about ×(1 + 5/3) ≈ ×2.7 per month — exponential, but slow and visible on chain
(every vouch is an event, the graph is public and can be analysed for dense clusters); a discovered fake costs
its vouchers strikes and then their own status. What it does **not** buy: collusion and **bought vouches**
are not prevented, only bounded and traceable; one person with real friends willing to lie can get several
identities; the genesis set and bans depend on governance; the stored status of a vouchee's vouchers is one
level deep (anyone can `refresh` a stale one). **Full Sybil resistance (one person = one account) is not
solved here** — hooks should treat level 2 as “more expensive to fake”, not as proof of personhood.

**Existing proof-of-personhood attestations, considered.** BrightID (social graph, free; verification is a
signature by BrightID nodes over an app context, which could be checked with `ecrecover` — but it needs
BrightID's node API and app registration, an external service), Proof of Humanity (lives on Ethereum/Gnosis,
needs a deposit and a cross-chain proof), World ID (Semaphore proofs could be verified on chain with a
Groth16 verifier, but issuance needs the Orb, a biometric device run by one company), Idena (its own chain,
needs a bridge). None can be verified on ZETAPHY today without a paid or central service, so none is wired
in; the `attestHuman` path of `LabelRegistry` (governance-approved attesters) is where a free attestation
could plug in later.

## 9. Guardrails for AI-driven wallets — `AgentPolicyWallet`

The owner (a person) holds the funds and the policy; the agent key acts only inside it
(`execute(to, value, data, modelHash, promptHash)`):

- **caps per period** per token (address 0 = native), counting native value, ERC-20 `transfer` amounts
  and `approve` amounts; a token with no cap cannot be moved by the agent;
- **allow-lists**: recipients (native sends, ERC-20 transfers) and contracts (any other call, approval
  spenders); `transferFrom`, `increaseAllowance`, `setApprovalForAll`, `permit` refused;
- **timelock above a threshold** (`cosignAbove` per token): `queue` → `executeQueued` after `delay`; the
  owner may `cancel`; caps apply when it runs;
- **emergency freeze** by the owner's account (`freeze`), the owner's **passkey**
  (`freezeWithPasskey`, P-256 precompile) or the owner's **ML-DSA-44 key** (`freezeWithPq`); the two
  signed freezes are relayable by anyone (so a phone with a passkey is enough). Only the owner's account
  unfreezes; the owner can always `ownerExecute` (take funds out), frozen or not.
- Every agent action emits `AgentAction(…, modelHash, promptHash, path)`.

**Hub**: Agents page → *Agent wallet guardrails*: state (frozen, what the agent may still send this
period, emergency passkey set), **Use my passkey as its emergency key** (owner sends
`setEmergencyKeys`, keeping the ML-DSA key), **Freeze with my passkey**.

**Limits.** Caps count amounts, not prices (a cap in one token, not in dollars). Only `transfer`/`approve`
are decoded; for any other call to an allowed contract the contract itself must be trusted (allow-list
only contracts you understand). One agent key per wallet; no per-recipient limits; owner = an EOA (it can
itself be a `QuantumWallet` or multisig). No factory yet: deploy one per agent.

## 14. AI co-signer — `CosignCommittee` + `src/cosign.js`

Above a threshold an action needs the timelock **or** `executeCosigned(…, reportHash, deadline, sigs)`
with signatures from `threshold` distinct members of a `CosignCommittee`. The committee is set **by
governance** (`setMembers`, the chain's gov module through a MsgEVMCall proposal, or a multisig); each
wallet's owner chooses which committee it trusts. The digest binds chain, wallet, a per-wallet nonce,
`to`, value, calldata hash, `reportHash` and a deadline (no replay).

Runners: `zetaphy cosign review --wallet … --to … [--value --data --deadline --strict]` reads what the
action touches with **Neuro's fixed rules** (`zetaphy-neuro/src/reader.js` + `verdict.js`, the same code
and skill id as NeuroJobs; `zetaphy-neuro/src/` unchanged): the called contract, and for ERC-20
transfer/approve the recipient/spender if it is a contract. It refuses on a **high** level (also
**medium** with `--strict`), on a contract call to an address without code, or when a read fails; otherwise
it signs, with `reportHash` = keccak256 of the verdict ids, so anyone can re-run the reads and see what
was vouched for. The agent collects answers and `zetaphy cosign combine a.json b.json …` orders them for
`executeCosigned`; runners that saw different chain state sign different digests and do not combine.

### Threshold co-signing: FROST (RFC 9591) — `src/frost.js`, `FrostSecp256k1`, `executeCosignedFrost`

The k-of-n path above stays as the fallback. The threshold path makes **one 65-byte Schnorr signature** that any
`t` of the `n` members produce together, without anyone ever holding the group's secret key:

- **Scheme**: FROST(secp256k1, SHA-256), ciphersuite `FROST-secp256k1-SHA256-v1` of
  [RFC 9591](https://www.rfc-editor.org/rfc/rfc9591) (Komlo & Goldberg's FROST, two-round signing): nonce
  generation (H3), commitments, binding factors (H1, H4, H5), group commitment, challenge (H2), signature
  shares, share verification and aggregation; points SEC1-compressed, `hash_to_field` with
  `expand_message_xmd(SHA-256)`. `src/frost.js`, point arithmetic from **`@noble/curves` 1.9.7** (pinned,
  now a direct dependency), SHA-256/ECDH/AES from `node:crypto`.
- **Key generation without a dealer** (the RFC leaves DKG out of scope; its Appendix C dealer is **not**
  used): the Pedersen DKG with proofs of knowledge from the FROST paper (Figure 1, *KeyGen*): each member
  draws a degree-(t−1) polynomial, publishes commitments to its coefficients and a Schnorr proof of knowledge
  of its constant term (`c = HDKG(id ‖ A0 ‖ R ‖ Φ)`, Φ = the session, so packages cannot be replayed into
  another session; with an empty Φ this is exactly the Zcash Foundation's `frost-core` proof), then sends each
  other member its share **encrypted** (ECDH on secp256k1 with a per-DKG key → HKDF-SHA256 → AES-256-GCM,
  bound to the session, sender and recipient), so every message can travel as a file or a paste in a public
  chat. Each member checks every share against the sender's commitments (a bad share names the sender), and
  derives its signing share, everyone's verifying shares and the group key. There is no broadcast channel, so
  every step prints a **transcript hash** that members compare out of band; a member shown different packages
  is detected at round 3. A group key whose x ≥ n (probability ~2⁻¹²⁸) is refused (run again): the on-chain
  check needs x < n.
- **On chain**: `CosignCommittee.setFrostKey(groupKey)` (governance; checks the point), `isValidFrost(digest,
  sig)` and `AgentPolicyWallet.executeCosignedFrost(…, reportHash, deadline, sig)` (same digest and nonce as
  the k-of-n path; `AgentAction` path 3). The verifier, `library FrostSecp256k1` (+ `FrostVerifier` for
  anyone to call), recomputes the RFC challenge `c = H2(R ‖ PK ‖ msg)` in Solidity (3 × SHA-256 precompile),
  lifts R from its compressed form (modexp precompile, square root mod p) and checks `z·G − c·PK = R` with
  **ECRECOVER**: `ecrecover(−z·PK.x, v(PK), PK.x, −c·PK.x)` returns the address of `z·G − c·PK`, compared
  with the address of R. This is the construction of V. Buterin, *“You can kinda abuse ECRECOVER to do ECMUL
  in secp256k1 today”* (ethresear.ch, 2018), used by Chainlink's `SchnorrSECP256K1.sol`, `noot/schnorr-verify`
  and Chronicle's Scribe; unlike those it takes the RFC 9591 signature as is, so any RFC 9591 implementation
  can produce it. Cost: about **15k gas** for the check (measured), whatever t and n are — more than 2 ECDSA
  signatures (~12k), less from k = 3 on, and the signature does not reveal which members signed.
- **CLI, files only, no server**:
  ```
  zetaphy cosign dkg1 --id 1 --threshold 2 --participants 3 --session <32 hex, same for all> --out r1-1.json
  zetaphy cosign dkg2 --secret ~/.zetaphy/frost/dkg-<session>-1.secret.json r1-1.json r1-2.json r1-3.json --out r2-1.json
  zetaphy cosign dkg3 --secret … --round1 r1-1.json,r1-2.json,r1-3.json r2-2.json r2-3.json --out group.json
      → group key; governance calls setFrostKey(0x<group key>)
  zetaphy cosign commit --key ~/.zetaphy/frost/<group>-1.key.json --out c1.json        (signing round 1)
  zetaphy cosign frost-package --group group.json --wallet 0x… --to 0x… [--value --data --deadline] c1.json c3.json
  zetaphy cosign frost-sign --key … --package pkg.json --out z1.json                    (signing round 2)
  zetaphy cosign frost-aggregate --group group.json --package pkg.json z1.json z3.json  → executeCosignedFrost args
  ```
  `frost-sign` **re-runs the Neuro review** and computes the wallet's digest itself; it refuses a package
  whose digest differs (it signs what it checked, not what it was told). Nonces are single-use: the nonce file
  is deleted before the share is computed. Secret files (DKG polynomial, signing share, nonces) are mode 0600 and
  sealed with `ZETAPHY_PASSPHRASE` when set (scrypt + AES-GCM, as the other runner keys); the DKG secret is
  deleted after round 3.
- **Tests**: `test/frost.test.js` checks `src/frost.js` against the **RFC 9591 Appendix E.5 test vectors**
  (shares, nonces from the given randomness, commitments, binding factors, signature shares, final signature;
  `test/fixtures/frost-secp256k1-rfc9591.json`, as published with the Zcash Foundation's `frost-secp256k1`
  2.1.0) and that crate's **DKG vectors** (proofs of knowledge, shares, verifying shares, group key); runs full
  DKGs (2-of-3, 3-of-3) and signing with every signer subset; checks tampered packages, replays, a hidden
  package swap (transcript), a bad share, a wrong digest and a reused nonce; and verifies the RFC signature and
  ours **on chain** (and refuses z+1, the other R, another R, z = n, the other key parity, x ≥ n).
  `policywallet.test.js` runs the wallet path (governance-only key, wrong amount, another group, expiry, caps,
  removal, k-of-n still working); `agentscli.test.js` runs the whole CLI flow with files.

**Limits.** k-of-n ECDSA (~k × 6k gas) or FROST (~15k gas, one signature); neither is post-quantum
(FROST on secp256k1 falls to a quantum computer like ECDSA; an ML-DSA committee would cost ~k × 30k gas through
the precompile; doable later). FROST here is the RFC's two-round protocol without identifiable-abort extras: a
member that sends a bad share is named (share verification) but the signing round must be restarted without it;
the DKG must be re-run to change members or the threshold (no proactive refresh / repair yet). The members' signing
shares are as sensitive as runner keys.
No server: the agent reaches runners out of band (they run the CLI). Neuro's rules judge contracts, not
intent: a clean contract can still be the wrong recipient — the allow-lists and caps stay in force.
The committee is not paid or bonded here; tying it to NeuroJobs runner bonds is future work.

---

## Tests (run)

- `zetaphy-network`: `npm test` — `agents.test.js` (9), `intents.test.js` (15: + approve with cap, bridge, daily caps,
  simulate and the hub's encoders), `labels.test.js` (8), `vouch.test.js` (5), `policywallet.test.js` (8: + FROST path),
  `frost.test.js` (4: RFC 9591 and DKG vectors, DKG + signing, on-chain verifier), `agentscli.test.js` (3: + FROST by files),
  plus all existing tests.
- `zetaphy-hub`: `npm test` — new `agents.test.mjs` (8: selectors and calldata vs ethers, SPKI/DER vs
  node:crypto, typed data, `checkIntent`, model-draft parsing, prompt fencing, 8 languages; + strict builder schema,
  every template, summaries, `simulate`/spend-cap calldata vs ethers, error decoding, VouchRegistry selectors);
  `npm run test:e2e` — `agents.e2e.mjs` (Chromium, the site's CSP: mocked model drafts an intent, the review shows
  it, the key reaches only the provider, label lookup, Thai; and the builder against the **real IntentExecutor** in an
  in-memory EVM behind a fake node and a stand-in wallet: template fields, a refused amount, the summary, simulation
  before and after “Allow”, a daily cap that makes the simulation fail and one that does not, signing, a solver
  executing the signed file; the uniqueness level from a VouchRegistry; no sideways scroll at 375 px).

## What remains

- Deploy (testnet) and add the addresses to the launch state; a `deploy-agents` CLI step.
- PQ typed-data signing in the PQ wallet so the hub can sign intents with ML-DSA-44.
- A solver relay (GitHub-Actions or volunteer-runner based, no always-on server) and solver fees.
- Committee bonds/rewards; an ML-DSA committee option; a policy-wallet factory; FROST key refresh/repair and a
  hub page for the DKG (today CLI only).
- The node faucet reading labels (needs a chain patch change, out of scope here).
- Real personhood: the vouching layer resists but does not stop collusion or bought vouches; no free
  proof-of-personhood attestation can be verified on ZETAPHY today (see §25). Hooks (faucet, swap gate) do not read
  the uniqueness level yet.
- Bridge intents with a Mailbox fee (the executor would need to forward value); several tokens per intent.
