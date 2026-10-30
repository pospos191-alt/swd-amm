// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Plain ERC-20 for the audit suites. Optional hook: when `hook` is set, every transfer /
/// transferFrom calls hook.onTokenTransfer(from, to, value) BEFORE moving the balance, which a
/// test uses to attempt re-entrancy from inside a token call (ERC-777-style hooks).
interface ITokenHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
}

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hook;
    uint256 public feeBps; // fee-on-transfer (burned), 0 = plain

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setHook(address h) external { hook = h; }
    function setFeeBps(uint256 b) external { feeBps = b; }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function burn(address from, uint256 v) external {
        balanceOf[from] -= v;
        totalSupply -= v;
        emit Transfer(from, address(0), v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[f][msg.sender] = a - v;
        }
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) private {
        if (hook != address(0)) ITokenHook(hook).onTokenTransfer(f, to, v);
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        uint256 fee = (v * feeBps) / 10_000;
        balanceOf[to] += v - fee;
        totalSupply -= fee;
        emit Transfer(f, to, v);
    }
}

/// A runner registry stub (NeuroJobs.workers shape) whose answers the test sets.
contract MockRunners {
    struct W { uint128 bond; uint64 unbondAt; bool active; uint32 agreed; uint32 rejected; }
    mapping(address => W) public w;

    function set(address who, bool active, uint32 agreed, uint32 rejected) external {
        w[who] = W(100 ether, 0, active, agreed, rejected);
    }

    function workers(address who) external view returns (uint128, uint64, bool, uint32, uint32) {
        W memory x = w[who];
        return (x.bond, x.unbondAt, x.active, x.agreed, x.rejected);
    }
}

/// Stand-in for ZETAPHY's ML-DSA precompile at 0x…0900 (etched there by the tests): it accepts a
/// "signature" iff sig == keccak256(variant, digest, pk). That keeps the wallet logic testable
/// without the real post-quantum verifier (which only exists on the ZETAPHY chain).
contract MockMLDSA {
    fallback(bytes calldata input) external returns (bytes memory) {
        // input = variant (1) || digest (32) || pk || sig; pk is 32 bytes in these tests, sig is 32 bytes
        if (input.length != 1 + 32 + 32 + 32) return abi.encode(uint256(0));
        bytes32 want = keccak256(input[0:65]);
        bytes32 got = bytes32(input[65:97]);
        return abi.encode(uint256(want == got ? 1 : 0));
    }
}

/// Receives native coins (or refuses them while `refuse` is set).
contract Receiver {
    bool public refuse;
    function setRefuse(bool r) external { refuse = r; }
    receive() external payable { require(!refuse, "refused"); }
    function call(address to, uint256 value, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call{value: value}(data);
    }
}
