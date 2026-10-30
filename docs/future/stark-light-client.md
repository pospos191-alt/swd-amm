# STARK light client: post-quantum proofs of block finality

**Prototype, testnet only.** Not audited. The demo data uses public test keys.

Today the explorer (and `zetaphy pq verify-block`) checks a block's ML-DSA-44 certificate by downloading
every signature (2,420 bytes each), every vote key (1,312 bytes each) and the validator powers, and verifying each
signature. That is post-quantum but heavy, and unless keys are pinned it trusts the RPC node for the validator set
(`zetaphy-network/src/pqcert.js`).

This prototype replaces that with **one small proof** that a phone or browser checks against **one 32-byte pinned
root**. The proof system is a STARK (DEEP-ALI + FRI) whose only cryptographic assumption is SHA-256, so it is
hash-based and post-quantum, like the signatures it is about.

| Piece | Where |
|---|---|
| Field, NTT (Stark252 prime, 2-adicity 192) | `zetaphy-network/src/starklc/field.js` |
| SHA-256 Merkle trees, multi-openings, Fiat–Shamir transcript, grinding | `…/starklc/hash.js` |
| Statement (AIR), validator-set commitment, signed messages | `…/starklc/air.js` |
| Prover (node) / verifier (browser) / binary proof format | `…/starklc/prover.js`, `verifier.js`, `proof.js` |
| Light client with epoch handoffs; collecting a block from a node | `…/starklc/client.js`, `lightclient.js` |
| Tests | `zetaphy-network/test/starklc.test.js` (15 tests) |
| Node benchmark, demo files | `zetaphy-network/scripts/starklc-bench.js [--demo dir]` |
| Browser page (CSP-safe, no inline script or style) | `zetaphy-explorer/lightclient.html`, `src/lightclient-page.js`, `vendor/starklc-lib.js` |
| Browser test and benchmark (Playwright Chromium) | `zetaphy-explorer/test/lightclient.e2e.js`, `scripts/starklc-browser-bench.js` |

## 1. What is proven

**The validator set** of an epoch is committed once as the **set root**: the Merkle root (SHA-256) of the low-degree
extension of four columns, one row per validator sorted by consensus address, padded with zero rows to
N = a power of two ≥ n + 1 (at least 8):

- `A` address, `K` digest of the ML-DSA-44 vote key (31 bytes of SHA-256, domain-separated; 0 = no key),
  `Z` = 1 if the validator has no vote key, `P` voting power (< 2^64).

Anyone holding the validator list recomputes the root bit for bit (`buildSet`). Because the set is committed in the same
form as the trace ("preprocessed columns"), no hash has to be computed inside the STARK.

**A block proof** commits a witness trace (one row per validator):

- `B` the signer bitmap, `G` the digest of the signer's ML-DSA signature (0 if not signing) — the **certificate
  commitment** — and running sums `CS` (signed power), `CT` (total power), `CU` (keyless power), `CC` (signer count).

Constraints on every row: `B(B−1)=0`, `(1−B)·G=0`, `B·Z=0` (keyless validators cannot sign), `Z(Z−1)=0`, `Z·K=0`.
Transitions: `CS'=CS+B·P`, `CT'=CT+P`, `CU'=CU+Z·P`, `CC'=CC+B`. Boundaries: all sums 0 on the first row; on the last
(padding) row `CS=S, CT=T, CU=U, CC=C` and `P=0`. Since `P < 2^64` and `n < 2^20`, nothing wraps around the 252-bit
field. So the public numbers **S, T, U, C are exactly** the signed power, total power, keyless power and signer count
**of the pinned set** under the committed bitmap. The verifier then applies the chain's own rule
(`zetaphy_pqcert.go`): **3·S > 2·T − 3·U** (`ok`), and reports `pqMajority` (3·S > 2·T, more than 2/3 of all power).

The statement (chain id, height, block hash — the exact bytes validators sign, `voteMessage`) and the set root are the
first things absorbed by the Fiat–Shamir transcript, so a proof cannot be moved to another block, chain or set.

**Signature validity** — whether each `G` is the digest of a *valid* ML-DSA-44 signature by that row's key — is
not proven inside the STARK in Stage A. Each proof carries one of three modes, and the verifier enforces a minimum:

