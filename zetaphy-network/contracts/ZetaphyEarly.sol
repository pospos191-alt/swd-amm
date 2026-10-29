// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Early (ZEARLY): the community token of the ZETAPHY testnet airdrop
/// @notice A plain ERC-20 with a fixed supply of 1,000,000,000, all created once for the holder given at
///         deploy (the airdrop wallet). No owner, no mint, no pause, no fee: nobody can create more or stop
///         transfers. It shows who joined early; it is NOT ZETAPHY, it is not converted into ZETAPHY, and
///         it has no value (zetaphy-chain/rewards/EARLY.md).
///         batchTransfer sends the same amount from the caller to many wallets in one transaction (the airdrop).
contract ZetaphyEarly {
    string public constant name = "ZETAPHY Early";
    string public constant symbol = "ZEARLY";
    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = 1_000_000_000 ether;
    uint256 public constant MAX_BATCH = 500;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error BadBatch();

    constructor(address holder) {
        if (holder == address(0)) revert ZeroAddress();
        balanceOf[holder] = totalSupply;
        emit Transfer(address(0), holder, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = a - value; }
        }
        _move(from, to, value);
        return true;
    }

    /// @notice Sends `each` from the caller to every address in `to` (1 to MAX_BATCH addresses).
    function batchTransfer(address[] calldata to, uint256 each) external returns (bool) {
        uint256 n = to.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatch();
        uint256 total = each * n;
        uint256 b = balanceOf[msg.sender];
        if (b < total) revert InsufficientBalance();
        unchecked { balanceOf[msg.sender] = b - total; }
        for (uint256 i; i < n; ++i) {
            address t = to[i];
            if (t == address(0)) revert ZeroAddress();
            unchecked { balanceOf[t] += each; } // sum of all balances is totalSupply: no overflow
            emit Transfer(msg.sender, t, each);
        }
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
