// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyEarly} from "../../contracts/ZetaphyEarly.sol";
import {ZetaphyEarlyFarm} from "../../contracts/ZetaphyEarlyFarm.sol";
import {ZetaphyEarlyPolls} from "../../contracts/ZetaphyEarlyPolls.sol";
import {ZetaphyEarlyPass} from "../../contracts/ZetaphyEarlyPass.sol";
import {ZetaphyQuests} from "../../contracts/ZetaphyQuests.sol";
import {MockERC20} from "./utils/Mocks.sol";

contract EarlyHandler is Test {
    ZetaphyEarly public z;
    ZetaphyEarlyFarm public farm;
    ZetaphyEarlyPolls public polls;
    ZetaphyEarlyPass public pass;
    ZetaphyQuests public quests;
    MockERC20 public lp;
    address public op;
    address[4] public users = [address(0xE001), address(0xE002), address(0xE003), address(0xE004)];

    // farm ghosts
    uint256 public farmFunded;   // ZEARLY sent to the farm
    uint256 public farmPaid;     // rewards paid out
    uint256 public farmRecovered;
    // polls ghosts
    uint256 public pollDoubleRelease;
    // pass / quests ghosts
    uint256 public passTwice;
    uint256 public questTwice;
    mapping(uint8 => mapping(address => uint256)) public questPaidCount;

    constructor(ZetaphyEarly z_, ZetaphyEarlyFarm f, ZetaphyEarlyPolls p, ZetaphyEarlyPass ps, ZetaphyQuests q, MockERC20 lp_, address op_) {
        (z, farm, polls, pass, quests, lp, op) = (z_, f, p, ps, q, lp_, op_);
        for (uint256 i; i < 4; i++) {
            vm.startPrank(users[i]);
            z.approve(address(polls), type(uint256).max);
            z.approve(address(pass), type(uint256).max);
            lp.approve(address(farm), type(uint256).max);
            vm.stopPrank();
            lp.mint(users[i], 1e24);
        }
    }

    // ---- token ----
    function transfer(uint256 a, uint256 b, uint256 v) external {
        address from = users[a % 4];
        v = bound(v, 0, z.balanceOf(from));
        vm.prank(from);
        z.transfer(users[b % 4], v);
    }

    function batch(uint256 a, uint256 each) external {
        address from = users[a % 4];
        address[] memory to = new address[](3);
        for (uint256 i; i < 3; i++) to[i] = users[(a + 1 + i) % 4];
        each = bound(each, 0, z.balanceOf(from) / 3);
        vm.prank(from);
        z.batchTransfer(to, each);
    }

    // ---- farm ----
    function stake(uint256 u, uint256 v) external {
        vm.prank(users[u % 4]);
        farm.stake(bound(v, 1, 1e21));
    }

    function unstake(uint256 u, uint256 v) external {
        address a = users[u % 4];
        uint256 b = farm.balanceOf(a);
        if (b == 0) return;
        vm.prank(a);
        farm.withdraw(bound(v, 1, b));
    }

    function getReward(uint256 u) external {
        address a = users[u % 4];
        uint256 before = z.balanceOf(a);
        vm.prank(a);
        farm.getReward();
        farmPaid += z.balanceOf(a) - before;
    }

    function notify(uint256 reward, uint256 dur) external {
        reward = bound(reward, 0, 1e24);
        uint256 have = z.balanceOf(op);
        if (reward > have) reward = have;
        vm.startPrank(op);
        z.transfer(address(farm), reward);
        farmFunded += reward;
        try farm.notifyReward(reward, bound(dur, 1 hours, 30 days)) {} catch {}
        vm.stopPrank();
    }

    function recover(uint256 v) external {
        vm.prank(op);
        try farm.recover(op, bound(v, 0, 1e24)) { farmRecovered += bound(v, 0, 1e24); } catch {}
    }

    // ---- polls ----
    function createPoll(uint256 u) external {
        string[] memory o = new string[](2);
        o[0] = "yes";
        o[1] = "no";
        vm.prank(users[u % 4]);
        try polls.create("q?", o, 1 hours) {} catch {}
    }

    function vote(uint256 u, uint256 id, uint8 opt, uint256 v) external {
        uint256 n = polls.count();
        if (n == 0) return;
        address a = users[u % 4];
        v = bound(v, 1, 1e21);
        vm.prank(a);
        try polls.vote(id % n, opt % 2, v) {} catch {}
    }

    function releasePoll(uint256 u, uint256 id) external {
        uint256 n = polls.count();
        if (n == 0) return;
        address a = users[u % 4];
        vm.startPrank(a);
        try polls.release(id % n) {
            try polls.release(id % n) { pollDoubleRelease++; } catch {}
        } catch {}
        vm.stopPrank();
    }

    // ---- pass / quests ----
    function mintPass(uint256 u) external {
        address a = users[u % 4];
        bool had = pass.minted(a);
        vm.prank(a);
        try pass.mint() { if (had) passTwice++; } catch {}
    }

    function payQuest(uint8 q, uint256 seed) external {
        q = q % 3;
        address[] memory to = new address[](2);
        to[0] = users[seed % 4];
        to[1] = users[(seed / 4) % 4];
        uint256[2] memory before = [z.balanceOf(to[0]), z.balanceOf(to[1])];
        vm.prank(op);
        try quests.pay(q, to) {
            for (uint256 i; i < 2; i++) {
                if (z.balanceOf(to[i]) > before[i] && !(i == 1 && to[1] == to[0])) {
                    questPaidCount[q][to[i]]++;
                    if (questPaidCount[q][to[i]] > 1) questTwice++;
                }
            }
        } catch {}
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 3 days)); }
}

