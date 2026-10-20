// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title NeuroJobs: the Neuro ZETAPHY job market (testnet, stage 1-2)
/// @notice Someone asks for a contract to be checked and pays a fee in ZETAPHY.
///         Up to three bonded node runners each compute Neuro's verdict on their
///         own machine. The verdict stands once two of them agree, and those two
///         share the fee plus a reward from the pool.
///
///         Commit-reveal stops a runner from copying another's answer: runners
///         first post keccak256(verdict, runner, salt), and reveal only after
///         all seats are taken or the commit window closes.
///
///         Payouts are credited, then pulled with withdraw() (no ETH is pushed
///         to arbitrary addresses inside the job logic).
///
///         Seats are not first-come: per job, a lottery weighted by bond
///         decides who may commit (eligible()). Its seed comes from the
///         request (requester, chain, target, time, the requester's own
///         counter), which nobody else can change, and only runners that
///         registered before the job count. Splitting one bond over many
///         addresses does not raise the odds. Pool rewards are capped at a
///         quarter of the fee per winner and per day, so requesting jobs for
///         oneself does not pay. (zetaphyd has no usable on-chain
///         randomness: BLOCKHASH returns 0 and PREVRANDAO is constant.)
contract NeuroJobs {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    /// Share of the bond a runner loses for a verdict the quorum rejected,
    /// or for committing and then never revealing (basis points).
    uint16 public constant PENALTY_BPS = 1000;
    /// Expected number of eligible runners when a job opens. It doubles each
    /// third of the commit window so seats still fill when some are offline.
    uint256 public constant COMMITTEE = 6;
    /// Longest target: a Move coin type (66-char address + two 128-char names + separators).
    uint256 public constant MAX_TARGET = 330;

    uint256 public immutable workerBond;
    uint256 public immutable jobReward;
    uint256 public immutable minFee;
    uint64 public immutable commitWindow;
    uint64 public immutable jobTimeout;
    uint64 public immutable unbondDelay;
    uint256 public immutable dailyRewardCap;

    enum Status { None, Open, Done, Failed }

    struct Worker {
        uint128 bond;
        uint64 unbondAt; // 0 while active
        bool active;
        uint32 agreed;
        uint32 rejected;
        uint64 since;    // when it last became active; only later jobs count
    }

    struct Job {
        address requester;
        uint64 created;
        Status status;
        uint8 commits;
        uint8 reveals;
        bytes32 chain;
        uint256 fee;
        bytes32 result;
        bytes32 seed;
        string target;
        address[3] seat;
        bytes32[3] commitOf;
        bytes32[3] verdictOf;
        bool[3] revealed;
    }

    uint256 public rewardPool;
    uint256 public activeWorkers;
    uint256 public totalActiveBond;
    uint64 public rewardDay;
    uint256 public rewardedToday;
    mapping(address => uint256) public requestCount;
    mapping(address => Worker) public workers;
    mapping(address => uint256) public credit;
    Job[] internal jobs;

    event Funded(address indexed from, uint256 amount);
    event Registered(address indexed worker, uint256 bond);
    event UnbondRequested(address indexed worker, uint64 at);
    event JobRequested(uint256 indexed id, bytes32 indexed chain, string target, uint256 fee);
    event Committed(uint256 indexed id, address indexed worker);
    event Revealed(uint256 indexed id, address indexed worker, bytes32 verdict);
    event Finalized(uint256 indexed id, bytes32 verdict);
    event JobFailed(uint256 indexed id);
    event Penalized(address indexed worker, uint256 amount);

    error BadValue();
    error BadJob();
    error NotWorker();
    error Closed();
    error AlreadyIn();
    error NoSeat();
    error TooEarly();
    error BadReveal();
    error Nothing();
    error NotChosen();

    constructor(uint256 bond_, uint256 reward_, uint256 minFee_, uint64 commitWindow_, uint64 timeout_, uint64 unbondDelay_, uint256 dailyRewardCap_) {
        if (bond_ == 0 || commitWindow_ == 0 || timeout_ <= commitWindow_ || unbondDelay_ < timeout_) revert BadValue();
        workerBond = bond_;
        jobReward = reward_;
        minFee = minFee_;
        commitWindow = commitWindow_;
        jobTimeout = timeout_;
        unbondDelay = unbondDelay_;
        dailyRewardCap = dailyRewardCap_;
    }

    // ---- pool and runners ----

    function fund() external payable {
        if (msg.value == 0) revert BadValue();
        rewardPool += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    function register() external payable {
        Worker storage w = workers[msg.sender];
        if (w.active) revert AlreadyIn();
        if (w.unbondAt != 0) revert TooEarly(); // finish leaving first
        uint256 bond = uint256(w.bond) + msg.value;
        if (bond < workerBond) revert BadValue();
        w.bond = uint128(bond);
        w.active = true;
        w.since = uint64(block.timestamp);
        activeWorkers += 1;
        totalActiveBond += bond;
        emit Registered(msg.sender, bond);
    }

    /// Leaving takes unbondDelay, so a runner cannot escape a penalty on a job
    /// it is still part of.
    function requestUnbond() external {
        Worker storage w = workers[msg.sender];
        if (!w.active) revert NotWorker();
        w.active = false;
        w.unbondAt = uint64(block.timestamp) + unbondDelay;
        activeWorkers -= 1;
        totalActiveBond -= w.bond;
        emit UnbondRequested(msg.sender, w.unbondAt);
    }

    function withdrawBond() external {
        Worker storage w = workers[msg.sender];
        if (w.active || w.unbondAt == 0 || block.timestamp < w.unbondAt) revert TooEarly();
        uint256 amount = w.bond;
        w.bond = 0;
        w.unbondAt = 0;
        credit[msg.sender] += amount;
    }

    function withdraw() external {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert Nothing();
        credit[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ---- jobs ----

    /// @param chain   chain key as bytes32, e.g. "bsc"
    /// @param target  address on that chain (EVM hex, Solana base58, a Move coin
    ///                type such as 0x…::module::NAME, or a TON address), at most MAX_TARGET bytes
    function request(bytes32 chain, string calldata target) external payable returns (uint256 id) {
        return _request(msg.sender, chain, target);
    }

    /// Same as request(), but a refund goes to `refundTo`. Used by StableGateway,
    /// which pays the fee for a user who paid it in a stablecoin.
    function requestFor(address refundTo, bytes32 chain, string calldata target) external payable returns (uint256 id) {
        if (refundTo == address(0)) revert BadValue();
        return _request(refundTo, chain, target);
    }

    function _request(address requester, bytes32 chain, string calldata target) private returns (uint256 id) {
        if (msg.value < minFee || chain == bytes32(0) || bytes(target).length == 0 || bytes(target).length > MAX_TARGET) revert BadValue();
        id = jobs.length;
        Job storage j = jobs.push();
        j.requester = requester;
        j.created = uint64(block.timestamp);
        // Not the job id: jobs slipped in first must not move the seed.
        j.seed = keccak256(abi.encode(requester, chain, target, block.timestamp, requestCount[requester]++));
        j.status = Status.Open;
        j.chain = chain;
        j.target = target;
        j.fee = msg.value;
        emit JobRequested(id, chain, target, msg.value);
    }

    /// @param commitment keccak256(abi.encode(verdict, msg.sender, salt))
    function commit(uint256 id, bytes32 commitment) external {
        Job storage j = _open(id);
        if (!workers[msg.sender].active) revert NotWorker();
        if (block.timestamp >= j.created + commitWindow || j.commits == SEATS) revert NoSeat();
        if (!eligible(id, msg.sender)) revert NotChosen();
        for (uint8 i = 0; i < j.commits; i++) if (j.seat[i] == msg.sender) revert AlreadyIn();
        j.seat[j.commits] = msg.sender;
        j.commitOf[j.commits] = commitment;
        j.commits += 1;
        emit Committed(id, msg.sender);
    }

    function reveal(uint256 id, bytes32 verdict, bytes32 salt) external {
        Job storage j = _open(id);
        if (j.commits < SEATS && block.timestamp < j.created + commitWindow) revert TooEarly();
        uint8 s = _seatOf(j, msg.sender);
        if (j.revealed[s]) revert AlreadyIn();
        if (keccak256(abi.encode(verdict, msg.sender, salt)) != j.commitOf[s]) revert BadReveal();
        j.revealed[s] = true;
        j.verdictOf[s] = verdict;
        j.reveals += 1;
        emit Revealed(id, msg.sender, verdict);

        // Quorum: this verdict matches QUORUM-1 earlier reveals.
        uint8 same = 0;
        for (uint8 i = 0; i < j.commits; i++) if (j.revealed[i] && j.verdictOf[i] == verdict) same++;
        if (same >= QUORUM) _finalize(id, j, verdict);
        else if (j.reveals == j.commits && (j.commits == SEATS || block.timestamp >= j.created + commitWindow)) {
            // Everyone who committed has revealed and no two agree.
            _fail(id, j, false);
        }
    }

    /// Anyone can close a job that ran out of time without a quorum.
    function expire(uint256 id) external {
        Job storage j = _open(id);
        if (block.timestamp < j.created + jobTimeout) revert TooEarly();
        _fail(id, j, true);
    }

    // ---- views ----

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function getJob(uint256 id) external view returns (
        address requester, uint64 created, Status status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat
    ) {
        if (id >= jobs.length) revert BadJob();
        Job storage j = jobs[id];
        return (j.requester, j.created, j.status, j.chain, j.target, j.fee, j.result, j.commits, j.reveals, j.seat);
    }

    /// May `w` take a seat on job `id` right now? A bond-weighted lottery:
    /// about COMMITTEE runners qualify at first, twice as many after each
    /// third of the commit window. Only runners active since before the job.
    function eligible(uint256 id, address w) public view returns (bool) {
        if (id >= jobs.length) return false;
        Job storage j = jobs[id];
        Worker storage wk = workers[w];
        uint256 total = totalActiveBond;
        if (!wk.active || wk.since >= j.created || total == 0) return false;
        uint256 stage = ((block.timestamp - j.created) * 3) / commitWindow; // 0, 1, 2 inside the window
        uint256 k = COMMITTEE << (stage > 2 ? 2 : stage);
        uint256 x = uint256(keccak256(abi.encode(j.seed, w))) % 1e18;
        return x * total < k * uint256(wk.bond) * 1e18;
    }

    function seatOf(uint256 id, address worker) external view returns (bool seated, bool revealed_) {
        if (id >= jobs.length) revert BadJob();
        Job storage j = jobs[id];
        for (uint8 i = 0; i < j.commits; i++) if (j.seat[i] == worker) return (true, j.revealed[i]);
        return (false, false);
    }

    // ---- internals ----

    function _open(uint256 id) private view returns (Job storage j) {
        if (id >= jobs.length) revert BadJob();
        j = jobs[id];
        if (j.status != Status.Open) revert Closed();
    }

    function _seatOf(Job storage j, address w) private view returns (uint8) {
        for (uint8 i = 0; i < j.commits; i++) if (j.seat[i] == w) return i;
        revert NoSeat();
    }

    function _finalize(uint256 id, Job storage j, bytes32 verdict) private {
        j.status = Status.Done;
        j.result = verdict;
        uint8 winners = 0;
        for (uint8 i = 0; i < j.commits; i++) if (j.revealed[i] && j.verdictOf[i] == verdict) winners++;
        uint256 share = j.fee / winners;
        uint256 dust = j.fee - share * winners;
        // Pool reward per winner: at most jobReward and at most a quarter of
        // the fee, within the daily cap.
        uint256 reward = jobReward < j.fee / 4 ? jobReward : j.fee / 4;
        uint64 today = uint64(block.timestamp / 1 days);
        if (rewardDay != today) { rewardDay = today; rewardedToday = 0; }
        for (uint8 i = 0; i < j.commits; i++) {
            address w = j.seat[i];
            if (j.revealed[i] && j.verdictOf[i] == verdict) {
                uint256 pay = share;
                if (reward > 0 && rewardPool >= reward && rewardedToday + reward <= dailyRewardCap) {
                    rewardPool -= reward;
                    rewardedToday += reward;
                    pay += reward;
                }
                credit[w] += pay;
                workers[w].agreed += 1;
            } else if (j.revealed[i]) {
                workers[w].rejected += 1;
                _penalize(w);
            }
            // A seat that has not revealed yet is judged when the job would
            // have timed out; after a quorum it simply earns nothing.
        }
        rewardPool += dust;
        emit Finalized(id, verdict);
    }

    function _fail(uint256 id, Job storage j, bool timedOut) private {
        j.status = Status.Failed;
        credit[j.requester] += j.fee;
        if (timedOut) {
            for (uint8 i = 0; i < j.commits; i++) if (!j.revealed[i]) _penalize(j.seat[i]);
        }
        emit JobFailed(id);
    }

    function _penalize(address w) private {
        Worker storage wk = workers[w];
        uint256 cut = (uint256(wk.bond) * PENALTY_BPS) / 10_000;
        if (cut == 0) return;
        wk.bond -= uint128(cut);
        rewardPool += cut;
        if (wk.active) totalActiveBond -= cut;
        emit Penalized(w, cut);
        // Below the bond: stop taking new jobs until topped up.
        if (wk.active && wk.bond < workerBond) {
            wk.active = false;
            activeWorkers -= 1;
            totalActiveBond -= wk.bond;
        }
    }
}
