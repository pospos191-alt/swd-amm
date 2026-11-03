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

/// Test-only light client: app hashes set by hand (StarkLightClient's own proofs are tested in starkbridge.test.js).
contract KitLightClient {
    mapping(uint64 => bytes32) public appHashAt;
    function set(uint64 h, bytes32 a) external { appHashAt[h] = a; }
}

/// Test-only SPV client: a block is "included" when set by hand; returns the txid like BtcLightClient
/// (its real proofs of work and Merkle branches are tested in btclc.test.js on mainnet blocks).
contract KitBtcClient {
    mapping(bytes32 => bool) public known;
    function setKnown(bytes32 b) external { known[b] = true; }
    function verifyTx(bytes calldata rawTx, bytes32 blockHash, uint256, bytes32[] calldata, uint256) external view returns (bytes32) {
        require(known[blockHash], "unknown block");
        return sha256(abi.encodePacked(sha256(rawTx)));
    }
}
