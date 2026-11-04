// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Saphan PR 6, item S2: machine-checked invariants of a whole Saphan route (docs/SAPHAN-PR6.md). Both chains in one
// EVM, each with its own MockMailbox; the handler plays the relayer (delivers releases in any order, twice, never),
// two honest lanes, one LYING lane, users, guardians and time. From zetaphy-network/:
//   forge test --match-path 'audit/invariants/saphan/*'
// The same properties run in the normal JS suite (test/saphaninvariants.test.js) and are proven for all inputs of a
// bounded scenario with Halmos (SaphanSymbolic.t.sol in this folder).

import {Test} from "forge-std/Test.sol";
import {BridgeGuard, BridgedToken} from "../../../contracts/BridgeGuard.sol";
import {BridgeAirlock, IGuardInbound} from "../../../contracts/BridgeAirlock.sol";
import {HyperlaneLockBoxV2, HyperlaneOutbox, ISaphanMailbox, ISaphanIsm, IGuardOutbound} from "../../../contracts/HyperlaneLockBoxV2.sol";
import {MockMailbox} from "../../../contracts/MockMailbox.sol";

contract SaphanRouteHandler is Test {
    HyperlaneLockBoxV2 public box;
    HyperlaneOutbox public outbox;
    BridgeGuard public guard;
    BridgeAirlock public airlock;
    BridgedToken public token;
    MockMailbox public srcMailbox;
    address public gov;
    address public guardian;
    address[2] public honest = [address(0x1A1), address(0x1A2)];
    address public liar = address(0x1A3);
    address[3] public users = [address(0xD1), address(0xD2), address(0xD3)];

    struct Lock { uint256 nonce; address sender; uint256 amount; bool minted; }
    Lock[] public locks;
    bytes[] public bodies;           // release bodies the outbox sent
    mapping(uint256 => uint256) public deliveries;
    mapping(bytes32 => bool) public paid;

    uint256 public ghostLocked;
    uint256 public ghostMinted;
    uint256 public ghostBurned;
    uint256 public ghostClaimed;
    uint256 public ghostUnminted;
    uint256 public twice;            // a body delivered twice, a release paid twice, a lock minted twice
    uint256 public forgedMint;       // a lie that minted
    uint256 public overDay;
    mapping(uint256 => uint256) public dayClaimed;
    mapping(uint256 => uint256) public dayBoxLimitMax;
    mapping(uint256 => uint256) public dayMinted;
    mapping(uint256 => uint256) public dayGuardLimitMax;

    constructor(HyperlaneLockBoxV2 b, HyperlaneOutbox o, BridgeGuard g, BridgeAirlock a, MockMailbox m, address gov_, address guardian_) {
        box = b; outbox = o; guard = g; airlock = a; srcMailbox = m; gov = gov_; guardian = guardian_;
        token = g.token();
        for (uint256 i; i < 3; i++) vm.deal(users[i], 1e30);
    }

    function _today() internal view returns (uint256) { return block.timestamp / 1 days; }

    function lock(uint256 u, uint256 amount) external {
        amount = bound(amount, 1, 20 ether);
        address who = users[u % 3];
        uint256 n = box.nonce();
        vm.prank(who);
        try box.lock{value: amount}(who, amount) {
            locks.push(Lock(n, who, amount, false));
            ghostLocked += amount;
            ghostUnminted += amount;
        } catch {}
    }

    function attest(uint256 i, uint256 laneSeed) external {
        if (locks.length == 0) return;
        Lock memory l = locks[i % locks.length];
        vm.prank(honest[laneSeed % 2]);
        try airlock.attest(block.chainid, address(box), l.nonce, l.sender, l.sender, l.amount) {} catch {}
    }

    /// The lying lane attests a transfer that never happened (another amount or recipient), then tries to release it.
    function lie(uint256 i, uint256 amount, uint256 u) external {
        if (locks.length == 0) return;
        Lock memory l = locks[i % locks.length];
        amount = bound(amount, 1, 1000 ether);
        address to = users[u % 3];
        if (amount == l.amount && to == l.sender) return;
        vm.prank(liar);
        try airlock.attest(block.chainid, address(box), l.nonce, l.sender, to, amount) {} catch {}
        uint256 s = token.totalSupply();
        try airlock.release(block.chainid, address(box), l.nonce, l.sender, to, amount) {
            if (token.totalSupply() != s) forgedMint++;
        } catch {}
    }

    function release(uint256 i) external {
        if (locks.length == 0) return;
        uint256 k = i % locks.length;
        Lock storage l = locks[k];
        uint256 s = token.totalSupply();
        (, uint128 routeLimit,,,,) = guard.routes("in");
        uint256 cap = guard.maxDailyLimit() < routeLimit ? guard.maxDailyLimit() : routeLimit;
        try airlock.release(block.chainid, address(box), l.nonce, l.sender, l.sender, l.amount) {
            uint256 m = token.totalSupply() - s;
            if (l.minted) twice++;
            l.minted = true;
            ghostMinted += m;
            ghostUnminted -= l.amount;
            uint256 d = _today();
            dayMinted[d] += m;
            if (cap > dayGuardLimitMax[d]) dayGuardLimitMax[d] = cap;
            if (dayMinted[d] > dayGuardLimitMax[d]) overDay++;
        } catch {}
    }

    function burn(uint256 u, uint256 amount) external {
        address who = users[u % 3];
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bytes memory b = outbox.body(outbox.nonce(), who, who, amount);
        vm.prank(who);
        try outbox.send(who, amount) {
            bodies.push(b);
            ghostBurned += amount;
        } catch {}
    }

    /// The relayer delivers release k (verified by the ISM: the Mailbox calls handle), maybe again.
    function deliver(uint256 k) external {
        if (bodies.length == 0) return;
        k = k % bodies.length;
        vm.prank(address(srcMailbox));
        try box.handle(77390, bytes32(uint256(uint160(address(outbox)))), bodies[k]) {
            deliveries[k]++;
            if (deliveries[k] > 1) twice++;
        } catch {}
    }

    function claim(uint256 k) external {
        if (bodies.length == 0) return;
        bytes32 id = keccak256(bodies[k % bodies.length]);
        (address to,,,, uint256 amount) = box.releases(id);
        uint256 before = to.balance;
        uint256 lim = box.dailyLimit();
        try box.claim(id) {
            if (paid[id]) twice++;
            paid[id] = true;
            ghostClaimed += amount;
            if (to.balance - before != amount) twice++;
            uint256 d = _today();
            dayClaimed[d] += amount;
            if (lim > dayBoxLimitMax[d]) dayBoxLimitMax[d] = lim;
            if (dayClaimed[d] > dayBoxLimitMax[d]) overDay++;
        } catch {}
    }

    function veto(uint256 k) external {
        if (bodies.length == 0) return;
        vm.prank(guardian);
        try box.veto(keccak256(bodies[k % bodies.length])) {} catch {}
    }

    function pauseBox() external { vm.prank(guardian); box.pause(); }
    function unpauseBox() external { vm.prank(gov); box.unpause(); }
    function pauseGuard() external { vm.prank(gov); guard.pause(); }
    function unpauseGuard() external { vm.prank(gov); guard.unpause(); }

    function lowerBoxLimit(uint256 v) external {
        uint256 cur = box.dailyLimit();
        if (cur == 0) return;
        vm.prank(guardian);
        box.lowerDailyLimit(bound(v, 0, cur - 1));
    }

    function warp(uint256 secs) external { vm.warp(block.timestamp + bound(secs, 1, 2 days)); }
}

