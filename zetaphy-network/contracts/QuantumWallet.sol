// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title QuantumWallet: a smart wallet a quantum computer cannot drain (stage 5)
/// @notice Every action needs an ML-DSA signature (FIPS 204, post-quantum),
///         checked by ZETAPHY's precompile at 0x…0900. Two modes:
///           - hybrid: ECDSA AND ML-DSA must both sign (today's security, plus
///             protection if ECDSA is ever broken)
///           - post-quantum only: no ECDSA key at all (ecdsaOwner = 0)
///         Anyone may submit a signed action and pay its gas (a relay), so the
///         owner needs no other account. Keys rotate only through the wallet
///         itself, i.e. with the current keys' signatures.
contract QuantumWallet {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;

    address public ecdsaOwner;   // 0 = post-quantum only
    uint8 public variant;        // 44 or 65 (ML-DSA parameter set)
    bytes32 public pqKeyHash;    // keccak256 of the ML-DSA public key (the key itself rides in calldata)
    uint256 public nonce;

    /// The signatures for one action. pqPublicKey must hash to pqKeyHash;
    /// ecdsaSig is ignored in post-quantum-only mode.
    struct Auth {
        bytes pqPublicKey;
        bytes pqSig;
        bytes ecdsaSig;
    }

    event Executed(uint256 indexed nonce, address indexed to, uint256 value);
    event KeysChanged(address ecdsaOwner, uint8 variant, bytes32 pqKeyHash);

    error Expired();
    error BadEcdsa();
    error BadPq();
    error WrongKey();
    error BadVariant();
    error OnlySelf();
    error CallFailed(bytes reason);

    constructor(address ecdsaOwner_, uint8 variant_, bytes32 pqKeyHash_) payable {
        _setKeys(ecdsaOwner_, variant_, pqKeyHash_);
    }

    receive() external payable {}

    /// The 32 bytes both keys sign for one action.
    function digest(address to, uint256 value, bytes calldata data, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY QuantumWallet", block.chainid, address(this), nonce, to, value, keccak256(data), deadline));
    }

    function execute(address to, uint256 value, bytes calldata data, uint256 deadline, Auth calldata auth)
        external returns (bytes memory)
    {
        if (block.timestamp > deadline) revert Expired();
        _authorize(digest(to, value, data, deadline), auth);
        uint256 n = nonce++;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(n, to, value);
        return ret;
    }

    function _authorize(bytes32 d, Auth calldata auth) private view {
        if (ecdsaOwner != address(0) && _recover(d, auth.ecdsaSig) != ecdsaOwner) revert BadEcdsa();
        if (keccak256(auth.pqPublicKey) != pqKeyHash) revert WrongKey();
        if (!_pqValid(d, auth.pqPublicKey, auth.pqSig)) revert BadPq();
    }

    /// Rotate keys or switch mode; callable only by execute() on this wallet.
    function setKeys(address ecdsaOwner_, uint8 variant_, bytes32 pqKeyHash_) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _setKeys(ecdsaOwner_, variant_, pqKeyHash_);
    }

    function _setKeys(address ecdsaOwner_, uint8 variant_, bytes32 pqKeyHash_) private {
        if ((variant_ != 44 && variant_ != 65) || pqKeyHash_ == bytes32(0)) revert BadVariant();
        ecdsaOwner = ecdsaOwner_;
        variant = variant_;
        pqKeyHash = pqKeyHash_;
        emit KeysChanged(ecdsaOwner_, variant_, pqKeyHash_);
    }

    function _pqValid(bytes32 d, bytes calldata pk, bytes calldata sig) private view returns (bool) {
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(variant, d, pk, sig));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(d, v, r, s);
    }
}

/// @title QuantumWalletFactory: wallets at an address known before they exist
/// @notice The address depends only on the keys, so funds can be sent to a
///         wallet before it is deployed, and anyone can deploy it later.
contract QuantumWalletFactory {
    event Created(address indexed wallet, address ecdsaOwner, uint8 variant, bytes32 pqKeyHash);

    function create(address ecdsaOwner, uint8 variant, bytes32 pqKeyHash) external returns (address w) {
        w = address(new QuantumWallet{salt: _salt(ecdsaOwner, variant, pqKeyHash)}(ecdsaOwner, variant, pqKeyHash));
        emit Created(w, ecdsaOwner, variant, pqKeyHash);
    }

    function predict(address ecdsaOwner, uint8 variant, bytes32 pqKeyHash) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ecdsaOwner, variant, pqKeyHash),
            keccak256(abi.encodePacked(type(QuantumWallet).creationCode, abi.encode(ecdsaOwner, variant, pqKeyHash)))));
        return address(uint160(uint256(h)));
    }

    function _salt(address e, uint8 v, bytes32 k) private pure returns (bytes32) {
        return keccak256(abi.encode(e, v, k));
    }
}
