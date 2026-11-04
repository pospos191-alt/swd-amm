// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only fixtures for the invariant firewall (contracts/InvariantFirewall.sol, test/firewall.test.js).
// FwVault is DELIBERATELY VULNERABLE: `skim` forgets its access check and its accounting, and `withdrawAll`
// pays before it updates its books (a textbook reentrancy). Never deploy any of it outside a local test chain.

import {Firewalled, IInvariantFirewall} from "../../contracts/Firewalled.sol";
import {CircuitBreakable, ICircuitBreaker} from "../../contracts/CircuitBreakable.sol";

contract FwVault is Firewalled, CircuitBreakable {
    address public immutable owner;
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    constructor(IInvariantFirewall fw, ICircuitBreaker breaker, address protocolGovernance)
        Firewalled(fw)
        CircuitBreakable(breaker)
    {
        owner = msg.sender;
        _firewallRegister(protocolGovernance);
    }

    /// The owner has the vault call CircuitBreaker.register(policy) itself (as HealVault does).
    function optInBreaker(bytes calldata registerCall) external {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory ret) = address(circuitBreaker).call(registerCall);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    function deposit() external payable firewalled whenNotTripped(this.deposit.selector) {
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }

    /// Correct: books first, then pay.
    function withdraw(uint256 amount) external firewalled whenNotTripped(this.withdraw.selector) {
        require(balances[msg.sender] >= amount, "balance");
        balances[msg.sender] -= amount;
        totalDeposits -= amount;
        _firewallOutflow(address(0), amount);
        if (_outflow(address(0), msg.sender, amount)) _payOut(address(0), msg.sender, amount);
    }

    /// BUG (deliberate): pays first, then books what is left (0 after a re-entrant call did it).
    function withdrawAll() external firewalled {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "empty");
        _payOut(address(0), msg.sender, amount);
        totalDeposits -= balances[msg.sender];
        balances[msg.sender] = 0;
    }

    /// BUG (deliberate): "fee skimming" with no access check and no accounting.
    function skim(uint256 amount) external firewalled {
        _payOut(address(0), msg.sender, amount);
    }

    function _payOut(address, address to, uint256 amount) internal override {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send");
    }

    /// Donations (no books).
    receive() external payable {}
}

/// The same vault without the firewall (the control group).
contract PlainVault {
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }

    function skim(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }
}

interface IFwBooks {
    function totalDeposits() external view returns (uint256);
}

/// Solvency: the vault holds at least what it owes its depositors.
contract SolvencyInvariant {
    function holds(address protocol) external view returns (bool) {
        return protocol.balance >= IFwBooks(protocol).totalDeposits();
    }
}

/// A checker whose behaviour the test sets: 0 holds, 1 false, 2 reverts, 3 burns all its gas, 4 returns 64 bytes,
/// 5 returns 2 (not a bool), 6 returns nothing.
contract ModeInvariant {
    uint8 public mode;

    function set(uint8 m) external {
        mode = m;
    }

    function holds(address) external view returns (bool) {
        uint8 m = mode;
        if (m == 1) return false;
        if (m == 2) revert("broken");
        if (m == 3) {
            uint256 x;
            while (true) x++;
        }
        if (m == 4) assembly { mstore(0, 1) mstore(32, 1) return(0, 64) }
        if (m == 5) assembly { mstore(0, 2) return(0, 32) }
        if (m == 6) assembly { return(0, 0) }
        return true;
    }
}

/// Re-enters withdrawAll `depth` times.
contract FwAttacker {
    FwVault public immutable vault;
    uint256 public left;

    constructor(FwVault v) {
        vault = v;
    }

    function attack(uint256 depth) external payable {
        left = depth;
        vault.deposit{value: msg.value}();
        vault.withdrawAll();
        left = 0;
    }

    function skim(uint256 amount) external {
        vault.skim(amount);
    }

    /// Calls skim with too little gas for the firewall to check anything: returns whether it went through.
    function starve(uint256 amount, uint256 gas) external returns (bool ok) {
        (ok, ) = address(vault).call{gas: gas}(abi.encodeCall(FwVault.skim, (amount)));
    }

    receive() external payable {
        if (left > 0) {
            left -= 1;
            vault.withdrawAll();
        }
    }
}

/// A benign smart wallet that re-deposits part of every payment it receives (a legitimate nested call).
contract FwSmartWallet {
    FwVault public immutable vault;
    bool public redeposit;

    constructor(FwVault v) {
        vault = v;
    }

    function save() external payable {
        vault.deposit{value: msg.value}();
    }

    function take(uint256 amount, bool again) external {
        redeposit = again;
        vault.withdraw(amount);
        redeposit = false;
    }

    receive() external payable {
        if (redeposit) vault.deposit{value: msg.value / 2}();
    }
}

/// Stands in for AuditCertificate (the unit tests; one test uses the real one).
contract MockCertificates {
    struct Cert {
        uint256 requestId;
        uint64 chainId;
        address target;
        bytes32 codeHash;
        bytes32 reportHash;
        bytes32 sourceHash;
        uint8 level;
        uint16 auditors;
        uint16 mutationBps;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint256 revokedBy;
    }

    mapping(address => Cert) internal _c;

    function set(address target, uint256 requestId, uint64 expiresAt, bool revoked) external {
        Cert storage c = _c[target];
        c.requestId = requestId;
        c.chainId = uint64(block.chainid);
        c.target = target;
        c.codeHash = target.codehash;
        c.level = 1;
        c.issuedAt = uint64(block.timestamp);
        c.expiresAt = expiresAt;
        c.revokedAt = revoked ? uint64(block.timestamp) : 0;
    }

    function _valid(Cert storage c) internal view returns (bool) {
        return c.issuedAt != 0 && c.revokedAt == 0 && block.timestamp < c.expiresAt && c.target.codehash == c.codeHash;
    }

    function isCertified(uint64 chainId, address target) external view returns (bool) {
        return chainId == block.chainid && _valid(_c[target]);
    }

    function certificate(uint64, address target) external view returns (Cert memory c, bool valid) {
        return (_c[target], _valid(_c[target]));
    }
}
