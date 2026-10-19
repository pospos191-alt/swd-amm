// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRunnersView {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// @title ComputeMarket: pay node runners in ZETAPHY for AI work (stage 4)
/// @notice Model output (tier 2+) is not deterministic, so it cannot be
///         settled by 2-of-3 agreement like Neuro tier 1. Instead: escrow.
///         The requester pays up front; a runner with a NeuroJobs track
///         record takes the task and delivers a result (hash + URI); the
///         requester accepts or rejects within REVIEW. Silence pays the
///         runner. Both sides' reject counts are public, so runners can avoid
///         requesters who reject everything, and requesters can avoid runners
///         who deliver junk.
contract ComputeMarket {
    uint64 public constant REVIEW = 1 days;

    enum Status { None, Open, Taken, Delivered, Paid, Refunded }

    struct Task {
        address requester;
        address runner;
        Status status;
        uint64 deadline;     // delivery due
        uint64 deliveredAt;
        bytes32 model;       // e.g. "llama-3.1-8b-instruct-q4"
        bytes32 inputHash;
        bytes32 resultHash;
        uint256 price;
        string inputURI;
        string resultURI;
    }

    IRunnersView public immutable runners;
    uint32 public immutable minAgreed;
    Task[] internal tasks;
    mapping(address => uint256) public credit;
    mapping(address => uint32) public runnerDone;
    mapping(address => uint32) public runnerRejected;
    mapping(address => uint32) public requesterRejections;

    event Requested(uint256 indexed id, bytes32 indexed model, uint256 price, uint64 deadline);
    event Taken(uint256 indexed id, address indexed runner);
    event Delivered(uint256 indexed id, bytes32 resultHash, string resultURI);
    event Settled(uint256 indexed id, Status status);

    error BadValue();
    error BadState();
    error NotAllowed();
    error TooEarly();
    error Nothing();

    constructor(IRunnersView runners_, uint32 minAgreed_) {
        runners = runners_;
        minAgreed = minAgreed_;
    }

    function request(bytes32 model, bytes32 inputHash, string calldata inputURI, uint64 seconds_) external payable returns (uint256 id) {
        if (msg.value == 0 || model == bytes32(0) || seconds_ == 0 || seconds_ > 7 days || bytes(inputURI).length > 256) revert BadValue();
        id = tasks.length;
        Task storage t = tasks.push();
        t.requester = msg.sender;
        t.status = Status.Open;
        t.deadline = uint64(block.timestamp) + seconds_;
        t.model = model;
        t.inputHash = inputHash;
        t.inputURI = inputURI;
        t.price = msg.value;
        emit Requested(id, model, msg.value, t.deadline);
    }

    function take(uint256 id) external {
        Task storage t = _task(id, Status.Open);
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed || msg.sender == t.requester) revert NotAllowed();
        if (block.timestamp >= t.deadline) revert BadState();
        t.runner = msg.sender;
        t.status = Status.Taken;
        emit Taken(id, msg.sender);
    }

    function deliver(uint256 id, bytes32 resultHash, string calldata resultURI) external {
        Task storage t = _task(id, Status.Taken);
        if (msg.sender != t.runner) revert NotAllowed();
        if (block.timestamp > t.deadline || resultHash == bytes32(0) || bytes(resultURI).length > 256) revert BadValue();
        t.resultHash = resultHash;
        t.resultURI = resultURI;
        t.deliveredAt = uint64(block.timestamp);
        t.status = Status.Delivered;
        emit Delivered(id, resultHash, resultURI);
    }

    function accept(uint256 id) external {
        Task storage t = _task(id, Status.Delivered);
        if (msg.sender != t.requester) revert NotAllowed();
        _pay(id, t);
    }

    function reject(uint256 id) external {
        Task storage t = _task(id, Status.Delivered);
        if (msg.sender != t.requester) revert NotAllowed();
        if (block.timestamp > t.deliveredAt + REVIEW) revert BadState();
        runnerRejected[t.runner] += 1;
        requesterRejections[t.requester] += 1;
        _refund(id, t);
    }

    /// The runner is paid once the review window passes without a rejection.
    function claim(uint256 id) external {
        Task storage t = _task(id, Status.Delivered);
        if (block.timestamp <= t.deliveredAt + REVIEW) revert TooEarly();
        _pay(id, t);
    }

    /// Requester gets the money back if nobody took the task, or nothing was delivered in time.
    function cancel(uint256 id) external {
        if (id >= tasks.length) revert BadState();
        Task storage t = tasks[id];
        if (msg.sender != t.requester) revert NotAllowed();
        bool open = t.status == Status.Open;
        bool late = t.status == Status.Taken && block.timestamp > t.deadline;
        if (!open && !late) revert BadState();
        _refund(id, t);
    }

    function withdraw() external {
        uint256 a = credit[msg.sender];
        if (a == 0) revert Nothing();
        credit[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "transfer failed");
    }

    function taskCount() external view returns (uint256) { return tasks.length; }

    function getTask(uint256 id) external view returns (Task memory) {
        if (id >= tasks.length) revert BadState();
        return tasks[id];
    }

    function _task(uint256 id, Status want) private view returns (Task storage t) {
        if (id >= tasks.length) revert BadState();
        t = tasks[id];
        if (t.status != want) revert BadState();
    }

    function _pay(uint256 id, Task storage t) private {
        t.status = Status.Paid;
        credit[t.runner] += t.price;
        runnerDone[t.runner] += 1;
        emit Settled(id, Status.Paid);
    }

    function _refund(uint256 id, Task storage t) private {
        t.status = Status.Refunded;
        credit[t.requester] += t.price;
        emit Settled(id, Status.Refunded);
    }
}
