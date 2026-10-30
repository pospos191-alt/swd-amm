# Trustless bridge: ZETAPHY → Ethereum and Bitcoin (prototype)

**Testnet prototype, not audited.** Test keys only. Builds on the STARK light client
([stark-light-client.md](stark-light-client.md)); read that first for what the STARK proves (Stage A) and what it does not.

Goal: move assets out of ZETAPHY with **no multisig and no trusted relayer**: a relayer (anyone) only carries proofs;
what is released is decided by the proofs. This document says exactly how far the prototype gets, per mode.

| Piece | Where |
|---|---|
| On-chain STARK verifier (port of `src/starklc/verifier.js`, SHA-256 precompile, modexp) | `zetaphy-network/contracts/StarkVerifier.sol` |
| Light client on Ethereum: genesis pin, handoffs, block headers + app_hash, optimistic signature disputes | `contracts/StarkLightClient.sol` |
| ZETAPHY-side commitment: append-only Merkle outbox (root in storage slot 0) + a lockbox | `contracts/ZetaphyOutbox.sol` |
| Ethereum-side release: ICS23 IAVL + multistore + outbox proofs, replay protection, rate limit, pause | `contracts/ZetaphyBridgeInbox.sol` |
| Bitcoin headers + SPV on ZETAPHY (BTC → ZETAPHY deposits) | `contracts/BtcLightClient.sol` |
| Off-chain proof building (CometBFT header hash, multistore, IAVL, outbox tree) | `zetaphy-network/src/starkbridge/` |
| Tests: two in-memory chains end to end, forgeries, gas | `test/starkbridge.test.js`, `test/btclc.test.js` |
| Real Bitcoin mainnet fixture (rebuilt and re-checked from public files) | `test/fixtures/btc-mainnet.json`, `scripts/btc-fixture.js` |

## 1. Architecture (ZETAPHY → Ethereum)

```
ZETAPHY (Cosmos SDK + cosmos/evm)                         Ethereum
───────────────────────────────────                       ─────────────────────────────────────────────
user ─lock─> ZetaphyLockbox ─send─> ZetaphyOutbox         StarkLightClient (pinned genesis set root)
                      slot 0 = sha256(treeRoot‖count)        ▲ submit(proof, app_hash, 4 aunts)
block h: state changes                                       │   StarkVerifier: full STARK check (on chain)
block H > h: header.app_hash = state after H-1               │   header Merkle: app_hash → block hash
validators sign "zetaphy/pq-vote" ‖ chain ‖ H ‖ hash         │   window / submitChecked → final app_hash(H)
   (ML-DSA-44 certificate in block H+1)                      │
prover (anyone): collectFromNode → proveBlock ──────────────┘
relayer (anyone): abci_query store/evm/key prove=true ──> ZetaphyBridgeInbox.release(H, state proof, message, path)
                                                           app_hash(H) ─multistore ops─> evm store root
                                                           ─IAVL ops─> key 0x02‖outbox‖slot0 = outbox root
                                                           ─32 SHA-256 siblings─> message leaf
                                                           sender = lockbox, dst = this chain/contract,
                                                           nonce unused, rate limit, not paused → transfer
```

### What root is available, and why an outbox

A CometBFT header commits to `app_hash` (the Cosmos multistore root, **the state after the previous block**), the
validator set hashes, and `last_results_hash`. The bridge needs to prove "this lock happened":

- **EVM logs are not in the state.** cosmos/evm keeps blooms and receipts in a transient object store; the JSON-RPC
  receipts are rebuilt by the node, not committed in `app_hash`.
- **`last_results_hash` does commit the logs, indirectly.** It is the Merkle root of each tx's deterministic
  `ExecTxResult` (code, data, gas wanted, gas used); `data` is the `TxMsgData` whose `MsgEthereumTxResponse` carries
  the logs. Proving a log that way means decoding nested protobuf (`TxMsgData → Any → MsgEthereumTxResponse → Log`)
  in Solidity, tied to cosmos/evm's message layout and version. Possible, fragile; not done here.
