**English** | [ภาษาไทย](encrypted-mempool.th.md)

# Post-quantum threshold-encrypted mempool (research prototype)

Testnet research only. Nothing here is in the chain yet: this is a JavaScript reference
implementation, a deterministic simulation and an integration plan for `zetaphy-chain`.
No consensus code was changed.

| Piece | Where | Status |
|---|---|---|
| Envelope format, client encryption | `zetaphy-network/src/encmempool/envelope.js` | done (prototype) |
| Hybrid KEM (ML-KEM-768 + X25519 = X-Wing) + AES-256-GCM | `src/encmempool/kem.js` | done, uses `@noble/post-quantum` (already a dependency) |
| Shamir t-of-n over GF(256) | `src/encmempool/shamir.js` | done |
| Per-epoch dealing, acks, committee | `src/encmempool/dealing.js`, `committee.js` | done (prototype; trust assumptions below) |
| ML-DSA-44 signed share release, key rebuild | `src/encmempool/release.js` | done |
| Ordering / decrypt / expiry state machine | `src/encmempool/ordering.js` | done |
| MEV simulation (AMM sandwich) | `src/encmempool/sim.js`, `scripts/encmempool-sim.js` | done, deterministic |
| Benchmarks | `scripts/encmempool-bench.js` | done |
| Tests | `test/encmempool.test.js` (part of `npm test`) | 10 tests |
| Chain integration (ABCI++) | this document, "Integration" | **design only** |

## The goal in one paragraph

A searcher who can read your swap before it is ordered can buy before you and sell after you
(a sandwich). Your swap still succeeds, at the worst price your slippage limit allows, and the
difference is the searcher's profit. The fix: users send transactions **encrypted**; the block
**fixes the order of the ciphertexts first**; only **after** that order is committed can the
validators (at least `t` of `n` of them) release what is needed to decrypt; the decrypted
transactions then run **in exactly the committed order** at the start of the next block. By the
time anyone can read your swap, every transaction that runs before it is already fixed.

## Design

### Keys

Every validator already has an **ML-DSA-44 vote key** (PQ block certificates,
`zetaphy-chain/README.md` items 5–6). The prototype adds one key per validator:

- an **X-Wing transport key** (ML-KEM-768 + X25519, `draft-connolly-cfrg-xwing-kem`), used only
  to receive key shares from dealers. On chain it would be registered with a message signed by
  the vote key (like `MsgPQVoteKey`).

### Epochs and dealing (`dealing.js`)

Time is cut into epochs of `L` blocks (prototype default 8 in the simulation, 32 in the
benchmark). Before epoch `e`, `d` **dealers** are picked from public randomness
(`selectDealers`; on chain: the PREVRANDAO value derived from the ML-DSA certificate). Each
dealer `i`:

1. draws a fresh 32-byte X-Wing seed `s[i,h]` **for every height** `h` of the epoch and publishes
   the public key `ek[i,h] = XWing.getPublicKey(s[i,h])` (X-Wing's secret key *is* the 32-byte
   seed, which is what makes the threshold step simple);
2. Shamir-splits every `s[i,h]` `t`-of-`n` over GF(256) and publishes a hash commitment to every
   share, `C[i,h,j] = SHA-256(tag, chain, e, i, h, j, share)`;
3. encrypts validator `j`'s shares (all heights in one blob) to `j`'s transport key;
4. signs the whole dealing with its ML-DSA-44 vote key and **erases the seeds**.

Each validator opens its blob, checks its shares against the commitments and signs an **ack**.
A dealing with at least `t` acks is accepted. Users always encrypt to **all** accepted dealers.

Why one key per height and not one per epoch: a per-epoch key would decrypt every later
transaction of the epoch as soon as it is released once. Per-height keys are released one block
at a time, which is what a threshold identity-based scheme (Shutter, Ferveo) gives with
"identity = height"; we cannot use IBE because no practical post-quantum threshold IBE exists,
so the dealer pre-generates the per-height keys instead.

### Envelope (`envelope.js`)

```
body  = "zetaphy/encmempool-envelope/v1" | chain id | u64 target height h | u32 epoch
        | u64 inclusion fee | u32 gas limit | payer ML-DSA-44 public key (1312)
        | u8 d | d x u16 dealer | d x X-Wing ciphertext (1120) to ek[dealer, h]
        | u32 len | AES-256-GCM(u32 len | tx | zero padding to 256 B) | tag
bytes = body | ML-DSA-44 signature of the payer over body (2420)
AEAD key = SHA3-256("zetaphy/encmempool-tx" | d | ss_1..ss_d | header-and-KEM-ciphertexts)
AAD      = header-and-KEM-ciphertexts
```

