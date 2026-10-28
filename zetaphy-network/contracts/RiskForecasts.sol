// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRiskPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IRiskFlags {
    function isAddressFlagged(uint256 chainId, address who) external view returns (bool, uint8);
    function isContractFlagged(address who) external view returns (bool, uint8);
}

interface IForesightResolver {
    function openEvent(bytes32 topic, uint64 commitEnd, uint64 revealEnd) external returns (uint256);
    function closeCommits(uint256 id) external;
    function resolve(uint256 id, uint8 outcome) external;
}

/// @title RiskForecasts: testnet risk forecasts on tokens, resolved from on-chain facts
/// @notice TESTNET ONLY. Stakes are testnet ZETAPHY, which has no value; this is a
///         forecasting tool that turns people's and models' judgement into labelled
///         data for Neuro, not a product to make money with.
///
///         A forecast question is one of:
///           - LiquidityDrop: "the other side of token X's pool loses at least N% of
///             what it held when the question was opened, before the deadline"
///           - Flagged: "token X is flagged in the ThreatRegistry before the deadline"
///         Forecasters back Yes or No with a testnet stake until the question closes
///         (and never while the condition already holds). The answer comes only from
///         chain state: anyone may `poke` a question, which reads the pair's reserves or
///         the ThreatRegistry; a drop counts once it has held for `confirmDelay` (so a
///         flash swap or a single-block dip is not enough). `propose` then states the
///         answer the facts give, and a dispute window lets anyone post a bond to send it
///         to governance (e.g. the pool moved for an honest migration, or the flag was a
///         mistake). Accurate forecasters share the stakes of the inaccurate side; a void
///         question refunds everyone.
///
///         When a ForesightRegistry is set, every question is also a Foresight event, so
///         models' committed probabilities are scored (Brier) against the same answer.
contract RiskForecasts {
    enum Kind { LiquidityDrop, Flagged }
    enum Status { None, Open, Proposed, Disputed, Final }
    enum Answer { None, No, Yes, Void }

    struct Question {
        address token;
        address pair;
        Kind kind;
        uint16 dropBps;       // LiquidityDrop: the drop that makes the answer Yes
        uint64 createdAt;
        uint64 closeAt;       // forecasts until
        uint64 deadline;      // the condition must be seen by then
        uint112 baseReserve;  // the pool's other side when opened
        address creator;
    }

    struct State {
        Status status;
        Answer proposed;
        Answer answer;
        uint64 seenAt;        // first poke that saw the condition (0: not holding)
        bool confirmed;       // seen again at least confirmDelay later, before the deadline (+ confirmDelay)
        uint64 proposedAt;
        address disputer;
        uint128 yes;
        uint128 no;
        uint256 foresightId;
    }

    uint256 public constant BPS = 10_000;
    uint64 public constant MIN_HORIZON = 1 hours;
    uint64 public constant MAX_HORIZON = 180 days;

    address public governance;
    IRiskFlags public threats;
    IForesightResolver public foresight;
    uint64 public confirmDelay = 1 hours;
    uint64 public disputeWindow = 1 days;
    uint64 public revealWindow = 1 days;      // Foresight reveal period after forecasts close
    uint128 public disputeBond = 10 ether;
    uint128 public minStake = 0.01 ether;
    uint112 public minReserve = 1 ether;      // smaller pools are too easy to move

    uint256 public count;
    mapping(uint256 => Question) public questions;
    mapping(uint256 => State) public states;
    mapping(uint256 => mapping(address => uint128)) public yesOf;
    mapping(uint256 => mapping(address => uint128)) public noOf;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(address => uint256) public owed;

    event Opened(uint256 indexed id, address indexed token, address pair, Kind kind, uint16 dropBps, uint64 closeAt, uint64 deadline, uint112 baseReserve, uint256 foresightId);
    event Forecast(uint256 indexed id, address indexed who, bool yes, uint256 amount);
    event Seen(uint256 indexed id, bool holding, bool confirmed, uint256 reserve);
    event Proposed(uint256 indexed id, Answer answer);
    event Disputed(uint256 indexed id, address indexed by, uint256 bond);
    event Finalized(uint256 indexed id, Answer answer, bool byGovernance);
    event Claimed(uint256 indexed id, address indexed who, uint256 amount);
    event ParamsSet(uint64 confirmDelay, uint64 disputeWindow, uint64 revealWindow, uint128 disputeBond, uint128 minStake, uint112 minReserve);
    event GovernanceSet(address governance);

    error NotGovernance();
    error BadParams();
    error BadPair();
    error AlreadyTrue();
    error WrongStatus();
    error ForecastsClosed();
    error StakeTooSmall();
    error NotYet();
    error TooLate();
    error BadBond();
    error NothingToClaim();
    error SendFailed();

    constructor(address governance_, IRiskFlags threats_, IForesightResolver foresight_) {
        governance = governance_;
        threats = threats_;
        foresight = foresight_;
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address g) external onlyGov {
        governance = g;
        emit GovernanceSet(g);
    }

    function setParams(uint64 confirm, uint64 disputeFor, uint64 reveal, uint128 bond, uint128 stake, uint112 reserve) external onlyGov {
        if (disputeFor < 1 hours || disputeFor > 30 days || confirm > 7 days || reveal < 1 hours || reveal > 30 days || stake == 0) revert BadParams();
        (confirmDelay, disputeWindow, revealWindow, disputeBond, minStake, minReserve) = (confirm, disputeFor, reveal, bond, stake, reserve);
        emit ParamsSet(confirm, disputeFor, reveal, bond, stake, reserve);
    }

    // ------------------------------------------------------------------ open

    /// @param horizon  seconds from now to the deadline
    /// @param window   seconds from now during which forecasts are taken (<= horizon)
    function open(address token, address pair, Kind kind, uint16 dropBps, uint64 horizon, uint64 window) external returns (uint256 id) {
        if (horizon < MIN_HORIZON || horizon > MAX_HORIZON || window == 0 || window > horizon || token == address(0)) revert BadParams();
        uint112 base;
        if (kind == Kind.LiquidityDrop) {
            if (dropBps < 1000 || dropBps > BPS) revert BadParams();
            base = _otherReserve(token, pair);
            if (base < minReserve) revert BadPair();
        } else {
            if (address(threats) == address(0)) revert BadParams();
            if (_flagged(token)) revert AlreadyTrue();
            dropBps = 0;
        }
        id = ++count;
        uint64 nowT = uint64(block.timestamp);
        questions[id] = Question(token, pair, kind, dropBps, nowT, nowT + window, nowT + horizon, base, msg.sender);
        State storage s = states[id];
        s.status = Status.Open;
        if (address(foresight) != address(0)) {
            s.foresightId = foresight.openEvent(keccak256(abi.encode(address(this), id)), nowT + window, nowT + window + revealWindow);
        }
        emit Opened(id, token, pair, kind, dropBps, nowT + window, nowT + horizon, base, s.foresightId);
    }

    // ------------------------------------------------------------------ forecast

    function forecast(uint256 id, bool yes) external payable {
        Question storage q = questions[id];
        State storage s = states[id];
        if (s.status != Status.Open || block.timestamp >= q.closeAt) revert ForecastsClosed();
        if (msg.value < minStake || msg.value > type(uint128).max) revert StakeTooSmall();
        // never while the answer is already being decided
        if (s.seenAt != 0 || _holds(q)) revert AlreadyTrue();
        if (yes) { yesOf[id][msg.sender] += uint128(msg.value); s.yes += uint128(msg.value); }
        else { noOf[id][msg.sender] += uint128(msg.value); s.no += uint128(msg.value); }
        emit Forecast(id, msg.sender, yes, msg.value);
    }

    // ------------------------------------------------------------------ resolve from chain facts

    /// Reads the chain for a question (anyone; a keeper runs it on a schedule).
    function poke(uint256 id) public {
        Question storage q = questions[id];
        State storage s = states[id];
        if (s.status != Status.Open || s.confirmed) return;
        uint64 nowT = uint64(block.timestamp);
        bool holding = _holds(q);
        uint256 reserve = q.kind == Kind.LiquidityDrop ? _otherReserve(q.token, q.pair) : 0;
        if (holding) {
            if (s.seenAt == 0) {
                if (nowT <= q.deadline) {
                    s.seenAt = nowT;
                    // forecasts and Foresight commits stop the moment it is seen
                    if (s.foresightId != 0 && nowT < q.closeAt) foresight.closeCommits(s.foresightId);
                    if (nowT < q.closeAt) q.closeAt = nowT;
                }
            }
            if (s.seenAt != 0 && nowT >= s.seenAt + _confirmFor(q)) s.confirmed = true;
        } else if (s.seenAt != 0) {
            s.seenAt = 0; // it did not hold: start again
        }
        emit Seen(id, holding, s.confirmed, reserve);
    }

    /// States the answer the facts give: Yes once confirmed, No once the deadline (+ confirm time) passed without it.
    function propose(uint256 id) external {
        Question storage q = questions[id];
        State storage s = states[id];
        if (s.status != Status.Open) revert WrongStatus();
        poke(id);
        Answer a;
        if (s.confirmed) a = Answer.Yes;
        else if (block.timestamp > q.deadline + _confirmFor(q) && s.seenAt == 0) a = Answer.No;
        else revert NotYet(); // (past that time, the poke above either confirmed a holding condition or reset it)
        s.status = Status.Proposed;
        s.proposed = a;
        s.proposedAt = uint64(block.timestamp);
        emit Proposed(id, a);
    }

    function dispute(uint256 id) external payable {
        State storage s = states[id];
        if (s.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp >= s.proposedAt + disputeWindow) revert TooLate();
        if (msg.value != disputeBond) revert BadBond();
        s.status = Status.Disputed;
        s.disputer = msg.sender;
        emit Disputed(id, msg.sender, msg.value);
    }

    /// Governance answers a disputed question. The bond goes back if the proposed answer changed, else to governance.
    function settleDispute(uint256 id, Answer a) external onlyGov {
        State storage s = states[id];
        if (s.status != Status.Disputed) revert WrongStatus();
        if (a == Answer.None) revert BadParams();
        owed[a != s.proposed ? s.disputer : governance] += disputeBond;
        _final(id, a, true);
    }

    function finalize(uint256 id) external {
        State storage s = states[id];
        if (s.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp < s.proposedAt + disputeWindow) revert NotYet();
        _final(id, s.proposed, false);
    }

    function _final(uint256 id, Answer a, bool byGov) private {
        State storage s = states[id];
        s.status = Status.Final;
        s.answer = a;
        if (s.foresightId != 0) foresight.resolve(s.foresightId, uint8(a));
        emit Finalized(id, a, byGov);
    }

    // ------------------------------------------------------------------ pay out

    /// What `who` gets back from a final question.
    function payoutOf(uint256 id, address who) public view returns (uint256) {
        State storage s = states[id];
        if (s.status != Status.Final || claimed[id][who]) return 0;
        uint256 y = yesOf[id][who];
        uint256 n = noOf[id][who];
        uint256 total = uint256(s.yes) + s.no;
        if (s.answer == Answer.Void) return y + n;
        uint256 winStake = s.answer == Answer.Yes ? y : n;
        uint256 winTotal = s.answer == Answer.Yes ? s.yes : s.no;
        if (winTotal == 0) return y + n; // nobody was right: everyone gets their stake back
        return (winStake * total) / winTotal;
    }

    function claim(uint256 id, address who) external {
        uint256 amount = payoutOf(id, who);
        if (amount == 0) revert NothingToClaim();
        claimed[id][who] = true;
        owed[who] += amount;
        emit Claimed(id, who, amount);
    }

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert NothingToClaim();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert SendFailed();
    }

    // ------------------------------------------------------------------ facts

    function _confirmFor(Question storage q) private view returns (uint64) {
        return q.kind == Kind.Flagged ? 0 : confirmDelay; // a flag already took a quorum of runners
    }

    function _holds(Question storage q) private view returns (bool) {
        if (q.kind == Kind.Flagged) return _flagged(q.token);
        uint256 r = _otherReserve(q.token, q.pair);
        return r * BPS <= uint256(q.baseReserve) * (BPS - q.dropBps);
    }

    function _flagged(address token) private view returns (bool) {
        if (address(threats) == address(0)) return false;
        (bool a,) = threats.isAddressFlagged(block.chainid, token);
        if (a) return true;
        (bool c,) = threats.isContractFlagged(token);
        return c;
    }

    /// The reserve of the pool's other token (the liquidity a holder of `token` can sell into).
    function _otherReserve(address token, address pair) private view returns (uint112) {
        if (pair.code.length == 0) revert BadPair();
        address t0 = IRiskPair(pair).token0();
        address t1 = IRiskPair(pair).token1();
        if (t0 != token && t1 != token) revert BadPair();
        (uint112 r0, uint112 r1,) = IRiskPair(pair).getReserves();
        return t0 == token ? r1 : r0;
    }

    /// The other side's reserve now (for pages and keepers).
    function reserveNow(uint256 id) external view returns (uint256) {
        Question storage q = questions[id];
        return q.kind == Kind.LiquidityDrop ? _otherReserve(q.token, q.pair) : 0;
    }

    function holdsNow(uint256 id) external view returns (bool) {
        return _holds(questions[id]);
    }
}
