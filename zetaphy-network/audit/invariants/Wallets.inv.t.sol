// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentPolicyWallet} from "../../contracts/AgentPolicyWallet.sol";
import {QuantumWallet} from "../../contracts/QuantumWallet.sol";
import {AgentRegistry, ConstitutionChecker} from "../../contracts/AgentRegistry.sol";
import {StableGateway, INeuroJobs, IPriceOracle} from "../../contracts/StableGateway.sol";
import {NeuroJobs} from "../../contracts/NeuroJobs.sol";
import {MockERC20, MockMLDSA, Receiver} from "./utils/Mocks.sol";

address constant MLDSA_ADDR = 0x0000000000000000000000000000000000000900;

// ============================================================================ AgentPolicyWallet

contract PolicyHandler is Test {
    AgentPolicyWallet public w;
    MockERC20 public tok;      // has a limit
    MockERC20 public tok2;     // no limit: the agent must never move it
    address public owner;
    address public agent;
    address public okTo = address(0xA110);
    address public badTo = address(0xBAD0);
    uint256 public constant PERIOD = 1 days;

    struct Move { uint64 t; uint256 amount; }
    Move[] public tokMoves;
    Move[] public nativeMoves;
    uint256 public violations; // unlimited token moved, moved while frozen, moved to a non-allowed recipient, cosign skipped

    constructor(AgentPolicyWallet w_, MockERC20 t, MockERC20 t2, address o, address a) {
        w = w_;
        tok = t;
        tok2 = t2;
        owner = o;
        agent = a;
    }

    function _record(Move[] storage m, uint256 amount) internal { m.push(Move(uint64(block.timestamp), amount)); }

    function agentTransfer(uint256 amount, bool toBad, bool unlimited) external {
        MockERC20 t = unlimited ? tok2 : tok;
        amount = bound(amount, 1, 50 ether);
        address to = toBad ? badTo : okTo;
        bool frozen = w.frozen();
        uint256 before = t.balanceOf(address(w));
        vm.prank(agent);
        try w.execute(address(t), 0, abi.encodeCall(MockERC20.transfer, (to, amount)), bytes32(0), bytes32(0)) {
            if (unlimited || frozen || toBad) violations++;
            (,, uint256 cosignAbove,,) = w.limits(address(t));
            if (amount > cosignAbove) violations++;
            _record(tokMoves, before - t.balanceOf(address(w)));
        } catch {}
    }

    function agentNative(uint256 amount, bool toBad) external {
        amount = bound(amount, 1, 50 ether);
        bool frozen = w.frozen();
        vm.prank(agent);
        try w.execute(toBad ? badTo : okTo, amount, "", bytes32(0), bytes32(0)) {
            if (frozen || toBad) violations++;
            _record(nativeMoves, amount);
        } catch {}
    }

    function agentApprove(uint256 amount) external {
        amount = bound(amount, 1, 50 ether);
        bool frozen = w.frozen();
        vm.prank(agent);
        try w.execute(address(tok), 0, abi.encodeCall(MockERC20.approve, (okTo, amount)), bytes32(0), bytes32(0)) {
            if (frozen) violations++;
            _record(tokMoves, amount); // an approval counts as spending
        } catch {}
    }

    /// Above cosignAbove: queue, wait the delay, execute.
    function agentQueued(uint256 amount) external {
        amount = bound(amount, 1, 200 ether);
        bytes memory data = abi.encodeCall(MockERC20.transfer, (okTo, amount));
        uint256 seq = w.queueCount() + 1;
        vm.prank(agent);
        try w.queue(address(tok), 0, data, bytes32(0), bytes32(0)) {} catch { return; }
        vm.warp(block.timestamp + w.delay());
        bool frozen = w.frozen();
        uint256 before = tok.balanceOf(address(w));
        vm.prank(agent);
        try w.executeQueued(seq, address(tok), 0, data, bytes32(0), bytes32(0)) {
            if (frozen) violations++;
            _record(tokMoves, before - tok.balanceOf(address(w)));
        } catch {}
    }

    function freeze() external { vm.prank(owner); w.freeze(); }
    function unfreeze() external { vm.prank(owner); w.unfreeze(); }
    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 2 days)); }

    function tokMovesLength() external view returns (uint256) { return tokMoves.length; }
    function nativeMovesLength() external view returns (uint256) { return nativeMoves.length; }
}

