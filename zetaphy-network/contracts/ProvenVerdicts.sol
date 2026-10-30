// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The model-bound Groth16 verifier (contracts/NeuroScoreVerifier.sol, generated from the zk ceremony; not edited here).
interface IModelProofVerifier {
    function MODEL_HASH() external view returns (bytes32);
    function verifyModelProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256 commitment, uint256 margin)
        external view returns (bool);
}

/// What ProvenVerdicts reads from NeuroScore (contracts/NeuroScore.sol): the pinned model and its evaluator.
interface IPinnedScorer {
    struct Model {
        bytes32 hash;
        bytes32 modelId;
        uint16 nFeatures;
        int64 low;
        int64 medium;
        int64 high;
        uint64 activatedAt;
    }
    function model(uint32 v) external view returns (Model memory);
    function modelBytes(bytes32 hash) external view returns (bytes memory);
    function evaluateAt(uint32 v, bytes calldata features) external view returns (int256 score, uint8 level);
}

/// What ProvenVerdicts reads from NeuroJobs (contracts/NeuroJobs.sol): a settled k-of-n verdict on a feature job.
interface IFeatureJobs {
    function getJob(uint256 id) external view returns (address requester, uint64 created, uint8 status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat);
    function assurance(uint256 id) external view returns (uint8 agreedBy, uint8 state, uint64 challengeUntil, bool settled);
}

