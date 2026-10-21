// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// UNAUDITED. ZETAPHY DLMM (discrete liquidity bins), testnet only.
// ============================================================================
//
// Fixed-point math for the DLMM pair. Ported from our own Solana design
// (programs/swd_amm/src/dlmm.rs, Q64.64 there) to 128.128 on the EVM:
//
//   - A price is a 128.128 fixed-point number (`priceX128` = price * 2^128):
//     raw units of tokenY per raw unit of tokenX (no decimals involved).
//   - price(id) = (1 + binStep / 10_000) ^ id.  Like dlmm.rs, it is computed
//     from the single step DOWN, 10_000 / (10_000 + binStep), raised to |id|
//     by squaring. That base is < 1, so every product of two 128.128 values
//     stays < 2^256 and needs no 512-bit math; a positive id takes the
//     reciprocal at the end (2^256 / result, one division).
//   - Prices are limited to [2^-96, 2^96] (MIN_PRICE_X128 .. MAX_PRICE_X128):
//     outside it the price has too few significant bits (or a bin could hold
//     almost nothing), so such a bin id is refused (PriceOutOfRange). This is
//     what bounds the bin id range for every bin step.
//   - mulDiv / mulDivUp: floor / ceil of a * b / d with a 512-bit product.
//
// Rounding: every function says which way it rounds; the pair always picks
// the direction that favours the pool (inputs and fees up, outputs down).
//
// Written from scratch for ZETAPHY (MIT). The 128.128 price idea is common to
// bin-based AMMs (Trader Joe's Liquidity Book uses it too; its repository
// traderjoe-xyz/joe-v2 is MIT-licensed, checked 2026-10-21), but no code was
// copied from it or from any other project.

