# ZETAPHY Saphan: proven releases, Bitcoin deposits by proof of work, proof of reserves

**Testnets only, not audited.** Saphan PR 3: where a route can stop trusting people and trust math instead.

| What | Before | Now |
|---|---|---|
| ZETAPHY -> source chain | our validators sign each release (ECDSA, an ISM) | the release is **proven from ZETAPHY's state**: a STARK light client of ZETAPHY on the source chain (ML-DSA-44 finality votes counted), an IAVL / multistore path to the block's app hash, a Merkle path in ZetaphyOutbox. With `requireProof` on, no signer can release anything |
| Bitcoin -> ZETAPHY | (no route) | a lane that attests deposits by **Bitcoin's proof of work** (BtcLightClient, SPV with confirmations) |
| Reserves | read two chains by hand | every heartbeat carries token(X)'s supply on ZETAPHY; `lockbox.reserves()` shows held / supply / bps |

## Proven releases (ZETAPHY -> X)

```
 ZETAPHY                                                   source chain X
 SaphanProvableOutbox(X).send(to, amount)
   ├─ HyperlaneOutbox.send ── Hyperlane release ─────────▶ HyperlaneLockBoxV2.handle   (refused when requireProof)
   └─ ZetaphyOutbox.send(X, lockbox, the SAME body)
         its root is in ZETAPHY's state
                         StarkLightClient (on X): block H final ─▶ SaphanReleaseVerifier.prove(H, state proof, leaf)
                                                                     └─▶ lockbox.queueProven(body)
 the same body = the same release id: whichever path comes first queues it, the other is a replay.
 After queueing, the lockbox's usual delay, veto, pause, daily limit and backing checks apply.
```

- `SaphanProvableOutbox` has the outbox's `send` / `quoteSend`, so the Gateway and wallets use it unchanged
  (approve it for token(X)). It writes the body the outbox is about to send (same nonce) into ZetaphyOutbox.
- `SaphanReleaseVerifier` takes the leaf only from the provable outbox, to this lockbox on this chain.
- `lockbox.setProofVerifier(verifier, requireProof)` (governance). `requireProof = false`: both paths (proofs
  speed nothing up but remove nothing either); `true`: only proofs.
- **Post-quantum end to end**: STARKs are hash-based; ZETAPHY's finality certificates are ML-DSA-44 votes (its
  pq modes, docs/future/trustless-bridge.md). No ECDSA key is on the path of a proven release.
- What a relayer builds: `src/starkbridge` (light-client proof of block H, ICS23 proofs from `abci_query
  store/evm/key` at H-1, the leaf path from ZetaphyOutbox's `MessageSent` events) and `src/saphanproofs.js`.

## Bitcoin deposits (BtcSpvLane)

A deposit is a Bitcoin transaction with an output to the route's custody script and an OP_RETURN
`"ZTPHY" || <20-byte ZETAPHY recipient>`. Anyone submits it with its block and Merkle branch; the light
client checks the proof of work and confirmations (default 6); the lane attests
`(BTC_CHAIN_ID, custody id, keccak256(txid, vout), 0, recipient, sats x 10^10)` to the BTC route's airlock. The
airlock still needs its other lane (the Neuro runners watching Bitcoin), the quarantine and the threat checks.
Each output attests once. Sending BTC back needs keys on Bitcoin: not before an external audit (order 6 has a
BitVM2 prototype).

## Proof of reserves

`SaphanCheckpointer` now puts token(X)'s `totalSupply()` on ZETAPHY into every heartbeat (192-byte body). The
lockbox records it with the time: `reserves()` returns `(held, supply, asOf, bps)`; bps >= 10000 means every
bridged coin is backed. A burn that is on its way shows as over-backed for a moment, never under. The heartbeat is
signed by our validators like a release; with the STARK light client the supply can also be read from ZETAPHY's
state, the same way as a release.

## Not in this PR

- **IBC (Cosmos Hub / Osmosis)**: needs a relayer that runs all the time (Hermes), more than the free node can
  carry. Moved to Saphan PR 6 (more chains).
- An Ethereum light client on ZETAPHY (inbound without Hyperlane's validators): Ethereum's sync committee in a
  STARK, in order 4 (one proof per message).

Contracts: `contracts/SaphanProofs.sol`, `contracts/BtcSpvLane.sol`, `contracts/HyperlaneLockBoxV2.sol`
(`queueProven`, `requireProof`, `reserves`), `contracts/SaphanCheckpointer.sol`. Tests: `test/saphanproofs.test.js`.
