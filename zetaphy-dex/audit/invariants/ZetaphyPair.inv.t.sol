// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyFactory} from "../../contracts/ZetaphyFactory.sol";
import {ZetaphyRouter} from "../../contracts/ZetaphyRouter.sol";
import {ZetaphyPair} from "../../contracts/ZetaphyPair.sol";
import {WZETAPHY} from "../../contracts/WZETAPHY.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// A flash-swap borrower that pays back `payBack` (in token0) from its own balance.
contract FlashBorrower {
    uint256 public payBack;
    address public tokenBack;
    function set(address t, uint256 p) external { (tokenBack, payBack) = (t, p); }
    function zetaphyDexCall(address, uint256, uint256, bytes calldata) external {
        if (payBack != 0) MockERC20(tokenBack).transfer(msg.sender, payBack);
    }
}

contract PairHandler is Test {
    ZetaphyFactory public f;
    ZetaphyRouter public r;
    ZetaphyPair public pair;
    MockERC20 public a;
    MockERC20 public b;
    FlashBorrower public fb;
    address public gov;
    address[3] public users = [address(0xD001), address(0xD002), address(0xD003)];
    address public feeTo = address(0xFEE);

    uint256 public kDecreasedOnSwap;      // a swap that left reserve0 * reserve1 lower
    uint256 public shareValueDropped;     // sqrt(k) / totalSupply went down (any action)
    uint256 public lastK;
    uint256 public lastS;

    constructor(ZetaphyFactory f_, ZetaphyRouter r_, ZetaphyPair p, MockERC20 a_, MockERC20 b_, address gov_) {
        (f, r, pair, a, b, gov) = (f_, r_, p, a_, b_, gov_);
        fb = new FlashBorrower();
        a.mint(address(fb), 1e30);
        b.mint(address(fb), 1e30);
        for (uint256 i; i < 3; i++) {
            a.mint(users[i], 1e30);
            b.mint(users[i], 1e30);
            vm.startPrank(users[i]);
            a.approve(address(r), type(uint256).max);
            b.approve(address(r), type(uint256).max);
            pair.approve(address(r), type(uint256).max);
            vm.stopPrank();
        }
        _snap();
    }

    function _k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * r1;
    }

    /// totalSupply plus the LP the protocol fee would mint now (ZetaphyPair._mintFee): that part of the
    /// growth belongs to feeTo, so a share's value is measured against this effective supply.
    function _effectiveSupply() internal view returns (uint256 s) {
        s = pair.totalSupply();
        uint256 kl = pair.kLast();
        if (f.feeTo() == address(0) || kl == 0) return s;
        uint256 rootK = _sqrt(_k());
        uint256 rootKLast = _sqrt(kl);
        if (rootK > rootKLast) s += (s * (rootK - rootKLast)) / (rootK * 5 + rootKLast);
    }

    function _snap() internal {
        lastK = _k();
        lastS = _effectiveSupply();
    }

    /// value per LP share must not go down: k/S^2 >= lastK/lastS^2 (cross-multiplied, 1 wei-share slack
    /// for the burn rounding which favours the pool).
    function _checkShareValue() internal {
        uint256 k = _k();
        uint256 s = _effectiveSupply();
        if (lastS != 0 && s != 0 && lastK != 0) {
            // compare sqrt(k)/s with sqrt(lastK)/lastS using sqrt to stay in range
            uint256 lhs = _sqrt(k) * lastS;
            uint256 rhs = _sqrt(lastK) * s;
            if (lhs + lastS + s < rhs) shareValueDropped++;
        }
        _snap();
    }

    function swap(uint256 u, uint256 amountIn, bool aToB) external {
        address[] memory path = new address[](2);
        (path[0], path[1]) = aToB ? (address(a), address(b)) : (address(b), address(a));
        uint256 k0 = _k();
        vm.prank(users[u % 3]);
        try r.swapExactTokensForTokens(bound(amountIn, 1, 1e24), 0, path, users[u % 3], block.timestamp) {
            if (_k() < k0) kDecreasedOnSwap++;
        } catch {}
        _checkShareValue();
    }

    function swapExactOut(uint256 u, uint256 amountOut, bool aToB) external {
        address[] memory path = new address[](2);
        (path[0], path[1]) = aToB ? (address(a), address(b)) : (address(b), address(a));
        uint256 k0 = _k();
        vm.prank(users[u % 3]);
        try r.swapTokensForExactTokens(bound(amountOut, 1, 1e23), type(uint256).max, path, users[u % 3], block.timestamp) {
            if (_k() < k0) kDecreasedOnSwap++;
        } catch {}
        _checkShareValue();
    }

    /// A flash swap that pays back `back` of token0 (maybe too little): only a k-preserving one passes.
    function flash(uint256 out0, uint256 back) external {
        (uint112 r0,,) = pair.getReserves();
        if (r0 < 2) return;
        out0 = bound(out0, 1, r0 - 1);
        fb.set(pair.token0(), bound(back, 0, out0 * 2));
        uint256 k0 = _k();
        try pair.swap(out0, 0, address(fb), hex"01") {
            if (_k() < k0) kDecreasedOnSwap++;
        } catch {}
        _checkShareValue();
    }

    function add(uint256 u, uint256 x, uint256 y) external {
        vm.prank(users[u % 3]);
        try r.addLiquidity(address(a), address(b), bound(x, 1e3, 1e24), bound(y, 1e3, 1e24), 0, 0, users[u % 3], block.timestamp) {} catch {}
        _checkShareValue();
    }

    function remove(uint256 u, uint256 l) external {
        address who = users[u % 3];
        uint256 have = pair.balanceOf(who);
        if (have == 0) return;
        vm.prank(who);
        try r.removeLiquidity(address(a), address(b), bound(l, 1, have), 0, 0, who, block.timestamp) {} catch {}
        _checkShareValue();
    }

    function donateAndSync(uint256 x, bool skim) external {
        a.mint(address(pair), bound(x, 0, 1e22));
        if (skim) pair.skim(address(0x5C1));
        else pair.sync();
        _checkShareValue();
    }

    function toggleFee(bool on) external {
        vm.prank(gov);
        f.setFeeTo(on ? feeTo : address(0));
        _snap(); // the switch itself moves value between LPs and feeTo (by design): re-baseline
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 1 days)); }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) z = 1;
    }
}