- The inner `tx` is an ordinary signed ZETAPHY transaction (EVM or native PQ); the envelope does
  not replace its signature.
- The envelope is valid **only in block `h`**. Keys for `h` become public right after `h`, so an
  envelope for `h` that shows up in a later block would already be readable: such proposals are
  rejected. Users who miss `h` re-encrypt for a later height.
- The AAD binds the payload to the height, epoch, fee, payer and dealer set. A relay that strips
  the outer signature and re-signs as itself gets a valid-looking envelope that never decrypts.
- Padding to 256-byte buckets hides the exact size of the transaction (not its bucket).

### Ordering, release, decryption, expiry (`ordering.js`, `release.js`)

```
block h        proposer includes envelopes for h; ProcessProposal checks each (target height,
               epoch, dealer set, size, fee >= size x minimum, ML-DSA signature).
               batchHash(h) = SHA-256(tag, chain, h, envelope hashes in block order)
commit of h    the order is final. Nobody, the proposer included, can read the batch.
after commit   each validator j publishes release(j, h) = its shares of s[i,h] for every accepted
               dealer i, signed with its ML-DSA-44 vote key over (chain, epoch, h, batchHash(h)).
               Nodes accept a release only if: batch h is committed and pending, the batch hash is
               the committed one, every share matches the dealer's commitment, the signature is valid.
block h' > h   first block whose key message holds >= t valid releases for h. At the very start of
               h' (before any plaintext tx of h') every node rebuilds every s[i,h] from the t lowest-
               index releases, checks XWing.getPublicKey(s[i,h]) == ek[i,h], decrypts batch h and
               executes it in batch order. Envelopes that do not decrypt (junk) are skipped.
expiry         if batch h has not decrypted by h + ttl it expires: none of its txs ever runs. Users
               lose only the inclusion fee and keep their nonces.
order          batches run strictly by height: an older pending batch blocks newer ones until it
               decrypts or expires (head-of-line), so inclusion order is never inverted.
```

A release signed over a batch hash that is **not** the committed one is evidence that the
validator released for a block that was never final (a fork or an early release); it can be
slashed. A share that does not match its commitment is rejected on its own; a set of
commitment-matching shares that rebuilds a seed that does not match `ek[i,h]` proves that the
**dealer** dealt inconsistently (`reconstructSeeds` reports it as `faulty`; tested).

### Why this kills sandwiching

A sandwich needs a **front leg that executes before the victim**, chosen with knowledge of the
victim. With this rule, everything that executes before the victim is in one of:

1. an earlier block or block `h` itself (plaintext txs of `h` run during `h`, the batch runs at the
   start of `h+1`): all fixed while the victim was ciphertext;
2. batch `h` ahead of the victim: also ciphertext when ordered. The proposer chooses the order
   inside the batch, but blindly.

So the front leg can only be a **guess**. Back-running after the reveal is still possible; that
is ordinary arbitrage and does not worsen the victim's price. The simulation shows that a blind
sandwich loses money on average (below).

## Simulation (`node scripts/encmempool-sim.js`)

Constant-product pool 4,000,000 A / 2,000 B (0.30% fee), victim swaps 60,000 A → B with 1%
slippage tolerance, searcher pays 2 A gas per leg. Encrypted runs use the real crypto (X-Wing
dealings, Shamir shares, ML-DSA-44 signed releases), a batch of [victim, paid-for junk
envelope], ttl = 3. Colluders are taken non-dealers first; a colluding dealer keeps its seeds.
Output (deterministic; identical every run):

