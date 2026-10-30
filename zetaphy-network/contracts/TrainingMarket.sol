// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITMIssuance {
    function draw(uint256 amount) external returns (uint256 paid);
}

interface ITMReputation {
    function record(address worker, uint8 kind, bytes32 ref) external;
}

interface ITMEpochs {
    function current() external view returns (bool found, uint256 index, bytes32 hash, uint64 activation, string memory uri);
}

interface ITMPool {
    function eligible(address w) external view returns (bool);
    function size() external view returns (uint256);
    function members(uint256 i) external view returns (address);
    function exitDelay() external view returns (uint32);
    function lock(address w, bool on) external;
    function slash(address w, uint256 amount) external returns (uint256 got);
}

interface ITMMinDelay {
    function getMinDelay() external view returns (uint256);
}

/// @title TrainingMarket: proof of useful work for AI training (testnet)
/// @notice The network's compute trains Neuro (the scam-detection model) and is paid only for work it can
///         check (docs/future/useful-work-training.md). One TASK is one training round:
///           1. A poster escrows a budget for a spec (keccak of the spec file: data shards, base model, seed,
///              hyper-parameters) and commits to a secret held-out seed.
///           2. Pool members (staked) take seats; seat j trains shard j DETERMINISTICALLY (bit-reproducible
///              JS, zetaphy-hub/train-core.js) and commits keccak(root, treesHash, worker, salt, task): root
///              is the hash of its per-segment checkpoint digests. Then it reveals root, treesHash and where
///              its trees are published.
///           3. Randomness from a FUTURE block (requestDraw, then draw) picks `checksPerJob` segments of every
///              job and `verifiersPerCheck` verifiers for each (never the job's trainer), and the evaluators
///              (never a trainer with a revealed job).
///           4. Spot-checks: verifiers re-run their segment and commit their own digest, sealed; then the
///              trainer opens its digests (checked against root) and verifiers reveal. The majority decides:
///              a mismatch FAILS the job and slashes `trainSlash` from the trainer (a share goes to the
///              verifiers who caught it); verifiers in the minority or silent lose `missSlash`.
///           5. The poster reveals its secret; held-out seed = keccak(secret, randomness), known to nobody
///              before the draw. Evaluators compute AUC and recall at 1% FPR of the base model and of the
///              candidate (base + the passed jobs' trees) on the held-out rows that seed picks, sealed then
///              revealed. The majority's numbers decide: ACCEPTED only if AUC rises by >= minGainAuc and
///              recall does not fall.
///           6. Payouts (pull): verifiers and evaluators in the majority are paid whatever the outcome (so they
///              have no reason to favour acceptance); trainers of passed jobs are paid ONLY if accepted (plus
///              a subsidy from UsefulIssuance on a feeder's task). The rest returns to the poster.
///         The accepted candidate id (keccak(baseModel ‖ treesHash of each passed job)) is recorded; the new
///         model version is then scheduled by governance through ModelEpochs (a timelock vote), and a task
///         must start from the version in force (`epochs`). No admin key: governance must be a timelock with
///         at least MIN_DELAY; the contract starts paused until governance opens it.
contract TrainingMarket {
    uint256 public constant MIN_DELAY = 2 days;
    uint256 public constant MAX_JOBS = 8;
    uint256 public constant MAX_SEGMENTS = 64;
    bytes32 public constant UNAVAILABLE = keccak256("zetaphy-train/1 unavailable");

    // WorkerReputation.Kind
    uint8 internal constant AGREED = 0;
    uint8 internal constant DISAGREED = 1;
    uint8 internal constant MISSED = 2;
    uint8 internal constant SLASHED = 3;

    // job status
    uint8 public constant JOB_PENDING = 0;
    uint8 public constant JOB_PASSED = 1;
    uint8 public constant JOB_FAILED = 2;
    uint8 public constant JOB_INCONCLUSIVE = 3;
    uint8 public constant JOB_MISSED = 4;
    /// The job number of the evaluation check (the last check of a drawn task).
    uint8 public constant EVAL_JOB = 255;

    // task stage
    uint8 public constant OPEN = 0;
    uint8 public constant VERIFY = 1;
    uint8 public constant EVAL = 2;
    uint8 public constant DONE = 3;

    struct Params {
        uint128 trainSlash;        // a trainer whose checkpoint fails a spot-check
        uint128 missSlash;         // a missed reveal, a verifier / evaluator in the minority
        uint128 maxSubsidy;        // most a feeder's task may draw from UsefulIssuance
        uint32 seatWindow;         // seats are taken during this
        uint32 commitWindow;       // then the trained results are committed
        uint32 revealWindow;       // then revealed
        uint32 verifyCommitWindow; // after the draw: verifiers commit
        uint32 verifyRevealWindow; // then trainers open their digests and verifiers reveal
        uint32 evalCommitWindow;   // after judging: evaluators commit
        uint32 evalRevealWindow;   // then reveal
        uint8 checksPerJob;        // segments re-run per job (1..4)
        uint8 verifiersPerCheck;   // verifiers per segment (1..5)
        uint8 evaluators;          // evaluators per task (1..7)
        uint16 trainBps;           // budget shares (sum <= 10,000)
        uint16 checkBps;
        uint16 evalBps;
        uint16 catchBps;           // share of a trainer's slash paid to the verifiers who caught it
        uint16 minGainAuc;         // in 1/10,000 AUC
    }

    struct Task {
        address poster;
        uint8 stage;
        uint8 jobCount;
        uint8 taken;
        uint8 passed;
        uint16 segments;
        bool heldoutRevealed;
        bool accepted;
        uint64 postedAt;
        uint64 drawBlock;
        uint64 verifyAt;
        uint64 evalAt;
        uint128 budget;
        uint128 spent;
        uint128 subsidy;
        uint32 baseAuc;
        uint32 candAuc;
        uint32 baseRecall;
        uint32 candRecall;
        bytes32 specHash;
        bytes32 baseModel;
        bytes32 heldoutCommit;
        bytes32 heldoutSeed;
        bytes32 randomness;
        bytes32 candidate;
    }

    struct Job {
        address trainer;
        uint8 status;
        bool revealed;
        bool opened;
        bytes32 commitment;
        bytes32 root;
        bytes32 treesHash;
    }

    struct Check {
        uint8 job;
        uint16 segment;
        uint8 status; // 0 open, 1 pass, 2 fail, 3 inconclusive
        bytes32 majority;
    }

    address public governance;
    ITMPool public pool;
    ITMIssuance public issuance;
    ITMReputation public reputation;
    ITMEpochs public epochs;
    Params private _params;
    bool public paused;

    uint256 public reserve;     // slashes and plain transfers: pays feeder subsidies first
    uint256 public escrow;      // budgets of tasks not finished
    uint256 public totalOwed;
    mapping(address => uint256) public owed;
    mapping(address => bool) public feeders;
    /// candidate id => task id + 1 of the task that accepted it
    mapping(bytes32 => uint256) public acceptedBy;

    Task[] private _tasks;
    mapping(uint256 => Job[]) private _jobs;
    mapping(uint256 => mapping(address => uint256)) public seatOf; // job index + 1
    mapping(uint256 => mapping(uint256 => bytes32[])) private _digests;
    mapping(uint256 => Check[]) private _checks;
    mapping(uint256 => mapping(uint256 => address[])) private _verifiers;
    mapping(uint256 => mapping(uint256 => mapping(address => bytes32))) public commits;
    mapping(uint256 => mapping(uint256 => mapping(address => bytes32))) public answers;

    event Posted(uint256 indexed id, address indexed poster, bytes32 specHash, bytes32 baseModel, uint256 budget, string specURI);
    event SeatTaken(uint256 indexed id, uint256 job, address indexed trainer);
    event TrainRevealed(uint256 indexed id, uint256 job, bytes32 root, bytes32 treesHash, string uri);
    event Drawn(uint256 indexed id, bytes32 randomness, uint256 checks);
    event CheckAssigned(uint256 indexed id, uint256 indexed check, uint256 job, uint256 segment, address[] verifiers);
    event Answered(uint256 indexed id, uint256 indexed check, address indexed who, bytes32 answer);
    event HeldoutRevealed(uint256 indexed id, bytes32 seed);
    event CheckJudged(uint256 indexed id, uint256 indexed check, uint8 status, bytes32 majority, bytes32 claimed);
    event JobJudged(uint256 indexed id, uint256 job, uint8 status, uint256 slashed);
    event Judged(uint256 indexed id, uint256 passed, bytes32 candidate, bytes32 heldoutSeed);
    event Finalized(uint256 indexed id, bool accepted, bytes32 candidate, uint256 refund);
    event ModelAccepted(uint256 indexed id, bytes32 indexed candidate, bytes32 baseModel);
    event Paid(uint256 indexed id, address indexed to, uint256 amount, uint8 role); // 0 trainer, 1 verifier, 2 evaluator, 3 catch bounty
    event Slashed(uint256 indexed id, address indexed who, uint256 amount, uint8 kind);
    event Withdrawn(address indexed to, uint256 amount);
    event ParamsSet();
    event FeederSet(address indexed feeder, bool on);
    event PausedSet(bool paused);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotTimelock();
    error BadParams();
    error BadValue();
    error BadTask();
    error Paused();
    error WrongPhase();
    error NotEligible();
    error Full();
    error AlreadyIn();
    error NotSeated();
    error BadReveal();
    error StaleBase();
    error NotFeeder();
    error Nothing();

    constructor(address governance_, ITMPool pool_, ITMIssuance issuance_, ITMReputation reputation_, ITMEpochs epochs_, Params memory p) {
        _checkTimelock(governance_);
        governance = governance_;
        pool = pool_;
        issuance = issuance_;
        reputation = reputation_;
        epochs = epochs_;
        _setParams(p);
        paused = true; // closed until governance opens it
        emit PausedSet(true);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier notPaused() {
        if (paused) revert Paused();
        _;
    }

    /// Money in from UsefulIssuance.draw() or anyone: into the reserve.
    receive() external payable {
        reserve += msg.value;
    }

    // ---------------------------------------------------------------- posting

    /// Anyone: a training round of `jobs` shards, `segments` checkpoints each, paid from msg.value. A feeder
    /// (named by governance) may add a `subsidy` the trainers of an accepted round share (from UsefulIssuance).
    function post(bytes32 specHash, string calldata specURI, bytes32 baseModel, uint8 jobs, uint16 segments, bytes32 heldoutCommit, uint128 subsidy)
        external payable notPaused returns (uint256 id)
    {
        if (subsidy > 0 && (!feeders[msg.sender] || subsidy > _params.maxSubsidy)) revert NotFeeder();
        if (msg.value == 0 || msg.value > type(uint128).max) revert BadValue();
        if (specHash == 0 || baseModel == 0 || heldoutCommit == 0 || bytes(specURI).length == 0 || bytes(specURI).length > 256) revert BadTask();
        if (jobs == 0 || jobs > MAX_JOBS || segments < _params.checksPerJob || segments > MAX_SEGMENTS) revert BadTask();
        _checkBase(baseModel);
        id = _tasks.length;
        Task storage t = _tasks.push();
        t.poster = msg.sender;
        t.jobCount = jobs;
        t.segments = segments;
        t.postedAt = uint64(block.timestamp);
        t.budget = uint128(msg.value);
        t.subsidy = subsidy;
        t.specHash = specHash;
        t.baseModel = baseModel;
        t.heldoutCommit = heldoutCommit;
        escrow += msg.value;
        emit Posted(id, msg.sender, specHash, baseModel, msg.value, specURI);
    }

    /// Rounds improve the model in force (ModelEpochs), when there is one.
    function _checkBase(bytes32 baseModel) internal view {
        if (address(epochs) == address(0)) return;
        (bool found,, bytes32 cur,,) = epochs.current();
        if (found && cur != baseModel) revert StaleBase();
    }

    // ---------------------------------------------------------------- training: seats, commit, reveal

    function takeSeat(uint256 id) external notPaused returns (uint256 job) {
        Task storage t = _task(id);
        if (t.stage != OPEN || block.timestamp >= _seatEnd(t)) revert WrongPhase();
        if (t.taken >= t.jobCount) revert Full();
        if (!pool.eligible(msg.sender)) revert NotEligible();
        if (seatOf[id][msg.sender] != 0) revert AlreadyIn();
        job = t.taken++;
        Job storage j = _jobs[id].push();
        j.trainer = msg.sender;
        seatOf[id][msg.sender] = job + 1;
        pool.lock(msg.sender, true);
        emit SeatTaken(id, job, msg.sender);
    }

    function _trainCommitment(bytes32 root, bytes32 treesHash, address worker, bytes32 salt, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(root, treesHash, worker, salt, id));
    }

    function commitTraining(uint256 id, bytes32 commitment) external {
        Task storage t = _task(id);
        if (t.stage != OPEN || block.timestamp >= _commitEnd(t)) revert WrongPhase();
        Job storage j = _seat(id);
        if (j.commitment != 0) revert AlreadyIn();
        if (commitment == 0) revert BadValue();
        j.commitment = commitment;
    }

    function revealTraining(uint256 id, bytes32 root, bytes32 treesHash, string calldata uri, bytes32 salt) external {
        Task storage t = _task(id);
        if (t.stage != OPEN || block.timestamp < _commitEnd(t) || block.timestamp >= _revealEnd(t)) revert WrongPhase();
        Job storage j = _seat(id);
        if (j.revealed) revert AlreadyIn();
        if (j.commitment == 0 || root == 0 || treesHash == 0 || bytes(uri).length > 256) revert BadReveal();
        if (_trainCommitment(root, treesHash, msg.sender, salt, id) != j.commitment) revert BadReveal();
        j.revealed = true;
        j.root = root;
        j.treesHash = treesHash;
        emit TrainRevealed(id, seatOf[id][msg.sender] - 1, root, treesHash, uri);
    }

    // ---------------------------------------------------------------- the draw (future block hash)

    /// Anyone, once the reveals closed: fixes the block whose hash decides the checks.
    function requestDraw(uint256 id) external {
        Task storage t = _task(id);
        if (t.stage != OPEN || block.timestamp < _revealEnd(t)) revert WrongPhase();
        if (t.drawBlock != 0 && block.number <= uint256(t.drawBlock) + 256) revert AlreadyIn();
        t.drawBlock = uint64(block.number + 1);
    }

    /// Anyone, once that block exists (within 256 blocks; else requestDraw again).
    function draw(uint256 id) external {
        Task storage t = _task(id);
        if (t.stage != OPEN || t.drawBlock == 0 || block.number <= t.drawBlock) revert WrongPhase();
        bytes32 bh = blockhash(t.drawBlock);
        if (bh == 0) revert WrongPhase();
        bytes32 rnd = keccak256(abi.encode(bh, id, address(this)));
        t.randomness = rnd;
        Job[] storage js = _jobs[id];
        uint256 revealed;
        for (uint256 j = 0; j < js.length; j++) {
            if (!js[j].revealed) {
                js[j].status = JOB_MISSED;
                pool.lock(js[j].trainer, false);
                _slash(id, js[j].trainer, _params.missSlash, MISSED);
                emit JobJudged(id, j, JOB_MISSED, _params.missSlash);
                continue;
            }
            revealed++;
            uint256 n = _params.checksPerJob;
            for (uint256 c = 0; c < n; c++) _assignCheck(id, t, rnd, j, c);
        }
        t.verifyAt = uint64(block.timestamp);
        emit Drawn(id, rnd, _checks[id].length);
        if (revealed == 0) {
            _finish(id, t);
            return;
        }
        // the evaluation is the last check (job EVAL_JOB); its evaluators are never a trainer whose result is in
        // this round
        uint256 e = _checks[id].length;
        _checks[id].push(Check(EVAL_JOB, 0, 0, 0));
        address[] storage ev = _verifiers[id][e];
        for (uint256 v = 0; v < _params.evaluators; v++) {
            address w = _pick(keccak256(abi.encode(rnd, uint256(3), e, v)), id, type(uint256).max, ev);
            if (w == address(0)) break;
            ev.push(w);
            pool.lock(w, true);
        }
        t.stage = VERIFY;
    }

    function _assignCheck(uint256 id, Task storage t, bytes32 rnd, uint256 j, uint256 c) internal {
        uint256 seg;
        for (uint256 nonce = 0; ; nonce++) {
            seg = uint256(keccak256(abi.encode(rnd, uint256(1), j, c, nonce))) % t.segments;
            bool dup;
            Check[] storage cs = _checks[id];
            for (uint256 q = cs.length; q > 0 && cs[q - 1].job == j; q--) if (cs[q - 1].segment == seg) dup = true;
            if (!dup) break;
        }
        uint256 ch = _checks[id].length;
        _checks[id].push(Check(uint8(j), uint16(seg), 0, 0));
        address[] storage vs = _verifiers[id][ch];
        for (uint256 v = 0; v < _params.verifiersPerCheck; v++) {
            address w = _pick(keccak256(abi.encode(rnd, uint256(2), ch, v)), id, j, vs);
            if (w == address(0)) break;
            vs.push(w);
            pool.lock(w, true);
        }
        emit CheckAssigned(id, ch, j, seg, vs);
    }

    /// A random eligible member not in `chosen`, not the trainer of `exceptJob` (or, for evaluators —
    /// exceptJob = max — not any trainer with a revealed job). address(0) when nobody fits.
    /// key = keccak(abi.encode(randomness, tag, a, b)); try k: pool[keccak(abi.encode(key, k)) % pool size].
    function _pick(bytes32 key, uint256 id, uint256 exceptJob, address[] storage chosen) internal view returns (address) {
        uint256 n = pool.size();
        for (uint256 nonce = 0; n > 0 && nonce < 8 * n + 8; nonce++) {
            address w = pool.members(uint256(keccak256(abi.encode(key, nonce))) % n);
            if (_fits(w, id, exceptJob) && !_assigned(chosen, w)) return w;
        }
        return address(0);
    }

    function _fits(address w, uint256 id, uint256 exceptJob) internal view returns (bool) {
        if (!pool.eligible(w)) return false;
        uint256 seat = seatOf[id][w];
        if (seat == 0) return true;
        return exceptJob == type(uint256).max ? !_jobs[id][seat - 1].revealed : seat - 1 != exceptJob;
    }

    // ---------------------------------------------------------------- spot-checks

    /// A sealed answer: a verifier's segment digest, or an evaluator's keccak(abi.encode(baseAuc, candAuc,
    /// baseRecall, candRecall)) (uint32 each, in 1/10,000) on the evaluation check.
    function _answerCommitment(bytes32 answer, address who, bytes32 salt, uint256 id, uint256 check) internal pure returns (bytes32) {
        return keccak256(abi.encode(answer, who, salt, id, check));
    }

    function commitAnswer(uint256 id, uint256 check, bytes32 commitment) external {
        Task storage t = _task(id);
        bool ev = _checks[id][check].job == EVAL_JOB;
        if (ev ? (t.stage != EVAL || block.timestamp >= _ecEnd(t)) : (t.stage != VERIFY || block.timestamp >= _vcEnd(t))) revert WrongPhase();
        if (!_assigned(_verifiers[id][check], msg.sender)) revert NotSeated();
        if (commits[id][check][msg.sender] != 0) revert AlreadyIn();
        if (commitment == 0) revert BadValue();
        commits[id][check][msg.sender] = commitment;
    }

    /// The trainer opens its per-segment digests once the verifiers are sealed.
    function openCheckpoints(uint256 id, bytes32[] calldata digests) external {
        Task storage t = _task(id);
        if (t.stage != VERIFY || block.timestamp < _vcEnd(t) || block.timestamp >= _vrEnd(t)) revert WrongPhase();
        Job storage j = _seat(id);
        uint256 job = seatOf[id][msg.sender] - 1;
        if (!j.revealed || j.opened) revert AlreadyIn();
        if (digests.length != t.segments || keccak256(abi.encodePacked(digests)) != j.root) revert BadReveal();
        j.opened = true;
        _digests[id][job] = digests;
    }

    function revealAnswer(uint256 id, uint256 check, bytes32 answer, bytes32 salt) external {
        Task storage t = _task(id);
        bool ev = _checks[id][check].job == EVAL_JOB;
        if (ev ? (t.stage != EVAL || block.timestamp < _ecEnd(t) || block.timestamp >= _erEnd(t))
               : (t.stage != VERIFY || block.timestamp < _vcEnd(t) || block.timestamp >= _vrEnd(t))) revert WrongPhase();
        bytes32 c = commits[id][check][msg.sender];
        if (c == 0) revert NotSeated();
        if (answers[id][check][msg.sender] != 0) revert AlreadyIn();
        if (answer == 0 || _answerCommitment(answer, msg.sender, salt, id, check) != c) revert BadReveal();
        answers[id][check][msg.sender] = answer;
        emit Answered(id, check, msg.sender, answer);
    }

    /// The poster opens its held-out secret (any time after the draw, before judging).
    function revealHeldout(uint256 id, bytes32 secret) external {
        Task storage t = _task(id);
        if (t.stage != VERIFY || t.heldoutRevealed) revert WrongPhase();
        if (msg.sender != t.poster || keccak256(abi.encode(secret, msg.sender)) != t.heldoutCommit) revert BadReveal();
        t.heldoutRevealed = true;
        t.heldoutSeed = keccak256(abi.encode(secret, t.randomness));
        emit HeldoutRevealed(id, t.heldoutSeed);
    }

    /// Anyone, after the verify window: decides every check and job, pays the verifiers, fixes the candidate.
    function judge(uint256 id) external {
        Task storage t = _task(id);
        if (t.stage != VERIFY || block.timestamp < _vrEnd(t)) revert WrongPhase();
        uint256 units;
        uint256 e = _checks[id].length - 1; // the evaluation check
        for (uint256 c = 0; c < e; c++) units += _judgeCheck(id, c);
        if (units > 0) _payChecks(id, t, ((uint256(t.budget) * _params.checkBps) / 10_000) / units);
        _judgeJobs(id, t);
        if (!t.heldoutRevealed) t.heldoutSeed = keccak256(abi.encode(bytes32(0), t.randomness));
        t.evalAt = uint64(block.timestamp);
        emit Judged(id, t.passed, t.candidate, t.heldoutSeed);
        if (t.passed == 0) {
            address[] storage ev = _verifiers[id][e];
            for (uint256 v = 0; v < ev.length; v++) pool.lock(ev[v], false);
            _finish(id, t);
        } else {
            t.stage = EVAL;
        }
    }

    /// The check pool, split among every verifier answer in a majority.
    function _payChecks(uint256 id, Task storage t, uint256 each) internal {
        Check[] storage cs = _checks[id];
        for (uint256 c = 0; c < cs.length; c++) {
            if (cs[c].status == 3 || cs[c].job == EVAL_JOB) continue;
            address[] storage vs = _verifiers[id][c];
            for (uint256 v = 0; v < vs.length; v++) if (answers[id][c][vs[v]] == cs[c].majority) _pay(id, t, vs[v], each, 1);
        }
    }

    /// A job passes when every check of it passed; one failed check fails it (and slashes its trainer).
    function _judgeJobs(uint256 id, Task storage t) internal {
        Job[] storage js = _jobs[id];
        bytes memory cand = abi.encodePacked(t.baseModel);
        uint8 passed;
        for (uint256 j = 0; j < js.length; j++) {
            if (js[j].status == JOB_MISSED) continue;
            uint8 st = _jobStatus(id, j);
            js[j].status = st;
            pool.lock(js[j].trainer, false);
            uint256 slashed;
            if (st == JOB_FAILED) slashed = _slashTrainer(id, j);
            else if (st == JOB_PASSED) {
                passed++;
                cand = abi.encodePacked(cand, js[j].treesHash);
            }
            emit JobJudged(id, j, st, slashed);
        }
        t.passed = passed;
        t.candidate = passed > 0 ? keccak256(cand) : bytes32(0);
    }

    function _jobStatus(uint256 id, uint256 j) internal view returns (uint8 st) {
        Check[] storage cs = _checks[id];
        st = JOB_PASSED;
        for (uint256 c = 0; c < cs.length; c++) {
            if (cs[c].job != j) continue;
            if (cs[c].status == 2) return JOB_FAILED;
            if (cs[c].status == 3) st = JOB_INCONCLUSIVE;
        }
    }

    /// Decides one check; returns how many verifier answers are in its majority (0 if none).
    function _judgeCheck(uint256 id, uint256 c) internal returns (uint256 agreed) {
        Check storage ck = _checks[id][c];
        address[] storage vs = _verifiers[id][c];
        bytes32 maj;
        uint256 quorum = vs.length / 2 + 1;
        for (uint256 v = 0; v < vs.length && maj == 0; v++) {
            bytes32 a = answers[id][c][vs[v]];
            if (a == 0) continue;
            uint256 n;
            for (uint256 q = 0; q < vs.length; q++) if (answers[id][c][vs[q]] == a) n++;
            if (n >= quorum) maj = a;
        }
        bytes32 claimed;
        if (ck.job != EVAL_JOB && _jobs[id][ck.job].opened) claimed = _digests[id][ck.job][ck.segment];
        ck.majority = maj;
        ck.status = maj == 0 ? 3 : (maj == claimed || ck.job == EVAL_JOB ? 1 : 2);
        for (uint256 v = 0; v < vs.length; v++) {
            address w = vs[v];
            pool.lock(w, false);
            bytes32 a = answers[id][c][w];
            if (a == 0) _slash(id, w, _params.missSlash, MISSED);
            else if (maj == 0) continue;
            else if (a == maj) {
                agreed++;
                _rep(w, AGREED, id);
            } else _slash(id, w, _params.missSlash, DISAGREED);
        }
        emit CheckJudged(id, c, ck.status, maj, claimed);
    }

    /// Slashes a trainer whose checkpoint failed; catchBps of it goes to the verifiers who caught it.
    function _slashTrainer(uint256 id, uint256 job) internal returns (uint256 slashed) {
        address tr = _jobs[id][job].trainer;
        slashed = pool.slash(tr, _params.trainSlash); // arrives through receive(): in the reserve
        emit Slashed(id, tr, slashed, SLASHED);
        _rep(tr, SLASHED, id);
        uint256 bounty = (slashed * _params.catchBps) / 10_000;
        Check[] storage cs = _checks[id];
        uint256 catchers;
        for (uint256 c = 0; c < cs.length; c++) {
            if (cs[c].job == job && cs[c].status == 2) {
                address[] storage vs = _verifiers[id][c];
                for (uint256 v = 0; v < vs.length; v++) if (answers[id][c][vs[v]] == cs[c].majority) catchers++;
            }
        }
        uint256 each = catchers > 0 ? bounty / catchers : 0;
        uint256 given;
        for (uint256 c = 0; c < cs.length && each > 0; c++) {
            if (cs[c].job == job && cs[c].status == 2) {
                address[] storage vs = _verifiers[id][c];
                for (uint256 v = 0; v < vs.length; v++) {
                    if (answers[id][c][vs[v]] == cs[c].majority) {
                        _credit(vs[v], each);
                        given += each;
                        emit Paid(id, vs[v], each, 3);
                    }
                }
            }
        }
        reserve -= given;
    }

    // ---------------------------------------------------------------- evaluation

    /// Anyone, after the evaluation window, with the numbers the evaluators' majority revealed (ignored when
    /// there is no majority): accepts or rejects the candidate and pays.
    function finalize(uint256 id, uint32[4] calldata r) external {
        Task storage t = _task(id);
        if (t.stage != EVAL || block.timestamp < _erEnd(t)) revert WrongPhase();
        uint256 e = _checks[id].length - 1;
        uint256 agreed = _judgeCheck(id, e);
        bytes32 maj = _checks[id][e].majority;
        if (maj != 0) {
            if (keccak256(abi.encode(r)) != maj) revert BadReveal();
            (t.baseAuc, t.candAuc, t.baseRecall, t.candRecall) = (r[0], r[1], r[2], r[3]);
            uint256 each = ((uint256(t.budget) * _params.evalBps) / 10_000) / agreed;
            address[] storage ev = _verifiers[id][e];
            for (uint256 v = 0; v < ev.length; v++) if (answers[id][e][ev[v]] == maj) _pay(id, t, ev[v], each, 2);
            t.accepted = uint256(r[1]) >= uint256(r[0]) + _params.minGainAuc && r[3] >= r[2];
        }
        if (t.accepted) _payTrainers(id, t);
        _finish(id, t);
    }

    function _payTrainers(uint256 id, Task storage t) internal {
        uint256 subsidy = t.subsidy > 0 ? _subsidy(t.subsidy) : 0;
        uint256 fromBudget = (uint256(t.budget) * _params.trainBps) / 10_000;
        uint256 each = fromBudget / t.passed;
        uint256 subEach = subsidy / t.passed;
        reserve += subsidy - subEach * t.passed;
        Job[] storage js = _jobs[id];
        for (uint256 j = 0; j < js.length; j++) {
            if (js[j].status != JOB_PASSED) continue;
            _pay(id, t, js[j].trainer, each, 0);
            if (subEach > 0) {
                _credit(js[j].trainer, subEach);
                emit Paid(id, js[j].trainer, subEach, 0);
            }
            _rep(js[j].trainer, AGREED, id);
        }
        acceptedBy[t.candidate] = id + 1;
        emit ModelAccepted(id, t.candidate, t.baseModel);
    }

    /// Ends a task: what the budget did not pay goes back to the poster (to the reserve if it never opened its
    /// held-out secret: withholding it to choose between two seeds costs the whole refund).
    function _finish(uint256 id, Task storage t) internal {
        t.stage = DONE;
        uint256 refund = uint256(t.budget) - t.spent;
        escrow -= t.budget;
        if (t.heldoutRevealed || t.randomness == 0 || t.passed == 0) _credit(t.poster, refund);
        else reserve += refund;
        emit Finalized(id, t.accepted, t.candidate, refund);
    }

    // ---------------------------------------------------------------- money

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        totalOwed -= a;
        _send(msg.sender, a);
        emit Withdrawn(msg.sender, a);
    }

    function _pay(uint256 id, Task storage t, address to, uint256 amount, uint8 role) internal {
        if (amount == 0) return;
        t.spent += uint128(amount);
        _credit(to, amount);
        emit Paid(id, to, amount, role);
    }

    function _credit(address to, uint256 amount) internal {
        owed[to] += amount;
        totalOwed += amount;
    }

    function _slash(uint256 id, address w, uint256 amount, uint8 kind) internal {
        uint256 got = pool.slash(w, amount); // arrives through receive(): in the reserve
        emit Slashed(id, w, got, kind);
        _rep(w, kind, id);
    }

    function _rep(address w, uint8 kind, uint256 id) internal {
        if (address(reputation) == address(0)) return;
        try reputation.record(w, kind, bytes32(id)) {} catch {}
    }

    /// Takes up to `want` from the reserve, then from UsefulIssuance.
    function _subsidy(uint256 want) internal returns (uint256 got) {
        got = want < reserve ? want : reserve;
        reserve -= got;
        if (got < want && address(issuance) != address(0)) {
            uint256 before = address(this).balance;
            try issuance.draw(want - got) returns (uint256) {} catch {}
            uint256 arrived = address(this).balance - before;
            reserve -= arrived; // receive() counted it into the reserve
            got += arrived;
        }
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert Nothing();
    }

    // ---------------------------------------------------------------- governance (a timelock)

    function setParams(Params calldata p) external onlyGovernance {
        _setParams(p);
    }

    function setFeeder(address f, bool on) external onlyGovernance {
        feeders[f] = on;
        emit FeederSet(f, on);
    }

    function setPaused(bool p) external onlyGovernance {
        paused = p;
        emit PausedSet(p);
    }

    /// The next governance must also be a timelock with at least MIN_DELAY.
    function setGovernance(address next) external onlyGovernance {
        _checkTimelock(next);
        governance = next;
        emit GovernanceSet(next);
    }

    function _setParams(Params memory p) internal {

        if (p.checksPerJob == 0 || p.checksPerJob > 4 || p.verifiersPerCheck == 0 || p.verifiersPerCheck > 5) revert BadParams();
        if (p.evaluators == 0 || p.evaluators > 7) revert BadParams();
        if (uint256(p.trainBps) + p.checkBps + p.evalBps > 10_000 || p.catchBps > 10_000) revert BadParams();
        uint256 life = uint256(p.seatWindow) + p.commitWindow + p.revealWindow + p.verifyCommitWindow + p.verifyRevealWindow + p.evalCommitWindow + p.evalRevealWindow;
        if (p.seatWindow == 0 || p.commitWindow == 0 || p.revealWindow == 0 || p.verifyCommitWindow == 0 || p.verifyRevealWindow == 0) revert BadParams();
        if (p.evalCommitWindow == 0 || p.evalRevealWindow == 0 || pool.exitDelay() < life) revert BadParams();
        _params = p;
        emit ParamsSet();
    }

    function _checkTimelock(address t) internal view {
        if (t.code.length == 0) revert NotTimelock();
        try ITMMinDelay(t).getMinDelay() returns (uint256 d) {
            if (d < MIN_DELAY) revert NotTimelock();
        } catch {
            revert NotTimelock();
        }
    }

    // ---------------------------------------------------------------- reads

    function params() external view returns (Params memory) {
        return _params;
    }

    function taskCount() external view returns (uint256) {
        return _tasks.length;
    }

    function getTask(uint256 id) external view returns (Task memory) {
        return _task(id);
    }

    function getJob(uint256 id, uint256 job) external view returns (Job memory) {
        return _jobs[id][job];
    }

    function checksOf(uint256 id) external view returns (Check[] memory) {
        return _checks[id];
    }

    function verifiersOf(uint256 id, uint256 check) external view returns (address[] memory) {
        return _verifiers[id][check];
    }

    function digestsOf(uint256 id, uint256 job) external view returns (bytes32[] memory) {
        return _digests[id][job];
    }

    // ---------------------------------------------------------------- internals

    function _task(uint256 id) internal view returns (Task storage) {
        if (id >= _tasks.length) revert BadTask();
        return _tasks[id];
    }

    function _seat(uint256 id) internal view returns (Job storage) {
        uint256 s = seatOf[id][msg.sender];
        if (s == 0) revert NotSeated();
        return _jobs[id][s - 1];
    }

    function _assigned(address[] storage list, address w) internal view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) if (list[i] == w) return true;
        return false;
    }

    function _seatEnd(Task storage t) internal view returns (uint256) {
        return uint256(t.postedAt) + _params.seatWindow;
    }

    function _commitEnd(Task storage t) internal view returns (uint256) {
        return _seatEnd(t) + _params.commitWindow;
    }

    function _revealEnd(Task storage t) internal view returns (uint256) {
        return _commitEnd(t) + _params.revealWindow;
    }

    function _vcEnd(Task storage t) internal view returns (uint256) {
        return uint256(t.verifyAt) + _params.verifyCommitWindow;
    }

    function _vrEnd(Task storage t) internal view returns (uint256) {
        return _vcEnd(t) + _params.verifyRevealWindow;
    }

    function _ecEnd(Task storage t) internal view returns (uint256) {
        return uint256(t.evalAt) + _params.evalCommitWindow;
    }

    function _erEnd(Task storage t) internal view returns (uint256) {
        return _ecEnd(t) + _params.evalRevealWindow;
    }
}
