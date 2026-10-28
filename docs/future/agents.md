# AI agents on ZETAPHY: identity, intents, labels, guardrails, co-signing (testnet)

[ภาษาไทย](agents.th.md)

Five pieces, all **testnet only, nothing with real money**. They are contracts in
`zetaphy-network/contracts/`, runner/solver code in `zetaphy-network/src/`, and one hub page
(**Agents** tab, `zetaphy-hub/agents.js`, 8 languages). None of them is deployed yet: the hub reads
their addresses from `hub-config.json` (`contracts.intentExecutor`, `labelRegistry`, `agentRegistry`,
`agentPolicyWallet`, written by `build.mjs` from the launch state once deployed) or lets the user type them.

| # | Item | Status | Where |
|---|------|--------|-------|
| 23 | Agent identity & liability | **done (prototype)** | `AgentRegistry.sol` (+ `ConstitutionChecker`), `test/agents.test.js` |
| 24 | Proof of Intent | **done (prototype)**; NL parsing is advisory by design | `IntentExecutor.sol`, `zetaphy-hub/intent-core.js`, `src/intent.js`, hub Agents page, `test/intents.test.js`, `zetaphy-hub/test/agents*.mjs` |
| 25 | Human-or-agent labels | **done (prototype)**; "human" ≠ unique human | `WebAuthnVerifier.sol`, `HumanAgentLabels.sol` (`LabelRegistry`, `LabelFaucet`, `LabelSwapGate`), `test/labels.test.js` |
| 9 | Guardrails for AI wallets | **done (prototype)** | `AgentPolicyWallet.sol`, `test/policywallet.test.js` |
| 14 | AI co-signer | **done (prototype)**; k-of-n ECDSA, not threshold crypto | `CosignCommittee` (in `AgentPolicyWallet.sol`), `src/cosign.js`, `zetaphy cosign`, `test/policywallet.test.js` |

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
- `constitution`: keccak256 of its policy document; `checker`: an optional deterministic checker contract.

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

**Limits.** A checker is chosen by the operator: a lazy checker finds nothing, so the committee path
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
**swap**, **stake** (tokenOut = the vault's receipt token). `targetsHash` = keccak256(abi.encode(address[]))
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

**Limits / what remains.** No solver market or relay is run (no always-on server): the user hands the
file to a solver (anyone with the CLI). ERC-20 only (the native coin is the ERC-20 at `0xEeee…EEeE`).
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

**Limits.** k-of-n ECDSA signatures (simple, ~k × 6k gas), **not** a threshold-cryptography signature
and not post-quantum (an ML-DSA committee would cost ~k × 30k gas through the precompile; doable later).
No server: the agent reaches runners out of band (they run the CLI). Neuro's rules judge contracts, not
intent: a clean contract can still be the wrong recipient — the allow-lists and caps stay in force.
The committee is not paid or bonded here; tying it to NeuroJobs runner bonds is future work.

---

## Tests (run)

- `zetaphy-network`: `npm test` — new `agents.test.js` (9), `intents.test.js` (11), `labels.test.js` (8),
  `policywallet.test.js` (7), `agentscli.test.js` (2), plus all existing tests.
- `zetaphy-hub`: `npm test` — new `agents.test.mjs` (8: selectors and calldata vs ethers, SPKI/DER vs
  node:crypto, typed data, `checkIntent`, model-draft parsing, prompt fencing, 8 languages);
  `npm run test:e2e` — new `agents.e2e.mjs` (Chromium, the site's CSP: mocked model drafts an intent,
  the review shows it, the key reaches only the provider, label lookup, Thai).

## What remains

- Deploy (testnet) and add the addresses to the launch state; a `deploy-agents` CLI step.
- PQ typed-data signing in the PQ wallet so the hub can sign intents with ML-DSA-44.
- A solver relay (GitHub-Actions or volunteer-runner based, no always-on server) and solver fees.
- Committee bonds/rewards; an ML-DSA committee option; a policy-wallet factory.
- The node faucet reading labels (needs a chain patch change, out of scope here).
- Real personhood (uniqueness) is out of reach with passkeys alone.