contract SaphanRouteInvariants is Test {
    SaphanRouteHandler h;
    HyperlaneLockBoxV2 box;
    BridgeGuard guard;
    address gov = address(0x60F);
    address guardian = address(0x6A);

    function setUp() public {
        vm.warp(1_700_000_000);
        MockMailbox srcMailbox = new MockMailbox(11155111);
        MockMailbox zMailbox = new MockMailbox(77390);
        guard = new BridgeGuard(gov);
        vm.startPrank(gov);
        guard.createToken("ETH from Sepolia (bridged)", "sepETH", 18); // hard cap 1,000 / day
        guard.setAudit("https://example.org/audit.pdf", keccak256("report"));
        vm.stopPrank();
        BridgeAirlock airlock = new BridgeAirlock(IGuardInbound(address(guard)), "in", gov, 2, 1 hours);
        // the outbox names the lockbox, the lockbox names the outbox: the lockbox's address is predicted
        address boxAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        HyperlaneOutbox outbox = new HyperlaneOutbox(IGuardOutbound(address(guard)), "out", ISaphanMailbox(address(zMailbox)), 11155111, block.chainid,
            bytes32(uint256(uint160(boxAt))), address(0));
        box = new HyperlaneLockBoxV2(ISaphanMailbox(address(srcMailbox)), 77390, block.chainid, bytes32(uint256(0x1A)),
            bytes32(uint256(uint160(address(outbox)))), address(0), ISaphanIsm(address(0x15A)), gov, guardian, 30 ether, 1 hours);
        require(address(box) == boxAt, "prediction");
        h = new SaphanRouteHandler(box, outbox, guard, airlock, srcMailbox, gov, guardian);
        vm.startPrank(gov);
        airlock.setLane(h.honest(0), true);
        airlock.setLane(h.honest(1), true);
        airlock.setLane(h.liar(), true);
        guard.setRoute("in", address(airlock), 50 ether, true);
        guard.setOutboundRoute("out", address(outbox), 50 ether, true);
        vm.stopPrank();
        targetContract(address(h));
    }

    function test_handlerReachesEveryState() public {
        h.lock(0, 10 ether);
        h.attest(0, 0);
        h.attest(0, 1);
        h.warp(2 hours);
        h.release(0);
        h.burn(0, 4 ether);
        h.deliver(0);
        h.deliver(0);               // a replay: refused
        h.warp(2 hours);
        h.claim(0);
        h.claim(0);                 // a second claim: refused
        assertEq(h.ghostMinted(), 10 ether);
        assertEq(h.ghostClaimed(), 4 ether);
        assertEq(h.deliveries(0), 1);
        assertEq(h.twice(), 0);
    }

    /// The lockbox never releases more than was locked; it holds exactly what it owes.
    function invariant_lockboxNeverReleasesMoreThanLocked() public view {
        assertLe(h.ghostClaimed(), h.ghostLocked());
        assertEq(box.locked(), h.ghostLocked() - h.ghostClaimed());
        assertEq(address(box).balance, box.locked());
    }

    /// Supply on ZETAPHY + releases in flight (burned, not yet paid) <= locked; the gap is exactly the locks not minted.
    function invariant_supplyBackedByLockedPlusInFlight() public view {
        uint256 supply = guard.token().totalSupply();
        uint256 inFlight = h.ghostBurned() - h.ghostClaimed();
        assertEq(supply, h.ghostMinted() - h.ghostBurned());
        assertLe(supply + inFlight, box.locked());
        assertEq(box.locked() - supply - inFlight, h.ghostUnminted());
    }

    /// Each message body is delivered, paid and minted at most once; a lying lane alone never mints.
    function invariant_eachBodyReleasedOnce() public view {
        assertEq(h.twice(), 0);
        assertEq(h.forgedMint(), 0);
    }

    /// Per UTC day: paid <= the lockbox's daily limit, minted <= the guard's limit for the route (and its hard cap).
    function invariant_dailyLimits() public view {
        assertEq(h.overDay(), 0);
    }
}
