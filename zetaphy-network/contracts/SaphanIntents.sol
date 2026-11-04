// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan intents: "I give A, I want at least B on chain Y by time T", filled by solvers, gated by Neuro
/// @notice Saphan PR 5 (docs/SAPHAN-PR5.md), testnet only, not audited.
///
///   SaphanIntents (ZETAPHY) holds the A of every intent in escrow (token(X) of a route, or any ERC-20 on ZETAPHY).
///     open(order) on ZETAPHY, or from chain X in one transaction: SaphanSourceGateway.depositAndCall with
///     target = this contract and data = abi.encode(order).
///   A solver pays the recipient B from its own money on chain Y (SaphanFillRelay.fill: the ETH goes to the recipient
///     at once) and is repaid the A on ZETAPHY once the fill is proven:
///       - by the fill's own message: SaphanFillRelay sends it through Y's Hyperlane Mailbox; the Mailbox on ZETAPHY
///         checks the ISM (the Hyperlane validators that already attest the routes' transfers) before handle();
///       - or optimistically, faster: claimFill with a bond; with no challenge within challengeWindow, settle() repays.
///         A challenge (with its own bond) leaves only the fill's message to decide: if it does not come within
///         disputePeriod the claim was false and the solver's bond goes to the challenger.
///     Fills on ZETAPHY itself (Y = ZETAPHY, B an ERC-20) are atomic: fillLocal pays the recipient and repays the
///     solver in one transaction.
///   Neuro gates fills: when the intent opens, the recipient is looked up in NeuroScore (Neuro's on-chain risk model)
///     and the ThreatRegistry. High risk, held or enforced: the intent is refused (from X the Gateway refunds it).
///     Medium risk: fills count only after riskDelay (notBefore), so watchers and guardians get time. A solver the
///     ThreatRegistry holds cannot fill or claim.
///   Unfilled past deadline + grace: refund() owes A back to refundTo (pull). The grace lets a fill made just before
///     the deadline still arrive.
///   Every payout is a pull (claim / withdrawBonds); no admin; the deployer only names each chain's relay, once.

interface IIntentToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
}

/// NeuroScore.scoreOf: level 1 low, 2 medium, 3 high (thresholds set with the model by governance).
interface IIntentScores {
    function scoreOf(address who) external view returns (bool known, int256 score, uint8 level);
}

/// ThreatRegistry's views (Reason as its uint8 value).
interface IIntentThreats {
    function isAddressHeld(uint256 chainId, address who) external view returns (bool, uint8);
    function isAddressEnforced(uint256 chainId, address who) external view returns (bool, uint8);
}

interface IIntentMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256);
}

