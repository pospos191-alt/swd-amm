// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NeuroJobs, NeuroJobsBase} from "../../contracts/NeuroJobs.sol";

/// NeuroJobs without a NeuroControl (no defenders, no pause): the money paths only.
contract JobsHandler is Test {
    NeuroJobs public nj;
    address[5] public ws = [address(0x3001), address(0x3002), address(0x3003), address(0x3004), address(0x3005)];
    address public requester = address(0x2001);
    address public challenger = address(0x2002);
    mapping(uint256 => mapping(address => bytes32)) public verdict; // job -> worker -> verdict (round-agnostic key below)
    uint256 public bondOutWhileSlashable;
    uint256 public burned;

    constructor(NeuroJobs n) {
        nj = n;
        vm.deal(requester, 1e24);
        vm.deal(challenger, 1e24);
        for (uint256 i; i < 5; i++) {
            vm.deal(ws[i], 1e24);
            vm.prank(ws[i]);
            n.register{value: 1 ether}();
        }
        vm.warp(block.timestamp + 1);
    }

    function _salt(uint256 id, uint8 round, address w) internal pure returns (bytes32) { return keccak256(abi.encode(id, round, w)); }

    function request(uint256 fee) external {
        vm.prank(requester);
        nj.request{value: bound(fee, 0.01 ether, 2 ether)}("zetaphy", "0xabc");
        vm.roll(block.number + 2);
    }

    /// Commit in round 1 (or the open challenge round), moving the clock into the window's last third
    /// (where every active runner is eligible) when needed.
    function commit(uint256 id, uint256 w, uint256 v, bool challengeRound) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        id = id % n;
        address wk = ws[w % 5];
        bytes32 vd = bytes32(1 + v % 2);
        uint64 start;
        uint8 round = 1;
        if (challengeRound) {
            (, NeuroJobsBase.ChallengeState st,, uint64 s,,,,,,) = nj.challengeInfo(id);
            if (st != NeuroJobsBase.ChallengeState.Open) return;
            (uint8 cnt,) = nj.challengeRound(id);
            round = cnt + 1;
            start = s;
        } else {
            (, uint64 created,,,,,,,,) = nj.getJob(id);
            start = created;
        }
        uint256 third = start + (2 * 30 minutes) / 3 + 1;
        if (block.timestamp < third) vm.warp(third);
        vm.roll(block.number + 2);
        bytes32 c = keccak256(abi.encode(vd, wk, _salt(id, round, wk)));
        vm.prank(wk);
        if (challengeRound) {
            try nj.challengeCommit(id, c) { verdict[id * 10 + round][wk] = vd; } catch {}
        } else {
            try nj.commit(id, c) { verdict[id * 10 + 1][wk] = vd; } catch {}
        }
    }

    function reveal(uint256 id, uint256 w, bool challengeRound) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        id = id % n;
        address wk = ws[w % 5];
        uint8 round = 1;
        if (challengeRound) {
            (uint8 cnt,) = nj.challengeRound(id);
            round = cnt + 1;
        }
        bytes32 vd = verdict[id * 10 + round][wk];
        if (vd == bytes32(0)) return;
        vm.prank(wk);
        if (challengeRound) {
            try nj.challengeReveal(id, vd, _salt(id, round, wk)) {} catch {}
        } else {
            try nj.reveal(id, vd, _salt(id, round, wk)) {} catch {}
        }
    }

    function expire(uint256 id) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        try nj.expire(id % n) {} catch {}
    }

    function settle(uint256 id) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        try nj.settle(id % n) {} catch {}
    }

    function challenge(uint256 id, uint256 v) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        id = id % n;
        uint256 b = nj.challengeBondOf(id);
        vm.prank(challenger);
        try nj.challenge{value: b}(id, bytes32(1 + v % 2)) { vm.roll(block.number + 2); } catch {}
    }

    function challengeExpire(uint256 id) external {
        uint256 n = nj.jobCount();
        if (n == 0) return;
        try nj.challengeExpire(id % n) {} catch {}
    }

    function requestUnbond(uint256 w) external {
        vm.prank(ws[w % 5]);
        try nj.requestUnbond() {} catch {}
    }

    function reRegister(uint256 w) external {
        vm.prank(ws[w % 5]);
        try nj.register{value: 1 ether}() {} catch {}
    }

    function withdrawBond(uint256 w) external {
        address wk = ws[w % 5];
        bool slashable = _slashable(wk);
        vm.prank(wk);
        try nj.withdrawBond() { if (slashable) bondOutWhileSlashable++; } catch {}
    }

    function withdraw(uint256 who) external {
        address[7] memory all = [ws[0], ws[1], ws[2], ws[3], ws[4], requester, challenger];
        vm.prank(all[who % 7]);
        try nj.withdraw() {} catch {}
    }

    function fund(uint256 a) external {
        a = bound(a, 1, 1 ether);
        vm.deal(address(this), a);
        nj.fund{value: a}();
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3 hours));
        vm.roll(block.number + 1);
    }

    /// Can `w` still be slashed for a seat it holds? (an open round, a pending grace, or a round-1 seat
    /// of a job that can still be challenged / is being challenged)
    function _slashable(address w) internal view returns (bool) {
        uint256 n = nj.jobCount();
        for (uint256 id; id < n; id++) {
            (,, NeuroJobsBase.Status st,,,,,,, address[3] memory seat) = nj.getJob(id);
            bool inR1 = seat[0] == w || seat[1] == w || seat[2] == w;
            (,,, uint64 settleAt,) = nj.jobInfo(id);
            (, NeuroJobsBase.ChallengeState cst, uint64 challengeUntil,) = nj.assurance(id);
            (,,,,,,, address[3] memory cseat,, uint64 csettle) = nj.challengeInfo(id);
            bool inCh = cseat[0] == w || cseat[1] == w || cseat[2] == w;
            if (inR1 && st == NeuroJobsBase.Status.Open) return true;
            if (inR1 && settleAt != 0) return true;
            if (inR1 && st == NeuroJobsBase.Status.Done && (block.timestamp < challengeUntil || cst == NeuroJobsBase.ChallengeState.Open)) return true;
            if (inCh && (cst == NeuroJobsBase.ChallengeState.Open || csettle != 0)) return true;
        }
        return false;
    }
}

