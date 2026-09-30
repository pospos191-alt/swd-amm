// Property tests (proptest) for the SWDMM v2 pool math — swdmm_math.rs.
// Run: cargo test -p swd_amm --test proptest_math
//
// Invariants checked on random inputs:
//   1. A swap never decreases k = reserve_a * reserve_b.
//   2. Token conservation: every input unit ends up in reserves, in fees,
//      or (for the output side) with the trader — nothing is created.
//   3. Fees split exactly into LP + protocol parts.
//   4. Deposit then withdraw never returns more than was paid.
//   5. Claimable fees across positions never exceed the fee collected.
//   6. Scheduled base fees stay within [floor, cliff] and never increase
//      with more periods.

use proptest::prelude::*;
use swd_amm::swdmm_math::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20_000))]

    #[test]
    fn swap_invariants(
        ra in 1_000_000u64..(1u64 << 55),
        rb in 1_000_000u64..(1u64 << 55),
        x_frac in 1u64..5_000,
        a_to_b in any::<bool>(),
        fee in 1u64..=MAX_TOTAL_FEE_BPS,
        share in 0u64..=2_000,
        mode in 0u8..=2,
    ) {
        let r_in = if a_to_b { ra } else { rb };
        let x = ((r_in as u128 * x_frac as u128) / 10_000) as u64;
        prop_assume!(x > 0);
        if let Some(s) = swap(ra, rb, x, a_to_b, fee, share, mode) {
            let k0 = ra as u128 * rb as u128;
            let k1 = s.new_reserve_a as u128 * s.new_reserve_b as u128;
            prop_assert!(k1 >= k0);
            prop_assert_eq!(s.lp_fee + s.protocol_fee, s.fee);
            let (in0, out0, in1, out1) = if a_to_b {
                (ra, rb, s.new_reserve_a, s.new_reserve_b)
            } else {
                (rb, ra, s.new_reserve_b, s.new_reserve_a)
            };
            let kept = if s.compounded { s.protocol_fee } else { s.fee } as u128;
            let fee_on_input = mode == COLLECT_FEE_BOTH || !a_to_b;
            if fee_on_input {
                prop_assert_eq!(in1 as u128 + kept, in0 as u128 + x as u128);
                prop_assert_eq!(out1 as u128 + s.amount_out as u128, out0 as u128);
            } else {
                prop_assert_eq!(in1 as u128, in0 as u128 + x as u128);
                prop_assert_eq!(out1 as u128 + s.amount_out as u128 + kept, out0 as u128);
            }
            prop_assert!(s.price_impact_bps <= 10_000);
        }
    }

    #[test]
    fn deposit_withdraw_never_profits(
        a0 in 2_000_000u64..(1u64 << 45),
        b0 in 2_000_000u64..(1u64 << 45),
        ma in 1u64..(1u64 << 45),
        mb in 1u64..(1u64 << 45),
    ) {
        let l0 = initial_liquidity(a0, b0).unwrap();
        if let Some((l, pa, pb)) = deposit_quote(a0, b0, l0, ma, mb) {
            prop_assert!(pa <= ma && pb <= mb);
            let (wa, wb) = withdraw_quote(a0 + pa, b0 + pb, l0 + l, l).unwrap();
            prop_assert!(wa <= pa && wb <= pb);
        }
    }

    #[test]
    fn fees_never_overpaid(
        total in 1_001u64..(1u64 << 62),
        fee in 0u64..(1u64 << 52),
        split in 0u64..=10_000,
    ) {
        let g = fee_growth(fee, total as u128).unwrap();
        let part = (total as u128 * split as u128) / 10_000;
        let a = pending_fee(g, 0, part).unwrap() as u128;
        let b = pending_fee(g, 0, total as u128 - part).unwrap() as u128;
        prop_assert!(a + b <= fee as u128);
    }

    #[test]
    fn scheduler_monotone_and_bounded(
        floor in 1u16..=1_000,
        extra in 0u16..=8_000,
        periods in 1u16..=10_000,
        rf_lin in 1u64..=1_000,
        rf_exp in 1u64..9_999,
        exponential in any::<bool>(),
        n in 0u64..20_000,
    ) {
        let c = BaseFeeConfig {
            mode: BASE_FEE_MODE_TIME,
            decay: if exponential { FEE_DECAY_EXPONENTIAL } else { FEE_DECAY_LINEAR },
            cliff_fee_bps: floor + extra,
            floor_fee_bps: floor,
            number_of_periods: periods,
            period_frequency: 60,
            reduction_factor: if exponential { rf_exp } else { rf_lin },
        };
        prop_assert!(validate_base_fee(&c));
        let f = scheduled_fee_bps(&c, n).unwrap();
        let g = scheduled_fee_bps(&c, n + 1).unwrap();
        prop_assert!(f >= floor as u64 && f <= (floor + extra) as u64);
        prop_assert!(g <= f);
    }
}
