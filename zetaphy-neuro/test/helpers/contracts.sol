// SPDX-License-Identifier: MIT
// Sample contracts for the tests: one honest token and several with the
// patterns Neuro tier 1 must flag. Test-only; never deploy these.
pragma solidity ^0.8.26;

contract BaseToken {
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

contract Owned {
    address public owner = msg.sender;
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    function transferOwnership(address n) external onlyOwner { owner = n; }
    function renounceOwnership() external onlyOwner { owner = address(0); }
}

contract CleanToken is BaseToken {
    constructor() BaseToken("Clean Token", "CLEAN", 1_000_000e18) {}
}

contract ScamToken is BaseToken, Owned {
    mapping(address => bool) public isBlacklisted;
    mapping(address => bool) private exempt;
    bool public paused;
    bool public tradingOpen;
    uint256 public sellFee;
    uint256 public maxTx = type(uint256).max;

    constructor() BaseToken("Moon Inu", "MOON", 1e27) {}

    function mint(address to, uint256 v) external onlyOwner { _mint(to, v); }
    function setBlacklist(address a, bool b) external onlyOwner { isBlacklisted[a] = b; }
    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }
    function setSellFee(uint256 f) external onlyOwner { sellFee = f; }
    function enableTrading() external onlyOwner { tradingOpen = true; }
    function setMaxTxAmount(uint256 m) external onlyOwner { maxTx = m; }
    function excludeFromFee(address a) external onlyOwner { exempt[a] = true; }

    function _move(address f, address to, uint256 v) internal override {
        require(!paused && !isBlacklisted[f] && v <= maxTx, "blocked");
        super._move(f, to, v);
    }
}

contract RenouncedToken is BaseToken, Owned {
    constructor() BaseToken("Fair Token", "FAIR", 1e24) { owner = address(0); }
    function mint(address to, uint256 v) external onlyOwner { _mint(to, v); }
}

contract RolesToken is BaseToken {
    mapping(bytes32 => mapping(address => bool)) public hasRole;
    constructor() BaseToken("Role Token", "ROLE", 1e24) { hasRole[0][msg.sender] = true; }
    function grantRole(bytes32 r, address a) external { require(hasRole[0][msg.sender]); hasRole[r][a] = true; }
    function mint(address to, uint256 v) external { require(hasRole[keccak256("MINTER")][msg.sender]); _mint(to, v); }
}

contract PhishToken is BaseToken {
    constructor() BaseToken("Claim rewards at bonus-drop.xyz", unicode"\u202eCLAIM", 1e24) {}
}

contract Killable {
    address private immutable o = msg.sender;
    function kill() external { require(msg.sender == o); selfdestruct(payable(o)); }
}

// EIP-1967 proxy with a UUPS-style upgradeable token behind it.
contract Proxy1967 {
    bytes32 private constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address impl, bytes memory init) {
        assembly { sstore(IMPL, impl) sstore(ADMIN, caller()) }
        (bool ok, ) = impl.delegatecall(init);
        require(ok, "init failed");
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL)
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}

// ZeppelinOS-era proxy (Circle's FiatTokenProxy layout): same idea, older slots.
contract ProxyZos {
    bytes32 private constant IMPL = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
    bytes32 private constant ADMIN = 0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b;

    constructor(address impl, bytes memory init) {
        assembly { sstore(IMPL, impl) sstore(ADMIN, caller()) }
        (bool ok, ) = impl.delegatecall(init);
        require(ok, "init failed");
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL)
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}

// A pool that CALLS its LP token's mint(): the selector is in its code, but
// mint is not one of its own functions.
interface ILpToken { function mint(address to, uint256 v) external; }
contract PoolCallsMint {
    ILpToken public lp;
    constructor(address t) { lp = ILpToken(t); }
    function deposit(uint256 v) external { lp.mint(msg.sender, v); }
}

contract UpgradeableToken {
    string public name;
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    address public owner;

    function initialize() external {
        require(owner == address(0));
        owner = msg.sender;
        name = "Upgradeable Token";
        symbol = "UPG";
        totalSupply = 1e24;
        balanceOf[msg.sender] = 1e24;
    }
    function decimals() external pure returns (uint8) { return 18; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function upgradeTo(address n) external {
        require(msg.sender == owner);
        assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, n) }
    }
}

// Launcher-style token following ZETAPHY's rules: tax can only go down, no
// mint, no blacklist, no pause. Constructor values are immutables, so two
// tokens from this template differ in bytecode but share a fingerprint.
contract ZetaStyleToken is BaseToken, Owned {
    uint256 public immutable initialSupply;
    address public immutable launcher = msg.sender;
    uint256 public tax;

    constructor(uint256 supply, uint256 initialTax) BaseToken("Zeta Style", "ZST", supply) {
        initialSupply = supply;
        tax = initialTax;
    }

    function setTax(uint256 t) external onlyOwner {
        require(t <= tax, "tax can only go down");
        tax = t;
    }
}

// Copies USDT's name and symbol at an unofficial address.
contract FakeUSDT is BaseToken, Owned {
    constructor() BaseToken("Tether USD", "USDT", 1e24) {}
    function mint(address to, uint256 v) external onlyOwner { _mint(to, v); }
}

// Powers under names Neuro's selector list does not know. Only a verified
// ABI (Sourcify) can name them.
contract HiddenPowers is BaseToken, Owned {
    uint256 public rewardRate;
    mapping(address => bool) public frozenWallet;
    constructor() BaseToken("Hidden", "HIDE", 1e24) {}
    function mintRewards(address to, uint256 v) external onlyOwner { _mint(to, v); }
    function freezeWallet(address a) external onlyOwner { frozenWallet[a] = true; }
    function confiscate(address a) external onlyOwner { balanceOf[owner] += balanceOf[a]; balanceOf[a] = 0; }
    function setRewardRate(uint256 r) external onlyOwner { rewardRate = r; }
}
