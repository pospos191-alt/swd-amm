// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// StarkLightClient as the inbox reads it.
interface IZetaphyLightClient {
    /// The final app hash of ZETAPHY block `height` (reverts when unknown or the client is frozen).
    function appHashAt(uint64 height) external view returns (bytes32);
}

interface IERC20Release {
    function transfer(address to, uint256 v) external returns (bool);
}

/// @title ZetaphyBridgeInbox: releases tokens on Ethereum for messages proven from ZETAPHY's state
/// @notice No relayer or multisig is trusted for WHAT is released: a message is accepted only with
///         a chain of proofs, all checked here or in the light client:
///           1. app_hash of a final ZETAPHY header (StarkLightClient: STARK over the validator set);
///           2. the evm store's root in app_hash: Cosmos SDK multistore, ICS23 Tendermint-spec ops;
///           3. ZetaphyOutbox's storage slot 0 in the evm store: ICS23 IAVL-spec existence proof of
///              key 0x02 || outbox || 0x00..00 (cosmos/evm x/vm KeyPrefixStorage) with the 32-byte root;
///           4. the message leaf in the outbox tree (32 SHA-256 siblings) and the tree's count.
///         Then: the sender is ZETAPHY's lockbox, the destination is this chain and this contract,
///         and the nonce was never consumed (replay protection).
///         Circuit breaker in the style of BridgeGuard: a daily release limit; guardians pause and
///         lower the limit at once (they only reduce risk); governance unpauses and raises the limit,
///         at most x2 per step, each raise LIMIT_DELAY after it was proposed. Governance cannot
///         release anything: it can delay releases, never forge them. A release over the limit or
///         while paused reverts and can simply be retried later (anyone may submit it).
///         Testnet prototype, not audited. See docs/future/trustless-bridge.md.
contract ZetaphyBridgeInbox {
    struct InnerOp {
        bytes prefix;
        bytes suffix;
    }

    /// Proof that the outbox root is in ZETAPHY's state at a header's app_hash.
    struct StateProof {
        bytes32 outboxRoot;        // value of the outbox's slot 0
        bytes iavlLeafPrefix;      // zz(0) zz(1) zz(version)
        InnerOp[] iavlPath;        // evm store, leaf to root (IavlSpec)
        InnerOp[] storePath;       // multistore, evm store root to app hash (TendermintSpec)
    }

    struct Message {
        uint64 nonce;
        address sender;
        uint256 dstChainId;
        address receiver;
        bytes payload;             // abi.encode(recipient, amount)
    }

    bytes32 public constant LEAF_TAG = keccak256("zetaphy/outbox/v1");
    uint64 public constant LIMIT_DELAY = 7 days;

    IZetaphyLightClient public immutable lightClient;
    uint256 public immutable zetaphyChainId;  // ZETAPHY's EVM chain id (in every leaf)
    address public immutable zetaphyOutbox;
    address public immutable zetaphySender;   // the ZETAPHY lockbox allowed to release tokens here
    IERC20Release public immutable token;

    address public governance;
    mapping(address => bool) public guardian;
    bool public paused;
    uint256 public dailyLimit;
    uint256 public pendingLimit;
    uint64 public pendingAt;
    uint256 public releasedToday;
    uint64 public day;
    mapping(uint64 => bool) public consumed;

    event Released(uint64 indexed nonce, address indexed recipient, uint256 amount, uint64 height);
    event Paused(address by);
    event Unpaused();
    event LimitSet(uint256 limit);
    event LimitProposed(uint256 limit, uint64 at);
    event GuardianSet(address who, bool on);

    error AlreadyConsumed();
    error BadStateProof(uint256 step);
    error BadMessage();
    error BridgePaused();
    error OverLimit(uint256 left);
    error NotGovernance();
    error NotGuardian();
    error TooEarly();

    constructor(IZetaphyLightClient lc, uint256 zetaphyChainId_, address outbox, address sender, IERC20Release token_, address governance_, address guardian_, uint256 dailyLimit_) {
        lightClient = lc;
        zetaphyChainId = zetaphyChainId_;
        zetaphyOutbox = outbox;
        zetaphySender = sender;
        token = token_;
        governance = governance_;
        if (guardian_ != address(0)) { guardian[guardian_] = true; emit GuardianSet(guardian_, true); }
        dailyLimit = dailyLimit_;
        emit LimitSet(dailyLimit_);
    }

    // ------------------------------------------------------------------ release

    /// Anyone: release the tokens of message `m`, proven at ZETAPHY block `height` (whose app_hash is
    /// the state after block height - 1, so a lock in block h is provable with any final header > h).
    function release(uint64 height, StateProof calldata sp, Message calldata m, bytes32[32] calldata siblings, uint64 count) external {
        if (consumed[m.nonce]) revert AlreadyConsumed();
        if (m.sender != zetaphySender || m.dstChainId != block.chainid || m.receiver != address(this)) revert BadMessage();
        bytes32 app = lightClient.appHashAt(height);
        bytes32 evmRoot = iavlRoot(abi.encodePacked(uint8(2), zetaphyOutbox, bytes32(0)), sp.outboxRoot, sp.iavlLeafPrefix, sp.iavlPath);
        if (storeRoot("evm", evmRoot, sp.storePath) != app) revert BadStateProof(2);
        bytes32 leaf = sha256(abi.encode(LEAF_TAG, zetaphyChainId, zetaphyOutbox, m.nonce, m.sender, m.dstChainId, m.receiver, sha256(m.payload)));
        if (m.nonce >= count || outboxRoot(leaf, m.nonce, siblings, count) != sp.outboxRoot) revert BadStateProof(4);
        consumed[m.nonce] = true;
        (address recipient, uint256 amount) = abi.decode(m.payload, (address, uint256));
        _spend(amount);
        require(token.transfer(recipient, amount), "transfer");
        emit Released(m.nonce, recipient, amount, height);
    }

    function _spend(uint256 amount) private {
        if (paused) revert BridgePaused();
        uint64 today = uint64(block.timestamp / 1 days);
        if (day != today) { day = today; releasedToday = 0; }
        uint256 used = releasedToday;
        if (used + amount > dailyLimit) revert OverLimit(dailyLimit > used ? dailyLimit - used : 0);
        releasedToday = used + amount;
    }

    // ------------------------------------------------------------------ proofs (pure, reusable)

    /// The outbox root for a leaf at `index` with its 32 siblings and the tree's count.
    function outboxRoot(bytes32 leaf, uint64 index, bytes32[32] calldata sib, uint64 count) public pure returns (bytes32) {
        bytes32 node = leaf;
        for (uint256 h = 0; h < 32; h++) {
            node = (index >> h) & 1 == 1 ? sha256(abi.encodePacked(sib[h], node)) : sha256(abi.encodePacked(node, sib[h]));
        }
        return sha256(abi.encodePacked(node, uint256(count)));
    }

    /// ICS23 IavlSpec existence proof: the IAVL root for (key, 32-byte value). Leaf and inner
    /// prefixes are checked as ics23 does (validateIavlOps, InnerSpec lengths, no leaf prefix on an
    /// inner node), so an inner node can never be passed off as a leaf or the other way round.
    function iavlRoot(bytes memory key, bytes32 value, bytes calldata leafPrefix, InnerOp[] calldata path) public pure returns (bytes32 h) {
        _checkLeafPrefix(leafPrefix);
        h = sha256(abi.encodePacked(leafPrefix, _uvarint(key.length), key, uint8(32), sha256(abi.encodePacked(value))));
        for (uint256 i = 0; i < path.length; i++) {
            _checkInner(path[i].prefix, path[i].suffix, i + 1);
            h = sha256(abi.encodePacked(path[i].prefix, h, path[i].suffix));
        }
    }

    /// zz(height 0) zz(size 1) zz(version >= 0), nothing else.
    function _checkLeafPrefix(bytes calldata lp) private pure {
        (uint256 hgt, uint256 p) = _varint(lp, 0);
        uint256 size;
        (size, p) = _varint(lp, p);
        uint256 ver;
        (ver, p) = _varint(lp, p);
        if (hgt != 0 || size != 2 || ver & 1 == 1 || p != lp.length) revert BadStateProof(3);
    }

    /// zz(height >= level) zz(size) zz(version), then 0x20 (left child; suffix 0x20 || right) or
    /// 0x20 || left || 0x20 (right child; no suffix).
    function _checkInner(bytes calldata pre, bytes calldata suf, uint256 level) private pure {
        (uint256 hgt, uint256 p) = _varint(pre, 0);
        uint256 x;
        (x, p) = _varint(pre, p); // size
        if (hgt & 1 == 1 || hgt / 2 < level || x & 1 == 1 || pre[0] == 0x00) revert BadStateProof(3);
        (x, p) = _varint(pre, p); // version
        if (x & 1 == 1) revert BadStateProof(3);
        uint256 rest = pre.length - p;
        bool left = rest == 1 && pre[p] == 0x20 && suf.length == 33 && suf[0] == 0x20;
        bool right = rest == 34 && pre[p] == 0x20 && pre[p + 33] == 0x20 && suf.length == 0;
        if (!left && !right) revert BadStateProof(3);
    }

    /// ICS23 TendermintSpec ops (Cosmos SDK multistore): the app hash for (store name, store root).
    function storeRoot(bytes memory name, bytes32 root, InnerOp[] calldata path) public pure returns (bytes32 h) {
        h = sha256(abi.encodePacked(uint8(0), _uvarint(name.length), name, uint8(32), sha256(abi.encodePacked(root))));
        for (uint256 i = 0; i < path.length; i++) {
            bytes calldata pre = path[i].prefix;
            bytes calldata suf = path[i].suffix;
            bool ok = pre.length > 0 && pre[0] == 0x01 && ((pre.length == 1 && suf.length == 32) || (pre.length == 33 && suf.length == 0));
            if (!ok) revert BadStateProof(2);
            h = sha256(abi.encodePacked(pre, h, suf));
        }
    }

    function _varint(bytes calldata b, uint256 p) private pure returns (uint256 v, uint256 q) {
        uint256 shift;
        for (q = p; q < b.length && q < p + 10; q++) {
            uint8 x = uint8(b[q]);
            v |= uint256(x & 0x7f) << shift;
            shift += 7;
            if (x & 0x80 == 0) return (v, q + 1);
        }
        revert BadStateProof(3);
    }

    function _uvarint(uint256 n) private pure returns (bytes memory out) {
        if (n < 0x80) return abi.encodePacked(uint8(n));
        return abi.encodePacked(uint8(n & 0x7f) | 0x80, uint8(n >> 7)); // keys and names < 16384 bytes
    }

    // ------------------------------------------------------------------ circuit breaker

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function _guard() private view {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
    }

    function pause() external {
        _guard();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyGov {
        paused = false;
        emit Unpaused();
    }

    /// Guardians or governance: lower the daily limit at once (and drop a pending raise).
    function lowerLimit(uint256 v) external {
        _guard();
        require(v < dailyLimit, "not lower");
        dailyLimit = v;
        pendingAt = 0;
        emit LimitSet(v);
    }

    /// Governance: propose a raise (at most x2 of the current limit), applied LIMIT_DELAY later by anyone.
    function proposeLimit(uint256 v) external onlyGov {
        require(v > dailyLimit && v <= 2 * dailyLimit + 1, "step");
        pendingLimit = v;
        pendingAt = uint64(block.timestamp) + LIMIT_DELAY;
        emit LimitProposed(v, pendingAt);
    }

    function applyLimit() external {
        if (pendingAt == 0 || block.timestamp < pendingAt) revert TooEarly();
        dailyLimit = pendingLimit;
        pendingAt = 0;
        emit LimitSet(dailyLimit);
    }

    function setGuardian(address who, bool on) external onlyGov {
        guardian[who] = on;
        emit GuardianSet(who, on);
    }

    function setGovernance(address g) external onlyGov {
        governance = g;
    }
}
