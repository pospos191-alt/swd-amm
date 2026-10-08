# swd_amm attack suite

Integration tests that play the attacker against the real `swd_amm` program.
Each test sends the transaction an attacker would send and passes only if
the program rejects it, or if the attack gains nothing. The program runs
inside `solana-program-test`, so no validator or network is needed.

```
cd security/attack-tests
cargo test                         # native build: CP, SWDMM v2, governance, oracle
```

The DLMM attacks need the real SBF build. A DLMM bin array holds `u128`s,
which are 8-byte aligned on SBF but need 16-byte alignment in a native x86_64
build, and the test runtime does not provide that. Run them like this:

```
anchor build                                           # from the repo root
BPF_OUT_DIR=$PWD/target/deploy \
  cargo test --manifest-path security/attack-tests/Cargo.toml -- --include-ignored
```

CI (`.github/workflows/security.yml`, job `program`) runs both commands on
every push. The web faucet has its own attack tests in
`test-ui/tests/faucet-attacks.mjs`.

This crate has its own `[workspace]` and `Cargo.lock` on purpose. The test
runtime pulls in hundreds of crates, and none of them may change the
program's own lockfile (the one `anchor build` compiles).

## What is covered

| File | Attacks |
|---|---|
| `cp_attacks.rs` | Front-running the governance bootstrap. Re-initialising config or a pool. An outsider calling governance or pause instructions. A non-allowlisted mint. Substituted vaults or pools. Spending a victim's tokens or LP. Withdrawing more LP than owned. **Rounding drain with dust swaps.** Donation / first-depositor inflation. Sandwiching (bounded by `min_out`). **Pushing the pool price outside the oracle guard.** Overflow and zero amounts. Forged, partial, wrong-feed, swapped and stale Pyth accounts. Trading while paused. |
| `dlmm_attacks.rs` | **Excess B in an active-bin deposit handed to existing holders.** **Stranding the active bin outside the array (permanent DoS).** **An unpriceable `active_bin_id` at creation.** Taking another wallet's position, or a position from another pool. Removing more shares than owned. A fake bin array or vault. The single-sided rule and range limits. Dust-swap and deposit/withdraw round trips. |
| `v2_attacks.rs` | Withdrawing, claiming, locking, transferring or closing another wallet's position. A non-creator setting the first price. A substituted vault. Double fee claims, or claiming fees earned before a deposit. Unlocking locked liquidity. Sniping before activation. The impact cap. Dust round trips. **Claiming fees while withdrawals are paused.** Timelock: an outsider proposing, executing early, redirecting protocol fees, executing twice. |

Attacks in **bold** succeeded against the code before 2026-10-08 and are now
fixed. Each test was run against the old code to confirm it fails there; see
SECURITY.md, "Attack suite".

## Adding an attack

1. Put the helper for any new instruction in `tests/common/` (`cp.rs`,
   `dlmm.rs`, `v2.rs`).
2. Write the test as the attacker. Use `assert_rejected_with(&r, code(Error::X), "what")`
   when you know the error, or assert that the attacker's balances did not
   grow.
3. Run the test against the code before your fix and make sure it fails.
