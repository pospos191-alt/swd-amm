// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPolicyWebAuthn {
    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    function verify(bytes32 challenge, Assertion calldata a, uint256 x, uint256 y, bytes32 rpIdHash, bool requireUV)
        external view returns (bool);
}

/// @title FrostSecp256k1: on-chain check of a FROST(secp256k1, SHA-256) signature (RFC 9591)
/// @notice A FROST signature is a plain Schnorr signature (R, z) under the group key PK:
///         z·G == R + c·PK with c = H2(R ‖ PK ‖ msg) (RFC 9591 §6.5: hash_to_field over
///         expand_message_xmd(SHA-256), DST "FROST-secp256k1-SHA256-v1chal"; points SEC1-compressed).
///         The EVM has no secp256k1 point multiplication, so the check uses ECRECOVER:
///         ecrecover(h, v, r, s) returns the address of r⁻¹·(s·Rr − h·G), where Rr is the point with
///         x = r and y-parity v−27. With r = PK.x, v from PK.y, s = −c·PK.x and h = −z·PK.x (mod n) it
///         returns the address of z·G − c·PK, which must equal R: we compare it with the address of
///         R, lifted from its compressed form with the modexp precompile. This is the construction
///         of V. Buterin, "You can *kinda* abuse ECRECOVER to do ECMUL in secp256k1 today"
///         (ethresear.ch, 2018), used by Chainlink's SchnorrSECP256K1.sol, noot/schnorr-verify and
///         Chronicle's Scribe. Unlike those, the challenge here is RFC 9591's (so signatures from any
///         RFC 9591 implementation verify) and R is a whole curve point lifted from x and parity,
///         not an address the signer supplies.
///         Caveats (docs/future/agents.md): like every ecrecover verifier it compares 160-bit
///         addresses; the group key's x must be below the curve order n (true except with ~2^-128
///         probability; the DKG refuses such a key).
library FrostSecp256k1 {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    /// y of the curve point with this x and y-parity (ok = false when x is not on the curve).
    function liftX(uint256 x, uint256 parity) internal view returns (bool ok, uint256 y) {
        if (x >= P || parity > 1) return (false, 0);
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
        y = _modexp(rhs, (P + 1) / 4, P); // P ≡ 3 (mod 4)
        if (mulmod(y, y, P) != rhs) return (false, 0);
        if (y & 1 != parity) y = P - y; // y != 0: secp256k1 has no point of order 2
        return (true, y);
    }

    /// RFC 9380 hash_to_field(msg, 1) for secp256k1's scalar field: expand_message_xmd with SHA-256,
    /// L = 48 bytes, reduced mod n. RFC 9591 uses it for H1, H2, H3 with DST = context ‖ tag.
    function hashToScalar(bytes memory message, bytes memory dst) internal pure returns (uint256) {
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));
        bytes32 b0 = sha256(abi.encodePacked(bytes32(0), bytes32(0), message, uint16(48), uint8(0), dstPrime));
        bytes32 b1 = sha256(abi.encodePacked(b0, uint8(1), dstPrime));
        bytes32 b2 = sha256(abi.encodePacked(b0 ^ b1, uint8(2), dstPrime));
        // the 48 bytes b1 ‖ b2[0:16] as an integer, mod n
        return addmod(mulmod(uint256(b1), 1 << 128, N), uint256(b2) >> 128, N);
    }

    /// RFC 9591 H2 (the challenge) for R (33 bytes), the group key (x, parity) and the message.
    function challenge(bytes memory rEnc, uint256 pkX, uint256 pkParity, bytes memory message) internal pure returns (uint256) {
        return hashToScalar(abi.encodePacked(rEnc, uint8(2 + pkParity), pkX, message), "FROST-secp256k1-SHA256-v1chal");
    }

    /// True when `sig` (RFC 9591 serialization: compressed R ‖ z, 65 bytes) is a valid signature of
    /// `message` under the group key (pkX, pkParity = PK.y mod 2).
    function verify(uint256 pkX, uint256 pkParity, bytes memory message, bytes memory sig) internal view returns (bool) {
        if (sig.length != 65 || pkX == 0 || pkX >= N || pkParity > 1) return false;
        uint256 prefix = uint8(sig[0]);
        if (prefix != 2 && prefix != 3) return false;
        uint256 rx;
        uint256 z;
        assembly {
            rx := mload(add(sig, 33))
            z := mload(add(sig, 65))
        }
        if (z == 0 || z >= N) return false;
        (bool ok, uint256 ry) = liftX(rx, prefix - 2);
        if (!ok) return false;
        uint256 c = challenge(abi.encodePacked(uint8(prefix), rx), pkX, pkParity, message);
        if (c == 0) return false;
        address q = _zGminusCP(pkX, pkParity, z, c);
        return q != address(0) && q == address(uint160(uint256(keccak256(abi.encodePacked(rx, ry)))));
    }

    /// The address of z·G − c·PK: ecrecover(−z·x, v(PK), x, −c·x) = x⁻¹·(−c·x·PK + z·x·G).
    function _zGminusCP(uint256 pkX, uint256 pkParity, uint256 z, uint256 c) private pure returns (address) {
        return ecrecover(bytes32(N - mulmod(z, pkX, N)), uint8(27 + pkParity), bytes32(pkX), bytes32(N - mulmod(c, pkX, N)));
    }

    /// A compressed group key (33 bytes) -> (x, parity), checking it is a curve point with 0 < x < n.
    function parseKey(bytes memory key) internal view returns (bool ok, uint256 x, uint256 parity) {
        if (key.length != 33 || (uint8(key[0]) != 2 && uint8(key[0]) != 3)) return (false, 0, 0);
        assembly { x := mload(add(key, 33)) }
        parity = uint8(key[0]) - 2;
        if (x == 0 || x >= N) return (false, 0, 0);
        (ok,) = liftX(x, parity);
    }

    function _modexp(uint256 b, uint256 e, uint256 m) private view returns (uint256 r) {
        (bool ok, bytes memory out) = address(0x05).staticcall(abi.encode(uint256(32), uint256(32), uint256(32), b, e, m));
        require(ok && out.length == 32, "modexp");
        r = uint256(bytes32(out));
    }
}

