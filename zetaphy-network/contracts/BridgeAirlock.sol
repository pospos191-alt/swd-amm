// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRunnerRecords {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IGuardInbound {
    function inbound(bytes32 route, address to, uint256 amount) external;
}

/// ThreatRegistry's views (Reason as its uint8 value). is*Held: once the flag is
/// the registry's holdDelay old (e.g. 10 minutes), or at once through its fast
/// lane or a guardian's holdNow. is*Enforced: once the flag is the registry's
/// enforceDelay old, or at once through its fast lane.
interface IThreatFlags {
    function isAddressEnforced(uint256 chainId, address who) external view returns (bool, uint8);
    function isContractEnforced(address who) external view returns (bool, uint8);
    function isAddressHeld(uint256 chainId, address who) external view returns (bool, uint8);
    function isContractHeld(address who) external view returns (bool, uint8);
}

/// NeuroControl (Neuro's stop switch); only `paused()` is used here.
interface INeuroControl {
    function paused() external view returns (bool);
}

/// A lane says who decides what it attests (NeuroLane: its runner records;
/// HyperlaneLane: its Mailbox). Lanes whose controllers are the same address
/// are one lane as far as independence goes.
interface ILaneInfo {
    function laneController() external view returns (address);
}

/// @title BridgeAirlock: nothing enters ZETAPHY on one bridge's word (stage 3)
/// @notice Defence in depth for incoming assets:
///   1. Several independent "lanes" (Hyperlane, IBC, the Neuro runner lane...)
///      must each attest the SAME transfer. One hacked bridge alone cannot
///      create money.
///   2. Even then the transfer waits in quarantine. During it, vetoers (the
///      Neuro lane by quorum, or a guardian) can stop it.
///   3. Markers: keys governance names (setMarker), typically the bridge
///      monitor's own low-privilege key, can mark an address (trip). A
///      transfer from or to a marked address is not released until governance
///      lifts the mark (untrip). Why an address is marked is decided off-chain
///      by the marker; the airlock keeps no list of what it watches.
///   4. Vaccine: with a ThreatRegistry set, a transfer whose source sender or
///      source contract (on its chain), or whose ZETAPHY recipient (address or
///      code), is flagged by the Neuro runners is not released:
///        - flagged, within the registry's holdDelay (e.g. 10 minutes): not
///          held yet, so a 2-runner quorum alone cannot freeze anyone's
///          transfers at once; governance or a guardian can holdNow(key)
///          meanwhile (the registry's fast lane holds at once too).
///        - held (past holdDelay, fast lane or holdNow), not enforced yet:
///          release reverts with ThreatHeld. It comes out once the flag is
///          cleared (same quorum, or an upheld appeal) or governance protects
///          the key; nothing else releases it.
///        - enforced (past the registry's enforceDelay, or at once through its
///          fast lane): refused, release reverts with ThreatFlagged, as long as
///          the flag stands. The transfer stays, so it still comes out if the
///          flag is cleared or the key protected.
///      For a hold that outlives any flag, the Neuro lane or a guardian vetoes.
///      The coins stay locked in the source chain's LockBox meanwhile: it has no
///      refund path, so a held (or vetoed) transfer is not paid back there.
///      deploy-bridge therefore protects the bridge's own keys and the source
///      LockBox in the registry, so runners cannot hold every transfer at once.
///   Released transfers still pass BridgeGuard's daily limits.
///   Independence: each lane names its controller (laneController(): NeuroLane
///   its runner records, HyperlaneLane its Mailbox; a plain key is its own).
///   independentLanes() counts distinct controllers, and BridgeGuard enables
///   this airlock's route only while it is 2 or more.
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
    address[] private laneList;         // the lanes now on, in no particular order
    uint256 public constant MAX_LANES = 16;
    mapping(address => bool) public isVetoer;
    /// Keys that may mark addresses (trip). See trip(): a marker can only mark.
    mapping(address => bool) public isMarker;
    uint256 public markerCount;         // markers now on
    /// Who marked an address (zero: not marked). A mark counts only while its
    /// marker is still a marker, so removing a stolen marker key lifts all of
    /// its marks at once (see tripped()).
    mapping(address => address) public trippedBy;
    mapping(bytes32 => Transfer) public transfers;
    mapping(bytes32 => mapping(address => bool)) public attestedBy;
    /// By controller (laneControllerOf at attest time): two lanes with one
    /// controller count once, so the threshold means independent lanes.
    mapping(bytes32 => mapping(address => bool)) public attestedByController;
    IThreatFlags public threats;        // zero: no vaccine check

    event LaneSet(address lane, bool on);
    event GovernanceSet(address governance);
    event ThresholdSet(uint8 threshold);
    event QuarantineSet(uint64 quarantine);
    event Untripped(address indexed who);
    event VetoerSet(address who, bool on);
    event MarkerSet(address marker, bool on);
    /// The transfer's details too, so a monitor sees two lanes that disagree
    /// about one source deposit (same chain, contract and nonce; another id).
    event Attested(bytes32 indexed id, address indexed lane, uint8 count, uint256 srcChainId, address srcContract,
        uint256 indexed srcNonce, address sender, address to, uint256 amount);
    event Vetoed(bytes32 indexed id, address indexed by, string reason);
    event Released(bytes32 indexed id, address indexed to, uint256 amount);
    event Tripped(address indexed who, address indexed by);
    event ThreatsSet(address registry);

    error NotGovernance();
    error NotLane();
    error NotVetoer();
    error NotMarker();
    error Twice();
    error NotReady();
    error Blocked();
    /// what: 1 source sender, 2 source contract, 3 ZETAPHY recipient (enforced flag)
    error ThreatFlagged(uint8 what);
    /// the same, for a held flag that is not enforced yet: held until it is cleared
    error ThreatHeld(uint8 what);

    constructor(IGuardInbound guard_, bytes32 route_, address governance_, uint8 threshold_, uint64 quarantine_) {
        require(threshold_ >= 2, "need 2+ independent lanes");
        guard = guard_;
        route = route_;
        governance = governance_;
        threshold = threshold_;
        quarantine = quarantine_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setLane(address lane, bool on) external onlyGov {
        if (on && !isLane[lane]) {
            require(lane != address(0) && laneList.length < MAX_LANES, "lane");
            laneList.push(lane);
        } else if (!on && isLane[lane]) {
            for (uint256 i = 0; i < laneList.length; i++) {
                if (laneList[i] == lane) { laneList[i] = laneList[laneList.length - 1]; laneList.pop(); break; }
            }
        }
        isLane[lane] = on;
        emit LaneSet(lane, on);
    }
    function setVetoer(address who, bool on) external onlyGov { isVetoer[who] = on; emit VetoerSet(who, on); }
    /// Names (or removes) a marker: typically the bridge monitor's own key, which
    /// holds no other role. Governance removes a lost or misused marker key here.
    function setMarker(address marker, bool on) external onlyGov {
        if (on != isMarker[marker]) {
            if (on) markerCount += 1;
            else markerCount -= 1;
        }
        isMarker[marker] = on;
        emit MarkerSet(marker, on);
    }
    /// Raising the threshold later does not hold back transfers that already reached the old one.
    function setThreshold(uint8 t) external onlyGov { require(t >= 2, "need 2+"); threshold = t; emit ThresholdSet(t); }
    function setQuarantine(uint64 q) external onlyGov { quarantine = q; emit QuarantineSet(q); }
    function setGovernance(address g) external onlyGov { governance = g; emit GovernanceSet(g); }
    /// The ThreatRegistry whose flags hold transfers (zero turns the check off).
    function setThreats(IThreatFlags r) external onlyGov { threats = r; emit ThreatsSet(address(r)); }
    /// Governance can lift a mark set by mistake.
    function untrip(address who) external onlyGov { delete trippedBy[who]; emit Untripped(who); }

    /// Marked by a marker that is still on. setMarker(m, false) lifts every
    /// mark m made (setting m on again would bring them back).
    function tripped(address who) public view returns (bool) {
        address m = trippedBy[who];
        return m != address(0) && isMarker[m];
    }

    /// The lanes now on.
    function lanes() external view returns (address[] memory) { return laneList; }
    function laneCount() external view returns (uint256) { return laneList.length; }

    /// Who decides what a lane attests: its laneController(), or the lane itself
    /// (a key, or a contract that does not say).
    function laneControllerOf(address lane) public view returns (address) {
        if (lane.code.length == 0) return lane;
        try ILaneInfo(lane).laneController() returns (address c) { return c == address(0) ? lane : c; } catch { return lane; }
    }

    /// Lanes with distinct controllers. BridgeGuard will not enable this
    /// airlock's route while it is below 2: one controller behind two lane
    /// contracts is still one bridge's word.
    function independentLanes() external view returns (uint256 n) {
        uint256 len = laneList.length;
        address[] memory seen = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            address c = laneControllerOf(laneList[i]);
            bool dup = false;
            for (uint256 j = 0; j < n; j++) if (seen[j] == c) { dup = true; break; }
            if (!dup) seen[n++] = c;
        }
    }

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
        address c = laneControllerOf(msg.sender);
        if (!attestedByController[id][c]) {
            attestedByController[id][c] = true;
            t.attestations += 1;
        }
        if (t.readyFrom == 0 && t.attestations >= threshold) t.readyFrom = uint64(block.timestamp);
        emit Attested(id, msg.sender, t.attestations, srcChainId, srcContract, srcNonce, sender, to, amount);
    }

    function veto(bytes32 id, string calldata reason) external {
        if (!isVetoer[msg.sender]) revert NotVetoer();
        Transfer storage t = transfers[id];
        if (t.released) revert Blocked();
        t.vetoed = true;
        emit Vetoed(id, msg.sender, reason);
    }

    /// A marker marks `who`: release() then refuses (Blocked) every transfer
    /// whose source sender or ZETAPHY recipient is `who`, until governance
    /// untrips it. That is all a marker can do: it cannot attest, veto,
    /// release, mint, pause or move any funds, and a mark loses nothing (the
    /// transfer stays and comes out once the mark is lifted). So a stolen or
    /// misused marker key can at worst delay some addresses' transfers until
    /// governance removes the marker (setMarker), which lifts all its marks.
    function trip(address who) external {
        if (!isMarker[msg.sender]) revert NotMarker();
        trippedBy[who] = msg.sender;
        emit Tripped(who, msg.sender);
    }

    /// Anyone may release a transfer that passed every check.
    function release(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external {
        bytes32 id = transferId(srcChainId, srcContract, srcNonce, sender, to, amount);
        Transfer storage t = transfers[id];
        if (t.released || t.vetoed || tripped(sender) || tripped(to)) revert Blocked();
        if (t.attestations < threshold || t.readyFrom == 0 || block.timestamp < t.readyFrom + quarantine) revert NotReady();
        uint8 what = flaggedParty(srcChainId, srcContract, sender, to);
        if (what != 0) revert ThreatFlagged(what);
        what = heldParty(srcChainId, srcContract, sender, to);
        if (what != 0) revert ThreatHeld(what);
        t.released = true;
        guard.inbound(route, to, amount);
        emit Released(id, to, amount);
    }

    /// 0 when no party of this transfer has an enforced flag, else which one
    /// has (see ThreatFlagged). NeuroLane watchers ask this before they attest.
    function flaggedParty(uint256 srcChainId, address srcContract, address sender, address to) public view returns (uint8) {
        return _party(srcChainId, srcContract, sender, to, true);
    }

    /// 0 when no party of this transfer is held, else which one is (the
    /// registry's is*Held views: past holdDelay, fast lane or holdNow). A
    /// transfer with a held party is not released; NeuroLane watchers ask this
    /// before they release.
    function heldParty(uint256 srcChainId, address srcContract, address sender, address to) public view returns (uint8) {
        return _party(srcChainId, srcContract, sender, to, false);
    }

    function _party(uint256 srcChainId, address srcContract, address sender, address to, bool enforced) private view returns (uint8) {
        IThreatFlags r = threats;
        if (address(r) == address(0)) return 0;
        bool f;
        (f, ) = enforced ? r.isAddressEnforced(srcChainId, sender) : r.isAddressHeld(srcChainId, sender);
        if (f) return 1;
        (f, ) = enforced ? r.isAddressEnforced(srcChainId, srcContract) : r.isAddressHeld(srcChainId, srcContract);
        if (f) return 2;
        (f, ) = enforced ? r.isContractEnforced(to) : r.isContractHeld(to);
        if (f) return 3;
        return 0;
    }

    function status(bytes32 id) external view returns (uint8 attestations, bool released, bool vetoed, uint64 readyAt) {
        Transfer storage t = transfers[id];
        return (t.attestations, t.released, t.vetoed, t.readyFrom == 0 ? 0 : t.readyFrom + quarantine);
    }
}

