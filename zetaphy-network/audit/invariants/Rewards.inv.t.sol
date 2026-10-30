// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UsefulIssuance} from "../../contracts/UsefulIssuance.sol";
import {UsefulWork, IUWReputation, IUWIssuance} from "../../contracts/UsefulWork.sol";
import {BugBounty, IBBRunners, IBBReputation, IBBIssuance} from "../../contracts/BugBounty.sol";
import {ComputeMarket, IRunnersView} from "../../contracts/ComputeMarket.sol";
import {DataDAO} from "../../contracts/DataDAO.sol";
import {MockRunners, Receiver} from "./utils/Mocks.sol";

contract FakeTimelock {
    function getMinDelay() external pure returns (uint256) { return 2 days; }
}

/// A sink contract of UsefulIssuance that draws for itself.
contract Sink {
    UsefulIssuance public iss;
    constructor(UsefulIssuance i) { iss = i; }
    receive() external payable {}
    function draw(uint256 a) external returns (uint256) { return iss.draw(a); }
}

// ============================================================================ UsefulIssuance

contract IssuanceHandler is Test {
    UsefulIssuance public iss;
    address public gov;
    Sink[3] public sinks;
    Receiver public overflowTo;
    uint256 public ghostIn;
    uint256 public ghostOut;

    constructor(UsefulIssuance i, address g, Sink[3] memory s, Receiver o) {
        iss = i;
        gov = g;
        sinks = s;
        overflowTo = o;
    }

    function fund(uint256 a) external {
        a = bound(a, 0, 1e24);
        vm.deal(address(this), a);
        iss.fund{value: a}();
        ghostIn += a;
    }

    function draw(uint256 s, uint256 a) external {
        Sink k = sinks[s % 3];
        uint256 before = address(k).balance;
        try k.draw(bound(a, 0, 1e24)) { ghostOut += address(k).balance - before; } catch {}
    }

    function sweep(bool refuse) external {
        overflowTo.setRefuse(refuse);
        uint256 before = address(overflowTo).balance;
        iss.sweepOverflow();
        ghostOut += address(overflowTo).balance - before;
    }

    function setBuckets(uint16 a, uint16 b, uint128 capA, uint128 capB, uint256 pick) external {
        a = uint16(bound(a, 1, 6000));
        b = uint16(bound(b, 1, 10_000 - a));
        UsefulIssuance.Bucket[] memory n = new UsefulIssuance.Bucket[](2);
        n[0] = UsefulIssuance.Bucket(address(sinks[pick % 3]), a, uint128(bound(capA, 0, 1e24)), 0);
        n[1] = UsefulIssuance.Bucket(address(sinks[(pick + 1) % 3]), b, uint128(bound(capB, 0, 1e24)), 0);
        vm.prank(gov);
        iss.setBuckets(n);
    }
}

contract UsefulIssuanceInvariants is Test {
    UsefulIssuance iss;
    IssuanceHandler h;

    function setUp() public {
        FakeTimelock tl = new FakeTimelock();
        Receiver o = new Receiver();
        iss = new UsefulIssuance(address(tl), address(o));
        Sink[3] memory s = [new Sink(iss), new Sink(iss), new Sink(iss)];
        UsefulIssuance.Bucket[] memory b = new UsefulIssuance.Bucket[](2);
        b[0] = UsefulIssuance.Bucket(address(s[0]), 3000, 100 ether, 0);
        b[1] = UsefulIssuance.Bucket(address(s[1]), 2000, 1e24, 0);
        vm.prank(address(tl));
        iss.setBuckets(b);
        h = new IssuanceHandler(iss, address(tl), s, o);
        targetContract(address(h));
    }

    /// Every wei in is either accrued in a bucket or pending overflow; nothing else leaves.
    function invariant_accounting() public view {
        UsefulIssuance.Bucket[] memory b = iss.buckets();
        uint256 sum = iss.pendingOverflow();
        for (uint256 i; i < b.length; i++) {
            sum += b[i].accrued;
            assertLe(b[i].accrued, b[i].cap, "bucket over its cap");
        }
        assertEq(address(iss).balance, sum);
        assertEq(h.ghostIn(), address(iss).balance + h.ghostOut());
    }
}

// ============================================================================ UsefulWork (+ UsefulIssuance as its subsidy source)