```
n = 4, t = 3, dealers d = 3
| scenario                            | searcher reads victim early | victim executed | victim out (B) | victim loss (≈A) | searcher profit (A) |
|-------------------------------------|-----------------------------|-----------------|----------------|------------------|---------------------|
| plaintext mempool                   | YES                         | block 1         | 29.174593      | 589.39           | 480.08              |
| encrypted, no collusion             | no                          | block 2         | 29.469286      | 0.00             | 0.00                |
| encrypted, 2 colluders (t-1)        | no                          | block 2         | 29.469286      | 0.00             | 0.00                |
| encrypted, 3 colluders (t)          | YES                         | block 2         | 29.174593      | 589.39           | 480.08              |
| encrypted, all 3 dealers keep seeds | YES                         | block 2         | 29.174593      | 589.39           | 480.08              |
| encrypted, 1 withhold (n-t)         | no                          | block 2         | 29.469286      | 0.00             | 0.00                |
| encrypted, 2 withhold (n-t+1)       | no                          | expired @5      | 0.000000       | 0.00             | 0.00                |

n = 21, t = 15, dealers d = 3
| encrypted, 14 colluders (t-1)       | no                          | block 2         | 29.469286      | 0.00             | 0.00                |
| encrypted, 15 colluders (t)         | YES                         | block 2         | 29.174593      | 589.39           | 480.08              |
| encrypted, all 3 dealers keep seeds | YES                         | block 2         | 29.174593      | 589.39           | 480.08              |
| encrypted, 6 withhold (n-t)         | no                          | block 2         | 29.469286      | 0.00             | 0.00                |
| encrypted, 7 withhold (n-t+1)       | no                          | expired @5      | 0.000000       | 0.00             | 0.00                |
(other n = 21 rows identical to n = 4; the junk envelope is skipped in every decrypted run;
 victim envelope 7,445 bytes, inclusion fee 0.0000075 ZETAPHY at 1 gwei/byte)
```

Blind sandwich (searcher cannot read the victim; 2,000 seeded random victims, direction 50/50,
size 1k–100k A, slippage 0.3–3%):

| blind front (A) | mean profit blind (A) | win rate | victims reverted | mean profit if it could read (A) |
|---|---|---|---|---|
| 5,000 | −29.95 | 44.1% | 0.0% | 331.09 |
| 20,000 | −173.98 | 32.9% | 12.8% | 331.09 |
| 60,000 | −1,054.91 | 1.6% | 48.8% | 331.09 |

Reading the table honestly:

- **Below the threshold** (`t-1` colluding validators, no colluding dealer) the searcher learns
  nothing (Shamir is information-theoretic) and the victim gets the fair price.
- **At `t` colluders the scheme is broken for that block**, exactly as in every threshold scheme:
  they rebuild the keys from their own shares as soon as the dealing is done, decrypt from the
  mempool, and sandwich (front leg in block `h`, back leg after the batch). Same profit as the
  plaintext mempool.
- **If all `d` dealers keep their seeds, it is also broken**, and `d` (3) is far smaller than `t`.
  This is the main weakness of the prototype; see "Honest limits".
- **Liveness**: with `n-t` validators withholding, the batch still decrypts. With `n-t+1` it
  cannot; it expires after `ttl` blocks and the victim only paid the inclusion fee. Withholders
  cannot read anything unless they also reach `t`.

## Benchmarks (`node scripts/encmempool-bench.js`)

Sizes are exact. Times are pure JavaScript (`@noble/post-quantum`), one thread, on the machine
that ran the commit; a Go implementation would be several times faster.

Per transaction (d = dealers):

| dealers | plain tx | envelope | overhead |
|---|---|---|---|
| 1 | 250 B | 5,201 B | 4,951 B |
| 3 | 250 B | 7,445 B | 7,195 B |
| 5 | 250 B | 9,689 B | 9,439 B |

The fixed part is the payer's ML-DSA-44 key (1,312 B) and signature (2,420 B), which a native PQ
ZETAPHY tx already pays; the encryption itself costs 1,120 B per dealer plus padding (≤ 255 B)
and 16 B tag. (Referencing an already-registered payer key by address would save 1,292 B.)

| step (d = 3, 250 B tx) | time |
|---|---|
| client: encrypt + ML-DSA sign | ~23 ms |
| node: CheckTx / ProcessProposal (decode + ML-DSA verify) | ~2 ms |
| node: decrypt one tx with rebuilt keys (3 X-Wing decaps + AES-GCM) | ~17 ms |

Per committee (d = 3, epoch = 32 blocks, t = ⌊2n/3⌋+1):

| n | t | release per validator per block | all releases per block | dealings per epoch | amortised per block (with encrypted txs) | verify t releases | rebuild 3 keys |
|---|---|---|---|---|---|---|---|
| 4 | 3 | 2,614 B | 10.2 KiB | 158.7 KiB | 15.2 KiB | ~9 ms | ~12 ms |
| 21 | 15 | 2,614 B | 53.6 KiB | 317.5 KiB | 63.5 KiB | ~26 ms | ~6 ms |
| 100 | 67 | 2,614 B | 255.3 KiB | 1,055 KiB | 288.3 KiB | ~115 ms | ~7 ms |