- **Chosen: a commitment contract.** `ZetaphyOutbox` appends each message to a depth-32 SHA-256 Merkle tree
  (the Ethereum deposit-contract construction) and stores `sha256(treeRoot ‖ count)` in **storage slot 0**. In
  cosmos/evm (`x/vm/types/key.go`) a slot lives in the `evm` IAVL store under `0x02 ‖ address ‖ slot` with the
  32-byte value, so `app_hash → (ICS23 Tendermint ops) → evm store root → (ICS23 IAVL ops) → slot 0 → (Merkle path)
  → message` uses only stable, standard formats — the same ones IBC uses. One header proves every message sent before
  it (append-only), so one light-client update serves a whole batch.

Formats, checked in tests against reality where possible:

| Step | Format | Checked against |
|---|---|---|
| block hash | CometBFT `Header.Hash()`: simple Merkle (leaf `0x00`, inner `0x01`) over 14 protobuf fields | the **real devnet blocks 13 and 14** in `fixtures/pqcert-devnet.json` (JS and Solidity) |
| app_hash in header | field 10 of 14: leaf `0x0a 0x20 ‖ app_hash`, 4 aunts | same real blocks; another 32-byte field in that position fails |
| evm store in app_hash | ICS23 `TendermintSpec`: leaf `0x00 ‖ len‖"evm" ‖ 0x20 ‖ sha256(root)`, ops `0x01‖left` / `0x01`+right | Cosmos SDK `store/internal/maps` (KV pair, hashed value) |
| slot in evm store | ICS23 `IavlSpec`: leaf `zz(0) zz(1) zz(version) ‖ len‖key ‖ 0x20 ‖ sha256(value)`, inner `zz(h) zz(size) zz(v) 0x20 [left 0x20]` | cosmos/iavl v1.2.8 `writeHashBytes`, ics23 `validateIavlOps` rules (height ≥ level, remaining 1 or 34 bytes, no leaf prefix on inner) |
| message in outbox | `sha256(abi.encode(tag, srcChainId, outbox, nonce, sender, dstChainId, receiver, sha256(payload)))`, 32 siblings | the contract's own root (JS = Solidity) |

The IAVL/multistore proofs in the end-to-end test come from a **simulated** ZETAPHY state built with these exact
encodings (a real block hash and the real header encoding, but a synthetic app hash); proving against a live node's
`abci_query(prove=true)` is the next step (the ops map 1:1 onto `ZetaphyBridgeInbox.StateProof`).

## 2. On-chain verification and its gas

`StarkVerifier` replays the Fiat–Shamir transcript with the SHA-256 precompile and checks everything the JS verifier
checks (composition at z, reveals, DEEP, Merkle multi-openings of trace/set/Q, every FRI layer, the final
polynomial, grinding). It is tested to agree with the JS verifier, rejects 40+ tampered byte positions, wrong set
roots, wrong chain ids and weak parameters, and verifies a proof of the **real devnet certificate** (Go-built).

Measured on the repo's in-memory EVM (Cancun), default parameters (28 queries, blowup 16, 16 bits grinding = 128
conjectured bits); "tx total" = 21,000 + calldata (16/4 gas per byte) + execution (the EIP-7623 floor never binds here):

| n validators | mode | proof | revealed sigs | execution | calldata | **tx total** |
|---|---|---|---|---|---|---|
| 4 | none | 22.8 KB | 0 | 1.02 M | 0.33 M | **1.37 M** |
| 4 | all | 38.2 KB | 4 | 1.58 M | 0.57 M | **2.18 M** |
| 21 | none | 30.0 KB | 0 | 1.43 M | 0.45 M | **1.89 M** |
| 21 | all | 111.6 KB | 21 | 4.33 M | 1.74 M | **6.09 M** |
| 21 | sample-128 | 112.3 KB | 21 | 4.72 M | 1.75 M | **6.49 M** |
| 100 | none | 44.6 KB | 0 | 2.26 M | 0.68 M | **2.97 M** |
| 100 | sample-128 | 326.7 KB | 73 | 12.87 M | 5.15 M | **18.05 M** |

