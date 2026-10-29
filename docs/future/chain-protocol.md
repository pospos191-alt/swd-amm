# ZETAPHY v5: protection built into the chain (testnet research)

Thai: [chain-protocol.th.md](chain-protocol.th.md)

This covers five features in the `zetaphy-chain` node patch (`setup-node.sh`,
files `evmd/zetaphy_future.go`, `zetaphy_aimodel.go`, `zetaphy_immune.go`,
`zetaphy_breaker.go` and `zetaphy_guard.go`). They are **testnet only** and
**off until someone turns them on**. Governance turns on the chain-wide parts.
Each account turns on its own protection.

| # | Feature | Status | Where |
|---|---|---|---|
| 11 | AI precompile (integer GBDT model in chain state) | done (testnet) | `0x…0902` |
| 12 | Chain immune system through vote extensions | done, with documented limits | vote extensions, `0x…0903` |
| 13 | Protected-account mode | done | ante handler, `0x…0904` |
| 31 | Bridge circuit breaker | done, with documented limits | vote extensions, BeginBlock |
| 33 | Anomaly hold for opted-in accounts | done: native coin and ERC-20 tokens (per-token rules), with documented limits | ante handler, `0x…0904` |

## Activation (the `v5` height)

- **New chains:** v5 is on from block 1. `zetaphyd init` writes key `20` =
  `0000000000000001` in `app_state.zetaphypq`, and `setup-node.sh` writes it
  again.
- **Running chains:** submit `gov.sh propose-upgrade zetaphy-v5 <H> "<summary>"`
  and vote it through. Every validator switches binary at H, and v5 applies
  from H+1. The chain must already have run `zetaphy-v4`, because v5 adds no
  store.
- Below the v5 height, blocks run exactly as before:
  - the three addresses are empty accounts;
  - a vote extension that carries anything beyond the ML-DSA signature is
    refused, as it always was;
  - `MsgSetFuture` is refused.
- A genesis export keeps every setting. On an exported chain, v5 is on from
  the new chain's start.

All governance settings go through one message, `MsgSetFuture{kind, data}`.
Submit it with `gov.sh` (which calls `zetaphyd tx security-proposal <kind> …`):

```bash
bash gov.sh ai-model model.hex          # node zetaphy-chain/tools/gbdt-export.mjs > model.hex
bash gov.sh immune '{"enabled":true,"enforce_bps":9000,"hold_bps":8000,"protect_bps":7000}'
bash gov.sh breaker '{"bridge":"0x…","topic":"0x<topic0>","recipient_topic":2,"amount_word":0,"min_volume":"1000000000000000000000","vol_mult_bps":50000,"new_ratio_bps":5000,"baseline_shift":7,"enabled":true}'
bash gov.sh breaker-rearm 0x…
bash gov.sh model-epochs 0x…            # the Neuro ModelEpochs registry (item 35, ../future/federated.md)
```

The chain decodes the JSON strictly and refuses unknown fields.

---

## (11) AI precompile: `0x0000000000000000000000000000000000000902`

```solidity
function score(bytes features) external view returns (uint16 bps);   // 0..10000
function model() external view returns (bytes32 sha256, uint16 features, uint16 trees, uint32 nodes);
```

**What was built.** A gradient-boosted tree model (GBDT) is stored in chain
state by governance (kind `ai-model`) and evaluated with **integers only**:

- `features` is the model's feature vector, one big-endian int32 per feature
  (4 bytes each).
- Every tree walk uses integer comparisons only.
- The result goes through a fixed 65-point integer sigmoid (logit −8…8 in
  steps of 0.25, linear in between, clamped).

The model format, `ZGB1`, is: a header, then 14-byte nodes. Each node holds a
feature, an int32 threshold, the left and right child, and an int32 value.
The chain checks the model when governance sets it:

- at most 64 KiB, 512 trees, 255 nodes per tree and 1024 features;
- children come after their parent, so every walk ends;
- no trailing bytes.

The parsed model is cached in memory by its sha256. It is read from the store
without KV gas.

**Gas.** 2,000 + 6 per 32-byte input word, plus 40 per tree and 8 per node
visited. Neuro's real model (160 trees, 3,072 nodes, 43 KB) costs 39,404 gas
for a whole `MsgEVMCall` to `score()`, including the 21,000 base and calldata
(measured in the fork test). One evaluation takes about 35 µs.

