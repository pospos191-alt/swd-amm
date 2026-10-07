# SWD AMM — Security Status and Pre-Mainnet Checklist

## Status: UNAUDITED DRAFT. Do not deploy to mainnet as-is.

**Update (2026-09-08, latest): the first-depositor/donation attack found by
the test suite (see the finding below) has been FIXED, not just
documented.** Two changes landed in `lib.rs`:

1. **Internal reserve tracking.** Every instruction used to price deposits/
   withdrawals/swaps off the vaults' LIVE token balance
   (`vault_a.amount`/`vault_b.amount`). Now every instruction reads and
   updates two new fields on the `Pool` account itself —
   `reserve_a`/`reserve_b` — which this program's own instructions are the
   only thing that ever changes. A plain SPL transfer straight into a vault
   (the "donation" attack) no longer moves the numbers any pricing
   calculation actually uses — it just leaves the donated tokens stuck in
   the vault, permanently uncounted and unrecoverable by anyone. See the
   long doc comment on `Pool.reserve_a` in `lib.rs` for the full reasoning
   and the invariant this program must maintain going forward
   (`vault_a.amount >= reserve_a`, always).
2. **`MIN_INITIAL_DEPOSIT` (1,000,000 raw units, flat/decimals-unaware).** A
   pool's first deposit must now supply at least this much of EACH token,
   on top of the pre-existing `MINIMUM_LIQUIDITY` lock — raising the cost of
   opening a pool at all, which the donation fix alone doesn't address
   (donation was the free part; opening a pool to donate into was always
   somewhat costly, this just raises that floor further).

**CONFIRMED on localnet, 2026-09-08: `anchor build && anchor test` passed,
10/10.** This is no longer just a code-review claim — the updated
first-depositor test actually ran against the new code and the numbers
prove the fix works: an attacker donated 10,000,000,000 raw units straight
into a fresh pool's vaults (bypassing `add_liquidity` entirely), and the
next depositor still received exactly 1,000,000 LP for depositing
1,000,000 of each token — precisely what a clean, undonated 1:1 pool would
have given them. The donation is sitting in the vault, verified
(`5,001,000,000` real balance vs `1,000,000` tracked reserve — the
`5,000,000,000` difference is the stuck donation), completely unable to
move anyone's pricing. The `MIN_INITIAL_DEPOSIT` boundary test also passed
(`InitialDepositTooSmall` below the floor, success exactly at it). Full
log kept in this project's chat history if you need to re-verify the exact
numbers.

**Update (2026-09-08, further): three more items from checklist item 3
below are now written and — for two of them — believed to pass; NOT YET
RUN AND CONFIRMED as of this edit, same as any other freshly-written test:**

- **`integer_sqrt`/`mul_div` fuzz/property tests.** Added as plain Rust
  `#[cfg(test)]` unit tests directly in `lib.rs` (NOT part of
  `tests/swd_amm.ts`, and NOT run by `anchor test` — run these with
  `cargo test` from `programs/swd_amm/` or the workspace root). Covers 0,
  1, every perfect square up to 1000², hand-checked non-perfect-square
  cases, `u64::MAX`, `u128::MAX`, and 10,000 deterministic pseudo-random
  values spanning the full `u128` range, plus a few `mul_div` overflow
  cases. **Next step: run `cargo test` and confirm it actually passes.**
- **Arithmetic near `u64::MAX`**, added as a new `anchor test` case. Read
  its comment in `tests/swd_amm.ts` for the full reasoning, but the short
  version: an on-chain test that actually pushes a vault's balance PAST
  `u64::MAX` is impossible to construct honestly, because an SPL mint's
  total supply is ALSO a `u64` field — no mint can ever have more than
  `u64::MAX` units to begin with, and the SPL Token program's own Transfer
  instruction already refuses to let any account's balance exceed
  `u64::MAX`. So `Pool.reserve_a`/`reserve_b`'s own `checked_add` overflow
  guards are real, worthwhile defense-in-depth, but are unreachable through
  legitimate token flows — there's no real "overflow the AMM" scenario to
  test at the integration level. What the new test actually does instead:
  deposits an ENTIRE `u64::MAX`-supply mint's worth of tokens into one side
  of a pool (the largest a pool can ever legitimately be), swaps and
  removes liquidity at that scale, and checks the results against the
  off-chain formula EXACTLY — this is where a real bug (u64 used somewhere
  a u128 was needed, or a JS-side bigint/BN encoding mistake for numbers
  this large) would actually show up.
- **Multiple concurrent pools**, added as a new `anchor test` case: three
  independent pools (different mint pairs, different fees) with
  interleaved deposits/swaps across all three, then asserting every pool's
  tracked reserves exactly match its own vault balance and that each kept
  its own distinct fee (proof the `Pool` accounts are genuinely
  independent, not aliased). This is the test that would catch a missing
  `seeds`/`address` constraint letting one pool's instruction touch
  another pool's state.

**Update (2026-09-08, further still): ran the above, and it found a REAL
bug — this is the fuzz testing working exactly as intended.**

