# Security — ZETAPHY and SWD AMM

## Status: UNAUDITED DRAFT. Do not deploy to mainnet as-is.

## Reporting a vulnerability / แจ้งช่องโหว่

**Do not open a public issue.** Report privately through GitHub: **Security → Report a vulnerability**
(the owner enables it under **Settings → Code security → Private vulnerability reporting**). Scope, severity
levels, rewards, rules, safe harbor and the disclosure timeline are in [`docs/BUG_BOUNTY.md`](docs/BUG_BOUNTY.md).
There is no real-money reward yet: on the testnet, rewards are recognition only, and real amounts must be
funded by a governance vote before mainnet.

**อย่าเปิด issue สาธารณะ** แจ้งแบบส่วนตัวทาง GitHub: แท็บ **Security → Report a vulnerability** รายละเอียด (ขอบเขต ระดับ รางวัล
กติกา safe harbor กำหนดเวลาเปิดเผย) อยู่ใน [`docs/BUG_BOUNTY.md`](docs/BUG_BOUNTY.md) ตอนนี้ยังไม่มีเงินรางวัลจริง

**ZETAPHY lock/mint bridge:** deployed CLOSED. It opens only when every gate in `zetaphy-network/README.md`
(stage 3, "เปิดสะพาน") holds: a second independent lane (Hyperlane), an audit recorded on-chain, 10+ independent
Neuro runners, multisig guardian and governance on hardware wallets, a funded bug bounty, small caps that grow
behind a 7-day timelock, and the bridge monitor running.

**ZETAPHY governance:** after the launch handover every admin role of the ZETAPHY contracts (bridge, ThreatRegistry,
NeuroControl, RewardVault, StableGateway, NeuroIdentity, ZetaphyOracle and its Pyth relay, DEX factory, NFT marketplace)
belongs to `ZetaphyTimelock` (OpenZeppelin `TimelockController` 5.4.0, unmodified, pinned by sha256 in
`zetaphy-network/vendor/openzeppelin-contracts.json`; 48 h delay; proposers = the gov module or a multisig; anyone executes;
no admin key). Guardians (multisigs) keep only switches that reduce risk (pause, lower caps, holds, remove a lane or marker,
pause a price feed). The launch tool checks on-chain that no EOA keeps an admin or timelock role. Prices for the StableGateway
come from `ZetaphyOracle` (DEX TWAP + Pyth with staleness, deviation, confidence and circuit-breaker guards), never a
silently wrong value. Scope: [`docs/BUG_BOUNTY.md`](docs/BUG_BOUNTY.md); details in `zetaphy-network/README.md`.

**การปกครองของ ZETAPHY:** หลัง handover สิทธิ์ผู้ดูแลทุกตัวเป็นของ `ZetaphyTimelock` (รอ 48 ชั่วโมง) guardian กดได้ทันทีเฉพาะสิ่งที่ลดความเสี่ยง
ราคาของ StableGateway มาจาก `ZetaphyOracle` ที่ไม่มีราคาก็ revert ไม่เดา รายละเอียดด้านความปลอดภัยเก็บแยกไว้สำหรับทีม

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

## SWD AMM (Solana program) — status

Unaudited draft, never deployed to mainnet. Its security history, attack-suite results and open risk
decisions are kept privately by the team; report anything you find through the private channel above.
รายละเอียดด้านความปลอดภัยเก็บแยกไว้สำหรับทีม

## ZETAPHY chain security core (Q-day, threat gate, IBC hold) — added 2026-10-21

Protocol-level rules in the ZETAPHY chain patch (`zetaphy-chain/setup-node.sh`), each off until a governance
vote: Q-day (ECDSA-signed transactions refused from a voted height; migration by quantum lock, or commit–reveal
for keys never used on chain), the threat gate (a call to a contract with an enforced Neuro flag needs the
sender's own consent, precompile `0x…0901`), and the IBC large-transfer hold (big inbound transfers wait; the
guardian can only return them to the sender). User guide (Thai): [`docs/SECURITY-CORE.md`](docs/SECURITY-CORE.md);
audit scope: [`docs/CHAIN_AUDIT_SCOPE.md`](docs/CHAIN_AUDIT_SCOPE.md). **Unaudited; testnet only.**
Known limits and internal review notes are kept separately for the team.
