// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// ThreatRegistry's view for code on ZETAPHY (Reason as its uint8 value): true
/// as soon as the runners' quorum flagged its address or code (warning level).
interface IContractThreats {
    function isContractFlagged(address who) external view returns (bool, uint8);
}

/// @title BridgedToken: a token that exists on ZETAPHY only through a bridge
/// @notice Only its BridgeGuard can mint (assets arriving) or burn (leaving).
contract BridgedToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    address public immutable guard;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d, address guard_) {
        name = n; symbol = s; decimals = d; guard = guard_;
    }

    modifier onlyGuard() { require(msg.sender == guard, "only guard"); _; }

    function mint(address to, uint256 v) external onlyGuard { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function burn(address from, uint256 v) external onlyGuard {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v; totalSupply -= v; emit Transfer(from, address(0), v);
    }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v); return true;
    }
    function _move(address f, address to, uint256 v) private {
        require(to != address(0) && balanceOf[f] >= v, "transfer");
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}

/// @title BridgeGuard: limits and a stop button for every bridge route (stage 3)
/// @notice A bridge adapter (Hyperlane warp route, IBC hook, ...) never mints
///         or burns directly: it asks this guard, which enforces
///           - a daily limit per route and direction, so a hacked bridge can
///             lose at most one day's limit, not everything;
///           - a pause that only guardians can pull and only governance can
///             release. Pausing stops the bridges, never the chain.
///           - vaccine (with a ThreatRegistry set): no coins to, or out of, a
///             contract whose address or code the Neuro runners flagged, from
///             the moment it is flagged (warning level; no enforceDelay here).
///             This is a hold, not a loss: the call reverts, so the adapter's
///             message stays pending (an inbound mint is retried, an outbound
///             burn simply did not happen) and goes through once the flag is
///             cleared or governance protects the key. Reverting is how a
///             direct path holds, so it needs no separate hold state. The adapter
///             itself is NOT checked: governance chose it and can disable its
///             route; a runner flag on its code hash or address must not be
///             able to freeze a whole route.
///         Governance should be the chain's gov module or a multisig.
contract BridgeGuard {
    struct Route {
        address adapter;      // the only caller allowed for this route
        uint128 dailyLimit;   // per direction, in token units
        uint128 inToday;
        uint128 outToday;
        uint64 day;
        bool enabled;
    }

    BridgedToken public token;
    address public governance;
    mapping(address => bool) public guardian;
    bool public paused;
    mapping(bytes32 => Route) public routes;
    IContractThreats public threats; // zero: no vaccine check

    event RouteSet(bytes32 indexed id, address adapter, uint128 dailyLimit, bool enabled);
    event GuardianSet(address indexed who, bool allowed);
    event Paused(address indexed by);
    event Unpaused();
    event Inbound(bytes32 indexed route, address indexed to, uint256 amount);
    event Outbound(bytes32 indexed route, address indexed from, uint256 amount);
    event ThreatsSet(address registry);

    error NotGovernance();
    error NotGuardian();
    error NotAdapter();
    error BridgePaused();
    error OverLimit(uint256 remaining);
    error FlaggedContract(address who);

    constructor(address governance_) {
        governance = governance_;
    }

    /// One-time: the guard deploys and owns its token.
    function createToken(string calldata n, string calldata s, uint8 d) external returns (BridgedToken) {
        if (msg.sender != governance) revert NotGovernance();
        require(address(token) == address(0), "token exists");
        token = new BridgedToken(n, s, d, address(this));
        return token;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { governance = g; }
    function setGuardian(address who, bool allowed) external onlyGov { guardian[who] = allowed; emit GuardianSet(who, allowed); }
    /// The ThreatRegistry whose flags refuse coins (zero turns the check off).
    function setThreats(IContractThreats r) external onlyGov { threats = r; emit ThreatsSet(address(r)); }

    function setRoute(bytes32 id, address adapter, uint128 dailyLimit, bool enabled) external onlyGov {
        Route storage r = routes[id];
        r.adapter = adapter;
        r.dailyLimit = dailyLimit;
        r.enabled = enabled;
        emit RouteSet(id, adapter, dailyLimit, enabled);
    }

    /// Any guardian (or governance) can stop all bridges at once.
    function pause() external {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    /// Restarting needs governance: a stolen guardian key can only stop things.
    function unpause() external onlyGov {
        paused = false;
        emit Unpaused();
    }

    function inbound(bytes32 id, address to, uint256 amount) external {
        Route storage r = _use(id, amount, true);
        _clean(to);
        r.inToday += uint128(amount);
        token.mint(to, amount);
        emit Inbound(id, to, amount);
    }

    function outbound(bytes32 id, address from, uint256 amount) external {
        Route storage r = _use(id, amount, false);
        _clean(from);
        r.outToday += uint128(amount);
        token.burn(from, amount);
        emit Outbound(id, from, amount);
    }

    function remaining(bytes32 id) external view returns (uint256 inLeft, uint256 outLeft) {
        Route storage r = routes[id];
        bool fresh = r.day != uint64(block.timestamp / 1 days);
        inLeft = r.dailyLimit - (fresh ? 0 : r.inToday);
        outLeft = r.dailyLimit - (fresh ? 0 : r.outToday);
    }

    /// Vaccine: holds back a party (the coins' owner) that is flagged.
    function _clean(address who) private view {
        IContractThreats t = threats;
        if (address(t) == address(0)) return;
        (bool f, ) = t.isContractFlagged(who);
        if (f) revert FlaggedContract(who);
    }

    function _use(bytes32 id, uint256 amount, bool isIn) private returns (Route storage r) {
        if (paused) revert BridgePaused();
        r = routes[id];
        if (!r.enabled || msg.sender != r.adapter) revert NotAdapter();
        uint64 today = uint64(block.timestamp / 1 days);
        if (r.day != today) { r.day = today; r.inToday = 0; r.outToday = 0; }
        uint256 used = isIn ? r.inToday : r.outToday;
        if (used + amount > r.dailyLimit) revert OverLimit(r.dailyLimit - used);
    }
}