- **`cargo test` result: 7/8 passed, 1 FAILED — a genuine bug in
  `integer_sqrt`, now fixed.** `integer_sqrt_u128_max` panicked with
  `attempt to add with overflow` at the function's very first line, `let
  mut y = (x + 1) / 2;` — when `value == u128::MAX`, `x + 1` overflows
  `u128` outright. This is a real defect in the pure math helper, not a
  test artifact: this program's own `[profile.release] overflow-checks =
  true` (required by Anchor, set in the workspace `Cargo.toml`) enables
  the identical checked-arithmetic behavior in the real on-chain build, so
  had `integer_sqrt` ever been called on-chain with `value == u128::MAX`,
  the transaction would have failed the same way. In practice that exact
  input can't occur through this program's only call site (`amount_a_desired
  as u128 * amount_b_desired as u128`, both u64, whose product is always
  strictly below `u128::MAX`) — but "the one call site happens to avoid
  it" is exactly the kind of reasoning that breaks the next time someone
  adds a second call site, so it's fixed at the source: the starting guess
  is now computed as `x / 2 + 1` instead of `(x + 1) / 2` (mathematically
  equivalent for the Babylonian method's convergence, just overflow-safe).
  **`cargo test` now passes 8/8** — re-run and confirmed after the fix.
- **`anchor test` result: 11/12 passed, 1 FAILED — a bug in the TEST
  ITSELF, not in the program.** The u64::MAX-scale test originally
  deposited a mint's ENTIRE `u64::MAX` supply into the pool in one shot,
  leaving the depositor's own wallet at exactly 0 — then immediately tried
  to swap from that same, now-empty wallet, which correctly failed with
  the SPL Token program's own `insufficient funds` error. This was the
  test fixture's mistake (not reserving any tokens for the swap step), not
  a program defect. Fixed by depositing `bigSupplyA - amountIn` instead of
  the full `bigSupplyA`, leaving exactly enough in the depositor's wallet
  to perform the planned swap — the swap then brings the vault to exactly
  `u64::MAX` afterward, so the test still covers the same "true maximum
  scale" scenario, just via deposit-then-swap instead of deposit-with-
  nothing-left-over.

**Update (2026-09-08, re-run after the fixes above): `anchor test` now
passes 12/12, confirmed.** The u64::MAX-scale fix worked as intended.

**But `cargo test` found a SECOND bug — this time in the FIX from the
first bug.** The initial fix for `integer_sqrt`'s overflow (changing the
starting guess to `x / 2 + 1`) avoided the overflow but was mathematically
wrong for ordinary small inputs: `integer_sqrt(2)` came back as `2`
instead of the correct `1`, caught immediately by
`integer_sqrt_non_perfect_squares_floor_correctly` failing on the very
next `cargo test` run. Root cause: `x / 2 + 1` is not the same value as
the original `(x + 1) / 2` when `x` is even (e.g. for `x=2`:
`(2+1)/2=1` vs `2/2+1=2`) — a plausible-looking "safe" rewrite that
quietly changed the function's actual behavior instead of just avoiding
the overflow. **Correctly fixed now** with `x / 2 + (x % 2)`, which is
provably the exact same value as `(x + 1) / 2` for every input (it's just
`ceil(x/2)` computed a different way, one that can't overflow) — verified
by re-running the full test suite, including a deliberate check that this
matches the original formula's output for every non-overflowing input.
**This whole two-bug episode is exactly why the fuzz/property tests exist
rather than trusting hand-verified reasoning about a "safe-looking"
one-line change** — both bugs (the original overflow, and the first
attempted fix's regression) were caught by running the tests, not by
reading the code carefully enough.

**CONFIRMED, 2026-09-08: `cargo test` 8/8 and `anchor test` 12/12, both
clean, against the final fix.** This closes out every item under
checklist step 3 below except devnet:
- `integer_sqrt`/`mul_div` fuzz/property coverage — done, passing, and it
  found (and this session fixed) two real bugs along the way.
- Arithmetic exactness at true-maximum (u64::MAX) scale — done, passing.
- Multiple concurrent pools, fully isolated — done, passing.
- Devnet testing — **the only thing left before step 3 is fully done.**
  Everything above, and everything from earlier in this file, has been
  localnet only.

**Earlier update (2026-09-08): `anchor build` succeeded** with the
pre-fix code. The program compiled and linked cleanly (Anchor 0.31.1,
Solana toolchain 3.1.10) and a real program keypair had been generated —
program id `3zKYYQT7LhCWLLnzbRMhTZJKmQdSwGzEghRrTyT4jdCL`. This confirmed the
code was syntactically and type-correct; it did **not** confirm the code
was *correct* — that's what the test suite below is for. No human besides
the person prompting the AI has read this code. Steps 3–5 below are all
still outstanding and are not optional.

This program was originally written by an AI assistant (Claude) inside an
environment with **no Rust, Cargo, Anchor, or Solana CLI installed** — at
that time it had never been compiled, run on a local validator, run on
devnet, fuzz-tested, or reviewed by a human Solana engineer, let alone
professionally audited. The code follows well-established patterns (this
is a fairly standard constant-product AMM, structurally close to Uniswap
V2 / Raydium's original AMM v4), but "follows a known-good pattern" is not
the same as "verified correct" — subtle bugs in exactly this kind of code
are how real AMMs have lost real money, including Raydium itself twice
(Dec 2022, ~$4.4M; Jun 2026, ~$1.3M), despite being built and reviewed by
a funded, experienced team.

**Treat every number and every line in this program as unverified until you
have personally confirmed it — do not take "it looks right" as sufficient.**

## SWDMM v2 + governance v2 — added 2026-09-29

**New code (unaudited):** `swdmm_v2.rs` (Meteora-DAMM-v2-style pools),
`swdmm_math.rs` (pure math), `timelock.rs` (timelocked governance, protocol
fee settings, per-mint policy). See `docs/SWDMM_V2.md`,
`docs/AUDIT_SCOPE.md` and `docs/MAINNET_RUNBOOK.md`.

What changed for security:

- **Timelock.** Unpausing any pool, changing the protocol fee share, the
  timelock delay, the treasury, SWDMM v2 pool risk parameters, and
  withdrawing protocol fees all go through `propose_gov_action` → wait →
  `execute_*` (anyone can execute; governance can cancel). Delay: 24–48h on
  a `--features mainnet` build, 5s–48h otherwise. The old instant
  `governed_unpause_pool` / `governed_unpause_dlmm_pool` now always fail
  with `UseTimelockedUnpause`.
- **Protocol fee** (≤ 20% of SWDMM v2 trading fees) accrues per pool and only
  leaves to the treasury through a matured timelocked action.
- **Price-impact cap.** Constant-product swaps: max 50% per swap
  (`PriceImpactTooHigh`). SWDMM v2: per-pool cap ≤ 50%.
- **MintPolicy** for SWDMM v2: governance allowlist that pins the token
  program; Token-2022 needs an explicit reviewed flag plus the extension
  gate; transfer-fee mints are refused.
- **SWDMM v2 first deposit** (sets the price) is restricted to the pool
  creator.
- **CI:** `cargo audit` job (0 vulnerabilities, 3 transitive warnings as of
  2026-09-29), proptest property suite, `--features mainnet` compile check.

Verified 2026-09-29 in a local toolchain (Anchor 0.31.1, Solana 3.1.10):
`cargo test` (42 unit + 4 proptest × 20,000 cases), the full `anchor test`
suite including `tests/swdmm_v2.ts`, and a browser end-to-end run of the
SWDMM v2 page (create pool → swap both ways → deposit → claim → withdraw
→ lock → timelocked protocol-fee withdrawal) against a local validator.
Still required before mainnet: gates 4–9 in `docs/MAINNET_RUNBOOK.md`
(independent audit, fresh hardware keys, Squads 2-of-3, mainnet build).

## What this is (and isn't)

This is **one pool type**: a classic constant-product (x·y=k) AMM, similar
to Raydium's original AMM v4 or Uniswap V2. It supports:
- `initialize_pool` — permissionless pool creation for any (mint_a, mint_b) pair
- `add_liquidity` — deposit both sides, receive LP tokens
- `remove_liquidity` — burn LP tokens, withdraw a proportional share
- `swap` — trade one side for the other, minus the pool's fee

It does **not** include, and would each need separate, comparably-sized
engineering effort: concentrated liquidity beyond the DLMM feature below,
a bonding-curve launchpad (like pump.fun or Raydium's LaunchLab),
perpetuals, or farms/staking.

**Update (2026-09-22): a minimal governance layer was added** — see the
"Governance layer" section below for the full detail. In short: a
Squads-multisig-controlled `GlobalConfig` singleton now gates pool
*creation* (mint allowlist + a global pause switch) and lets a narrow
"emergency authority" pause an *existing* pool's swap/deposit/withdraw
instructions on its own (governance must sign to unpause). **A pool's fee
is still fixed forever at creation time — this did not change.** There is
still no fee-change instruction, no fund-recovery/sweep instruction, and no
ability for governance to touch a pool's reserves, LP tokens, or vaults —
the governance layer can only gate *new* pool creation and pause/unpause
the three trading instructions on existing pools, nothing else. As with
everything else in this file: **this addition is UNCOMPILED AND UNTESTED
as of 2026-09-22** — see its own section below before relying on it.

**Assumption:** both mints must be classic SPL Token Program mints (like
SWD itself — see the project's own overview.md, which explicitly notes SWD
uses classic SPL Token, not Token-2022). A Token-2022 mint with a
transfer-fee, transfer-hook, or other extension would silently break the
reserve accounting this program relies on (the amount that "arrives" from
a transfer would differ from the amount the instruction requested). Do not
point this program at a Token-2022 mint without redoing this analysis.

## Mandatory steps before ANY mainnet use

1. ~~**Install the toolchain** (Rust, Solana CLI, Anchor CLI — via
   `avm install latest` once `anchor-cli` itself is installed) on a machine
   you control, and run `anchor build`. Fix every compiler error and
   warning.~~ **Done 2026-09-08.** `anchor build` succeeds with Anchor
   0.31.1 / Solana 3.1.10 (Anchor 0.30.1 was tried first but its pinned
   platform-tools toolchain was too old for the current crates.io index —
   see the version history in `Anchor.toml`/`Cargo.toml` if this ever
   needs revisiting). Only compiler *warnings* remain (an unused-cfg lint
   from Anchor's own macros and one deprecated-method notice from
   `anchor-lang` itself) — nothing in `swd_amm`'s own code is flagged.
2. ~~**Generate the real program keypair** (`solana-keygen new -o
   target/deploy/swd_amm-keypair.json`) and replace the placeholder id in
   both `Anchor.toml` and `declare_id!(...)` in `lib.rs`~~ **Done
   2026-09-08.** Real program id: `3zKYYQT7LhCWLLnzbRMhTZJKmQdSwGzEghRrTyT4jdCL`.
   The keypair file itself is at `target/deploy/swd_amm-keypair.json` on
   the dev machine (D:\Projects\swd-amm) — **do not commit this file to
   any public repo**, it is the private key that controls who can upgrade
   this program once deployed.
3. **Write and run a full test suite on localnet, then devnet.**
   **`anchor test`: 12/12 confirmed passing on localnet as of 2026-09-08,
   and `cargo test -p swd_amm`: 8/8 confirmed passing, both against the
   final code** (happy paths for every instruction with exact balance
   assertions, slippage/zero-amount rejections, the account-substitution
   attack, the `MIN_INITIAL_DEPOSIT` boundary, the first-depositor/
   donation attack now asserted to have ZERO effect, arithmetic exactness
   at u64::MAX scale, multiple-concurrent-pool isolation, and
   `integer_sqrt`/`mul_div` fuzz/property coverage — see the confirmed
   numbers at the top of this file). The fuzz suite earned its keep: it
   caught two real bugs in `integer_sqrt` (an overflow at `u128::MAX`, and
   a regression in the first attempted fix) that hand-reading the code had
   missed — see the update above for the full story. **The only item still
   fully outstanding is devnet testing** (everything confirmed so far, all
   20 test cases across both suites, is localnet-only).

   > **Finding from the first-depositor-attack test — FIXED AND VERIFIED
   > (2026-09-08):** the test measured, not just described, this attack. An
   > attacker who deposited ~1,100 raw units to open a pool, then donated
   > ~10,000,000,000 raw units (two plain SPL transfers straight into the
   > vaults, bypassing `add_liquidity` — costing only the donated tokens
   > themselves, no protocol fee) inflated the pool's implied price enough
   > that a normal-sized subsequent deposit (1,000,000 raw units of each
   > token) got **rejected outright** with `ZeroLiquidityMinted`, rather
   > than silently shortchanging the depositor. `MINIMUM_LIQUIDITY` alone
   > raised the cost of *opening* the pool but did nothing to stop the
   > *donation* step.
   >
   > **Fixed at the root, not just made to fail safe.** Every instruction
   > now prices off reserve fields (`Pool.reserve_a`/`reserve_b`) tracked on
   > the `Pool` account instead of the vaults' live token balance, so a
   > donation can no longer move the price at all, plus a
   > `MIN_INITIAL_DEPOSIT` floor (1,000,000 raw units) to raise the cost of
   > opening a pool in the first place. **Verified on localnet, 2026-09-08:**
   > with the exact same attack sequence, the victim's 1,000,000-unit
   > deposit into the 10-billion-unit-donated pool received exactly
   > 1,000,000 LP — identical to what a clean, undonated pool would have
   > given them — and the donated tokens are confirmed sitting outside the
   > tracked reserve (dead weight, not stolen, not disruptive).

   At minimum the suite covers:
   - Every instruction's happy path, with balances asserted exactly
     (not just "no error thrown")
   - Every `require!`/error branch — zero amounts, insufficient slippage
     tolerance, mismatched mints, wrong token account owner, empty pool
   - **Account substitution attacks**: try passing a different (but
     validly-typed) token account or mint in place of the pool's real
     vaults/mints on every instruction, and confirm the transaction is
     rejected
   - **The first-depositor / share-inflation attack**: donate tokens
     directly to a fresh pool's vault via a plain SPL transfer (bypassing
     `add_liquidity`) before a second depositor arrives, and assert it has
     ZERO effect on that depositor's LP share — fixed 2026-09-08 via
     internal reserve tracking, **confirmed passing on localnet**
   - **The `MIN_INITIAL_DEPOSIT` floor**: a pool's first deposit below this
     amount must be rejected (`InitialDepositTooSmall`), and exactly at the
     floor must succeed — **confirmed passing on localnet**
   - **Arithmetic edge cases**: `integer_sqrt`/`mul_div` fuzz-tested in Rust
     directly (0, 1, perfect squares, `u64::MAX`, `u128::MAX`, 10,000
     pseudo-random values — `cargo test`, **confirmed 8/8 passing**, and it
     found two real bugs along the way, both fixed — see the update above)
     and a pool holding an entire `u64::MAX`-supply mint tested end-to-end
     via `anchor test` for numerical exactness (see that test's comment for
     why an actual vault-balance overflow can't be constructed on-chain —
     **confirmed passing on localnet**)
   - **Repeated swaps back and forth**: confirm the pool's `k` value never
     decreases across a round trip (small increases from fees are
     expected and correct; any decrease is a bug) — covered both at normal
     scale and at u64::MAX scale, **confirmed passing**
   - **Multiple concurrent pools**: three independent pools, interleaved
     deposits/swaps across all three, asserting full isolation of reserves
     and fees between them — added 2026-09-08, **confirmed passing on
     localnet**
   - Every instruction called with a completely unrelated pool's accounts
     substituted in (see account substitution, above)
4. **Get an independent human read-through** of `lib.rs` — ideally someone
   who has shipped Solana/Anchor programs before, at minimum someone other
   than whoever ran step 3.
5. **Get a paid third-party security audit** before real user funds ever
   touch a pool backed by this program. This is standard practice for
   every serious AMM (Raydium, Uniswap, Meteora, etc. all publish audit
   reports) precisely because bugs at this layer are usually unrecoverable
   — once a pool is drained, there is no undo on a blockchain.
6. **Consider bounds you might want that this draft still doesn't have**: a
   maximum pool size, a timelock or multisig on anything you DO decide to
   add administrative control over, and whether permissionless pool
   creation (anyone can make a pool for any pair, including fake/malicious
   tokens) matches what you actually want for SWD specifically. (A minimum
   first-deposit amount — `MIN_INITIAL_DEPOSIT` — was added 2026-09-08; see
   the finding/update above. It's a flat, decimals-unaware constant sized
   for the mints tested so far — revisit it before pairing against a mint
   with drastically different decimals.)

## DLMM (concentrated liquidity) — added 2026-09-09

**Status: CONFIRMED on localnet, 2026-09-09 — `cargo test -p swd_amm`: 19/19
passing, `anchor build`: succeeds, `anchor test`: 20/20 passing (8 new DLMM
tests in `tests/dlmm.ts` + the 12 pre-existing constant-product tests,
unaffected).** This is real evidence the core DLMM mechanics (bin pricing,
single-sided liquidity, per-bin share accounting, multi-bin-crossing swaps,
liquidity removal) work for the scenarios actually tested — it is still
**NOT** a substitute for an independent human read-through or a paid
audit, and this feature is newer and structurally more complex than the
constant-product pool, so treat it as having a materially thinner track
record even though the numbers above are real, not just a code-review
claim. **Still UNAUDITED. Do not deploy to mainnet.**

Getting to a passing state took five real, found-and-fixed rounds — worth
reading in full, since it's the concrete evidence for how much "looks
correct on paper" differs from "actually compiles and runs correctly" on
code this dense with fixed-point arithmetic and Anchor macro plumbing:

**Why this exists:** the user asked for swd-amm to get as close to
Meteora's actual design as possible, and DLMM (discrete geometric price
bins, single-sided liquidity above/below the active bin, constant price
within a bin) is Meteora's flagship pool type — it's also the exact pool
type the real SWD-PUMP pool trades on. Dynamic fees and paginated bin
arrays were explicitly scoped OUT of this pass (see dlmm.rs's own module
doc comment) to keep this addition reviewable; each would be a comparable
follow-on effort, the same way this whole feature was originally scoped
out of the constant-product pool.

**Round 1 — caught by manual review, before this was ever compiled:**

1. `bin_price_q64` originally rejected any `bin_id` outside
   `[-HALF_RANGE, HALF_RANGE]` (i.e. `[-100, 100]`), which conflated "how
   far a bin is from this pool's own active bin" (the thing `HALF_RANGE`
   is actually supposed to bound, enforced separately and correctly by
   `BinArray::index_of`) with "how far a bin is from the global bin 0
   (price = 1.0)". Since a pool's `active_bin_id` is a global index that
   realistically needs to be in the thousands for many real mint-decimal
   ratios, this bug would have made **every swap fail on any pool whose
   active bin wasn't within 100 of zero** — i.e. almost every real pool.
   Fixed by removing that bound entirely (the real safety net is
   `pow_q64`'s own checked-arithmetic overflow detection, which is
   sufficient and doesn't have this conflation). A regression test
   (`bin_price_works_far_from_zero`) was added to `dlmm.rs`'s own
   `cargo test` suite to pin this down.
2. `initialize_dlmm_pool` had a leftover `require!` whose comment claimed
   it was "trivially true; real bound below" but which actually silently
   forced `active_bin_id >= -100` — dead, misleading code rather than a
   real check. Removed.

**Round 2 — the first real `cargo test -p swd_amm` run, 2026-09-09, found 2
compile errors:**

3. `q64_mul`'s tail-position `.ok_or(SwdAmmError::MathOverflow)` (its final
   line, with no `?` after it) doesn't get the automatic `SwdAmmError` →
   `anchor_lang::error::Error` conversion that every OTHER `?`-suffixed
   `.ok_or(...)` call in the same function gets from `?`'s own `From`
   conversion — a plain type mismatch (`expected Error, found SwdAmmError`).
   Fixed with `.ok_or_else(|| SwdAmmError::MathOverflow.into())`.
4. `[Bin; 201]` (the `BinArray.bins` field) didn't implement `bytemuck::Pod`/
   `Zeroable` — bytemuck's default array support only covers lengths up to
   32 elements; anything larger needs the `min_const_generics` cargo
   feature explicitly enabled. Fixed by adding `"min_const_generics"` to
   `bytemuck`'s features list in `Cargo.toml`.

**Round 3 — the second `cargo test` run found one more, purely an Anchor
multi-file gotcha:**

5. `unresolved import `crate`` pointing at the `#[program]` macro, with a
   hint naming `dlmm::__client_accounts_add_dlmm_liquidity`. Anchor's
   `#[derive(Accounts)]` macro generates a hidden companion module next to
   every Accounts struct it's applied to, in the SAME module where that
   struct lives (`dlmm`, here) — and the `#[program]` macro's generated
   code expects those hidden modules to also be reachable at the crate
   root. The original `pub use dlmm::{AddDlmmLiquidity, ...}` (naming only
   the types actually used) doesn't pull the hidden modules along with it.
   Fixed by switching to a glob re-export, `pub use dlmm::*;`.