contract SaphanIntents {
    struct Order {
        address tokenIn;      // what the user gives, on ZETAPHY (token(X) when it came from chain X)
        uint256 amountIn;     // A
        uint32 dstDomain;     // chain Y (its Hyperlane domain = its chain id); ZETAPHY's own id: filled here
        address tokenOut;     // Y = ZETAPHY: the ERC-20 wanted; another chain: zero (its native coin)
        address recipient;    // on Y
        uint256 minOut;       // B
        uint64 deadline;      // T (a fill must happen by then)
        address refundTo;     // on ZETAPHY: who gets A back when nobody fills
    }

    enum Status { None, Open, Claimed, Filled, Refunded }

    struct Intent {
        Order order;
        Status status;
        uint64 notBefore;     // risk delay: fills count from then on
        address solver;       // an optimistic claim: who claims to have filled
        address repayTo;
        uint64 claimedAt;
        address challenger;
    }

    bytes32 public constant TAG = keccak256("saphan/intent/v1");
    uint64 public constant MAX_DURATION = 30 days;
    uint8 public constant MEDIUM = 2;
    uint8 public constant HIGH = 3;

    IIntentScores public immutable scores;     // NeuroScore (zero: no score check)
    IIntentThreats public immutable threats;   // ThreatRegistry (zero: no flag check)
    address public immutable mailbox;          // the Mailbox on ZETAPHY
    /// Hyperlane reads it: the ISM for fill messages (e.g. a routing ISM over each chain's Hyperlane validators).
    address public immutable interchainSecurityModule;
    uint256 public immutable claimBond;        // ZTPHY a solver puts up per optimistic claim
    uint256 public immutable challengeBond;    // ZTPHY a challenger puts up
    uint64 public immutable challengeWindow;
    uint64 public immutable disputePeriod;     // how long a challenged claim waits for the fill's message
    uint64 public immutable grace;             // after the deadline, before a refund
    uint64 public immutable riskDelay;         // medium risk: fills count only after this
    address public immutable deployer;

    mapping(uint32 => bytes32) public relays;  // SaphanFillRelay per chain (set once each)
    mapping(bytes32 => Intent) private _intents;
    uint256 public nonce;
    mapping(address => uint256) public accounted;                    // tokens held for intents and payouts
    mapping(address => mapping(address => uint256)) public owed;     // token -> who -> amount (claim)
    mapping(address => uint256) public bonds;                        // ZTPHY owed (withdrawBonds)
    uint256 private entered;

    event RelaySet(uint32 indexed domain, bytes32 relay);
    event Opened(bytes32 indexed id, address indexed owner, uint256 srcChainId, Order order, uint64 notBefore);
    event Filled(bytes32 indexed id, address indexed solver, address repayTo, uint256 amountOut, bool proven);
    event FillRejected(bytes32 indexed id, address indexed solver, uint32 origin);
    event ClaimMade(bytes32 indexed id, address indexed solver, address repayTo);
    event Challenged(bytes32 indexed id, address indexed challenger);
    event Slashed(bytes32 indexed id, address indexed solver, address indexed to, uint256 amount);
    event Refunded(bytes32 indexed id, address refundTo, uint256 amount);
    event Claimed(address indexed who, address indexed token, uint256 amount);

    error BadOrder(uint256 code);
    error Risky(uint8 level);
    error SolverHeld();
    error WrongStatus();
    error TooEarly();
    error TooLate();
    error Bond(uint256 needed);
    error NotMailbox();
    error NoValue();
    error WrongSender();
    error Short(uint256 have, uint256 need);
    error Nothing();
    error PayFailed();
    error Reentered();

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(IIntentScores scores_, IIntentThreats threats_, address mailbox_, address ism_, uint256 claimBond_, uint256 challengeBond_,
        uint64 challengeWindow_, uint64 disputePeriod_, uint64 grace_, uint64 riskDelay_)
    {
        require(mailbox_ != address(0) && claimBond_ > 0 && challengeBond_ > 0 && challengeWindow_ > 0 && disputePeriod_ > challengeWindow_, "config");
        scores = scores_;
        threats = threats_;
        mailbox = mailbox_;
        interchainSecurityModule = ism_;
        claimBond = claimBond_;
        challengeBond = challengeBond_;
        challengeWindow = challengeWindow_;
        disputePeriod = disputePeriod_;
        grace = grace_;
        riskDelay = riskDelay_;
        deployer = msg.sender;
    }

    /// Once per chain, by the deployer: the SaphanFillRelay there (deployed after this contract, it names this one).
    function setRelay(uint32 domain, address relay) external {
        require(msg.sender == deployer && relays[domain] == bytes32(0) && relay != address(0) && domain != uint32(block.chainid), "relay");
        relays[domain] = bytes32(uint256(uint160(relay)));
        emit RelaySet(domain, relays[domain]);
    }

    function intentOf(bytes32 id) external view returns (Intent memory) { return _intents[id]; }

    // ---- risk (Neuro) ----

    /// When fills to `recipient` on `domain` may count: now, now + riskDelay (medium risk), or never (reverts Risky).
    function riskGate(address recipient, uint32 domain) public view returns (uint64 notBefore) {
        if (address(threats) != address(0)) {
            (bool held, ) = threats.isAddressHeld(domain, recipient);
            (bool enforced, ) = threats.isAddressEnforced(domain, recipient);
            if (held || enforced) revert Risky(HIGH);
        }
        notBefore = uint64(block.timestamp);
        if (address(scores) != address(0)) {
            (bool known, , uint8 level) = scores.scoreOf(recipient);
            if (known && level >= HIGH) revert Risky(level);
            if (known && level == MEDIUM) notBefore += riskDelay;
        }
    }

    function _solverOk(address solver) private view {
        if (address(threats) == address(0)) return;
        (bool held, ) = threats.isAddressHeld(block.chainid, solver);
        if (held) revert SolverHeld();
    }

    // ---- opening ----

    /// Opens an intent with the caller's tokens (approve this contract for amountIn of tokenIn first).
    function open(Order calldata o) external nonReentrant returns (bytes32 id) {
        uint64 notBefore = _check(o);
        uint256 need = accounted[o.tokenIn] + o.amountIn;
        id = _open(o, notBefore, msg.sender, block.chainid, o.amountIn);
        if (!IIntentToken(o.tokenIn).transferFrom(msg.sender, address(this), o.amountIn)) revert PayFailed();
        uint256 have = IIntentToken(o.tokenIn).balanceOf(address(this));
        if (have < need) revert Short(have, need);
    }

    /// From chain X through its ZetaphyGateway (data = abi.encode(order)), after the Gateway handed over the tokens.
    /// Reverting (risky recipient, bad order, tokens missing) makes the Gateway refund the user on X.
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256, bytes calldata data) external nonReentrant {
        Order memory o = abi.decode(data, (Order));
        if (token != o.tokenIn) revert BadOrder(0);
        uint64 notBefore = _check(o);
        uint256 received = IIntentToken(token).balanceOf(address(this)) - accounted[token];
        if (received < o.amountIn) revert Short(received, o.amountIn);
        _open(o, notBefore, sender, srcChainId, received);
    }

    /// The checks of an order and its risk gate: when fills may count (reverts when the order cannot open).
    function check(Order calldata o) external view returns (uint64 notBefore) { return _check(o); }

    function _check(Order memory o) private view returns (uint64) {
        if (o.tokenIn == address(0) || o.amountIn == 0 || o.recipient == address(0) || o.minOut == 0 || o.refundTo == address(0)) revert BadOrder(1);
        if (o.deadline <= block.timestamp || o.deadline > block.timestamp + MAX_DURATION) revert BadOrder(2);
        if (o.dstDomain == uint32(block.chainid)) { if (o.tokenOut == address(0)) revert BadOrder(3); }
        else if (o.tokenOut != address(0) || relays[o.dstDomain] == bytes32(0)) revert BadOrder(4);
        return riskGate(o.recipient, o.dstDomain);
    }

    function _open(Order memory o, uint64 notBefore, address owner, uint256 srcChainId, uint256 received) private returns (bytes32 id) {
        id = keccak256(abi.encode(TAG, block.chainid, address(this), nonce++));
        Intent storage it = _intents[id];
        it.order = o;
        it.status = Status.Open;
        it.notBefore = notBefore;
        accounted[o.tokenIn] += received;
        if (received > o.amountIn) owed[o.tokenIn][o.refundTo] += received - o.amountIn;
        emit Opened(id, owner, srcChainId, o, notBefore);
    }

    // ---- fills ----

    /// Y = ZETAPHY: the solver pays the recipient `amountOut` (>= minOut) of tokenOut and is owed A at once.
    function fillLocal(bytes32 id, uint256 amountOut, address repayTo) external nonReentrant {
        Intent storage it = _intents[id];
        Order storage o = it.order;
        if (it.status != Status.Open || o.dstDomain != uint32(block.chainid)) revert WrongStatus();
        if (block.timestamp < it.notBefore) revert TooEarly();
        if (block.timestamp > o.deadline) revert TooLate();
        if (amountOut < o.minOut || repayTo == address(0)) revert BadOrder(5);
        _solverOk(msg.sender);
        riskGate(o.recipient, o.dstDomain); // still not risky now
        _repay(id, it, repayTo);
        emit Filled(id, msg.sender, repayTo, amountOut, true);
        if (!IIntentToken(o.tokenOut).transferFrom(msg.sender, o.recipient, amountOut)) revert PayFailed();
    }

    /// The Mailbox, after the ISM checked it: a fill made on chain `origin` by its SaphanFillRelay.
    /// A fill that does not match an open intent is consumed and rejected (it never blocks the Mailbox).
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != mailbox) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (sender == bytes32(0) || sender != relays[origin]) revert WrongSender();
        (bytes32 id, address recipient, uint256 amount, uint64 filledAt, address solver, address repayTo) =
            abi.decode(body, (bytes32, address, uint256, uint64, address, address));
        Intent storage it = _intents[id];
        Order storage o = it.order;
        bool ok = (it.status == Status.Open || it.status == Status.Claimed) && o.dstDomain == origin && o.recipient == recipient
            && amount >= o.minOut && filledAt <= o.deadline && filledAt >= it.notBefore && repayTo != address(0);
        if (!ok) { emit FillRejected(id, solver, origin); return; }
        if (it.status == Status.Claimed) {
            if (it.solver == solver) {
                bonds[solver] += claimBond;                                  // the claim was true
                if (it.challenger != address(0)) bonds[solver] += challengeBond; // and the challenge was not
            } else _slash(id, it, it.challenger != address(0) ? it.challenger : solver); // someone else filled: the claim was false
        }
        _repay(id, it, repayTo);
        emit Filled(id, solver, repayTo, amount, true);
    }

    function _repay(bytes32, Intent storage it, address repayTo) private {
        it.status = Status.Filled;
        it.solver = address(0);
        it.challenger = address(0);
        owed[it.order.tokenIn][repayTo] += it.order.amountIn;
    }

    /// The claimer's bond goes to `to` (with its own challenge bond back when `to` is the challenger).
    function _slash(bytes32 id, Intent storage it, address to) private {
        uint256 v = claimBond + (to == it.challenger ? challengeBond : 0);
        bonds[to] += v;
        emit Slashed(id, it.solver, to, claimBond);
    }

    // ---- optimistic claims ----

    /// A solver that filled on chain Y claims it now, with `claimBond` (msg.value, exactly), instead of waiting for
    /// the fill's message. Repaid by settle() after challengeWindow unless someone challenges.
    function claimFill(bytes32 id, address repayTo) external payable {
        Intent storage it = _intents[id];
        if (msg.value != claimBond) revert Bond(claimBond);
        if (it.status != Status.Open || it.order.dstDomain == uint32(block.chainid) || repayTo == address(0)) revert WrongStatus();
        if (block.timestamp < it.notBefore) revert TooEarly();
        if (block.timestamp > uint256(it.order.deadline) + grace) revert TooLate();
        _solverOk(msg.sender);
        it.status = Status.Claimed;
        it.solver = msg.sender;
        it.repayTo = repayTo;
        it.claimedAt = uint64(block.timestamp);
        emit ClaimMade(id, msg.sender, repayTo);
    }

    /// Anyone, within challengeWindow, with `challengeBond`: "this claim is false". Only the fill's message can then
    /// repay the solver.
    function challenge(bytes32 id) external payable {
        Intent storage it = _intents[id];
        if (msg.value != challengeBond) revert Bond(challengeBond);
        if (it.status != Status.Claimed || it.challenger != address(0)) revert WrongStatus();
        if (block.timestamp > uint256(it.claimedAt) + challengeWindow) revert TooLate();
        it.challenger = msg.sender;
        emit Challenged(id, msg.sender);
    }

    /// Anyone, after an unchallenged window: the claim stands; the solver is repaid and gets its bond back.
    function settle(bytes32 id) external {
        Intent storage it = _intents[id];
        if (it.status != Status.Claimed || it.challenger != address(0)) revert WrongStatus();
        if (block.timestamp <= uint256(it.claimedAt) + challengeWindow) revert TooEarly();
        bonds[it.solver] += claimBond;
        emit Filled(id, it.solver, it.repayTo, 0, false);
        _repay(id, it, it.repayTo);
    }

    /// Anyone, when a challenged claim saw no fill message within disputePeriod: the claim was false. The solver's
    /// bond goes to the challenger, and the intent is open again.
    function timeout(bytes32 id) external {
        Intent storage it = _intents[id];
        if (it.status != Status.Claimed || it.challenger == address(0)) revert WrongStatus();
        if (block.timestamp <= uint256(it.claimedAt) + disputePeriod) revert TooEarly();
        _slash(id, it, it.challenger);
        it.status = Status.Open;
        it.solver = address(0);
        it.challenger = address(0);
    }

    // ---- refunds and payouts ----

    /// Anyone, after deadline + grace with no fill: A is owed back to refundTo.
    function refund(bytes32 id) external {
        Intent storage it = _intents[id];
        if (it.status != Status.Open) revert WrongStatus();
        if (block.timestamp <= uint256(it.order.deadline) + grace) revert TooEarly();
        it.status = Status.Refunded;
        owed[it.order.tokenIn][it.order.refundTo] += it.order.amountIn;
        emit Refunded(id, it.order.refundTo, it.order.amountIn);
    }

    /// The caller's repayments and refunds in `token`.
    function claim(address token) external nonReentrant {
        uint256 v = owed[token][msg.sender];
        if (v == 0) revert Nothing();
        owed[token][msg.sender] = 0;
        accounted[token] -= v;
        emit Claimed(msg.sender, token, v);
        if (!IIntentToken(token).transfer(msg.sender, v)) revert PayFailed();
    }

    /// The caller's bonds (back, or won) in ZTPHY.
    function withdrawBonds() external nonReentrant {
        uint256 v = bonds[msg.sender];
        if (v == 0) revert Nothing();
        bonds[msg.sender] = 0;
        emit Claimed(msg.sender, address(0), v);
        (bool ok, ) = msg.sender.call{value: v}("");
        if (!ok) revert PayFailed();
    }
}

