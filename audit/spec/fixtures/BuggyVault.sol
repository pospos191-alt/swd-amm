// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BuggyVault: TEST ONLY, DELIBERATELY BROKEN. Never deploy, never send value to it.
/// @notice The demo target of audit/spec (docs/future/specs-and-proofs.md): an ETH vault with two
///         planted bugs, so the spec tool's drafted properties have something real to refute.
///           BUG 1 emergencyWithdraw pays the caller's balance and clears it, but forgets
///                 totalDeposits: afterwards the vault owes more than it holds (backing broken,
///                 and the total no longer moves with the balances).
///           BUG 2 withdraw pays before it updates the balance (a reentrancy hole: write after
///                 the external call).
///         Everything else is correct (access control, the counter, the pause), so the same run
///         also shows what a proof looks like. It lives outside every audited project (audit/
///         scope.json) and is compiled only by the spec tool's tests and demo.
contract BuggyVault {
    mapping(address => uint256) public balanceOf;
    uint256 public totalDeposits;
    uint256 public deposits;          // how many deposits ever (only grows)
    address public governance;
    bool public paused;

    constructor(address governance_) {
        require(governance_ != address(0), "governance");
        governance = governance_;
    }

    function deposit() external payable {
        require(!paused, "paused");
        require(msg.value > 0, "zero");
        balanceOf[msg.sender] += msg.value;
        totalDeposits += msg.value;
        deposits += 1;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        (bool ok, ) = msg.sender.call{value: amount}("");   // BUG 2: interaction before effects
        require(ok, "pay");
        balanceOf[msg.sender] -= amount;
        totalDeposits -= amount;
    }

    function emergencyWithdraw() external {
        uint256 amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;                           // BUG 1: totalDeposits is not reduced
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }

    function pause() external {
        require(msg.sender == governance, "governance");
        paused = true;
    }

    function unpause() external {
        require(msg.sender == governance, "governance");
        paused = false;
    }

    function setGovernance(address g) external {
        require(msg.sender == governance && g != address(0), "governance");
        governance = g;
    }
}
