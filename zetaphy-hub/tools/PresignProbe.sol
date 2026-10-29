// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PresignProbe: the hub's pre-sign simulation (presign.js), never deployed.
/// @notice One eth_call with a state override puts this code at the USER's own address and calls it from the user:
///         probe() then makes the user's call (msg.sender = the user, tx.origin = the user) and reports what it did
///         to the user's balances: the native coin and each listed token (balanceOf before and after). The override
///         exists only inside that one call; nothing is signed or sent. A token whose balanceOf fails reads as 0.
///         What differs from the real transaction: the user's account has code during the call (a contract that
///         checks extcodesize(msg.sender) == 0 behaves differently), gas is not charged, and the state is the latest
///         block's, not the one the transaction lands in.
contract PresignProbe {
    function probe(address target, uint256 value, bytes calldata data, address[] calldata tokens)
        external
        returns (bool ok, bytes memory ret, uint256 nativeBefore, uint256 nativeAfter, uint256[] memory before, uint256[] memory afterwards)
    {
        before = new uint256[](tokens.length);
        afterwards = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) before[i] = _bal(tokens[i]);
        nativeBefore = address(this).balance;
        (ok, ret) = target.call{value: value}(data);
        nativeAfter = address(this).balance;
        for (uint256 i = 0; i < tokens.length; ++i) afterwards[i] = _bal(tokens[i]);
    }

    function _bal(address token) private view returns (uint256 v) {
        (bool s, bytes memory r) = token.staticcall{gas: 100_000}(abi.encodeWithSelector(0x70a08231, address(this)));
        if (s && r.length >= 32) v = abi.decode(r, (uint256));
    }

    // An account without code accepts these; so does the probe standing in for it.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return 0xbc197c81; }
    receive() external payable {}
    fallback() external payable {}
}
