// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The Web3 immune system on every other EVM chain (docs/future/immune-network.md): the mirror of ZETAPHY's
// ImmuneRegistry, written only by ZETAPHY's ImmuneBroadcaster through Hyperlane (a message-id multisig ISM of OUR
// validators for origin ZETAPHY, as NeuroOracle and the Saphan routes). It answers IImmuneFeed (ImmuneGuard.sol):
// routers, vaults and bridges add ImmuneGuard's notFlagged(to); wallets call isFlagged; circuit breakers watch
// ThreatFlag / CodeThreatFlag or poll isFlagged and decide for themselves.

interface IIMIsm {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

/// One key as mirrored (ImmuneRegistry.sol ImmuneItem; the same ABI layout).
struct MirrorItem {
    bytes32 key;
    uint32 round;
    bool flagged;
    uint8 keyType;         // 1 an account on chainId, 2 an EVM address on every chain, 3 code
    uint64 chainId;
    bytes32 subject;
    uint8 kind;
    uint8 severity;
    uint64 since;
    uint64 expiresAt;
    bytes32 evidenceHash;
    bytes32 vaccine;
}

/// @title ImmuneMirror: ZETAPHY's immune flags on this chain
/// @notice A key keeps the newest state by round (out-of-order or replayed deliveries change nothing). While paused
///         (a guardian pauses; governance unpauses) handle reverts, so messages wait at the Mailbox, every view
///         answers "not flagged" and live() is false: consumers choose fail-open or fail-closed (ImmuneGuard).
///         Flags end at their expiresAt here too, even if no lift message arrives.
contract ImmuneMirror {
    struct Entry {
        uint32 round;
        bool flagged;
        uint8 keyType;
        uint8 kind;
        uint8 severity;
        uint64 since;
        uint64 expiresAt;
        uint64 mirroredAt;
        bytes32 evidenceHash;
        bytes32 vaccine;
    }

    uint8 public constant KIND_IMMUNE = 4;
    address public immutable mailbox;
    uint32 public immutable zetaphyDomain;
    uint256 public immutable zetaphyChainId;
    bytes32 public immutable remoteSender;    // ImmuneBroadcaster on ZETAPHY
    IIMIsm public interchainSecurityModule;
    address public governance;
    mapping(address => bool) public guardian;
    bool public paused;

    mapping(bytes32 => Entry) public entries;
    bytes32[] public keys;
    uint256 public flaggedNow;
    uint256 public messages;
    uint64 public lastUpdate;

    event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event AccountThreatFlag(uint256 indexed chainId, bytes32 indexed account, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event Stale(bytes32 indexed key, uint32 round, uint32 have);
    event Paused(address by);
    event Unpaused();
    event IsmSet(address ism);
    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);

    error NotMailbox();
    error WrongOrigin(uint32 origin);
    error WrongSender(bytes32 sender);
    error WrongSource();
    error BadKind(uint8 kind);
    error IsPaused();
    error NoValue();
    error NotGovernance();
    error NotGuardian();

    constructor(address mailbox_, uint32 zetaphyDomain_, uint256 zetaphyChainId_, bytes32 remoteSender_, IIMIsm ism_, address governance_, address guardian_) {
        require(mailbox_ != address(0) && remoteSender_ != bytes32(0) && address(ism_) != address(0) && governance_ != address(0) && zetaphyChainId_ != 0, "zero");
        mailbox = mailbox_;
        zetaphyDomain = zetaphyDomain_;
        zetaphyChainId = zetaphyChainId_;
        remoteSender = remoteSender_;
        interchainSecurityModule = ism_;
        governance = governance_;
        if (guardian_ != address(0)) { guardian[guardian_] = true; emit GuardianSet(guardian_, true); }
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setIsm(IIMIsm ism) external onlyGov { require(address(ism) != address(0), "zero"); interchainSecurityModule = ism; emit IsmSet(address(ism)); }
    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }
    function setGuardian(address who, bool on) external onlyGov { guardian[who] = on; emit GuardianSet(who, on); }
    function pause() external { if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian(); paused = true; emit Paused(msg.sender); }
    function unpause() external onlyGov { paused = false; emit Unpaused(); }

    // ---------------------------------------------------------------- Hyperlane

    function handle(uint32 origin, bytes32 sender, bytes calldata b) external payable {
        if (msg.sender != mailbox) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (paused) revert IsPaused();
        if (origin != zetaphyDomain) revert WrongOrigin(origin);
        if (sender != remoteSender) revert WrongSender(sender);
        (uint8 kind, uint256 src) = abi.decode(b[:64], (uint8, uint256));
        if (src != zetaphyChainId) revert WrongSource();
        if (kind != KIND_IMMUNE) revert BadKind(kind);
        ( , , MirrorItem[] memory items) = abi.decode(b, (uint8, uint256, MirrorItem[]));
        messages += 1;
        lastUpdate = uint64(block.timestamp);
        for (uint256 i = 0; i < items.length; ++i) _apply(items[i]);
    }

    function _apply(MirrorItem memory it) private {
        Entry storage m = entries[it.key];
        if (it.round <= m.round) { emit Stale(it.key, it.round, m.round); return; }
        if (m.round == 0) keys.push(it.key);
        if (it.flagged && !m.flagged) flaggedNow += 1;
        else if (!it.flagged && m.flagged) flaggedNow -= 1;
        entries[it.key] = Entry(it.round, it.flagged, it.keyType, it.kind, it.severity, it.since, it.expiresAt, uint64(block.timestamp), it.evidenceHash, it.vaccine);
        if (it.keyType == 3) emit CodeThreatFlag(it.subject, it.flagged, it.severity, it.since, it.evidenceHash);
        else if (uint256(it.subject) >> 160 == 0) emit ThreatFlag(it.chainId, address(uint160(uint256(it.subject))), it.flagged, it.severity, it.since, it.evidenceHash);
        else emit AccountThreatFlag(it.chainId, it.subject, it.flagged, it.severity, it.since, it.evidenceHash);
    }

    // ---------------------------------------------------------------- keys (ThreatRegistry's derivations)

    function codeKey(bytes32 codeHash) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.code", codeHash)); }
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.address", chainId, who)); }
    function accountKey(uint256 chainId, bytes32 account) public pure returns (bytes32) {
        if (uint256(account) >> 160 == 0) return addressKey(chainId, address(uint160(uint256(account))));
        return keccak256(abi.encode("zetaphy.threat.account", chainId, account));
    }

    // ---------------------------------------------------------------- IImmuneFeed

    function _view(bytes32 key) private view returns (bool, uint8, uint64, bytes32) {
        Entry storage m = entries[key];
        if (paused || !m.flagged || block.timestamp >= m.expiresAt) return (false, 0, 0, bytes32(0));
        return (true, m.severity, m.since, m.evidenceHash);
    }

    function isFlagged(uint256 chainId, address subject) public view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash) {
        (flagged, severity, since, evidenceHash) = _view(addressKey(chainId, subject));
        (bool f2, uint8 s2, uint64 t2, bytes32 e2) = _view(addressKey(0, subject));
        if (f2 && (!flagged || s2 > severity)) (flagged, severity, since, evidenceHash) = (f2, s2, t2, e2);
    }

