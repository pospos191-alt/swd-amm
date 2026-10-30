// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "contracts/AuditVerified.sol";

/// A router that lists only audited code (test of contracts/AuditVerified.sol against the real NeuroOracle mirror).
contract AVRouter {
    using AuditVerified for IAVOracle;
    IAVOracle public immutable oracle;

    constructor(IAVOracle o) { oracle = o; }

    function verified(address t) external view returns (bool) { return oracle.isVerified(t); }
    function level(address t) external view returns (uint8) { return oracle.levelOf(t); }
    function list(address t) external view returns (bool) { oracle.requireCertified(t); return true; }
    function listGold(address t) external view returns (bool) { oracle.requireLevel(t, 3); return true; }
    function listProxy(address p, address reader, address impl) external view returns (bool) { oracle.requireCertifiedProxy(p, reader, impl); return true; }
    function codehashOf(address t) external view returns (bytes32) { return t.codehash; }
}

contract AVImplA { function version() external pure returns (uint256) { return 1; } }
contract AVImplB { function version() external pure returns (uint256) { return 2; } }

/// An upgradeable proxy that keeps its implementation in the EIP-1967 slot (what the hub / `zetaphy aas` read off-chain)
/// and also answers implementation() (what AuditVerified.requireCertifiedProxy reads on-chain). Forwards every call.
contract AVProxy {
    bytes32 private constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address immutable admin;
    constructor(address impl) { admin = msg.sender; _set(impl); }
    function implementation() public view returns (address a) { assembly { a := sload(SLOT) } }
    function upgradeTo(address impl) external { require(msg.sender == admin, "admin"); _set(impl); }
    function _set(address impl) private { assembly { sstore(SLOT, impl) } }
    fallback() external {
        address impl = implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