/// @title SaphanFillRelay: on chain Y, a solver pays an intent's recipient and tells SaphanIntents through Hyperlane
contract SaphanFillRelay {
    IIntentMailbox public immutable mailbox;  // Y's Mailbox
    uint32 public immutable zetaphyDomain;
    bytes32 public immutable intents;         // SaphanIntents on ZETAPHY
    mapping(bytes32 => address) public filledBy; // each intent is filled once here

    event Fill(bytes32 indexed id, address indexed solver, address indexed recipient, uint256 amount, address repayTo, bytes32 messageId);

    error Filled();
    error Fee(uint256 needed);
    error PayFailed();

    constructor(IIntentMailbox mailbox_, uint32 zetaphyDomain_, address intents_) {
        require(address(mailbox_) != address(0) && intents_ != address(0), "config");
        mailbox = mailbox_;
        zetaphyDomain = zetaphyDomain_;
        intents = bytes32(uint256(uint160(intents_)));
    }

    function body(bytes32 id, address recipient, uint256 amount, address solver, address repayTo) public view returns (bytes memory) {
        return abi.encode(id, recipient, amount, uint64(block.timestamp), solver, repayTo);
    }

    /// The Mailbox fee of a fill (pay amount + this).
    function quote(bytes32 id, address recipient, uint256 amount, address repayTo) external view returns (uint256) {
        return mailbox.quoteDispatch(zetaphyDomain, intents, body(id, recipient, amount, msg.sender, repayTo));
    }

    /// The solver: pays `recipient` `amount` now (msg.value = amount + the Mailbox fee, exactly) and sends the
    /// proof of it to ZETAPHY, where `repayTo` will be owed the intent's A. Check the intent first (intentOf on
    /// ZETAPHY: open, this recipient, amount >= minOut, before its deadline and after notBefore): a fill that does
    /// not match is rejected there and not repaid.
    function fill(bytes32 id, address recipient, uint256 amount, address repayTo) external payable returns (bytes32 messageId) {
        if (filledBy[id] != address(0)) revert Filled();
        filledBy[id] = msg.sender;
        bytes memory b = body(id, recipient, amount, msg.sender, repayTo);
        uint256 fee = mailbox.quoteDispatch(zetaphyDomain, intents, b);
        if (msg.value != amount + fee) revert Fee(amount + fee);
        messageId = mailbox.dispatch{value: fee}(zetaphyDomain, intents, b);
        emit Fill(id, msg.sender, recipient, amount, repayTo, messageId);
        (bool ok, ) = recipient.call{value: msg.value - fee}("");
        if (!ok) revert PayFailed();
    }
}
