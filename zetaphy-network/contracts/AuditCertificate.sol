// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// What AuditCertificate reads from AuditNetwork (AuditNetwork.Request, same layout).
interface IACNetwork {
    struct Request {
        address sponsor;
        uint64 chainId;
        uint64 createdAt;
        uint64 contestEnd;
        uint8 tier;
        bool naDeclared;
        bool settled;
        bool reclaimed;
        bool certified;
        address target;
        uint32 minContest;
        uint16 minAuditors;
        uint32 reports;
        uint32 rejected;
        uint32 undecided;
        uint32 critHigh;
        uint32 openAppeals;
        uint32 totalWeight;
        uint64 certExpiry;
        uint64 prev;
        bytes32 codeHash;
        bytes32 sourceHash;
        bytes32 naReason;
        uint128 pool;
        uint128 reserve;
        uint128 reportSlash;
        bytes32 uriHash;
    }

    function getRequest(uint256 id) external view returns (Request memory);
    function carriedOf(uint256 id) external view returns (uint64[] memory);
    function markCertified(uint256 id, uint64 expiry) external;
}

/// What the judges decided (AuditJudges).
interface IACJudges {
    function naAccepted(uint256 id) external view returns (bool);
    function fixConfirmed(uint256 id, uint256 findingId) external view returns (bool);
}

/// AuditRunners.result (AuditRunners.Result, same layout).
interface IACRunners {
    struct Result {
        bytes32 resultHash;
        uint32 critHigh;
        uint32 invFailed;
        uint32 invNotRun;
        uint16 mutationBps;
    }

    function result(uint256 id) external view returns (bool agreed, Result memory r);
}

