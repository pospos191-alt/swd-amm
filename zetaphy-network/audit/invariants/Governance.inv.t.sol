// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../../contracts/RewardVault.sol";
import {SimpleMultisig} from "../../contracts/SimpleMultisig.sol";
import {ZetaphyTimelock} from "../../contracts/ZetaphyTimelock.sol";
import {Receiver} from "./utils/Mocks.sol";

// ============================================================================ RewardVault

contract VaultHandler is Test {
    RewardVault public v;
    address public gov;
    Receiver[3] public rcv;
    uint256 public ghostIn;          // everything sent to the vault
    uint256 public ghostOut;         // everything recipients received
    // schedule window: since the last deposit, how much was released and from what balance
    uint256 public windowStartDay;
    uint256 public windowStartBal;
    uint256 public windowReleased;
    bool public windowOpen;
    uint256 public worstExcess;      // released - allowed(10%/365 days), max seen (0 = never exceeded)

    constructor(RewardVault v_, address gov_, Receiver[3] memory r) {
        v = v_;
        gov = gov_;
        rcv = r;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1e27);
        vm.deal(address(this), amount);
        (bool ok,) = address(v).call{value: amount}("");
        require(ok);
        ghostIn += amount;
        // a new window starts at the next release (see release())
        windowOpen = false;
    }

    function release() external {
        if (!windowOpen) {
            // settle what vested before this window, then start measuring from here
            uint256 paid0 = _received();
            v.release();
            ghostOut += _received() - paid0;
            windowOpen = true;
            windowStartDay = v.daysElapsed();
            windowStartBal = address(v).balance;
            windowReleased = 0;
            return;
        }
        uint256 before = address(v).balance;
        uint256 paid = _received();
        v.release();
        uint256 got = _received() - paid;
        ghostOut += got;
        windowReleased += before - address(v).balance;
        uint256 d = v.daysElapsed() - windowStartDay;
        // 10% of the remainder per year, compounding daily: over d <= 365 days at most
        // 10% of the window's starting balance (+1 wei of rounding per release step).
        if (d <= 365) {
            uint256 allowed = windowStartBal / 10 + d + 1;
            if (windowReleased > allowed && windowReleased - allowed > worstExcess) worstExcess = windowReleased - allowed;
        }
    }

    function refuse(uint256 i, bool on) external {
        rcv[i % 3].setRefuse(on);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 60 days));
    }

    function proposeAndApply(uint16 a) external {
        a = uint16(bound(a, 1, 9999));
        RewardVault.Share[] memory s = new RewardVault.Share[](2);
        s[0] = RewardVault.Share(address(rcv[0]), a, false);
        s[1] = RewardVault.Share(address(rcv[1]), 10_000 - a, false);
        vm.prank(gov);
        v.proposeShares(s);
        vm.warp(block.timestamp + 7 days);
        uint256 paid = _received();
        v.applyShares();
        ghostOut += _received() - paid;
        windowOpen = false; // applyShares released (a new window starts at the next release)
    }

    function _received() internal view returns (uint256 s) {
        for (uint256 i; i < 3; i++) s += address(rcv[i]).balance;
    }
}

contract RewardVaultInvariants is Test {
    RewardVault v;
    VaultHandler h;
    address gov = address(0x60F);

    function setUp() public {
        Receiver[3] memory r = [new Receiver(), new Receiver(), new Receiver()];
        RewardVault.Share[] memory s = new RewardVault.Share[](3);
        s[0] = RewardVault.Share(address(r[0]), 5000, false);
        s[1] = RewardVault.Share(address(r[1]), 3000, false);
        s[2] = RewardVault.Share(address(r[2]), 2000, false);
        v = new RewardVault(gov, s);
        h = new VaultHandler(v, gov, r);
        targetContract(address(h));
    }

    /// Conservation: in = vault balance + paid to recipients (no withdraw path, nothing else leaves).
    function invariant_conservation() public view {
        assertEq(h.ghostIn(), address(v).balance + h.ghostOut());
    }

    /// The schedule: with no deposit in between, at most 10% of the balance leaves in any 365 days.
    function invariant_scheduleAtMost10PercentPerYear() public view {
        assertEq(h.worstExcess(), 0);
    }

    /// The releases never run ahead of the clock.
    function invariant_releasedDaysNotAhead() public view {
        assertLe(v.releasedDays(), v.daysElapsed());
    }
}