**Round 4 — the third `cargo test` run compiled clean but found 2 real math
bugs (not build errors) via the pure-Rust `dlmm_math_tests`:**

6. `amount_in_for_output` rounded DOWN (floored) when it should round UP —
   its whole contract is "compute an input that produces AT LEAST this
   output", and flooring under-shot by 1 raw unit in the round-trip test
   (`amount_in_for_output_matches_convert_at_bin_price`: wanted 500000,
   got 499999). This one had real (if tiny) consequences: `swap_dlmm`'s
   "fully drain this bin" logic uses this function to size the input it
   asks the trader for, so the under-shoot meant the pool could hand out a
   full bin's output for very slightly less input than the bin's own price
   implies — a 1-part-in-~500,000 bias in the TRADER's favor, not the
   pool's. Fixed by adding ceiling-rounding variants (`q64_mul_ceil`,
   `q64_div_amount_ceil`) and switching `amount_in_for_output` to use them.
7. `pow_q64_matches_repeated_multiplication` asserted EXACT equality
   between `pow_q64`'s binary-exponentiation result and 10 sequential
   `q64_mul` calls, and found a genuine 2-unit difference (out of a
   ~1.8×10¹⁹ magnitude value — an ~10⁻¹⁹ relative difference). This is not
   a code bug: binary exponentiation and linear repeated multiplication
   floor their intermediate results in a different order, so a few units
   of last-bit rounding divergence between two internally-consistent
   calculations is expected, not a defect. The TEST's assertion was wrong
   (too strict); loosened to a small tolerance.

