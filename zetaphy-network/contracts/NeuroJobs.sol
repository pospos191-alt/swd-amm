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
contract NeuroJobs {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    /// Share of the bond a runner loses for a verdict the quorum rejected,
    /// or for committing and then never revealing (basis points).
    uint16 public constant PENALTY_BPS = 1000;

    uint256 public immutable workerBond;
    uint256 public immutable jobReward;
    uint256 public immutable minFee;
    uint64 public immutable commitWindow;
    uint64 public immutable jobTimeout;
    uint64 public immutable unbondDelay;

    enum Status { None, Open, Done, Failed }

    struct Worker {
        uint128 bond;
        uint64 unbondAt; // 0 while active
        bool active;
        uint32 agreed;
        uint32 rejected;
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
        string target;
        address[3] seat;
        bytes32[3] commitOf;
        bytes32[3] verdictOf;
        bool[3] revealed;
    }

    uint256 public rewardPool;
    uint256 public activeWorkers;
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

    constructor(uint256 bond_, uint256 reward_, uint256 minFee_, uint64 commitWindow_, uint64 timeout_, uint64 unbondDelay_) {
        if (bond_ == 0 || commitWindow_ == 0 || timeout_ <= commitWindow_ || unbondDelay_ < timeout_) revert BadValue();
        workerBond = bond_;
        jobReward = reward_;
        minFee = minFee_;
        commitWindow = commitWindow_;
        jobTimeout = timeout_;
        unbondDelay = unbondDelay_;
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
        activeWorkers += 1;
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
    /// @param target  address on that chain (EVM hex or Solana base58), at most 64 bytes
    function request(bytes32 chain, string calldata target) external payable returns (uint256 id) {
        if (msg.value < minFee || chain == bytes32(0) || bytes(target).length == 0 || bytes(target).length > 64) revert BadValue();
        id = jobs.length;
        Job storage j = jobs.push();
        j.requester = msg.sender;
        j.created = uint64(block.timestamp);
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
        for (uint8 i = 0; i < j.commits; i++) {
            address w = j.seat[i];
            if (j.revealed[i] && j.verdictOf[i] == verdict) {
                uint256 pay = share;
                if (rewardPool >= jobReward) { rewardPool -= jobReward; pay += jobReward; }
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
        emit Penalized(w, cut);
        // Below the bond: stop taking new jobs until topped up.
        if (wk.active && wk.bond < workerBond) {
            wk.active = false;
            activeWorkers -= 1;
        }
    }
}
