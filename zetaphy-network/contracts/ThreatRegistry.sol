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
///
///         Vaccine: a fingerprint can only be computed off chain, so the same
///         votes can also flag exact identities that contracts can check:
///           - codeKey(h):         EVM code with extcodehash h on ZETAPHY
///           - addressKey(id, a):  address a on the chain with EVM id `id`
///                                 (bridge senders, source tokens/contracts)
///         Every key lives in the same table, with the same quorum and the
///         same way back (clear). voteBatch lets a runner vote for a flagged
///         fingerprint together with the code hashes and addresses it found
///         for it, in one tx; each key still needs its own quorum.
///         BridgeAirlock / BridgeGuard refuse flagged sources and recipients,
///         and the ZETAPHY wallet refuses to sign calls to flagged code.
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

    /// keccak256 of empty code: every account without code has it, so it is never a threat.
    bytes32 public constant EMPTY_CODEHASH = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    /// The key under which EVM code with this extcodehash is flagged.
    function codeKey(bytes32 codeHash) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.threat.code", codeHash));
    }

    /// The key under which an address on a given chain (EVM chain id) is flagged.
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.threat.address", chainId, who));
    }

    function _checkRunner() private view {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    /// Vote to flag (flag = true, with a reason) or to clear (flag = false).
    /// `fingerprint` is any key: a fp1 fingerprint, codeKey(..) or addressKey(..).
    function vote(bytes32 fingerprint, bool flag, Reason reason) external {
        _checkRunner();
        if (!_vote(fingerprint, flag, reason)) revert NoChange();
    }

    /// One runner's votes on several keys at once, e.g. a fingerprint plus the
    /// code hashes and addresses of its copies. Keys already in that state, or
    /// already voted on by this runner this round, are skipped (not an error),
    /// so the same list can be sent again as copies are found.
    function voteBatch(bytes32[] calldata keys, bool flag, Reason reason) external returns (uint256 counted) {
        _checkRunner();
        if (flag && reason == Reason.None) revert NoChange();
        for (uint256 i = 0; i < keys.length; i++) {
            Entry storage e = entries[keys[i]];
            if (e.flagged == flag || voted[keys[i]][e.round][msg.sender]) continue;
            _vote(keys[i], flag, reason);
            counted++;
        }
        if (counted == 0) revert NoChange();
    }

    function _vote(bytes32 fingerprint, bool flag, Reason reason) private returns (bool) {
        Entry storage e = entries[fingerprint];
        if (e.flagged == flag || (flag && reason == Reason.None)) return false;
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
        return true;
    }

    function isFlagged(bytes32 fingerprint) external view returns (bool, Reason) {
        Entry storage e = entries[fingerprint];
        return (e.flagged, e.reason);
    }

    /// EVM code with this code hash (extcodehash) is flagged. Empty code never is.
    function isCodeFlagged(bytes32 codeHash) public view returns (bool, Reason) {
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODEHASH) return (false, Reason.None);
        Entry storage e = entries[codeKey(codeHash)];
        return (e.flagged, e.reason);
    }

    function isAddressFlagged(uint256 chainId, address who) public view returns (bool, Reason) {
        Entry storage e = entries[addressKey(chainId, who)];
        return (e.flagged, e.reason);
    }

    /// For contracts on this chain: `who` itself is flagged, or the code at it is.
    function isContractFlagged(address who) external view returns (bool, Reason) {
        (bool f, Reason r) = isAddressFlagged(block.chainid, who);
        if (f) return (f, r);
        return isCodeFlagged(who.codehash);
    }

    function flaggedCount() external view returns (uint256) {
        return flaggedList.length;
    }
}