contract WorkHandler is Test {
    UsefulWork public uw;
    address public feeder = address(0xFEED);
    address[4] public workers = [address(0x4001), address(0x4002), address(0x4003), address(0x4004)];
    address[2] public posters = [address(0x5001), address(0x5002)];
    mapping(uint256 => mapping(address => bytes32)) public verdictOf;
    uint256 public stampCount;
    uint256 public settledCount;

    constructor(UsefulWork u) {
        uw = u;
        vm.deal(feeder, 1e24);
        for (uint256 i; i < 4; i++) vm.deal(workers[i], 1e24);
        for (uint256 i; i < 2; i++) vm.deal(posters[i], 1e24);
    }

    function stamp(uint256 w) external {
        address wk = workers[w % 4];
        vm.roll(block.number + 1);
        uint256 height = block.number - 1;
        vm.setBlockhash(height, keccak256(abi.encode(height, "zetaphy")));
        (, bytes memory raw) = address(uw).staticcall(abi.encodeCall(uw.params, ()));
        uint8 bits = abi.decode(raw, (UsefulWork.Params)).stampBits;
        for (uint64 nonce; nonce < 20_000; nonce++) {
            bytes32 hh = uw.stampHash(wk, height, nonce);
            if (uint256(hh) >> (256 - bits) == 0 && !uw.usedStamp(hh)) {
                vm.prank(wk);
                uw.stamp(height, nonce);
                stampCount++;
                return;
            }
        }
    }

    function post(uint256 p, uint256 fee, bool asFeeder, bool subsidized) external {
        fee = bound(fee, asFeeder ? 0 : 1, 10 ether);
        if (asFeeder) {
            vm.prank(feeder);
            uw.postFeeder{value: fee}("zetaphy", "0xabc", keccak256("code"), 0, subsidized, bytes32(0));
        } else {
            vm.prank(posters[p % 2]);
            uw.post{value: fee}("zetaphy", "0xabc", keccak256("code"), 0);
        }
    }

    function commit(uint256 j, uint256 w, uint256 v) external {
        uint256 n = uw.jobCount();
        if (n == 0) return;
        j = j % n;
        address wk = workers[w % 4];
        bytes32 verdict = bytes32(1 + (v % 2));
        bytes32 cm = uw.commitmentOf(verdict, wk, keccak256(abi.encode(j, wk)), j);
        uint256 dep = uw.getJob(j).deposit;
        vm.prank(wk);
        try uw.commit{value: dep}(j, cm) { verdictOf[j][wk] = verdict; } catch {}
    }

    function reveal(uint256 j, uint256 w) external {
        uint256 n = uw.jobCount();
        if (n == 0) return;
        j = j % n;
        address wk = workers[w % 4];
        vm.prank(wk);
        try uw.reveal(j, verdictOf[j][wk], keccak256(abi.encode(j, wk))) {} catch {}
    }

    function settle(uint256 j) external {
        uint256 n = uw.jobCount();
        if (n == 0) return;
        try uw.settle(j % n) { settledCount++; } catch {}
    }

    function withdraw(uint256 who) external {
        address[7] memory all = [workers[0], workers[1], workers[2], workers[3], posters[0], posters[1], feeder];
        vm.prank(all[who % 7]);
        try uw.withdraw() {} catch {}
    }

    function fund(uint256 a) external {
        a = bound(a, 0, 5 ether);
        vm.deal(address(this), a);
        uw.fund{value: a}();
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3 hours));
    }
}

