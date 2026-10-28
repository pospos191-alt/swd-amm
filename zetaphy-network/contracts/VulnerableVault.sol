// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title VulnerableVault: a DELIBERATELY VULNERABLE contract for the bug-hunting prototype
/// @notice TEST ONLY. Never deploy it with anything of value. It is the target of the first
///         BugBounty on the testnet (zetaphy-hub/bounties/vulnerable-vault.json), so that the
///         browser fuzzer, the commit-reveal of findings and the runners' verification can be
///         shown end to end on a bug that really exists.
///
///         The bug: `initialize()` was meant to run once, from the deployment script, but the
///         deployment never calls it and it has no access control. Whoever calls it first
///         becomes the owner and can `sweep` every depositor's money.
contract VulnerableVault {
    address public owner;
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    /// BUG (deliberate): anyone may call this while no owner is set.
    function initialize() external {
        require(owner == address(0), "done");
        owner = msg.sender;
    }

    function sweep(address to) external {
        require(msg.sender == owner, "owner");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "send");
    }
}
