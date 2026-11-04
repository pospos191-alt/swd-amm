// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// SS8 (docs/future/immune-score.md): formal properties of the open audit network's own contracts, as Foundry
// invariants over random sequences of requests, auditor and runner commits and reveals, judge votes, appeals,
// settlements, certifications, post-certificate findings, claims and withdrawals.
//   - no payout exceeds deposits: what a request pays out of its pool never exceeds the pool; every credited balance
//     (owed) and every bond is backed by the contract's balance; nobody withdraws more than was ever paid in;
//   - a certificate never issues with an open critical: an issued request has zero valid critical/high, zero undecided
//     findings, no open appeal and an agreed automated tier with zero critical/high;
//   - a certificate that a valid post-certificate critical/high finding hit is never valid again.

import {Test} from "forge-std/Test.sol";
import {AuditNetwork, IANReputation, IANPot, IANCertificate} from "../../contracts/AuditNetwork.sol";
import {AuditRunners, IARNetwork, IARJobs, IARReputation} from "../../contracts/AuditRunners.sol";
import {AuditJudges, IAJNetwork, IAJReputation} from "../../contracts/AuditJudges.sol";
import {AuditCertificate, IACNetwork, IACRunners, IACJudges} from "../../contracts/AuditCertificate.sol";
import {MockRunners} from "./utils/Mocks.sol";

/// Code that is audited (any runtime code will do): two different contracts.
contract AuditTarget {
    uint256 public x;
    function poke(uint256 v) external { x = v; }
}

contract AuditTarget2 {
    uint256 public y;
    function prod(uint256 v) external { y = v + 1; }
}

