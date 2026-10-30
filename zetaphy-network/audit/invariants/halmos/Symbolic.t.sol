// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Halmos symbolic checks (functions prefixed check_; forge ignores them). From zetaphy-network/:
//   halmos --forge-build-out audit/out --contract RewardVaultSymbolic --loop 12
//   halmos --forge-build-out audit/out --contract ChequesSymbolic
// Inputs marked symbolic are proven for ALL values in range (or halmos prints a counterexample),
// unlike the fuzzers, which sample.
// Status 2026-10-30: ChequesSymbolic PASSES (66 paths, 4 s). RewardVaultSymbolic TIMES OUT (991 s with
// the default solver; > 28 min with bitwuzla at 600 s per query): the 256-bit products bal * z / RAY
// are the bottleneck. Run it overnight with --solver-timeout-assertion 0.

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../../../contracts/RewardVault.sol";
import {ZetaphyCheques} from "../../../contracts/ZetaphyCheques.sol";

contract RewardVaultSymbolic is Test {
    RewardVault v;

    function setUp() public {
        RewardVault.Share[] memory s = new RewardVault.Share[](1);
        s[0] = RewardVault.Share(address(0xBEEF), 10_000, false);
        v = new RewardVault(address(this), s);
    }

    /// For ANY balance up to 10^30 wei (1e12 ZETAPHY), one release after n days without a release pays
    /// at most 10% of the balance (+ a rounding allowance of bal/1e20 + 2 wei), for n on a grid that
    /// includes n = 365 (the worst case within a year: the payout grows with n, asserted along the grid
    /// and fuzzed in Governance.inv.t.sol). The day count is concrete per step: with a symbolic one the
    /// solver has to reason through the division and the bit loop of _rpow, and did not finish in
    /// 20 minutes here. The balance is fully symbolic.
    function check_releaseAtMost10PercentPerYear(uint256 bal) public {
        vm.assume(bal <= 1e30);
        vm.deal(address(v), bal);
        v.release(); // checkpoint: the balance vests from now (coins that bypass receive() wait for one, RV-1)
        uint16[7] memory grid = [uint16(1), 7, 30, 91, 182, 364, 365];
        uint256 t0 = block.timestamp;
        uint256 prev;
        for (uint256 i; i < grid.length; i++) {
            vm.warp(t0 + uint256(grid[i]) * 1 days);
            uint256 amount = v.releasable();
            assert(amount <= bal / 10 + bal / 1e20 + 2);
            assert(amount >= prev); // monotone along the grid
            prev = amount;
        }
    }
}

contract ChequesSymbolic is Test {
    ZetaphyCheques c;
    address payer = address(0xA1);
    address payee = address(0xB1);
    address signer = address(0x5160);

    function setUp() public {
        c = new ZetaphyCheques();
    }

    /// For any deposit and any two cheques (any cumulative amounts, any signatures the contract
    /// accepts: halmos models ecrecover as an uninterpreted function, so "the signature is valid" is
    /// itself a free choice), the payee never receives more than the deposit and the contract keeps
    /// exactly deposit - paid.
    function check_chequesNeverPayMoreThanDeposit(uint128 deposit, uint256 c1, uint256 c2, bytes32 r1, bytes32 s1, bytes32 r2, bytes32 s2) public {
        vm.assume(deposit > 0);
        vm.deal(payer, deposit);
        vm.prank(payer);
        uint256 id = c.open{value: deposit}(payee, address(0), deposit, uint64(block.timestamp + 1 days), signer);
        uint256 before = payee.balance;
        try c.cash(id, c1, abi.encodePacked(r1, s1, uint8(27))) {} catch {}
        try c.cash(id, c2, abi.encodePacked(r2, s2, uint8(28))) {} catch {}
        uint256 got = payee.balance - before;
        assert(got <= deposit);
        (,,,,,,, uint256 paid,) = c.channels(id);
        assert(got == paid);
        assert(address(c).balance == uint256(deposit) - paid);
    }
}
