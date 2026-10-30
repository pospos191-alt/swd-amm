// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IChequeERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title ZetaphyCheques: offline payments with signed cheques (testnet, not audited)
/// @notice One-way payment channels. A payer locks a deposit (native ZETAPHY or an ERC-20) for one
///         payee and names a `signer`: a dedicated key (the hub keeps it encrypted in the browser),
///         not the payer's main wallet. Offline, the signer signs cheques: EIP-712
///         Cheque{channelId, cumulativeAmount}, the TOTAL promised to the payee so far. Each new
///         cheque replaces the last one (a higher total); the payee keeps only the best.
///
///         cash(channelId, cumulative, sig): anyone may submit a cheque; the payee always gets the
///         money: the part of `cumulative` not cashed yet, never more than the deposit (a cheque
///         above the deposit pays what is there; a later topUp lets the same cheque pay the rest).
///
///         Closing: once the channel has expired the payer calls startClose; the payee still has
///         CHALLENGE_PERIOD (24 h) to cash its best cheque; then the payer withdraws the remainder.
///         The payee may end that wait early with release() (after cashing).
///
///         What the payee can rely on offline: a valid cheque for a total up to the deposit it last
///         saw on chain, while the channel is not closing, is money it can cash (the deposit never
///         goes down before the close; nobody else can take it). The payee must cash before
///         expiry + 24 h at the latest (the earliest a close can end).
///
///         No owner, no fee, no upgrade. Tokens: plain ERC-20s; fee-on-transfer tokens are refused
///         (the received amount is measured). Every state change happens before the transfer
///         (checks-effects-interactions) and every entry point is nonReentrant.
contract ZetaphyCheques {
    struct Channel {
        address payer;
        uint64 expiry;   // the payer may start closing from here
        uint64 closeAt;  // 0 = open; else the end of the challenge period (cashing stops, withdraw starts)
        address payee;
        address token;   // address(0) = native ZETAPHY
        address signer;  // the key whose cheques count
        uint256 deposit; // everything deposited
        uint256 paid;    // everything cashed by the payee
        bool done;       // the payer took the remainder: the channel is over
    }

    uint256 public constant CHALLENGE_PERIOD = 24 hours;
    uint256 public constant MAX_DURATION = 366 days;
    bytes32 public constant CHEQUE_TYPEHASH = keccak256("Cheque(uint256 channelId,uint256 cumulativeAmount)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 public channelCount;
    mapping(uint256 => Channel) public channels;
    uint256 private locked = 1;

    event ChannelOpened(uint256 indexed id, address indexed payer, address indexed payee, address token, uint256 amount, uint64 expiry, address signer);
    event ToppedUp(uint256 indexed id, uint256 amount, uint256 deposit);
    event Extended(uint256 indexed id, uint64 expiry);
    event Cashed(uint256 indexed id, address indexed payee, uint256 cumulative, uint256 amount, address submitter);
    event CloseStarted(uint256 indexed id, uint64 closeAt);
    event Released(uint256 indexed id);
    event Withdrawn(uint256 indexed id, address indexed payer, uint256 amount);

    error BadChannel();
    error NotPayer();
    error NotPayee();
    error BadAmount();
    error BadExpiry();
    error BadValue();
    error Closing();
    error NotClosing();
    error NotExpired();
    error ChallengeOpen();
    error ChannelDone();
    error BadSignature();
    error NothingToCash();
    error FeeOnTransfer();
    error TokenFailed();
    error SendFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ------------------------------------------------------------------ EIP-712

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY Cheques"), keccak256("1"), block.chainid, address(this)));
    }

    /// The digest the signer signs for a cheque (eth_signTypedData_v4 gives the same).
    function chequeDigest(uint256 id, uint256 cumulative) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(CHEQUE_TYPEHASH, id, cumulative))));
    }

    // ------------------------------------------------------------------ payer

    /// Opens a channel to `payee` with `amount` of `token` (0 = native: send it as msg.value), cheques
    /// signed by `signer`, closable from `expiry`. Returns the channel id (1, 2, ...).
    function open(address payee, address token, uint256 amount, uint64 expiry, address signer)
        external payable nonReentrant returns (uint256 id)
    {
        if (payee == address(0) || signer == address(0) || payee == msg.sender) revert BadChannel();
        if (amount == 0) revert BadAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        id = ++channelCount;
        channels[id] = Channel({ payer: msg.sender, expiry: expiry, closeAt: 0, payee: payee, token: token, signer: signer,
            deposit: amount, paid: 0, done: false });
        emit ChannelOpened(id, msg.sender, payee, token, amount, expiry, signer);
        _pullIn(token, amount);
    }

    /// Adds to the deposit (payer only, not once closing).
    function topUp(uint256 id, uint256 amount) external payable nonReentrant {
        Channel storage c = _payerChannel(id);
        if (c.closeAt != 0) revert Closing();
        if (amount == 0) revert BadAmount();
        c.deposit += amount;
        emit ToppedUp(id, amount, c.deposit);
        _pullIn(c.token, amount);
    }

    /// Moves the expiry later (payer only, not once closing).
    function extend(uint256 id, uint64 expiry) external nonReentrant {
        Channel storage c = _payerChannel(id);
        if (c.closeAt != 0) revert Closing();
        if (expiry <= c.expiry || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        c.expiry = expiry;
        emit Extended(id, expiry);
    }

    /// After the expiry: starts the challenge period, during which the payee can still cash.
    function startClose(uint256 id) external nonReentrant {
        Channel storage c = _payerChannel(id);
        if (c.closeAt != 0) revert Closing();
        if (block.timestamp < c.expiry) revert NotExpired();
        uint64 at = uint64(block.timestamp + CHALLENGE_PERIOD);
        c.closeAt = at;
        emit CloseStarted(id, at);
    }

    /// After the challenge period (or a release): the payer takes what was not cashed.
    function withdraw(uint256 id) external nonReentrant {
        Channel storage c = _payerChannel(id);
        if (c.closeAt == 0) revert NotClosing();
        if (block.timestamp < c.closeAt) revert ChallengeOpen();
        c.done = true;
        uint256 rest = c.deposit - c.paid;
        emit Withdrawn(id, c.payer, rest);
        if (rest != 0) _pay(c.token, c.payer, rest);
    }

    // ------------------------------------------------------------------ payee (and anyone)

    /// Cashes a cheque: pays the payee min(cumulative, deposit) minus what it was already paid.
    /// Anyone may submit it; the money always goes to the payee. Works until the challenge period ends.
    function cash(uint256 id, uint256 cumulative, bytes calldata sig) external nonReentrant returns (uint256 amount) {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert BadChannel();
        if (c.done) revert ChannelDone();
        if (c.closeAt != 0 && block.timestamp >= c.closeAt) revert ChannelDone();
        if (_recover(chequeDigest(id, cumulative), sig) != c.signer) revert BadSignature();
        uint256 upTo = cumulative < c.deposit ? cumulative : c.deposit;
        if (upTo <= c.paid) revert NothingToCash();
        amount = upTo - c.paid;
        c.paid = upTo;
        emit Cashed(id, c.payee, cumulative, amount, msg.sender);
        _pay(c.token, c.payee, amount);
    }

    /// The payee gives up the rest of the channel (after cashing): the payer may withdraw at once.
    function release(uint256 id) external nonReentrant {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert BadChannel();
        if (msg.sender != c.payee) revert NotPayee();
        if (c.done) revert ChannelDone();
        c.closeAt = uint64(block.timestamp);
        emit Released(id);
    }

    /// What cash(id, cumulative, …) would pay now with a valid cheque (0 if nothing / closed).
    function cashable(uint256 id, uint256 cumulative) external view returns (uint256) {
        Channel storage c = channels[id];
        if (c.payer == address(0) || c.done || (c.closeAt != 0 && block.timestamp >= c.closeAt)) return 0;
        uint256 upTo = cumulative < c.deposit ? cumulative : c.deposit;
        return upTo > c.paid ? upTo - c.paid : 0;
    }

    // ------------------------------------------------------------------ internals

    function _payerChannel(uint256 id) private view returns (Channel storage c) {
        c = channels[id];
        if (c.payer == address(0)) revert BadChannel();
        if (msg.sender != c.payer) revert NotPayer();
        if (c.done) revert ChannelDone();
    }

    /// Takes `amount` from the caller: msg.value for native, else transferFrom with the received
    /// amount measured (a token that delivers less, e.g. fee on transfer, is refused).
    function _pullIn(address token, uint256 amount) private {
        if (token == address(0)) {
            if (msg.value != amount) revert BadValue();
            return;
        }
        if (msg.value != 0) revert BadValue();
        if (token.code.length == 0) revert TokenFailed();
        uint256 before = IChequeERC20(token).balanceOf(address(this));
        _safe(token, abi.encodeCall(IChequeERC20.transferFrom, (msg.sender, address(this), amount)));
        if (IChequeERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransfer();
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert SendFailed();
        } else {
            _safe(token, abi.encodeCall(IChequeERC20.transfer, (to, amount)));
        }
    }

    /// ecrecover of a 65-byte r‖s‖v signature; refuses high s (malleability) and v other than 27/28 (or 0/1).
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address got) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_N) revert BadSignature();
        got = ecrecover(digest, v, r, s);
        if (got == address(0)) revert BadSignature();
    }

    /// ERC-20 call that accepts tokens returning nothing (USDT style) but not false, a revert or no code.
    function _safe(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenFailed();
    }
}
