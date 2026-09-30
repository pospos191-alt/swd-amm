# SWDMM v2

Dynamic AMM pools in swd-amm, modelled on Meteora DAMM v2. Full-range
constant-product liquidity with configurable fees, positions and
permanent locks. Token A is the base token, token B the quote token.

## Pool options (chosen at creation, shown on the Create pool page)

| Option | Values | Notes |
|---|---|---|
| Fee tier | 0.25%, 0.3%, 1%, 2%, 4%, 6% | The fee the pool settles at. Part of the pool address, so one pool per pair per tier. |
| Base fee mode | Fixed · Time Scheduler · Market Cap Scheduler | Schedulers start at a higher "starting fee" (10–99%) and step down to the tier. |
| Reduction | Linear · Exponential | 100 steps. Time: spread over 30m–24h. Market cap: over a +50% … +1000% price rise. |
| Dynamic fee | Yes / No | Adds up to 2% while the price is moving (volatility accumulator; filter 10s, decay 120s). |
| Fee collection | Base + Quote · Quote · Quote + Compounding | Claimable in the input token, claimable in token B only, or token B added back to the pool. |
| Start time | Now / custom (≤ 30 days) | Swaps revert with `NotActivated` before it. Deposits are allowed. |
| Max price impact | default 50% | Per swap; governance can lower it through the timelock. |
| Permanently lock | on/off | Locks the creator's liquidity forever; it keeps earning fees. |

Protocol fee: `GovernanceSettings.protocol_fee_share_bps` (≤ 20%) of every
trading fee accrues to the pool's protocol balance and can only leave to the
treasury through a timelocked `WithdrawV2ProtocolFees` action.

## Positions

Each deposit goes into a position (`Position #0, #1, …`, PDA
`["swdmm_v2_position", pool, index]`). A position has withdrawable
liquidity, locked liquidity, and claimable fees. Positions can be
transferred to another owner and closed (rent refunded) once empty.

## Instructions

| Instruction | Who |
|---|---|
| `initialize_v2_pool(params)` | anyone (both mints need an enabled MintPolicy; pool creation not paused) |
| `create_v2_position` | anyone |
| `add_v2_liquidity(max_a, max_b, min_liquidity)` | position owner (first deposit: pool creator only) |
| `remove_v2_liquidity(liquidity, min_a, min_b)` | position owner |
| `claim_v2_fees` | position owner |
| `lock_v2_liquidity(liquidity)` | position owner, irreversible |
| `transfer_v2_position(new_owner)`, `close_v2_position` | position owner |
| `swap_v2(amount_in, min_out, a_to_b)` | anyone |
| `emergency_pause_v2_pool` | emergency authority |
| `set_mint_policy`, `initialize_governance_settings`, `propose_gov_action`, `cancel_gov_action` | governance |
| `execute_*` | anyone, after the timelock |

## Using it on devnet

1. Upgrade the devnet program (the program grew to ~1.16 MB; `solana program
   deploy` extends the account automatically, or run `solana program extend
   3zKYYQT7LhCWLLnzbRMhTZJKmQdSwGzEghRrTyT4jdCL 420000 --url devnet`).
2. With the governance wallet (Phantom CRZs…), open test-ui → SWDMM v2 →
   Governance: *Initialize settings* (e.g. 60 s timelock, 10% share), then
   *Allow* each mint you want to pool (and wSOL for SOL pairs).
3. Create pool → pick tokens and amounts → options → Confirm (one wallet
   approval for two transactions).
4. Trade / add / withdraw / lock / claim on the pool page.

CLI equivalents: `yarn governance init-settings | set-mint-policy |
propose-* | execute | cancel | settings`.