/// @title ProvenVerdicts: Neuro risk verdicts that come with a zero-knowledge proof of the model run
/// @notice docs/future/proven-verdicts.md. A bonded runner posts, for a token:
///           - the token's feature vector (`features`, 133 x u32, the profile "zfeat/1": every value is a pure
///             function of the token's runtime bytecode, zetaphy-network/src/zkverdict/features.js), and
///           - a Groth16 proof (the existing circuit, zetaphy-neuro/ml/onchain/zk/) that a committed vector yields
///             margin Z under the pinned model H. The verifier supplies H itself (verifyModelProof).
///         The score is computed HERE from the proven margin (score = trunc(calibA * Z / scale) + calibB, the
///         pinned model's calibration), so a runner cannot state another score than the one proven.
///
///         What binds the proof to the posted features and the features to the token (all permissionless):
///           1. the token's code hash (EXTCODEHASH) is recorded when the verdict lands;
///           2. challengeScore(id, features): anyone re-runs the pinned model on the posted features on-chain
///              (NeuroScore.evaluateAt). A different score means the proof was made for other features than the
///              posted ones (or, for an unproven claim, that the claim is wrong): the runner is slashed, the verdict
///              overturned. No trust in anything but the model bytes;
///           3. contest(id) + resolveContest(id, jobId): the posted features are not the token's. Anyone recomputes
///              zfeat/1 from the code with that hash; the dispute is settled by a NeuroJobs k-of-n job on chain
///              "zetaphy" with target featureTarget(id) ("zfeat/1:<token>:<codehash>"), whose verdict is
///              keccak256(the packed features). A settled result different from the posted hash slashes the runner.
///         Proof mode (governance): Optional = unproven claims are accepted with a lower weight; Required = they
///         are refused and old ones read as unknown. A verifier for another model is refused at construction:
///         a new model is a new circuit, a new ceremony, a new verifier and a new ProvenVerdicts.
///         Testnet: until the public phase-2 ceremony is final, the verifier comes from a one-machine rehearsal,
///         whose operator could forge proofs. Score = a statistical estimate, never a finding about a project.
contract ProvenVerdicts {
    enum ProofMode { Optional, Required }
    enum Status { None, Live, Contested, Overturned }

    struct Verdict {
        address token;
        uint64 time;
        uint8 level;      // 0 none, 1 low, 2 medium, 3 high (the pinned model's thresholds)
        bool proven;
        Status status;
        address runner;
        int64 score;      // calibrated logit x 1e7 (p = sigmoid(score / 1e7)), as NeuroScore
        bytes32 featuresHash; // keccak256 of the posted features (packed u32 big-endian)
        bytes32 codeHash;     // EXTCODEHASH of the token when the verdict landed
        bytes32 proofHash;    // keccak256(abi.encode(a, b, c, commitment, margin)); 0 for a claim
    }

    struct Contest {
        address challenger;
        uint64 openedAt;
        uint128 bond;
    }

    struct Runner {
        uint128 bond;
        uint64 unbondAt;  // 0 while active
        uint64 heldUntil; // the bond stays until every verdict it posted is out of its challenge window
        uint32 contested; // open contests on its verdicts (the bond stays while > 0)
        bool active;
    }

    /// One proven verdict (submit / submitBatch).
    struct Proof {
        address token;
        bytes32 modelId;  // must be the pinned model's id
        bytes features;
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 commitment;
        uint256 margin;   // Z + 2^40 (the circuit's public output)
    }

    uint16 public constant PROVEN_WEIGHT = 3;
    uint16 public constant CLAIM_WEIGHT = 1;
    /// Share of a runner's bond lost when a verdict of theirs is overturned; half to the challenger, half burned.
    uint16 public constant SLASH_BPS = 5000;
    /// Share of the contest bond the challenger gets back when its contest times out without a settled job.
    uint16 public constant EXPIRE_REFUND_BPS = 8000;
    uint256 public constant MARGIN_OFFSET = 1 << 40;
    bytes32 public constant FEATURE_CHAIN = "zetaphy";
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address public immutable governance;
    IModelProofVerifier public immutable verifier;
    IPinnedScorer public immutable scorer;
    IFeatureJobs public immutable jobs;
    uint32 public immutable scorerVersion;
    bytes32 public immutable modelHash;
    bytes32 public immutable modelId;
    uint16 public immutable nFeatures;
    int256 public immutable scale;
    int256 public immutable calibA;
    int256 public immutable calibB;
    int64 public immutable levelLow;
    int64 public immutable levelMedium;
    int64 public immutable levelHigh;
    uint256 public immutable runnerBond;
    uint256 public immutable contestBond;
    uint64 public immutable challengeWindow;
    uint64 public immutable contestTimeout;
    uint64 public immutable unbondDelay;

    ProofMode public proofMode;
    Verdict[] private _verdicts;
    mapping(uint256 => Contest) public contests;
    mapping(address => uint256) public latestOf; // token -> newest verdict id + 1 (0 = none)
    mapping(bytes32 => bool) public proofUsed;   // keccak256(token, proofHash)
    mapping(address => Runner) public runners;
    mapping(address => uint256) public credit;

    event ProofModeSet(ProofMode mode);
    event Registered(address indexed runner, uint256 bond);
    event UnbondRequested(address indexed runner, uint64 at);
    event Proven(uint256 indexed id, address indexed token, address indexed runner, int64 score, uint8 level, bytes32 featuresHash, bytes32 codeHash);
    /// The proof and the features of verdict `id` (what a browser re-verifies: zetaphy-hub/zkverdict-core.js).
    event ProofData(uint256 indexed id, address indexed token, uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 commitment, uint256 margin, bytes features);
    event Claimed(uint256 indexed id, address indexed token, address indexed runner, int64 score, uint8 level, bytes32 featuresHash,
        bytes32 codeHash, bytes features);
    event Overturned(uint256 indexed id, address indexed by, uint8 why, int256 trueScore, bytes32 trueFeaturesHash); // why: 1 score, 2 features
    event Slashed(address indexed runner, uint256 amount, address indexed challenger);
    event Contested(uint256 indexed id, address indexed challenger, uint256 bond);
    event ContestUpheld(uint256 indexed id, uint256 jobId);
    event ContestExpired(uint256 indexed id);

    error NotGovernance();
    error ModelMismatch();
    error BadValue();
    error NotRunner();
    error WrongModel(bytes32 modelId);
    error BadFeatures();
    error NoCode(address token);
    error InvalidProof(uint256 index);
    error ProofUsed(uint256 index);
    error ProofRequired();
    error Unknown();
    error NotWrong();
    error Closed();
    error Busy();
    error NotSettled(uint256 jobId);
    error WrongJob(uint256 jobId);
    error TooEarly();
    error Nothing();

    /// @param scorer_ NeuroScore; its model `version_` must be the one `verifier_` was generated for (same hash H).
    constructor(address governance_, IModelProofVerifier verifier_, IPinnedScorer scorer_, uint32 version_, IFeatureJobs jobs_,
        uint256 runnerBond_, uint256 contestBond_, uint64 challengeWindow_, uint64 contestTimeout_, uint64 unbondDelay_) {
        if (governance_ == address(0) || runnerBond_ == 0 || contestBond_ == 0 || challengeWindow_ == 0 || contestTimeout_ == 0
            || unbondDelay_ < challengeWindow_) revert BadValue();
        IPinnedScorer.Model memory m = scorer_.model(version_);
        if (m.hash == bytes32(0) || verifier_.MODEL_HASH() != m.hash) revert ModelMismatch();
        bytes memory b = scorer_.modelBytes(m.hash);
        if (b.length < 24 || keccak256(b) != m.hash) revert ModelMismatch();
        governance = governance_;
        verifier = verifier_;
        scorer = scorer_;
        jobs = jobs_;
        scorerVersion = version_;
        modelHash = m.hash;
        modelId = m.modelId;
        nFeatures = m.nFeatures;
        levelLow = m.low;
        levelMedium = m.medium;
        levelHigh = m.high;
        // NSM1 header: scale u32 at 8, calibA i32 at 16, calibB i32 at 20 (zetaphy-neuro/ml/onchain/fixed.js)
        scale = int256(uint256(_be(b, 8, 4)));
        calibA = int256(int32(uint32(_be(b, 16, 4))));
        calibB = int256(int32(uint32(_be(b, 20, 4))));
        if (scale <= 0) revert ModelMismatch();
        runnerBond = runnerBond_;
        contestBond = contestBond_;
        challengeWindow = challengeWindow_;
        contestTimeout = contestTimeout_;
        unbondDelay = unbondDelay_;
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ---- governance ----

    function setProofMode(ProofMode mode) external onlyGov {
        proofMode = mode;
        emit ProofModeSet(mode);
    }

    // ---- runners ----

    function register() external payable {
        Runner storage r = runners[msg.sender];
        uint256 b = uint256(r.bond) + msg.value;
        if (b < runnerBond) revert BadValue();
        r.bond = uint128(b);
        r.active = true;
        r.unbondAt = 0;
        emit Registered(msg.sender, b);
    }

    function requestUnbond() external {
        Runner storage r = runners[msg.sender];
        if (!r.active) revert NotRunner();
        r.active = false;
        r.unbondAt = uint64(block.timestamp) + unbondDelay;
        emit UnbondRequested(msg.sender, r.unbondAt);
    }

    function withdrawBond() external {
        Runner storage r = runners[msg.sender];
        if (r.active || r.unbondAt == 0 || block.timestamp < r.unbondAt || block.timestamp < r.heldUntil || r.contested != 0) revert TooEarly();
        uint256 b = r.bond;
        if (b == 0) revert Nothing();
        r.bond = 0;
        _pay(msg.sender, b);
    }

    function withdraw() external {
        uint256 c = credit[msg.sender];
        if (c == 0) revert Nothing();
        credit[msg.sender] = 0;
        _pay(msg.sender, c);
    }

    // ---- verdicts ----

    /// A proven verdict: the proof is checked by the model-bound verifier, the score is computed from its margin.
    function submit(Proof calldata p) external returns (uint256 id) {
        _runner();
        return _submit(p, 0);
    }

    /// Several proven verdicts in one transaction (one runner). Reverts as a whole if any proof is invalid.
    function submitBatch(Proof[] calldata ps) external returns (uint256 first) {
        _runner();
        if (ps.length == 0) revert BadValue();
        first = _verdicts.length;
        for (uint256 i = 0; i < ps.length; ++i) _submit(ps[i], i);
    }

    /// An unproven verdict (Optional mode only), weighted lower; challengeScore slashes a wrong one.
    function claim(address token, bytes calldata features, int64 score) external returns (uint256 id) {
        _runner();
        if (proofMode == ProofMode.Required) revert ProofRequired();
        if (features.length != uint256(nFeatures) * 4) revert BadFeatures();
        bytes32 codeHash = _codeHash(token);
        bytes32 fh = keccak256(features);
        uint8 level = _level(score);
        id = _push(Verdict(token, uint64(block.timestamp), level, false, Status.Live, msg.sender, score, fh, codeHash, bytes32(0)));
        uint256 cur = latestOf[token];
        // a claim never hides a live proven verdict for the same code
        if (cur == 0 || !_verdicts[cur - 1].proven || _verdicts[cur - 1].status != Status.Live || _verdicts[cur - 1].codeHash != codeHash) {
            latestOf[token] = id + 1;
        }
        emit Claimed(id, token, msg.sender, score, level, fh, codeHash, features);
    }

    function _submit(Proof calldata p, uint256 index) private returns (uint256 id) {
        if (p.modelId != modelId) revert WrongModel(p.modelId);
        if (p.features.length != uint256(nFeatures) * 4) revert BadFeatures();
        if (p.margin >= 2 * MARGIN_OFFSET) revert InvalidProof(index);
        if (!verifier.verifyModelProof(p.a, p.b, p.c, p.commitment, p.margin)) revert InvalidProof(index);
        bytes32 ph = keccak256(abi.encode(p.a, p.b, p.c, p.commitment, p.margin));
        bytes32 key = keccak256(abi.encode(p.token, ph));
        if (proofUsed[key]) revert ProofUsed(index);
        proofUsed[key] = true;
        bytes32 codeHash = _codeHash(p.token);
        int64 score = scoreOfMargin(p.margin);
        uint8 level = _level(score);
        bytes32 fh = keccak256(p.features);
        id = _push(Verdict(p.token, uint64(block.timestamp), level, true, Status.Live, msg.sender, score, fh, codeHash, ph));
        latestOf[p.token] = id + 1;
        emit Proven(id, p.token, msg.sender, score, level, fh, codeHash);
        _emitProof(id, p);
    }

    function _emitProof(uint256 id, Proof calldata p) private {
        emit ProofData(id, p.token, p.a, p.b, p.c, p.commitment, p.margin, p.features);
    }

    // ---- challenges ----

    /// Anyone: re-runs the pinned model on the posted features (their preimage). A different score overturns the
    /// verdict and slashes its runner. For a proven verdict this means the proof was for other features.
    function challengeScore(uint256 id, bytes calldata features) external {
        Verdict storage v = _get(id);
        if (v.status == Status.Overturned) revert Closed();
        if (keccak256(features) != v.featuresHash) revert BadFeatures();
        (int256 s,) = scorer.evaluateAt(scorerVersion, features);
        if (s == int256(v.score)) revert NotWrong();
        _overturn(id, v, msg.sender, 1, s, v.featuresHash);
    }

    /// Anyone, inside the challenge window, with `contestBond`: "the posted features are not the token's".
    /// Settled by resolveContest with a NeuroJobs feature job, or expires after contestTimeout.
    function contest(uint256 id) external payable {
        Verdict storage v = _get(id);
        if (v.status != Status.Live) revert Closed();
        if (block.timestamp >= uint256(v.time) + challengeWindow) revert Closed();
        if (msg.value != contestBond) revert BadValue();
        v.status = Status.Contested;
        contests[id] = Contest(msg.sender, uint64(block.timestamp), uint128(msg.value));
        runners[v.runner].contested += 1;
        emit Contested(id, msg.sender, msg.value);
    }

    /// Anyone: settles a contest with a settled NeuroJobs job on chain "zetaphy" whose target is featureTarget(id).
    /// Its verdict (keccak256 of the zfeat/1 features k-of-n runners computed) decides.
    function resolveContest(uint256 id, uint256 jobId) external {
        Verdict storage v = _get(id);
        if (v.status != Status.Contested) revert Closed();
        if (address(jobs) == address(0)) revert NotSettled(jobId);
        (, , , bool settled) = jobs.assurance(jobId);
        if (!settled) revert NotSettled(jobId);
        (, , uint8 status, bytes32 chain, string memory target, , bytes32 result, , , ) = jobs.getJob(jobId);
        if (status != 2 || chain != FEATURE_CHAIN || keccak256(bytes(target)) != keccak256(bytes(featureTarget(id)))) revert WrongJob(jobId);
        Contest memory c = contests[id];
        delete contests[id];
        runners[v.runner].contested -= 1;
        if (result == v.featuresHash) {
            v.status = Status.Live;
            credit[v.runner] += c.bond; // the contest was wrong: its bond goes to the runner
            emit ContestUpheld(id, jobId);
        } else {
            credit[c.challenger] += c.bond;
            v.status = Status.Live; // the contest is closed above; _overturn only slashes
            _overturn(id, v, c.challenger, 2, 0, result);
        }
    }

    /// Anyone, after contestTimeout without a settled job: the verdict stands, the challenger gets most of its bond back.
    function expireContest(uint256 id) external {
        Verdict storage v = _get(id);
        if (v.status != Status.Contested) revert Closed();
        Contest memory c = contests[id];
        if (block.timestamp < uint256(c.openedAt) + contestTimeout) revert TooEarly();
        delete contests[id];
        runners[v.runner].contested -= 1;
        v.status = Status.Live;
        uint256 back = (uint256(c.bond) * EXPIRE_REFUND_BPS) / 10_000;
        credit[c.challenger] += back;
        credit[v.runner] += c.bond - back;
        emit ContestExpired(id);
    }

    function _overturn(uint256 id, Verdict storage v, address by, uint8 why, int256 trueScore, bytes32 trueFh) private {
        if (v.status == Status.Contested) {
            // a score challenge during a contest: the contest ends, its bond goes back
            Contest memory c = contests[id];
            delete contests[id];
            runners[v.runner].contested -= 1;
            credit[c.challenger] += c.bond;
        }
        v.status = Status.Overturned;
        Runner storage r = runners[v.runner];
        uint256 cut = (uint256(r.bond) * SLASH_BPS) / 10_000;
        r.bond -= uint128(cut);
        if (r.bond < runnerBond) r.active = false;
        uint256 toChallenger = cut / 2;
        credit[by] += toChallenger;
        emit Overturned(id, by, why, trueScore, trueFh);
        emit Slashed(v.runner, cut, by);
        if (cut - toChallenger > 0) _pay(BURN, cut - toChallenger);
    }

    // ---- views ----

    /// The token's newest verdict: known (live or contested, and not an unproven claim in Required mode), score,
    /// level, proven, weight (PROVEN_WEIGHT / CLAIM_WEIGHT / 0), settled (out of its challenge window, no contest),
    /// and its id.
    function verdictOf(address token) external view returns (bool known, int64 score, uint8 level, bool proven, uint16 weight, bool settled, uint256 id) {
        uint256 k = latestOf[token];
        if (k == 0) return (false, 0, 0, false, 0, false, 0);
        id = k - 1;
        Verdict storage v = _verdicts[id];
        if (v.status == Status.Overturned) return (false, 0, 0, v.proven, 0, true, id);
        if (!v.proven && proofMode == ProofMode.Required) return (false, v.score, v.level, false, 0, false, id);
        known = true;
        score = v.score;
        level = v.level;
        proven = v.proven;
        weight = v.proven ? PROVEN_WEIGHT : CLAIM_WEIGHT;
        settled = v.status == Status.Live && block.timestamp >= uint256(v.time) + challengeWindow;
    }

    function verdict(uint256 id) external view returns (Verdict memory) {
        return _get(id);
    }

    function count() external view returns (uint256) {
        return _verdicts.length;
    }

    /// Score from a proven margin (Z + 2^40) with the pinned model's calibration (as NeuroScore._eval).
    function scoreOfMargin(uint256 margin) public view returns (int64) {
        int256 z = int256(margin) - int256(MARGIN_OFFSET);
        int256 s = (calibA * z) / scale + calibB;
        if (s > type(int64).max || s < type(int64).min) revert BadValue();
        return int64(s);
    }

    /// The NeuroJobs target that settles a contest of verdict `id`: "zfeat/1:<token>:<code hash>", lower-case hex.
    function featureTarget(uint256 id) public view returns (string memory) {
        Verdict storage v = _get(id);
        return string.concat("zfeat/1:", _hex(abi.encodePacked(v.token)), ":", _hex(abi.encodePacked(v.codeHash)));
    }

    // ---- internals ----

    function _runner() private {
        Runner storage r = runners[msg.sender];
        if (!r.active) revert NotRunner();
        uint64 until = uint64(block.timestamp) + challengeWindow;
        if (until > r.heldUntil) r.heldUntil = until;
    }

    function _push(Verdict memory v) private returns (uint256 id) {
        _verdicts.push(v);
        return _verdicts.length - 1;
    }

    function _get(uint256 id) private view returns (Verdict storage) {
        if (id >= _verdicts.length) revert Unknown();
        return _verdicts[id];
    }

    function _codeHash(address token) private view returns (bytes32 h) {
        if (token.code.length == 0) revert NoCode(token);
        h = token.codehash;
    }

    function _level(int256 s) private view returns (uint8) {
        if (s >= levelHigh) return 3;
        if (s >= levelMedium) return 2;
        if (s >= levelLow) return 1;
        return 0;
    }

    function _be(bytes memory b, uint256 off, uint256 len) private pure returns (uint256 x) {
        for (uint256 i = 0; i < len; ++i) x = (x << 8) | uint8(b[off + i]);
    }

    function _hex(bytes memory b) private pure returns (string memory) {
        bytes16 h = "0123456789abcdef";
        bytes memory out = new bytes(2 + 2 * b.length);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < b.length; ++i) {
            out[2 + 2 * i] = h[uint8(b[i]) >> 4];
            out[3 + 2 * i] = h[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay failed");
    }
}