contract AgentPolicyWalletInvariants is Test {
    AgentPolicyWallet w;
    PolicyHandler h;
    MockERC20 tok;
    MockERC20 tok2;
    address owner = address(0x0A0A);
    address agent = address(0xA9E7);

    function setUp() public {
        vm.warp(1_700_000_000);
        w = new AgentPolicyWallet(owner, agent, address(0), address(0), 1 days, 1 hours);
        tok = new MockERC20("T", "T", 18);
        tok2 = new MockERC20("U", "U", 18);
        tok.mint(address(w), 1e24);
        tok2.mint(address(w), 1e24);
        vm.deal(address(w), 1e24);
        h = new PolicyHandler(w, tok, tok2, owner, agent);
        vm.startPrank(owner);
        w.setLimit(address(tok), 100 ether, 20 ether);
        w.setLimit(address(0), 100 ether, 1e30);
        w.setAllowed(h.okTo(), false, true);
        vm.stopPrank();
        targetContract(address(h));
    }

    /// In any sliding `period`, the agent moves at most 2 x perPeriod (the cap is per fixed window);
    /// never an unlimited token, never while frozen, never to a non-allowed recipient, never above
    /// cosignAbove without the queue.
    function invariant_agentWithinCaps() public view {
        assertEq(h.violations(), 0);
        _check(true, 100 ether);
        _check(false, 100 ether);
    }

    function _check(bool isTok, uint256 cap) internal view {
        uint256 n = isTok ? h.tokMovesLength() : h.nativeMovesLength();
        for (uint256 i; i < n; i++) {
            (uint64 ti,) = isTok ? h.tokMoves(i) : h.nativeMoves(i);
            uint256 sum;
            for (uint256 k; k < n; k++) {
                (uint64 tk, uint256 ak) = isTok ? h.tokMoves(k) : h.nativeMoves(k);
                if (tk <= ti && tk + 1 days > ti) sum += ak;
            }
            assertLe(sum, 2 * cap, "agent above 2x cap in a sliding period");
        }
    }
}

contract MockNFT {
    mapping(uint256 => address) public ownerOf;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "not owner");
        ownerOf[id] = to;
    }
    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

/// Any function of any contract: succeeds for every caller (stands in for value-moving functions that
/// no deny-list knows about).
contract AnyCall {
    uint256 public calls;
    fallback() external payable { calls++; }
}

