// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only targets of the Saphan Gateway (test/saphangateway.test.js).
interface IKitToken { function balanceOf(address) external view returns (uint256); }

/// On ZETAPHY: records the last call; `fail` makes it revert (after taking the tokens, which must be undone).
contract KitCallee {
    address public gateway;
    bool public fail;
    uint256 public calls;
    uint256 public lastSrc;
    address public lastSender;
    address public lastToken;
    uint256 public lastAmount;
    bytes public lastData;
    constructor(address g) { gateway = g; }
    function setFail(bool f) external { fail = f; }
    function onSaphanCall(uint256 src, address sender, address token, uint256 amount, bytes calldata data) external {
        require(msg.sender == gateway, "gateway only");
        require(IKitToken(token).balanceOf(address(this)) >= amount, "tokens first");
        require(!fail, "target says no");
        calls++; lastSrc = src; lastSender = sender; lastToken = token; lastAmount = amount; lastData = data;
    }
    /// Burns the gas it is given (for the gas-limit check).
    function spin() external pure { while (true) {} }
}

/// On a source chain: records calls and refunds; `fail` makes onSaphanCall revert.
contract KitReceiver {
    address public gateway;
    bool public fail;
    uint256 public got;
    uint256 public lastSrc;
    address public lastSender;
    bytes public lastData;
    uint256 public revertNonce;
    bytes public revertMessage;
    address public revertSender;
    constructor(address g) { gateway = g; }
    function setFail(bool f) external { fail = f; }
    function onSaphanCall(uint256 src, address sender, bytes calldata data) external payable {
        require(msg.sender == gateway, "gateway only");
        require(!fail, "receiver says no");
        got += msg.value; lastSrc = src; lastSender = sender; lastData = data;
    }
    function onSaphanRevert(address sender, uint256 nonce, bytes calldata message) external payable {
        require(msg.sender == gateway, "gateway only");
        got += msg.value; revertSender = sender; revertNonce = nonce; revertMessage = message;
    }
}

/// Refuses ETH: a refund to it is kept in the Gateway (owed) instead of failing the execution.
contract KitRefuser {
    receive() external payable { revert("no"); }
}
