// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SignalBoard: browsers find each other on the ZETAPHY chain itself (testnet)
/// @notice A public notice board for WebRTC signaling, so two browsers that hold
///         (or want) the same model can connect with no server of ours and no
///         third-party tracker: a browser posts a short-lived message under a
///         topic (e.g. sha256 of "zetaphy-signal/1|chunks|<manifest hash>"), others
///         read the board with eth_getLogs, and the offer/answer go to one
///         recipient, ENCRYPTED to that recipient's key and signed by the sender
///         (zetaphy-neuro/ai/browser/signal.js). The contract never reads the
///         payload: it only bounds it.
///
///         Nothing is stored but a rate counter: messages live in event logs.
///         "Expiry" is a field readers enforce (block time + at most MAX_TTL); the
///         log itself stays on chain forever, so payloads must be encrypted or
///         harmless (an announce reveals a session key, a topic and a time).
///
///         Limits: payload 1..MAX_PAYLOAD bytes; expiresAt in (now, now + MAX_TTL];
///         each sender at most MAX_PER_WINDOW posts per WINDOW seconds. A sender
///         address costs nothing to make, so the rate limit only bounds one key;
///         what bounds a flood is gas (testnet coins come from the faucet, which
///         is rate-limited per internet address) and readers' own caps.
///
///         No owner, no funds, no upgrade, nothing to govern.
contract SignalBoard {
    uint256 public constant MAX_PAYLOAD = 2048;
    uint256 public constant MAX_TTL = 600;
    uint256 public constant WINDOW = 60;
    uint256 public constant MAX_PER_WINDOW = 12;

    struct Rate {
        uint64 windowStart;
        uint32 count;
    }

    mapping(address => Rate) public rate;

    /// @param topic what the message is about (readers filter on it)
    /// @param to recipient's peer id (16 bytes, left-aligned) or 0 for everyone on the topic
    event Signal(bytes32 indexed topic, bytes32 indexed to, address indexed from, uint64 expiresAt, bytes payload);

    error NoTopic();
    error PayloadSize();
    error BadExpiry();
    error RateLimited();

    function post(bytes32 topic, bytes32 to, uint64 expiresAt, bytes calldata payload) external {
        if (topic == bytes32(0)) revert NoTopic();
        if (payload.length == 0 || payload.length > MAX_PAYLOAD) revert PayloadSize();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_TTL) revert BadExpiry();
        Rate memory r = rate[msg.sender];
        if (block.timestamp >= uint256(r.windowStart) + WINDOW) {
            r.windowStart = uint64(block.timestamp);
            r.count = 0;
        }
        if (r.count >= MAX_PER_WINDOW) revert RateLimited();
        r.count += 1;
        rate[msg.sender] = r;
        emit Signal(topic, to, msg.sender, expiresAt, payload);
    }

    /// @notice Posts left for `who` in the current window.
    function remaining(address who) external view returns (uint256) {
        Rate memory r = rate[who];
        if (block.timestamp >= uint256(r.windowStart) + WINDOW) return MAX_PER_WINDOW;
        return MAX_PER_WINDOW - r.count;
    }
}
