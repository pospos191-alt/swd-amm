// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRunnerRecords {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IGuardInbound {
    function inbound(bytes32 route, address to, uint256 amount) external;
}

/// @title BridgeAirlock: nothing enters ZETAPHY on one bridge's word (stage 3)
/// @notice Defence in depth for incoming assets:
///   1. Several independent "lanes" (Hyperlane, IBC, the Neuro runner lane...)
///      must each attest the SAME transfer. One hacked bridge alone cannot
///      create money.
///   2. Even then the transfer waits in quarantine. During it, vetoers (the
///      Neuro lane by quorum, or a guardian) can stop it.
///   3. Decoy bridges (DecoyBridge) mark whoever pokes them; a transfer from
///      or to a marked address is never released.
///   Released transfers still pass BridgeGuard's daily limits.
contract BridgeAirlock {
    struct Transfer {
        uint64 readyFrom;    // when the threshold was reached; quarantine counts from here
        uint8 attestations;
        bool released;
        bool vetoed;
    }

    IGuardInbound public immutable guard;
    bytes32 public immutable route;     // this airlock's route in BridgeGuard
    address public governance;
    uint8 public threshold;             // distinct lanes that must agree
    uint64 public quarantine;           // seconds a transfer waits after enough lanes agreed
    mapping(address => bool) public isLane;
    mapping(address => bool) public isVetoer;
    mapping(address => bool) public isDecoy;
    mapping(address => bool) public tripped;   // marked by a decoy
    mapping(bytes32 => Transfer) public transfers;
    mapping(bytes32 => mapping(address => bool)) public attestedBy;

    event LaneSet(address lane, bool on);
    event VetoerSet(address who, bool on);
    event DecoySet(address decoy, bool on);
    event Attested(bytes32 indexed id, address indexed lane, uint8 count);
    event Vetoed(bytes32 indexed id, address indexed by, string reason);
    event Released(bytes32 indexed id, address indexed to, uint256 amount);
    event Tripped(address indexed who, address indexed decoy);

    error NotGovernance();
    error NotLane();
    error NotVetoer();
    error NotDecoy();
    error Twice();
    error NotReady();
    error Blocked();

    constructor(IGuardInbound guard_, bytes32 route_, address governance_, uint8 threshold_, uint64 quarantine_) {
        require(threshold_ >= 2, "need 2+ independent lanes");
        guard = guard_;
        route = route_;
        governance = governance_;
        threshold = threshold_;
        quarantine = quarantine_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setLane(address lane, bool on) external onlyGov { isLane[lane] = on; emit LaneSet(lane, on); }
    function setVetoer(address who, bool on) external onlyGov { isVetoer[who] = on; emit VetoerSet(who, on); }
    function setDecoy(address decoy, bool on) external onlyGov { isDecoy[decoy] = on; emit DecoySet(decoy, on); }
    /// Raising the threshold later does not hold back transfers that already reached the old one.
    function setThreshold(uint8 t) external onlyGov { require(t >= 2, "need 2+"); threshold = t; }
    function setQuarantine(uint64 q) external onlyGov { quarantine = q; }
    function setGovernance(address g) external onlyGov { governance = g; }
    /// Governance can lift a mark set by mistake.
    function untrip(address who) external onlyGov { tripped[who] = false; }

    /// The id every lane computes for one transfer seen on the source chain:
    /// the source contract's own running number, not a tx hash or log
    /// position, which can change if the source chain reorganises.
    function transferId(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(srcChainId, srcContract, srcNonce, sender, to, amount));
    }

    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external {
        if (!isLane[msg.sender]) revert NotLane();
        bytes32 id = transferId(srcChainId, srcContract, srcNonce, sender, to, amount);
        if (attestedBy[id][msg.sender]) revert Twice();
        attestedBy[id][msg.sender] = true;
        Transfer storage t = transfers[id];
        t.attestations += 1;
        if (t.readyFrom == 0 && t.attestations >= threshold) t.readyFrom = uint64(block.timestamp);
        emit Attested(id, msg.sender, t.attestations);
    }

    function veto(bytes32 id, string calldata reason) external {
        if (!isVetoer[msg.sender]) revert NotVetoer();
        Transfer storage t = transfers[id];
        if (t.released) revert Blocked();
        t.vetoed = true;
        emit Vetoed(id, msg.sender, reason);
    }

    /// Called by a DecoyBridge: whoever touched it is marked.
    function trip(address who) external {
        if (!isDecoy[msg.sender]) revert NotDecoy();
        tripped[who] = true;
        emit Tripped(who, msg.sender);
    }

    /// Anyone may release a transfer that passed every check.
    function release(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external {
        bytes32 id = transferId(srcChainId, srcContract, srcNonce, sender, to, amount);
        Transfer storage t = transfers[id];
        if (t.released || t.vetoed || tripped[sender] || tripped[to]) revert Blocked();
        if (t.attestations < threshold || t.readyFrom == 0 || block.timestamp < t.readyFrom + quarantine) revert NotReady();
        t.released = true;
        guard.inbound(route, to, amount);
        emit Released(id, to, amount);
    }

    function status(bytes32 id) external view returns (uint8 attestations, bool released, bool vetoed, uint64 readyAt) {
        Transfer storage t = transfers[id];
        return (t.attestations, t.released, t.vetoed, t.readyFrom == 0 ? 0 : t.readyFrom + quarantine);
    }
}

/// @title DecoyBridge: looks like a bridge, holds nothing, marks who pokes it
/// @notice Attackers scan for bridge contracts and try their functions. Any
///         state-changing call here marks the caller (tx.origin too, to catch
///         helper contracts) in the airlock, so their transfers are never
///         released. It does NOT pause anything: otherwise anyone could stop
///         the bridges by calling a decoy.
contract DecoyBridge {
    BridgeAirlock public immutable airlock;
    string public name;
    uint256 public trips;

    constructor(BridgeAirlock airlock_, string memory name_) {
        airlock = airlock_;
        name = name_;
    }

    function _mark() private {
        trips += 1;
        airlock.trip(msg.sender);
        if (tx.origin != msg.sender) airlock.trip(tx.origin);
    }

    // The usual entry points of bridge contracts.
    function mint(address, uint256) external { _mark(); }
    function release(address, uint256) external { _mark(); }
    function withdraw(uint256) external { _mark(); }
    function process(bytes calldata, bytes calldata) external { _mark(); }
    function handle(uint32, bytes32, bytes calldata) external payable { _mark(); }
    function executeMessage(bytes calldata) external { _mark(); }
    function upgradeTo(address) external { _mark(); }
    function transferOwnership(address) external { _mark(); }
    fallback() external payable { _mark(); }
    receive() external payable { _mark(); }
}

/// @title NeuroLane: Neuro runners as one of the airlock's bridges
/// @notice Runners watch the source chain's LockBox and each attest the
///         transfers they see. When `quorum` distinct proven runners attest
///         the same transfer, this lane attests it to the airlock. Runners
///         can also vote to veto a transfer still in quarantine.
contract NeuroLane {
    IRunnerRecords public immutable runners;
    BridgeAirlock public immutable airlock;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed;

    mapping(bytes32 => uint8) public votes;
    mapping(bytes32 => mapping(address => bool)) public votedBy;
    mapping(bytes32 => bool) public done;

    event RunnerAttested(bytes32 indexed id, address indexed runner, uint8 votes);
    event RunnerVetoVote(bytes32 indexed id, address indexed runner, uint8 votes);

    error NotRunner();
    error Twice();

    constructor(IRunnerRecords runners_, BridgeAirlock airlock_, uint8 quorum_, uint32 minAgreed_) {
        require(quorum_ >= 2, "quorum");
        runners = runners_;
        airlock = airlock_;
        quorum = quorum_;
        minAgreed = minAgreed_;
    }

    function _runner() private view {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external {
        _runner();
        bytes32 id = airlock.transferId(srcChainId, srcContract, srcNonce, sender, to, amount);
        bytes32 key = keccak256(abi.encode("attest", id));
        if (votedBy[key][msg.sender] || done[key]) revert Twice();
        votedBy[key][msg.sender] = true;
        uint8 v = ++votes[key];
        emit RunnerAttested(id, msg.sender, v);
        if (v >= quorum) {
            done[key] = true;
            airlock.attest(srcChainId, srcContract, srcNonce, sender, to, amount);
        }
    }

    function voteVeto(bytes32 id, string calldata reason) external {
        _runner();
        bytes32 key = keccak256(abi.encode("veto", id));
        if (votedBy[key][msg.sender] || done[key]) revert Twice();
        votedBy[key][msg.sender] = true;
        uint8 v = ++votes[key];
        emit RunnerVetoVote(id, msg.sender, v);
        if (v >= quorum) {
            done[key] = true;
            airlock.veto(id, reason);
        }
    }
}

/// @title LockBox: the source-chain side of the Neuro lane (test / testnet)
/// @notice Locks native coin and emits what the lanes need to attest. Lanes
///         attest (chainid, this contract, nonce, sender, to, amount).
contract LockBox {
    uint256 public nonce;
    event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount);

    function lock(address to) external payable {
        require(msg.value > 0 && to != address(0), "lock");
        emit Locked(nonce++, msg.sender, to, msg.value);
    }
}