/// @title FrostVerifier: FrostSecp256k1 as a contract anyone can call (and the tests use)
contract FrostVerifier {
    /// groupKey: SEC1-compressed (33 bytes); sig: R (33) ‖ z (32), RFC 9591's serialization.
    function verify(bytes calldata groupKey, bytes calldata message, bytes calldata sig) external view returns (bool) {
        (bool ok, uint256 x, uint256 parity) = FrostSecp256k1.parseKey(groupKey);
        return ok && FrostSecp256k1.verify(x, parity, message, sig);
    }

    /// RFC 9591's challenge H2(R ‖ PK ‖ msg), for cross-checking implementations.
    function challenge(bytes calldata rEnc, bytes calldata groupKey, bytes calldata message) external view returns (uint256) {
        (bool ok, uint256 x, uint256 parity) = FrostSecp256k1.parseKey(groupKey);
        require(ok && rEnc.length == 33, "key");
        return FrostSecp256k1.challenge(rEnc, x, parity, message);
    }
}

/// @title CosignCommittee: runners that co-sign large agent transactions
/// @notice Two ways to co-sign, both set by governance (the chain's gov module
///         through a MsgEVMCall proposal, or a SimpleMultisig):
///           - k-of-n separate ECDSA signatures (isValid): each member signs
///             the digest; signers in ascending order, no repeats. Simple and
///             checkable, k signatures of gas. Kept as the fallback.
///           - a FROST threshold signature (isValidFrost, RFC 9591): the
///             members ran a distributed key generation (no dealer;
///             `zetaphy cosign dkg1|dkg2|dkg3`) for a t-of-n group key; any t
///             of them make ONE 65-byte Schnorr signature in two rounds
///             (`zetaphy cosign commit | frost-sign | frost-aggregate`),
///             checked by FrostSecp256k1 at the cost of about one ecrecover
///             whatever t is. Which members signed is not visible on chain.
///         A member signs only after running Neuro's checks on the transaction.
contract CosignCommittee {
    uint256 public constant MAX_MEMBERS = 32;

    address public governance;
    mapping(address => bool) public isMember;
    address[] private memberList;
    uint256 public threshold;
    uint256 public frostKeyX;      // FROST group key: x (0 = none) ...
    uint256 public frostKeyParity; // ... and the parity of y

    event MembersSet(address[] members, uint256 threshold);
    event GovernanceChanged(address governance);
    event FrostKeySet(bytes groupKey);

    error NotGovernance();
    error BadMembers();
    error BadFrostKey();

    constructor(address governance_, address[] memory initialMembers, uint256 threshold_) {
        governance = governance_;
        _set(initialMembers, threshold_);
    }

    function setMembers(address[] calldata newMembers, uint256 threshold_) external {
        if (msg.sender != governance) revert NotGovernance();
        _set(newMembers, threshold_);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        governance = g;
        emit GovernanceChanged(g);
    }

    /// The FROST group key (33 bytes, SEC1-compressed, from `zetaphy cosign dkg3`); empty removes it.
    function setFrostKey(bytes calldata groupKey) external {
        if (msg.sender != governance) revert NotGovernance();
        if (groupKey.length == 0) {
            frostKeyX = 0;
            frostKeyParity = 0;
        } else {
            (bool ok, uint256 x, uint256 parity) = FrostSecp256k1.parseKey(groupKey);
            if (!ok) revert BadFrostKey();
            frostKeyX = x;
            frostKeyParity = parity;
        }
        emit FrostKeySet(groupKey);
    }

    /// True when `sig` is the group's FROST signature (RFC 9591, 65 bytes) of the 32-byte digest.
    function isValidFrost(bytes32 digest, bytes calldata sig) external view returns (bool) {
        if (frostKeyX == 0) return false;
        return FrostSecp256k1.verify(frostKeyX, frostKeyParity, abi.encodePacked(digest), sig);
    }

    function members() external view returns (address[] memory) {
        return memberList;
    }

    /// True when at least `threshold` distinct members signed `digest` (65-byte ECDSA each, signers ascending).
    function isValid(bytes32 digest, bytes[] calldata sigs) external view returns (bool) {
        if (threshold == 0) return false;
        uint256 count;
        address last;
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _recover(digest, sigs[i]);
            if (s <= last) return false; // ascending: no signer counted twice
            last = s;
            if (isMember[s]) count++;
        }
        return count >= threshold;
    }

    function _set(address[] memory members_, uint256 threshold_) private {
        if (members_.length > MAX_MEMBERS || threshold_ == 0 || threshold_ > members_.length) revert BadMembers();
        for (uint256 i = 0; i < memberList.length; i++) isMember[memberList[i]] = false;
        delete memberList;
        for (uint256 i = 0; i < members_.length; i++) {
            if (members_[i] == address(0) || isMember[members_[i]]) revert BadMembers();
            isMember[members_[i]] = true;
            memberList.push(members_[i]);
        }
        threshold = threshold_;
        emit MembersSet(members_, threshold_);
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(d, v, r, s);
    }
}

