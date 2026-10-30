// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyDlmmFactory} from "../../contracts/dlmm/ZetaphyDlmmFactory.sol";
import {ZetaphyDlmmPair} from "../../contracts/dlmm/ZetaphyDlmmPair.sol";
import {DlmmMath, DlmmBinTree} from "../../contracts/dlmm/DlmmMath.sol";
import {MockERC20} from "./utils/Mocks.sol";

contract DlmmHandler is Test {
    ZetaphyDlmmPair public pair;
    MockERC20 public x;
    MockERC20 public y;
    ZetaphyDlmmFactory public f;
    address public gov;
    address[2] public lps = [address(0xF001), address(0xF002)];
    address public trader = address(0xF0F0);
    int24[] public touched;
    mapping(int24 => bool) public seen;
    uint256 public roundTripProfit;      // X -> Y -> X returned more X than went in
    uint256 public unauthorizedBurn;     // burned someone else's shares without approval

    constructor(ZetaphyDlmmPair p, MockERC20 x_, MockERC20 y_, ZetaphyDlmmFactory f_, address gov_) {
        (pair, x, y, f, gov) = (p, x_, y_, f_, gov_);
        for (uint256 i; i < 2; i++) {
            x.mint(lps[i], 1e30);
            y.mint(lps[i], 1e30);
        }
        x.mint(trader, 1e30);
        y.mint(trader, 1e30);
    }

    function _note(int24 id) internal {
        if (!seen[id]) {
            seen[id] = true;
            touched.push(id);
        }
    }

    function touchedLength() external view returns (uint256) { return touched.length; }

    function mint(uint256 u, int256 lo, uint256 n, uint256 amount) external {
        address lp = lps[u % 2];
        int24 active = pair.getActiveId();
        n = bound(n, 1, 6);
        lo = bound(lo, -8, 8);
        amount = bound(amount, 1e6, 1e22);
        int24[] memory ids = new int24[](n);
        uint256[] memory ax = new uint256[](n);
        uint256[] memory ay = new uint256[](n);
        uint256 sx;
        uint256 sy;
        for (uint256 i; i < n; i++) {
            int24 id = int24(int256(active) + lo + int256(i));
            ids[i] = id;
            if (id >= active) { ax[i] = amount; sx += amount; }
            if (id <= active) { ay[i] = amount; sy += amount; }
        }
        vm.startPrank(lp);
        x.transfer(address(pair), sx);
        y.transfer(address(pair), sy);
        try pair.mint(lp, ids, ax, ay, lp) {
            for (uint256 i; i < n; i++) _note(ids[i]);
        } catch {
            pair.skim(lp); // give the unused deposit back
        }
        vm.stopPrank();
    }

    function burn(uint256 u, uint256 idSeed, uint256 frac, bool asStranger) external {
        if (touched.length == 0) return;
        address lp = lps[u % 2];
        int24 id = touched[idSeed % touched.length];
        uint256 bal = pair.balanceOf(lp, id);
        if (bal == 0) return;
        int24[] memory ids = new int24[](1);
        ids[0] = id;
        uint256[] memory sh = new uint256[](1);
        sh[0] = bound(frac, 1, bal);
        vm.prank(asStranger ? lps[(u + 1) % 2] : lp);
        try pair.burn(lp, lp, ids, sh) { if (asStranger) unauthorizedBurn++; } catch {}
    }

    function swap(uint256 amount, bool forY) external {
        amount = bound(amount, 1, 1e22);
        vm.startPrank(trader);
        (forY ? x : y).transfer(address(pair), amount);
        try pair.swap(forY, trader) {} catch { pair.skim(trader); }
        vm.stopPrank();
    }

    /// X in, then all the Y out back in: must never return more X than was paid. Donations sitting
    /// in the pair (unaccounted balances) belong to whoever calls next by design, so they are swept
    /// to a sink first: the property is about what the LPs' bins give away.
    function roundTrip(uint256 amount, bool startX) external {
        amount = bound(amount, 1, 1e21);
        MockERC20 a = startX ? x : y;
        uint256 stray = 0;
        pair.skim(address(0x5C1));
        vm.startPrank(trader);
        a.transfer(address(pair), amount);
        try pair.swap(startX, trader) returns (uint256 out) {
            (startX ? y : x).transfer(address(pair), out);
            try pair.swap(!startX, trader) returns (uint256 back) {
                if (back > amount + stray) roundTripProfit++;
            } catch { pair.skim(trader); }
        } catch { pair.skim(trader); }
        vm.stopPrank();
    }

    function donate(uint256 amount, bool skim) external {
        x.mint(address(pair), bound(amount, 0, 1e20));
        if (skim) pair.skim(address(0x5C1));
    }

    function protocolShare(uint16 bps) external {
        vm.prank(gov);
        f.setPairProtocolShare(address(pair), uint16(bound(bps, 0, 5000)));
    }

    function collect() external {
        try pair.collectProtocolFees() {} catch {}
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 2 hours)); }
}

