// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZearlyQ {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title ZETAPHY Early quests: rewards in ZEARLY for things done on the ZETAPHY chain, each paid once per wallet
/// @notice The quests (first swap, liquidity, an Early Pass, staking…) are checked off chain from the chain's own
///         records (zetaphy-network/scripts/early.js quests); this contract pays from its ZEARLY balance and keeps,
///         on chain and for everyone to read, who was paid for which quest, so nobody is paid twice.
///         The operator (the quest job) sets each quest's reward and how many wallets it may pay, and pays.
///         It can take back only ZEARLY nobody was paid. Testnet; no value (zetaphy-chain/rewards/EARLY.md).
contract ZetaphyQuests {
    uint256 public constant MAX_BATCH = 300;

    IZearlyQ public immutable token;
    address public operator;

    struct Quest { uint256 reward; uint32 cap; uint32 count; }
    mapping(uint8 => Quest) public quests;
    mapping(uint8 => mapping(address => bool)) public paid;
    mapping(address => uint256) public earned;

    event OperatorSet(address operator);
    event QuestSet(uint8 indexed quest, uint256 reward, uint32 cap);
    event QuestPaid(uint8 indexed quest, address indexed to, uint256 reward);
    event Withdrawn(address to, uint256 amount);

    error NotOperator();
    error ZeroAddress();
    error BadBatch();
    error NoQuest();
    error TransferFailed();

    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }

    constructor(address token_, address operator_) {
        if (token_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        token = IZearlyQ(token_);
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setOperator(address o) external onlyOperator {
        if (o == address(0)) revert ZeroAddress();
        operator = o;
        emit OperatorSet(o);
    }

    /// @notice A quest's reward per wallet and the most wallets it pays in all (cap 0 = closed).
    function setQuest(uint8 q, uint256 reward, uint32 cap) external onlyOperator {
        quests[q].reward = reward;
        quests[q].cap = cap;
        emit QuestSet(q, reward, cap);
    }

    /// @notice Pays quest `q` to every wallet in `to` not paid for it yet (others are skipped: re-runs are safe),
    ///         until the quest's cap. Returns how many were paid.
    function pay(uint8 q, address[] calldata to) external onlyOperator returns (uint256 n) {
        if (to.length == 0 || to.length > MAX_BATCH) revert BadBatch();
        Quest storage s = quests[q];
        if (s.reward == 0) revert NoQuest();
        for (uint256 i; i < to.length && s.count < s.cap; ++i) {
            address a = to[i];
            if (a == address(0) || paid[q][a]) continue;
            paid[q][a] = true;
            s.count += 1;
            earned[a] += s.reward;
            n++;
            if (!token.transfer(a, s.reward)) revert TransferFailed();
            emit QuestPaid(q, a, s.reward);
        }
    }

    /// @notice Which of quests 0..n-1 a wallet has been paid for (for the hub's Early page).
    function progress(address a, uint8 n) external view returns (bool[] memory done) {
        done = new bool[](n);
        for (uint8 i; i < n; ++i) done[i] = paid[i][a];
    }

    /// @notice Takes back ZEARLY nobody was paid (e.g. after the quests end).
    function withdraw(address to, uint256 amount) external onlyOperator {
        if (to == address(0)) revert ZeroAddress();
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }
}
