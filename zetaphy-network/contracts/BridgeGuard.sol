// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// ThreatRegistry's hold view for code on ZETAPHY (Reason as its uint8 value):
/// true once a flag on its address or code is the registry's holdDelay old, or at
/// once through the registry's fast lane or a guardian's holdNow.
interface IContractThreats {
    function isContractHeld(address who) external view returns (bool, uint8);
}

/// BridgeAirlock's count of lanes with distinct controllers.
interface IIndependentLanes {
    function independentLanes() external view returns (uint256);
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
///           - vaccine (with a ThreatRegistry set): no coins to, or out of, an
///             address or contract the registry holds (is*Held: a flag that is
///             holdDelay old, e.g. 10 minutes, or held at once by the fast lane or
///             a guardian's holdNow; two runners alone cannot freeze anyone at
///             once). This is a hold, not a loss:
///               - inbound: the mint is QUEUED, not reverted (InboundHeld, an id
///                 in `held`). The adapter's message is delivered, so nothing
///                 depends on an adapter retrying. Anyone calls releaseHeld(id)
///                 once the hold ends (the flag cleared, or governance protects
///                 the key); it then passes the pause, the route (still enabled)
///                 and the route's daily limit like any inbound. Governance can
///                 dropHeld(id) a queued mint (e.g. from a hacked adapter).
///               - outbound: the call reverts (the burn simply did not happen;
///                 the holder keeps the coins).
///             The adapter itself is NOT checked: governance chose it and can
///             disable its route; a runner flag on its code hash or address must
///             not be able to freeze a whole route.
///         Opening gates (a route stays closed until they hold):
///           - an audit on record: setAudit(https url, sha256 of the report)
///             before any route can be enabled;
///           - the route's adapter is a BridgeAirlock with at least 2 lanes
///             whose controllers differ (independentLanes() >= 2);
///           - a hard cap, maxDailyLimit, over every route's daily limit and over all routes together per day. It
///             starts at 1,000 whole tokens (createToken), is lowered at once,
///             and is raised only by governance, at most x2 per step, each step
///             7 days after it was proposed: caps grow gradually and in public.
///         Governance should be the ZetaphyTimelock (proposers: the chain's gov
///         module or a multisig). Guardians act at once, but only to reduce risk:
///         pause, lowerMaxDailyLimit, cancelMaxDailyLimit, disableRoute.
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
    address[] private guardianList;  // everyone ever made a guardian (guardians() filters the current ones)

    /// The audit the bridge opened on: where to read it and the sha256 of the report.
    string public auditUrl;
    bytes32 public auditSha256;
    /// Hard cap over every route's daily limit (token units).
    uint128 public maxDailyLimit;
    uint128 public pendingMaxDailyLimit;
    uint64 public pendingMaxAt;      // when the pending raise may be applied (0: none)
    uint64 public constant CAP_DELAY = 7 days;
    uint128 public constant STARTER_UNITS = 1000; // whole tokens: the cap at createToken
    /// Every route together, per direction and day: the hard cap binds the
    /// guard, so more routes cannot multiply it.
    uint128 public totalInToday;
    uint128 public totalOutToday;
    uint64 public totalDay;

    /// Inbound mints held by the vaccine, waiting for releaseHeld.
    struct HeldMint {
        bytes32 route;
        address to;
        uint256 amount;
        bool done;       // released or dropped
    }
    HeldMint[] public held;

    event RouteSet(bytes32 indexed id, address adapter, uint128 dailyLimit, bool enabled);
    event GovernanceSet(address governance);
    event AuditSet(string url, bytes32 sha256);
    event MaxDailyLimitProposed(uint128 value, uint64 at);
    event MaxDailyLimitSet(uint128 value);
    event MaxDailyLimitCancelled();
    event GuardianSet(address indexed who, bool allowed);
    event Paused(address indexed by);
    event Unpaused();
    event Inbound(bytes32 indexed route, address indexed to, uint256 amount);
    event Outbound(bytes32 indexed route, address indexed from, uint256 amount);
    event ThreatsSet(address registry);
    event InboundHeld(uint256 indexed id, bytes32 indexed route, address indexed to, uint256 amount);
    event HeldReleased(uint256 indexed id, address indexed to, uint256 amount);
    event HeldDropped(uint256 indexed id);

    error NotGovernance();
    error NotGuardian();
    error NotAdapter();
    error BridgePaused();
    error OverLimit(uint256 remaining);
    error FlaggedContract(address who);
    error NoHeld();
    error AuditMissing();
    error NeedLanes(uint256 independent);
    error OverCap(uint128 cap);
    error CapStep(uint128 most);
    error TooEarly(uint64 at);
    error NoPending();

    constructor(address governance_) {
        governance = governance_;
    }

