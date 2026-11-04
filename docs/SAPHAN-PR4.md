# ZETAPHY Saphan PR 4: one aggregated proof per transfer, and sealed cross-chain orders

**Testnets only. Nothing here is audited or deployed. No mainnet, no real money.** Saphan is ZETAPHY's cross-chain
bridge (docs/SAPHAN-MULTICHAIN.md, SAPHAN-GATEWAY.md, SAPHAN-SAFETY.md, SAPHAN-PROOFS.md, SAPHAN-PR5.md,
SAPHAN-PR6.md). This PR adds two pieces:

| Item | What | Real or prototype | Where (zetaphy-network) |
|---|---|---|---|
| S1 | One aggregated post-quantum certificate per transfer, or one per batch of transfers | real (tested with real ML-DSA-44 keys) | `contracts/SaphanAggLane.sol`, `src/saphanagg.js`, `test/saphanagg.test.js` |
| S6 | Orders encrypted to a solver's ML-KEM-768 key, committed on chain, revealed later | real (tested end to end); see the limits | `contracts/SaphanSealedOrders.sol`, `src/saphansealed.js`, `test/saphansealed.test.js` |

Offline commands: `node scripts/saphan.js agg batch|digest|cert …` and `sealed key|seal|open …`
(`scripts/saphan-ops.js` lists every option).

## S1: one certificate instead of many transactions

### The problem

The airlock (`BridgeAirlock`) only lets a transfer into ZETAPHY when two independent "lanes" both say it happened.
One lane is Hyperlane. Another can be the Neuro runners (`NeuroLane`): today **each runner sends its own transaction**
to vote, and the lane attests after `quorum` votes. Three runners = three transactions per transfer.

### What `SaphanAggLane` does

The attesters (a committee of up to 32) each hold an **ML-DSA-44** key (post-quantum signatures). They sign off
chain, and anyone brings **one certificate** on chain:

```
 committee members (off chain)                          ZETAPHY
 watch the lockbox, agree on transfers
 build a Merkle tree of them (src/saphanagg.js)
 each signs digest(root) with ML-DSA-44  ─▶ anyone: certify(root, certificate)   checked ONCE:
                                              t entries [key 1312 B | signature 2420 B], keys sorted by hash,
                                              each key a member, each signature checked by the precompile 0x…0900
                                            anyone: attest(transfer, root, path)  or  attestMany(transfers, root, paths)
                                              ─▶ BridgeAirlock.attest(...)  (this lane's one vote)
 one transfer: root = its leaf, no path  ─▶ certifyAndAttest(transfer, root, [], certificate)  (one call)
```

- **Digest**: `keccak256(abi.encode(TAG, chain id, lane address, epoch, root))`. A certificate cannot be reused on
  another chain, another lane, or after the committee changed.
- **Hash-sorted keys**: keys must come in increasing order of their hash, so one member cannot count twice; exactly
  `threshold` entries.
- **Batches**: one certificate covers every transfer under the root. Each transfer is then attested with its Merkle
  path (sorted pairs, double-hashed leaf). A path for another transfer, a changed amount, or an unknown root is refused.
- **Committee changes**: only governance (the `ZetaphyTimelock`), with bounds: at least 2 signers, more than half the
  committee, at most 32 members. A new committee bumps the **epoch**: every root of the old one stops counting.
- **Still one lane**: the airlock's rules do not change. The committee alone cannot mint anything: Hyperlane must
  agree too, then the quarantine, vetoes, marks, Neuro flags and the guard's daily limits apply. A guardian can still
  remove the lane at once.
- **Re-adding a lane**: if the airlock removes the lane and adds it again, the lane may attest again; the airlock
  alone decides what counts twice (the lane keeps no list of its own).

### Gas (measured in `test/saphanagg.test.js`)

ML-DSA-44 verification charged at ZETAPHY's precompile price, 30,000 gas. Totals include 21,000 per transaction
and the calldata. Committee of 4, threshold 3.

| Path | Gas | Per transfer |
|---|---|---|
| A plain key's attestation (no proof at all; the airlock's own bookkeeping) | 154,694 | 154,694 |
| NeuroLane today: 3 runner votes (3 transactions) | 317,472 | 317,472 |
| One certificate for one transfer (`certifyAndAttest`) | 448,600 | 448,600 |
| One certificate for 16 transfers (`certify` 327,504 + `attestMany` 1,938,796) | 2,266,300 | **141,644** |

What this says, honestly:

- **For a single transfer, the certificate costs more** than three cheap votes. Most of it is calldata: three ML-DSA
  keys and signatures are about 11 KB. What you buy is post-quantum signatures and one transaction instead of three.
