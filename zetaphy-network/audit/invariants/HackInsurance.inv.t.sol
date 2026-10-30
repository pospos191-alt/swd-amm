// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HackInsurance, IHIRunners} from "../../contracts/HackInsurance.sol";
import {MockRunners} from "./utils/Mocks.sol";

/// The public getters return all-static structs: decode them whole (avoids stack-too-deep tuples).
library HI {
    function claim(HackInsurance ins, uint256 id) internal view returns (HackInsurance.Claim memory k) {
        (bool ok, bytes memory r) = address(ins).staticcall(abi.encodeCall(ins.claims, (id)));
        require(ok);
        k = abi.decode(r, (HackInsurance.Claim));
    }

    function cover(HackInsurance ins, uint256 id) internal view returns (HackInsurance.Cover memory c) {
        (bool ok, bytes memory r) = address(ins).staticcall(abi.encodeCall(ins.covers, (id)));
        require(ok);
        c = abi.decode(r, (HackInsurance.Cover));
    }
}

contract InsuranceHandler is Test {
    HackInsurance public ins;
    MockRunners public runners;
    address public gov;
    bytes32 public target;
    address[3] public lps = [address(0xE1), address(0xE2), address(0xE3)];
    address[2] public holders = [address(0xF1), address(0xF2)];
    address[3] public rs = [address(0x71), address(0x72), address(0x73)];
    address public disputer = address(0xD15);

    uint256 public ghostPaidOutTwice;     // a cover whose claim reached Paid twice
    uint256 public ghostOverpaid;         // a claim paid more than its entitlement / loss / cover amount
    uint256 public ghostZeroPayouts;      // a payout that paid nothing while something was still owed (HI-1)
    uint256 public ghostFledOpenClaim;    // a withdrawal executed while a claim was open (HI-2)
    mapping(uint256 => bool) public coverPaid;
    mapping(uint256 => uint256) public paidTo;

    constructor(HackInsurance i, MockRunners r, address g, bytes32 t) {
        ins = i;
        runners = r;
        gov = g;
        target = t;
        for (uint256 k; k < 3; k++) vm.deal(lps[k], 1e30);
        for (uint256 k; k < 2; k++) vm.deal(holders[k], 1e30);
        vm.deal(disputer, 1e30);
    }

    function deposit(uint256 who, uint256 amount) external {
        vm.prank(lps[who % 3]);
        try ins.deposit{value: bound(amount, 1, 1000 ether)}() {} catch {}
    }

    function requestWithdraw(uint256 who, uint256 s) external {
        address lp = lps[who % 3];
        uint256 have = ins.shares(lp);
        if (have == 0) return;
        vm.prank(lp);
        ins.requestWithdraw(bound(s, 1, have));
    }

    function withdraw(uint256 who) external {
        uint256 open = ins.openClaims();
        vm.prank(lps[who % 3]);
        try ins.withdraw() {
            if (open != 0) ghostFledOpenClaim++;
        } catch {}
    }

    function buyCover(uint256 who, uint256 amount, uint256 dur) external {
        amount = bound(amount, 1 ether, 500 ether);
        dur = bound(dur, 1 days, 365 days);
        uint256 premium = ins.premiumOf(uint128(amount), uint64(dur));
        vm.prank(holders[who % 2]);
        try ins.buyCover{value: premium + 1}(target, uint128(amount), uint64(dur)) {} catch {}
    }

    function fileClaim(uint256 coverSeed, uint256 loss) external {
        uint256 n = ins.coverCount();
        if (n == 0) return;
        uint256 id = coverSeed % n;
        address holder = HI.cover(ins, id).holder;
        vm.roll(block.number + 2);
        bytes32[] memory txs = new bytes32[](1);
        txs[0] = keccak256(abi.encode(id, loss));
        uint256 bond = ins.claimBond();
        vm.prank(holder);
        try ins.fileClaim{value: bond}(id, txs, uint64(block.number - 1), uint64(block.number - 1), keccak256("report"),
            uint128(bound(loss, 1, 1000 ether)), "") {} catch {}
    }

    function vote(uint256 claimSeed, uint256 runnerSeed, bool approve) external {
        uint256 n = ins.claimCount();
        if (n == 0) return;
        uint256 id = claimSeed % n;
        uint128 loss = HI.claim(ins, id).loss;
        vm.prank(rs[runnerSeed % 3]);
        try ins.vote(id, approve, keccak256("report"), loss) {} catch {}
    }

    function expire(uint256 claimSeed) external {
        uint256 n = ins.claimCount();
        if (n == 0) return;
        try ins.expire(claimSeed % n) {} catch {}
    }

    function dispute(uint256 claimSeed) external {
        uint256 n = ins.claimCount();
        if (n == 0) return;
        uint256 b = ins.disputeBond();
        vm.prank(disputer);
        try ins.dispute{value: b}(claimSeed % n, "no") {} catch {}
    }

    function resolve(uint256 claimSeed, bool stands) external {
        uint256 n = ins.claimCount();
        if (n == 0) return;
        vm.prank(gov);
        try ins.resolveDispute(claimSeed % n, stands) {} catch {}
    }

    function payout(uint256 claimSeed) external {
        uint256 n = ins.claimCount();
        if (n == 0) return;
        uint256 id = claimSeed % n;
        HackInsurance.Claim memory k = HI.claim(ins, id);
        uint256 owed = ins.entitlement(id) - ins.paidOut(id);
        uint256 before = k.claimant.balance;
        try ins.payout(id) {
            _afterPayout(id, k, owed, k.claimant.balance - before);
        } catch {}
    }

    function _afterPayout(uint256 id, HackInsurance.Claim memory k, uint256 owed, uint256 got) internal {
        bool closed = HI.claim(ins, id).state == HackInsurance.ClaimState.Paid;
        uint256 paid = closed ? got - k.bond : got;
        if (paid == 0 && owed != 0) ghostZeroPayouts++;
        paidTo[id] += paid;
        HackInsurance.Cover memory c = HI.cover(ins, k.coverId);
        if (paidTo[id] > ins.entitlement(id) || paidTo[id] > k.loss || paidTo[id] > c.amount) ghostOverpaid++;
        if (closed) {
            if (coverPaid[k.coverId]) ghostPaidOutTwice++;
            coverPaid[k.coverId] = true;
        }
    }

    function expireCover(uint256 coverSeed) external {
        uint256 n = ins.coverCount();
        if (n == 0) return;
        try ins.expireCover(coverSeed % n) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 5 days));
        vm.roll(block.number + 1);
    }
}