/// REGRESSION APW-1 (was Medium): the selector filter refused only transferFrom / setApprovalForAll /
/// permit / increaseAllowance; any other value-moving function of an allow-listed TARGET ran uncapped
/// (e.g. ERC-721 safeTransferFrom). Now contract calls need an allow-listed (target, selector) pair
/// (deny by default) and transfer-like selectors can never be allow-listed.
contract AgentPolicyWalletSelectorBypass is Test {
    address owner = address(0x0A0A);
    address agent = address(0xA9E7);
    AgentPolicyWallet w;

    function setUp() public {
        w = new AgentPolicyWallet(owner, agent, address(0), address(0), 1 days, 1 hours);
    }

    function test_regression_APW1_agentCannotMoveNftOfAllowedTarget() public {
        MockNFT nft = new MockNFT();
        nft.mint(address(w), 1);
        vm.prank(owner);
        w.setAllowed(address(nft), true, false); // the owner allows the collection as a target
        bytes memory data = abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(w), agent, uint256(1));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.Forbidden.selector, bytes4(0x42842e0e)));
        w.execute(address(nft), 0, data, bytes32(0), bytes32(0));
        // and the owner cannot allow-list it either
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.Forbidden.selector, bytes4(0x42842e0e)));
        w.setAllowedCall(address(nft), 0x42842e0e, true);
        assertEq(nft.ownerOf(1), address(w), "the NFT stays");
    }

    /// Every transfer-like selector of the list is refused on an allowed target, whatever the owner allows.
    function test_regression_APW1_transferLikeSelectorsRefused() public {
        AnyCall t = new AnyCall();
        vm.prank(owner);
        w.setAllowed(address(t), true, false);
        bytes4[26] memory sels = [bytes4(0x23b872dd), 0x39509351, 0xa22cb465, 0xd505accf, 0x42842e0e, 0xb88d4fde, 0xf242432a,
            0x2eb2c2d6, 0x9bd9bbc6, 0x62ad1b83, 0x959b8c3f, 0x4000aea0, 0x1296ee62, 0xd8fbe994, 0xc1d34b89, 0x3177029f,
            0xcae9ca51, 0xbb35783b, 0xf2d5d56b, 0xb753a98c, 0x8fcbaf0c, 0x2b67b570, 0x2a2d80d1, 0x87517c45, 0x36c78516, 0x79cc6790];
        for (uint256 i; i < sels.length; i++) {
            assertTrue(w.isTransferLike(sels[i]));
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.Forbidden.selector, sels[i]));
            w.setAllowedCall(address(t), sels[i], true);
            vm.prank(agent);
            vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.Forbidden.selector, sels[i]));
            w.execute(address(t), 0, abi.encodePacked(sels[i], bytes32(0), bytes32(0), bytes32(0)), bytes32(0), bytes32(0));
        }
        assertEq(t.calls(), 0);
    }

    /// Deny by default: on an allowed target, ANY selector runs only once the owner allowed that pair;
    /// its native value counts against the native cap.
    function testFuzz_APW1_contractCallsNeedAllowedSelector(bytes4 sel, uint96 value) public {
        vm.assume(!w.isTransferLike(sel) && sel != 0xa9059cbb && sel != 0x095ea7b3);
        AnyCall t = new AnyCall();
        vm.deal(address(w), 1000 ether);
        vm.startPrank(owner);
        w.setAllowed(address(t), true, false);
        w.setLimit(address(0), 10 ether, 10 ether);
        vm.stopPrank();
        bytes memory data = abi.encodePacked(sel, bytes32(uint256(1)));
        uint256 v = bound(value, 0, 10 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.SelectorNotAllowed.selector, address(t), sel));
        w.execute(address(t), v, data, bytes32(0), bytes32(0));
        vm.prank(owner);
        w.setAllowedCall(address(t), sel, true);
        vm.prank(agent);
        w.execute(address(t), v, data, bytes32(0), bytes32(0));
        assertEq(t.calls(), 1);
        assertEq(w.remaining(address(0)), 10 ether - v, "value capped as native");
        // a pair allowed on one target does not open another
        AnyCall t2 = new AnyCall();
        vm.prank(owner);
        w.setAllowed(address(t2), true, false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyWallet.SelectorNotAllowed.selector, address(t2), sel));
        w.execute(address(t2), 0, data, bytes32(0), bytes32(0));
    }
}

// ============================================================================ QuantumWallet