**Using Neuro's model.** `node zetaphy-chain/tools/gbdt-export.mjs >
model.hex` converts `zetaphy-neuro/ml/model.json` (floats):

- Thresholds and features become `floor(x × 1e4)`.
- Leaves and the base become logits × 1e4.
- Neuro's Platt calibration is folded in (`a·z + b`).

A caller computes Neuro's features off chain, as `ml/features.js` does, and
passes them quantized the same way (`featureBytes()` in the exporter).

**Tests.**

- `fork-tests/evmd/zetaphy_future_test.go`:
  - `TestAIModelFormat`: parser refusals, and the sigmoid's exact points,
    monotonicity and clamps.
  - `TestAIPrecompile`: governance only, scores, wrong length, `model()`,
    deterministic gas that grows with the model, removal.
  - `TestAINeuroModelVectors`: Neuro's model exported. The chain gives the
    exporter's score exactly on 41 vectors (`testdata/neuro-gbdt.json`, made
    by `tools/gbdt-vectors.mjs`).
- `zetaphy-chain/tools/gbdt-export.test.mjs`: on 3,000 rows kept 2e-4 away
  from thresholds, the integer model is within 15 bps of Neuro's float
  probability.

**Limits.**

- Quantization: a feature within 1e-4 of a split threshold can take the other
  branch than in the float model. Score changes are then up to a few thousand
  bps on that row. Pass features already on the 1e-4 grid to avoid this.
- The precompile does not compute features from a contract by itself. The
  caller supplies them.
- Neuro's float model stays the reference. On chain, this is a deterministic
  copy, not a new model.

---

## (12) Chain immune system (vote extensions): `0x…0903`

**How it works.**

1. **Block N.** Contracts created at the top level are put on the block's
   pending list: an Ethereum tx without `to`, or a `MsgEVMCall` without `to`.
   At most 16 per block. More get the event `zetaphy_immune_unscored`.
2. **Vote on N+1.** Each validator scores the pending contracts of N from
   their runtime bytecode with `immuneCodeScore`. This is a deterministic Go
   copy of a minimal subset of Neuro's rules (`src/bytecode.js`,
   `src/selectors.generated.js`):
   - It walks the opcodes and skips PUSH data and Solidity metadata.
   - SELFDESTRUCT +2000, CALLCODE +2000, DELEGATECALL +1500, ORIGIN +1000,
     CREATE2 +500.
   - If the contract looks like an ERC-20 (transfer, balanceOf and approve
     are all present): blacklist functions +2500, fee setters +1500, trading
     switches +1000, mint +1000, tax wallet +500.
   - An EIP-1167 minimal proxy gets 1000 (it is not judged).
   - The total is capped at 10000.

   The validator puts the scores in its vote extension, after the ML-DSA vote
   signature.
3. **Block N+2.** The proposer adds `MsgZXVotes` (right after the PQ
   certificate). It holds each validator's payload and CometBFT's ed25519
   signature over the whole extension. To keep the block small, the 2,420-byte
   ML-DSA part is taken from the certificate when it is there.
   - Every node, in PreBlocker (so also during blocksync), checks each entry
     against the validator's consensus key.
   - Per contract, the node records the **power-weighted median**, but only if
     validators with **more than 2/3 of the power** sent a score.
   - It then prunes the pending list.

The median is recorded at N+2, not N+1 as first asked. Under ABCI++ a
validator signs its vote extension on block H *before* H runs, so the vote on
N+1 can see only the state after N.

**Extension layout.** The PQ certificate is not changed:

```
[ML-DSA-44 signature, 2420 bytes, if the validator signs] || ["ZX1" | n | n×(contract20|score u16) | m | m×bridge20]
```

- The certificate builder and checker read the signature part only. Its
  format, rule and the light-client message are unchanged. This is tested in
  `TestImmuneKeepsPQCertificate`.
- A keyed validator must still sign: a payload alone is refused.
- `VerifyVoteExtension` refuses a payload that is malformed, sent before v5,
  sent while the immune system is off, or that names a contract that was not
  deployed in N.

**Reading it.** `0x…0903` exposes:

- `scoreOf(address) → (score, height, powerBps, known)`;
- the ThreatRegistry-compatible views `isContractEnforced(address) → (bool,
  uint8 reason=7 "Other")` (score ≥ `enforce_bps`) and
  `isContractHeld(address)` (score ≥ `hold_bps`);
- `codeScore(address)`: the live bytecode score, for wallets;
- `immuneParams()` and `breaker(bridge)`.

Because the views are ThreatRegistry-compatible, existing consumers can use
the immune system directly:

- `gov.sh threat-gate 0x0000000000000000000000000000000000000903 on` makes the
  threat gate enforce immune scores. `setThreatGate` accepts the precompile.
- `BridgeGuard.setThreats(0x…0903)` holds mints to high-score contracts.

**Settings.** Governance kind `immune` takes `{enabled, enforce_bps, hold_bps,
protect_bps}`. Off by default. A threshold of 0 means "never".

**Limits.**

- **Contracts created by contracts (factories, CREATE2 deployers) are not
  scored.** Only the top-level creation address is in the receipt. Doing this
  would need an EVM tracer in consensus. That is possible, but it is a
  performance and determinism risk we did not take.
- At most 16 contracts per block. An attacker can fill a block to leave one
  unscored. The `zetaphy_immune_unscored` event shows that.
- The score is a small rule subset, not Neuro's full analysis. There is no
  trade simulation, no source, no market data, no ML. Running the GBDT model
  in the vote needs Neuro's 133 features, and most of them come from RPC
  reads and simulation that are not deterministic inside a vote. So the vote
  uses rules only. The AI precompile is the place to run the model on
  features a caller supplies.
- With deterministic rules every honest validator sends the same score. The
  median protects against a minority that lies or runs a different version.
  It is not a source of independent judgement.
- The proposer can **leave out** the votes. That is censorship, and only
  delays the record. It cannot **forge** them (each is checked against the
  validator's ed25519 key).
- The ed25519 check is not post-quantum. Each validator's ML-DSA signature
  covers the block, not the payload, so that the certificate format stays the
  same. A post-quantum payload signature would add 2.4 KB per validator per
  block.

**Tests.** `TestImmuneCodeScore`, `TestImmuneVotes`,
`TestImmuneKeepsPQCertificate` and `TestImmuneMalformedZX`. `TestImmuneVotes`
covers:

- deploy → pending list → payload;
- disagreement (a low and a high liar, where the median holds);
- missing validators (50% power records nothing);
- a forged entry (it does not count);
- the ML-DSA part inline and from the certificate;
- reading through the EVM;
- the threat gate refusing a call because of the immune score.

---

## (13) Protected-account mode: `0x…0904`

```solidity
function protect(uint8 mode, uint64 delaySeconds) returns (uint64 effectiveAt); // 0 off, 1 delay queue, 2 reject
function queue(address target) returns (uint64 usableFrom);
function protection(address) view returns (uint8 mode, uint64 delay, uint8 pendingMode, uint64 pendingAt);
function queuedFrom(address account, address target) view returns (uint64);
function highRisk(address target) view returns (bool, string why);
```

**What it does.** For an account that opted in, the ante handler (CheckTx, the
EVM mempool and blocks) stops these txs when they go to a **high-risk**
contract:

- calls, and value sent, to it;
- the spender or recipient argument of `approve`, `increaseAllowance`,
  `setApprovalForAll`, `transfer`, `transferFrom`, both `safeTransferFrom`,
  ERC-1155 transfers and Permit2 `approve`;
- bank sends to it.

What happens depends on the mode:

- **Mode 2 (reject):** the tx is refused.
- **Mode 1 (delay queue):** the tx is refused unless the account called
  `queue(target)` at least `delay` seconds earlier (1 h to 30 days). The queue
  entry is usable for one day.

High-risk means either of these:

- an immune score ≥ `protect_bps` (default 7000);
- an **enforced** flag in the ThreatRegistry that the threat gate points at.
  The registry is asked even when the gate itself is off.

A stronger setting applies at once. A weaker setting, or turning it off, waits
`max(delay, 1 day)`, so a stolen key cannot switch protection off first.
Accounts that never opted in are never checked (two store reads).

**Tests.** `TestGuardProtectedAccount` covers:

- not opted in;
- reject mode for a call, an approve, a transferFrom and a bank send;
- other accounts are unaffected;
- turning off waits a day;
- stronger is immediate;
- the delay-queue window;
- ThreatRegistry flags with the gate off.

**Limits.**

- Only the tx signer's own actions are seen. Contract wallets (Safe, passkey
  wallets) send from inside the EVM, which the ante handler cannot see.
- Calldata wrapped in multicall or routers is not decoded.
- A tx that passed CheckTx but is refused in the block, because the state
  changed meanwhile, fails without running and without a fee.

---

## (31) Bridge circuit breaker

**What was built.** Governance can watch up to 4 bridge contracts, such as
BridgeGuard or the Saphan/Hyperlane lock boxes. For each one it names the
outflow event: `topic0`, which indexed topic holds the recipient, and which
data word holds the amount. Examples:

- BridgeGuard `Outbound(bytes32 indexed route, address indexed from, uint256
  amount)`: `recipient_topic` 2, `amount_word` 0.
- Saphan `Locked(nonce, sender, to, amount)`: `recipient_topic` 3,
  `amount_word` 0.

Each block, every node computes these deterministically from the receipts'
logs:

- outflow volume;
- the number of outflows;
- recipients never seen before for that bridge.

Both Ethereum txs and `MsgEVMCall` are counted, including inner calls (all of
a tx's logs). The baseline is an exponential moving average of the per-block
volume: alpha = 2^-`baseline_shift` (default 7, about 128 blocks), and idle
blocks count as 0.

In its vote on N+1, each validator flags the bridge for block N when all three
hold:

- `volume ≥ min_volume`;
- `volume ≥ baseline × vol_mult_bps / 10000`;
- `new recipients / outflows ≥ new_ratio_bps / 10000`.

The flag goes in the same vote-extension payload as the immune scores. If
validators with **more than 2/3 of the power** flag it (checked with their
signatures in N+2), the chain calls the bridge's `pause()` at the start of
block N+2. The caller is `BreakerAddress`, a module address
(`authtypes.NewModuleAddress("zetaphy-breaker")`) whose key does not exist.

**Setup on the bridge.** Governance must make `BreakerAddress` a pauser. For
BridgeGuard that is `setGuardian(BreakerAddress, true)`; for the Saphan lock
boxes, their `onlyGuardian` role. Without it the call fails. The trip is
still recorded with `ok=false` (event `zetaphy_breaker_pause`), and the chain
goes on.

**Unpause only through governance.** The chain never calls `unpause()`, which
is the bridges' own governance-only function. After a trip the breaker stays
quiet: validators stop flagging that bridge and no second pause is sent.
Governance re-arms it with `breaker-rearm`.

**Tests.** `TestBridgeBreakerDrain` runs a mock bridge with BridgeGuard's
`pause()` rule and an `Outbound`-style event:

- 20 normal blocks are not flagged;
- a big outflow to known recipients is not flagged;
- a simulated drain to fresh addresses is flagged;
- 2 of 4 validators flagging does nothing;
- 3 of 4 without the pauser role records a failed trip;
- 3 of 4 with the role pauses the bridge;
- a tripped breaker does not fire again;
- re-arm works;
- removing the bridge refuses its flags.

**Limits.**

- The rule is a simple statistical one. A slow drain spread over many blocks
  under `min_volume` per block is not caught, so per-route daily limits in
  the contracts are still needed.
- Validators run the default rule. The vote-extension design lets a validator
  use a different local policy, but none is shipped.
- Recipients are counted per bridge in a "seen" set that grows with distinct
  recipients (one key each). That is fine for a testnet. Mainnet would need
  pruning.
- Detection happens one block after the drain and the pause one block after
  that (N → N+2), so the drain block itself is not stopped.

---

## (33) Anomaly hold for opted-in accounts: `0x…0904`

```solidity
// the account and its native-coin rule
function holdOptIn(address guardian, uint64 timeoutSeconds, uint256 minAmount, uint32 multBps);
function requestRelease(uint256 amount) returns (uint64 readyAt);
function confirmRelease(address account);      // the guardian only
function cancelRelease(address account);       // the guardian or the account
function holdOptOut() returns (uint64 at);     // takes effect after the timeout
function cancelOptOut(address account);        // the guardian only
function holdState(address) view returns (...);

