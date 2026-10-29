// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IIntentERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @title IntentExecutor: Proof of Intent (testnet)
/// @notice A user signs WHAT they want (an intent: send / swap / stake with
///         limits), not HOW. Anyone (an off-chain AI or compiler, "the
///         solver") turns the intent into calls and submits them here. This
///         contract runs the calls and then checks the effects on chain:
///           - the user's tokenIn balance went down by at most maxIn,
///           - the recipient's tokenOut balance went up by at least minOut,
///           - this contract keeps nothing (leftover tokenIn back to the user,
///             any tokenOut it holds on to the recipient),
///           - the deadline has not passed, the nonce is unused,
///           - every call went to a contract the user listed (targetsHash),
///             never to tokenIn, tokenOut, the user or this contract, with no
///             value, and never with an ERC-20 transferFrom selector,
///         and reverts everything otherwise. The solver cannot take more than
///         the user signed for, whatever calls it sends.
///
///         Signatures: EIP-712 by the user's ECDSA key (sigType 0), or the
///         same EIP-712 digest signed with an ML-DSA-44 key whose keccak256
///         the user registered with setPqKey (sigType 1), checked by
///         ZETAPHY's precompile at 0x…0900.
///
///         Tokens are ERC-20 (the native coin is an ERC-20 at
///         0xEeee…EEeE on ZETAPHY). Approve this contract for at most what
///         you sign for; approve a fresh amount per intent.
contract IntentExecutor {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;

    uint8 public constant SEND = 1;
    uint8 public constant SWAP = 2;
    uint8 public constant STAKE = 3;
    uint256 public constant MAX_CALLS = 8;

    // Selectors a solver call may never use: the executor does its own (temporary) approval of `spender`.
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant APPROVE = 0x095ea7b3;
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 private constant PERMIT = 0xd505accf;

    struct Intent {
        address user;
        uint8 kind;
        address tokenIn;
        uint256 maxIn;
        address tokenOut;
        uint256 minOut;
        address recipient;
        bytes32 targetsHash; // keccak256(abi.encode(address[] targets)); 0 for SEND
        uint256 nonce;
        uint256 deadline;
    }

    struct Call {
        address target;
        bytes data;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,uint8 kind,address tokenIn,uint256 maxIn,address tokenOut,uint256 minOut,address recipient,bytes32 targetsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(address => bytes32) public pqKeyOf;
    uint256 private locked = 1;

    event IntentExecuted(address indexed user, uint256 indexed nonce, bytes32 indexed intentHash, address solver, uint256 spent, uint256 received);
    event NonceCancelled(address indexed user, uint256 nonce);
    event PqKeySet(address indexed user, bytes32 keyHash);

    error Expired();
    error NonceUsed();
    error BadSignature();
    error BadIntent();
    error TargetNotAllowed(address target);
    error ForbiddenCall(address target);
    error CallFailed(uint256 index, bytes reason);
    error SpentTooMuch(uint256 spent, uint256 maxIn);
    error ReceivedTooLittle(uint256 received, uint256 minOut);
    error Leftover();
    error TokenFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY IntentExecutor"), keccak256("1"), block.chainid, address(this)));
    }

    function intentHash(Intent calldata i) public pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, i.user, i.kind, i.tokenIn, i.maxIn, i.tokenOut, i.minOut,
            i.recipient, i.targetsHash, i.nonce, i.deadline));
    }

    /// The EIP-712 digest the user signs (eth_signTypedData_v4 gives the same).
    function digest(Intent calldata i) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), intentHash(i)));
    }

    /// Registers (or with 0 removes) the ML-DSA-44 key that may sign this account's intents.
    function setPqKey(bytes32 keyHash) external {
        pqKeyOf[msg.sender] = keyHash;
        emit PqKeySet(msg.sender, keyHash);
    }

    function cancel(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// How the user signed: sigType 0 = ECDSA (65 bytes r‖s‖v), 1 = ML-DSA-44 (pqPublicKey + sig).
    struct Auth {
        uint8 sigType;
        bytes sig;
        bytes pqPublicKey;
    }

    /// What the solver does: calls to `targets` only (must hash to intent.targetsHash);
    /// `spender` (one of the targets, or 0) is approved for the pulled tokenIn during the calls.
    struct Plan {
        address[] targets;
        address spender;
        Call[] calls;
    }

    function execute(Intent calldata intent, Auth calldata auth, Plan calldata plan)
        external nonReentrant returns (uint256 spent, uint256 received)
    {
        if (block.timestamp > intent.deadline) revert Expired();
        if (nonceUsed[intent.user][intent.nonce]) revert NonceUsed();
        if (intent.user == address(0) || intent.recipient == address(0) || intent.maxIn == 0) revert BadIntent();
        _checkSig(intent, auth);
        nonceUsed[intent.user][intent.nonce] = true;

        uint256 userBefore = IIntentERC20(intent.tokenIn).balanceOf(intent.user);
        uint256 recvBefore = IIntentERC20(intent.tokenOut).balanceOf(intent.recipient);

        if (intent.kind == SEND) {
            // to oneself nothing would move: refuse rather than pretend
            if (intent.tokenIn != intent.tokenOut || plan.calls.length != 0 || intent.minOut > intent.maxIn
                || intent.recipient == intent.user) revert BadIntent();
            _safe(intent.tokenIn, abi.encodeCall(IIntentERC20.transferFrom, (intent.user, intent.recipient, intent.minOut)));
        } else if (intent.kind == SWAP || intent.kind == STAKE) {
            _runPlan(intent, plan);
        } else {
            revert BadIntent();
        }

        spent = _moved(IIntentERC20(intent.tokenIn).balanceOf(intent.user), userBefore);
        if (spent > intent.maxIn) revert SpentTooMuch(spent, intent.maxIn);
        received = _moved(recvBefore, IIntentERC20(intent.tokenOut).balanceOf(intent.recipient));
        if (received < intent.minOut) revert ReceivedTooLittle(received, intent.minOut);
        emit IntentExecuted(intent.user, intent.nonce, intentHash(intent), msg.sender, spent, received);
    }

    /// hi - lo when hi > lo, else 0 (how far a balance moved).
    function _moved(uint256 lo, uint256 hi) private pure returns (uint256) {
        return hi > lo ? hi - lo : 0;
    }

    function _runPlan(Intent calldata intent, Plan calldata plan) private {
        if (intent.tokenIn == intent.tokenOut || plan.calls.length == 0 || plan.calls.length > MAX_CALLS) revert BadIntent();
        if (keccak256(abi.encode(plan.targets)) != intent.targetsHash) revert BadIntent();
        IIntentERC20 tin = IIntentERC20(intent.tokenIn);
        IIntentERC20 tout = IIntentERC20(intent.tokenOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));
        _safe(address(tin), abi.encodeCall(IIntentERC20.transferFrom, (intent.user, address(this), intent.maxIn)));
        if (plan.spender != address(0)) {
            _allowed(plan.spender, plan.targets, intent);
            _safe(address(tin), abi.encodeCall(IIntentERC20.approve, (plan.spender, intent.maxIn)));
        }
        for (uint256 k = 0; k < plan.calls.length; k++) _call(k, plan.calls[k], plan.targets, intent);
        if (plan.spender != address(0)) _safe(address(tin), abi.encodeCall(IIntentERC20.approve, (plan.spender, 0)));
        // leftovers: tokenIn back to the user, tokenOut on to the recipient
        uint256 inNow = tin.balanceOf(address(this));
        if (inNow > inBefore) _safe(address(tin), abi.encodeCall(IIntentERC20.transfer, (intent.user, inNow - inBefore)));
        uint256 outNow = tout.balanceOf(address(this));
        if (outNow > outBefore) _safe(address(tout), abi.encodeCall(IIntentERC20.transfer, (intent.recipient, outNow - outBefore)));
        if (tin.balanceOf(address(this)) != inBefore || tout.balanceOf(address(this)) != outBefore) revert Leftover();
    }

    function _call(uint256 k, Call calldata c, address[] calldata targets, Intent calldata intent) private {
        _allowed(c.target, targets, intent);
        if (c.data.length >= 4) {
            bytes4 sel = bytes4(c.data[0:4]);
            if (sel == TRANSFER_FROM || sel == APPROVE || sel == INCREASE_ALLOWANCE || sel == SET_APPROVAL_FOR_ALL || sel == PERMIT) {
                revert ForbiddenCall(c.target);
            }
        }
        (bool ok, bytes memory ret) = c.target.call(c.data);
        if (!ok) revert CallFailed(k, ret);
    }

    /// A call target must be listed, and never tokenIn, the user, this contract or 0. tokenOut is
    /// refused too, except for STAKE, where the vault is both the target and the receipt token
    /// (ERC-4626 style); the balance checks still hold there.
    function _allowed(address t, address[] calldata targets, Intent calldata intent) private view {
        if (t == intent.tokenIn || t == intent.user || t == address(this) || t == address(0)) revert ForbiddenCall(t);
        if (t == intent.tokenOut && intent.kind != STAKE) revert ForbiddenCall(t);
        for (uint256 i = 0; i < targets.length; i++) if (targets[i] == t) return;
        revert TargetNotAllowed(t);
    }

    function _checkSig(Intent calldata intent, Auth calldata auth) private view {
        bytes32 d = digest(intent);
        if (auth.sigType == 0) {
            bytes calldata sig = auth.sig;
            if (sig.length != 65) revert BadSignature();
            uint8 v = uint8(sig[64]);
            if (v < 27) v += 27;
            if (uint256(bytes32(sig[32:64])) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
            address got = ecrecover(d, v, bytes32(sig[0:32]), bytes32(sig[32:64]));
            if (got == address(0) || got != intent.user) revert BadSignature();
        } else if (auth.sigType == 1) {
            bytes32 kh = pqKeyOf[intent.user];
            if (kh == bytes32(0) || keccak256(auth.pqPublicKey) != kh) revert BadSignature();
            (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), d, auth.pqPublicKey, auth.sig));
            if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) revert BadSignature();
        } else {
            revert BadSignature();
        }
    }

    /// ERC-20 call that accepts tokens returning nothing (USDT style) but not false or a revert.
    function _safe(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) revert TokenFailed();
    }
}
