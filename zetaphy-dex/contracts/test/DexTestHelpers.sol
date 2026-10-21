// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Contracts used only by the unit tests (never deployed by cli.js).

interface IPairT {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256, uint256, address, bytes calldata) external;
    function sync() external;
    function skim(address) external;
    function mint(address) external returns (uint256);
    function burn(address) external returns (uint256, uint256);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IERC20T {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// A flash borrower: takes the output, then pays back `repayBps` of what it
/// must (10000 = exactly enough with the 0.3% fee) in the borrowed token.
contract FlashBorrower {
    uint256 public repayBps = 10_000;
    address public lastSender;
    function setRepayBps(uint256 b) external { repayBps = b; }

    function borrow(address pair, uint256 amount0Out, uint256 amount1Out) external {
        IPairT(pair).swap(amount0Out, amount1Out, address(this), abi.encode(pair));
    }

    function zetaphyDexCall(address sender, uint256 amount0Out, uint256 amount1Out, bytes calldata data) external {
        address pair = abi.decode(data, (address));
        require(msg.sender == pair, "not pair");
        lastSender = sender;
        if (amount0Out > 0) _repay(IPairT(pair).token0(), pair, amount0Out);
        if (amount1Out > 0) _repay(IPairT(pair).token1(), pair, amount1Out);
    }

    function _repay(address token, address pair, uint256 out) private {
        // Same-token repayment: (balance*1000 - in*3) >= reserve*1000 needs in >= out*1000/997.
        uint256 owed = (out * 1000) / 997 + 1;
        IERC20T(token).transfer(pair, (owed * repayBps) / 10_000);
    }
}

/// An ERC-20 whose transfer can call back into a pair (a hostile token): every
/// entry point of the pair must refuse with Locked() while one is running.
contract ReentrantToken {
    string public constant name = "Reentrant";
    string public constant symbol = "RE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public pair;
    uint8 public mode; // 0 off, 1 swap, 2 sync, 3 skim, 4 mint, 5 burn
    bytes public lastRevert;
    uint256 public attempts;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; }
    function arm(address p, uint8 m) external { pair = p; mode = m; }

    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
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
            mode = 0; // once
            attempts++;
            bytes memory call;
            if (m == 1) call = abi.encodeCall(IPairT.swap, (1, 0, address(this), ""));
            else if (m == 2) call = abi.encodeCall(IPairT.sync, ());
            else if (m == 3) call = abi.encodeCall(IPairT.skim, (address(this)));
            else if (m == 4) call = abi.encodeCall(IPairT.mint, (address(this)));
            else call = abi.encodeCall(IPairT.burn, (address(this)));
            (bool ok, bytes memory r) = pair.call(call);
            require(!ok, "reentered");
            lastRevert = r;
        }
    }
}

/// Stands in for NeuroJobs' runner list (ThreatRegistry asks it who may vote).
contract MockRunners {
    mapping(address => bool) public on;
    function set(address a, bool v) external { on[a] = v; }
    function workers(address a) external view returns (uint128, uint64, bool, uint32, uint32) { return (100, 0, on[a], on[a] ? 5 : 0, 0); }
}

/// Checks that a reverted call leaves native balances exactly as they were
/// (security note S1: the DEX trusts the native ERC-20 precompile's balances,
/// so the chain must undo precompile transfers made inside a reverting call).
/// probe() runs `calls` inside a sub-call (this.run). With undo = true the
/// sub-call always reverts at the end (Undo, or Failed(i, data) if a call
/// failed first); with undo = false it keeps the calls' effects (only a failed
/// call reverts it). The balances of `watch` and of this contract, read both as
/// address.balance and through `wnative`.balanceOf, are reported in Probed; the
/// rest of this contract's native balance goes back to the caller at the end.
contract RevertProbe {
    struct Call { address target; uint256 value; bytes data; }
    struct Balances { uint256 watchNative; uint256 watchWrapped; uint256 selfNative; uint256 selfWrapped; }

    error Undo();
    error Failed(uint256 index, bytes data);
    error RefundFailed();

    event Probed(Balances before, Balances afterwards, bool reverted, bytes revertData);

    function _balances(address wnative, address watch) private view returns (Balances memory b) {
        b.watchNative = watch.balance;
        b.watchWrapped = IERC20T(wnative).balanceOf(watch);
        b.selfNative = address(this).balance;
        b.selfWrapped = IERC20T(wnative).balanceOf(address(this));
    }

    function probe(Call[] calldata calls, bool undo, address wnative, address watch)
        external payable returns (Balances memory before, Balances memory afterwards, bool reverted, bytes memory revertData)
    {
        before = _balances(wnative, watch);
        try this.run(calls, undo) {
            reverted = false;
        } catch (bytes memory r) {
            reverted = true;
            revertData = r;
        }
        afterwards = _balances(wnative, watch);
        emit Probed(before, afterwards, reverted, revertData);
        (bool ok,) = msg.sender.call{value: address(this).balance}("");
        if (!ok) revert RefundFailed();
    }

    function run(Call[] calldata calls, bool undo) external {
        require(msg.sender == address(this), "self only");
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory r) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert Failed(i, r);
        }
        if (undo) revert Undo();
    }

    receive() external payable {}
}

/// A registry stand-in that answers "not enforced" after burning `burn` gas:
/// with burn above the router's REGISTRY_GAS it stops answering in time, and
/// the router fails closed (RegistryUnavailable).
contract GasHogRegistry {
    uint256 public burn;
    function setBurn(uint256 b) external { burn = b; }
    function isContractEnforced(address) external view returns (bool, uint8) {
        uint256 start = gasleft();
        uint256 x;
        while (start - gasleft() < burn) x++;
        return (false, 0);
    }
}

/// Sends its value to `to` without calling it (SELFDESTRUCT in the
/// constructor), the way stray native coins can reach the router.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}
