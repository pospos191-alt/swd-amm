// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only fixtures for the self-healing prototype (src/selfheal/, test/selfheal*.test.js).
// HealVault is DELIBERATELY VULNERABLE (withdrawAll pays before it zeroes the balance: a textbook
// reentrancy) and opted in to CircuitBreaker through CircuitBreakable. Never deploy any of it
// outside a local test chain.

import {CircuitBreakable, ICircuitBreaker} from "../../contracts/CircuitBreakable.sol";

contract HealVault is CircuitBreakable {
    address public immutable owner;
    mapping(address => uint256) public balances;

    event Deposited(address indexed from, uint256 amount);
    /// one per payment out (or held): what the off-chain detectors read
    event Withdrawn(address indexed to, uint256 amount, bool paid);
    event WithdrawnAll(address indexed to, uint256 amount, bool paid);

    constructor(ICircuitBreaker breaker) CircuitBreakable(breaker) {
        owner = msg.sender;
    }

    /// Opt in: the owner (standing in for the protocol's governance) has the vault call
    /// CircuitBreaker.register(policy) itself.
    function optIn(bytes calldata registerCall) external {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory ret) = address(circuitBreaker).call(registerCall);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    function deposit() external payable whenNotTripped(this.deposit.selector) {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// Correct: balance first, then pay.
    function withdraw(uint256 amount) external whenNotTripped(this.withdraw.selector) {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        bool pay = _outflow(address(0), msg.sender, amount);
        emit Withdrawn(msg.sender, amount, pay);
        if (pay) _payOut(address(0), msg.sender, amount);
    }

    /// BUG (deliberate): pays before zeroing the balance.
    function withdrawAll() external whenNotTripped(this.withdrawAll.selector) {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "empty");
        bool pay = _outflow(address(0), msg.sender, amount);
        emit WithdrawnAll(msg.sender, amount, pay);
        if (pay) _payOut(address(0), msg.sender, amount);
        balances[msg.sender] = 0;
    }

    function _payOut(address, address to, uint256 amount) internal override {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send");
    }
}

/// Re-enters withdrawAll `depth` times per attack() (one attack per block in the demo).
contract HealAttacker {
    HealVault public immutable vault;
    address public immutable owner;
    uint256 public left;

    constructor(HealVault v) {
        vault = v;
        owner = msg.sender;
    }

    function attack(uint256 depth) external payable {
        require(msg.sender == owner, "owner");
        left = depth;
        vault.deposit{value: msg.value}();
        vault.withdrawAll();
        left = 0;
    }

    receive() external payable {
        if (left > 0 && address(vault).balance >= msg.value) {
            left -= 1;
            vault.withdrawAll();
        }
    }

    function loot() external {
        require(msg.sender == owner, "owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "send");
    }
}

/// A benign smart-contract wallet: deposits and withdraws normal amounts (no reentrancy).
contract HealSmartWallet {
    HealVault public immutable vault;
    constructor(HealVault v) { vault = v; }
    function save() external payable { vault.deposit{value: msg.value}(); }
    function take(uint256 amount) external { vault.withdraw(amount); }
    receive() external payable {}
}

/// A price feed whose updates the oracle-deviation detector reads.
contract HealFeed {
    event Price(address indexed asset, uint256 price);
    function post(address asset, uint256 price) external { emit Price(asset, price); }
}
