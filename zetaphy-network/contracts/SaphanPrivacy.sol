// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPrivacyPoseidon {
    function poseidon(uint256[2] calldata x) external pure returns (uint256);
}

/// ZkIdentityVerifier (Groth16, the identity circuit zetaphy-network/zkid/circuits/identity.circom; DEV setup).
interface IPrivacyVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[5] calldata pub)
        external view returns (bool);
}

interface IPrivacyToken {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title SaphanPrivacyPool: optional private transfers of a bridged token, one fixed denomination per pool
/// @notice Saphan PR 6, item F (docs/SAPHAN-PR6.md). Testnet only, not audited. A REAL zero-knowledge proof, with a
///         DEV trusted setup: the Groth16 key of ZkIdentityVerifier was made by one party on one machine
///         (zetaphy-network/zkid/setup.js), who could forge proofs and drain every pool. Mainnet would need a public
///         multi-party phase-2 ceremony first.
///
///         It reuses the private-identity circuit unchanged (a Semaphore-style membership + nullifier proof):
///           deposit:  the depositor makes a note (secret, nullifierKey) offline and deposits its commitment
///                     C = Poseidon(secret, nullifierKey) with exactly `denomination` of `token` (e.g. 0.01 sepETH).
///                     The pool appends the leaf Poseidon(C, 1) to its own Poseidon Merkle tree (depth 20).
///           withdraw: later, from any address, a Groth16 proof that "some leaf of a root this pool had is
///                     Poseidon(Poseidon(secret, nullifierKey), level >= 1)", revealing only
///                     nullifier = Poseidon(nullifierKey, scope) (one withdrawal per note) and binding
///                     signal = keccak256(recipient, fee) >> 8 (a proof copied from the mempool cannot redirect the
///                     coins). The recipient gets denomination - fee, whoever submits gets fee (a relayer, so the
///                     recipient needs no gas and no link to the depositor).
///         Every pool has its own scope (from the chain id and its address), so a note's nullifier differs per pool.
///         What is hidden: which deposit a withdrawal spends (among all deposits of this pool). What is not: that an
///         address deposited, amounts (all equal), timing. The anonymity set is the pool's deposits: small on a testnet.
///         No owner, no fee of its own, no upgrade, no pause: it cannot be frozen or drained by anyone but note holders
///         (and the DEV key holder, see above).
contract SaphanPrivacyPool {
    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 20;
    uint256 public constant LEVEL = 1;

    IPrivacyPoseidon public immutable poseidon;
    IPrivacyVerifier public immutable verifier;
    IPrivacyToken public immutable token;
    uint256 public immutable denomination;
    uint256 public immutable scope;

    uint256 public root;
    uint256 public leafCount;
    mapping(uint256 => bool) public rootSeen;          // every root this pool ever had (the tree only grows)
    mapping(uint256 => bool) public nullifierUsed;
    mapping(uint256 => bool) public commitmentUsed;
    uint256[21] private zeros;
    uint256[20] private filled;                         // the left node last written at each height
    uint256 private unlocked = 1;

    event Deposit(uint256 indexed commitment, uint256 leaf, uint256 index, uint256 root);
    event Withdrawal(uint256 indexed nullifier, address indexed recipient, address relayer, uint256 fee);

    error BadCommitment();
    error TreeFull();
    error UnknownRoot();
    error Spent();
    error BadFee();
    error BadProof();
    error TokenFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(IPrivacyPoseidon poseidon_, IPrivacyVerifier verifier_, IPrivacyToken token_, uint256 denomination_) {
        require(address(poseidon_) != address(0) && address(verifier_) != address(0) && address(token_) != address(0) && denomination_ > 0, "config");
        poseidon = poseidon_;
        verifier = verifier_;
        token = token_;
        denomination = denomination_;
        scope = uint256(keccak256(abi.encode("saphan/privacy-pool/v1", block.chainid, address(this)))) >> 8;
        uint256 z = 0;
        for (uint256 h = 0; h <= DEPTH; h++) {
            zeros[h] = z;
            if (h < DEPTH) filled[h] = z;
            z = poseidon_.poseidon([z, z]);
        }
        root = zeros[DEPTH];
        rootSeen[root] = true;
    }

    /// The signal a withdrawal's proof must carry (as PrivateAirdrop's).
    function signalOf(address recipient, uint256 fee) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(recipient, fee))) >> 8;
    }

    function zeroAt(uint256 h) external view returns (uint256) { return zeros[h]; }

    /// Deposits one note: exactly `denomination` of the token (approve first).
    function deposit(uint256 commitment) external nonReentrant {
        if (commitment == 0 || commitment >= SNARK_FIELD || commitmentUsed[commitment]) revert BadCommitment();
        uint256 index = leafCount;
        if (index >= (1 << DEPTH)) revert TreeFull();
        commitmentUsed[commitment] = true;
        leafCount = index + 1;
        uint256 leaf = poseidon.poseidon([commitment, LEVEL]);
        uint256 node = leaf;
        uint256 i = index;
        for (uint256 h = 0; h < DEPTH; h++) {
            if (i & 1 == 0) {
                filled[h] = node;
                node = poseidon.poseidon([node, zeros[h]]);
            } else {
                node = poseidon.poseidon([filled[h], node]);
            }
            i >>= 1;
        }
        root = node;
        rootSeen[node] = true;
        emit Deposit(commitment, leaf, index, node);
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), denomination) || token.balanceOf(address(this)) - before != denomination) revert TokenFailed();
    }

    /// Withdraws one note to `recipient` (denomination - fee), paying `fee` to the caller.
    /// proof = [a0, a1, b00, b01, b10, b11, c0, c1] (zetaphy-hub/zkid-core.js proofWords).
    function withdraw(address recipient, uint256 fee, uint256 root_, uint256 nullifier, uint256[8] calldata proof) external nonReentrant {
        if (!rootSeen[root_]) revert UnknownRoot();
        if (nullifierUsed[nullifier]) revert Spent();
        if (fee > denomination || recipient == address(0)) revert BadFee();
        if (!verifier.verifyProof([proof[0], proof[1]], [[proof[2], proof[3]], [proof[4], proof[5]]], [proof[6], proof[7]],
            [root_, nullifier, scope, signalOf(recipient, fee), LEVEL])) revert BadProof();
        nullifierUsed[nullifier] = true;
        emit Withdrawal(nullifier, recipient, msg.sender, fee);
        if (!token.transfer(recipient, denomination - fee)) revert TokenFailed();
        if (fee != 0 && !token.transfer(msg.sender, fee)) revert TokenFailed();
    }
}
