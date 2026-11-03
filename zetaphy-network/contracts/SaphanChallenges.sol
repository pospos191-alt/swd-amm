// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SaphanChallenges: anyone can stop a bad bridge transfer before it mints, and the lanes that vouched for it pay
/// @notice One per route (its BridgeAirlock), on ZETAPHY. Testnet only, not audited (docs/SAPHAN-SAFETY.md).
///
///         Challenge  anyone, with a bond, names a transfer that is not released yet. The airlock HOLDS it (its release
///                    waits; the airlock's challenger role can only delay, like a marker).
///         Vote       Neuro runners (NeuroJobs workers that are active, with a clean track record) vote uphold or reject
///                    within votingPeriod.
///         Upheld     (quorum of uphold votes) the airlock VETOES the transfer for good: nothing mints. The challenger
///                    gets the bond back, and the bonds of the lanes that attested the transfer are slashed: half to the
///                    challenger, half to the reserve (insurance).
///         Rejected   (quorum of reject votes, or the period ends without an upheld quorum) the hold is lifted and the
///                    challenger's bond goes to the transfer's ZETAPHY recipient, for the delay.
///
///         Lane bonds: the operator of a lane (the key behind lane2, or a NeuroLane's controller) bonds it here; a bond
///         leaves only after UNBOND_DELAY (longer than any open challenge), and can be slashed until then.
///         Every payout is pulled by its owner (claim); governance moves the reserve to an insurance pool.

interface IChallengeAirlock {
    function transfers(bytes32 id) external view returns (uint64 readyFrom, uint8 attestations, bool released, bool vetoed, uint64 readyEpoch, bool held);
    function attestedBy(bytes32 id, address lane) external view returns (bool);
    function lanes() external view returns (address[] memory);
    function isLane(address lane) external view returns (bool);
    function hold(bytes32 id) external;
    function unhold(bytes32 id) external;
    function veto(bytes32 id, string calldata reason) external;
}

interface IChallengeRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

