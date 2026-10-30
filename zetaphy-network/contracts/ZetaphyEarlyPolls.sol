// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20P {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title ZETAPHY Early polls: community opinion polls weighted by ZEARLY
/// @notice Anyone may open a poll by locking `deposit` ZEARLY (given back when it ends). A vote locks ZEARLY on one
///         option until the poll ends; the weight is the ZEARLY locked, so the same coins cannot vote twice. After
///         the end everyone takes their ZEARLY back. Polls are opinions only: nothing on the chain follows them
///         (the chain's own votes are x/gov). Text is shown as text by the hub. Testnet; no value.
contract ZetaphyEarlyPolls {
    uint256 public constant MAX_OPTIONS = 8;
    uint256 public constant MAX_TEXT = 280;
    uint256 public constant MAX_OPTION_TEXT = 64;
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 30 days;

    IERC20P public immutable token;
    uint256 public immutable deposit;

    struct Poll { address creator; uint64 end; bool depositBack; string question; string[] options; uint256[] tally; }
    Poll[] private polls;
    mapping(uint256 => mapping(address => uint256)) public locked;  // poll => voter => ZEARLY locked
    mapping(uint256 => mapping(address => uint8)) public choiceOf;  // option index + 1 (0 = has not voted)

    event PollCreated(uint256 indexed id, address indexed creator, uint64 end);
    event Voted(uint256 indexed id, address indexed voter, uint8 option, uint256 amount);
    event Released(uint256 indexed id, address indexed who, uint256 amount);

    error BadPoll();
    error Ended();
    error NotEnded();
    error OtherOption();
    error ZeroAmount();
    error NothingLocked();
    error TransferFailed();

    constructor(address token_, uint256 deposit_) {
        if (token_ == address(0)) revert BadPoll();
        token = IERC20P(token_);
        deposit = deposit_;
    }

    function create(string calldata question, string[] calldata options, uint64 duration) external returns (uint256 id) {
        if (bytes(question).length == 0 || bytes(question).length > MAX_TEXT) revert BadPoll();
        if (options.length < 2 || options.length > MAX_OPTIONS) revert BadPoll();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadPoll();
        for (uint256 i; i < options.length; ++i) {
            if (bytes(options[i]).length == 0 || bytes(options[i]).length > MAX_OPTION_TEXT) revert BadPoll();
        }
        if (deposit != 0 && !token.transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();
        id = polls.length;
        Poll storage p = polls.push();
        p.creator = msg.sender;
        p.end = uint64(block.timestamp) + duration;
        p.question = question;
        for (uint256 i; i < options.length; ++i) { p.options.push(options[i]); p.tally.push(0); }
        emit PollCreated(id, msg.sender, p.end);
    }

    /// @notice Locks `amount` ZEARLY on `option` until the poll ends (more can be added to the same option).
    function vote(uint256 id, uint8 option, uint256 amount) external {
        if (id >= polls.length) revert BadPoll();
        Poll storage p = polls[id];
        if (block.timestamp >= p.end) revert Ended();
        if (option >= p.options.length) revert BadPoll();
        if (amount == 0) revert ZeroAmount();
        uint8 c = choiceOf[id][msg.sender];
        if (c != 0 && c != option + 1) revert OtherOption();
        choiceOf[id][msg.sender] = option + 1;
        locked[id][msg.sender] += amount;
        p.tally[option] += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Voted(id, msg.sender, option, amount);
    }

    /// @notice After the end: the voter's locked ZEARLY back, and the creator's deposit.
    function release(uint256 id) external {
        if (id >= polls.length) revert BadPoll();
        Poll storage p = polls[id];
        if (block.timestamp < p.end) revert NotEnded();
        uint256 amount = locked[id][msg.sender];
        locked[id][msg.sender] = 0;
        if (msg.sender == p.creator && !p.depositBack) { p.depositBack = true; amount += deposit; }
        if (amount == 0) revert NothingLocked();
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Released(id, msg.sender, amount);
    }

    function count() external view returns (uint256) { return polls.length; }

    function poll(uint256 id) external view returns (address creator, uint64 end, string memory question, string[] memory options, uint256[] memory tally) {
        if (id >= polls.length) revert BadPoll();
        Poll storage p = polls[id];
        return (p.creator, p.end, p.question, p.options, p.tally);
    }
}