A release is 32 B of share per dealer plus a 2,420 B ML-DSA-44 signature: the signature
dominates. Inside a vote extension the existing ML-DSA vote signature covers the block, not the
shares, so the shares need their own signature to be post-quantum authenticated (the immune
system's payload makes the opposite trade-off: ed25519 only, `chain-protocol.md` item 12).
Decrypting a batch costs ~6 ms per dealer per tx in JS (X-Wing decapsulation), so batch size
should be capped (e.g. 100 envelopes per block ≈ 2 s in JS, much less in Go).

The dealer-free alternative (each user Shamir-shares its own key to all `n` validators, so no
dealer is trusted) would cost `n x 1,152` B per tx: 4.6 KB for n = 4, 24 KB for n = 21, 115 KB for
n = 100, and per-tx releases. It is the right choice for very small committees only.

## Threat model

| Adversary | Can it read a tx before ordering? | Can it stop decryption? | Notes |
|---|---|---|---|
| Searcher / any user | no | no | sees payer, size bucket, gas limit, fee, target height |
| Proposer of `h` | no | can censor (leave envelopes out), cannot reorder after commit | blind ordering inside the batch only |
| `< t` colluding validators, ≥ 1 honest dealer | no (information-theoretic) | only if `> n-t` withhold | |
| `≥ t` colluding validators | **yes, for every height of the epoch** | yes | the threshold assumption; their early decryption is not detectable on chain |
| all `d` dealers of the epoch keep their seeds | **yes, for that epoch** | — | trust assumption specific to this prototype |
| a dealer deals inconsistent shares | no | yes, its heights expire | detected and attributable after the fact |
| `> n-t` validators withhold | no | yes: batches expire after `ttl` | users lose only the inclusion fee |
| quantum adversary breaking X25519 | no (ML-KEM-768 half of X-Wing holds) | — | |
| quantum adversary forging ed25519 | no | CometBFT votes are ed25519; ZETAPHY's ML-DSA certificate rule already protects finality | |
| spammer with junk envelopes | — | no | pays the inclusion fee for every byte; size ≤ 64 KiB; signed by a known payer; junk is skipped (tested) |

## Honest limits

**What is post-quantum here**

- Confidentiality of the envelope and of the dealt shares: ML-KEM-768 (inside X-Wing) +
  AES-256-GCM; X25519 is kept only as a hedge against a flaw in ML-KEM.
- Secrecy of the key below `t` shares: Shamir, information-theoretic (no assumption at all).
- Authenticity of envelopes, dealings, acks and releases: ML-DSA-44 (FIPS 204).
- Hashes: SHA-256 / SHA3-256 (Grover leaves ~128-bit).

**What is not (or not yet)**

- **This is not a threshold KEM.** There is no practical post-quantum threshold KEM or threshold
  IBE today; lattice threshold decryption (noise flooding, threshold FHE) exists in the research
  literature but not as something we can ship, and ML-KEM's decapsulation (with its FO re-encryption
  check) is not linear, so it cannot be split like ElGamal. NIST's multi-party threshold
  cryptography project is where standard schemes may come from.
- **Dealer trust.** Confidentiality needs at least one of the `d` dealers to erase its seeds. A
  coalition with a fraction `p` of the validators controls all `d` dealers with probability about
  `p^d` per epoch: for `p = 1/3`, `d = 3` gives 3.7% of epochs, `d = 5` 0.4%; for `p` just below
  2/3, `d = 3` gives ~29%. Raising `d` costs 1,120 B per tx per dealer. Erasure cannot be proved.
  A real deployment needs a PQ DKG (research) or a much larger `d`.
- **No verifiable secret sharing.** Shares are hash-committed, not Feldman/Pedersen-verifiable
  (those rely on discrete log). An inconsistent dealing is caught only when the key is rebuilt,
  which makes the heights of that dealer expire (liveness, attributable, not a confidentiality
  break). Acks only prove each validator's share matched its commitment.
- **Collusion at `t` is undetectable.** `t` validators can decrypt any height of the epoch early,
  in private. Nothing on chain shows it (only the MEV pattern might). The scheme moves trust from
  "anyone who sees the mempool" to "at least `n-t+1` of the validators are honest".