/// @title NeuroLane: Neuro runners as one of the airlock's bridges
/// @notice Runners watch the source chain's LockBox and each attest the
///         transfers they see. When `quorum` distinct proven runners attest
///         the same transfer, this lane attests it to the airlock. Runners
///         can also vote to veto a transfer still in quarantine.
///         While Neuro is paused (NeuroControl, if set) nothing is attested;
///         vetoes still work, since holding money back is always safe.
contract NeuroLane {
    IRunnerRecords public immutable runners;
    BridgeAirlock public immutable airlock;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed;
    INeuroControl public immutable control; // zero: no pause check

    mapping(bytes32 => uint8) public votes;
    mapping(bytes32 => mapping(address => bool)) public votedBy;
    mapping(bytes32 => bool) public done;

    event RunnerAttested(bytes32 indexed id, address indexed runner, uint8 votes);

    /// The runner records decide what this lane attests (BridgeAirlock.independentLanes).
    function laneController() external view returns (address) { return address(runners); }
    event RunnerVetoVote(bytes32 indexed id, address indexed runner, uint8 votes);

    error NotRunner();
    error Twice();
    error NeuroPaused();

    constructor(IRunnerRecords runners_, BridgeAirlock airlock_, uint8 quorum_, uint32 minAgreed_, INeuroControl control_) {
        require(quorum_ >= 2, "quorum");
        runners = runners_;
        airlock = airlock_;
        quorum = quorum_;
        minAgreed = minAgreed_;
        control = control_;
    }

    function _runner() private view {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external {
        _runner();
        if (address(control) != address(0) && control.paused()) revert NeuroPaused();
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
