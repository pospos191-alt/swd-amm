// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// StarkVerifier's interface (contracts/StarkVerifier.sol; same structs).
interface IStarkLCVerifier {
    struct Pin {
        bytes32 root;
        uint8 logN;
        uint8 logBlowup;
    }

    struct Result {
        uint8 kind;
        uint64 height;
        bytes32 hash;
        uint8 nextLogN;
        uint8 nextLogBlowup;
        uint256 S;
        uint256 T;
        uint256 U;
        uint256 C;
        uint8 mode;
        uint256 revealed;
        uint256 revealsOffset;
        bytes32 revealsHash;
        bytes message;
        bool ok;
        bool pqMajority;
    }

    function verify(bytes calldata proof, Pin calldata pin, bytes calldata chainId, uint256 minSigBits, uint256 minStarkBits)
        external view returns (Result memory);
}

/// @title StarkLightClient: ZETAPHY finality on Ethereum from STARK light-client proofs (prototype)
/// @notice Holds ZETAPHY's validator set by its 32-byte set root, starting from a pinned genesis set,
///         and accepts:
///           - block proofs: "block H with hash X was signed by more than the chain's threshold of
///             the current set" (3S > 2T - 3U), plus the header's app_hash (state root) proven
///             against X (CometBFT header Merkle tree, field 10 of 14);
///           - handoff proofs: "the current set (more than 2/3 of ALL its power) signed the root of
///             the next epoch's set".
///         The STARK (validator-set accounting) is verified completely on chain by StarkVerifier at
///         submission. ML-DSA-44 signature validity is NOT proven by the Stage A STARK; it is covered:
///           - `submitChecked`: every revealed signature (modes all/sample) is verified now by the
///             ML-DSA verifier contract `mldsa`, and the claim is final at once (no trust; costs one
///             ML-DSA verification per revealed signer, millions of gas each in Solidity today);
///           - `submit` (optimistic): the claim waits `challengeWindow`; anyone who shows that one
///             revealed signature does not verify (`challenge`, a single non-interactive check)
///             rejects the claim and takes the submitter's bond. Trust: one honest watcher and
///             Ethereum liveness during the window;
///           - mode `none` (no reveals): only `trustedProver` may post it, and it is trusted for ML-DSA
///             validity (stated, not hidden). trustedProver = 0 disables mode none.
///         Two different final hashes for one height (or two set roots for one epoch) prove that more
///         than 1/3 of the stake equivocated: the client freezes (no app hash is served any more).
///         No admin: every parameter is fixed at deployment.
///         Testnet prototype, not audited. See docs/future/trustless-bridge.md.
contract StarkLightClient {
    enum Status { None, Pending, Final, Rejected }

    struct Claim {
        uint8 kind;          // 0 block, 1 handoff
        Status status;
        uint8 mode;          // 0 none, 1 sample, 2 all
        uint8 nextLogN;
        uint8 nextLogBlowup;
        uint64 epoch;        // the set the proof was checked against
        uint64 height;       // block height, or the next epoch (handoff)
        uint64 submittedAt;
        address submitter;
        uint256 bond;
        bytes32 hash;        // block hash, or the next set root
        bytes32 appHash;     // blocks: the header's app_hash
        bytes32 revealsHash; // keccak256(G0, K0, G1, K1, ...) of the revealed rows
        bytes32 messageHash; // keccak256 of the message validators signed
    }

    IStarkLCVerifier public immutable verifier;
    /// ML-DSA-44 verifier: staticcall(pk[1312] || sig[2420] || message) returns uint256(1) when valid.
    address public immutable mldsa;
    uint64 public immutable challengeWindow;
    uint256 public immutable bond;
    uint256 public immutable minSigBits;
    uint256 public immutable minStarkBits;
    address public immutable trustedProver;
    bytes public chainId;

    uint64 public epoch;
    bytes32 public setRoot;
    uint8 public setLogN;
    uint8 public setLogBlowup;
    bool public frozen;

    Claim[] private claims;
    mapping(uint64 => bytes32) public finalBlockHash;
    mapping(uint64 => bytes32) public finalAppHash;
    mapping(uint64 => bytes32) public epochRoot;

    event Submitted(uint256 indexed id, uint8 kind, uint64 height, bytes32 hash, uint8 mode, uint256 revealed);
    event Challenged(uint256 indexed id, uint256 reveal, address challenger);
    event Finalized(uint256 indexed id, uint8 kind, uint64 height, bytes32 hash);
    event EpochAdvanced(uint64 epoch, bytes32 root);
    event Equivocation(uint256 indexed id, uint64 height, bytes32 known, bytes32 other);

    error Frozen();
    error WrongBond();
    error RuleFails();
    error WrongEpoch();
    error NoMajority();
    error BadAppHash();
    error ModeNotAllowed();
    error NotPending();
    error WindowOpen();
    error WindowClosed();
    error BadDispute();
    error SignatureValid();
    error SignatureInvalid(uint256 reveal);
    error Unknown();

    constructor(
        IStarkLCVerifier verifier_,
        address mldsa_,
        bytes memory chainId_,
        bytes32 genesisRoot,
        uint8 genesisLogN,
        uint8 genesisLogBlowup,
        uint64 challengeWindow_,
        uint256 bond_,
        uint256 minSigBits_,
        uint256 minStarkBits_,
        address trustedProver_
    ) {
        require(minStarkBits_ >= 80 && minSigBits_ >= 80 && challengeWindow_ > 0, "params");
        verifier = verifier_;
        mldsa = mldsa_;
        chainId = chainId_;
        setRoot = genesisRoot;
        setLogN = genesisLogN;
        setLogBlowup = genesisLogBlowup;
        epochRoot[0] = genesisRoot;
        challengeWindow = challengeWindow_;
        bond = bond_;
        minSigBits = minSigBits_;
        minStarkBits = minStarkBits_;
        trustedProver = trustedProver_;
    }

    // ------------------------------------------------------------------ submitting

    /// Optimistic: the STARK is checked now; signatures can be disputed for `challengeWindow`.
    /// `appHash` and its 4 header aunts are needed for block proofs (ignored for handoffs).
    function submit(bytes calldata proof, bytes32 appHash, bytes32[4] calldata aunts) external payable returns (uint256 id) {
        if (msg.value != bond) revert WrongBond();
        IStarkLCVerifier.Result memory r = _check(proof, appHash, aunts);
        id = _store(r, appHash, Status.Pending);
    }

    /// Final at once: every revealed ML-DSA-44 signature is verified now (modes all / sample).
    function submitChecked(bytes calldata proof, bytes32 appHash, bytes32[4] calldata aunts) external returns (uint256 id) {
        IStarkLCVerifier.Result memory r = _check(proof, appHash, aunts);
        if (r.mode == 0) revert ModeNotAllowed();
        uint256 off = r.revealsOffset;
        for (uint256 j = 0; j < r.revealed; j++) {
            uint256 sig = off + j * 3960 + 228;
            if (!_mldsaValid(proof[sig + 2420:sig + 2420 + 1312], proof[sig:sig + 2420], r.message)) revert SignatureInvalid(j);
        }
        id = _store(r, appHash, Status.Final);
        _apply(id);
    }

    function _check(bytes calldata proof, bytes32 appHash, bytes32[4] calldata aunts) private view returns (IStarkLCVerifier.Result memory r) {
        if (frozen) revert Frozen();
        bool trusted = trustedProver != address(0) && msg.sender == trustedProver;
        r = verifier.verify(proof, IStarkLCVerifier.Pin(setRoot, setLogN, setLogBlowup), chainId, trusted ? 0 : minSigBits, minStarkBits);
        if (r.mode == 0 && !trusted) revert ModeNotAllowed();
        if (r.kind == 0) {
            if (!r.ok) revert RuleFails();
            if (appHashRoot(appHash, aunts) != r.hash) revert BadAppHash();
        } else {
            if (r.height != epoch + 1) revert WrongEpoch();
            if (!r.pqMajority) revert NoMajority();
        }
    }

    function _store(IStarkLCVerifier.Result memory r, bytes32 appHash, Status status) private returns (uint256 id) {
        id = claims.length;
        claims.push(Claim({
            kind: r.kind, status: status, mode: r.mode, nextLogN: r.nextLogN, nextLogBlowup: r.nextLogBlowup,
            epoch: epoch, height: r.height, submittedAt: uint64(block.timestamp), submitter: msg.sender,
            bond: status == Status.Pending ? msg.value : 0, hash: r.hash, appHash: r.kind == 0 ? appHash : bytes32(0),
            revealsHash: r.revealsHash, messageHash: keccak256(r.message)
        }));
        emit Submitted(id, r.kind, r.height, r.hash, r.mode, r.revealed);
    }

    // ------------------------------------------------------------------ disputes and finality

    /// Anyone, during the window: reveal j of claim `id` is not a valid ML-DSA-44 signature.
    /// digests: (G, K) of every revealed row, as in the proof (their keccak is the claim's revealsHash);
    /// sig and pk: the revealed signature and key (from the submission's calldata); message: what was signed.
    function challenge(uint256 id, uint256 j, bytes32[] calldata digests, bytes calldata sig, bytes calldata pk, bytes calldata message) external {
        Claim storage c = claims[id];
        if (c.status != Status.Pending) revert NotPending();
        if (block.timestamp >= c.submittedAt + challengeWindow) revert WindowClosed();
        if (keccak256(abi.encodePacked(digests)) != c.revealsHash || 2 * j + 1 >= digests.length) revert BadDispute();
        if (keccak256(message) != c.messageHash || sig.length != 2420 || pk.length != 1312) revert BadDispute();
        if (_digest31("zetaphy/starklc/sig\x00", sig) != uint256(digests[2 * j]) || _digest31("zetaphy/starklc/pk\x00", pk) != uint256(digests[2 * j + 1])) revert BadDispute();
        if (_mldsaValid(pk, sig, message)) revert SignatureValid();
        c.status = Status.Rejected;
        uint256 b = c.bond;
        c.bond = 0;
        emit Challenged(id, j, msg.sender);
        if (b > 0) {
            (bool ok, ) = msg.sender.call{ value: b }("");
            require(ok, "bond");
        }
    }

    /// Anyone, after the window: the claim becomes final (and the bond goes back).
    function finalize(uint256 id) external {
        Claim storage c = claims[id];
        if (c.status != Status.Pending) revert NotPending();
        if (block.timestamp < c.submittedAt + challengeWindow) revert WindowOpen();
        c.status = Status.Final;
        _apply(id);
        uint256 b = c.bond;
        c.bond = 0;
        if (b > 0) {
            (bool ok, ) = c.submitter.call{ value: b }("");
            require(ok, "bond");
        }
    }

    function _apply(uint256 id) private {
        Claim storage c = claims[id];
        if (c.kind == 0) {
            bytes32 known = finalBlockHash[c.height];
            if (known != bytes32(0) && known != c.hash) { frozen = true; emit Equivocation(id, c.height, known, c.hash); return; }
            finalBlockHash[c.height] = c.hash;
            finalAppHash[c.height] = c.appHash;
        } else {
            bytes32 known = epochRoot[c.height];
            if (known != bytes32(0)) {
                if (known != c.hash) { frozen = true; emit Equivocation(id, c.height, known, c.hash); }
                return;
            }
            if (c.epoch != epoch || c.height != epoch + 1) revert WrongEpoch();
            epoch = c.height;
            setRoot = c.hash;
            setLogN = c.nextLogN;
            setLogBlowup = c.nextLogBlowup;
            epochRoot[c.height] = c.hash;
            emit EpochAdvanced(c.height, c.hash);
        }
        emit Finalized(id, c.kind, c.height, c.hash);
    }

    // ------------------------------------------------------------------ reading

    /// The final app hash of ZETAPHY block `height` (the state after block height - 1).
    function appHashAt(uint64 height) external view returns (bytes32 h) {
        if (frozen) revert Frozen();
        h = finalAppHash[height];
        if (h == bytes32(0)) revert Unknown();
    }

    function getClaim(uint256 id) external view returns (Claim memory) {
        return claims[id];
    }

    function claimCount() external view returns (uint256) {
        return claims.length;
    }

    /// CometBFT header hash from app_hash (field 10 of 14) and its aunts (bottom-up): the
    /// leaf is the protobuf BytesValue 0x0a 0x20 || app_hash, then 4 levels of the simple tree.
    function appHashRoot(bytes32 app, bytes32[4] calldata a) public pure returns (bytes32 h) {
        h = sha256(abi.encodePacked(uint8(0), uint8(0x0a), uint8(0x20), app));
        h = sha256(abi.encodePacked(uint8(1), h, a[0]));
        h = sha256(abi.encodePacked(uint8(1), a[1], h));
        h = sha256(abi.encodePacked(uint8(1), h, a[2]));
        h = sha256(abi.encodePacked(uint8(1), a[3], h));
    }

    function _mldsaValid(bytes memory pk, bytes memory sig, bytes memory message) private view returns (bool) {
        if (mldsa == address(0)) return false;
        (bool ok, bytes memory ret) = mldsa.staticcall(abi.encodePacked(pk, sig, message));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function _digest31(bytes memory tag, bytes calldata b) private pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(tag, b))) >> 8;
    }
}
