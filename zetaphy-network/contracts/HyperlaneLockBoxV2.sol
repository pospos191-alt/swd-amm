// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ZETAPHY Saphan, EVM routes, version 2: both directions, one stack per source chain.
//
//   source chain (Sepolia, Base Sepolia, Arbitrum Sepolia, ...)       ZETAPHY
//   HyperlaneLockBoxV2 --lock: Hyperlane message------------------->  HyperlaneLane -> BridgeAirlock -> BridgeGuard mints
//                      <--release: Hyperlane message, verified by--   HyperlaneOutbox <- BridgeGuard burns (outbound route)
//                         OUR validator(s) for origin ZETAPHY
//
// Each source chain has its own BridgeGuard and so its own bridged token on ZETAPHY
// (docs/SAPHAN-MULTICHAIN.md): a hole in one source chain's route can only mint that
// route's token, which only that route's outbox can burn, and only that route's
// lockbox releases for it. Nobody can drain the ETH locked on chain B with a message
// or a token of chain A.
//
// Local copies of the Hyperlane v3 interfaces, checked against hyperlane-xyz/hyperlane-monorepo
// at commit 1aadbba0696ecf96ed4c06f78c978d08db22c0ad (main, 2026-10-28): IMailbox,
// IMessageRecipient, IInterchainSecurityModule and ISpecifiesInterchainSecurityModule. Named
// apart from HyperlaneLane.sol's copies (the build compiles every file in one unit).

interface ISaphanMailbox {
    function localDomain() external view returns (uint32);
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256 fee);
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody, bytes calldata customHookMetadata, address customHook) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody, bytes calldata customHookMetadata, address customHook) external view returns (uint256 fee);
}

