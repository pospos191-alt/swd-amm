// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// NeuroJobs' runner record, set by the test.
contract MockRunners {
    struct W { uint128 bond; uint64 unbondAt; bool active; uint32 agreed; uint32 rejected; }
    mapping(address => W) public workers;

    function set(address w, bool active, uint32 agreed, uint32 rejected) external {
        workers[w] = W(100 ether, 0, active, agreed, rejected);
    }
}

/// An ERC-8004 identity registry's ownerOf, set by the test.
contract MockIdentity {
    mapping(uint256 => address) public ownerOf;

    function set(uint256 id, address o) external {
        ownerOf[id] = o;
    }
}

/// A timelock that reports a delay (for UsefulIssuance's check) and forwards calls.
contract MockShortTimelock {
    uint256 public getMinDelay = 1 hours;
}