contract QwHandler is Test {
    QuantumWallet public q;
    uint256 public ownerKey = 0xEC05A;
    bytes32 public pk = keccak256("ml-dsa public key");
    address public to = address(0x7070);
    struct A { address to; uint256 value; uint256 deadline; bytes pq; bytes ec; }
    A[] internal used;
    uint256 public okCount;
    uint256 public replayed;

    constructor(QuantumWallet q_) { q = q_; }

    function _auth(uint256 value, uint256 deadline) internal view returns (QuantumWallet.Auth memory a) {
        bytes32 d = q.digest(to, value, "", deadline);
        a.pqPublicKey = abi.encodePacked(pk);
        a.pqSig = abi.encodePacked(keccak256(abi.encodePacked(q.variant(), d, pk)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, d);
        a.ecdsaSig = abi.encodePacked(r, s, v);
    }

    function exec(uint256 value) external {
        value = bound(value, 0, 1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        QuantumWallet.Auth memory a = _auth(value, deadline);
        q.execute(to, value, "", deadline, a);
        okCount++;
        used.push(A(to, value, deadline, a.pqSig, a.ecdsaSig));
    }

    function replay(uint256 i) external {
        if (used.length == 0) return;
        A memory x = used[i % used.length];
        QuantumWallet.Auth memory a = QuantumWallet.Auth(abi.encodePacked(pk), x.pq, x.ec);
        try q.execute(x.to, x.value, "", x.deadline, a) { replayed++; } catch {}
    }

    function wrongKey(uint256 value) external {
        uint256 deadline = block.timestamp + 1 hours;
        QuantumWallet.Auth memory a = _auth(bound(value, 0, 1 ether), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, q.digest(to, 0, "", deadline));
        a.ecdsaSig = abi.encodePacked(r, s, v);
        try q.execute(to, 0, "", deadline, a) { replayed++; } catch {}
    }
}

contract QuantumWalletInvariants is Test {
    QuantumWallet q;
    QwHandler h;

    function setUp() public {
        vm.etch(MLDSA_ADDR, address(new MockMLDSA()).code);
        h = new QwHandler(QuantumWallet(payable(address(0))));
        q = new QuantumWallet(vm.addr(h.ownerKey()), 44, keccak256(abi.encodePacked(h.pk())));
        h = new QwHandler(q);
        vm.deal(address(q), 1e24);
        targetContract(address(h));
    }

    /// The nonce counts exactly the authorised actions; no replay, no action without both keys.
    function invariant_noReplay() public view {
        assertEq(q.nonce(), h.okCount());
        assertEq(h.replayed(), 0);
    }
}

// ============================================================================ AgentRegistry

contract RegistryHandler is Test {
    AgentRegistry public reg;
    ConstitutionChecker public checker;
    address[2] public ops = [address(0xB001), address(0xB002)];
    address public victim = address(0x71C7);
    address public claimant = address(0xC1A1);
    address[3] public committee = [address(0xC001), address(0xC002), address(0xC003)];
    bytes32 public pk = keccak256("agent pq key");
    bytes public constitution;
    uint256 public bondOutWithOpenClaim;

    constructor(AgentRegistry r, ConstitutionChecker c) {
        reg = r;
        checker = c;
        address[] memory targets = new address[](1);
        targets[0] = address(0x7A);
        constitution = abi.encode(victim, uint256(1 ether), targets, new bytes32[](0));
        for (uint256 i; i < 2; i++) vm.deal(ops[i], 1e24);
        vm.deal(claimant, 1e24);
    }

    function register(uint256 o, uint256 bond) external {
        address op = ops[o % 2];
        address account = address(uint160(uint256(keccak256(abi.encode(op, reg.agentCount())))));
        vm.prank(op);
        try reg.register{value: bound(bond, 1 ether, 10 ether)}(account, keccak256(abi.encodePacked(pk)), keccak256(constitution), address(checker)) {} catch {}
    }

    function record(uint256 id, uint256 value, bool badTarget) external {
        uint256 n = reg.agentCount();
        if (n == 0) return;
        id = 1 + id % n;
        AgentRegistry.ActionInput memory x = AgentRegistry.ActionInput(badTarget ? address(0xBAD) : address(0x7A), bound(value, 0, 5 ether),
            keccak256("data"), keccak256("model"), keccak256("prompt"));
        bytes32 d = reg.actionDigest(id, x);
        bytes memory sig = abi.encodePacked(keccak256(abi.encodePacked(uint8(44), d, pk)));
        try reg.recordAction(id, x, abi.encodePacked(pk), sig) {} catch {}
    }

    function claimByChecker(uint256 a) external {
        uint256 n = reg.actionCount();
        if (n == 0) return;
        try reg.claimByChecker(1 + a % n, constitution, "") {} catch {}
    }

    function fileClaim(uint256 a, uint256 amount) external {
        uint256 n = reg.actionCount();
        if (n == 0) return;
        uint256 dep = reg.claimDeposit();
        vm.prank(claimant);
        try reg.fileClaim{value: dep}(1 + a % n, bound(amount, 1, 20 ether), keccak256("ev")) {} catch {}
    }

    function vote(uint256 c, uint256 m, bool up) external {
        uint256 n = reg.claimCount();
        if (n == 0) return;
        vm.prank(committee[m % 3]);
        try reg.vote(1 + c % n, up) {} catch {}
    }

    function expireClaim(uint256 c) external {
        uint256 n = reg.claimCount();
        if (n == 0) return;
        try reg.expireClaim(1 + c % n) {} catch {}
    }

    function requestUnbond(uint256 id) external {
        uint256 n = reg.agentCount();
        if (n == 0) return;
        id = 1 + id % n;
        (address op,,,,,,,,) = reg.agents(id);
        vm.prank(op);
        try reg.requestUnbond(id) {} catch {}
    }

    function withdrawBond(uint256 id) external {
        uint256 n = reg.agentCount();
        if (n == 0) return;
        id = 1 + id % n;
        (address op,,,,,,,, uint32 open) = reg.agents(id);
        uint256 last = reg.lastActionAt(id);
        vm.prank(op);
        try reg.withdrawBond(id) {
            if (open != 0) bondOutWithOpenClaim++;
            if (last != 0 && block.timestamp <= last + reg.CLAIM_WINDOW()) bondOutInClaimWindow++; // AR-1
        } catch {}
    }

    uint256 public bondOutInClaimWindow;

    function addBond(uint256 id, uint256 v) external {
        uint256 n = reg.agentCount();
        if (n == 0) return;
        vm.deal(address(this), 10 ether);
        reg.addBond{value: bound(v, 0, 10 ether)}(1 + id % n);
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 5 days)); }
}