interface ISaphanIsm {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

/// BridgeGuard as an outbound adapter sees it: burns `amount` of the route's token from `from`.
interface IGuardOutbound {
    function outbound(bytes32 route, address from, uint256 amount) external;
}

/// @title HyperlaneLockBoxV2: the source-chain side, both directions
/// @notice Lock (source -> ZETAPHY): exactly HyperlaneLockBox's message and its `Locked`
///         event (the Neuro runners watch it, `zetaphy bridge watch --lockbox <this>`), so the
///         HyperlaneLane on ZETAPHY is unchanged. msg.value = amount + quoteLock(); the Mailbox
///         gets exactly the quote and anything above is sent back.
///
///         Release (ZETAPHY -> source): handle() takes a message only
///           - from the configured Mailbox (msg.sender), after the ISM this contract names
///             (interchainSecurityModule: a multisig ISM of OUR validators for origin ZETAPHY,
///             never the Mailbox default; set at deploy, changed only by governance),
///           - from origin domain ZETAPHY and the one HyperlaneOutbox of this route (sender),
///           - whose body names ZETAPHY's chain id and that outbox as the source, and this
///             chain and this contract as the destination,
///         and each message once. It never pays at once: the release is queued and can be
///         claimed (by anyone, paid to its receiver) after `releaseDelay`, while
///           - not vetoed (a guardian or governance vetoes during the delay or later),
///           - not paused (guardians pause; only governance unpauses),
///           - within the daily release limit (over it, the claim waits for the next day),
///           - within what this contract holds for locks (`locked`: locks minus releases), so
///             even a forged message can never take more than this route's own deposits.
///         A message is never refused for a limit or a pause: it is recorded, and the money
///         moves only when every check passes (nothing depends on the relayer retrying).
///
///         Roles: governance (the source chain's timelock: its multisig proposes, 48 h) changes
///         the ISM, raises limits, lifts vetoes, unpauses; guardians (a multisig) only reduce
///         risk, at once: pause, veto, lower the daily limit, lengthen the delay.
contract HyperlaneLockBoxV2 {
    struct Release {
        address to;
        uint64 readyAt;      // zero: no such release
        bool claimed;
        bool vetoed;
        uint256 amount;
    }

    ISaphanMailbox public immutable mailbox;
    uint32 public immutable zetaphyDomain;   // ZETAPHY's Hyperlane domain (77390)
    uint256 public immutable zetaphyChainId; // ZETAPHY's EVM chain id, as the outbox writes it (77390)
    bytes32 public immutable recipient;      // HyperlaneLane on ZETAPHY (locks go there)
    bytes32 public immutable remoteSender;   // HyperlaneOutbox on ZETAPHY (the only sender of releases)
    address public immutable hook;           // zero = the Mailbox default hook, for locks

    uint64 public constant MAX_RELEASE_DELAY = 30 days;

    address public governance;
    mapping(address => bool) public guardian;
    /// Hyperlane reads this (ISpecifiesInterchainSecurityModule). Never zero here: the Mailbox's
    /// default ISM is Hyperlane's, which does not know our validators for origin ZETAPHY.
    ISaphanIsm public interchainSecurityModule;
    bool public paused;
    uint256 public dailyLimit;               // wei released per day (UTC day)
    uint256 public releasedToday;
    uint64 public day;
    uint64 public releaseDelay;              // seconds between a message and its claim

    uint256 public nonce;                    // locks
    uint256 public received;                 // release messages recorded (the relayer workflow compares it with the outbox's nonce)
    uint256 public locked;                   // backing: everything locked minus everything released
    /// Each lock's transfer id (keccak256 of its body = BridgeAirlock.transferId): the relayer workflow asks the
    /// HyperlaneLane on ZETAPHY whether the latest one arrived (delivered(id)) instead of running for days.
    mapping(uint256 => bytes32) public transferIds;
    mapping(bytes32 => Release) public releases; // by keccak256(body)

    event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount);
    event Dispatched(uint256 indexed nonce, bytes32 messageId);
    event ReleaseQueued(bytes32 indexed id, uint256 indexed srcNonce, address sender, address indexed to, uint256 amount, uint64 readyAt);
    event Released(bytes32 indexed id, address indexed to, uint256 amount);
    event ReleaseVetoed(bytes32 indexed id, address indexed by);
    event VetoLifted(bytes32 indexed id);
    event Paused(address indexed by);
    event Unpaused();
    event IsmSet(address ism);
    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);
    event DailyLimitSet(uint256 limit);
    event ReleaseDelaySet(uint64 delay);

    error NotGovernance();
    error NotGuardian();
    error NotMailbox();
    error WrongOrigin(uint32 origin);
    error WrongSender(bytes32 sender);
    error WrongSource();
    error WrongDestination();
    error BadBody();
    error Replay(bytes32 id);
    error NoValue();
    error IsPaused();
    error NoRelease();
    error AlreadyClaimed();
    error IsVetoed();
    error NotReady(uint64 readyAt);
    error OverLimit(uint256 remaining);
    error OverBacking(uint256 locked);
    error PayFailed();
    error Fee(uint256 needed);

    constructor(ISaphanMailbox mailbox_, uint32 zetaphyDomain_, uint256 zetaphyChainId_, bytes32 recipient_, bytes32 remoteSender_,
        address hook_, ISaphanIsm ism_, address governance_, address guardian_, uint256 dailyLimit_, uint64 releaseDelay_)
    {
        require(address(mailbox_) != address(0) && recipient_ != bytes32(0) && remoteSender_ != bytes32(0) && zetaphyChainId_ != 0
            && address(ism_) != address(0) && governance_ != address(0) && releaseDelay_ <= MAX_RELEASE_DELAY, "config");
        mailbox = mailbox_;
        zetaphyDomain = zetaphyDomain_;
        zetaphyChainId = zetaphyChainId_;
        recipient = recipient_;
        remoteSender = remoteSender_;
        hook = hook_;
        interchainSecurityModule = ism_;
        governance = governance_;
        dailyLimit = dailyLimit_;
        releaseDelay = releaseDelay_;
        emit IsmSet(address(ism_));
        emit GovernanceSet(governance_);
        emit DailyLimitSet(dailyLimit_);
        emit ReleaseDelaySet(releaseDelay_);
        if (guardian_ != address(0)) { guardian[guardian_] = true; emit GuardianSet(guardian_, true); }
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }
    modifier onlyGuardian() { if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian(); _; }

    // ---------------------------------------------------------------- lock (source -> ZETAPHY)

    /// The same body as HyperlaneLockBox (192 bytes), so the HyperlaneLane on ZETAPHY is unchanged.
    function body(uint256 n, address sender, address to, uint256 amount) public view returns (bytes memory) {
        return abi.encode(block.chainid, address(this), n, sender, to, amount);
    }

    /// The Mailbox fee for the next lock (pay amount + this).
    function quoteLock(address to, uint256 amount) public view returns (uint256) {
        return _quote(body(nonce, msg.sender, to, amount));
    }

    function lock(address to, uint256 amount) external payable returns (bytes32 messageId) {
        if (paused) revert IsPaused();
        require(amount > 0 && to != address(0) && msg.value >= amount, "lock");
        uint256 n = nonce++;
        bytes memory b = body(n, msg.sender, to, amount);
        uint256 fee = _quote(b);
        if (msg.value < amount + fee) revert Fee(amount + fee);
        locked += amount;
        transferIds[n] = keccak256(b);
        emit Locked(n, msg.sender, to, amount);
        messageId = hook == address(0)
            ? mailbox.dispatch{value: fee}(zetaphyDomain, recipient, b)
            : mailbox.dispatch{value: fee}(zetaphyDomain, recipient, b, "", hook);
        emit Dispatched(n, messageId);
        uint256 extra = msg.value - amount - fee;
        if (extra > 0) {
            (bool ok, ) = msg.sender.call{value: extra}("");
            if (!ok) revert PayFailed();
        }
    }

    function _quote(bytes memory b) private view returns (uint256) {
        return hook == address(0) ? mailbox.quoteDispatch(zetaphyDomain, recipient, b) : mailbox.quoteDispatch(zetaphyDomain, recipient, b, "", hook);
    }

    // ---------------------------------------------------------------- release (ZETAPHY -> source)

    /// Called by the Mailbox after interchainSecurityModule verified the message.
    /// Body (256 bytes): abi.encode(uint256 srcChainId, address srcContract, uint256 srcNonce,
    /// address sender, address to, uint256 amount, uint256 dstChainId, address dstContract).
    function handle(uint32 origin, bytes32 sender, bytes calldata b) external payable {
        if (msg.sender != address(mailbox)) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (origin != zetaphyDomain) revert WrongOrigin(origin);
        if (sender != remoteSender) revert WrongSender(sender);
        if (b.length != 256) revert BadBody();
        (uint256 srcChain, address src, uint256 n, address from, address to, uint256 amount, uint256 dstChain, address dst) =
            abi.decode(b, (uint256, address, uint256, address, address, uint256, uint256, address));
        if (srcChain != zetaphyChainId || bytes32(uint256(uint160(src))) != remoteSender) revert WrongSource();
        if (dstChain != block.chainid || dst != address(this)) revert WrongDestination();
        if (to == address(0) || amount == 0) revert BadBody();
        bytes32 id = keccak256(b);
        if (releases[id].readyAt != 0) revert Replay(id);
        uint64 readyAt = uint64(block.timestamp) + releaseDelay;
        releases[id] = Release(to, readyAt, false, false, amount);
        received += 1;
        emit ReleaseQueued(id, n, from, to, amount, readyAt);
    }

    /// Anyone: pays a queued release to its receiver once every check passes.
    function claim(bytes32 id) external {
        Release storage r = releases[id];
        if (r.readyAt == 0) revert NoRelease();
        if (r.claimed) revert AlreadyClaimed();
        if (r.vetoed) revert IsVetoed();
        if (paused) revert IsPaused();
        if (block.timestamp < r.readyAt) revert NotReady(r.readyAt);
        uint64 today = uint64(block.timestamp / 1 days);
        if (day != today) { day = today; releasedToday = 0; }
        uint256 amount = r.amount;
        if (releasedToday + amount > dailyLimit) revert OverLimit(dailyLimit > releasedToday ? dailyLimit - releasedToday : 0);
        if (amount > locked) revert OverBacking(locked);
        r.claimed = true;
        releasedToday += amount;
        locked -= amount;
        emit Released(id, r.to, amount);
        (bool ok, ) = r.to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }

    /// What can still be released today.
    function remainingToday() external view returns (uint256) {
        uint256 used = day == uint64(block.timestamp / 1 days) ? releasedToday : 0;
        return dailyLimit > used ? dailyLimit - used : 0;
    }

    // ---------------------------------------------------------------- guardians: only reduce risk, at once

    function pause() external onlyGuardian { paused = true; emit Paused(msg.sender); }

    /// Stops a release that is not paid yet (during its delay, or while it waits for a limit).
    function veto(bytes32 id) external onlyGuardian {
        Release storage r = releases[id];
        if (r.readyAt == 0) revert NoRelease();
        if (r.claimed) revert AlreadyClaimed();
        r.vetoed = true;
        emit ReleaseVetoed(id, msg.sender);
    }

    function lowerDailyLimit(uint256 v) external onlyGuardian {
        require(v < dailyLimit, "lower only");
        dailyLimit = v;
        emit DailyLimitSet(v);
    }

    function raiseReleaseDelay(uint64 d) external onlyGuardian {
        require(d > releaseDelay && d <= MAX_RELEASE_DELAY, "raise only");
        releaseDelay = d;
        emit ReleaseDelaySet(d);
    }

    // ---------------------------------------------------------------- governance (the source chain's timelock)

    function unpause() external onlyGov { paused = false; emit Unpaused(); }

    function liftVeto(bytes32 id) external onlyGov {
        Release storage r = releases[id];
        if (r.readyAt == 0) revert NoRelease();
        r.vetoed = false;
        emit VetoLifted(id);
    }

    function setDailyLimit(uint256 v) external onlyGov { dailyLimit = v; emit DailyLimitSet(v); }

    function setReleaseDelay(uint64 d) external onlyGov {
        require(d <= MAX_RELEASE_DELAY, "delay");
        releaseDelay = d;
        emit ReleaseDelaySet(d);
    }

    /// A new ISM (e.g. more of our validators, a higher threshold). Never zero.
    function setInterchainSecurityModule(ISaphanIsm ism) external onlyGov {
        require(address(ism) != address(0), "ism");
        interchainSecurityModule = ism;
        emit IsmSet(address(ism));
    }

    function setGuardian(address who, bool on) external onlyGov { guardian[who] = on; emit GuardianSet(who, on); }

    function setGovernance(address g) external onlyGov {
        require(g != address(0), "governance");
        governance = g;
        emit GovernanceSet(g);
    }
}

