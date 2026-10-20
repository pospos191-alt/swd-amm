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

// ---------------------------------------------------------------------------
// Trade simulation (honeypot check). A minimal Uniswap-V2-style DEX with the
// same function names and math as the real one, and tokens that misbehave
// only when traded. The DEX contracts keep no state from their constructors
// (except the router's immutables), so tests can copy their code to the real
// DEX addresses in src/chains.js.

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract MockWETH {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    receive() external payable { balanceOf[msg.sender] += msg.value; }
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 v) external {
        balanceOf[msg.sender] -= v;
        (bool ok, ) = msg.sender.call{value: v}("");
        require(ok, "eth");
    }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (f != msg.sender) allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract MockPair {
    address public factory;
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;

    function init(address a, address b) external { require(factory == address(0)); factory = msg.sender; token0 = a; token1 = b; }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }
    function sync() external {
        r0 = uint112(IERC20Like(token0).balanceOf(address(this)));
        r1 = uint112(IERC20Like(token1).balanceOf(address(this)));
    }
    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        require(out0 > 0 || out1 > 0, "no output");
        (uint256 _r0, uint256 _r1) = (r0, r1);
        require(out0 < _r0 && out1 < _r1, "liquidity");
        if (out0 > 0) require(IERC20Like(token0).transfer(to, out0));
        if (out1 > 0) require(IERC20Like(token1).transfer(to, out1));
        uint256 b0 = IERC20Like(token0).balanceOf(address(this));
        uint256 b1 = IERC20Like(token1).balanceOf(address(this));
        uint256 in0 = b0 > _r0 - out0 ? b0 - (_r0 - out0) : 0;
        uint256 in1 = b1 > _r1 - out1 ? b1 - (_r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "no input");
        require((b0 * 1000 - in0 * 3) * (b1 * 1000 - in1 * 3) >= _r0 * _r1 * 1e6, "K");
        r0 = uint112(b0);
        r1 = uint112(b1);
    }
}

contract MockFactory {
    mapping(address => mapping(address => address)) public getPair;
    function createPair(address a, address b) external returns (address p) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        MockPair pair = new MockPair();
        pair.init(t0, t1);
        p = address(pair);
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}

contract MockRouter {
    address public immutable factory;
    address public immutable WETH;
    constructor(address f, address w) { factory = f; WETH = w; }
    receive() external payable {}

    function _pair(address a, address b) internal view returns (MockPair p) {
        p = MockPair(MockFactory(factory).getPair(a, b));
        require(address(p) != address(0), "no pair");
    }
    function _reserves(MockPair p, address input) internal view returns (uint256 rIn, uint256 rOut) {
        (uint112 a, uint112 b, ) = p.getReserves();
        (rIn, rOut) = input == p.token0() ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
    }
    function _out(uint256 aIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        require(aIn > 0 && rIn > 0 && rOut > 0, "amount");
        uint256 f = aIn * 997;
        return f * rOut / (rIn * 1000 + f);
    }
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2);
        (uint256 rIn, uint256 rOut) = _reserves(_pair(path[0], path[1]), path[0]);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _out(amountIn, rIn, rOut);
    }
    function _swap(address input, address output, address to) internal {
        MockPair p = _pair(input, output);
        (uint256 rIn, uint256 rOut) = _reserves(p, input);
        uint256 aOut = _out(IERC20Like(input).balanceOf(address(p)) - rIn, rIn, rOut);
        (uint256 o0, uint256 o1) = input == p.token0() ? (uint256(0), aOut) : (aOut, uint256(0));
        p.swap(o0, o1, to, "");
    }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] calldata path, address to, uint256) external payable {
        require(path[0] == WETH);
        MockWETH(payable(WETH)).deposit{value: msg.value}();
        require(MockWETH(payable(WETH)).transfer(address(_pair(path[0], path[1])), msg.value));
        uint256 before = IERC20Like(path[1]).balanceOf(to);
        _swap(path[0], path[1], to);
        require(IERC20Like(path[1]).balanceOf(to) - before >= minOut, "slippage");
    }
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256) external {
        require(path[1] == WETH);
        require(IERC20Like(path[0]).transferFrom(msg.sender, address(_pair(path[0], path[1])), amountIn));
        _swap(path[0], path[1], address(this));
        uint256 out = MockWETH(payable(WETH)).balanceOf(address(this));
        require(out >= minOut, "slippage");
        MockWETH(payable(WETH)).withdraw(out);
        (bool ok, ) = to.call{value: out}("");
        require(ok, "eth");
    }
}

// Takes a tax on buys (from the pool) and sells (to the pool), in basis
// points. The owner is exempt so it can add liquidity.
contract TaxToken is BaseToken, Owned {
    address public pool;
    uint256 public immutable buyBps;
    uint256 public immutable sellBps;
    constructor(uint256 b, uint256 s) BaseToken("Taxed", "TAX", 1e27) { buyBps = b; sellBps = s; }
    function setPool(address p) external onlyOwner { pool = p; }
    function _move(address f, address to, uint256 v) internal override {
        uint256 bps = (f == owner || to == owner) ? 0 : f == pool ? buyBps : to == pool ? sellBps : 0;
        uint256 fee = v * bps / 10000;
        super._move(f, to, v - fee);
        if (fee > 0) super._move(f, owner, fee);
    }
}

// A honeypot behind a harmless name: only the owner may send tokens to the
// pool, so everyone else can buy but never sell. No function name gives it away.
contract QuietHoneypot is BaseToken, Owned {
    address private lp;
    constructor() BaseToken("Quiet", "QUIET", 1e27) {}
    function syncRewards(address p) external onlyOwner { lp = p; }
    function _move(address f, address to, uint256 v) internal override {
        require(to != lp || f == owner, "");
        super._move(f, to, v);
    }
}

// Trading not open yet: nothing can leave the pool.
contract NotLaunched is BaseToken, Owned {
    address private lp;
    constructor() BaseToken("Soon", "SOON", 1e27) {}
    function prepare(address p) external onlyOwner { lp = p; }
    function _move(address f, address to, uint256 v) internal override {
        require(f != lp, "not open");
        super._move(f, to, v);
    }
}
