// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only stand-ins for the identity/validation tests. They are placed with
// putCode (no constructor), so every setting starts at zero.

/// NeuroJobs' workers() view, with values the test sets.
contract MockRunners {
    struct W { uint128 bond; uint64 unbondAt; bool active; uint32 agreed; uint32 rejected; }
    mapping(address => W) public workers;
    function set(address who, bool active, uint32 agreed, uint32 rejected) external {
        workers[who] = W(100 ether, 0, active, agreed, rejected);
    }
}

/// A token-like contract with an owner(); it can also call the registry itself.
contract MockOwned {
    address public owner;
    function setOwner(address o) external { owner = o; }
    function claimSelf(address registry, uint256 agentId) external {
        (bool ok, bytes memory r) = registry.call(abi.encodeWithSignature("claim(uint256)", agentId));
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
}

/// An ERC-1271 wallet that accepts any signature once `ok` is set.
contract Mock1271 {
    bool public ok;
    function setOk(bool v) external { ok = v; }
    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        return ok ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
