// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {EchidnaCheques, EchidnaIssuance, EchidnaCompute, EchidnaLockBox, EchidnaMultisig} from "./EchidnaHarnesses.sol";

/// The Echidna/Medusa harnesses deploy and their properties hold at start (run by forge, so a broken
/// harness is caught even where Echidna is not installed).
contract EchidnaHarnessesSmoke is Test {
    function test_harnessesDeployAndHold() public {
        EchidnaCheques a = new EchidnaCheques();
        assertTrue(a.echidna_conservation() && a.echidna_noOverpay() && a.echidna_payerOnly());
        a.open(0, 0, true, 1 ether, 1 days, 0);
        a.cash(0, 0.4 ether);
        assertTrue(a.echidna_conservation());

        EchidnaIssuance b = new EchidnaIssuance();
        assertTrue(address(b.sinks(0)) != address(0) && address(b.overflowTo()) != address(0));
        assertEq(b.iss().buckets().length, 2);
        b.fund(10 ether);
        b.draw(0, 1 ether);
        assertTrue(b.echidna_accounting());

        EchidnaCompute c = new EchidnaCompute();
        c.request(0, 1 ether, 1 hours);
        c.take(0, 0);
        assertTrue(c.echidna_escrow());

        EchidnaLockBox d = new EchidnaLockBox();
        assertTrue(address(d.mailbox()) != address(0));
        d.lock(0, 1 ether);
        assertTrue(d.echidna_backing() && d.echidna_claimRules());

        EchidnaMultisig e = new EchidnaMultisig();
        assertTrue(e.echidna_executeNeedsCurrentOwnersQuorum());
    }
}