**Round 5 — cleanup, not a bug:** `anchor build` (the first one that got
past compilation) surfaced an "ambiguous glob re-exports" warning — the
`pub use dlmm::*;` from round 3 also re-exported the four instruction
handler functions (`initialize_dlmm_pool` etc.), colliding with the
`#[program]` macro's own re-export of the same names for CPI purposes.
Harmless (a warning, not an error) but fixed for cleanliness by narrowing
those four functions from `pub fn` to `pub(crate) fn` — they only ever
need to be called from the wrapper functions in the same crate, never from
outside it.

None of rounds 1, 4, or 6 would have been obvious from reading the diff
casually — all were caught either by tracing through what values would
actually flow through the function at runtime (rounds 1–2) or by the tests
actually running against real numbers (round 4). This is exactly the
pattern this project's `integer_sqrt` bugs followed earlier, and exactly
why "looks right on paper" and even "compiles cleanly" are both still not
treated as sufficient here — only "the tests that exercise the actual
behavior pass" is.

**What's included:** `initialize_dlmm_pool` (permissionless, like the
constant-product pool — picks `bin_step_bps`, `fee_bps`, and the initial
`active_bin_id`), `add_dlmm_liquidity` (single-sided above/below the
active bin, both-sided exactly at it, per-bin share accounting with a
`MIN_BIN_LIQUIDITY` floor mirroring `MINIMUM_LIQUIDITY`'s donation-attack
defense — permanently locked, per bin, on that bin's first deposit),
`remove_dlmm_liquidity` (burns shares, returns a proportional slice of
that bin's current reserves), `swap_dlmm` (walks bins one at a time from
the active bin, trading at each bin's fixed price until the input is
exhausted or `MAX_BINS_CROSSED_PER_SWAP` (30) bins have been crossed).

**What's deliberately NOT included** (each would be its own,
comparably-sized follow-on, same framing as the original CLMM exclusion
above): dynamic/volatility-based fees, paginated bin arrays (this version
gives every pool exactly one fixed-size `BinArray` covering
`active_bin_id ± 100` at creation — a swap or position that needs a bin
outside that fixed window simply errors with `BinOutOfRange`, it does not
grow), and any oracle/TWAP tracking of bin-crossing history.

**What's actually confirmed, as of 2026-09-09:**
- `cargo test -p swd_amm`: **19/19 passing**, including the 11
  `dlmm_math_tests` (Q64.64 multiplication, exponentiation, bin pricing in
  both directions, round-tripping conversions, overflow rejection, the
  far-from-zero regression test, and the ceiling-rounding fix's coverage)
  and the pre-existing 8 constant-product-pool math tests (unaffected).
- `anchor build`: succeeds, BPF/SBF release target included. No stack-frame
  overflow ended up being needed for `InitializeDlmmPool`/`SwapDlmm` (a
  real risk flagged before the build — see round 2 above — that simply
  didn't materialize this time; worth re-checking if these Accounts
  structs grow further).
- `anchor test`: **20/20 passing** — the 8 new tests in `tests/dlmm.ts`
  (pool init; single-sided liquidity above and below the active bin;
  mixed liquidity at the active bin; the single-sided-rule rejection; the
  per-bin `MIN_BIN_LIQUIDITY` floor rejection; a swap that crosses
  multiple bins with balance-conservation assertions; liquidity removal)
  plus the 12 pre-existing constant-product tests, run in the same
  `anchor test` invocation, all still green.

**What's still NOT covered, so still genuinely unknown:** devnet (this was
all localnet only, per the user's own explicit scope choice for this
round), `MAX_BINS_CROSSED_PER_SWAP` actually being exhausted (the swap
test crosses 2 bins, not anywhere near the 30-bin limit), fuzzing the
fixed-point math through real transactions the way `integer_sqrt` was
fuzzed for the constant-product pool, an independent human read-through,
and a paid audit. Given how many real bugs review + testing already
surfaced in this single pass (7 across 5 rounds, 3 of them affecting
actual behavior — see above), treat the absence of a bug in an untested
path as "not yet looked for," not as "not there."

**Environment note:** this feature was written and initially reviewed in
a sandboxed AI assistant environment with no Rust/Solana/Anchor toolchain
and no network access to crates.io (see rounds 1–2 above) — every fix
after that point (rounds 2–5, plus the final confirmed passing run) was
applied blind to a file the assistant couldn't compile itself, then
verified by the user running `cargo test`/`anchor build`/`anchor test`
themselves in WSL on this machine (where the toolchain that has built and
tested this project all along actually lives — see the "Earlier update"
notes above) and reporting the exact output back. This "fix blind, verify
via a human's real run, iterate" loop is why this took five rounds instead
of one — each round's fix was informed only by the previous round's actual
compiler/test output, never by re-running anything locally to confirm it
first.

## Governance layer (Squads multisig, mint allowlist, emergency pause) — added 2026-09-22

