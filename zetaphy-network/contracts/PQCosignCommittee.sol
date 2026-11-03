// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PQCosignCommittee: runners that co-sign large agent transactions with ML-DSA-44 (testnet)
/// @notice The post-quantum sibling of CosignCommittee (AgentPolicyWallet.sol). CosignCommittee's two ways
///         to co-sign, k-of-n ECDSA and one FROST signature, both rest on secp256k1: on Q-day the members'
///         keys (and FROST's group key) can be derived from public data and the committee impersonated.
///         Here each member holds an ML-DSA-44 key (FIPS 204) and t of the n members sign; every signature
///         is checked by ZETAPHY's precompile at 0x…0900, like PQMultisigIsm's validators. It is a t-of-n
///         ML-DSA multisig, not a threshold scheme: there is no group key, the proof carries t public keys
///         and t signatures (about 3.7 KB each), and which members signed is visible on chain.
///
///         Each member signs pqDigest(digest) = keccak256("ZETAPHY PQ cosign v1" ‖ digest), where digest is
///         AgentPolicyWallet.cosignDigest (bound to the chain, the wallet and its cosignNonce), after running
///         Neuro's checks on the action (src/cosign.js review; `zetaphy cosign pq-review`).
///
///         proof = n × [public key (1312) ‖ signature (2420)], entries ordered by keccak256(public key),
///         strictly ascending (each member counts once). Every entry must be a member with a valid
///         signature; valid when there are at least `threshold` of them. Members are stored as
///         keccak256(public key); the keys ride in the proof (src/pqcosign.js builds it).
///         Only works on a chain that verifies ML-DSA (ZETAPHY).
contract PQCosignCommittee {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant SIG_BYTES = 2420;
    uint256 public constant ENTRY = PK_BYTES + SIG_BYTES;
    uint256 public constant MAX_MEMBERS = 32;

    address public governance; // the chain's gov module (MsgEVMCall), a timelock or a multisig
    mapping(bytes32 => bool) public isMember;
    bytes32[] private memberList;
    uint256 public threshold;

    event MembersSet(bytes32[] members, uint256 threshold);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error BadMembers();

    constructor(address governance_, bytes32[] memory initialMembers, uint256 threshold_) {
        if (governance_ == address(0)) revert BadMembers();
        governance = governance_;
        _set(initialMembers, threshold_);
    }

    function setMembers(bytes32[] calldata newMembers, uint256 threshold_) external {
        if (msg.sender != governance) revert NotGovernance();
        _set(newMembers, threshold_);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        if (g == address(0)) revert BadMembers();
        governance = g;
        emit GovernanceChanged(g);
    }

    function members() external view returns (bytes32[] memory) {
        return memberList;
    }

    /// The 32 bytes each member signs with ML-DSA-44 for a wallet's cosign digest (domain-separated).
    function pqDigest(bytes32 digest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("ZETAPHY PQ cosign v1", digest));
    }

    /// True when the proof holds valid ML-DSA-44 signatures of pqDigest(digest) by at least `threshold`
    /// distinct members (and nothing else).
    function isValid(bytes32 digest, bytes calldata proof) external view returns (bool) {
        uint256 t = threshold;
        if (t == 0 || proof.length == 0 || proof.length % ENTRY != 0) return false;
        uint256 n = proof.length / ENTRY;
        if (n < t || n > MAX_MEMBERS) return false;
        bytes32 d = pqDigest(digest);
        bytes32 last = bytes32(0); // below every valid key hash (0 itself means refused)
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = _entry(d, proof[i * ENTRY:(i + 1) * ENTRY]);
            if (uint256(h) <= uint256(last)) return false; // ascending (and 0 = refused): no member counted twice
            last = h;
        }
        return true;
    }

    /// One entry (public key ‖ signature): its key hash when it is a member's valid signature of `d`, else 0.
    function _entry(bytes32 d, bytes calldata entry) private view returns (bytes32 h) {
        bytes calldata pk = entry[0:PK_BYTES];
        h = keccak256(pk);
        if (!isMember[h]) return bytes32(0);
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), d, pk, entry[PK_BYTES:ENTRY]));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) return bytes32(0);
    }

    function _set(bytes32[] memory members_, uint256 threshold_) private {
        if (members_.length > MAX_MEMBERS || threshold_ == 0 || threshold_ > members_.length) revert BadMembers();
        for (uint256 i = 0; i < memberList.length; i++) isMember[memberList[i]] = false;
        delete memberList;
        for (uint256 i = 0; i < members_.length; i++) {
            if (members_[i] == bytes32(0) || isMember[members_[i]]) revert BadMembers();
            isMember[members_[i]] = true;
            memberList.push(members_[i]);
        }
        threshold = threshold_;
        emit MembersSet(members_, threshold_);
    }
}
