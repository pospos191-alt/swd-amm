// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZetaphyOutbox: an append-only Merkle commitment of outgoing messages (ZETAPHY side)
/// @notice Why a commitment contract: a CometBFT header commits to the state (app_hash, an IAVL
///         multistore root) but NOT to EVM logs (last_results_hash only covers code, data and gas
///         of each tx result, and receipts/blooms live in a transient store). So events cannot be
///         proven to Ethereum from a header. Instead every message is appended to a SHA-256 Merkle
///         tree (depth 32, the Ethereum deposit-contract construction) and the root is kept in
///         STORAGE SLOT 0. The slot is in the evm IAVL store under 0x02 || address || slot, so
///         app_hash -> multistore proof -> IAVL proof -> slot 0 -> Merkle path proves a message.
///
///         root  = sha256(treeRoot || uint256(count))
///         leaf  = sha256(abi.encode(LEAF_TAG, block.chainid, address(this), nonce, sender,
///                                   dstChainId, receiver, sha256(payload)))
///         The nonce is the leaf index (0, 1, 2, ...): replay protection on the other side is a
///         bitmap of consumed nonces. No owner, no upgrade, no way to remove a message.
///         Testnet prototype, not audited. See docs/future/trustless-bridge.md.
contract ZetaphyOutbox {
    bytes32 public root;              // slot 0: proven by ZetaphyBridgeInbox (never zero after the constructor)
    uint64 public count;              // slot 1
    bytes32[32] private branch;       // slots 2..33

    bytes32 public constant LEAF_TAG = keccak256("zetaphy/outbox/v1");
    uint256 public constant DEPTH = 32;

    event MessageSent(uint64 indexed nonce, address indexed sender, uint256 indexed dstChainId, address receiver, bytes payload, bytes32 leaf, bytes32 root);

    constructor() {
        root = _root();
    }

    function send(uint256 dstChainId, address receiver, bytes calldata payload) external returns (uint64 nonce) {
        nonce = count;
        require(nonce < type(uint32).max, "full");
        bytes32 leaf = leafHash(block.chainid, address(this), nonce, msg.sender, dstChainId, receiver, sha256(payload));
        uint256 size = uint256(nonce) + 1;
        bytes32 node = leaf;
        for (uint256 h = 0; h < DEPTH; h++) {
            if (size & 1 == 1) { branch[h] = node; break; }
            node = sha256(abi.encodePacked(branch[h], node));
            size >>= 1;
        }
        count = nonce + 1;
        bytes32 r = _root();
        root = r;
        emit MessageSent(nonce, msg.sender, dstChainId, receiver, payload, leaf, r);
    }

    function leafHash(uint256 srcChainId, address outbox, uint64 nonce, address sender, uint256 dstChainId, address receiver, bytes32 payloadHash)
        public pure returns (bytes32)
    {
        return sha256(abi.encode(LEAF_TAG, srcChainId, outbox, nonce, sender, dstChainId, receiver, payloadHash));
    }

    function _root() private view returns (bytes32) {
        bytes32 node;
        bytes32 zero;
        uint256 size = count;
        for (uint256 h = 0; h < DEPTH; h++) {
            node = size & 1 == 1 ? sha256(abi.encodePacked(branch[h], node)) : sha256(abi.encodePacked(node, zero));
            zero = sha256(abi.encodePacked(zero, zero));
            size >>= 1;
        }
        return sha256(abi.encodePacked(node, uint256(count)));
    }
}

interface IZetaphyOutbox {
    function send(uint256 dstChainId, address receiver, bytes calldata payload) external returns (uint64);
}

interface IERC20Lockable {
    function transferFrom(address from, address to, uint256 v) external returns (bool);
}

/// @title ZetaphyLockbox: locks a token on ZETAPHY and sends "release `amount` to `recipient`"
///        through the outbox to one fixed receiver on one fixed destination chain.
/// @notice The tokens stay here (the way back is a mirror of this bridge, not in this prototype).
///         Everything is fixed at deployment: no admin.
contract ZetaphyLockbox {
    IERC20Lockable public immutable token;
    IZetaphyOutbox public immutable outbox;
    uint256 public immutable dstChainId;
    address public immutable dstReceiver;

    event Locked(uint64 indexed nonce, address indexed from, address indexed recipient, uint256 amount);

    constructor(IERC20Lockable token_, IZetaphyOutbox outbox_, uint256 dstChainId_, address dstReceiver_) {
        token = token_;
        outbox = outbox_;
        dstChainId = dstChainId_;
        dstReceiver = dstReceiver_;
    }

    function lock(uint256 amount, address recipient) external returns (uint64 nonce) {
        require(amount > 0 && recipient != address(0), "lock");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        nonce = outbox.send(dstChainId, dstReceiver, abi.encode(recipient, amount));
        emit Locked(nonce, msg.sender, recipient, amount);
    }
}
