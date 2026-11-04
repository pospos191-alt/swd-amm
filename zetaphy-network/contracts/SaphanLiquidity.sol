// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// HyperlaneLockBoxV2 as this contract sees it: its daily release limit, which a guardian may only lower.
interface ILiquidityLockbox {
    function dailyLimit() external view returns (uint256);
    function lowerDailyLimit(uint256 v) external;
}

/// @title SaphanLiquidityBounds: route limits that follow observed flows, inside bounds governance set
/// @notice Saphan PR 6, item S9 (docs/SAPHAN-PR6.md). Testnet only, not audited.
///
///         Governance (the chain's ZetaphyTimelock: every change waits its delay) sets, per route, the band a route's
///         daily release limit may move in: [min, max], the largest step per update (maxStepBps of the current
///         target) and the shortest time between updates (minInterval). The rebalancer (a key governance names: the
///         off-chain policy in src/saphanliquidity.js runs with it; an LLM may only hint, the policy is deterministic)
///         moves the route's TARGET inside that band, one bounded step at a time. Whatever the rebalancer's key does,
///         the target stays in [min, max] and moves at most maxStepBps per minInterval.
///
///         What the target does on chain: this contract is a GUARDIAN of the route's lockbox, and guardians can only
///         reduce risk. applyDown(route) (anyone) lowers the lockbox's daily limit to the target when the target is
///         lower. Raising a limit stays with the lockbox's governance (its timelock, 48 h): the policy prints the
///         proposal (src/saphanliquidity.js raiseProposal), and governance never has to accept it.
///         The rebalancer may also drop a target to `min` at once (an incident: emergencyMin), never raise it at once.
///
///         No other power: this contract calls nothing but lowerDailyLimit, holds no money, has no upgrade.
contract SaphanLiquidityBounds {
    struct Bounds {
        address lockbox;      // the route's HyperlaneLockBoxV2 (this contract must be one of its guardians)
        uint128 min;          // wei per day
        uint128 max;
        uint16 maxStepBps;    // largest change per update, in bps of the current target
        uint32 minInterval;   // seconds between updates
    }

    struct Target {
        uint128 value;
        uint64 updatedAt;
        bytes32 hint;         // hash of the policy input (flows, LLM hint) that produced it: anyone can recompute it
    }

    uint16 public constant MAX_STEP_BPS = 5000;
    uint32 public constant MIN_INTERVAL = 1 hours;

    address public immutable governance;
    address public rebalancer;
    mapping(bytes32 => Bounds) public bounds;
    mapping(bytes32 => Target) public target;

    event BoundsSet(bytes32 indexed route, address lockbox, uint128 min, uint128 max, uint16 maxStepBps, uint32 minInterval);
    event RebalancerSet(address rebalancer);
    event TargetSet(bytes32 indexed route, uint128 from, uint128 to, bytes32 hint);
    event AppliedDown(bytes32 indexed route, uint256 from, uint256 to);

    error NotGovernance();
    error NotRebalancer();
    error NoRoute();
    error BadBounds();
    error OutOfBounds(uint128 min, uint128 max);
    error StepTooBig(uint256 most);
    error TooSoon(uint64 at);
    error NothingToLower();

    constructor(address governance_) {
        require(governance_ != address(0), "governance");
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }
    modifier onlyRebalancer() { if (msg.sender != rebalancer) revert NotRebalancer(); _; }

    /// Governance: a route's band. The target is pulled into the new band at once.
    function setBounds(bytes32 route, address lockbox, uint128 min, uint128 max, uint16 maxStepBps, uint32 minInterval) external onlyGov {
        if (lockbox == address(0) || min > max || max == 0 || maxStepBps == 0 || maxStepBps > MAX_STEP_BPS || minInterval < MIN_INTERVAL) revert BadBounds();
        bounds[route] = Bounds(lockbox, min, max, maxStepBps, minInterval);
        Target storage t = target[route];
        uint128 v = t.value < min ? min : t.value > max ? max : t.value;
        if (v != t.value) { emit TargetSet(route, t.value, v, bytes32(0)); t.value = v; }
        emit BoundsSet(route, lockbox, min, max, maxStepBps, minInterval);
    }

    /// Governance: who runs the policy (zero: nobody; the targets stay as they are).
    function setRebalancer(address r) external onlyGov {
        rebalancer = r;
        emit RebalancerSet(r);
    }

    /// The rebalancer: a new target for `route`, inside the band, at most one step from the current one.
    function propose(bytes32 route, uint128 value, bytes32 hint) external onlyRebalancer {
        Bounds memory b = bounds[route];
        if (b.lockbox == address(0)) revert NoRoute();
        Target storage t = target[route];
        if (t.updatedAt != 0 && block.timestamp < uint256(t.updatedAt) + b.minInterval) revert TooSoon(t.updatedAt + b.minInterval);
        if (value < b.min || value > b.max) revert OutOfBounds(b.min, b.max);
        uint256 step = maxStep(route);
        uint256 diff = value > t.value ? value - t.value : t.value - value;
        if (diff > step) revert StepTooBig(step);
        emit TargetSet(route, t.value, value, hint);
        t.value = value;
        t.updatedAt = uint64(block.timestamp);
        t.hint = hint;
    }

    /// The rebalancer, in an incident: the target drops to the band's minimum at once (no step, no interval).
    function emergencyMin(bytes32 route) external onlyRebalancer {
        Bounds memory b = bounds[route];
        if (b.lockbox == address(0)) revert NoRoute();
        Target storage t = target[route];
        emit TargetSet(route, t.value, b.min, keccak256("emergency"));
        t.value = b.min;
        t.updatedAt = uint64(block.timestamp);
    }

    /// Anyone: when the target is below the lockbox's daily limit, lowers the limit to it (a guardian call).
    function applyDown(bytes32 route) external {
        Bounds memory b = bounds[route];
        if (b.lockbox == address(0)) revert NoRoute();
        uint256 cur = ILiquidityLockbox(b.lockbox).dailyLimit();
        uint256 v = target[route].value;
        if (v >= cur) revert NothingToLower();
        emit AppliedDown(route, cur, v);
        ILiquidityLockbox(b.lockbox).lowerDailyLimit(v);
    }

    /// The largest change the next propose() may make (a target of 0 may move up to maxStepBps of max).
    function maxStep(bytes32 route) public view returns (uint256) {
        Bounds memory b = bounds[route];
        uint256 v = target[route].value;
        uint256 base = v > 0 ? v : b.max;
        return base * b.maxStepBps / 10000;
    }
}