contract DlmmInvariants is Test {
    ZetaphyDlmmFactory f;
    ZetaphyDlmmPair pair;
    MockERC20 x;
    MockERC20 y;
    DlmmHandler h;
    address gov = address(0x60F);

    function setUp() public {
        vm.warp(1_700_000_000);
        MockERC20 t1 = new MockERC20("T1", "T1", 18);
        MockERC20 t2 = new MockERC20("T2", "T2", 18);
        (x, y) = address(t1) < address(t2) ? (t1, t2) : (t2, t1);
        f = new ZetaphyDlmmFactory(gov);
        vm.startPrank(gov);
        f.setPreset(25, ZetaphyDlmmFactory.Preset({baseFeeBps: 20, maxDynamicFeeBps: 100, variableFeeControl: 5000, filterPeriod: 30,
            decayPeriod: 600, reductionFactor: 5000, maxVolatilityAccumulator: 350_000, enabled: true}));
        f.setFeeTo(address(0xFEE));
        vm.stopPrank();
        pair = ZetaphyDlmmPair(f.createPair(address(x), address(y), 25, 0));
        h = new DlmmHandler(pair, x, y, f, gov);
        h.mint(0, -5, 6, 1e20);
        h.mint(1, 0, 6, 1e20);
        targetContract(address(h));
    }

    /// Reserves are the sum of the bins; the token balances cover reserves + protocol fees.
    function invariant_reservesMatchBins() public view {
        uint256 sx;
        uint256 sy;
        uint256 n = h.touchedLength();
        for (uint256 i; i < n; i++) {
            (uint128 bx, uint128 by) = pair.getBin(h.touched(i));
            sx += bx;
            sy += by;
        }
        assertEq(sx, pair.reserveX(), "sum bins x");
        assertEq(sy, pair.reserveY(), "sum bins y");
        assertGe(x.balanceOf(address(pair)), uint256(pair.reserveX()) + pair.protocolFeesX());
        assertGe(y.balanceOf(address(pair)), uint256(pair.reserveY()) + pair.protocolFeesY());
    }

    /// Bins above the active bin hold only X, bins below only Y.
    function invariant_singleSided() public view {
        int24 active = pair.getActiveId();
        uint256 n = h.touchedLength();
        for (uint256 i; i < n; i++) {
            int24 id = h.touched(i);
            (uint128 bx, uint128 by) = pair.getBin(id);
            if (id > active) assertEq(by, 0, "Y above the active bin");
            if (id < active) assertEq(bx, 0, "X below the active bin");
        }
    }

    /// Shares: per bin, the LPs' balances sum to totalSupply; a bin has shares iff it has reserves and
    /// is in the bitmap; nobody burns another's shares without approval.
    function invariant_shares() public view {
        uint256 n = h.touchedLength();
        for (uint256 i; i < n; i++) {
            int24 id = h.touched(i);
            uint256 s = pair.balanceOf(h.lps(0), id) + pair.balanceOf(h.lps(1), id);
            assertEq(s, pair.totalSupply(id));
            (uint128 bx, uint128 by) = pair.getBin(id);
            assertEq(s == 0, bx == 0 && by == 0, "shares without reserves (or reverse)");
            if (s != 0) {
                (int24 nb, bool found) = pair.getNextNonEmptyBin(false, id - 1);
                assertTrue(found && nb == id, "bitmap misses a non-empty bin");
            }
        }
        assertEq(h.unauthorizedBurn(), 0);
    }

    /// No free money: a round trip never returns more than it put in.
    function invariant_noRoundTripProfit() public view {
        assertEq(h.roundTripProfit(), 0);
    }
}

// ============================================================================ DlmmMath / DlmmBinTree

contract TreeHarness {
    using DlmmBinTree for DlmmBinTree.Tree;
    DlmmBinTree.Tree t;
    function add(uint256 i) external { t.add(i); }
    function remove(uint256 i) external { t.remove(i); }
    function below(uint256 i) external view returns (uint256) { return t.below(i); }
    function above(uint256 i) external view returns (uint256) { return t.above(i); }
    function contains(uint256 i) external view returns (bool) { return t.contains(i); }
}

