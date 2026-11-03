// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan Gateway: call contracts across chains in one transaction, with automatic refunds
/// @notice Two contracts per source chain X, on top of the existing route (HyperlaneLockBoxV2 on X; HyperlaneLane,
///         BridgeAirlock, BridgeGuard and HyperlaneOutbox on ZETAPHY), none of which changes:
///
///         X -> ZETAPHY  SaphanSourceGateway.depositAndCall(target, data, ...) locks ETH in the route's lockbox
///                       to a DEPOSIT ADDRESS that is derived from the whole call (CREATE2 of ZetaphyGateway,
///                       salt = the call's hash). The route mints token(X) to that address after its usual checks
///                       (two independent lanes, quarantine, Neuro, threat registry, daily limits). Anyone then
///                       hands the call to ZetaphyGateway.execute, which empties the address (a one-shot CREATE2,
///                       so each call runs once), pays the executor its fee in token(X) and calls
///                       target.onSaphanCall. If the call fails, the tokens go back to X (to revertTo, optionally
///                       calling its onSaphanRevert), or stay on ZETAPHY for abortTo when the way back is closed.
///         ZETAPHY -> X  ZetaphyGateway.withdrawAndCall(target, data, ...) burns token(X) through the route's
///                       outbox toward a deposit address of SaphanSourceGateway on X. After the lockbox's delay
///                       and checks it is paid ETH (anyone claims the release); anyone then runs
///                       SaphanSourceGateway.execute: executor fee in
///                       ETH, then target.onSaphanCall; if that fails, the ETH is kept for revertTo (claim()).
///
///         Why a derived address and not a second message: the lanes that attest the transfer attest the address,
///         and so the call itself (its hash). A call cannot be swapped or replayed without breaking keccak256, and
///         the Gateway adds no new signer, relayer or admin to trust.
///
///         Gas: the executor's fee (maxFee, set by the caller) comes out of the amount, in what moved (token(X) on
///         ZETAPHY, ETH on X): the user needs no gas coin on the destination chain.
///         Testnet only, not audited.

interface ISaphanToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
}

interface ISaphanLockBox {
    function lock(address to, uint256 amount) external payable returns (bytes32);
    function quoteLock(address to, uint256 amount) external view returns (uint256);
    function claim(bytes32 id) external;
}

interface ISaphanOutbox {
    function send(address to, uint256 amount) external payable returns (bytes32);
    function quoteSend(address to, uint256 amount) external view returns (uint256);
}

interface ISaphanAirlock {
    function release(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external;
}

/// What a contract on ZETAPHY implements to be called from another chain (it must check msg.sender is the Gateway).
interface ISaphanCallee {
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata data) external;
}

/// What a contract on a source chain implements to be called from ZETAPHY (it must check msg.sender is the Gateway).
interface ISaphanReceiver {
    function onSaphanCall(uint256 srcChainId, address sender, bytes calldata data) external payable;
    function onSaphanRevert(address sender, uint256 nonce, bytes calldata message) external payable;
}

/// @notice The deposit address of one call: deployed once (CREATE2, salt = the call's hash) by the Gateway that owns
///         it; its constructor hands everything it holds (`token`, or ETH when token is zero) to that Gateway.
///         Once deployed it accepts nothing more, so a call can never run twice.
contract SaphanDepositAddress {
    constructor(address token) {
        if (token == address(0)) {
            (bool ok, ) = msg.sender.call{value: address(this).balance}("");
            require(ok, "sweep");
        } else {
            uint256 b = ISaphanToken(token).balanceOf(address(this));
            if (b > 0) require(ISaphanToken(token).transfer(msg.sender, b), "sweep");
        }
    }
}

