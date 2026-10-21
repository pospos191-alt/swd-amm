// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ZETAPHY DEX router (MIT, written from scratch). The functions keep the
// Uniswap V2 router's names and argument order, so wallets that decode V2
// calls show them; "ETH" in a name means the chain's native coin (ZETAPHY,
// ticker ZTPHY), which the router wraps through WETH():
//   - on ZETAPHY: the native ERC-20 precompile 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
//     (Cosmos EVM's WERC20: its balanceOf is the native balance, transfer moves
//     native coins, deposit() gives the coins straight back, withdraw() is a no-op);
//   - elsewhere (and in the unit tests): the WZETAPHY contract, a classic WETH.
// The router works with both, because it only relies on deposit, withdraw,
// transfer and balanceOf.
//
// Every function checks a deadline; every swap and liquidity call takes a
// minimum (or maximum) amount, so the caller sets the slippage it accepts.
// The *SupportingFeeOnTransferTokens functions work with tokens that take a
// cut on transfer: they measure what each pair actually received.
//
// Neuro: when governance set factory.threatRegistry() (zero = off), the
// router refuses to swap INTO, or add liquidity with, a token whose flag is
// enforced in Neuro's ThreatRegistry (isContractEnforced: the token's address
// on this chain, or its exact code). Selling such a token and removing
// liquidity always work, so nobody is locked in. A flag is automated,
// reproducible code analysis, not an accusation (docs/LEGAL.md).
//
// Governance's reach over the router (stated plainly, see README):
//   - the registry check FAILS CLOSED: if the registry governance set stops
//     answering (reverts, returns junk, or needs more than REGISTRY_GAS), or
//     answers "enforced" for everything, every swap into a token other than
//     the native coin, and every add of liquidity, is refused router-wide.
//     Selling into the native coin and removing liquidity never ask the
//     registry, so they keep working; the pairs themselves never ask it either.
//     Governance lifts such a stop by setting the registry to zero.
//   - sweep(to): native coins that reached the router outside a call (a
//     precompile transfer, a self-destruct) can be sent on by governance. The
//     router holds no user funds between calls, so nothing of a user's is reachable.
//
// First deposit: while a pair's totalSupply is 0 (nobody has minted LP yet),
// addLiquidity takes the desired amounts as given, even if someone donated
// tokens and called sync() so that the reserves are not zero. The donation
// then belongs to the first LP, and the first LP's price is not set by
// whoever made the donation (security finding M3).

