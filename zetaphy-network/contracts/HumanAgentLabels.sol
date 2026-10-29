// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILabelWebAuthn {
    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    function verify(bytes32 challenge, Assertion calldata a, uint256 x, uint256 y, bytes32 rpIdHash, bool requireUV)
        external view returns (bool);
}

interface ILabelAgents {
    function activeAgentOf(address account) external view returns (uint256);
}

/// The read interface for hooks (faucets, DEX gates, ...).
interface ILabels {
    /// 0 = no label, 1 = human (passkey-verified), 2 = registered AI agent
    function labelOf(address account) external view returns (uint8);
}

/// @title LabelRegistry: "human" or "agent" labels for accounts (testnet)
/// @notice
///   AGENT: an account an active agent of AgentRegistry transacts from
///          (bonded, not unbonding). Read live from the registry, so it
///          follows registration, unbonding and slashing.
///   HUMAN: an account whose owner showed a passkey (WebAuthn) with user
///          verification (fingerprint, face or device PIN), in one of two ways:
///          - on chain: proveHumanP256 checks the assertion through
///            WebAuthnVerifier (the P-256 precompile 0x…0100); the passkey's
///            challenge commits to this account and its nonce;
///          - off chain: an attester governance approved (a volunteer runner)
///            verified the assertion and signs an EIP-712 HumanAttestation
///            that anyone submits with attestHuman.
///          One passkey (its public key hash) labels one account at a time;
///          moving it to another account drops the old one's label.
///   An agent account is labelled AGENT even if it once proved a passkey.
///
///   What a HUMAN label does NOT prove: that the person is unique. Anyone can
///   make many passkeys. It proves a person was present at a device when the
///   label was made (expires after humanTtl). Hooks must treat it as a
///   speed bump against simple bots, not as proof of personhood.
contract LabelRegistry is ILabels {
    uint8 public constant NONE = 0;
    uint8 public constant HUMAN = 1;
    uint8 public constant AGENT = 2;
    uint8 public constant BY_PASSKEY = 1;
    uint8 public constant BY_ATTESTER = 2;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "HumanAttestation(address account,bytes32 credentialHash,uint64 validUntil,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct Human {
        uint64 validUntil;
        uint8 method;
        bytes32 credentialHash;
        address attester; // 0 for an on-chain passkey proof
    }

    address public governance;
    ILabelAgents public agents;
    ILabelWebAuthn public webauthn;
    bytes32 public rpIdHash;  // sha256 of the hub's host name (0 = any site)
    uint64 public humanTtl;

    mapping(address => bool) public isAttester;
    mapping(address => Human) public humans;
    mapping(bytes32 => address) public credentialAccount;
    mapping(address => uint256) public nonces;

    event HumanLabelled(address indexed account, bytes32 indexed credentialHash, uint8 method, address attester, uint64 validUntil);
    event HumanRevoked(address indexed account, address by);
    event AttesterSet(address indexed attester, bool allowed);
    event ConfigSet(address agents, address webauthn, bytes32 rpIdHash, uint64 humanTtl);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotAttester();
    error BadPasskey();
    error BadSignature();
    error Expired();
    error BadTtl();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_, address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) {
        governance = governance_;
        _config(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    // ------------------------------------------------------------- reading

    function labelOf(address account) public view returns (uint8) {
        if (address(agents) != address(0) && agents.activeAgentOf(account) != 0) return AGENT;
        Human storage h = humans[account];
        if (h.validUntil >= block.timestamp && credentialAccount[h.credentialHash] == account) return HUMAN;
        return NONE;
    }

    function isHuman(address account) external view returns (bool) {
        return labelOf(account) == HUMAN;
    }

    function isAgent(address account) external view returns (bool) {
        return labelOf(account) == AGENT;
    }

    /// The 32-byte challenge the passkey must sign to label `account` now.
    function humanChallenge(address account) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY human label", block.chainid, address(this), account, nonces[account]));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY Labels"), keccak256("1"), block.chainid, address(this)));
    }

    function attestationDigest(address account, bytes32 credentialHash, uint64 validUntil, uint256 nonce, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(ATTESTATION_TYPEHASH, account, credentialHash, validUntil, nonce, deadline))));
    }

    // ------------------------------------------------------------- labelling

    /// On-chain path: msg.sender labels itself with a passkey assertion over humanChallenge(msg.sender).
    function proveHumanP256(uint256 x, uint256 y, ILabelWebAuthn.Assertion calldata assertion) external {
        if (!webauthn.verify(humanChallenge(msg.sender), assertion, x, y, rpIdHash, true)) revert BadPasskey();
        _label(msg.sender, keccak256(abi.encode(x, y)), BY_PASSKEY, address(0), uint64(block.timestamp) + humanTtl);
    }

    /// Off-chain path: an attester's EIP-712 HumanAttestation, submitted by anyone.
    function attestHuman(address account, bytes32 credentialHash, uint64 validUntil, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        if (validUntil > block.timestamp + humanTtl) revert BadTtl();
        address attester = _recover(attestationDigest(account, credentialHash, validUntil, nonces[account], deadline), sig);
        if (!isAttester[attester]) revert NotAttester();
        _label(account, credentialHash, BY_ATTESTER, attester, validUntil);
    }

    /// The account itself, governance or any attester can remove a human label.
    function revokeHuman(address account) external {
        if (msg.sender != account && msg.sender != governance && !isAttester[msg.sender]) revert NotAttester();
        Human storage h = humans[account];
        if (credentialAccount[h.credentialHash] == account) delete credentialAccount[h.credentialHash];
        delete humans[account];
        nonces[account]++;
        emit HumanRevoked(account, msg.sender);
    }

    // ------------------------------------------------------------- governance

    function setAttester(address a, bool allowed) external onlyGovernance {
        isAttester[a] = allowed;
        emit AttesterSet(a, allowed);
    }

    function setConfig(address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) external onlyGovernance {
        _config(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    function setGovernance(address g) external onlyGovernance {
        governance = g;
        emit GovernanceChanged(g);
    }

    // ------------------------------------------------------------- internals

    function _config(address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) private {
        if (humanTtl_ == 0 || humanTtl_ > 400 days) revert BadTtl();
        agents = ILabelAgents(agents_);
        webauthn = ILabelWebAuthn(webauthn_);
        rpIdHash = rpIdHash_;
        humanTtl = humanTtl_;
        emit ConfigSet(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    function _label(address account, bytes32 cred, uint8 method, address attester, uint64 until) private {
        if (cred == bytes32(0)) revert BadPasskey();
        address prev = credentialAccount[cred];
        if (prev != address(0) && prev != account) delete humans[prev]; // one passkey, one account
        Human storage old = humans[account];
        if (old.credentialHash != bytes32(0) && old.credentialHash != cred && credentialAccount[old.credentialHash] == account) {
            delete credentialAccount[old.credentialHash];
        }
        credentialAccount[cred] = account;
        humans[account] = Human({validUntil: until, method: method, credentialHash: cred, attester: attester});
        nonces[account]++;
        emit HumanLabelled(account, cred, method, attester, until);
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(d, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }
}

/// @title LabelFaucet: a testnet faucet hook that reads labels
/// @notice Pays each label its own amount (e.g. humans 10, agents 1,
///         unlabelled 0) at most once per cooldown per account, and, for
///         humans, once per cooldown per passkey too, so moving one passkey
///         across accounts does not multiply the drip. Funded by anyone.
contract LabelFaucet {
    LabelRegistry public immutable labels;
    address public governance;
    uint256 public cooldown;
    uint256[3] public amountFor; // by label: NONE, HUMAN, AGENT
    mapping(address => uint256) public lastDrip;
    mapping(bytes32 => uint256) public lastDripCredential;

    event Dripped(address indexed to, uint8 label, uint256 amount);
    event ConfigSet(uint256 cooldown, uint256[3] amountFor);

    error NotGovernance();
    error NothingForLabel(uint8 label);
    error TooSoon();
    error TransferFailed();

    constructor(LabelRegistry labels_, address governance_, uint256 cooldown_, uint256[3] memory amountFor_) {
        labels = labels_;
        governance = governance_;
        cooldown = cooldown_;
        amountFor = amountFor_;
        emit ConfigSet(cooldown_, amountFor_);
    }

    receive() external payable {}

    function setConfig(uint256 cooldown_, uint256[3] calldata amountFor_) external {
        if (msg.sender != governance) revert NotGovernance();
        cooldown = cooldown_;
        amountFor = amountFor_;
        emit ConfigSet(cooldown_, amountFor_);
    }

    function drip() external returns (uint256 amount) {
        uint8 label = labels.labelOf(msg.sender);
        amount = amountFor[label];
        if (amount == 0) revert NothingForLabel(label);
        if (lastDrip[msg.sender] != 0 && block.timestamp < lastDrip[msg.sender] + cooldown) revert TooSoon();
        lastDrip[msg.sender] = block.timestamp;
        if (label == 1) {
            (,, bytes32 cred,) = labels.humans(msg.sender);
            if (lastDripCredential[cred] != 0 && block.timestamp < lastDripCredential[cred] + cooldown) revert TooSoon();
            lastDripCredential[cred] = block.timestamp;
        }
        if (amount > address(this).balance) amount = address(this).balance;
        emit Dripped(msg.sender, label, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

/// @title LabelSwapGate: a DEX-side hook that reads labels
/// @notice A router or pool calls check(trader, amountIn) before a swap.
///         Each label has its own cap per hour on the input amount (0 = no
///         swaps for that label, type(uint256).max = no cap). The default
///         testnet setting: humans uncapped, registered agents capped (they
///         can be held to account), unlabelled accounts capped lower.
contract LabelSwapGate {
    ILabels public immutable labels;
    address public governance;
    uint256[3] public hourlyCap;
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public usedInWindow;
    mapping(address => bool) public isCaller; // routers / pools allowed to count volume

    event CapsSet(uint256[3] hourlyCap);
    event CallerSet(address caller, bool allowed);

    error NotGovernance();
    error NotCaller();
    error OverCap(uint8 label, uint256 cap);

    constructor(ILabels labels_, address governance_, uint256[3] memory hourlyCap_) {
        labels = labels_;
        governance = governance_;
        hourlyCap = hourlyCap_;
        emit CapsSet(hourlyCap_);
    }

    function setCaps(uint256[3] calldata caps) external {
        if (msg.sender != governance) revert NotGovernance();
        hourlyCap = caps;
        emit CapsSet(caps);
    }

    function setCaller(address c, bool allowed) external {
        if (msg.sender != governance) revert NotGovernance();
        isCaller[c] = allowed;
        emit CallerSet(c, allowed);
    }

    /// Counts amountIn against the trader's hourly cap for its label; reverts when over.
    function check(address trader, uint256 amountIn) external returns (uint8 label) {
        if (!isCaller[msg.sender]) revert NotCaller();
        label = labels.labelOf(trader);
        uint256 cap = hourlyCap[label];
        if (cap == type(uint256).max) return label;
        if (block.timestamp >= windowStart[trader] + 1 hours) {
            windowStart[trader] = block.timestamp;
            usedInWindow[trader] = 0;
        }
        uint256 used = usedInWindow[trader] + amountIn;
        if (used > cap) revert OverCap(label, cap);
        usedInWindow[trader] = used;
    }
}
