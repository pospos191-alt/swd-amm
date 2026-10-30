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
    function chainAllowed(bytes32) external view returns (bool);
    function challengeBond() external view returns (uint256);
    function challengeWindow() external view returns (uint256);
    function defenderTimeout() external view returns (uint256);
}

/// @title NeuroJobsBase: storage, rules and helpers shared by NeuroJobs and
///        its challenge logic (NeuroJobsChallenges, reached by delegatecall,
///        so both see the same storage). See NeuroJobs for the rules.
abstract contract NeuroJobsBase {
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
    /// Strikes within the last STRIKE_WINDOW judged seats that put a runner in quarantine (K).
    uint8 public constant QUARANTINE_AFTER = 2;
    uint8 public constant STRIKE_WINDOW = 5;
    /// Share of a failed or expired job's fee that is burned instead of refunded.
    uint16 public constant FAIL_BURN_BPS = 500;
    /// Longest target: a Move coin type (66-char address + two 128-char names + separators).
    uint256 public constant MAX_TARGET = 330;
    /// Share of its bond a round-1 runner loses when a challenge overturns its verdict.
    uint16 public constant CHALLENGE_SLASH_BPS = 5000;
    /// The challenge bond is at least this many times the job fee.
    uint256 public constant CHALLENGE_FEE_MULTIPLE = 2;
    /// Challenge rounds per job (after a Disputed one a new one may open): 3 rounds in all.
    uint8 public constant MAX_CHALLENGES = 2;
    /// Share of the challenger's bond kept when a challenge round finds no quorum.
    uint16 public constant DISPUTE_KEEP_BPS = 2000;

    uint256 public immutable workerBond;
    uint256 public immutable jobReward;
    uint256 public immutable minFee;
    uint64 public immutable commitWindow;
    uint64 public immutable jobTimeout;
    uint64 public immutable unbondDelay;
    uint256 public immutable dailyRewardCap;
    /// May call setControl() once.
    address public immutable deployer;

    enum Status { None, Open, Done, Failed }
    enum ChallengeState { None, Open, Confirmed, Overturned, Disputed }

    struct Worker {
        uint128 bond;
        uint64 unbondAt; // 0 while active
        bool active;
        uint32 agreed;
        uint32 rejected;
        uint64 since;    // when it last became active; only later jobs count
        uint8 recent;    // last STRIKE_WINDOW judged seats, newest in bit 0; 1 = strike
        uint64 quarantinedAt; // 0 = never; see quarantined()
        uint64 lastSeen;  // last register, heartbeat, commit or reveal
        uint64 heldUntil; // bond stays until nothing it sat on can still slash it
    }

    /// One round of 3 seats (round 1 = the job, rounds 2.. = challenges).
    struct Round {
        uint8 commits;
        uint8 reveals;
        uint8 defenders;   // seats taken as a defender
        uint64 start;      // the commit window starts here
        uint64 startBlock; // the lottery uses blockhash(startBlock + 1)
        bytes32 rand;      // the stored lottery; 0 until stored (see _rand)
        uint256 total;     // totalActiveBond when the round opened (the lottery's denominator)
        address[3] seat;
        bytes32[3] commitOf;
        bytes32[3] verdictOf;
        bool[3] revealed;
    }

    struct Job {
        address requester;
        Status status;
        uint8 agreedBy;  // distinct runners that revealed the final verdict
        uint8 chN;       // challenges opened on it (at most MAX_CHALLENGES)
        uint16 bodies;   // bodies when requested
        uint16 drawn;    // of which drawn by lottery (bodies minus seated defenders)
        uint64 settleAt; // quorum reached with seats unrevealed: grace ends here (0 = nothing pending)
        uint64 challengeUntil; // set when the quorum forms (moved after a Disputed challenge)
        bytes32 chain;
        uint256 fee;
        bytes32 result;
        bytes32 seed;
        bytes32 skill;   // NeuroControl.activeSkill() at request time
        string target;
        Round r;
    }

    struct Challenge {
        address challenger;
        ChallengeState state;
        uint64 settleAt;
        uint256 bond;
        bytes32 claim;   // the verdict the challenger says is right
        bytes32 result;
        Round r;
    }

    uint256 public rewardPool;
    uint256 public activeWorkers;
    uint256 public totalActiveBond;
    uint64 public rewardDay;
    uint256 public rewardedToday;
    mapping(address => uint256) public requestCount;
    mapping(address => Worker) public workers;
    mapping(address => uint256) public credit;
    /// Seats a runner committed to and that are not resolved yet (revealed, or missed: penalised by
    /// expire / settle / challengeExpire). withdrawBond needs 0, so a runner that never reveals cannot
    /// take its bond out before its penalty lands, whoever calls expire/settle and whenever (NJ-1).
    mapping(address => uint256) public openSeats;
    Job[] internal jobs;
    /// challenges[id][k]: the k-th challenge (0-based) of job id.
    mapping(uint256 => mapping(uint256 => Challenge)) internal challenges;
    /// Ids of challenged jobs, once per challenge, in order (runners scan it for seats).
    uint256[] public challenged;

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
    event Missed(uint256 indexed id, address indexed worker);
    event Settled(uint256 indexed id);
    event Drawn(uint256 indexed id, uint8 round, bytes32 rand);
    /// The lottery block's hash fell out of the 256-block window before anyone used it: the round takes a new block.
    event Redrawn(uint256 indexed id, uint8 round, uint64 startBlock);
    event Challenged(uint256 indexed id, address indexed challenger, uint256 bond);
    event ChallengeClaim(uint256 indexed id, uint8 round, bytes32 claim);
    event ChallengeCommitted(uint256 indexed id, address indexed worker);
    event ChallengeRevealed(uint256 indexed id, address indexed worker, bytes32 verdict);
    event ChallengeResolved(uint256 indexed id, ChallengeState state, bytes32 verdict);

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
    error UnknownChain();
    error InQuarantine();

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

    // ---- shared internals ----

    function _job(uint256 id) internal view returns (Job storage) {
        if (id >= jobs.length) revert BadJob();
        return jobs[id];
    }

    /// The latest challenge of job `id` and its round number (2, 3, ...);
    /// (an empty one, 1) when there is none.
    function _latest(uint256 id) internal view returns (Challenge storage ch, uint8 round) {
        uint8 n = jobs[id].chN;
        return (challenges[id][n == 0 ? 0 : n - 1], n + 1);
    }

    function _paused() internal view returns (bool) {
        return address(control) != address(0) && control.paused();
    }

    /// The lottery of a round: keccak256(seed, blockhash(startBlock + 1), round).
    /// Fixed by a block the caller cannot pick, so failing (a revert) and
    /// trying again in a later block, or calling only when it suits, changes
    /// nothing. 0 = not available: before block startBlock + 2, or (blockhash
    /// 0) more than 256 blocks later, when draw() moves the round to a new
    /// block. A chain whose BLOCKHASH gives 0 inside the window gets a fixed
    /// fallback, keccak256(seed, 1, round): as predictable as the request.
    function _rand(bytes32 seed, Round storage r, uint8 round) internal view returns (bytes32) {
        if (r.rand != 0) return r.rand;
        uint256 n = uint256(r.startBlock) + 1;
        if (block.number <= n) return 0;
        bytes32 h = blockhash(n);
        if (h == 0) {
            if (block.number - n > 256) return 0;
            h = bytes32(uint256(1));
        }
        return keccak256(abi.encode(seed, h, round));
    }

    function _open(Round storage r) internal {
        r.start = uint64(block.timestamp);
        r.startBlock = uint64(block.number);
        r.total = totalActiveBond;
    }

    /// Takes a seat in round `round` for msg.sender.
    function _take(uint256 id, Round storage r, uint8 round, bytes32 commitment) internal {
        Worker storage wk = workers[msg.sender];
        if (!wk.active) revert NotWorker();
        if (_paused()) revert Paused();
        if (block.timestamp >= r.start + commitWindow || r.commits == SEATS) revert NoSeat();
        if (r.rand == 0) {
            bytes32 x = _rand(jobs[id].seed, r, round);
            if (x == 0) revert TooEarly();
            r.rand = x;
            emit Drawn(id, round, x);
        }
        (bool ok, bool asDefender) = _eligible(id, r, msg.sender, round);
        if (!ok) revert NotChosen();
        for (uint8 i = 0; i < r.commits; i++) if (r.seat[i] == msg.sender) revert AlreadyIn();
        r.seat[r.commits] = msg.sender;
        r.commitOf[r.commits] = commitment;
        r.commits += 1;
        if (asDefender) r.defenders += 1;
        openSeats[msg.sender] += 1;
        wk.lastSeen = uint64(block.timestamp);
        // Penalties of this seat come by start + jobTimeout (+ the grace): the bond stays.
        _hold(msg.sender, uint256(r.start) + 2 * uint256(jobTimeout));
    }

    /// Checks msg.sender's commitment; returns how many revealed seats now
    /// hold this verdict (itself included).
    function _reveal(Round storage r, bytes32 verdict, bytes32 salt) internal returns (uint8 same) {
        uint8 s = _seatOf(r, msg.sender);
        if (r.revealed[s]) revert AlreadyIn();
        if (keccak256(abi.encode(verdict, msg.sender, salt)) != r.commitOf[s]) revert BadReveal();
        r.revealed[s] = true;
        r.verdictOf[s] = verdict;
        r.reveals += 1;
        openSeats[msg.sender] -= 1;
        workers[msg.sender].lastSeen = uint64(block.timestamp);
        for (uint8 i = 0; i < r.commits; i++) if (r.revealed[i] && r.verdictOf[i] == verdict) same++;
    }

    /// May a round's reveal still come? Open rounds: once seats are full or
    /// the commit window is over, and never after start + jobTimeout (a hard
    /// deadline: expire()/challengeExpire() close the round).
    function _revealOpen(Round storage r) internal view {
        if (block.timestamp >= r.start + jobTimeout) revert Closed();
        if (r.commits < SEATS && block.timestamp < r.start + commitWindow) revert TooEarly();
    }

    /// (eligible, as a defender) for round `round` of job `id`. Rounds 2..
    /// exclude every challenger so far and every seat of the earlier rounds.
    function _eligible(uint256 id, Round storage r, address w, uint8 round) internal view returns (bool, bool) {
        Job storage j = jobs[id];
        Worker storage wk = workers[w];
        uint256 total = r.total;
        if (_rand(j.seed, r, round) == 0 || !wk.active || wk.since >= r.start || total == 0 || quarantined(w)) return (false, false);
        if (round >= 2) {
            for (uint8 i = 0; i < j.r.commits; i++) if (j.r.seat[i] == w) return (false, false);
            for (uint256 c = 0; c + 2 <= round; c++) {
                Challenge storage x = challenges[id][c];
                if (x.challenger == w) return (false, false);
                if (c + 2 < round) for (uint8 i = 0; i < x.r.commits; i++) if (x.r.seat[i] == w) return (false, false);
            }
        }
        // A defender never goes by the lottery, and at most one sits on a
        // round, in every phase, unless no runner but defenders is active.
        if (isDefender(w)) return (r.defenders == 0 || activeWorkers <= _seatedDefenders(), true);
        uint256 stage = ((block.timestamp - r.start) * 3) / commitWindow; // 0, 1, 2 inside the window
        // Last third: every active runner (a real random draw must not leave seats empty).
        if (stage >= 2) return (true, false);
        uint256 base = j.drawn;
        if (stage > 0 && base < SEATS) base = SEATS;
        uint256 k = base << stage;
        uint256 x2 = uint256(keccak256(abi.encode(_rand(j.seed, r, round), w))) % 1e18;
        return (x2 * total < k * uint256(wk.bond) * 1e18, false);
    }

    function _seatOf(Round storage r, address w) internal view returns (uint8) {
        for (uint8 i = 0; i < r.commits; i++) if (r.seat[i] == w) return i;
        revert NoSeat();
    }

    function _challengeWindow() internal view returns (uint256 w) {
        if (address(control) != address(0)) w = control.challengeWindow();
        if (w == 0) w = jobTimeout;
    }

    /// Bonds of round-1 seats stay until a challenge opened by challengeUntil
    /// is over (its reveals end jobTimeout after it opens, its grace and
    /// settle() inside another jobTimeout).
    function _holdRound1(Job storage j) internal {
        uint256 hold = uint256(j.challengeUntil) + 2 * uint256(jobTimeout);
        for (uint8 i = 0; i < j.r.commits; i++) _hold(j.r.seat[i], hold);
    }

    function _hold(address w, uint256 until) internal {
        if (workers[w].heldUntil < until) workers[w].heldUntil = uint64(until);
    }

    function _toCommunity(uint256 amount) internal {
        if (amount == 0) return;
        if (address(control) != address(0)) credit[control.communityFund()] += amount;
        else rewardPool += amount;
    }

    function _settleRound(uint256 id, Round storage r, uint64 at) internal returns (bool) {
        if (at == 0 || block.timestamp < at) return false;
        for (uint8 i = 0; i < r.commits; i++) if (!r.revealed[i]) _miss(id, r.seat[i]);
        return true;
    }

    /// A judged seat: `ok` = its verdict stood. A rejected verdict costs the
    /// penalty and a strike.
    function _judge(address w, bool ok) internal {
        Worker storage wk = workers[w];
        if (ok) {
            wk.agreed += 1;
            _record(w, false);
        } else {
            wk.rejected += 1;
            _penalize(w, PENALTY_BPS, true);
            _record(w, true);
        }
    }

    /// Committed, never revealed: penalty and a strike.
    function _miss(uint256 id, address w) internal {
        openSeats[w] -= 1;
        emit Missed(id, w);
        _penalize(w, PENALTY_BPS, true);
        _record(w, true);
    }

    function _record(address w, bool strike) internal {
        Worker storage wk = workers[w];
        wk.recent = uint8(((uint256(wk.recent) << 1) | (strike ? 1 : 0)) & ((1 << STRIKE_WINDOW) - 1));
        if (strike && strikes(w) >= QUARANTINE_AFTER && !quarantined(w)) _quarantine(w);
    }

    /// Out at once: not active, its bond leaves totalActiveBond and starts
    /// unbonding (withdrawable after unbondDelay, minus penalties).
    function _quarantine(address w) internal {
        Worker storage wk = workers[w];
        wk.recent = 0;
        wk.quarantinedAt = uint64(block.timestamp);
        _deactivate(w);
        emit Quarantined(w);
        for (uint256 i = 0; i < DEFENDERS; i++) {
            if (defender[i] == w) {
                defender[i] = address(0);
                emit DefenderVacated(w, i);
            }
        }
    }

    /// Not active any more, and the unbond timer runs (withdrawBond after
    /// unbondDelay and heldUntil), so the bond never gets stuck.
    function _deactivate(address w) internal {
        Worker storage wk = workers[w];
        if (wk.active) {
            wk.active = false;
            activeWorkers -= 1;
            totalActiveBond -= wk.bond;
        }
        if (wk.unbondAt == 0 && wk.bond > 0) {
            wk.unbondAt = uint64(block.timestamp) + unbondDelay;
            emit UnbondRequested(w, wk.unbondAt);
        }
    }

    /// Takes `bps` of the bond: into the reward pool (`toPool`), or returned
    /// for the caller to hand out (a challenge's slash).
    function _penalize(address w, uint16 bps, bool toPool) internal returns (uint256 cut) {
        Worker storage wk = workers[w];
        cut = (uint256(wk.bond) * bps) / 10_000;
        if (cut == 0) return 0;
        wk.bond -= uint128(cut);
        if (toPool) rewardPool += cut;
        if (wk.active) totalActiveBond -= cut;
        emit Penalized(w, cut);
        // Below the bond: out until topped up (register() again), unbonding meanwhile.
        if (wk.active && wk.bond < workerBond) _deactivate(w);
    }

    /// Strikes within the runner's last STRIKE_WINDOW judged seats.
    function strikes(address w) public view returns (uint256 n) {
        for (uint8 r = workers[w].recent; r != 0; r >>= 1) n += r & 1;
    }

    function quarantined(address w) public view returns (bool) {
        uint64 q = workers[w].quarantinedAt;
        if (q == 0) return false;
        return address(control) == address(0) || q >= control.releasedAt(w);
    }

    /// Seated in a defender seat and still fit for it (incl. a recent heartbeat).
    function isDefender(address w) public view returns (bool) {
        if (w == address(0)) return false;
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] == w) return _fit(w);
        return false;
    }

    function _fit(address w) internal view returns (bool) {
        if (address(control) == address(0) || !control.defenderApproved(w) || !workers[w].active || quarantined(w)) return false;
        return block.timestamp < uint256(workers[w].lastSeen) + control.defenderTimeout();
    }

    function _seatedDefenders() internal view returns (uint256 n) {
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] != address(0) && _fit(defender[i])) n++;
    }

    /// The least bond challenge(id) takes: max(2 x fee, NeuroControl.challengeBond()).
    function challengeBondOf(uint256 id) public view returns (uint256 b) {
        b = _job(id).fee * CHALLENGE_FEE_MULTIPLE;
        if (address(control) != address(0)) {
            uint256 floor_ = control.challengeBond();
            if (floor_ > b) b = floor_;
        }
    }
}

