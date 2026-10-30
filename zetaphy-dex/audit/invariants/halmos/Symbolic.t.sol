// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Halmos symbolic checks (functions prefixed check_; forge ignores them).
//   cd zetaphy-dex && halmos --forge-build-out audit/out --contract PairSymbolic
//   cd zetaphy-dex && halmos --forge-build-out audit/out --contract DlmmMathSymbolic
// Status 2026-10-30 (bitwuzla, 300 s per query): all four checks here TIME OUT: 256-bit symbolic
// multiply/divide (and mulDiv's modular inverse) is beyond the solver in that budget, even with
// 40-bit operands. The same properties are covered by the Foundry fuzz/invariant suites
// (Dlmm.inv.t.sol: mulDiv vs. a 512-bit reference; ZetaphyPair.inv.t.sol: k never decreases).
// Kept for longer CI budgets (e.g. --solver-timeout-assertion 0 overnight).

import {Test} from "forge-std/Test.sol";
import {ZetaphyFactory} from "../../../contracts/ZetaphyFactory.sol";
import {ZetaphyPair} from "../../../contracts/ZetaphyPair.sol";
import {DlmmMath} from "../../../contracts/dlmm/DlmmMath.sol";
import {MockERC20} from "../utils/Mocks.sol";

contract PairSymbolic is Test {
    ZetaphyPair pair;
    MockERC20 t0;
    MockERC20 t1;
    address user = address(0xD001);

    function setUp() public {
        ZetaphyFactory f = new ZetaphyFactory(address(this));
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        pair = ZetaphyPair(f.createPair(address(a), address(b)));
        (t0, t1) = pair.token0() == address(a) ? (a, b) : (b, a);
        t0.mint(address(pair), 1e21);
        t1.mint(address(pair), 3e21);
        pair.mint(address(this));
        t0.mint(user, 2 ** 100);
        t1.mint(user, 2 ** 100);
    }

    /// AMM: for ANY input sent and ANY outputs requested, a swap that succeeds leaves
    /// reserve0 * reserve1 at least where it was (the 0.3% fee only adds to k).
    function check_swapNeverDecreasesK(uint96 in0, uint96 in1, uint256 out0, uint256 out1) public {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        vm.startPrank(user);
        t0.transfer(address(pair), in0);
        t1.transfer(address(pair), in1);
        try pair.swap(out0, out1, user, "") {
            (uint112 n0, uint112 n1,) = pair.getReserves();
            assert(uint256(n0) * n1 >= uint256(r0) * r1);
        } catch {}
        vm.stopPrank();
    }

    /// LP accounting: burning ANY amount of LP pays at most the pro-rata share of each reserve.
    function check_burnPaysAtMostShare(uint256 lp) public {
        uint256 have = pair.balanceOf(address(this));
        vm.assume(lp > 0 && lp <= have);
        uint256 supply = pair.totalSupply();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        pair.transfer(address(pair), lp);
        try pair.burn(user) returns (uint256 a0, uint256 a1) {
            assert(a0 * supply <= uint256(r0) * lp);
            assert(a1 * supply <= uint256(r1) * lp);
        } catch {}
    }
}

contract DlmmMathSymbolic is Test {
    /// mulDiv is exact floor(a*b/d) whenever a*b fits in 256 bits.
    function check_mulDivExactWhenNoOverflow(uint128 a, uint128 b, uint256 d) public pure {
        vm.assume(d != 0);
        uint256 r = DlmmMath.mulDiv(a, b, d);
        assert(r == (uint256(a) * b) / d);
    }

    /// The pair's in-bin conversions round in the pool's favour: X -> Y -> X never gains.
    function check_priceRoundTripFavoursPool(uint128 amount, uint256 priceX128) public pure {
        vm.assume(priceX128 >= DlmmMath.MIN_PRICE_X128 && priceX128 <= DlmmMath.MAX_PRICE_X128);
        uint256 y = DlmmMath.mulPriceDown(amount, priceX128);
        vm.assume(y < 2 ** 128);
        uint256 back = DlmmMath.divPriceDown(y, priceX128);
        assert(back <= amount);
        assert(DlmmMath.mulPriceUp(amount, priceX128) >= y);
    }
}
