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
///         decides who may commit (eligible()). Only runners that registered
///         before the job count, and splitting one bond over many addresses
///         does not raise the odds. Pool rewards are capped at a quarter of
///         the fee per winner and per day, so requesting jobs for oneself
///         does not pay.
///
///         Unpredictable lottery: a request records nothing random. The
///         lottery is drawn later, once, by the first commit or by draw(id)
///         (anyone), in a block after the request block:
///           rand = keccak256(seed, block.prevrandao, round)
///         seed comes from the request (requester, chain, target, time, the
///         requester's own counter). On zetaphyd with the PQ certificate
///         patch, PREVRANDAO is derived from the previous block's ML-DSA
///         vote certificate, so the requester cannot know who will be
///         eligible when it sends the request. eligible() is false for
///         everyone until the draw. Where PREVRANDAO is constant (older
///         zetaphyd binaries, the unit-test EVM) the draw still works, and
///         the lottery is as predictable as the request data alone (the
///         behaviour before this change). Runners call draw() as soon as
///         they see a request, so a requester cannot wait for a block it
///         likes unless nobody else is watching.
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
///         busiest recent minute, fading linearly to zero over DECAY_MINUTES:
///         N requests in a minute count as N*(30-age)/30 after `age` whole
///         minutes, so with no use the extra bodies shrink step by step and
///         are gone after 30 minutes. Only requests that pass every check
///         count, and with a NeuroControl only chains on its allowlist
///         (chainAllowed) are accepted, so requests no runner can answer
///         cannot inflate the bodies; even refunded ones lose 5%.
///
///         Immune system: 4 defender seats, filled by regrow() (anyone may
///         call it) from NeuroControl's voted roster, at most
///         maxRegrowPerHour refills per hour. Defenders are always eligible,
///         but at most one defender sits on a round: a second may commit
///         only after the first third of the commit window, and only while
///         no drawn runner has committed (so two defenders cannot decide a
///         verdict together while the lottery has runners to offer).
///         Runners call heartbeat() (a commit or reveal counts too); a
///         defender silent for longer than NeuroControl.defenderTimeout()
///         stops being a defender at once, the next regrow() vacates its
///         seat, and regrow() seats it again only after a fresh heartbeat.
///
///         Strikes: a rejected verdict, and a seat that committed but never
///         revealed, each cost PENALTY_BPS of the bond and a strike.
///         QUARANTINE_AFTER strikes within a runner's last STRIKE_WINDOW
///         judged seats put it in quarantine (lying every other job does not
///         reset it). A quarantined runner stops being active at once: it
///         drops out of activeWorkers and totalActiveBond, so other
///         contracts reading workers() no longer count it, and its bond
///         starts unbonding (withdrawBond after unbondDelay, minus
///         penalties). Seats it already holds can still be revealed. Its
///         defender seat is vacated, and register() refuses the address
///         until governance releases it (NeuroControl.release).
///
///         Unrevealed seats: once a quorum forms, a seat that has not
///         revealed yet gets a grace of commitWindow seconds to reveal (it
///         is judged like the others, but the fee is already shared). After
///         the grace anyone may call settle(id): every seat still unrevealed
///         gets the penalty and a strike. A job that times out (expire())
///         does the same at once.
///
///         Challenge round: verdicts are deterministic, so anyone can re-run
///         Neuro and prove a bad pair wrong. Until challengeUntil (the
///         finalize time plus NeuroControl.challengeWindow(), or jobTimeout
///         when that is 0) anyone may call challenge(id) with a bond of at
///         least max(2 x fee, NeuroControl.challengeBond()). That opens round
///         2: 3 fresh seats, drawn with the same lottery (its own draw, in a
///         later block), never a round-1 seat or the challenger; commit-
///         reveal and 2 of 3 as in round 1. One challenge per job.
///           - Round 2 overturns round 1: each round-1 runner that revealed
///             the overturned verdict loses CHALLENGE_SLASH_BPS (50%) of its
///             bond and gets a strike. The challenger gets its bond back plus
///             half of the slashed sum; the other half is shared by round-2
///             winners and round-1 seats that had revealed the new verdict.
///             The job's result becomes round 2's.
///           - Round 2 confirms round 1: the challenger's bond is shared,
///             half by the round-2 winners, half by the round-1 winners.
///           - No quorum in round 2 (all revealed and none agree, or
///             jobTimeout passed: challengeExpire): the bond goes back, the
///             verdict stands but is marked Disputed.
///         Round 2 has the same reveal grace and settle() as round 1. A
///         round-1 runner's bond cannot be withdrawn until challengeUntil +
///         jobTimeout of every job it sat on, so a pair cannot leave before
///         a challenge is resolved. The fee shares of round 1 are paid at
///         once and are not taken back: the 50% slash is the deterrent.
///         Rounding dust always goes to the community fund (to the wei).
///         assurance(id) shows how many runners agreed with the final
///         verdict (2, 3, or 4+ after a confirmed challenge) and the
///         challenge state.
///
///         NeuroControl's paused() stops new requests, challenges and commits
///         only; reveals, expiry, refunds and withdrawals keep working. Each
///         job records the voted skill (activeSkill) it was requested under.
///
///         Without a NeuroControl (setControl never called) nothing is
///         paused, jobs carry skill 0, any chain key is accepted, there are
///         no defenders, bodies are uncapped, challenges need 2 x fee and
///         last jobTimeout, and the community share goes to the reward pool.
///         `zetaphy deploy` calls setControl right after deploying, so only
///         jobs slipped in during those blocks have skill 0: runners that
///         follow governance skip them, so they expire and refund (minus
///         the 5% slice).
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
        uint64 heldUntil; // bond stays until every job it sat on is past its challenge
    }

    /// One round of 3 seats (round 1 = the job, round 2 = a challenge).
    struct Round {
        uint8 commits;
        uint8 reveals;
        uint8 defenders;   // seats taken as a defender
        uint64 start;      // the commit window starts here
        uint64 startBlock; // the draw must come in a later block
        bytes32 rand;      // the lottery; 0 until drawn
        address[3] seat;
        bytes32[3] commitOf;
        bytes32[3] verdictOf;
        bool[3] revealed;
    }

    struct Job {
        address requester;
        Status status;
        uint8 agreedBy;  // distinct runners that revealed the final verdict
        uint16 bodies;   // bodies when requested
        uint16 drawn;    // of which drawn by lottery (bodies minus seated defenders)
        uint64 settleAt; // quorum reached with seats unrevealed: grace ends here (0 = nothing pending)
        uint64 challengeUntil; // set when the quorum forms
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
    Job[] internal jobs;
    mapping(uint256 => Challenge) internal challenges;
    /// Ids of challenged jobs, in order (runners scan it for round-2 seats).
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
    event Challenged(uint256 indexed id, address indexed challenger, uint256 bond);
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

    /// Wires in NeuroControl. Once, by the deployer. Jobs requested before
    /// it keep skill 0 (see above), so a request slipped in first cannot
    /// block it.
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

    function register() external payable {
        Worker storage w = workers[msg.sender];
        if (w.active) revert AlreadyIn();
        if (w.unbondAt != 0) revert TooEarly(); // finish leaving first
        if (quarantined(msg.sender)) revert InQuarantine();
        uint256 bond = uint256(w.bond) + msg.value;
        if (bond < workerBond) revert BadValue();
        w.bond = uint128(bond);
        w.active = true;
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

    /// Also waits for heldUntil: the challenge window (and a challenge round)
    /// of every job the runner sat on.
    function withdrawBond() external {
        Worker storage w = workers[msg.sender];
        if (w.active || w.unbondAt == 0 || block.timestamp < w.unbondAt || block.timestamp < w.heldUntil) revert TooEarly();
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
            if (!control.chainAllowed(chain)) revert UnknownChain();
        }
        _countRequest();
        id = jobs.length;
        Job storage j = jobs.push();
        j.requester = requester;
        j.r.start = uint64(block.timestamp);
        j.r.startBlock = uint64(block.number);
        // Not the job id: jobs slipped in first must not move the seed.
        // Nothing random yet: the lottery is drawn in a later block (draw()).
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

    /// Draws the lottery of the round now taking seats (round 1 while the
    /// job is open, else an open challenge's round 2). Anyone may; once per
    /// round; only in a block after the request (or challenge) block. The
    /// first commit draws too.
    function draw(uint256 id) external {
        Job storage j = _job(id);
        Challenge storage ch = challenges[id];
        if (j.status == Status.Open && j.r.rand == 0) _draw(id, j, j.r, 1);
        else if (ch.state == ChallengeState.Open && ch.r.rand == 0) _draw(id, j, ch.r, 2);
        else revert Nothing();
    }

    /// @param commitment keccak256(abi.encode(verdict, msg.sender, salt))
    function commit(uint256 id, bytes32 commitment) external {
        Job storage j = _job(id);
        if (j.status != Status.Open) revert Closed();
        _take(id, j, j.r, 1, commitment);
        emit Committed(id, msg.sender);
    }

    /// Also open after a quorum, until settleAt, for a seat that had not
    /// revealed yet: it is judged against the result (no fee share).
    function reveal(uint256 id, bytes32 verdict, bytes32 salt) external {
        Job storage j = _job(id);
        Round storage r = j.r;
        if (j.status == Status.Open) {
            if (r.commits < SEATS && block.timestamp < r.start + commitWindow) revert TooEarly();
        } else if (j.settleAt == 0 || block.timestamp >= j.settleAt) {
            revert Closed();
        }
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

        // Quorum: this verdict matches QUORUM-1 earlier reveals.
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
    /// a challenge's round 2): every seat that committed and still has not
    /// revealed gets the penalty and a strike.
    function settle(uint256 id) external {
        Job storage j = _job(id);
        Challenge storage ch = challenges[id];
        bool any;
        if (_settleRound(id, j.r, j.settleAt)) { j.settleAt = 0; any = true; }
        if (_settleRound(id, ch.r, ch.settleAt)) { ch.settleAt = 0; any = true; }
        if (!any) {
            if (j.settleAt != 0 || ch.settleAt != 0) revert TooEarly();
            revert Nothing();
        }
        emit Settled(id);
    }

    // ---- challenge round ----

    /// The least bond challenge(id) takes: max(2 x fee, NeuroControl.challengeBond()).
    function challengeBondOf(uint256 id) public view returns (uint256 b) {
        b = _job(id).fee * CHALLENGE_FEE_MULTIPLE;
        if (address(control) != address(0)) {
            uint256 floor_ = control.challengeBond();
            if (floor_ > b) b = floor_;
        }
    }

    /// Anyone who re-ran Neuro and got another verdict: opens round 2 (see
    /// above). The whole msg.value is the bond. Once per job, before
    /// challengeUntil.
    function challenge(uint256 id) external payable {
        Job storage j = _job(id);
        Challenge storage ch = challenges[id];
        if (j.status != Status.Done || block.timestamp >= j.challengeUntil) revert Closed();
        if (ch.state != ChallengeState.None) revert AlreadyIn();
        if (_paused()) revert Paused();
        if (msg.value < challengeBondOf(id)) revert BadValue();
        ch.challenger = msg.sender;
        ch.state = ChallengeState.Open;
        ch.bond = msg.value;
        ch.r.start = uint64(block.timestamp);
        ch.r.startBlock = uint64(block.number);
        challenged.push(id);
        emit Challenged(id, msg.sender, msg.value);
    }

    function challengeCommit(uint256 id, bytes32 commitment) external {
        Job storage j = _job(id);
        Challenge storage ch = challenges[id];
        if (ch.state != ChallengeState.Open) revert Closed();
        _take(id, j, ch.r, 2, commitment);
        emit ChallengeCommitted(id, msg.sender);
    }

    /// Like reveal(), for a round-2 seat (with the same grace after its quorum).
    function challengeReveal(uint256 id, bytes32 verdict, bytes32 salt) external {
        Job storage j = _job(id);
        Challenge storage ch = challenges[id];
        Round storage r = ch.r;
        if (ch.state == ChallengeState.Open) {
            if (r.commits < SEATS && block.timestamp < r.start + commitWindow) revert TooEarly();
        } else if (ch.settleAt == 0 || block.timestamp >= ch.settleAt) {
            revert Closed();
        }
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
        else if (r.reveals == r.commits && (r.commits == SEATS || block.timestamp >= r.start + commitWindow)) _dispute(id, ch, false);
    }

    /// Anyone, jobTimeout after the challenge, if round 2 found no quorum:
    /// the challenger's bond goes back, the verdict stands (Disputed), and
    /// round-2 seats that never revealed are penalized.
    function challengeExpire(uint256 id) external {
        _job(id);
        Challenge storage ch = challenges[id];
        if (ch.state != ChallengeState.Open) revert Closed();
        if (block.timestamp < ch.r.start + jobTimeout) revert TooEarly();
        _dispute(id, ch, true);
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
    /// lottery is drawn (draw()). A seated defender may if no defender sits
    /// on the job yet (or, after the first third of the commit window, if
    /// only defenders have committed). Everyone else goes by a bond-weighted
    /// lottery: about `drawn` runners (the job's bodies minus seated
    /// defenders) qualify at first, twice as many (at least 2 x SEATS)
    /// after the first third of the commit window, and every runner in the
    /// last third, so seats always fill while runners are online, whatever
    /// the draw. Only runners active since before the job, never
    /// quarantined ones.
    function eligible(uint256 id, address w) public view returns (bool ok) {
        if (id >= jobs.length) return false;
        (ok,) = _eligible(id, jobs[id].r, w, 1);
    }

    /// Same for round 2 of a challenge: never a round-1 seat or the challenger.
    function challengeEligible(uint256 id, address w) external view returns (bool ok) {
        if (id >= jobs.length) return false;
        Challenge storage ch = challenges[id];
        if (ch.state != ChallengeState.Open) return false;
        (ok,) = _eligible(id, ch.r, w, 2);
    }

    /// The skill a job was requested under, its body counts, when the reveal
    /// grace after a quorum ends (0 = nothing pending), and its round-1
    /// lottery (0 = not drawn yet).
    function jobInfo(uint256 id) external view returns (bytes32 skill, uint256 bodies_, uint256 drawn, uint64 settleAt, bytes32 rand) {
        Job storage j = _job(id);
        return (j.skill, j.bodies, j.drawn, j.settleAt, j.r.rand);
    }

    /// How sure the verdict is: `agreedBy` distinct runners revealed it (2
    /// or 3 after round 1; plus round 2's after a confirmed challenge), the
    /// challenge state, until when it can be challenged, and `settled`:
    /// no challenge is possible or running any more.
    function assurance(uint256 id) external view returns (uint8 agreedBy, ChallengeState state, uint64 challengeUntil, bool settled) {
        Job storage j = _job(id);
        state = challenges[id].state;
        settled = j.status == Status.Done && state != ChallengeState.Open && (state != ChallengeState.None || block.timestamp >= j.challengeUntil);
        return (j.agreedBy, state, j.challengeUntil, settled);
    }

    function challengeInfo(uint256 id) external view returns (
        address challenger, ChallengeState state, uint256 bond, uint64 start, bytes32 rand,
        uint8 commits, uint8 reveals, address[3] memory seat, bytes32 result, uint64 settleAt
    ) {
        _job(id);
        Challenge storage ch = challenges[id];
        Round storage r = ch.r;
        return (ch.challenger, ch.state, ch.bond, r.start, r.rand, r.commits, r.reveals, r.seat, ch.result, ch.settleAt);
    }

    /// Strikes within the runner's last STRIKE_WINDOW judged seats.
    function strikes(address w) public view returns (uint256 n) {
        for (uint8 r = workers[w].recent; r != 0; r >>= 1) n += r & 1;
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

    /// Seated in a defender seat and still fit for it (incl. a recent heartbeat).
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
    /// fit (removed from the roster, quarantined, unbonded, below the bond,
    /// or silent for longer than defenderTimeout), then refills empty seats
    /// from NeuroControl's roster, at most maxRegrowPerHour refills per
    /// clock hour.
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

    function _job(uint256 id) private view returns (Job storage) {
        if (id >= jobs.length) revert BadJob();
        return jobs[id];
    }

    function _paused() private view returns (bool) {
        return address(control) != address(0) && control.paused();
    }

    function _draw(uint256 id, Job storage j, Round storage r, uint8 round) private {
        if (block.number <= r.startBlock) revert TooEarly();
        r.rand = keccak256(abi.encode(j.seed, block.prevrandao, round));
        emit Drawn(id, round, r.rand);
    }

    /// Takes a seat in round `round` (1 or 2) for msg.sender.
    function _take(uint256 id, Job storage j, Round storage r, uint8 round, bytes32 commitment) private {
        Worker storage wk = workers[msg.sender];
        if (!wk.active) revert NotWorker();
        if (_paused()) revert Paused();
        if (block.timestamp >= r.start + commitWindow || r.commits == SEATS) revert NoSeat();
        if (r.rand == 0) _draw(id, j, r, round);
        (bool ok, bool asDefender) = _eligible(id, r, msg.sender, round);
        if (!ok) revert NotChosen();
        for (uint8 i = 0; i < r.commits; i++) if (r.seat[i] == msg.sender) revert AlreadyIn();
        r.seat[r.commits] = msg.sender;
        r.commitOf[r.commits] = commitment;
        r.commits += 1;
        if (asDefender) r.defenders += 1;
        wk.lastSeen = uint64(block.timestamp);
    }

    /// Checks msg.sender's commitment; returns how many revealed seats now
    /// hold this verdict (itself included).
    function _reveal(Round storage r, bytes32 verdict, bytes32 salt) private returns (uint8 same) {
        uint8 s = _seatOf(r, msg.sender);
        if (r.revealed[s]) revert AlreadyIn();
        if (keccak256(abi.encode(verdict, msg.sender, salt)) != r.commitOf[s]) revert BadReveal();
        r.revealed[s] = true;
        r.verdictOf[s] = verdict;
        r.reveals += 1;
        workers[msg.sender].lastSeen = uint64(block.timestamp);
        for (uint8 i = 0; i < r.commits; i++) if (r.revealed[i] && r.verdictOf[i] == verdict) same++;
    }

    /// (eligible, as a defender) for round `round` of job `id`. Round 2
    /// excludes the challenger and every round-1 seat.
    function _eligible(uint256 id, Round storage r, address w, uint8 round) private view returns (bool, bool) {
        Job storage j = jobs[id];
        Worker storage wk = workers[w];
        uint256 total = totalActiveBond;
        if (r.rand == 0 || !wk.active || wk.since >= r.start || total == 0 || quarantined(w)) return (false, false);
        if (round == 2) {
            if (w == challenges[id].challenger) return (false, false);
            for (uint8 i = 0; i < j.r.commits; i++) if (j.r.seat[i] == w) return (false, false);
        }
        uint256 elapsed = block.timestamp - r.start;
        // A defender never goes by the lottery: one per round, more only
        // after the first third of the window while no drawn runner has come.
        if (isDefender(w)) return (r.defenders == 0 || (elapsed * 3 >= commitWindow && r.commits == r.defenders), true);
        uint256 stage = (elapsed * 3) / commitWindow; // 0, 1, 2 inside the window
        // Last third: every active runner (a real random draw must not leave seats empty).
        if (stage >= 2) return (true, false);
        uint256 base = j.drawn;
        if (stage > 0 && base < SEATS) base = SEATS;
        uint256 k = base << stage;
        uint256 x = uint256(keccak256(abi.encode(r.rand, w))) % 1e18;
        return (x * total < k * uint256(wk.bond) * 1e18, false);
    }

    function _seatOf(Round storage r, address w) private view returns (uint8) {
        for (uint8 i = 0; i < r.commits; i++) if (r.seat[i] == w) return i;
        revert NoSeat();
    }

    function _challengeWindow() private view returns (uint256 w) {
        if (address(control) != address(0)) w = control.challengeWindow();
        if (w == 0) w = jobTimeout;
    }

    function _toCommunity(uint256 amount) private {
        if (amount == 0) return;
        if (address(control) != address(0)) credit[control.communityFund()] += amount;
        else rewardPool += amount;
    }

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
        uint64 hold = j.challengeUntil + jobTimeout;
        for (uint8 i = 0; i < r.commits; i++) {
            address w = r.seat[i];
            // Every round-1 seat may be slashed by a challenge: its bond stays until then.
            if (workers[w].heldUntil < hold) workers[w].heldUntil = hold;
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

    /// Round 2 reached a quorum on `verdict`. Only credits move (no calls out).
    function _resolve(uint256 id, Job storage j, Challenge storage ch, bytes32 verdict) private {
        Round storage r1 = j.r;
        Round storage r2 = ch.r;
        ch.result = verdict;
        bytes32 old = j.result;
        bool overturned = verdict != old;
        ch.state = overturned ? ChallengeState.Overturned : ChallengeState.Confirmed;
        uint256 pot;  // shared by the payees below
        uint256 n;    // payees: round-2 winners, plus round-1 seats that revealed `verdict`
        if (overturned) {
            j.result = verdict;
            for (uint8 i = 0; i < r1.commits; i++) {
                if (!r1.revealed[i] || r1.verdictOf[i] != old) continue;
                address w = r1.seat[i];
                workers[w].rejected += 1;
                pot += _penalize(w, CHALLENGE_SLASH_BPS, false);
                _record(w, true);
            }
            uint256 toChallenger = pot / 2;
            credit[ch.challenger] += ch.bond + toChallenger;
            pot -= toChallenger;
        } else {
            pot = ch.bond;
        }
        uint8 n1;
        for (uint8 i = 0; i < r1.commits; i++) if (r1.revealed[i] && r1.verdictOf[i] == verdict) n1++;
        uint8 n2;
        for (uint8 i = 0; i < r2.commits; i++) if (r2.revealed[i] && r2.verdictOf[i] == verdict) n2++;
        // Confirmed: half for round 2, half for round 1's winners. Overturned:
        // one equal share each for round-2 winners and vindicated round-1 seats.
        uint256 s2;
        uint256 s1;
        if (overturned) {
            n = uint256(n1) + n2;
            s1 = s2 = pot / n;
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

    /// Round 2 without a quorum: bond back, verdict stands but disputed.
    function _dispute(uint256 id, Challenge storage ch, bool timedOut) private {
        ch.state = ChallengeState.Disputed;
        credit[ch.challenger] += ch.bond;
        if (timedOut) {
            for (uint8 i = 0; i < ch.r.commits; i++) if (!ch.r.revealed[i]) _miss(id, ch.r.seat[i]);
        }
        emit ChallengeResolved(id, ChallengeState.Disputed, jobs[id].result);
    }

    function _settleRound(uint256 id, Round storage r, uint64 at) private returns (bool) {
        if (at == 0 || block.timestamp < at) return false;
        for (uint8 i = 0; i < r.commits; i++) if (!r.revealed[i]) _miss(id, r.seat[i]);
        return true;
    }

    /// A judged seat: `ok` = its verdict stood. A rejected verdict costs the
    /// penalty and a strike.
    function _judge(address w, bool ok) private {
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
    function _miss(uint256 id, address w) private {
        emit Missed(id, w);
        _penalize(w, PENALTY_BPS, true);
        _record(w, true);
    }

    function _record(address w, bool strike) private {
        Worker storage wk = workers[w];
        wk.recent = uint8(((uint256(wk.recent) << 1) | (strike ? 1 : 0)) & ((1 << STRIKE_WINDOW) - 1));
        if (strike && strikes(w) >= QUARANTINE_AFTER && !quarantined(w)) _quarantine(w);
    }

    /// Out at once: not active, its bond leaves totalActiveBond and starts
    /// unbonding (withdrawable after unbondDelay, minus penalties).
    function _quarantine(address w) private {
        Worker storage wk = workers[w];
        wk.recent = 0;
        wk.quarantinedAt = uint64(block.timestamp);
        if (wk.active) {
            wk.active = false;
            activeWorkers -= 1;
            totalActiveBond -= wk.bond;
        }
        if (wk.unbondAt == 0 && wk.bond > 0) {
            wk.unbondAt = uint64(block.timestamp) + unbondDelay;
            emit UnbondRequested(w, wk.unbondAt);
        }
        emit Quarantined(w);
        for (uint256 i = 0; i < DEFENDERS; i++) {
            if (defender[i] == w) {
                defender[i] = address(0);
                emit DefenderVacated(w, i);
            }
        }
    }

    function _fit(address w) private view returns (bool) {
        if (address(control) == address(0) || !control.defenderApproved(w) || !workers[w].active || quarantined(w)) return false;
        return block.timestamp < uint256(workers[w].lastSeen) + control.defenderTimeout();
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

    /// Takes `bps` of the bond: into the reward pool (`toPool`), or returned
    /// for the caller to hand out (a challenge's slash).
    function _penalize(address w, uint16 bps, bool toPool) private returns (uint256 cut) {
        Worker storage wk = workers[w];
        cut = (uint256(wk.bond) * bps) / 10_000;
        if (cut == 0) return 0;
        wk.bond -= uint128(cut);
        if (toPool) rewardPool += cut;
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