library DlmmMath {
    uint256 internal constant SCALE = 128;
    uint256 internal constant ONE_X128 = 1 << 128;
    /// 2^-96 and 2^96 as 128.128 numbers.
    uint256 internal constant MIN_PRICE_X128 = 1 << 32;
    uint256 internal constant MAX_PRICE_X128 = 1 << 224;
    uint256 internal constant BPS = 10_000;
    /// Largest bin step (10% per bin), same ceiling as dlmm.rs (MAX_BIN_STEP_BPS).
    uint256 internal constant MAX_BIN_STEP = 1_000;
    /// Bin ids are int24; the price range above is reached far inside it.
    int256 internal constant MAX_ABS_ID = (1 << 23) - 1;

    error PriceOutOfRange(int256 id);
    error InvalidBinStep();
    error MulDivOverflow();

    /// price(id) as 128.128. Reverts outside [MIN_PRICE_X128, MAX_PRICE_X128].
    /// Negative ids round down (a product of floors), positive ids round up
    /// (the reciprocal of that). A pure function of (id, binStep): every bin
    /// always has the same price, whichever path reached it.
    function getPriceX128(int256 id, uint256 binStep) internal pure returns (uint256 priceX128) {
        if (binStep == 0 || binStep > MAX_BIN_STEP) revert InvalidBinStep();
        if (id > MAX_ABS_ID || id < -MAX_ABS_ID) revert PriceOutOfRange(id);
        if (id == 0) return ONE_X128;
        uint256 n = id < 0 ? uint256(-id) : uint256(id);
        uint256 base = (ONE_X128 * BPS) / (BPS + binStep); // < 2^128
        uint256 r = ONE_X128;
        unchecked {
            // r <= 2^128 and base < 2^128: both products stay below 2^256.
            while (true) {
                if (n & 1 != 0) r = (r * base) >> SCALE;
                n >>= 1;
                if (n == 0) break;
                base = (base * base) >> SCALE;
                if (r < MIN_PRICE_X128) break; // already out of range, stop early
            }
        }
        if (id < 0) {
            if (r < MIN_PRICE_X128) revert PriceOutOfRange(id);
            return r;
        }
        if (r == 0) revert PriceOutOfRange(id);
        priceX128 = type(uint256).max / r; // ~ 2^256 / r, rounds the price up
        if (priceX128 > MAX_PRICE_X128) revert PriceOutOfRange(id);
    }

    /// floor(amount * priceX128 / 2^128): tokenX -> tokenY at a bin's price.
    /// amount < 2^128 and price <= 2^224, so the result is < 2^224.
    function mulPriceDown(uint256 amount, uint256 priceX128) internal pure returns (uint256) {
        uint256 hi = priceX128 >> SCALE;
        uint256 lo = priceX128 & type(uint128).max;
        return amount * hi + ((amount * lo) >> SCALE);
    }

    /// ceil(amount * priceX128 / 2^128).
    function mulPriceUp(uint256 amount, uint256 priceX128) internal pure returns (uint256 r) {
        uint256 hi = priceX128 >> SCALE;
        uint256 lo = priceX128 & type(uint128).max;
        uint256 p = amount * lo;
        r = amount * hi + (p >> SCALE);
        if (p & type(uint128).max != 0) r += 1;
    }

    /// floor(amount * 2^128 / priceX128): tokenY -> tokenX at a bin's price.
    function divPriceDown(uint256 amount, uint256 priceX128) internal pure returns (uint256) {
        return (amount << SCALE) / priceX128;
    }

    /// ceil(amount * 2^128 / priceX128).
    function divPriceUp(uint256 amount, uint256 priceX128) internal pure returns (uint256 r) {
        uint256 n = amount << SCALE;
        r = n / priceX128;
        if (n % priceX128 != 0) r += 1;
    }

    /// floor(a * b / d) with a full 512-bit product; reverts if d == 0 or the result overflows.
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit product [p1 p0] = a * b.
            uint256 p0 = a * b;
            uint256 mm = mulmod(a, b, type(uint256).max);
            uint256 p1 = mm - p0 - (mm < p0 ? 1 : 0);
            if (p1 == 0) {
                if (d == 0) revert MulDivOverflow();
                return p0 / d;
            }
            if (d <= p1) revert MulDivOverflow();
            // Subtract the remainder so the division is exact.
            uint256 rem = mulmod(a, b, d);
            p1 -= rem > p0 ? 1 : 0;
            p0 -= rem;
            // Divide out the largest power of two that divides d.
            uint256 twos = d & (~d + 1);
            d /= twos;
            p0 /= twos;
            // 2^256 / twos, and fold the high word into p0.
            p0 |= p1 * ((0 - twos) / twos + 1);
            // d is odd now: its inverse mod 2^256 by Newton's iteration
            // (each step doubles the correct bits: 4 -> 8 -> ... -> 256).
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = p0 * inv;
        }
    }

    /// ceil(a * b / d).
    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        result = mulDiv(a, b, d);
        if (mulmod(a, b, d) != 0) {
            if (result == type(uint256).max) revert MulDivOverflow();
            result += 1;
        }
    }

    /// ceil(a * b / d) for small operands (no overflow possible in the callers).
    function ceilDiv(uint256 n, uint256 d) internal pure returns (uint256) {
        return n / d + (n % d == 0 ? 0 : 1);
    }

    /// Index of the most significant set bit (x > 0).
    function msb(uint256 x) internal pure returns (uint256 r) {
        if (x >= 1 << 128) { x >>= 128; r += 128; }
        if (x >= 1 << 64) { x >>= 64; r += 64; }
        if (x >= 1 << 32) { x >>= 32; r += 32; }
        if (x >= 1 << 16) { x >>= 16; r += 16; }
        if (x >= 1 << 8) { x >>= 8; r += 8; }
        if (x >= 1 << 4) { x >>= 4; r += 4; }
        if (x >= 1 << 2) { x >>= 2; r += 2; }
        if (x >= 1 << 1) r += 1;
    }

    /// Index of the least significant set bit (x > 0).
    function lsb(uint256 x) internal pure returns (uint256) {
        unchecked {
            return msb(x & (~x + 1));
        }
    }
}

