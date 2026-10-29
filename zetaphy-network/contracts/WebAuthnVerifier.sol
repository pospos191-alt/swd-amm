// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WebAuthnVerifier: checks a passkey (WebAuthn) assertion on chain
/// @notice Stateless helper shared by LabelRegistry (human labels) and
///         AgentPolicyWallet (emergency freeze by the owner's passkey).
///         The P-256 (secp256r1) signature is checked by the precompile at
///         0x…0100 that cosmos/evm ships (RIP-7212 interface: input
///         hash ‖ r ‖ s ‖ x ‖ y, output 32 bytes = 1 when valid, empty
///         otherwise). ZETAPHY's genesis enables it (active_static_precompiles
///         in zetaphy-chain/setup-node.sh).
///
///         What is checked, as a relying party would (WebAuthn §7.2):
///           - clientDataJSON has "type":"webauthn.get" and
///             "challenge":"<base64url of the 32-byte challenge>";
///           - authenticatorData starts with rpIdHash (sha256 of the site's
///             host name; 0 = any site) and has the user-present flag, and
///             the user-verified flag when requireUV;
///           - the signature is over sha256(authenticatorData ‖ sha256(clientDataJSON)).
///         Not checked: the origin inside clientDataJSON (rpIdHash already
///         binds the site), the signature counter (passkeys that sync keep it
///         at 0), and attestation (who made the authenticator).
contract WebAuthnVerifier {
    address public constant P256 = 0x0000000000000000000000000000000000000100;

    bytes1 private constant FLAG_UP = 0x01;
    bytes1 private constant FLAG_UV = 0x04;

    /// A passkey's answer to navigator.credentials.get(): the authenticator
    /// data, the client data JSON and the signature as (r, s).
    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    /// True when `a` is a valid assertion of the passkey (x, y) over `challenge`.
    function verify(bytes32 challenge, Assertion calldata a, uint256 x, uint256 y, bytes32 rpIdHash, bool requireUV)
        external view returns (bool)
    {
        if (!_flagsOk(a.authenticatorData, rpIdHash, requireUV)) return false;
        if (!_contains(a.clientDataJSON, bytes('"type":"webauthn.get"'))) return false;
        if (!_contains(a.clientDataJSON, abi.encodePacked('"challenge":"', base64url(challenge), '"'))) return false;
        bytes32 h = sha256(abi.encodePacked(a.authenticatorData, sha256(a.clientDataJSON)));
        (bool ok, bytes memory ret) = P256.staticcall(abi.encode(h, a.r, a.s, x, y));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _flagsOk(bytes calldata authData, bytes32 rpIdHash, bool requireUV) private pure returns (bool) {
        if (authData.length < 37) return false;
        if (rpIdHash != bytes32(0) && bytes32(authData[0:32]) != rpIdHash) return false;
        bytes1 flags = authData[32];
        if (flags & FLAG_UP == 0) return false;
        if (requireUV && flags & FLAG_UV == 0) return false;
        return true;
    }

    /// base64url without padding of 32 bytes (43 characters), as WebAuthn
    /// writes the challenge in clientDataJSON.
    function base64url(bytes32 data) public pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory out = new bytes(43);
        uint256 v = uint256(data);
        // 32 bytes = 256 bits = 42 full 6-bit groups + 4 bits (padded with 2 zero bits)
        for (uint256 i = 0; i < 42; i++) {
            out[i] = table[(v >> (250 - 6 * i)) & 63];
        }
        out[42] = table[(v & 15) << 2];
        return string(out);
    }

    function _contains(bytes calldata hay, bytes memory needle) private pure returns (bool) {
        uint256 n = needle.length;
        if (hay.length < n) return false;
        bytes32 nh = keccak256(needle);
        for (uint256 i = 0; i + n <= hay.length; i++) {
            if (hay[i] == needle[0] && keccak256(hay[i:i + n]) == nh) return true;
        }
        return false;
    }
}