/// @title HyperlaneOutbox: the ZETAPHY side of the way back (ZETAPHY -> one source chain)
/// @notice send(to, amount) burns `amount` of the route's bridged token from the caller through
///         BridgeGuard (its outbound route for this outbox: daily limit, hard cap, pause,
///         vaccine) and dispatches a release to the source chain's HyperlaneLockBoxV2 through
///         ZETAPHY's Mailbox. Everything it may do is fixed at deploy (no admin): which guard
///         route burns, which domain, chain and lockbox it sends to. Closing it is the guard's:
///         a guardian pauses, governance disables the outbound route.
///         Body (256 bytes): abi.encode(block.chainid, this, nonce, sender, to, amount,
///         destinationChainId, the lockbox): the lockbox checks every field.
contract HyperlaneOutbox {
    IGuardOutbound public immutable guard;
    bytes32 public immutable route;              // this outbox's outbound route in the guard
    ISaphanMailbox public immutable mailbox;     // ZETAPHY's Mailbox
    uint32 public immutable destinationDomain;   // the source chain's Hyperlane domain
    uint256 public immutable destinationChainId; // the source chain's EVM chain id
    bytes32 public immutable recipient;          // the source chain's HyperlaneLockBoxV2
    address public immutable hook;               // zero = the Mailbox default hook
    uint256 public nonce;

    event Sent(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount, bytes32 messageId);

    error Fee(uint256 needed);
    error PayFailed();

    constructor(IGuardOutbound guard_, bytes32 route_, ISaphanMailbox mailbox_, uint32 destinationDomain_, uint256 destinationChainId_,
        bytes32 recipient_, address hook_)
    {
        require(address(guard_) != address(0) && address(mailbox_) != address(0) && recipient_ != bytes32(0) && destinationChainId_ != 0, "config");
        guard = guard_;
        route = route_;
        mailbox = mailbox_;
        destinationDomain = destinationDomain_;
        destinationChainId = destinationChainId_;
        recipient = recipient_;
        hook = hook_;
    }

    function body(uint256 n, address sender, address to, uint256 amount) public view returns (bytes memory) {
        return abi.encode(block.chainid, address(this), n, sender, to, amount, destinationChainId, address(uint160(uint256(recipient))));
    }

    /// The Mailbox fee for the next send (msg.value of send).
    function quoteSend(address to, uint256 amount) public view returns (uint256) {
        return _quote(body(nonce, msg.sender, to, amount));
    }

    function send(address to, uint256 amount) external payable returns (bytes32 messageId) {
        require(amount > 0 && to != address(0), "send");
        uint256 n = nonce++;
        bytes memory b = body(n, msg.sender, to, amount);
        uint256 fee = _quote(b);
        if (msg.value < fee) revert Fee(fee);
        guard.outbound(route, msg.sender, amount); // burns; reverts when closed, paused, over a limit or held
        messageId = hook == address(0)
            ? mailbox.dispatch{value: fee}(destinationDomain, recipient, b)
            : mailbox.dispatch{value: fee}(destinationDomain, recipient, b, "", hook);
        emit Sent(n, msg.sender, to, amount, messageId);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert PayFailed();
        }
    }

    function _quote(bytes memory b) private view returns (uint256) {
        return hook == address(0) ? mailbox.quoteDispatch(destinationDomain, recipient, b) : mailbox.quoteDispatch(destinationDomain, recipient, b, "", hook);
    }
}
