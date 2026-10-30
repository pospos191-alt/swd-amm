// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The request windows and sponsor AuditNetwork exposes.
interface IARNetwork {
    function core(uint256 id) external view returns (address sponsor, uint64 contestEnd, uint256 revealEnd, uint256 judgeEnd, bool naDeclared, bool settled);
}

/// NeuroJobs' runner record (the same bar BugBounty and ThreatRegistry use).
interface IARJobs {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IARReputation {
    function record(address worker, uint8 kind, bytes32 ref) external;
}

/// @title AuditRunners: the automated tier of an AuditNetwork request
/// @notice Three bonded NeuroJobs runners (the useful-work runners: `zetaphy audit run`) run the audit
///         pipeline (audit/report.js: Slither, Aderyn, Semgrep, SMTChecker, fuzzers, Halmos, mutation
///         testing), Neuro's rules and, if their owner set one up, an LLM review on the EXACT code of the
///         request, and commit the hash of the canonical result together with its summary numbers:
///             (resultHash, open critical+high, invariant suites failed, suites not run, mutation score bps)
///         commitment = keccak256("zetaphy.audit.run", keccak256(abi.encode(result)), runner, salt, requestId)
///         Commits until the contest ends, reveals in the request's reveal window, so nobody copies a
///         result. The tier counts only when at least 2 of the 3 seats revealed the SAME tuple
///         (UsefulWork's agreement pattern); the agreeing seats share the runners' part of the fee,
///         the others are reported to WorkerReputation (disagreed / missed). With no agreement the fee
///         goes back to the sponsor and the request can never be certified (strict: a new request).
///         The LLM review is advisory and is NOT part of the hashed result: two honest runners must get
///         the same hash; AI findings enter the contest as ordinary findings that judges decide.
contract AuditRunners {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    uint8 internal constant AGREED = 0;
    uint8 internal constant DISAGREED = 1;
    uint8 internal constant MISSED = 2;

    struct Result {
        bytes32 resultHash;      // keccak256 of the canonical pipeline + Neuro result (src/auditnet.js canonicalResult)
        uint32 critHigh;         // open (or accepted) critical + high findings in it
        uint32 invFailed;        // invariant suites that failed
        uint32 invNotRun;        // invariant suites that did not run (n/a must then be accepted by the judges)
        uint16 mutationBps;      // mutation score, 0..10000
    }

    struct Tier {
        uint128 fee;
        uint8 taken;
        uint8 revealed;
        bool settled;
        bool agreed;
        bytes32 accepted;        // keccak256(abi.encode(Result)) of the agreed tuple
    }

    IARNetwork public immutable network;
    IARJobs public immutable jobs;
    IARReputation public immutable reputation;
    uint32 public immutable minAgreed;

    mapping(uint256 => Tier) public tiers;
    mapping(uint256 => address[]) private _seats;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bytes32)) public revealedKey;
    mapping(bytes32 => Result) private _results;
    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    event Opened(uint256 indexed id, uint256 fee);
    event Committed(uint256 indexed id, address indexed runner);
    event Revealed(uint256 indexed id, address indexed runner, bytes32 resultHash, uint32 critHigh, uint32 invFailed, uint32 invNotRun, uint16 mutationBps);
    event TierSettled(uint256 indexed id, bool agreed, bytes32 resultHash, uint256 agreedSeats, uint256 paidEach);
    event Withdrawn(address indexed to, uint256 amount);

    error NotNetwork();
    error NotRunner();
    error Closed();
    error TooEarly();
    error AlreadyIn();
    error BadReveal();
    error Nothing();
    error Reentrant();

    constructor(IARNetwork network_, IARJobs jobs_, IARReputation reputation_, uint32 minAgreed_) {
        require(address(network_) != address(0) && address(jobs_) != address(0), "zero");
        network = network_;
        jobs = jobs_;
        reputation = reputation_;
        minAgreed = minAgreed_;
    }

    /// AuditNetwork opens the tier of a new request with the runners' part of its fee.
    function open(uint256 id) external payable {
        if (msg.sender != address(network)) revert NotNetwork();
        tiers[id].fee += uint128(msg.value);
        emit Opened(id, msg.value);
    }

    function commitmentOf(Result calldata r, address runner, bytes32 salt, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.audit.run", keccak256(abi.encode(r)), runner, salt, id));
    }

    function eligible(address runner) public view returns (bool) {
        (, , bool active, uint32 agreed, uint32 rejected) = jobs.workers(runner);
        return active && agreed >= minAgreed && rejected <= agreed;
    }

    function commit(uint256 id, bytes32 commitment) external {
        (address sponsor, uint64 contestEnd, , , , ) = network.core(id);
        Tier storage t = tiers[id];
        if (t.settled || t.taken >= SEATS || block.timestamp >= contestEnd) revert Closed();
        if (!eligible(msg.sender) || msg.sender == sponsor) revert NotRunner();
        if (commitment == bytes32(0) || commitments[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        commitments[id][msg.sender] = commitment;
        _seats[id].push(msg.sender);
        t.taken++;
        emit Committed(id, msg.sender);
    }

    function reveal(uint256 id, Result calldata r, bytes32 salt) external {
        (, uint64 contestEnd, uint256 revealEnd, , , ) = network.core(id);
        Tier storage t = tiers[id];
        if (block.timestamp < contestEnd) revert TooEarly();
        if (t.settled || block.timestamp >= revealEnd) revert Closed();
        bytes32 c = commitments[id][msg.sender];
        if (c == bytes32(0) || revealedKey[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        if (r.resultHash == bytes32(0) || r.mutationBps > 10_000 || commitmentOf(r, msg.sender, salt, id) != c) revert BadReveal();
        bytes32 k = keccak256(abi.encode(r));
        revealedKey[id][msg.sender] = k;
        _results[k] = r;
        t.revealed++;
        emit Revealed(id, msg.sender, r.resultHash, r.critHigh, r.invFailed, r.invNotRun, r.mutationBps);
    }

    /// Anyone, once all 3 seats revealed or the reveal window ended.
    function settle(uint256 id) external {
        (address sponsor, uint64 contestEnd, uint256 revealEnd, , , ) = network.core(id);
        Tier storage t = tiers[id];
        if (t.settled) revert Closed();
        bool allIn = t.taken == SEATS && t.revealed == SEATS && block.timestamp >= contestEnd;
        if (!allIn && block.timestamp < revealEnd) revert TooEarly();
        t.settled = true;
        address[] memory seats = _seats[id];
        bytes32 k = _majority(id, seats);
        uint256 n;
        for (uint256 i = 0; i < seats.length; i++) if (k != bytes32(0) && revealedKey[id][seats[i]] == k) n++;
        uint256 each;
        if (n > 0) {
            t.agreed = true;
            t.accepted = k;
            each = t.fee / n;
        } else {
            owed[sponsor] += t.fee; // no agreement: the fee goes back
        }
        for (uint256 i = 0; i < seats.length; i++) {
            bytes32 v = revealedKey[id][seats[i]];
            uint8 kind = v == bytes32(0) ? MISSED : (k != bytes32(0) && v == k ? AGREED : DISAGREED);
            if (kind == AGREED) owed[seats[i]] += each;
            if (k != bytes32(0) || kind == MISSED) _rep(seats[i], kind, id);
        }
        emit TierSettled(id, t.agreed, t.agreed ? _results[k].resultHash : bytes32(0), n, each);
    }

    function withdraw() external {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        if (!ok) revert Nothing();
        _lock = 1;
        emit Withdrawn(msg.sender, a);
    }

    /// The agreed result of request `id` (agreed = false: none, or not settled yet).
    function result(uint256 id) external view returns (bool agreed, Result memory r) {
        Tier storage t = tiers[id];
        if (!t.settled || !t.agreed) return (false, r);
        return (true, _results[t.accepted]);
    }

    function seatsOf(uint256 id) external view returns (address[] memory) {
        return _seats[id];
    }

    function _majority(uint256 id, address[] memory seats) internal view returns (bytes32) {
        for (uint256 i = 0; i < seats.length; i++) {
            bytes32 v = revealedKey[id][seats[i]];
            if (v == bytes32(0)) continue;
            uint256 n;
            for (uint256 j = 0; j < seats.length; j++) if (revealedKey[id][seats[j]] == v) n++;
            if (n >= QUORUM) return v; // QUORUM > SEATS/2: at most one tuple reaches it
        }
        return bytes32(0);
    }

    function _rep(address w, uint8 kind, uint256 id) internal {
        if (address(reputation) == address(0)) return;
        try reputation.record(w, kind, keccak256(abi.encode("zetaphy.audit.run", id))) {} catch {}
    }
}
