// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test stand-in for ZETAPHY's ML-DSA precompile (0x…0900), for the
/// in-memory EVM only. "Valid" means sig == keccak256(msg ++ pk); the real
/// precompile runs FIPS 204 and is exercised by test:devnet.
contract MockMLDSA {
    fallback(bytes calldata input) external returns (bytes memory) {
        uint8 variant = uint8(input[0]);
        if (variant != 44 && variant != 65) return "";
        uint256 pkLen = variant == 44 ? 1312 : 1952;
        if (input.length != 33 + pkLen + 32) return "";
        bytes calldata msg_ = input[1:33];
        bytes calldata pk = input[33:33 + pkLen];
        bytes32 sig = bytes32(input[33 + pkLen:]);
        if (sig != keccak256(abi.encodePacked(msg_, pk))) return "";
        return abi.encode(uint256(1));
    }
}