contract NeuroJobsInvariants is Test {
    NeuroJobs nj;
    JobsHandler h;

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(1000);
        nj = new NeuroJobs(1 ether, 0.01 ether, 0.01 ether, 30 minutes, 1 hours, 2 hours, 1 ether);
        vm.deal(address(this), 10 ether);
        nj.fund{value: 10 ether}();
        h = new JobsHandler(nj);
        targetContract(address(h));
    }

    /// Solvency to the wei: balance = reward pool + every credit + every bond + fees of open jobs +
    /// bonds of open challenges (the 5% burns left for 0x…dEaD).
    function invariant_solvency() public view {
        uint256 sum = nj.rewardPool();
        for (uint256 i; i < 5; i++) {
            (uint128 bond,,,,,,,,,) = nj.workers(h.ws(i));
            sum += bond + nj.credit(h.ws(i));
        }
        sum += nj.credit(h.requester()) + nj.credit(h.challenger());
        uint256 n = nj.jobCount();
        for (uint256 id; id < n; id++) {
            (,, NeuroJobsBase.Status st,,, uint256 fee,,,,) = nj.getJob(id);
            if (st == NeuroJobsBase.Status.Open) sum += fee;
            (, NeuroJobsBase.ChallengeState cst, uint256 cbond,,,,,,,) = nj.challengeInfo(id);
            if (cst == NeuroJobsBase.ChallengeState.Open) sum += cbond;
        }
        assertEq(address(nj).balance, sum);
    }

    /// totalActiveBond = the bonds of active runners.
    function invariant_activeBond() public view {
        uint256 s;
        uint256 c;
        for (uint256 i; i < 5; i++) {
            (uint128 bond,, bool active,,,,,,,) = nj.workers(h.ws(i));
            if (active) { s += bond; c++; }
        }
        assertEq(nj.totalActiveBond(), s);
        assertEq(nj.activeWorkers(), c);
    }

    /// A bond never leaves while its runner sits on a round that can still slash it.
    function invariant_bondHeldWhileSlashable() public view {
        assertEq(h.bondOutWhileSlashable(), 0);
    }

    function test_handlerReachesFinalizeAndChallenge() public {
        h.request(1 ether);
        h.commit(0, 0, 0, false);
        h.commit(0, 1, 0, false);
        h.commit(0, 2, 1, false);
        h.reveal(0, 0, false);
        h.reveal(0, 1, false);
        (,, NeuroJobsBase.Status st,,,, bytes32 result,,,) = nj.getJob(0);
        assertEq(uint8(st), uint8(NeuroJobsBase.Status.Done));
        assertEq(result, bytes32(uint256(1)));
        h.challenge(0, 1);
        (, NeuroJobsBase.ChallengeState cst,,,,,,,,) = nj.challengeInfo(0);
        assertEq(uint8(cst), uint8(NeuroJobsBase.ChallengeState.Open));
        invariant_solvency();
        h.commit(0, 3, 1, true);
        h.commit(0, 4, 1, true);
        h.warp(15 minutes);                // 2 seats only: reveals open when the commit window ends
        h.reveal(0, 3, true);
        h.reveal(0, 4, true);
        (, cst,,,,,,,,) = nj.challengeInfo(0);
        assertEq(uint8(cst), uint8(NeuroJobsBase.ChallengeState.Overturned));
        invariant_solvency();
        invariant_activeBond();
    }
}

