// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Parametric hack insurance, TESTNET ONLY (docs/future/crosschain-assist.md, item 32). Testnet ZETAPHY has no
// value; nothing here is an insurance product and no real money may ever be put in it.
//
//   pool:    anyone deposits testnet ZETAPHY for shares; a withdrawal is requested and paid after
//            `withdrawDelay` (longer than a claim's whole life, so a known incident cannot be fled), at the
//            share price of that time (requested shares still carry losses until then). A request can be
//            executed only within WITHDRAW_WINDOW after it is ready (no standing exit), and no withdrawal
//            runs while any claim is open (voting, approved and not fully paid, or disputed). Shares are
//            priced with a virtual share and a virtual wei (ERC-4626-style offset): a pool emptied by payouts
//            does not hand new deposits to old share holders, and a donation cannot inflate the price.
//   targets: governance lists the covered contracts (a target key, as ThreatRegistry.addressKey(chainid, a))
//            with a cap per claim.
//   covers:  anyone buys cover on a listed target: amount, duration; premium = amount x premiumBps x
//            duration / year, paid into the pool. Total active cover is limited to maxCoverBps of the pool.
//   claims:  the holder files the incident as deterministic replay evidence: the exploit's transaction hashes
//            and the block range (all inside the cover's blocks), the hash of Neuro's forensic report of that
//            replay and the loss it computed, with a bond. evidenceHash = keccak256(abi.encode(chain id, target,
//            txHashes, fromBlock, toBlock)) is what every runner replays.
//   vote:    the committee is NeuroJobs' runners (active, with a track record, like ThreatRegistry). A runner
//            approves by restating the SAME report hash and loss its own replay produced; anything else counts
//            as a rejection. `quorum` approvals approve, `quorum` rejections reject (the bond goes to the pool),
//            neither within `voteWindow`: expired (bond refunded).
//   dispute: during `disputeWindow` after approval anyone may dispute with a bond; governance (the chain's
//            gov module or the timelock) then upholds or overturns. Undisputed, anyone triggers the payout.
//   payout:  the entitlement min(loss, the cover's amount, the target's cap, maxClaimBps of the pool) is fixed
//            when the claim is approved; each payout pays what is left of it, at most what is left of the
//            day's cap and what the pool holds. The claim stays Approved (and the cover taken) until the whole
//            entitlement is paid, on later days if the cap is used; a payout that would pay 0 reverts.
// What this does not do (the doc says it plainly): prove the loss on chain (the runners' replays are the
// evidence), cover chains other than this one, price risk, or protect LPs from a governance mistake.

interface IHIRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

