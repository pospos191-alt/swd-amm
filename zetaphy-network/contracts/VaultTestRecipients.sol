// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only recipients for RewardVault.

/// Refuses every payment.
contract RefusingRecipient {
    receive() external payable { revert("no"); }
}

interface IVault {
    function applyShares() external;
    function release() external returns (uint256);
}

/// Tries to re-enter the vault while being paid.
contract ReentrantRecipient {
    IVault public vault;
    uint256 public attempts;
    function setVault(address v) external { vault = IVault(v); }
    receive() external payable {
        attempts += 1;
        try vault.applyShares() {} catch {}
        try vault.release() {} catch {}
    }
}
