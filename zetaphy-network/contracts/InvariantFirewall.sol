// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// An invariant of a protected contract: a view over its state. True while the invariant holds.
/// It is called with a fixed gas cap and must not depend on who calls it.
interface IInvariantChecker {
    function holds(address protocol) external view returns (bool);
}

/// What the firewall reads from AuditCertificate (AuditCertificate.Cert, same layout).
interface IFWCertificate {
    struct Cert {
        uint256 requestId;
        uint64 chainId;
        address target;
        bytes32 codeHash;
        bytes32 reportHash;
        bytes32 sourceHash;
        uint8 level;
        uint16 auditors;
        uint16 mutationBps;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint256 revokedBy;
    }

    function isCertified(uint64 chainId, address target) external view returns (bool);
    function certificate(uint64 chainId, address target) external view returns (Cert memory c, bool valid);
}

/// @title InvariantFirewall: invariants as post-conditions, and "certificate or capped outflows" (testnet prototype)
/// @notice docs/future/invariant-firewall.md. Two opt-in rules for a protocol on ZETAPHY:
///
///         1. Invariant firewall (SS1). The protocol registers (from its own contract) and its governance adds
///            invariant checkers (IInvariantChecker, at most MAX_INVARIANTS, each with its own gas cap). The
///            protocol integrates Firewalled (contracts/Firewalled.sol): after the outermost call of every
///            `firewalled` function it calls `enforce(this)`, which runs every checker on the state the call
///            left. A checker that answers false, reverts, runs out of its gas cap or answers garbage is a
///            violation, and the WHOLE transaction reverts (InvariantViolated). So an attacker who finds a bug
///            that breaks an invariant cannot keep the result. Adding an invariant is immediate (it must hold
///            when added); removing one, or opting out, waits POLICY_DELAY in public, so a stolen protocol
///            key cannot quietly drop an invariant right before an exploit.
///            Chain layer (prototype, off unless governance turns it on): the protocol asks and the timelock
///            approves (`approveChain`, bounded by MAX_CHAIN protocols and CHAIN_GAS_BUDGET gas of checks);
///            the node then calls `chainCheck()` after every EVM transaction and reverts a transaction that
///            breaks an invariant that held before it, whichever contract it went through
///            (zetaphy-chain/prototypes/invariant-firewall).
///
///         2. Certificate as a chain rule (SS2). For every asset governance lists with a value threshold
///            (address(0) = the native coin), a registered protocol that holds at least the threshold and has
///            no live AuditCertificate certificate (expired, revoked, never issued, or its code changed) may
///            pay out at most `uncertifiedBps` of its balance per day; `recordOutflow` (Firewalled
///            `_firewallOutflow`) reverts above that. A live certificate lifts the cap at once.
///
///         Certificates and invariants: `attest(protocol, requestId)` records that the protocol's CURRENT invariant set
///         (checker addresses, their code hashes, gas caps and names) is covered by audit certificates: the
///         protocol and every checker hold a live certificate. `isAttested` stays true only while the set,
///         the protocol's certificate (same request) and every checker's certificate are unchanged and live.
///
///         No admin key: `governance` (the ZetaphyTimelock) only sets bounded parameters (thresholds, the
///         uncertified share), approves or drops chain-layer protection and hands over governance. It cannot
///         add or remove a protocol's invariants, and cannot move anyone's funds (this contract holds none).
///         CircuitBreaker (contracts/CircuitBreaker.sol) stays the place for pauses and held outflows; a
///         reverted violation carries InvariantViolated(protocol, checker, name) in its revert data, which
///         Neuro runners can use as evidence for a CircuitBreaker trip.
contract InvariantFirewall {
    // ---- bounds (constants: governance cannot widen them)
    uint256 public constant MAX_INVARIANTS = 8;
    uint32 public constant MIN_CHECK_GAS = 5_000;
    uint32 public constant MAX_CHECK_GAS = 500_000;
    uint64 public constant POLICY_DELAY = 2 days;
    uint256 public constant MAX_CHAIN = 8;
    uint256 public constant CHAIN_GAS_BUDGET = 2_000_000;  // all checks of all chain-layer protocols together
    uint256 public constant CHAIN_CALL_GAS = 3_000_000;    // the gas the node gives chainCheck (covers the budget and overhead)
    uint256 public constant CHECK_OVERHEAD = 5_000;        // gas kept back around each check
    uint256 public constant MAX_ASSETS = 8;
    uint32 public constant WINDOW = 1 days;
    uint16 public constant MIN_UNCERTIFIED_BPS = 100;      // 1% a day
    uint16 public constant MAX_UNCERTIFIED_BPS = 5000;     // 50% a day
    uint256 public constant BALANCE_GAS = 50_000;

    struct Invariant {
        address checker;
        uint32 gasLimit;
        bytes32 name;
    }

    struct Protocol {
        address governance;   // the protocol's own governance (adds invariants, asks for removals)
        bool active;
        bool chainRequested;  // the protocol asked for chain-layer protection
        bool chain;           // the timelock approved it: the node checks it after every EVM tx
        uint64 optOutAt;      // opt-out ready at (0: none)
    }

    struct Flow {
        uint64 day;
        uint128 base;   // the highest balance seen at an outflow today
        uint128 used;   // paid out today
    }

    struct Attestation {
        bytes32 setHash;
        uint256 requestId;  // the protocol's certificate (AuditNetwork request) it was attested under
        uint64 at;
    }

    IFWCertificate public immutable certificates;
    address public governance;
    uint16 public uncertifiedBps;

    mapping(address => Protocol) internal _protocols;
    mapping(address => Invariant[]) internal _invariants;
    mapping(address => mapping(address => uint64)) public removalAt;   // protocol => checker => ready at (0: none)
    mapping(address => uint256) public valueThreshold;                 // asset => threshold (0: not covered)
    address[] internal _assets;
    mapping(address => mapping(address => Flow)) public flowOf;        // protocol => asset => today's outflow
    mapping(address => Attestation) public attestationOf;
    address[] internal _chain;
    address[] public registered;
    mapping(address => bool) public listed;

    event Registered(address indexed protocol, address governance);
    event InvariantAdded(address indexed protocol, address indexed checker, uint32 gasLimit, bytes32 name);
    event RemovalProposed(address indexed protocol, address indexed checker, uint64 readyAt);
    event RemovalCancelled(address indexed protocol, address indexed checker);
    event InvariantRemoved(address indexed protocol, address indexed checker);
    event OptOutProposed(address indexed protocol, uint64 readyAt);
    event OptOutCancelled(address indexed protocol);
    event OptedOut(address indexed protocol);
    event ChainRequested(address indexed protocol);
    event ChainApproved(address indexed protocol);
    event ChainDropped(address indexed protocol);
    event Attested(address indexed protocol, bytes32 setHash, uint256 requestId);
    event OutflowRecorded(address indexed protocol, address indexed asset, uint256 amount, uint256 used, uint256 cap);
    event ThresholdSet(address indexed asset, uint256 threshold);
    event UncertifiedBpsSet(uint16 bps);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotProtocolGovernance();
    error NotRegistered();
    error AlreadyRegistered();
    error BadValue();
    error TooMany();
    error NotAContract();
    error Duplicate();
    error UnknownInvariant();
    error DoesNotHold(address checker);
    error TooEarly();
    error OverBudget();
    error InsufficientGas();
    error NotCertified(address target);
    error WrongRequest(uint256 certified);
    error InvariantViolated(address protocol, address checker, bytes32 name);
    error OutflowLimited(address protocol, address asset, uint256 used, uint256 cap);

    constructor(IFWCertificate certificates_, address governance_, uint16 uncertifiedBps_) {
        if (address(certificates_) == address(0) || governance_ == address(0)) revert BadValue();
        certificates = certificates_;
        governance = governance_;
        _setUncertifiedBps(uncertifiedBps_);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyProtocolGov(address protocol) {
        if (!_protocols[protocol].active) revert NotRegistered();
        if (msg.sender != _protocols[protocol].governance) revert NotProtocolGovernance();
        _;
    }

    // ======================================================================= opt in / out

    /// Opt in. Called by the protocol contract itself (its own governance decides to call it).
    /// From now on the certificate rule applies to it, and its governance can add invariants.
    function register(address protocolGovernance) external {
        if (_protocols[msg.sender].active) revert AlreadyRegistered();
        if (protocolGovernance == address(0)) revert BadValue();
        _protocols[msg.sender] = Protocol(protocolGovernance, true, false, false, 0);
        if (!listed[msg.sender]) {
            listed[msg.sender] = true;
            registered.push(msg.sender);
        }
        emit Registered(msg.sender, protocolGovernance);
    }

    function proposeOptOut(address protocol) external onlyProtocolGov(protocol) {
        uint64 at = uint64(block.timestamp) + POLICY_DELAY;
        _protocols[protocol].optOutAt = at;
        emit OptOutProposed(protocol, at);
    }

    function cancelOptOut(address protocol) external onlyProtocolGov(protocol) {
        if (_protocols[protocol].optOutAt == 0) revert TooEarly();
        _protocols[protocol].optOutAt = 0;
        emit OptOutCancelled(protocol);
    }

    /// After POLICY_DELAY, by anyone: every invariant and the certificate rule stop applying.
    function optOut(address protocol) external {
        Protocol storage p = _protocols[protocol];
        if (!p.active) revert NotRegistered();
        if (p.optOutAt == 0 || block.timestamp < p.optOutAt) revert TooEarly();
        if (p.chain) _dropChain(protocol);
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) removalAt[protocol][list[i].checker] = 0;
        delete _invariants[protocol];
        delete _protocols[protocol];
        delete attestationOf[protocol];
        emit OptedOut(protocol);
    }

    // ======================================================================= invariants

    /// Immediate: a stricter protocol. The invariant must hold now (a broken one would only block the protocol).
    function addInvariant(address protocol, address checker, uint32 gasLimit, bytes32 name) external onlyProtocolGov(protocol) {
        Invariant[] storage list = _invariants[protocol];
        if (list.length >= MAX_INVARIANTS) revert TooMany();
        if (checker.code.length == 0) revert NotAContract();
        if (gasLimit < MIN_CHECK_GAS || gasLimit > MAX_CHECK_GAS) revert BadValue();
        for (uint256 i = 0; i < list.length; i++) if (list[i].checker == checker) revert Duplicate();
        if (_protocols[protocol].chain && chainGas() + gasLimit > CHAIN_GAS_BUDGET) revert OverBudget();
        list.push(Invariant(checker, gasLimit, name));
        removalAt[protocol][checker] = 0;
        emit InvariantAdded(protocol, checker, gasLimit, name);
        if (!_holds(checker, protocol, gasLimit)) revert DoesNotHold(checker); // last: effects before the (static) call
    }

    /// Removing an invariant is a weaker protocol: it waits POLICY_DELAY in public.
    function proposeRemoval(address protocol, address checker) external onlyProtocolGov(protocol) {
        if (_indexOf(protocol, checker) >= MAX_INVARIANTS) revert UnknownInvariant(); // (reverts inside if unknown)
        uint64 at = uint64(block.timestamp) + POLICY_DELAY;
        removalAt[protocol][checker] = at;
        emit RemovalProposed(protocol, checker, at);
    }

    function cancelRemoval(address protocol, address checker) external onlyProtocolGov(protocol) {
        if (removalAt[protocol][checker] == 0) revert UnknownInvariant();
        removalAt[protocol][checker] = 0;
        emit RemovalCancelled(protocol, checker);
    }

    /// After POLICY_DELAY, by anyone.
    function removeInvariant(address protocol, address checker) external {
        uint64 at = removalAt[protocol][checker];
        if (at == 0 || block.timestamp < at) revert TooEarly();
        uint256 i = _indexOf(protocol, checker);
        Invariant[] storage list = _invariants[protocol];
        list[i] = list[list.length - 1];
        list.pop();
        removalAt[protocol][checker] = 0;
        emit InvariantRemoved(protocol, checker);
    }

    function _indexOf(address protocol, address checker) internal view returns (uint256) {
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) if (list[i].checker == checker) return i;
        revert UnknownInvariant();
    }

    // ======================================================================= checks

    /// One check, fail-closed: true only if the checker returned exactly 32 bytes encoding `true` within its gas cap.
    /// Reverts with InsufficientGas when the caller did not leave enough gas to give the checker its full cap,
    /// so starving a check can never turn it into a pass (nor into a spurious violation).
    function _holds(address checker, address protocol, uint32 gasLimit) internal view returns (bool) {
        if (gasleft() < (uint256(gasLimit) * 64) / 63 + CHECK_OVERHEAD) revert InsufficientGas();
        bytes memory data = abi.encodeCall(IInvariantChecker.holds, (protocol));
        bool ok = false;
        uint256 word = 0;
        assembly ("memory-safe") {
            ok := staticcall(gasLimit, checker, add(data, 32), mload(data), 0, 32)
            if iszero(eq(returndatasize(), 32)) { ok := 0 }
            word := mload(0)
        }
        return ok && word == 1;
    }

    /// The first invariant of `protocol` that does not hold now: (false, index), or (true, 0).
    function check(address protocol) public view returns (bool ok, uint256 failed) {
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) {
            if (!_holds(list[i].checker, protocol, list[i].gasLimit)) return (false, i);
        }
        return (true, 0);
    }

    /// What Firewalled calls after a protected call: reverts with InvariantViolated unless every invariant holds.
    function enforce(address protocol) external view {
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) {
            Invariant storage v = list[i];
            if (!_holds(v.checker, protocol, v.gasLimit)) revert InvariantViolated(protocol, v.checker, v.name);
        }
    }

    // ======================================================================= chain layer (prototype)

    /// The protocol's governance asks for chain-layer protection (the timelock decides).
    function requestChain(address protocol) external onlyProtocolGov(protocol) {
        _protocols[protocol].chainRequested = true;
        emit ChainRequested(protocol);
    }

    /// The timelock approves a request, within MAX_CHAIN protocols and CHAIN_GAS_BUDGET of checks.
    function approveChain(address protocol) external onlyGovernance {
        Protocol storage p = _protocols[protocol];
        if (!p.active || !p.chainRequested || p.chain) revert BadValue();
        if (_chain.length >= MAX_CHAIN) revert TooMany();
        if (chainGas() + _gasOf(protocol) > CHAIN_GAS_BUDGET) revert OverBudget();
        p.chain = true;
        _chain.push(protocol);
        emit ChainApproved(protocol);
    }

    /// The timelock drops a protocol from the chain layer at once (node load, a misbehaving checker). The
    /// protocol's own (contract-layer) invariants keep applying. Leaving otherwise means opting out (delayed).
    function dropChain(address protocol) external onlyGovernance {
        if (!_protocols[protocol].chain) revert BadValue();
        _dropChain(protocol);
    }

    function _dropChain(address protocol) internal {
        _protocols[protocol].chain = false;
        _protocols[protocol].chainRequested = false;
        for (uint256 i = 0; i < _chain.length; i++) {
            if (_chain[i] == protocol) {
                _chain[i] = _chain[_chain.length - 1];
                _chain.pop();
                break;
            }
        }
        emit ChainDropped(protocol);
    }

    function _gasOf(address protocol) internal view returns (uint256 g) {
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) g += list[i].gasLimit;
    }

    /// The gas caps of all chain-layer checks together (<= CHAIN_GAS_BUDGET).
    function chainGas() public view returns (uint256 g) {
        for (uint256 i = 0; i < _chain.length; i++) g += _gasOf(_chain[i]);
    }

    /// What the node calls after every EVM transaction (CHAIN_CALL_GAS): the chain-layer protocols and a
    /// bit mask of those with an invariant that does not hold (bit i = protocols[i]).
    function chainCheck() external view returns (address[] memory protocols, uint256 brokenMask) {
        protocols = _chain;
        for (uint256 i = 0; i < protocols.length; i++) {
            (bool ok, ) = check(protocols[i]);
            if (!ok) brokenMask |= 1 << i;
        }
    }

    // ======================================================================= certificate rule (SS2)

    /// Called by a registered protocol (Firewalled._firewallOutflow) before it pays `amount` of `asset`.
    /// Reverts with OutflowLimited when the protocol holds at least the asset's threshold, has no live
    /// certificate and today's outflow would exceed uncertifiedBps of its balance. Every recorded outflow
    /// of the day counts (also those made while certified), so a certificate that lapses during the day
    /// does not open a fresh allowance. Unregistered callers and assets without a threshold: nothing recorded.
    function recordOutflow(address asset, uint256 amount) external {
        if (!_protocols[msg.sender].active || amount == 0) return;
        uint256 threshold = valueThreshold[asset];
        if (threshold == 0) return;
        uint256 bal = _balanceOf(asset, msg.sender);
        Flow storage f = flowOf[msg.sender][asset];
        uint64 day = uint64(block.timestamp / WINDOW);
        if (f.day != day) {
            f.day = day;
            f.used = 0;
            f.base = 0;
        }
        // The highest balance seen today. A deposit that raises it must leave again as a recorded
        // outflow, which counts in full: inflating the base never lets more of the rest out.
        uint256 base = bal > f.base ? bal : f.base;
        uint256 used = uint256(f.used) + amount;
        f.base = uint128(base > type(uint128).max ? type(uint128).max : base);
        f.used = uint128(used > type(uint128).max ? type(uint128).max : used);
        if (base < threshold) return; // holds little value: not limited
        uint256 cap = (base * uncertifiedBps) / 10_000;
        emit OutflowRecorded(msg.sender, asset, amount, used, cap);
        // last: the (static) certificate read, after every effect
        if (used > cap && !certificates.isCertified(uint64(block.chainid), msg.sender)) revert OutflowLimited(msg.sender, asset, used, cap);
    }

    function _balanceOf(address asset, address who) internal view returns (uint256 bal) {
        if (asset == address(0)) return who.balance;
        if (asset.code.length == 0) return 0;
        bytes memory data = abi.encodeWithSelector(0x70a08231, who); // balanceOf(address)
        bool ok = false;
        assembly ("memory-safe") {
            ok := staticcall(BALANCE_GAS, asset, add(data, 32), mload(data), 0, 32)
            if iszero(eq(returndatasize(), 32)) { ok := 0 }
            bal := mload(0)
        }
        if (!ok) bal = 0;
    }

    /// Whether `protocol` may pay out without the uncertified cap now (it holds a live certificate).
    function isCertified(address protocol) external view returns (bool) {
        return certificates.isCertified(uint64(block.chainid), protocol);
    }

    /// How much more of `asset` the protocol may pay out today under the certificate rule
    /// (type(uint256).max: not limited now).
    function outflowLeft(address protocol, address asset) external view returns (uint256) {
        uint256 threshold = valueThreshold[asset];
        if (!_protocols[protocol].active || threshold == 0 || certificates.isCertified(uint64(block.chainid), protocol)) return type(uint256).max;
        uint256 bal = _balanceOf(asset, protocol);
        Flow storage f = flowOf[protocol][asset];
        bool stale = f.day != uint64(block.timestamp / WINDOW); // a new day: nothing used yet
        uint256 base = !stale && f.base > bal ? f.base : bal;
        if (base < threshold) return type(uint256).max;
        uint256 cap = (base * uncertifiedBps) / 10_000;
        uint256 used = stale ? 0 : f.used;
        return used >= cap ? 0 : cap - used;
    }

    // ======================================================================= certificates and invariant sets

    /// The hash of the protocol's current invariant set (order, checkers, their code, gas caps and names).
    function setHash(address protocol) public view returns (bytes32 h) {
        Invariant[] storage list = _invariants[protocol];
        h = keccak256(abi.encode(block.chainid, protocol, list.length));
        for (uint256 i = 0; i < list.length; i++) {
            h = keccak256(abi.encode(h, list[i].checker, list[i].checker.codehash, list[i].gasLimit, list[i].name));
        }
    }

    /// Records that the current invariant set is covered by audit certificates: the protocol holds a live
    /// certificate issued for audit request `requestId`, and every checker holds a live certificate now.
    /// Anyone may call it.
    function attest(address protocol, uint256 requestId) external {
        if (!_protocols[protocol].active) revert NotRegistered();
        Invariant[] storage list = _invariants[protocol];
        if (list.length == 0) revert UnknownInvariant();
        bytes32 h = setHash(protocol);
        attestationOf[protocol] = Attestation(h, requestId, uint64(block.timestamp));
        emit Attested(protocol, h, requestId);
        // the (static) certificate reads come after every effect; any failure reverts them
        uint64 cid = uint64(block.chainid);
        (IFWCertificate.Cert memory c, bool valid) = certificates.certificate(cid, protocol);
        if (!valid) revert NotCertified(protocol);
        if (c.requestId != requestId) revert WrongRequest(c.requestId);
        for (uint256 i = 0; i < list.length; i++) {
            if (!certificates.isCertified(cid, list[i].checker)) revert NotCertified(list[i].checker);
        }
    }

    /// True while the attested invariant set is the current one and every certificate behind it is still live
    /// (the protocol's under the same request). Changing, adding or removing an invariant ends it.
    function isAttested(address protocol) external view returns (bool) {
        Attestation storage a = attestationOf[protocol];
        if (a.setHash == bytes32(0) || a.setHash != setHash(protocol)) return false;
        uint64 cid = uint64(block.chainid);
        (IFWCertificate.Cert memory c, bool valid) = certificates.certificate(cid, protocol);
        if (!valid || c.requestId != a.requestId) return false;
        Invariant[] storage list = _invariants[protocol];
        for (uint256 i = 0; i < list.length; i++) if (!certificates.isCertified(cid, list[i].checker)) return false;
        return true;
    }

    // ======================================================================= governance (the timelock)

    /// The value above which a protocol needs a live certificate to pay `asset` out freely (0 removes the asset).
    function setThreshold(address asset, uint256 threshold) external onlyGovernance {
        bool known = false;
        for (uint256 i = 0; i < _assets.length; i++) {
            if (_assets[i] == asset) {
                known = true;
                if (threshold == 0) {
                    _assets[i] = _assets[_assets.length - 1];
                    _assets.pop();
                }
                break;
            }
        }
        if (!known && threshold != 0) {
            if (_assets.length >= MAX_ASSETS) revert TooMany();
            _assets.push(asset);
        }
        valueThreshold[asset] = threshold;
        emit ThresholdSet(asset, threshold);
    }

    function setUncertifiedBps(uint16 bps) external onlyGovernance {
        _setUncertifiedBps(bps);
    }

    function _setUncertifiedBps(uint16 bps) internal {
        if (bps < MIN_UNCERTIFIED_BPS || bps > MAX_UNCERTIFIED_BPS) revert BadValue();
        uncertifiedBps = bps;
        emit UncertifiedBpsSet(bps);
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadValue();
        governance = next;
        emit GovernanceSet(next);
    }

    // ======================================================================= views

    function protocolOf(address protocol) external view returns (Protocol memory) {
        return _protocols[protocol];
    }

    function invariantsOf(address protocol) external view returns (Invariant[] memory) {
        return _invariants[protocol];
    }

    function chainProtocols() external view returns (address[] memory) {
        return _chain;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }
}
