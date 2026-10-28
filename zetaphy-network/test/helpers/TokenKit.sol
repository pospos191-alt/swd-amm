// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: ERC-20s for the token-route tests (test/saphantokens.test.js): a plain one with any decimals, and
// the odd ones a vault must refuse or handle: fee on transfer, no return value (USDT style), returns false,
// no decimals(), a hook that re-enters the vault, and a ThreatRegistry stand-in.

contract KitToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }

    function mint(address to, uint256 v) external { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external virtual returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external virtual returns (bool) { _spend(f, v); _move(f, to, v); return true; }
    function _spend(address f, uint256 v) internal {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
    }
    function _move(address f, address to, uint256 v) internal virtual {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}

/// Takes 1% of every transfer (the receiver gets less than was sent).
contract KitFeeToken is KitToken {
    constructor() KitToken("Fee", "FEE", 18) {}
    function _move(address f, address to, uint256 v) internal override {
        require(balanceOf[f] >= v, "balance");
        uint256 fee = v / 100;
        balanceOf[f] -= v; balanceOf[to] += v - fee; totalSupply -= fee; emit Transfer(f, to, v - fee);
    }
}

/// transfer / transferFrom return nothing (USDT on Ethereum).
contract KitNoReturnToken {
    string public constant name = "NoReturn";
    string public constant symbol = "NRT";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external { allowance[msg.sender][s] = v; }
    function transfer(address to, uint256 v) external { require(balanceOf[msg.sender] >= v); balanceOf[msg.sender] -= v; balanceOf[to] += v; }
    function transferFrom(address f, address to, uint256 v) external {
        require(allowance[f][msg.sender] >= v && balanceOf[f] >= v);
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v;
    }
}

/// Returns false instead of reverting (and moves nothing).
contract KitFalseToken is KitToken {
    constructor() KitToken("False", "NO", 18) {}
    function transferFrom(address, address, uint256) external pure override returns (bool) { return false; }
    function transfer(address, uint256) external pure override returns (bool) { return false; }
}

/// No decimals() at all.
contract KitNoDecimalsToken {
    mapping(address => uint256) public balanceOf;
}

/// Calls back into a target on every transfer (an ERC-777-style hook): tries to re-enter the vault.
contract KitHookToken is KitToken {
    address public target;
    bytes public data;
    bool public reentered;
    constructor() KitToken("Hook", "HOOK", 18) {}
    function arm(address t, bytes calldata d) external { target = t; data = d; }
    function _move(address f, address to, uint256 v) internal override {
        super._move(f, to, v);
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (bool ok, ) = t.call(data);
            reentered = ok;
        }
    }
}

/// ThreatRegistry stand-in: isContractHeld(who) as set here.
contract KitThreats {
    mapping(address => bool) public held;
    function setHeld(address who, bool h) external { held[who] = h; }
    function isContractHeld(address who) external view returns (bool, uint8) { return (held[who], held[who] ? 1 : 0); }
}
