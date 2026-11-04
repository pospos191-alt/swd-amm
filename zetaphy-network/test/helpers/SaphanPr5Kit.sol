// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only stand-ins for Saphan PR 5 (test/saphanreads, saphanbundles, saphanintents, saphanaccounts .test.js).

/// A light client of chain X "accepting" state roots set by hand (the proofs under them are real).
contract KitStateRoots {
    struct R { bytes32 root; uint64 time; }
    mapping(uint64 => R) public r;
    function set(uint64 b, bytes32 root, uint64 time) external { r[b] = R(root, time); }
    function stateRootAt(uint64 b) external view returns (bytes32, uint64) { return (r[b].root, r[b].time); }
}

/// What reads ask about: a value in slot 0, a mapping in slot 1, a call that reverts, one that returns too much.
contract KitReadTarget {
    uint256 public value;
    mapping(address => uint256) public balances;
    function set(uint256 v) external { value = v; }
    function setBalance(address who, uint256 v) external { balances[who] = v; }
    function boom() external pure returns (uint256) { revert("boom"); }
    function big() external pure returns (bytes memory) { return new bytes(2000); }
    function spin() external pure returns (uint256 x) { while (true) x++; }
}

/// Calls something with a chosen gas (to show an answerer cannot starve a read).
contract KitGasCaller {
    function call(address to, bytes calldata data, uint256 gas) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call{value: msg.value, gas: gas}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}

/// NeuroScore.scoreOf, set by hand.
contract KitScores {
    struct S { bool known; int256 score; uint8 level; }
    mapping(address => S) public s;
    function set(address who, bool known, uint8 level) external { s[who] = S(known, int256(uint256(level)) * 1e7, level); }
    function scoreOf(address who) external view returns (bool, int256, uint8) { return (s[who].known, s[who].score, s[who].level); }
}

/// ThreatRegistry's address views, set by hand.
contract KitAddressThreats {
    mapping(address => bool) public held;
    mapping(address => bool) public enforced;
    function setHeld(address who, bool h) external { held[who] = h; }
    function setEnforced(address who, bool e) external { enforced[who] = e; }
    function isAddressHeld(uint256, address who) external view returns (bool, uint8) { return (held[who], held[who] ? 1 : 0); }
    function isAddressEnforced(uint256, address who) external view returns (bool, uint8) { return (enforced[who], enforced[who] ? 1 : 0); }
}

interface IKit20 { function balanceOf(address) external view returns (uint256); }

/// A bundle step on ZETAPHY: checks it has the tokens, records the call; `fail` makes it revert.
contract KitBundleTarget {
    address public bundles;
    bool public fail;
    uint256 public calls;
    bytes32 public lastId;
    address public lastCreator;
    uint256 public lastAmount;
    bytes public lastData;
    constructor(address b) { bundles = b; }
    function setFail(bool f) external { fail = f; }
    function onSaphanBundle(bytes32 id, address creator, address token, uint256 amount, bytes calldata data) external {
        require(msg.sender == bundles, "bundles only");
        require(IKit20(token).balanceOf(address(this)) >= amount, "tokens first");
        require(!fail, "step says no");
        calls++; lastId = id; lastCreator = creator; lastAmount = amount; lastData = data;
    }
}

/// A plain target for an account's calls: remembers who called with what.
contract KitAccountTarget {
    address public lastCaller;
    uint256 public lastValue;
    uint256 public x;
    function poke(uint256 v) external payable { lastCaller = msg.sender; lastValue = msg.value; x = v; }
    function nope() external pure { revert("nope"); }
}
