// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Pyth's IPyth read surface, with PythStructs.Price's layout (the real Pyth and ZetaphyPythRelay both answer it).
interface IPythPrice {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// TwapRecorder's surface.
interface ITwapSource {
    struct Twap {
        uint256 avg0;
        uint256 avg1;
        uint64 from;
        uint64 newest;
        uint16 observations;
        uint128 minDepth;
        uint256 maxSegmentGapBps;
    }
    function consult(address pair, uint32 window) external view returns (Twap memory);
    function record(address pair) external returns (bool);
}

interface IPairTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @title ZetaphyOracle: one price per asset, or a clear revert
/// @notice price(asset) returns (value, updatedAt): `value` is the asset's price in
///         USD with 18 decimals (1e18 = $1 per whole token), `updatedAt` the oldest
///         source time behind it. When any guard fails it REVERTS with an error
///         naming what failed; it never returns a stale, lopsided or jumped value.
///         Sources, per asset (governance enables one or both):
///           a) a TWAP of a ZETAPHY DEX pair (TwapRecorder observations, the pair's
///              cumulative prices; the other token is a USD stablecoin counted at $1):
///              valid only over at least `window` seconds (from an observation at
///              most 2 x window old), with at least `minObservations` observations
///              in it, a pool depth (quote side, 18 decimals) of at least
///              `minLiquidity` at every observation and now, and no segment
///              between observations averaging more than `maxSegmentGapBps` away
///              from the window's average;
///           b) Pyth (IPyth.getPriceUnsafe; on ZETAPHY a ZetaphyPythRelay until Pyth
///              or a Hyperlane route is here): not older than `maxAge`, not dated
///              in the future, positive, confidence interval at most `maxConfBps`
///              of the price.
///         With both: they must agree within `maxDeviationBps` (else SourcesDeviate);
///         the value is Pyth's, anchored by the TWAP. Decimals are normalized
///         (token decimals, Pyth's exponent) to 18.
///         Circuit breaker: poke(asset) (anyone; a keeper, the relay) records a TWAP
///         observation and, if every guard passes, makes the live price the
///         reference. price() refuses a live price more than `maxChangeBps` from the
///         reference, or more than `maxWindowChangeBps` from the price at the start
///         of the current `changeWindow`. A poke that sees such a jump TRIPS the
///         breaker: the asset has no price until governance resets it (through the
///         timelock). poke() also logs DeviationTripped / StaleFeed / SourceProblem
///         for the bridge monitor (zetaphy bridge monitor).
///         Roles: governance (the ZetaphyTimelock) sets every parameter; guardians
///         (multisigs governance names) may pause a feed at once. Unpausing,
///         resetting a tripped breaker and any setting wait the timelock.
contract ZetaphyOracle {
    struct TwapConfig {
        address pair;            // zero: no TWAP source
        bool assetIsToken0;
        uint8 assetDecimals;
        uint8 quoteDecimals;
        uint32 window;           // seconds
        uint16 minObservations;
        uint16 maxSegmentGapBps;
        uint128 minLiquidity;    // quote-side depth, 18 decimals (USD)
    }
    struct PythConfig {
        bytes32 id;              // zero: no Pyth source
        uint32 maxAge;           // seconds
        uint16 maxConfBps;
    }
    struct Guards {
        uint16 maxDeviationBps;      // between the two sources
        uint16 maxChangeBps;         // from the reference (the last accepted price)
        uint16 maxWindowChangeBps;   // from the price at the start of the change window
        uint32 changeWindow;         // seconds
    }
    struct State {
        uint128 lastPrice;       // the reference (0: none yet, poke first)
        uint64 lastAt;
        bool paused;
        bool tripped;
        uint128 windowPrice;
        uint64 windowStart;
    }

    /// What went wrong with the live price (poke logs it; price() reverts with the matching error).
    enum Problem { None, NotConfigured, TwapUnavailable, TwapStale, TooFewObservations, LowLiquidity, TwapSpike,
        PythUnavailable, PythStale, PythInvalid, PythConfidence, SourcesDeviate }

    ITwapSource public immutable recorder;
    IPythPrice public pyth;
    address public governance;
    mapping(address => bool) public guardian;

    mapping(address => TwapConfig) public twapOf;
    mapping(address => PythConfig) public pythOf;
    mapping(address => Guards) public guardsOf;
    mapping(address => State) public stateOf;
    address[] private _assets;
    mapping(address => bool) public listed;

    uint256 public constant MAX_FUTURE = 60;   // seconds a Pyth publishTime may run ahead (clock skew)
    uint256 private constant BPS = 10_000;

    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);
    event PythSet(address pyth);
    event TwapConfigured(address indexed asset, address pair, uint32 window, uint16 minObservations, uint16 maxSegmentGapBps, uint128 minLiquidity);
    event PythConfigured(address indexed asset, bytes32 id, uint32 maxAge, uint16 maxConfBps);
    event GuardsSet(address indexed asset, uint16 maxDeviationBps, uint16 maxChangeBps, uint16 maxWindowChangeBps, uint32 changeWindow);
    event FeedPaused(address indexed asset, address indexed by);
    event FeedUnpaused(address indexed asset);
    event CircuitBreakerReset(address indexed asset);
    event Poked(address indexed asset, uint256 price, uint256 updatedAt);
    event DeviationTripped(address indexed asset, uint256 twapPrice, uint256 pythPrice, uint256 bps);
    event StaleFeed(address indexed asset, uint8 source, uint256 updatedAt);   // source 1 TWAP, 2 Pyth
    event SourceProblem(address indexed asset, uint8 problem, uint256 a, uint256 b);
    event CircuitBreakerTripped(address indexed asset, uint256 price, uint256 ref, uint256 bps);

