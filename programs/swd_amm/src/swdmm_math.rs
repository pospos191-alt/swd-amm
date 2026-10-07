// SWDMM v2 — pure math (no Anchor, no Solana types).
//
// Everything a SWDMM v2 pool computes lives here as plain integer math
// that returns `Option` (None = overflow / invalid input), so it can be
// unit- and property-tested on the host with nothing but `rustc --test`
// (see the `tests` module at the bottom) and reused unchanged by
// swdmm_v2.rs, which maps `None` to its own Anchor error.
//
// Conventions
// - Token amounts are u64 raw units. Intermediate math is u128.
// - Fees are basis points (1 bps = 0.01%). FEE_DENOMINATOR = 10_000.
// - Prices are Q64.64 fixed point: raw units of token B per raw unit of
//   token A (same convention as oracle.rs / dlmm.rs).
// - "Liquidity" is a constant-product share unit: the first deposit mints
//   sqrt(a * b) (Uniswap v2 style); later deposits mint pro-rata.
// - Every rounding goes in the pool's favour: amounts a user receives
//   round down, amounts a user pays (and fees) round up.

pub const FEE_DENOMINATOR: u64 = 10_000;
/// Hard ceiling on any fee a SWDMM v2 swap can charge (99%).
pub const MAX_TOTAL_FEE_BPS: u64 = 9_900;
pub const Q64: u128 = 1u128 << 64;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    a.checked_mul(b)?.checked_div(d)
}

pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let p = a.checked_mul(b)?;
    let q = p / d;
    if p % d == 0 { Some(q) } else { q.checked_add(1) }
}

pub fn to_u64(v: u128) -> Option<u64> {
    u64::try_from(v).ok()
}

/// floor(sqrt(v)) — Newton's method, exact for every u128.
pub fn isqrt(v: u128) -> u128 {
    if v < 2 {
        return v;
    }
    let mut x = v;
    let mut y = x / 2 + 1;
    while y < x {
        x = y;
        y = (x + v / x) / 2;
    }
    x
}

/// Pool spot price as Q64.64 (B per A). None if reserve_a == 0.
pub fn price_q64(reserve_a: u64, reserve_b: u64) -> Option<u128> {
    if reserve_a == 0 {
        return None;
    }
    ((reserve_b as u128) << 64).checked_div(reserve_a as u128)
}

/// |p - reference| in bps of `reference`.
pub fn price_change_bps(price: u128, reference: u128) -> Option<u64> {
    if reference == 0 {
        return None;
    }
    let diff = if price >= reference { price - reference } else { reference - price };
    // diff * 10_000 can overflow u128 for extreme Q64 prices; divide first
    // when it would, trading a little precision for no overflow.
    let bps = match diff.checked_mul(FEE_DENOMINATOR as u128) {
        Some(p) => p / reference,
        None => (diff / reference).checked_mul(FEE_DENOMINATOR as u128)?,
    };
    Some(u64::try_from(bps).unwrap_or(u64::MAX))
}

/// Q64.64 power by squaring: base^exp, base <= 1.0 in practice.
pub fn pow_q64(mut base: u128, mut exp: u64) -> Option<u128> {
    let mut acc: u128 = Q64;
    while exp > 0 {
        if exp & 1 == 1 {
            acc = acc.checked_mul(base)? >> 64;
        }
        exp >>= 1;
        if exp > 0 {
            base = base.checked_mul(base)? >> 64;
        }
    }
    Some(acc)
}

// ---------------------------------------------------------------------
// Base fee schedulers (DAMM v2 "Base Fee Mode")
// ---------------------------------------------------------------------

pub const BASE_FEE_MODE_FIXED: u8 = 0;
pub const BASE_FEE_MODE_TIME: u8 = 1;
pub const BASE_FEE_MODE_MARKET_CAP: u8 = 2;

pub const FEE_DECAY_LINEAR: u8 = 0;
pub const FEE_DECAY_EXPONENTIAL: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseFeeConfig {
    pub mode: u8,
    pub decay: u8,
    /// Starting fee (the "cliff"); equal to `floor_fee_bps` for Fixed.
    pub cliff_fee_bps: u16,
    /// The fee the schedule settles at, and the pool's fee tier.
    pub floor_fee_bps: u16,
    /// How many reduction steps the schedule has.
    pub number_of_periods: u16,
    /// Time mode: seconds per period. Market-cap mode: price rise (in bps
    /// of the initial price) per period.
    pub period_frequency: u64,
    /// Linear: bps removed per period. Exponential: bps of the current
    /// fee removed per period (fee *= (1 - rf/10_000) each period).
    pub reduction_factor: u64,
}