contract HackInsuranceInvariants is Test {
    HackInsurance ins;
    MockRunners runners;
    InsuranceHandler h;
    address gov = address(0x60F);
    bytes32 target;

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(100);
        runners = new MockRunners();
        ins = new HackInsurance(IHIRunners(address(runners)), 2, 1, gov);
        target = ins.targetKey(block.chainid, address(0xCAFE));
        vm.prank(gov);
        ins.setTarget(target, true, 300 ether);
        h = new InsuranceHandler(ins, runners, gov, target);
        for (uint256 i; i < 3; i++) runners.set(h.rs(i), true, 5, 0);
        targetContract(address(h));
    }

    /// Bonds are never spent as pool money: the balance always covers bondsHeld, and bondsHeld is
    /// exactly the bonds of live claims (Voting / Approved / Disputed) plus open dispute bonds.
    function invariant_bondsBacked() public view {
        assertGe(address(ins).balance, ins.bondsHeld());
        uint256 sum;
        uint256 n = ins.claimCount();
        for (uint256 i; i < n; i++) {
            HackInsurance.Claim memory k = HI.claim(ins, i);
            HackInsurance.ClaimState st = k.state;
            if (st == HackInsurance.ClaimState.Voting || st == HackInsurance.ClaimState.Approved || st == HackInsurance.ClaimState.Disputed) sum += k.bond;
            sum += k.disputeBond;
        }
        assertEq(ins.bondsHeld(), sum);
    }

    /// activeCover = the amounts of covers not ended (no capacity leak or double release).
    function invariant_activeCover() public view {
        uint256 sum;
        uint256 n = ins.coverCount();
        for (uint256 i; i < n; i++) {
            HackInsurance.Cover memory c = HI.cover(ins, i);
            if (c.endBlock == type(uint64).max) sum += c.amount;
        }
        assertEq(ins.activeCover(), sum);
    }

    /// Shares: totalShares = sum of LP shares; at most one claim per cover is paid in full; no claim is paid
    /// more than its entitlement (<= loss, <= cover amount); a payout never pays 0 while something is owed (HI-1).
    function invariant_sharesAndSinglePayout() public view {
        uint256 s;
        for (uint256 i; i < 3; i++) s += ins.shares(h.lps(i));
        assertEq(ins.totalShares(), s);
        assertEq(h.ghostPaidOutTwice(), 0);
        assertEq(h.ghostOverpaid(), 0);
        assertEq(h.ghostZeroPayouts(), 0);
    }

    /// openClaims counts the claims Voting / Approved / Disputed, and no LP withdraws while one is open (HI-2).
    function invariant_noFleeingOpenClaims() public view {
        uint256 n = ins.claimCount();
        uint256 open;
        for (uint256 i; i < n; i++) {
            HackInsurance.ClaimState st = HI.claim(ins, i).state;
            if (st == HackInsurance.ClaimState.Voting || st == HackInsurance.ClaimState.Approved || st == HackInsurance.ClaimState.Disputed) open++;
        }
        assertEq(ins.openClaims(), open);
        assertEq(h.ghostFledOpenClaim(), 0);
    }
}

