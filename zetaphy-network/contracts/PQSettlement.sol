// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISettleERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title PQSettlement: batch netting of payments authorised only by ML-DSA (testnet)
/// @notice Accounts are ML-DSA-44 keys (keyId = keccak256(public key)); no ECDSA key can move anything here.
///         - deposit(keyId, token, amount): anyone funds a key (token 0 = native ZETAPHY);
///         - settle(batch): many payments among many keys in one transaction. Every key that pays in the
///           batch signs the same batch digest with ML-DSA (checked by the precompile at 0x…0900, the
///           QuantumWallet path). The contract nets each key's position per token and moves only the net,
///           all or nothing; a batch digest settles once (replay protection), before its deadline;
///         - withdraw: an ML-DSA-signed instruction with a per-key nonce, relayed by anyone.
///         Finality: a batch settled in block H is final once block H+1 exists: on ZETAPHY block H+1 carries
///         the ML-DSA certificate of block H (MsgPQCertificate, verified by every node; see the limits in
///         docs/future/quantum-safe-settlement.md). isFinal(digest) says so on-chain; off-chain verifiers
///         check the certificate itself (zetaphy pq verify-block H, src/qsafe/settlement.js).
contract PQSettlement {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant MAX_PARTIES = 64;
    uint256 public constant MAX_PAYMENTS = 256;
    uint256 public constant MAX_TOKENS = 8;

    struct Payment {
        uint16 from;      // index into parties
        uint16 to;        // index into parties
        address token;    // 0 = native ZETAPHY
        uint256 amount;
    }

    struct PartySig {
        uint16 party;     // index into parties (strictly increasing over the list)
        bytes pk;         // ML-DSA-44 public key, keccak256(pk) == parties[party]
        bytes sig;        // ML-DSA-44 signature of batchDigest
    }

    mapping(bytes32 => mapping(address => uint256)) public balanceOf; // keyId => token => amount
    mapping(bytes32 => uint256) public nonceOf;                        // withdrawals per key
    mapping(bytes32 => uint256) public settledAt;                      // batch digest => block (0 = not settled)
    uint256 private locked = 1;

    event Deposited(bytes32 indexed keyId, address indexed token, address from, uint256 amount);
    event Paid(bytes32 indexed batch, bytes32 indexed fromKey, bytes32 indexed toKey, address token, uint256 amount);
    event Settled(bytes32 indexed batch, uint256 parties, uint256 payments, uint256 height);
    event Withdrawn(bytes32 indexed keyId, address indexed token, address to, uint256 amount, uint256 nonce);

    error BadBatch();
    error Expired();
    error AlreadySettled();
    error MissingSignature(uint16 party);
    error BadSignature(uint16 party);
    error WrongKey();
    error Insufficient(bytes32 keyId, address token);
    error TransferFailed();
    error Reentrant();
    error BadParams();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    // ------------------------------------------------------------------ funding

    function deposit(bytes32 keyId, address token, uint256 amount) external payable nonReentrant {
        if (keyId == bytes32(0) || amount == 0) revert BadParams();
        uint256 got = amount;
        if (token == address(0)) {
            if (msg.value != amount) revert BadParams();
        } else {
            if (msg.value != 0 || token.code.length == 0) revert BadParams();
            uint256 before = ISettleERC20(token).balanceOf(address(this));
            _call(token, abi.encodeWithSelector(ISettleERC20.transferFrom.selector, msg.sender, address(this), amount));
            got = ISettleERC20(token).balanceOf(address(this)) - before;
        }
        balanceOf[keyId][token] += got;
        emit Deposited(keyId, token, msg.sender, got);
    }

    // ------------------------------------------------------------------ batch settlement

    /// The 32 bytes every paying key signs for a batch. `salt` makes otherwise equal batches distinct.
    function batchDigest(bytes32[] calldata parties, Payment[] calldata payments, bytes32 salt, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encode("ZETAPHY PQSettlement batch v1", block.chainid, address(this),
            keccak256(abi.encode(parties)), keccak256(abi.encode(payments)), salt, deadline));
    }

    /// Settle a batch: `parties` are distinct key ids in increasing order; each key that appears as a payer
    /// must sign; balances move by each key's net position per token (all or nothing).
    function settle(bytes32[] calldata parties, Payment[] calldata payments, bytes32 salt, uint256 deadline,
        PartySig[] calldata sigs) external returns (bytes32 d)
    {
        if (block.timestamp > deadline) revert Expired();
        uint256 np = parties.length;
        if (np < 2 || np > MAX_PARTIES || payments.length == 0 || payments.length > MAX_PAYMENTS) revert BadBatch();
        for (uint256 i = 1; i < np; ++i) if (parties[i] <= parties[i - 1]) revert BadBatch();
        if (parties[0] == bytes32(0)) revert BadBatch();
        d = batchDigest(parties, payments, salt, deadline);
        if (settledAt[d] != 0) revert AlreadySettled();
        settledAt[d] = block.number;
        _settle(parties, payments, d, sigs);
        emit Settled(d, np, payments.length, block.number);
    }

    function _settle(bytes32[] calldata parties, Payment[] calldata payments, bytes32 d, PartySig[] calldata sigs) private {
        (address[] memory tokens, uint256 nt, int256[] memory net, bool[] memory pays) = _net(payments, parties.length);
        _checkSigs(parties, pays, d, sigs);
        _apply(parties, tokens, nt, net);
        for (uint256 i = 0; i < payments.length; ++i) {
            emit Paid(d, parties[payments[i].from], parties[payments[i].to], payments[i].token, payments[i].amount);
        }
    }

    /// The distinct tokens, the net position of each (party, token) and who pays.
    function _net(Payment[] calldata payments, uint256 np)
        private pure returns (address[] memory tokens, uint256 nt, int256[] memory net, bool[] memory pays)
    {
        tokens = new address[](MAX_TOKENS);
        net = new int256[](np * MAX_TOKENS);
        pays = new bool[](np);
        for (uint256 i = 0; i < payments.length; ++i) {
            Payment calldata p = payments[i];
            if (p.from >= np || p.to >= np || p.from == p.to || p.amount == 0 || p.amount > uint256(type(int256).max)) revert BadBatch();
            uint256 t = 0;
            while (t < nt && tokens[t] != p.token) ++t;
            if (t == nt) {
                if (nt == MAX_TOKENS) revert BadBatch();
                tokens[nt++] = p.token;
            }
            net[uint256(p.from) * MAX_TOKENS + t] -= int256(p.amount);
            net[uint256(p.to) * MAX_TOKENS + t] += int256(p.amount);
            pays[p.from] = true;
        }
    }

    /// Every payer signed the batch (signatures in increasing party order, so each counts once).
    function _checkSigs(bytes32[] calldata parties, bool[] memory pays, bytes32 d, PartySig[] calldata sigs) private view {
        uint256 si = 0;
        for (uint256 i = 0; i < parties.length; ++i) {
            if (!pays[i]) continue;
            while (si < sigs.length && sigs[si].party < i) ++si;
            if (si == sigs.length || sigs[si].party != i) revert MissingSignature(uint16(i));
            PartySig calldata s = sigs[si];
            if (s.pk.length != PK_BYTES || keccak256(s.pk) != parties[i]) revert WrongKey();
            if (!_pqValid(d, s.pk, s.sig)) revert BadSignature(uint16(i));
            ++si;
        }
    }

    /// Move each key's net: a debit needs the balance (all or nothing: any shortfall reverts the batch).
    function _apply(bytes32[] calldata parties, address[] memory tokens, uint256 nt, int256[] memory net) private {
        for (uint256 i = 0; i < parties.length; ++i) {
            for (uint256 t = 0; t < nt; ++t) {
                int256 v = net[i * MAX_TOKENS + t];
                if (v < 0) {
                    uint256 owe = uint256(-v);
                    uint256 bal = balanceOf[parties[i]][tokens[t]];
                    if (bal < owe) revert Insufficient(parties[i], tokens[t]);
                    balanceOf[parties[i]][tokens[t]] = bal - owe;
                } else if (v > 0) {
                    balanceOf[parties[i]][tokens[t]] += uint256(v);
                }
            }
        }
    }

    /// Final: settled in an earlier block, so the next block (which carries that block's ML-DSA certificate) exists.
    function isFinal(bytes32 d) external view returns (bool) {
        uint256 h = settledAt[d];
        return h != 0 && block.number > h;
    }

    // ------------------------------------------------------------------ withdrawal (ML-DSA signed)

    function withdrawDigest(bytes32 keyId, address token, uint256 amount, address to, uint256 nonce, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encode("ZETAPHY PQSettlement withdraw v1", block.chainid, address(this), keyId, token, amount, to, nonce, deadline));
    }

    function withdraw(bytes calldata pk, address token, uint256 amount, address to, uint256 deadline, bytes calldata sig)
        external nonReentrant
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0) || amount == 0 || pk.length != PK_BYTES) revert BadParams();
        bytes32 keyId = keccak256(pk);
        uint256 n = nonceOf[keyId];
        if (!_pqValid(withdrawDigest(keyId, token, amount, to, n, deadline), pk, sig)) revert BadSignature(0);
        uint256 bal = balanceOf[keyId][token];
        if (bal < amount) revert Insufficient(keyId, token);
        balanceOf[keyId][token] = bal - amount;
        nonceOf[keyId] = n + 1;
        emit Withdrawn(keyId, token, to, amount, n);
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(ISettleERC20.transfer.selector, to, amount));
        }
    }

    // ------------------------------------------------------------------ internals

    function _pqValid(bytes32 d, bytes calldata pk, bytes calldata sig) private view returns (bool) {
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), d, pk, sig));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