- **Unweighted.** One share per validator; the chain's rules are stake-weighted. Ferveo-style
  weighting (shares proportional to power) is a straightforward extension, not done.
- **Validator set changes.** The committee is fixed per epoch; a validator that leaves keeps its
  shares for the rest of the epoch and is no longer slashable.
- **Metadata leaks.** Payer, size bucket, gas limit, fee and timing are public. A searcher can
  still front-run *statistically* (a payer who always buys) or with a blind guess.
- **Latency.** A tx runs one block later than in a plaintext mempool (two in the vote-extension
  fallback path), and a tx that misses its target height must be re-encrypted.
- **Inner-tx validity is only known after decryption.** A decrypted tx can fail (nonce, balance);
  the inclusion fee has already been paid, the gas limit reserved in the envelope is not used.
- **Back-running and censorship remain.** The proposer can still leave envelopes out.
- **Consensus is still ed25519** (CometBFT votes, vote-extension signatures). The ML-DSA certificate
  rule (`zetaphy-chain/README.md` item 6) already guards finality, and the releases are ML-DSA signed.
- **Confidentiality is short-lived by design**: everything is public once executed, so
  "harvest now, decrypt later" is irrelevant. The PQ KEM matters only against an attacker who can
  break X25519 *within the few seconds before ordering*; the lasting PQ value is that nothing
  in the design (signatures, release authenticity, dealing) depends on discrete log or pairings.
- Prototype code: not audited, no constant-time guarantees beyond the libraries', JS only.

## Integration plan for `zetaphy-chain` (design only)

All of this would live in a new file `evmd/zetaphy_encmempool.go`, wired into the same hooks the
PQ certificate and the immune system already use (`pqProposalHandlers`, `setPQVoteHandlers`,
`pqPreBlock` in `evmd/zetaphy_pqcert.go`), behind an activation height like `v2`/`v5`.

**State** (store `zetaphypq`, new prefixes after `0x30` = `modelEpochsKey`, the last one in use):
transport keys `0x31 || cons addr → XWing pk`, accepted dealings per epoch
`0x32 || epoch || dealer → dealing`, pending batches
`0x33 || height → { batchHash, envelope hashes, gas reserved }`, envelopes `0x34 || hash → bytes`
(pruned after decrypt/expiry), params `{enabled, d, epoch_length, ttl, min_fee_per_byte,
max_envelopes_per_block, max_envelope_bytes}`.

**Messages**: `MsgRegisterTransportKey{validator, xwing_pk}` (signed by the vote key);
`MsgDealing{bytes}` and `MsgDealingAck{validator, dealing_hash, mldsa_sig}` in epoch `e-1`;
`MsgEncryptedTx{envelope}` (ante: payer's ML-DSA signature, charge `fee` at inclusion, no
refund); `MsgDecryptionKeys{height, releases[]}` (proposer-only, like `MsgPQCertificate`).

```go
// PrepareProposal(h)                               (inside pqProposalHandlers)
lead := [cert, zx]
if keys := app.emCollectReleases(h); keys != nil { // pending batches < h with >= t releases:
    lead = append(lead, keys)                      // fast path: gossiped after commit (~timeout_commit),
}                                                  // fallback: req.LocalLastCommit vote extensions
encs := app.emPickEnvelopes(h, maxEnv, maxBytes)   // valid for h, highest fee first; proposer cannot read them
res.Txs = lead ++ encs ++ plaintextTxs

// ProcessProposal(h)
checkCert(); checkZX()
k := keysMsgOf(req.Txs)                             // optional, but REQUIRED if LocalLastCommit-visible
for each release in k: emVerifyRelease(release)    // extensions hold >= t valid releases for a pending batch
for each MsgEncryptedTx e in req.Txs:               //   (same idea as the v2 "proposer must sign" rule)
    require e.height == h && e.epoch == epochOf(h) && e.dealers == accepted(epoch)
    require len(e) <= max && e.fee >= len(e)*minFeePerByte && mldsaVerify(e.payer, e.body, e.sig)
require count(MsgEncryptedTx) <= maxEnv && no duplicates

// ExtendVote(h)                                     (setPQVoteHandlers)
ext := mldsaSig(block h) || zxPayload || "EM1" || releasesFor(pending batches < h)
//  releases only for COMMITTED batches (h-1 and older): ExtendVote(h) runs before h is final,
//  so releasing for h here would leak h if round r fails and another block is committed for h.
// VerifyVoteExtension(h): parse "EM1", emVerifyRelease each (signature, committed batch hash,
//  share commitment); reject malformed. Keyed validators MUST include their releases (missing
//  ones are just absent, not rejected, to keep liveness).

// PreBlocker(h)                                     (pqPreBlock, after the certificate)
if k := keysMsgOf(req.Txs); k != nil:
    for each pending batch b < h in height order:
        seeds, ok := emRebuild(b, k)               // t lowest-index releases, check ek match
        if !ok && h <= b+ttl: break                // head-of-line
        if !ok: emExpire(b); continue              // also on a faulty dealer (+ slash evidence)
        for i, env := range b.envelopes:
            if tx := emDecrypt(env, seeds); tx != nil:
                app.emDeliver(ctx, tx, env.gasLimit)  // runs the inner tx through the normal ante +
        emDelete(b)                                   // msg handlers, BEFORE any tx of block h
// EndBlocker(h): commit batch h: pending[h] = {batchHash(h, envelope hashes in block order)}
// also: expire batches with h > b+ttl even without a keys message
```

