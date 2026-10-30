// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyCheques} from "../../contracts/ZetaphyCheques.sol";
import {ZetaphyEarlyFarm} from "../../contracts/ZetaphyEarlyFarm.sol";
import {ZetaphyEarly} from "../../contracts/ZetaphyEarly.sol";
import {HyperlaneLockBoxV2, ISaphanMailbox, ISaphanIsm} from "../../contracts/HyperlaneLockBoxV2.sol";
import {MockMailbox} from "../../contracts/MockMailbox.sol";
import {ComputeMarket, IRunnersView} from "../../contracts/ComputeMarket.sol";
import {MockERC20, MockRunners} from "./utils/Mocks.sol";

/// A token hook / native receiver that tries to call back into the contract under test, and records
/// whether the nested call got through.
contract Reenterer {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentered;   // the nested call succeeded
    bool public attempted;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function _try() internal {
        if (!armed) return;
        armed = false;
        attempted = true;
        (bool ok,) = target.call(payload);
        if (ok) reentered = true;
    }

    function onTokenTransfer(address, address, uint256) external { _try(); }
    receive() external payable { _try(); }

    function call(address to, uint256 value, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory r) = to.call{value: value}(data);
        require(ok, "call failed");
        return r;
    }
}

contract ReentrancyTests is Test {
    /// ZetaphyCheques: an ERC-777-style token hook fires inside cash(); re-entering cash() with a higher
    /// cheque, or withdraw(), is refused (nonReentrant), and the books stay exact.
    function test_cheques_tokenHookCannotReenter() public {
        ZetaphyCheques c = new ZetaphyCheques();
        MockERC20 t = new MockERC20("H", "H", 18);
        Reenterer r = new Reenterer();
        address payer = address(0xA1);
        address payee = address(0xB1);
        uint256 key = 0x51;
        t.mint(payer, 100 ether);
        vm.startPrank(payer);
        t.approve(address(c), type(uint256).max);
        uint256 id = c.open(payee, address(t), 100 ether, uint64(block.timestamp + 1 days), vm.addr(key));
        vm.stopPrank();
        t.setHook(address(r));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(key, c.chequeDigest(id, 30 ether));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(key, c.chequeDigest(id, 90 ether));
        r.arm(address(c), abi.encodeCall(ZetaphyCheques.cash, (id, 90 ether, abi.encodePacked(r2, s2, v2))));
        c.cash(id, 30 ether, abi.encodePacked(r1, s1, v1));
        assertTrue(r.attempted());
        assertFalse(r.reentered(), "nested cash got through");
        assertEq(t.balanceOf(payee), 30 ether);
        assertEq(t.balanceOf(address(c)), 70 ether);
    }

    /// ZetaphyEarlyFarm: a hooked LP token fires on withdraw(); re-entering withdraw() is refused.
    function test_farm_lpHookCannotReenterWithdraw() public {
        ZetaphyEarly z = new ZetaphyEarly(address(this));
        MockERC20 lp = new MockERC20("LP", "LP", 18);
        ZetaphyEarlyFarm farm = new ZetaphyEarlyFarm(address(lp), address(z), address(this));
        Reenterer r = new Reenterer();
        lp.mint(address(r), 10 ether);
        r.call(address(lp), 0, abi.encodeCall(MockERC20.approve, (address(farm), type(uint256).max)));
        r.call(address(farm), 0, abi.encodeCall(ZetaphyEarlyFarm.stake, (10 ether)));
        lp.setHook(address(r));
        r.arm(address(farm), abi.encodeCall(ZetaphyEarlyFarm.withdraw, (5 ether)));
        r.call(address(farm), 0, abi.encodeCall(ZetaphyEarlyFarm.withdraw, (5 ether)));
        assertTrue(r.attempted());
        assertFalse(r.reentered());
        assertEq(farm.totalSupply(), 5 ether);
        assertEq(lp.balanceOf(address(farm)), 5 ether);
    }

    /// HyperlaneLockBoxV2: the receiver of a claim re-enters claim() for the same release; refused
    /// (claimed is set before the payment), the backing stays exact.
    function test_lockbox_receiverCannotDoubleClaim() public {
        vm.warp(1_700_000_000);
        MockMailbox mb = new MockMailbox(1);
        bytes32 remote = bytes32(uint256(0x0B0B));
        HyperlaneLockBoxV2 box = new HyperlaneLockBoxV2(ISaphanMailbox(address(mb)), 77390, 77390, bytes32(uint256(1)), remote,
            address(0), ISaphanIsm(address(0x15A)), address(this), address(0), 1000 ether, 0);
        vm.deal(address(this), 100 ether);
        box.lock{value: 100 ether}(address(0xD1), 100 ether);
        Reenterer r = new Reenterer();
        bytes memory body = abi.encode(uint256(77390), address(uint160(uint256(remote))), uint256(0), address(1), address(r), uint256(10 ether),
            block.chainid, address(box));
        vm.prank(address(mb));
        box.handle(77390, remote, body);
        bytes32 id = keccak256(body);
        r.arm(address(box), abi.encodeCall(HyperlaneLockBoxV2.claim, (id)));
        box.claim(id);
        assertTrue(r.attempted());
        assertFalse(r.reentered());
        assertEq(address(r).balance, 10 ether);
        assertEq(address(box).balance, box.locked());
    }

    /// ComputeMarket.withdraw (CEI, no lock): a re-entering receiver finds its credit already zero.
    function test_compute_withdrawReentryGetsNothing() public {
        MockRunners rn = new MockRunners();
        ComputeMarket m = new ComputeMarket(IRunnersView(address(rn)), 0);
        Reenterer r = new Reenterer();
        vm.deal(address(r), 5 ether);
        r.call(address(m), 5 ether, abi.encodeCall(ComputeMarket.request, ("m", bytes32(0), "", 1 hours)));
        r.call(address(m), 0, abi.encodeCall(ComputeMarket.cancel, (0)));
        r.arm(address(m), abi.encodeCall(ComputeMarket.withdraw, ()));
        r.call(address(m), 0, abi.encodeCall(ComputeMarket.withdraw, ()));
        assertTrue(r.attempted());
        assertFalse(r.reentered());
        assertEq(address(r).balance, 5 ether);
        assertEq(address(m).balance, 0);
    }
}