**Status: CONFIRMED on the user's WSL machine, 2026-09-22 — `cargo build
-p swd_amm` passes, `cargo test -p swd_amm`: 19/19 passing, `anchor build`
succeeds, and the full `anchor test` suite is 26/26 passing** (8
`tests/dlmm.ts` + 6 `tests/governance.ts` + 12 `tests/swd_amm.ts`), after
three real rounds of fixes (below) — the same level of confirmation the
DLMM section above has for its own feature. **Still UNAUDITED — passing
tests are not a substitute for an independent human read-through or a
paid audit (see "Mandatory steps before ANY mainnet use" above, which
apply here too). Do not deploy to mainnet.**

**Why this exists:** the user asked for a full Squads-governed,
allowlisted, dynamic-fee, oracle-guarded AMM ("SWDMM") built from a pasted
draft design. That draft was itself incomplete and referenced undefined
helpers, and its approach to verifying Squads multisig approval was to
deserialize and check a Squads `Multisig` account's threshold/members
directly on-chain — fragile, since it couples this program to the exact
layout of whatever Squads program version is deployed, and redundant,
since Squads' own on-chain program already enforces M-of-N before it will
ever produce a signature from its vault PDA. Rather than fork a new project
or graft that draft in as-is, the scope was narrowed, in agreement with the
user, to: **add a governance layer to the existing, tested `swd_amm`
program**, covering the parts of the original request that are both
well-specified and independently verifiable, and explicitly deferring the
rest rather than shipping something unverifiable end-to-end. See the
"Deliberately deferred" list below for exactly what was cut and why.

**Design — three pieces, all new:**

1. **`GlobalConfig`** — a one-time PDA singleton (`seeds = [b"global-config"]`).
   Holds `governance_authority: Pubkey` (meant to be a Squads vault/PDA —
   this program does not verify that; it just requires a signature from
   whatever pubkey is stored here) and a separate, narrower
   `emergency_authority: Pubkey`, plus `pool_creation_paused: bool`.
   `initialize_global_config` sets both authorities once; `set_authorities`
   lets governance rotate either one later (rejects setting them equal to
   each other — see "Why two authorities" below).
2. **Mint allowlist** — a per-mint `AllowedMint` PDA
   (`seeds = [b"allowed-mint", mint]`) with an `enabled: bool`, set via
   `set_allowed_mint` (governance-only). Both `initialize_pool` and
   `initialize_dlmm_pool` now require an enabled `AllowedMint` entry for
   *both* mints in the pair, plus `!global_config.pool_creation_paused`.
   **This is a real, deliberate behavior change**: pool creation, which was
   fully permissionless before, is now gated. Existing pools created before
   this change are unaffected — the allowlist is only checked at creation
   time, never retroactively, and disabling a mint later does not touch any
   pool that already exists.
3. **Pause / unpause, split across two authorities on purpose** — three new
   bool fields on both `Pool` and `DlmmPool` (`swap_paused`,
   `deposit_paused`, `withdraw_paused`), checked by `require!` at the top of
   `swap`/`add_liquidity`/`remove_liquidity` (and the DLMM equivalents).
   `emergency_pause_pool` / `emergency_pause_dlmm_pool` can be called by
   *either* `emergency_authority` or `governance_authority` and can only set
   pause flags to `true` (there's no "unpause" argument on this
   instruction — see `GovernanceError::EmergencyPauseRequestEmpty` if all
   three requested flags are `false`). `governed_unpause_pool` /
   `governed_unpause_dlmm_pool` can only be called by
   `governance_authority` and clears flags immediately (no additional
   on-chain timelock — the reasoning is that Squads' own M-of-N approval
   process is already the review gate; adding a second, program-level
   timelock on top would mostly just slow down the multisig from
   responding to a real incident, since the pause itself is the one-sided,
   no-approval-needed safety action and the *unpause* is exactly the
   action that should require full governance sign-off, which the
   signature check already provides).

**Why two authorities instead of one:** the entire point of an emergency
pause is that it needs to be fast — faster than waiting on a full Squads
M-of-N approval, which is the whole reason `emergency_authority` exists as
something narrower than `governance_authority` (it might reasonably be a
single hot key held by an on-call engineer, rather than the multisig
itself). But that speed is exactly why an emergency key must not be able to
*undo* its own pause — `governed_unpause_*` deliberately requires the full
multisig, so a compromised or mistaken emergency key can freeze trading but
can never be the one to declare the incident over.
`initialize_global_config` and `set_authorities` both `require!` the two
authorities are distinct pubkeys, enforced on-chain, not just by
convention.

**Round 1 — the first real `cargo build -p swd_amm` run on the user's WSL
machine, 2026-09-22, found exactly the compile error you'd expect from code
that had never touched a compiler: 1 real error, plus the same class of
harmless warning the DLMM section above already explains.**

- **``error[E0432]: unresolved import `crate` `` / ``could not find
  `__client_accounts_governance` in the crate root``, pointing at the
  `#[program]` macro.** Root cause: the 8 governance thin wrappers in
  `lib.rs` wrote their `Context<...>` argument with a module-qualified
  path — `Context<governance::InitializeGlobalConfig>`,
  `Context<governance::GovernanceOnly>`, etc. — instead of the bare type
  name. Anchor's `#[program]` macro parses that generic argument
  syntactically to build the hidden `__client_accounts_*` module path it
  needs, and a qualified path there confuses it into looking for a module
  named after the *qualifier* (`governance`) rather than the *type*. The
  DLMM wrappers just below the governance ones in the same file already had
  the right pattern to copy — `Context<InitializeDlmmPool>`, not
  `Context<dlmm::InitializeDlmmPool>` — because `use super::*;` inside
  `pub mod swd_amm` already brings every glob-re-exported type
  (`pub use governance::*;` at the crate root) into scope unqualified.
  Fixed by dropping the `governance::` prefix on all 8 `Context<...>`
  arguments; the *function-call* lines like `governance::initialize_global_
  config(ctx, ...)` right below each signature were left qualified, since
  those aren't parsed by the macro and qualifying them is harmless (matches
  how the DLMM wrappers call `dlmm::initialize_dlmm_pool(...)`).
- **The same "ambiguous glob re-exports" warning the DLMM section's Round 5
  already documents**, this time for all 8 governance instruction names
  (`pub use governance::*;` colliding with `#[program]`'s own
  re-export). Fixed the identical way: narrowed all 8 functions in
  `governance.rs` from `pub fn` to `pub(crate) fn`, since they're only
  ever called from the wrapper functions in `lib.rs`.

Both fixes applied and the corrected `lib.rs`/`governance.rs` sent back to
the user for a re-run. **Confirmed, 2026-09-22: `cargo build -p swd_amm`
passes clean with only the same class of harmless warning the DLMM
section above already has (no new errors).** This is exactly the "fix
blind, verify via a human's real run, iterate" loop this file already
documents for the DLMM feature, now proven out for governance too: round 1
produced a real, first-ever compiler signal on this code, and it was a
plausible mistake (not a deep logic bug) — and, as the next two rounds
below show, not the only thing a real run would find.

**Round 2 — the user's first full `anchor test` run, 2026-09-22, found a
real gap: not a bug in the governance code itself, but an existing test
file the governance change should have updated and didn't.**

- **18 passing, 8 failing — and every single failure was in the
  pre-existing `tests/dlmm.ts`** (the DLMM test suite from the section
  above, untouched by this pass until now). All 6 `tests/governance.ts`
  cases passed, and all 12 pre-existing `tests/swd_amm.ts` cases passed —
  proof the governance logic itself, and the `initPool()` bootstrap fix
  applied to `tests/swd_amm.ts`, both work as designed.
- **Root cause:** `initialize_dlmm_pool` picked up the identical
  `config`/`allowed_mint_a`/`allowed_mint_b` requirement `initialize_pool`
  did (see "Design" above — both pool types are gated the same way), but
  only `tests/swd_amm.ts`'s shared `initPool()` helper was updated to
  bootstrap `GlobalConfig` and allowlist its mints before creating a pool.
  `tests/dlmm.ts` is a separate file with its own, separate pool-creation
  call site that nobody had touched — so its very first test,
  `initializes a DLMM pool`, failed with `AccountNotInitialized` on the
  `config` account, and every other test in that file cascaded from there
  (a pool that was never created has no vaults/bin array to look up either,
  hence the `TokenAccountNotFoundError`/`Account does not exist` failures
  further down the list — one root cause, eight symptoms).
- **Fixed** by porting the exact same idempotent
  `ensureGlobalConfig()`/`ensureAllowlisted()` pattern from
  `tests/swd_amm.ts` into `tests/dlmm.ts`, called from its own `before()`
  hook, and adding `config`/`allowedMintA`/`allowedMintB` to
  `initializeDlmmPool`'s `.accounts({...})` call. Idempotent on purpose:
  mocha runs every `tests/*.ts` file in one shared `anchor test`
  invocation against the same localnet validator, and `GlobalConfig` can
  only ever be `init`ed once across all of them — whichever file's
  `before` hook happens to run first (alphabetically, `dlmm.ts` before
  `governance.ts` before `swd_amm.ts`, which is exactly why this file's
  failures showed up first in the output) actually creates it, and the
  others' `ensureGlobalConfig()` calls catch the resulting "already in
  use" error and move on — the same design already documented for
  `tests/swd_amm.ts` above, just not yet copied to this file until now.

