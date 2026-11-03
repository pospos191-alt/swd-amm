// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan, proven releases: ZETAPHY -> source chain without trusting any validator
/// @notice Two contracts (docs/SAPHAN-PROOFS.md), testnet only, not audited:
///
///         ZETAPHY       SaphanProvableOutbox(X) sits in front of the route's HyperlaneOutbox (same send / quoteSend):
///                       it takes the tokens, has the outbox burn them and send the usual Hyperlane release, AND writes
///                       the very same release body into ZetaphyOutbox (the Merkle outbox whose root lives in ZETAPHY's
///                       state). The Gateway and wallets use it instead of the outbox.
///         source X      SaphanReleaseVerifier checks a release body against ZETAPHY's state: the ZetaphyOutbox root at
///                       a ZETAPHY block that StarkLightClient finalized (a STARK proof of > 2/3 of ZETAPHY's validators,
///                       ML-DSA-44 votes counted by its pq modes), the IAVL / multistore path to that block's app_hash,
///                       and the leaf's Merkle path. Then HyperlaneLockBoxV2.queueProven(body) queues it exactly as a
///                       Hyperlane message would (same id: whichever path comes first; the other is a replay).
///
///         With the lockbox's requireProof on (governance), the Hyperlane path no longer releases anything: outbound
///         money then moves on math alone (hash-based STARK, ML-DSA finality), no ECDSA signer anywhere in the way.

interface IProofOutbox {
    function send(address to, uint256 amount) external payable returns (bytes32);
    function quoteSend(address to, uint256 amount) external view returns (uint256);
    function body(uint256 n, address sender, address to, uint256 amount) external view returns (bytes memory);
    function nonce() external view returns (uint256);
    function destinationChainId() external view returns (uint256);
    function recipient() external view returns (bytes32);
}

interface IMerkleOutbox {
    function send(uint256 dstChainId, address receiver, bytes calldata payload) external returns (uint64);
}

interface IProofToken {
    function transferFrom(address from, address to, uint256 v) external returns (bool);
}

contract SaphanProvableOutbox {
    IProofOutbox public immutable outbox;        // the route's HyperlaneOutbox
    IMerkleOutbox public immutable merkleOutbox; // ZetaphyOutbox (provable from ZETAPHY's state)
    IProofToken public immutable token;          // token(X)
    address public immutable lockbox;            // HyperlaneLockBoxV2 on X (the receiver in every leaf)
    uint256 public immutable destinationChainId;

    event ProvableSent(uint256 indexed outboxNonce, uint64 indexed merkleNonce, address indexed from, address to, uint256 amount, bytes32 bodyHash);

    error PayFailed();

    constructor(IProofOutbox outbox_, IMerkleOutbox merkleOutbox_, IProofToken token_) {
        outbox = outbox_;
        merkleOutbox = merkleOutbox_;
        token = token_;
        lockbox = address(uint160(uint256(outbox_.recipient())));
        destinationChainId = outbox_.destinationChainId();
    }

    function quoteSend(address to, uint256 amount) external view returns (uint256) { return outbox.quoteSend(to, amount); }

    /// Like HyperlaneOutbox.send (approve this contract for `amount` of token(X) first). msg.value: exactly the
    /// Mailbox fee (quoteSend).
    function send(address to, uint256 amount) external payable returns (bytes32 messageId) {
        uint256 n = outbox.nonce();
        bytes memory b = outbox.body(n, address(this), to, amount); // the body the outbox is about to send
        uint64 m = merkleOutbox.send(destinationChainId, lockbox, b);
        emit ProvableSent(n, m, msg.sender, to, amount, keccak256(b));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert PayFailed();
        messageId = outbox.send{value: msg.value}(to, amount);  // burns this contract's tokens; the same nonce n (the outbox
                                                                 // refuses a short fee and would send any extra back here)
    }
}