contract AgentRegistryInvariants is Test {
    AgentRegistry reg;
    RegistryHandler h;

    function setUp() public {
        vm.etch(MLDSA_ADDR, address(new MockMLDSA()).code);
        reg = new AgentRegistry(address(0x60F), 1 ether, 0.1 ether);
        ConstitutionChecker checker = new ConstitutionChecker();
        vm.prank(address(0x60F));
        reg.setChecker(address(checker), true);
        h = new RegistryHandler(reg, checker);
        address[] memory c = new address[](3);
        for (uint256 i; i < 3; i++) c[i] = h.committee(i);
        vm.prank(address(0x60F));
        reg.setCommittee(c, 2);
        targetContract(address(h));
    }

    /// The registry holds exactly the bonds plus the deposits of open claims; the open-claim counter
    /// matches the claims; no bond leaves while a claim is open.
    function invariant_accounting() public view {
        uint256 sum;
        uint256 na = reg.agentCount();
        uint256[] memory open = new uint256[](na + 1);
        uint256 nc = reg.claimCount();
        for (uint256 i = 1; i <= nc; i++) {
            (uint256 actionId,,, uint256 deposit,,,,, AgentRegistry.ClaimState st) = reg.claims(i);
            if (st == AgentRegistry.ClaimState.Open) {
                sum += deposit;
                (uint256 agentId,,,,,,,,,) = reg.actions(actionId);
                open[agentId]++;
            }
        }
        for (uint256 i = 1; i <= na; i++) {
            (,,,,, uint256 bond,,, uint32 oc) = reg.agents(i);
            sum += bond;
            assertEq(oc, open[i], "openClaims counter");
        }
        assertEq(address(reg).balance, sum);
        assertEq(h.bondOutWithOpenClaim(), 0);
        assertEq(h.bondOutInClaimWindow(), 0, "bond left while an action could still be claimed (AR-1)");
    }
}

