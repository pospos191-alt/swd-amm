// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The airlock calls this lane makes (BridgeAirlock).
interface IAggAirlock {
    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external;
}

/// @title SaphanAggLane: one aggregated post-quantum proof instead of one transaction per attester (Saphan PR 4, S1)
/// @notice Testnet only, not audited (docs/SAPHAN-PR4.md).
///
///   A committee of n attesters (e.g. the Neuro runners that watch a route's lockbox) each hold an ML-DSA-44 key.
///   Instead of n transactions per transfer (NeuroLane: one vote each), they sign ONE digest off chain and anyone
///   brings the certificate on chain in one call, checked once:
///
///     certificate = threshold x [public key (1312) | signature (2420)], keys sorted by keccak256(key), strictly
///                   increasing (each member counts once), every key a member of the current committee,
///                   every signature checked by ZETAPHY's ML-DSA precompile (0x...0900), like PQMultisigIsm.
///
///   What they sign is a Merkle ROOT of transfers (src/saphanagg.js): one transfer (root = its leaf, no path) or a
///   batch of many, each later attested with its Merkle path. A batch costs one certificate for all its transfers.
///     leaf   = keccak256(bytes.concat(keccak256(abi.encode(transferId))))   (BridgeAirlock.transferId)
///     node   = keccak256(min(a, b) | max(a, b))
///     digest = keccak256(abi.encode(TAG, block.chainid, this lane, epoch, root))
///
///   This contract is ONE lane of a BridgeAirlock (its own controller): the airlock still needs another independent
///   lane (e.g. HyperlaneLane), its quarantine, vetoes, marks, Neuro flags and BridgeGuard's daily limits. A root
///   counts only in the committee epoch that signed it: a new committee (governance) retires every root of the old one.
///   No admin key: governance is the ZetaphyTimelock, and the committee it sets is bounded (2 <= t, 2t > n, n <= 32).
contract SaphanAggLane {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant SIG_BYTES = 2420;
    uint256 public constant ENTRY = PK_BYTES + SIG_BYTES;
    uint256 public constant MAX_MEMBERS = 32;
    uint256 public constant MAX_DEPTH = 24;      // a batch of up to 2^24 transfers
    bytes32 public constant TAG = keccak256("saphan/agg/v1");

    struct Transfer {
        uint256 srcChainId;
        address srcContract;
        uint256 srcNonce;
        address sender;
        address to;
        uint256 amount;
    }

    IAggAirlock public immutable airlock;
    address public governance;                   // the ZetaphyTimelock
    uint64 public epoch;                         // bumped by every committee change
    uint8 public threshold;
    bytes32[] private _members;                  // keccak256 of the members' ML-DSA-44 keys, increasing
    mapping(bytes32 => uint64) public memberEpoch;   // key hash => the epoch it is a member in
    mapping(bytes32 => uint64) public rootEpoch;     // root => the epoch whose committee certified it (0: none)
    /// BridgeAirlock.Twice(): the airlock already counts this lane's attestation of a transfer (it alone knows
    /// whether a lane removed and added again may attest again, so the lane keeps no record of its own).
    bytes4 private constant AIRLOCK_TWICE = bytes4(keccak256("Twice()"));

    event CommitteeSet(uint64 indexed epoch, bytes32[] members, uint8 threshold);
    event GovernanceSet(address governance);
    event RootCertified(bytes32 indexed root, uint64 indexed epoch, address by);
    event LaneAttested(bytes32 indexed id, bytes32 indexed root);

    error OnlyGovernance();
    error BadCommittee();
    error BadCertificate(uint256 entry);
    error Known();
    error UnknownRoot();
    error BadProof();
    error Twice();
    error Length();

    constructor(IAggAirlock airlock_, address governance_, bytes32[] memory members_, uint8 threshold_) {
        if (address(airlock_) == address(0) || governance_ == address(0)) revert BadCommittee();
        airlock = airlock_;
        governance = governance_;
        _setCommittee(members_, threshold_);
    }

    /// BridgeAirlock.independentLanes: this committee is its own controller (one lane).
    function laneController() external view returns (address) { return address(this); }

    function committee() external view returns (bytes32[] memory members, uint8 t, uint64 e) {
        return (_members, threshold, epoch);
    }

    // ---- governance (the ZetaphyTimelock) ----

    /// A new committee: key hashes strictly increasing, 2 <= t, more than half must sign (2t > n), at most 32 keys.
    /// Every root the old committee certified stops counting.
    function setCommittee(bytes32[] calldata members_, uint8 t) external {
        if (msg.sender != governance) revert OnlyGovernance();
        _setCommittee(members_, t);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert OnlyGovernance();
        if (g == address(0)) revert BadCommittee();
        governance = g;
        emit GovernanceSet(g);
    }

    function _setCommittee(bytes32[] memory m, uint8 t) private {
        uint256 n = m.length;
        if (n > MAX_MEMBERS || t < 2 || t > n || 2 * uint256(t) <= n) revert BadCommittee();
        uint64 e = epoch + 1;
        bytes32 last = bytes32(0);
        for (uint256 i = 0; i < n; ++i) {
            if (m[i] <= last) revert BadCommittee();   // nonzero, increasing, no repeats
            last = m[i];
            memberEpoch[m[i]] = e;
        }
        epoch = e;
        threshold = t;
        _members = m;
        emit CommitteeSet(e, m, t);
    }

    // ---- certificates ----

    /// What the committee signs for `root` now (src/saphanagg.js certDigest).
    function certDigest(bytes32 root) public view returns (bytes32) {
        return keccak256(abi.encode(TAG, block.chainid, address(this), epoch, root));
    }

    /// Anyone: brings the committee's certificate of `root` (threshold entries, keys hash-sorted).
    function certify(bytes32 root, bytes calldata cert) public {
        if (root == bytes32(0)) revert UnknownRoot();
        uint64 e = epoch;
        if (rootEpoch[root] == e) revert Known();
        _verify(certDigest(root), cert);
        rootEpoch[root] = e;
        emit RootCertified(root, e, msg.sender);
    }

    function _verify(bytes32 d, bytes calldata cert) private view {
        uint256 t = threshold;
        if (cert.length != t * ENTRY) revert Length();
        uint64 e = epoch;
        bytes32 last = bytes32(0);
        for (uint256 i = 0; i < t; ++i) {
            bytes32 h = _entry(d, cert[i * ENTRY:(i + 1) * ENTRY]);
            if (h <= last || memberEpoch[h] != e) revert BadCertificate(i);
            last = h;
        }
    }

    /// One certificate entry: the key's hash, after its signature of `d` passed the precompile (else zero).
    function _entry(bytes32 d, bytes calldata x) private view returns (bytes32) {
        bytes calldata pk = x[:PK_BYTES];
        (bool ok, bytes memory ret) = MLDSA.staticcall(bytes.concat(bytes1(uint8(44)), d, pk, x[PK_BYTES:]));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) return bytes32(0);
        return keccak256(pk);
    }

    // ---- attesting ----

    /// The airlock's id of a transfer (BridgeAirlock.transferId, same encoding) and its leaf here.
    function transferId(Transfer calldata x) public pure returns (bytes32) {
        return keccak256(abi.encode(x.srcChainId, x.srcContract, x.srcNonce, x.sender, x.to, x.amount));
    }

    function leaf(bytes32 id) public pure returns (bytes32) { return keccak256(bytes.concat(keccak256(abi.encode(id)))); }

    /// Anyone: one transfer of a certified root, with its Merkle path, attested to the airlock.
    function attest(Transfer calldata x, bytes32 root, bytes32[] calldata proof) external {
        if (!_attest(x, root, proof)) revert Twice();
    }

    /// Anyone: many transfers of one certified root. Transfers already attested are skipped; a bad path reverts.
    function attestMany(Transfer[] calldata xs, bytes32 root, bytes32[][] calldata proofs) external returns (uint256 n) {
        if (xs.length != proofs.length) revert Length();
        for (uint256 i = 0; i < xs.length; ++i) if (_attest(xs[i], root, proofs[i])) ++n;
    }

    /// Anyone, one call: certify `root` (unless it already is, in this epoch) and attest `x` under it. With a
    /// one-transfer root (root = leaf, empty path) this is "one aggregated proof per message".
    function certifyAndAttest(Transfer calldata x, bytes32 root, bytes32[] calldata proof, bytes calldata cert) external {
        if (rootEpoch[root] != epoch) certify(root, cert);
        if (!_attest(x, root, proof)) revert Twice();
    }

    function _attest(Transfer calldata x, bytes32 root, bytes32[] calldata proof) private returns (bool) {
        if (root == bytes32(0) || rootEpoch[root] != epoch) revert UnknownRoot();
        if (proof.length > MAX_DEPTH) revert BadProof();
        bytes32 id = transferId(x);
        bytes32 h = leaf(id);
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        if (h != root) revert BadProof();
        try airlock.attest(x.srcChainId, x.srcContract, x.srcNonce, x.sender, x.to, x.amount) {
            emit LaneAttested(id, root);
            return true;
        } catch (bytes memory err) {
            if (err.length == 4 && bytes4(err) == AIRLOCK_TWICE) return false;
            assembly { revert(add(err, 32), mload(err)) }
        }
    }
}