contract EarlyInvariants is Test {
    ZetaphyEarly z;
    ZetaphyEarlyFarm farm;
    ZetaphyEarlyPolls polls;
    ZetaphyEarlyPass pass;
    ZetaphyQuests quests;
    MockERC20 lp;
    EarlyHandler h;
    address op = address(0x0909);

    function setUp() public {
        vm.warp(1_700_000_000);
        z = new ZetaphyEarly(op);
        lp = new MockERC20("LP", "LP", 18);
        farm = new ZetaphyEarlyFarm(address(lp), address(z), op);
        polls = new ZetaphyEarlyPolls(address(z), 10 ether);
        pass = new ZetaphyEarlyPass(address(z), 5 ether, 3, uint64(block.timestamp + 1 days), 1 ether);
        quests = new ZetaphyQuests(address(z), op);
        h = new EarlyHandler(z, farm, polls, pass, quests, lp, op);
        vm.startPrank(op);
        for (uint256 i; i < 4; i++) z.transfer(h.users(i), 1_000_000 ether);
        z.transfer(address(quests), 100_000 ether);
        quests.setQuest(0, 10 ether, 3);
        quests.setQuest(1, 20 ether, 100);
        quests.setQuest(2, 1 ether, 1);
        vm.stopPrank();
        targetContract(address(h));
    }

    /// ZEARLY: fixed supply, the balances always sum to it.
    function invariant_supplyConserved() public view {
        uint256 s = z.balanceOf(op) + z.balanceOf(address(farm)) + z.balanceOf(address(polls)) + z.balanceOf(address(quests))
            + z.balanceOf(pass.BURN());
        for (uint256 i; i < 4; i++) s += z.balanceOf(h.users(i));
        assertEq(s, z.totalSupply());
    }

    /// Farm: rewards owed are always funded; what stakers can claim never exceeds what is owed;
    /// the staked LP is never touched by the operator.
    function invariant_farmFunded() public view {
        assertGe(z.balanceOf(address(farm)), farm.owed(), "owed > ZEARLY held");
        uint256 claimable;
        uint256 staked;
        for (uint256 i; i < 4; i++) {
            claimable += farm.earned(h.users(i));
            staked += farm.balanceOf(h.users(i));
        }
        assertLe(claimable, farm.owed(), "claimable > owed");
        // nothing owed to nobody (EF-1): owed = claimable + the stream still to come + the idle stream
        // not yet settled (nobody staked since lastUpdate), up to per-user rounding
        uint256 t = farm.lastTime();
        uint256 toCome = farm.periodFinish() > t ? (farm.periodFinish() - t) * farm.rewardRate() : 0;
        uint256 idle = farm.totalSupply() == 0 && t > farm.lastUpdate() ? (t - farm.lastUpdate()) * farm.rewardRate() : 0;
        assertApproxEqAbs(farm.owed(), claimable + toCome + idle, 1e12, "rewards owed to nobody");
        assertEq(staked, farm.totalSupply());
        assertEq(lp.balanceOf(address(farm)), farm.totalSupply(), "LP held != staked");
    }

    /// Polls hold every locked vote; a release pays once. Pass: one per wallet, at most maxSupply.
    /// Quests: once per (quest, wallet), at most `cap` wallets.
    function invariant_pollsPassQuests() public view {
        assertEq(h.pollDoubleRelease(), 0);
        assertEq(h.passTwice(), 0);
        assertLe(pass.totalSupply(), pass.maxSupply());
        assertEq(h.questTwice(), 0);
        for (uint8 q; q < 3; q++) {
            (, uint32 cap, uint32 count) = quests.quests(q);
            assertLe(count, cap);
        }
        uint256 locked;
        uint256 n = polls.count();
        for (uint256 id; id < n; id++) for (uint256 i; i < 4; i++) locked += polls.locked(id, h.users(i));
        assertGe(z.balanceOf(address(polls)), locked);
    }
}