contract UsefulWorkInvariants is Test {
    UsefulWork uw;
    UsefulIssuance iss;
    WorkHandler h;
    address gov = address(0x60F);

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(1000);
        FakeTimelock tl = new FakeTimelock();
        iss = new UsefulIssuance(address(tl), address(new Receiver()));
        UsefulWork.Params memory p = UsefulWork.Params({stampBits: 8, stampSeats: 50, stampLife: 30 days, seatsPerDay: 100, seats: 3,
            quorum: 2, commitWindow: 1 hours, revealWindow: 1 hours, seatDeposit: 0.1 ether, subsidy: 0.05 ether, priorityScore: 0, priorityWindow: 0});
        uw = new UsefulWork(gov, IUWReputation(address(0)), IUWIssuance(address(iss)), p);
        UsefulIssuance.Bucket[] memory b = new UsefulIssuance.Bucket[](1);
        b[0] = UsefulIssuance.Bucket(address(uw), 5000, 1000 ether, 0);
        vm.prank(address(tl));
        iss.setBuckets(b);
        vm.deal(address(this), 100 ether);
        iss.fund{value: 100 ether}();
        h = new WorkHandler(uw);
        address feeder = h.feeder();
        vm.prank(gov);
        uw.setFeeder(feeder, true);
        targetContract(address(h));
    }

    /// Solvency to the wei: balance = reserve + every credit + (fee + deposits) of unsettled jobs.
    function invariant_conservation() public view {
        uint256 owed;
        for (uint256 i; i < 4; i++) owed += uw.owed(h.workers(i));
        for (uint256 i; i < 2; i++) owed += uw.owed(h.posters(i));
        owed += uw.owed(h.feeder());
        uint256 open;
        uint256 n = uw.jobCount();
        for (uint256 i; i < n; i++) {
            UsefulWork.Job memory j = uw.getJob(i);
            if (!j.settled) open += uint256(j.fee) + uint256(j.taken) * j.deposit;
        }
        assertEq(address(uw).balance, uw.reserve() + owed + open);
    }

    /// The accepted verdict of a settled job was revealed by at least `quorum` seats (no canaries here).
    function invariant_resultHasQuorum() public view {
        uint256 n = uw.jobCount();
        for (uint256 i; i < n; i++) {
            UsefulWork.Job memory j = uw.getJob(i);
            if (!j.settled || j.result == bytes32(0)) continue;
            address[] memory seats = uw.seatsOf(i);
            uint256 agree;
            for (uint256 k; k < seats.length; k++) if (uw.verdicts(i, seats[k]) == j.result) agree++;
            assertGe(agree, j.quorum);
        }
    }

    function test_handlerReachesSettle() public {
        h.post(0, 1 ether, false, false);
        for (uint256 w; w < 3; w++) h.stamp(w);
        for (uint256 w; w < 3; w++) h.commit(0, w, 0);
        for (uint256 w; w < 3; w++) h.reveal(0, w);
        h.settle(0);
        assertEq(h.settledCount(), 1);
        assertEq(uw.getJob(0).result, bytes32(uint256(1)));
    }
}

// ============================================================================ BugBounty

contract BountyHandler is Test {
    BugBounty public bb;
    address public sponsor = address(0x5905);
    address[3] public finders = [address(0x6001), address(0x6002), address(0x6003)];
    address[3] public rs = [address(0x71), address(0x72), address(0x73)];

    constructor(BugBounty b) {
        bb = b;
        vm.deal(sponsor, 1e24);
        for (uint256 i; i < 3; i++) vm.deal(finders[i], 1e24);
    }

    function post(uint256 reward, uint64 dur) external {
        vm.prank(sponsor);
        bb.post{value: bound(reward, 1, 10 ether)}(keccak256("spec"), "ipfs://spec", uint64(bound(dur, 1 hours, 3 days)));
    }

    function commit(uint256 b, uint256 f) external {
        uint256 n = bb.bountyCount();
        if (n == 0) return;
        b = b % n;
        address fd = finders[f % 3];
        uint256 dep = bb.findingDeposit();
        bytes32 cm = bb.commitmentOf(keccak256(abi.encode("bug", fd)), fd, bytes32(uint256(7)), b);
        vm.prank(fd);
        try bb.commitFinding{value: dep}(b, cm) {} catch {}
    }

    function reveal(uint256 fid) external {
        uint256 n = bb.findingCount();
        if (n == 0) return;
        fid = fid % n;
        address fd = bb.getFinding(fid).finder;
        vm.roll(block.number + 1);
        vm.prank(fd);
        try bb.revealFinding(fid, abi.encode("bug", fd), bytes32(uint256(7))) {} catch {}
    }

    function attest(uint256 fid, uint256 r, bool valid) external {
        uint256 n = bb.findingCount();
        if (n == 0) return;
        vm.prank(rs[r % 3]);
        try bb.attest(fid % n, valid) {} catch {}
    }

    function claim(uint256 fid) external {
        uint256 n = bb.findingCount();
        if (n == 0) return;
        try bb.claim(fid % n) {} catch {}
    }

    function close(uint256 fid) external {
        uint256 n = bb.findingCount();
        if (n == 0) return;
        try bb.close(fid % n) {} catch {}
    }

    function refund(uint256 b) external {
        uint256 n = bb.bountyCount();
        if (n == 0) return;
        try bb.refund(b % n) {} catch {}
    }

    /// The sponsor tries to take finding slots of its own bounty (must always be refused, BB-1).
    function sponsorCommit(uint256 b) external {
        uint256 n = bb.bountyCount();
        if (n == 0) return;
        uint256 dep = bb.findingDeposit();
        vm.prank(sponsor);
        try bb.commitFinding{value: dep}(b % n, keccak256("junk")) { sponsorCommits++; } catch {}
    }

    uint256 public sponsorCommits;

    function withdraw(uint256 who) external {
        address[4] memory all = [finders[0], finders[1], finders[2], sponsor];
        vm.prank(all[who % 4]);
        try bb.withdraw() {} catch {}
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 1 days));
        vm.roll(block.number + 1);
    }
}

