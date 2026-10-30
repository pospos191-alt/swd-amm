// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IOrdersERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IOrdersPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// The ZETAPHY Swap router (zetaphy-dex/contracts/ZetaphyRouter.sol, Uniswap V2 names).
interface IOrdersRouter {
    function WETH() external view returns (address);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
}

interface IOrdersWrapped {
    function withdraw(uint256) external;
}

/// @title ZetaphyOfflineOrders: swap orders signed offline, filled by anyone (testnet, not audited)
/// @notice A maker signs an EIP-712 Order without a network (in the hub, or any wallet that signs typed
///         data offline): sell exactly `amountIn` of `tokenIn` for at least `minAmountOut` of `tokenOut`
///         (after the relayer's fee), until `deadline`. The signed order travels as a QR code or text;
///         whoever brings it online calls fill() and earns `relayerFee`, paid in tokenOut out of the swap.
///
///         fill(order, sig, path): pulls tokenIn from the maker (an approve of this contract, or an
///         EIP-2612 permit through fillWithPermit), swaps it on the ZETAPHY Swap router with
///         amountOutMin = minAmountOut + relayerFee, then pays the maker everything but the fee and
///         the caller the fee. All or nothing: no partial fills. The relayer chooses the route
///         (`path`, empty = the direct pool) but cannot take more than the fee: the maker's minimum
///         is checked on what the maker actually received.
///
///         tokenOut = address(0) means native ZETAPHY: the route ends in the router's wrapped coin
///         (WZETAPHY, or ZETAPHY's native ERC-20), which is unwrapped and sent as coins. To SELL native
///         ZETAPHY offline, wrap it first (tokenIn = WZETAPHY) and approve this contract.
///
///         Replay: one nonce per order in a per-maker bitmap (Uniswap Permit2 style); cancel(nonce) or
///         cancelWord(wordPos, mask) burns nonces. The EIP-712 domain binds the chain id and this
///         contract. No owner, no fee of its own, no upgrade. nonReentrant everywhere; the nonce is
///         spent before any call out.
contract ZetaphyOfflineOrders {
    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;     // address(0) = native ZETAPHY
        uint256 amountIn;
        uint256 minAmountOut; // what the maker gets at least, after the relayer fee
        uint256 deadline;
        uint256 nonce;
        uint256 relayerFee;   // in tokenOut, to whoever fills
    }

    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 nonce,uint256 relayerFee)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 public constant MAX_HOPS = 3;

    address public immutable router;
    address public immutable wrapped;

    /// maker => word position (nonce >> 8) => bits of used nonces (nonce & 255)
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    uint256 private locked = 1;

    event OrderFilled(address indexed maker, uint256 indexed nonce, bytes32 indexed orderHash, address relayer,
        uint256 amountIn, uint256 amountOut, uint256 relayerFee);
    event NonceCancelled(address indexed maker, uint256 wordPos, uint256 mask);

    error Expired();
    error NonceUsed();
    error BadSignature();
    error BadOrder();
    error BadPath();
    error FeeOnTransfer();
    error InsufficientOutput(uint256 got, uint256 wanted);
    error TokenFailed();
    error SendFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address router_) {
        router = router_;
        wrapped = IOrdersRouter(router_).WETH();
    }

    /// Only the wrapped coin pays native coins in here (when it unwraps).
    receive() external payable {
        if (msg.sender != wrapped) revert SendFailed();
    }

    // ------------------------------------------------------------------ EIP-712

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY Offline Orders"), keccak256("1"), block.chainid, address(this)));
    }

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(ORDER_TYPEHASH, o.maker, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.deadline, o.nonce, o.relayerFee));
    }

    /// The digest the maker signs (eth_signTypedData_v4 gives the same).
    function digest(Order calldata o) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), orderHash(o)));
    }

    function isNonceUsed(address maker, uint256 nonce) public view returns (bool) {
        return nonceBitmap[maker][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    // ------------------------------------------------------------------ maker

    function cancel(uint256 nonce) external {
        uint256 mask = 1 << (nonce & 0xff);
        nonceBitmap[msg.sender][nonce >> 8] |= mask;
        emit NonceCancelled(msg.sender, nonce >> 8, mask);
    }

    /// Burns every nonce of word `wordPos` whose bit is set in `mask`.
    function cancelWord(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
        emit NonceCancelled(msg.sender, wordPos, mask);
    }

    // ------------------------------------------------------------------ anyone (the relayer)

    /// Fills a signed order; returns what the maker received. Simulate it with eth_call first.
    function fill(Order calldata o, bytes calldata sig, address[] calldata path) external nonReentrant returns (uint256) {
        return _fill(o, sig, path);
    }

    /// The same, after the maker's EIP-2612 permit of tokenIn to this contract (a permit that fails, e.g.
    /// one somebody already used, is skipped: the fill then needs the allowance to be there anyway).
    function fillWithPermit(Order calldata o, bytes calldata sig, address[] calldata path, Permit calldata p)
        external nonReentrant returns (uint256)
    {
        try IOrdersPermit(o.tokenIn).permit(o.maker, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
        return _fill(o, sig, path);
    }

    // ------------------------------------------------------------------ internals

    function _fill(Order calldata o, bytes calldata sig, address[] calldata path) private returns (uint256 toMaker) {
        if (block.timestamp > o.deadline) revert Expired();
        if (o.maker == address(0) || o.amountIn == 0 || o.tokenIn == address(0) || o.tokenIn == o.tokenOut || o.tokenIn == address(this)) revert BadOrder();
        address outToken = o.tokenOut == address(0) ? wrapped : o.tokenOut;
        if (outToken == o.tokenIn) revert BadOrder();
        _checkPath(path, o.tokenIn, outToken);
        bytes32 h = orderHash(o);
        if (_recover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), h)), sig) != o.maker) revert BadSignature();
        _useNonce(o.maker, o.nonce);
        uint256 got = _pullAndSwap(o, path, outToken);
        toMaker = got - o.relayerFee;
        _payOut(o, outToken, got, toMaker);
        emit OrderFilled(o.maker, o.nonce, h, msg.sender, o.amountIn, toMaker, o.relayerFee);
    }

    /// Pulls exactly amountIn (fee-on-transfer refused), swaps it on the router to this contract; returns
    /// the output received, at least minAmountOut + relayerFee.
    function _pullAndSwap(Order calldata o, address[] calldata path, address outToken) private returns (uint256 got) {
        IOrdersERC20 tin = IOrdersERC20(o.tokenIn);
        uint256 inBefore = tin.balanceOf(address(this));
        _safe(o.tokenIn, abi.encodeCall(IOrdersERC20.transferFrom, (o.maker, address(this), o.amountIn)));
        if (tin.balanceOf(address(this)) - inBefore != o.amountIn) revert FeeOnTransfer();
        uint256 want = o.minAmountOut + o.relayerFee;
        uint256 outBefore = IOrdersERC20(outToken).balanceOf(address(this));
        _safe(o.tokenIn, abi.encodeCall(IOrdersERC20.approve, (router, o.amountIn)));
        _swap(o, path, outToken, want);
        _safe(o.tokenIn, abi.encodeCall(IOrdersERC20.approve, (router, 0)));
        if (tin.balanceOf(address(this)) != inBefore) revert BadPath(); // the router took all of amountIn
        got = IOrdersERC20(outToken).balanceOf(address(this)) - outBefore;
        if (got < want) revert InsufficientOutput(got, want);
    }

    function _swap(Order calldata o, address[] calldata path, address outToken, uint256 want) private {
        if (path.length != 0) {
            IOrdersRouter(router).swapExactTokensForTokens(o.amountIn, want, path, address(this), o.deadline);
            return;
        }
        address[] memory direct = new address[](2);
        direct[0] = o.tokenIn;
        direct[1] = outToken;
        IOrdersRouter(router).swapExactTokensForTokens(o.amountIn, want, direct, address(this), o.deadline);
    }

    /// The maker gets `toMaker` (checked on what it actually received), the caller the relayer fee.
    function _payOut(Order calldata o, address outToken, uint256 got, uint256 toMaker) private {
        if (o.tokenOut == address(0)) {
            IOrdersWrapped(wrapped).withdraw(got);
            // WZETAPHY pays the coins in; ZETAPHY's native ERC-20 already holds them (its withdraw is a no-op)
            if (address(this).balance < got) revert TokenFailed();
            _sendNative(o.maker, toMaker);
            if (o.relayerFee != 0) _sendNative(msg.sender, o.relayerFee);
            return;
        }
        uint256 makerBefore = IOrdersERC20(outToken).balanceOf(o.maker);
        _safe(outToken, abi.encodeCall(IOrdersERC20.transfer, (o.maker, toMaker)));
        uint256 makerGot = IOrdersERC20(outToken).balanceOf(o.maker) - makerBefore;
        if (makerGot < o.minAmountOut) revert InsufficientOutput(makerGot, o.minAmountOut);
        if (o.relayerFee != 0) _safe(outToken, abi.encodeCall(IOrdersERC20.transfer, (msg.sender, o.relayerFee)));
    }

    function _checkPath(address[] calldata path, address tokenIn, address outToken) private pure {
        if (path.length == 0) return;
        if (path.length < 2 || path.length > MAX_HOPS + 1 || path[0] != tokenIn || path[path.length - 1] != outToken) revert BadPath();
    }

    function _useNonce(address maker, uint256 nonce) private {
        uint256 bit = 1 << (nonce & 0xff);
        uint256 word = nonceBitmap[maker][nonce >> 8];
        if (word & bit != 0) revert NonceUsed();
        nonceBitmap[maker][nonce >> 8] = word | bit;
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address got) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_N) revert BadSignature();
        got = ecrecover(d, v, r, s);
        if (got == address(0)) revert BadSignature();
    }

    function _safe(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenFailed();
    }
}
