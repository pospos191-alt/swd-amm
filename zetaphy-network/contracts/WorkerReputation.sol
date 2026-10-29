// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// NeuroJobs' runner record (read-only; the runner's NeuroJobs history counts too).
interface IRepRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// The identity registry (NeuroIdentity, ERC-8004 Identity Registry) a worker may link.
interface IRepIdentity {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title WorkerReputation: on-chain track record of useful-work workers and Neuro runners
/// @notice An ERC-8004-style Reputation Registry for the workers of ZETAPHY's useful-work
///         markets (UsefulWork scan jobs, BugBounty findings) and, read-only, the bonded
///         NeuroJobs runners. Feedback is NOT free text from anyone: only contracts that
///         governance names as reporters (the markets themselves) write outcomes, and each
///         outcome is the result of a commit-reveal round they settled on-chain:
///           - agreed:     the worker's revealed answer matched the accepted result
///           - disagreed:  it revealed a different answer
///           - missed:     it took a seat and never revealed
///           - slashed:    it answered a known-answer (canary) job wrong, or governance slashed it
///           - bugValid / bugInvalid: a bug finding runners accepted / rejected
///         The score (0..1000) is a smoothed success rate:
///             good = agreed + 3*bugValid + NeuroJobs.agreed
///             bad  = disagreed + 2*missed + 5*slashed + 3*bugInvalid + NeuroJobs.rejected
///             score = 1000 * good / (good + bad + PRIOR)
///         PRIOR (5 phantom failures) means a new address starts at 0 and needs a track
///         record before the markets give it important jobs (UsefulWork.minScore). A score
///         is only as good as the markets that feed it: it measures agreement with the
///         other workers (and canaries), not truth.
///
///         Linking: a worker that owns an ERC-8004 agent in NeuroIdentity can link it, and
///         `getSummary(agentId)` then answers in the ERC-8004 reputation shape (count,
///         average 0..100).
///
///         Governance (a ZetaphyTimelock) names reporters and may slash by hand; adding a
///         reporter is a timelocked action, removing one is too (no guardian path: a
///         reporter can only lower or raise scores, it cannot move funds).
contract WorkerReputation {
    uint256 public constant PRIOR = 5;
    uint256 public constant MAX_SCORE = 1000;

    enum Kind { Agreed, Disagreed, Missed, Slashed, BugValid, BugInvalid }

    struct Record {
        uint32 agreed;
        uint32 disagreed;
        uint32 missed;
        uint32 slashed;
        uint32 bugValid;
        uint32 bugInvalid;
        uint64 lastAt;
    }

    address public governance;
    IRepRunners public immutable runners;   // NeuroJobs, or address(0)
    IRepIdentity public immutable identity; // NeuroIdentity, or address(0)
    mapping(address => bool) public reporters;
    mapping(address => Record) private _records;
    mapping(uint256 => address) public workerOfAgent;
    mapping(address => uint256) public agentOfWorker; // 0 = none (agent ids start at 1 in NeuroIdentity)

    event Outcome(address indexed worker, Kind indexed kind, address indexed reporter, bytes32 ref);
    event ReporterSet(address indexed reporter, bool on);
    event AgentLinked(address indexed worker, uint256 indexed agentId);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotReporter();
    error NotAgentOwner();
    error ZeroAddress();

    constructor(address governance_, IRepRunners runners_, IRepIdentity identity_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        runners = runners_;
        identity = identity_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ---------------------------------------------------------------- writes

    /// A market reports one settled outcome for a worker (ref = the job / finding it was about).
    function record(address worker, Kind kind, bytes32 ref) external {
        if (!reporters[msg.sender]) revert NotReporter();
        _record(worker, kind, ref);
    }

    /// Governance slashes by hand (e.g. proven collusion found off-chain).
    function slash(address worker, bytes32 ref) external onlyGovernance {
        _record(worker, Kind.Slashed, ref);
    }

    function _record(address worker, Kind kind, bytes32 ref) internal {
        Record storage r = _records[worker];
        if (kind == Kind.Agreed) r.agreed++;
        else if (kind == Kind.Disagreed) r.disagreed++;
        else if (kind == Kind.Missed) r.missed++;
        else if (kind == Kind.Slashed) r.slashed++;
        else if (kind == Kind.BugValid) r.bugValid++;
        else r.bugInvalid++;
        r.lastAt = uint64(block.timestamp);
        emit Outcome(worker, kind, msg.sender, ref);
    }

    function setReporter(address reporter, bool on) external onlyGovernance {
        if (reporter == address(0)) revert ZeroAddress();
        reporters[reporter] = on;
        emit ReporterSet(reporter, on);
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert ZeroAddress();
        governance = next;
        emit GovernanceChanged(next);
    }

    /// Links the caller to an ERC-8004 agent it owns (one agent per worker, one worker per agent).
    function linkAgent(uint256 agentId) external {
        if (address(identity) == address(0) || identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        uint256 old = agentOfWorker[msg.sender];
        if (old != 0) delete workerOfAgent[old];
        address prev = workerOfAgent[agentId];
        if (prev != address(0)) delete agentOfWorker[prev];
        workerOfAgent[agentId] = msg.sender;
        agentOfWorker[msg.sender] = agentId;
        emit AgentLinked(msg.sender, agentId);
    }

    // ---------------------------------------------------------------- reads

    function recordOf(address worker) external view returns (Record memory) {
        return _records[worker];
    }

    /// Good and bad outcome weights (this registry's records plus the NeuroJobs runner record).
    function weights(address worker) public view returns (uint256 good, uint256 bad) {
        Record memory r = _records[worker];
        good = uint256(r.agreed) + 3 * uint256(r.bugValid);
        bad = uint256(r.disagreed) + 2 * uint256(r.missed) + 5 * uint256(r.slashed) + 3 * uint256(r.bugInvalid);
        if (address(runners) != address(0)) {
            try runners.workers(worker) returns (uint128, uint64, bool, uint32 agreed, uint32 rejected) {
                good += agreed;
                bad += rejected;
            } catch {}
        }
    }

    /// 0..1000; 0 for an address with no record.
    function scoreOf(address worker) public view returns (uint256) {
        (uint256 good, uint256 bad) = weights(worker);
        return (MAX_SCORE * good) / (good + bad + PRIOR);
    }

    /// ERC-8004 reputation shape for a linked agent: (outcomes counted, average 0..100).
    function getSummary(uint256 agentId) external view returns (uint64 count, uint8 averageScore) {
        address w = workerOfAgent[agentId];
        if (w == address(0)) return (0, 0);
        (uint256 good, uint256 bad) = weights(w);
        count = uint64(good + bad);
        averageScore = uint8(scoreOf(w) / 10);
    }
}