pub const MAX_SCHEDULER_PERIODS: u16 = 10_000;
pub const MAX_FLOOR_FEE_BPS: u16 = 1_000; // 10%

pub fn validate_base_fee(c: &BaseFeeConfig) -> bool {
    if c.floor_fee_bps == 0 || c.floor_fee_bps > MAX_FLOOR_FEE_BPS {
        return false;
    }
    if c.cliff_fee_bps < c.floor_fee_bps || c.cliff_fee_bps as u64 > MAX_TOTAL_FEE_BPS {
        return false;
    }
    match c.mode {
        BASE_FEE_MODE_FIXED => c.cliff_fee_bps == c.floor_fee_bps,
        BASE_FEE_MODE_TIME | BASE_FEE_MODE_MARKET_CAP => {
            if c.decay != FEE_DECAY_LINEAR && c.decay != FEE_DECAY_EXPONENTIAL {
                return false;
            }
            if c.number_of_periods == 0 || c.number_of_periods > MAX_SCHEDULER_PERIODS {
                return false;
            }
            if c.period_frequency == 0 {
                return false;
            }
            if c.decay == FEE_DECAY_EXPONENTIAL && (c.reduction_factor == 0 || c.reduction_factor >= FEE_DENOMINATOR) {
                return false;
            }
            if c.decay == FEE_DECAY_LINEAR && c.reduction_factor == 0 {
                return false;
            }
            true
        }
        _ => false,
    }
}

/// Fee after `n` scheduler periods (clamped to the floor).
pub fn scheduled_fee_bps(c: &BaseFeeConfig, n: u64) -> Option<u64> {
    let floor = c.floor_fee_bps as u64;
    let cliff = c.cliff_fee_bps as u64;
    if c.mode == BASE_FEE_MODE_FIXED {
        return Some(floor);
    }
    let n = n.min(c.number_of_periods as u64);
    let fee = if c.decay == FEE_DECAY_LINEAR {
        cliff.saturating_sub(n.saturating_mul(c.reduction_factor))
    } else {
        let keep_q64 = ((FEE_DENOMINATOR - c.reduction_factor) as u128 * Q64) / FEE_DENOMINATOR as u128;
        let factor = pow_q64(keep_q64, n)?;
        ((cliff as u128 * factor) >> 64) as u64
    };
    Some(fee.max(floor))
}