/// @title NeuroJobsChallenges: the challenge rounds of NeuroJobs
/// @notice Runs only through NeuroJobs' delegatecall (on NeuroJobs' storage
///         and balance); NeuroJobs deploys it in its constructor. Called
///         directly it refuses. The rules are documented on NeuroJobs.
contract NeuroJobsChallenges is NeuroJobsBase {
    address private immutable self_;

    constructor(uint256 bond_, uint256 reward_, uint256 minFee_, uint64 commitWindow_, uint64 timeout_, uint64 unbondDelay_, uint256 dailyRewardCap_)
        NeuroJobsBase(bond_, reward_, minFee_, commitWindow_, timeout_, unbondDelay_, dailyRewardCap_)
    {
        self_ = address(this);
    }

    modifier delegated() {
        if (address(this) == self_) revert NotDeployer();
        _;
    }

    function challenge(uint256 id, bytes32 claim) external payable delegated {
        Job storage j = _job(id);
        if (j.status != Status.Done || block.timestamp >= j.challengeUntil) revert Closed();
        (Challenge storage prev,) = _latest(id);
        if (prev.state != ChallengeState.None && prev.state != ChallengeState.Disputed) revert AlreadyIn();
        if (j.chN >= MAX_CHALLENGES) revert Closed();
        if (_paused()) revert Paused();
        if (claim == bytes32(0) || claim == j.result || msg.value < challengeBondOf(id)) revert BadValue();
        Challenge storage ch = challenges[id][j.chN];
        j.chN += 1;
        ch.challenger = msg.sender;
        ch.state = ChallengeState.Open;
        ch.bond = msg.value;
        ch.claim = claim;
        _open(ch.r);
        // Round-1 bonds stay until this round is over (whatever challengeUntil said).
        uint256 hold = uint256(block.timestamp) + 2 * uint256(jobTimeout);
        for (uint8 i = 0; i < j.r.commits; i++) _hold(j.r.seat[i], hold);
        challenged.push(id);
        emit Challenged(id, msg.sender, msg.value);
        emit ChallengeClaim(id, j.chN + 1, claim);
    }

    function challengeCommit(uint256 id, bytes32 commitment) external delegated {
        _job(id);
        (Challenge storage ch, uint8 round) = _latest(id);
        if (ch.state != ChallengeState.Open) revert Closed();
        _take(id, ch.r, round, commitment);
        emit ChallengeCommitted(id, msg.sender);
    }

    function challengeReveal(uint256 id, bytes32 verdict, bytes32 salt) external delegated {
        Job storage j = _job(id);
        (Challenge storage ch,) = _latest(id);
        Round storage r = ch.r;
        if (ch.state == ChallengeState.Open) _revealOpen(r);
        else if (ch.settleAt == 0 || block.timestamp >= ch.settleAt) revert Closed();
        uint8 same = _reveal(r, verdict, salt);
        emit ChallengeRevealed(id, msg.sender, verdict);

        if (ch.state != ChallengeState.Open) {
            bool ok = verdict == ch.result;
            if (ok) j.agreedBy += 1;
            _judge(msg.sender, ok);
            if (r.reveals == r.commits) { ch.settleAt = 0; emit Settled(id); }
            return;
        }
        if (same >= QUORUM) _resolve(id, j, ch, verdict);
        else if (r.reveals == r.commits && (r.commits == SEATS || block.timestamp >= r.start + commitWindow)) _dispute(id, j, ch, false);
    }

    function challengeExpire(uint256 id) external delegated {
        Job storage j = _job(id);
        (Challenge storage ch,) = _latest(id);
        if (ch.state != ChallengeState.Open) revert Closed();
        if (block.timestamp < ch.r.start + jobTimeout) revert TooEarly();
        _dispute(id, j, ch, true);
    }

    /// The round reached a quorum on `verdict`. Only credits move (no calls out).
    function _resolve(uint256 id, Job storage j, Challenge storage ch, bytes32 verdict) private {
        Round storage r1 = j.r;
        Round storage r2 = ch.r;
        ch.result = verdict;
        bytes32 old = j.result;
        bool overturned = verdict != old;
        ch.state = overturned ? ChallengeState.Overturned : ChallengeState.Confirmed;
        uint256 pot = ch.bond; // shared by the payees below (the challenger's part comes off first)
        if (overturned) {
            j.result = verdict;
            uint256 slashed;
            for (uint8 i = 0; i < r1.commits; i++) {
                if (!r1.revealed[i] || r1.verdictOf[i] != old) continue;
                address w = r1.seat[i];
                workers[w].rejected += 1;
                slashed += _penalize(w, CHALLENGE_SLASH_BPS, false);
                _record(w, true);
            }
            if (verdict == ch.claim) {
                // The challenger was right: bond back plus half of the slash.
                uint256 toChallenger = slashed / 2;
                credit[ch.challenger] += ch.bond + toChallenger;
                pot = slashed - toChallenger;
            } else {
                // Overturned, but not to what the challenger said: its bond is lost too.
                pot += slashed;
            }
        }
        uint8 n1;
        for (uint8 i = 0; i < r1.commits; i++) if (r1.revealed[i] && r1.verdictOf[i] == verdict) n1++;
        uint8 n2;
        for (uint8 i = 0; i < r2.commits; i++) if (r2.revealed[i] && r2.verdictOf[i] == verdict) n2++;
        // Confirmed: half for this round, half for round 1's winners. Overturned:
        // one equal share each for this round's winners and vindicated round-1 seats.
        uint256 s2;
        uint256 s1;
        if (overturned) {
            s1 = s2 = pot / (uint256(n1) + n2);
            j.agreedBy = n1 + n2;
        } else {
            s2 = (pot / 2) / n2;
            s1 = (pot - pot / 2) / n1;
            j.agreedBy += n2;
        }
        uint256 paid;
        for (uint8 i = 0; i < r1.commits; i++) {
            if (r1.revealed[i] && r1.verdictOf[i] == verdict) { credit[r1.seat[i]] += s1; paid += s1; }
        }
        for (uint8 i = 0; i < r2.commits; i++) {
            address w = r2.seat[i];
            if (r2.revealed[i] && r2.verdictOf[i] == verdict) { credit[w] += s2; paid += s2; _judge(w, true); }
            else if (r2.revealed[i]) _judge(w, false);
            else ch.settleAt = uint64(block.timestamp) + commitWindow;
        }
        _toCommunity(pot - paid); // rounding dust
        emit ChallengeResolved(id, ch.state, verdict);
    }

    /// No quorum: DISPUTE_KEEP_BPS of the bond goes to the seats that
    /// revealed (or the community fund), the rest back; the verdict stands,
    /// Disputed, and a new challenge may open (up to MAX_CHALLENGES).
    function _dispute(uint256 id, Job storage j, Challenge storage ch, bool timedOut) private {
        ch.state = ChallengeState.Disputed;
        Round storage r = ch.r;
        uint256 keep = (ch.bond * DISPUTE_KEEP_BPS) / 10_000;
        credit[ch.challenger] += ch.bond - keep;
        uint256 share = r.reveals == 0 ? 0 : keep / r.reveals;
        for (uint8 i = 0; i < r.commits; i++) {
            if (r.revealed[i]) credit[r.seat[i]] += share;
            else if (timedOut) _miss(id, r.seat[i]);
        }
        _toCommunity(keep - share * r.reveals);
        // Another challenge may open for one more challenge window; round-1
        // bonds stay through it. At the cap the window closes now.
        if (j.chN < MAX_CHALLENGES) {
            j.challengeUntil = uint64(block.timestamp + _challengeWindow());
            _holdRound1(j);
        } else if (j.challengeUntil > block.timestamp) {
            j.challengeUntil = uint64(block.timestamp);
        }
        emit ChallengeResolved(id, ChallengeState.Disputed, j.result);
    }
}

