// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// SaphanIntents (docs/SAPHAN-PR5.md): the calls made here. Order is SaphanIntents.Order, field for field.
interface ISealedIntents {
    struct Order {
        address tokenIn;
        uint256 amountIn;
        uint32 dstDomain;
        address tokenOut;
        address recipient;
        uint256 minOut;
        uint64 deadline;
        address refundTo;
    }
    function open(Order calldata o) external returns (bytes32 id);
    function fillLocal(bytes32 id, uint256 amountOut, address repayTo) external;
    function threats() external view returns (address);
}

interface ISealedThreats {
    function isAddressHeld(uint256 chainId, address who) external view returns (bool, uint8);
}

interface ISealedToken {
    function balanceOf(address) external view returns (uint256);
}

/// @title SaphanSealedOrders: cross-chain orders encrypted to a solver's ML-KEM-768 key (Saphan PR 4, S6)
/// @notice Testnet only, not audited (docs/SAPHAN-PR4.md).
///
///   An intent (SaphanIntents.Order: where to, for whom, at least how much, by when) is public the moment it is
///   opened, so anyone can trade ahead of it. Here the user first SEALS it:
///
///   1. A solver (one key, or a group of solvers sharing one key behind one address) publishes its post-quantum
///      encryption key: setSolverKey(X-Wing key = ML-KEM-768 (1184 bytes) + X25519 (32), as the encrypted mempool).
///   2. The user escrows the input tokens and posts commit(solver, token, amount, refundTo, window, commitment,
///      ciphertext). ciphertext = the order and a random 32-byte salt, encrypted to the solver's key
///      (src/saphansealed.js); commitment = keccak256(abi.encode(TAG, chainid, this, solver, order, salt)).
///      On chain everyone sees the token, the amount, refundTo and the solver; nobody but the solver can read where
///      the money goes, to whom, the minimum and the deadline. From another chain: SaphanSourceGateway.depositAndCall
///      with target = this contract and data = abi.encode(solver, refundTo, window, commitment, ciphertext).
///   3. Within the window, only that solver reveals (order, salt). The commitment binds them: a solver cannot change
///      one field. The order must spend exactly the escrow (same token, amount, refundTo). The reveal opens it as an
///      ordinary SaphanIntents intent (Neuro gates, bonds, proofs as there); an order SaphanIntents refuses (expired,
///      risky recipient, ...) cannot be revealed and is refunded after the window. For a fill on ZETAPHY itself, revealAndFillLocal reveals and
///      fills in one transaction, so the order is never public before it is done.
///   4. Not revealed in time: anyone calls refund(id); refundTo claims the escrow (pull).
///
///   The contract cannot check that the ciphertext really holds the committed order (that needs the solver's
///   secret key): a user who seals garbage only locks its own tokens until the window ends. A solver that does not
///   reveal costs the user only time. No admin, no parameter to govern: every bound is a constant.
contract SaphanSealedOrders {
    enum Status { None, Sealed, Revealed, Refunded }

    struct Sealed {
        address solver;
        uint64 revealBy;
        Status status;
        address token;
        uint256 amount;
        address refundTo;
        bytes32 commitment;
        bytes32 keyHash;        // keccak256 of the solver key the order was sealed to
        bytes32 ciphertextHash;
    }

    bytes32 public constant TAG = keccak256("saphan/sealed/v1");
    uint256 public constant KEY_BYTES = 1216;          // X-Wing public key: ML-KEM-768 1184 + X25519 32
    /// X-Wing ciphertext (1120) + abi.encode(order, salt) (9 words, 288) + AES-256-GCM tag (16): every sealed order
    /// has the same length, so the length says nothing about it.
    uint256 public constant CIPHERTEXT_BYTES = 1424;
    uint64 public constant MIN_WINDOW = 1 minutes;
    uint64 public constant MAX_WINDOW = 1 days;

    ISealedIntents public immutable intents;

    mapping(address => bytes32) public solverKey;      // solver => keccak256(its X-Wing key); zero: none
    mapping(bytes32 => Sealed) private _sealed;
    uint256 public nonce;
    mapping(address => uint256) public accounted;      // tokens held for sealed orders and payouts
    mapping(address => mapping(address => uint256)) public owed;  // token => who => amount (claim)
    uint256 private entered;

    event SolverKeySet(address indexed solver, bytes32 keyHash, bytes publicKey);
    event Committed(bytes32 indexed id, address indexed owner, uint256 srcChainId, address indexed solver, address token,
        uint256 amount, address refundTo, uint64 revealBy, bytes32 commitment, bytes32 keyHash, bytes ciphertext);
    event Revealed(bytes32 indexed id, ISealedIntents.Order order, bytes32 salt);
    event IntentOpened(bytes32 indexed id, bytes32 indexed intentId);
    event Refunded(bytes32 indexed id, address refundTo, uint256 amount);
    event Claimed(address indexed who, address indexed token, uint256 amount);

    error BadKey();
    error BadSeal(uint256 code);
    error NotSolver();
    error WrongStatus();
    error TooLate();
    error TooEarly();
    error Mismatch(uint256 code);
    error Short(uint256 have, uint256 need);
    error SolverHeld();
    error Nothing();
    error PayFailed();
    error Reentered();

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(ISealedIntents intents_) {
        require(address(intents_) != address(0), "intents");
        intents = intents_;
    }

    function sealedOf(bytes32 id) external view returns (Sealed memory) { return _sealed[id]; }

    /// The caller's encryption key (X-Wing, 1216 bytes); empty removes it. Orders already sealed keep the key they
    /// were sealed to, so keep the old secret key until they are revealed or expired.
    function setSolverKey(bytes calldata publicKey) external {
        if (publicKey.length != 0 && publicKey.length != KEY_BYTES) revert BadKey();
        bytes32 h = publicKey.length == 0 ? bytes32(0) : keccak256(publicKey);
        solverKey[msg.sender] = h;
        emit SolverKeySet(msg.sender, h, publicKey);
    }

    /// What a sealed order commits to (src/saphansealed.js commitment).
    function commitmentOf(address solver, ISealedIntents.Order calldata o, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(TAG, block.chainid, address(this), solver, o, salt));
    }

    // ---- sealing ----

    /// Seals an order with the caller's tokens (approve this contract for `amount` of `token` first).
    function commit(address solver, address token, uint256 amount, address refundTo, uint64 window, bytes32 commitment,
        bytes calldata ciphertext) external nonReentrant returns (bytes32 id)
    {
        uint256 need = accounted[token] + amount;
        id = _seal(msg.sender, block.chainid, solver, token, amount, refundTo, window, commitment, ciphertext);
        _pay(token, abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
        uint256 have = ISealedToken(token).balanceOf(address(this));
        if (have < need) revert Short(have, need);
    }

    /// From chain X through its ZetaphyGateway, after it handed over the tokens:
    /// data = abi.encode(solver, refundTo, window, commitment, ciphertext). Reverting makes the Gateway refund on X.
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256, bytes calldata data) external nonReentrant {
        (address solver, address refundTo, uint64 window, bytes32 commitment, bytes memory ciphertext) =
            abi.decode(data, (address, address, uint64, bytes32, bytes));
        if (token == address(0) || token.code.length == 0) revert BadSeal(1);
        uint256 received = ISealedToken(token).balanceOf(address(this)) - accounted[token];
        _sealMem(sender, srcChainId, solver, token, received, refundTo, window, commitment, ciphertext);
    }

    function _seal(address owner, uint256 srcChainId, address solver, address token, uint256 amount, address refundTo,
        uint64 window, bytes32 commitment, bytes calldata ciphertext) private returns (bytes32)
    {
        if (token.code.length == 0) revert BadSeal(1);
        return _sealMem(owner, srcChainId, solver, token, amount, refundTo, window, commitment, ciphertext);
    }

    function _sealMem(address owner, uint256 srcChainId, address solver, address token, uint256 amount, address refundTo,
        uint64 window, bytes32 commitment, bytes memory ciphertext) private returns (bytes32 id)
    {
        bytes32 key = solverKey[solver];
        if (key == bytes32(0)) revert BadKey();
        if (amount == 0 || refundTo == address(0) || commitment == bytes32(0)) revert BadSeal(2);
        if (window < MIN_WINDOW || window > MAX_WINDOW) revert BadSeal(3);
        if (ciphertext.length != CIPHERTEXT_BYTES) revert BadSeal(4);
        id = keccak256(abi.encode(TAG, block.chainid, address(this), nonce++));
        uint64 revealBy = uint64(block.timestamp) + window;
        _sealed[id] = Sealed(solver, revealBy, Status.Sealed, token, amount, refundTo, commitment, key, keccak256(ciphertext));
        accounted[token] += amount;
        emit Committed(id, owner, srcChainId, solver, token, amount, refundTo, revealBy, commitment, key, ciphertext);
    }

    // ---- revealing ----

    /// The chosen solver, within the window: the plaintext, bound by the commitment. Opens the intent in
    /// SaphanIntents (its Opened event, and IntentOpened here, give the intent's id). An order SaphanIntents refuses
    /// (expired, risky recipient, ...) cannot be revealed: the user gets the escrow back after the window (refund).
    function reveal(bytes32 id, ISealedIntents.Order calldata o, bytes32 salt) external nonReentrant returns (bytes32 intentId) {
        Sealed storage s = _revealable(id, o, salt);
        s.status = Status.Revealed;
        accounted[s.token] -= s.amount;
        emit Revealed(id, o, salt);
        _pay(s.token, abi.encodeWithSignature("approve(address,uint256)", address(intents), s.amount));
        intentId = intents.open(o);
        emit IntentOpened(id, intentId);
    }

    /// The chosen solver, for an order filled on ZETAPHY (dstDomain = this chain): reveals, opens and fills in one
    /// transaction, so the order is never public before it is filled. The solver pays `amountOut` of tokenOut
    /// (approve this contract) and `repayTo` is owed the input in SaphanIntents (claim there).
    function revealAndFillLocal(bytes32 id, ISealedIntents.Order calldata o, bytes32 salt, uint256 amountOut, address repayTo)
        external nonReentrant returns (bytes32 intentId)
    {
        Sealed storage s = _revealable(id, o, salt);
        s.status = Status.Revealed;
        accounted[s.token] -= s.amount;
        // the solver's tokenOut passes through here: never the escrow of other orders
        uint256 floor = accounted[o.tokenOut];
        emit Revealed(id, o, salt);
        address t = intents.threats();
        if (t != address(0)) {
            (bool held, ) = ISealedThreats(t).isAddressHeld(block.chainid, msg.sender);
            if (held) revert SolverHeld();
        }
        _pay(s.token, abi.encodeWithSignature("approve(address,uint256)", address(intents), s.amount));
        intentId = intents.open(o);
        emit IntentOpened(id, intentId);
        _pay(o.tokenOut, abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amountOut));
        uint256 have = ISealedToken(o.tokenOut).balanceOf(address(this));
        if (have < floor + amountOut) revert Short(have, floor + amountOut);
        // exactly amountOut may leave (the allowance): fillLocal pays the recipient from it
        _pay(o.tokenOut, abi.encodeWithSignature("approve(address,uint256)", address(intents), amountOut));
        intents.fillLocal(intentId, amountOut, repayTo);
    }

    function _revealable(bytes32 id, ISealedIntents.Order calldata o, bytes32 salt) private view returns (Sealed storage s) {
        s = _sealed[id];
        if (s.status != Status.Sealed) revert WrongStatus();
        if (msg.sender != s.solver) revert NotSolver();
        if (block.timestamp > s.revealBy) revert TooLate();
        if (commitmentOf(s.solver, o, salt) != s.commitment) revert Mismatch(0);
        if (o.tokenIn != s.token || o.amountIn != s.amount || o.refundTo != s.refundTo) revert Mismatch(1);
    }

    // ---- refunds and payouts ----

    /// Anyone, after the window with no reveal: the escrow is owed to refundTo.
    function refund(bytes32 id) external {
        Sealed storage s = _sealed[id];
        if (s.status != Status.Sealed) revert WrongStatus();
        if (block.timestamp <= s.revealBy) revert TooEarly();
        s.status = Status.Refunded;
        owed[s.token][s.refundTo] += s.amount;
        emit Refunded(id, s.refundTo, s.amount);
    }

    /// The caller's refunds in `token`.
    function claim(address token) external nonReentrant {
        uint256 v = owed[token][msg.sender];
        if (v == 0) revert Nothing();
        owed[token][msg.sender] = 0;
        accounted[token] -= v;
        emit Claimed(msg.sender, token, v);
        _pay(token, abi.encodeWithSignature("transfer(address,uint256)", msg.sender, v));
    }

    /// A token call that must succeed (tokens that return nothing are accepted).
    function _pay(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert PayFailed();
    }
}