contract BugBountyInvariants is Test {
    BugBounty bb;
    MockRunners runners;
    BountyHandler h;

    function setUp() public {
        vm.warp(1_700_000_000);
        runners = new MockRunners();
        bb = new BugBounty(IBBRunners(address(runners)), 2, 1, address(0x60F), IBBReputation(address(0)), IBBIssuance(address(0)),
            0.5 ether, 1 days, 1 days);
        h = new BountyHandler(bb);
        for (uint256 i; i < 3; i++) runners.set(h.rs(i), true, 5, 0);
        targetContract(address(h));
    }

    function _liabilities() internal view returns (uint256 sum) {
        for (uint256 i; i < 3; i++) sum += bb.owed(h.finders(i));
        sum += bb.owed(h.sponsor());
        uint256 nb = bb.bountyCount();
        for (uint256 i; i < nb; i++) {
            BugBounty.Bounty memory b = bb.getBounty(i);
            if (!b.paid && !b.refunded) sum += b.reward;
        }
        uint256 nf = bb.findingCount();
        for (uint256 i; i < nf; i++) {
            BugBounty.Finding memory f = bb.getFinding(i);
            if (f.state == BugBounty.State.Committed || f.state == BugBounty.State.Revealed || f.state == BugBounty.State.Accepted) sum += f.deposit;
        }
    }

    /// The sponsor never holds a finding slot of its own bounty, and a refund never pays the sponsor
    /// forfeited deposits (owed to the sponsor <= what it posted).
    function invariant_sponsorCannotBlockOrProfit() public view {
        assertEq(h.sponsorCommits(), 0);
        uint256 posted;
        uint256 nb = bb.bountyCount();
        for (uint256 i; i < nb; i++) {
            BugBounty.Bounty memory b = bb.getBounty(i);
            if (b.refunded) posted += b.reward - bb.forfeitedOf(i);
        }
        assertLe(bb.owed(h.sponsor()), posted);
    }

    /// Solvency: the contract can always pay every credit, open reward and open deposit.
    function invariant_solvent() public view {
        assertGe(address(bb).balance, _liabilities());
    }

    /// No money is stranded (BB-2, fixed): every wei held is a credit, an open reward or an open deposit.
    /// A deposit forfeited after its bounty was paid / refunded is burned instead of being added to a
    /// reward nobody can take.
    function invariant_noStrandedFunds() public view {
        assertEq(address(bb).balance, _liabilities(), "funds stranded in a closed bounty");
    }
}