/// REGRESSION AR-1 (was Medium): CLAIM_WINDOW is 30 days but UNBOND_DELAY is 7: an operator used to take
/// the bond out on day 7 after a harmful action. Now the bond stays until the claim window of the last
/// action is over; the victim can still file on day 29.
contract AgentRegistryBondEscapesClaimWindow is Test {
    function test_regression_AR1_bondStaysForTheClaimWindow() public {
        vm.etch(MLDSA_ADDR, address(new MockMLDSA()).code);
        AgentRegistry reg = new AgentRegistry(address(0x60F), 1 ether, 0.1 ether);
        address op = address(0xB001);
        vm.deal(op, 100 ether);
        bytes32 pk = keccak256("k");
        vm.prank(op);
        uint256 id = reg.register{value: 50 ether}(address(0xACC), keccak256(abi.encodePacked(pk)), keccak256("c"), address(0));
        AgentRegistry.ActionInput memory x = AgentRegistry.ActionInput(address(0x7A), 40 ether, keccak256("d"), keccak256("m"), keccak256("p"));
        bytes32 d = reg.actionDigest(id, x);
        uint256 actionId = reg.recordAction(id, x, abi.encodePacked(pk), abi.encodePacked(keccak256(abi.encodePacked(uint8(44), d, pk))));
        vm.prank(op);
        reg.requestUnbond(id);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 7 days);
        vm.prank(op);
        vm.expectRevert(AgentRegistry.NotYet.selector);
        reg.withdrawBond(id);                                   // day 7: refused now
        vm.warp(t0 + 30 days);                                  // last moment of the claim window
        vm.prank(op);
        vm.expectRevert(AgentRegistry.NotYet.selector);
        reg.withdrawBond(id);
        vm.deal(address(0xC1A1), 1 ether);
        vm.prank(address(0xC1A1));
        reg.fileClaim{value: 0.1 ether}(actionId, 40 ether, keccak256("ev")); // the victim can file
        vm.warp(t0 + 30 days + 1);
        vm.prank(op);
        vm.expectRevert(AgentRegistry.OpenClaims.selector);     // and the open claim holds the bond
        reg.withdrawBond(id);
        assertEq(reg.withdrawableAt(id), t0 + 30 days + 1);
    }

    /// An agent that never acted: the 7-day delay alone applies.
    function test_regression_AR1_noActionsSevenDays() public {
        AgentRegistry reg = new AgentRegistry(address(0x60F), 1 ether, 0.1 ether);
        address op = address(0xB001);
        vm.deal(op, 100 ether);
        vm.prank(op);
        uint256 id = reg.register{value: 50 ether}(address(0xACC), keccak256("pk"), keccak256("c"), address(0));
        vm.prank(op);
        reg.requestUnbond(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(op);
        reg.withdrawBond(id);
        assertEq(op.balance, 100 ether);
    }
}

// ============================================================================ StableGateway

contract MockOracle {
    mapping(address => uint256) public p;
    function set(address a, uint256 v) external { p[a] = v; }
    function price(address a) external view returns (uint256, uint256) {
        require(p[a] != 0, "no price");
        return (p[a], block.timestamp);
    }
}

contract MockJobs {
    uint256 public n;
    uint256 public received;
    function requestFor(address, bytes32, string calldata) external payable returns (uint256) {
        received += msg.value;
        return n++;
    }
}

contract GatewayHandler is Test {
    StableGateway public g;
    MockERC20 public usd;
    MockJobs public jobs;
    uint256[2] public keys = [uint256(0x5EED1), uint256(0x5EED2)];
    StableGateway.JobRequest[] internal done;
    bytes[] internal doneSigs;
    uint256 public okCount;
    uint256 public replayed;
    uint256 public overspent;
    uint256 public reserveWrong;

    constructor(StableGateway g_, MockERC20 u, MockJobs j) {
        g = g_;
        usd = u;
        jobs = j;
        for (uint256 i; i < 2; i++) {
            address a = vm.addr(keys[i]);
            u.mint(a, 1e30);
            vm.prank(a);
            u.approve(address(g_), type(uint256).max);
        }
    }

    function _sign(uint256 k, StableGateway.JobRequest memory q) internal view returns (bytes memory) {
        (bool ok, bytes memory r) = address(g).staticcall(abi.encodeCall(StableGateway.hashRequest, (q)));
        require(ok);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(k, abi.decode(r, (bytes32)));
        return abi.encodePacked(rr, s, v);
    }

    function request(uint256 who, uint256 fee, uint256 tip, uint256 maxCost) external {
        uint256 k = keys[who % 2];
        address user = vm.addr(k);
        fee = bound(fee, 1, 5 ether);
        StableGateway.JobRequest memory q = StableGateway.JobRequest(user, address(usd), "zetaphy", "0xabc", fee, bound(tip, 0, 1e6),
            bound(maxCost, 0, 1e9), g.nonces(user), block.timestamp + 1 hours);
        bytes memory sig = _sign(k, q);
        uint256 before = usd.balanceOf(user);
        uint256 reserve = address(g).balance;
        try g.request(q, sig) {
            okCount++;
            if (before - usd.balanceOf(user) > q.maxCost) overspent++;
            if (reserve - address(g).balance != fee) reserveWrong++;
            done.push(q);
            doneSigs.push(sig);
        } catch {}
    }

    function replay(uint256 i) external {
        if (done.length == 0) return;
        i = i % done.length;
        try g.request(done[i], doneSigs[i]) { replayed++; } catch {}
    }
}

