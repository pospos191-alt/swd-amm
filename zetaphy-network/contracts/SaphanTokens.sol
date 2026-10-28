// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ZETAPHY Saphan, token routes: tokens BORN on ZETAPHY go out to an EVM chain and come back
// (the reverse of the v2 ETH routes in HyperlaneLockBoxV2.sol). docs/SAPHAN-TOKENS.md.
//
//   ZETAPHY                                                     destination chain X (Sepolia, Base Sepolia, ...)
//   ZetaphyTokenVault(token, X) --lock: Hyperlane message---->  SaphanSyntheticToken(token, X) queues a mint,
//     escrows the token             (ISM on X: OUR validators   mints after the delay (veto, daily cap, supply cap, pause)
//                                    for origin ZETAPHY)
//     queues a release <-----------burn: Hyperlane message----- sendBack(): burns, dispatches
//     pays after the delay          (ISM on ZETAPHY: Hyperlane's validator(s) for origin X)
//     (veto, daily limit, pause, never more than it locked for X)
//
// One vault per (token, destination) and one synthetic per (token, destination): a hole on chain X (or in X's
// synthetic, or X's validators) can only ask vault(token, X) for a release, and that vault pays at most what was
// locked in it for X. It cannot reach another token's vault or another destination's escrow.
//
// Local copies of the Hyperlane v3 interfaces, checked against hyperlane-xyz/hyperlane-monorepo at commit
// 1aadbba0696ecf96ed4c06f78c978d08db22c0ad (as HyperlaneLockBoxV2.sol): IMailbox dispatch / quoteDispatch,
// IMessageRecipient.handle, ISpecifiesInterchainSecurityModule.interchainSecurityModule. Named apart from the
// other files' copies (the build compiles every file in one unit and names artifacts by contract).

interface ISaphanTokenMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256 fee);
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody, bytes calldata customHookMetadata, address customHook) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody, bytes calldata customHookMetadata, address customHook) external view returns (uint256 fee);
}

interface ISaphanTokenIsm {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

/// ThreatRegistry's hold view for ZETAPHY addresses (as BridgeGuard uses it).
interface ISaphanTokenThreats {
    function isContractHeld(address who) external view returns (bool, uint8);
}

/// @title SaphanTokenEndpoint: what both ends of a token route share
/// @notice Sending: the subclass takes the tokens (_take: the vault escrows, the synthetic burns), then this
///         dispatches a 288-byte body through the local Mailbox to the one remote contract:
///           abi.encode(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to,
///                      uint256 amount, uint256 dstChainId, address dstContract, address originToken)
///         `originToken` is the token's address on ZETAPHY (the same on both ends), so a message of token A can
///         never be taken by token B's endpoint even if every other field matched.
///         Receiving: handle() takes a message only from the Mailbox (after the ISM this contract names, never the
///         Mailbox default, never zero), from the remote domain and the remote contract (sender), whose body names
///         the remote chain and contract as the source, this chain and contract as the destination, and this
///         route's origin token; each message once. It never pays at once: the payout is queued (Queued) and anyone
///         claims it after `delay`, while not vetoed, not paused and within the daily limit (over it, it waits for
///         the next UTC day); the subclass adds its own bound (_pay: the vault's backing, the synthetic's supply
///         cap). A message is never refused for a limit or a pause, so nothing depends on the relayer retrying.
///         Starts PAUSED (deployed closed): opening is governance's unpause, on both ends.
///         Roles: governance (a timelock: 48 h) unpauses, lifts vetoes, raises limits, changes the ISM; guardians
///         (a multisig) only reduce risk, at once: pause, veto, lower the daily limit, lengthen the delay.
abstract contract SaphanTokenEndpoint {
    struct Pending {
        address to;
        uint64 readyAt;      // zero: no such message
        bool done;
        bool vetoed;
        uint256 amount;
    }

    /// The message body (288 bytes, abi.encode of these fields in this order).
    struct Body {
        uint256 srcChainId;
        address srcContract;
        uint256 srcNonce;
        address sender;
        address to;
        uint256 amount;
        uint256 dstChainId;
        address dstContract;
        address originToken;
    }

    ISaphanTokenMailbox public immutable mailbox;
    uint32 public immutable remoteDomain;     // the other end's Hyperlane domain
    uint256 public immutable remoteChainId;   // the other end's EVM chain id, as it writes it into bodies
    bytes32 public immutable remote;          // the other end's contract (the only sender, the only recipient)
    address public immutable hook;            // zero = the Mailbox default hook
    address public immutable originToken;     // the token's address on ZETAPHY

    uint64 public constant MAX_DELAY = 30 days;
    uint256 public constant BODY_LENGTH = 288;

    address public governance;
    mapping(address => bool) public guardian;
    /// Hyperlane reads this (ISpecifiesInterchainSecurityModule). Never zero.
    ISaphanTokenIsm public interchainSecurityModule;
    bool public paused;
    uint256 public dailyLimit;                // token units paid out (released / minted) per UTC day
    uint256 public paidToday;
    uint64 public day;
    uint64 public delay;                      // seconds between a message and its claim

    uint256 public nonce;                     // messages sent
    uint256 public received;                  // messages recorded (the relayer workflow compares it with the other end's nonce)
    mapping(bytes32 => Pending) public pending; // by keccak256(body)
    uint256 private entered = 1;

    event Sent(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount, bytes32 messageId);
    event Queued(bytes32 indexed id, uint256 indexed srcNonce, address sender, address indexed to, uint256 amount, uint64 readyAt);
    event Paid(bytes32 indexed id, address indexed to, uint256 amount);
    event Vetoed(bytes32 indexed id, address indexed by);
    event VetoLifted(bytes32 indexed id);
    event Paused(address indexed by);
    event Unpaused();
    event IsmSet(address ism);
    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);
    event DailyLimitSet(uint256 limit);
    event DelaySet(uint64 delay);