/// REGRESSION NJ-1 (was Low): a runner that committed and never revealed used to withdraw its whole bond
/// after the hold if nobody called expire() in the second jobTimeout; the later expire() penalised a bond
/// of 0. Now an unresolved seat (openSeats) holds the bond: withdrawBond waits until expire()/settle()
/// resolved the seat, whoever calls it and whenever, so the 10% penalty always lands.
contract NeuroJobsPenaltyEscape is Test {
    NeuroJobs nj;
    address w = address(0x3001);

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(1000);
        nj = new NeuroJobs(1 ether, 0, 0.01 ether, 30 minutes, 1 hours, 2 hours, 0);
        vm.deal(w, 10 ether);
        vm.prank(w);
        nj.register{value: 1 ether}();
        vm.warp(block.timestamp + 1);
        vm.deal(address(this), 1 ether);
    }

    function _commitNeverReveal() internal returns (uint256 id) {
        id = nj.request{value: 0.1 ether}("zetaphy", "0xabc");
        vm.roll(block.number + 2);
        vm.warp(block.timestamp + 21 minutes);          // last third of the commit window: every runner may sit
        vm.prank(w);
        nj.commit(id, keccak256(abi.encode(bytes32(uint256(1)), w, bytes32(0))));
        assertEq(nj.openSeats(w), 1);
        vm.prank(w);
        nj.requestUnbond();                              // never reveals
    }

    function test_regression_NJ1_unrevealedSeatHoldsBondUntilPenalised() public {
        uint256 id = _commitNeverReveal();
        vm.warp(block.timestamp + 30 days);              // long past heldUntil and unbondAt; nobody called expire()
        vm.prank(w);
        vm.expectRevert(NeuroJobsBase.TooEarly.selector);
        nj.withdrawBond();
        vm.prank(w);
        nj.expire(id);                                   // the runner itself (or anyone) resolves the seat
        assertEq(nj.openSeats(w), 0);
        assertEq(nj.rewardPool(), 0.1 ether, "10% penalty reached the pool");
        vm.prank(w);
        nj.withdrawBond();
        vm.prank(w);
        nj.withdraw();
        assertEq(w.balance, 9 ether + 0.9 ether, "bond minus the penalty");
    }

    /// A seat that reveals is resolved at once: no extra wait for honest runners.
    function test_regression_NJ1_revealResolvesSeat() public {
        uint256 id = nj.request{value: 0.1 ether}("zetaphy", "0xabc");
        vm.roll(block.number + 2);
        vm.warp(block.timestamp + 21 minutes);
        vm.prank(w);
        nj.commit(id, keccak256(abi.encode(bytes32(uint256(1)), w, bytes32(0))));
        vm.warp(block.timestamp + 10 minutes);           // commit window over: reveals open
        vm.prank(w);
        nj.reveal(id, bytes32(uint256(1)), bytes32(0));
        assertEq(nj.openSeats(w), 0);
    }
}