contract DlmmMathFuzz is Test {
    /// mulDiv == floor(a*b/d) computed by schoolbook 512-bit long division (reference).
    function testFuzz_mulDivMatchesReference(uint256 a, uint256 b, uint256 d) public pure {
        d = bound(d, 1, type(uint256).max);
        (uint256 hi, uint256 lo) = _mul512(a, b);
        if (hi >= d) return; // result does not fit: mulDiv must revert (checked below)
        assertEq(DlmmMath.mulDiv(a, b, d), _div512(hi, lo, d));
    }

    function testFuzz_mulDivRevertsOnOverflow(uint256 a, uint256 b, uint256 d) public {
        d = bound(d, 1, type(uint256).max);
        (uint256 hi,) = _mul512(a, b);
        if (hi < d) return;
        vm.expectRevert(DlmmMath.MulDivOverflow.selector);
        this.callMulDiv(a, b, d);
    }

    function callMulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return DlmmMath.mulDiv(a, b, d); }

    function testFuzz_mulDivUpIsCeil(uint256 a, uint256 b, uint256 d) public pure {
        d = bound(d, 1, type(uint256).max);
        (uint256 hi, uint256 lo) = _mul512(a, b);
        if (hi >= d) return;
        uint256 down = _div512(hi, lo, d);
        uint256 up = DlmmMath.mulDivUp(a, b, d);
        if (mulmod(a, b, d) == 0) assertEq(up, down);
        else assertEq(up, down + 1);
    }

    /// Prices strictly increase with the bin id; a bin and its mirror multiply to ~1.
    function testFuzz_priceMonotonic(int24 id, uint16 step) public view {
        step = uint16(bound(step, 1, 1000));
        int256 i = bound(int256(id), -20_000, 20_000);
        (bool ok0, uint256 p0) = _price(i, step);
        (bool ok1, uint256 p1) = _price(i + 1, step);
        if (ok0 && ok1) assertGt(p1, p0);
        (bool okm, uint256 pm) = _price(-i, step);
        if (ok0 && okm && p0 < (1 << 200) && pm < (1 << 200)) {
            // p(i) * p(-i) / 2^128 == 2^128 within a relative 1e-9
            uint256 prod = DlmmMath.mulDiv(p0, pm, 1 << 128);
            uint256 one = 1 << 128;
            uint256 diff = prod > one ? prod - one : one - prod;
            assertLe(diff, one / 1e9);
        }
    }

    function _price(int256 id, uint256 step) internal view returns (bool, uint256) {
        try this.price(id, step) returns (uint256 p) { return (true, p); } catch { return (false, 0); }
    }

    function price(int256 id, uint256 step) external pure returns (uint256) { return DlmmMath.getPriceX128(id, step); }

    /// The bitmap's below/above agree with a naive scan of a reference set.
    function testFuzz_binTreeMatchesReference(uint256[8] memory adds, uint256[3] memory rems, uint256 q) public {
        TreeHarness t = new TreeHarness();
        uint256[] memory set = new uint256[](8);
        uint256 n;
        for (uint256 k; k < 8; k++) {
            uint256 v = bound(adds[k], 0, (1 << 24) - 1);
            if (k % 2 == 1) v = bound(adds[k], 0, 1 << 10); // cluster some near each other
            t.add(v);
            bool dup;
            for (uint256 m; m < n; m++) if (set[m] == v) dup = true;
            if (!dup) set[n++] = v;
        }
        for (uint256 k; k < 3; k++) {
            if (n == 0) break;
            uint256 idx = rems[k] % n;
            t.remove(set[idx]);
            set[idx] = set[n - 1];
            n--;
        }
        q = bound(q, 0, (1 << 24) - 1);
        uint256 below = type(uint256).max;
        uint256 above = type(uint256).max;
        for (uint256 m; m < n; m++) {
            uint256 v = set[m];
            if (v < q && (below == type(uint256).max || v > below)) below = v;
            if (v > q && (above == type(uint256).max || v < above)) above = v;
        }
        assertEq(t.below(q), below, "below");
        assertEq(t.above(q), above, "above");
        for (uint256 m; m < n; m++) assertTrue(t.contains(set[m]));
    }

    // ---- 512-bit reference helpers ----
    function _mul512(uint256 a, uint256 b) internal pure returns (uint256 hi, uint256 lo) {
        unchecked {
            lo = a * b;
            uint256 mm = mulmod(a, b, type(uint256).max);
            hi = mm - lo - (mm < lo ? 1 : 0);
        }
    }

    /// floor([hi lo] / d) assuming hi < d (bitwise long division).
    function _div512(uint256 hi, uint256 lo, uint256 d) internal pure returns (uint256 q) {
        uint256 r = hi;
        for (uint256 i; i < 256; i++) {
            bool carry = r >> 255 == 1;
            r = (r << 1) | (lo >> 255);
            lo <<= 1;
            q <<= 1;
            if (carry || r >= d) {
                unchecked { r -= d; }
                q |= 1;
            }
        }
    }
}