contract HackInsurance {
    enum ClaimState { None, Voting, Approved, Rejected, Expired, Disputed, Paid, Overturned }

    struct Target { bool listed; uint128 capPerClaim; }
    struct Cover { address holder; bytes32 target; uint128 amount; uint64 startBlock; uint64 endBlock; uint64 end; bool claimed; }
    struct Claim {
        uint256 coverId;
        address claimant;
        ClaimState state;
        uint8 approvals;
        uint8 rejections;
        uint64 filedAt;
        uint64 decidedAt;     // approval time (start of the dispute window)
        uint128 loss;         // what the forensic report computed (wei)
        uint128 bond;
        bytes32 evidenceHash;
        bytes32 reportHash;
        address disputer;
        uint128 disputeBond;
    }

    uint256 public constant MAX_TXS = 16;
    uint256 public constant YEAR = 365 days;
    uint64 public constant WITHDRAW_WINDOW = 2 days; // a ready withdrawal request must be used within this

    IHIRunners public immutable runners;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed;
    address public governance;

    // parameters (governance)
    uint16 public premiumBps = 200;          // per year of cover
    uint16 public maxCoverBps = 30000;       // active cover at most 3x the pool
    uint16 public maxClaimBps = 2000;        // one claim pays at most 20% of the pool
    uint128 public dailyCap = 1000 ether;    // all payouts per UTC day
    uint128 public claimBond = 1 ether;
    uint128 public disputeBond = 5 ether;
    uint64 public voteWindow = 3 days;
    uint64 public disputeWindow = 2 days;
    uint64 public withdrawDelay = 7 days;

    // pool
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public pendingShares;
    mapping(address => uint64) public withdrawReadyAt;
    uint256 public bondsHeld;                // claim + dispute bonds (not pool money)
    uint256 public activeCover;
    uint64 public payDay;
    uint128 public paidToday;

    mapping(bytes32 => Target) public targets;
    Cover[] public covers;
    Claim[] public claims;
    mapping(uint256 => mapping(address => bool)) public voted;
    mapping(uint256 => uint256) public claimOfCover;   // cover id -> claim id + 1 of its open/approved claim
    mapping(uint256 => uint256) public entitlement;    // claim id -> what it is owed in total (set at approval)
    mapping(uint256 => uint256) public paidOut;        // claim id -> paid so far
    uint256 public openClaims;                         // claims Voting, Approved (not fully paid) or Disputed

    event Deposited(address indexed lp, uint256 amount, uint256 shares);
    event WithdrawRequested(address indexed lp, uint256 shares, uint64 readyAt);
    event Withdrawn(address indexed lp, uint256 shares, uint256 amount);
    event TargetSet(bytes32 indexed target, bool listed, uint128 capPerClaim);
    event CoverBought(uint256 indexed id, address indexed holder, bytes32 indexed target, uint128 amount, uint64 end, uint256 premium);
    event ClaimFiled(uint256 indexed id, uint256 indexed coverId, bytes32 evidenceHash, bytes32 reportHash, uint128 loss);
    event ClaimEvidence(uint256 indexed id, bytes32[] txHashes, uint64 fromBlock, uint64 toBlock, string uri);
    event ClaimVoted(uint256 indexed id, address indexed runner, bool approve, bytes32 reportHash, uint128 loss);
    event ClaimStateChanged(uint256 indexed id, ClaimState state);
    event Disputed(uint256 indexed id, address indexed by, string why);
    event PaidOut(uint256 indexed id, address indexed to, uint256 amount);
    event ParamsSet();
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotRunner();
    error NotListed();
    error OverCapacity(uint256 room);
    error Premium(uint256 needed);
    error Bond(uint256 needed);
    error NotHolder();
    error CoverEnded();
    error Claimed();
    error BadEvidence();
    error WrongState(ClaimState state);
    error AlreadyVoted();
    error TooLate();
    error NotYet(uint64 at);
    error NoShares();
    error PayFailed();
    error BadParams();
    error ClaimsOpen();
    error RequestExpired(uint64 at);
    error NothingToPay();

    constructor(IHIRunners runners_, uint8 quorum_, uint32 minAgreed_, address governance_) {
        require(quorum_ >= 2 && governance_ != address(0), "params");
        runners = runners_;
        quorum = quorum_;
        minAgreed = minAgreed_;
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }

    function setParams(uint16 premiumBps_, uint16 maxCoverBps_, uint16 maxClaimBps_, uint128 dailyCap_, uint128 claimBond_, uint128 disputeBond_,
        uint64 voteWindow_, uint64 disputeWindow_, uint64 withdrawDelay_) external onlyGov
    {
        if (maxClaimBps_ > 10000 || maxClaimBps_ == 0 || premiumBps_ > 10000 || voteWindow_ < 1 hours || disputeWindow_ < 1 hours
            || withdrawDelay_ < voteWindow_ + disputeWindow_) revert BadParams();
        (premiumBps, maxCoverBps, maxClaimBps, dailyCap, claimBond, disputeBond) = (premiumBps_, maxCoverBps_, maxClaimBps_, dailyCap_, claimBond_, disputeBond_);
        (voteWindow, disputeWindow, withdrawDelay) = (voteWindow_, disputeWindow_, withdrawDelay_);
        emit ParamsSet();
    }

    function setTarget(bytes32 target, bool listed, uint128 capPerClaim) external onlyGov {
        targets[target] = Target(listed, capPerClaim);
        emit TargetSet(target, listed, capPerClaim);
    }

    /// keccak256(abi.encode("zetaphy.threat.address", chainId, a)): the same key as ThreatRegistry.addressKey.
    function targetKey(uint256 chainId, address a) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.address", chainId, a)); }

    // ---------------------------------------------------------------- pool

    /// Pool money: everything held minus the bonds.
    function assets() public view returns (uint256) { return address(this).balance - bondsHeld; }

    function deposit() external payable {
        uint256 before = assets() - msg.value;
        // +1 virtual share and +1 virtual wei: 1:1 for the first deposit, and when the pool is empty but
        // shares exist the old shares are worth < 1 wei of the new money (HI-3).
        uint256 s = (msg.value * (totalShares + 1)) / (before + 1);
        if (s == 0) revert NoShares();
        shares[msg.sender] += s;
        totalShares += s;
        emit Deposited(msg.sender, msg.value, s);
    }

    function requestWithdraw(uint256 s) external {
        if (s == 0 || s > shares[msg.sender]) revert NoShares();
        pendingShares[msg.sender] = s;
        withdrawReadyAt[msg.sender] = uint64(block.timestamp) + withdrawDelay;
        emit WithdrawRequested(msg.sender, s, withdrawReadyAt[msg.sender]);
    }

    function withdraw() external {
        uint256 s = pendingShares[msg.sender];
        if (s == 0) revert NoShares();
        uint64 readyAt = withdrawReadyAt[msg.sender];
        if (block.timestamp < readyAt) revert NotYet(readyAt);
        if (block.timestamp > readyAt + WITHDRAW_WINDOW) revert RequestExpired(readyAt + WITHDRAW_WINDOW);  // HI-2
        if (openClaims != 0) revert ClaimsOpen();                                                            // HI-2
        if (s > shares[msg.sender]) s = shares[msg.sender];
        uint256 pool = assets();
        uint256 amount = (s * (pool + 1)) / (totalShares + 1);
        if (amount > pool) amount = pool;
        pendingShares[msg.sender] = 0;
        shares[msg.sender] -= s;
        totalShares -= s;
        emit Withdrawn(msg.sender, s, amount);
        _send(msg.sender, amount);
    }

    // ---------------------------------------------------------------- covers

    function premiumOf(uint128 amount, uint64 duration) public view returns (uint256) {
        return (uint256(amount) * premiumBps * duration) / (10000 * YEAR);
    }

    function buyCover(bytes32 target, uint128 amount, uint64 duration) external payable returns (uint256 id) {
        if (!targets[target].listed) revert NotListed();
        if (amount == 0 || duration < 1 days || duration > YEAR) revert BadParams();
        uint256 premium = premiumOf(amount, duration);
        if (msg.value < premium) revert Premium(premium);
        uint256 room = ((assets() - msg.value + premium) * maxCoverBps) / 10000;
        if (activeCover + amount > room) revert OverCapacity(room > activeCover ? room - activeCover : 0);
        activeCover += amount;
        covers.push(Cover(msg.sender, target, amount, uint64(block.number), type(uint64).max, uint64(block.timestamp) + duration, false));
        id = covers.length - 1;
        emit CoverBought(id, msg.sender, target, amount, uint64(block.timestamp) + duration, premium);
        if (msg.value > premium) _send(msg.sender, msg.value - premium);
    }

    /// Ends an expired cover's capacity use (anyone).
    function expireCover(uint256 coverId) external {
        Cover storage c = covers[coverId];
        if (block.timestamp < c.end || c.endBlock != type(uint64).max || claimOfCover[coverId] != 0) revert NotYet(c.end);
        c.endBlock = uint64(block.number);
        activeCover -= c.amount;
    }

    // ---------------------------------------------------------------- claims

    /// What every runner replays: this chain, the target, the exploit's transactions and the block range.
    function evidenceHash(bytes32 target, bytes32[] calldata txHashes, uint64 fromBlock, uint64 toBlock) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, target, txHashes, fromBlock, toBlock));
    }

    function fileClaim(uint256 coverId, bytes32[] calldata txHashes, uint64 fromBlock, uint64 toBlock, bytes32 reportHash, uint128 loss, string calldata uri)
        external payable returns (uint256 id)
    {
        Cover storage c = covers[coverId];
        _checkFiling(c, coverId, txHashes.length, fromBlock, toBlock, reportHash, loss, bytes(uri).length);
        bondsHeld += msg.value;
        bytes32 ev = evidenceHash(c.target, txHashes, fromBlock, toBlock);
        claims.push(Claim(coverId, msg.sender, ClaimState.Voting, 0, 0, uint64(block.timestamp), 0, loss, uint128(msg.value), ev, reportHash, address(0), 0));
        id = claims.length - 1;
        claimOfCover[coverId] = id + 1;
        openClaims += 1;
        emit ClaimFiled(id, coverId, ev, reportHash, loss);
        emit ClaimEvidence(id, txHashes, fromBlock, toBlock, uri);
    }

    function _checkFiling(Cover storage c, uint256 coverId, uint256 txs, uint64 fromBlock, uint64 toBlock, bytes32 reportHash, uint128 loss, uint256 uriLen) private view {
        if (msg.sender != c.holder) revert NotHolder();
        if (c.claimed || claimOfCover[coverId] != 0) revert Claimed();
        if (block.timestamp > c.end + voteWindow) revert CoverEnded();
        if (msg.value != claimBond) revert Bond(claimBond);
        if (txs == 0 || txs > MAX_TXS || reportHash == bytes32(0) || loss == 0 || uriLen > 200
            || fromBlock > toBlock || fromBlock < c.startBlock || toBlock >= block.number) revert BadEvidence();
    }

    function _checkRunner() private view {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    /// A runner's vote: approve only by restating the same forensic report hash and loss its replay produced.
    function vote(uint256 id, bool approve, bytes32 reportHash, uint128 loss) external {
        _checkRunner();
        Claim storage k = claims[id];
        if (k.state != ClaimState.Voting) revert WrongState(k.state);
        if (block.timestamp > k.filedAt + voteWindow) revert TooLate();
        if (msg.sender == k.claimant) revert NotRunner();
        if (voted[id][msg.sender]) revert AlreadyVoted();
        voted[id][msg.sender] = true;
        bool yes = approve && reportHash == k.reportHash && loss == k.loss;
        if (yes) k.approvals += 1; else k.rejections += 1;
        emit ClaimVoted(id, msg.sender, yes, reportHash, loss);
        if (k.approvals >= quorum) {
            k.state = ClaimState.Approved;
            k.decidedAt = uint64(block.timestamp);
            entitlement[id] = _entitlement(id);
            emit ClaimStateChanged(id, ClaimState.Approved);
        } else if (k.rejections >= quorum) {
            _close(id, ClaimState.Rejected, false);
        }
    }

    /// Neither quorum within the vote window: the bond comes back.
    function expire(uint256 id) external {
        Claim storage k = claims[id];
        if (k.state != ClaimState.Voting) revert WrongState(k.state);
        if (block.timestamp <= k.filedAt + voteWindow) revert NotYet(k.filedAt + voteWindow);
        _close(id, ClaimState.Expired, true);
    }

    function dispute(uint256 id, string calldata why) external payable {
        Claim storage k = claims[id];
        if (k.state != ClaimState.Approved) revert WrongState(k.state);
        if (block.timestamp >= k.decidedAt + disputeWindow) revert TooLate();
        if (msg.value != disputeBond) revert Bond(disputeBond);
        bondsHeld += msg.value;
        k.state = ClaimState.Disputed;
        k.disputer = msg.sender;
        k.disputeBond = uint128(msg.value);
        emit Disputed(id, msg.sender, why);
        emit ClaimStateChanged(id, ClaimState.Disputed);
    }

    /// Governance decides a dispute: upheld = the claim stands (the disputer's bond goes to the pool, then
    /// the payout follows); overturned = the claim fails (the claimant's bond goes to the disputer, whose own comes back).
    function resolveDispute(uint256 id, bool claimStands) external onlyGov {
        Claim storage k = claims[id];
        if (k.state != ClaimState.Disputed) revert WrongState(k.state);
        uint256 db = k.disputeBond;
        bondsHeld -= db;
        k.disputeBond = 0;
        if (claimStands) {
            k.state = ClaimState.Approved;
            k.decidedAt = uint64(block.timestamp) - disputeWindow; // payable now
            emit ClaimStateChanged(id, ClaimState.Approved);
        } else {
            uint256 cb = k.bond;
            bondsHeld -= cb;
            k.bond = 0;
            k.state = ClaimState.Overturned;
            claimOfCover[k.coverId] = 0;
            openClaims -= 1;
            emit ClaimStateChanged(id, ClaimState.Overturned);
            _send(k.disputer, db + cb);
        }
    }

    /// The claim's total entitlement: min(loss, the cover's amount, the target's cap, maxClaimBps of the pool).
    /// Fixed when the claim is approved (vote quorum); an upheld dispute keeps it.
    function _entitlement(uint256 id) private view returns (uint256 amount) {
        Claim storage k = claims[id];
        Cover storage c = covers[k.coverId];
        amount = k.loss;
        if (c.amount < amount) amount = c.amount;
        uint128 cap = targets[c.target].capPerClaim;
        if (cap < amount) amount = cap;
        uint256 byPool = (assets() * maxClaimBps) / 10000;
        if (byPool < amount) amount = byPool;
    }

    /// What payout(id) would pay now: what is left of the entitlement, at most what is left of today's cap
    /// and what the pool holds.
    function payoutOf(uint256 id) public view returns (uint256 amount) {
        amount = entitlement[id] - paidOut[id];
        uint256 pool = assets();
        if (pool < amount) amount = pool;
        uint128 today = uint64(block.timestamp / 1 days) == payDay ? paidToday : 0;
        uint256 dayLeft = dailyCap > today ? dailyCap - today : 0;
        if (dayLeft < amount) amount = dayLeft;
    }

    /// Anyone, after the dispute window of an approved claim: pays the holder what payoutOf says. The claim is
    /// closed (Paid, bond returned, cover used) only once the whole entitlement is paid; until then it stays
    /// Approved and later calls (e.g. on the next day, when the daily cap is used) pay the rest (HI-1).
    function payout(uint256 id) external {
        Claim storage k = claims[id];
        if (k.state != ClaimState.Approved) revert WrongState(k.state);
        if (block.timestamp < k.decidedAt + disputeWindow) revert NotYet(k.decidedAt + disputeWindow);
        uint256 amount = payoutOf(id);
        uint256 left = entitlement[id] - paidOut[id];
        if (amount == 0 && left != 0) revert NothingToPay();
        uint64 today = uint64(block.timestamp / 1 days);
        if (payDay != today) { payDay = today; paidToday = 0; }
        paidToday += uint128(amount);
        paidOut[id] += amount;
        uint256 bond;
        if (amount == left) {
            Cover storage c = covers[k.coverId];
            c.claimed = true;
            if (c.endBlock == type(uint64).max) { c.endBlock = uint64(block.number); activeCover -= c.amount; }
            k.state = ClaimState.Paid;
            openClaims -= 1;
            bond = k.bond;
            bondsHeld -= bond;
            k.bond = 0;
            emit ClaimStateChanged(id, ClaimState.Paid);
        }
        emit PaidOut(id, k.claimant, amount);
        _send(k.claimant, amount + bond);
    }

    function _close(uint256 id, ClaimState s, bool refund) private {
        Claim storage k = claims[id];
        k.state = s;
        claimOfCover[k.coverId] = 0;
        openClaims -= 1;
        uint256 b = k.bond;
        bondsHeld -= b;     // refunded, or (rejected) left in the contract as pool money
        k.bond = 0;
        emit ClaimStateChanged(id, s);
        if (refund) _send(k.claimant, b);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }

    function coverCount() external view returns (uint256) { return covers.length; }
    function claimCount() external view returns (uint256) { return claims.length; }
}
