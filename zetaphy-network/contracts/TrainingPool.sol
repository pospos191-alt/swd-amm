// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITPMinDelay {
    function getMinDelay() external view returns (uint256);
}

/// @title TrainingPool: the staked workers of the training market (testnet)
/// @notice Workers that train, spot-check and evaluate Neuro's model (TrainingMarket,
///         docs/future/useful-work-training.md) stake here first. The stake is what a fake checkpoint or a
///         wrong / missing answer costs: a market that governance names (`markets`) may lock a member while
///         it holds a seat or an assignment (`busy`) and slash it (the slashed coins go to that market).
///         A member who leaves stops being drawn at once and gets its stake back after `exitDelay`, once
///         nothing is locked (longer than a whole task, so a cheater cannot leave before it is judged).
///         No admin key: governance must be a timelock with at least MIN_DELAY.
contract TrainingPool {
    uint256 public constant MIN_DELAY = 2 days;

    struct Member {
        uint128 stake;
        uint64 exitAt;
        uint32 busy;
        uint32 index; // position in `members` + 1 (0: not in the pool)
    }

    address public governance;
    uint128 public minStake;
    uint32 public exitDelay;
    uint256 public totalStake;
    mapping(address => bool) public markets;
    mapping(address => Member) public memberOf;
    address[] public members;

    event Joined(address indexed member, uint256 stake);
    event Exiting(address indexed member, uint64 at);
    event Withdrawn(address indexed member, uint256 amount);
    event Slashed(address indexed member, address indexed market, uint256 amount);
    event MarketSet(address indexed market, bool on);
    event ParamsSet(uint128 minStake, uint32 exitDelay);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotMarket();
    error NotTimelock();
    error BadValue();
    error WrongPhase();
    error Busy();

    constructor(address governance_, uint128 minStake_, uint32 exitDelay_) {
        _checkTimelock(governance_);
        governance = governance_;
        _setParams(minStake_, exitDelay_);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyMarket() {
        if (!markets[msg.sender]) revert NotMarket();
        _;
    }

    // ---------------------------------------------------------------- members

    /// Stakes (or adds stake); a member who was leaving is back in the draw.
    function join() external payable {
        Member storage m = memberOf[msg.sender];
        m.stake += uint128(msg.value);
        totalStake += msg.value;
        if (m.stake < minStake) revert BadValue();
        m.exitAt = 0;
        if (m.index == 0) {
            members.push(msg.sender);
            m.index = uint32(members.length);
        }
        emit Joined(msg.sender, m.stake);
    }

    /// Leaves the draw now; the stake comes back after exitDelay (it can still be slashed until then).
    function exit() external {
        Member storage m = memberOf[msg.sender];
        if (m.index == 0 || m.exitAt != 0) revert WrongPhase();
        m.exitAt = uint64(block.timestamp + exitDelay);
        emit Exiting(msg.sender, m.exitAt);
    }

    function withdrawStake() external {
        Member storage m = memberOf[msg.sender];
        if (m.exitAt == 0 || block.timestamp < m.exitAt) revert WrongPhase();
        if (m.busy != 0) revert Busy();
        uint256 amount = m.stake;
        m.stake = 0;
        m.exitAt = 0;
        totalStake -= amount;
        uint256 i = m.index - 1;
        address last = members[members.length - 1];
        members[i] = last;
        memberOf[last].index = uint32(i + 1);
        members.pop();
        m.index = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BadValue();
        emit Withdrawn(msg.sender, amount);
    }

    /// In the draw: staked at least minStake and not leaving.
    function eligible(address w) external view returns (bool) {
        Member storage m = memberOf[w];
        return m.index != 0 && m.exitAt == 0 && m.stake >= minStake;
    }

    function size() external view returns (uint256) {
        return members.length;
    }

    // ---------------------------------------------------------------- markets

    /// Locks (+1) or releases (-1) a member while a market holds a seat or an assignment of it.
    function lock(address w, bool on) external onlyMarket {
        if (on) memberOf[w].busy++;
        else memberOf[w].busy--;
    }

    /// Takes up to `amount` of a member's stake (what is there) and sends it to the calling market.
    function slash(address w, uint256 amount) external onlyMarket returns (uint256 got) {
        Member storage m = memberOf[w];
        got = amount < m.stake ? amount : m.stake;
        if (got == 0) return 0;
        m.stake -= uint128(got);
        totalStake -= got;
        emit Slashed(w, msg.sender, got);
        (bool ok, ) = msg.sender.call{value: got}("");
        if (!ok) revert NotMarket();
    }

    // ---------------------------------------------------------------- governance (a timelock)

    function setMarket(address market, bool on) external onlyGovernance {
        markets[market] = on;
        emit MarketSet(market, on);
    }

    function setParams(uint128 minStake_, uint32 exitDelay_) external onlyGovernance {
        _setParams(minStake_, exitDelay_);
    }

    function setGovernance(address next) external onlyGovernance {
        _checkTimelock(next);
        governance = next;
        emit GovernanceSet(next);
    }

    function _setParams(uint128 minStake_, uint32 exitDelay_) internal {
        if (minStake_ == 0 || exitDelay_ == 0) revert BadValue();
        minStake = minStake_;
        exitDelay = exitDelay_;
        emit ParamsSet(minStake_, exitDelay_);
    }

    function _checkTimelock(address t) internal view {
        if (t.code.length == 0) revert NotTimelock();
        try ITPMinDelay(t).getMinDelay() returns (uint256 d) {
            if (d < MIN_DELAY) revert NotTimelock();
        } catch {
            revert NotTimelock();
        }
    }
}
