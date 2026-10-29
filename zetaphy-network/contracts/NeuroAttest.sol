// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// "Neuro-checked" certificates and a hash anchor (docs/future/crosschain-assist.md, items 19 and 30).
//
// NeuroAttest: a minimal EAS-like attestation registry with one schema, "zetaphy.neuro-checked.v1":
// a token (subject, on this chain) was checked by Neuro, with the report's hash (Neuro's verdict hash,
// zetaphy-neuro/src/verdict.js), the skill id of the Neuro code that made it (zetaphy-network/src/skill.js)
// and the AI model, if any (a short name; "rules" when only the rules ran). Two ways in:
//   - attestFromJob(jobId, token): anyone, for a NeuroJobs job on chain "zetaphy" about that token whose
//     verdict is settled (2-of-3 runners agreed, no challenge open or possible): the attester is NeuroJobs
//     itself, the report hash is the job's verdict, the skill the job's. Nobody's word is needed.
//   - attest(...): an attester governance approved (the launch tools' deployer key, testnet), for a token
//     it just created and checked; the badge says who attested.
// Governance (the chain's gov module through MsgEVMCall, or the timelock) revokes any attestation with a
// reason; an attester may revoke its own. A certificate says "Neuro checked this code and here is the
// report", never "safe": wallets and the DEX show it next to the report and any ThreatRegistry flag.
//
// NeuroAnchor: anyone anchors a 32-byte hash once; the first block and time stay (the PQ attestation archive
// of item 30 anchors its hash here, so an archive can be shown to have existed by then).

interface INAJobs {
    function getJob(uint256 id) external view returns (address requester, uint64 created, uint8 status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat);
    function jobInfo(uint256 id) external view returns (bytes32 skill, uint256 bodies, uint256 drawn, uint64 settleAt, bytes32 rand);
    function assurance(uint256 id) external view returns (uint8 agreedBy, uint8 state, uint64 challengeUntil, bool settled);
}

