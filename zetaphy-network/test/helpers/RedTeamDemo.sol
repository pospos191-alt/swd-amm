// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: deliberately vulnerable demo targets for the red team (test/redteam.test.js, docs/future/red-team.md).
// Each one has ONE textbook bug that a strategy of src/redteam/strategies.js must find, plus a SafeBank that has
// none (no false positive). The S1 pause demo uses SelfHealKit's HealVault (opted in to CircuitBreaker). Never deploy any of this outside a local test chain / fork.

contract DemoToken {
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(string memory s) { symbol = s; }
    function mint(address to, uint256 v) external { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v);
        return true;
    }
    function _move(address f, address to, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}

/// Reentrancy: pays before it zeroes the balance.
contract ReentrantBank {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        uint256 a = balances[msg.sender];
        require(a > 0, "empty");
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
        balances[msg.sender] = 0;
    }
    function totalHeld() external view returns (uint256) { return address(this).balance; }
}

/// The same bank done right (effects before interactions): the red team must find nothing here.
contract SafeBank {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        uint256 a = balances[msg.sender];
        require(a > 0, "empty");
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "send");
    }
}

/// Access control: `setOwner` forgot onlyOwner; `drain` trusts it.
contract OpenOwnerVault {
    address public owner;
    constructor() payable { owner = msg.sender; }
    receive() external payable {}
    function setOwner(address o) external { owner = o; }
    function drain(address to) external {
        require(msg.sender == owner, "owner");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "send");
    }
}

/// Signature replay: a signed payout voucher binds neither the recipient nor a nonce.
contract SigVouchers {
    address public immutable signer;
    constructor(address s) payable { signer = s; }
    receive() external payable {}
    function claim(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(address(this), amount))));
        require(ecrecover(h, v, r, s) == signer, "sig");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }
}

/// Rounding: withdraw(assets) burns assets * shares / totalAssets, rounded DOWN (0 for a small enough amount).
contract RoundingVault {
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    function deposit() external payable {
        uint256 before = address(this).balance - msg.value;
        uint256 s = totalShares == 0 || before == 0 ? msg.value : msg.value * totalShares / before;
        shares[msg.sender] += s;
        totalShares += s;
    }
    /// Yield arrives without new shares (the share price goes up).
    function harvest() external payable {}
    function withdraw(uint256 assets) external {
        uint256 burn = assets * totalShares / address(this).balance; // BUG: rounds down, should round up
        require(shares[msg.sender] >= burn, "shares");
        shares[msg.sender] -= burn;
        totalShares -= burn;
        (bool ok, ) = msg.sender.call{value: assets}("");
        require(ok, "send");
    }
}

/// Price manipulation: buys tokenA for tokenB at the pair's SPOT price (reserves), no TWAP, no cap.
interface IDemoPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

contract SpotBuyback {
    IDemoPair public immutable pair;
    DemoToken public immutable tokenA;
    DemoToken public immutable tokenB;
    constructor(IDemoPair p, DemoToken a, DemoToken b) { pair = p; tokenA = a; tokenB = b; }
    function priceA() public view returns (uint256) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        (uint256 ra, uint256 rb) = pair.token0() == address(tokenA) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        return rb * 1e18 / ra;
    }
    function sell(uint256 amountA) external {
        uint256 pay = amountA * priceA() / 1e18;
        tokenA.transferFrom(msg.sender, address(this), amountA);
        tokenB.transfer(msg.sender, pay);
    }
}

/// An ERC-3156-style flash lender (fee 0.09%), the capital source of flash-loan sequences.
contract DemoFlashLender {
    bytes32 public constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    function flashFee(address, uint256 amount) public pure returns (uint256) { return amount * 9 / 10_000; }
    function maxFlashLoan(address token) external view returns (uint256) { return DemoToken(token).balanceOf(address(this)); }
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool) {
        uint256 fee = flashFee(token, amount);
        DemoToken(token).transfer(receiver, amount);
        (bool ok, bytes memory ret) = receiver.call(abi.encodeWithSignature("onFlashLoan(address,address,uint256,uint256,bytes)", msg.sender, token, amount, fee, data));
        require(ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == CALLBACK_SUCCESS, "callback");
        DemoToken(token).transferFrom(receiver, address(this), amount + fee);
        return true;
    }
}