/// REGRESSION BB-1 (was Medium): the sponsor used to fill all 32 finding slots with commitments it never
/// revealed, block real finders (TooMany), close them (their deposits grew its own reward) and refund
/// itself everything. Now: the sponsor cannot commit, one address holds at most MAX_PER_FINDER slots,
/// junk frees its slot when its reveal window ends, and forfeited deposits are never refunded to the
/// sponsor.
contract BugBountySponsorBlocksFindings is Test {
    BugBounty bb;
    MockRunners r;
    address sponsor = address(0x5905);
    address hunter = address(0x6001);

    function setUp() public {
        vm.warp(1_700_000_000);
        r = new MockRunners();
        bb = new BugBounty(IBBRunners(address(r)), 2, 1, address(0x60F), IBBReputation(address(0)), IBBIssuance(address(0)),
            0.5 ether, 1 days, 1 days);
        vm.deal(sponsor, 100 ether);
        vm.deal(hunter, 1 ether);
    }

    function test_regression_BB1_sponsorCannotCommit() public {
        vm.startPrank(sponsor);
        uint256 id = bb.post{value: 10 ether}(keccak256("spec"), "spec", 7 days);
        vm.expectRevert(BugBounty.BadFinding.selector);
        bb.commitFinding{value: 0.5 ether}(id, keccak256(abi.encode(uint256(0))));
        vm.stopPrank();
        vm.prank(hunter);
        bb.commitFinding{value: 0.5 ether}(id, keccak256("real bug"));
    }

    /// The same attack through 8 sock-puppet addresses (4 slots each): the slots free up when the junk's
    /// reveal window ends, the hunter gets in, and the sponsor's junk deposits are burned, not refunded.
    function test_regression_BB1_sybilFloodCostsAndExpires() public {
        vm.prank(sponsor);
        uint256 id = bb.post{value: 10 ether}(keccak256("spec"), "spec", 7 days);
        uint256 n;
        for (uint160 s = 1; s <= 8; s++) {
            address puppet = address(0x9000 + s);
            vm.deal(puppet, 10 ether);
            for (uint256 k; k < 4; k++) {
                vm.prank(puppet);
                bb.commitFinding{value: 0.5 ether}(id, keccak256(abi.encode(s, k)));
                n++;
            }
            vm.prank(puppet);
            vm.expectRevert(BugBounty.TooMany.selector); // 5th slot for one address
            bb.commitFinding{value: 0.5 ether}(id, keccak256(abi.encode(s, uint256(9))));
        }
        assertEq(n, 32);
        vm.prank(hunter);
        vm.expectRevert(BugBounty.TooMany.selector); // full right now...
        bb.commitFinding{value: 0.5 ether}(id, keccak256("real bug"));
        vm.warp(block.timestamp + 1 days + 1);       // ...until the junk's reveal window ends
        vm.prank(hunter);
        bb.commitFinding{value: 0.5 ether}(id, keccak256("real bug"));
        // nobody wins: the sponsor gets its 10 ether back, not the 16 ether of junk deposits
        vm.warp(block.timestamp + 10 days);
        for (uint256 i; i < 33; i++) bb.close(i);
        bb.refund(id);
        vm.prank(sponsor);
        bb.withdraw();
        assertEq(sponsor.balance, 100 ether - 10 ether + 10 ether, "only its own reward back");
        assertEq(bb.burned(), 16 ether + 0.5 ether, "forfeited deposits burned");
    }
}

/// REGRESSION BB-2 (was Low): a finding rejected (or closed unrevealed) after its bounty was paid used to
/// add its deposit to that bounty's reward, which nothing could pay out any more. Now it is burned and
/// the contract holds exactly its liabilities.
contract BugBountyStrandedDeposit is Test {
    function test_regression_BB2_noDepositStrandedAfterPayout() public {
        vm.warp(1_700_000_000);
        MockRunners r = new MockRunners();
        r.set(address(0x71), true, 5, 0);
        r.set(address(0x72), true, 5, 0);
        BugBounty bb = new BugBounty(IBBRunners(address(r)), 2, 1, address(0x60F), IBBReputation(address(0)), IBBIssuance(address(0)),
            0.5 ether, 1 days, 1 days);
        address a = address(0x6001);
        address b = address(0x6002);
        vm.deal(address(this), 10 ether);
        vm.deal(a, 1 ether);
        vm.deal(b, 1 ether);
        uint256 id = bb.post{value: 5 ether}(keccak256("spec"), "spec", 3 days);
        bytes32 ca = bb.commitmentOf(keccak256("A"), a, bytes32(0), id);
        vm.prank(a);
        uint256 fa = bb.commitFinding{value: 0.5 ether}(id, ca);
        vm.prank(b);
        bb.commitFinding{value: 0.5 ether}(id, keccak256("never revealed"));
        vm.roll(block.number + 1);
        vm.prank(a);
        bb.revealFinding(fa, "A", bytes32(0));
        vm.prank(address(0x71));
        bb.attest(fa, true);
        vm.prank(address(0x72));
        bb.attest(fa, true);
        vm.warp(block.timestamp + 2 days);           // b's reveal window is over: b is "settled out"
        bb.claim(fa);                                 // a wins 5 ether + its deposit back
        vm.prank(a);
        bb.withdraw();
        bb.close(1);                                  // b's deposit: burned, not added to a PAID bounty
        assertEq(address(bb).balance, 0, "nothing stranded");
        assertEq(bb.burned(), 0.5 ether);
        assertEq(bb.getBounty(id).reward, 5 ether);
    }

    /// Same after a refund: a late rejection of a revealed finding.
    function test_regression_BB2_noDepositStrandedAfterRefund() public {
        vm.warp(1_700_000_000);
        MockRunners r = new MockRunners();
        r.set(address(0x71), true, 5, 0);
        r.set(address(0x72), true, 5, 0);
        BugBounty bb = new BugBounty(IBBRunners(address(r)), 2, 1, address(0x60F), IBBReputation(address(0)), IBBIssuance(address(0)),
            0.5 ether, 1 days, 1 days);
        address a = address(0x6001);
        vm.deal(address(this), 10 ether);
        vm.deal(a, 1 ether);
        uint256 id = bb.post{value: 5 ether}(keccak256("spec"), "spec", 1 days);
        bytes32 ca = bb.commitmentOf(keccak256("A"), a, bytes32(0), id);
        vm.prank(a);
        uint256 fa = bb.commitFinding{value: 0.5 ether}(id, ca);
        vm.roll(block.number + 1);
        vm.prank(a);
        bb.revealFinding(fa, "A", bytes32(0));
        vm.warp(block.timestamp + 3 days + 1);        // past deadline + reveal + judge windows, unjudged
        bb.refund(id);
        bb.close(fa);                                 // unjudged: the deposit goes back to the finder
        vm.prank(a);
        bb.withdraw();
        bb.withdraw();
        assertEq(address(bb).balance, 0);
    }

    receive() external payable {}
}