Points that need care in Go:

- `emDeliver` executes transactions that are not in `req.Txs`. Results and EVM receipts must be
  emitted as events of the `MsgDecryptionKeys` tx (or a synthetic tx index), and JSON-RPC
  indexing must learn about them (the same issue `MsgEVMCall` logs have today, README item 3).
- Block gas: the sum of the envelopes' public gas limits of batch `h` is reserved in block `h+1`'s
  gas budget when `h` is committed.
- Dealer selection randomness: use the certificate-derived value of the last block of epoch
  `e-2`, so dealers are known one epoch ahead and have a full epoch to deal and collect acks;
  if fewer than one dealing is accepted, the encrypted lane is off for that epoch (plaintext
  still works).
- Slashing: a signed release over a non-committed batch hash; a dealing whose commitment-matching
  shares rebuild a key different from its `ek` (the `faulty` evidence).
- CheckTx in the EVM mempool (`evmd/mempool.go`): add `MsgEncryptedTx` as a separate lane with its
  own size cap; it must never be re-broadcast after its target height.

## Comparison with other designs

| | This prototype | Shutter (Gnosis Chain, Shutter Network) | Ferveo (Anoma/Namada, proposed for Osmosis) | Ethereum research |
|---|---|---|---|---|
| Key generation | `d` dealers, Shamir, hash commitments | DKG by a keyper committee | PVSS-based DKG, stake-weighted | various |
| Encryption | X-Wing (ML-KEM-768 + X25519) per dealer key per height | threshold IBE over BLS12-381 (identity = slot/epoch) | threshold public-key encryption over BLS12-381 | threshold IBE (Shutter-style), delay/VDF encryption, TEEs (e.g. SUAVE) |
| Release | ML-DSA-44-signed shares after commit, in vote extensions or gossip | keypers publish decryption keys after the slot | shares in Tendermint vote extensions (ABCI++) | — |
| Post-quantum | confidentiality and signatures yes; threshold part needs dealer trust | no (pairings) | no (pairings) | no for pairing designs |
| Ciphertext overhead | 1,120 B per dealer + PQ signature | ~100–200 B (order of magnitude) | ~100–200 B (order of magnitude) | — |
| Weak point | dealer erasure, no VSS, size | `t` keypers collude | `t` stake collude | depends |

The integration pattern (ordering commitment in block `h`, shares in vote extensions, decrypt and
execute at the top of the next block) is the same as Ferveo's ABCI++ plan; Shutter on Gnosis
Chain follows the same "commit, then reveal the key for that slot" idea with a separate keyper
set. Both get small ciphertexts and a dealer-free DKG from pairings, which a quantum computer
breaks. Ethereum's roadmap lists encrypted mempools as an open item ("The Scourge"), with
threshold encryption, delay encryption and trusted hardware all under discussion. As far as we
know no deployed encrypted mempool is post-quantum; this prototype shows what it costs today
(kilobytes per tx and a dealer trust assumption) and where the missing primitive (a PQ threshold
KEM or DKG) would plug in: replace `dealing.js` and keep everything else.

## Running it

```
cd zetaphy-network
npm test                              # includes test/encmempool.test.js
node scripts/encmempool-sim.js        # results table for n = 4 and 21 (add 100 for n = 100)
node scripts/encmempool-bench.js      # sizes and timings for n = 4, 21, 100
```
