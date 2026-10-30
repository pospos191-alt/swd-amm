// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20F {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title ZETAPHY Early farm: stake ZEARLY/ZETAPHY pool shares (LP), earn ZEARLY over time
/// @notice The classic StakingRewards design: the operator funds a reward period (ZEARLY sent here first, then
///         `notifyReward`), rewards stream per second to stakers by their share of the stake. Stakers can withdraw
///         their LP and claim at any time; nobody else can touch the staked LP. The operator can only take back
///         ZEARLY that no reward period promised; what streams while nothing is staked is owed to nobody and
///         stops being promised at the next update, so the operator can recover it (EF-1). Testnet; no value
///         (zetaphy-chain/rewards/EARLY.md).
contract ZetaphyEarlyFarm {
    IERC20F public immutable stakingToken; // the ZEARLY/ZETAPHY pair (LP)
    IERC20F public immutable rewardsToken; // ZEARLY
    address public operator;

    uint256 public periodFinish;
    uint256 public rewardRate;          // ZEARLY per second
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;
    uint256 public owed;                // rewards promised and not yet claimed (funded, never withdrawable)

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userPaid;
    mapping(address => uint256) public rewards;

    uint256 private locked = 1;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 duration);
    event OperatorSet(address operator);

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error Underfunded();
    error PeriodActive();
    error Reentrancy();
    error TransferFailed();

    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }
    modifier nonReentrant() { if (locked != 1) revert Reentrancy(); locked = 2; _; locked = 1; }
    modifier update(address a) {
        uint256 t = lastTime();
        if (totalSupply == 0 && t > lastUpdate) {
            // nobody staked: what streamed since lastUpdate is owed to nobody; it is no longer promised, so
            // recover() can take it back (EF-1)
            owed -= (t - lastUpdate) * rewardRate;
        } else {
            rewardPerTokenStored = rewardPerToken();
        }
        lastUpdate = t;
        if (a != address(0)) { rewards[a] = earned(a); userPaid[a] = rewardPerTokenStored; }
        _;
    }

    constructor(address lp, address zearly, address operator_) {
        if (lp == address(0) || zearly == address(0) || operator_ == address(0)) revert ZeroAddress();
        if (lp == zearly) revert ZeroAddress(); // staked LP and rewards are kept apart
        stakingToken = IERC20F(lp);
        rewardsToken = IERC20F(zearly);
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function lastTime() public view returns (uint256) { return block.timestamp < periodFinish ? block.timestamp : periodFinish; }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (lastTime() - lastUpdate) * rewardRate * 1e18 / totalSupply;
    }

    function earned(address a) public view returns (uint256) {
        return balanceOf[a] * (rewardPerToken() - userPaid[a]) / 1e18 + rewards[a];
    }

    function stake(uint256 amount) external nonReentrant update(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        if (!stakingToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant update(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        if (!stakingToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant update(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r == 0) return;
        rewards[msg.sender] = 0;
        owed -= r;
        if (!rewardsToken.transfer(msg.sender, r)) revert TransferFailed();
        emit RewardPaid(msg.sender, r);
    }

    function exit() external {
        uint256 b = balanceOf[msg.sender];
        if (b != 0) withdraw(b);
        getReward();
    }

    /// @notice Starts (or extends) a reward period: `reward` ZEARLY over `duration` seconds. The ZEARLY must be here
    ///         already, on top of what earlier periods still owe.
    function notifyReward(uint256 reward, uint256 duration) external onlyOperator update(address(0)) {
        if (duration == 0) revert ZeroAmount();
        uint256 left = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        uint256 total = reward + left;
        // what earlier periods already streamed and nobody claimed yet is `owed` minus `left`
        uint256 streamed = owed - left;
        if (rewardsToken.balanceOf(address(this)) < streamed + total) revert Underfunded();
        rewardRate = total / duration;
        owed = streamed + rewardRate * duration;
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, duration);
    }

    /// @notice Takes back ZEARLY no reward period promised (never the staked LP, never what stakers are owed).
    function recover(address to, uint256 amount) external onlyOperator {
        if (to == address(0)) revert ZeroAddress();
        if (rewardsToken.balanceOf(address(this)) < owed + amount) revert Underfunded();
        if (!rewardsToken.transfer(to, amount)) revert TransferFailed();
    }

    function setOperator(address o) external onlyOperator {
        if (o == address(0)) revert ZeroAddress();
        operator = o;
        emit OperatorSet(o);
    }
}
