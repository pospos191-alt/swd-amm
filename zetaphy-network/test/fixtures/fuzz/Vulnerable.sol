// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// DELIBERATELY VULNERABLE fuzz fixtures (TEST ONLY, never deployed): each contract has one known
// bug of a different kind, so the browser fuzzer (zetaphy-hub/fuzz-core.js) is tested on each
// invariant it checks. scripts/fuzz-fixtures.js turns them into fuzz specs.

/// Reentrancy: withdraw() pays before it zeroes the balance.
contract ReentrantBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 a = balances[msg.sender];
        require(a > 0, "empty");
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        balances[msg.sender] = 0; // BUG: too late
    }
}

/// Delegatecall to anyone: execute() has no access control.
contract OpenDelegate {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {}

    function execute(address to, bytes calldata data) external returns (bytes memory) {
        // BUG: missing `require(msg.sender == owner)`
        (bool ok, bytes memory r) = to.delegatecall(data);
        require(ok, "call");
        return r;
    }
}

/// Selfdestruct by anyone: the time lock was never set (0), so the owner check is skipped.
contract KillSwitch {
    address public owner;
    uint256 public shutdownAfter; // BUG: the deployment never sets it
    mapping(address => uint256) public balances;

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }

    function shutdown(address payable to) external {
        require(msg.sender == owner || block.timestamp >= shutdownAfter, "early");
        selfdestruct(to);
    }
}

/// Token drain: transferFrom never checks the allowance.
contract LeakyToken {
    string public name = "Leaky";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() {
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        require(balanceOf[f] >= v, "balance"); // BUG: allowance[f][msg.sender] is never checked or spent
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// Owner takeover: transferOwnership forgot its modifier.
contract OwnerTakeover {
    address public owner;
    mapping(address => uint256) public balances;

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function transferOwnership(address next) external {
        require(next != address(0), "zero"); // BUG: anyone may call
        owner = next;
    }

    function setFee(uint256) external view {
        require(msg.sender == owner, "owner");
    }
}
