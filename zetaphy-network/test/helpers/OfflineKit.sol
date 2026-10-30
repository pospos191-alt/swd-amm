// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY (test/offline.test.js): an ERC-20 with EIP-2612 permit, and a receiver that tries to re-enter
// whatever paid it native coins.

contract KitPermitToken {
    string public constant name = "Permit";
    string public constant symbol = "PRM";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256("1"), block.chainid, address(this)));
    }
    function mint(address to, uint256 v) external { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v);
        return true;
    }
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp <= deadline, "expired");
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
        address got = ecrecover(d, v, r, s);
        require(got != address(0) && got == owner, "permit");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
    function _move(address f, address to, uint256 v) private {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}

/// Receives native coins and, once, calls `target` with `data` from receive() (a re-entry attempt).
contract KitReenterer {
    address public target;
    bytes public data;
    bool public tried;
    bool public reentered;
    function arm(address t, bytes calldata d) external { target = t; data = d; }
    function call(address t, bytes calldata d) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = t.call{value: msg.value}(d);
        require(ok, "call");
        return ret;
    }
    receive() external payable {
        if (target == address(0)) return;
        address t = target;
        target = address(0);
        tried = true;
        (bool ok, ) = t.call(data);
        reentered = ok;
    }
}