contract StableGatewayInvariants is Test {
    StableGateway g;
    MockERC20 usd;
    MockJobs jobs;
    GatewayHandler h;

    function setUp() public {
        jobs = new MockJobs();
        g = new StableGateway(INeuroJobs(address(jobs)));
        usd = new MockERC20("USD", "USD", 6);
        MockOracle o = new MockOracle();
        o.set(address(0x2E7A), 0.5e18); // 1 ZETAPHY = $0.50
        g.setOracle(IPriceOracle(address(o)), address(0x2E7A));
        g.setToken(address(usd), true, false, 6);
        vm.deal(address(g), 1e24);
        h = new GatewayHandler(g, usd, jobs);
        targetContract(address(h));
    }

    /// One request per signed nonce; a user never pays more than maxCost; the reserve pays exactly the fee.
    function invariant_requests() public view {
        assertEq(h.replayed(), 0);
        assertEq(h.overspent(), 0);
        assertEq(h.reserveWrong(), 0);
        assertEq(address(g).balance + jobs.received(), 1e24);
    }
}

/// REGRESSION SG-1 (was Medium): a job nobody answers used to refund 95% of its fee in native ZETAPHY to
/// the user, making the reserve a stablecoin -> ZETAPHY exchange at the oracle price (50 USD -> 95
/// ZETAPHY at a $0.50 oracle). Now the gateway is the requester: the ZETAPHY refund returns to the
/// reserve and the user gets 95% of its stablecoin back.
contract StableGatewayRefundArbitrage is Test {
    NeuroJobs nj;
    StableGateway g;
    MockERC20 usd;
    uint256 k = 0xA11CE;
    address user;

    function setUp() public {
        vm.warp(1_700_000_000);
        nj = new NeuroJobs(100 ether, 0, 0.01 ether, 1 hours, 2 hours, 4 hours, 0);
        g = new StableGateway(INeuroJobs(address(nj)));
        usd = new MockERC20("USD", "USD", 6);
        MockOracle o = new MockOracle();
        o.set(address(0x2E7A), 0.5e18);
        g.setOracle(IPriceOracle(address(o)), address(0x2E7A));
        g.setToken(address(usd), true, false, 6);
        vm.deal(address(g), 1000 ether);
        user = vm.addr(k);
        usd.mint(user, 1000e6);
        vm.prank(user);
        usd.approve(address(g), type(uint256).max);
    }

    function _request(uint256 fee, uint256 nonce) internal returns (uint256) {
        StableGateway.JobRequest memory q = StableGateway.JobRequest(user, address(usd), "zetaphy", "0xnobody", fee, 0, 1000e6, nonce, block.timestamp + 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, g.hashRequest(q));
        return g.request(q, abi.encodePacked(r, s, v));
    }

    function test_regression_SG1_refundStaysInStablecoin() public {
        uint256 id = _request(100 ether, 0);            // pays 50 USD, the reserve pays 100 ZETAPHY
        (address requester,,,,,,,,,) = nj.getJob(id);
        assertEq(requester, address(g), "the gateway is the requester");
        vm.expectRevert(StableGateway.NotRefundable.selector);
        g.refund(id);                                    // not failed yet
        vm.warp(block.timestamp + 2 hours);
        nj.expire(id);
        assertEq(nj.credit(user), 0, "no native credit for the user");
        vm.prank(user);
        vm.expectRevert();
        nj.withdraw();
        g.refund(id);                                    // anyone
        assertEq(user.balance, 0, "no ZETAPHY bought");
        assertEq(usd.balanceOf(user), 950e6 + 47.5e6, "95% of the 50 USD back");
        assertEq(address(g).balance, 1000 ether - 5 ether, "the reserve got its ZETAPHY back (minus the 5% fail burn)");
        vm.expectRevert(StableGateway.NotRefundable.selector);
        g.refund(id);                                    // once
    }

    /// Round trip at any fee: the user never ends with ZETAPHY or with more stablecoin than it started.
    function testFuzz_SG1_noExchange(uint96 fee) public {
        uint256 f = bound(fee, 0.01 ether, 500 ether);
        uint256 id = _request(f, 0);
        vm.warp(block.timestamp + 2 hours);
        nj.expire(id);
        g.refund(id);
        assertEq(user.balance, 0);
        assertLe(usd.balanceOf(user), 1000e6);
    }
}