/// FINDING RV-1 (Low): the release rate applies retroactively to money that arrives after the last
/// release. A vault whose release() was not called for N days pays out (1 - 0.9^(N/365)) of a deposit
/// made just now, at the very next release, instead of starting that deposit's schedule at deposit time.
contract RewardVaultRetroactiveRelease is Test {
    function test_finding_depositIsReleasedRetroactively() public {
        Receiver r = new Receiver();
        RewardVault.Share[] memory s = new RewardVault.Share[](1);
        s[0] = RewardVault.Share(address(r), 10_000, false);
        RewardVault v = new RewardVault(address(this), s);
        // deployed, nobody funds it or calls release() for 2 years
        vm.warp(block.timestamp + 730 days);
        // the 500M pool arrives now
        vm.deal(address(this), 500_000_000 ether);
        (bool ok,) = address(v).call{value: 500_000_000 ether}("");
        assertTrue(ok);
        v.release();
        // 19% of the pool leaves at once (1 - 0.9^2), although it was deposited a second ago
        assertGt(address(r).balance, 94_000_000 ether);
        emit log_named_decimal_uint("released immediately (ZETAPHY)", address(r).balance, 18);
    }
}

// ============================================================================ SimpleMultisig

contract Counter {
    uint256 public n;
    function bump() external { n++; }
}

contract MultisigHandler is Test {
    SimpleMultisig public m;
    Counter public counter;
    address[] public everOwners;
    // ghost: proposals that executed while fewer than threshold CURRENT owners had confirmed them
    uint256 public executedWithoutCurrentQuorum;

    constructor(SimpleMultisig m_, Counter c, address[] memory owners) {
        m = m_;
        counter = c;
        for (uint256 i; i < owners.length; i++) everOwners.push(owners[i]);
    }

    function _currentOwners() internal view returns (address[] memory o) {
        uint256 n = m.ownerCount();
        o = new address[](n);
        for (uint256 i; i < n; i++) o[i] = m.owners(i);
    }

    function _anyOwner(uint256 seed) internal view returns (address) {
        address[] memory o = _currentOwners();
        return o[seed % o.length];
    }

    function propose(uint256 seed) external {
        vm.prank(_anyOwner(seed));
        m.propose(address(counter), 0, abi.encodeCall(Counter.bump, ()));
    }

    /// A proposal that replaces the owner set (rotates out the first owner, keeps threshold 2).
    function proposeRotation(uint256 seed, uint160 fresh) external {
        address[] memory o = _currentOwners();
        address[] memory next = new address[](o.length);
        address newcomer = address(uint160(bound(fresh, 1e6, 1e6 + 50)));
        for (uint256 i; i < o.length; i++) next[i] = i == 0 ? newcomer : o[i];
        for (uint256 i = 1; i < o.length; i++) if (o[i] == newcomer) return;
        everOwners.push(newcomer);
        vm.prank(_anyOwner(seed));
        m.propose(address(m), 0, abi.encodeCall(SimpleMultisig.setOwners, (next, 2)));
    }

    function confirm(uint256 id, uint256 who) external {
        uint256 n = m.proposalCount();
        if (n == 0) return;
        vm.prank(everOwners[who % everOwners.length]);
        try m.confirm(id % n) {} catch {}
    }

    function revoke(uint256 id, uint256 who) external {
        uint256 n = m.proposalCount();
        if (n == 0) return;
        vm.prank(everOwners[who % everOwners.length]);
        try m.revoke(id % n) {} catch {}
    }

    function execute(uint256 id, uint256 who) external {
        uint256 n = m.proposalCount();
        if (n == 0) return;
        id = id % n;
        address[] memory o = _currentOwners();
        uint256 live;
        for (uint256 i; i < o.length; i++) if (m.confirmed(id, o[i])) live++;
        uint256 th = m.threshold();
        vm.prank(o[who % o.length]);
        try m.execute(id) {
            if (live < th) executedWithoutCurrentQuorum++;
        } catch {}
    }
}

contract SimpleMultisigInvariants is Test {
    SimpleMultisig m;
    Counter counter;
    MultisigHandler h;

    function setUp() public {
        address[] memory o = new address[](3);
        o[0] = address(0x101);
        o[1] = address(0x102);
        o[2] = address(0x103);
        m = new SimpleMultisig(o, 2);
        counter = new Counter();
        h = new MultisigHandler(m, counter, o);
        targetContract(address(h));
    }

    /// EXPECTED TO FAIL (finding SM-1): a proposal runs only with `threshold` confirmations of the
    /// owners at execution time. Confirmations of removed owners keep counting.
    function invariant_executeNeedsCurrentOwnersQuorum() public view {
        assertEq(h.executedWithoutCurrentQuorum(), 0, "executed with confirmations of removed owners");
    }

    /// threshold stays within [2, owners] and owners stay distinct and non-zero.
    function invariant_config() public view {
        uint256 n = m.ownerCount();
        assertGe(m.threshold(), 2);
        assertLe(m.threshold(), n);
        for (uint256 i; i < n; i++) {
            assertTrue(m.isOwner(m.owners(i)));
            for (uint256 k; k < i; k++) assertTrue(m.owners(i) != m.owners(k));
        }
    }
}

