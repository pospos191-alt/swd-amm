// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The parts of AuditNetwork the judges read and write.
interface IAJNetwork {
    function core(uint256 id) external view returns (address sponsor, uint64 contestEnd, uint256 revealEnd, uint256 judgeEnd, bool naDeclared, bool settled);
    function findingCore(uint256 fid) external view returns (uint64 req, uint8 st, bool late, uint256 judgeBy);
    function timing() external view returns (uint32 judgeWindow, uint32 appealWindow, uint32 appealTimeout);
    function involved(uint256 id, address who) external view returns (bool);
    function reportHash(uint256 id, address auditor) external view returns (bytes32);
    function isCarried(uint256 id, uint256 fid) external view returns (bool);
    function checkGroup(uint256 fid, uint8 sev, uint256 group) external view;
    function decide(uint256 fid, bool valid, uint8 sev, uint256 group) external;
    function rejectReport(uint256 id, address auditor) external;
    function setAppeal(uint256 fid, bool open) external;
    function treasury() external view returns (address);
}

interface IAJReputation {
    function scoreOf(address worker) external view returns (uint256);
}

/// @title AuditJudges: the judging committee of AuditNetwork
/// @notice Judges post a bond (`judgeBond`) and need a WorkerReputation score of at least `judgeMinScore`
///         (a track record from useful work, bug bounties and NeuroJobs); at most `maxJudges` sit at once
///         and governance (the timelock) can remove or slash one. They decide, per request:
///           - every revealed finding: invalid, or valid with a severity and its duplicate group;
///           - participation reports: accepted, or rejected as empty / plagiarised / spam;
///           - the sponsor's "invariant suites do not apply" declaration;
///           - for a fix, whether each carried critical/high finding of the old version is fixed.
///         An item is decided when `quorum()` judges cast the SAME outcome: at least `judgeQuorum` (3 or
///         more) AND a majority of all active judges, so a minority cannot decide anything, whatever it
///         votes. A judge never votes on a request it sponsored or audited, and votes once per item.
///         Decided findings can be appealed (bond `appealBond`) until AuditNetwork's appeal window ends;
///         governance resolves the appeal (the bond comes back if it changed the outcome, else it goes to
///         the treasury) or, after `appealTimeout`, the decision stands and the bond comes back.
///         The judges' part of each fee is shared by the judges who voted with each contest decision.
contract AuditJudges {
    bytes32 internal constant YES = keccak256(abi.encode(true));
    bytes32 internal constant NO = keccak256(abi.encode(false));

    uint8 public constant K_FINDING = 1;
    uint8 public constant K_REPORT = 2;
    uint8 public constant K_NA = 3;
    uint8 public constant K_FIX = 4;
    uint8 internal constant F_REVEALED = 2;
    uint8 internal constant F_VALID = 3;
    uint8 internal constant F_INVALID = 4;

    struct Params {
        uint16 judgeQuorum;         // [3, 50]
        uint16 maxJudges;           // [judgeQuorum, 255]
        uint16 judgeMinScore;       // [0, 1000]
        uint32 unbondDelay;         // [1 day, 60 days]
        uint128 judgeBond;          // (0, 10000 ether]
        uint128 appealBond;         // (0, 1000 ether]
    }

    struct Judge {
        uint128 bond;
        uint64 lockedUntil;
        uint64 unbondAt;            // 0: active
        bool counted;
        bool blocked;
    }

    struct Appeal {
        address by;
        uint64 at;
        uint128 bond;
    }

    IAJNetwork public immutable network;
    IAJReputation public immutable reputation;
    address public governance;
    Params public params;

    mapping(address => Judge) public judges;
    uint256 public judgeCount;

    mapping(bytes32 => mapping(bytes32 => uint16)) public tally;
    mapping(bytes32 => mapping(address => bytes32)) public votedFor;
    mapping(bytes32 => bytes32) public decided;
    mapping(bytes32 => uint64) public itemReq;            // request id + 1 for items that pay judges
    mapping(bytes32 => mapping(address => bool)) public judgeClaimed;
    mapping(uint256 => uint128) public pot;               // the judges' part of the fee
    mapping(uint256 => uint32) public credits;            // winning votes on paid items
    mapping(uint256 => bool) public potReclaimed;
    mapping(uint256 => Appeal) public appeals;            // by finding id
    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    event Opened(uint256 indexed id, uint256 pot);
    event Bonded(address indexed judge, uint256 bond);
    event UnbondRequested(address indexed judge, uint64 at);
    event BondWithdrawn(address indexed judge, uint256 amount);
    event Voted(bytes32 indexed item, address indexed judge, bytes32 outcome);
    event Decided(bytes32 indexed item, uint256 indexed id, bytes32 outcome);
    event Appealed(uint256 indexed findingId, address indexed by);
    event AppealResolved(uint256 indexed findingId, bool changed, bool expired);
    event JudgeBlocked(address indexed judge, bool blocked);
    event JudgeSlashed(address indexed judge, uint256 amount);
    event Paid(address indexed to, uint256 amount, uint256 indexed id);
    event Withdrawn(address indexed to, uint256 amount);
    event ParamsSet();
    event GovernanceSet(address governance);

    error NotNetwork();
    error NotGovernance();
    error NotJudge();
    error BadParams();
    error BadValue();
    error Conflict();
    error Closed();
    error TooEarly();
    error TooMany();
    error AlreadyIn();
    error Locked();
    error Nothing();
    error Reentrant();
    error BadOutcome();         // from AuditNetwork.checkGroup (bubbles up)

    constructor(IAJNetwork network_, IAJReputation reputation_, address governance_, Params memory p) {
        require(address(network_) != address(0) && governance_ != address(0), "zero");
        network = network_;
        reputation = reputation_;
        governance = governance_;
        _setParams(p);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// AuditNetwork hands over the judges' part of a new request's fee.
    function open(uint256 id) external payable {
        if (msg.sender != address(network)) revert NotNetwork();
        pot[id] += uint128(msg.value);
        emit Opened(id, msg.value);
    }

    // ================================================================ the committee

    function bond() external payable {
        Judge storage j = judges[msg.sender];
        if (msg.value == 0) revert BadValue();
        if (j.unbondAt != 0) revert Locked();
        if (j.blocked) revert NotJudge();
        if (address(reputation) != address(0) && reputation.scoreOf(msg.sender) < params.judgeMinScore) revert NotJudge();
        j.bond += uint128(msg.value);
        _recount(j);
        emit Bonded(msg.sender, j.bond);
    }

    function requestUnbond() external {
        Judge storage j = judges[msg.sender];
        if (j.bond == 0 || j.unbondAt != 0) revert Nothing();
        uint64 at = uint64(block.timestamp + params.unbondDelay);
        if (j.lockedUntil > at) at = j.lockedUntil;
        j.unbondAt = at;
        _recount(j);
        emit UnbondRequested(msg.sender, at);
    }

    function withdrawBond() external nonReentrant {
        Judge storage j = judges[msg.sender];
        if (j.unbondAt == 0 || block.timestamp < j.unbondAt || block.timestamp < j.lockedUntil) revert TooEarly();
        uint256 a = j.bond;
        j.bond = 0;
        j.unbondAt = 0;
        _send(msg.sender, a);
        emit BondWithdrawn(msg.sender, a);
    }

    function _recount(Judge storage j) internal {
        bool active = j.unbondAt == 0 && !j.blocked && j.bond >= params.judgeBond;
        if (active && !j.counted) {
            if (judgeCount >= params.maxJudges) revert TooMany();
            j.counted = true;
            judgeCount++;
        } else if (!active && j.counted) {
            j.counted = false;
            judgeCount--;
        }
    }

    function isJudge(address who) external view returns (bool) {
        return judges[who].counted;
    }

    /// Votes a decision needs: judgeQuorum, and never fewer than a majority of the active judges.
    function quorum() public view returns (uint256) {
        uint256 q = params.judgeQuorum;
        uint256 maj = judgeCount / 2 + 1;
        return maj > q ? maj : q;
    }

    // ================================================================ votes

    function itemKey(uint8 kind, uint256 a, uint256 b) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.audit.item", kind, a, b));
    }

    function findingOutcome(bool valid, uint8 sev, uint256 group) public pure returns (bytes32) {
        return keccak256(abi.encode(valid, sev, group));
    }

    /// A revealed finding: invalid, or valid with a severity (1 info .. 5 critical) and its group (its own
    /// id for an original, else an earlier finding of the same request already decided valid as original).
    function voteFinding(uint256 fid, bool valid, uint8 sev, uint256 group) external {
        (uint64 id, uint8 st, bool late, uint256 judgeBy) = network.findingCore(fid);
        if (st != F_REVEALED || block.timestamp >= judgeBy) revert Closed();
        if (valid) network.checkGroup(fid, sev, group);
        else { sev = 0; group = fid; }
        if (_cast(itemKey(K_FINDING, fid, 0), findingOutcome(valid, sev, group), id, !late)) network.decide(fid, valid, sev, group);
    }

    function voteReport(uint256 id, address auditor, bool accept) external {
        (, , , uint256 judgeEnd, , ) = network.core(id);
        if (network.reportHash(id, auditor) == bytes32(0) || block.timestamp >= judgeEnd) revert Closed();
        if (_cast(itemKey(K_REPORT, id, uint256(uint160(auditor))), accept ? YES : NO, id, true) && !accept) network.rejectReport(id, auditor);
    }

    function voteNotApplicable(uint256 id, bool accept) external {
        (, , , uint256 judgeEnd, bool na, ) = network.core(id);
        if (!na || block.timestamp >= judgeEnd) revert Closed();
        _cast(itemKey(K_NA, id, 0), accept ? YES : NO, id, true);
    }

    /// For a fix: is the carried critical/high finding `fid` of the old version fixed in request `id`?
    function voteFixed(uint256 id, uint256 fid, bool fixed_) external {
        (, uint64 contestEnd, , uint256 judgeEnd, , ) = network.core(id);
        if (block.timestamp < contestEnd || block.timestamp >= judgeEnd || !network.isCarried(id, fid)) revert Closed();
        _cast(itemKey(K_FIX, id, fid), fixed_ ? YES : NO, id, true);
    }

    /// Records a judge's vote; true when it made the decision. `paid`: counts for the judges' pot.
    function _cast(bytes32 item, bytes32 outcome, uint256 id, bool paid) internal returns (bool) {
        Judge storage j = judges[msg.sender];
        if (!j.counted) revert NotJudge();
        if (network.involved(id, msg.sender)) revert Conflict();
        if (decided[item] != bytes32(0)) revert Closed();
        if (votedFor[item][msg.sender] != bytes32(0)) revert AlreadyIn();
        votedFor[item][msg.sender] = outcome;
        if (paid) itemReq[item] = uint64(id + 1);
        uint16 t = ++tally[item][outcome];
        (, uint32 aw, uint32 at) = network.timing();
        uint256 until = block.timestamp + aw + at;
        if (until > j.lockedUntil) j.lockedUntil = uint64(until);
        emit Voted(item, msg.sender, outcome);
        if (t < quorum()) return false;
        decided[item] = outcome;
        if (paid) credits[id] += t;
        emit Decided(item, id, outcome);
        return true;
    }

    function naAccepted(uint256 id) external view returns (bool) {
        return decided[itemKey(K_NA, id, 0)] == YES;
    }

    function fixConfirmed(uint256 id, uint256 fid) external view returns (bool) {
        return decided[itemKey(K_FIX, id, fid)] == YES;
    }

    // ================================================================ appeals

    /// Anyone appeals a decided finding before AuditNetwork's appeal window for it ends.
    function appeal(uint256 fid) external payable {
        if (msg.value != params.appealBond) revert BadValue();
        network.setAppeal(fid, true); // reverts unless decided, in time and not already appealed
        appeals[fid] = Appeal(msg.sender, uint64(block.timestamp), uint128(msg.value));
        emit Appealed(fid, msg.sender);
    }

    /// Governance (the timelock) decides an appeal; its outcome replaces the judges'.
    function resolveAppeal(uint256 fid, bool valid, uint8 sev, uint256 group) external onlyGovernance {
        Appeal memory a = appeals[fid];
        if (a.by == address(0)) revert Closed();
        if (!valid) { sev = 0; group = fid; }
        bytes32 item = itemKey(K_FINDING, fid, 0);
        bytes32 old = decided[item];
        bytes32 next = findingOutcome(valid, sev, group);
        bool changed = old != next;
        if (changed) {
            network.decide(fid, valid, sev, group);
            decided[item] = next;
            uint64 r = itemReq[item];
            if (r != 0) credits[r - 1] = credits[r - 1] - tally[item][old] + tally[item][next];
        }
        _close(fid, a, changed, false);
    }

    /// After appealTimeout without a governance decision the judges' decision stands; the bond comes back.
    function expireAppeal(uint256 fid) external {
        Appeal memory a = appeals[fid];
        if (a.by == address(0)) revert Closed();
        (, , uint32 timeout) = network.timing();
        if (block.timestamp < uint256(a.at) + timeout) revert TooEarly();
        _close(fid, a, true, true);
    }

    function _close(uint256 fid, Appeal memory a, bool refund, bool expired) internal {
        delete appeals[fid];
        network.setAppeal(fid, false);
        owed[refund ? a.by : network.treasury()] += a.bond;
        emit AppealResolved(fid, refund && !expired, expired);
    }

    // ================================================================ pay

    /// A judge's share of request `id`'s pot: one credit per contest decision it voted with.
    function claim(uint256 id, bytes32[] calldata items) external {
        (, , , , , bool settled) = network.core(id);
        if (!settled) revert TooEarly();
        uint256 n;
        for (uint256 i = 0; i < items.length; i++) {
            bytes32 it = items[i];
            bytes32 d = decided[it];
            if (itemReq[it] != id + 1 || judgeClaimed[it][msg.sender] || d == bytes32(0) || votedFor[it][msg.sender] != d) revert Nothing();
            judgeClaimed[it][msg.sender] = true;
            n++;
        }
        if (n == 0 || credits[id] == 0) revert Nothing();
        uint256 amount = (uint256(pot[id]) * n) / credits[id];
        owed[msg.sender] += amount;
        emit Paid(msg.sender, amount, id);
    }

    /// Nothing was decided on a settled request: the sponsor takes the judges' pot back.
    function reclaimPot(uint256 id) external {
        (address sponsor, , , , , bool settled) = network.core(id);
        if (msg.sender != sponsor || !settled || credits[id] != 0 || potReclaimed[id]) revert Nothing();
        potReclaimed[id] = true;
        owed[sponsor] += pot[id];
        emit Paid(sponsor, pot[id], id);
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

    // ================================================================ governance

    function setParams(Params calldata p) external onlyGovernance {
        _setParams(p);
    }

    function setGovernance(address g) external onlyGovernance {
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    /// Removes (or re-admits) a judge; its bond stays its own (withdraw after unbonding).
    function setJudgeBlocked(address who, bool blocked) external onlyGovernance {
        Judge storage j = judges[who];
        j.blocked = blocked;
        _recount(j);
        emit JudgeBlocked(who, blocked);
    }

    /// Slashes a judge for proven collusion (at most its bond), to the treasury.
    function slashJudge(address who, uint128 amount) external onlyGovernance {
        Judge storage j = judges[who];
        if (amount > j.bond) amount = j.bond;
        j.bond -= amount;
        owed[network.treasury()] += amount;
        _recount(j);
        emit JudgeSlashed(who, amount);
    }

    function _setParams(Params memory p) internal {
        if (p.judgeQuorum < 3 || p.judgeQuorum > 50 || p.maxJudges < p.judgeQuorum || p.maxJudges > 255 || p.judgeMinScore > 1000) revert BadParams();
        if (p.unbondDelay < 1 days || p.unbondDelay > 60 days) revert BadParams();
        if (p.judgeBond == 0 || p.judgeBond > 10_000 ether || p.appealBond == 0 || p.appealBond > 1000 ether) revert BadParams();
        if (judgeCount > p.maxJudges) revert BadParams();
        params = p;
        emit ParamsSet();
    }
}