    /// One-time: the guard deploys and owns its token.
    function createToken(string calldata n, string calldata s, uint8 d) external returns (BridgedToken) {
        if (msg.sender != governance) revert NotGovernance();
        require(address(token) == address(0), "token exists");
        require(d <= 30, "decimals");
        token = new BridgedToken(n, s, d, address(this));
        maxDailyLimit = uint128(uint256(STARTER_UNITS) * (uint256(10) ** d));
        emit MaxDailyLimitSet(maxDailyLimit);
        return token;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { governance = g; emit GovernanceSet(g); }
    function setGuardian(address who, bool allowed) external onlyGov {
        if (allowed && !guardian[who]) {
            bool known = false;
            for (uint256 i = 0; i < guardianList.length; i++) if (guardianList[i] == who) { known = true; break; }
            if (!known) { require(guardianList.length < 32, "guardians"); guardianList.push(who); }
        }
        guardian[who] = allowed;
        emit GuardianSet(who, allowed);
    }

    /// The current guardians.
    function guardians() external view returns (address[] memory out) {
        uint256 n = 0;
        for (uint256 i = 0; i < guardianList.length; i++) if (guardian[guardianList[i]]) n++;
        out = new address[](n);
        n = 0;
        for (uint256 i = 0; i < guardianList.length; i++) if (guardian[guardianList[i]]) out[n++] = guardianList[i];
    }

    /// The audit report the bridge opens on (an https url and the report's sha256).
    function setAudit(string calldata url, bytes32 sha) external onlyGov {
        bytes memory u = bytes(url);
        require(sha != bytes32(0) && u.length > 8 && u.length <= 200 && u[0] == "h" && u[1] == "t" && u[2] == "t" && u[3] == "p"
            && u[4] == "s" && u[5] == ":" && u[6] == "/" && u[7] == "/", "audit: https url and sha256");
        auditUrl = url;
        auditSha256 = sha;
        emit AuditSet(url, sha);
    }

    /// Lowering the cap applies at once (and cancels a pending raise); a raise
    /// (at most x2 of the cap) waits CAP_DELAY, then anyone applies it.
    function proposeMaxDailyLimit(uint128 v) external onlyGov {
        if (v <= maxDailyLimit) {
            maxDailyLimit = v;
            pendingMaxAt = 0;
            pendingMaxDailyLimit = 0;
            emit MaxDailyLimitSet(v);
            return;
        }
        uint256 most = uint256(maxDailyLimit) * 2;
        if (v > most) revert CapStep(uint128(most));
        pendingMaxDailyLimit = v;
        pendingMaxAt = uint64(block.timestamp) + CAP_DELAY;
        emit MaxDailyLimitProposed(v, pendingMaxAt);
    }

    function applyMaxDailyLimit() external {
        uint64 at = pendingMaxAt;
        if (at == 0) revert NoPending();
        if (block.timestamp < at) revert TooEarly(at);
        maxDailyLimit = pendingMaxDailyLimit;
        pendingMaxAt = 0;
        pendingMaxDailyLimit = 0;
        emit MaxDailyLimitSet(maxDailyLimit);
    }

    /// Governance or a guardian: drop a pending raise (reducing risk never waits).
    function cancelMaxDailyLimit() external {
        _govOrGuardian();
        pendingMaxAt = 0;
        pendingMaxDailyLimit = 0;
        emit MaxDailyLimitCancelled();
    }

    // ---- emergency: guardians act at once, but only to reduce risk ----
    // With governance behind a timelock (ZetaphyTimelock, 48 h), everything that
    // raises risk or changes rules (enable a route, raise a cap, unpause, new
    // guardians, audit, registry, governance) waits the delay. These calls only
    // shrink what can cross, so a guardian (a multisig) makes them at once.

    /// Lower the hard cap (never raise it) and drop a pending raise.
    function lowerMaxDailyLimit(uint128 v) external {
        _govOrGuardian();
        if (v >= maxDailyLimit) revert CapStep(maxDailyLimit);
        maxDailyLimit = v;
        pendingMaxAt = 0;
        pendingMaxDailyLimit = 0;
        emit MaxDailyLimitSet(v);
    }

    /// Close a route (its adapter and limit are kept; enabling it again is governance's).
    function disableRoute(bytes32 id) external {
        _govOrGuardian();
        Route storage r = routes[id];
        r.enabled = false;
        emit RouteSet(id, r.adapter, r.dailyLimit, false);
    }

    function _govOrGuardian() private view {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
    }
    /// The ThreatRegistry whose flags refuse coins (zero turns the check off).
    function setThreats(IContractThreats r) external onlyGov { threats = r; emit ThreatsSet(address(r)); }

    /// Enabling needs the audit on record, a daily limit within the hard cap and
    /// an adapter that is a BridgeAirlock with 2+ independent lanes. Disabling (or
    /// setting a closed route up) needs none of them: closing always works.
    function setRoute(bytes32 id, address adapter, uint128 dailyLimit, bool enabled) external onlyGov {
        if (enabled) {
            if (dailyLimit > maxDailyLimit) revert OverCap(maxDailyLimit);
            if (auditSha256 == bytes32(0)) revert AuditMissing();
            uint256 n = _independentLanes(adapter);
            if (n < 2) revert NeedLanes(n);
        }
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

    /// A held recipient: the mint is queued (InboundHeld), not reverted, and
    /// counts against the daily limit only when it is released.
    function inbound(bytes32 id, address to, uint256 amount) external {
        Route storage r = _use(id, amount, true);
        if (_isHeld(to)) {
            held.push(HeldMint(id, to, amount, false));
            emit InboundHeld(held.length - 1, id, to, amount);
            return;
        }
        _total(amount, true);
        r.inToday += uint128(amount);
        token.mint(to, amount);
        emit Inbound(id, to, amount);
    }

    /// Anyone: mint a queued inbound once its recipient is no longer held.
    /// Passes the pause, the route being enabled and its daily limit, as inbound does.
    function releaseHeld(uint256 hid) external {
        if (hid >= held.length || held[hid].done) revert NoHeld();
        HeldMint storage h = held[hid];
        if (paused) revert BridgePaused();
        Route storage r = routes[h.route];
        if (!r.enabled) revert NotAdapter();
        _clean(h.to);
        uint64 today = uint64(block.timestamp / 1 days);
        if (r.day != today) { r.day = today; r.inToday = 0; r.outToday = 0; }
        uint128 lim = _limit(r);
        if (r.inToday + h.amount > lim) revert OverLimit(lim > r.inToday ? lim - r.inToday : 0);
        _total(h.amount, true);
        h.done = true;
        r.inToday += uint128(h.amount);
        token.mint(h.to, h.amount);
        emit HeldReleased(hid, h.to, h.amount);
        emit Inbound(h.route, h.to, h.amount);
    }

    /// Governance drops a queued mint (e.g. one a hacked adapter sent).
    function dropHeld(uint256 hid) external onlyGov {
        if (hid >= held.length || held[hid].done) revert NoHeld();
        held[hid].done = true;
        emit HeldDropped(hid);
    }

    function heldCount() external view returns (uint256) {
        return held.length;
    }

    function outbound(bytes32 id, address from, uint256 amount) external {
        Route storage r = _use(id, amount, false);
        _clean(from);
        _total(amount, false);
        r.outToday += uint128(amount);
        token.burn(from, amount);
        emit Outbound(id, from, amount);
    }

    function remaining(bytes32 id) external view returns (uint256 inLeft, uint256 outLeft) {
        Route storage r = routes[id];
        bool fresh = r.day != uint64(block.timestamp / 1 days);
        uint128 lim = _limit(r);
        uint128 i = fresh ? 0 : r.inToday;
        uint128 o = fresh ? 0 : r.outToday;
        inLeft = lim > i ? lim - i : 0;
        outLeft = lim > o ? lim - o : 0;
    }

    /// A route's daily limit, never above the hard cap.
    function _limit(Route storage r) private view returns (uint128) {
        return r.dailyLimit < maxDailyLimit ? r.dailyLimit : maxDailyLimit;
    }

    /// The hard cap over all routes together (per direction, per day).
    function _total(uint256 amount, bool isIn) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (totalDay != today) { totalDay = today; totalInToday = 0; totalOutToday = 0; }
        uint256 used = isIn ? totalInToday : totalOutToday;
        uint256 cap = maxDailyLimit;
        if (used + amount > cap) revert OverLimit(cap > used ? cap - used : 0);
        if (isIn) totalInToday = uint128(used + amount); else totalOutToday = uint128(used + amount);
    }

    function _independentLanes(address adapter) private view returns (uint256) {
        if (adapter.code.length == 0) return 0;
        (bool ok, bytes memory ret) = adapter.staticcall(abi.encodeCall(IIndependentLanes.independentLanes, ()));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// Vaccine: holds back a party (the coins' owner) that the registry holds.
    function _clean(address who) private view {
        if (_isHeld(who)) revert FlaggedContract(who);
    }

    function _isHeld(address who) private view returns (bool f) {
        IContractThreats t = threats;
        if (address(t) == address(0)) return false;
        (f, ) = t.isContractHeld(who);
    }

    function _use(bytes32 id, uint256 amount, bool isIn) private returns (Route storage r) {
        if (paused) revert BridgePaused();
        r = routes[id];
        if (!r.enabled || msg.sender != r.adapter) revert NotAdapter();
        uint64 today = uint64(block.timestamp / 1 days);
        if (r.day != today) { r.day = today; r.inToday = 0; r.outToday = 0; }
        uint256 used = isIn ? r.inToday : r.outToday;
        uint256 lim = _limit(r);
        if (used + amount > lim) revert OverLimit(lim > used ? lim - used : 0);
    }
}
