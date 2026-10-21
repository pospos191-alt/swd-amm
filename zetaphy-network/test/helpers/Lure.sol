// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only (moved out of contracts/: it is not part of the deployed system).
/// A contract that calls a target on behalf of whoever calls it, to check that a
/// watched contract logs, and the bridge monitor marks, this contract (the direct
/// caller, msg.sender) and not the person who called it.
contract Lure {
    address public immutable target;
    constructor(address target_) { target = target_; }
    function claimAirdrop() external {
        (bool ok,) = target.call(abi.encodeWithSignature("mint(address,uint256)", msg.sender, 1));
        require(ok, "target call failed");
    }
}
