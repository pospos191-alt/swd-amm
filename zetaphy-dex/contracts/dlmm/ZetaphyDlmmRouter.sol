// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// UNAUDITED. ZETAPHY DLMM router, testnet only.
// ============================================================================
//
// What users call: add / remove liquidity across a range of bins, and swap
// (exact in or exact out, one or more hops through DLMM pairs), each with a
// deadline and the caller's slippage limits. "NATIVE" in a name means the
// chain's coin, wrapped through WNATIVE (on ZETAPHY the native ERC-20
// precompile 0xEeee…EEeE, elsewhere WZETAPHY), exactly as ZetaphyRouter does.
//
//   - Liquidity: bins are given RELATIVE to the active bin (deltaIds), with
//     an explicit amount of X and Y for each (the distribution shape is the
//     client's choice, as in dlmm.rs). activeIdDesired + idSlippage bound how
//     far the price may have moved; amountXMin / amountYMin bound what is
//     actually deposited (a bin only takes amounts in its own ratio; the rest
//     comes back). A pair with no liquidity at all gets its active bin set to
//     activeIdDesired first: the first LP sets the price.
//   - Removing needs pair.setApprovalForAll(router, true) (the pair's share
//     ledger); amountXMin / amountYMin bound the result.
//   - Fee-on-transfer tokens are refused: what the router sends into a pair
//     must arrive in full (FeeOnTransferNotSupported). Rebasing tokens are
//     not supported either.
//   - Neuro: like ZetaphyRouter, with factory.threatRegistry() set the router
//     refuses to swap INTO, or add liquidity with, a token whose flag is
//     enforced (TokenEnforced); it fails closed (RegistryUnavailable).
//     Selling and removing liquidity never ask the registry.
//   - The router holds no funds between calls.

interface IDlmmFactoryR {
    function getPair(address, address, uint16) external view returns (address);
    function createPair(address, address, uint16, int24) external returns (address);
    function threatRegistry() external view returns (address);
    function governance() external view returns (address);
    function PAIR_CODE_HASH() external view returns (bytes32);
    function pairDeployer() external view returns (address);
}

interface IDlmmPairR {
    function tokenX() external view returns (address);
    function getActiveId() external view returns (int24);
    function reserveX() external view returns (uint128);
    function reserveY() external view returns (uint128);
    function setActiveIdWhileEmpty(int24 id) external;
    function swap(bool swapForY, address to) external returns (uint256);
    function mint(address to, int24[] calldata ids, uint256[] calldata amountsX, uint256[] calldata amountsY, address refundTo)
        external returns (uint256, uint256, uint256[] memory);
    function burn(address from, address to, int24[] calldata ids, uint256[] calldata shares) external returns (uint256, uint256);
    function getSwapIn(uint256 amountOut, bool swapForY) external view returns (uint256, uint256, uint256);
    function getSwapOut(uint256 amountIn, bool swapForY) external view returns (uint256, uint256, uint256);
}

interface IWNativeR {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
}

interface IThreatViewR {
    function isContractEnforced(address who) external view returns (bool enforced, uint8 reason);
}

