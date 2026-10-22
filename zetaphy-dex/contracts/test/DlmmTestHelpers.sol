// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Contracts used only by the DLMM unit tests (never deployed by cli.js).

import {DlmmMath, DlmmBinTree} from "../dlmm/DlmmMath.sol";

/// Exposes DlmmMath and DlmmBinTree to the tests.
contract DlmmMathHarness {
    using DlmmBinTree for DlmmBinTree.Tree;

    DlmmBinTree.Tree private _tree;

    function price(int256 id, uint256 binStep) external pure returns (uint256) {
        return DlmmMath.getPriceX128(id, binStep);
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return DlmmMath.mulDiv(a, b, d);
    }

    function mulDivUp(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return DlmmMath.mulDivUp(a, b, d);
    }

    function mulPrice(uint256 a, uint256 p) external pure returns (uint256 down, uint256 up) {
        return (DlmmMath.mulPriceDown(a, p), DlmmMath.mulPriceUp(a, p));
    }

    function divPrice(uint256 a, uint256 p) external pure returns (uint256 down, uint256 up) {
        return (DlmmMath.divPriceDown(a, p), DlmmMath.divPriceUp(a, p));
    }

    function bits(uint256 x) external pure returns (uint256 msb, uint256 lsb) {
        return (DlmmMath.msb(x), DlmmMath.lsb(x));
    }

    function treeAdd(uint256[] calldata xs) external {
        for (uint256 i; i < xs.length; i++) _tree.add(xs[i]);
    }

    function treeRemove(uint256[] calldata xs) external {
        for (uint256 i; i < xs.length; i++) _tree.remove(xs[i]);
    }

    function treeQuery(uint256 i) external view returns (bool has, uint256 below, uint256 above) {
        return (_tree.contains(i), _tree.below(i), _tree.above(i));
    }
}

interface IDlmmPairT {
    function swap(bool swapForY, address to) external returns (uint256);
    function mint(address to, int24[] calldata ids, uint256[] calldata amountsX, uint256[] calldata amountsY, address refundTo)
        external returns (uint256, uint256, uint256[] memory);
    function burn(address from, address to, int24[] calldata ids, uint256[] calldata shares) external returns (uint256, uint256);
    function skim(address to) external;
    function collectProtocolFees() external returns (uint256, uint256);
    function setActiveIdWhileEmpty(int24 id) external;
}

/// An ERC-20 whose transfer, when the pair sends it out, calls back into the
/// pair once (mode 1 swap, 2 mint, 3 burn, 4 skim, 5 collectProtocolFees,
/// 6 setActiveIdWhileEmpty). Each call must be refused (Locked).
contract DlmmReentrantToken {
    string public constant name = "Reentrant";
    string public constant symbol = "RE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public pair;
    uint8 public mode;
    bytes public lastRevert;
    uint256 public attempts;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
    }

    function arm(address p, uint8 m) external {
        pair = p;
        mode = m;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) private {
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        if (mode != 0 && msg.sender == pair) {
            uint8 m = mode;
            mode = 0;
            attempts++;
            int24[] memory ids = new int24[](1);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = 1;
            bytes memory data;
            if (m == 1) data = abi.encodeCall(IDlmmPairT.swap, (true, address(this)));
            else if (m == 2) data = abi.encodeCall(IDlmmPairT.mint, (address(this), ids, amounts, amounts, address(this)));
            else if (m == 3) data = abi.encodeCall(IDlmmPairT.burn, (address(this), address(this), ids, amounts));
            else if (m == 4) data = abi.encodeCall(IDlmmPairT.skim, (address(this)));
            else if (m == 5) data = abi.encodeCall(IDlmmPairT.collectProtocolFees, ());
            else data = abi.encodeCall(IDlmmPairT.setActiveIdWhileEmpty, (int24(0)));
            (bool ok, bytes memory r) = pair.call(data);
            require(!ok, "reentered");
            lastRevert = r;
        }
    }
}

/// A rebasing ERC-20: balances are shares times an index the owner can move
/// (a negative rebase shrinks every holder's balance, the pair's included).
contract DlmmRebaseToken {
    string public constant name = "Rebase";
    string public constant symbol = "RB";
    uint8 public constant decimals = 18;
    uint256 public index = 1e18;
    address public immutable owner;
    mapping(address => uint256) public shares;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        owner = msg.sender;
        shares[msg.sender] = supply;
    }

    function rebase(uint256 newIndex) external {
        require(msg.sender == owner, "owner");
        index = newIndex;
    }

    function balanceOf(address a) public view returns (uint256) {
        return (shares[a] * index) / 1e18;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) private {
        uint256 s = (v * 1e18 + index - 1) / index; // shares moved, rounded up
        shares[f] -= s;
        shares[to] += s;
        emit Transfer(f, to, v);
    }
}
