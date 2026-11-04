// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only fixtures for the node-level invariant firewall (evmd/zetaphy_firewall.go,
// zetaphy_firewall_test.go). ChainVault is DELIBERATELY VULNERABLE: `withdrawBuggy` pays without
// checking or booking anything. Never deploy any of it outside a test chain.
//
// ChainVault does NOT use Firewalled (no contract-layer `enforce`): only the node's check after
// every EVM transaction protects it, which is the point of the chain layer.
//
// Built with solc 0.8.26, optimizer 200 runs, evmVersion cancun (zetaphy-network's settings) into
// testdata/firewall/<Contract>.bin (creation code, hex) together with InvariantFirewall.sol
// (zetaphy-network/contracts, SS1). See zetaphy_firewall_test.go for how to rebuild them.

interface IFwRegistry {
    function register(address protocolGovernance) external;
}

contract ChainVault {
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    constructor(IFwRegistry fw, address protocolGovernance) {
        fw.register(protocolGovernance); // the protocol opts in itself
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }

    /// Correct: books first, then pay.
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        totalDeposits -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    /// BUG (deliberate): pays anyone anything, no check, no books.
    function withdrawBuggy(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    /// Donations (no books).
    receive() external payable {}
}

interface IFwBooks {
    function totalDeposits() external view returns (uint256);
}

/// Solvency: the vault holds at least what it owes its depositors.
contract SolvencyInvariant {
    function holds(address protocol) external view returns (bool) {
        return protocol.balance >= IFwBooks(protocol).totalDeposits();
    }
}

/// A checker whose answer the test sets: 0 holds, 1 false, 2 reverts, 3 burns all its gas,
/// 4 returns 64 bytes, 5 returns 2 (not a bool), 6 returns nothing, 7 holds only with more than
/// 100,000 gas (a check that passes with a big cap and fails with a small one).
contract ModeInvariant {
    uint8 public mode;

    function set(uint8 m) external {
        mode = m;
    }

    function holds(address) external view returns (bool) {
        uint8 m = mode;
        if (m == 1) return false;
        if (m == 2) revert("broken");
        if (m == 3) {
            uint256 x;
            while (true) x++;
        }
        if (m == 4) assembly { mstore(0, 1) mstore(32, 1) return(0, 64) }
        if (m == 5) assembly { mstore(0, 2) return(0, 32) }
        if (m == 6) assembly { return(0, 0) }
        if (m == 7) {
            uint256 x;
            while (gasleft() > 100_000) x++;
            return x > 0;
        }
        return true;
    }
}
