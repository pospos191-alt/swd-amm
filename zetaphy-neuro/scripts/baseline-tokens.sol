// SPDX-License-Identifier: MIT
// Similarity BASELINE (src/similarity.js): honest token code that many
// contracts share. Opcode 4-grams and selectors found here are removed before
// two contracts are compared, so ordinary library code (OpenZeppelin-style
// ERC-20 extensions, ownership, roles, a plain blacklist) never makes an honest
// token look like flagged code. Compiled by scripts/build-threat-signatures.js
// with solc 0.8.26, optimizer on and off. Never deployed anywhere.
//
// The OZ* contracts follow OpenZeppelin Contracts v5 (ERC20, Ownable,
// Ownable2Step, Pausable, ERC20Burnable, ERC20Capped, ERC20Permit/EIP712/
// Nonces, AccessControl): same functions, errors, events and storage logic,
// condensed into one file so no dependency is needed.
pragma solidity ^0.8.26;

// ------------------------------------------------------------- minimal tokens
// The shortest honest ERC-20s (no events, no errors), as hand-written tokens are.

contract MinBase {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint256 supply) {
        name = n;
        symbol = s;
        _mint(msg.sender, supply);
    }

    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        _move(f, to, v);
        return true;
    }
    function _move(address f, address to, uint256 v) internal virtual { balanceOf[f] -= v; balanceOf[to] += v; }
    function _mint(address to, uint256 v) internal { totalSupply += v; balanceOf[to] += v; }
}

contract MinOwned {
    address public owner = msg.sender;
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function renounceOwnership() external onlyOwner { owner = address(0); }
}

contract MinToken is MinBase {
    constructor() MinBase("Min", "MIN", 1_000_000e18) {}
}

contract MinOwnedMintToken is MinBase, MinOwned {
    constructor() MinBase("Min Owned", "MINO", 1e24) {}
    function mint(address to, uint256 v) external onlyOwner { _mint(to, v); }
}

// ------------------------------------------------------------- OpenZeppelin v5 style

abstract contract OZContext {
    function _msgSender() internal view virtual returns (address) { return msg.sender; }
}

abstract contract OZERC20 is OZContext {
    mapping(address account => uint256) private _balances;
    mapping(address account => mapping(address spender => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InvalidSender(address sender);
    error ERC20InvalidReceiver(address receiver);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);

    constructor(string memory name_, string memory symbol_) { _name = name_; _symbol = symbol_; }

    function name() public view virtual returns (string memory) { return _name; }
    function symbol() public view virtual returns (string memory) { return _symbol; }
    function decimals() public view virtual returns (uint8) { return 18; }
    function totalSupply() public view virtual returns (uint256) { return _totalSupply; }
    function balanceOf(address account) public view virtual returns (uint256) { return _balances[account]; }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        _transfer(_msgSender(), to, value);
        return true;
    }
    function allowance(address owner, address spender) public view virtual returns (uint256) { return _allowances[owner][spender]; }
    function approve(address spender, uint256 value) public virtual returns (bool) {
        _approve(_msgSender(), spender, value);
        return true;
    }
    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        _spendAllowance(from, _msgSender(), value);
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        _update(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal virtual {
        if (from == address(0)) {
            _totalSupply += value;
        } else {
            uint256 fromBalance = _balances[from];
            if (fromBalance < value) revert ERC20InsufficientBalance(from, fromBalance, value);
            unchecked { _balances[from] = fromBalance - value; }
        }
        if (to == address(0)) {
            unchecked { _totalSupply -= value; }
        } else {
            unchecked { _balances[to] += value; }
        }
        emit Transfer(from, to, value);
    }

    function _mint(address account, uint256 value) internal {
        if (account == address(0)) revert ERC20InvalidReceiver(address(0));
        _update(address(0), account, value);
    }

    function _burn(address account, uint256 value) internal {
        if (account == address(0)) revert ERC20InvalidSender(address(0));
        _update(account, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) internal { _approve(owner, spender, value, true); }

    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal virtual {
        if (owner == address(0)) revert ERC20InvalidApprover(address(0));
        if (spender == address(0)) revert ERC20InvalidSpender(address(0));
        _allowances[owner][spender] = value;
        if (emitEvent) emit Approval(owner, spender, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            unchecked { _approve(owner, spender, currentAllowance - value, false); }
        }
    }
}

abstract contract OZOwnable is OZContext {
    address private _owner;
    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(initialOwner);
    }
    modifier onlyOwner() { _checkOwner(); _; }
    function owner() public view virtual returns (address) { return _owner; }
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) revert OwnableUnauthorizedAccount(_msgSender());
    }
    function renounceOwnership() public virtual onlyOwner { _transferOwnership(address(0)); }
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(newOwner);
    }
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