contract SaphanChallenges {
    enum State { None, Open, Upheld, Rejected }

    struct Challenge {
        address challenger;
        address recipient;      // the transfer's ZETAPHY recipient (gets the bond when the challenge fails)
        uint128 bond;
        uint64 deadline;
        uint16 upheld;
        uint16 rejected;
        State state;
    }

    struct LaneBond {
        address operator;
        uint128 amount;
        uint64 unlockAt;        // 0: bonded; else when the operator may take it
    }

    IChallengeAirlock public immutable airlock;
    IChallengeRunners public immutable runners;
    address public governance;
    uint256 public challengeBond;
    uint64 public votingPeriod;
    uint16 public quorum;
    uint32 public minAgreed;
    uint64 public constant UNBOND_DELAY = 14 days;
    uint64 public constant MAX_VOTING = 7 days;

    mapping(bytes32 => Challenge) public challenges;
    mapping(bytes32 => mapping(address => bool)) public voted;
    mapping(address => LaneBond) public laneBonds;
    /// What each address may take (claim): returned bonds, rewards, compensation.
    mapping(address => uint256) public credit;
    /// Slashed bonds kept for insurance (moved by governance, e.g. into HackInsurance).
    uint256 public reserve;
    uint256 public openCount;

    event Opened(bytes32 indexed id, address indexed challenger, address indexed recipient, uint256 bond, uint64 deadline, string reason);
    event Voted(bytes32 indexed id, address indexed runner, bool uphold);
    event Resolved(bytes32 indexed id, bool upheld, uint256 slashed);
    event Slashed(bytes32 indexed id, address indexed lane, uint256 amount);
    event LaneBonded(address indexed lane, address indexed operator, uint256 amount);
    event UnbondRequested(address indexed lane, uint64 unlockAt);
    event LaneUnbonded(address indexed lane, uint256 amount);
    event Claimed(address indexed who, uint256 amount);
    event ReservePaid(address indexed to, uint256 amount);
    event ParamsSet(uint256 challengeBond, uint64 votingPeriod, uint16 quorum, uint32 minAgreed);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotRunner();
    error Bond(uint256 needed);
    error WrongState();
    error TooLate();
    error TooEarly();
    error Twice();
    error NotOperator();
    error NotLane();
    error Nothing();
    error PayFailed();
    error Params();

    uint256 private entered;
    modifier nonReentrant() { require(entered == 0, "reentered"); entered = 1; _; entered = 0; }
    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    constructor(IChallengeAirlock airlock_, IChallengeRunners runners_, address governance_, uint256 bond_, uint64 votingPeriod_, uint16 quorum_, uint32 minAgreed_) {
        require(address(airlock_) != address(0) && address(runners_) != address(0) && governance_ != address(0), "config");
        airlock = airlock_;
        runners = runners_;
        governance = governance_;
        _setParams(bond_, votingPeriod_, quorum_, minAgreed_);
    }

    function _setParams(uint256 bond_, uint64 votingPeriod_, uint16 quorum_, uint32 minAgreed_) private {
        if (bond_ == 0 || votingPeriod_ < 1 hours || votingPeriod_ > MAX_VOTING || quorum_ == 0) revert Params();
        challengeBond = bond_;
        votingPeriod = votingPeriod_;
        quorum = quorum_;
        minAgreed = minAgreed_;
        emit ParamsSet(bond_, votingPeriod_, quorum_, minAgreed_);
    }

    /// Governance; never while a challenge is open (the rules of an open challenge do not change under it).
    function setParams(uint256 bond_, uint64 votingPeriod_, uint16 quorum_, uint32 minAgreed_) external onlyGov {
        if (openCount != 0) revert WrongState();
        _setParams(bond_, votingPeriod_, quorum_, minAgreed_);
    }

    function setGovernance(address g) external onlyGov {
        require(g != address(0), "governance");
        governance = g;
        emit GovernanceSet(g);
    }

    // ---------------------------------------------------------------- challenges

    /// Anyone: holds a transfer that lanes attested but the airlock has not released, with the bond (msg.value).
    function open(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount, string calldata reason)
        external payable returns (bytes32 id)
    {
        if (msg.value != challengeBond) revert Bond(challengeBond);
        id = keccak256(abi.encode(srcChainId, srcContract, srcNonce, sender, to, amount)); // = BridgeAirlock.transferId
        Challenge storage c = challenges[id];
        if (c.state != State.None) revert Twice(); // one challenge per transfer, ever
        uint64 deadline = uint64(block.timestamp) + votingPeriod;
        challenges[id] = Challenge(msg.sender, to, uint128(msg.value), deadline, 0, 0, State.Open);
        openCount += 1;
        // last: the airlock refuses (and this whole call reverts) unless lanes attested it and it is not released or vetoed
        airlock.hold(id);
        emit Opened(id, msg.sender, to, msg.value, deadline, reason);
    }

    /// A Neuro runner's vote (active, at least minAgreed agreed jobs, no more rejected than agreed); once per challenge.
    function vote(bytes32 id, bool uphold) external {
        Challenge storage c = challenges[id];
        if (c.state != State.Open) revert WrongState();
        if (block.timestamp > c.deadline) revert TooLate();
        if (msg.sender == c.challenger) revert NotRunner();
        if (voted[id][msg.sender]) revert Twice();
        voted[id][msg.sender] = true;
        if (uphold) c.upheld += 1; else c.rejected += 1;
        emit Voted(id, msg.sender, uphold);
        // who may vote, checked last (a read of NeuroJobs; a vote from anyone else reverts whole)
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    /// Anyone: settles a challenge once a quorum agrees, or after its deadline (no upheld quorum then = rejected).
    function resolve(bytes32 id) external nonReentrant {
        Challenge storage c = challenges[id];
        if (c.state != State.Open) revert WrongState();
        bool upheld = c.upheld >= quorum;
        bool rejected = !upheld && (c.rejected >= quorum || block.timestamp > c.deadline);
        if (!upheld && !rejected) revert TooEarly();
        openCount -= 1;
        uint256 slashed;
        if (upheld) {
            c.state = State.Upheld;
            credit[c.challenger] += c.bond;
            // the lanes that vouched for it lose their bonds: half to the challenger, half to the reserve
            address[] memory ls = airlock.lanes();
            for (uint256 i = 0; i < ls.length; i++) {
                if (!airlock.attestedBy(id, ls[i])) continue;
                LaneBond storage b = laneBonds[ls[i]];
                uint256 v = b.amount;
                if (v == 0) continue;
                b.amount = 0;
                slashed += v;
                emit Slashed(id, ls[i], v);
            }
            credit[c.challenger] += slashed / 2;
            reserve += slashed - slashed / 2;
            emit Resolved(id, true, slashed);
            airlock.veto(id, "Saphan challenge upheld");
        } else {
            c.state = State.Rejected;
            credit[c.recipient] += c.bond;
            emit Resolved(id, false, 0);
            airlock.unhold(id);
        }
    }

    // ---------------------------------------------------------------- lane bonds

    /// A lane's operator bonds it (the first bonder of a lane is its operator; only the operator adds).
    function bondLane(address lane) external payable {
        if (msg.value == 0) revert Nothing();
        LaneBond storage b = laneBonds[lane];
        if (b.operator == address(0)) b.operator = msg.sender;
        if (b.operator != msg.sender) revert NotOperator();
        b.amount += uint128(msg.value);
        b.unlockAt = 0;
        emit LaneBonded(lane, msg.sender, msg.value);
        if (!airlock.isLane(lane)) revert NotLane(); // checked last (a read of the airlock): not a lane, the whole call reverts
    }

    /// The operator starts leaving: the bond can still be slashed until UNBOND_DELAY has passed.
    function requestUnbond(address lane) external {
        LaneBond storage b = laneBonds[lane];
        if (b.operator != msg.sender) revert NotOperator();
        b.unlockAt = uint64(block.timestamp) + UNBOND_DELAY;
        emit UnbondRequested(lane, b.unlockAt);
    }

    function unbond(address lane) external nonReentrant {
        LaneBond storage b = laneBonds[lane];
        if (b.operator != msg.sender) revert NotOperator();
        if (b.unlockAt == 0 || block.timestamp < b.unlockAt) revert TooEarly();
        uint256 v = b.amount;
        if (v == 0) revert Nothing();
        b.amount = 0;
        b.unlockAt = 0;
        credit[msg.sender] += v;
        emit LaneUnbonded(lane, v);
    }

    // ---------------------------------------------------------------- payouts

    /// What the caller is owed (bonds back, rewards, compensation, unbonded lane bonds).
    function claim() external nonReentrant {
        uint256 v = credit[msg.sender];
        if (v == 0) revert Nothing();
        credit[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: v}("");
        if (!ok) revert PayFailed();
        emit Claimed(msg.sender, v);
    }

    /// Governance moves slashed bonds to insurance (e.g. HackInsurance's pool): credited there, taken with claim().
    function payReserve(address to, uint256 amount) external onlyGov {
        if (amount == 0 || amount > reserve) revert Nothing();
        reserve -= amount;
        credit[to] += amount;
        emit ReservePaid(to, amount);
    }
}
