// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Saphan PR 6, item S2: Halmos symbolic checks of the bridge core (functions check_*; forge ignores them, the
// testFuzz_ twins below run in every forge run). From zetaphy-network/:
//   halmos --forge-build-out audit/out --contract SaphanSymbolic --solver bitwuzla
// Inputs are symbolic: a pass is a proof for ALL values in range (or halmos prints a counterexample).

import {Test} from "forge-std/Test.sol";
import {HyperlaneLockBoxV2, ISaphanMailbox, ISaphanIsm} from "../../../contracts/HyperlaneLockBoxV2.sol";
import {MockMailbox} from "../../../contracts/MockMailbox.sol";
import {SaphanRecoveryClaims} from "../../../contracts/SaphanRecovery.sol";

contract SaphanSymbolic is Test {
    HyperlaneLockBoxV2 box;
    MockMailbox mailbox;
    address gov = address(0x60F);
    address remote = address(0x0B0B);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 constant LIMIT = 100 ether;

    function setUp() public {
        vm.warp(1_700_000_000);
        mailbox = new MockMailbox(11155111);
        box = new HyperlaneLockBoxV2(ISaphanMailbox(address(mailbox)), 77390, 77390, bytes32(uint256(0x1A)), bytes32(uint256(uint160(remote))),
            address(0), ISaphanIsm(address(0x15A)), gov, address(0), LIMIT, 1 hours);
    }

    function _body(uint256 n, address to, uint256 amount) internal view returns (bytes memory) {
        return abi.encode(uint256(77390), remote, n, alice, to, amount, block.chainid, address(box));
    }

    function _deliver(bytes memory b) internal returns (bool ok) {
        vm.prank(address(mailbox));
        try box.handle(77390, bytes32(uint256(uint160(remote))), b) { ok = true; } catch {}
    }

    /// For ANY two locks and ANY two release messages (amounts and receivers), whatever is claimed, in one day:
    /// the lockbox pays at most what was locked, at most the daily limit, holds exactly `locked`, and each release
    /// pays once.
    function check_releaseNeverExceedsLockedOrLimit(uint96 l1, uint96 l2, uint96 r1, uint96 r2) public {
        vm.assume(l1 > 0 && l2 > 0 && r1 > 0 && r2 > 0);
        vm.deal(alice, uint256(l1) + l2);
        vm.startPrank(alice);
        box.lock{value: l1}(alice, l1);
        box.lock{value: l2}(alice, l2);
        vm.stopPrank();
        bytes memory b1 = _body(0, bob, r1);
        bytes memory b2 = _body(1, bob, r2);
        assert(_deliver(b1));
        assert(_deliver(b2));
        assert(!_deliver(b1));                       // a second delivery of the same body is refused
        vm.warp(block.timestamp + 1 hours);
        uint256 before = bob.balance;
        try box.claim(keccak256(b1)) {} catch {}
        try box.claim(keccak256(b2)) {} catch {}
        try box.claim(keccak256(b1)) {} catch {}     // a second claim pays nothing
        uint256 got = bob.balance - before;
        assert(got <= uint256(l1) + l2);
        assert(got <= LIMIT);
        assert(got == 0 || got == r1 || got == r2 || got == uint256(r1) + r2);
        assert(address(box).balance == box.locked());
        assert(box.locked() == uint256(l1) + l2 - got);
    }

    /// For ANY pool, total and two lines that fit in the total: the recovery claims (the escape hatch's pro rata rule)
    /// never pay out more than the pool. 32-bit amounts for the solver (the 96-bit statement times out at 600 s with
    /// the default solver: owed * pool / total is non-linear); testFuzz_ below samples the 96-bit range.
    function check_recoveryProRataNeverExceedsPool(uint32 pool, uint32 total, uint32 o1, uint32 o2) public {
        _proRata(pool, total, o1, o2);
    }

    function _proRata(uint256 pool, uint256 total, uint256 o1, uint256 o2) internal {
        vm.assume(total > 0 && o1 + o2 <= total);
        SaphanRecoveryClaims k = new SaphanRecoveryClaims(gov, address(0), gov, 7 days);
        vm.deal(address(k), pool);
        vm.prank(gov);
        k.start(bytes32(uint256(1)), total);
        assert(k.payout(o1) + k.payout(o2) <= pool);
        assert(k.payout(o1) <= o1);
    }

    // ---- the same statements, fuzzed by forge on every run

    function testFuzz_releaseNeverExceedsLockedOrLimit(uint96 l1, uint96 l2, uint96 r1, uint96 r2) public {
        l1 = uint96(bound(l1, 1, type(uint96).max)); l2 = uint96(bound(l2, 1, type(uint96).max));
        r1 = uint96(bound(r1, 1, type(uint96).max)); r2 = uint96(bound(r2, 1, type(uint96).max));
        check_releaseNeverExceedsLockedOrLimit(l1, l2, r1, r2);
    }

    function testFuzz_recoveryProRataNeverExceedsPool(uint96 pool, uint96 total, uint96 o1, uint96 o2) public {
        total = uint96(bound(total, 1, type(uint96).max));
        o1 = uint96(bound(o1, 0, total));
        o2 = uint96(bound(o2, 0, total - o1));
        _proRata(pool, total, o1, o2);
    }
}