abstract contract OZOwnable2Step is OZOwnable {
    address private _pendingOwner;
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function pendingOwner() public view virtual returns (address) { return _pendingOwner; }
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }
    function _transferOwnership(address newOwner) internal virtual override {
        delete _pendingOwner;
        super._transferOwnership(newOwner);
    }
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) revert OwnableUnauthorizedAccount(sender);
        _transferOwnership(sender);
    }
}

abstract contract OZPausable is OZContext {
    bool private _paused;
    event Paused(address account);
    event Unpaused(address account);
    error EnforcedPause();
    error ExpectedPause();

    modifier whenNotPaused() { _requireNotPaused(); _; }
    modifier whenPaused() { _requirePaused(); _; }
    function paused() public view virtual returns (bool) { return _paused; }
    function _requireNotPaused() internal view virtual { if (paused()) revert EnforcedPause(); }
    function _requirePaused() internal view virtual { if (!paused()) revert ExpectedPause(); }
    function _pause() internal virtual whenNotPaused { _paused = true; emit Paused(_msgSender()); }
    function _unpause() internal virtual whenPaused { _paused = false; emit Unpaused(_msgSender()); }
}

abstract contract OZERC20Pausable is OZERC20, OZPausable {
    function _update(address from, address to, uint256 value) internal virtual override whenNotPaused {
        super._update(from, to, value);
    }
}

abstract contract OZERC20Burnable is OZContext, OZERC20 {
    function burn(uint256 value) public virtual { _burn(_msgSender(), value); }
    function burnFrom(address account, uint256 value) public virtual {
        _spendAllowance(account, _msgSender(), value);
        _burn(account, value);
    }
}

abstract contract OZERC20Capped is OZERC20 {
    uint256 private immutable _cap;
    error ERC20ExceededCap(uint256 increasedSupply, uint256 cap);
    error ERC20InvalidCap(uint256 cap);

    constructor(uint256 cap_) {
        if (cap_ == 0) revert ERC20InvalidCap(0);
        _cap = cap_;
    }
    function cap() public view virtual returns (uint256) { return _cap; }
    function _update(address from, address to, uint256 value) internal virtual override {
        super._update(from, to, value);
        if (from == address(0)) {
            uint256 maxSupply = cap();
            uint256 supply = totalSupply();
            if (supply > maxSupply) revert ERC20ExceededCap(supply, maxSupply);
        }
    }
}

abstract contract OZNonces {
    error InvalidAccountNonce(address account, uint256 currentNonce);
    mapping(address account => uint256) private _nonces;
    function nonces(address owner) public view virtual returns (uint256) { return _nonces[owner]; }
    function _useNonce(address owner) internal virtual returns (uint256) {
        unchecked { return _nonces[owner]++; }
    }
}

abstract contract OZEIP712 {
    bytes32 private constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;
    address private immutable _cachedThis;
    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;
    string private _nameFallback;
    string private _versionFallback;

    event EIP712DomainChanged();

    constructor(string memory name_, string memory version_) {
        _nameFallback = name_;
        _versionFallback = version_;
        _hashedName = keccak256(bytes(name_));
        _hashedVersion = keccak256(bytes(version_));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        _cachedThis = address(this);
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        if (address(this) == _cachedThis && block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(TYPE_HASH, _hashedName, _hashedVersion, block.chainid, address(this)));
    }
    function _hashTypedDataV4(bytes32 structHash) internal view virtual returns (bytes32 digest) {
        bytes32 ds = _domainSeparatorV4();
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, hex"19_01")
            mstore(add(ptr, 0x02), ds)
            mstore(add(ptr, 0x22), structHash)
            digest := keccak256(ptr, 0x42)
        }
    }
    function eip712Domain() public view virtual returns (
        bytes1 fields, string memory name, string memory version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions
    ) {
        return (hex"0f", _nameFallback, _versionFallback, block.chainid, address(this), bytes32(0), new uint256[](0));
    }
}

abstract contract OZERC20Permit is OZERC20, OZEIP712, OZNonces {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    error ERC2612ExpiredSignature(uint256 deadline);
    error ERC2612InvalidSigner(address signer, address owner);
    error ECDSAInvalidSignature();
    error ECDSAInvalidSignatureS(bytes32 s);

    constructor(string memory name_) OZEIP712(name_, "1") {}

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) public virtual {
        if (block.timestamp > deadline) revert ERC2612ExpiredSignature(deadline);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline));
        bytes32 hash = _hashTypedDataV4(structHash);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert ECDSAInvalidSignatureS(s);
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert ECDSAInvalidSignature();
        if (signer != owner) revert ERC2612InvalidSigner(signer, owner);
        _approve(owner, spender, value);
    }
    function nonces(address owner) public view virtual override returns (uint256) { return super.nonces(owner); }
    function DOMAIN_SEPARATOR() external view virtual returns (bytes32) { return _domainSeparatorV4(); }
}