interface ICosignCommittee {
    function isValid(bytes32 digest, bytes[] calldata sigs) external view returns (bool);
    function isValidFrost(bytes32 digest, bytes calldata sig) external view returns (bool);
}

/// @title AgentPolicyWallet: a wallet an AI agent runs inside guardrails (testnet)
/// @notice The owner (a person) holds the funds and sets the policy; the agent
///         key can only act inside it:
///           - spend caps per period, per token (address 0 = the native coin),
///             counting native value, ERC-20 transfer amounts and approvals;
///             a token without a cap cannot be moved by the agent at all;
///           - allow-listed recipients (native sends and ERC-20 transfers) and
///             contracts (any other call, and approval spenders);
///             transferFrom, increaseAllowance, setApprovalForAll and permit
///             are refused outright;
///           - above a per-token threshold ("cosignAbove"), an action either
///             waits in a timelock (queue, then executeQueued after `delay`;
///             the owner may cancel) or carries co-signatures of the runner
///             committee (CosignCommittee, set by governance) that ran Neuro
///             checks on it: k-of-n ECDSA (executeCosigned) or one FROST
///             threshold signature (executeCosignedFrost). Caps apply to all;
///           - emergency freeze: the owner's account, the owner's passkey
///             (WebAuthn, P-256 precompile via WebAuthnVerifier) or the
///             owner's ML-DSA-44 key (precompile 0x…0900) stops the agent at
///             once; passkey and PQ freezes are signed messages anyone can
///             relay. Only the owner's account unfreezes.
///         Every agent action logs (modelHash, promptHash) provenance.
///         The owner itself is not limited (ownerExecute), so it can always
///         take the funds back, frozen or not.
contract AgentPolicyWallet {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;

    bytes4 private constant TRANSFER = 0xa9059cbb;
    bytes4 private constant APPROVE = 0x095ea7b3;
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 private constant PERMIT = 0xd505accf;
    uint256 public constant MAX_DELAY = 30 days;

    struct Limit {
        bool set;
        uint256 perPeriod;
        uint256 cosignAbove; // amounts above this need the timelock or the committee
        uint256 spent;
        uint64 windowStart;
    }

    address public owner;
    address public agent;
    ICosignCommittee public committee;
    IPolicyWebAuthn public webauthn;

    bytes32 public pqKeyHash;   // owner's ML-DSA-44 key (0 = none)
    uint256 public passkeyX;    // owner's passkey (0,0 = none)
    uint256 public passkeyY;
    bytes32 public rpIdHash;

    bool public frozen;
    uint256 public freezeNonce;
    uint256 public cosignNonce;
    uint256 public period;
    uint256 public delay;
    uint256 public queueCount;

    mapping(address => Limit) public limits;
    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public allowedRecipient;
    mapping(bytes32 => uint64) public queuedAt; // id -> ready time (0 = none)

    event AgentAction(address indexed to, uint256 value, bytes4 selector, address token, uint256 amount, bytes32 modelHash, bytes32 promptHash, uint8 path);
    event Queued(bytes32 indexed id, uint256 seq, address to, uint256 value, bytes data, bytes32 modelHash, bytes32 promptHash, uint64 readyAt);
    event Cancelled(bytes32 indexed id);
    event Frozen(address by, uint8 how);
    event Unfrozen();
    event LimitSet(address indexed token, uint256 perPeriod, uint256 cosignAbove);
    event AllowSet(address indexed who, bool target, bool recipient);
    event ConfigSet(address agent, address committee, uint256 period, uint256 delay);
    event EmergencyKeysSet(bytes32 pqKeyHash, uint256 passkeyX, uint256 passkeyY, bytes32 rpIdHash);
    event OwnerChanged(address owner);

    error NotOwner();
    error NotAgent();
    error IsFrozen();
    error NotAllowed(address who);
    error Forbidden(bytes4 selector);
    error NoLimit(address token);
    error OverCap(address token, uint256 spent, uint256 cap);
    error NeedsDelayOrCosign(address token, uint256 amount);
    error NotQueued();
    error NotReady();
    error BadCosign();
    error Expired();
    error BadEmergencyKey();
    error BadConfig();
    error CallFailed(bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert IsFrozen();
        _;
    }

    constructor(address owner_, address agent_, address committee_, address webauthn_, uint256 period_, uint256 delay_) payable {
        owner = owner_;
        webauthn = IPolicyWebAuthn(webauthn_);
        _config(agent_, committee_, period_, delay_);
    }

    receive() external payable {}

    // ------------------------------------------------------------- agent

    /// Within caps, allow-lists and below every cosignAbove: runs at once.
    function execute(address to, uint256 value, bytes calldata data, bytes32 modelHash, bytes32 promptHash)
        external onlyAgent returns (bytes memory)
    {
        (address token, uint256 amount) = _classify(to, value, data);
        if (amount != 0 && !limits[token].set) revert NoLimit(token);
        if (amount > limits[token].cosignAbove) revert NeedsDelayOrCosign(token, amount);
        return _run(to, value, data, token, amount, modelHash, promptHash, 0);
    }

    /// Above a threshold, path 1: wait `delay`, during which the owner sees it and may cancel or freeze.
    function queue(address to, uint256 value, bytes calldata data, bytes32 modelHash, bytes32 promptHash)
        external onlyAgent returns (bytes32 id)
    {
        _classify(to, value, data); // allow-lists checked now too, so a bad action fails early
        uint256 seq = ++queueCount;
        id = keccak256(abi.encode(seq, to, value, keccak256(data), modelHash, promptHash));
        uint64 readyAt = uint64(block.timestamp + delay);
        queuedAt[id] = readyAt;
        emit Queued(id, seq, to, value, data, modelHash, promptHash, readyAt);
    }

    function executeQueued(uint256 seq, address to, uint256 value, bytes calldata data, bytes32 modelHash, bytes32 promptHash)
        external onlyAgent returns (bytes memory)
    {
        bytes32 id = keccak256(abi.encode(seq, to, value, keccak256(data), modelHash, promptHash));
        uint64 readyAt = queuedAt[id];
        if (readyAt == 0) revert NotQueued();
        if (block.timestamp < readyAt) revert NotReady();
        delete queuedAt[id];
        (address token, uint256 amount) = _classify(to, value, data);
        return _run(to, value, data, token, amount, modelHash, promptHash, 1);
    }

    /// The digest committee members sign for one large action (raw 32 bytes, no EIP-191 prefix;
    /// bound to this chain, this wallet and cosignNonce). src/cosign.js computes the same.
    function cosignDigest(address to, uint256 value, bytes calldata data, bytes32 reportHash, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encode("ZETAPHY AgentCosign", block.chainid, address(this), cosignNonce, to, value,
            keccak256(data), reportHash, deadline));
    }

    /// Above a threshold, path 2: no wait, with the committee's co-signatures
    /// (reportHash = the Neuro report the runners checked).
    function executeCosigned(
        address to,
        uint256 value,
        bytes calldata data,
        bytes32 modelHash,
        bytes32 promptHash,
        bytes32 reportHash,
        uint256 deadline,
        bytes[] calldata sigs
    ) external onlyAgent returns (bytes memory) {
        if (block.timestamp > deadline) revert Expired();
        if (address(committee) == address(0) || !committee.isValid(cosignDigest(to, value, data, reportHash, deadline), sigs)) revert BadCosign();
        cosignNonce++;
        (address token, uint256 amount) = _classify(to, value, data);
        return _run(to, value, data, token, amount, modelHash, promptHash, 2);
    }

    /// Path 2 with ONE FROST threshold signature of the same digest (any t of the committee's DKG
    /// group signed it in two rounds) instead of k separate ECDSA signatures.
    function executeCosignedFrost(
        address to,
        uint256 value,
        bytes calldata data,
        bytes32 modelHash,
        bytes32 promptHash,
        bytes32 reportHash,
        uint256 deadline,
        bytes calldata sig
    ) external onlyAgent returns (bytes memory) {
        if (block.timestamp > deadline) revert Expired();
        if (address(committee) == address(0) || !committee.isValidFrost(cosignDigest(to, value, data, reportHash, deadline), sig)) revert BadCosign();
        cosignNonce++;
        (address token, uint256 amount) = _classify(to, value, data);
        return _run(to, value, data, token, amount, modelHash, promptHash, 3);
    }

    // ------------------------------------------------------------- emergency freeze

    /// The 32 bytes the owner's passkey or ML-DSA key signs to freeze the wallet.
    function freezeChallenge() public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY freeze", block.chainid, address(this), freezeNonce));
    }

    function freeze() external onlyOwner {
        _freeze(0);
    }

    function freezeWithPasskey(IPolicyWebAuthn.Assertion calldata assertion) external {
        if (passkeyX == 0 && passkeyY == 0) revert BadEmergencyKey();
        if (!webauthn.verify(freezeChallenge(), assertion, passkeyX, passkeyY, rpIdHash, true)) revert BadEmergencyKey();
        _freeze(1);
    }

    function freezeWithPq(bytes calldata pqPublicKey, bytes calldata pqSig) external {
        if (pqKeyHash == bytes32(0) || keccak256(pqPublicKey) != pqKeyHash) revert BadEmergencyKey();
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), freezeChallenge(), pqPublicKey, pqSig));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) revert BadEmergencyKey();
        _freeze(2);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Unfrozen();
    }

    // ------------------------------------------------------------- owner

    function ownerExecute(address to, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
    }

    function cancel(bytes32 id) external onlyOwner {
        if (queuedAt[id] == 0) revert NotQueued();
        delete queuedAt[id];
        emit Cancelled(id);
    }

    function setLimit(address token, uint256 perPeriod, uint256 cosignAbove) external onlyOwner {
        Limit storage l = limits[token];
        l.set = true;
        l.perPeriod = perPeriod;
        l.cosignAbove = cosignAbove;
        emit LimitSet(token, perPeriod, cosignAbove);
    }

    function setAllowed(address who, bool target, bool recipient) external onlyOwner {
        allowedTarget[who] = target;
        allowedRecipient[who] = recipient;
        emit AllowSet(who, target, recipient);
    }

    function setConfig(address agent_, address committee_, uint256 period_, uint256 delay_) external onlyOwner {
        _config(agent_, committee_, period_, delay_);
    }

    function setEmergencyKeys(bytes32 pqKeyHash_, uint256 x, uint256 y, bytes32 rpIdHash_) external onlyOwner {
        pqKeyHash = pqKeyHash_;
        passkeyX = x;
        passkeyY = y;
        rpIdHash = rpIdHash_;
        emit EmergencyKeysSet(pqKeyHash_, x, y, rpIdHash_);
    }

    function setOwner(address o) external onlyOwner {
        if (o == address(0)) revert BadConfig();
        owner = o;
        emit OwnerChanged(o);
    }

    /// What is left of a token's cap in the current period.
    function remaining(address token) external view returns (uint256) {
        Limit storage l = limits[token];
        if (!l.set) return 0;
        uint256 spent = block.timestamp >= l.windowStart + period ? 0 : l.spent;
        return spent >= l.perPeriod ? 0 : l.perPeriod - spent;
    }

    // ------------------------------------------------------------- internals

    function _config(address agent_, address committee_, uint256 period_, uint256 delay_) private {
        if (period_ == 0 || delay_ > MAX_DELAY) revert BadConfig();
        agent = agent_;
        committee = ICosignCommittee(committee_);
        period = period_;
        delay = delay_;
        emit ConfigSet(agent_, committee_, period_, delay_);
    }

    function _freeze(uint8 how) private {
        frozen = true;
        freezeNonce++;
        emit Frozen(msg.sender, how);
    }

    /// Which token an action moves and how much, after the allow-list checks.
    function _classify(address to, uint256 value, bytes calldata data) private view returns (address token, uint256 amount) {
        if (data.length == 0) {
            if (!allowedRecipient[to] && !allowedTarget[to]) revert NotAllowed(to);
            return (address(0), value);
        }
        bytes4 sel = data.length >= 4 ? bytes4(data[0:4]) : bytes4(0);
        if (sel == TRANSFER_FROM || sel == INCREASE_ALLOWANCE || sel == SET_APPROVAL_FOR_ALL || sel == PERMIT) revert Forbidden(sel);
        if (sel == TRANSFER || sel == APPROVE) {
            if (value != 0 || data.length < 68) revert Forbidden(sel);
            (address who, uint256 amt) = abi.decode(data[4:68], (address, uint256));
            if (sel == TRANSFER ? !allowedRecipient[who] : !allowedTarget[who]) revert NotAllowed(who);
            if (!limits[to].set) revert NoLimit(to);
            return (to, amt);
        }
        if (!allowedTarget[to]) revert NotAllowed(to);
        return (address(0), value);
    }

    function _run(address to, uint256 value, bytes calldata data, address token, uint256 amount, bytes32 modelHash, bytes32 promptHash, uint8 path)
        private returns (bytes memory ret)
    {
        if (amount != 0) {
            Limit storage l = limits[token];
            if (!l.set) revert NoLimit(token);
            if (block.timestamp >= l.windowStart + period) {
                l.windowStart = uint64(block.timestamp);
                l.spent = 0;
            }
            uint256 spent = l.spent + amount;
            if (spent > l.perPeriod) revert OverCap(token, spent, l.perPeriod);
            l.spent = spent;
        }
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit AgentAction(to, value, data.length >= 4 ? bytes4(data[0:4]) : bytes4(0), token, amount, modelHash, promptHash, path);
    }
}