    error NotGovernance();
    error NotGuardian();
    error NotMailbox();
    error WrongOrigin(uint32 origin);
    error WrongSender(bytes32 sender);
    error WrongSource();
    error WrongDestination();
    error WrongToken(address token);
    error BadBody();
    error Replay(bytes32 id);
    error NoValue();
    error IsPaused();
    error NoMessage();
    error AlreadyDone();
    error IsVetoed();
    error NotReady(uint64 readyAt);
    error OverLimit(uint256 remaining);
    error PayFailed();
    error Fee(uint256 needed);
    error Reentered();

    /// Deploy settings shared by both ends (one tuple: fewer constructor arguments).
    struct Config {
        ISaphanTokenMailbox mailbox;
        uint32 remoteDomain;
        uint256 remoteChainId;
        bytes32 remote;
        address hook;
        address originToken;
        ISaphanTokenIsm ism;
        address governance;
        address guardian;
        uint256 dailyLimit;
        uint64 delay;
    }

    constructor(Config memory c) {
        require(address(c.mailbox) != address(0) && c.remote != bytes32(0) && c.remoteChainId != 0 && c.originToken != address(0)
            && address(c.ism) != address(0) && c.governance != address(0) && c.delay <= MAX_DELAY, "config");
        mailbox = c.mailbox;
        remoteDomain = c.remoteDomain;
        remoteChainId = c.remoteChainId;
        remote = c.remote;
        hook = c.hook;
        originToken = c.originToken;
        interchainSecurityModule = c.ism;
        governance = c.governance;
        dailyLimit = c.dailyLimit;
        delay = c.delay;
        paused = true;
        emit IsmSet(address(c.ism));
        emit GovernanceSet(c.governance);
        emit DailyLimitSet(c.dailyLimit);
        emit DelaySet(c.delay);
        emit Paused(msg.sender);
        if (c.guardian != address(0)) { guardian[c.guardian] = true; emit GuardianSet(c.guardian, true); }
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }
    modifier onlyGuardian() { if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian(); _; }
    modifier nonReentrant() { if (entered != 1) revert Reentered(); entered = 2; _; entered = 1; }

    // ---------------------------------------------------------------- what the two ends do differently

    /// Takes `amount` from msg.sender for a send (the vault escrows it, the synthetic burns it).
    function _take(address from, uint256 amount) internal virtual;
    /// Pays a claimed message (the vault releases within its backing, the synthetic mints within its cap).
    function _pay(address to, uint256 amount) internal virtual;