contract NeuroAttest {
    bytes32 public constant SCHEMA = keccak256("zetaphy.neuro-checked.v1");
    bytes32 public constant ZETAPHY_CHAIN = "zetaphy";   // NeuroJobs' chain id for this chain
    uint256 public constant MAX_URI = 200;
    uint256 public constant MAX_REASON = 200;

    struct Attestation {
        bytes32 schema;
        address subject;      // the token (on this chain)
        address attester;     // NeuroJobs for attestFromJob, else the approved attester
        uint64 time;
        uint64 revokedAt;     // 0: valid
        bytes32 reportHash;   // Neuro's verdict hash of the report
        bytes32 skill;        // the Neuro skill id (code version) that made it
        bytes32 model;        // AI model (short name as bytes32), "rules" when none
        uint256 jobId;        // the NeuroJobs job (attestFromJob; attester == jobs), else 0
        string uri;           // where the report can be read (at most MAX_URI bytes)
    }

    INAJobs public immutable jobs;        // zero: attestFromJob off
    address public governance;
    mapping(address => bool) public attester;
    Attestation[] private _all;           // uid = index + 1
    mapping(address => uint256) public latestOf;    // subject -> newest uid
    mapping(uint256 => bool) public jobUsed;
    mapping(uint256 => string) public revokeReason;

    event Attested(uint256 indexed uid, address indexed subject, address indexed attester, bytes32 reportHash, bytes32 skill, bytes32 model, uint256 jobId);
    event Revoked(uint256 indexed uid, address indexed by, string reason);
    event AttesterSet(address indexed who, bool on);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotAttester();
    error NoSuchAttestation();
    error AlreadyRevoked();
    error TooLong();
    error NotSettled(uint256 jobId);
    error WrongJob(uint256 jobId);
    error JobUsed(uint256 jobId);
    error NoReport();

    constructor(INAJobs jobs_, address governance_) {
        require(governance_ != address(0), "zero");
        jobs = jobs_;
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }
    function setAttester(address who, bool on) external onlyGov { attester[who] = on; emit AttesterSet(who, on); }

    /// An approved attester certifies `subject` (a token it created and ran Neuro on).
    function attest(address subject, bytes32 reportHash, bytes32 skill, bytes32 model, string calldata uri) external returns (uint256) {
        if (!attester[msg.sender]) revert NotAttester();
        if (skill == bytes32(0)) revert NoReport();
        return _attest(subject, msg.sender, reportHash, skill, model, 0, uri);
    }

    /// Anyone: a settled NeuroJobs verdict on chain "zetaphy" about `subject` becomes its certificate.
    function attestFromJob(uint256 jobId, address subject) external returns (uint256) {
        if (address(jobs) == address(0)) revert NotSettled(jobId);
        if (jobUsed[jobId]) revert JobUsed(jobId);
        (, , , bool settled) = jobs.assurance(jobId);
        if (!settled) revert NotSettled(jobId);
        (, , , bytes32 chain, string memory target, , bytes32 result, , , ) = jobs.getJob(jobId);
        if (chain != ZETAPHY_CHAIN || keccak256(_lower(bytes(target))) != keccak256(_addr(subject))) revert WrongJob(jobId);
        (bytes32 skill, , , , ) = jobs.jobInfo(jobId);
        jobUsed[jobId] = true;
        return _attest(subject, address(jobs), result, skill, "rules", jobId, "");
    }

    function _attest(address subject, address by, bytes32 reportHash, bytes32 skill, bytes32 model, uint256 jobId, string memory uri) private returns (uint256 uid) {
        if (reportHash == bytes32(0) || subject == address(0)) revert NoReport();
        if (bytes(uri).length > MAX_URI) revert TooLong();
        _all.push(Attestation(SCHEMA, subject, by, uint64(block.timestamp), 0, reportHash, skill, model, jobId, uri));
        uid = _all.length;
        latestOf[subject] = uid;
        emit Attested(uid, subject, by, reportHash, skill, model, jobId);
    }

    /// Governance revokes any attestation; an attester its own.
    function revoke(uint256 uid, string calldata reason) external {
        Attestation storage a = _get(uid);
        if (msg.sender != governance && !(msg.sender == a.attester && attester[msg.sender])) revert NotGovernance();
        if (a.revokedAt != 0) revert AlreadyRevoked();
        if (bytes(reason).length > MAX_REASON) revert TooLong();
        a.revokedAt = uint64(block.timestamp);
        revokeReason[uid] = reason;
        emit Revoked(uid, msg.sender, reason);
    }

    function _get(uint256 uid) private view returns (Attestation storage) {
        if (uid == 0 || uid > _all.length) revert NoSuchAttestation();
        return _all[uid - 1];
    }

    function getAttestation(uint256 uid) external view returns (Attestation memory) { return _get(uid); }
    function count() external view returns (uint256) { return _all.length; }

    /// The badge: the subject's newest attestation, if it is not revoked.
    /// (checked, uid, reportHash, skill, model, attester, time)
    function badge(address subject) external view returns (bool checked, uint256 uid, bytes32 reportHash, bytes32 skill, bytes32 model, address by, uint64 time) {
        uid = latestOf[subject];
        if (uid == 0) return (false, 0, 0, 0, 0, address(0), 0);
        Attestation storage a = _all[uid - 1];
        return (a.revokedAt == 0, uid, a.reportHash, a.skill, a.model, a.attester, a.time);
    }

    function _lower(bytes memory b) private pure returns (bytes memory) {
        for (uint256 i = 0; i < b.length; ++i) if (b[i] >= "A" && b[i] <= "Z") b[i] = bytes1(uint8(b[i]) + 32);
        return b;
    }

    function _addr(address a) private pure returns (bytes memory out) {
        bytes16 h = "0123456789abcdef";
        out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; ++i) {
            uint8 c = uint8(uint160(a) >> (8 * (19 - i)));
            out[2 + 2 * i] = h[c >> 4];
            out[3 + 2 * i] = h[c & 0x0f];
        }
    }
}

/// @title NeuroAnchor: the first time a hash was seen on ZETAPHY
contract NeuroAnchor {
    struct Anchor { uint64 time; uint64 blockNumber; address by; }
    mapping(bytes32 => Anchor) public anchors;
    event Anchored(bytes32 indexed hash, address indexed by, uint64 time);
    error AlreadyAnchored(uint64 time);
    error Zero();

    function anchor(bytes32 h) external {
        if (h == bytes32(0)) revert Zero();
        if (anchors[h].time != 0) revert AlreadyAnchored(anchors[h].time);
        anchors[h] = Anchor(uint64(block.timestamp), uint64(block.number), msg.sender);
        emit Anchored(h, msg.sender, uint64(block.timestamp));
    }

    /// (time, block, by) of the first anchor; time 0: never anchored.
    function anchoredAt(bytes32 h) external view returns (uint64, uint64, address) {
        Anchor storage a = anchors[h];
        return (a.time, a.blockNumber, a.by);
    }
}