/// Number of scheduler periods that have passed.
/// - Time mode: whole `period_frequency` seconds since activation.
/// - Market-cap mode: whole `period_frequency`-bps steps the current
///   price has risen above the initial price (a falling price never
///   raises the fee back up past the cliff).
pub fn scheduler_periods(
    c: &BaseFeeConfig,
    now: i64,
    activation_ts: i64,
    price_now_q64: u128,
    init_price_q64: u128,
) -> Option<u64> {
    match c.mode {
        BASE_FEE_MODE_FIXED => Some(0),
        BASE_FEE_MODE_TIME => {
            if now <= activation_ts {
                return Some(0);
            }
            Some(((now - activation_ts) as u64) / c.period_frequency)
        }
        BASE_FEE_MODE_MARKET_CAP => {
            if price_now_q64 <= init_price_q64 || init_price_q64 == 0 {
                return Some(0);
            }
            let rise_bps = price_change_bps(price_now_q64, init_price_q64)?;
            Some(rise_bps / c.period_frequency)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Dynamic (volatility) fee — DAMM v2 "Dynamic Fee"
// ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DynamicFeeConfig {
    pub enabled: bool,
    /// Cap on the volatility part of the fee.
    pub max_dynamic_fee_bps: u16,
    /// variable_fee_bps = volatility_accumulator * control / 10_000.
    pub variable_fee_control: u32,
    /// Swaps closer together than this share one reference price.
    pub filter_period: u32,
    /// After this long without swaps the volatility resets to zero.
    pub decay_period: u32,
    /// Share (bps) of the accumulator kept as the new reference between
    /// `filter_period` and `decay_period`.
    pub reduction_factor: u16,
    /// Ceiling for the accumulator (bps of price change).
    pub max_volatility_accumulator: u64,
}

pub const MAX_DYNAMIC_FEE_BPS: u16 = 1_000;

pub fn validate_dynamic_fee(c: &DynamicFeeConfig) -> bool {
    if !c.enabled {
        return true;
    }
    c.max_dynamic_fee_bps > 0
        && c.max_dynamic_fee_bps <= MAX_DYNAMIC_FEE_BPS
        && c.variable_fee_control > 0
        && c.filter_period < c.decay_period
        && (c.reduction_factor as u64) <= FEE_DENOMINATOR
        && c.max_volatility_accumulator > 0
}

/// Whether `c` is a valid config to switch ON. A pool created with the
/// dynamic fee disabled never had these fields validated, so turning it
/// on later must check them as if `enabled` were true.
pub fn can_enable_dynamic_fee(c: &DynamicFeeConfig) -> bool {
    validate_dynamic_fee(&DynamicFeeConfig { enabled: true, ..*c })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VolatilityState {
    pub volatility_accumulator: u64,
    pub volatility_reference: u64,
    pub price_reference_q64: u128,
    pub last_update_ts: i64,
}

/// Refresh the reference at the start of a swap (time-based decay).
pub fn update_references(c: &DynamicFeeConfig, s: &mut VolatilityState, now: i64, price_now_q64: u128) {
    let elapsed = now.saturating_sub(s.last_update_ts).max(0) as u64;
    if s.price_reference_q64 == 0 {
        s.price_reference_q64 = price_now_q64;
        s.volatility_reference = 0;
        return;
    }
    if elapsed >= c.filter_period as u64 {
        s.price_reference_q64 = price_now_q64;
        if elapsed < c.decay_period as u64 {
            s.volatility_reference =
                ((s.volatility_accumulator as u128 * c.reduction_factor as u128) / FEE_DENOMINATOR as u128) as u64;
        } else {
            s.volatility_reference = 0;
        }
    }
}

/// Accumulate the move from the reference price to `price_q64`.
pub fn accumulate(c: &DynamicFeeConfig, s: &mut VolatilityState, price_q64: u128, now: i64) {
    let delta = price_change_bps(price_q64, s.price_reference_q64).unwrap_or(u64::MAX);
    s.volatility_accumulator = s
        .volatility_reference
        .saturating_add(delta)
        .min(c.max_volatility_accumulator);
    s.last_update_ts = now;
}

pub fn variable_fee_bps(c: &DynamicFeeConfig, s: &VolatilityState) -> u64 {
    if !c.enabled {
        return 0;
    }
    let v = (s.volatility_accumulator as u128 * c.variable_fee_control as u128) / FEE_DENOMINATOR as u128;
    (v.min(c.max_dynamic_fee_bps as u128)) as u64
}

pub fn total_fee_bps(base_bps: u64, variable_bps: u64) -> u64 {
    base_bps.saturating_add(variable_bps).min(MAX_TOTAL_FEE_BPS)
}

// ---------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------

pub const COLLECT_FEE_BOTH: u8 = 0; // "Base + Quote": fee in the input token, claimable
pub const COLLECT_FEE_QUOTE: u8 = 1; // "Quote": fee always in token B, claimable
pub const COLLECT_FEE_QUOTE_COMPOUND: u8 = 2; // "Quote + Compounding": fee in B, LP part added to reserves

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct SwapResult {
    /// What the trader receives.
    pub amount_out: u64,
    /// Total fee charged (in `fee_in_b ? B : input token`).
    pub fee: u64,
    pub protocol_fee: u64,
    /// LP part of the fee.
    pub lp_fee: u64,
    /// true if the fee is denominated in token B, false if in token A.
    pub fee_in_b: bool,
    /// true if the LP fee was compounded into reserves (not claimable).
    pub compounded: bool,
    pub new_reserve_a: u64,
    pub new_reserve_b: u64,
    /// Amount of the input that actually moved the curve.
    pub curve_in: u64,
    pub price_impact_bps: u64,
}

pub fn fee_amount(amount: u64, fee_bps: u64) -> Option<u64> {
    to_u64(mul_div_ceil(amount as u128, fee_bps as u128, FEE_DENOMINATOR as u128)?)
}

/// Constant-product output: floor(x * R_out / (R_in + x)).
pub fn cp_out(reserve_in: u64, reserve_out: u64, x: u64) -> Option<u64> {
    let denom = (reserve_in as u128).checked_add(x as u128)?;
    to_u64(mul_div_floor(x as u128, reserve_out as u128, denom)?)
}

/// Price impact of pushing `x` into the curve, in bps: x / (R_in + x).
pub fn impact_bps(reserve_in: u64, x: u64) -> Option<u64> {
    let denom = (reserve_in as u128).checked_add(x as u128)?;
    to_u64(mul_div_ceil(x as u128, FEE_DENOMINATOR as u128, denom)?)
}

pub fn swap(
    reserve_a: u64,
    reserve_b: u64,
    amount_in: u64,
    a_to_b: bool,
    fee_bps: u64,
    protocol_share_bps: u64,
    collect_mode: u8,
) -> Option<SwapResult> {
    if reserve_a == 0 || reserve_b == 0 || amount_in == 0 || fee_bps > MAX_TOTAL_FEE_BPS {
        return None;
    }
    if protocol_share_bps > FEE_DENOMINATOR {
        return None;
    }
    let (r_in, r_out) = if a_to_b { (reserve_a, reserve_b) } else { (reserve_b, reserve_a) };
    // Fee is taken from the input when the input is the fee token.
    let fee_on_input = match collect_mode {
        COLLECT_FEE_BOTH => true,
        COLLECT_FEE_QUOTE | COLLECT_FEE_QUOTE_COMPOUND => !a_to_b, // input is B
        _ => return None,
    };
    let compounded = collect_mode == COLLECT_FEE_QUOTE_COMPOUND;
    let fee_in_b = if collect_mode == COLLECT_FEE_BOTH { !a_to_b } else { true };

    let mut res = SwapResult { fee_in_b, compounded, ..Default::default() };
    let (new_r_in, new_r_out);
    if fee_on_input {
        let fee = fee_amount(amount_in, fee_bps)?;
        if fee >= amount_in {
            return None;
        }
        let x = amount_in - fee;
        let out = cp_out(r_in, r_out, x)?;
        if out == 0 || out >= r_out {
            return None;
        }
        let protocol = to_u64(mul_div_floor(fee as u128, protocol_share_bps as u128, FEE_DENOMINATOR as u128)?)?;
        let lp = fee - protocol;
        res.amount_out = out;
        res.fee = fee;
        res.protocol_fee = protocol;
        res.lp_fee = lp;
        res.curve_in = x;
        res.price_impact_bps = impact_bps(r_in, x)?;
        // Input side reserve grows by the curve amount, plus the LP fee
        // when it compounds.
        new_r_in = r_in.checked_add(x)?.checked_add(if compounded { lp } else { 0 })?;
        new_r_out = r_out - out;
    } else {
        // Input is A, fee taken from the B output.
        let gross = cp_out(r_in, r_out, amount_in)?;
        if gross == 0 || gross >= r_out {
            return None;
        }
        let fee = fee_amount(gross, fee_bps)?;
        if fee >= gross {
            return None;
        }
        let protocol = to_u64(mul_div_floor(fee as u128, protocol_share_bps as u128, FEE_DENOMINATOR as u128)?)?;
        let lp = fee - protocol;
        res.amount_out = gross - fee;
        res.fee = fee;
        res.protocol_fee = protocol;
        res.lp_fee = lp;
        res.curve_in = amount_in;
        res.price_impact_bps = impact_bps(r_in, amount_in)?;
        new_r_in = r_in.checked_add(amount_in)?;
        // The whole gross leaves the curve; a compounding LP fee goes back.
        new_r_out = (r_out - gross).checked_add(if compounded { lp } else { 0 })?;
    }
    if a_to_b {
        res.new_reserve_a = new_r_in;
        res.new_reserve_b = new_r_out;
    } else {
        res.new_reserve_b = new_r_in;
        res.new_reserve_a = new_r_out;
    }
    Some(res)
}

// ---------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------

/// Locked forever on a pool's first deposit (share-inflation defence).
pub const MINIMUM_LIQUIDITY: u128 = 1_000;

/// First deposit: liquidity = sqrt(a*b); must exceed MINIMUM_LIQUIDITY.
pub fn initial_liquidity(a: u64, b: u64) -> Option<u128> {
    let l = isqrt((a as u128).checked_mul(b as u128)?);
    if l <= MINIMUM_LIQUIDITY { None } else { Some(l) }
}

/// Liquidity a deposit of at most (max_a, max_b) buys, and the exact
/// (rounded-up) token amounts it costs.
pub fn deposit_quote(
    reserve_a: u64,
    reserve_b: u64,
    total_liquidity: u128,
    max_a: u64,
    max_b: u64,
) -> Option<(u128, u64, u64)> {
    if reserve_a == 0 || reserve_b == 0 || total_liquidity == 0 {
        return None;
    }
    let la = mul_div_floor(max_a as u128, total_liquidity, reserve_a as u128)?;
    let lb = mul_div_floor(max_b as u128, total_liquidity, reserve_b as u128)?;
    let l = la.min(lb);
    if l == 0 {
        return None;
    }
    let a = to_u64(mul_div_ceil(l, reserve_a as u128, total_liquidity)?)?;
    let b = to_u64(mul_div_ceil(l, reserve_b as u128, total_liquidity)?)?;
    if a > max_a || b > max_b {
        return None;
    }
    Some((l, a, b))
}

/// Tokens returned for burning `liquidity` (rounded down).
pub fn withdraw_quote(reserve_a: u64, reserve_b: u64, total_liquidity: u128, liquidity: u128) -> Option<(u64, u64)> {
    if total_liquidity == 0 || liquidity > total_liquidity {
        return None;
    }
    let a = to_u64(mul_div_floor(liquidity, reserve_a as u128, total_liquidity)?)?;
    let b = to_u64(mul_div_floor(liquidity, reserve_b as u128, total_liquidity)?)?;
    Some((a, b))
}

// ---------------------------------------------------------------------
// Fee accounting (claimable fees per unit of liquidity, Q64.64)
// ---------------------------------------------------------------------

/// Growth of fee-per-liquidity for `fee` spread over `total_liquidity`.
pub fn fee_growth(fee: u64, total_liquidity: u128) -> Option<u128> {
    if total_liquidity == 0 {
        return None;
    }
    ((fee as u128) << 64).checked_div(total_liquidity)
}

/// Fees owed to a position since its checkpoint (rounded down).
pub fn pending_fee(global_q64: u128, checkpoint_q64: u128, liquidity: u128) -> Option<u64> {
    let delta = global_q64.checked_sub(checkpoint_q64)?;
    // (delta * liquidity) >> 64 without overflowing: split delta.
    let hi = (delta >> 64).checked_mul(liquidity)?;
    let lo = ((delta & (Q64 - 1)).checked_mul(liquidity)?) >> 64;
    to_u64(hi.checked_add(lo)?)
}

// ---------------------------------------------------------------------
// Host-side tests: `rustc --edition 2021 --test swdmm_math.rs && ./swdmm_math`
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn range(&mut self, lo: u64, hi: u64) -> u64 {
            lo + self.next() % (hi - lo + 1)
        }
    }

    fn fixed(bps: u16) -> BaseFeeConfig {
        BaseFeeConfig { mode: BASE_FEE_MODE_FIXED, decay: 0, cliff_fee_bps: bps, floor_fee_bps: bps, number_of_periods: 0, period_frequency: 0, reduction_factor: 0 }
    }

    #[test]
    fn isqrt_exact() {
        let mut r = Rng(7);
        for _ in 0..20_000 {
            let v = (r.next() as u128) << (r.next() % 64);
            let s = isqrt(v);
            assert!(s * s <= v);
            assert!((s + 1).checked_mul(s + 1).map_or(true, |q| q > v));
        }
        assert_eq!(isqrt(u128::MAX), u64::MAX as u128);
    }

    #[test]
    fn fee_tiers_validate() {
        for bps in [25u16, 30, 100, 200, 400, 600] {
            assert!(validate_base_fee(&fixed(bps)));
        }
        assert!(!validate_base_fee(&fixed(0)));
        assert!(!validate_base_fee(&fixed(1_001)));
    }

    #[test]
    fn time_scheduler_exponential_50_to_floor() {
        // 50% cliff, -10% of the current fee every 5 minutes, floor 1%.
        let c = BaseFeeConfig { mode: BASE_FEE_MODE_TIME, decay: FEE_DECAY_EXPONENTIAL, cliff_fee_bps: 5_000, floor_fee_bps: 100, number_of_periods: 120, period_frequency: 300, reduction_factor: 1_000 };
        assert!(validate_base_fee(&c));
        assert_eq!(scheduled_fee_bps(&c, 0), Some(5_000));
        let f1 = scheduled_fee_bps(&c, 1).unwrap();
        assert!((4_498..=4_500).contains(&f1), "{f1}");
        let mut prev = 5_000;
        for n in 1..200 {
            let f = scheduled_fee_bps(&c, n).unwrap();
            assert!(f <= prev && f >= 100);
            prev = f;
        }
        assert_eq!(scheduled_fee_bps(&c, 10_000), Some(100));
        // periods from time
        assert_eq!(scheduler_periods(&c, 1_000 + 299, 1_000, 0, 0), Some(0));
        assert_eq!(scheduler_periods(&c, 1_000 + 600, 1_000, 0, 0), Some(2));
    }

    #[test]
    fn linear_and_market_cap_scheduler() {
        let c = BaseFeeConfig { mode: BASE_FEE_MODE_MARKET_CAP, decay: FEE_DECAY_LINEAR, cliff_fee_bps: 2_000, floor_fee_bps: 100, number_of_periods: 100, period_frequency: 1_000, reduction_factor: 50 };
        assert!(validate_base_fee(&c));
        let init = price_q64(1_000_000, 1_000_000).unwrap();
        // price down or flat -> no reduction
        assert_eq!(scheduler_periods(&c, 0, 0, init / 2, init), Some(0));
        // +25% -> 2 periods of 10%
        let p = price_q64(1_000_000, 1_250_000).unwrap();
        assert_eq!(scheduler_periods(&c, 0, 0, p, init), Some(2));
        assert_eq!(scheduled_fee_bps(&c, 2), Some(1_900));
        assert_eq!(scheduled_fee_bps(&c, 1_000), Some(100));
    }

    #[test]
    fn swap_matches_constant_product_and_never_loses_k() {
        let mut r = Rng(42);
        for _ in 0..50_000 {
            let ra = r.range(1_000_000, 1u64 << 50);
            let rb = r.range(1_000_000, 1u64 << 50);
            let x = r.range(1, ra / 2);
            let a_to_b = r.next() % 2 == 0;
            let fee = r.range(1, 9_900);
            let share = r.range(0, 5_000);
            let mode = (r.next() % 3) as u8;
            let Some(s) = swap(ra, rb, x, a_to_b, fee, share, mode) else { continue };
            // k never decreases
            let k0 = ra as u128 * rb as u128;
            let k1 = s.new_reserve_a as u128 * s.new_reserve_b as u128;
            assert!(k1 >= k0, "k dropped mode={mode}");
            assert_eq!(s.protocol_fee + s.lp_fee, s.fee);
            // vault conservation: in - out - claimable fees == reserve change
            let (in_res0, out_res0, in_res1, out_res1) = if a_to_b {
                (ra, rb, s.new_reserve_a, s.new_reserve_b)
            } else {
                (rb, ra, s.new_reserve_b, s.new_reserve_a)
            };
            let kept_fee = if s.compounded { s.protocol_fee } else { s.fee };
            let fee_on_input = mode == COLLECT_FEE_BOTH || !a_to_b;
            if fee_on_input {
                assert_eq!(in_res1 as u128 + kept_fee as u128, in_res0 as u128 + x as u128);
                assert_eq!(out_res1 + s.amount_out, out_res0);
            } else {
                assert_eq!(in_res1, in_res0 + x);
                assert_eq!(out_res1 as u128 + s.amount_out as u128 + kept_fee as u128, out_res0 as u128);
            }
        }
    }

    #[test]
    fn swap_fee_side_by_mode() {
        let s = swap(1_000_000_000, 1_000_000_000, 1_000_000, true, 100, 1_000, COLLECT_FEE_BOTH).unwrap();
        assert!(!s.fee_in_b && s.fee == 10_000 && s.protocol_fee == 1_000);
        let s = swap(1_000_000_000, 1_000_000_000, 1_000_000, true, 100, 1_000, COLLECT_FEE_QUOTE).unwrap();
        assert!(s.fee_in_b && !s.compounded);
        let s = swap(1_000_000_000, 1_000_000_000, 1_000_000, false, 100, 0, COLLECT_FEE_QUOTE_COMPOUND).unwrap();
        assert!(s.fee_in_b && s.compounded);
        assert!(swap(1_000, 1_000, 10, true, 100, 0, 9).is_none());
    }

    #[test]
    fn deposit_withdraw_round_trip_never_profits() {
        let mut r = Rng(9);
        for _ in 0..30_000 {
            let a0 = r.range(2_000_000, 1u64 << 40);
            let b0 = r.range(2_000_000, 1u64 << 40);
            let l0 = initial_liquidity(a0, b0).unwrap();
            let ma = r.range(1, 1u64 << 40);
            let mb = r.range(1, 1u64 << 40);
            let Some((l, pa, pb)) = deposit_quote(a0, b0, l0, ma, mb) else { continue };
            assert!(pa <= ma && pb <= mb);
            let (wa, wb) = withdraw_quote(a0 + pa, b0 + pb, l0 + l, l).unwrap();
            assert!(wa <= pa && wb <= pb, "deposit+withdraw returned more than paid");
        }
    }

    #[test]
    fn fee_growth_distributes_without_overpaying() {
        let mut r = Rng(3);
        for _ in 0..20_000 {
            let total = r.range(1_001, 1u64 << 60) as u128;
            let fee = r.range(0, 1u64 << 50);
            let g = fee_growth(fee, total).unwrap();
            let part = r.range(0, total as u64) as u128;
            let rest = total - part;
            let a = pending_fee(g, 0, part).unwrap();
            let b = pending_fee(g, 0, rest).unwrap();
            assert!(a as u128 + b as u128 <= fee as u128);
        }
    }

    #[test]
    fn dynamic_fee_rises_with_volatility_and_decays() {
        let c = DynamicFeeConfig { enabled: true, max_dynamic_fee_bps: 500, variable_fee_control: 1_000, filter_period: 10, decay_period: 120, reduction_factor: 5_000, max_volatility_accumulator: 100_000 };
        assert!(validate_dynamic_fee(&c));
        let mut s = VolatilityState::default();
        let p0 = price_q64(1_000_000, 1_000_000).unwrap();
        update_references(&c, &mut s, 0, p0);
        accumulate(&c, &mut s, price_q64(1_000_000, 1_100_000).unwrap(), 0);
        assert!((999..=1_000).contains(&s.volatility_accumulator));
        assert!((99..=100).contains(&variable_fee_bps(&c, &s)));
        // 30s later: reference halves
        update_references(&c, &mut s, 30, price_q64(1_000_000, 1_100_000).unwrap());
        assert!((499..=500).contains(&s.volatility_reference));
        // long quiet period: back to zero
        update_references(&c, &mut s, 1_000, p0);
        assert_eq!(s.volatility_reference, 0);
        let off = DynamicFeeConfig { enabled: false, ..c };
        assert_eq!(variable_fee_bps(&off, &s), 0);
        // A disabled config is never validated, so enabling it must be.
        assert!(can_enable_dynamic_fee(&off));
        let zeros = DynamicFeeConfig { enabled: false, max_dynamic_fee_bps: 0, variable_fee_control: 0, filter_period: 0, decay_period: 0, reduction_factor: 0, max_volatility_accumulator: 0 };
        assert!(validate_dynamic_fee(&zeros));
        assert!(!can_enable_dynamic_fee(&zeros));
        let too_high = DynamicFeeConfig { enabled: false, max_dynamic_fee_bps: u16::MAX, ..c };
        assert!(validate_dynamic_fee(&too_high));
        assert!(!can_enable_dynamic_fee(&too_high));
        assert_eq!(total_fee_bps(9_800, 500), MAX_TOTAL_FEE_BPS);
    }

    #[test]
    fn price_impact() {
        assert_eq!(impact_bps(1_000, 1_000), Some(5_000));
        assert_eq!(impact_bps(1_000_000, 1), Some(1));
    }
}
