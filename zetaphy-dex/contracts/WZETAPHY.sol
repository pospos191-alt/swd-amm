// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WZETAPHY: wrapped native coin, one token per wei (a classic WETH, written from scratch).
/// @notice On ZETAPHY itself the DEX uses the native ERC-20 precompile
///         0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE instead (Cosmos EVM's WERC20,
///         whose balances ARE the native balances). This contract is for the
///         unit tests (an EVM without that precompile) and for other EVM chains:
///         `cli.js deploy --wnative deploy` deploys it.
contract WZETAPHY {
    string public constant name = "Wrapped ZETAPHY";
    string public constant symbol = "WZTPHY";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error SendFailed();

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        if (balanceOf[msg.sender] < value) revert InsufficientBalance();
        unchecked { balanceOf[msg.sender] -= value; }
        emit Withdrawal(msg.sender, value);
        (bool ok,) = msg.sender.call{value: value}("");
        if (!ok) revert SendFailed();
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return transferFrom(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        if (balanceOf[from] < value) revert InsufficientBalance();
        if (from != msg.sender) {
            uint256 a = allowance[from][msg.sender];
            if (a != type(uint256).max) {
                if (a < value) revert InsufficientAllowance();
                unchecked { allowance[from][msg.sender] = a - value; }
            }
        }
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
