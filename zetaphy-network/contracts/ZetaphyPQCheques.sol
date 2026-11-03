// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPQChequeERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title ZetaphyPQCheques: offline cheques signed with ML-DSA-44 (testnet, not audited)
/// @notice The post-quantum twin of ZetaphyCheques (same channels, same rules, same events where they fit),
///         a separate contract so the deployed ZetaphyCheques and everything that reads it stay as they are.
///         The difference: a channel names an ML-DSA-44 public key (FIPS 204) instead of an ECDSA signer, and
///         cheques are checked by ZETAPHY's precompile at 0x…0900, the PQSettlement / QuantumWallet path.
///         No ecrecover anywhere: a quantum computer that derives secp256k1 keys cannot forge a cheque.
///
///         open(payee, token, amount, expiry, signerKey): signerKey is the 1312-byte ML-DSA-44 public key;
///         the contract keeps keccak256(signerKey) and emits the key itself (SignerKey event), so the payee
///         can read it from the chain once and check cheques offline afterwards.
///
///         A cheque: the signer signs chequeDigest(channelId, cumulativeAmount) =
///           keccak256(abi.encode("ZETAPHY PQCheques cheque v1", chainid, this, channelId, cumulativeAmount)),
///         the TOTAL promised so far; cash(id, cumulative, pk, sig) pays the payee the part not cashed yet,
///         never more than the deposit. Closing, challenge period, release, top-up and extend are exactly
///         those of ZetaphyCheques.
///
///         What stays classical: the payer funds the channel and closes it with its own account, and the
///         payee receives at its address. A quantum attacker who derives the payer's ECDSA key can do what
///         the payer can (top up, extend, close after expiry), not forge cheques; to make those steps
///         quantum-safe too, open the channel from a QuantumWallet or a native ML-DSA account.
///
///         No owner, no fee, no upgrade. Plain ERC-20s; fee-on-transfer tokens are refused. Checks-effects-
///         interactions and nonReentrant on every entry point.
contract ZetaphyPQCheques {
    struct Channel {
        address payer;
        uint64 expiry;     // the payer may start closing from here
        uint64 closeAt;    // 0 = open; else the end of the challenge period
        address payee;
        address token;     // address(0) = native ZETAPHY
        bytes32 signerKey; // keccak256 of the ML-DSA-44 public key whose cheques count
        uint256 deposit;   // everything deposited
        uint256 paid;      // everything cashed by the payee
        bool done;         // the payer took the remainder: the channel is over
    }

    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint8 public constant VARIANT = 44;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant CHALLENGE_PERIOD = 24 hours;
    uint256 public constant MAX_DURATION = 366 days;

    uint256 public channelCount;
    mapping(uint256 => Channel) public channels;
    uint256 private locked = 1;

    event ChannelOpened(uint256 indexed id, address indexed payer, address indexed payee, address token, uint256 amount, uint64 expiry, bytes32 signerKey);
    event SignerKey(uint256 indexed id, bytes publicKey);
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
    error WrongKey();
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

    /// The 32 bytes the channel's ML-DSA key signs for a cheque (src/qsafe/offline.js pqChequeDigest).
    function chequeDigest(uint256 id, uint256 cumulative) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY PQCheques cheque v1", block.chainid, address(this), id, cumulative));
    }

    // ------------------------------------------------------------------ payer

    /// Opens a channel to `payee` with `amount` of `token` (0 = native: send it as msg.value), cheques
    /// signed by the ML-DSA-44 key `signerKey`, closable from `expiry`. Returns the channel id (1, 2, ...).
    function open(address payee, address token, uint256 amount, uint64 expiry, bytes calldata signerKey)
        external payable nonReentrant returns (uint256 id)
    {
        if (payee == address(0) || payee == msg.sender || signerKey.length != PK_BYTES) revert BadChannel();
        if (amount == 0) revert BadAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        bytes32 keyHash = keccak256(signerKey);
        id = ++channelCount;
        channels[id] = Channel({ payer: msg.sender, expiry: expiry, closeAt: 0, payee: payee, token: token, signerKey: keyHash,
            deposit: amount, paid: 0, done: false });
        emit ChannelOpened(id, msg.sender, payee, token, amount, expiry, keyHash);
        emit SignerKey(id, signerKey);
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

    /// Cashes an ML-DSA-signed cheque: pays the payee min(cumulative, deposit) minus what it was already paid.
    /// `pk` is the channel's public key (keccak256(pk) == signerKey). Anyone may submit; the payee is paid.
    function cash(uint256 id, uint256 cumulative, bytes calldata pk, bytes calldata sig) external nonReentrant returns (uint256 amount) {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert BadChannel();
        if (c.done) revert ChannelDone();
        if (c.closeAt != 0 && block.timestamp >= c.closeAt) revert ChannelDone();
        if (keccak256(pk) != c.signerKey) revert WrongKey();
        if (!_pqValid(chequeDigest(id, cumulative), pk, sig)) revert BadSignature();
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

    function _pullIn(address token, uint256 amount) private {
        if (token == address(0)) {
            if (msg.value != amount) revert BadValue();
            return;
        }
        if (msg.value != 0) revert BadValue();
        if (token.code.length == 0) revert TokenFailed();
        uint256 before = IPQChequeERC20(token).balanceOf(address(this));
        _safe(token, abi.encodeCall(IPQChequeERC20.transferFrom, (msg.sender, address(this), amount)));
        if (IPQChequeERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransfer();
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert SendFailed();
        } else {
            _safe(token, abi.encodeCall(IPQChequeERC20.transfer, (to, amount)));
        }
    }

    /// ML-DSA-44 verify through the precompile (variant ‖ digest ‖ pk ‖ sig -> uint256(1)), as PQSettlement.
    function _pqValid(bytes32 d, bytes calldata pk, bytes calldata sig) private view returns (bool) {
        if (pk.length != PK_BYTES) return false; // fixed key length: the key / signature split cannot shift
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(VARIANT, d, pk, sig));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _safe(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert TokenFailed();
    }
}
