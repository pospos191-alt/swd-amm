// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The parts of ThreatRegistry this contract reads.
interface IThreatRegistryView {
    function governance() external view returns (address);
    function quorum() external view returns (uint8);
    function voted(bytes32 key, uint32 round, address runner) external view returns (bool);
    function entries(bytes32 key) external view returns (
        bool flagged, uint8 reason, uint64 updatedAt, uint32 round, uint8 votes, bool fast, uint8 support, uint64 fastAt);
}

/// @title ThreatReports: anyone can point the Neuro runners at a contract to check
/// @notice A user who wants a contract's code checked pays a small fee and
///         reports it: report(key, chainKey, target, note). Runners' tools
///         watch the Reported event, run Neuro on the target and, if a
///         reproducible code fact shows up (ThreatRegistry.Reason, with its
///         evidence), flag the key in the ThreatRegistry (the usual quorum;
///         reports never flag anything by themselves, and a report is a request
///         to check, not a finding).
///         The fee is the anti-spam and the runners' reward:
///           - the key is flagged after the report: the runners who set that
///             flag (the registry's quorum of that round) share the fee; each
///             claims its share (claim);
///           - not flagged within `ttl`: the fee goes to the community fund.
///         settle(id) decides which (anyone may call it).
///         Input is bounded: a note of at most MAX_NOTE bytes, one key per report.
///         Governance is the ThreatRegistry's governance.
contract ThreatReports {
    struct Report {
        bytes32 key;          // ThreatRegistry key: fp1, codeKey(..) or addressKey(..)
        bytes32 chainKey;     // where the target lives, e.g. "eip155:56" or "bsc" (bytes32 string)
        address target;       // the contract on that chain (zero: none given)
        address reporter;
        uint64 createdAt;
        uint8 state;          // 0 open, 1 flagged (runners claim), 2 not flagged (to the fund)
        uint32 flagRound;     // the registry round whose voters share the fee
        uint128 fee;          // what was paid
        uint128 share;        // each voter's share once flagged
        uint8 claims;         // shares paid (at most the registry's quorum)
    }

    uint256 public constant MAX_NOTE = 280;
    uint256 public constant MAX_FEE = 100 ether;
    uint64 public constant MIN_TTL = 1 days;
    uint64 public constant MAX_TTL = 365 days;

    IThreatRegistryView public immutable registry;
    uint256 public fee;
    uint64 public ttl;
    address public communityFund;
    Report[] public reports;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Reported(uint256 indexed id, bytes32 indexed key, bytes32 indexed chainKey, address target, address reporter, uint256 fee, string note);
    event Settled(uint256 indexed id, bool flagged, uint256 share);
    event Claimed(uint256 indexed id, address indexed runner, uint256 amount);
    event FeeSet(uint256 fee);
    event TtlSet(uint64 ttl);
    event CommunityFundSet(address fund);

    error NotGovernance();
    error BadFee(uint256 fee);
    error NoteTooLong();
    error BadKey();
    error AlreadyFlagged();
    error NotSettled();
    error AlreadySettled();
    error NotYet();
    error NotVoter();
    error PayFailed();

    constructor(IThreatRegistryView registry_, address communityFund_, uint256 fee_, uint64 ttl_) {
        require(communityFund_ != address(0), "fund");
        require(fee_ <= MAX_FEE, "fee");
        require(ttl_ >= MIN_TTL && ttl_ <= MAX_TTL, "ttl");
        registry = registry_;
        communityFund = communityFund_;
        fee = fee_;
        ttl = ttl_;
    }

    modifier onlyGov() { if (msg.sender != registry.governance()) revert NotGovernance(); _; }

    function setFee(uint256 f) external onlyGov { require(f <= MAX_FEE, "fee"); fee = f; emit FeeSet(f); }
    function setTtl(uint64 t) external onlyGov { require(t >= MIN_TTL && t <= MAX_TTL, "ttl"); ttl = t; emit TtlSet(t); }
    function setCommunityFund(address f) external onlyGov { require(f != address(0), "fund"); communityFund = f; emit CommunityFundSet(f); }

    /// Ask the runners to check a contract. `key` is the registry key the runners
    /// would flag; send exactly `fee`. A key that is already flagged needs no
    /// report (and would pay nobody for new work), so it is refused.
    function report(bytes32 key, bytes32 chainKey, address target, string calldata note) external payable returns (uint256 id) {
        if (msg.value != fee) revert BadFee(fee);
        if (bytes(note).length > MAX_NOTE) revert NoteTooLong();
        if (key == bytes32(0)) revert BadKey();
        (bool flagged, , , , , , , ) = registry.entries(key);
        if (flagged) revert AlreadyFlagged();
        id = reports.length;
        reports.push(Report(key, chainKey, target, msg.sender, uint64(block.timestamp), 0, 0, uint128(msg.value), 0, 0));
        emit Reported(id, key, chainKey, target, msg.sender, msg.value, note);
    }

    /// Flagged since the report: the voters of that flag share the fee. Not
    /// flagged and older than ttl: the fee goes to the community fund.
    function settle(uint256 id) external {
        Report storage r = reports[id];
        if (r.state != 0) revert AlreadySettled();
        (bool flagged, , uint64 updatedAt, uint32 round, , , , ) = registry.entries(r.key);
        if (flagged && updatedAt >= r.createdAt) {
            uint256 q = registry.quorum();
            r.state = 1;
            r.flagRound = round - 1; // the round that set the standing flag
            r.share = uint128(r.fee / q);
            uint256 dust = r.fee - r.share * q;
            if (dust != 0) _pay(communityFund, dust);
            emit Settled(id, true, r.share);
        } else if (block.timestamp >= uint256(r.createdAt) + ttl) {
            r.state = 2;
            _pay(communityFund, r.fee);
            emit Settled(id, false, 0);
        } else revert NotYet();
    }

    /// A runner who voted for the flag that settled this report takes its share.
    function claim(uint256 id) external {
        Report storage r = reports[id];
        if (r.state != 1) revert NotSettled();
        if (claimed[id][msg.sender]) revert AlreadySettled();
        if (!registry.voted(r.key, r.flagRound, msg.sender)) revert NotVoter();
        if (r.claims >= registry.quorum()) revert AlreadySettled(); // never more than the fee
        r.claims += 1;
        claimed[id][msg.sender] = true;
        _pay(msg.sender, r.share);
        emit Claimed(id, msg.sender, r.share);
    }

    function reportCount() external view returns (uint256) {
        return reports.length;
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }
}
