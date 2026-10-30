// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZkPoseidonT3 {
    function poseidon(uint256[2] calldata x) external pure returns (uint256);
}

interface IZkIdentityVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[5] calldata pub)
        external view returns (bool);
}

interface IZkLabels {
    function labelOf(address account) external view returns (uint8);
    function humans(address account) external view returns (uint64 validUntil, uint8 method, bytes32 credentialHash, address attester);
}

interface IZkVouch {
    function levelOf(address account) external view returns (uint8);
}

/// @title ZkIdentityRegistry: private identities for labelled humans (testnet)
/// @notice docs/future/zk-identity.md. An account with a HUMAN label (LabelRegistry: a passkey checked on chain or by an
///   approved attester) registers an identity commitment C = Poseidon(secret, nullifierKey) that it made in its
///   browser. The registry stores the leaf Poseidon(C, level) in a Poseidon Merkle tree (depth 20), where level is
///   the account's uniqueness level when it registered or was last synced: 1 passkey human, 2 vouched unique human
///   (VouchRegistry; 1 if no VouchRegistry is set).
///   Later the person proves with a Groth16 proof (ZkIdentityVerifier) "my leaf is in the tree, my level >= X" and
///   reveals only nullifier = Poseidon(nullifierKey, scope), one per person per scope (PrivateAirdrop, PrivatePoll).
///
///   Which accounts are members is PUBLIC (registration is a transaction from the account). What is hidden is which
///   member made a given proof, and whether two proofs in different scopes came from the same member.
///
///   Binding rules (against making many identities from one label):
///   - an account keeps its first commitment forever: it can never register a second one;
///   - a passkey (credentialHash) is bound forever to the first commitment registered with it: moving the passkey to
///     a new account lets that account carry the SAME commitment (same nullifiers), never a new one;
///   - a commitment is in the tree at most once (one active account).
///   So a new identity needs a new account AND a new passkey (and, for level 2, new vouches): the anti-sybil
///   strength is exactly that of the labels and vouches (a person can make many passkeys; level 1 is a speed bump).
///
///   Labels expire and levels change: sync(account), callable by anyone, sets the leaf to the account's current
///   level, or removes it (leaf 0) when the account no longer holds a human label. Until someone calls it, the old
///   leaf stays provable. Replaced roots stay valid for rootTtl seconds, so proofs in flight survive new
///   registrations (and a removed member can still prove against a root younger than rootTtl).
///
///   Scopes: each app registers its scopes here (first come, first served), so two apps never share a nullifier
///   space by accident.
contract ZkIdentityRegistry {
    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 20;
    uint8 public constant HUMAN = 1;

    IZkPoseidonT3 public immutable poseidon;
    IZkIdentityVerifier public immutable verifier;
    IZkLabels public immutable labels;
    IZkVouch public vouch;
    address public governance;
    uint64 public rootTtl;

    struct Member {
        uint256 commitment;
        uint32 index;
        uint8 level;  // 0 = not in the tree now
        bool active;
    }

    mapping(address => Member) public memberOf;
    mapping(bytes32 => uint256) public credentialCommitment; // passkey hash -> the commitment it is bound to
    mapping(uint256 => address) public commitmentAccount;    // commitment -> the account that holds it
    mapping(uint256 => address) public scopeOwner;
    mapping(uint256 => uint64) public rootReplacedAt;        // when a root stopped being the current one
    mapping(uint256 => bool) public rootSeen;
    uint256 public root;
    uint256 public leafCount;
    uint256[21] private zeros;                                // zeros[h]: an empty subtree of height h
    mapping(uint256 => uint256) private nodes;                // (h << 32) | index -> node (0 = empty)

    event Registered(address indexed account, uint256 indexed commitment, uint256 index, uint8 level, uint256 root);
    event Synced(address indexed account, uint256 index, uint8 level, uint256 root);
    event LeafSet(uint256 indexed index, uint256 leaf, uint256 root);
    event ScopeRegistered(uint256 indexed scope, address indexed owner);
    event ConfigSet(address vouch, uint64 rootTtl);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotHuman();
    error BadCommitment();
    error AccountBound(uint256 commitment);
    error PasskeyBound(uint256 commitment);
    error CommitmentTaken(address account);
    error AlreadyMember();
    error NotMember();
    error Unchanged();
    error TreeFull();
    error ScopeTaken(address owner);
    error BadScope();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(IZkPoseidonT3 poseidon_, IZkIdentityVerifier verifier_, IZkLabels labels_, IZkVouch vouch_, address governance_, uint64 rootTtl_) {
        poseidon = poseidon_;
        verifier = verifier_;
        labels = labels_;
        vouch = vouch_;
        governance = governance_;
        rootTtl = rootTtl_;
        uint256 z = 0;
        for (uint256 h = 0; h <= DEPTH; h++) {
            zeros[h] = z;
            z = _hash(z, z);
        }
        root = zeros[DEPTH];
        rootSeen[root] = true;
    }

    // ------------------------------------------------------------- reading

    /// The level `account` would be registered at now: 0 (no human label, or an agent), 1 or 2.
    function levelNow(address account) public view returns (uint8) {
        if (labels.labelOf(account) != HUMAN) return 0;
        if (address(vouch) == address(0)) return 1;
        uint8 l = vouch.levelOf(account);
        return l == 0 ? 1 : l;
    }

    /// The current root, or a replaced one younger than rootTtl.
    function isValidRoot(uint256 r) public view returns (bool) {
        if (r == root) return true;
        return rootSeen[r] && rootReplacedAt[r] != 0 && block.timestamp <= uint256(rootReplacedAt[r]) + rootTtl;
    }

    function zeroAt(uint256 h) external view returns (uint256) {
        return zeros[h];
    }

    /// Leaves [from, from + count) (0 = empty or removed), for provers rebuilding the tree locally.
    function leavesRange(uint256 from, uint256 count) external view returns (uint256[] memory out) {
        if (from >= leafCount) return new uint256[](0);
        if (count > leafCount - from) count = leafCount - from;
        out = new uint256[](count);
        for (uint256 i = 0; i < count; i++) out[i] = nodes[from + i];
    }

    /// Checks a membership proof: root known and recent, level >= minLevel, nullifier for `scope`, bound to `signalHash`.
    /// proof = [a0, a1, b00, b01, b10, b11, c0, c1] in the Solidity verifier's order (zkid-core.js proofWords).
    function verify(uint256 root_, uint256 nullifier, uint256 scope, uint256 signalHash, uint256 minLevel, uint256[8] calldata proof)
        public view returns (bool)
    {
        if (!isValidRoot(root_) || minLevel == 0) return false;
        return verifier.verifyProof(
            [proof[0], proof[1]], [[proof[2], proof[3]], [proof[4], proof[5]]], [proof[6], proof[7]],
            [root_, nullifier, scope, signalHash, minLevel]
        );
    }

    // ------------------------------------------------------------- members

    /// Registers the caller's identity commitment (made in its browser; reveals nothing about the secret).
    function register(uint256 commitment) external {
        if (commitment == 0 || commitment >= SNARK_FIELD) revert BadCommitment();
        uint8 level = levelNow(msg.sender);
        if (level == 0) revert NotHuman();
        Member storage m = memberOf[msg.sender];
        if (m.active) revert AlreadyMember();
        if (m.commitment != 0 && m.commitment != commitment) revert AccountBound(m.commitment);
        (, , bytes32 cred, ) = labels.humans(msg.sender);
        uint256 bound = credentialCommitment[cred];
        if (bound != 0 && bound != commitment) revert PasskeyBound(bound);
        address holder = commitmentAccount[commitment];
        if (holder != address(0) && holder != msg.sender) {
            _sync(holder); // drops the old holder if it lost its label (e.g. the passkey moved here)
            if (memberOf[holder].active) revert CommitmentTaken(holder);
        }
        credentialCommitment[cred] = commitment;
        commitmentAccount[commitment] = msg.sender;
        uint256 index;
        if (m.commitment == commitment) {
            index = m.index; // back after a removal: the same slot
        } else {
            index = leafCount;
            if (index >= 2 ** DEPTH) revert TreeFull();
            leafCount = index + 1;
        }
        memberOf[msg.sender] = Member({commitment: commitment, index: uint32(index), level: level, active: true});
        uint256 r = _setLeaf(index, _hash(commitment, level));
        emit Registered(msg.sender, commitment, index, level, r);
    }

    /// Sets `account`'s leaf to its level now, or removes it if it no longer qualifies. Anyone may call it.
    function sync(address account) external {
        Member storage m = memberOf[account];
        if (!m.active) revert NotMember();
        if (!_sync(account)) revert Unchanged();
    }

    function _sync(address account) private returns (bool changed) {
        Member storage m = memberOf[account];
        if (!m.active) return false;
        uint8 level = levelNow(account);
        if (level != 0) {
            // the account's passkey now may be bound to another identity: it no longer qualifies with this one
            (, , bytes32 cred, ) = labels.humans(account);
            uint256 bound = credentialCommitment[cred];
            if (bound != 0 && bound != m.commitment) level = 0;
        }
        if (level == m.level) return false;
        m.level = level;
        uint256 r;
        if (level == 0) {
            m.active = false;
            r = _setLeaf(m.index, 0);
        } else {
            r = _setLeaf(m.index, _hash(m.commitment, level));
        }
        emit Synced(account, m.index, level, r);
        return true;
    }

    // ------------------------------------------------------------- scopes

    /// Claims `scope` for the caller (an app contract). Nullifiers are per scope: one owner per scope.
    function registerScope(uint256 scope) external {
        if (scope == 0 || scope >= SNARK_FIELD) revert BadScope();
        address o = scopeOwner[scope];
        if (o != address(0)) revert ScopeTaken(o);
        scopeOwner[scope] = msg.sender;
        emit ScopeRegistered(scope, msg.sender);
    }

    // ------------------------------------------------------------- governance

    function setConfig(IZkVouch vouch_, uint64 rootTtl_) external onlyGovernance {
        vouch = vouch_;
        rootTtl = rootTtl_;
        emit ConfigSet(address(vouch_), rootTtl_);
    }

    function setGovernance(address g) external onlyGovernance {
        governance = g;
        emit GovernanceChanged(g);
    }

    // ------------------------------------------------------------- tree

    function _hash(uint256 a, uint256 b) private view returns (uint256) {
        return poseidon.poseidon([a, b]);
    }

    function _setLeaf(uint256 index, uint256 leaf) private returns (uint256 r) {
        uint256 node = leaf;
        uint256 i = index;
        for (uint256 h = 0; h < DEPTH; h++) {
            nodes[(h << 32) | i] = node;
            uint256 sib = nodes[(h << 32) | (i ^ 1)];
            if (sib == 0) sib = zeros[h];
            node = (i & 1) == 1 ? _hash(sib, node) : _hash(node, sib);
            i >>= 1;
        }
        r = node;
        uint256 old = root;
        if (old != r) {
            rootReplacedAt[old] = uint64(block.timestamp);
            root = r;
            rootReplacedAt[r] = 0;
            rootSeen[r] = true;
        }
        emit LeafSet(index, leaf, r);
    }
}