/// Shared by both Gateways: the call formats, their hashes and deposit addresses.
abstract contract SaphanCalls {
    /// X -> ZETAPHY: a call made on X (depositAndCall).
    struct InCall {
        uint256 srcChainId;   // X
        address srcGateway;   // SaphanSourceGateway on X
        uint256 nonce;        // its count of calls
        address sender;       // who called on X
        address target;       // the contract on ZETAPHY
        uint256 amount;       // ETH locked = token(X) minted to the deposit address
        uint256 maxFee;       // the executor's fee, in token(X)
        uint64 gasLimit;      // gas the target gets
        address revertTo;     // on X: who gets the refund when the call fails (zero: no way back, abortTo keeps it)
        bool callOnRevert;    // the refund calls revertTo.onSaphanRevert(sender, nonce, revertMessage)
        address abortTo;      // on ZETAPHY: who may claim the tokens when the refund cannot be sent
        bytes data;
        bytes revertMessage;
    }

    /// ZETAPHY -> X: a call made on ZETAPHY (withdrawAndCall), or the refund of a failed InCall (kind REVERT).
    struct OutCall {
        uint256 dstChainId;   // X
        address dstGateway;   // SaphanSourceGateway on X
        address srcGateway;   // ZetaphyGateway
        uint256 nonce;        // ZetaphyGateway's count of out calls
        address sender;       // who called on ZETAPHY (for a refund: who called on X)
        address target;       // the contract on X (for a refund: revertTo)
        uint256 amount;       // token(X) burned = ETH paid to the deposit address on X
        uint256 maxFee;       // the executor's fee, in ETH
        uint64 gasLimit;
        address revertTo;     // on X: who gets the ETH when the call fails
        uint8 kind;           // CALL or REVERT
        bytes data;           // CALL: the call's data; REVERT: abi.encode(the InCall's nonce, its revertMessage)
    }

    uint8 internal constant CALL = 0;
    uint8 internal constant REVERT = 1;
    bytes32 public constant IN_TAG = keccak256("saphan/gateway/in/v1");
    bytes32 public constant OUT_TAG = keccak256("saphan/gateway/out/v1");
    /// Gas kept back for what follows the target's call (fee transfer, refund, events).
    uint256 internal constant RESERVE = 120_000;

    uint256 private entered;

    error Reentered();
    error WrongGateway();
    error NotFunded(uint256 have, uint256 need);
    error LowGas(uint256 need);
    error NotSelf();
    error BadCall();
    error PayFailed();
    error Fee(uint256 needed);

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    function hashIn(InCall calldata p) public pure returns (bytes32) { return keccak256(abi.encode(IN_TAG, p)); }
    function hashOut(OutCall memory p) public pure returns (bytes32) { return keccak256(abi.encode(OUT_TAG, p)); }

    /// The deposit address `gateway` derives for a call hash, for a token (zero = ETH). The init code is the creation
    /// code followed by the token as one 32-byte word (= abi.encode(token), the constructor's argument).
    function depositAddressOf(address gateway, bytes32 callHash, address token) public pure returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(SaphanDepositAddress).creationCode, uint256(uint160(token))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), gateway, callHash, code)))));
    }

    /// Empties this Gateway's deposit address of a call into the Gateway (once: a second time reverts).
    function _sweep(bytes32 callHash, address token) internal {
        bytes memory code = abi.encodePacked(type(SaphanDepositAddress).creationCode, uint256(uint160(token)));
        address at;
        assembly { at := create2(0, add(code, 0x20), mload(code), callHash) }
        if (at == address(0)) revert BadCall(); // used already
    }

    /// The executor cannot starve the target: enough gas for it and what follows, checked before it runs.
    function _gasFor(uint64 gasLimit) internal view {
        uint256 need = uint256(gasLimit) + uint256(gasLimit) / 63 + RESERVE;
        if (gasleft() < need) revert LowGas(need);
    }

    /// ETH to the caller (its change, its fee, what it claims): the Gateways pay no one else directly.
    function _payCaller(uint256 v) internal {
        if (v == 0) return;
        (bool ok, ) = msg.sender.call{value: v}("");
        if (!ok) revert PayFailed();
    }
}

