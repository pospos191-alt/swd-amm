# swd-amm — Audit Scope (SWDMM v2 release)

Program: `programs/swd_amm` (Anchor 0.31.1, Solana 3.1.10), one program with
three pool types sharing governance.

| File | Lines | What it does |
|---|---|---|
| `src/lib.rs` | ~1,880 | Constant-product pool (tracked reserves, MINIMUM_LIQUIDITY lock, Token-2022 extension gate, transfer-fee-aware accounting, 50% price-impact cap), program entry points |
| `src/dlmm.rs` | ~1,600 | Bin-based DLMM pool |
| `src/oracle.rs` | ~690 | Hand-rolled Pyth `PriceUpdateV2` reader, deviation guard, oracle dynamic fee |
| `src/governance.rs` | ~770 | GlobalConfig, governance / emergency authorities, AllowedMint, emergency pause, Squads multisig verification |
| `src/timelock.rs` | ~560 | **New.** GovernanceSettings, timelocked proposals (unpause, fee share, delay, treasury, v2 pool params, protocol-fee withdrawal), MintPolicy |
| `src/swdmm_v2.rs` | ~1,120 | **New.** SWDMM v2 pools: positions, fee schedulers, dynamic fee, fee collection modes, activation, permanent lock, protocol fee |
| `src/swdmm_math.rs` | ~680 | **New.** Pure integer math for SWDMM v2 (no Anchor), host-tested |

## Trust model

- **Governance authority**: a Squads v4 vault (2-of-3 or 3-of-5). Can set
  mint policy, pause/unpause pool creation, propose timelocked actions,
  cancel them, rotate authorities.
- **Emergency authority**: separate key, can only pause (swap / deposit /
  withdraw) a pool. Cannot unpause, change fees, or move funds.
- **Timelock**: 24–48h on a `--features mainnet` build. Execution after the
  delay is permissionless.
- **Nobody** can withdraw LP funds from a vault except the position owner /
  LP-token holder; protocol fees leave only to the treasury via a matured
  timelocked action.

## Invariants to verify

1. SWDMM v2: `vault_x.amount >= reserve_x + unclaimed LP fees in x + protocol_fee_x` at all times (donations only add surplus).
2. `k = reserve_a * reserve_b` never decreases across a swap (all fee modes).
3. Deposit followed by withdraw of the same liquidity never returns more than was paid.
4. Sum of claimable fees over all positions never exceeds fees collected.
5. Locked liquidity (dead share + `lock_v2_liquidity`) can never be withdrawn.
6. Only the pool creator can make the price-setting first deposit.
7. Scheduled base fee stays within `[floor, cliff]`, is non-increasing, total fee ≤ 99%.
8. Timelocked actions execute at most once, only after `execute_after`, only against the account named in the action.
9. Instant `governed_unpause_*` always fails.
10. Position seeds are `[pool, index]`, ownership is a field — check every owner-gated instruction compares `position.owner == signer` and `position.pool == pool`.

Properties 2–4 and 7 are covered by `programs/swd_amm/tests/proptest_math.rs`
and `swdmm_math.rs` unit tests; 1, 5, 6, 8, 9 by `tests/swdmm_v2.ts` and
`tests/governance.ts`.

## Known design choices / risks to review

- `pending_fee` / fee growth rounding: floor everywhere, dust stays in the vault.
- Volatility (dynamic) fee uses a simplified linear accumulator; manipulation cost vs. fee cap (`max_dynamic_fee_bps` ≤ 10%).
- Market-cap scheduler reads the pool's own spot price; a trader can move price up within one transaction to lower the base fee for a following trade (bounded by the per-swap price-impact cap and fees paid).
- Oracle guard on SWDMM v2 is optional per pool (memecoins have no feed).
- DLMM and CP swap still use their earlier fee model (oracle dynamic fee).
- Position ownership transfer is a plain field update (no NFT).
- `#[error_code]` enums: SwdmmV2Error uses offset 8000, TimelockError 8500; older enums share the default range.

## How to run everything

```bash
cargo test -p swd_amm                  # unit + proptest
anchor build && anchor test            # localnet suite (needs mainnet RPC for the Squads clone)
node test-ui/tests/smoke.mjs           # UI smoke (Playwright)
cargo audit
```