contract AuditHandler is Test {
    AuditNetwork public net;
    AuditRunners public run;
    AuditJudges public jud;
    AuditCertificate public cert;
    address public gov;
    address public treasury;
    address[2] public targets;

    address[2] public sponsors = [address(0x5001), address(0x5002)];
    address[4] public auditorsA = [address(0xA001), address(0xA002), address(0xA003), address(0xA004)];
    address[3] public judgesA = [address(0x7001), address(0x7002), address(0x7003)];
    address[3] public runnersA = [address(0x8001), address(0x8002), address(0x8003)];
    address public appellant = address(0x9001);

    struct Sealed { bytes32 h; uint8 sev; bytes32 ev; bytes32 salt; }
    mapping(uint256 => Sealed) public sealedOf;                 // finding id -> what its auditor committed
    mapping(uint256 => mapping(uint256 => bool)) public runnerBad; // request -> runner index -> committed a critical result

    // ghosts
    uint256 public ghostIn;                       // every wei sent to the three contracts
    uint256 public ghostOut;                      // every wei withdrawn from them
    mapping(uint256 => uint256) public paidFromPool; // request -> credited to auditors / the sponsor out of its pool
    uint256 public certWithOpenCritical;          // certify succeeded while a critical/high was open (must stay 0)
    address[] public revokedTargets;              // targets whose certificate a valid late critical/high hit
    uint256 public calls;
    uint256 public certified;                     // successful certifications (coverage)

    constructor(AuditNetwork n, AuditRunners r, AuditJudges j, AuditCertificate c, address g, address t, address[2] memory tg) {
        net = n; run = r; jud = j; cert = c; gov = g; treasury = t; targets = tg;
        for (uint256 i; i < 2; i++) vm.deal(sponsors[i], 1e30);
        for (uint256 i; i < 4; i++) {
            vm.deal(auditorsA[i], 1e30);
            vm.prank(auditorsA[i]);
            net.bond{value: 10 ether}();
            ghostIn += 10 ether;
        }
        for (uint256 i; i < 3; i++) {
            vm.deal(judgesA[i], 1e30);
            vm.prank(judgesA[i]);
            jud.bond{value: 20 ether}();
            ghostIn += 20 ether;
        }
        vm.deal(appellant, 1e30);
    }

    function _req(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 n = net.requestCount();
        if (n == 0) return (0, false);
        return (seed % n, true);
    }

    function _fid(uint256 seed) internal view returns (uint256 fid, bool ok) {
        uint256 n = net.findingCount();
        if (n == 0) return (0, false);
        return (seed % n, true);
    }

    function _result(bool bad) internal pure returns (AuditRunners.Result memory r) {
        r = AuditRunners.Result(keccak256(abi.encode("result", bad)), bad ? 1 : 0, 0, 0, 9000);
    }

    // ------------------------------------------------------------------ requests and the contest

    function request(uint256 s, uint256 t, uint256 value) external {
        calls++;
        value = bound(value, 2 ether, 40 ether);
        address tg = targets[t % 2];
        AuditNetwork.Target memory x = AuditNetwork.Target(uint64(block.chainid), tg, tg.codehash, keccak256("src"));
        vm.prank(sponsors[s % 2]);
        try net.request{value: value}(x, 0, 3 days, 2, 0, "") { ghostIn += value; } catch {}
    }

    function commitReport(uint256 a, uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        address who = auditorsA[a % 4];
        bytes32 c = net.reportCommitment(keccak256(abi.encode("report", who)), who, bytes32(uint256(1)), id);
        vm.prank(who); // (computed first: a prank covers only the next call)
        try net.commitReport(id, c) {} catch {}
    }

    function revealReport(uint256 a, uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        address who = auditorsA[a % 4];
        vm.prank(who);
        try net.revealReport(id, keccak256(abi.encode("report", who)), bytes32(uint256(1))) {} catch {}
    }

    /// A contest finding, or (after the certificate) a post-certificate one.
    function commitFinding(uint256 a, uint256 seed, uint8 sev) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        address who = auditorsA[a % 4];
        sev = uint8(bound(sev, 1, 5));
        Sealed memory s = Sealed(keccak256(abi.encode("finding", seed, sev)), sev, keccak256("poc"), bytes32(seed));
        bytes32 c = net.findingCommitment(s.h, s.sev, s.ev, who, s.salt, id);
        vm.prank(who);
        try net.commitFinding(id, c) returns (uint256 fid) { sealedOf[fid] = s; } catch {}
    }

    function revealFinding(uint256 seed) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        Sealed memory s = sealedOf[fid];
        address auditor = net.getFinding(fid).auditor;
        vm.roll(block.number + 1);
        vm.prank(auditor);
        try net.revealFinding(fid, s.h, s.sev, s.ev, s.salt, "") {} catch {}
    }

    function runnerCommit(uint256 r, uint256 seed, bool bad) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        uint256 i = r % 3;
        bytes32 c = run.commitmentOf(_result(bad), runnersA[i], bytes32(uint256(7)), id);
        vm.prank(runnersA[i]);
        try run.commit(id, c) { runnerBad[id][i] = bad; } catch {}
    }

    function runnerReveal(uint256 r, uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        uint256 i = r % 3;
        vm.prank(runnersA[i]);
        try run.reveal(id, _result(runnerBad[id][i]), bytes32(uint256(7))) {} catch {}
    }

    // ------------------------------------------------------------------ judges, appeals

    /// The three judges vote the same outcome on a finding (a decision).
    function judgeFinding(uint256 seed, bool valid, uint8 sev) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        sev = uint8(bound(sev, 1, 5));
        AuditNetwork.Finding memory before = net.getFinding(fid);
        for (uint256 i; i < 3; i++) {
            vm.prank(judgesA[i]);
            try jud.voteFinding(fid, valid, sev, fid) {} catch { return; }
        }
        AuditNetwork.Finding memory f = net.getFinding(fid);
        if (before.status == 2 && f.late && f.status == 3 && f.sev >= 4) {
            AuditNetwork.Request memory r = net.getRequest(f.req);
            revokedTargets.push(r.target);
        }
    }

    function rejectReport(uint256 a, uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        for (uint256 i; i < 3; i++) {
            vm.prank(judgesA[i]);
            try jud.voteReport(id, auditorsA[a % 4], false) {} catch { return; }
        }
    }

    function appeal(uint256 seed) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        vm.prank(appellant);
        try jud.appeal{value: 5 ether}(fid) { ghostIn += 5 ether; } catch {}
    }

    function resolveAppeal(uint256 seed, bool valid, uint8 sev) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        sev = uint8(bound(sev, 1, 5));
        AuditNetwork.Finding memory before = net.getFinding(fid);
        vm.prank(gov);
        try jud.resolveAppeal(fid, valid, sev, fid) {} catch { return; }
        AuditNetwork.Finding memory f = net.getFinding(fid);
        if (f.late && f.status == 3 && f.sev >= 4 && !(before.status == 3 && before.sev >= 4)) revokedTargets.push(net.getRequest(f.req).target);
    }

    // ------------------------------------------------------------------ time, settlement, certificates

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1 hours, 4 days));
        vm.roll(block.number + 1);
    }

    function settle(uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        try run.settle(id) {} catch {}
        try net.settle(id) {} catch {}
    }

    function certify(uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        try cert.certify(id) {
            AuditNetwork.Request memory r = net.getRequest(id);
            (bool ag, IACRunners.Result memory res) = IACRunners(address(run)).result(id);
            if (!ag || res.critHigh != 0 || r.critHigh != 0 || r.undecided != 0 || r.openAppeals != 0) certWithOpenCritical++;
            certified++;
        } catch {}
    }

    /// A whole request in one step (so random runs reach settlement and certificates often): request, two or three
    /// reports, an optional finding, three runner seats (one may disagree, or all may report a critical), reveals,
    /// the judges' decision, settlement, then a certification attempt.
    function lifecycle(uint256 s, uint256 t, uint256 value, uint8 sev, uint8 shape) external {
        uint256 before = net.requestCount();
        this.request(s, t, value);
        if (net.requestCount() == before) return;
        uint256 id = before;
        uint256 seed = id; // _req(seed) == id while id is the newest
        for (uint256 a; a < 2 + (shape % 2); a++) this.commitReport(a, seed);
        bool finding = shape & 2 != 0;
        uint256 nf = net.findingCount();
        if (finding) this.commitFinding(2, seed, sev);
        finding = finding && net.findingCount() > nf;
        uint256 fid = nf;
        for (uint256 r; r < 3; r++) this.runnerCommit(r, seed, shape & 4 != 0 && (r == 0 || shape & 8 != 0));
        vm.warp(block.timestamp + 3 days);
        for (uint256 a; a < 3; a++) this.revealReport(a, seed);
        if (finding) this.revealFinding(fid);
        for (uint256 r; r < 3; r++) this.runnerReveal(r, seed);
        if (finding) this.judgeFinding(fid, shape & 16 != 0, sev);
        vm.warp(block.timestamp + 5 days);
        this.settle(seed);
        this.certify(seed);
    }

    /// A finding committed, revealed and judged in one step (after a certificate: a post-certificate one).
    function findingRound(uint256 a, uint256 seed, uint8 sev, bool valid) external {
        uint256 nf = net.findingCount();
        this.commitFinding(a, seed, sev);
        if (net.findingCount() == nf) return;
        this.revealFinding(nf);
        this.judgeFinding(nf, valid, sev);
    }

    // ------------------------------------------------------------------ money out

    function claimFinding(uint256 seed) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        AuditNetwork.Finding memory f = net.getFinding(fid);
        uint256 before = net.owed(f.auditor);
        try net.claimFinding(fid) { paidFromPool[f.req] += net.owed(f.auditor) - before; } catch {}
    }

    function claimReport(uint256 a, uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        address who = auditorsA[a % 4];
        uint256 before = net.owed(who);
        vm.prank(who);
        try net.claimReport(id) { paidFromPool[id] += net.owed(who) - before; } catch {}
    }

    function claimSlash(uint256 seed) external {
        (uint256 fid, bool ok) = _fid(seed);
        if (!ok) return;
        try net.claimSlash(fid) {} catch {}
    }

    function reclaim(uint256 seed) external {
        (uint256 id, bool ok) = _req(seed);
        if (!ok) return;
        address sp = net.getRequest(id).sponsor;
        uint256 before = net.owed(sp);
        vm.prank(sp); // net.reclaim is the next call
        try net.reclaim(id) { paidFromPool[id] += net.owed(sp) - before; } catch {}
    }

    function withdraw(uint256 who, uint8 which) external {
        address[13] memory all = [sponsors[0], sponsors[1], auditorsA[0], auditorsA[1], auditorsA[2], auditorsA[3], judgesA[0], judgesA[1], judgesA[2],
            runnersA[0], runnersA[1], runnersA[2], appellant];
        address a = all[who % 13];
        uint256 b = a.balance;
        vm.prank(a);
        if (which % 3 == 0) { try net.withdraw() {} catch {} }
        else if (which % 3 == 1) { try run.withdraw() {} catch {} }
        else { try jud.withdraw() {} catch {} }
        ghostOut += a.balance - b;
    }

    // ------------------------------------------------------------------ views for the invariants

    function revokedCount() external view returns (uint256) { return revokedTargets.length; }

    /// Everyone who can be owed anything.
    function people() external view returns (address[] memory p) {
        p = new address[](15);
        p[0] = sponsors[0]; p[1] = sponsors[1];
        for (uint256 i; i < 4; i++) p[2 + i] = auditorsA[i];
        for (uint256 i; i < 3; i++) p[6 + i] = judgesA[i];
        for (uint256 i; i < 3; i++) p[9 + i] = runnersA[i];
        p[12] = appellant; p[13] = treasury; p[14] = gov;
    }
}