/// FINDING SM-1 (Medium), minimal reproduction: a compromised owner is removed by setOwners, but the
/// confirmation it already gave a pending (malicious) proposal still counts. One more confirmation from
/// a current owner (who may believe one other owner already reviewed it) runs it, and with threshold 2
/// that single current owner suffices.
contract SimpleMultisigStaleConfirmations is Test {
    function test_finding_removedOwnerConfirmationStillCounts() public {
        address a = address(0xA);
        address b = address(0xB);
        address c = address(0xC);
        address d = address(0xD);
        address[] memory o = new address[](3);
        (o[0], o[1], o[2]) = (a, b, c);
        SimpleMultisig m = new SimpleMultisig(o, 2);
        Counter target = new Counter();

        vm.prank(a); // a's key is stolen: the thief proposes (and so confirms) a call
        uint256 bad = m.propose(address(target), 0, abi.encodeCall(Counter.bump, ()));

        // b and c remove a (rotate in d)
        address[] memory next = new address[](3);
        (next[0], next[1], next[2]) = (d, b, c);
        vm.prank(b);
        uint256 rot = m.propose(address(m), 0, abi.encodeCall(SimpleMultisig.setOwners, (next, 2)));
        vm.prank(c);
        m.confirm(rot);
        vm.prank(b);
        m.execute(rot);
        assertFalse(m.isOwner(a));

        // the old proposal still shows 1 confirmation (a's); ONE current owner now runs it
        vm.prank(d);
        m.confirm(bad);
        vm.prank(d);
        m.execute(bad);
        assertEq(target.n(), 1, "ran with a removed owner's confirmation");
    }
}

// ============================================================================ ZetaphyTimelock

contract TimelockHandler is Test {
    ZetaphyTimelock public t;
    Counter public counter;
    address public proposer;
    uint256 public salt;
    mapping(bytes32 => uint256) public scheduledAt;
    mapping(bytes32 => uint256) public delayAt;
    bytes32[] public opIds;
    mapping(bytes32 => bytes32) public saltOf;
    uint256 public earlyExecutions;   // must stay 0
    uint256 public strangerSchedules; // must stay 0
    uint256 public executed;

    constructor(ZetaphyTimelock t_, Counter c, address p) {
        t = t_;
        counter = c;
        proposer = p;
    }

    function schedule(uint256 extra, bool asStranger) external {
        uint256 d = t.getMinDelay() + bound(extra, 0, 3 days);
        bytes memory data = abi.encodeCall(Counter.bump, ());
        bytes32 s = bytes32(++salt);
        bytes32 id = t.hashOperation(address(counter), 0, data, bytes32(0), s);
        vm.prank(asStranger ? address(0xBAD) : proposer);
        try t.schedule(address(counter), 0, data, bytes32(0), s, d) {
            if (asStranger) strangerSchedules++;
            scheduledAt[id] = block.timestamp;
            delayAt[id] = d;
            saltOf[id] = s;
            opIds.push(id);
        } catch {}
    }

    function execute(uint256 seed) external {
        if (opIds.length == 0) return;
        uint256 i = seed % opIds.length;
        bytes32 id = opIds[i];
        bytes memory data = abi.encodeCall(Counter.bump, ());
        vm.prank(address(0xE0E));
        try t.execute(address(counter), 0, data, bytes32(0), saltOf[id]) {
            if (block.timestamp < scheduledAt[id] + delayAt[id]) earlyExecutions++;
            executed++;
        } catch {}
    }

    function cancel(uint256 seed) external {
        if (opIds.length == 0) return;
        vm.prank(proposer);
        try t.cancel(opIds[seed % opIds.length]) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract ZetaphyTimelockInvariants is Test {
    ZetaphyTimelock t;
    Counter counter;
    TimelockHandler h;
    address proposer = address(0x9909);

    function setUp() public {
        counter = new Counter();
        address[] memory p = new address[](1);
        p[0] = proposer;
        address[] memory e = new address[](1);
        e[0] = address(0); // anyone executes
        t = new ZetaphyTimelock(2 days, p, e, address(0));
        h = new TimelockHandler(t, counter, proposer);
        targetContract(address(h));
    }

    /// No operation runs before its delay; only proposers schedule; executions == counter bumps.
    function invariant_delayRespected() public view {
        assertEq(h.earlyExecutions(), 0);
        assertEq(h.strangerSchedules(), 0);
        assertEq(counter.n(), h.executed());
    }

    /// No admin key: the timelock administers itself.
    function invariant_selfAdministered() public view {
        assertTrue(t.hasRole(t.DEFAULT_ADMIN_ROLE(), address(t)));
        assertEq(t.getRoleMemberCount(t.DEFAULT_ADMIN_ROLE()), 1);
    }
}
