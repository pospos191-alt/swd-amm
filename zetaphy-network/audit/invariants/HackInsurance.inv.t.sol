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

    uint256 public ghostPaidOutTwice;
    mapping(uint256 => bool) public coverPaid;

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
        vm.prank(lps[who % 3]);
        try ins.withdraw() {} catch {}
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
        uint256 coverId = HI.claim(ins, id).coverId;
        try ins.payout(id) {
            if (coverPaid[coverId]) ghostPaidOutTwice++;
            coverPaid[coverId] = true;
        } catch {}
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

    /// Shares: totalShares = sum of LP shares; at most one payout per cover.
    function invariant_sharesAndSinglePayout() public view {
        uint256 s;
        for (uint256 i; i < 3; i++) s += ins.shares(h.lps(i));
        assertEq(ins.totalShares(), s);
        assertEq(h.ghostPaidOutTwice(), 0);
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

    /// FINDING HI-1 (High for an insurance product; testnet): payout() is permissionless and pays
    /// min(..., what is left of today's dailyCap). Once the day's cap is used, ANYONE can call payout()
    /// for another approved claim: it pays 0, marks the claim Paid and the cover claimed, for good.
    function test_finding_payoutGriefedToZeroByDailyCap() public {
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
        ins.payout(b);
        assertEq(bob.balance - before, 1 ether, "bob only got his bond back");
        assertEq(uint8(HI.claim(ins, b).state), uint8(HackInsurance.ClaimState.Paid));
        assertTrue(HI.cover(ins, 1).claimed, "cover consumed with a 0 payout");
    }

    /// FINDING HI-2 (Medium): a withdrawal request never expires. An LP requests at deposit time and,
    /// once withdrawDelay passed, keeps a standing "ready" exit; when a claim is filed it leaves at once
    /// (before the vote), defeating "a known incident cannot be fled".
    function test_finding_standingWithdrawalFleesKnownIncident() public {
        vm.prank(lp);
        ins.deposit{value: 1000 ether}();
        uint256 sh = ins.shares(lp);
        vm.prank(lp);
        ins.requestWithdraw(sh);                       // day 0: request, then just wait
        vm.warp(block.timestamp + 30 days);
        uint256 premium = ins.premiumOf(200 ether, 30 days);
        vm.prank(alice);
        uint256 cover = ins.buyCover{value: premium}(target, 200 ether, 30 days);
        vm.roll(block.number + 5);
        bytes32[] memory txs = new bytes32[](1);
        txs[0] = keccak256("hack");
        vm.prank(alice);
        ins.fileClaim{value: 1 ether}(cover, txs, uint64(block.number - 2), uint64(block.number - 1), keccak256("r"), 200 ether, "");
        // the incident is public; the LP exits in the same block, nothing left to pay the claim
        vm.prank(lp);
        ins.withdraw();
        assertEq(ins.assets(), 0, "pool emptied while a claim is being voted");
    }
}
