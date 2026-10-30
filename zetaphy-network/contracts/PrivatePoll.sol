// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZkIdentityPoll {
    function registerScope(uint256 scope) external;
    function verify(uint256 root, uint256 nullifier, uint256 scope, uint256 signalHash, uint256 minLevel, uint256[8] calldata proof)
        external view returns (bool);
}

/// @title PrivatePoll: one anonymous vote per person per poll (testnet)
/// @notice docs/future/zk-identity.md. Each poll is a scope of ZkIdentityRegistry (chosen by its creator, unique in the
///   registry). A vote carries a proof bound to (scope, option), so a relayer cannot change the choice; the nullifier
///   refuses a second vote by the same identity, and is unrelated to the same person's nullifiers in other polls.
///   Tallies are public as votes come in (no hiding of partial results; see the doc for commit-reveal / MACI).
contract PrivatePoll {
    IZkIdentityPoll public immutable registry;

    struct Poll {
        address creator;
        uint8 options;
        uint8 minLevel;
        uint64 endsAt;
        bytes32 question; // hash of the question text (kept off chain)
    }

    mapping(uint256 => Poll) public polls;
    mapping(uint256 => mapping(uint256 => uint256)) public tally;   // scope => option => votes
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed; // scope => nullifier => voted

    event PollCreated(uint256 indexed scope, address indexed creator, bytes32 question, uint8 options, uint8 minLevel, uint64 endsAt);
    event Voted(uint256 indexed scope, uint256 indexed nullifier, uint8 option);

    error BadPoll();
    error NoPoll();
    error Ended();
    error BadOption();
    error AlreadyVoted();
    error BadProof();

    constructor(IZkIdentityPoll registry_) {
        registry = registry_;
    }

    function createPoll(uint256 scope, bytes32 question, uint8 options, uint8 minLevel, uint64 endsAt) external {
        if (options < 2 || minLevel == 0 || endsAt <= block.timestamp) revert BadPoll();
        registry.registerScope(scope); // reverts if the scope is taken
        polls[scope] = Poll({creator: msg.sender, options: options, minLevel: minLevel, endsAt: endsAt, question: question});
        emit PollCreated(scope, msg.sender, question, options, minLevel, endsAt);
    }

    function signalOf(uint256 scope, uint8 option) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(scope, option))) >> 8;
    }

    function vote(uint256 scope, uint8 option, uint256 root, uint256 nullifier, uint256[8] calldata proof) external {
        Poll storage p = polls[scope];
        if (p.creator == address(0)) revert NoPoll();
        if (block.timestamp > p.endsAt) revert Ended();
        if (option >= p.options) revert BadOption();
        if (nullifierUsed[scope][nullifier]) revert AlreadyVoted();
        if (!registry.verify(root, nullifier, scope, signalOf(scope, option), p.minLevel, proof)) revert BadProof();
        nullifierUsed[scope][nullifier] = true;
        tally[scope][option]++;
        emit Voted(scope, nullifier, option);
    }
}