contract ZetaphyDlmmRouter {
    address public immutable factory;
    address public immutable WNATIVE;
    address private immutable pairDeployer;
    bytes32 private immutable pairCodeHash;

    /// Gas given to each ThreatRegistry query (same as ZetaphyRouter).
    uint256 public constant REGISTRY_GAS = 100_000;

    struct LiquidityParams {
        address tokenX; // the lower address of the two
        address tokenY;
        uint16 binStep;
        int24 activeIdDesired;
        uint24 idSlippage;
        int24[] deltaIds; // strictly increasing, relative to the active bin
        uint256[] amountsX;
        uint256[] amountsY;
        uint256 amountXMin;
        uint256 amountYMin;
        address to;
        uint256 deadline;
    }

    /// tokens[i] -> tokens[i+1] through the pair with binSteps[i].
    struct Path {
        uint16[] binSteps;
        address[] tokens;
    }

    error Expired();
    error InvalidPath();
    error UnsortedTokens();
    error InvalidLength();
    error IdSlippage(int24 activeId);
    error IdOutOfRange();
    error InsufficientXAmount();
    error InsufficientYAmount();
    error InsufficientOutputAmount();
    error ExcessiveInputAmount();
    error InsufficientLiquidity();
    error FeeOnTransferNotSupported();
    error PairNotFound();
    error ZeroAddress();
    error TransferFailed();
    error NativeTransferFailed();
    error OnlyWNative();
    error NotGovernance();
    error WrongNativeAmount();
    error TokenEnforced(address token, uint8 reason);
    error RegistryUnavailable();

    event Swept(address indexed to, uint256 amount);

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address factory_, address wnative) {
        if (factory_ == address(0) || wnative == address(0)) revert ZeroAddress();
        factory = factory_;
        WNATIVE = wnative;
        pairCodeHash = IDlmmFactoryR(factory_).PAIR_CODE_HASH();
        pairDeployer = IDlmmFactoryR(factory_).pairDeployer();
    }

    /// Native coins only come from WZETAPHY.withdraw (the precompile moves them without a call).
    receive() external payable {
        if (msg.sender != WNATIVE) revert OnlyWNative();
    }

    /// Governance only: sends the router's whole native balance to `to` (coins that reached it by mistake).
    function sweep(address to) external {
        if (msg.sender != IDlmmFactoryR(factory).governance()) revert NotGovernance();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        _sendNative(to, amount);
        emit Swept(to, amount);
    }

    // =====================================================================
    // Views
    // =====================================================================

    /// The pair's CREATE2 address (it may not exist yet).
    function pairFor(address tokenA, address tokenB, uint16 binStep) public view returns (address) {
        (address x, address y) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", pairDeployer, keccak256(abi.encodePacked(x, y, binStep)), pairCodeHash)))));
    }

    /// Outputs of every hop for an exact input (reverts if a pair lacks liquidity).
    function getAmountsOut(uint256 amountIn, Path calldata path) public view returns (uint256[] memory amounts) {
        address[] memory pairs = _pairs(path);
        amounts = new uint256[](path.tokens.length);
        amounts[0] = amountIn;
        for (uint256 i; i < pairs.length; i++) {
            (uint256 left, uint256 out,) = IDlmmPairR(pairs[i]).getSwapOut(amounts[i], path.tokens[i] < path.tokens[i + 1]);
            if (left != 0) revert InsufficientLiquidity();
            amounts[i + 1] = out;
        }
    }

    /// Inputs of every hop for an exact output (reverts if a pair lacks liquidity).
    function getAmountsIn(uint256 amountOut, Path calldata path) public view returns (uint256[] memory amounts) {
        address[] memory pairs = _pairs(path);
        amounts = new uint256[](path.tokens.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = pairs.length; i > 0; i--) {
            (uint256 inNeeded, uint256 outLeft,) = IDlmmPairR(pairs[i - 1]).getSwapIn(amounts[i], path.tokens[i - 1] < path.tokens[i]);
            if (outLeft != 0) revert InsufficientLiquidity();
            amounts[i - 1] = inNeeded;
        }
    }

    // =====================================================================
    // Liquidity
    // =====================================================================

    function addLiquidity(LiquidityParams calldata p)
        external ensure(p.deadline) returns (uint256 usedX, uint256 usedY, int24[] memory ids, uint256[] memory shares)
    {
        (address pair, uint256 sumX, uint256 sumY) = _prepareAdd(p);
        ids = _absoluteIds(pair, p);
        _pay(p.tokenX, msg.sender, pair, sumX);
        _pay(p.tokenY, msg.sender, pair, sumY);
        (usedX, usedY, shares) = IDlmmPairR(pair).mint(p.to, ids, p.amountsX, p.amountsY, msg.sender);
        _checkMins(p, usedX, usedY);
    }

    /// One of tokenX / tokenY must be WNATIVE; msg.value must equal that
    /// side's sum. What the bins did not take comes back as native.
    function addLiquidityNATIVE(LiquidityParams calldata p)
        external payable ensure(p.deadline) returns (uint256 usedX, uint256 usedY, int24[] memory ids, uint256[] memory shares)
    {
        bool nativeIsX = p.tokenX == WNATIVE;
        if (!nativeIsX && p.tokenY != WNATIVE) revert InvalidPath();
        address pair;
        (pair, ids) = _fundNative(p, nativeIsX);
        (usedX, usedY, shares) = _mintAndRefund(pair, p, ids, nativeIsX ? p.tokenY : p.tokenX);
    }

    function _fundNative(LiquidityParams calldata p, bool nativeIsX) private returns (address pair, int24[] memory ids) {
        uint256 sumX;
        uint256 sumY;
        (pair, sumX, sumY) = _prepareAdd(p);
        ids = _absoluteIds(pair, p);
        if (msg.value != (nativeIsX ? sumX : sumY)) revert WrongNativeAmount();
        _pay(nativeIsX ? p.tokenY : p.tokenX, msg.sender, pair, nativeIsX ? sumY : sumX);
        _wrapTo(pair, msg.value);
    }

    /// Mints with the router as refund recipient, then passes the refunds on (native as native).
    function _mintAndRefund(address pair, LiquidityParams calldata p, int24[] memory ids, address token)
        private returns (uint256 usedX, uint256 usedY, uint256[] memory shares)
    {
        uint256 tokenBefore = IERC20R(token).balanceOf(address(this));
        uint256 nativeBefore = IERC20R(WNATIVE).balanceOf(address(this));
        (usedX, usedY, shares) = IDlmmPairR(pair).mint(p.to, ids, p.amountsX, p.amountsY, address(this));
        _checkMins(p, usedX, usedY);
        uint256 tokenBack = IERC20R(token).balanceOf(address(this)) - tokenBefore;
        uint256 nativeBack = IERC20R(WNATIVE).balanceOf(address(this)) - nativeBefore;
        if (tokenBack != 0) _safeTransfer(token, msg.sender, tokenBack);
        if (nativeBack != 0) {
            IWNativeR(WNATIVE).withdraw(nativeBack);
            _sendNative(msg.sender, nativeBack);
        }
    }

    function removeLiquidity(
        address tokenX, address tokenY, uint16 binStep, int24[] calldata ids, uint256[] calldata shares,
        uint256 amountXMin, uint256 amountYMin, address to, uint256 deadline
    ) external ensure(deadline) returns (uint256 amountX, uint256 amountY) {
        if (tokenX >= tokenY) revert UnsortedTokens();
        (amountX, amountY) = IDlmmPairR(_existing(tokenX, tokenY, binStep)).burn(msg.sender, to, ids, shares);
        if (amountX < amountXMin) revert InsufficientXAmount();
        if (amountY < amountYMin) revert InsufficientYAmount();
    }

    /// `token` is the other token of a pair with WNATIVE; amounts in the token / native order.
    function removeLiquidityNATIVE(
        address token, uint16 binStep, int24[] calldata ids, uint256[] calldata shares,
        uint256 amountTokenMin, uint256 amountNativeMin, address payable to, uint256 deadline
    ) external ensure(deadline) returns (uint256 amountToken, uint256 amountNative) {
        (amountToken, amountNative) = _burnToRouter(token, binStep, ids, shares);
        if (amountToken < amountTokenMin || amountNative < amountNativeMin) revert InsufficientOutputAmount();
        if (amountToken != 0) _safeTransfer(token, to, amountToken);
        if (amountNative != 0) {
            IWNativeR(WNATIVE).withdraw(amountNative);
            _sendNative(to, amountNative);
        }
    }

    function _burnToRouter(address token, uint16 binStep, int24[] calldata ids, uint256[] calldata shares)
        private returns (uint256 amountToken, uint256 amountNative)
    {
        (uint256 ax, uint256 ay) = IDlmmPairR(_existing(token, WNATIVE, binStep)).burn(msg.sender, address(this), ids, shares);
        (amountToken, amountNative) = token < WNATIVE ? (ax, ay) : (ay, ax);
    }

    // =====================================================================
    // Swaps
    // =====================================================================

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Path calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256 amountOut)
    {
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        _pay(path.tokens[0], msg.sender, pairs[0], amountIn);
        amountOut = _swapChain(pairs, path.tokens, to);
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();
    }

    function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, Path calldata path, address to, uint256 deadline)
        external ensure(deadline) returns (uint256 amountIn)
    {
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        amountIn = getAmountsIn(amountOut, path)[0];
        if (amountIn > amountInMax) revert ExcessiveInputAmount();
        _pay(path.tokens[0], msg.sender, pairs[0], amountIn);
        if (_swapChain(pairs, path.tokens, to) < amountOut) revert InsufficientOutputAmount();
    }

    function swapExactNATIVEForTokens(uint256 amountOutMin, Path calldata path, address to, uint256 deadline)
        external payable ensure(deadline) returns (uint256 amountOut)
    {
        if (path.tokens[0] != WNATIVE) revert InvalidPath();
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        _wrapTo(pairs[0], msg.value);
        amountOut = _swapChain(pairs, path.tokens, to);
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();
    }

    /// msg.value is the most native coin to spend; the rest is refunded.
    function swapNATIVEForExactTokens(uint256 amountOut, Path calldata path, address to, uint256 deadline)
        external payable ensure(deadline) returns (uint256 amountIn)
    {
        if (path.tokens[0] != WNATIVE) revert InvalidPath();
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        amountIn = getAmountsIn(amountOut, path)[0];
        if (amountIn > msg.value) revert ExcessiveInputAmount();
        _wrapTo(pairs[0], amountIn);
        if (_swapChain(pairs, path.tokens, to) < amountOut) revert InsufficientOutputAmount();
        if (msg.value > amountIn) _sendNative(msg.sender, msg.value - amountIn);
    }

    function swapExactTokensForNATIVE(uint256 amountIn, uint256 amountOutMin, Path calldata path, address payable to, uint256 deadline)
        external ensure(deadline) returns (uint256 amountOut)
    {
        if (path.tokens[path.tokens.length - 1] != WNATIVE) revert InvalidPath();
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        _pay(path.tokens[0], msg.sender, pairs[0], amountIn);
        amountOut = _swapChain(pairs, path.tokens, address(this));
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();
        IWNativeR(WNATIVE).withdraw(amountOut);
        _sendNative(to, amountOut);
    }

    function swapTokensForExactNATIVE(uint256 amountOut, uint256 amountInMax, Path calldata path, address payable to, uint256 deadline)
        external ensure(deadline) returns (uint256 amountIn)
    {
        if (path.tokens[path.tokens.length - 1] != WNATIVE) revert InvalidPath();
        address[] memory pairs = _pairs(path);
        _checkPath(path.tokens);
        amountIn = getAmountsIn(amountOut, path)[0];
        if (amountIn > amountInMax) revert ExcessiveInputAmount();
        _pay(path.tokens[0], msg.sender, pairs[0], amountIn);
        uint256 got = _swapChain(pairs, path.tokens, address(this));
        if (got < amountOut) revert InsufficientOutputAmount();
        IWNativeR(WNATIVE).withdraw(got);
        _sendNative(to, got);
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _prepareAdd(LiquidityParams calldata p) private returns (address pair, uint256 sumX, uint256 sumY) {
        if (p.tokenX >= p.tokenY) revert UnsortedTokens();
        uint256 n = p.deltaIds.length;
        if (n == 0 || p.amountsX.length != n || p.amountsY.length != n) revert InvalidLength();
        _checkToken(p.tokenX);
        _checkToken(p.tokenY);
        pair = IDlmmFactoryR(factory).getPair(p.tokenX, p.tokenY, p.binStep);
        if (pair == address(0)) pair = IDlmmFactoryR(factory).createPair(p.tokenX, p.tokenY, p.binStep, p.activeIdDesired);
        // No liquidity yet: the first LP sets the price (atomically, with the deposit below).
        if (IDlmmPairR(pair).reserveX() == 0 && IDlmmPairR(pair).reserveY() == 0 && IDlmmPairR(pair).getActiveId() != p.activeIdDesired) {
            IDlmmPairR(pair).setActiveIdWhileEmpty(p.activeIdDesired);
        }
        for (uint256 i; i < n; i++) {
            sumX += p.amountsX[i];
            sumY += p.amountsY[i];
        }
    }

    function _absoluteIds(address pair, LiquidityParams calldata p) private view returns (int24[] memory ids) {
        int256 active = IDlmmPairR(pair).getActiveId();
        int256 diff = active - p.activeIdDesired;
        if (diff > int256(uint256(p.idSlippage)) || -diff > int256(uint256(p.idSlippage))) revert IdSlippage(int24(active));
        uint256 n = p.deltaIds.length;
        ids = new int24[](n);
        for (uint256 i; i < n; i++) {
            int256 id = active + p.deltaIds[i];
            if (id > type(int24).max || id < type(int24).min) revert IdOutOfRange();
            ids[i] = int24(id);
        }
    }

    function _checkMins(LiquidityParams calldata p, uint256 usedX, uint256 usedY) private pure {
        if (usedX < p.amountXMin) revert InsufficientXAmount();
        if (usedY < p.amountYMin) revert InsufficientYAmount();
    }

    function _existing(address tokenA, address tokenB, uint16 binStep) private view returns (address pair) {
        pair = IDlmmFactoryR(factory).getPair(tokenA, tokenB, binStep);
        if (pair == address(0)) revert PairNotFound();
    }

    /// The pairs along `path` (computed with CREATE2; each must exist).
    function _pairs(Path calldata path) private view returns (address[] memory pairs) {
        uint256 n = path.binSteps.length;
        if (n == 0 || path.tokens.length != n + 1) revert InvalidPath();
        pairs = new address[](n);
        for (uint256 i; i < n; i++) {
            if (path.tokens[i] == path.tokens[i + 1]) revert InvalidPath();
            pairs[i] = pairFor(path.tokens[i], path.tokens[i + 1], path.binSteps[i]);
            if (pairs[i].code.length == 0) revert PairNotFound();
        }
    }

    /// Runs the hops; each pair sends its output straight to the next pair.
    /// Returns what `to` actually received of the last token.
    function _swapChain(address[] memory pairs, address[] calldata tokens, address to) private returns (uint256 received) {
        address last = tokens[tokens.length - 1];
        uint256 before = IERC20R(last).balanceOf(to);
        uint256 n = pairs.length;
        for (uint256 i; i < n; i++) {
            IDlmmPairR(pairs[i]).swap(tokens[i] < tokens[i + 1], i + 1 < n ? pairs[i + 1] : to);
        }
        received = IERC20R(last).balanceOf(to) - before;
    }

    // ---- Neuro ----

    function _checkToken(address token) private view {
        address registry = IDlmmFactoryR(factory).threatRegistry();
        if (registry != address(0)) _refuseEnforced(registry, token);
    }

    /// Every token a swap along `tokens` receives into a pool or hands out; not the one sold.
    function _checkPath(address[] calldata tokens) private view {
        address registry = IDlmmFactoryR(factory).threatRegistry();
        if (registry == address(0)) return;
        for (uint256 i = 1; i < tokens.length; i++) _refuseEnforced(registry, tokens[i]);
    }

    function _refuseEnforced(address registry, address token) private view {
        if (token == WNATIVE) return;
        (bool ok, bytes memory r) = registry.staticcall{gas: REGISTRY_GAS}(abi.encodeCall(IThreatViewR.isContractEnforced, (token)));
        if (!ok || r.length < 64) revert RegistryUnavailable();
        (bool enforced, uint8 reason) = abi.decode(r, (bool, uint8));
        if (enforced) revert TokenEnforced(token, reason);
    }

    // ---- transfers ----

    /// transferFrom(from -> pair) that must arrive in full (no fee-on-transfer).
    function _pay(address token, address from, address pair, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = IERC20R(token).balanceOf(pair);
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, pair, amount));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
        if (IERC20R(token).balanceOf(pair) - before != amount) revert FeeOnTransferNotSupported();
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }

    function _sendNative(address to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert NativeTransferFailed();
    }

    /// Wraps `amount` of the native coin and sends it to `pair`.
    function _wrapTo(address pair, uint256 amount) private {
        if (amount == 0) return;
        IWNativeR(WNATIVE).deposit{value: amount}();
        _safeTransfer(WNATIVE, pair, amount);
    }
}
