// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// HyperlaneOutbox (contracts/HyperlaneLockBoxV2.sol): burns the route's token from the caller through the guard and
/// sends the release to the source chain's lockbox.
interface IOfflineOutbox {
    function guard() external view returns (address);
    function quoteSend(address to, uint256 amount) external view returns (uint256);
    function send(address to, uint256 amount) external payable returns (bytes32 messageId);
}

interface IOfflineGuard {
    function token() external view returns (address);
}

interface IOfflineToken {
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function transfer(address to, uint256 v) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title SaphanOfflineTransfers: a bridge transfer signed offline, relayed by anyone later
/// @notice Saphan PR 6, item H (docs/SAPHAN-PR6.md). Testnet only, not audited. The pattern of ZetaphyOfflineOrders
///         (EIP-712, a QR code or text payload, a nonce bitmap, the relayer paid a fee the signer chose), for the
///         way out of ZETAPHY: "send `amount` of route R's token to `to` on R's source chain".
///
///         Online once: the holder approves this contract for the route's token (token(X) on ZETAPHY).
///         Offline: it signs Transfer{from, outbox, to, amount, relayerFee, nonce, deadline} (no network; the hub or
///         `node scripts/saphan.js offline sign`), and hands the text / QR (src/saphanoffline.js, "ZSPH1:...") to
///         anyone. Later, whoever is online calls relay(): this contract pulls amount + relayerFee from the signer,
///         pays the relayer its fee in the token, and calls the outbox's send(to, amount) with the Mailbox fee the
///         relayer pays in ZTPHY (anything above the quote is returned to the relayer). From there it is an ordinary
///         transfer: the guard's limits, pause and vaccine, the lockbox's delay, veto and daily limit all apply.
///
///         The relayer cannot change anything signed (outbox = the route and so the chain, recipient, amount, fee);
///         a nonce is spent before any call out; cancel(nonce) burns one. The token is the outbox guard's token
///         (read on chain, not trusted from the payload). No owner, no fee of its own, no upgrade; nonReentrant.
contract SaphanOfflineTransfers {
    struct Transfer {
        address from;
        address outbox;       // the route (HyperlaneOutbox on ZETAPHY): which source chain and which token
        address to;           // the receiver on the source chain
        uint256 amount;       // token units that arrive (burned here, released there)
        uint256 relayerFee;   // token units to whoever relays, on top of amount
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "Transfer(address from,address outbox,address to,uint256 amount,uint256 relayerFee,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    address private expectRefund;
    uint256 private unlocked = 1;

    /// The amount, receiver and chain are in the outbox's Sent event of the same transaction (messageId).
    event Relayed(address indexed from, uint256 indexed nonce, address indexed outbox, address relayer, uint256 relayerFee, bytes32 messageId);
    event NonceCancelled(address indexed from, uint256 wordPos, uint256 mask);

    error Expired();
    error NonceUsed();
    error BadSignature();
    error BadTransfer();
    error Fee(uint256 needed);
    error TokenFailed();
    error PayFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    /// Only the outbox being called returns change here (its Mailbox-fee refund).
    receive() external payable {
        if (msg.sender != expectRefund) revert PayFailed();
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY Saphan Offline"), keccak256("1"), block.chainid, address(this)));
    }

    function transferHash(Transfer calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(TRANSFER_TYPEHASH, t.from, t.outbox, t.to, t.amount, t.relayerFee, t.nonce, t.deadline));
    }

    function digest(Transfer calldata t) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), transferHash(t)));
    }

    function isNonceUsed(address from, uint256 nonce) public view returns (bool) {
        return nonceBitmap[from][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function cancel(uint256 nonce) external {
        uint256 mask = 1 << (nonce & 0xff);
        nonceBitmap[msg.sender][nonce >> 8] |= mask;
        emit NonceCancelled(msg.sender, nonce >> 8, mask);
    }

    /// The Mailbox fee relay() needs for `t` now (msg.value of relay).
    function quote(Transfer calldata t) external view returns (uint256) {
        return IOfflineOutbox(t.outbox).quoteSend(t.to, t.amount);
    }

    /// Anyone online: carries a signed transfer to its route. msg.value >= quote(t); the rest comes back.
    function relay(Transfer calldata t, bytes calldata sig) external payable nonReentrant returns (bytes32 messageId) {
        if (block.timestamp > t.deadline) revert Expired();
        if (t.amount == 0 || t.to == address(0) || t.outbox.code.length == 0) revert BadTransfer();
        if (_recover(digest(t), sig) != t.from) revert BadSignature();
        uint256 bit = 1 << (t.nonce & 0xff);
        uint256 word = nonceBitmap[t.from][t.nonce >> 8];
        if (word & bit != 0) revert NonceUsed();
        nonceBitmap[t.from][t.nonce >> 8] = word | bit;

        IOfflineOutbox outbox = IOfflineOutbox(t.outbox);
        uint256 fee = outbox.quoteSend(t.to, t.amount);
        if (msg.value < fee) revert Fee(fee);
        (IOfflineToken token, uint256 before) = _pull(t);

        expectRefund = t.outbox;
        messageId = outbox.send{value: fee}(t.to, t.amount); // burns `amount` from this contract (the guard's outbound route)
        expectRefund = address(0);
        emit Relayed(t.from, t.nonce, t.outbox, msg.sender, t.relayerFee, messageId);
        if (token.balanceOf(address(this)) != before) revert TokenFailed(); // all of amount was burned, nothing kept
        uint256 change = address(this).balance;
        if (change != 0) {
            (bool ok, ) = msg.sender.call{value: change}("");
            if (!ok) revert PayFailed();
        }
    }

    /// Pulls amount + relayerFee from the signer (exactly: no fee-on-transfer token) and pays the relayer its fee.
    function _pull(Transfer calldata t) private returns (IOfflineToken token, uint256 before) {
        token = IOfflineToken(IOfflineGuard(IOfflineOutbox(t.outbox).guard()).token());
        before = token.balanceOf(address(this));
        if (!token.transferFrom(t.from, address(this), t.amount + t.relayerFee)) revert TokenFailed();
        if (token.balanceOf(address(this)) - before != t.amount + t.relayerFee) revert TokenFailed();
        if (t.relayerFee != 0 && !token.transfer(msg.sender, t.relayerFee)) revert TokenFailed();
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address got) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        got = ecrecover(d, v, r, s);
        if (got == address(0)) revert BadSignature();
    }
}
