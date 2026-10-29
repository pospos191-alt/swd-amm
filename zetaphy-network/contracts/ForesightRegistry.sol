// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ForesightRegistry: Proof of Foresight (testnet)
/// @notice Forecasters and AI models commit keccak256(eventId, modelId, p, salt)
///         before an event's commit deadline and reveal p after it, so nobody can
///         copy a forecast or change it once the answer is known. When the event's
///         resolver states the outcome, every commitment is scored with the Brier
///         score (p - outcome)^2 and added to the model's public track record.
///         A commitment that is never revealed scores the worst possible loss (1.0),
///         so hiding a bad forecast never pays.
///
///         Probabilities are in basis points (0..10000 = 0..100%); a Brier score is
///         stored scaled by 1e8 (1.0 = 100_000_000). Always saying 50% scores 0.25.
///
///         Only resolvers that governance approved (contracts that resolve from
///         on-chain facts, such as RiskForecasts and RedBlueArena) may open events,
///         so nobody can make up events whose outcome they choose.
///         The track record is a weight, not money: DetectorPool pays and slashes
///         detectors with it, and Neuro may weight models by `skill`.
contract ForesightRegistry {
    uint256 public constant ONE = 10_000;
    uint256 public constant MAX_LOSS = ONE * ONE;      // 1.0
    uint256 public constant COIN_FLIP = MAX_LOSS / 4;  // 0.25: always 50%
    uint256 public constant PRIOR_N = 10;              // skill shrinks toward 0 with few forecasts

    enum Outcome { Open, No, Yes, Void }

    struct Event {
        address resolver;
        uint64 commitEnd;
        uint64 revealEnd;
        Outcome outcome;
        uint32 commits;
        bytes32 topic;       // what the event is, e.g. keccak256(abi.encode(market contract, market id))
    }

    struct Forecast {
        bytes32 commitment;
        uint16 p;            // revealed probability of Yes, basis points
        bool revealed;
        bool scored;
    }

    struct Track {
        uint32 n;            // scored forecasts
        uint32 unrevealed;   // of which never revealed (scored 1.0)
        uint64 brierSum;     // sum of Brier scores, 1e8 each at most
    }

    address public governance;
    uint256 public eventCount;
    mapping(address => bool) public resolvers;
    mapping(bytes32 => address) public modelOwner;
    mapping(uint256 => Event) public events;
    mapping(uint256 => mapping(bytes32 => Forecast)) public forecasts;
    mapping(bytes32 => Track) public tracks;

    event GovernanceSet(address governance);
    event ResolverSet(address indexed resolver, bool on);
    event ModelRegistered(bytes32 indexed modelId, address indexed owner);
    event ModelTransferred(bytes32 indexed modelId, address indexed to);
    event EventOpened(uint256 indexed id, address indexed resolver, bytes32 topic, uint64 commitEnd, uint64 revealEnd);
    event CommitsClosed(uint256 indexed id, uint64 at);
    event Committed(uint256 indexed id, bytes32 indexed modelId, bytes32 commitment);
    event Revealed(uint256 indexed id, bytes32 indexed modelId, uint16 p);
    event Resolved(uint256 indexed id, Outcome outcome);
    event Scored(uint256 indexed id, bytes32 indexed modelId, uint256 brier, bool revealed);

    error NotGovernance();
    error NotResolver();
    error NotModelOwner();
    error Taken();
    error BadTimes();
    error Closed();
    error NotYet();
    error BadReveal();
    error BadOutcome();
    error NothingToScore();

    constructor(address governance_) {
        governance = governance_;
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address g) external onlyGov {
        governance = g;
        emit GovernanceSet(g);
    }

    function setResolver(address r, bool on) external onlyGov {
        resolvers[r] = on;
        emit ResolverSet(r, on);
    }

    // ------------------------------------------------------------------ models

    /// A model id (e.g. keccak256("neuro-ml nml-b4c35477f7b1") or a detector's id) belongs to the first to claim it.
    function registerModel(bytes32 modelId) external {
        if (modelId == bytes32(0) || modelOwner[modelId] != address(0)) revert Taken();
        modelOwner[modelId] = msg.sender;
        emit ModelRegistered(modelId, msg.sender);
    }

    function transferModel(bytes32 modelId, address to) external {
        if (modelOwner[modelId] != msg.sender || to == address(0)) revert NotModelOwner();
        modelOwner[modelId] = to;
        emit ModelTransferred(modelId, to);
    }

    // ------------------------------------------------------------------ events

    function openEvent(bytes32 topic, uint64 commitEnd, uint64 revealEnd) external returns (uint256 id) {
        if (!resolvers[msg.sender]) revert NotResolver();
        if (commitEnd <= block.timestamp || revealEnd <= commitEnd) revert BadTimes();
        id = ++eventCount;
        events[id] = Event(msg.sender, commitEnd, revealEnd, Outcome.Open, 0, topic);
        emit EventOpened(id, msg.sender, topic, commitEnd, revealEnd);
    }

    /// The resolver closes commits early, e.g. as soon as the watched condition is seen.
    function closeCommits(uint256 id) external {
        Event storage e = events[id];
        if (msg.sender != e.resolver) revert NotResolver();
        if (block.timestamp < e.commitEnd) {
            uint64 shift = e.commitEnd - uint64(block.timestamp);
            e.commitEnd = uint64(block.timestamp);
            e.revealEnd -= shift; // the reveal period keeps its length
            emit CommitsClosed(id, uint64(block.timestamp));
        }
    }

    function resolve(uint256 id, Outcome outcome) external {
        Event storage e = events[id];
        if (msg.sender != e.resolver) revert NotResolver();
        if (outcome == Outcome.Open) revert BadOutcome();
        if (e.outcome != Outcome.Open) revert Closed();
        if (block.timestamp < e.commitEnd) {
            // resolving closes commits
            uint64 shift = e.commitEnd - uint64(block.timestamp);
            e.commitEnd = uint64(block.timestamp);
            e.revealEnd -= shift;
        }
        e.outcome = outcome;
        emit Resolved(id, outcome);
    }

    // ------------------------------------------------------------------ forecasts

    function commitmentOf(uint256 id, bytes32 modelId, uint16 p, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, modelId, p, salt));
    }

    /// Commits (or replaces, before the deadline) a model's hidden forecast.
    function commit(uint256 id, bytes32 modelId, bytes32 commitment) external {
        Event storage e = events[id];
        if (modelOwner[modelId] != msg.sender) revert NotModelOwner();
        if (e.resolver == address(0) || e.outcome != Outcome.Open || block.timestamp >= e.commitEnd) revert Closed();
        if (commitment == bytes32(0)) revert BadReveal();
        Forecast storage f = forecasts[id][modelId];
        if (f.commitment == bytes32(0)) e.commits++;
        f.commitment = commitment;
        emit Committed(id, modelId, commitment);
    }

    /// Anyone holding the salt may reveal, after the commit deadline and before the reveal deadline.
    function reveal(uint256 id, bytes32 modelId, uint16 p, bytes32 salt) external {
        Event storage e = events[id];
        if (block.timestamp < e.commitEnd) revert NotYet();
        if (block.timestamp >= e.revealEnd) revert Closed();
        Forecast storage f = forecasts[id][modelId];
        if (p > ONE || f.revealed || f.commitment == bytes32(0) || f.commitment != commitmentOf(id, modelId, p, salt)) revert BadReveal();
        f.p = p;
        f.revealed = true;
        emit Revealed(id, modelId, p);
    }

    /// Adds a forecast's Brier score to its model's track record (anyone may call).
    /// A revealed forecast is scored once the event is resolved; an unrevealed one after the reveal deadline (as 1.0).
    function score(uint256 id, bytes32 modelId) public returns (uint256 brier) {
        Event storage e = events[id];
        Forecast storage f = forecasts[id][modelId];
        if (f.commitment == bytes32(0) || f.scored || e.outcome == Outcome.Open || e.outcome == Outcome.Void) revert NothingToScore();
        if (!f.revealed && block.timestamp < e.revealEnd) revert NotYet();
        if (f.revealed) {
            uint256 target = e.outcome == Outcome.Yes ? ONE : 0;
            uint256 d = f.p > target ? f.p - target : target - f.p;
            brier = d * d;
        } else {
            brier = MAX_LOSS;
        }
        f.scored = true;
        Track storage t = tracks[modelId];
        t.n += 1;
        if (!f.revealed) t.unrevealed += 1;
        t.brierSum += uint64(brier);
        emit Scored(id, modelId, brier, f.revealed);
    }

    function scoreMany(uint256 id, bytes32[] calldata modelIds) external {
        for (uint256 i; i < modelIds.length; i++) {
            Forecast storage f = forecasts[id][modelIds[i]];
            if (f.commitment != bytes32(0) && !f.scored) score(id, modelIds[i]);
        }
    }

    // ------------------------------------------------------------------ track record

    /// Mean Brier score (1e8 = 1.0) over n scored forecasts; mean is 0 when n is 0.
    function brierOf(bytes32 modelId) external view returns (uint256 n, uint256 mean) {
        Track memory t = tracks[modelId];
        n = t.n;
        mean = n == 0 ? 0 : t.brierSum / n;
    }

    /// Skill in basis points: how much better than always saying 50% (0 = no better, 10000 = perfect),
    /// shrunk by n / (n + PRIOR_N) so a short lucky record weighs little.
    function skill(bytes32 modelId) external view returns (uint256) {
        Track memory t = tracks[modelId];
        if (t.n == 0) return 0;
        uint256 mean = t.brierSum / t.n;
        if (mean >= COIN_FLIP) return 0;
        uint256 s = ((COIN_FLIP - mean) * ONE) / COIN_FLIP;
        return (s * t.n) / (t.n + PRIOR_N);
    }
}