interface IFactory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
    function threatRegistry() external view returns (address);
    function governance() external view returns (address);
    function PAIR_CODE_HASH() external view returns (bytes32);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function totalSupply() external view returns (uint256);
    function mint(address to) external returns (uint256);
    function burn(address to) external returns (uint256, uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IWNative {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

interface IThreatView {
    function isContractEnforced(address who) external view returns (bool enforced, uint8 reason);
}

contract ZetaphyRouter {
    address public immutable factory;
    address public immutable WETH;
    bytes32 private immutable pairCodeHash;

    /// Gas given to each ThreatRegistry query: a registry that needs more fails closed (RegistryUnavailable).
    uint256 public constant REGISTRY_GAS = 100_000;

    error Expired();
    error InvalidPath();
    error InsufficientAAmount();
    error InsufficientBAmount();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error ExcessiveInputAmount();
    error IdenticalAddresses();
    error ZeroAddress();
    error TransferFailed();
    error NativeTransferFailed();
    error OnlyWNative();
    error NotGovernance();
    /// Neuro's ThreatRegistry has an enforced flag on this token (reason: ThreatRegistry.Reason).
    error TokenEnforced(address token, uint8 reason);
    /// The ThreatRegistry governance set did not answer (within REGISTRY_GAS); fails closed.
    error RegistryUnavailable();

    event Swept(address indexed to, uint256 amount);

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address factory_, address wnative) {
        if (factory_ == address(0) || wnative == address(0)) revert ZeroAddress();
        factory = factory_;
        WETH = wnative;
        pairCodeHash = IFactory(factory_).PAIR_CODE_HASH();
    }

    /// Native coins only come from WZETAPHY.withdraw (the precompile moves them without a call).
    receive() external payable {
        if (msg.sender != WETH) revert OnlyWNative();
    }

    /// Governance only: sends the router's whole native balance to `to`. Coins
    /// can only be there by mistake (a precompile transfer or a self-destruct
    /// skips receive()); the router holds no user funds between calls.
    function sweep(address to) external {
        if (msg.sender != IFactory(factory).governance()) revert NotGovernance();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        _sendNative(to, amount);
        emit Swept(to, amount);
    }

    // ---- Neuro ----

    /// Reverts with TokenEnforced if the registry (when set) has an enforced flag on `token`.
    function _refuseEnforced(address registry, address token) private view {
        if (token == WETH) return;
        (bool ok, bytes memory r) = registry.staticcall{gas: REGISTRY_GAS}(abi.encodeCall(IThreatView.isContractEnforced, (token)));
        if (!ok || r.length < 64) revert RegistryUnavailable();
        (bool enforced, uint8 reason) = abi.decode(r, (bool, uint8));
        if (enforced) revert TokenEnforced(token, reason);
    }

    /// Every token a swap along `path` receives into a pool or hands out (path[1..]); not the one sold.
    function _checkPath(address[] calldata path) private view {
        address registry = IFactory(factory).threatRegistry();
        if (registry == address(0)) return;
        for (uint256 i = 1; i < path.length; i++) _refuseEnforced(registry, path[i]);
    }

    function _checkPair(address a, address b) private view {
        address registry = IFactory(factory).threatRegistry();
        if (registry == address(0)) return;
        _refuseEnforced(registry, a);
        _refuseEnforced(registry, b);
    }

    // ---- library ----

    function sortTokens(address tokenA, address tokenB) public pure returns (address token0, address token1) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
    }

    /// The pair's CREATE2 address (it may not exist yet).
    function pairFor(address tokenA, address tokenB) public view returns (address) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", factory, keccak256(abi.encodePacked(token0, token1)), pairCodeHash)))));
    }

    function getReserves(address tokenA, address tokenB) public view returns (uint256 reserveA, uint256 reserveB) {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint256 r0, uint256 r1,) = IPair(pairFor(tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (r0, r1) : (r1, r0);
    }

    /// The amount of B worth amountA at the current price (no fee, no price impact).
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256) {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        return (amountA * reserveB) / reserveA;
    }

    /// Output for an exact input, after the 0.3% fee.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// Input needed for an exact output, after the 0.3% fee (rounded up).
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut == 0 || amountOut >= reserveOut) revert InsufficientLiquidity();
        return (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 rIn, uint256 rOut) = getReserves(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) public view returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 rIn, uint256 rOut) = getReserves(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
    }

    // ---- token transfers ----

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }

    function _sendNative(address to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert NativeTransferFailed();
    }

    /// Wraps `amount` of the native coin and sends it to `pair`.
    function _wrapTo(address pair, uint256 amount) private {
        IWNative(WETH).deposit{value: amount}();
        _safeTransfer(WETH, pair, amount);
    }

    // ---- add liquidity ----

    function _addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin)
        private returns (uint256 amountA, uint256 amountB)
    {
        _checkPair(tokenA, tokenB);
        address pair = IFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) pair = IFactory(factory).createPair(tokenA, tokenB);
        (uint256 reserveA, uint256 reserveB) = getReserves(tokenA, tokenB);
        // No LP minted yet: a new pool, whatever the reserves (a donation + sync
        // must not set the first LP's price). The first LP sets it and gets the donation.
        if (IPair(pair).totalSupply() == 0 || (reserveA == 0 && reserveB == 0)) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) revert InsufficientBAmount();
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
                // amountAOptimal <= amountADesired here
                if (amountAOptimal < amountAMin) revert InsufficientAAmount();
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired,
        uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = pairFor(tokenA, tokenB);
        _safeTransferFrom(tokenA, msg.sender, pair, amountA);
        _safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IPair(pair).mint(to);
    }

    /// msg.value is the most native coin to add; the rest is refunded.
    function addLiquidityETH(
        address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (amountToken, amountETH) = _addLiquidity(token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);
        address pair = pairFor(token, WETH);
        _safeTransferFrom(token, msg.sender, pair, amountToken);
        _wrapTo(pair, amountETH);
        liquidity = IPair(pair).mint(to);
        if (msg.value > amountETH) _sendNative(msg.sender, msg.value - amountETH);
    }

    // ---- remove liquidity ----

    function removeLiquidity(
        address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = pairFor(tokenA, tokenB);
        if (!IPair(pair).transferFrom(msg.sender, pair, liquidity)) revert TransferFailed();
        (uint256 amount0, uint256 amount1) = IPair(pair).burn(to);
        (address token0,) = sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    function removeLiquidityETH(
        address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline
    ) public ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        (amountToken, amountETH) = removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
        _safeTransfer(token, to, amountToken);
        IWNative(WETH).withdraw(amountETH);
        _sendNative(to, amountETH);
    }

    /// For tokens that take a cut on transfer: passes on whatever token amount the router received.
    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline
    ) public ensure(deadline) returns (uint256 amountETH) {
        (, amountETH) = removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
        _safeTransfer(token, to, IERC20Min(token).balanceOf(address(this)));
        IWNative(WETH).withdraw(amountETH);
        _sendNative(to, amountETH);
    }

    // ---- swaps (exact amounts known up front) ----

    /// amounts[0] must already be in the first pair.
    function _swap(uint256[] memory amounts, address[] calldata path, address _to) private {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? pairFor(output, path[i + 2]) : _to;
            IPair(pairFor(input, output)).swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256[] memory amounts)
    {
        _checkPath(path);
        amounts = getAmountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256[] memory amounts)
    {
        _checkPath(path);
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external payable ensure(deadline) returns (uint256[] memory amounts)
    {
        if (path[0] != WETH) revert InvalidPath();
        _checkPath(path);
        amounts = getAmountsOut(msg.value, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        _wrapTo(pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256[] memory amounts)
    {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        _checkPath(path);
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWNative(WETH).withdraw(amounts[amounts.length - 1]);
        _sendNative(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256[] memory amounts)
    {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        _checkPath(path);
        amounts = getAmountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWNative(WETH).withdraw(amounts[amounts.length - 1]);
        _sendNative(to, amounts[amounts.length - 1]);
    }

    /// msg.value is the most native coin to spend; the rest is refunded.
    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external payable ensure(deadline) returns (uint256[] memory amounts)
    {
        if (path[0] != WETH) revert InvalidPath();
        _checkPath(path);
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > msg.value) revert ExcessiveInputAmount();
        _wrapTo(pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
        if (msg.value > amounts[0]) _sendNative(msg.sender, msg.value - amounts[0]);
    }

    // ---- swaps (fee-on-transfer tokens: amounts measured as they arrive) ----

    function _swapSupportingFeeOnTransferTokens(address[] calldata path, address _to) private {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = sortTokens(input, output);
            IPair pair = IPair(pairFor(input, output));
            uint256 amountOutput;
            {
                (uint256 r0, uint256 r1,) = pair.getReserves();
                (uint256 reserveIn, uint256 reserveOut) = input == token0 ? (r0, r1) : (r1, r0);
                uint256 amountInput = IERC20Min(input).balanceOf(address(pair)) - reserveIn;
                amountOutput = getAmountOut(amountInput, reserveIn, reserveOut);
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? pairFor(output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external ensure(deadline) {
        if (path.length < 2) revert InvalidPath();
        _checkPath(path);
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amountIn);
        address last = path[path.length - 1];
        uint256 before = IERC20Min(last).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        if (IERC20Min(last).balanceOf(to) - before < amountOutMin) revert InsufficientOutputAmount();
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external payable ensure(deadline) {
        if (path.length < 2 || path[0] != WETH) revert InvalidPath();
        _checkPath(path);
        _wrapTo(pairFor(path[0], path[1]), msg.value);
        address last = path[path.length - 1];
        uint256 before = IERC20Min(last).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        if (IERC20Min(last).balanceOf(to) - before < amountOutMin) revert InsufficientOutputAmount();
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external ensure(deadline) {
        if (path.length < 2 || path[path.length - 1] != WETH) revert InvalidPath();
        _checkPath(path);
        _safeTransferFrom(path[0], msg.sender, pairFor(path[0], path[1]), amountIn);
        // With the precompile, WETH.balanceOf(router) is the router's native
        // balance, which may hold coins of its own: measure the difference.
        uint256 before = IERC20Min(WETH).balanceOf(address(this));
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IERC20Min(WETH).balanceOf(address(this)) - before;
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();
        IWNative(WETH).withdraw(amountOut);
        _sendNative(to, amountOut);
    }
}