Bridge operations (n = 4, `test/starkbridge.test.js` prints them):

| operation | tx total |
|---|---|
| `StarkLightClient.submit` block, mode all (optimistic) | 2.36 M |
| `submit` block, mode none (trusted prover) | 1.60 M |
| `submit` handoff, mode all | 2.30 M |
| `ZetaphyBridgeInbox.release` (IAVL 4 levels + multistore 4 + outbox 32 + token transfer) | **0.21 M** |
| `challenge` (one disputed ML-DSA-44 signature) | **≈ 14.3 M** (estimate, see below) |
| `submitChecked` block, 4 ML-DSA checks now | ≈ 59 M (estimate) — over a block |

**Decision: the STARK is verified fully on chain, no FRI bisection game.** Every case above fits a 30 M gas block
(mainnet's limit is higher today), the worst being n = 100 with 73 revealed signatures (18 M, mostly the revealed
signatures' calldata). An interactive FRI-query/layer bisection would only add latency and a liveness assumption to
save gas we do not need to save. It becomes relevant only if proofs grow past a block (much larger sets with `all`).

**ML-DSA-44 in Solidity** (no verifier exists in the repo; the chain's `0x…0900` precompile is a ZETAPHY precompile,
not on Ethereum). `test/helpers/MLDSACost.sol` measures the two dominant primitives on the same EVM: our Keccak-f[1600]
(checked against the KECCAK256 opcode) **107 k gas**, a 256-point NTT mod q **202 k gas**, 256 pointwise products 26 k.
FIPS 204 verify needs ≈ 100 permutations (ExpandA alone is 16 × 5 SHAKE128 blocks; SHAKE is not the KECCAK256 opcode),
≈ 13 NTTs, ≈ 24 pointwise polynomials and ≈ 4,000 decoding/range operations: **≈ 14 M gas per signature** with this
straightforward code; heavily optimized assembly might reach 3–7 M (public efforts report numbers in that range;
an ML-DSA precompile has been proposed). Either way, verifying 67 %+ of the signers directly is far beyond a block,
which is why signatures are covered by disputes below, and why Stage B (ML-DSA inside the STARK) is the real target.

## 3. Trust model per mode

What every mode shares (Stage A): the **genesis pin** (32 bytes, chosen at deployment, immutable); SHA-256
(collisions + Fiat–Shamir; 128 bits conjectured / 72 provable with default parameters — use the 60-query preset for
value); **validators are honest about what they sign** (a light client checks consensus, not state transitions);
the PQ certificate rule 3S > 2T − 3U as the chain applies it (validators without a vote key are not checked by
anyone's PQ signature); and **handoffs must be relayed before the old set's unbonding ends** (long-range attacks,
as for any PoS light client — anyone may relay them).

| Path | Validator-set accounting | ML-DSA signature validity | Extra trust | Latency | Status |
|---|---|---|---|---|---|
| mode `none`, `trustedProver` only | proven on chain | **trusted: the prover** | the prover could claim signers who did not sign | window | implemented; off unless `trustedProver ≠ 0` |
| mode `all` / `sample`, `submit` (optimistic) | proven on chain | revealed signatures are bound to the certificate commitment on chain; **any one invalid signature can be proven in `challenge`** (one tx, ≈ 14.3 M gas); `sample`: unrevealed rows covered by 128 bits of power-weighted sampling | **1 honest watcher** and Ethereum inclusion within the window; bond ≥ challenge cost | window | implemented, tested (forged signature rejected, bond paid to watcher) |
| `submitChecked` | proven | verified on chain at once | none beyond Stage A | immediate | implemented; impractical before an ML-DSA precompile (≈ 14 M gas × signers) |
| Stage B (ML-DSA in the STARK, recursion) | proven | **proven** | none beyond SHA-256 + pin | immediate | design only ([stark-light-client.md §5](stark-light-client.md)); expected 2–4 M gas |

Never trusted in any mode: the relayer, the prover's liveness aside, the RPC node, governance. **Governance on the
inbox can pause and cap releases (it can delay), never release**: the light client has no admin at all.

What makes it *not yet* trustless end to end, honestly:

1. **Handoff signatures do not exist on the chain yet** (vote extension change needed, see the STARK doc §2.4). Until
   then the light client cannot follow validator-set changes of the live chain; the tests sign handoffs with test keys.
2. Signature soundness is **optimistic** (1-of-N watcher) unless `submitChecked` is affordable or Stage B ships.
3. The ZETAPHY-side proofs are exercised against a simulated state with the real encodings, not yet a live node.

**Challenge window parameters.** A dispute is a single non-interactive transaction (no bisection rounds), so the
window only has to cover detection (seconds: anyone recomputes `ml_dsa44.verify` from the submission's calldata) and
inclusion under adversarial conditions. Recommended: **24 h** on mainnet (≈ 7,200 Ethereum blocks to get one 14.3 M
gas tx in), 1 h on testnets (tests use 1 h). Bond ≥ 2 × the challenge's cost at a high gas price (e.g. 14.3 M gas ×
50 gwei ≈ 0.72 ETH → **bond 1.5 ETH**); it pays the successful challenger. Two final hashes for one height (or two
roots for one epoch) prove that more than 1/3 of the stake equivocated: the client **freezes** (re-pinning is a social
decision, out of scope). Inbox: daily limit (guardian lowers at once, governance raises ×2 per step after 7 days),
pause (guardian) / unpause (governance), retryable releases (a release over the limit reverts and can be sent again).

## 4. Bitcoin

Bitcoin cannot verify a STARK (or any SNARK) in L1 script today. Options, honestly:

| Option | What it gives | Trust | Status |
|---|---|---|---|
| **Federated / threshold peg** (e.g. a FROST/Taproot key of ZETAPHY validators; tBTC-, Liquid-style) | BTC ↔ ZETAPHY both ways | t-of-n signers (and their key security); secp256k1 is **not PQ** | possible now (the repo has FROST secp256k1); *interim only* |
| **BitVM2-style** optimistic verification | peg-out where operators front BTC and are reimbursed unless a challenger shows, in Bitcoin script split across transactions, that their claim (a SNARK/STARK about ZETAPHY's state) is false | 1 honest challenger (safety), ≥ 1 honest operator (liveness), pre-signed transaction graphs by a committee at setup (existence of honest setup signer) | research/early deployments for SNARKs (Groth16, pairing-based: not PQ); a STARK verifier in script is far larger |
| **Covenants (OP_CAT, BIP-347; CTV, BIP-119)** | with OP_CAT, a STARK verifier can be written in script (demonstrated on signet / forks) → a real BTC light-client-of-ZETAPHY on Bitcoin | SHA-256 only — matches our proof system | **not activated** on Bitcoin; no timeline |
| **BTC light client on ZETAPHY** (this prototype) | BTC → ZETAPHY deposits: ZETAPHY verifies Bitcoin headers (PoW, difficulty, MTP) and SPV inclusion | Bitcoin PoW (heaviest chain shown) + checkpoint; confirmations scale with value | **implemented** (`BtcLightClient.sol`) |

So today ZETAPHY can do **BTC → ZETAPHY trust-minimized** (SPV on ZETAPHY) while **ZETAPHY → BTC needs signers**
(threshold peg) until BitVM-style constructions mature or covenants activate.

`BtcLightClient` (tested with **real mainnet data**, `fixtures/btc-mainnet.json`, built by `scripts/btc-fixture.js` from
public files — summa-tx/relays test vectors and bitcoinjs-lib's genesis block — and re-checked: every header's double
SHA-256 meets its target and links): 17 consecutive headers (562623–562639), the real **retarget at 306432**
(bits 0x185d859a → 0x1851aba2, recomputed from the period's timestamps), Bitcoin Core's `pow_tests.cpp` retarget vectors
(including both clamps), tampered nonce / bits / unknown parent / duplicate refused, and an SPV proof of a real
transaction in block 592920 (index 26, 12 siblings; wrong index, too few confirmations, a modified tx and 64-byte
"transactions" refused). Gas: **≈ 116 k per header** (4 storage writes and the median-time-past walk; ≈ 16.7 M gas a
day of Bitcoin blocks), **≈ 20 k per SPV check**. Not checked: version soft-fork rules, testnet's 20-minute rule, tx
validity (inclusion only). An SPV client trusts that the heaviest chain *it was shown* is Bitcoin's: deposits must
wait for confirmations proportional to their value.

## 5. Comparison

| Effort | Source chain consensus checked | Proof on Ethereum | Gas (order) | PQ? |
|---|---|---|---|---|
| **This prototype** | ZETAPHY's ML-DSA-44 certificate: set accounting proven; signatures optimistic (Stage A) | SHA-256 STARK, verified directly | 1.4–3 M (none), 2–6 M (all/sample, n ≤ 21) | yes (hash-based; signatures ML-DSA) |
| Succinct (SP1 Tendermint/Helios, Telepathy) | CometBFT ed25519 / Ethereum sync committee, in a zkVM | Groth16/PLONK wrapper | ≈ 0.25–0.3 M | no (pairings, ed25519/BLS) |
| IBC to Ethereum (e.g. IBC Eureka with SP1-proven CometBFT light client; Union's CometBLS + Groth16) | CometBFT light client in a SNARK | Groth16 | ≈ 0.3 M | no |
| zkBridge (Polyhedra; deVirgo + Groth16) | Cosmos/Tendermint ed25519 | Groth16 | ≈ 0.23 M | no |
| Polymer | IBC-based hub; rollup state via native settlement/state proofs | proofs of rollup state | low | no |
| BitVM / BitVM2 (Bitcoin) | a SNARK of the other chain, optimistic in Bitcoin script | — | many large txs only in a dispute | no (Groth16) |

The trade is explicit: a SNARK wrapper costs ≈ 10× less gas but rests on pairing assumptions a quantum computer breaks;
ZETAPHY's goal is a post-quantum path end to end, so the outermost proof stays hash-based. Stage B + recursion should
bring the PQ verifier to ≈ 2–4 M gas per update with full signature soundness.

## 6. Limits of the prototype

- Not audited; proof format v1 not frozen; Solidity verifier ≈ 17 KB of code (under the 24 KB limit).
- ZETAPHY side: simulated multistore/IAVL with real encodings; live `abci_query` proofs untested. The way back
  (Ethereum → ZETAPHY) mirrors this design (an Ethereum light client on ZETAPHY) and is not built.
- ML-DSA dispute cost is an estimate from measured primitives, not a full Solidity verifier; tests use a JS stand-in at
  a fixed address charging that estimate.
- The light client accepts block proofs only under the **current** set (blocks of an epoch must be submitted before
  its handoff finalizes); a freeze after equivocation needs an off-chain recovery decision.
- BTC client: no fork tests with real competing chains (mainnet PoW cannot be produced in a test); version rules not
  enforced; peg-out not built.

Reproduce: `cd zetaphy-network && npm run build && node --test test/starkbridge.test.js test/btclc.test.js`
(`STARKBRIDGE_FULL=1` adds the n = 100 rows, ≈ 1 more minute).