interface IProofLightClient {
    function appHashAt(uint64 height) external view returns (bytes32);
}

/// The pure proof functions of ZetaphyBridgeInbox (any deployed instance: they read no state).
interface IZetaphyProofs {
    struct InnerOp { bytes prefix; bytes suffix; }
    function outboxRoot(bytes32 leaf, uint64 index, bytes32[32] calldata sib, uint64 count) external pure returns (bytes32);
    function iavlRoot(bytes memory key, bytes32 value, bytes calldata leafPrefix, InnerOp[] calldata path) external pure returns (bytes32);
    function storeRoot(bytes memory name, bytes32 root, InnerOp[] calldata path) external pure returns (bytes32);
}

interface IProvenLockbox {
    function queueProven(bytes calldata body) external;
}

/// @title SaphanReleaseVerifier: on the source chain X, a release proven from ZETAPHY's state (see above)
contract SaphanReleaseVerifier {
    struct StateProof {
        bytes32 outboxRoot;                  // ZetaphyOutbox's slot 0 at that block
        bytes iavlLeafPrefix;
        IZetaphyProofs.InnerOp[] iavlPath;   // evm store, leaf to root
        IZetaphyProofs.InnerOp[] storePath;  // multistore, evm store root to app hash
    }

    bytes32 public constant LEAF_TAG = keccak256("zetaphy/outbox/v1");
    IProofLightClient public immutable lightClient;  // StarkLightClient: ZETAPHY finality on this chain
    IZetaphyProofs public immutable proofs;
    uint256 public immutable zetaphyChainId;
    address public immutable merkleOutbox;            // ZetaphyOutbox on ZETAPHY
    address public immutable provableSender;          // SaphanProvableOutbox(X) on ZETAPHY: the only sender it accepts
    IProvenLockbox public immutable lockbox;          // HyperlaneLockBoxV2 here

    event Proven(uint64 indexed merkleNonce, uint64 height, bytes32 bodyHash);

    error BadStateProof(uint256 step);
    error BadMessage();

    constructor(IProofLightClient lc, IZetaphyProofs proofs_, uint256 zetaphyChainId_, address merkleOutbox_, address provableSender_, IProvenLockbox lockbox_) {
        require(address(lc) != address(0) && address(proofs_) != address(0) && merkleOutbox_ != address(0) && provableSender_ != address(0)
            && address(lockbox_) != address(0), "config");
        lightClient = lc;
        proofs = proofs_;
        zetaphyChainId = zetaphyChainId_;
        merkleOutbox = merkleOutbox_;
        provableSender = provableSender_;
        lockbox = lockbox_;
    }

    /// Anyone: proves the release `body` (the leaf `nonce` of ZetaphyOutbox, sent by the provable outbox to this lockbox)
    /// at ZETAPHY block `height`, then queues it in the lockbox (each body once there).
    function prove(uint64 height, StateProof calldata sp, uint64 nonce, bytes calldata body, bytes32[32] calldata siblings, uint64 count) external {
        if (body.length != 256) revert BadMessage();
        bytes32 app = lightClient.appHashAt(height);
        if (app == bytes32(0)) revert BadStateProof(0);
        bytes32 evmRoot = proofs.iavlRoot(abi.encodePacked(uint8(2), merkleOutbox, bytes32(0)), sp.outboxRoot, sp.iavlLeafPrefix, sp.iavlPath);
        if (proofs.storeRoot("evm", evmRoot, sp.storePath) != app) revert BadStateProof(2);
        bytes32 leaf = sha256(abi.encode(LEAF_TAG, zetaphyChainId, merkleOutbox, nonce, provableSender, block.chainid, address(lockbox), sha256(body)));
        if (nonce >= count || proofs.outboxRoot(leaf, nonce, siblings, count) != sp.outboxRoot) revert BadStateProof(4);
        emit Proven(nonce, height, keccak256(body));
        lockbox.queueProven(body);
    }
}
