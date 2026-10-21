// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only contracts for the oracle, gateway and timelock tests (never under contracts/).

interface IPairLike {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}
interface IERC20Like {
    function transfer(address to, uint256 v) external returns (bool);
}
interface IOracleLike {
    function price(address asset) external view returns (uint256, uint256);
    function poke(address asset) external returns (bool);
}

/// IPyth's read side with any value (negative, future-dated, wide...), unlike the relay.
contract MockPyth {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    mapping(bytes32 => Price) private _p;
    function set(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external { _p[id] = Price(price, conf, expo, publishTime); }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        require(_p[id].publishTime != 0, "PriceFeedNotFound");
        return _p[id];
    }
}

/// ZetaphyOracle's consumer side with a set price, or a revert.
contract MockPriceOracle {
    mapping(address => uint256) public value;
    mapping(address => bool) public down;
    error Unavailable(address asset);
    function set(address asset, uint256 v) external { value[asset] = v; }
    function setDown(address asset, bool d) external { down[asset] = d; }
    function price(address asset) external view returns (uint256, uint256) {
        if (down[asset]) revert Unavailable(asset);
        return (value[asset], block.timestamp);
    }
}

/// Swaps `amountIn` of the token it holds into the pair and, in the same transaction,
/// pokes and reads the oracle: what a flash-loan attacker can do within one block.
contract SameBlockAttacker {
    event Result(bool poked, bool priced, uint256 value, bytes reason);

    function attack(address pair, address tokenIn, uint256 amountIn, address oracle, address asset) external {
        _swap(pair, tokenIn, amountIn);
        bool poked = IOracleLike(oracle).poke(asset);
        try IOracleLike(oracle).price(asset) returns (uint256 v, uint256) { emit Result(poked, true, v, ""); }
        catch (bytes memory r) { emit Result(poked, false, 0, r); }
    }

    /// Only the swap (the pool stays pushed at the end of this block).
    function push(address pair, address tokenIn, uint256 amountIn) external { _swap(pair, tokenIn, amountIn); }

    function _swap(address pair, address tokenIn, uint256 amountIn) private {
        (uint112 r0, uint112 r1, ) = IPairLike(pair).getReserves();
        bool in0 = IPairLike(pair).token0() == tokenIn;
        (uint256 rin, uint256 rout) = in0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 out = (amountIn * 997 * rout) / (rin * 1000 + amountIn * 997);
        IERC20Like(tokenIn).transfer(pair, amountIn);
        IPairLike(pair).swap(in0 ? 0 : out, in0 ? out : 0, address(this), "");
    }
}

/// Calls a target with data (a contract proposer / executor stand-in).
contract Caller {
    function call(address to, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        return ret;
    }
}