// ============================================================================ ComputeMarket

contract ComputeHandler is Test {
    ComputeMarket public m;
    address[2] public reqs = [address(0x8001), address(0x8002)];
    address[2] public rs = [address(0x71), address(0x72)];
    uint256 public doubleSettle;
    mapping(uint256 => bool) public settled;

    constructor(ComputeMarket m_) {
        m = m_;
        for (uint256 i; i < 2; i++) vm.deal(reqs[i], 1e24);
    }

    function request(uint256 r, uint256 price, uint64 secs) external {
        vm.prank(reqs[r % 2]);
        m.request{value: bound(price, 1, 10 ether)}("model", keccak256("in"), "ipfs://in", uint64(bound(secs, 1, 7 days)));
    }

    function take(uint256 id, uint256 r) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        vm.prank(rs[r % 2]);
        try m.take(id % n) {} catch {}
    }

    function deliver(uint256 id) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getTask(id).runner);
        try m.deliver(id, keccak256("out"), "ipfs://out") {} catch {}
    }

    function _settleCheck(uint256 id) internal {
        if (settled[id]) doubleSettle++;
        settled[id] = true;
    }

    function accept(uint256 id) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getTask(id).requester);
        try m.accept(id) { _settleCheck(id); } catch {}
    }

    function reject(uint256 id) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getTask(id).requester);
        try m.reject(id) { _settleCheck(id); } catch {}
    }

    function claim(uint256 id) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        try m.claim(id % n) { _settleCheck(id % n); } catch {}
    }

    function cancel(uint256 id) external {
        uint256 n = m.taskCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getTask(id).requester);
        try m.cancel(id) { _settleCheck(id); } catch {}
    }

    function withdraw(uint256 who) external {
        address[4] memory all = [reqs[0], reqs[1], rs[0], rs[1]];
        vm.prank(all[who % 4]);
        try m.withdraw() {} catch {}
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 2 days)); }
}

contract ComputeMarketInvariants is Test {
    ComputeMarket m;
    ComputeHandler h;

    function setUp() public {
        MockRunners r = new MockRunners();
        m = new ComputeMarket(IRunnersView(address(r)), 1);
        h = new ComputeHandler(m);
        r.set(h.rs(0), true, 3, 0);
        r.set(h.rs(1), true, 3, 0);
        targetContract(address(h));
    }

    /// Escrow: balance = credits + prices of tasks not settled; a task settles once.
    function invariant_escrow() public view {
        uint256 sum;
        for (uint256 i; i < 2; i++) sum += m.credit(h.reqs(i)) + m.credit(h.rs(i));
        uint256 n = m.taskCount();
        for (uint256 i; i < n; i++) {
            ComputeMarket.Task memory t = m.getTask(i);
            if (t.status == ComputeMarket.Status.Open || t.status == ComputeMarket.Status.Taken || t.status == ComputeMarket.Status.Delivered) sum += t.price;
        }
        assertEq(address(m).balance, sum);
        assertEq(h.doubleSettle(), 0);
    }
}

