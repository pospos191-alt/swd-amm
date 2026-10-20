// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// What NeuroJobs reads from NeuroControl (contracts/NeuroControl.sol).
interface INeuroKnobs {
    function paused() external view returns (bool);
    function activeSkill() external view returns (bytes32);
    function defenderApproved(address) external view returns (bool);
    function roster() external view returns (address[] memory);
    function releasedAt(address) external view returns (uint64);
    function maxBodies() external view returns (uint256);
    function maxRegrowPerHour() external view returns (uint256);
    function communityFund() external view returns (address);
}

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
///
///         Fee: 90% to the runners whose verdict stood, 5% burned (sent to
///         0x…dEaD, locked forever), 5% to the community fund (credited; it
///         withdraws like a runner). Rounding dust goes to the community
///         fund, so fee = runners + burned + community to the wei. A failed
///         job refunds 100% of the fee.
///
///         Bodies (runners eligible per job) are elastic:
///           bodies = DEFENDERS + ceil(requests per minute / CAPACITY_PER_BODY)
///         capped by NeuroControl.maxBodies(). Requests per minute is the
///         busiest recent minute, fading linearly to zero over DECAY_MINUTES:
///         N requests in a minute count as N*(30-age)/30 after `age` whole
///         minutes, so with no use the extra bodies shrink step by step and
///         are gone after 30 minutes. Every request pays at least minFee,
///         so forcing growth with fake requests costs the attacker.
///
///         Immune system: 4 defender seats, filled by regrow() (anyone may
///         call it) from NeuroControl's voted roster, at most
///         maxRegrowPerHour refills per hour. Defenders are always eligible.
///         A runner whose verdict is rejected QUARANTINE_AFTER times in a row
///         is quarantined: no more commits, and its defender seat is
///         vacated. Only governance (NeuroControl.release) lets it back.
///
///         NeuroControl's paused() stops new requests and commits only;
///         reveals, expiry, refunds and withdrawals keep working. Each job
///         records the voted skill (activeSkill) it was requested under.
///
///         Without a NeuroControl (setControl never called) nothing is
///         paused, jobs carry skill 0, there are no defenders, bodies are
///         uncapped and the community share goes to the reward pool.
contract NeuroJobs {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    /// Share of the bond a runner loses for a verdict the quorum rejected,
    /// or for committing and then never revealing (basis points).
    uint16 public constant PENALTY_BPS = 1000;
    /// Fee split (basis points of the fee); the runners get the rest (90%).
    uint16 public constant BURN_BPS = 500;
    uint16 public constant COMMUNITY_BPS = 500;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// Defender seats; also the fewest bodies there ever are.
    uint8 public constant DEFENDERS = 4;
    /// Requests per minute one body is expected to handle.
    uint256 public constant CAPACITY_PER_BODY = 6;
    /// Minutes for the extra bodies to fade out after the last busy minute.
    uint256 public constant DECAY_MINUTES = 30;
    /// Rejected verdicts in a row that put a runner in quarantine (K).
    uint8 public constant QUARANTINE_AFTER = 2;
    /// Longest target: a Move coin type (66-char address + two 128-char names + separators).
    uint256 public constant MAX_TARGET = 330;

    uint256 public immutable workerBond;
    uint256 public immutable jobReward;
    uint256 public immutable minFee;
    uint64 public immutable commitWindow;
    uint64 public immutable jobTimeout;
    uint64 public immutable unbondDelay;
    uint256 public immutable dailyRewardCap;
    /// May call setControl() once, before the first job.
    address public immutable deployer;

    enum Status { None, Open, Done, Failed }

    struct Worker {
        uint128 bond;
        uint64 unbondAt; // 0 while active
        bool active;
        uint32 agreed;
        uint32 rejected;
        uint64 since;    // when it last became active; only later jobs count
        uint8 streak;    // rejected verdicts in a row
        uint64 quarantinedAt; // 0 = never; see quarantined()
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
        bytes32 skill;   // NeuroControl.activeSkill() at request time
        uint16 bodies;   // bodies when requested
        uint16 drawn;    // of which drawn by lottery (bodies minus seated defenders)
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

    INeuroKnobs public control;
    address[4] public defender;
    uint64 public regrowHour;
    uint256 public regrownThisHour;
    uint256 public totalBurned;
    // Load meter: requests in the latest minute that had any, and the
    // busiest earlier minute still fading (see bodies()).
    uint64 public loadMinute;
    uint64 public loadCount;
    uint64 public peakMinute;
    uint64 public peakCount;

    event Funded(address indexed from, uint256 amount);
    event Registered(address indexed worker, uint256 bond);
    event UnbondRequested(address indexed worker, uint64 at);
    event JobRequested(uint256 indexed id, bytes32 indexed chain, string target, uint256 fee);
    event Committed(uint256 indexed id, address indexed worker);
    event Revealed(uint256 indexed id, address indexed worker, bytes32 verdict);
    event Finalized(uint256 indexed id, bytes32 verdict);
    event JobFailed(uint256 indexed id);
    event Penalized(address indexed worker, uint256 amount);
    event ControlSet(address control);
    event JobSized(uint256 indexed id, bytes32 indexed skill, uint256 bodies, uint256 drawn);
    event FeeSplit(uint256 indexed id, uint256 runners, uint256 burned, uint256 community);
    event Quarantined(address indexed worker);
    event DefenderSeated(address indexed worker, uint256 seat);
    event DefenderVacated(address indexed worker, uint256 seat);

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
    error Paused();
    error NoSkill();
    error NoControl();
    error NotDeployer();

    constructor(uint256 bond_, uint256 reward_, uint256 minFee_, uint64 commitWindow_, uint64 timeout_, uint64 unbondDelay_, uint256 dailyRewardCap_) {
        if (bond_ == 0 || commitWindow_ == 0 || timeout_ <= commitWindow_ || unbondDelay_ < timeout_) revert BadValue();
        workerBond = bond_;
        jobReward = reward_;
        minFee = minFee_;
        commitWindow = commitWindow_;
        jobTimeout = timeout_;
        unbondDelay = unbondDelay_;
        dailyRewardCap = dailyRewardCap_;
        deployer = msg.sender;
    }

    /// Wires in NeuroControl. Once, by the deployer, before any job exists.
    function setControl(INeuroKnobs control_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(control) != address(0) || jobs.length != 0 || address(control_) == address(0)) revert BadValue();
        control = control_;
        emit ControlSet(address(control_));
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
        bytes32 skill;
        if (address(control) != address(0)) {
            if (control.paused()) revert Paused();
            skill = control.activeSkill();
            if (skill == bytes32(0)) revert NoSkill();
        }
        _countRequest();
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
        j.skill = skill;
        uint256 b = bodies();
        uint256 seated = _seatedDefenders();
        j.bodies = uint16(b);
        j.drawn = uint16(b > seated ? b - seated : 0);
        emit JobRequested(id, chain, target, msg.value);
        emit JobSized(id, skill, b, j.drawn);
    }

    /// @param commitment keccak256(abi.encode(verdict, msg.sender, salt))
    function commit(uint256 id, bytes32 commitment) external {
        Job storage j = _open(id);
        if (!workers[msg.sender].active) revert NotWorker();
        if (address(control) != address(0) && control.paused()) revert Paused();
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

    /// May `w` take a seat on job `id` right now? Seated defenders always
    /// may. Everyone else goes by a bond-weighted lottery: about `drawn`
    /// runners (the job's bodies minus seated defenders) qualify at first,
    /// twice as many after each third of the commit window (at least SEATS
    /// once the first third has passed, so jobs still fill when defenders
    /// are offline). Only runners active since before the job, never
    /// quarantined ones.
    function eligible(uint256 id, address w) public view returns (bool) {
        if (id >= jobs.length) return false;
        Job storage j = jobs[id];
        Worker storage wk = workers[w];
        uint256 total = totalActiveBond;
        if (!wk.active || wk.since >= j.created || total == 0 || quarantined(w)) return false;
        if (isDefender(w)) return true;
        uint256 stage = ((block.timestamp - j.created) * 3) / commitWindow; // 0, 1, 2 inside the window
        uint256 base = j.drawn;
        if (stage > 0 && base < SEATS) base = SEATS;
        uint256 k = base << (stage > 2 ? 2 : stage);
        uint256 x = uint256(keccak256(abi.encode(j.seed, w))) % 1e18;
        return x * total < k * uint256(wk.bond) * 1e18;
    }

    /// The skill a job was requested under, and its body counts.
    function jobInfo(uint256 id) external view returns (bytes32 skill, uint256 bodies_, uint256 drawn) {
        if (id >= jobs.length) revert BadJob();
        Job storage j = jobs[id];
        return (j.skill, j.bodies, j.drawn);
    }

    /// Requests per minute right now, times DECAY_MINUTES (the busiest
    /// recent minute, fading linearly to 0 over DECAY_MINUTES).
    function load() public view returns (uint256) {
        uint64 m = uint64(block.timestamp / 60);
        uint256 a = _fade(loadCount, loadMinute, m);
        uint256 b = _fade(peakCount, peakMinute, m);
        return a > b ? a : b;
    }

    /// Bodies for a job requested now: DEFENDERS + ceil(requests per minute
    /// / CAPACITY_PER_BODY), at most NeuroControl.maxBodies().
    function bodies() public view returns (uint256 n) {
        uint256 unit = DECAY_MINUTES * CAPACITY_PER_BODY;
        n = DEFENDERS + (load() + unit - 1) / unit;
        uint256 cap = address(control) != address(0) ? control.maxBodies() : type(uint16).max;
        if (n > cap) n = cap;
    }

    function quarantined(address w) public view returns (bool) {
        uint64 q = workers[w].quarantinedAt;
        if (q == 0) return false;
        return address(control) == address(0) || q >= control.releasedAt(w);
    }

    /// Seated in a defender seat and still fit for it.
    function isDefender(address w) public view returns (bool) {
        if (w == address(0)) return false;
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] == w) return _fit(w);
        return false;
    }

    function defenders() external view returns (address[4] memory) {
        return defender;
    }

    // ---- immune system ----

    /// Anyone may call it. Vacates defender seats whose runner is no longer
    /// fit (removed from the roster, quarantined, unbonded or below the
    /// bond), then refills empty seats from NeuroControl's roster, at most
    /// maxRegrowPerHour refills per clock hour.
    function regrow() external returns (uint256 filled) {
        if (address(control) == address(0)) revert NoControl();
        for (uint256 i = 0; i < DEFENDERS; i++) {
            address d = defender[i];
            if (d != address(0) && !_fit(d)) {
                defender[i] = address(0);
                emit DefenderVacated(d, i);
            }
        }
        uint64 hour = uint64(block.timestamp / 1 hours);
        if (regrowHour != hour) { regrowHour = hour; regrownThisHour = 0; }
        uint256 cap = control.maxRegrowPerHour();
        address[] memory r = control.roster();
        uint256 next = 0;
        for (uint256 i = 0; i < DEFENDERS && regrownThisHour < cap; i++) {
            if (defender[i] != address(0)) continue;
            for (; next < r.length; next++) {
                address cand = r[next];
                if (!_seated(cand) && _fit(cand)) {
                    defender[i] = cand;
                    regrownThisHour += 1;
                    filled += 1;
                    emit DefenderSeated(cand, i);
                    next++;
                    break;
                }
            }
            if (next >= r.length && defender[i] == address(0)) break;
        }
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
        uint256 burnCut = (j.fee * BURN_BPS) / 10_000;
        uint256 fundCut = (j.fee * COMMUNITY_BPS) / 10_000;
        uint256 toRunners = j.fee - burnCut - fundCut;
        uint256 share = toRunners / winners;
        fundCut += toRunners - share * winners; // rounding dust
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
                workers[w].streak = 0;
            } else if (j.revealed[i]) {
                Worker storage wk = workers[w];
                wk.rejected += 1;
                wk.streak += 1;
                _penalize(w);
                if (wk.streak >= QUARANTINE_AFTER) _quarantine(w);
            }
            // A seat that has not revealed yet is judged when the job would
            // have timed out; after a quorum it simply earns nothing.
        }
        if (address(control) != address(0)) credit[control.communityFund()] += fundCut;
        else rewardPool += fundCut;
        totalBurned += burnCut;
        emit FeeSplit(id, share * winners, burnCut, fundCut);
        emit Finalized(id, verdict);
        // Last: BURN has no code, so this cannot call back.
        if (burnCut > 0) {
            (bool ok,) = BURN.call{value: burnCut}("");
            require(ok, "burn failed");
        }
    }

    function _fail(uint256 id, Job storage j, bool timedOut) private {
        j.status = Status.Failed;
        credit[j.requester] += j.fee;
        if (timedOut) {
            for (uint8 i = 0; i < j.commits; i++) if (!j.revealed[i]) _penalize(j.seat[i]);
        }
        emit JobFailed(id);
    }

    function _quarantine(address w) private {
        Worker storage wk = workers[w];
        wk.streak = 0;
        wk.quarantinedAt = uint64(block.timestamp);
        emit Quarantined(w);
        for (uint256 i = 0; i < DEFENDERS; i++) {
            if (defender[i] == w) {
                defender[i] = address(0);
                emit DefenderVacated(w, i);
            }
        }
    }

    function _fit(address w) private view returns (bool) {
        return address(control) != address(0) && control.defenderApproved(w) && workers[w].active && !quarantined(w);
    }

    function _seated(address w) private view returns (bool) {
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] == w) return true;
        return false;
    }

    function _seatedDefenders() private view returns (uint256 n) {
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] != address(0) && _fit(defender[i])) n++;
    }

    /// N requests counted at minute `from`, seen at minute `m`: N*(DECAY-age), 0 after DECAY_MINUTES.
    function _fade(uint256 n, uint64 from, uint64 m) private pure returns (uint256) {
        uint256 age = m - from;
        return age >= DECAY_MINUTES ? 0 : n * (DECAY_MINUTES - age);
    }

    function _countRequest() private {
        uint64 m = uint64(block.timestamp / 60);
        if (m != loadMinute) {
            // The finished minute becomes the peak if it outweighs the fading one.
            if (_fade(loadCount, loadMinute, m) >= _fade(peakCount, peakMinute, m)) { peakCount = loadCount; peakMinute = loadMinute; }
            loadMinute = m;
            loadCount = 0;
        }
        loadCount += 1;
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