contract ZetaphyPairInvariants is Test {
    ZetaphyFactory f;
    ZetaphyRouter r;
    ZetaphyPair pair;
    MockERC20 a;
    MockERC20 b;
    PairHandler h;
    address gov = address(0x60F);

    function setUp() public {
        vm.warp(1_700_000_000);
        f = new ZetaphyFactory(gov);
        r = new ZetaphyRouter(address(f), address(new WZETAPHY()));
        a = new MockERC20("A", "A", 18);
        b = new MockERC20("B", "B", 18);
        a.mint(address(this), 1e30);
        b.mint(address(this), 1e30);
        a.approve(address(r), type(uint256).max);
        b.approve(address(r), type(uint256).max);
        r.addLiquidity(address(a), address(b), 1e22, 3e22, 0, 0, address(this), block.timestamp);
        pair = ZetaphyPair(f.getPair(address(a), address(b)));
        h = new PairHandler(f, r, pair, a, b, gov);
        targetContract(address(h));
    }

    /// Constant product: no swap (router or flash) ever lowers reserve0 * reserve1.
    function invariant_kNeverDecreasesOnSwap() public view {
        assertEq(h.kDecreasedOnSwap(), 0);
    }

    /// LP share accounting: the value of one LP share (sqrt(k) / totalSupply) never goes down.
    function invariant_shareValueNonDecreasing() public view {
        assertEq(h.shareValueDropped(), 0);
    }

    /// Reserves are backed; LP balances sum to totalSupply; MINIMUM_LIQUIDITY stays locked; the router keeps nothing.
    function invariant_accounting() public view {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertLe(uint256(r0), MockERC20(pair.token0()).balanceOf(address(pair)));
        assertLe(uint256(r1), MockERC20(pair.token1()).balanceOf(address(pair)));
        uint256 s = pair.balanceOf(address(this)) + pair.balanceOf(address(0)) + pair.balanceOf(h.feeTo()) + pair.balanceOf(address(pair));
        for (uint256 i; i < 3; i++) s += pair.balanceOf(h.users(i));
        assertEq(s, pair.totalSupply());
        assertEq(pair.balanceOf(address(0)), pair.MINIMUM_LIQUIDITY());
        assertEq(a.balanceOf(address(r)), 0);
        assertEq(b.balanceOf(address(r)), 0);
        assertEq(address(r).balance, 0);
    }
}
