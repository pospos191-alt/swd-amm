// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY (test/immune-vaccine.test.js, test/securityscore.test.js): a vault with a confirmed bug, its fixed
// version (same functions, so the same selectors), and an unrelated plain vault. Never deployed anywhere real.

/// The vulnerable one: withdrawAll pays before it zeroes the balance (re-entrancy), sweep has no access check.
contract LeakyVault {
    address public owner;
    uint256 public fee;
    mapping(address => uint256) public balances;

    constructor() { owner = msg.sender; }

    function deposit() external payable { balances[msg.sender] += msg.value; }

    function withdrawAll() external {
        uint256 a = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        balances[msg.sender] = 0;
    }

    function sweep(address payable to) external { to.transfer(address(this).balance); }

    function emergencyDrain(address payable to) external {
        require(msg.sender == owner, "owner");
        to.transfer(address(this).balance);
    }

    function setFee(uint256 f) external { fee = f; }
}

/// The fix: the same interface (so most selectors match: a suspect only), checks-effects-interactions, access checks.
contract LeakyVaultFixed {
    address public owner;
    uint256 public fee;
    mapping(address => uint256) public balances;
    bool private locked;

    constructor() { owner = msg.sender; }

    function deposit() external payable { balances[msg.sender] += msg.value; }

    function withdrawAll() external {
        require(!locked, "lock");
        locked = true;
        uint256 a = balances[msg.sender];
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        locked = false;
    }

    function sweep(address payable to) external {
        require(msg.sender == owner, "owner");
        to.transfer(address(this).balance - 0);
    }

    function emergencyDrain(address payable to) external {
        require(msg.sender == owner && to != address(0), "owner");
        to.transfer(address(this).balance);
    }

    function setFee(uint256 f) external {
        require(msg.sender == owner && f <= 1000, "fee");
        fee = f;
    }
}

/// Unrelated honest code: never matches.
contract PlainVault {
    mapping(address => uint256) public held;

    function put() external payable { held[msg.sender] += msg.value; }

    function take(uint256 a) external {
        held[msg.sender] -= a;
        payable(msg.sender).transfer(a);
    }
}