/// Reproductions of the findings (see audit/manual-review.md, HackInsurance).
contract HackInsuranceFindings is Test {
    HackInsurance ins;
    MockRunners runners;
    address gov = address(0x60F);
    bytes32 target;
    address lp = address(0x1111);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(100);
        runners = new MockRunners();
        runners.set(address(0x71), true, 5, 0);
        runners.set(address(0x72), true, 5, 0);
        ins = new HackInsurance(IHIRunners(address(runners)), 2, 1, gov);
        target = ins.targetKey(block.chainid, address(0xCAFE));
        vm.prank(gov);
        ins.setTarget(target, true, 1000 ether);
        vm.deal(lp, 10_000 ether);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function _approvedClaim(address holder, uint128 amount, uint128 loss) internal returns (uint256 claimId) {
        uint256 premium = ins.premiumOf(amount, 30 days);
        vm.prank(holder);
        uint256 cover = ins.buyCover{value: premium}(target, amount, 30 days);
        vm.roll(block.number + 5);
        bytes32[] memory txs = new bytes32[](1);
        txs[0] = keccak256(abi.encode(holder));
        vm.prank(holder);
        claimId = ins.fileClaim{value: 1 ether}(cover, txs, uint64(block.number - 2), uint64(block.number - 1), keccak256("r"), loss, "");
        vm.prank(address(0x71));
        ins.vote(claimId, true, keccak256("r"), loss);
        vm.prank(address(0x72));
        ins.vote(claimId, true, keccak256("r"), loss);
    }

    /// REGRESSION HI-1 (was High): once the day's cap is used, a stranger's payout() of another approved
    /// claim used to pay 0 and close it for good. Now it reverts (nothing payable today), the claim stays
    /// Approved, and the next day pays the whole entitlement.
    function test_regression_HI1_payoutNotGriefedByDailyCap() public {
        vm.prank(lp);
        ins.deposit{value: 5000 ether}();
        vm.prank(gov);
        ins.setParams(200, 30000, 2000, 100 ether, 1 ether, 5 ether, 3 days, 2 days, 7 days); // dailyCap 100
        uint256 a = _approvedClaim(alice, 100 ether, 100 ether);
        uint256 b = _approvedClaim(bob, 100 ether, 100 ether);
        vm.warp(block.timestamp + 2 days + 1);
        ins.payout(a);                       // uses the whole 100 ether daily cap
        uint256 before = bob.balance;
        vm.prank(address(0xBAD));            // a stranger, same day
        vm.expectRevert(HackInsurance.NothingToPay.selector);
        ins.payout(b);
        assertEq(bob.balance, before);
        assertEq(uint8(HI.claim(ins, b).state), uint8(HackInsurance.ClaimState.Approved), "still payable");
        assertFalse(HI.cover(ins, 1).claimed, "cover not consumed");
        vm.warp(block.timestamp + 1 days);
        vm.prank(address(0xBAD));
        ins.payout(b);
        assertEq(bob.balance - before, 100 ether + 1 ether, "whole entitlement + bond, on the next day");
        assertEq(uint8(HI.claim(ins, b).state), uint8(HackInsurance.ClaimState.Paid));
    }

    /// HI-1, partial days: a claim larger than the daily cap is paid over several days, never closed short.
    function test_regression_HI1_largeClaimPaidOverDays() public {
        vm.prank(lp);
        ins.deposit{value: 5000 ether}();
        vm.prank(gov);
        ins.setParams(200, 30000, 2000, 100 ether, 1 ether, 5 ether, 3 days, 2 days, 7 days);
        uint256 a = _approvedClaim(alice, 250 ether, 250 ether);
        uint256 before = alice.balance;
        vm.warp(block.timestamp + 2 days + 1);
        assertEq(ins.entitlement(a), 250 ether);
        ins.payout(a);
        assertEq(uint8(HI.claim(ins, a).state), uint8(HackInsurance.ClaimState.Approved));
        vm.expectRevert(HackInsurance.NothingToPay.selector);
        ins.payout(a);
        vm.warp(block.timestamp + 1 days);
        ins.payout(a);
        vm.warp(block.timestamp + 1 days);
        assertEq(ins.payoutOf(a), 50 ether);
        ins.payout(a);
        assertEq(uint8(HI.claim(ins, a).state), uint8(HackInsurance.ClaimState.Paid));
        assertEq(alice.balance - before, 250 ether + 1 ether);
        vm.expectRevert(abi.encodeWithSelector(HackInsurance.WrongState.selector, HackInsurance.ClaimState.Paid));
        ins.payout(a);
    }

    /// REGRESSION HI-2 (was Medium): a request made long ago can no longer be held as a standing exit, and
    /// no withdrawal runs while a claim is open.
    function test_regression_HI2_noStandingWithdrawal() public {
        vm.prank(lp);
        ins.deposit{value: 1000 ether}();
        uint256 sh = ins.shares(lp);
        vm.prank(lp);
        ins.requestWithdraw(sh);                       // day 0: request, then just wait
        uint64 expiry = uint64(block.timestamp) + 7 days + 2 days;
        vm.warp(block.timestamp + 30 days);
        uint256 premium = ins.premiumOf(200 ether, 30 days);
        vm.prank(alice);
        uint256 cover = ins.buyCover{value: premium}(target, 200 ether, 30 days);
        vm.roll(block.number + 5);
        bytes32[] memory txs = new bytes32[](1);
        txs[0] = keccak256("hack");
        vm.prank(alice);
        uint256 id = ins.fileClaim{value: 1 ether}(cover, txs, uint64(block.number - 2), uint64(block.number - 1), keccak256("r"), 200 ether, "");
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(HackInsurance.RequestExpired.selector, expiry));
        ins.withdraw();
        // a fresh request: still frozen while the claim is open
        vm.prank(lp);
        ins.requestWithdraw(sh);
        vm.warp(block.timestamp + 7 days);
        // the claim's vote window is over but nobody closed it yet: still open
        vm.prank(lp);
        vm.expectRevert(HackInsurance.ClaimsOpen.selector);
        ins.withdraw();
        ins.expire(id);
        vm.prank(lp);
        ins.withdraw();
        assertEq(ins.shares(lp), 0);
    }

    /// HI-3: the pool emptied by a 100% payout while shares exist: a new deposit is not shared with the old
    /// (worthless) shares.
    function test_HI3_emptiedPoolDoesNotDiluteNewDeposit() public {
        vm.prank(gov);
        ins.setParams(200, 30000, 10000, 10_000 ether, 1 ether, 5 ether, 3 days, 2 days, 7 days); // 100% per claim
        vm.prank(lp);
        ins.deposit{value: 100 ether}();
        uint256 a = _approvedClaim(alice, 300 ether, 300 ether);
        vm.warp(block.timestamp + 2 days + 1);
        ins.payout(a);
        assertEq(ins.assets(), 0, "pool emptied");
        assertGt(ins.totalShares(), 0, "old shares remain");
        vm.prank(bob);
        ins.deposit{value: 100 ether}();
        uint256 bobShares = ins.shares(bob);
        vm.prank(bob);
        ins.requestWithdraw(bobShares);
        vm.warp(block.timestamp + 7 days);
        uint256 before = bob.balance;
        vm.prank(bob);
        ins.withdraw();
        assertGe(bob.balance - before, 100 ether - 1, "the new depositor gets its deposit back (old shares worth < 1 wei)");
    }

    /// HI-3: classic first-depositor inflation: 1 wei deposit + a forced donation (selfdestruct). A victim
    /// depositing less than the donation is refused (no 0-share mint); the attacker cannot profit.
    function test_HI3_donationInflationUnprofitable() public {
        address attacker = address(0xA77);
        vm.deal(attacker, 2000 ether);
        vm.prank(attacker);
        ins.deposit{value: 1}();
        vm.prank(attacker);
        new Donor{value: 1000 ether}(payable(address(ins)));
        vm.prank(lp);
        vm.expectRevert(HackInsurance.NoShares.selector);
        ins.deposit{value: 400 ether}();
        vm.prank(lp);
        ins.deposit{value: 1500 ether}();
        uint256 sa = ins.shares(attacker);
        vm.prank(attacker);
        ins.requestWithdraw(sa);
        vm.warp(block.timestamp + 7 days);
        uint256 a0 = attacker.balance;
        vm.prank(attacker);
        ins.withdraw();
        assertLt(attacker.balance - a0, 1000 ether + 1, "the attacker gets back less than it put in");
    }

    /// HI-3: a round trip with any three deposits: nobody gets back more than it put in, Σ out <= pool, and
    /// the virtual share keeps at most rounding dust.
    function testFuzz_HI3_roundTripNeverPaysMoreThanPool(uint96 d1, uint96 d2, uint96 d3) public {
        uint256[3] memory d = [bound(d1, 1, 1e24), bound(d2, 1, 1e24), bound(d3, 1, 1e24)];
        address[3] memory who = [address(0x5001), address(0x5002), address(0x5003)];
        for (uint256 i; i < 3; i++) {
            vm.deal(who[i], d[i]);
            vm.prank(who[i]);
            try ins.deposit{value: d[i]}() {} catch {}
        }
        uint256 pool = ins.assets();
        for (uint256 i; i < 3; i++) {
            uint256 sh = ins.shares(who[i]);
            if (sh == 0) continue;
            vm.prank(who[i]);
            ins.requestWithdraw(sh);
        }
        vm.warp(block.timestamp + 7 days);
        uint256 out;
        for (uint256 i; i < 3; i++) {
            if (ins.pendingShares(who[i]) == 0) continue;
            uint256 b0 = who[i].balance;
            vm.prank(who[i]);
            ins.withdraw();
            out += who[i].balance - b0;
            assertLe(who[i].balance, d[i], "nobody gains from a round trip");
        }
        assertLe(out, pool);
        assertLe(ins.assets(), 3, "rounding dust only");
    }
}

contract Donor {
    constructor(address payable to) payable { selfdestruct(to); }
}
