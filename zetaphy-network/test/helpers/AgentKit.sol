// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: helpers for test/intents.test.js and test/policywallet.test.js.

interface IKitERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// A staking vault: deposit(amount, to) pulls `amount` from the caller and mints as many shares to `to`.
contract ShareVault {
    address public immutable asset;
    string public constant symbol = "sKIT";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address asset_) { asset = asset_; }

    function deposit(uint256 amount, address to) external {
        require(IKitERC20(asset).transferFrom(msg.sender, address(this), amount), "pull");
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}

/// A "router" the user once approved, that a malicious solver uses to pull more than the intent allows.
contract Drainer {
    function drain(address token, address from, address to, uint256 amount) external {
        IKitERC20(token).transferFrom(from, to, amount);
    }
}

/// Records calls (to check what a wallet sent) and accepts value.
contract Sink {
    uint256 public calls;
    bytes public last;
    function poke(bytes calldata data) external payable { calls++; last = data; }
    receive() external payable {}
}
