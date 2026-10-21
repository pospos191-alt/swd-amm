// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only stand-in for a contract the bridge monitor watches (BRIDGE_WATCHLIST).
/// Every call logs its direct caller (msg.sender) as the first indexed topic, the
/// monitor's default callerTopic 1. It holds nothing and changes nothing else.
contract WatchedEmitter {
    event Called(address indexed caller, bytes4 indexed selector);

    function mint(address, uint256) external { emit Called(msg.sender, msg.sig); }
    fallback() external { emit Called(msg.sender, msg.sig); }
}

/// The same, with the caller in the second indexed topic (callerTopic 2).
contract WatchedEmitterTopic2 {
    event Poked(bytes32 indexed tag, address indexed caller);

    fallback() external { emit Poked(keccak256("poke"), msg.sender); }
}