/// @title NeuroJobs: the Neuro ZETAPHY job market (testnet, stage 1-2)
/// @notice Someone asks for a contract to be checked and pays a fee in ZETAPHY.
///         Up to three bonded node runners each compute Neuro's verdict on their
///         own machine. The verdict stands once two of them agree, and those two
///         share the fee plus a reward from the pool.
///
///         Commit-reveal stops a runner from copying another's answer: runners
///         first post keccak256(verdict, runner, salt), and reveal only after
///         all seats are taken or the commit window closes, and before the
///         round's hard deadline (start + jobTimeout).
///
///         Payouts are credited, then pulled with withdraw() (no ETH is pushed
///         to arbitrary addresses inside the job logic).
///
///         Seats are not first-come: per job, a lottery weighted by bond
///         decides who may commit (eligible()). Only runners that registered
///         before the job count, and splitting one bond over many addresses
///         does not raise the odds. The denominator (totalActiveBond) is
///         snapshotted when the round opens, so bonds registered or withdrawn
///         later cannot push drawn runners out. Pool rewards are capped at a
///         quarter of the fee per winner and per day, so requesting jobs for
///         oneself does not pay.
///
///         Lottery bound to a block nobody picks: a request records nothing
///         random. For a round opened in block B:
///           rand = keccak256(seed, blockhash(B + 1), round)
///         usable from block B + 2. seed comes from the request (requester,
///         chain, target, time, the requester's own counter). The value is
///         fixed once B + 1 exists, whoever computes it and whenever: a commit
///         that reverts (NotChosen) and is retried every block, or a contract
///         that calls draw() only when it likes the outcome, gets the same
///         rand. eligible() computes it lazily (a view); the first commit or
///         draw(id) stores it. Limits: (a) blockhash only covers 256 blocks;
///         if nobody stored the draw by then, draw() moves the round to the
///         current block (Redrawn) and a new block hash decides; a party
///         that dislikes the draw cannot cause this while any runner is
///         watching, as any draw()/commit stores it. (b) The proposer of
///         block B + 1 can grind that block's contents (and so its hash) and
///         try many candidates: that is the remaining bias, a validator one.
///         (c) A chain whose BLOCKHASH returns 0 inside the window (old
///         zetaphyd) uses keccak256(seed, 1, round): it works, and is as
///         predictable as the request data alone (the unit-test EVM now gives
///         block hashes; zetaphyd v3+ does too).
///
///         Fee: 90% to the runners whose verdict stood, 5% burned (sent to
///         0x…dEaD, locked forever), 5% to the community fund (credited; it
///         withdraws like a runner). Rounding dust goes to the community
///         fund, so fee = runners + burned + community to the wei. A failed
///         or expired job refunds the fee minus FAIL_BURN_BPS (5%), which is
///         burned: whoever makes fake or unanswerable requests pays for them.
///
///         Bodies (runners eligible per job) are elastic:
///           bodies = DEFENDERS + ceil(requests per minute / CAPACITY_PER_BODY)
///         capped by NeuroControl.maxBodies(). Requests per minute is the
///         busiest recent minute, fading linearly to zero over DECAY_MINUTES.
///         Only requests that pass every check count, and with a NeuroControl
///         only chains on its allowlist (chainAllowed) are accepted.
///
///         Immune system: 4 defender seats, filled by regrow() (anyone may
///         call it) from NeuroControl's voted roster, at most
///         maxRegrowPerHour refills per hour. Defenders do not go by the
///         lottery, and at most ONE defender sits on any round, in every
///         phase of the window, unless no active runner is anything but a
///         seated defender (then defenders fill the seats, so jobs never
///         stall). Runners call heartbeat() (a commit or reveal counts too);
///         a defender silent for longer than NeuroControl.defenderTimeout()
///         stops being a defender at once and loses its seat at regrow().
///
///         Strikes: a rejected verdict, and a seat that committed but never
///         revealed, each cost PENALTY_BPS of the bond and a strike.
///         QUARANTINE_AFTER strikes within a runner's last STRIKE_WINDOW
///         judged seats put it in quarantine: not active, out of
///         totalActiveBond, unbonding, defender seat vacated, register()
///         refused until governance releases it (NeuroControl.release).
///         A penalty that leaves the bond below workerBond also deactivates
///         the runner and starts its unbond timer (withdrawBond after
///         unbondDelay and heldUntil; register() again to top up instead).
///
///         Unrevealed seats: once a quorum forms, a seat that has not
///         revealed yet gets a grace of commitWindow seconds to reveal. After
///         the grace anyone may call settle(id): every seat still unrevealed
///         gets the penalty and a strike. A job that times out (expire())
///         does the same at once.
///
///         Bond holds: a seat's bond stays (heldUntil) until start +
///         2 x jobTimeout of every round it sat on, and a round-1 seat's until
///         challengeUntil + 2 x jobTimeout, moved on when a challenge opens or
///         ends Disputed. Every reveal has a hard deadline, so every slash
///         lands before the hold ends. A seat committed and not yet revealed
///         or penalised also holds the bond (openSeats): withdrawBond waits
///         until expire()/settle()/challengeExpire() resolved it, whenever
///         they are called (the runner may call them itself), so the
///         non-reveal penalty cannot be escaped by a quiet keeper (NJ-1).
///
///         Challenges: until challengeUntil (finalize time + challengeWindow,
///         or jobTimeout when 0) anyone may call challenge(id, claim) with a
///         bond of at least max(2 x fee, NeuroControl.challengeBond()) and
///         the verdict it says is right (claim, not the current result). That
///         opens a challenge round: 3 fresh seats by the same lottery (its own
///         start block), never a seat of an earlier round nor any challenger
///         so far; commit-reveal and 2 of 3, hard deadline start + jobTimeout.
///           - Overturned to the claim: each round-1 runner that revealed the
///             overturned verdict loses CHALLENGE_SLASH_BPS (50%) of its bond
///             and gets a strike; the challenger gets its bond back plus half
///             the slash; the other half goes to the round's winners and the
///             round-1 seats that had revealed the new verdict.
///           - Overturned to a verdict that is neither the old one nor the
///             claim: the same slash, but the challenger's whole bond joins
///             the pot (it was wrong too).
///           - Confirmed: the challenger's bond is shared, half by the round's
///             winners, half by round 1's winners.
///           - No quorum (all revealed and none agree, or challengeExpire
///             after jobTimeout): DISPUTE_KEEP_BPS (20%) of the bond goes to
///             the round's seats that revealed (the community fund if none),
///             80% back; the verdict stands, Disputed, and a new challenge may
///             open within a fresh challenge window, up to MAX_CHALLENGES (2)
///             challenges: 3 rounds in all. So a challenge that ends nowhere
///             costs 20% and does not lock out real challengers.
///         Rounding dust always goes to the community fund (to the wei).
///
///         The challenge entry points run in NeuroJobsChallenges (deployed by
///         this constructor) through delegatecall, so NeuroJobs stays under
///         the 24,576-byte code limit; same storage, same address, same ABI.
///
///         NeuroControl's paused() stops new requests, challenges and commits
///         only; reveals, expiry, refunds and withdrawals keep working.
///         Without a NeuroControl nothing is paused, jobs carry skill 0, any
///         chain key is accepted, there are no defenders, bodies are uncapped,
///         challenges need 2 x fee and last jobTimeout, and the community share
///         goes to the reward pool.
contract NeuroJobs is NeuroJobsBase {
    /// The challenge logic (NeuroJobsChallenges), deployed by the constructor.
    address public immutable challengeLogic;

    constructor(uint256 bond_, uint256 reward_, uint256 minFee_, uint64 commitWindow_, uint64 timeout_, uint64 unbondDelay_, uint256 dailyRewardCap_)
        NeuroJobsBase(bond_, reward_, minFee_, commitWindow_, timeout_, unbondDelay_, dailyRewardCap_)
    {
        challengeLogic = address(new NeuroJobsChallenges(bond_, reward_, minFee_, commitWindow_, timeout_, unbondDelay_, dailyRewardCap_));
    }

    /// Wires in NeuroControl. Once, by the deployer.
    function setControl(INeuroKnobs control_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(control) != address(0) || address(control_) == address(0)) revert BadValue();
        control = control_;
        emit ControlSet(address(control_));
    }

    // ---- pool and runners ----

    function fund() external payable {
        if (msg.value == 0) revert BadValue();
        rewardPool += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// Joins, or comes back (tops up a bond below workerBond, or cancels
    /// unbonding). Only later jobs count it (since = now).
    function register() external payable {
        Worker storage w = workers[msg.sender];
        if (w.active) revert AlreadyIn();
        if (quarantined(msg.sender)) revert InQuarantine();
        uint256 bond = uint256(w.bond) + msg.value;
        if (bond < workerBond) revert BadValue();
        w.bond = uint128(bond);
        w.active = true;
        w.unbondAt = 0;
        w.since = uint64(block.timestamp);
        w.lastSeen = uint64(block.timestamp);
        activeWorkers += 1;
        totalActiveBond += bond;
        emit Registered(msg.sender, bond);
    }

    /// "Still here": keeps a defender seat (see defenderTimeout). Costs only gas.
    function heartbeat() external {
        Worker storage w = workers[msg.sender];
        if (!w.active) revert NotWorker();
        w.lastSeen = uint64(block.timestamp);
    }

    function requestUnbond() external {
        if (!workers[msg.sender].active) revert NotWorker();
        _deactivate(msg.sender);
    }

    /// After unbondDelay, and after heldUntil (see bond holds).
    function withdrawBond() external {
        Worker storage w = workers[msg.sender];
        if (w.active || w.unbondAt == 0 || block.timestamp < w.unbondAt || block.timestamp < w.heldUntil
            || openSeats[msg.sender] != 0) revert TooEarly();
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
    /// @param target  address on that chain, at most MAX_TARGET bytes
    function request(bytes32 chain, string calldata target) external payable returns (uint256 id) {
        return _request(msg.sender, chain, target);
    }

    /// Same as request(), but a refund goes to `refundTo` (StableGateway).
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
            if (!control.chainAllowed(chain)) revert UnknownChain();
        }
        _countRequest();
        id = jobs.length;
        Job storage j = jobs.push();
        j.requester = requester;
        _open(j.r);
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

    /// Stores the lottery of the round taking seats (round 1 while the job
    /// is open, else the open challenge round). Anyone; once per round; from
    /// block startBlock + 2. If the lottery block fell out of the 256-block
    /// window unused, moves the round to this block instead (Redrawn).
    function draw(uint256 id) external {
        Job storage j = _job(id);
        (Challenge storage ch, uint8 round) = _latest(id);
        Round storage r;
        if (j.status == Status.Open && j.r.rand == 0) { r = j.r; round = 1; }
        else if (ch.state == ChallengeState.Open && ch.r.rand == 0) r = ch.r;
        else revert Nothing();
        bytes32 x = _rand(j.seed, r, round);
        if (x == 0) {
            if (block.number <= uint256(r.startBlock) + 1) revert TooEarly();
            r.startBlock = uint64(block.number);
            emit Redrawn(id, round, r.startBlock);
            return;
        }
        r.rand = x;
        emit Drawn(id, round, x);
    }

    /// @param commitment keccak256(abi.encode(verdict, msg.sender, salt))
    function commit(uint256 id, bytes32 commitment) external {
        Job storage j = _job(id);
        if (j.status != Status.Open) revert Closed();
        _take(id, j.r, 1, commitment);
        emit Committed(id, msg.sender);
    }

    /// Also open after a quorum, until settleAt, for a seat that had not
    /// revealed yet: it is judged against the result (no fee share).
    function reveal(uint256 id, bytes32 verdict, bytes32 salt) external {
        Job storage j = _job(id);
        Round storage r = j.r;
        if (j.status == Status.Open) _revealOpen(r);
        else if (j.settleAt == 0 || block.timestamp >= j.settleAt) revert Closed();
        uint8 same = _reveal(r, verdict, salt);
        emit Revealed(id, msg.sender, verdict);

        if (j.status != Status.Open) {
            // Late reveal inside the grace after a quorum.
            bool ok = verdict == j.result;
            if (ok) j.agreedBy += 1;
            _judge(msg.sender, ok);
            if (r.reveals == r.commits) { j.settleAt = 0; emit Settled(id); }
            return;
        }

        if (same >= QUORUM) _finalize(id, j, verdict);
        else if (r.reveals == r.commits && (r.commits == SEATS || block.timestamp >= r.start + commitWindow)) {
            // Everyone who committed has revealed and no two agree.
            _fail(id, j, false);
        }
    }

    /// Anyone can close a job that ran out of time without a quorum.
    function expire(uint256 id) external {
        Job storage j = _job(id);
        if (j.status != Status.Open) revert Closed();
        if (block.timestamp < j.r.start + jobTimeout) revert TooEarly();
        _fail(id, j, true);
    }

    /// Anyone, once the reveal grace after a quorum is over (in round 1 or
    /// the latest challenge round): every seat that committed and still has
    /// not revealed gets the penalty and a strike.
    function settle(uint256 id) external {
        Job storage j = _job(id);
        (Challenge storage ch,) = _latest(id);
        bool any;
        if (_settleRound(id, j.r, j.settleAt)) { j.settleAt = 0; any = true; }
        if (_settleRound(id, ch.r, ch.settleAt)) { ch.settleAt = 0; any = true; }
        if (!any) {
            if (j.settleAt != 0 || ch.settleAt != 0) revert TooEarly();
            revert Nothing();
        }
        emit Settled(id);
    }

    // ---- challenge rounds (NeuroJobsChallenges, by delegatecall) ----

    /// Opens a challenge round (see above). The whole msg.value is the bond;
    /// `claim` is the verdict the challenger says is right.
    function challenge(uint256, bytes32) external payable { _delegate(); }
    function challengeCommit(uint256, bytes32) external { _delegate(); }
    /// Like reveal(), for a seat of the open (or just decided) challenge round.
    function challengeReveal(uint256, bytes32, bytes32) external { _delegate(); }
    /// Anyone, jobTimeout after the challenge opened, if the round found no quorum.
    function challengeExpire(uint256) external { _delegate(); }

    function _delegate() private {
        address impl = challengeLogic;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    // ---- views ----

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function challengeCount() external view returns (uint256) {
        return challenged.length;
    }

    function getJob(uint256 id) external view returns (
        address requester, uint64 created, Status status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat
    ) {
        Job storage j = _job(id);
        return (j.requester, j.r.start, j.status, j.chain, j.target, j.fee, j.result, j.r.commits, j.r.reveals, j.r.seat);
    }

    /// May `w` take a round-1 seat on job `id` right now? False until the
    /// lottery block exists (startBlock + 2). A seated defender may if no
    /// defender sits on the job yet (or only defenders are active). Everyone
    /// else goes by a bond-weighted lottery: about `drawn` runners qualify
    /// at first, twice as many (at least 2 x SEATS) after the first third
    /// of the commit window, and every runner in the last third. Only
    /// runners active since before the job, never quarantined ones.
    function eligible(uint256 id, address w) external view returns (bool ok) {
        if (id >= jobs.length) return false;
        (ok,) = _eligible(id, jobs[id].r, w, 1);
    }

    /// Same for the open challenge round: never a seat of an earlier round or a challenger.
    function challengeEligible(uint256 id, address w) external view returns (bool ok) {
        if (id >= jobs.length) return false;
        (Challenge storage ch, uint8 round) = _latest(id);
        if (ch.state != ChallengeState.Open) return false;
        (ok,) = _eligible(id, ch.r, w, round);
    }

    /// The skill a job was requested under, its body counts, when the reveal
    /// grace after a quorum ends (0 = nothing pending), and its round-1
    /// lottery (0 = not available yet; computed even before anyone stores it).
    function jobInfo(uint256 id) external view returns (bytes32 skill, uint256 bodies_, uint256 drawn, uint64 settleAt, bytes32 rand) {
        Job storage j = _job(id);
        return (j.skill, j.bodies, j.drawn, j.settleAt, _rand(j.seed, j.r, 1));
    }

    /// How sure the verdict is: `agreedBy` distinct runners revealed it, the
    /// latest challenge state, until when it can be challenged, and
    /// `settled`: no challenge is possible or running any more.
    function assurance(uint256 id) external view returns (uint8 agreedBy, ChallengeState state, uint64 challengeUntil, bool settled) {
        Job storage j = _job(id);
        (Challenge storage ch,) = _latest(id);
        state = ch.state;
        settled = j.status == Status.Done && state != ChallengeState.Open
            && (state == ChallengeState.Confirmed || state == ChallengeState.Overturned || block.timestamp >= j.challengeUntil);
        return (j.agreedBy, state, j.challengeUntil, settled);
    }

    /// The latest challenge round of job `id` (see challengeRound for which one).
    function challengeInfo(uint256 id) external view returns (
        address challenger, ChallengeState state, uint256 bond, uint64 start, bytes32 rand,
        uint8 commits, uint8 reveals, address[3] memory seat, bytes32 result, uint64 settleAt
    ) {
        _job(id);
        (Challenge storage ch, uint8 round) = _latest(id);
        rand = _rand(jobs[id].seed, ch.r, round);
        challenger = ch.challenger;
        state = ch.state;
        bond = ch.bond;
        start = ch.r.start;
        commits = ch.r.commits;
        reveals = ch.r.reveals;
        seat = ch.r.seat;
        result = ch.result;
        settleAt = ch.settleAt;
    }

    /// How many challenges job `id` has had (the latest is round count + 1)
    /// and what the latest challenger claimed.
    function challengeRound(uint256 id) external view returns (uint8 count, bytes32 claim) {
        _job(id);
        (Challenge storage ch,) = _latest(id);
        return (jobs[id].chN, ch.claim);
    }

    /// Requests per minute right now, times DECAY_MINUTES.
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

    function defenders() external view returns (address[4] memory) {
        return defender;
    }

    // ---- immune system ----

    /// Anyone may call it. Vacates defender seats whose runner is no longer
    /// fit, then refills empty seats from NeuroControl's roster, at most
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

    // ---- internals ----

    function _finalize(uint256 id, Job storage j, bytes32 verdict) private {
        Round storage r = j.r;
        j.status = Status.Done;
        j.result = verdict;
        j.challengeUntil = uint64(block.timestamp + _challengeWindow());
        uint8 winners = 0;
        for (uint8 i = 0; i < r.commits; i++) if (r.revealed[i] && r.verdictOf[i] == verdict) winners++;
        j.agreedBy = winners;
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
        // Every round-1 seat may be slashed by a challenge: its bond stays until then.
        _holdRound1(j);
        for (uint8 i = 0; i < r.commits; i++) {
            address w = r.seat[i];
            if (r.revealed[i] && r.verdictOf[i] == verdict) {
                uint256 pay = share;
                if (reward > 0 && rewardPool >= reward && rewardedToday + reward <= dailyRewardCap) {
                    rewardPool -= reward;
                    rewardedToday += reward;
                    pay += reward;
                }
                credit[w] += pay;
                _judge(w, true);
            } else if (r.revealed[i]) {
                _judge(w, false);
            } else {
                // Not revealed yet: a grace to reveal, then settle() judges it.
                j.settleAt = uint64(block.timestamp) + commitWindow;
            }
        }
        _toCommunity(fundCut);
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
        uint256 burnCut = (j.fee * FAIL_BURN_BPS) / 10_000;
        credit[j.requester] += j.fee - burnCut;
        if (timedOut) {
            for (uint8 i = 0; i < j.r.commits; i++) if (!j.r.revealed[i]) _miss(id, j.r.seat[i]);
        }
        totalBurned += burnCut;
        emit FeeSplit(id, 0, burnCut, 0);
        emit JobFailed(id);
        // Last: BURN has no code, so this cannot call back.
        if (burnCut > 0) {
            (bool ok,) = BURN.call{value: burnCut}("");
            require(ok, "burn failed");
        }
    }

    function _seated(address w) private view returns (bool) {
        for (uint256 i = 0; i < DEFENDERS; i++) if (defender[i] == w) return true;
        return false;
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
}