The Round 2 fix was re-run: 25 passing, 1 failing, out of 26 total (8
`tests/dlmm.ts` + 6 `tests/governance.ts` + 12 `tests/swd_amm.ts` — the
constant-product suite has grown to 12 cases since the 2026-09-08 updates
earlier in this file added the u64::MAX-scale and multi-pool-isolation
tests, not 10 as an earlier draft of this section said). All 8
`tests/dlmm.ts` cases and all 12 `tests/swd_amm.ts` cases passed — Round
2's fix works. But the same run surfaced one new failure that hadn't shown
up before, because Round 2's fix changed which test file's setup code runs
first.

**Round 3 — same `anchor test` run that confirmed Round 2, one new
failure: `emergency_authority can pause swap on an existing pool, and
swap then fails`, with `AnchorError ... Unauthorized ... Signer does not
match the required authority` — a bug in the TEST FIXTURES, not the
program, and a subtle one.**

- **Root cause:** all three test files (`tests/dlmm.ts`,
  `tests/governance.ts`, `tests/swd_amm.ts`) independently called
  `Keypair.generate()` to create their own local `emergencyAuthority`,
  each producing a *different* random keypair in that file's own process
  memory. That was fine as long as nothing actually depended on which one
  ended up on-chain — but `GlobalConfig` is a one-time `init` PDA
  singleton shared across the whole `anchor test` run, so only the FIRST
  file whose `before()` hook successfully calls `initializeGlobalConfig`
  actually sets `emergency_authority` on-chain; every other file's own
  `ensureGlobalConfig()` just catches the resulting "already in use"
  error and silently moves on (this is the intentional, already-documented
  idempotent design — see "Design" above). Before Round 2's fix,
  `tests/dlmm.ts` never got far enough to call `ensureGlobalConfig()` at
  all, so `tests/governance.ts` (next alphabetically) was always the one
  that won and set its own local `emergencyAuthority` on-chain — its own
  later test that signs as `emergencyAuthority` naturally matched, so this
  bug was invisible. The moment Round 2 gave `tests/dlmm.ts` a working
  `ensureGlobalConfig()` call in its own `before()` hook, it started
  winning the race instead (mocha runs `tests/*.ts` alphabetically:
  `dlmm.ts` sorts before `governance.ts`) — and the `emergencyAuthority`
  keypair `tests/governance.ts` held locally was now a DIFFERENT keypair
  than the pubkey `tests/dlmm.ts` had actually written into `GlobalConfig`,
  so `tests/governance.ts`'s attempt to sign `emergency_pause_pool` as
  that authority correctly got rejected as an unrecognized signer — the
  program behaved exactly right; the test fixture handed it the wrong key.
- **Fixed** by deriving `emergencyAuthority` deterministically from a
  fixed 32-byte seed (`Keypair.fromSeed(...)`) in all three files instead
  of `Keypair.generate()`, so every file reconstructs the *identical*
  keypair regardless of which one's `before()` hook happens to win the
  race to actually create `GlobalConfig`. No cross-file imports or shared
  state needed — each file still independently derives the same keypair
  from the same hardcoded seed.
- **Why this matters beyond just fixing the test:** this is a reminder
  that `emergency_authority` in production must be a real, durably-held
  keypair (or better, its own small multisig) that whoever operates the
  emergency-pause capability actually keeps access to — losing it means
  losing the ability to pause without going through the full
  `governance_authority` (Squads) flow, which defeats the entire point of
  having a fast, separate emergency path. The test bug here was a toy
  version of a real operational risk: an authority whose keypair isn't
  where you expect it to be is an authority nobody can actually use.

Sent back to the user for a final re-run. **Confirmed, 2026-09-22: `anchor
test` now passes 26/26** — all 8 `tests/dlmm.ts`, all 6
`tests/governance.ts` (including this exact test), and all 12
`tests/swd_amm.ts` cases green in the same run. Three real, independent
things were caught this way across three rounds: a macro-parsing mistake
in the Rust (Round 1), a missed test file (Round 2), and an
order-dependent test-fixture bug (Round 3) — none of which were obvious
from reading the code, all three found only because real tooling actually
ran it. This closes out the "written but unverified" phase for the
governance layer; see "Mandatory steps before ANY mainnet use" above for
what's still required beyond passing tests (human read-through, paid
audit, devnet).

**What's deliberately deferred, and why** (each would be its own
comparably-sized follow-on, same framing as the CLMM/DLMM scoping notes
elsewhere in this file):
- **Timelocked fee and oracle-price-guard governance** (from the original
  pasted draft) — a fee-change or price-bound-change instruction gated by a
  mandatory delay between proposal and execution. Left out because it's a
  materially different, separately-testable piece of state machinery (a
  pending-change struct, a timestamp check, a separate "execute" step), and
  bolting it on unverified alongside everything else in this pass would
  make any compiler/test failure harder to isolate to one cause. A pool's
  fee remains fixed at creation time, exactly as before.
- **Token-2022 support** — the original draft assumed Token-2022 mints
  (transfer fees, transfer hooks, etc.). This program's reserve-accounting
  model (see the first-depositor-attack fix earlier in this file) already
  depends on the assumption that a requested transfer amount is the amount
  that actually arrives, which classic SPL Token guarantees and Token-2022
  extensions can silently break. Supporting Token-2022 safely means
  auditing every transfer call site against every extension that could be
  enabled on an allowlisted mint — not done here, so the allowlist should
  currently only admit classic SPL Token mints, same restriction as
  before.
- **On-chain Squads `Multisig` account deserialization** — deliberately
  NOT done (see "Design" above); `governance_authority` is just a pubkey
  requiring a signature, which is expected in practice to be a Squads vault
  PDA, but this program has no code-level dependency on the Squads program
  itself, its account layout, or its crate version.

**Files touched:**
- `programs/swd_amm/src/governance.rs` — **new file.** `GlobalConfig`/
  `AllowedMint` state, all 8 governance instructions and their Accounts
  structs, 8 events, `GovernanceError`.
  **Round 1 fix applied:** all 8 instruction functions changed from `pub fn` to `pub(crate) fn` (see Round 1 above).
- `programs/swd_amm/src/lib.rs` — `mod governance; pub use governance::*;`
  added; `Pool` gained 3 pause bool fields (`Pool::SIZE` updated);
  `InitializePool` gained `config`/`allowed_mint_a`/`allowed_mint_b`
  accounts; allowlist + `pool_creation_paused` checks added to
  `initialize_pool`; pause checks added to `add_liquidity`/
  `remove_liquidity`/`swap`; 5 new `SwdAmmError` variants
  (`PoolCreationPaused`, `MintNotAllowlisted`, `SwapPaused`,
  `DepositPaused`, `WithdrawPaused`); 8 thin wrapper instructions added to
  the `#[program]` module.
  **Round 1 fix applied:** the 8 governance wrapper functions' `Context<...>` arguments now use bare type names (see Round 1 above).
- `programs/swd_amm/src/dlmm.rs` — the same shape of change applied to
  `DlmmPool`/`InitializeDlmmPool`/`initialize_dlmm_pool`/
  `add_dlmm_liquidity`/`remove_dlmm_liquidity`/`swap_dlmm`.
- `tests/swd_amm.ts` — the shared `initPool()` helper used by all 6
  existing pool-creation call sites was updated to transparently bootstrap
  `GlobalConfig` and allowlist both mints before creating a pool.
  `emergencyAuthority` changed from `Keypair.generate()` to a
  deterministic `Keypair.fromSeed(...)` (Round 3). **Confirmed, 2026-09-22:
  all 12 cases pass.**
- `tests/governance.ts` — **new file, 6 test cases, all confirmed passing,
  2026-09-22:** `GlobalConfig` single-init (second init must fail),
  allowlist rejection for both a never-listed mint and a listed-but-
  disabled mint, successful pool creation once both mints are enabled
  (with disabling a mint afterward proven not to retroactively break an
  already-created pool, checked within the same test), the global
  `pool_creation_paused` gate, and the full emergency-pause /
  governed-unpause flow including proof that a random imposter keypair
  cannot pause and that `emergency_authority` itself cannot unpause (the
  one case Round 3 found and fixed — see above). DLMM-specific governance
  tests (pause/unpause on `DlmmPool`) are **not** included in this file —
  deferred, since the DLMM instructions reuse the identical pattern and
  are lower-risk to leave for a follow-up pass.