| Mode | What the client checks | Signature soundness |
|---|---|---|
| `all` | every signer's signature and key are revealed; each is tied to the committed trace by a DEEP opening at row w^i (B=1, G=digest(sig), K=digest(pk), P); the count must equal C; each signature is verified with ML-DSA-44 | complete |
| `sample` | after the trace is committed, Fiat–Shamir draws k power-weighted positions r ∈ [0, S); each must fall in a revealed row (CS_i ≤ r < CS_{i+1}, opened from the trace), whose signature is verified | k · log2(3S / (2T − 3U)) bits |
| `none` | nothing: the prover is **trusted** for ML-DSA validity (only the accounting is proven) | 0 bits (refused unless `minSigBits: 0`) |

Sampling soundness: if the honest signers hold W ≤ (2T−3U)/3 (the rule really fails) but the proof claims S, each
sample hits a forged row with probability ≥ 1 − (2T−3U)/(3S), so all k pass with probability ≤ ((2T−3U)/(3S))^k.
With near-unanimous signing that is log2(1.5) = 0.585 bits per sample: **219 samples for 128 bits**, independent of n.

### Epochs: chained validator sets

The client starts from a **pinned genesis set** `{ root, logN, logBlowup }`. To move from epoch e to e+1 it needs a
**handoff proof**: the same STARK over the set of epoch e, for the message
`"zetaphy/pq-setroot\0" ‖ chain id ‖ "\0" ‖ uint64(e+1) ‖ root(e+1) ‖ logN ‖ logBlowup`, with **more than 2/3 of all
power** of epoch e (the client requires `pqMajority`, not the keyless-adjusted rule). Handoffs must come in order;
a block proof under a set the client has not reached fails (wrong root). Tested in `epoch chain` (genesis → handoff →
blocks; self-signed, < 2/3, wrong-kind and skipped-epoch handoffs refused).

## 2. What is trusted (Stage A)

1. **The genesis pin** (32 bytes + two small integers), obtained out of band (e.g. shipped with the app, compared
   across sources). Everything else follows from it.
2. **ML-DSA validity in mode `none`**; in mode `sample`, only up to the stated bits (default minimum 128).
3. **SHA-256**: collision resistance (Merkle commitments; `K`/`G` use 248-bit truncations, 124-bit collision resistance)
   and random-oracle behaviour (Fiat–Shamir).
4. **Handoff signatures do not exist on the chain yet.** Validators sign only block hashes today. A chain change is needed:
   at an epoch boundary, the vote extension must also carry an ML-DSA signature over the next set root
   (`handoffMessage`). Tests and the demo produce these signatures with test keys. Until then, a deployment can only pin
   the current set and re-pin manually after validator or key changes (like `pqcert.js --pin`).
5. As with any light client: validators holding the threshold are honest about *what* they sign (state validity is not
   proven), and the prover is honest about **liveness only** (a dishonest prover can withhold proofs, not forge them).

Not trusted: the RPC node, the prover, the proof's transport. A node that lies yields a proof that fails (wrong set
root, bad openings, or bad signatures). `collectFromNode` + a real devnet certificate built by the Go chain
(`test/fixtures/pqcert-devnet.json`) is proven and verified in the tests.

## 3. Security level

Default parameters: blowup 16 (`logBlowup` 4), **28 queries, 16 bits of grinding**, final polynomial degree < 8,
field ≈ 2^251 (no extension field needed: OOD/DEEP/FRI challenge errors are ≈ 2^−230).

| | bits | formula |
|---|---|---|
| STARK, conjectured (ethSTARK-style) | **128** | queries · log2(blowup) + grinding = 28·4 + 16 |
| STARK, provable (Johnson bound, list decoding) | **72** | queries · log2(blowup)/2 + grinding |
| Signatures, `all` | complete | every signature verified |
| Signatures, `sample` | ≥ 128 (configurable) | k · log2(3S/(2T−3U)) |
| PQ-hardened preset `{ queries: 60 }` | 256 conjectured / 136 provable | +38 KB at n = 100 (82 KB), verify 63 ms |

The verifier refuses proofs below `minStarkBits` (default 100 conjectured) and `minSigBits` (default 128).
Quantum attackers: SHA-256 keeps ≈128-bit preimage security; generic quantum search over Fiat–Shamir transcripts
can at best square-root the query term, so the conservative post-quantum reading of the default is ≈ 64 bits for the
STARK part — use the 60-query preset (≈ 128 bits under that reading) for anything beyond a prototype.

## 4. Benchmarks

Test validators (powers 100–999), all signing, block statement; node 22 on this machine, browser = Playwright's
preinstalled Chromium (headless) running `vendor/starklc-lib.js` under the page's CSP. Median of 3 verifications.
"direct" = what `pqcert.js` does today: download the certificate (2,440 bytes per signer) and verify each ML-DSA-44
signature, *with the keys already pinned* (another n × 1,340 bytes at every set change, and trust in that pin).

