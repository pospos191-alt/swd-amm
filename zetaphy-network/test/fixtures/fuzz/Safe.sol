// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Safe fuzz fixtures (TEST ONLY): the fixed versions of the vulnerable ones. The fuzzer must not
// report anything on them (no false positives).

contract SafeBank {
    mapping(address => uint256) public balances;
    bool private locked;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        require(!locked, "locked");
        locked = true;
        uint256 a = balances[msg.sender];
        require(a > 0, "empty");
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        locked = false;
    }
}

contract SafeVault {
    address public owner;
    mapping(address => uint256) public balances;

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    function execute(address to, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory r) = to.delegatecall(data);
        require(ok, "call");
        return r;
    }

    function shutdown(address payable to) external {
        require(msg.sender == owner, "owner");
        selfdestruct(to);
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "owner");
        owner = next;
    }
}

contract SafeToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() {
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        allowance[f][msg.sender] = a - v;
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}
