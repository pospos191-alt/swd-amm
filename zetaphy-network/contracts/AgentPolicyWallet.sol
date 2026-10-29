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

/// @title CosignCommittee: runners that co-sign large agent transactions
/// @notice A k-of-n set of runner keys, chosen by governance (the chain's gov
///         module through a MsgEVMCall proposal, or a SimpleMultisig). A
///         member signs a co-sign digest only after running Neuro's checks
///         on the transaction (`zetaphy cosign`); isValid() counts distinct
///         member signatures (signers in ascending order, no repeats).
///         k-of-n separate ECDSA signatures, not a threshold-cryptography
///         signature: simple and checkable, at the cost of k signatures of gas.
contract CosignCommittee {
    uint256 public constant MAX_MEMBERS = 32;

    address public governance;
    mapping(address => bool) public isMember;
    address[] private memberList;
    uint256 public threshold;

    event MembersSet(address[] members, uint256 threshold);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error BadMembers();

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
///             checks on it (executeCosigned). Caps still apply to both;
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
