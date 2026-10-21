// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title TestToken: a plain ERC-20 for the ZETAPHY testnet DEX (no value, testnet only).
/// @notice The deployer gets the initial supply and may mint more (a test faucet).
///         Optional `feeBps`: a cut of every transfer is burned (fee-on-transfer
///         token, to test the router's *SupportingFeeOnTransferTokens functions).
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint16 public immutable feeBps;
    address public immutable minter;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error NotMinter();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 initialSupply, uint16 feeBps_) {
        require(feeBps_ <= 5000, "fee");
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        feeBps = feeBps_;
        minter = msg.sender;
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 value) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = a - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        uint256 fee = (value * feeBps) / 10_000;
        unchecked {
            balanceOf[from] = b - value;
            balanceOf[to] += value - fee;
            totalSupply -= fee;
        }
        emit Transfer(from, to, value - fee);
        if (fee != 0) emit Transfer(from, address(0), fee);
    }
}