- `tests/dlmm.ts` — added the `ensureGlobalConfig()`/`ensureAllowlisted()`
  bootstrap `tests/swd_amm.ts` uses (Round 2), called from this file's own
  `before()` hook, plus `config`/`allowedMintA`/`allowedMintB` on
  `initializeDlmmPool`'s accounts; `emergencyAuthority` changed to the
  same deterministic `Keypair.fromSeed(...)` as the other two files
  (Round 3). **Confirmed, 2026-09-22: all 8 cases pass.**

**Verification status — the honest part:** this was originally written in
an environment with no Rust/Solana/Anchor toolchain and, unlike some
earlier rounds recorded in this file, **also no network access to
crates.io at all** (blocked at the sandbox's network egress layer,
confirmed via a direct 403 rather than just a slow/flaky connection), so
not even a bare `cargo check` could be attempted at write time — every
cross-check that normally would have come from the compiler was done by
hand instead (re-verifying the multi-file module pattern against the
already-working `dlmm.rs` precedent, seeds/bump syntax, `ctx.bumps.<field>`
naming, etc.). **All four verification steps have now actually run, on
the user's WSL machine, across three rounds of real fixes:**
1. `cargo build -p swd_amm` — **confirmed passing** (Round 1 found and
   fixed a macro-parsing mistake in the Rust: `Context<...>` arguments
   need bare type names, not module-qualified paths).
2. `cargo test -p swd_amm` — **confirmed 19/19 passing.**
3. `anchor build` — **confirmed succeeding.**
4. `anchor test` — **confirmed 26/26 passing** (8 `tests/dlmm.ts` + 6
   `tests/governance.ts` + 12 `tests/swd_amm.ts`), after Round 2 (a
   pre-existing test file, `tests/dlmm.ts`, needed the same governance
   bootstrap `tests/swd_amm.ts` got) and Round 3 (all three test files'
   `emergencyAuthority` needed to be the *same* deterministic keypair, not
   independently-generated ones, since `GlobalConfig` is a shared
   singleton across the whole test run).

This closes out the "written but unverified" phase for the governance
layer — three real, independent bugs were found and fixed purely by
running real tooling against the code, none of them obvious from reading
it (a macro-parsing gotcha, a missed test file, and a subtle test-fixture
ordering bug), the same pattern the DLMM section above already
demonstrates for its own feature. **This is still not a substitute for an
independent human read-through or a paid audit** — see "Mandatory steps
before ANY mainnet use" above, which apply to this addition too and are
still fully outstanding for it (devnet testing in particular: everything
confirmed here, like the rest of this file, is localnet-only). Still
UNAUDITED. Do not deploy to mainnet.

## Phase 3 (Pyth oracle guard + dynamic fee) — added 2026-09-23/24

A Pyth pull-oracle price guard and a deviation-scaled dynamic fee were
added to `swap`/`swap_dlmm` (`programs/swd_amm/src/oracle.rs`, with the
guard wired into `lib.rs`'s `swap` and `dlmm.rs`'s `swap_dlmm`).
`initialize_pool`/`initialize_dlmm_pool` gained 5 new instruction
arguments (`pyth_feed_id_a`, `pyth_feed_id_b`, `oracle_max_staleness_secs`,
`oracle_max_deviation_bps`, `max_fee_bps`) validated at creation time via
`validate_oracle_params` — pool CREATION does not read any live price
account, only `swap`/`swap_dlmm` do. `add_liquidity`/`remove_liquidity`
are NOT gated by the oracle guard at all.

**What actually happens on every swap now:** both `priceUpdateA`/
`priceUpdateB` (Pyth `PriceUpdateV2` accounts) are required and must be
fresh (`verification_level == Full`, `feed_id` matches the pool's own
stored feed id, and `age <= oracle_max_staleness_secs`), then the fee
charged scales linearly between the pool's flat `fee_bps` and
`max_fee_bps` based on how far the pool's own reserve ratio has drifted
from the oracle price (`deviation_bps`) — at exactly zero deviation the
fee is exactly `fee_bps` (unchanged from before this feature), and
beyond `oracle_max_deviation_bps` the fee is `max_fee_bps` and the swap
is rejected with `PriceDeviationTooLarge` unless it moves the pool's
price strictly closer to the oracle price.

**Fixed 2026-10-07 — oracle guard could freeze a pool.** The guard used to
check only the pool's PRE-trade price. A swap that started inside the
guard could push the price past it (up to the 50% price-impact cap), and
after that every swap in either direction was rejected — including the
arbitrage that would bring the price back — so the pool stayed frozen
until the oracle itself moved to the pool's price. Anyone with enough
capital could do this on purpose. Now `oracle::guard_allows` also accepts
a swap whose POST-trade deviation is lower than its pre-trade deviation
(CP, DLMM and SWDMM v2 all call `OracleFeeResult::enforce_guard` after
computing the new price).