/// @title ZetaphyGateway: the ZETAPHY side, one per source chain X (its token, airlock and outbox)
contract ZetaphyGateway is SaphanCalls {
    ISaphanToken public immutable token;     // token(X), minted by the route's BridgeGuard
    ISaphanOutbox public immutable outbox;   // HyperlaneOutbox(X): burns token(X), releases ETH on X
    ISaphanAirlock public immutable airlock; // BridgeAirlock(X)
    address public immutable lockbox;        // HyperlaneLockBoxV2 on X (the airlock's source contract)
    uint256 public immutable remoteChainId;  // X
    address public immutable deployer;
    address public remote;                   // SaphanSourceGateway on X (set once, then fixed)
    uint256 public outNonce;
    /// Tokens kept on ZETAPHY for whoever a failed call names as abortTo (claimAborted).
    mapping(address => uint256) public aborted;

    event RemoteSet(address remote);
    event Executed(bytes32 indexed callHash, uint256 indexed nonce, address indexed target, uint256 amount, uint256 fee, address executor);
    event CallFailed(bytes32 indexed callHash, bytes reason);
    event Reverted(bytes32 indexed callHash, address indexed revertTo, uint256 amount, bool withCall, bytes32 outHash);
    event Aborted(bytes32 indexed callHash, address indexed abortTo, uint256 amount);
    event AbortClaimed(address indexed who, uint256 amount);
    event OutCallDispatched(bytes32 indexed callHash, bytes32 messageId);
    /// Every call toward X (a withdrawAndCall, or a refund that calls revertTo back): what the executor on X runs.
    event OutCallSent(bytes32 indexed callHash, uint256 indexed nonce, address indexed sender, address depositAddress, OutCall call);

    constructor(ISaphanToken token_, ISaphanOutbox outbox_, ISaphanAirlock airlock_, address lockbox_, uint256 remoteChainId_) {
        require(address(token_) != address(0) && address(outbox_) != address(0) && address(airlock_) != address(0)
            && lockbox_ != address(0) && remoteChainId_ != 0, "config");
        token = token_;
        outbox = outbox_;
        airlock = airlock_;
        lockbox = lockbox_;
        remoteChainId = remoteChainId_;
        deployer = msg.sender;
    }

    /// Once, by the deployer: the Gateway on X (deployed after this one, it names this one).
    function setRemote(address r) external {
        require(msg.sender == deployer && remote == address(0) && r != address(0), "remote");
        remote = r;
        emit RemoteSet(r);
    }

    function depositAddress(InCall calldata p) external view returns (address) { return depositAddressOf(address(this), hashIn(p), address(token)); }

    /// Anyone, once the route minted the call's tokens to its deposit address: runs the call. With `release`, it first
    /// asks the airlock to release the lock (the lockbox's nonce `lockNonce`, from its Locked event) when nobody did yet;
    /// the airlock reverts unless every check of the route passes (a wrong nonce names a transfer that is not there).
    /// msg.value: only for a refund to X (the Mailbox fee, in ZTPHY); the rest comes back to the executor.
    function execute(InCall calldata p, bool release, uint256 lockNonce) external payable nonReentrant returns (bool ok) {
        if (remote == address(0) || p.srcChainId != remoteChainId || p.srcGateway != remote) revert WrongGateway();
        if (p.target == address(0) || p.amount == 0 || p.maxFee > p.amount) revert BadCall();
        bytes32 h = hashIn(p);
        address at = depositAddressOf(address(this), h, address(token));
        if (release && token.balanceOf(at) < p.amount) airlock.release(p.srcChainId, lockbox, lockNonce, p.srcGateway, at, p.amount);
        uint256 have = token.balanceOf(at);
        if (have < p.amount) revert NotFunded(have, p.amount); // never deploy (and burn) an address before its tokens came
        _gasFor(p.gasLimit);
        _sweep(h, address(token));
        uint256 extra = have - p.amount;              // tokens someone else sent to the address go with the call's own
        uint256 fee = p.maxFee;
        uint256 rest = p.amount - fee + extra;
        if (fee > 0 && !token.transfer(msg.sender, fee)) revert PayFailed();
        uint256 before = address(this).balance - msg.value;
        try this.deliverIn(p, rest) {
            ok = true;
            emit Executed(h, p.nonce, p.target, rest, fee, msg.sender);
        } catch (bytes memory reason) {
            emit CallFailed(h, reason);
            _refund(p, h, rest, address(this).balance - before);
        }
        _payCaller(address(this).balance - before); // what the Mailbox did not take
    }

    /// Only the Gateway itself (so a failing call undoes its token transfer): tokens to the target, then its call.
    function deliverIn(InCall calldata p, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (!token.transfer(p.target, amount)) revert PayFailed();
        ISaphanCallee(p.target).onSaphanCall{gas: p.gasLimit}(p.srcChainId, p.sender, address(token), amount, p.data);
    }

    /// A failed InCall: back to X through the outbox (plainly, or as a REVERT call to revertTo's onSaphanRevert);
    /// kept for abortTo when there is no way back (no revertTo, or the outbound route refuses: closed, paused, limit).
    function _refund(InCall calldata p, bytes32 h, uint256 amount, uint256 value) private {
        address abortTo = p.abortTo == address(0) ? p.sender : p.abortTo;
        if (p.revertTo != address(0)) {
            address to = p.revertTo;
            bytes32 oh = bytes32(0);
            if (p.callOnRevert) {
                OutCall memory o = OutCall(remoteChainId, remote, address(this), outNonce++, p.sender, p.revertTo, amount, 0, p.gasLimit,
                    p.revertTo, REVERT, abi.encode(p.nonce, p.revertMessage));
                oh = hashOut(o);
                to = depositAddressOf(remote, oh, address(0));
                emit OutCallSent(oh, o.nonce, p.sender, to, o);
            }
            uint256 fee = outbox.quoteSend(to, amount);
            if (value < fee) revert Fee(fee); // the executor pays the way back; run again with it
            try outbox.send{value: fee}(to, amount) returns (bytes32) {
                emit Reverted(h, p.revertTo, amount, p.callOnRevert, oh);
                return;
            } catch {} // the outbound route refused: keep the tokens here
        }
        aborted[abortTo] += amount;
        emit Aborted(h, abortTo, amount);
    }

    /// Tokens kept for the caller by failed calls.
    function claimAborted() external nonReentrant {
        uint256 v = aborted[msg.sender];
        require(v > 0, "nothing");
        aborted[msg.sender] = 0;
        if (!token.transfer(msg.sender, v)) revert PayFailed();
        emit AbortClaimed(msg.sender, v);
    }

    /// ZETAPHY -> X: burns `amount` of token(X) from the caller (approve this Gateway first) and has the lockbox on X
    /// pay a deposit address of the Gateway there, which then calls `target` (or pays revertTo when that fails).
    /// msg.value: the Mailbox fee in ZTPHY (quoteWithdraw); the rest comes back.
    function withdrawAndCall(address target, bytes calldata data, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo)
        external payable nonReentrant returns (bytes32 h)
    {
        if (remote == address(0)) revert WrongGateway();
        if (target == address(0) || revertTo == address(0) || amount == 0 || maxFee > amount) revert BadCall();
        OutCall memory o = OutCall(remoteChainId, remote, address(this), outNonce++, msg.sender, target, amount, maxFee, gasLimit, revertTo, CALL, data);
        h = hashOut(o);
        address at = depositAddressOf(remote, h, address(0));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert PayFailed();
        uint256 before = address(this).balance - msg.value;
        bytes32 messageId = outbox.send{value: msg.value}(at, amount); // burns this Gateway's tokens through the guard's outbound route
        emit OutCallSent(h, o.nonce, msg.sender, at, o);
        emit OutCallDispatched(h, messageId);
        _payCaller(address(this).balance - before); // the outbox's change
    }

    /// The Mailbox fee of a withdrawAndCall.
    function quoteWithdraw(uint256 amount) external view returns (uint256) { return outbox.quoteSend(address(1), amount); }

    /// The OutCall a withdrawAndCall made (what the executor on X needs), rebuilt from its event and inputs.
    function outCall(uint256 nonce, address sender, address target, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo,
        uint8 kind, bytes calldata data) external view returns (OutCall memory)
    {
        return OutCall(remoteChainId, remote, address(this), nonce, sender, target, amount, maxFee, gasLimit, revertTo, kind, data);
    }

    receive() external payable {}
}