    // ---------------------------------------------------------------- sending

    function body(uint256 n, address sender, address to, uint256 amount) public view returns (bytes memory) {
        return abi.encode(block.chainid, address(this), n, sender, to, amount, remoteChainId, address(uint160(uint256(remote))), originToken);
    }

    /// The Mailbox fee for the next send (msg.value of the send).
    function quote(address to, uint256 amount) public view returns (uint256) {
        return _quote(body(nonce, msg.sender, to, amount));
    }

    function _send(address to, uint256 amount) internal returns (bytes32 messageId) {
        if (paused) revert IsPaused();
        require(amount > 0 && to != address(0), "send");
        uint256 n = nonce++;
        bytes memory b = body(n, msg.sender, to, amount);
        uint256 fee = _quote(b);
        if (msg.value < fee) revert Fee(fee);
        _take(msg.sender, amount);
        messageId = hook == address(0)
            ? mailbox.dispatch{value: fee}(remoteDomain, remote, b)
            : mailbox.dispatch{value: fee}(remoteDomain, remote, b, "", hook);
        emit Sent(n, msg.sender, to, amount, messageId);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert PayFailed();
        }
    }

    function _quote(bytes memory b) private view returns (uint256) {
        return hook == address(0) ? mailbox.quoteDispatch(remoteDomain, remote, b) : mailbox.quoteDispatch(remoteDomain, remote, b, "", hook);
    }

    // ---------------------------------------------------------------- receiving

    /// Called by the Mailbox after interchainSecurityModule verified the message.
    function handle(uint32 origin, bytes32 sender, bytes calldata b) external payable {
        if (msg.sender != address(mailbox)) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (origin != remoteDomain) revert WrongOrigin(origin);
        if (sender != remote) revert WrongSender(sender);
        if (b.length != BODY_LENGTH) revert BadBody();
        Body memory m = abi.decode(b, (Body));
        if (m.srcChainId != remoteChainId || bytes32(uint256(uint160(m.srcContract))) != remote) revert WrongSource();
        if (m.dstChainId != block.chainid || m.dstContract != address(this)) revert WrongDestination();
        if (m.originToken != originToken) revert WrongToken(m.originToken);
        if (m.to == address(0) || m.amount == 0) revert BadBody();
        bytes32 id = keccak256(b);
        if (pending[id].readyAt != 0) revert Replay(id);
        uint64 readyAt = uint64(block.timestamp) + delay;
        pending[id] = Pending(m.to, readyAt, false, false, m.amount);
        received += 1;
        emit Queued(id, m.srcNonce, m.sender, m.to, m.amount, readyAt);
    }

    /// Anyone: pays a queued message to its receiver once every check passes.
    function claim(bytes32 id) external nonReentrant {
        Pending storage p = pending[id];
        if (p.readyAt == 0) revert NoMessage();
        if (p.done) revert AlreadyDone();
        if (p.vetoed) revert IsVetoed();
        if (paused) revert IsPaused();
        if (block.timestamp < p.readyAt) revert NotReady(p.readyAt);
        uint64 today = uint64(block.timestamp / 1 days);
        if (day != today) { day = today; paidToday = 0; }
        uint256 amount = p.amount;
        if (paidToday + amount > dailyLimit) revert OverLimit(dailyLimit > paidToday ? dailyLimit - paidToday : 0);
        p.done = true;
        paidToday += amount;
        emit Paid(id, p.to, amount);
        _pay(p.to, amount);
    }

    /// What can still be paid out today.
    function remainingToday() external view returns (uint256) {
        uint256 used = day == uint64(block.timestamp / 1 days) ? paidToday : 0;
        return dailyLimit > used ? dailyLimit - used : 0;
    }

    // ---------------------------------------------------------------- guardians: only reduce risk, at once

    function pause() external onlyGuardian { paused = true; emit Paused(msg.sender); }

    /// Stops a queued payout that is not paid yet (during its delay, or while it waits for a limit).
    function veto(bytes32 id) external onlyGuardian {
        Pending storage p = pending[id];
        if (p.readyAt == 0) revert NoMessage();
        if (p.done) revert AlreadyDone();
        p.vetoed = true;
        emit Vetoed(id, msg.sender);
    }

    function lowerDailyLimit(uint256 v) external onlyGuardian {
        require(v < dailyLimit, "lower only");
        dailyLimit = v;
        emit DailyLimitSet(v);
    }

    function raiseDelay(uint64 d) external onlyGuardian {
        require(d > delay && d <= MAX_DELAY, "raise only");
        delay = d;
        emit DelaySet(d);
    }

    // ---------------------------------------------------------------- governance (a timelock)

    function unpause() external onlyGov { paused = false; emit Unpaused(); }

    function liftVeto(bytes32 id) external onlyGov {
        Pending storage p = pending[id];
        if (p.readyAt == 0) revert NoMessage();
        p.vetoed = false;
        emit VetoLifted(id);
    }

    function setDailyLimit(uint256 v) external onlyGov { dailyLimit = v; emit DailyLimitSet(v); }

    function setDelay(uint64 d) external onlyGov {
        require(d <= MAX_DELAY, "delay");
        delay = d;
        emit DelaySet(d);
    }

    /// A new ISM (e.g. more validators, a higher threshold). Never zero.
    function setInterchainSecurityModule(ISaphanTokenIsm ism) external onlyGov {
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

/// @title ZetaphyTokenVault: the ZETAPHY side of one token to one destination chain
/// @notice lock(to, amount) escrows `amount` of `originToken` (msg.value = quote(): the Mailbox fee) and sends a
///         mint to that destination's SaphanSyntheticToken. A release (a burn on the destination) is paid from this
///         vault only, after the delay, and never more than `locked` (everything locked here minus everything
///         released here): a compromise of one destination drains at most its own escrow, never another
///         destination's or another token's.
///         The token: any ERC-20 on ZETAPHY that governance adds (deploys a vault for), including the native coin
///         through its ERC-20 precompile (0xEeee…EEeE: approve, then lock). Refused: tokens that deliver less than
///         asked (fee-on-transfer: OddToken), that return false, or whose decimals() differ from the chain table's.
///         Not supported (governance must not add them): rebasing tokens, tokens with blocklists or admin
///         transfers (a vault's balance must only move through this contract). Transfers with no return value
///         (USDT style) are accepted.
///         Extra safety: `lockCap` bounds everything ever outstanding to this destination (and so the synthetic
///         supply that can exist); a ThreatRegistry (optional) holds a flagged sender (no lock) or receiver (the
///         release waits until the hold ends, as BridgeGuard's vaccine does).
contract ZetaphyTokenVault is SaphanTokenEndpoint {
    uint8 public immutable decimals;          // the token's, checked at deploy (the synthetic has the same)
    uint256 public locked;                    // backing: locked minus released
    uint256 public lockCap;                   // `locked` may never exceed this (governance raises, guardians lower)
    ISaphanTokenThreats public threats;       // zero: no hold check

    event LockCapSet(uint256 cap);
    event ThreatsSet(address registry);
    event ExcessRecovered(address indexed to, uint256 amount);

    error OddToken(uint256 received);
    error TransferFailed();
    error OverCap(uint256 cap);
    error OverBacking(uint256 locked);
    error Held(address who);

    /// `c.remote`: the destination's SaphanSyntheticToken; `c.originToken`: the token on ZETAPHY.
    constructor(Config memory c, uint8 decimals_, uint256 lockCap_, ISaphanTokenThreats threats_) SaphanTokenEndpoint(c) {
        address token_ = c.originToken;
        require(token_.code.length > 0 || token_ == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, "token");
        (bool ok, bytes memory ret) = token_.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == decimals_, "decimals");
        decimals = decimals_;
        lockCap = lockCap_;
        threats = threats_;
        emit LockCapSet(lockCap_);
        emit ThreatsSet(address(threats_));
    }

    /// Escrows `amount` here and sends a mint of the same amount (same decimals) to `to` on the destination.
    function lock(address to, uint256 amount) external payable nonReentrant returns (bytes32 messageId) {
        messageId = _send(to, amount);
    }

    function _take(address from, uint256 amount) internal override {
        if (_held(from)) revert Held(from);
        if (locked + amount > lockCap) revert OverCap(lockCap);
        uint256 before = _balance();
        _call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        uint256 got = _balance() - before;
        if (got != amount) revert OddToken(got);
        locked += amount;
    }

    function _pay(address to, uint256 amount) internal override {
        if (_held(to)) revert Held(to);
        if (amount > locked) revert OverBacking(locked);
        locked -= amount;
        _call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
    }

    function _balance() private view returns (uint256) {
        (bool ok, bytes memory ret) = originToken.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    /// A token call that must succeed and, if it returns anything, return true.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = originToken.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    function _held(address who) private view returns (bool h) {
        ISaphanTokenThreats t = threats;
        if (address(t) == address(0)) return false;
        (h, ) = t.isContractHeld(who);
    }

    function lowerLockCap(uint256 v) external onlyGuardian {
        require(v < lockCap, "lower only");
        lockCap = v;
        emit LockCapSet(v);
    }

    function setLockCap(uint256 v) external onlyGov { lockCap = v; emit LockCapSet(v); }

    function setThreats(ISaphanTokenThreats r) external onlyGov { threats = r; emit ThreatsSet(address(r)); }

    /// Tokens sent here without lock() are not backing; governance may send them on. Never touches `locked`.
    function recoverExcess(address to) external onlyGov nonReentrant {
        uint256 b = _balance();
        require(to != address(0) && b > locked, "no excess");
        _call(abi.encodeWithSignature("transfer(address,uint256)", to, b - locked));
        if (_balance() < locked) revert OverBacking(locked);
        emit ExcessRecovered(to, b - locked);
    }
}

