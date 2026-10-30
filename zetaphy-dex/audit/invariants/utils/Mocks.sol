// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Plain ERC-20 for the audit suites (optional transfer hook to attempt re-entrancy).
interface ITokenHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
}

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hook;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setHook(address h) external { hook = h; }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[f][msg.sender] = a - v;
        }
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) private {
        if (hook != address(0)) ITokenHook(hook).onTokenTransfer(f, to, v);
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[to] += v;
    }
}