/// @title SaphanSourceGateway: the side on a source chain X (its HyperlaneLockBoxV2)
contract SaphanSourceGateway is SaphanCalls {
    ISaphanLockBox public immutable lockbox;
    address public immutable remote;          // ZetaphyGateway(X) on ZETAPHY
    address public immutable remoteToken;     // token(X) on ZETAPHY
    uint256 public immutable zetaphyChainId;  // 77390
    uint256 public nonce;
    /// ETH of failed calls, kept for their revertTo (claim).
    mapping(address => uint256) public owed;

    event DepositAndCall(bytes32 indexed callHash, uint256 indexed nonce, address indexed sender, address depositAddress, InCall call);
    event Executed(bytes32 indexed callHash, address indexed target, uint256 amount, uint256 fee, address executor);
    event CallFailed(bytes32 indexed callHash, bytes reason);
    event Owed(address indexed to, uint256 amount);
    event Dispatched(address indexed depositAddress, bytes32 messageId);

    constructor(ISaphanLockBox lockbox_, address remote_, address remoteToken_, uint256 zetaphyChainId_) {
        require(address(lockbox_) != address(0) && remote_ != address(0) && remoteToken_ != address(0) && zetaphyChainId_ != 0, "config");
        lockbox = lockbox_;
        remote = remote_;
        remoteToken = remoteToken_;
        zetaphyChainId = zetaphyChainId_;
    }

    /// The InCall a depositAndCall with these inputs makes now (for quotes and wallets).
    function inCall(address sender, address target, bytes calldata data, uint256 amount, uint256 maxFee, uint64 gasLimit,
        address revertTo, bool callOnRevert, address abortTo, bytes calldata revertMessage) public view returns (InCall memory)
    {
        return InCall(block.chainid, address(this), nonce, sender, target, amount, maxFee, gasLimit, revertTo, callOnRevert, abortTo, data, revertMessage);
    }

    function _hashInMem(InCall memory p) private pure returns (bytes32) { return keccak256(abi.encode(IN_TAG, p)); }

    /// The lockbox's Mailbox fee for a depositAndCall of `amount` (pay amount + this).
    function quoteDeposit(uint256 amount) external view returns (uint256) { return lockbox.quoteLock(address(1), amount); }

    /// X -> ZETAPHY: locks `amount` of ETH for a call of `target` on ZETAPHY. msg.value = amount + the Mailbox fee
    /// (quoteDeposit); the rest comes back. revertTo defaults to the caller; abortTo (on ZETAPHY) too.
    function depositAndCall(address target, bytes calldata data, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo,
        bool callOnRevert, address abortTo, bytes calldata revertMessage) external payable nonReentrant returns (bytes32 h)
    {
        if (target == address(0) || amount == 0 || maxFee > amount) revert BadCall();
        InCall memory p = InCall(block.chainid, address(this), nonce++, msg.sender, target, amount, maxFee, gasLimit,
            revertTo == address(0) ? msg.sender : revertTo, callOnRevert, abortTo == address(0) ? msg.sender : abortTo, data, revertMessage);
        h = _hashInMem(p);
        address at = depositAddressOf(remote, h, remoteToken);
        _lock(at, amount);
        emit DepositAndCall(h, p.nonce, msg.sender, at, p);
    }

    /// Locks `amount` to `at` (the Mailbox fee from msg.value); the caller gets its change, never ETH owed to others.
    function _lock(address at, uint256 amount) private {
        uint256 fee = lockbox.quoteLock(at, amount);
        if (msg.value < amount + fee) revert Fee(amount + fee);
        uint256 before = address(this).balance - msg.value;
        bytes32 messageId = lockbox.lock{value: amount + fee}(at, amount);
        emit Dispatched(at, messageId);
        _payCaller(address(this).balance - before);
    }

    function depositAddress(OutCall calldata o) external view returns (address) { return depositAddressOf(address(this), hashOut(o), address(0)); }

    /// Anyone, once the lockbox paid the call's deposit address (anyone claims the queued release from the lockbox
    /// first, once it is due): runs the call. When it fails, the ETH waits for revertTo (claim()).
    /// Effects before interactions: the refund is recorded first, and the delivered call cancels it as its own first
    /// step; a failing call undoes that cancel with the rest of itself, so the refund stands.
    function execute(OutCall calldata o) external nonReentrant returns (bool ok) {
        if (o.dstChainId != block.chainid || o.dstGateway != address(this) || o.srcGateway != remote) revert WrongGateway();
        if (o.target == address(0) || o.revertTo == address(0) || o.amount == 0 || o.maxFee > o.amount || o.kind > REVERT) revert BadCall();
        bytes32 h = hashOut(o);
        address at = depositAddressOf(address(this), h, address(0));
        uint256 have = at.balance;
        if (have < o.amount) revert NotFunded(have, o.amount);
        _gasFor(o.gasLimit);
        uint256 fee = o.maxFee;
        uint256 rest = have - fee;            // all of the address's ETH moves (the sweep below takes `have`)
        owed[o.revertTo] += rest;             // the refund, unless the call goes through
        _sweep(h, address(0));
        _payCaller(fee);
        try this.deliverOut{value: rest}(o) {
            ok = true;
            emit Executed(h, o.target, rest, fee, msg.sender);
        } catch (bytes memory reason) {
            emit CallFailed(h, reason);
            emit Owed(o.revertTo, rest);
        }
    }

    /// Only the Gateway itself: cancels the call's refund, then the target's call with the ETH (a failure undoes both).
    function deliverOut(OutCall calldata o) external payable {
        if (msg.sender != address(this)) revert NotSelf();
        owed[o.revertTo] -= msg.value;
        if (o.kind == CALL) {
            ISaphanReceiver(o.target).onSaphanCall{value: msg.value, gas: o.gasLimit}(zetaphyChainId, o.sender, o.data);
        } else {
            (uint256 n, bytes memory m) = abi.decode(o.data, (uint256, bytes));
            ISaphanReceiver(o.target).onSaphanRevert{value: msg.value, gas: o.gasLimit}(o.sender, n, m);
        }
    }

    /// ETH of failed calls, kept for their revertTo.
    function claim() external nonReentrant {
        uint256 v = owed[msg.sender];
        require(v > 0, "nothing");
        owed[msg.sender] = 0;
        _payCaller(v);
    }

    receive() external payable {}
}
