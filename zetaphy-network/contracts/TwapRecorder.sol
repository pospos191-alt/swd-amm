// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The Uniswap-V2 pair surface (ZetaphyPair) the recorder reads.
interface ITwapPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title TwapRecorder: observations of DEX pairs' cumulative prices, for TWAPs
/// @notice A Uniswap-V2 pair (ZetaphyPair) keeps price0/price1CumulativeLast:
///         the running sum of its price times the seconds it held, updated at
///         the FIRST trade of a block with the reserves from before it. A TWAP
///         over [t0, t1] is (cumulative(t1) - cumulative(t0)) / (t1 - t0); it
///         needs cumulative(t0) remembered, which is what this contract does.
///         No owner, no settings after deployment. Anyone (a keeper, the relay,
///         a user) may call record(pair):
///           - at most one observation per pair every `minSpacing` seconds and
///             never two in one block, so pokes cannot flood the ring;
///           - an observation is the cumulative price as of now, counted with
///             the reserves from before this block's first trade (the pair's
///             own rule), so a swap in the same transaction or block as the
///             record (or as the read) adds nothing to the average;
///           - it also keeps sqrt(reserve0 * reserve1) (pool depth that swaps
///             cannot lower), so a reader can require depth at every observation
///             of its window, not only at the moment it reads.
///         consult() returns the window's average and what a reader needs to
///         judge it (oldest time, observation count, smallest depth, the
///         largest gap of one segment's average from the window's average: a
///         price pushed hard for one block shows up as an outlier segment).
contract TwapRecorder {
    struct Observation {
        uint64 time;
        uint128 depth;   // sqrt(reserve0 * reserve1), raw units
        uint256 cum0;    // price0Cumulative (UQ112x112 seconds), wraps by design
        uint256 cum1;
    }

    uint16 public constant CAPACITY = 96;
    uint32 public immutable minSpacing;

    mapping(address => Observation[CAPACITY]) private _obs;
    mapping(address => uint16) public nextIndex;
    mapping(address => uint16) public count;

    event Observed(address indexed pair, uint64 time, uint256 cum0, uint256 cum1, uint128 depth);

    error NotEnoughHistory();
    error EmptyPool();

    constructor(uint32 minSpacing_) {
        require(minSpacing_ >= 1, "spacing");
        minSpacing = minSpacing_;
    }

    /// Records an observation if minSpacing has passed since the last one. Returns whether it did.
    function record(address pair) external returns (bool) {
        uint16 n = count[pair];
        if (n != 0) {
            Observation storage last = _obs[pair][(nextIndex[pair] + CAPACITY - 1) % CAPACITY];
            if (block.timestamp < uint256(last.time) + minSpacing) return false;
        }
        (uint256 c0, uint256 c1, uint128 d) = current(pair);
        if (d == 0) revert EmptyPool();
        uint16 i = nextIndex[pair];
        _obs[pair][i] = Observation(uint64(block.timestamp), d, c0, c1);
        nextIndex[pair] = (i + 1) % CAPACITY;
        if (n < CAPACITY) count[pair] = n + 1;
        emit Observed(pair, uint64(block.timestamp), c0, c1, d);
        return true;
    }

    /// The pair's cumulative prices as of now (Uniswap's currentCumulativePrices) and its depth.
    function current(address pair) public view returns (uint256 c0, uint256 c1, uint128 depth) {
        c0 = ITwapPair(pair).price0CumulativeLast();
        c1 = ITwapPair(pair).price1CumulativeLast();
        (uint112 r0, uint112 r1, uint32 last) = ITwapPair(pair).getReserves();
        uint32 nowTs = uint32(block.timestamp);
        if (last != nowTs && r0 != 0 && r1 != 0) {
            unchecked {
                uint32 elapsed = nowTs - last; // wraps, as in the pair
                c0 += ((uint256(r1) << 112) / r0) * elapsed;
                c1 += ((uint256(r0) << 112) / r1) * elapsed;
            }
        }
        depth = uint128(_sqrt(uint256(r0) * uint256(r1)));
    }

    /// The i-th newest observation (0 = newest).
    function observation(address pair, uint16 i) public view returns (Observation memory) {
        require(i < count[pair], "index");
        return _obs[pair][(nextIndex[pair] + CAPACITY - 1 - i) % CAPACITY];
    }

    struct Twap {
        uint256 avg0;          // UQ112x112: token1 per token0 (raw units), over [from, now]
        uint256 avg1;          // token0 per token1
        uint64 from;           // the observation the window starts at (at least `window` old)
        uint64 newest;         // the newest observation's time
        uint16 observations;   // observations in [from, now], `from` included
        uint128 minDepth;      // smallest depth at those observations and now
        uint256 maxSegmentGapBps; // largest |segment average - window average| / window average of avg0, in bps
    }

    /// The average over the newest observation that is at least `window` seconds old up to now.
    /// Reverts NotEnoughHistory if there is none.
    function consult(address pair, uint32 window) external view returns (Twap memory t) {
        uint16 n = count[pair];
        uint256 nowTs = block.timestamp;
        // newest first: find the first one at least `window` old
        uint16 k = type(uint16).max;
        for (uint16 i = 0; i < n; i++) {
            if (nowTs >= uint256(observation(pair, i).time) + window) { k = i; break; }
        }
        if (k == type(uint16).max) revert NotEnoughHistory();
        Observation memory start = observation(pair, k);
        (uint256 c0, uint256 c1, uint128 d) = current(pair);
        uint256 span = nowTs - start.time;
        if (span == 0) revert NotEnoughHistory();
        unchecked {
            t.avg0 = (c0 - start.cum0) / span;
            t.avg1 = (c1 - start.cum1) / span;
        }
        t.from = start.time;
        t.newest = n == 0 ? 0 : observation(pair, 0).time;
        t.observations = k + 1;
        (t.minDepth, t.maxSegmentGapBps) = _segments(pair, k, start, Observation(uint64(nowTs), d, c0, c1), t.avg0);
    }

    /// Walks start -> ... -> newest -> now: the smallest depth, and the largest gap of a
    /// segment's average (avg0) from the window's average, in bps.
    function _segments(address pair, uint16 k, Observation memory prev, Observation memory last, uint256 avg)
        private view returns (uint128 minDepth, uint256 maxGapBps)
    {
        minDepth = prev.depth < last.depth ? prev.depth : last.depth;
        for (uint16 j = k + 1; j > 0; j--) {
            Observation memory o = j == 1 ? last : observation(pair, j - 2);
            if (o.depth < minDepth) minDepth = o.depth;
            uint256 dt = uint256(o.time) - prev.time;
            if (dt != 0 && avg != 0) {
                uint256 seg;
                unchecked { seg = (o.cum0 - prev.cum0) / dt; }
                uint256 bps = _mulDiv(seg > avg ? seg - avg : avg - seg, 10_000, avg);
                if (bps > maxGapBps) maxGapBps = bps;
            }
            prev = o;
        }
    }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) { z = y; y = (x / y + y) / 2; }
    }

    /// floor(a * b / d) with a 512-bit product (Remco Bloemen's mulDiv, MIT).
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1, "mulDiv");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}