/// @title AuditCertificate: "passed the ZETAPHY audit process at codeHash X on date Y"
/// @notice Anyone calls `certify(requestId)`; it is issued ONLY if ALL of these hold (else it reverts
///         with the first failing reason, see `check`):
///           1. the request is settled (contest, reveal, judging and appeal windows over, no appeal open);
///           2. the automated tier agreed (2 of 3 runners, same result) with zero open critical/high;
///           3. no invariant suite failed, and either all ran or the sponsor's "not applicable" was
///              accepted by the judges;
///           4. the contest ran at least its minimum (governance minimum + the tier's extra) and
///              at least `minAuditors` distinct bonded auditors revealed a report the judges did not reject;
///           5. no valid critical/high finding, no undecided finding, and every critical/high finding of
///              the version it fixes was confirmed fixed by the judges (a fix is a new codeHash and a new
///              request through the whole process);
///           6. on ZETAPHY, the target's EXTCODEHASH is still the audited codeHash; the codeHash was never
///              revoked; the sponsor did not take the post-certificate reserve back.
///         Levels: Gold / Silver / Bronze by distinct auditors, contest length and mutation score
///         (governance thresholds, bounded). A certificate expires (`validity`, 30..365 days) and is
///         revoked at once when a post-certificate finding of critical/high severity is judged valid
///         (AuditNetwork calls `revokeFor`); revocation covers the codeHash everywhere.
///         `isCertified(chainId, target)` re-checks EXTCODEHASH on ZETAPHY at every call, so a proxy
///         upgrade or a redeploy fails at once. For another chain the codeHash is recorded and the
///         reader (or NeuroOracle there, which can check EXTCODEHASH locally) compares it.
///         A certificate is NOT a guarantee that the code is safe.
contract AuditCertificate {
    uint8 public constant BRONZE = 1;
    uint8 public constant SILVER = 2;
    uint8 public constant GOLD = 3;
    uint8 public constant KIND_CERT = 3;  // NeuroOracle message kind (1 threats, 2 verdicts)

    // reasons `check` returns (0 = certifiable)
    uint8 public constant R_NOT_SETTLED = 1;
    uint8 public constant R_NO_AGREEMENT = 2;
    uint8 public constant R_AUTO_CRIT_HIGH = 3;
    uint8 public constant R_INVARIANT_FAILED = 4;
    uint8 public constant R_INVARIANT_NOT_RUN = 5;
    uint8 public constant R_CONTEST_SHORT = 6;
    uint8 public constant R_FEW_AUDITORS = 7;
    uint8 public constant R_CRIT_HIGH = 8;
    uint8 public constant R_UNDECIDED = 9;
    uint8 public constant R_APPEAL_OPEN = 10;
    uint8 public constant R_FIX_UNCONFIRMED = 11;
    uint8 public constant R_RECLAIMED = 12;
    uint8 public constant R_CODE_CHANGED = 13;
    uint8 public constant R_CODE_REVOKED = 14;
    uint8 public constant R_ALREADY = 15;

    uint32 public constant MIN_CONTEST_FLOOR = 3 days;

    struct Levels {
        uint32 validity;            // [30 days, 365 days]
        uint16 silverAuditors;      // [3, 100]
        uint16 goldAuditors;        // [silverAuditors, 200]
        uint32 silverContest;       // [7 days, 90 days]
        uint32 goldContest;         // [silverContest, 180 days]
        uint16 silverMutationBps;   // [5000, 10000]
        uint16 goldMutationBps;     // [silverMutationBps, 10000]
    }

    struct Cert {
        uint256 requestId;
        uint64 chainId;
        address target;
        bytes32 codeHash;
        bytes32 reportHash;         // the agreed automated-tier result hash (REPORT.md + tools + Neuro)
        bytes32 sourceHash;
        uint8 level;
        uint16 auditors;
        uint16 mutationBps;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint256 revokedBy;          // the finding id plus one (0: not revoked)
    }

    IACNetwork public immutable network;
    IACRunners public immutable runners;
    IACJudges public immutable judges;
    address public governance;      // the ZetaphyTimelock
    Levels public levels;

    mapping(bytes32 => Cert) private _certs;             // keccak256(chainId, target) -> newest certificate
    mapping(uint256 => bool) public issued;              // request id -> certified once
    mapping(bytes32 => uint256) public revokedCode;      // codeHash -> finding id + 1 that revoked it
    bytes32[] public keys;

    event CertificateIssued(uint256 indexed requestId, uint64 indexed chainId, address indexed target, bytes32 codeHash, bytes32 reportHash, uint8 level, uint64 expiresAt);
    event CertificateRevoked(uint256 indexed requestId, bytes32 indexed codeHash, uint256 findingId);
    event LevelsSet();
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotNetwork();
    error BadParams();
    error NotCertifiable(uint8 reason);

    constructor(IACNetwork network_, IACRunners runners_, IACJudges judges_, address governance_, Levels memory l) {
        require(address(network_) != address(0) && address(runners_) != address(0) && address(judges_) != address(0) && governance_ != address(0), "zero");
        network = network_;
        runners = runners_;
        judges = judges_;
        governance = governance_;
        _setLevels(l);
    }

    // ---------------------------------------------------------------- certify

    /// 0 when request `id` can be certified now, else the first failing reason (R_*).
    function check(uint256 id) public view returns (uint8) {
        if (issued[id]) return R_ALREADY;
        IACNetwork.Request memory s = network.getRequest(id);
        if (!s.settled) return R_NOT_SETTLED;
        (bool agreed, IACRunners.Result memory r) = runners.result(id);
        if (!agreed) return R_NO_AGREEMENT;
        if (r.critHigh != 0) return R_AUTO_CRIT_HIGH;
        if (r.invFailed != 0) return R_INVARIANT_FAILED;
        if (r.invNotRun != 0 && !(s.naDeclared && judges.naAccepted(id))) return R_INVARIANT_NOT_RUN;
        uint256 ran = uint256(s.contestEnd) - s.createdAt;
        if (ran < s.minContest || ran < MIN_CONTEST_FLOOR) return R_CONTEST_SHORT;
        if (s.reports - s.rejected < s.minAuditors) return R_FEW_AUDITORS;
        if (s.critHigh != 0) return R_CRIT_HIGH;
        if (s.undecided != 0) return R_UNDECIDED;
        if (s.openAppeals != 0) return R_APPEAL_OPEN;
        uint64[] memory carried = network.carriedOf(id);
        for (uint256 i = 0; i < carried.length; i++) if (!judges.fixConfirmed(id, carried[i])) return R_FIX_UNCONFIRMED;
        if (s.reclaimed) return R_RECLAIMED;
        if (s.chainId == block.chainid && s.target.codehash != s.codeHash) return R_CODE_CHANGED;
        if (revokedCode[s.codeHash] != 0) return R_CODE_REVOKED;
        return 0;
    }

    function certify(uint256 id) external returns (uint8 level) {
        uint8 why = check(id);
        if (why != 0) revert NotCertifiable(why);
        IACNetwork.Request memory s = network.getRequest(id);
        (, IACRunners.Result memory r) = runners.result(id);
        uint32 auditors = s.reports - s.rejected;
        level = levelOf(auditors, uint256(s.contestEnd) - s.createdAt, r.mutationBps);
        bytes32 k = keyOf(s.chainId, s.target);
        if (_certs[k].issuedAt == 0) keys.push(k);
        Cert storage c = _certs[k];
        c.requestId = id;
        c.chainId = s.chainId;
        c.target = s.target;
        c.codeHash = s.codeHash;
        c.reportHash = r.resultHash;
        c.sourceHash = s.sourceHash;
        c.level = level;
        c.auditors = uint16(auditors > type(uint16).max ? type(uint16).max : auditors);
        c.mutationBps = r.mutationBps;
        c.issuedAt = uint64(block.timestamp);
        c.expiresAt = uint64(block.timestamp + levels.validity);
        c.revokedAt = 0;
        c.revokedBy = 0;
        issued[id] = true;
        network.markCertified(id, c.expiresAt);
        emit CertificateIssued(id, s.chainId, s.target, s.codeHash, r.resultHash, level, c.expiresAt);
    }

    function levelOf(uint256 auditors, uint256 contest, uint16 mutationBps) public view returns (uint8) {
        Levels memory l = levels;
        if (auditors >= l.goldAuditors && contest >= l.goldContest && mutationBps >= l.goldMutationBps) return GOLD;
        if (auditors >= l.silverAuditors && contest >= l.silverContest && mutationBps >= l.silverMutationBps) return SILVER;
        return BRONZE;
    }

    /// AuditNetwork: a post-certificate critical/high finding was judged valid against request `id`'s code.
    function revokeFor(uint256 id, uint256 findingId) external {
        if (msg.sender != address(network)) revert NotNetwork();
        IACNetwork.Request memory s = network.getRequest(id);
        if (revokedCode[s.codeHash] == 0) revokedCode[s.codeHash] = findingId + 1;
        Cert storage c = _certs[keyOf(s.chainId, s.target)];
        if (c.requestId == id && c.issuedAt != 0 && c.revokedAt == 0) {
            c.revokedAt = uint64(block.timestamp);
            c.revokedBy = findingId + 1;
        }
        emit CertificateRevoked(id, s.codeHash, findingId);
    }

    // ---------------------------------------------------------------- reads

    function keyOf(uint64 chainId, address target) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, target));
    }

    function _valid(Cert storage c) internal view returns (bool) {
        if (c.issuedAt == 0 || c.revokedAt != 0 || revokedCode[c.codeHash] != 0 || block.timestamp >= c.expiresAt) return false;
        if (c.chainId == block.chainid && c.target.codehash != c.codeHash) return false; // upgraded / redeployed / destroyed
        return true;
    }

    /// True only while the newest certificate of (chainId, target) is unexpired, unrevoked and, on
    /// ZETAPHY, the target still runs exactly the certified code.
    function isCertified(uint64 chainId, address target) external view returns (bool) {
        return _valid(_certs[keyOf(chainId, target)]);
    }

    /// The newest certificate of (chainId, target) and whether it holds right now.
    function certificate(uint64 chainId, address target) external view returns (Cert memory c, bool valid) {
        Cert storage s = _certs[keyOf(chainId, target)];
        return (s, _valid(s));
    }

    function count() external view returns (uint256) {
        return keys.length;
    }

    /// The NeuroOracle message for (chainId, target): kind 3, this chain's id, then the certificate
    /// (all static fields, so it decodes as a struct on the other side). NeuroOracleSender.pushCertificate sends it.
    function certificateBody(uint64 chainId, address target) external view returns (bytes memory) {
        Cert storage c = _certs[keyOf(chainId, target)];
        if (c.issuedAt == 0) revert NotCertifiable(R_NOT_SETTLED);
        bool revoked = c.revokedAt != 0 || revokedCode[c.codeHash] != 0;
        return abi.encode(KIND_CERT, block.chainid, c.chainId, c.target, c.codeHash, c.reportHash, c.level, c.issuedAt, c.expiresAt, revoked, c.requestId);
    }

    // ---------------------------------------------------------------- governance

    function setLevels(Levels calldata l) external {
        if (msg.sender != governance) revert NotGovernance();
        _setLevels(l);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    function _setLevels(Levels memory l) internal {
        if (l.validity < 30 days || l.validity > 365 days) revert BadParams();
        if (l.silverAuditors < 3 || l.silverAuditors > 100 || l.goldAuditors < l.silverAuditors || l.goldAuditors > 200) revert BadParams();
        if (l.silverContest < 7 days || l.silverContest > 90 days || l.goldContest < l.silverContest || l.goldContest > 180 days) revert BadParams();
        if (l.silverMutationBps < 5000 || l.silverMutationBps > 10_000 || l.goldMutationBps < l.silverMutationBps || l.goldMutationBps > 10_000) revert BadParams();
        levels = l;
        emit LevelsSet();
    }
}
