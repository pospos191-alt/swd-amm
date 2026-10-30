// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: answers itemOf for any key as a fresh critical flag, so ImmuneBroadcaster's gas can be measured
// for any number of keys and routes without running a NeuroJobs agreement per key (test/immune.test.js).
struct FakeItem {
    bytes32 key; uint32 round; bool flagged; uint8 keyType; uint64 chainId; bytes32 subject;
    uint8 kind; uint8 severity; uint64 since; uint64 expiresAt; bytes32 evidenceHash; bytes32 vaccine;
}

contract FakeImmuneRegistry {
    function itemOf(bytes32 key) external view returns (FakeItem memory it) {
        it = FakeItem(key, 1, true, 2, 0, bytes32(uint256(uint160(uint256(key)))), 2, 4, uint64(block.timestamp), uint64(block.timestamp + 1 days), key, bytes32(0));
    }
}
