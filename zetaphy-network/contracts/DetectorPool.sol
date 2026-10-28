// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IForesightTracks {
    function modelOwner(bytes32 modelId) external view returns (address);
    function tracks(bytes32 modelId) external view returns (uint32 n, uint32 unrevealed, uint64 brierSum);
}

/// @title DetectorPool: evolving scam detectors (testnet)
/// @notice A detector "organism" is a rule set or model (its spec's hash + URI, e.g. a
///         zetaphy-neuro/ml/detectors spec JSON) with an author, a testnet stake, a parent
///         (the organism it was mutated from, 0 for none) and a ForesightRegistry model id.
///         The organism forecasts resolved questions (RiskForecasts, the arena) through
///         ForesightRegistry with commit-reveal, so its record cannot be faked or copied.
///
///         Every round (anyone may call `scoreRound` once it ended), each living organism's
///         Brier scores from that round are read from ForesightRegistry:
///           - at least `minForecasts` scored and better than always-50% (Brier < 0.25): a
///             winner, paid from the slashed stakes plus `rewardPerRound` from the pool, in
///             proportion to (0.25 - Brier) x forecasts;
///           - worse than always-50%: a loser, `slashBps` of its stake is slashed, one strike;
///             at `maxStrikes` strikes, or a stake below `minStake`, it is retired (the rest
///             of its stake is returned to its author);
///           - fewer forecasts: no change, but after MAX_IDLE such rounds in a row it is retired
///             (stake returned, not slashed), so the pool only keeps detectors that keep working.
///         A mutation script (zetaphy-neuro/ml/detectors/mutate.js, run on a GitHub Actions
///         schedule) breeds new variants from the best organisms and registers them.
contract DetectorPool {
    uint256 public constant BPS = 10_000;
    uint256 public constant COIN_FLIP = 25_000_000; // Brier 0.25 at 1e8 scale
    uint256 public constant MAX_ALIVE = 64;
    uint256 public constant MAX_URI = 200;
    uint16 public constant MAX_IDLE = 4;     // retired (stake returned, no slash) after 4 idle rounds

    struct Organism {
        address author;
        uint32 parent;
        uint16 strikes;
        uint16 wins;
        uint16 idle;         // rounds in a row with too few forecasts
        bool alive;
        bool leaving;
        uint64 born;
        uint128 stake;
        bytes32 modelId;
        bytes32 specHash;
        uint32 lastN;        // Foresight track at the last round
        uint64 lastSum;
        uint64 lastBrier;    // the last round's mean Brier (1e8), 0 if not scored
        string uri;
    }

    address public governance;
    IForesightTracks public foresight;
    uint128 public minStake = 1 ether;
    uint16 public slashBps = 2000;
    uint16 public maxStrikes = 3;
    uint32 public minForecasts = 3;
    uint64 public roundLength = 7 days;
    uint128 public rewardPerRound = 10 ether;
    uint64 public roundEnd;
    uint32 public round = 1;
    uint256 public pool;        // funded rewards + slashed stakes not yet paid
    uint256 public totalStake;

    Organism[] private _orgs;
    uint32[] public aliveIds;
    mapping(bytes32 => uint32) public organismOfModel;
    mapping(address => uint256) public owed;

    event Born(uint32 indexed id, address indexed author, uint32 indexed parent, bytes32 modelId, bytes32 specHash, uint256 stake, string uri);
    event Won(uint32 indexed id, uint32 indexed round, uint256 brier, uint256 reward);
    event Slashed(uint32 indexed id, uint32 indexed round, uint256 brier, uint256 n, uint256 amount, uint16 strikes);
    event Retired(uint32 indexed id, uint32 indexed round, uint256 returned);
    event RoundScored(uint32 indexed round, uint256 winners, uint256 losers, uint256 paid, uint64 nextEnd);
    event Funded(address indexed from, uint256 amount);
    event ParamsSet(uint128 minStake, uint16 slashBps, uint16 maxStrikes, uint32 minForecasts, uint64 roundLength, uint128 rewardPerRound);
    event GovernanceSet(address governance);

    error NotGovernance();
    error BadInput();
    error NotModelOwner();
    error ModelInUse();
    error Full();
    error NotAuthor();
    error NotYet();
    error NothingOwed();
    error SendFailed();

    constructor(address governance_, IForesightTracks foresight_) {
        governance = governance_;
        foresight = foresight_;
        roundEnd = uint64(block.timestamp) + roundLength;
        _orgs.push(); // id 0 = none
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    receive() external payable { pool += msg.value; emit Funded(msg.sender, msg.value); }
    function fund() external payable { pool += msg.value; emit Funded(msg.sender, msg.value); }

    function setGovernance(address g) external onlyGov { governance = g; emit GovernanceSet(g); }

    function setParams(uint128 stake, uint16 slash, uint16 strikes, uint32 minF, uint64 length, uint128 reward) external onlyGov {
        if (stake == 0 || slash > 5000 || strikes == 0 || minF == 0 || length < 1 hours || length > 90 days) revert BadInput();
        (minStake, slashBps, maxStrikes, minForecasts, roundLength, rewardPerRound) = (stake, slash, strikes, minF, length, reward);
        emit ParamsSet(stake, slash, strikes, minF, length, reward);
    }

    // ------------------------------------------------------------------ organisms

    function register(bytes32 modelId, bytes32 specHash, uint32 parent, string calldata uri) external payable returns (uint32 id) {
        if (msg.value < minStake || msg.value > type(uint128).max || specHash == bytes32(0) || bytes(uri).length > MAX_URI || parent >= _orgs.length) revert BadInput();
        if (foresight.modelOwner(modelId) != msg.sender) revert NotModelOwner();
        if (organismOfModel[modelId] != 0) revert ModelInUse();
        if (aliveIds.length >= MAX_ALIVE) revert Full();
        (uint32 n,, uint64 sum) = foresight.tracks(modelId);
        id = uint32(_orgs.length);
        _orgs.push(Organism(msg.sender, parent, 0, 0, 0, true, false, uint64(block.timestamp), uint128(msg.value), modelId, specHash, n, sum, 0, uri));
        organismOfModel[modelId] = id;
        aliveIds.push(id);
        totalStake += msg.value;
        emit Born(id, msg.sender, parent, modelId, specHash, msg.value, uri);
    }

    /// Leaves after the next round is scored (so a bad round cannot be dodged).
    function requestExit(uint32 id) external {
        Organism storage o = _orgs[id];
        if (o.author != msg.sender || !o.alive) revert NotAuthor();
        o.leaving = true;
    }

    function organismCount() external view returns (uint256) { return _orgs.length - 1; }
    function aliveCount() external view returns (uint256) { return aliveIds.length; }

    function organism(uint32 id) external view returns (address author, uint32 parent, bool alive, uint128 stake, uint16 strikes, uint16 wins, bytes32 modelId, bytes32 specHash, uint64 lastBrier, string memory uri) {
        Organism storage o = _orgs[id];
        return (o.author, o.parent, o.alive, o.stake, o.strikes, o.wins, o.modelId, o.specHash, o.lastBrier, o.uri);
    }

    // ------------------------------------------------------------------ rounds

    function scoreRound() external {
        if (block.timestamp < roundEnd) revert NotYet();
        uint256 len = aliveIds.length;
        uint256[] memory weight = new uint256[](len);
        uint256 totalWeight;
        uint256 slashed;
        uint256 winners;
        uint256 losers;
        for (uint256 i; i < len; i++) {
            (uint256 w, uint256 cut, bool lost) = _judge(aliveIds[i]);
            weight[i] = w;
            totalWeight += w;
            slashed += cut;
            if (w > 0) winners++;
            if (lost) losers++;
        }
        pool += slashed;
        uint256 paid;
        if (totalWeight > 0) {
            // slashed stakes are always passed on; the funded part is capped per round
            uint256 budget = rewardPerRound + slashed;
            if (budget > pool) budget = pool;
            for (uint256 i; i < len; i++) {
                if (weight[i] == 0) continue;
                uint256 r = (budget * weight[i]) / totalWeight;
                Organism storage o = _orgs[aliveIds[i]];
                owed[o.author] += r;
                paid += r;
                emit Won(aliveIds[i], round, o.lastBrier, r);
            }
            pool -= paid;
        }
        _retire();
        emit RoundScored(round, winners, losers, paid, uint64(block.timestamp) + roundLength);
        round++;
        roundEnd = uint64(block.timestamp) + roundLength;
    }

    /// One organism's round: its weight if it won, the stake cut if it lost.
    function _judge(uint32 id) private returns (uint256 w, uint256 cut, bool lost) {
        Organism storage o = _orgs[id];
        (uint32 n,, uint64 sum) = foresight.tracks(o.modelId);
        uint256 dn = n - o.lastN;
        uint256 dsum = sum - o.lastSum;
        (o.lastN, o.lastSum) = (n, sum);
        if (dn < minForecasts) { o.lastBrier = 0; o.idle++; return (0, 0, false); }
        o.idle = 0;
        uint256 mean = dsum / dn;
        o.lastBrier = uint64(mean);
        if (mean < COIN_FLIP) {
            o.strikes = 0;
            o.wins++;
            return ((COIN_FLIP - mean) * dn, 0, false);
        }
        if (mean > COIN_FLIP) {
            cut = (uint256(o.stake) * slashBps) / BPS;
            o.stake -= uint128(cut);
            totalStake -= cut;
            o.strikes++;
            emit Slashed(id, round, mean, dn, cut, o.strikes);
            return (0, cut, true);
        }
    }

    /// Retires organisms with too many strikes, too little stake, or that asked to leave.
    function _retire() private {
        for (uint256 i = aliveIds.length; i > 0; i--) {
            uint32 id = aliveIds[i - 1];
            Organism storage o = _orgs[id];
            if (o.strikes >= maxStrikes || o.stake < minStake || o.leaving || o.idle >= MAX_IDLE) {
                o.alive = false;
                uint256 back = o.stake;
                o.stake = 0;
                totalStake -= back;
                owed[o.author] += back;
                aliveIds[i - 1] = aliveIds[aliveIds.length - 1];
                aliveIds.pop();
                emit Retired(id, round, back);
            }
        }
    }

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert SendFailed();
    }
}