// ERC-20 rules: one per token, up to 16 per account, same guardian and timeout
function holdToken(address token, uint256 minAmount, uint32 multBps);
function requestTokenRelease(address token, uint256 amount) returns (uint64 readyAt);
function confirmTokenRelease(address account, address token);   // the guardian only
function cancelTokenRelease(address account, address token);    // the guardian or the account
function holdTokenOptOut(address token) returns (uint64 at);    // takes effect after the timeout
function cancelTokenOptOut(address account, address token);     // the guardian only
function holdTokenState(address account, address token) view returns (...);
function holdTokens(address account) view returns (address[]);
```

**What it does.** For an account that opted in, the chain keeps cheap
statistics per rule: the number of outflows and their moving average
(alpha 1/8). Two fields of state per rule, updated in the ante handler of
block txs. The native coin has one rule (`holdOptIn`); each ERC-20 the
account adds with `holdToken` has its own, with its own threshold in that
token's units (token units and prices differ, so one profile per token).

An outflow is **held** when it is above the rule's `minAmount` and either:

- among the rule's first 5 outflows (warm-up), or
- above `average × multBps / 10000`.

A held outflow is refused until the rule has a **release** that covers it:

1. The account calls `requestRelease(amount)` (native) or
   `requestTokenRelease(token, amount)`.
2. The release becomes usable either:
   - after the timeout (1 h to 30 days), or
   - **at once when the guardian confirms it**. The guardian is the second
     key: an ML-DSA-44 account (post-quantum, through `MsgEVMCall`), a
     passkey wallet contract (P-256 through `0x100`), or any other account
     that is not the account itself.

A release lasts one day, and its amount is used up by the outflows it covers.
The guardian (or the account) can cancel a release. Opting out waits the
timeout, and the guardian can cancel the opt-out; that holds for the whole
account (`holdOptOut`, which also ends every token rule) and for one token
(`holdTokenOptOut`). Adding a token rule is immediate (it only makes the
account stricter). A new opt-in after an opt-out starts with an empty profile
and no token rules. Accounts that did not opt in are never checked.

**What counts as an outflow.** Only what the signer's own messages state,
summed per rule over the whole tx:

| | counted under | teaches the profile |
|---|---|---|
| Ethereum tx value, `MsgEVMCall` value | native | yes |
| bank `MsgSend` / `MsgMultiSend`, IBC `MsgTransfer`, ICS-20 precompile `transfer` (`0x…0802`) | native for the EVM denom; the token for a coin with a token pair (`erc20/0x…`, IBC denoms with an ERC-20 interface) | yes |
| `transfer(to, amount)`, `transferFrom(signer, to, amount)` on a token | the token; **native** on the native coin's ERC-20 interface (`0xEeee…EEeE`, or any token pair of the EVM denom) | yes |
| `approve`, `increaseAllowance` on a token, Permit2 `approve(token, spender, amount, expiration)` | as above | **no** |
| `MsgConvertERC20` / `MsgConvertCoin` to *another* address | the token / the coin's rule | yes |

Approvals are checked as if the approved amount left the account, because
"approve, then the attacker pulls" is how most token drains work. They do
not teach the profile (an approval is not a payment), so an **unlimited
approval is always held** until a release covers it (`requestTokenRelease`
takes amounts up to `2^256 - 1`). A user who approves a DEX router asks the
guardian to confirm once, or waits the timeout.

**Cost in consensus.** Accounts that did not opt in: the two existing store
reads. An opted-in account: one read per rule touched, a 4-byte selector
switch, and for coins a token-pair lookup; the hold's lookups run on a free
gas meter, so they never change a tx's gas. ICS-20 calldata is ABI-decoded
only when the target is `0x…0802`. Everything is integer math on `big.Int`
in the order the tx states the outflows.

**Tests.** `TestAnomalyHold` (native rule):

- not opted in;
- the guardian must be another key;
- warm-up;
- the learned profile;
- a drain-sized outflow held in CheckTx and in a block;
- other accounts are unaffected;
- guardian confirmation (a stranger or the account itself cannot confirm);
- releases larger than requested, or used up, do not cover;
- cancel, then release by timeout;
- opt-out with cancel and the timeout;
- the `holdState` view.

`TestAnomalyHoldERC20` (token rules):

- a token rule needs the opt-in first; the native coin's interface cannot be
  added as a token; no duplicate rule;
- warm-up and the learned profile per token; token outflows do not touch the
  native profile; a token without a rule and other accounts are unaffected;
- a drain-sized amount is held, in CheckTx and in a block, through each of:
  `transfer`, `transferFrom(self)`, `approve`, an unlimited `approve`,
  `increaseAllowance`, Permit2 `approve`, bank send, multi-send, IBC
  `MsgTransfer`, the ICS-20 precompile, `MsgConvertERC20` and
  `MsgConvertCoin` to another address;
- held outflows teach nothing; pulling someone else's tokens, Permit2's
  selector on another contract and converting to oneself are not counted;
- approvals are checked but do not teach; two transfers in one tx add up;
- guardian confirmation (not a stranger, not the account), more than
  released, CheckTx does not use the release up, used up;
- the account's own cancel, release by timeout (not before), releases expire;
- an unlimited approval released by the guardian;
- token opt-out: only the guardian cancels it, and it takes effect after the
  timeout;
- an ordinary contract call by an enrolled account (this found and fixed an
  out-of-range slice in `guardTargets` that made such calls panic).

`TestAnomalyHoldNativeERC20`: `transfer` and `approve` on `0xEeee…EEeE`, IBC
and `MsgConvertCoin` of the native coin are held under the native rule and
teach it; the account's opt-out ends its token rules; a new opt-in starts
with no rules and an empty profile.

**Limits.**

- Only the signer's own messages are seen, as in (13). Not seen:
  - a contract that moves tokens internally: a DEX router or aggregator
    spending an approval, a smart-contract wallet, `multicall`, a vault
    withdraw-to;
  - an EIP-2612 `permit` or Permit2 signature signed off chain and submitted
    by someone else (the signature is the approval; it never passes through
    the account's own tx);
  - approvals given **before** opting in (revoke them after opting in);
  - ERC-721 / ERC-1155 (no amounts to profile), fee-on-transfer and rebasing
    tokens are counted at the stated amount.
- `transferFrom` signed by a spender is not counted for the owner: the hold
  meters the owner's `approve` instead. An approval to a spender that later
  pulls in several steps is checked once, at approval time.
- Calldata inside multicalls or batch calls is not decoded.
- A thief with the account key can still drain after the timeout if the
  guardian does nothing. The hold buys time; it is not a veto.
- The profile is a moving average, not a learned model. "Profile-breaking"
  means a large jump compared with the account's past.
- Running v5 chains: the new rules change which txs of **opted-in** accounts
  are accepted, so every validator must switch to this binary at the same
  height (no store migration; nothing changes for accounts that did not opt
  in).

---

## Performance and safety in consensus

**Per-block cost** when everything is on:

- reading ≤ 16 contracts' code and walking their opcodes in ExtendVote
  (microseconds);
- ≤ 4 bridges' stats;
- in PreBlocker, one ed25519 verification per validator (about 50 µs each);
- one EVM call only when a breaker trips.

When everything is off, the cost is a few store reads.

**Extension size.** The payload is at most 3 + 1 + 16·22 + 1 + 4·20 = 437
bytes per validator. `MsgZXVotes` holds at most 200 entries and 1 MiB.

**Memory.** One cached model (≤ 64 KiB parsed) is the only new memory. That
fits on 1 GB validators.

**Determinism.**

- Everything that changes state uses integers, `big.Int`, and keys iterated
  in sorted order.
- The bytecode score is pure.
- The vote payload can differ between validators. That is the point of
  voting, and it never decides state except through the checked median or the
  2/3 count.

**Fail-safe.**

- A malformed or forged vote entry is skipped, never the block.
- A failing `pause()` is recorded, not fatal.
- A panic while building a payload drops the payload, not the vote.
- A broken model is refused when governance sets it.

## What remains

- Factory-deployed contracts for the immune system (needs a consensus-safe
  tracer).
- A post-quantum signature over the payload (or merging it into the
  certificate message, which changes the light-client format).
- The anomaly hold sees only what the signer's own messages state (see its
  limits): token movements inside contracts would need a consensus-safe
  tracer over the EVM's transfer logs.
- Decoding multicall and router calldata in protected mode.
- Pruning the breaker's "seen recipients" set.
- More live devnet coverage. `zetaphy-chain/test-vote-keys.sh` step 9 runs on a
  real two-validator devnet with a full node, and passed in this round:
  1. governance turns the immune system on;
  2. a contract is deployed with an Ethereum tx (`tools/ethsign`);
  3. both validators score it in their vote extensions, after the ML-DSA
     signature;
  4. the 5500 bps median is recorded identically on a validator and on the
     full node;
  5. the PQ certificates continue.

  The breaker, the AI precompile and the account guard are tested only in the
  fork tests, which drive the real handlers (ExtendVote payload,
  VerifyVoteExtension, PrepareProposal tx, PreBlocker, BeginBlock, ante and
  precompiles) inside one app. They have not run on a live chain yet.
- `zetaphyd tx sign` of the hand-built `zetaphy.pq.v1` messages: their JSON
  form is not complete, which was already so before v5. Broadcasting them
  directly works. The devnet test therefore deploys with an Ethereum tx.