/// @title SaphanSyntheticToken: a ZETAPHY token on one destination chain (e.g. zZETAPHY on Base Sepolia)
/// @notice An ERC-20 that exists only through its vault on ZETAPHY: minted only for messages from ZETAPHY's
///         domain and that vault (verified by a multisig ISM of OUR validators for origin ZETAPHY), after the mint
///         delay, within the daily mint limit and the supply cap, while not vetoed or paused. sendBack(to, amount)
///         burns the caller's tokens and sends the release to the vault (msg.value = quote()).
///         Its value is exactly the vault's safety: one synthetic is a claim on one token locked in
///         ZetaphyTokenVault(token, this chain); if that vault, our validators or ZETAPHY fail, it can be worth
///         less or nothing.
contract SaphanSyntheticToken is SaphanTokenEndpoint {
    string public name;
    string public symbol;
    uint8 public immutable decimals;          // the origin token's
    uint256 public totalSupply;
    uint256 public supplyCap;                 // totalSupply may never exceed this (governance raises, guardians lower)
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event SupplyCapSet(uint256 cap);

    error OverCap(uint256 cap);

    /// `c.remote`: the ZetaphyTokenVault on ZETAPHY (domain c.remoteDomain, chain c.remoteChainId).
    constructor(string memory name_, string memory symbol_, uint8 decimals_, Config memory c, uint256 supplyCap_) SaphanTokenEndpoint(c) {
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0 && decimals_ <= 36, "token");
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        supplyCap = supplyCap_;
        emit SupplyCapSet(supplyCap_);
    }

    /// Burns `amount` of the caller's tokens and sends their release on ZETAPHY to `to`.
    function sendBack(address to, uint256 amount) external payable nonReentrant returns (bytes32 messageId) {
        messageId = _send(to, amount);
    }

    function _take(address from, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _pay(address to, uint256 amount) internal override {
        if (totalSupply + amount > supplyCap) revert OverCap(supplyCap);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v);
        return true;
    }
    function _move(address f, address to, uint256 v) private {
        require(to != address(0) && balanceOf[f] >= v, "transfer");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
    }

    function lowerSupplyCap(uint256 v) external onlyGuardian {
        require(v < supplyCap, "lower only");
        supplyCap = v;
        emit SupplyCapSet(v);
    }

    function setSupplyCap(uint256 v) external onlyGov { supplyCap = v; emit SupplyCapSet(v); }
}
