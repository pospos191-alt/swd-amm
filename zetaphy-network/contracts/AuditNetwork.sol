// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// WorkerReputation: AuditNetwork must be one of its reporters.
interface IANReputation {
    function record(address worker, uint8 kind, bytes32 ref) external;
}

/// AuditRunners / AuditJudges: receive their part of each request's fee.
interface IANPot {
    function open(uint256 reqId) external payable;
}

/// AuditJudges: who is a judge (judges never audit) and what the judges decided.
interface IANJudges {
    function isJudge(address who) external view returns (bool);
    function fixConfirmed(uint256 reqId, uint256 findingId) external view returns (bool);
}

/// AuditCertificate: told when certified code gets a valid critical/high finding.
interface IANCertificate {
    function revokeFor(uint256 reqId, uint256 findingId) external;
}

/// @title AuditNetwork: ZETAPHY's open audit platform (docs/future/audit-network.md)
/// @notice Anyone asks for an audit of a contract (on ZETAPHY or another chain Neuro reads), anyone
///         bonded audits it, a bonded judging committee (AuditJudges) decides every finding, three
///         runners (AuditRunners) run the automated pipeline, and only code that went through ALL of it
///         gets a certificate (AuditCertificate). This contract holds the requests, the auditors' bonds,
///         reports and findings, and the bounty money:
///           - Request: the target {chainId, address, codeHash, source hash}, a deposit (bounty pool +
///             fee), a scope tier, a contest window (at least the governance minimum plus a week per tier)
///             and the minimum number of auditors. On ZETAPHY the codeHash must be the target's
///             EXTCODEHASH right now. A fix is a NEW request (a new codeHash) naming the request it fixes:
///             every valid critical/high finding of the old version is carried over and must be confirmed
///             fixed by the judges on the new one.
///           - Auditors: register with a bond (locked while their submissions can still be judged or
///             appealed). During the contest they commit hashes only: a participation report and any
///             findings (severity claim + evidence / PoC hash, bound to the auditor and the request). All
///             reveals happen after the contest closed, so nobody can copy a finding.
///           - Money: valid findings share the pool by severity weight (duplicates split their group's
///             share), revealed reports share `participationBps`, an invalid finding or a rejected report
///             slashes `slashBps` of the auditor bond (escrowed until appeals are over, then to the sponsor,
///             or to the treasury for post-certificate findings). The fee goes to the runners and the
///             judges. Pull payments only, behind a reentrancy lock.
///           - After a certificate: findings stay open (post-certificate bug bounty, paid from what was
///             left of the pool) until it expires; a valid critical/high one revokes the certificate of that
///             codeHash at once.
///         No owner key: governance is the ZetaphyTimelock, and every parameter is bounded.
contract AuditNetwork {
    uint8 internal constant REP_SLASHED = 3;
    uint8 internal constant REP_BUG_VALID = 4;
    uint8 internal constant REP_BUG_INVALID = 5;

    // severities (the pipeline's schema: info < low < medium < high < critical)
    uint8 internal constant SEV_INFO = 1;
    uint8 internal constant SEV_LOW = 2;
    uint8 internal constant SEV_MEDIUM = 3;
    uint8 internal constant SEV_HIGH = 4;
    uint8 internal constant SEV_CRITICAL = 5;

    // finding status
    uint8 internal constant F_COMMITTED = 1;
    uint8 internal constant F_REVEALED = 2;
    uint8 internal constant F_VALID = 3;
    uint8 internal constant F_INVALID = 4;

    uint256 internal constant MAX_FINDINGS = 200;      // per request (contest + post-certificate)
    uint256 internal constant MAX_CARRY = 50;          // carried critical/high findings of a fix
    uint256 internal constant MAX_URI = 200;
    uint32 internal constant MIN_CONTEST_FLOOR = 3 days;
    uint32 internal constant TIER_EXTRA = 7 days;      // each scope tier adds a week to the minimum contest

    struct Params {
        uint32 minContest;          // [3 days, 60 days]
        uint32 maxContest;          // [minContest + 14 days, 180 days]
        uint32 revealWindow;        // [1 day, 14 days]
        uint32 judgeWindow;         // [2 days, 30 days]
        uint32 appealWindow;        // [2 days, 30 days]
        uint32 appealTimeout;       // [7 days, 90 days]: governance resolves an appeal in time, or the decision stands
        uint32 unbondDelay;         // [1 day, 60 days]
        uint16 minAuditorsFloor;    // [2, 50]
        uint16 slashBps;            // [500, 5000] of auditorBond per invalid finding / rejected report
        uint16 feeBps;              // [100, 3000] of a request's deposit that is fee (the rest is the pool)
        uint16 runnerBps;           // [2000, 8000] of the fee to the automated tier (the rest: judges)
        uint16 participationBps;    // [0, 2000] of the pool to the revealed, accepted reports
        uint16 maxFindingsPerAuditor; // [1, 50] per request
        uint128 auditorBond;        // (0, 1000 ether]
        uint128 minPool;            // (0, 1e6 ether]
    }

    /// What is audited: the contract on its chain, its runtime code hash and the source it was built from.
    struct Target {
        uint64 chainId;
        address target;
        bytes32 codeHash;           // EXTCODEHASH on ZETAPHY; keccak256(runtime bytecode) elsewhere
        bytes32 sourceHash;         // git commit / IPFS hash of the source
    }

    struct Request {
        address sponsor;
        uint64 chainId;
        uint64 createdAt;
        uint64 contestEnd;
        uint8 tier;                 // 0 basic, 1 standard, 2 deep
        bool naDeclared;
        bool settled;
        bool reclaimed;
        bool certified;
        address target;
        uint32 minContest;          // the minimum this request had to meet (snapshot)
        uint16 minAuditors;
        uint32 reports;             // revealed participation reports
        uint32 rejected;            // reports the judges rejected
        uint32 undecided;           // revealed contest findings not decided yet
        uint32 critHigh;            // valid critical/high contest findings
        uint32 openAppeals;
        uint32 totalWeight;         // sum of the severity weights of the valid groups (contest)
        uint64 certExpiry;
        uint64 prev;                // the request this one fixes, plus one (0: none)
        bytes32 codeHash;
        bytes32 sourceHash;
        bytes32 naReason;           // why invariant suites do not apply (when declared)
        uint128 pool;               // the bounty pool
        uint128 reserve;            // left after settlement: post-certificate bounty, then the sponsor's
        uint128 reportSlash;        // escrowed slashes of rejected reports (to the sponsor at settlement)
        bytes32 uriHash;            // keccak256 of the scope / docs / report link (the link itself: RequestUri event)
    }

    struct Finding {
        uint64 req;
        uint64 committedAt;
        uint64 commitBlock;
        uint64 revealedAt;
        uint64 decidedAt;
        address auditor;
        uint8 status;
        uint8 claimed;              // the severity the auditor claims
        uint8 sev;                  // the severity the judges decided (valid)
        bool late;                  // filed after the certificate (post-certificate bounty)
        bool paid;
        bool appealOpen;
        uint64 group;               // the original finding of its duplicate group
        uint128 slashed;            // escrowed until appeals are over
        bytes32 commitment;
        bytes32 findingHash;
        bytes32 evidenceHash;       // e.g. keccak256 of the PoC test file
    }

    struct Member {
        uint128 bond;
        uint64 lockedUntil;         // a submission can still be judged or appealed until then
        uint64 unbondAt;            // 0: active
    }

    address public governance;              // the ZetaphyTimelock
    address public treasury;
    IANReputation public immutable reputation;    // address(0): none
    IANPot public immutable runners;              // AuditRunners
    IANPot public immutable judging;              // AuditJudges
    IANCertificate public immutable certificate;  // AuditCertificate
    Params internal params;

    Request[] private _reqs;
    Finding[] private _findings;
    mapping(uint256 => uint256[]) private _reqFindings;
    mapping(uint256 => uint64[]) private _carry;

    mapping(address => Member) public auditors;
    mapping(uint256 => mapping(address => bytes32)) public reportCommit;
    mapping(uint256 => mapping(address => bytes32)) public reportHash;      // revealed
    mapping(uint256 => mapping(address => bool)) public reportRejected;
    mapping(uint256 => mapping(address => bool)) public reportClaimed;
    mapping(uint256 => mapping(address => uint256)) public findingsBy;
    mapping(uint256 => mapping(address => bool)) public involved;          // sponsor or auditor of a request
    mapping(uint256 => uint32) public groupSize;
    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    event Requested(uint256 indexed id, address indexed sponsor, uint64 indexed chainId, address target, bytes32 codeHash, bytes32 sourceHash, uint256 pool);
    event RequestUri(uint256 indexed id, string uri);
    event Carried(uint256 indexed id, uint256 indexed findingId);
    event NaDeclared(uint256 indexed id, bytes32 reason);
    event Bonded(address indexed auditor, uint256 bond);
    event UnbondRequested(address indexed auditor, uint64 at);
    event BondWithdrawn(address indexed auditor, uint256 amount);
    event ReportCommitted(uint256 indexed id, address indexed auditor);
    event ReportRevealed(uint256 indexed id, address indexed auditor, bytes32 reportHash);
    event ReportRejected(uint256 indexed id, address indexed auditor);
    event FindingCommitted(uint256 indexed findingId, uint256 indexed id, address indexed auditor, bool late);
    event FindingRevealed(uint256 indexed findingId, uint256 indexed id, address indexed auditor, uint8 severity, bytes32 findingHash, bytes32 evidenceHash, string uri);
    event FindingDecided(uint256 indexed findingId, bool valid, uint8 severity, uint256 group);
    event AppealSet(uint256 indexed findingId, bool open);
    event Slashed(address indexed auditor, uint256 amount, uint256 ref);
    event Settled(uint256 indexed id, uint256 reserve);
    event Certified(uint256 indexed id, uint64 expiry);
    event Paid(address indexed to, uint256 amount, bytes32 what);
    event Withdrawn(address indexed to, uint256 amount);
    event ParamsSet();
    event GovernanceSet(address governance);
    event TreasurySet(address treasury);

    error NotGovernance();
    error NotJudging();
    error NotCertificate();
    error BadParams();
    error BadValue();
    error BadRequest();
    error BadFinding();
    error BadOutcome();
    error CodeMismatch();
    error Closed();
    error TooEarly();
    error TooMany();
    error NotBonded();
    error Conflict();
    error AlreadyIn();
    error BadReveal();
    error Locked();
    error Nothing();
    error Reentrant();

    /// runners_, judging_ and certificate_ are the addresses those contracts get when deployed right after
    /// this one (the deploy script computes them from the deployer's nonce; no key binds them later).
    constructor(address governance_, address treasury_, IANReputation reputation_, IANPot runners_, IANPot judging_, IANCertificate certificate_, Params memory p) {
        if (governance_ == address(0) || treasury_ == address(0) || address(runners_) == address(0) || address(judging_) == address(0)
            || address(certificate_) == address(0)) revert BadParams();
        governance = governance_;
        treasury = treasury_;
        reputation = reputation_;
        runners = runners_;
        judging = judging_;
        certificate = certificate_;
        _setParams(p);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyJudging() {
        if (msg.sender != address(judging)) revert NotJudging();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ================================================================ requests

    /// Asks for an audit. msg.value = bounty pool + fee (fee = feeBps of it). `prev`: the request this
    /// version fixes plus one (0: a first version).
    function request(Target calldata t, uint8 tier, uint32 contest, uint16 minAuditors, uint64 prev, string calldata uri)
        external payable returns (uint256 id)
    {
        if (t.chainId == 0 || t.target == address(0) || t.codeHash == bytes32(0) || t.sourceHash == bytes32(0) || tier > 2) revert BadRequest();
        if (bytes(uri).length > MAX_URI) revert BadRequest();
        if (t.chainId == block.chainid && t.target.codehash != t.codeHash) revert CodeMismatch();
        id = _reqs.length;
        Request storage r = _reqs.push();
        uint256 judgePot = _terms(r, tier, contest, minAuditors);
        r.sponsor = msg.sender;
        r.chainId = t.chainId;
        r.target = t.target;
        r.codeHash = t.codeHash;
        r.sourceHash = t.sourceHash;
        r.uriHash = keccak256(bytes(uri));
        involved[id][msg.sender] = true;
        if (prev != 0) _carryFrom(id, r, prev - 1);
        r.prev = prev;
        emit Requested(id, msg.sender, t.chainId, t.target, t.codeHash, t.sourceHash, r.pool);
        if (bytes(uri).length != 0) emit RequestUri(id, uri);
        runners.open{value: msg.value - r.pool - judgePot}(id);
        judging.open{value: judgePot}(id);
    }

    /// The request's window, auditors and money, checked against the parameters. Returns the judges' pot.
    function _terms(Request storage r, uint8 tier, uint32 contest, uint16 minAuditors) internal returns (uint256) {
        Params storage p = params;
        uint32 need = p.minContest + uint32(tier) * TIER_EXTRA;
        if (contest < need || contest > p.maxContest) revert BadRequest();
        if (minAuditors < p.minAuditorsFloor + 2 * uint16(tier)) revert BadRequest();
        uint256 fee = (msg.value * p.feeBps) / 10_000;
        if (msg.value - fee < p.minPool) revert BadValue();
        r.tier = tier;
        r.createdAt = uint64(block.timestamp);
        r.contestEnd = uint64(block.timestamp + contest);
        r.minContest = need;
        r.minAuditors = minAuditors;
        r.pool = uint128(msg.value - fee);
        return fee - (fee * p.runnerBps) / 10_000;
    }

    /// A fix: the old version's valid critical/high findings, and its own carried ones that were not
    /// confirmed fixed, must be confirmed fixed on this one. The old request must be settled.
    function _carryFrom(uint256 id, Request storage r, uint256 old) internal {
        Request storage o = _req(old);
        if (!o.settled || o.chainId != r.chainId || o.codeHash == r.codeHash) revert BadRequest();
        uint256[] storage fs = _reqFindings[old];
        for (uint256 i = 0; i < fs.length; i++) {
            Finding storage f = _findings[fs[i]];
            if (f.status == F_VALID && f.sev >= SEV_HIGH) _pushCarry(id, fs[i]);
        }
        uint64[] storage oc = _carry[old];
        for (uint256 i = 0; i < oc.length; i++) if (!IANJudges(address(judging)).fixConfirmed(old, oc[i])) _pushCarry(id, oc[i]);
    }

    function _pushCarry(uint256 id, uint256 fid) internal {
        if (_carry[id].length >= MAX_CARRY) revert TooMany();
        _carry[id].push(uint64(fid));
        emit Carried(id, fid);
    }

    /// The sponsor says the invariant suites do not apply (e.g. a plain token); the judges must accept it.
    function declareNotApplicable(uint256 id, bytes32 reason) external {
        Request storage r = _req(id);
        if (msg.sender != r.sponsor || reason == bytes32(0)) revert BadRequest();
        if (block.timestamp >= r.contestEnd || r.naDeclared) revert Closed();
        r.naDeclared = true;
        r.naReason = reason;
        emit NaDeclared(id, reason);
    }

    // ================================================================ auditor bonds

    function bond() external payable {
        Member storage m = auditors[msg.sender];
        if (msg.value == 0) revert BadValue();
        if (m.unbondAt != 0) revert Locked();
        m.bond += uint128(msg.value);
        emit Bonded(msg.sender, m.bond);
    }

    function requestUnbond() external {
        Member storage m = auditors[msg.sender];
        if (m.bond == 0 || m.unbondAt != 0) revert Nothing();
        uint64 at = uint64(block.timestamp + params.unbondDelay);
        if (m.lockedUntil > at) at = m.lockedUntil;
        m.unbondAt = at;
        emit UnbondRequested(msg.sender, at);
    }

    function withdrawBond() external nonReentrant {
        Member storage m = auditors[msg.sender];
        if (m.unbondAt == 0 || block.timestamp < m.unbondAt || block.timestamp < m.lockedUntil) revert TooEarly();
        uint256 a = m.bond;
        m.bond = 0;
        m.unbondAt = 0;
        _send(msg.sender, a);
        emit BondWithdrawn(msg.sender, a);
    }

    function _checkAuditor(Request storage r) internal view {
        Member storage m = auditors[msg.sender];
        if (m.unbondAt != 0 || m.bond < params.auditorBond) revert NotBonded();
        if (msg.sender == r.sponsor || IANJudges(address(judging)).isJudge(msg.sender)) revert Conflict();
    }

    function _lockAuditor(uint256 until) internal {
        Member storage m = auditors[msg.sender];
        if (until > m.lockedUntil) m.lockedUntil = uint64(until);
    }

    /// Slashes slashBps of the auditor bond requirement (at most what is left).
    function _slash(address a, uint256 ref) internal returns (uint128 s) {
        Member storage m = auditors[a];
        uint256 want = (uint256(params.auditorBond) * params.slashBps) / 10_000;
        s = uint128(want > m.bond ? m.bond : want);
        m.bond -= s;
        emit Slashed(a, s, ref);
    }

    // ================================================================ reports and findings

    function reportCommitment(bytes32 hash, address auditor, bytes32 salt, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.audit.report", hash, auditor, salt, id));
    }

    function findingCommitment(bytes32 findingHash, uint8 severity, bytes32 evidenceHash, address auditor, bytes32 salt, uint256 id)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode("zetaphy.audit.finding", findingHash, severity, evidenceHash, auditor, salt, id));
    }

    /// An auditor's participation: the hash of its full report ("no findings" is a report too).
    function commitReport(uint256 id, bytes32 commitment) external {
        Request storage r = _req(id);
        _checkAuditor(r);
        if (block.timestamp >= r.contestEnd) revert Closed();
        if (commitment == bytes32(0) || reportCommit[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        reportCommit[id][msg.sender] = commitment;
        involved[id][msg.sender] = true;
        _lockAuditor(_horizon(r));
        emit ReportCommitted(id, msg.sender);
    }

    function revealReport(uint256 id, bytes32 hash, bytes32 salt) external {
        Request storage r = _req(id);
        if (block.timestamp < r.contestEnd) revert TooEarly();
        if (block.timestamp >= uint256(r.contestEnd) + params.revealWindow) revert Closed();
        bytes32 c = reportCommit[id][msg.sender];
        if (c == bytes32(0) || reportHash[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        if (hash == bytes32(0) || reportCommitment(hash, msg.sender, salt, id) != c) revert BadReveal();
        reportHash[id][msg.sender] = hash;
        r.reports++;
        emit ReportRevealed(id, msg.sender, hash);
    }

    /// During the contest, or (post-certificate bounty) while the request's certificate has not expired.
    function commitFinding(uint256 id, bytes32 commitment) external returns (uint256 fid) {
        Request storage r = _req(id);
        _checkAuditor(r);
        bool late = block.timestamp >= r.contestEnd;
        if (late && (!r.certified || block.timestamp >= r.certExpiry)) revert Closed();
        if (commitment == bytes32(0)) revert BadValue();
        if (_reqFindings[id].length >= MAX_FINDINGS || findingsBy[id][msg.sender] >= params.maxFindingsPerAuditor) revert TooMany();
        findingsBy[id][msg.sender]++;
        fid = _findings.length;
        Finding storage f = _findings.push();
        f.req = uint64(id);
        f.auditor = msg.sender;
        f.committedAt = uint64(block.timestamp);
        f.commitBlock = uint64(block.number);
        f.status = F_COMMITTED;
        f.late = late;
        f.group = uint64(fid);
        f.commitment = commitment;
        _reqFindings[id].push(fid);
        involved[id][msg.sender] = true;
        Params storage p = params;
        _lockAuditor(late ? block.timestamp + p.revealWindow + p.judgeWindow + p.appealWindow + p.appealTimeout : _horizon(r));
        emit FindingCommitted(fid, id, msg.sender, late);
    }

    /// Contest findings: after the contest, inside the reveal window. Post-certificate ones: from the next
    /// block, inside the reveal window counted from the commit (a watcher cannot front-run the reveal).
    function revealFinding(uint256 fid, bytes32 findingHash, uint8 severity, bytes32 evidenceHash, bytes32 salt, string calldata uri) external {
        Finding storage f = _finding(fid);
        if (msg.sender != f.auditor || f.status != F_COMMITTED) revert BadFinding();
        Request storage r = _reqs[f.req];
        if (f.late) {
            if (block.number <= f.commitBlock) revert TooEarly();
            if (block.timestamp >= uint256(f.committedAt) + params.revealWindow) revert Closed();
        } else {
            if (block.timestamp < r.contestEnd) revert TooEarly();
            if (block.timestamp >= uint256(r.contestEnd) + params.revealWindow) revert Closed();
        }
        if (severity < SEV_INFO || severity > SEV_CRITICAL || findingHash == bytes32(0) || bytes(uri).length > MAX_URI) revert BadValue();
        if (findingCommitment(findingHash, severity, evidenceHash, msg.sender, salt, f.req) != f.commitment) revert BadReveal();
        f.findingHash = findingHash;
        f.evidenceHash = evidenceHash;
        f.claimed = severity;
        f.revealedAt = uint64(block.timestamp);
        f.status = F_REVEALED;
        if (!f.late) r.undecided++;
        emit FindingRevealed(fid, f.req, msg.sender, severity, findingHash, evidenceHash, uri);
    }

    // ================================================================ decisions (from AuditJudges)

    /// Reverts unless (valid, sev, group) is a possible decision for finding `fid`: a severity, and a
    /// group that is the finding itself or an EARLIER finding of the same request (and kind) already
    /// decided valid as the original of its group.
    function checkGroup(uint256 fid, uint8 sev, uint256 group) public view {
        Finding storage f = _finding(fid);
        if (sev < SEV_INFO || sev > SEV_CRITICAL || group > fid) revert BadOutcome();
        if (group != fid) {
            Finding storage g = _findings[group];
            if (g.req != f.req || g.status != F_VALID || g.group != group || g.late != f.late) revert BadOutcome();
        }
    }

    /// The judges' decision on a revealed finding, or governance's on an appealed one (it replaces the old).
    function decide(uint256 fid, bool valid, uint8 sev, uint256 group) external onlyJudging {
        Finding storage f = _finding(fid);
        Request storage r = _reqs[f.req];
        if (f.status == F_VALID || f.status == F_INVALID) {
            if (!f.appealOpen) revert Closed();
            _undo(fid, f, r);
        } else if (f.status != F_REVEALED) revert Closed();
        if (valid) checkGroup(fid, sev, group);
        else { sev = 0; group = fid; }
        if (!f.late) r.undecided--;
        f.decidedAt = uint64(block.timestamp);
        f.group = uint64(group);
        if (valid) {
            f.status = F_VALID;
            f.sev = sev;
            groupSize[group]++;
            if (!f.late) {
                if (group == fid) r.totalWeight += weight(sev);
                if (sev >= SEV_HIGH) r.critHigh++;
            } else if (sev >= SEV_HIGH) {
                certificate.revokeFor(f.req, fid); // a valid critical/high against certified code: revoked now
            }
            _rep(f.auditor, REP_BUG_VALID, bytes32(fid));
        } else {
            f.status = F_INVALID;
            f.sev = 0;
            f.slashed = _slash(f.auditor, fid);
            _rep(f.auditor, REP_BUG_INVALID, bytes32(fid));
        }
        emit FindingDecided(fid, valid, sev, group);
    }

    function _undo(uint256 fid, Finding storage f, Request storage r) internal {
        if (f.status == F_VALID) {
            groupSize[f.group]--;
            if (!f.late) {
                if (f.group == fid) r.totalWeight -= weight(f.sev);
                if (f.sev >= SEV_HIGH) r.critHigh--;
            }
        } else if (f.slashed > 0) {
            auditors[f.auditor].bond += f.slashed; // the slash was wrong: back into the bond
            f.slashed = 0;
        }
        f.status = F_REVEALED;
        if (!f.late) r.undecided++;
    }

    /// The judges rejected a revealed report (empty, plagiarised, spam): it does not count, and slashes.
    function rejectReport(uint256 id, address auditor) external onlyJudging {
        Request storage r = _req(id);
        if (reportHash[id][auditor] == bytes32(0) || reportRejected[id][auditor]) revert Closed();
        reportRejected[id][auditor] = true;
        r.rejected++;
        r.reportSlash += _slash(auditor, id);
        _rep(auditor, REP_SLASHED, bytes32(id));
        emit ReportRejected(id, auditor);
    }

    /// AuditJudges opens (an appeal was filed in time) or closes an appeal on a decided finding.
    function setAppeal(uint256 fid, bool open) external onlyJudging {
        Finding storage f = _finding(fid);
        Request storage r = _reqs[f.req];
        if (open) {
            if ((f.status != F_VALID && f.status != F_INVALID) || f.appealOpen || block.timestamp >= appealEnd(fid)) revert Closed();
            r.openAppeals++;
        } else {
            if (!f.appealOpen) revert Closed();
            r.openAppeals--;
        }
        f.appealOpen = open;
        emit AppealSet(fid, open);
    }

    /// Severity weights of the bounty split: info 0, low 1, medium 3, high 10, critical 30.
    function weight(uint8 sev) public pure returns (uint32) {
        if (sev == SEV_CRITICAL) return 30;
        if (sev == SEV_HIGH) return 10;
        if (sev == SEV_MEDIUM) return 3;
        if (sev == SEV_LOW) return 1;
        return 0;
    }

    /// The share (bps) of the reserve a post-certificate finding takes: critical all, high half, ...
    function lateBps(uint8 sev) internal pure returns (uint256) {
        if (sev == SEV_CRITICAL) return 10_000;
        if (sev == SEV_HIGH) return 5_000;
        if (sev == SEV_MEDIUM) return 1_000;
        if (sev == SEV_LOW) return 200;
        return 0;
    }

    // ================================================================ settlement and payouts

    /// Anyone, once the appeal window is over and no appeal is open: the contest's money is final.
    function settle(uint256 id) external {
        Request storage r = _req(id);
        if (r.settled) revert Closed();
        if (block.timestamp < judgeEnd(id) + params.appealWindow || r.openAppeals != 0) revert TooEarly();
        r.settled = true;
        uint256 part = (uint256(r.pool) * params.participationBps) / 10_000;
        uint256 reserve;
        if (r.reports == r.rejected) reserve += part;
        if (r.totalWeight == 0) reserve += r.pool - part;
        r.reserve = uint128(reserve);
        if (r.reportSlash > 0) {
            owed[r.sponsor] += r.reportSlash;
            r.reportSlash = 0;
        }
        emit Settled(id, reserve);
    }

    /// A valid contest finding's share: the pool (less the participation part) by its group's severity
    /// weight, split equally in its duplicate group.
    function _payout(uint256 fid) internal view returns (uint256) {
        Finding storage f = _finding(fid);
        Request storage r = _reqs[f.req];
        if (f.status != F_VALID || f.late || r.totalWeight == 0) return 0;
        Finding storage g = _findings[f.group];
        if (g.status != F_VALID || g.group != f.group) return 0; // its original was overturned on appeal
        uint256 pot = uint256(r.pool) - (uint256(r.pool) * params.participationBps) / 10_000;
        return (pot * weight(g.sev)) / r.totalWeight / groupSize[f.group];
    }

    function claimFinding(uint256 fid) external {
        Finding storage f = _finding(fid);
        if (f.paid || f.appealOpen) revert Closed();
        uint256 amount;
        if (f.late) {
            // the original of its group only: a duplicate filed after it saw the reveal earns nothing
            if (f.status != F_VALID || f.group != fid || block.timestamp < appealEnd(fid)) revert TooEarly();
            Request storage r = _reqs[f.req];
            amount = (uint256(r.reserve) * lateBps(f.sev)) / 10_000;
            r.reserve -= uint128(amount);
        } else {
            if (!_reqs[f.req].settled) revert TooEarly();
            amount = _payout(fid);
        }
        if (amount == 0) revert Nothing();
        f.paid = true;
        owed[f.auditor] += amount;
        emit Paid(f.auditor, amount, bytes32(fid));
    }

    /// An escrowed slash of an invalid finding, once it can no longer be appealed: to the sponsor
    /// (contest) or the treasury (post-certificate).
    function claimSlash(uint256 fid) external {
        Finding storage f = _finding(fid);
        if (f.slashed == 0 || f.appealOpen || block.timestamp < appealEnd(fid)) revert TooEarly();
        uint256 a = f.slashed;
        f.slashed = 0;
        address to = f.late ? treasury : _reqs[f.req].sponsor;
        owed[to] += a;
        emit Paid(to, a, keccak256(abi.encode("slash", fid)));
    }

    function claimReport(uint256 id) external {
        Request storage r = _req(id);
        if (!r.settled) revert TooEarly();
        if (reportHash[id][msg.sender] == bytes32(0) || reportRejected[id][msg.sender] || reportClaimed[id][msg.sender]) revert Nothing();
        reportClaimed[id][msg.sender] = true;
        uint256 amount = (uint256(r.pool) * params.participationBps) / 10_000 / (r.reports - r.rejected);
        owed[msg.sender] += amount;
        emit Paid(msg.sender, amount, keccak256(abi.encode("report", id)));
    }

    /// The sponsor takes the reserve back: never certified, or once the certificate expired.
    function reclaim(uint256 id) external {
        Request storage r = _req(id);
        if (msg.sender != r.sponsor || !r.settled || r.reclaimed) revert Nothing();
        if (r.certified && block.timestamp < r.certExpiry) revert TooEarly();
        r.reclaimed = true;
        uint256 a = r.reserve;
        r.reserve = 0;
        owed[r.sponsor] += a;
        emit Paid(r.sponsor, a, keccak256(abi.encode("reclaim", id)));
    }

    function withdraw() external nonReentrant {
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        _send(msg.sender, a);
        emit Withdrawn(msg.sender, a);
    }

    function _send(address to, uint256 a) internal {
        (bool ok, ) = to.call{value: a}("");
        if (!ok) revert Nothing();
    }

    /// AuditCertificate marks a request certified (its post-certificate bounty opens).
    function markCertified(uint256 id, uint64 expiry) external {
        if (msg.sender != address(certificate)) revert NotCertificate();
        Request storage r = _req(id);
        r.certified = true;
        r.certExpiry = expiry;
        emit Certified(id, expiry);
    }

    // ================================================================ governance

    function setParams(Params memory p) external onlyGovernance {
        _setParams(p);
    }

    function setGovernance(address g) external onlyGovernance {
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    function setTreasury(address t) external onlyGovernance {
        if (t == address(0)) revert BadParams();
        treasury = t;
        emit TreasurySet(t);
    }

    function _setParams(Params memory p) internal {
        if (p.minContest < MIN_CONTEST_FLOOR || p.minContest > 60 days || p.maxContest < p.minContest + 2 * TIER_EXTRA || p.maxContest > 180 days) revert BadParams();
        if (p.revealWindow < 1 days || p.revealWindow > 14 days || p.judgeWindow < 2 days || p.judgeWindow > 30 days) revert BadParams();
        if (p.appealWindow < 2 days || p.appealWindow > 30 days || p.appealTimeout < 7 days || p.appealTimeout > 90 days) revert BadParams();
        if (p.unbondDelay < 1 days || p.unbondDelay > 60 days || p.minAuditorsFloor < 2 || p.minAuditorsFloor > 50) revert BadParams();
        if (p.slashBps < 500 || p.slashBps > 5000 || p.feeBps < 100 || p.feeBps > 3000) revert BadParams();
        if (p.runnerBps < 2000 || p.runnerBps > 8000 || p.participationBps > 2000) revert BadParams();
        if (p.maxFindingsPerAuditor < 1 || p.maxFindingsPerAuditor > 50) revert BadParams();
        if (p.auditorBond == 0 || p.auditorBond > 1000 ether || p.minPool == 0 || p.minPool > 1e6 ether) revert BadParams();
        params = p;
        emit ParamsSet();
    }

    // ================================================================ reads

    function getParams() external view returns (Params memory) {
        return params;
    }

    function requestCount() external view returns (uint256) {
        return _reqs.length;
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        return _req(id);
    }

    function findingCount() external view returns (uint256) {
        return _findings.length;
    }

    function getFinding(uint256 fid) external view returns (Finding memory) {
        return _finding(fid);
    }

    function findingsOf(uint256 id) external view returns (uint256[] memory) {
        return _reqFindings[id];
    }

    function carriedOf(uint256 id) external view returns (uint64[] memory) {
        return _carry[id];
    }

    function isCarried(uint256 id, uint256 fid) external view returns (bool) {
        uint64[] storage c = _carry[id];
        for (uint256 i = 0; i < c.length; i++) if (c[i] == fid) return true;
        return false;
    }

    /// What AuditRunners and AuditJudges need about request `id`: its sponsor and windows.
    function core(uint256 id) external view returns (address sponsor, uint64 contestEnd, uint256 revealEnd, uint256 judgeEnd_, bool naDeclared, bool settled) {
        Request storage r = _req(id);
        return (r.sponsor, r.contestEnd, uint256(r.contestEnd) + params.revealWindow, judgeEnd(id), r.naDeclared, r.settled);
    }

    /// What AuditJudges needs about a finding: (request, status, late, judging deadline).
    function findingCore(uint256 fid) external view returns (uint64 req, uint8 st, bool late, uint256 judgeBy) {
        Finding storage f = _finding(fid);
        judgeBy = f.late ? uint256(f.revealedAt) + params.judgeWindow : judgeEnd(f.req);
        return (f.req, f.status, f.late, judgeBy);
    }

    /// (judgeWindow, appealWindow, appealTimeout) for AuditJudges.
    function timing() external view returns (uint32, uint32, uint32) {
        return (params.judgeWindow, params.appealWindow, params.appealTimeout);
    }

    function judgeEnd(uint256 id) public view returns (uint256) {
        return uint256(_req(id).contestEnd) + params.revealWindow + params.judgeWindow;
    }

    /// The last moment the decision on finding `fid` can be appealed.
    function appealEnd(uint256 fid) public view returns (uint256) {
        Finding storage f = _finding(fid);
        if (f.late) return uint256(f.decidedAt) + params.appealWindow;
        return judgeEnd(f.req) + params.appealWindow;
    }

    /// The last moment anything about request `r`'s contest can still change.
    function _horizon(Request storage r) internal view returns (uint256) {
        Params storage p = params;
        return uint256(r.contestEnd) + p.revealWindow + p.judgeWindow + p.appealWindow + p.appealTimeout;
    }

    function _req(uint256 id) internal view returns (Request storage) {
        if (id >= _reqs.length) revert BadRequest();
        return _reqs[id];
    }

    function _finding(uint256 fid) internal view returns (Finding storage) {
        if (fid >= _findings.length) revert BadFinding();
        return _findings[fid];
    }

    function _rep(address w, uint8 kind, bytes32 ref) internal {
        if (address(reputation) == address(0)) return;
        try reputation.record(w, kind, ref) {} catch {}
    }
}
