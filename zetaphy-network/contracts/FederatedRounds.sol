// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FederatedRounds: commit-reveal inbox for Neuro's federated updates (testnet)
/// @notice Browsers send their clipped + noised update (zetaphy-neuro/ml/fl/codec.js
///         bytes) in two steps, so nobody can tailor an update to the others of
///         the same round:
///           1. commit phase: commit(round, keccak256(abi.encode(keccak256(payload), salt, sender)))
///           2. reveal phase: reveal(round, salt, payload) emits the payload.
///         The aggregator (a scheduled GitHub Actions job or a runner) reads
///         the Revealed events after the round; the transaction's sender is the
///         update's signer. No server, no storage of payloads (events only).
///
///         Round r covers blocks [start + r*period, start + (r+1)*period) with
///         period = commitBlocks + revealBlocks; the first commitBlocks of it
///         are the commit phase, the rest the reveal phase.
///
///         Limits (testnet): one commitment per address per round, at most
///         maxPerRound commitments per round, payload <= 16 KiB. Sybil
///         resistance is NOT provided here: robust aggregation bounds what a
///         minority of addresses can do (docs/future/federated.md).
contract FederatedRounds {
    uint256 public constant MAX_PAYLOAD = 16384;

    address public governance;
    bool public paused;
    uint64 public immutable start;
    uint64 public immutable commitBlocks;
    uint64 public immutable revealBlocks;
    uint32 public maxPerRound;

    mapping(uint256 => mapping(address => bytes32)) public commitmentOf;
    mapping(uint256 => mapping(address => bool)) public revealed;
    mapping(uint256 => uint32) public commits;
    mapping(uint256 => uint32) public reveals;

    event Committed(uint256 indexed round, address indexed sender, bytes32 commitment);
    event Revealed(uint256 indexed round, address indexed sender, bytes32 payloadHash, bytes payload);
    event Paused(bool paused);
    event MaxPerRound(uint32 value);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error BadValue();
    error WrongPhase();
    error AlreadyCommitted();
    error RoundFull();
    error BadReveal();
    error IsPaused();

    constructor(address governance_, uint64 start_, uint64 commitBlocks_, uint64 revealBlocks_, uint32 maxPerRound_) {
        if (governance_ == address(0) || commitBlocks_ == 0 || revealBlocks_ == 0 || maxPerRound_ == 0) revert BadValue();
        governance = governance_;
        start = start_;
        commitBlocks = commitBlocks_;
        revealBlocks = revealBlocks_;
        maxPerRound = maxPerRound_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadValue();
        governance = next;
        emit GovernanceChanged(next);
    }

    function setPaused(bool p) external onlyGovernance {
        paused = p;
        emit Paused(p);
    }

    function setMaxPerRound(uint32 n) external onlyGovernance {
        if (n == 0) revert BadValue();
        maxPerRound = n;
        emit MaxPerRound(n);
    }

    /// First block of a round.
    function roundStart(uint256 round) public view returns (uint256) {
        return uint256(start) + round * (uint256(commitBlocks) + revealBlocks);
    }

    /// The round and phase (1 = commit, 2 = reveal) at a block; phase 0 before the first round.
    function phaseAt(uint256 blockNumber) public view returns (uint256 round, uint8 phase) {
        if (blockNumber < start) return (0, 0);
        uint256 period = uint256(commitBlocks) + revealBlocks;
        uint256 off = blockNumber - start;
        round = off / period;
        phase = off % period < commitBlocks ? 1 : 2;
    }

    function commitmentFor(bytes32 payloadHash, bytes32 salt, address sender) public pure returns (bytes32) {
        return keccak256(abi.encode(payloadHash, salt, sender));
    }

    function commit(uint256 round, bytes32 commitment) external {
        if (paused) revert IsPaused();
        (uint256 r, uint8 phase) = phaseAt(block.number);
        if (phase != 1 || r != round) revert WrongPhase();
        if (commitment == bytes32(0)) revert BadValue();
        if (commitmentOf[round][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (commits[round] >= maxPerRound) revert RoundFull();
        commitmentOf[round][msg.sender] = commitment;
        commits[round] += 1;
        emit Committed(round, msg.sender, commitment);
    }

    function reveal(uint256 round, bytes32 salt, bytes calldata payload) external {
        (uint256 r, uint8 phase) = phaseAt(block.number);
        if (phase != 2 || r != round) revert WrongPhase();
        if (payload.length == 0 || payload.length > MAX_PAYLOAD) revert BadValue();
        bytes32 c = commitmentOf[round][msg.sender];
        bytes32 ph = keccak256(payload);
        if (c == bytes32(0) || revealed[round][msg.sender] || c != commitmentFor(ph, salt, msg.sender)) revert BadReveal();
        revealed[round][msg.sender] = true;
        reveals[round] += 1;
        emit Revealed(round, msg.sender, ph, payload);
    }
}
