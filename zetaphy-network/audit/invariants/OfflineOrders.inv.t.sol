// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyOfflineOrders} from "../../contracts/ZetaphyOfflineOrders.sol";
import {ZetaphyFactory} from "zetaphy-dex/ZetaphyFactory.sol";
import {ZetaphyRouter} from "zetaphy-dex/ZetaphyRouter.sol";
import {WZETAPHY} from "zetaphy-dex/WZETAPHY.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// Fills signed offline orders through the real ZETAPHY Swap router and pairs.
contract OrdersHandler is Test {
    ZetaphyOfflineOrders public oo;
    ZetaphyRouter public router;
    MockERC20 public a;
    MockERC20 public b;
    WZETAPHY public wz;
    uint256[2] public makerKeys = [uint256(0xAA01), uint256(0xAA02)];
    address public relayer = address(0x7E1A);

    mapping(address => mapping(uint256 => uint256)) public fills;     // maker -> nonce -> fills
    mapping(address => mapping(uint256 => bool)) public cancelledByMaker;
    uint256 public doubleFill;
    uint256 public cancelledFilled;
    uint256 public makerShort;      // maker got < minAmountOut, or paid != amountIn
    uint256 public relayerOverpaid; // relayer got more than relayerFee

    constructor(ZetaphyOfflineOrders o, ZetaphyRouter r, MockERC20 a_, MockERC20 b_, WZETAPHY w) {
        (oo, router, a, b, wz) = (o, r, a_, b_, w);
        for (uint256 i; i < 2; i++) {
            address m = vm.addr(makerKeys[i]);
            a.mint(m, 1e30);
            b.mint(m, 1e30);
            vm.startPrank(m);
            a.approve(address(o), type(uint256).max);
            b.approve(address(o), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _sign(uint256 k, ZetaphyOfflineOrders.Order memory o) internal view returns (bytes memory) {
        (bool ok, bytes memory r) = address(oo).staticcall(abi.encodeCall(ZetaphyOfflineOrders.digest, (o)));
        require(ok);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(k, abi.decode(r, (bytes32)));
        return abi.encodePacked(rr, s, v);
    }

    struct Bal { uint256 makerIn; uint256 makerOut; uint256 relayerOut; }

    function _outBal(address tokenOut, address who) internal view returns (uint256) {
        return tokenOut == address(0) ? who.balance : MockERC20(tokenOut).balanceOf(who);
    }

    function _order(uint256 mk, uint256 nonce, uint256 amountIn, uint256 minOut, uint256 fee, uint8 kind)
        internal view returns (ZetaphyOfflineOrders.Order memory o)
    {
        kind = kind % 3; // 0: A->B, 1: B->A, 2: A->native
        o.maker = vm.addr(makerKeys[mk % 2]);
        o.tokenIn = kind == 1 ? address(b) : address(a);
        o.tokenOut = kind == 0 ? address(b) : kind == 1 ? address(a) : address(0);
        o.amountIn = bound(amountIn, 1e6, 1e21);
        o.minAmountOut = bound(minOut, 0, 2e21);
        o.deadline = block.timestamp + 1 hours;
        o.nonce = bound(nonce, 0, 600);
        o.relayerFee = bound(fee, 0, 1e18);
    }

    function fill(uint256 mk, uint256 nonce, uint256 amountIn, uint256 minOut, uint256 fee, uint8 kind) external {
        ZetaphyOfflineOrders.Order memory o = _order(mk, nonce, amountIn, minOut, fee, kind);
        bytes memory sig = _sign(makerKeys[mk % 2], o);
        bool wasUsed = oo.isNonceUsed(o.maker, o.nonce);
        Bal memory before = Bal(MockERC20(o.tokenIn).balanceOf(o.maker), _outBal(o.tokenOut, o.maker), _outBal(o.tokenOut, relayer));
        vm.prank(relayer);
        try oo.fill(o, sig, new address[](0)) returns (uint256 toMaker) {
            _check(o, before, wasUsed, toMaker);
        } catch {}
    }

    function _check(ZetaphyOfflineOrders.Order memory o, Bal memory before, bool wasUsed, uint256 toMaker) internal {
        fills[o.maker][o.nonce]++;
        if (wasUsed || fills[o.maker][o.nonce] > 1) doubleFill++;
        if (cancelledByMaker[o.maker][o.nonce]) cancelledFilled++;
        if (before.makerIn - MockERC20(o.tokenIn).balanceOf(o.maker) != o.amountIn) makerShort++;
        uint256 got = _outBal(o.tokenOut, o.maker) - before.makerOut;
        if (got < o.minAmountOut || got != toMaker) makerShort++;
        if (_outBal(o.tokenOut, relayer) - before.relayerOut > o.relayerFee) relayerOverpaid++;
    }

    function cancel(uint256 mk, uint256 nonce) external {
        address maker = vm.addr(makerKeys[mk % 2]);
        nonce = bound(nonce, 0, 600);
        vm.prank(maker);
        oo.cancel(nonce);
        cancelledByMaker[maker][nonce] = true;
    }

    /// A relayer replays a filled order.
    function replay(uint256 mk, uint256 nonce) external {
        this.fill(mk, nonce, 1e18, 0, 0, 0);
    }
}

contract OfflineOrdersInvariants is Test {
    ZetaphyOfflineOrders oo;
    OrdersHandler h;
    MockERC20 a;
    MockERC20 b;
    WZETAPHY wz;

    function setUp() public {
        vm.warp(1_700_000_000);
        ZetaphyFactory f = new ZetaphyFactory(address(this));
        wz = new WZETAPHY();
        ZetaphyRouter r = new ZetaphyRouter(address(f), address(wz));
        a = new MockERC20("A", "A", 18);
        b = new MockERC20("B", "B", 18);
        a.mint(address(this), 1e30);
        b.mint(address(this), 1e30);
        a.approve(address(r), type(uint256).max);
        b.approve(address(r), type(uint256).max);
        r.addLiquidity(address(a), address(b), 1e24, 2e24, 0, 0, address(this), block.timestamp);
        vm.deal(address(this), 1e24);
        r.addLiquidityETH{value: 1e23}(address(a), 1e24, 0, 0, address(this), block.timestamp);
        oo = new ZetaphyOfflineOrders(address(r));
        h = new OrdersHandler(oo, r, a, b, wz);
        targetContract(address(h));
    }

    /// The contract never keeps anything between calls (no residue, no allowance left to the router).
    function invariant_noResidue() public view {
        assertEq(a.balanceOf(address(oo)), 0);
        assertEq(b.balanceOf(address(oo)), 0);
        assertEq(wz.balanceOf(address(oo)), 0);
        assertEq(address(oo).balance, 0);
        assertEq(a.allowance(address(oo), address(oo.router())), 0);
    }

    /// One fill per nonce, never a cancelled nonce; the maker pays exactly amountIn and gets at least
    /// minAmountOut; the relayer gets at most its fee.
    function invariant_fillRules() public view {
        assertEq(h.doubleFill(), 0);
        assertEq(h.cancelledFilled(), 0);
        assertEq(h.makerShort(), 0);
        assertEq(h.relayerOverpaid(), 0);
    }

    function test_handlerFills() public {
        h.fill(0, 1, 1e18, 0, 1e15, 0);
        h.fill(0, 2, 1e18, 0, 1e15, 2);
        assertEq(h.fills(vm.addr(h.makerKeys(0)), 1), 1);
        assertEq(h.fills(vm.addr(h.makerKeys(0)), 2), 1);
    }
}