| n | mode | proof size | of which STARK | prove (node) | verify (node) | verify (browser) | signature check |
|---|---|---|---|---|---|---|---|
| 4 | none | 22.3 KB | 22.3 KB | 0.28 s | 10 ms | 27 ms | trusted |
| 4 | sample-128 | 38.3 KB | 22.8 KB | 0.12 s | 30 ms | 52 ms | all 4 revealed |
| 4 | all | 38.2 KB | 22.8 KB | 0.03 s | 18 ms | 22 ms | complete |
| 4 | direct | 9.5 KB | – | – | 7 ms | 9 ms | complete (keys pinned) |
| 21 | none | 30.0 KB | 30.0 KB | 0.50 s | 12 ms | 12 ms | trusted |
| 21 | sample-128 | 111.8 KB | 30.6 KB | 0.51 s | 68 ms | 68 ms | 128 bits (21 revealed) |
| 21 | all | 111.7 KB | 30.5 KB | 0.28 s | 54 ms | 56 ms | complete |
| 21 | direct | 50.0 KB | – | – | 30 ms | 34 ms | complete (keys pinned) |
| 100 | none | 44.4 KB | 44.4 KB | 0.42 s | 21 ms | 19 ms | trusted |
| 100 | sample-128 | 372.3 KB | 43.6 KB | 1.42 s | 203 ms | 174 ms | 128 bits (85 revealed) |
| 100 | all | 430.6 KB | 43.9 KB | 1.78 s | 195 ms | 222 ms | complete |
| 100 | direct | 238.3 KB | – | – | 130 ms | 179 ms | complete (keys pinned) |
| 1000 | none | 73.2 KB | 73.2 KB | 3.7 s | 59 ms | – | trusted |
| 1000 | sample-128 | 843 KB | 71.1 KB | 24.8 s | 522 ms | – | 128 bits (195 revealed) |
| 1000 | direct | 2,383 KB | – | – | ≈1.3 s (extrapolated) | – | complete (keys pinned) |

