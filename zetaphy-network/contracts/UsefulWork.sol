// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IUWReputation {
    function scoreOf(address worker) external view returns (uint256);
    function record(address worker, uint8 kind, bytes32 ref) external;
}

interface IUWIssuance {
    function draw(uint256 amount) external returns (uint256 paid);
}

/// @title UsefulWork: proof of useful work for browsers (Neuro scan jobs)
/// @notice Small Neuro jobs that a web browser can do: a rules scan of one contract's
///         bytecode (zetaphy-neuro's reader in a Web Worker, sourcify and trade simulation
///         off, so the verdict depends only on the code). Unlike NeuroJobs it needs no
///         100 ZETAPHY bond; instead:
///           - Sybil cost: a worker first posts a PoW STAMP (`stamp`): sha256 over the chain
///             id, a recent block's seed, its own address and a nonce must start with
///             `stampBits` zero bits (the same puzzle as the PoW faucet, under another seed
///             so a faucet proof is not a stamp). A stamp buys `stampSeats` seats for
///             `stampLife` seconds, at most `seatsPerDay` a day per address.
///           - Each seat takes a small deposit (`seatDeposit`), returned when the worker's
///             answer is accepted, kept (into the subsidy reserve) when it is not.
///           - Redundancy: every job has `seats` (2..5) independent seats and pays only
///             answers that at least `quorum` seats agree on. Answers are commit-reveal
///             (keccak(verdict, worker, salt, jobId)), so nobody can copy another's answer.
///           - Canaries: a feeder (an address governance trusts to post jobs, e.g. the Neuro
///             watch-list Action) can post a known-answer job with a hidden commitment to the
///             right verdict. After the commits close it reveals it; seats that answered
///             otherwise are slashed even when they agreed with each other.
///           - Reputation (WorkerReputation): every settled seat is recorded. A job may ask
///             a minimum score (`minScore`), and during the first `priorityWindow` seconds
///             only workers with at least `priorityScore` may take seats, so important
///             jobs go to proven workers first.
///         Rewards: the poster's fee is split among the agreeing seats; feeder jobs marked
///         `subsidized` also pay `subsidy` per agreeing seat, from the forfeited deposits
///         and then from UsefulIssuance (a RewardVault share). No new minting.
///         Results are signed by being transactions of the worker's own key; the accepted
///         verdict is on-chain (`getJob(id).result`).
contract UsefulWork {
    // WorkerReputation.Kind
    uint8 internal constant AGREED = 0;
    uint8 internal constant DISAGREED = 1;
    uint8 internal constant MISSED = 2;
    uint8 internal constant SLASHED = 3;

    struct Params {
        uint8 stampBits;        // leading zero bits a stamp needs (8..48)
        uint16 stampSeats;      // seats one stamp buys
        uint32 stampLife;       // seconds a stamp's seats stay usable
        uint16 seatsPerDay;     // most seats one address takes per UTC day
        uint8 seats;            // seats per job (2..5)
        uint8 quorum;           // agreeing seats needed (> seats/2)
        uint32 commitWindow;    // seconds seats can be taken
        uint32 revealWindow;    // seconds to reveal after the commits close
        uint128 seatDeposit;    // per seat, returned on an accepted answer
        uint128 subsidy;        // per agreeing seat of a subsidized job
        uint16 priorityScore;   // score needed during the priority window (0 = none)
        uint32 priorityWindow;  // seconds after posting reserved for proven workers
    }

    struct Job {
        address poster;
        uint64 createdAt;
        uint64 closedAt;        // when the seats filled (0: closes at createdAt + commitWindow)
        uint32 commitWindow;
        uint32 revealWindow;
        uint8 seats;
        uint8 quorum;
        uint8 taken;
        uint8 revealed;
        bool subsidized;
        bool settled;
        bool canaryRevealed;
        uint16 minScore;
        uint128 fee;
        uint128 deposit;
        bytes32 chain;          // Neuro chain key, e.g. "zetaphy", "bsc"
        bytes32 codeHash;       // keccak256 of the runtime bytecode the poster saw
        bytes32 canary;         // keccak(verdict, salt, jobId) of the known answer, or 0
        bytes32 canaryVerdict;
        bytes32 result;         // the accepted verdict (0 = none)
        string target;          // the contract address on that chain
    }

    struct Credit {
        uint32 seats;
        uint64 until;
    }

    address public governance;
    IUWReputation public reputation;
    IUWIssuance public issuance;
    Params public params;
    uint256 public reserve;              // forfeited deposits + fund(): pays subsidies first
    mapping(address => bool) public feeders;
    mapping(address => Credit) public credits;
    mapping(bytes32 => bool) public usedStamp;
    mapping(address => mapping(uint256 => uint256)) public seatsOnDay;
    mapping(address => uint256) public owed;

    Job[] private _jobs;
    mapping(uint256 => address[]) private _seats;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bytes32)) public verdicts;

    event Funded(address indexed from, uint256 amount);
    event Stamped(address indexed worker, bytes32 stamp, uint32 seats, uint64 until);
    event Posted(uint256 indexed id, address indexed poster, bytes32 indexed chain, string target, bytes32 codeHash, uint256 fee, bool subsidized, bool canary);
    event Committed(uint256 indexed id, address indexed worker);
    event Revealed(uint256 indexed id, address indexed worker, bytes32 verdict);
    event CanaryRevealed(uint256 indexed id, bytes32 verdict);
    event Settled(uint256 indexed id, bytes32 result, uint256 agreed, uint256 paidEach);
    event SeatOutcome(uint256 indexed id, address indexed worker, uint8 kind);
    event ParamsSet();
    event FeederSet(address indexed feeder, bool on);
    event Withdrawn(address indexed to, uint256 amount);

    error NotGovernance();
    error NotFeeder();
    error BadParams();
    error BadValue();
    error BadJob();
    error StampTooOld();
    error StampUsed();
    error StampWeak();
    error NoCredit();
    error DayFull();
    error LowScore();
    error Closed();
    error AlreadyIn();
    error NotSeated();
    error TooEarly();
    error BadReveal();
    error Nothing();

    constructor(address governance_, IUWReputation reputation_, IUWIssuance issuance_, Params memory p) {
        governance = governance_;
        reputation = reputation_;
        issuance = issuance_;
        _setParams(p);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    receive() external payable {
        fund();
    }

    /// Adds to the subsidy reserve (anyone; RewardVault can pay here directly too).
    function fund() public payable {
        reserve += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- stamp (PoW)

    /// The 32 bytes the stamp hashes in place of a block hash: keccak(blockhash(height), this).
    function stampSeed(uint256 height) public view returns (bytes32) {
        bytes32 bh = blockhash(height);
        if (bh == bytes32(0)) return bytes32(0);
        return keccak256(abi.encodePacked(bh, address(this)));
    }

    /// sha256(chainId u64 BE || seed || worker || nonce u64 BE): the PoW faucet's layout.
    function stampHash(address worker, uint256 height, uint64 nonce) public view returns (bytes32) {
        return sha256(abi.encodePacked(uint64(block.chainid), stampSeed(height), worker, nonce));
    }

    function stamp(uint256 height, uint64 nonce) external {
        if (height >= block.number || block.number - height > 256 || stampSeed(height) == bytes32(0)) revert StampTooOld();
        bytes32 h = stampHash(msg.sender, height, nonce);
        if (usedStamp[h]) revert StampUsed();
        if (uint256(h) >> (256 - params.stampBits) != 0) revert StampWeak();
        usedStamp[h] = true;
        Credit storage c = credits[msg.sender];
        if (c.until < block.timestamp) c.seats = 0;
        c.seats += params.stampSeats;
        c.until = uint64(block.timestamp + params.stampLife);
        emit Stamped(msg.sender, h, c.seats, c.until);
    }

    // ---------------------------------------------------------------- posting

    /// Anyone posts a scan job and pays the fee the agreeing seats share.
    function post(bytes32 chain, string calldata target, bytes32 codeHash, uint16 minScore) external payable returns (uint256) {
        if (msg.value == 0) revert BadValue();
        return _post(chain, target, codeHash, minScore, false, bytes32(0));
    }

    /// A feeder posts a job that may be subsidized and may carry a hidden known answer.
    function postFeeder(bytes32 chain, string calldata target, bytes32 codeHash, uint16 minScore, bool subsidized, bytes32 canary)
        external payable returns (uint256)
    {
        if (!feeders[msg.sender]) revert NotFeeder();
        return _post(chain, target, codeHash, minScore, subsidized, canary);
    }

    function _post(bytes32 chain, string calldata target, bytes32 codeHash, uint16 minScore, bool subsidized, bytes32 canary)
        internal returns (uint256 id)
    {
        if (chain == bytes32(0) || codeHash == bytes32(0) || bytes(target).length == 0 || bytes(target).length > 128) revert BadJob();
        Params memory p = params;
        id = _jobs.length;
        Job storage j = _jobs.push();
        j.poster = msg.sender;
        j.createdAt = uint64(block.timestamp);
        j.commitWindow = p.commitWindow;
        j.revealWindow = p.revealWindow;
        j.seats = p.seats;
        j.quorum = p.quorum;
        j.subsidized = subsidized;
        j.minScore = minScore;
        j.fee = uint128(msg.value);
        j.deposit = p.seatDeposit;
        j.chain = chain;
        j.codeHash = codeHash;
        j.canary = canary;
        j.target = target;
        emit Posted(id, msg.sender, chain, target, codeHash, msg.value, subsidized, canary != bytes32(0));
    }

    // ---------------------------------------------------------------- commit / reveal

    function commitmentOf(bytes32 verdict, address worker, bytes32 salt, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(verdict, worker, salt, id));
    }

    function commit(uint256 id, bytes32 commitment) external payable {
        if (msg.value != _job(id).deposit) revert BadValue();
        _commit(id, commitment);
    }

    /// Several seats in one transaction (one wallet prompt in the browser).
    function commitMany(uint256[] calldata ids, bytes32[] calldata cs) external payable {
        if (ids.length != cs.length) revert BadValue();
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) {
            total += _job(ids[i]).deposit;
            _commit(ids[i], cs[i]);
        }
        if (msg.value != total) revert BadValue();
    }

    function _commit(uint256 id, bytes32 commitment) internal {
        Job storage j = _jobs[id];
        if (j.settled || j.taken >= j.seats || block.timestamp >= _closeTime(j)) revert Closed();
        if (commitments[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        if (commitment == bytes32(0)) revert BadValue();
        Credit storage c = credits[msg.sender];
        if (c.seats == 0 || c.until < block.timestamp) revert NoCredit();
        uint256 day = block.timestamp / 1 days;
        if (seatsOnDay[msg.sender][day] >= params.seatsPerDay) revert DayFull();
        if (address(reputation) != address(0)) {
            uint256 score = reputation.scoreOf(msg.sender);
            if (score < j.minScore) revert LowScore();
            if (block.timestamp < j.createdAt + params.priorityWindow && score < params.priorityScore) revert LowScore();
        }
        c.seats--;
        seatsOnDay[msg.sender][day]++;
        commitments[id][msg.sender] = commitment;
        _seats[id].push(msg.sender);
        j.taken++;
        if (j.taken == j.seats) j.closedAt = uint64(block.timestamp);
        emit Committed(id, msg.sender);
    }

    function reveal(uint256 id, bytes32 verdict, bytes32 salt) external {
        _reveal(id, verdict, salt);
    }

    function revealMany(uint256[] calldata ids, bytes32[] calldata vs, bytes32[] calldata salts) external {
        if (ids.length != vs.length || ids.length != salts.length) revert BadValue();
        for (uint256 i = 0; i < ids.length; i++) _reveal(ids[i], vs[i], salts[i]);
    }

    function _reveal(uint256 id, bytes32 verdict, bytes32 salt) internal {
        Job storage j = _job(id);
        if (j.settled) revert Closed();
        if (!_commitsClosed(j)) revert TooEarly();
        if (block.timestamp >= _closeTime(j) + j.revealWindow) revert Closed();
        bytes32 c = commitments[id][msg.sender];
        if (c == bytes32(0)) revert NotSeated();
        if (verdicts[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        if (verdict == bytes32(0) || commitmentOf(verdict, msg.sender, salt, id) != c) revert BadReveal();
        verdicts[id][msg.sender] = verdict;
        j.revealed++;
        emit Revealed(id, msg.sender, verdict);
    }

    /// The feeder reveals a canary's known answer once nobody can commit any more.
    function revealCanary(uint256 id, bytes32 verdict, bytes32 salt) external {
        Job storage j = _job(id);
        if (msg.sender != j.poster) revert NotFeeder();
        if (j.settled || j.canary == bytes32(0) || j.canaryRevealed) revert Closed();
        if (!_commitsClosed(j)) revert TooEarly();
        if (keccak256(abi.encode(verdict, salt, id)) != j.canary) revert BadReveal();
        j.canaryVerdict = verdict;
        j.canaryRevealed = true;
        emit CanaryRevealed(id, verdict);
    }

    // ---------------------------------------------------------------- settle

    /// Anyone, once every seat revealed (and the canary, if any) or the reveal window ended.
    function settle(uint256 id) external {
        Job storage j = _job(id);
        if (j.settled) revert Closed();
        bool allIn = _commitsClosed(j) && j.taken == j.seats && j.revealed == j.taken && (j.canary == bytes32(0) || j.canaryRevealed);
        if (!allIn && block.timestamp < _closeTime(j) + j.revealWindow) revert TooEarly();
        j.settled = true;
        address[] memory seats = _seats[id];
        bytes32 accepted;
        bool canary = j.canaryRevealed;
        if (canary) accepted = j.canaryVerdict;
        else accepted = _majority(id, seats, j.quorum);
        j.result = accepted;

        uint256 agreed;
        for (uint256 i = 0; i < seats.length; i++) if (accepted != bytes32(0) && verdicts[id][seats[i]] == accepted) agreed++;

        // the pot of the agreeing seats: the fee, plus the subsidy of a subsidized job
        uint256 pot;
        if (agreed > 0) {
            pot = j.fee;
            if (j.subsidized) pot += _subsidy(params.subsidy * agreed);
        } else if (j.fee > 0) {
            owed[j.poster] += j.fee; // nobody agreed: the poster gets the fee back
        }
        uint256 each = agreed > 0 ? pot / agreed : 0;
        reserve += agreed > 0 ? pot - each * agreed : 0;
        for (uint256 i = 0; i < seats.length; i++) _judgeSeat(id, seats[i], accepted, canary, j.deposit, each);
        emit Settled(id, accepted, agreed, each);
    }

    function _judgeSeat(uint256 id, address w, bytes32 accepted, bool canary, uint256 deposit, uint256 each) internal {
        bytes32 v = verdicts[id][w];
        uint8 kind;
        if (v == bytes32(0)) {
            kind = MISSED;
            reserve += deposit;
        } else if (accepted == bytes32(0)) {
            owed[w] += deposit; // no accepted answer: nobody is judged
            emit SeatOutcome(id, w, 255);
            return;
        } else if (v == accepted) {
            kind = AGREED;
            owed[w] += deposit + each;
        } else {
            kind = canary ? SLASHED : DISAGREED;
            reserve += deposit;
        }
        emit SeatOutcome(id, w, kind);
        if (address(reputation) != address(0)) {
            try reputation.record(w, kind, bytes32(id)) {} catch {}
        }
    }

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        if (!ok) revert Nothing();
        emit Withdrawn(msg.sender, a);
    }

    // ---------------------------------------------------------------- governance

    function setParams(Params calldata p) external onlyGovernance {
        _setParams(p);
    }

    function setFeeder(address f, bool on) external onlyGovernance {
        feeders[f] = on;
        emit FeederSet(f, on);
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
    }

    function _setParams(Params memory p) internal {
        if (p.stampBits < 8 || p.stampBits > 48 || p.stampSeats == 0 || p.stampLife == 0 || p.seatsPerDay == 0) revert BadParams();
        if (p.seats < 2 || p.seats > 5 || p.quorum * 2 <= p.seats || p.quorum > p.seats) revert BadParams();
        if (p.commitWindow == 0 || p.revealWindow == 0 || p.priorityWindow >= p.commitWindow) revert BadParams();
        params = p;
        emit ParamsSet();
    }

    // ---------------------------------------------------------------- reads

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 id) external view returns (Job memory) {
        return _job(id);
    }

    function seatsOf(uint256 id) external view returns (address[] memory) {
        return _seats[id];
    }

    /// Up to `max` job ids from `from` on that still take seats now.
    function openJobs(uint256 from, uint256 max) external view returns (uint256[] memory ids) {
        uint256[] memory buf = new uint256[](max);
        uint256 n;
        for (uint256 i = from; i < _jobs.length && n < max; i++) {
            Job storage j = _jobs[i];
            if (!j.settled && j.taken < j.seats && block.timestamp < _closeTime(j)) buf[n++] = i;
        }
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = buf[i];
    }

    /// Phase of a job: 0 taking seats, 1 revealing, 2 ready to settle, 3 settled.
    function phase(uint256 id) external view returns (uint8) {
        Job storage j = _job(id);
        if (j.settled) return 3;
        if (!_commitsClosed(j)) return 0;
        bool allIn = j.taken == j.seats && j.revealed == j.taken && (j.canary == bytes32(0) || j.canaryRevealed);
        if (allIn || block.timestamp >= _closeTime(j) + j.revealWindow) return 2;
        return 1;
    }

    // ---------------------------------------------------------------- internals

    function _job(uint256 id) internal view returns (Job storage) {
        if (id >= _jobs.length) revert BadJob();
        return _jobs[id];
    }

    function _closeTime(Job storage j) internal view returns (uint256) {
        return j.closedAt != 0 ? j.closedAt : uint256(j.createdAt) + j.commitWindow;
    }

    function _commitsClosed(Job storage j) internal view returns (bool) {
        return j.taken == j.seats || block.timestamp >= _closeTime(j);
    }

    function _majority(uint256 id, address[] memory seats, uint8 quorum) internal view returns (bytes32) {
        for (uint256 i = 0; i < seats.length; i++) {
            bytes32 v = verdicts[id][seats[i]];
            if (v == bytes32(0)) continue;
            uint256 n;
            for (uint256 k = 0; k < seats.length; k++) if (verdicts[id][seats[k]] == v) n++;
            if (n >= quorum) return v; // quorum > seats/2: at most one verdict can reach it
        }
        return bytes32(0);
    }

    /// Takes up to `want` from the reserve, then from UsefulIssuance. Returns what it got.
    function _subsidy(uint256 want) internal returns (uint256 got) {
        if (want == 0) return 0;
        got = want < reserve ? want : reserve;
        reserve -= got;
        if (got < want && address(issuance) != address(0)) {
            uint256 before = address(this).balance;
            try issuance.draw(want - got) returns (uint256) {} catch {}
            uint256 arrived = address(this).balance - before;
            // draw() pays through receive(), which counts it into the reserve: move it out again
            reserve -= arrived;
            got += arrived;
        }
    }
}