/// REGRESSION EF-1 (was Low): rewards streamed while nobody is staked used to stay in `owed`, credited to
/// no one, and `recover` could not take them. Now the idle part stops being promised at the next update
/// and the operator recovers it; stakers still get exactly what they earned.
contract EarlyFarmIdleRewardsStuck is Test {
    ZetaphyEarly z;
    MockERC20 lp;
    ZetaphyEarlyFarm farm;
    address op = address(0x0909);
    address u = address(0xE001);

    function setUp() public {
        vm.warp(1_700_000_000);
        z = new ZetaphyEarly(op);
        lp = new MockERC20("LP", "LP", 18);
        farm = new ZetaphyEarlyFarm(address(lp), address(z), op);
        vm.startPrank(op);
        z.transfer(address(farm), 1000 ether);
        farm.notifyReward(1000 ether, 10 days);
        vm.stopPrank();
        lp.mint(u, 1 ether);
        vm.prank(u);
        lp.approve(address(farm), 1 ether);
    }

    function test_regression_EF1_idleRewardsRecoverable() public {
        vm.warp(block.timestamp + 5 days);            // nobody staked for half the period
        vm.prank(u);
        farm.stake(1 ether);
        vm.warp(block.timestamp + 6 days);
        vm.prank(u);
        farm.exit();
        assertApproxEqAbs(z.balanceOf(u), 500 ether, 1e9);
        assertLe(farm.owed(), 1e9, "nothing owed to nobody");
        uint256 spare = z.balanceOf(address(farm)) - farm.owed();
        assertApproxEqAbs(spare, 500 ether, 1e9);
        vm.prank(op);
        farm.recover(op, spare);
        assertGe(z.balanceOf(address(farm)), farm.owed(), "still funded");
    }

    /// Idle at the end of the period too (everyone left early): recovered once anything updates.
    function test_regression_EF1_idleAfterExit() public {
        vm.prank(u);
        farm.stake(1 ether);
        vm.warp(block.timestamp + 2 days);
        vm.prank(u);
        farm.exit();                                   // ~200 earned
        vm.warp(block.timestamp + 20 days);            // period over, nobody staked for 8 days
        vm.prank(op);
        farm.notifyReward(0, 1 days);                  // any update settles the idle stream
        assertApproxEqAbs(z.balanceOf(u), 200 ether, 1e9);
        assertLe(farm.owed(), 1e9);
        uint256 spare = z.balanceOf(address(farm)) - farm.owed();
        assertApproxEqAbs(spare, 800 ether, 1e9);
        vm.prank(op);
        farm.recover(op, spare);
    }
}