- **For batches it is cheaper**: at 16 transfers it is less than half the per-lane path, and cheaper than even one
  plain-key attestation (the certificate's cost is shared, and one transaction carries all 16).
- Most of the remaining cost is the airlock's own storage per attestation (about 120,000 gas), which this PR does
  not change.

### Not done in S1

- An **aggregated STARK** (many messages proven by one STARK proof) was not built: the Merkle batch gives the
  "many messages, one check" saving without a new prover.
- A runner program that watches the lockbox, agrees on a batch and collects signatures is not part of this PR (the
  JS builds the tree, digest and certificate; the network part is to do).
- Keys and signatures travel in calldata each time. Storing the keys on chain would cost more to read than to send.

## S6: orders sealed with ML-KEM

### The problem

An intent (`SaphanIntents`, PR 5: "I give A, I want at least B on chain Y for this recipient by time T") is public as
soon as it is opened. Anyone watching can act on it first.

### What `SaphanSealedOrders` does

```
 solver   ── setSolverKey(X-Wing key: ML-KEM-768 + X25519, 1216 bytes)
 user     ── seal order + random salt to that key (src/saphansealed.js)
          ── commit(solver, token, amount, refundTo, window, commitment, ciphertext)   tokens go into escrow
             (from another chain: depositAndCall with data = abi.encode(solver, refundTo, window, commitment, ciphertext))
 solver   ── reads the Committed event, decrypts, checks the commitment
          ── within the window: reveal(id, order, salt)  ─▶ SaphanIntents.open(order): an ordinary intent
             or, for a fill on ZETAPHY: revealAndFillLocal(...)  reveal + open + fill in ONE transaction
 nobody revealed in time ─▶ anyone: refund(id) ─▶ refundTo: claim(token)
```

- **What is hidden**: the destination chain, the recipient, the minimum and the deadline. **What is public**: the
  token, the amount, `refundTo` and the chosen solver (they are needed to hold the escrow). Every ciphertext is the
  same length (1424 bytes), so the length says nothing.
- **The commitment binds the plaintext**: `keccak256(abi.encode(TAG, chain id, contract, solver, order, salt))`. The
  solver cannot change any field when it reveals; the order must spend exactly the escrow (same token, amount and
  refundTo). The 32-byte salt stops anyone guessing the order from the commitment.
- **Encryption**: X-Wing, the same KEM as the encrypted mempool (`src/encmempool/kem.js`, from
  `@noble/post-quantum`, already a dependency): it stays safe as long as either ML-KEM-768 or X25519 holds. The
  message is sealed with AES-256-GCM, and the associated data ties the ciphertext to the chain, contract, solver and
  commitment, so it cannot be moved to another order.
- **Only the chosen solver** can reveal, and only before the window ends (1 minute to 1 day, a constant).
- **Refunds**: if nobody reveals, anyone calls `refund`, and `refundTo` pulls the tokens. An order SaphanIntents
  refuses (expired, risky recipient by Neuro's score or the ThreatRegistry) cannot be revealed, so it is refunded the
  same way. Payouts are pulls; `nonReentrant` on every function that moves tokens; no admin, nothing to govern.
- **Local fills**: `revealAndFillLocal` reveals, opens and fills in one transaction, so a ZETAPHY order is never
  public before it is done. A solver the ThreatRegistry holds cannot use it. The solver's tokens pass through the
  contract without touching other users' escrow.

Gas measured in the tests: `commit` about 321,000 (most of it is the 1424-byte ciphertext and the escrow record),
`reveal` about 362,000 (it also opens the intent in SaphanIntents).

### Limits of S6

- The contract **cannot check** that the ciphertext really holds the committed order (only the solver's secret key
  can). A user who seals garbage only locks their own tokens until the window ends.
- A solver that does not reveal costs the user time (the window), not money. There is no solver bond or penalty: a
  bond could be griefed by users sealing garbage on purpose.
- After a cross-chain reveal the order is an ordinary public intent: another solver may fill it first on chain Y.
  That does not hurt the user (they are paid); the solver's head start is only the reveal itself.
- The solver itself sees the order before anyone else. Choose a solver you are willing to trust with that, or a group
  of solvers sharing one key.
- Keep the secret seed of a key until every order sealed to it has been revealed or refunded.

## Deploying (not done yet)

`SaphanAggLane(airlock, ZetaphyTimelock, committee key hashes, threshold)` on ZETAPHY, then the airlock's governance
adds it as a lane (through the timelock). `SaphanSealedOrders(SaphanIntents)` on ZETAPHY; solvers call
`setSolverKey`. There are no hub screens for these yet (CLI and contracts only).

## Audit notes

The fast audit (slither + aderyn) shows no High finding in the two new contracts. Two Medium findings remain, both
read and judged harmless: `incorrect-equality` on `key == bytes32(0)` (a "no key registered" check, not a balance),
and `unused-return` on the ThreatRegistry's `(held, reason)` view (only `held` is needed).