    function isAccountFlagged(uint256 chainId, bytes32 account) external view returns (bool, uint8, uint64, bytes32) { return _view(accountKey(chainId, account)); }
    function isCodeFlagged(bytes32 codeHash) public view returns (bool, uint8, uint64, bytes32) {
        if (codeHash == bytes32(0) || codeHash == keccak256("")) return (false, 0, 0, bytes32(0));
        return _view(codeKey(codeHash));
    }
    function live() external view returns (bool) { return !paused && lastUpdate != 0; }

    /// What a router or a DEX asks about an address on THIS chain: its address (here and every EVM chain) or its code.
    function check(address who) external view returns (bool flagged, uint8 severity, bytes32 evidenceHash) {
        (flagged, severity, , evidenceHash) = isFlagged(block.chainid, who);
        (bool f2, uint8 s2, , bytes32 e2) = isCodeFlagged(who.codehash);
        if (f2 && (!flagged || s2 > severity)) (flagged, severity, evidenceHash) = (true, s2, e2);
    }

    function keyCount() external view returns (uint256) { return keys.length; }

    /// The mirrored round of each key (0: never): the coverage meter compares them with ZETAPHY's.
    function roundsOf(bytes32[] calldata ks) external view returns (uint32[] memory out) {
        out = new uint32[](ks.length);
        for (uint256 i = 0; i < ks.length; ++i) out[i] = entries[ks[i]].round;
    }

    /// The vaccine hash shipped with a key's flag (sentinels on this chain fetch the vaccine by it from the feed).
    function vaccineOf(bytes32 key) external view returns (bytes32) { return entries[key].vaccine; }
}