// ============================================================================ DataDAO

contract DaoHandler is Test {
    DataDAO public dao;
    address public poster;
    address public gov;
    address[2] public accts = [address(0x9001), address(0x9002)];
    struct R { uint256 a0; uint256 a1; }
    mapping(uint256 => R) public amounts;
    uint256 public overClaim;

    constructor(DataDAO d, address p, address g) {
        dao = d;
        poster = p;
        gov = g;
    }

    function fund(uint256 a) external {
        a = bound(a, 0, 100 ether);
        vm.deal(address(this), a);
        dao.fund{value: a}();
    }

    function postRound(uint256 a0, uint256 a1) external {
        a0 = bound(a0, 1, 20 ether);
        a1 = bound(a1, 1, 20 ether);
        uint256 round = dao.roundCount() + 1;
        bytes32 l0 = dao.leafOf(round, accts[0], a0);
        bytes32 l1 = dao.leafOf(round, accts[1], a1);
        bytes32 root = l0 < l1 ? keccak256(abi.encode(l0, l1)) : keccak256(abi.encode(l1, l0));
        vm.prank(poster);
        try dao.postRound(root, uint128(a0 + a1), keccak256("report"), "ipfs://r") { amounts[round] = R(a0, a1); } catch {}
    }

    function claim(uint256 r, uint256 who, bool cheat) external {
        uint256 n = dao.roundCount();
        if (n == 0) return;
        uint256 round = 1 + r % n;
        uint256 i = who % 2;
        R memory x = amounts[round];
        if (x.a0 == 0) return;
        bytes32 other = dao.leafOf(round, accts[1 - i], i == 0 ? x.a1 : x.a0);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = other;
        uint256 amt = (i == 0 ? x.a0 : x.a1) + (cheat ? 1 : 0);
        uint256 before = accts[i].balance;
        try dao.claim(round, accts[i], amt, proof) {
            if (cheat || accts[i].balance - before != amt) overClaim++;
        } catch {}
    }

    function veto(uint256 r) external {
        uint256 n = dao.roundCount();
        if (n == 0) return;
        vm.prank(gov);
        try dao.veto(1 + r % n) {} catch {}
    }

    function sweep(uint256 r) external {
        uint256 n = dao.roundCount();
        if (n == 0) return;
        try dao.sweep(1 + r % n) {} catch {}
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 20 days)); }
}

contract DataDAOInvariants is Test {
    DataDAO dao;
    DaoHandler h;

    function setUp() public {
        dao = new DataDAO(address(0x60F), address(0x9057));
        h = new DaoHandler(dao, address(0x9057), address(0x60F));
        targetContract(address(h));
    }

    /// reserved = what live rounds still owe; the balance covers it; no claim pays a wrong amount.
    function invariant_reserved() public {
        uint256 owe;
        uint256 n = dao.roundCount();
        for (uint256 i = 1; i <= n; i++) {
            (, uint256 total, uint256 claimed,,,, bool vetoed,,) = dao.rounds(i);
            assertLe(claimed, total);
            if (!vetoed && block.timestamp < _expires(i)) owe += total - claimed;
            else if (!vetoed && !_swept(i)) owe += total - claimed;
        }
        assertEq(dao.reserved(), owe);
        assertGe(address(dao).balance, dao.reserved());
        assertEq(h.overClaim(), 0);
    }

    function _expires(uint256 i) internal view returns (uint64 e) { (,,,,, e,,,) = dao.rounds(i); }

    /// swept rounds: total - claimed released (read from storage slot logic via sweep() idempotence).
    function _swept(uint256 i) internal returns (bool) {
        // sweep() reverts NotOpen once swept (or before expiry / when vetoed): probe it on a snapshot
        uint256 snap = vm.snapshotState();
        (bool ok,) = address(dao).call(abi.encodeCall(DataDAO.sweep, (i)));
        vm.revertToState(snap);
        return !ok;
    }
}
