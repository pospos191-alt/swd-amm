// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test stand-in for the chain's security precompile (0x…0901): qday() and migration(address),
/// with the same return shapes (zetaphy-chain evmd/zetaphy_secprecompile.go). Tests set the values.
contract MockSecurity {
    uint64 public h;
    mapping(address => bool) public migrated;
    function setQday(uint64 v) external { h = v; }
    function setMigrated(address a, bool v) external { migrated[a] = v; }
    function qday() external view returns (uint64 height, uint64 revealDelay, bool active) {
        return (h, 720, h != 0 && block.number >= h);
    }
    function migration(address a) external view
        returns (bool, address, address, uint64, bool)
    {
        return (migrated[a], migrated[a] ? address(0xC0FFEE) : address(0), address(0), 0, true);
    }
}
