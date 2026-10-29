// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FuzzHook: the bug hunter's own contract (zetaphy-hub/fuzz-core.js), never deployed on a chain
/// @notice The fuzzer deploys it from the attacker inside its in-memory EVM, so a call sequence can act
///         through a contract: `go` makes a call (with value) from the hook, and `arm` sets up a
///         callback: when the target sends the hook coins (or calls it), the hook calls the target
///         again with `data`, up to `times` times. That is how reentrancy is tried. The coins the hook
///         holds count as the attacker's.
contract FuzzHook {
    address private immutable owner;
    address private target;
    bytes private data;
    uint256 private value;
    uint256 private left;

    constructor() payable {
        owner = msg.sender;
    }

    function arm(address t, bytes calldata d, uint256 v, uint256 times) external {
        require(msg.sender == owner, "owner");
        target = t;
        data = d;
        value = v;
        left = times;
    }

    function go(address t, bytes calldata d, uint256 v) external payable returns (bytes memory) {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory r) = t.call{value: v}(d);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
        return r;
    }

    receive() external payable {
        _hook();
    }

    fallback() external payable {
        _hook();
    }

    function _hook() private {
        if (left > 0 && msg.sender == target) {
            left--;
            (bool ok, ) = target.call{value: value}(data);
            ok;
        }
    }
}