    error NotGovernance();
    error NotGuardian();
    error UnknownAsset(address asset);
    error FeedIsPaused(address asset);
    error BreakerTripped(address asset);
    error NoReference(address asset);
    error PriceJump(address asset, uint256 price, uint256 ref, uint256 bps);
    /// No source enabled, or no guards set (setGuards is required).
    error NotConfigured(address asset);
    error TwapUnavailable(address asset);
    error TwapStale(address asset, uint256 from);
    error TooFewObservations(address asset, uint256 have, uint256 need);
    error LowLiquidity(address asset, uint256 depth, uint256 need);
    error TwapSpike(address asset, uint256 bps, uint256 most);
    error PythUnavailable(address asset);
    error PythStale(address asset, uint256 publishTime);
    error PythInvalid(address asset);
    error PythConfidence(address asset, uint256 bps, uint256 most);
    error SourcesDeviate(address asset, uint256 twapPrice, uint256 pythPrice, uint256 bps);
    error BadConfig();

    constructor(address governance_, ITwapSource recorder_, IPythPrice pyth_) {
        if (governance_ == address(0) || address(recorder_) == address(0)) revert BadConfig();
        governance = governance_;
        recorder = recorder_;
        pyth = pyth_;
        emit GovernanceSet(governance_);
        emit PythSet(address(pyth_));
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    // ---- governance (the timelock) ----

    function setGovernance(address g) external onlyGov { if (g == address(0)) revert BadConfig(); governance = g; emit GovernanceSet(g); }
    function setGuardian(address who, bool on) external onlyGov { guardian[who] = on; emit GuardianSet(who, on); }
    /// The Pyth contract (ZetaphyPythRelay now; Pyth itself once deployed on ZETAPHY). Zero: no Pyth.
    function setPyth(IPythPrice p) external onlyGov { pyth = p; emit PythSet(address(p)); }

    /// The TWAP source of `asset`: a DEX pair of `asset` and a USD stablecoin (pair zero: off).
    function setTwap(address asset, address pair, uint32 window, uint16 minObservations, uint16 maxSegmentGapBps, uint128 minLiquidity) external onlyGov {
        TwapConfig memory c;
        if (pair != address(0)) {
            address t0 = IPairTokens(pair).token0();
            address t1 = IPairTokens(pair).token1();
            if (asset != t0 && asset != t1) revert BadConfig();
            if (window < 60 || minObservations < 2 || maxSegmentGapBps == 0 || minLiquidity == 0) revert BadConfig();
            c = TwapConfig(pair, asset == t0, IDecimals(asset).decimals(), IDecimals(asset == t0 ? t1 : t0).decimals(),
                window, minObservations, maxSegmentGapBps, minLiquidity);
            if (c.quoteDecimals > 18 || c.assetDecimals > 30) revert BadConfig();
        }
        twapOf[asset] = c;
        _configured(asset);
        emit TwapConfigured(asset, pair, window, minObservations, maxSegmentGapBps, minLiquidity);
    }

    /// The Pyth feed of `asset` (id zero: off).
    function setPythFeed(address asset, bytes32 id, uint32 maxAge, uint16 maxConfBps) external onlyGov {
        if (id != bytes32(0) && (maxAge == 0 || maxConfBps == 0 || maxConfBps > BPS)) revert BadConfig();
        pythOf[asset] = PythConfig(id, maxAge, maxConfBps);
        _configured(asset);
        emit PythConfigured(asset, id, maxAge, maxConfBps);
    }

    function setGuards(address asset, uint16 maxDeviationBps, uint16 maxChangeBps, uint16 maxWindowChangeBps, uint32 changeWindow) external onlyGov {
        if (maxDeviationBps == 0 || maxChangeBps == 0 || maxWindowChangeBps < maxChangeBps || changeWindow == 0
            || maxDeviationBps > BPS || maxWindowChangeBps > BPS) revert BadConfig();
        guardsOf[asset] = Guards(maxDeviationBps, maxChangeBps, maxWindowChangeBps, changeWindow);
        _configured(asset);
        emit GuardsSet(asset, maxDeviationBps, maxChangeBps, maxWindowChangeBps, changeWindow);
    }

    /// Lifts a pause.
    function unpauseFeed(address asset) external onlyGov { stateOf[asset].paused = false; emit FeedUnpaused(asset); }

    /// Clears a tripped breaker and the reference: the next poke starts from the live price again.
    function resetCircuitBreaker(address asset) external onlyGov {
        State storage s = stateOf[asset];
        s.tripped = false;
        s.lastPrice = 0; s.lastAt = 0; s.windowPrice = 0; s.windowStart = 0;
        emit CircuitBreakerReset(asset);
    }

    function _configured(address asset) private {
        if (!listed[asset]) { listed[asset] = true; _assets.push(asset); }
        // A new source or guard starts from a fresh reference (the next poke).
        State storage s = stateOf[asset];
        s.lastPrice = 0; s.lastAt = 0; s.windowPrice = 0; s.windowStart = 0;
    }

    // ---- emergency: a guardian (or governance) stops a feed at once ----

    function pauseFeed(address asset) external {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
        stateOf[asset].paused = true;
        emit FeedPaused(asset, msg.sender);
    }

    // ---- consumers ----

    function assets() external view returns (address[] memory) { return _assets; }

    /// The asset's price in USD (18 decimals) and the time of its oldest source, or a revert naming why not.
    function price(address asset) external view returns (uint256 value, uint256 updatedAt) {
        if (!listed[asset]) revert UnknownAsset(asset);
        State memory s = stateOf[asset];
        if (s.paused) revert FeedIsPaused(asset);
        if (s.tripped) revert BreakerTripped(asset);
        Problem p; uint256 a; uint256 b;
        (value, updatedAt, p, a, b) = _live(asset);
        if (p != Problem.None) _fail(asset, p, a, b);
        if (s.lastPrice == 0) revert NoReference(asset);
        (uint256 ref, uint256 bps, bool ok) = _change(asset, s, value);
        if (!ok) revert PriceJump(asset, value, ref, bps);
    }

    /// The live price and what is wrong with it, without the circuit breaker (for monitors and tests).
    function livePrice(address asset) external view returns (uint256 value, uint256 updatedAt, Problem problem, uint256 a, uint256 b) {
        return _live(asset);
    }

    /// Anyone: records a TWAP observation and, when every guard passes, moves the reference
    /// to the live price. A jump beyond the change limits trips the breaker. Returns whether
    /// the reference moved.
    function poke(address asset) external returns (bool) {
        if (!listed[asset]) revert UnknownAsset(asset);
        address pair = twapOf[asset].pair;
        if (pair != address(0)) { try recorder.record(pair) {} catch {} }
        State storage s = stateOf[asset];
        if (s.paused || s.tripped) return false;
        (uint256 value, uint256 at, Problem p, uint256 a, uint256 b) = _live(asset);
        if (p != Problem.None) {
            if (p == Problem.SourcesDeviate) emit DeviationTripped(asset, a, b, _bps(a, b));
            else if (p == Problem.TwapStale) emit StaleFeed(asset, 1, a);
            else if (p == Problem.PythStale) emit StaleFeed(asset, 2, a);
            else emit SourceProblem(asset, uint8(p), a, b);
            return false;
        }
        if (s.lastPrice != 0) {
            if (block.timestamp >= uint256(s.windowStart) + guardsOf[asset].changeWindow) {
                s.windowPrice = s.lastPrice;
                s.windowStart = uint64(block.timestamp);
            }
            (uint256 ref, uint256 bps, bool ok) = _change(asset, s, value);
            if (!ok) {
                s.tripped = true;
                emit CircuitBreakerTripped(asset, value, ref, bps);
                return false;
            }
        } else {
            s.windowPrice = uint128(value);
            s.windowStart = uint64(block.timestamp);
        }
        s.lastPrice = uint128(value);
        s.lastAt = uint64(at);
        emit Poked(asset, value, at);
        return true;
    }

    // ---- internals ----

    /// (reference, bps, ok): the live value against the reference and the window's start price.
    function _change(address asset, State memory s, uint256 value) private view returns (uint256, uint256, bool) {
        Guards memory g = guardsOf[asset];
        uint256 bps = _bps(value, s.lastPrice);
        if (bps > g.maxChangeBps) return (s.lastPrice, bps, false);
        if (s.windowPrice != 0 && block.timestamp < uint256(s.windowStart) + g.changeWindow) {
            uint256 wb = _bps(value, s.windowPrice);
            if (wb > g.maxWindowChangeBps) return (s.windowPrice, wb, false);
        }
        return (s.lastPrice, bps, true);
    }

    function _live(address asset) private view returns (uint256 value, uint256 at, Problem p, uint256 a, uint256 b) {
        TwapConfig memory t = twapOf[asset];
        PythConfig memory y = pythOf[asset];
        if (t.pair == address(0) && (y.id == bytes32(0) || address(pyth) == address(0))) return (0, 0, Problem.NotConfigured, 0, 0);
        if (guardsOf[asset].maxChangeBps == 0) return (0, 0, Problem.NotConfigured, 0, 0); // guards are required
        uint256 twapValue; uint256 twapAt;
        if (t.pair != address(0)) {
            (twapValue, twapAt, p, a, b) = _twap(t);
            if (p != Problem.None) return (0, 0, p, a, b);
        }
        uint256 pythValue; uint256 pythAt;
        if (y.id != bytes32(0) && address(pyth) != address(0)) {
            (pythValue, pythAt, p, a, b) = _pyth(y);
            if (p != Problem.None) return (0, 0, p, a, b);
        }
        if (twapValue != 0 && pythValue != 0) {
            uint256 dev = _bps(twapValue, pythValue);
            if (dev > guardsOf[asset].maxDeviationBps) return (0, 0, Problem.SourcesDeviate, twapValue, pythValue);
            return (pythValue, pythAt < twapAt ? pythAt : twapAt, Problem.None, 0, 0);
        }
        return pythValue != 0 ? (pythValue, pythAt, Problem.None, 0, 0) : (twapValue, twapAt, Problem.None, 0, 0);
    }

    function _twap(TwapConfig memory t) private view returns (uint256 value, uint256 at, Problem p, uint256 a, uint256 b) {
        ITwapSource.Twap memory w;
        try recorder.consult(t.pair, t.window) returns (ITwapSource.Twap memory r) { w = r; } catch { return (0, 0, Problem.TwapUnavailable, 0, 0); }
        if (block.timestamp - w.from > 2 * uint256(t.window)) return (0, 0, Problem.TwapStale, w.from, 0);
        if (w.observations < t.minObservations) return (0, 0, Problem.TooFewObservations, w.observations, t.minObservations);
        if (w.maxSegmentGapBps > t.maxSegmentGapBps) return (0, 0, Problem.TwapSpike, w.maxSegmentGapBps, t.maxSegmentGapBps);
        uint256 avg = t.assetIsToken0 ? w.avg0 : w.avg1;   // quote (raw) per asset (raw), UQ112x112
        if (avg == 0) return (0, 0, Problem.TwapUnavailable, 0, 0);
        // depth: sqrt(r0 r1) * sqrt(quote per asset) = the quote reserve; then 18 decimals
        uint256 depth = (uint256(w.minDepth) * _sqrt(avg)) >> 56;
        depth = depth * (10 ** uint256(18 - t.quoteDecimals));
        if (depth < t.minLiquidity) return (0, 0, Problem.LowLiquidity, depth, t.minLiquidity);
        value = _mulDiv(avg, 10 ** (uint256(t.assetDecimals) + 18), (10 ** uint256(t.quoteDecimals)) << 112);
        if (value == 0 || value > type(uint128).max) return (0, 0, Problem.TwapUnavailable, 0, 0);
        return (value, w.newest, Problem.None, 0, 0);
    }

    function _pyth(PythConfig memory y) private view returns (uint256 value, uint256 at, Problem p, uint256 a, uint256 b) {
        IPythPrice.Price memory q;
        try pyth.getPriceUnsafe(y.id) returns (IPythPrice.Price memory r) { q = r; } catch { return (0, 0, Problem.PythUnavailable, 0, 0); }
        if (q.publishTime > block.timestamp + MAX_FUTURE) return (0, 0, Problem.PythInvalid, q.publishTime, 0);
        if (block.timestamp > q.publishTime && block.timestamp - q.publishTime > y.maxAge) return (0, 0, Problem.PythStale, q.publishTime, 0);
        if (q.price <= 0 || q.expo < -30 || q.expo > 12) return (0, 0, Problem.PythInvalid, 0, 0);
        uint256 raw = uint256(uint64(q.price));
        uint256 confBps = _mulDiv(uint256(q.conf), BPS, raw);
        if (confBps > y.maxConfBps) return (0, 0, Problem.PythConfidence, confBps, y.maxConfBps);
        int256 e = int256(q.expo) + 18;
        value = e >= 0 ? raw * (10 ** uint256(e)) : raw / (10 ** uint256(-e));
        if (value == 0 || value > type(uint128).max) return (0, 0, Problem.PythInvalid, 0, 0);
        return (value, q.publishTime > block.timestamp ? block.timestamp : q.publishTime, Problem.None, 0, 0);
    }

    function _fail(address asset, Problem p, uint256 a, uint256 b) private pure {
        if (p == Problem.NotConfigured) revert NotConfigured(asset);
        if (p == Problem.TwapUnavailable) revert TwapUnavailable(asset);
        if (p == Problem.TwapStale) revert TwapStale(asset, a);
        if (p == Problem.TooFewObservations) revert TooFewObservations(asset, a, b);
        if (p == Problem.LowLiquidity) revert LowLiquidity(asset, a, b);
        if (p == Problem.TwapSpike) revert TwapSpike(asset, a, b);
        if (p == Problem.PythUnavailable) revert PythUnavailable(asset);
        if (p == Problem.PythStale) revert PythStale(asset, a);
        if (p == Problem.PythInvalid) revert PythInvalid(asset);
        if (p == Problem.PythConfidence) revert PythConfidence(asset, a, b);
        revert SourcesDeviate(asset, a, b, _bps(a, b));
    }

    /// |x - y| / min(x, y), in bps.
    function _bps(uint256 x, uint256 y) private pure returns (uint256) {
        uint256 lo = x < y ? x : y;
        if (lo == 0) return type(uint256).max;
        return _mulDiv(x > y ? x - y : y - x, BPS, lo);
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