**Two real bugs found and fixed via the user's own `anchor test` runs on
their WSL machine** (same "write blind, verify via a human's real run,
iterate" loop as every other feature in this file):
1. **Collapsed error codes.** `get_price_no_older_than`'s three distinct
   checks (verification level, feed id match, staleness) were all mapped
   to the same `OracleError::PriceUnavailable`, making the real failure
   point undiagnosable from error output alone. Fixed by giving each its
   own error code (`PriceVerificationNotFull`/`PriceFeedMismatch`/
   `PriceTooStale`).
2. **Backwards future-tolerance logic.** The staleness check used
   `age >= 0 && (age as u64) <= maximum_age`, which — because `age` is
   `clock.unix_timestamp - price_message.publish_time` — REJECTED any
   `publish_time` in the future relative to the on-chain clock (a negative
   `age` fails `age >= 0`) as `PriceTooStale`. This is the exact opposite
   of the method's own doc comment, which says a publish_time slightly
   ahead of the clock should be tolerated (only genuinely-too-old prices
   rejected) — and it is precisely the situation a freshly (re)started
   local validator's Clock is in relative to a fixture's real-wall-clock
   `publish_time`. Fixed by treating any future `publish_time` as `age =
   0` (always within any `maximum_age`); only a `publish_time` decisively
   in the past beyond `maximum_age` is now rejected.

A separate, non-bug finding: fixture regeneration timing. Anchor's own
flow starts the local validator with whatever `[[test.validator.account]]`
files exist on disk AT THAT MOMENT, before ts-mocha's own in-suite
fixture-regeneration code runs — so running bare `anchor test` (skipping
the separate fixture-generation step) silently loads STALE, many-minutes-
old fixtures from the previous run. **Always run
`node scripts/gen-pyth-fixtures.js && anchor test` together** (`yarn test`
does this for you) — never bare `anchor test` — for as long as pools
require the oracle guard.

**Legacy test porting.** The 28 pre-Phase-3 tests across
`tests/swd_amm.ts`/`tests/dlmm.ts`/`tests/governance.ts` all needed their
pool-creation calls updated with the 5 new instruction args and their
`swap`/`swap_dlmm` calls updated with valid `priceUpdateA`/`priceUpdateB`
accounts. Three "legacy pool" Pyth fixtures (`legacy-ratio1`/
`legacy-ratio4`/`legacy-ratiohalf`, see `scripts/gen-pyth-fixtures.js`'s
`LEGACY_SCENARIOS`) were added, each calibrated to exactly match a
specific test's real reserve ratio where an exact-value assertion
required zero price deviation, and reused loosely elsewhere. Confirmed,
2026-09-24: **`anchor test` — 31 passing, 0 failing**, across
`tests/dlmm.ts`, `tests/governance.ts`, `tests/oracle.ts`,
`tests/squads-vault-pda.ts`, and `tests/swd_amm.ts`.

Still UNAUDITED. Devnet testing, an independent human read-through, and a
paid audit remain fully outstanding for this feature too — see "Mandatory
steps before ANY mainnet use" above.

## Phase 2b (Squads multisig — live on-chain verification) — added 2026-09-24

The governance layer above (Phase 2) deliberately trusts
`governance_authority`'s bare signature rather than re-checking Squads'
own threshold logic on-chain (see that section's design note) — but it
also added a separate, informational, permissionless instruction,
`verify_governance_multisig`, that anyone can call to cryptographically
confirm `governance_authority` really is a specific Squads vault and see
that multisig's real threshold/member count. That instruction reads a
Squads v4 `Multisig` account's raw bytes at fixed offsets
(`read_squads_multisig_summary` in `governance.rs`) instead of depending
on Squads' own Rust crate. As of Phase 2's own write-up, this byte layout
had only been cross-checked against Squads' published docs — it had never
actually been run against a REAL Squads v4 `Multisig` account.

**This pass closes that gap.** `Anchor.toml`'s `[test.validator]` now sets
`url` (a mainnet-beta RPC — the only cluster this pass could directly
confirm the Squads v4 program is deployed at) and two
`[[test.validator.clone]]` entries: the real Squads v4 program
(`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) and its `ProgramConfig`
singleton PDA (`BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr` — computed
offline directly from the installed `@sqds/multisig` v2.1.1 package's own
compiled source, `seeds = ["multisig", "program_config"]`, not guessed).
A new test file, `tests/z-squads-live-verification.ts` (named to sort
alphabetically last among `tests/**/*.ts` — see its own header comment
for why), creates a genuine multisig with the official `@sqds/multisig`
SDK against that cloned program and:
1. Confirms a non-Squads-owned account is rejected
   (`NotASquadsMultisigAccount`).
2. Confirms `read_squads_multisig_summary` successfully parses a REAL
   multisig account's bytes (reaching `MultisigVaultMismatch` — the
   correct outcome when `governance_authority` hasn't been pointed at this
   particular multisig's vault — rather than a raw deserialization
   failure proves the byte offsets are right).
3. Temporarily points `governance_authority` at the real vault PDA,
   confirms `verify_governance_multisig` then succeeds outright, and
   restores `governance_authority` afterward via a GENUINE Squads
   propose → approve → execute flow (a single-member, threshold-1
   multisig, so one signer can legitimately drive the whole flow) — which
   additionally proves the Phase 2 design's core assumption: a real Squads
   execute_transaction CPI can actually drive this program's governance
   instructions, not just a plain direct signature.

**CONFIRMED — all 3 tests pass against a real run** (2026-09-24, after two
rounds of fixes driven by real `anchor test` output, not written-blind
guesses):

- The mainnet-beta RPC clone in `Anchor.toml` worked on the first try — no
  rate-limiting, no private-endpoint swap needed.
- The first real run surfaced two bugs, both in
  `tests/z-squads-live-verification.ts` itself, neither in `governance.rs`
  or `Anchor.toml`:
  1. Every raw `multisig.rpc.*` SDK call is a thin wrapper around
     `connection.sendTransaction(...)` (confirmed by reading the installed
     `@sqds/multisig` source directly) — it resolves as soon as the RPC
     *accepts* a transaction, not once it lands. Combined with
     `skipPreflight: true`, an on-chain failure would throw nothing at
     all, letting later steps race ahead against state that was never
     actually written. Test 2 hit exactly this: `createRealMultisig`
     "succeeded" before the multisig account existed, so
     `verify_governance_multisig` saw a system-owned account and returned
     `NotASquadsMultisigAccount` instead of the expected
     `MultisigVaultMismatch`. Fixed with a `sendAndConfirm()` helper that
     awaits confirmation and checks the on-chain result, and by dropping
     `skipPreflight: true` everywhere so a real failure now surfaces
     immediately with logs.
  2. `vaultTransactionCreate`'s RPC-level signature is the one call in
     this SDK that wants `creator: PublicKey` — every sibling call used
     here (`multisigCreateV2`, `proposalCreate`, `proposalApprove`) wants
     `creator`/`member: Signer` instead (confirmed against the SDK's own
     `.d.ts` files). The test originally passed `creator: payer` (a
     `Keypair`) by analogy with the others; the SDK threaded that straight
     into an account-meta `pubkey` slot with no runtime check, crashing
     `TypeError: pubkey.toBase58 is not a function` deep inside the SDK's
     own bundled `@solana/web3.js` copy the first time it tried to compile
     the transaction. Fixed to `creator: payer.publicKey`.
- With both fixed, the real `anchor test` run reached 34/34 passing,
  including all 3 tests in this file — `read_squads_multisig_summary`'s
  byte offsets, `derive_squads_vault_pda`'s seeds, and the
  Squads-execute-transaction-CPI trust assumption underlying the whole
  Phase 2 design are now each verified against a genuine, cloned Squads v4
  deployment, not just cross-checked against docs or a hand-rolled mock.

## CI/CD — added 2026-09-24, CONFIRMED on a real GitHub Actions run 2026-09-25

`.github/workflows/security.yml` (repo: `pospos191-alt/swd-amm`, private)
runs on every push and pull request:

- **test-ui** — `node --check` on the page's inline scripts, then a
  headless-Chromium smoke test (`test-ui/tests/smoke.mjs`) that loads the
  real page with local stubs for web3.js/anchor/spl-token and fails if
  startup throws or never reaches the `data-app-ready` marker. Added after
  a real incident: a `const` read before its declaration froze the page on
  load (build 2026-09-25o), which syntax checks alone could not catch.
- **program** — `cargo test -p swd_amm`, `anchor build`, and the full
  `yarn test` localnet suite. CI generates its own throwaway payer wallet
  and program keypair and rewrites `declare_id!`/`Anchor.toml` to match
  inside the CI checkout only; the real program keypair (3zKYY...) is not
  in the repository (`.gitignore` excludes `target/`, `*keypair*.json`,
  `.env*`).
- **deploy-devnet** — manual only (`workflow_dispatch` with the
  "deploy to Devnet" box ticked), runs only after both jobs above pass,
  needs the `DEVNET_DEPLOYER_KEYPAIR` and `PROGRAM_KEYPAIR` repository
  secrets, and refuses to deploy if the program keypair does not match
  `declare_id!`. There is deliberately no mainnet deploy job.

First real run (CI #1, commit `4288fa0`): test-ui and program both green
(program job 9m 22s: cargo test 1m 6s, anchor build 4m 6s, anchor test
1m 24s). **This does not reduce anything in "Mandatory steps before ANY
mainnet use" above** — it only guarantees the tests that already exist
keep passing; devnet testing, an independent human read-through, and a
paid audit are unaffected and still fully required.

Known flakiness: the Squads v4 program is cloned from the public
mainnet-beta RPC at validator start. The anchor-test step retries 3 times;
if it keeps failing, set a private RPC URL as the `MAINNET_RPC_URL`
repository secret and the workflow uses it instead.

## Governance ops CLI — added 2026-09-24

`scripts/governance.ts` (`yarn governance <command> ...`) is a real
operational tool for calling this program's governance instructions
against an actual deployed program (devnet or mainnet-beta) — status
checks, pausing/unpausing a pool, allowlist changes, and the Squads
transparency check — as opposed to the test scripts above, which only
ever talk to a local validator. Every state-changing subcommand defaults
to a dry run (prints the exact accounts/args it would use) and only
submits with an explicit `--yes` flag. If the current `governance_authority`
is a Squads vault (the intended production setup), the authority-changing
subcommands cannot submit directly from this CLI's own wallet — use their
dry-run output to build the equivalent instruction inside a Squads
proposal instead. Written blind, not yet run against a real deployment.

## Design notes worth knowing about

- **No canonical mint ordering.** `(mint_a, mint_b)` and `(mint_b, mint_a)`
  produce two different pool addresses. This program doesn't enforce
  ordering on-chain — a frontend calling `initialize_pool` should
  canonicalize (e.g., sort by pubkey bytes) so the ecosystem doesn't end
  up with two competing, liquidity-splitting pools for the same pair.
- **No liquidity auto-migration from bonding curves.** If a future
  launchpad phase adds a pump.fun-style bonding curve, "graduating" a
  token into one of these pools would be a separate instruction/flow, not
  something this program does automatically.
- **Fees accrue silently in the vaults** (there's no separate protocol-fee
  cut in this MVP, unlike Raydium's 12%-to-buyback split) — every trade's
  fee simply stays in the pool, increasing `k` and thus every LP holder's
  proportional value. If you want a protocol-level fee (e.g. funding SWD
  buybacks the way Raydium funds RAY buybacks), that's an additional,
  deliberate design change to `swap`, not something to add as an
  afterthought.
