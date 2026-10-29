// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only fixtures for the insurance replay (src/replay.js, test/replay.test.js, scripts/insurance-replay-e2e.js).
// A deliberately trivial "incident": a vault whose sweep() forgot its owner check. Nothing here is a real
// contract, a real exploit or a technique; never deploy any of it outside a local test chain.

contract ReplayToken {
    string public constant symbol = "RPL";
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(uint8 d) { decimals = d; }
    function mint(address to, uint256 v) external { balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }
}

/// The covered target: holds native coin and tokens. sweep() should be owner-only and is not (the fixture's bug).
contract ToyVault {
    address public owner;
    constructor() payable { owner = msg.sender; }
    receive() external payable {}
    function sweep(address token, address to) external {
        if (token == address(0)) { (bool ok, ) = to.call{value: address(this).balance}(""); require(ok, "send"); }
        else { ReplayToken t = ReplayToken(token); t.transfer(to, t.balanceOf(address(this))); }
    }
    /// A time-dependent action, to check the replay keeps the original timestamp: works only inside [notBefore, notAfter].
    function sweepAt(address token, address to, uint256 notBefore, uint256 notAfter) external {
        require(block.timestamp >= notBefore && block.timestamp <= notAfter, "time");
        this.sweep(token, to);
    }
}

/// HackInsurance's committee stand-in: everyone is an active runner with a track record (IHIRunners).
contract RunnersStub {
    function workers(address) external pure returns (uint128, uint64, bool, uint32, uint32) { return (1, 0, true, 1, 0); }
}

/// A ZetaphyOracle stand-in: price(asset) in USD with 18 decimals; reverts for an unknown asset.
contract PriceStub {
    mapping(address => uint256) public usd;
    function set(address asset, uint256 v) external { usd[asset] = v; }
    function price(address asset) external view returns (uint256 value, uint256 updatedAt) {
        require(usd[asset] > 0, "unknown");
        return (usd[asset], block.timestamp);
    }
}
