// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BridgeGuard, BridgedToken} from "../../contracts/BridgeGuard.sol";
import {BridgeAirlock, IGuardInbound} from "../../contracts/BridgeAirlock.sol";
import {HyperlaneLockBoxV2, ISaphanMailbox, ISaphanIsm} from "../../contracts/HyperlaneLockBoxV2.sol";
import {MockMailbox} from "../../contracts/MockMailbox.sol";

// ============================================================================ BridgeAirlock -> BridgeGuard

contract BridgeHandler is Test {
    BridgeGuard public guard;
    BridgeAirlock public airlock;
    BridgedToken public token;
    address public gov;
    address public guardian = address(0x6A);
    address public vetoer = address(0x7E);
    address public marker = address(0x3A);
    address public outbox = address(0x0B0);   // the outbound-only route's adapter
    address[3] public lanes = [address(0x1A1), address(0x1A2), address(0x1A3)];
    address[4] public users = [address(0xC1), address(0xC2), address(0xC3), address(0xC4)];
    bytes32 public constant ROUTE = "in";
    bytes32 public constant OUT = "out";

    struct T { uint256 nonce; address sender; address to; uint256 amount; }
    T[] public ts;

    uint256 public ghostMinted;
    uint256 public ghostBurned;
    mapping(uint256 => uint256) public dayMinted;     // UTC day -> minted by released transfers
    mapping(uint256 => uint256) public dayCapMax;     // UTC day -> highest maxDailyLimit seen at a mint
    uint256 public violations;                         // any release that broke a rule
    uint256 public overDayCap;
    uint256 public movedWhilePaused;

    constructor(BridgeGuard g, BridgeAirlock a, address gov_) {
        guard = g;
        airlock = a;
        gov = gov_;
        token = g.token();
    }

    function newTransfer(uint256 senderSeed, uint256 toSeed, uint256 amount, uint256 laneMask) external {
        amount = bound(amount, 1, 600e18);
        T memory t = T(ts.length, users[senderSeed % 4], users[toSeed % 4], amount);
        ts.push(t);
        for (uint256 i; i < 3; i++) if (laneMask & (1 << i) != 0) _attest(ts.length - 1, i);
    }

    function attest(uint256 tSeed, uint256 laneSeed) external {
        if (ts.length == 0) return;
        _attest(tSeed % ts.length, laneSeed % 3);
    }

    /// A lane that lies: attests a transfer that never happened (different amount).
    function forge(uint256 tSeed, uint256 laneSeed, uint256 amount) external {
        if (ts.length == 0) return;
        T memory t = ts[tSeed % ts.length];
        vm.prank(lanes[laneSeed % 3]);
        try airlock.attest(1, address(0x50C), t.nonce, t.sender, t.to, bound(amount, 1, 1e24)) {} catch {}
    }

    function _attest(uint256 i, uint256 lane) internal {
        T memory t = ts[i];
        vm.prank(lanes[lane]);
        try airlock.attest(1, address(0x50C), t.nonce, t.sender, t.to, t.amount) {} catch {}
    }

    struct Snap { uint8 att; bool released; bool vetoed; uint64 readyAt; bool tripped; uint8 th; bool paused; uint256 cap; uint256 supply; }

    function _snap(T memory t) internal view returns (Snap memory x) {
        bytes32 id = airlock.transferId(1, address(0x50C), t.nonce, t.sender, t.to, t.amount);
        (x.att, x.released, x.vetoed, x.readyAt) = airlock.status(id);
        x.tripped = airlock.tripped(t.sender) || airlock.tripped(t.to);
        x.th = airlock.threshold();
        x.paused = guard.paused();
        x.cap = guard.maxDailyLimit();
        x.supply = token.totalSupply();
    }

    function release(uint256 tSeed) external {
        if (ts.length == 0) return;
        T memory t = ts[tSeed % ts.length];
        Snap memory x = _snap(t);
        try airlock.release(1, address(0x50C), t.nonce, t.sender, t.to, t.amount) {
            if (x.released || x.vetoed || x.tripped || x.att < x.th || x.readyAt == 0 || block.timestamp < x.readyAt) violations++;
            if (x.paused) movedWhilePaused++;
            _recordMint(token.totalSupply() - x.supply, x.cap);
        } catch {}
    }

    function _recordMint(uint256 minted, uint256 cap) internal {
        ghostMinted += minted;
        uint256 day = block.timestamp / 1 days;
        dayMinted[day] += minted;
        if (cap > dayCapMax[day]) dayCapMax[day] = cap;
        if (dayMinted[day] > dayCapMax[day]) overDayCap++;
    }

    function veto(uint256 tSeed) external {
        if (ts.length == 0) return;
        T memory t = ts[tSeed % ts.length];
        bytes32 id = airlock.transferId(1, address(0x50C), t.nonce, t.sender, t.to, t.amount);
        vm.prank(vetoer);
        try airlock.veto(id, "x") {} catch {}
    }

    function trip(uint256 userSeed) external {
        vm.prank(marker);
        airlock.trip(users[userSeed % 4]);
    }

    function untrip(uint256 userSeed) external {
        vm.prank(gov);
        airlock.untrip(users[userSeed % 4]);
    }

    function burn(uint256 userSeed, uint256 amount) external {
        address u = users[userSeed % 4];
        uint256 bal = token.balanceOf(u);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bool paused = guard.paused();
        vm.prank(outbox);
        try guard.outbound(OUT, u, amount) {
            ghostBurned += amount;
            if (paused) movedWhilePaused++;
        } catch {}
    }

    function pause() external { vm.prank(guardian); guard.pause(); }
    function unpause() external { vm.prank(gov); guard.unpause(); }

    function lowerCap(uint256 v) external {
        uint256 cur = guard.maxDailyLimit();
        if (cur == 0) return;
        vm.prank(guardian);
        guard.lowerMaxDailyLimit(uint128(bound(v, 0, cur - 1)));
    }

    function raiseCap(uint256 v) external {
        uint256 cur = guard.maxDailyLimit();
        vm.prank(gov);
        try guard.proposeMaxDailyLimit(uint128(bound(v, cur + 1, cur * 2 + 1000e18))) {} catch {}
    }

    function applyCap() external {
        try guard.applyMaxDailyLimit() {} catch {}
    }

    function raiseThreshold() external {
        uint8 next = airlock.threshold() + 1;
        vm.prank(guardian);
        try airlock.emergencyRaiseThreshold(next) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract BridgeInvariants is Test {
    BridgeGuard guard;
    BridgeAirlock airlock;
    BridgeHandler h;
    address gov = address(0x60F);

    function setUp() public {
        vm.warp(1_700_000_000);
        guard = new BridgeGuard(gov);
        vm.startPrank(gov);
        guard.createToken("Bridged", "bZ", 18); // hard cap 1,000 tokens / day
        guard.setAudit("https://example.org/audit.pdf", keccak256("report"));
        vm.stopPrank();
        airlock = new BridgeAirlock(IGuardInbound(address(guard)), "in", gov, 2, 1 hours);
        h = new BridgeHandler(guard, airlock, gov);
        vm.startPrank(gov);
        for (uint256 i; i < 3; i++) airlock.setLane(h.lanes(i), true);
        airlock.setVetoer(h.vetoer(), true);
        airlock.setMarker(h.marker(), true);
        guard.setGuardian(h.guardian(), true);
        guard.setRoute("in", address(airlock), 800e18, true);
        vm.etch(h.outbox(), hex"00"); // the outbound adapter must be a contract
        guard.setOutboundRoute("out", h.outbox(), 800e18, true);
        vm.stopPrank();
        targetContract(address(h));
    }

    function test_handlerReachesReleaseAndBurn() public {
        h.newTransfer(0, 1, 100e18, 3);
        h.warp(2 hours);
        h.release(0);
        h.burn(1, 10e18);
        assertEq(h.ghostMinted(), 100e18);
        assertEq(h.ghostBurned(), 10e18);
    }

    /// Supply = everything released - everything burned (nothing else mints or burns).
    function invariant_supplyMatchesFlows() public view {
        assertEq(guard.token().totalSupply(), h.ghostMinted() - h.ghostBurned());
    }

    /// No release without `threshold` independent attestations, the quarantine, no veto and no mark;
    /// never twice.
    function invariant_releaseRules() public view {
        assertEq(h.violations(), 0);
    }

    /// Per UTC day, minted <= the highest hard cap in force at a mint that day (cap is global).
    function invariant_dailyCap() public view {
        assertEq(h.overDayCap(), 0);
        assertLe(guard.totalInToday(), uint256(type(uint128).max));
    }

    /// Paused: nothing mints, nothing burns.
    function invariant_pauseStopsEverything() public view {
        assertEq(h.movedWhilePaused(), 0);
    }
}

// ============================================================================ HyperlaneLockBoxV2

contract LockBoxHandler is Test {
    HyperlaneLockBoxV2 public box;
    MockMailbox public mailbox;
    address public gov;
    address public guardian;
    bytes32 public remote;
    uint256 public zChain = 77390;
    address[3] public users = [address(0xD1), address(0xD2), address(0xD3)];

    bytes32[] public ids;
    uint256 public outNonce;
    uint256 public ghostLocked;
    uint256 public ghostClaimed;
    mapping(uint256 => uint256) public dayClaimed;
    uint256 public overDaily;
    uint256 public badClaims;       // vetoed / not ready / paused / twice
    uint256 public forgedQueued;    // a message from a wrong sender or source got queued

    constructor(HyperlaneLockBoxV2 b, MockMailbox m, address g, address gd, bytes32 r) {
        box = b;
        mailbox = m;
        gov = g;
        guardian = gd;
        remote = r;
        for (uint256 i; i < 3; i++) vm.deal(users[i], 1e30);
    }

    function lock(uint256 u, uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        uint256 fee = mailbox.fee();
        vm.prank(users[u % 3]);
        try box.lock{value: amount + fee + 7}(users[(u + 1) % 3], amount) { ghostLocked += amount; } catch {}
    }

    function _body(address to, uint256 amount, bytes32 sender) internal returns (bytes memory) {
        return abi.encode(zChain, address(uint160(uint256(sender))), outNonce++, users[0], to, amount, block.chainid, address(box));
    }

    /// A release message from ZETAPHY (the real outbox, verified by the ISM, so the Mailbox delivers it).
    function release(uint256 u, uint256 amount) external {
        amount = bound(amount, 1, 150 ether);
        bytes memory b = _body(users[u % 3], amount, remote);
        vm.prank(address(mailbox));
        try box.handle(77390, remote, b) { ids.push(keccak256(b)); } catch {}
    }

    /// Forged: another sender on ZETAPHY, or the right sender but the body names another source.
    function forged(uint256 u, uint256 amount, bool wrongSenderArg) external {
        amount = bound(amount, 1, 150 ether);
        bytes32 evil = bytes32(uint256(0xE7));
        bytes memory b = _body(users[u % 3], amount, wrongSenderArg ? remote : evil);
        vm.prank(address(mailbox));
        try box.handle(77390, wrongSenderArg ? evil : remote, b) { forgedQueued++; } catch {}
    }

    function claim(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        (address to, uint64 readyAt, bool claimed, bool vetoed, uint256 amount) = box.releases(id);
        bool paused = box.paused();
        uint256 limit = box.dailyLimit();
        uint256 before = to.balance;
        try box.claim(id) {
            if (claimed || vetoed || paused || block.timestamp < readyAt) badClaims++;
            if (to.balance - before != amount) badClaims++;
            ghostClaimed += amount;
            uint256 d = block.timestamp / 1 days;
            dayClaimed[d] += amount;
            if (dayClaimed[d] > limit) overDaily++;
        } catch {}
    }

    function veto(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(guardian);
        try box.veto(ids[seed % ids.length]) {} catch {}
    }

    function liftVeto(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(gov);
        try box.liftVeto(ids[seed % ids.length]) {} catch {}
    }

    function pause() external { vm.prank(guardian); box.pause(); }
    function unpause() external { vm.prank(gov); box.unpause(); }

    function lowerLimit(uint256 v) external {
        uint256 cur = box.dailyLimit();
        if (cur == 0) return;
        vm.prank(guardian);
        box.lowerDailyLimit(bound(v, 0, cur - 1));
    }

    function warp(uint256 secs) external { vm.warp(block.timestamp + bound(secs, 1, 2 days)); }
}

contract LockBoxInvariants is Test {
    HyperlaneLockBoxV2 box;
    MockMailbox mailbox;
    LockBoxHandler h;
    address gov = address(0x60F);
    address guardian = address(0x6A);
    bytes32 remote = bytes32(uint256(0x0B0B));

    function setUp() public {
        vm.warp(1_700_000_000);
        mailbox = new MockMailbox(11155111);
        mailbox.setFee(0.01 ether);
        box = new HyperlaneLockBoxV2(ISaphanMailbox(address(mailbox)), 77390, 77390, bytes32(uint256(0x1A)), remote, address(0),
            ISaphanIsm(address(0x15A)), gov, guardian, 200 ether, 1 hours);
        h = new LockBoxHandler(box, mailbox, gov, guardian, remote);
        targetContract(address(h));
    }

    function test_handlerReachesClaim() public {
        h.lock(0, 50 ether);
        h.release(1, 20 ether);
        h.warp(2 hours);
        h.claim(0);
        assertEq(h.ghostClaimed(), 20 ether);
    }

    /// Backing: the box holds exactly `locked` (locks - claims), and claims never exceed locks.
    function invariant_backing() public view {
        assertEq(address(box).balance, box.locked());
        assertEq(box.locked(), h.ghostLocked() - h.ghostClaimed());
        assertLe(h.ghostClaimed(), h.ghostLocked());
    }

    /// A claim pays once, only when ready, unvetoed and unpaused, and within the day's limit.
    function invariant_claimRules() public view {
        assertEq(h.badClaims(), 0);
        assertEq(h.overDaily(), 0);
    }

    /// Only the configured outbox, with a body naming ZETAPHY + that outbox, gets a release queued.
    function invariant_noForgedQueue() public view {
        assertEq(h.forgedQueued(), 0);
    }
}

/// FINDING BA-1 (Low): removing a lane (governance setLane(false) or a guardian's emergencyRemoveLane)
/// does not withdraw the attestations it already gave. A lane caught lying is removed, but its vote on
/// a pending forged transfer still counts: one more lane (e.g. a second compromised or newly added
/// one) completes the threshold. Vetoing each pending transfer is the only remedy today.
contract BridgeAirlockRemovedLaneStillCounts is Test {
    function test_finding_removedLaneAttestationCounts() public {
        vm.warp(1_700_000_000);
        address gov = address(0x60F);
        BridgeGuard guard = new BridgeGuard(gov);
        vm.startPrank(gov);
        guard.createToken("B", "B", 18);
        guard.setAudit("https://example.org/audit.pdf", keccak256("r"));
        BridgeAirlock al = new BridgeAirlock(IGuardInbound(address(guard)), "in", gov, 2, 1 hours);
        al.setLane(address(0x1A1), true);
        al.setLane(address(0x1A2), true);
        al.setLane(address(0x1A3), true);
        guard.setRoute("in", address(al), 500e18, true);
        vm.stopPrank();
        // lane 1 is compromised and attests a transfer that never happened
        vm.prank(address(0x1A1));
        al.attest(1, address(0x50C), 99, address(0xEE), address(0xEE), 400e18);
        // it is caught and removed
        vm.prank(gov);
        al.setLane(address(0x1A1), false);
        // a second dishonest lane attests the same forged transfer: threshold reached
        vm.prank(address(0x1A2));
        al.attest(1, address(0x50C), 99, address(0xEE), address(0xEE), 400e18);
        vm.warp(block.timestamp + 1 hours);
        al.release(1, address(0x50C), 99, address(0xEE), address(0xEE), 400e18);
        assertEq(guard.token().balanceOf(address(0xEE)), 400e18, "minted on a removed lane's vote");
    }
}