Reproduce: `node zetaphy-network/scripts/starklc-bench.js 4 21 100` and
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node zetaphy-explorer/scripts/starklc-browser-bench.js` (sizes vary by a few
hundred bytes between runs: ML-DSA signing is randomized). The n = 1000 row was measured once with the same code.

Reading the table honestly:

- The **STARK part is small and almost flat**: 22 → 44 → 73 KB and 10–60 ms for n = 4 → 1000, and it removes the
  trust in the RPC node and in a key pin file (only 32 bytes are pinned, and the set can change by handoff).
- **Stage A does not shrink the signature data for complete checking.** `all` carries every signature *and key*
  (keys are what the client no longer stores), so it is larger than "direct" with pinned keys. `sample` only pays off
  when n ≫ 219 (n = 1000: 843 KB vs 2.4 MB). Small proofs *with* full signature soundness need Stage B.
- Prover time (JS BigInt, single thread) is fine for a prototype; a production prover in Rust is 100–1000× faster.

## 5. Stage B (design): ML-DSA-44 inside the proof, then recursion

Goal: mode `all` soundness at the size of mode `none` (tens of KB, flat in n), so the client checks nothing but the
STARK.

**What one ML-DSA-44 verification costs as an AIR** (FIPS 204, k = l = 4, n = 256, q = 8,380,417):

- Per **validator** (once per epoch, preprocessed like the set columns): `ρ`-expanded matrix Â in NTT form
  (16 × 256 coefficients), t1·2^d in NTT form (4 × 256), tr = H(pk). These leave the per-block circuit.
- Per **signature**: decode z (1,024 coefficients, range check ‖z‖∞ < γ1 − β), hint h (≤ 80 ones),
  c = SampleInBall(c̃) (≈ 1–2 Keccak-f permutations), μ = H(tr ‖ M') (≈ 1–2 permutations),
  NTT of z (4 polys) and c (1), 16 × 256 + 4 × 256 pointwise products, 4 inverse NTTs, UseHint, w1Encode (768 bytes)
  and c̃' = H(μ ‖ w1) (≈ 6 permutations), compare with c̃.
  Total ≈ **9–10 Keccak-f[1600]**, **≈ 9 × 1,024 NTT butterflies + ≈ 5,000 mod-q products**, ≈ 2,000 range checks.
- In a 31-bit field (BabyBear/M31) mod-q products need a quotient and range lookups; in Goldilocks (64-bit) products
  fit natively. Keccak-f ≈ 24 rows × ≈ 2,600 columns (Plonky3 `keccak-air`) ≈ 60 k cells; arithmetic ≈ 100–150 k cells.
  **≈ 0.7–1 M trace cells per signature**; n = 100 → ≈ 10^8 cells.
- Estimates with a production prover (Plonky3 or Stwo, multi-core laptop, SIMD): **≈ 2–10 s to prove 100 signatures**,
  proof ≈ 100–200 KB before recursion, verify ≈ 10–50 ms. In this repo's JS BigInt prover, 10^8 cells is out of
  reach (hours, GBs of memory) — which is why Stage B is a design here.
- The block witness column `G` becomes the signature itself (committed), and the constraint "B = 1 ⇒ Verify(pk_i, M, sig_i)"
  replaces the reveals. The statement and the set commitment stay as they are.

**Recursion** (a STARK verifier inside a STARK, as in Plonky3/Stwo/RISC Zero):

1. Fold the n signature checks into one proof per block (or prove them in parallel shards and aggregate):
   proof size stops depending on n (≈ 50–100 KB at 128 bits, depending on the hash and field).
2. **Chain the handoffs (IVC):** one proof of "genesis root → … → root(e)", updated each epoch, so a new client
   downloads one proof instead of one per epoch since genesis.
3. Optionally use an arithmetic hash (Poseidon2) inside recursion for speed; it is still hash-based (PQ), but
   younger than SHA-256/Keccak — keep SHA-256 or Keccak for the outermost layer.

## 6. Roadmap to a trustless bridge

1. **Chain:** sign `handoffMessage` in the vote extension at epoch boundaries (and keep the key-rotation rule:
   the key valid at H). Publish the set list per epoch so anyone can recompute the root.
2. **Prover service:** `collectFromNode` → `proveBlock` / `proveHandoff`, serving `.bin` files (the explorer page
   already verifies them; the PWA can cache the current pin).
3. **Stage B prover** (Rust, Plonky3/Stwo) with in-circuit ML-DSA-44, then recursion; the browser keeps verifying.
4. **Ethereum verifier contract** for a ZETAPHY → Ethereum bridge: stores the pinned set root, accepts handoffs and
   block proofs, then checks Merkle/IAVL proofs against the certified header (`app_hash`, via the SHA-256 header
   Merkle tree).

**Gas estimate for the EVM verifier** (n = 100, default parameters, measured proof: 43.5 KB, 39.4 k non-zero bytes;
≈ 167 hashed leaves + ≈ 750 inner nodes; ≈ 5 k field multiplications, one batched inversion):

| item | gas |
|---|---|
| calldata at 16/4 gas per byte | ≈ 0.65 M |
| SHA-256 precompile (≈ 920 calls × 300–400) | ≈ 0.3 M |
| field arithmetic (`mulmod`, p < 2^256 fits natively), decoding, memory | ≈ 0.3–0.5 M |
| **total** | **≈ 1.3–1.5 M** (EIP-7623 calldata floor: ≈ 1.6 M) |

So **≈ 1.5–2 M gas per block or handoff proof** (≈ 2.5–3 M for n = 1000, 73 KB); a Keccak-based variant (hash opcode
instead of a precompile call) saves ≈ 0.2 M. Stage B proofs of similar size (50–100 KB after recursion) land in the
same **≈ 2–4 M** range. Verifying ML-DSA-44 signatures directly in Solidity costs several million gas *each*
(public implementations; ML-DSA precompiles have been proposed), so 67+ signers directly is out of reach — the STARK is
the way to a PQ bridge. Wrapping the STARK in a pairing SNARK (≈ 250–300 k gas) would be cheaper but is **not**
post-quantum, so it is not the target.

A Stage A bridge with mode `none` is **not trustless** (it trusts the prover for signatures). An interim option is an
optimistic bridge: accept `none` proofs after a challenge window in which anyone may post the certificate signature
of a committed row with a failing ML-DSA check (expensive, but only in a dispute).

## 7. Limits of the prototype

- JS BigInt field arithmetic and a 252-bit field: simple to audit, slow to prove; no zero-knowledge (none is needed:
  everything is public).
- Handoff signatures are produced by tests/demo only (chain change pending). The demo page uses test keys.
- Proof format v1 is not frozen; parameters are carried in the proof and checked against the pin and minimums.
- Not audited; no constant-time concerns (no secrets in the verifier).
