// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPQOrdersERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// The ZETAPHY Swap router (zetaphy-dex/contracts/ZetaphyRouter.sol, Uniswap V2 names).
interface IPQOrdersRouter {
    function WETH() external view returns (address);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
}

interface IPQOrdersWrapped {
    function withdraw(uint256) external;
}

/// @title ZetaphyPQOfflineOrders: offline swap orders signed with ML-DSA-44, filled by anyone (testnet, not audited)
/// @notice The post-quantum twin of ZetaphyOfflineOrders, a separate contract so the deployed one and its users
///         stay as they are. Same Order, same fill rules (all or nothing, the relayer picks the route and earns
///         `relayerFee` in tokenOut, the maker's minimum is checked on what it actually received, native
///         ZETAPHY out is unwrapped, one nonce per order in a per-maker bitmap, cancel / cancelWord).
///
///         The difference: no ecrecover. A maker (any account: a QuantumWallet, a native ML-DSA account's
///         0x address, or an EOA) first names its ML-DSA-44 key with setPQKey(keccak256(publicKey)); orders
///         are then signed offline with that key over
///           digest(o) = keccak256(abi.encode("ZETAPHY PQOfflineOrders order v1", chainid, this, orderHash(o)))
///         and fill(o, pk, sig, path) checks keccak256(pk) == pqKeyOf[maker] and the signature with ZETAPHY's
///         ML-DSA precompile at 0x…0900 (the PQSettlement / QuantumWallet path). Rotating or clearing the key
///         (setPQKey again) voids every unfilled order signed with the old key.
///
///         Honest limits: tokenIn is pulled from the maker with transferFrom, so the allowance and the balance
///         are only as safe as the maker's account. For an end-to-end quantum-safe maker, use a QuantumWallet in
///         post-quantum-only mode (it calls setPQKey and approve through execute) or a native ML-DSA account.
///         There is no EIP-2612 permit path here: permits are ECDSA signatures.
contract ZetaphyPQOfflineOrders {
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

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 nonce,uint256 relayerFee)"
    );
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint8 public constant VARIANT = 44;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant MAX_HOPS = 3;

    address public immutable router;
    address public immutable wrapped;

    /// maker => keccak256 of its ML-DSA-44 public key (0 = none: its orders cannot fill)
    mapping(address => bytes32) public pqKeyOf;
    /// maker => word position (nonce >> 8) => bits of used nonces (nonce & 255)
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    uint256 private locked = 1;

    event PQKeySet(address indexed maker, bytes32 keyHash);
    event OrderFilled(address indexed maker, uint256 indexed nonce, bytes32 indexed orderHash, address relayer,
        uint256 amountIn, uint256 amountOut, uint256 relayerFee);
    event NonceCancelled(address indexed maker, uint256 wordPos, uint256 mask);

    error Expired();
    error NonceUsed();
    error NoKey();
    error WrongKey();
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
        wrapped = IPQOrdersRouter(router_).WETH();
    }

    /// Only the wrapped coin pays native coins in here (when it unwraps).
    receive() external payable {
        if (msg.sender != wrapped) revert SendFailed();
    }

    // ------------------------------------------------------------------ digests

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(ORDER_TYPEHASH, o.maker, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.deadline, o.nonce, o.relayerFee));
    }

    /// The 32 bytes the maker's ML-DSA key signs (src/qsafe/offline.js pqOrderDigest).
    function digest(Order calldata o) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY PQOfflineOrders order v1", block.chainid, address(this), orderHash(o)));
    }

    function isNonceUsed(address maker, uint256 nonce) public view returns (bool) {
        return nonceBitmap[maker][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    // ------------------------------------------------------------------ maker

    /// Names the caller's ML-DSA-44 key (keccak256 of the 1312-byte public key); 0 clears it.
    function setPQKey(bytes32 keyHash) external {
        pqKeyOf[msg.sender] = keyHash;
        emit PQKeySet(msg.sender, keyHash);
    }

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

    /// Fills an ML-DSA-signed order; returns what the maker received. Simulate it with eth_call first.
    function fill(Order calldata o, bytes calldata pk, bytes calldata sig, address[] calldata path)
        external nonReentrant returns (uint256 toMaker)
    {
        address outToken = _checkOrder(o, path);
        bytes32 h = _checkSig(o, pk, sig);
        _useNonce(o.maker, o.nonce);
        return _swapAndPay(o, path, outToken, h);
    }

    // ------------------------------------------------------------------ internals

    /// Deadline, order shape and route; returns the token the swap ends in.
    function _checkOrder(Order calldata o, address[] calldata path) private view returns (address outToken) {
        if (block.timestamp > o.deadline) revert Expired();
        if (o.maker == address(0) || o.amountIn == 0 || o.tokenIn == address(0) || o.tokenIn == o.tokenOut || o.tokenIn == address(this)) revert BadOrder();
        outToken = o.tokenOut == address(0) ? wrapped : o.tokenOut;
        if (outToken == o.tokenIn) revert BadOrder();
        _checkPath(path, o.tokenIn, outToken);
    }

    function _swapAndPay(Order calldata o, address[] calldata path, address outToken, bytes32 h) private returns (uint256 toMaker) {
        uint256 got = _pullAndSwap(o, path, outToken);
        toMaker = got - o.relayerFee;
        _payOut(o, outToken, got, toMaker);
        emit OrderFilled(o.maker, o.nonce, h, msg.sender, o.amountIn, toMaker, o.relayerFee);
    }

    /// The maker's named key signed this order; returns its orderHash.
    function _checkSig(Order calldata o, bytes calldata pk, bytes calldata sig) private view returns (bytes32 h) {
        bytes32 key = pqKeyOf[o.maker];
        if (key == bytes32(0)) revert NoKey();
        if (keccak256(pk) != key) revert WrongKey();
        h = orderHash(o);
        if (!_pqValid(keccak256(abi.encode("ZETAPHY PQOfflineOrders order v1", block.chainid, address(this), h)), pk, sig)) revert BadSignature();
    }

    function _pullAndSwap(Order calldata o, address[] calldata path, address outToken) private returns (uint256 got) {
        IPQOrdersERC20 tin = IPQOrdersERC20(o.tokenIn);
        uint256 inBefore = tin.balanceOf(address(this));
        _safe(o.tokenIn, abi.encodeCall(IPQOrdersERC20.transferFrom, (o.maker, address(this), o.amountIn)));
        if (tin.balanceOf(address(this)) - inBefore != o.amountIn) revert FeeOnTransfer();
        uint256 want = o.minAmountOut + o.relayerFee;
        uint256 outBefore = IPQOrdersERC20(outToken).balanceOf(address(this));
        _safe(o.tokenIn, abi.encodeCall(IPQOrdersERC20.approve, (router, o.amountIn)));
        _swap(o, path, outToken, want);
        _safe(o.tokenIn, abi.encodeCall(IPQOrdersERC20.approve, (router, 0)));
        if (tin.balanceOf(address(this)) != inBefore) revert BadPath(); // the router took all of amountIn
        got = IPQOrdersERC20(outToken).balanceOf(address(this)) - outBefore;
        if (got < want) revert InsufficientOutput(got, want);
    }

    function _swap(Order calldata o, address[] calldata path, address outToken, uint256 want) private {
        uint256[] memory amounts;
        if (path.length != 0) {
            amounts = IPQOrdersRouter(router).swapExactTokensForTokens(o.amountIn, want, path, address(this), o.deadline);
        } else {
            address[] memory direct = new address[](2);
            direct[0] = o.tokenIn;
            direct[1] = outToken;
            amounts = IPQOrdersRouter(router).swapExactTokensForTokens(o.amountIn, want, direct, address(this), o.deadline);
        }
        // the router's own report must meet `want` too; _pullAndSwap then measures what actually arrived
        uint256 reported = amounts.length == 0 ? 0 : amounts[amounts.length - 1];
        if (reported < want) revert InsufficientOutput(reported, want);
    }

    function _payOut(Order calldata o, address outToken, uint256 got, uint256 toMaker) private {
        if (o.tokenOut == address(0)) {
            IPQOrdersWrapped(wrapped).withdraw(got);
            // WZETAPHY pays the coins in; ZETAPHY's native ERC-20 already holds them (its withdraw is a no-op)
            if (address(this).balance < got) revert TokenFailed();
            _sendNative(o.maker, toMaker);
            if (o.relayerFee != 0) _sendNative(msg.sender, o.relayerFee);
            return;
        }
        uint256 makerBefore = IPQOrdersERC20(outToken).balanceOf(o.maker);
        _safe(outToken, abi.encodeCall(IPQOrdersERC20.transfer, (o.maker, toMaker)));
        uint256 makerGot = IPQOrdersERC20(outToken).balanceOf(o.maker) - makerBefore;
        if (makerGot < o.minAmountOut) revert InsufficientOutput(makerGot, o.minAmountOut);
        if (o.relayerFee != 0) _safe(outToken, abi.encodeCall(IPQOrdersERC20.transfer, (msg.sender, o.relayerFee)));
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

    /// ML-DSA-44 verify through the precompile (variant ‖ digest ‖ pk ‖ sig -> uint256(1)), as PQSettlement.
    function _pqValid(bytes32 d, bytes calldata pk, bytes calldata sig) private view returns (bool) {
        if (pk.length != PK_BYTES) return false;
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(VARIANT, d, pk, sig));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _safe(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenFailed();
    }
}