abstract contract OZAccessControl is OZContext {
    struct RoleData { mapping(address account => bool) hasRole; bytes32 adminRole; }
    mapping(bytes32 role => RoleData) private _roles;
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error AccessControlBadConfirmation();
    event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    modifier onlyRole(bytes32 role) { _checkRole(role); _; }
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == 0x7965db0b || interfaceId == 0x01ffc9a7;
    }
    function hasRole(bytes32 role, address account) public view virtual returns (bool) { return _roles[role].hasRole[account]; }
    function _checkRole(bytes32 role) internal view virtual { _checkRole(role, _msgSender()); }
    function _checkRole(bytes32 role, address account) internal view virtual {
        if (!hasRole(role, account)) revert AccessControlUnauthorizedAccount(account, role);
    }
    function getRoleAdmin(bytes32 role) public view virtual returns (bytes32) { return _roles[role].adminRole; }
    function grantRole(bytes32 role, address account) public virtual onlyRole(getRoleAdmin(role)) { _grantRole(role, account); }
    function revokeRole(bytes32 role, address account) public virtual onlyRole(getRoleAdmin(role)) { _revokeRole(role, account); }
    function renounceRole(bytes32 role, address callerConfirmation) public virtual {
        if (callerConfirmation != _msgSender()) revert AccessControlBadConfirmation();
        _revokeRole(role, callerConfirmation);
    }
    function _grantRole(bytes32 role, address account) internal virtual returns (bool) {
        if (!hasRole(role, account)) {
            _roles[role].hasRole[account] = true;
            emit RoleGranted(role, account, _msgSender());
            return true;
        }
        return false;
    }
    function _revokeRole(bytes32 role, address account) internal virtual returns (bool) {
        if (hasRole(role, account)) {
            _roles[role].hasRole[account] = false;
            emit RoleRevoked(role, account, _msgSender());
            return true;
        }
        return false;
    }
}

// ------------------------------------------------------------- baseline tokens
// One per common pattern, each on its own, so no combination of them is "new".

contract OZToken is OZERC20 {
    constructor() OZERC20("OZ Token", "OZT") { _mint(msg.sender, 1e24); }
}

contract OZOwnableMintToken is OZERC20, OZOwnable {
    constructor() OZERC20("OZ Mint", "OZM") OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }
}

contract OZPausableToken is OZERC20Pausable, OZOwnable {
    constructor() OZERC20("OZ Pausable", "OZP") OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function pause() public onlyOwner { _pause(); }
    function unpause() public onlyOwner { _unpause(); }
    function _update(address from, address to, uint256 value) internal override(OZERC20Pausable) { super._update(from, to, value); }
}

contract OZPermitToken is OZERC20Permit {
    constructor() OZERC20("OZ Permit", "OZPM") OZERC20Permit("OZ Permit") { _mint(msg.sender, 1e24); }
}

contract OZBurnableToken is OZERC20Burnable {
    constructor() OZERC20("OZ Burnable", "OZB") { _mint(msg.sender, 1e24); }
}

contract OZCappedToken is OZERC20Capped, OZOwnable {
    constructor() OZERC20("OZ Capped", "OZC") OZERC20Capped(1e27) OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }
}

contract OZOwnable2StepToken is OZERC20, OZOwnable2Step {
    constructor() OZERC20("OZ Two Step", "OZ2") OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }
}

contract OZAccessControlToken is OZERC20, OZAccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    constructor() OZERC20("OZ Roles", "OZR") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _mint(msg.sender, 1e24);
    }
    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) { _mint(to, amount); }
}

/// A plain owner-managed blacklist, as many regulated or anti-bot tokens have.
/// Its power is still reported by the fixed rules (can-blacklist); it is only
/// removed here so that the pattern alone does not read as "similar to flagged code".
contract OZBlacklistToken is OZERC20, OZOwnable {
    mapping(address => bool) public isBlacklisted;
    event Blacklisted(address indexed account, bool value);
    error BlacklistedAccount(address account);
    constructor() OZERC20("OZ Blacklist", "OZBL") OZOwnable(msg.sender) { _mint(msg.sender, 1e24); }
    function setBlacklist(address account, bool value) public onlyOwner {
        isBlacklisted[account] = value;
        emit Blacklisted(account, value);
    }
    function _update(address from, address to, uint256 value) internal override {
        if (isBlacklisted[from]) revert BlacklistedAccount(from);
        if (isBlacklisted[to]) revert BlacklistedAccount(to);
        super._update(from, to, value);
    }
}
