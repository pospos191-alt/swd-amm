// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ZETAPHY DEX pair: a constant-product (x * y = k) pool of two tokens, written
// from scratch for ZETAPHY (MIT). The math and the interface follow the
// Uniswap V2 whitepaper (https://uniswap.org/whitepaper.pdf) so that tools
// that know V2 pools read it too, but no Uniswap source code is copied.
//
//   - fee: 0.3% of every input stays in the pool (LP fee);
//   - protocol fee: off by default. When governance sets factory.feeTo, 1/6
//     of the fee growth (0.05% of volume) is minted to feeTo as LP tokens,
//     on the next mint/burn (whitepaper section 2.4);
//   - TWAP: price0CumulativeLast / price1CumulativeLast accumulate the
//     UQ112.112 price times seconds, at the first touch of each block, before
//     the trade (overflow is intended: consumers take differences);
//   - MINIMUM_LIQUIDITY (1000 wei of LP) is locked at address(0) on the first
//     mint, so the share price can never be pushed to a level where nobody
//     can afford a share;
//   - every state-changing function holds one reentrancy lock;
//   - skim() sends out tokens above the reserves, sync() sets the reserves
//     to the balances;
//   - flash swaps: swap() sends the output first and, with data, calls
//     zetaphyDexCall on `to`; the K check after it needs the input (or the
//     output back plus the fee) to be in the pool by then.

interface IZetaphyFactoryForPair {
    function feeTo() external view returns (address);
    function pairParameters() external view returns (address token0, address token1);
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface IZetaphyDexCallee {
    function zetaphyDexCall(address sender, uint256 amount0Out, uint256 amount1Out, bytes calldata data) external;
}

contract ZetaphyPair {
    // ---- LP token (ERC-20) ----
    string public constant name = "ZETAPHY DEX LP";
    string public constant symbol = "ZLP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ---- pool ----
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    /// reserve0 * reserve1 after the last liquidity event (only kept while the protocol fee is on).
    uint256 public kLast;

    uint256 private unlocked = 1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    error Locked();
    error Overflow();
    error TransferFailed();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error K();
    error InsufficientAllowance();
    error InsufficientBalance();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    /// Created by the factory with CREATE2; the tokens come from the factory,
    /// so the init code (and so every pair's address) does not depend on them.
    constructor() {
        factory = msg.sender;
        (token0, token1) = IZetaphyFactoryForPair(msg.sender).pairParameters();
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ---- ERC-20 ----

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = a - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - value;
            balanceOf[to] += value; // cannot overflow: sum of balances == totalSupply
        }
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) private {
        balanceOf[from] -= value;
        unchecked { totalSupply -= value; }
        emit Transfer(from, address(0), value);
    }

    // ---- pool internals ----

    /// transfer(), accepting tokens that return nothing (USDT-style) but not ones that return false.
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }

    function _balance(address token) private view returns (uint256) {
        return IERC20Balance(token).balanceOf(address(this));
    }

    /// New reserves; on the block's first touch, the price accumulators grow by
    /// the price before this update times the seconds since the last one.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast; // wraps around, by design
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                // UQ112.112: (reserve1 << 112) / reserve0 fits in 224 bits; the products wrap, by design.
                price0CumulativeLast += ((uint256(_reserve1) << 112) / _reserve0) * timeElapsed;
                price1CumulativeLast += ((uint256(_reserve0) << 112) / _reserve1) * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// Protocol fee: 1/6 of the growth of sqrt(k) since the last liquidity event, as LP tokens to feeTo.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IZetaphyFactoryForPair(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = _sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = _sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 liquidity = (totalSupply * (rootK - rootKLast)) / (rootK * 5 + rootKLast);
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // ---- pool: called by the router (or anyone who transferred tokens in first) ----

    /// LP tokens for the tokens sent to the pair since the last update.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = _balance(token0);
        uint256 balance1 = _balance(token1);
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // after _mintFee, which may change it
        if (_totalSupply == 0) {
            uint256 root = _sqrt(amount0 * amount1);
            if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = root - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY); // locked forever
        } else {
            uint256 l0 = (amount0 * _totalSupply) / _reserve0;
            uint256 l1 = (amount1 * _totalSupply) / _reserve1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// Burns the LP tokens sent to the pair; their share of both tokens goes to `to`.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = _balance(_token0);
        uint256 balance1 = _balance(_token1);
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply; // pro rata of balances, not reserves
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = _balance(_token0);
        balance1 = _balance(_token1);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// Sends the outputs to `to` (then calls it back if `data` is not empty);
    /// the inputs must be in the pair by the end, such that the balances less
    /// 0.3% of the inputs keep k at least where it was.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        if (amount0Out >= _reserve0 || amount1Out >= _reserve1) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address _token0 = token0;
            address _token1 = token1;
            if (to == _token0 || to == _token1) revert InvalidTo();
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out); // optimistic
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
            if (data.length > 0) IZetaphyDexCallee(to).zetaphyDexCall(msg.sender, amount0Out, amount1Out, data);
            balance0 = _balance(_token0);
            balance1 = _balance(_token1);
        }
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            if (balance0Adjusted * balance1Adjusted < uint256(_reserve0) * _reserve1 * 1_000_000) revert K();
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// Sends whatever is above the reserves (e.g. tokens sent by mistake) to `to`.
    function skim(address to) external lock {
        address _token0 = token0;
        address _token1 = token1;
        _safeTransfer(_token0, to, _balance(_token0) - reserve0);
        _safeTransfer(_token1, to, _balance(_token1) - reserve1);
    }

    /// Sets the reserves to the balances (e.g. after a token's balance changed on its own).
    function sync() external lock {
        _update(_balance(token0), _balance(token1), reserve0, reserve1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
