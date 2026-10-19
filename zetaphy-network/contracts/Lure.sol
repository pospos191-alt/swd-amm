// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only: a contract that pokes a decoy on behalf of whoever calls it,
/// to check that the decoy marks this contract and not the person calling.
contract Lure {
    address public immutable decoy;
    constructor(address decoy_) { decoy = decoy_; }
    function claimAirdrop() external {
        (bool ok,) = decoy.call(abi.encodeWithSignature("mint(address,uint256)", msg.sender, 1));
        require(ok, "decoy call failed");
    }
}
