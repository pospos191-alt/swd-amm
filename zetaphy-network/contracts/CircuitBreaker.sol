// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// NeuroJobs' runner record (the first five fields of NeuroJobs.workers): bond, unbonding, active, track record.
interface IBreakerRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// @title CircuitBreaker: opt-in, narrow, time-boxed self-healing for protocols on ZETAPHY (testnet prototype)
/// @notice docs/future/self-healing.md. A protocol OPTS IN by registering a policy (from its own
///         contract), and integrates CircuitBreakable (contracts/CircuitBreakable.sol): the
///         `whenNotTripped(selector)` modifier and `_outflow(asset, to, amount)` accounting.
///
///         The policy states, in advance, everything a trip may do:
///           - which selectors of the protocol may be paused (at most 16), and which of them an
///             invariant trip pauses (`invariantMask`);
///           - outflow caps per window for each listed asset (at most 8; address(0) = native coin);
///           - while tripped: the caps are cut to `tripCapBps` and single outflows above `holdAbove`
///             are HELD (kept by the protocol, paid later or cancelled by its governance);
///           - `maxPause`: how long a trip lasts (at most MAX_PAUSE); it always expires by itself;
///           - `quorum`: how many bonded Neuro runners must sign the same evidence (>= minQuorum);
///           - `governance`: the protocol's OWN governance. It ends a trip early (release), changes
///             the policy (after POLICY_DELAY, never while tripped), opts out (after POLICY_DELAY),
///             cancels held outflows and claims a trip was false.
///
///         Two ways to trip, nothing else:
///           1. Evidence: >= quorum distinct eligible runners sign the same evidence
///              {protocol, epoch, block range, evidence hash, detector id, selector mask}: either
///              ECDSA signatures gathered off chain (tripWithSignatures) or one attest() tx each
///              (so a runner with an ML-DSA account, MsgEVMCall, attests post-quantum). Eligible =
///              an active NeuroJobs runner with >= minAgreed accepted verdicts AND a guardian bond
///              of >= guardianBond posted here (slashable: NeuroJobs bonds cannot be slashed from
///              outside). Evidence must be fresh: its range starts after the previous trip's, ends
///              at most MAX_EVIDENCE_AGE blocks ago, and its hash was never used.
///           2. Invariant: the protocol's own outflow accounting exceeds a cap within a window.
///              The breaker sees it itself (recordOutflow); the outflow that broke it is held,
///              not reverted, so the trip stays.
///         At most MAX_STREAK trips in a row (each starting within maxPause of the last one's end)
///         before the protocol's governance must rearm: runners cannot keep a protocol paused.
///
///         No admin key: `governance` (the ZetaphyTimelock) only sets bounded parameters, vetoes a
///         trip (ends it at once) and judges false-trip claims. It can never pause anything.
///
///         False trips: within CLAIM_WINDOW of a runner trip, the protocol's governance may
///         claimFalse (posting claimBond); the timelock judges it. Proven false: each signer loses
///         slashBps of its guardian bond, COMPENSATION_BPS of it goes to the protocol's governance
///         (plus its claim bond back), the rest is burned. Rejected: the claim bond goes to the
///         signers. Not judged within RESOLVE_WINDOW: the claim bond is refunded, nobody slashed.
///         Signers cannot exit while a trip they signed can still be claimed or is being judged.
contract CircuitBreaker {
    // ---- bounds (constants: governance cannot widen them) ----
    uint256 public constant MAX_SELECTORS = 16;
    uint256 public constant MAX_ASSETS = 8;
    uint256 public constant MAX_QUORUM = 16;
    uint32 public constant MIN_PAUSE = 10 minutes;
    uint32 public constant MAX_PAUSE = 3 days;
    uint32 public constant MIN_WINDOW = 1 minutes;
    uint32 public constant MAX_WINDOW = 1 days;
    uint32 public constant MAX_REVIEW = 7 days;
    uint64 public constant POLICY_DELAY = 2 days;
    uint64 public constant EXIT_DELAY = 7 days;
    uint64 public constant CLAIM_WINDOW = 7 days;
    uint64 public constant RESOLVE_WINDOW = 14 days;
    uint64 public constant MAX_EVIDENCE_AGE = 64; // blocks
    uint64 public constant MAX_RANGE = 256;       // blocks
    uint8 public constant MAX_STREAK = 3;
    uint16 public constant MAX_SLASH_BPS = 5000;
    uint16 public constant COMPENSATION_BPS = 8000;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant TRIP_TYPEHASH = keccak256("ZetaphyCircuitBreakerTrip(uint256 chainId,address breaker,address protocol,uint256 epoch,uint64 fromBlock,uint64 toBlock,bytes32 evidenceHash,bytes32 detectorId,uint16 mask)");

    struct Policy {
        address governance;
        bytes4[] selectors;
        address[] assets;
        uint256[] caps;
        uint32 window;
        uint32 maxPause;
        uint8 quorum;
        uint16 invariantMask;
        uint16 tripCapBps;
        uint256 holdAbove;
        uint32 holdReview;
    }

    struct Config {
        address governance;
        uint32 window;
        uint32 maxPause;
        uint8 quorum;
        bool active;
        uint16 invariantMask;
        uint16 tripCapBps;
        uint32 holdReview;
        uint256 holdAbove;
        bytes4[] selectors;
        address[] assets;
    }

    struct Evidence {
        uint64 fromBlock;
        uint64 toBlock;
        bytes32 evidenceHash;
        bytes32 detectorId;
        uint16 mask;
    }

    enum Kind { Runners, Invariant }
    enum Claim { None, Open, ProvenFalse, Rejected, Expired }

    struct Trip {
        address protocol;
        Kind kind;
        Claim claim;
        uint16 mask;
        uint64 start;
        uint64 until;      // the trip is live while block.timestamp < until (release/veto set it to now)
        uint64 fromBlock;
        uint64 toBlock;
        uint64 claimedAt;
        bytes32 evidenceHash;
        bytes32 detectorId;
        uint256 claimBond;
        address[] runners;
    }

    struct Guardian {
        uint128 bond;
        uint64 exitAt;        // 0 while serving
        uint64 lockedUntil;   // trips it signed can be claimed until then
        uint32 openClaims;    // claims on trips it signed, not yet settled
        uint32 trips;         // trips it signed
        uint32 slashed;       // trips it signed that were proven false
    }

    struct Flow {
        uint64 windowId;
        uint192 used;
    }

    IBreakerRunners public immutable runners;
    address public governance;
    uint256 public guardianBond;
    uint256 public claimBond;
    uint8 public minQuorum;
    uint32 public minAgreed;
    uint16 public slashBps = 5000;

    mapping(address => Config) internal _policy;
    mapping(address => mapping(address => uint256)) public capOf;        // protocol => asset => cap per window
    mapping(address => mapping(address => Flow)) public flowOf;          // protocol => asset => this window's outflow
    mapping(address => Config) internal _pending;
    mapping(address => mapping(address => uint256)) internal _pendingCap;
    mapping(address => uint64) public pendingAt;      // policy change ready at (0: none)
    mapping(address => uint64) public optOutAt;       // opt-out ready at (0: none)
    address[] public protocols;
    mapping(address => bool) public listed;

    Trip[] internal _trips;
    mapping(address => uint256) public lastTrip;      // protocol => trip id + 1 (0: never)
    mapping(address => uint256) public epoch;         // bumps on every trip: older signatures stop counting
    mapping(address => uint64) public lastToBlock;    // evidence must start after this
    mapping(address => uint8) public streak;
    mapping(bytes32 => bool) public usedEvidence;
    mapping(bytes32 => address[]) internal _attesters; // digest => runners who attested it on chain

    mapping(address => Guardian) public guardians;
    mapping(address => uint256) public owed;

    event Registered(address indexed protocol, address governance);
    event PolicyProposed(address indexed protocol, uint64 readyAt);
    event PolicyApplied(address indexed protocol);
    event OptOutProposed(address indexed protocol, uint64 readyAt);
    event OptedOut(address indexed protocol);
    event GuardianJoined(address indexed runner, uint256 bond);
    event GuardianExitRequested(address indexed runner, uint64 at);
    event GuardianExited(address indexed runner, uint256 bond);
    event Attested(address indexed protocol, bytes32 indexed digest, address indexed runner, uint256 count);
    event Tripped(uint256 indexed id, address indexed protocol, Kind kind, uint16 mask, uint64 until, bytes32 evidenceHash, bytes32 detectorId, uint64 fromBlock, uint64 toBlock);
    event Outflow(address indexed protocol, address indexed asset, uint256 amount, uint256 used, bool held);
    event Released(uint256 indexed id, address indexed by);
    event Vetoed(uint256 indexed id);
    event Rearmed(address indexed protocol);
    event ClaimedFalse(uint256 indexed id, uint256 bond);
    event ClaimResolved(uint256 indexed id, bool provenFalse, uint256 slashed);
    event ClaimExpired(uint256 indexed id);
    event Slashed(address indexed runner, uint256 amount);
    event ParamsSet(uint256 guardianBond, uint256 claimBond, uint8 minQuorum, uint32 minAgreed, uint16 slashBps);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotProtocolGovernance();
    error BadPolicy();
    error AlreadyRegistered();
    error NotRegistered();
    error IsTripped();
    error NotTripped();
    error TooEarly();
    error NotEligible();
    error StaleEvidence();
    error UsedEvidence();
    error BadMask();
    error NoQuorum();
    error BadSignature();
    error NotSorted();
    error AlreadyAttested();
    error StreakLimit();
    error BadValue();
    error BadClaim();
    error Locked();

    constructor(IBreakerRunners runners_, address governance_, uint256 guardianBond_, uint256 claimBond_, uint8 minQuorum_, uint32 minAgreed_) {
        if (address(runners_) == address(0) || governance_ == address(0)) revert BadValue();
        runners = runners_;
        governance = governance_;
        _setParams(guardianBond_, claimBond_, minQuorum_, minAgreed_, slashBps);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyProtocolGov(address protocol) {
        if (!_policy[protocol].active) revert NotRegistered();
        if (msg.sender != _policy[protocol].governance) revert NotProtocolGovernance();
        _;
    }

    // ======================================================================= policies

    /// Opt in. Called by the protocol contract itself (its own governance decides to call it).
    function register(Policy calldata p) external {
        if (_policy[msg.sender].active) revert AlreadyRegistered();
        _check(p);
        _store(_policy[msg.sender], capOf[msg.sender], p);
        if (!listed[msg.sender]) { listed[msg.sender] = true; protocols.push(msg.sender); }
        emit Registered(msg.sender, p.governance);
    }

    /// A new policy, applied after POLICY_DELAY (applyPolicy). Loosening a policy is never instant.
    function proposePolicy(address protocol, Policy calldata p) external onlyProtocolGov(protocol) {
        _check(p);
        _store(_pending[protocol], _pendingCap[protocol], p);
        uint64 at = uint64(block.timestamp) + POLICY_DELAY;
        pendingAt[protocol] = at;
        emit PolicyProposed(protocol, at);
    }

    function applyPolicy(address protocol) external {
        uint64 at = pendingAt[protocol];
        if (at == 0 || block.timestamp < at) revert TooEarly();
        if (isTripped(protocol)) revert IsTripped();
        Config storage cur = _policy[protocol];
        Config storage nxt = _pending[protocol];
        for (uint256 i = 0; i < cur.assets.length; i++) capOf[protocol][cur.assets[i]] = 0;
        cur.governance = nxt.governance;
        cur.window = nxt.window;
        cur.maxPause = nxt.maxPause;
        cur.quorum = nxt.quorum;
        cur.invariantMask = nxt.invariantMask;
        cur.tripCapBps = nxt.tripCapBps;
        cur.holdReview = nxt.holdReview;
        cur.holdAbove = nxt.holdAbove;
        cur.selectors = nxt.selectors;
        cur.assets = nxt.assets;
        for (uint256 i = 0; i < nxt.assets.length; i++) {
            capOf[protocol][nxt.assets[i]] = _pendingCap[protocol][nxt.assets[i]];
            _pendingCap[protocol][nxt.assets[i]] = 0;
            delete flowOf[protocol][nxt.assets[i]];
        }
        delete _pending[protocol];
        pendingAt[protocol] = 0;
        emit PolicyApplied(protocol);
    }

    function proposeOptOut(address protocol) external onlyProtocolGov(protocol) {
        uint64 at = uint64(block.timestamp) + POLICY_DELAY;
        optOutAt[protocol] = at;
        emit OptOutProposed(protocol, at);
    }

    /// After POLICY_DELAY and not while tripped: the protocol is no longer protected (or limited).
    function optOut(address protocol) external {
        uint64 at = optOutAt[protocol];
        if (at == 0 || block.timestamp < at) revert TooEarly();
        if (isTripped(protocol)) revert IsTripped();
        Config storage cur = _policy[protocol];
        for (uint256 i = 0; i < cur.assets.length; i++) capOf[protocol][cur.assets[i]] = 0;
        delete _policy[protocol];
        optOutAt[protocol] = 0;
        pendingAt[protocol] = 0;
        emit OptedOut(protocol);
    }

    function _check(Policy calldata p) internal view {
        if (p.governance == address(0) || p.selectors.length > MAX_SELECTORS || p.assets.length > MAX_ASSETS
            || p.assets.length != p.caps.length) revert BadPolicy();
        if (p.window < MIN_WINDOW || p.window > MAX_WINDOW || p.maxPause < MIN_PAUSE || p.maxPause > MAX_PAUSE) revert BadPolicy();
        if (p.quorum < minQuorum || p.quorum > MAX_QUORUM || p.tripCapBps > 10_000 || p.holdReview > MAX_REVIEW) revert BadPolicy();
        if (uint256(p.invariantMask) >> p.selectors.length != 0) revert BadPolicy();
        for (uint256 i = 0; i < p.selectors.length; i++) {
            if (p.selectors[i] == bytes4(0)) revert BadPolicy();
            for (uint256 j = 0; j < i; j++) if (p.selectors[j] == p.selectors[i]) revert BadPolicy();
        }
        for (uint256 i = 0; i < p.assets.length; i++) {
            if (p.caps[i] == 0 || p.caps[i] > type(uint192).max) revert BadPolicy();
            for (uint256 j = 0; j < i; j++) if (p.assets[j] == p.assets[i]) revert BadPolicy();
        }
    }

    function _store(Config storage c, mapping(address => uint256) storage caps, Policy calldata p) internal {
        c.governance = p.governance;
        c.window = p.window;
        c.maxPause = p.maxPause;
        c.quorum = p.quorum;
        c.active = true;
        c.invariantMask = p.invariantMask;
        c.tripCapBps = p.tripCapBps;
        c.holdReview = p.holdReview;
        c.holdAbove = p.holdAbove;
        c.selectors = p.selectors;
        c.assets = p.assets;
        for (uint256 i = 0; i < p.assets.length; i++) caps[p.assets[i]] = p.caps[i];
    }

    // ======================================================================= guardians (bonded runners)

    /// Post (or top up) a guardian bond. Only active NeuroJobs runners with a track record.
    function joinGuardians() external payable {
        Guardian storage g = guardians[msg.sender];
        if (g.exitAt != 0) revert Locked();
        uint256 bond = uint256(g.bond) + msg.value;
        if (bond < guardianBond || bond > type(uint128).max || !_isRunner(msg.sender)) revert NotEligible();
        g.bond = uint128(bond);
        emit GuardianJoined(msg.sender, bond);
    }

    function requestExit() external {
        Guardian storage g = guardians[msg.sender];
        if (g.bond == 0 || g.exitAt != 0) revert BadValue();
        g.exitAt = uint64(block.timestamp) + EXIT_DELAY;
        emit GuardianExitRequested(msg.sender, g.exitAt);
    }

    /// After EXIT_DELAY, once nothing it signed can still be claimed or is being judged.
    function exit() external {
        Guardian storage g = guardians[msg.sender];
        if (g.exitAt == 0 || block.timestamp < g.exitAt || block.timestamp < g.lockedUntil || g.openClaims != 0) revert Locked();
        uint256 amount = g.bond;
        g.bond = 0;
        g.exitAt = 0;
        owed[msg.sender] += amount;
        emit GuardianExited(msg.sender, amount);
    }

    function _isRunner(address r) internal view returns (bool) {
        (uint128 bond, , bool active, uint32 agreed, ) = runners.workers(r);
        return active && bond > 0 && agreed >= minAgreed;
    }

    /// May sign or attest evidence now.
    function eligible(address r) public view returns (bool) {
        Guardian storage g = guardians[r];
        return g.bond >= guardianBond && g.bond > 0 && g.exitAt == 0 && _isRunner(r);
    }

    // ======================================================================= evidence trips

    /// What runners sign (personal_sign / EIP-191 over this 32-byte digest).
    function digest(address protocol, Evidence calldata ev) public view returns (bytes32) {
        return keccak256(abi.encode(TRIP_TYPEHASH, block.chainid, address(this), protocol, epoch[protocol],
            ev.fromBlock, ev.toBlock, ev.evidenceHash, ev.detectorId, ev.mask));
    }

    /// One runner attests on chain (any account type: ECDSA, or ML-DSA through MsgEVMCall).
    /// The attestation that reaches the policy's quorum trips the breaker.
    function attest(address protocol, Evidence calldata ev) external returns (bool tripped) {
        _checkEvidence(protocol, ev);
        if (!eligible(msg.sender)) revert NotEligible();
        bytes32 d = digest(protocol, ev);
        address[] storage list = _attesters[d];
        for (uint256 i = 0; i < list.length; i++) if (list[i] == msg.sender) revert AlreadyAttested();
        list.push(msg.sender);
        emit Attested(protocol, d, msg.sender, list.length);
        // only attesters still eligible now count toward the quorum
        uint256 q = _policy[protocol].quorum;
        if (list.length < q) return false;
        address[] memory ok = new address[](list.length);
        uint256 n;
        for (uint256 i = 0; i < list.length; i++) if (eligible(list[i])) ok[n++] = list[i];
        if (n < q) return false;
        assembly { mstore(ok, n) }
        _tripRunners(protocol, ev, ok);
        return true;
    }

    /// k-of-n ECDSA signatures gathered off chain, submitted by anyone. Signers strictly ascending.
    function tripWithSignatures(address protocol, Evidence calldata ev, address[] calldata signers, bytes[] calldata sigs) external {
        _checkEvidence(protocol, ev);
        if (signers.length != sigs.length) revert BadValue();
        if (signers.length < _policy[protocol].quorum) revert NoQuorum();
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest(protocol, ev)));
        address prev = address(0);
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] <= prev) revert NotSorted();
            prev = signers[i];
            if (_recover(h, sigs[i]) != signers[i]) revert BadSignature();
            if (!eligible(signers[i])) revert NotEligible();
        }
        _tripRunners(protocol, ev, signers);
    }

    function _checkEvidence(address protocol, Evidence calldata ev) internal view {
        Config storage c = _policy[protocol];
        if (!c.active) revert NotRegistered();
        if (isTripped(protocol)) revert IsTripped();
        if (ev.evidenceHash == bytes32(0) || ev.fromBlock > ev.toBlock || ev.toBlock >= block.number
            || block.number - ev.toBlock > MAX_EVIDENCE_AGE || ev.toBlock - ev.fromBlock > MAX_RANGE
            || ev.fromBlock <= lastToBlock[protocol]) revert StaleEvidence();
        if (usedEvidence[ev.evidenceHash]) revert UsedEvidence();
        if (uint256(ev.mask) >> c.selectors.length != 0) revert BadMask();
    }

    function _tripRunners(address protocol, Evidence calldata ev, address[] memory signers) internal {
        usedEvidence[ev.evidenceHash] = true;
        uint256 id = _start(protocol, Kind.Runners, ev.mask, ev.evidenceHash, ev.detectorId, ev.fromBlock, ev.toBlock);
        Trip storage t = _trips[id];
        uint64 lockUntil = t.start + CLAIM_WINDOW;
        for (uint256 i = 0; i < signers.length; i++) {
            t.runners.push(signers[i]);
            Guardian storage g = guardians[signers[i]];
            if (g.lockedUntil < lockUntil) g.lockedUntil = lockUntil;
            g.trips += 1;
        }
    }

    function _start(address protocol, Kind kind, uint16 mask, bytes32 evidenceHash, bytes32 detectorId, uint64 fromBlock, uint64 toBlock)
        internal returns (uint256 id)
    {
        Config storage c = _policy[protocol];
        uint256 prev = lastTrip[protocol];
        uint8 s = streak[protocol];
        if (prev != 0 && block.timestamp > uint256(_trips[prev - 1].until) + c.maxPause) s = 0; // a quiet period resets it
        if (s >= MAX_STREAK) revert StreakLimit();
        streak[protocol] = s + 1;
        epoch[protocol] += 1;
        lastToBlock[protocol] = toBlock;
        id = _trips.length;
        Trip storage t = _trips.push();
        t.protocol = protocol;
        t.kind = kind;
        t.mask = mask;
        t.start = uint64(block.timestamp);
        t.until = uint64(block.timestamp) + c.maxPause;
        t.fromBlock = fromBlock;
        t.toBlock = toBlock;
        t.evidenceHash = evidenceHash;
        t.detectorId = detectorId;
        lastTrip[protocol] = id + 1;
        emit Tripped(id, protocol, kind, mask, t.until, evidenceHash, detectorId, fromBlock, toBlock);
    }

    /// ECDSA (65 bytes r,s,v), low-s only.
    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 || (v != 27 && v != 28)) revert BadSignature();
        address a = ecrecover(h, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    // ======================================================================= outflow accounting (invariant trips)

    /// Called by a registered protocol (CircuitBreakable._outflow) before it pays `amount` of `asset`.
    /// Returns false when the payment must be HELD: over the window's cap (this trips the breaker
    /// if it is not tripped yet), or above holdAbove while tripped. Unregistered callers and unlisted
    /// assets: always true, nothing recorded.
    function recordOutflow(address asset, uint256 amount) external returns (bool payNow) {
        Config storage c = _policy[msg.sender];
        if (!c.active) return true;
        uint256 cap = capOf[msg.sender][asset];
        if (cap == 0) return true;
        Flow storage f = flowOf[msg.sender][asset];
        uint64 w = uint64(block.timestamp / c.window);
        if (f.windowId != w) { f.windowId = w; f.used = 0; }
        bool tripped = isTripped(msg.sender);
        uint256 limit = tripped ? cap * c.tripCapBps / 10_000 : cap;
        uint256 used = uint256(f.used) + amount;
        if ((tripped && c.holdAbove != 0 && amount > c.holdAbove) || used > limit) {
            if (!tripped && streak[msg.sender] < MAX_STREAK) {
                // the invariant broke: the chain saw it itself, no runners needed
                uint64 b = uint64(block.number);
                if (b > lastToBlock[msg.sender]) {
                    _start(msg.sender, Kind.Invariant, c.invariantMask, keccak256(abi.encode(msg.sender, asset, used, cap, b)), bytes32("invariant:outflow-cap"), b, b);
                }
            }
            emit Outflow(msg.sender, asset, amount, f.used, true);
            return false;
        }
        f.used = uint192(used);
        emit Outflow(msg.sender, asset, amount, used, false);
        return true;
    }

    // ======================================================================= ending trips, rearm

    /// The protocol's own governance ends its trip early.
    function release(address protocol) external onlyProtocolGov(protocol) {
        uint256 id = _live(protocol);
        _trips[id].until = uint64(block.timestamp);
        emit Released(id, msg.sender);
    }

    /// Chain governance (the timelock) overrides: ends a trip at once.
    function veto(address protocol) external onlyGovernance {
        uint256 id = _live(protocol);
        _trips[id].until = uint64(block.timestamp);
        emit Vetoed(id);
    }

    /// The protocol's governance resets the streak (allows MAX_STREAK new trips).
    function rearm(address protocol) external onlyProtocolGov(protocol) {
        streak[protocol] = 0;
        emit Rearmed(protocol);
    }

    function _live(address protocol) internal view returns (uint256) {
        if (!isTripped(protocol)) revert NotTripped();
        return lastTrip[protocol] - 1;
    }

    // ======================================================================= false-trip claims

    function claimFalse(uint256 id) external payable {
        Trip storage t = _trips[id];
        if (msg.sender != _policy[t.protocol].governance) revert NotProtocolGovernance();
        if (t.kind != Kind.Runners || t.claim != Claim.None || block.timestamp > t.start + CLAIM_WINDOW) revert BadClaim();
        if (msg.value != claimBond) revert BadValue();
        t.claim = Claim.Open;
        t.claimedAt = uint64(block.timestamp);
        t.claimBond = msg.value;
        for (uint256 i = 0; i < t.runners.length; i++) guardians[t.runners[i]].openClaims += 1;
        emit ClaimedFalse(id, msg.value);
    }

    /// The timelock judges a claim. Proven false: the signers are slashed and the protocol compensated.
    function resolveClaim(uint256 id, bool provenFalse) external onlyGovernance {
        Trip storage t = _trips[id];
        if (t.claim != Claim.Open) revert BadClaim();
        address gov = _policy[t.protocol].governance;
        uint256 n = t.runners.length;
        uint256 total;
        if (provenFalse) {
            t.claim = Claim.ProvenFalse;
            for (uint256 i = 0; i < n; i++) {
                Guardian storage g = guardians[t.runners[i]];
                uint256 cut = uint256(g.bond) * slashBps / 10_000;
                g.bond -= uint128(cut);
                g.openClaims -= 1;
                g.slashed += 1;
                total += cut;
                emit Slashed(t.runners[i], cut);
            }
            uint256 comp = total * COMPENSATION_BPS / 10_000;
            owed[gov == address(0) ? BURN : gov] += comp + t.claimBond;
            owed[BURN] += total - comp;
        } else {
            t.claim = Claim.Rejected;
            uint256 share = t.claimBond / n;
            for (uint256 i = 0; i < n; i++) {
                guardians[t.runners[i]].openClaims -= 1;
                owed[t.runners[i]] += share;
            }
            owed[BURN] += t.claimBond - share * n;
        }
        emit ClaimResolved(id, provenFalse, total);
    }

    /// Nobody judged it in time: the claim bond goes back, nobody is slashed.
    function expireClaim(uint256 id) external {
        Trip storage t = _trips[id];
        if (t.claim != Claim.Open || block.timestamp < t.claimedAt + RESOLVE_WINDOW) revert BadClaim();
        t.claim = Claim.Expired;
        for (uint256 i = 0; i < t.runners.length; i++) guardians[t.runners[i]].openClaims -= 1;
        address gov = _policy[t.protocol].governance;
        owed[gov == address(0) ? BURN : gov] += t.claimBond;
        emit ClaimExpired(id);
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert BadValue();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    /// Burned shares are paid to BURN by anyone (nobody holds its key).
    function flushBurn() external {
        uint256 amount = owed[BURN];
        owed[BURN] = 0;
        (bool ok, ) = BURN.call{value: amount}("");
        require(ok, "send");
    }

    // ======================================================================= governance (the timelock)

    function setParams(uint256 guardianBond_, uint256 claimBond_, uint8 minQuorum_, uint32 minAgreed_, uint16 slashBps_) external onlyGovernance {
        _setParams(guardianBond_, claimBond_, minQuorum_, minAgreed_, slashBps_);
    }

    function _setParams(uint256 guardianBond_, uint256 claimBond_, uint8 minQuorum_, uint32 minAgreed_, uint16 slashBps_) internal {
        if (guardianBond_ == 0 || claimBond_ == 0 || minQuorum_ < 2 || minQuorum_ > MAX_QUORUM || slashBps_ == 0 || slashBps_ > MAX_SLASH_BPS) revert BadValue();
        guardianBond = guardianBond_;
        claimBond = claimBond_;
        minQuorum = minQuorum_;
        minAgreed = minAgreed_;
        slashBps = slashBps_;
        emit ParamsSet(guardianBond_, claimBond_, minQuorum_, minAgreed_, slashBps_);
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadValue();
        governance = next;
        emit GovernanceSet(next);
    }

    // ======================================================================= views

    function isTripped(address protocol) public view returns (bool) {
        uint256 id = lastTrip[protocol];
        return id != 0 && block.timestamp < _trips[id - 1].until;
    }

    /// True while a live trip pauses this selector of the protocol.
    function isPaused(address protocol, bytes4 selector) external view returns (bool) {
        if (!isTripped(protocol)) return false;
        uint16 mask = _trips[lastTrip[protocol] - 1].mask;
        bytes4[] storage s = _policy[protocol].selectors;
        for (uint256 i = 0; i < s.length; i++) if (s[i] == selector) return (mask >> i) & 1 == 1;
        return false;
    }

    function policyOf(address protocol) external view returns (Config memory) {
        return _policy[protocol];
    }

    function policyGovernance(address protocol) external view returns (address) {
        return _policy[protocol].governance;
    }

    function holdReviewOf(address protocol) external view returns (uint32) {
        return _policy[protocol].holdReview;
    }

    function tripCount() external view returns (uint256) {
        return _trips.length;
    }

    function protocolCount() external view returns (uint256) {
        return protocols.length;
    }

    function tripOf(uint256 id) external view returns (Trip memory) {
        return _trips[id];
    }

    function attesters(bytes32 d) external view returns (address[] memory) {
        return _attesters[d];
    }
}
