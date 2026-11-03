// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only Neuro runner registry (NeuroJobs.workers' first five fields), set per address (test/saphansafety.test.js).
contract KitRunners {
    struct W { uint128 bond; uint64 unbondAt; bool active; uint32 agreed; uint32 rejected; }
    mapping(address => W) public w;
    function set(address who, bool active, uint32 agreed, uint32 rejected) external { w[who] = W(1, 0, active, agreed, rejected); }
    function workers(address who) external view returns (uint128, uint64, bool, uint32, uint32) {
        W memory x = w[who];
        return (x.bond, x.unbondAt, x.active, x.agreed, x.rejected);
    }
}
