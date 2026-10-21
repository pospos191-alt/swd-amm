// SPDX-License-Identifier: MIT
// Honest tokens built from common OpenZeppelin-style parts in combinations
// that are NOT in the similarity baseline (scripts/baseline-tokens.sol).
// test/similarity.test.js checks that none of them reads as "similar" to the
// test reference samples. Test-only; never deploy these.
pragma solidity ^0.8.26;

import "baseline-tokens.sol";

// Pausable + Burnable + Permit + Ownable2Step + owner mint.
contract HonestFullToken is OZERC20Pausable, OZERC20Burnable, OZERC20Permit, OZOwnable2Step {
    constructor() OZERC20("Honest Full", "HFULL") OZERC20Permit("Honest Full") OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function pause() public onlyOwner { _pause(); }
    function unpause() public onlyOwner { _unpause(); }
    function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override(OZERC20, OZERC20Pausable) { super._update(from, to, value); }
}

// AccessControl roles + Pausable + Burnable.
contract HonestRolesToken is OZERC20Pausable, OZERC20Burnable, OZAccessControl {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    constructor() OZERC20("Honest Roles", "HROLE") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _mint(msg.sender, 1e24);
    }
    function pause() public onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() public onlyRole(PAUSER_ROLE) { _unpause(); }
    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override(OZERC20, OZERC20Pausable) { super._update(from, to, value); }
}

// Capped owner mint + a plain blacklist + Burnable.
contract HonestCappedBlacklist is OZERC20Capped, OZERC20Burnable, OZOwnable {
    mapping(address => bool) public isBlacklisted;
    event Blacklisted(address indexed account, bool value);
    error BlacklistedAccount(address account);
    constructor() OZERC20("Honest Capped", "HCAP") OZERC20Capped(1e27) OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }
    function setBlacklist(address account, bool value) public onlyOwner {
        isBlacklisted[account] = value;
        emit Blacklisted(account, value);
    }
    function _update(address from, address to, uint256 value) internal override(OZERC20, OZERC20Capped) {
        if (isBlacklisted[from]) revert BlacklistedAccount(from);
        if (isBlacklisted[to]) revert BlacklistedAccount(to);
        super._update(from, to, value);
    }
}

// Fixed supply with Permit and Burnable.
contract HonestPermitBurnable is OZERC20Permit, OZERC20Burnable {
    constructor() OZERC20("Honest Permit", "HPRM") OZERC20Permit("Honest Permit") { _mint(msg.sender, 1e24); }
}

// Pausable + owner mint + blacklist, on the minimal hand-written base (no OZ).
contract HonestMinPausable is MinBase, MinOwned {
    bool public paused;
    mapping(address => bool) public isBlacklisted;
    constructor() MinBase("Honest Min", "HMIN", 1e24) {}
    function mint(address to, uint256 v) external onlyOwner { _mint(to, v); }
    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }
    function setBlacklist(address a, bool b) external onlyOwner { isBlacklisted[a] = b; }
    function _move(address f, address to, uint256 v) internal override {
        require(!paused && !isBlacklisted[f] && !isBlacklisted[to], "blocked");
        super._move(f, to, v);
    }
}
