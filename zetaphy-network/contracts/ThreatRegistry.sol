// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// @title ThreatRegistry: Neuro's immune system (stage 4)
/// @notice When one Neuro runner spots a scam contract, every copy of that
///         code everywhere should be flagged. Active, bonded NeuroJobs runners
///         with a track record vote to flag a code fingerprint (Neuro's fp1:
///         sha256 of the code with addresses/immutables masked). At QUORUM
///         distinct votes the fingerprint is flagged, and every Neuro instance
///         that reads this registry warns about it, on every chain.
///         A flag is cleared the same way (QUORUM votes to clear), so a wrong
///         flag can be appealed to the network, not to one operator.
contract ThreatRegistry {
    IRunners public immutable runners;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed; // verdicts a runner must have had accepted to vote

    enum Reason { None, Drainer, Honeypot, HiddenMint, FakeToken, Phishing, Other }

    struct Entry {
        bool flagged;
        Reason reason;
        uint64 updatedAt;
        uint32 round;        // bumps on every flag/clear so old votes stop counting
        uint8 votes;
    }

    mapping(bytes32 => Entry) public entries;
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public voted;
    bytes32[] public flaggedList;

    event Voted(bytes32 indexed fingerprint, address indexed runner, bool flag, Reason reason);
    event Flagged(bytes32 indexed fingerprint, Reason reason);
    event Cleared(bytes32 indexed fingerprint);

    error NotRunner();
    error AlreadyVoted();
    error NoChange();

    constructor(IRunners runners_, uint8 quorum_, uint32 minAgreed_) {
        require(quorum_ >= 2, "quorum");
        runners = runners_;
        quorum = quorum_;
        minAgreed = minAgreed_;
    }

    /// Vote to flag (flag = true, with a reason) or to clear (flag = false).
    function vote(bytes32 fingerprint, bool flag, Reason reason) external {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
        Entry storage e = entries[fingerprint];
        if (e.flagged == flag || (flag && reason == Reason.None)) revert NoChange();
        if (voted[fingerprint][e.round][msg.sender]) revert AlreadyVoted();
        voted[fingerprint][e.round][msg.sender] = true;
        e.votes += 1;
        if (flag && e.reason == Reason.None) e.reason = reason; // first voter's reason; all must agree it is bad
        emit Voted(fingerprint, msg.sender, flag, reason);
        if (e.votes >= quorum) {
            e.flagged = flag;
            e.round += 1;
            e.votes = 0;
            e.updatedAt = uint64(block.timestamp);
            if (flag) { flaggedList.push(fingerprint); emit Flagged(fingerprint, e.reason); }
            else { e.reason = Reason.None; emit Cleared(fingerprint); }
        }
    }

    function isFlagged(bytes32 fingerprint) external view returns (bool, Reason) {
        Entry storage e = entries[fingerprint];
        return (e.flagged, e.reason);
    }

    function flaggedCount() external view returns (uint256) {
        return flaggedList.length;
    }
}
