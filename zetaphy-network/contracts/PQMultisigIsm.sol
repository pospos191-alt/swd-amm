// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PQMultisigIsm: a Hyperlane security module whose validators sign with ML-DSA (testnet)
/// @notice Hyperlane's message-id multisig ISM trusts `threshold` ECDSA validator signatures, which a quantum
///         computer could forge from the validators' public keys. This ISM checks the same checkpoint
///         (origin, origin merkle tree hook, root, index, message id) signed with ML-DSA-44 instead, verified by
///         ZETAPHY's precompile at 0x…0900. It only works on a chain that verifies ML-DSA (ZETAPHY); for a
///         destination without it (Ethereum, BNB) see the STARK-wrapped route in
///         docs/future/quantum-safe-settlement.md. During a transition, put it next to the ECDSA ISM in a
///         Hyperlane aggregation ISM (both must pass).
///
///         metadata = merkleTreeHook (32) ‖ root (32) ‖ index (4) ‖ n × [validator index (1) ‖ public key (1312) ‖ signature (2420)]
///         with strictly increasing validator indexes (each validator counts once); the first `threshold` entries count.
///         Validators are stored as keccak256(public key); the keys ride in the metadata.
///         A Hyperlane relayer needs this metadata builder (src/qsafe/pqism.js), so moduleType() is UNUSED (0).
contract PQMultisigIsm {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant SIG_BYTES = 2420;
    uint256 public constant ENTRY = 1 + PK_BYTES + SIG_BYTES;
    uint256 public constant MAX_VALIDATORS = 32;

    address public governance;   // a timelock / multisig
    bytes32[] private validators;
    uint8 public threshold;

    event ValidatorsSet(bytes32[] validators, uint8 threshold);
    event GovernanceSet(address governance);

    error OnlyGovernance();
    error BadSet();

    constructor(address governance_, bytes32[] memory validators_, uint8 threshold_) {
        if (governance_ == address(0)) revert BadSet();
        governance = governance_;
        _set(validators_, threshold_);
    }

    function moduleType() external pure returns (uint8) { return 0; }

    function validatorsAndThreshold(bytes calldata) external view returns (bytes32[] memory, uint8) {
        return (validators, threshold);
    }

    function setValidators(bytes32[] calldata v, uint8 t) external {
        if (msg.sender != governance) revert OnlyGovernance();
        _set(v, t);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert OnlyGovernance();
        if (g == address(0)) revert BadSet();
        governance = g;
        emit GovernanceSet(g);
    }

    function _set(bytes32[] memory v, uint8 t) private {
        if (t == 0 || t > v.length || v.length > MAX_VALIDATORS) revert BadSet();
        for (uint256 i = 0; i < v.length; ++i) {
            if (v[i] == bytes32(0)) revert BadSet();
            for (uint256 j = 0; j < i; ++j) if (v[j] == v[i]) revert BadSet();
        }
        validators = v;
        threshold = t;
        emit ValidatorsSet(v, t);
    }

    /// The 32 bytes each validator signs with ML-DSA: Hyperlane's checkpoint, domain-separated for this ISM.
    function digest(bytes calldata metadata, bytes calldata message) public pure returns (bytes32) {
        bytes32 domainHash = keccak256(abi.encodePacked(uint32(bytes4(message[5:9])), bytes32(metadata[0:32]), "HYPERLANE"));
        bytes32 checkpoint = keccak256(abi.encodePacked(domainHash, bytes32(metadata[32:64]), uint32(bytes4(metadata[64:68])), keccak256(message)));
        return keccak256(abi.encodePacked("ZETAPHY PQ checkpoint v1", checkpoint));
    }

    function verify(bytes calldata metadata, bytes calldata message) external view returns (bool) {
        uint8 t = threshold;
        require(message.length >= 77, "PQISM: message");
        require(metadata.length >= 68 && (metadata.length - 68) % ENTRY == 0, "PQISM: metadata length");
        require((metadata.length - 68) / ENTRY >= t, "PQISM: below threshold");
        bytes32 d = digest(metadata, message);
        uint256 last = type(uint256).max;
        for (uint256 i = 0; i < t; ++i) {
            uint256 vi = _entry(metadata, 68 + i * ENTRY, d);
            require(last == type(uint256).max || vi > last, "PQISM: validator order");
            last = vi;
        }
        return true;
    }

    /// One validator entry at offset `o`: its index, after checking the key and the ML-DSA signature.
    function _entry(bytes calldata metadata, uint256 o, bytes32 d) private view returns (uint256 vi) {
        vi = uint8(metadata[o]);
        require(vi < validators.length, "PQISM: unknown validator");
        bytes calldata pk = metadata[o + 1:o + 1 + PK_BYTES];
        require(keccak256(pk) == validators[vi], "PQISM: wrong key");
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), d, pk, metadata[o + 1 + PK_BYTES:o + ENTRY]));
        require(ok && ret.length == 32 && uint256(bytes32(ret)) == 1, "PQISM: bad signature");
    }
}