contract AuditNetworkInvariants is Test {
    AuditNetwork net;
    AuditRunners run;
    AuditJudges jud;
    AuditCertificate cert;
    AuditHandler h;
    MockRunners jobs;
    address gov = address(0x60F);
    address treasury = address(0x7EA);

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(100);
        jobs = new MockRunners();
        address[2] memory tg = [address(new AuditTarget()), address(new AuditTarget2())];
        uint64 n = vm.getNonce(address(this));
        address pRun = vm.computeCreateAddress(address(this), n + 1);
        address pJud = vm.computeCreateAddress(address(this), n + 2);
        address pCert = vm.computeCreateAddress(address(this), n + 3);
        net = new AuditNetwork(gov, treasury, IANReputation(address(0)), IANPot(pRun), IANPot(pJud), IANCertificate(pCert), AuditNetwork.Params({
            minContest: 3 days, maxContest: 30 days, revealWindow: 1 days, judgeWindow: 2 days, appealWindow: 2 days, appealTimeout: 7 days,
            unbondDelay: 1 days, minAuditorsFloor: 2, slashBps: 2000, feeBps: 1000, runnerBps: 5000, participationBps: 1000,
            maxFindingsPerAuditor: 5, auditorBond: 10 ether, minPool: 1 ether }));
        run = new AuditRunners(IARNetwork(address(net)), IARJobs(address(jobs)), IARReputation(address(0)), 1);
        jud = new AuditJudges(IAJNetwork(address(net)), IAJReputation(address(0)), gov, AuditJudges.Params({
            judgeQuorum: 3, maxJudges: 9, judgeMinScore: 0, unbondDelay: 1 days, judgeBond: 20 ether, appealBond: 5 ether }));
        cert = new AuditCertificate(IACNetwork(address(net)), IACRunners(address(run)), IACJudges(address(jud)), gov, AuditCertificate.Levels({
            validity: 30 days, silverAuditors: 3, goldAuditors: 5, silverContest: 7 days, goldContest: 14 days, silverMutationBps: 7000, goldMutationBps: 8500 }));
        require(address(run) == pRun && address(jud) == pJud && address(cert) == pCert, "addresses");
        h = new AuditHandler(net, run, jud, cert, gov, treasury, tg);
        for (uint256 i; i < 3; i++) jobs.set(h.runnersA(i), true, 5, 0);
        targetContract(address(h));
    }

    /// Credited balances and bonds are always backed: AuditNetwork holds at least every owed balance, every
    /// auditor bond and every escrowed slash; AuditRunners every owed balance; AuditJudges every owed balance and
    /// every judge bond.
    function invariant_creditsBacked() public view {
        address[] memory p = h.people();
        uint256 netOwed;
        uint256 runOwed;
        uint256 judOwed;
        uint256 bonds;
        uint256 judgeBonds;
        for (uint256 i; i < p.length; i++) {
            netOwed += net.owed(p[i]);
            runOwed += run.owed(p[i]);
            judOwed += jud.owed(p[i]);
            (uint128 b, , ) = net.auditors(p[i]);
            bonds += b;
            (uint128 jb, , , , ) = jud.judges(p[i]);
            judgeBonds += jb;
        }
        uint256 escrow;
        uint256 nf = net.findingCount();
        for (uint256 i; i < nf; i++) escrow += net.getFinding(i).slashed;
        uint256 nr = net.requestCount();
        for (uint256 i; i < nr; i++) escrow += net.getRequest(i).reportSlash;
        assertGe(address(net).balance, netOwed + bonds + escrow, "AuditNetwork: credits, bonds and escrow backed");
        assertGe(address(run).balance, runOwed, "AuditRunners: credits backed");
        assertGe(address(jud).balance, judOwed + judgeBonds, "AuditJudges: credits and bonds backed");
    }

    /// No payout exceeds deposits: a request never pays out more than its pool, and nobody ever withdrew more than
    /// was paid in.
    function invariant_noPayoutExceedsDeposits() public view {
        uint256 nr = net.requestCount();
        for (uint256 i; i < nr; i++) assertLe(h.paidFromPool(i), net.getRequest(i).pool, "a request paid more than its pool");
        assertLe(h.ghostOut(), h.ghostIn(), "withdrawn more than deposited");
        assertEq(address(net).balance + address(run).balance + address(jud).balance, h.ghostIn() - h.ghostOut(), "conservation");
    }

    /// A certificate never issues with an open critical (checked at every issuance and for every issued request).
    function invariant_noCertificateWithOpenCritical() public view {
        assertEq(h.certWithOpenCritical(), 0, "certified with an open critical/high");
        uint256 nr = net.requestCount();
        for (uint256 i; i < nr; i++) {
            if (!cert.issued(i)) continue;
            AuditNetwork.Request memory r = net.getRequest(i);
            assertEq(r.critHigh, 0, "issued with a valid critical/high");
            assertEq(r.undecided, 0, "issued with an undecided finding");
            (bool agreed, IACRunners.Result memory res) = IACRunners(address(run)).result(i);
            assertTrue(agreed && res.critHigh == 0, "issued without an agreed clean automated tier");
        }
    }

    /// The handler reaches what the properties are about (a fixed sequence, so this never depends on the fuzzer's luck).
    function test_handlerReachesCertificatesAndRevocations() public {
        h.lifecycle(0, 0, 10 ether, 2, 0);   // clean: certified
        assertEq(h.certified(), 1);
        assertTrue(cert.isCertified(uint64(block.chainid), h.targets(0)));
        h.lifecycle(1, 1, 10 ether, 4, 2 | 16); // a valid high in the contest: refused
        assertEq(h.certified(), 1);
        h.lifecycle(1, 1, 10 ether, 4, 4 | 8); // the automated tier reports a critical: refused
        assertEq(h.certified(), 1);
        // a post-certificate critical against request 0, judged valid: revoked
        h.commitFinding(3, 0, 5);
        uint256 fid = net.findingCount() - 1;
        h.revealFinding(fid);
        h.judgeFinding(fid, true, 5);
        assertEq(h.revokedCount(), 1);
        assertFalse(cert.isCertified(uint64(block.chainid), h.targets(0)));
        vm.warp(block.timestamp + 2 days); // its appeal window
        h.claimFinding(fid);
        assertGt(h.paidFromPool(0), 0);
        invariant_creditsBacked();
        invariant_noPayoutExceedsDeposits();
        invariant_noCertificateWithOpenCritical();
        invariant_revokedStaysRevoked();
    }

    /// A certificate hit by a valid post-certificate critical/high is never valid again (its code hash is revoked).
    function invariant_revokedStaysRevoked() public view {
        uint256 n = h.revokedCount();
        for (uint256 i; i < n; i++) assertFalse(cert.isCertified(uint64(block.chainid), h.revokedTargets(i)), "a revoked certificate holds");
    }
}