/// A set of bin indexes (0 .. 2^24-1) as a three-level bitmap, so the swap can
/// jump straight to the next bin that holds liquidity instead of stepping
/// through empty bins one by one (dlmm.rs stepped bin by bin inside a fixed
/// 201-bin array; the EVM version has no fixed array). Each lookup reads at
/// most 3 + 2 storage words.
library DlmmBinTree {
    uint256 internal constant NONE = type(uint256).max;

    struct Tree {
        uint256 level2; // bit k: level1[k] != 0
        mapping(uint256 => uint256) level1; // bit j of level1[k]: level0[k*256+j] != 0
        mapping(uint256 => uint256) level0; // bit b of level0[w]: index w*256+b is in the set
    }

    function contains(Tree storage t, uint256 i) internal view returns (bool) {
        return t.level0[i >> 8] & (1 << (i & 255)) != 0;
    }

    function add(Tree storage t, uint256 i) internal {
        uint256 k0 = i >> 8;
        uint256 w0 = t.level0[k0];
        uint256 b0 = 1 << (i & 255);
        if (w0 & b0 != 0) return;
        t.level0[k0] = w0 | b0;
        if (w0 != 0) return;
        uint256 k1 = i >> 16;
        uint256 w1 = t.level1[k1];
        t.level1[k1] = w1 | (1 << (k0 & 255));
        if (w1 != 0) return;
        t.level2 |= 1 << k1;
    }

    function remove(Tree storage t, uint256 i) internal {
        uint256 k0 = i >> 8;
        uint256 w0 = t.level0[k0];
        uint256 b0 = 1 << (i & 255);
        if (w0 & b0 == 0) return;
        w0 &= ~b0;
        t.level0[k0] = w0;
        if (w0 != 0) return;
        uint256 k1 = i >> 16;
        uint256 w1 = t.level1[k1] & ~(1 << (k0 & 255));
        t.level1[k1] = w1;
        if (w1 != 0) return;
        t.level2 &= ~(1 << k1);
    }

    /// The largest index in the set that is < i, or NONE.
    function below(Tree storage t, uint256 i) internal view returns (uint256) {
        uint256 k0 = i >> 8;
        uint256 w = t.level0[k0] & ((1 << (i & 255)) - 1);
        if (w != 0) return (k0 << 8) | DlmmMath.msb(w);
        uint256 k1 = i >> 16;
        w = t.level1[k1] & ((1 << (k0 & 255)) - 1);
        if (w == 0) {
            w = t.level2 & ((1 << k1) - 1);
            if (w == 0) return NONE;
            k1 = DlmmMath.msb(w);
            w = t.level1[k1];
        }
        k0 = (k1 << 8) | DlmmMath.msb(w);
        return (k0 << 8) | DlmmMath.msb(t.level0[k0]);
    }

    /// The smallest index in the set that is > i, or NONE.
    function above(Tree storage t, uint256 i) internal view returns (uint256) {
        uint256 k0 = i >> 8;
        uint256 w;
        unchecked {
            w = t.level0[k0] & ~((2 << (i & 255)) - 1); // 2 << 255 wraps to 0: mask 0
        }
        if (w != 0) return (k0 << 8) | DlmmMath.lsb(w);
        uint256 k1 = i >> 16;
        unchecked {
            w = t.level1[k1] & ~((2 << (k0 & 255)) - 1);
        }
        if (w == 0) {
            unchecked {
                w = t.level2 & ~((2 << k1) - 1);
            }
            if (w == 0) return NONE;
            k1 = DlmmMath.lsb(w);
            w = t.level1[k1];
        }
        k0 = (k1 << 8) | DlmmMath.lsb(w);
        return (k0 << 8) | DlmmMath.lsb(t.level0[k0]);
    }
}
