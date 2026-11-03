// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RedTeamAttacker: the red team's programmable attack contract (docs/future/red-team.md)
/// @notice LOCAL FORKS ONLY. The red team deploys it on its own fork (src/redteam/fork.js) as part of an exploit
///         bundle; it is NOT a ZETAPHY contract, never deployed by ZETAPHY, and holds nothing. Compiled by
///         scripts/build-redteam.js into src/redteam/attacker.json.
///
///         run(calls)            executes the calls in order (any failure reverts the whole run)
///         arm(calls, times, r)  the next `times` callbacks into this contract (receive / fallback: a payout, a
///                               flash-loan or swap callback, a token hook) execute `calls`, then return `r`
///         A call can PATCH one 32-byte word of its calldata (at byte `patchAt` - 1) with this contract's current
///         balance of `balanceOf` (address(0): the native coin), and `value == type(uint256).max` sends the whole
///         native balance: "swap everything I got" without knowing amounts in advance.
///         sweep(tokens)         sends every listed token and the native coin to the owner (the attacker EOA).
contract RedTeamAttacker {
    struct Call {
        address to;
        uint256 value;
        bytes data;
        address balanceOf;
        uint32 patchAt;
    }

    address public immutable owner;
    Call[] internal _callback;
    uint256 public armed;
    bytes internal _ret;

    constructor() payable {
        owner = msg.sender;
    }

    function run(Call[] calldata calls) external payable {
        require(msg.sender == owner, "owner");
        for (uint256 i = 0; i < calls.length; i++) _exec(calls[i]);
    }

    function arm(Call[] calldata calls, uint256 times, bytes calldata ret) external {
        require(msg.sender == owner, "owner");
        delete _callback;
        for (uint256 i = 0; i < calls.length; i++) _callback.push(calls[i]);
        armed = times;
        _ret = ret;
    }

    function sweep(address[] calldata tokens) external {
        require(msg.sender == owner, "owner");
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool ok, bytes memory b) = tokens[i].staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
            if (ok && b.length >= 32) {
                uint256 bal = abi.decode(b, (uint256));
                if (bal > 0) tokens[i].call(abi.encodeWithSignature("transfer(address,uint256)", owner, bal));
            }
        }
        if (address(this).balance > 0) {
            (bool sent, ) = owner.call{value: address(this).balance}("");
            require(sent, "sweep");
        }
    }

    receive() external payable {
        _onCallback();
    }

    fallback(bytes calldata) external payable returns (bytes memory) {
        _onCallback();
        return _ret;
    }

    function _onCallback() internal {
        if (armed == 0) return;
        armed -= 1;
        uint256 n = _callback.length;
        for (uint256 i = 0; i < n; i++) _exec(_callback[i]);
    }

    function _exec(Call memory c) internal {
        bytes memory data = c.data;
        if (c.patchAt != 0) {
            uint256 bal = c.balanceOf == address(0) ? address(this).balance : _tokenBalance(c.balanceOf);
            uint256 at = uint256(c.patchAt) - 1;
            require(at + 32 <= data.length, "patch");
            assembly { mstore(add(add(data, 32), at), bal) }
        }
        uint256 v = c.value == type(uint256).max ? address(this).balance : c.value;
        (bool ok, bytes memory ret) = c.to.call{value: v}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    function _tokenBalance(address token) internal view returns (uint256) {
        (bool ok, bytes memory b) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok && b.length >= 32 ? abi.decode(b, (uint256)) : 0;
    }
}
