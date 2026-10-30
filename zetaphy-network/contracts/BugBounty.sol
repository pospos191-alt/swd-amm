// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IBBRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IBBReputation {
    function record(address worker, uint8 kind, bytes32 ref) external;
}

interface IBBIssuance {
    function draw(uint256 amount) external returns (uint256 paid);
}

/// @title BugBounty: bug-hunting jobs for browsers, paid after runners verify
/// @notice A sponsor posts a bounty on a testnet contract: the hash of a fuzz SPEC (the
///         contract's init code, the functions to call, the setup, and the invariant, e.g.
///         "the attacker must not end with more than it started"; see
///         zetaphy-hub/bounties/*.json) and a reward. Browsers fuzz the contract in an
///         in-memory EVM (the same EthereumJS EVM the contract tests use) and, on a finding:
///           1. `commitFinding`: keccak(findingHash, finder, salt, bountyId) and a deposit.
///              Findings are numbered in commit order, so whoever committed first is first;
///              watching someone's reveal cannot help a copier, whose commit is later.
///           2. `revealFinding` (a later block, within `revealWindow`): the finding itself
///              (the call sequence) is calldata of this transaction and in the event, so the
///              runners need no server to read it.
///           3. Bonded NeuroJobs runners with a track record (the bar ThreatRegistry uses:
///              active, at least `minAgreed` accepted verdicts, no more rejected than
///              accepted) replay it against the spec (`zetaphy bounty verify`) and `attest`.
///              `quorum` matching attestations accept or reject it.
///           4. `claim`: the earliest accepted finding (every earlier one rejected or never
///              revealed) gets the reward, plus the bounty's subsidy from UsefulIssuance, plus
///              its deposit back. Later accepted duplicates get their deposit back.
///         A rejected (or never revealed) finding's deposit grows the bounty's reward for its
///         winner; if nobody wins, it is burned at the refund rather than given to the sponsor,
///         and once the bounty is paid or refunded it is burned at once (BB-1, BB-2).
///         Finding slots: the sponsor cannot commit to its own bounty, one address holds at most
///         MAX_PER_FINDER commitments per bounty, and only findings still in play (not rejected,
///         closed or past their reveal window unrevealed) count against MAX_FINDINGS, so junk
///         commitments free their slot when their reveal window ends (BB-1). Outcomes feed
///         WorkerReputation (bugValid / bugInvalid). Governance only sets the subsidy of a
///         bounty and the deposit; it cannot take a bounty's reward, which only goes to a
///         verified finding or back to the sponsor after the bounty ended.
contract BugBounty {
    uint8 internal constant BUG_VALID = 4;
    uint8 internal constant BUG_INVALID = 5;
    uint256 public constant MAX_FINDINGS = 32;      // findings in play at once, per bounty
    uint256 public constant MAX_COMMITS = 256;      // all commitments ever, per bounty (bounds the loops)
    uint256 public constant MAX_PER_FINDER = 4;     // commitments per address, per bounty
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    enum State { None, Committed, Revealed, Accepted, Rejected, Paid, Closed }

    struct Bounty {
        address sponsor;
        uint64 deadline;     // last moment to commit a finding
        bool paid;
        bool refunded;
        uint128 reward;
        uint128 subsidy;     // drawn from UsefulIssuance on payout (set by governance)
        bytes32 specHash;    // keccak256 of the spec file
        string specURI;
        uint256[] findings;
    }

    struct Finding {
        uint256 bounty;
        address finder;
        uint64 committedAt;
        uint64 commitBlock;
        uint64 revealedAt;
        State state;
        uint8 yes;
        uint8 no;
        uint128 deposit;
        bytes32 commitment;
        bytes32 findingHash;
    }

    IBBRunners public immutable runners;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed;
    address public governance;
    IBBReputation public reputation;
    IBBIssuance public issuance;
    uint128 public findingDeposit;
    uint32 public revealWindow;
    uint32 public judgeWindow;
    /// New bounties and new findings stop while paused (reveals, votes, claims, refunds go on, so
    /// nothing is stuck). `zetaphy deploy-useful-work` deploys it paused; governance opens it.
    bool public paused;
    address public guardian;           // may pause (never unpause): a fast brake for governance

    Bounty[] private _bounties;
    Finding[] private _findings;
    mapping(uint256 => mapping(address => bool)) public attested;
    mapping(address => uint256) public owed;
    /// Part of a bounty's reward that came from forfeited deposits: never refunded to the sponsor.
    mapping(uint256 => uint256) public forfeitedOf;
    mapping(uint256 => mapping(address => uint256)) public commitsBy;
    uint256 public burned;

    event BountyPosted(uint256 indexed id, address indexed sponsor, bytes32 specHash, string specURI, uint256 reward, uint64 deadline);
    event SubsidySet(uint256 indexed id, uint256 subsidy);
    event FindingCommitted(uint256 indexed findingId, uint256 indexed bounty, address indexed finder);
    event FindingRevealed(uint256 indexed findingId, uint256 indexed bounty, address indexed finder, bytes finding);
    event Attested(uint256 indexed findingId, address indexed runner, bool valid);
    event FindingJudged(uint256 indexed findingId, bool valid);
    event BountyPaid(uint256 indexed id, uint256 indexed findingId, address indexed finder, uint256 amount);
    event BountyRefunded(uint256 indexed id, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event PausedSet(bool paused);
    event GuardianSet(address guardian);
    event GovernanceSet(address governance);
    event Burned(uint256 indexed bountyId, uint256 amount);

    error Paused();
    error NotGovernance();
    error NotRunner();
    error BadValue();
    error BadBounty();
    error BadFinding();
    error Closed();
    error TooEarly();
    error TooMany();
    error BadReveal();
    error AlreadyVoted();
    error Nothing();

    constructor(IBBRunners runners_, uint8 quorum_, uint32 minAgreed_, address governance_, IBBReputation reputation_,
        IBBIssuance issuance_, uint128 findingDeposit_, uint32 revealWindow_, uint32 judgeWindow_)
    {
        if (quorum_ == 0 || revealWindow_ == 0 || judgeWindow_ == 0) revert BadValue();
        runners = runners_;
        quorum = quorum_;
        minAgreed = minAgreed_;
        governance = governance_;
        reputation = reputation_;
        issuance = issuance_;
        findingDeposit = findingDeposit_;
        revealWindow = revealWindow_;
        judgeWindow = judgeWindow_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// UsefulIssuance.draw pays through here.
    receive() external payable {}

    // ---------------------------------------------------------------- bounties

    function post(bytes32 specHash, string calldata specURI, uint64 duration) external payable returns (uint256 id) {
        if (paused) revert Paused();
        if (msg.value == 0 || specHash == bytes32(0) || duration == 0 || bytes(specURI).length > 256) revert BadValue();
        id = _bounties.length;
        Bounty storage b = _bounties.push();
        b.sponsor = msg.sender;
        b.deadline = uint64(block.timestamp + duration);
        b.reward = uint128(msg.value);
        b.specHash = specHash;
        b.specURI = specURI;
        emit BountyPosted(id, msg.sender, specHash, specURI, msg.value, b.deadline);
    }

    function setSubsidy(uint256 id, uint128 subsidy) external onlyGovernance {
        _bounty(id).subsidy = subsidy;
        emit SubsidySet(id, subsidy);
    }

    function setFindingDeposit(uint128 d) external onlyGovernance {
        findingDeposit = d;
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
        emit GovernanceSet(next);
    }

    /// Governance pauses or unpauses; the guardian may only pause.
    function setPaused(bool p) external {
        if (msg.sender != governance && !(p && msg.sender == guardian && guardian != address(0))) revert NotGovernance();
        paused = p;
        emit PausedSet(p);
    }

    function setGuardian(address g) external onlyGovernance {
        guardian = g;
        emit GuardianSet(g);
    }

    // ---------------------------------------------------------------- findings

    /// keccak(abi.encode(findingHash, finder, salt, bountyId)): bound to the finder, so a copy is useless.
    function commitmentOf(bytes32 findingHash, address finder, bytes32 salt, uint256 bountyId) public pure returns (bytes32) {
        return keccak256(abi.encode(findingHash, finder, salt, bountyId));
    }

    function commitFinding(uint256 bountyId, bytes32 commitment) external payable returns (uint256 fid) {
        if (paused) revert Paused();
        Bounty storage b = _bounty(bountyId);
        if (b.paid || b.refunded || block.timestamp > b.deadline) revert Closed();
        if (msg.value != findingDeposit || commitment == bytes32(0)) revert BadValue();
        if (msg.sender == b.sponsor) revert BadFinding();
        if (b.findings.length >= MAX_COMMITS || commitsBy[bountyId][msg.sender] >= MAX_PER_FINDER) revert TooMany();
        uint256 inPlay;
        for (uint256 i = 0; i < b.findings.length; i++) if (!_settledOut(_findings[b.findings[i]])) inPlay++;
        if (inPlay >= MAX_FINDINGS) revert TooMany();
        commitsBy[bountyId][msg.sender] += 1;
        fid = _findings.length;
        _findings.push(Finding({
            bounty: bountyId, finder: msg.sender, committedAt: uint64(block.timestamp), commitBlock: uint64(block.number),
            revealedAt: 0, state: State.Committed, yes: 0, no: 0, deposit: uint128(msg.value), commitment: commitment, findingHash: bytes32(0)
        }));
        b.findings.push(fid);
        emit FindingCommitted(fid, bountyId, msg.sender);
    }

    function revealFinding(uint256 fid, bytes calldata finding, bytes32 salt) external {
        Finding storage f = _finding(fid);
        if (msg.sender != f.finder) revert BadFinding();
        if (f.state != State.Committed) revert Closed();
        if (block.number <= f.commitBlock) revert TooEarly();
        if (block.timestamp > f.committedAt + revealWindow) revert Closed();
        bytes32 h = keccak256(finding);
        if (commitmentOf(h, msg.sender, salt, f.bounty) != f.commitment) revert BadReveal();
        f.findingHash = h;
        f.revealedAt = uint64(block.timestamp);
        f.state = State.Revealed;
        emit FindingRevealed(fid, f.bounty, msg.sender, finding);
    }

    /// A proven runner's verdict on a revealed finding (it replayed it against the spec).
    function attest(uint256 fid, bool valid) external {
        Finding storage f = _finding(fid);
        if (f.state != State.Revealed) revert Closed();
        if (block.timestamp > f.revealedAt + judgeWindow) revert Closed();
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed || msg.sender == f.finder) revert NotRunner();
        if (attested[fid][msg.sender]) revert AlreadyVoted();
        attested[fid][msg.sender] = true;
        emit Attested(fid, msg.sender, valid);
        if (valid) f.yes++;
        else f.no++;
        if (f.yes >= quorum) {
            f.state = State.Accepted;
            emit FindingJudged(fid, true);
            _rep(f.finder, BUG_VALID, fid);
        } else if (f.no >= quorum) {
            f.state = State.Rejected;
            _forfeit(f.bounty, f.deposit); // the deposit of a wrong finding grows the reward
            emit FindingJudged(fid, false);
            _rep(f.finder, BUG_INVALID, fid);
        }
    }

    /// Pays an accepted finding: the reward if it is the earliest valid one, else its deposit.
    function claim(uint256 fid) external {
        Finding storage f = _finding(fid);
        if (f.state != State.Accepted) revert Closed();
        Bounty storage b = _bounties[f.bounty];
        f.state = State.Paid;
        if (b.paid || b.refunded) {
            owed[f.finder] += f.deposit; // a later duplicate: its deposit back
            return;
        }
        for (uint256 i = 0; i < b.findings.length; i++) {
            uint256 other = b.findings[i];
            if (other == fid) break;
            if (!_settledOut(_findings[other])) revert TooEarly(); // an earlier finding is still open
        }
        b.paid = true;
        uint256 amount = b.reward;
        if (b.subsidy > 0 && address(issuance) != address(0)) {
            uint256 before = address(this).balance;
            try issuance.draw(b.subsidy) returns (uint256) {} catch {}
            amount += address(this).balance - before;
        }
        owed[f.finder] += amount + f.deposit;
        emit BountyPaid(f.bounty, fid, f.finder, amount);
    }

    /// After the judging window: an unjudged finding's deposit goes back (runners did not
    /// decide in time), and an unrevealed one is closed (its deposit grows the reward).
    function close(uint256 fid) external {
        Finding storage f = _finding(fid);
        if (f.state == State.Committed) {
            if (block.timestamp <= f.committedAt + revealWindow) revert TooEarly();
            f.state = State.Closed;
            _forfeit(f.bounty, f.deposit);
            return;
        } else if (f.state == State.Revealed) {
            if (block.timestamp <= f.revealedAt + judgeWindow) revert TooEarly();
            owed[f.finder] += f.deposit;
        } else {
            revert Closed();
        }
        f.state = State.Closed;
    }

    /// The sponsor takes an unpaid reward back once nobody can still win it.
    function refund(uint256 bountyId) external {
        Bounty storage b = _bounty(bountyId);
        if (b.paid || b.refunded) revert Closed();
        if (block.timestamp <= uint256(b.deadline) + revealWindow + judgeWindow) revert TooEarly();
        for (uint256 i = 0; i < b.findings.length; i++) {
            State s = _findings[b.findings[i]].state;
            if (s == State.Accepted) revert TooEarly(); // a winner can still claim
        }
        b.refunded = true;
        uint256 forfeited = forfeitedOf[bountyId];
        owed[b.sponsor] += b.reward - forfeited;
        emit BountyRefunded(bountyId, b.reward - forfeited);
        _burn(bountyId, forfeited); // forfeited deposits never go to the sponsor (BB-1)
    }

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        if (!ok) revert Nothing();
        emit Withdrawn(msg.sender, a);
    }

    // ---------------------------------------------------------------- reads

    function bountyCount() external view returns (uint256) {
        return _bounties.length;
    }

    function getBounty(uint256 id) external view returns (Bounty memory) {
        return _bounty(id);
    }

    function findingCount() external view returns (uint256) {
        return _findings.length;
    }

    function getFinding(uint256 fid) external view returns (Finding memory) {
        return _finding(fid);
    }

    // ---------------------------------------------------------------- internals

    function _bounty(uint256 id) internal view returns (Bounty storage) {
        if (id >= _bounties.length) revert BadBounty();
        return _bounties[id];
    }

    function _finding(uint256 fid) internal view returns (Finding storage) {
        if (fid >= _findings.length) revert BadFinding();
        return _findings[fid];
    }

    function _settledOut(Finding storage f) internal view returns (bool) {
        if (f.state == State.Rejected || f.state == State.Closed) return true;
        // committed and never revealed in time: out, even before anyone calls close()
        return f.state == State.Committed && block.timestamp > f.committedAt + revealWindow;
    }

    /// A forfeited deposit: grows the reward of a bounty that can still be won; burned if it is
    /// already paid or refunded (BB-2).
    function _forfeit(uint256 bountyId, uint128 amount) internal {
        Bounty storage b = _bounties[bountyId];
        if (b.paid || b.refunded) {
            _burn(bountyId, amount);
        } else {
            b.reward += amount;
            forfeitedOf[bountyId] += amount;
        }
    }

    function _burn(uint256 bountyId, uint256 amount) internal {
        if (amount == 0) return;
        burned += amount;
        emit Burned(bountyId, amount);
        (bool ok, ) = BURN.call{value: amount}("");
        if (!ok) revert Nothing();
    }

    function _rep(address w, uint8 kind, uint256 fid) internal {
        if (address(reputation) == address(0)) return;
        try reputation.record(w, kind, bytes32(fid)) {} catch {}
    }
}
