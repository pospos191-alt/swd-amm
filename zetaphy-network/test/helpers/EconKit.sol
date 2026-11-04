// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY stubs for EconomicBounds (test/economicbounds.test.js): the two external contracts it reads, so the
// test needs no full AuditNetwork / AuditCertificate deployment. Never deployed outside a local test chain.

/// AuditNetwork.core, enough for EconomicBounds (it reads only the sponsor).
contract StubNetwork {
    mapping(uint256 => address) public sponsorOf;
    function setSponsor(uint256 id, address s) external { sponsorOf[id] = s; }
    function core(uint256 id) external view returns (address sponsor, uint64 contestEnd, uint256 revealEnd, uint256 judgeEnd, bool naDeclared, bool settled) {
        return (sponsorOf[id], 0, 0, 0, false, true);
    }
}

/// AuditCertificate.certificate, with the same Cert layout EconomicBounds decodes.
contract StubCertificate {
    struct Cert {
        uint256 requestId; uint64 chainId; address target; bytes32 codeHash; bytes32 reportHash; bytes32 sourceHash;
        uint8 level; uint16 auditors; uint16 mutationBps; uint64 issuedAt; uint64 expiresAt; uint64 revokedAt;
    }
    mapping(bytes32 => Cert) internal _c;
    mapping(bytes32 => bool) internal _valid;
    function key(uint64 chainId, address target) public pure returns (bytes32) { return keccak256(abi.encode(chainId, target)); }
    function setCert(uint64 chainId, address target, uint256 requestId, bool valid) external {
        bytes32 k = key(chainId, target);
        _c[k] = Cert(requestId, chainId, target, bytes32(0), bytes32(0), bytes32(0), 1, 0, 0, 1, 2, 0);
        _valid[k] = valid;
    }
    function certificate(uint64 chainId, address target) external view returns (Cert memory c, bool valid) {
        bytes32 k = key(chainId, target);
        return (_c[k], _valid[k]);
    }
}
