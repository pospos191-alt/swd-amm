// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// BtcLightClient as this contract sees it (contracts/BtcLightClient.sol: proof of work, heaviest chain, confirmations).
interface IBitVMSpvClient {
    function verifyTx(bytes calldata rawTx, bytes32 blockHash, uint256 index, bytes32[] calldata siblings, uint256 minConfirmations)
        external view returns (bytes32 txid);
}

/// The BTC route's bridged token on ZETAPHY (BridgedToken: 18 decimals, 1 sat = 10^10 units).
interface IBitVMToken {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title SaphanBtcWithdrawals: optimistic BTC withdrawals, a BitVM2-style claim / challenge / slash game
/// @notice PROTOTYPE, testnet only, not audited (docs/SAPHAN-PR6.md, item S7). There is NO Bitcoin script here and no
///         peg-out on Bitcoin: the game runs on ZETAPHY, and the "disprove" step is simplified to "prove the payment
///         by SPV or lose the bond". What it shows is the shape of BitVM2's operator flow:
///
///           1. request(amount, btcScript): a holder of the bridged BTC token escrows it here and names where the BTC
///              should go on Bitcoin (a scriptPubKey).
///           2. An operator (anyone who bonded ZTPHY here) FRONTS the BTC from its own coins: a Bitcoin transaction
///              with an output paying btcScript at least the requested sats, and an OP_RETURN that commits to the
///              withdrawal and to itself: "ZTPHYW" || withdrawal id (8 bytes, big-endian) || operator (20 bytes).
///              Then claim(id, txid, vout): it asks to be reimbursed with the escrowed tokens.
///           3. During CHALLENGE_WINDOW anyone who sees that txid:vout does not exist, does not pay the script, or
///              does not carry that commitment may challenge(id), posting challengeBond.
///           4. A challenged operator answers within RESPONSE_WINDOW with prove(): the raw transaction, its block and
///              Merkle branch; BtcLightClient checks the proof of work and minConfirmations. Proven: the operator is
///              reimbursed and takes the challenger's bond. Not proven in time: slash(id) by anyone: the holder gets
///              the escrow back plus half the operator's per-claim bond, the challenger its bond plus the other half.
///           5. Not challenged: finalize(id) after the window reimburses the operator.
///
///         Safety properties (tests: test/saphanbitvm.test.js):
///           - a holder either gets the escrow back or the operator had to be able to prove the BTC payment (or no
///             watcher looked: the optimistic assumption, ONE honest watcher is enough);
///           - the OP_RETURN binds the payment to one withdrawal AND one operator: another operator cannot claim a
///             payment it did not make, and one payment serves one withdrawal (paymentUsed);
///           - each claim locks bondPerClaim of the operator's bond until it is settled: an operator cannot withdraw
///             a bond that a pending claim could still lose; unlocked bond can be withdrawn at once.
///         Payouts are pulled (withdraw()); every parameter is fixed at deploy; there is no owner, admin or pause.
///         What a real BitVM2 adds: the reimbursement comes from a Bitcoin peg UTXO through pre-signed transactions,
///         and the disprove runs as a Bitcoin script (the SNARK verifier split into chunks). Not here.
contract SaphanBtcWithdrawals {
    enum State { None, Requested, Claimed, Challenged, Paid, Slashed, Cancelled }

    struct Withdrawal {
        address holder;
        uint64 sats;
        uint64 requestedAt;
        State state;
        address operator;
        uint64 claimEnds;     // end of the challenge window
        uint64 respondBy;     // end of the response window (when challenged)
        uint32 vout;
        address challenger;
        bytes32 scriptHash;   // keccak256 of the destination scriptPubKey
        bytes32 txid;         // the claimed payment (internal byte order, as BtcLightClient returns it)
        uint256 amount;       // escrowed token units (sats x 10^10)
    }

    uint256 public constant SATS_TO_WEI = 1e10;
    bytes6 public constant TAG = "ZTPHYW";

    IBitVMSpvClient public immutable client;
    IBitVMToken public immutable token;
    uint256 public immutable minConfirmations;
    uint256 public immutable bondPerClaim;      // native ZTPHY locked per open claim
    uint256 public immutable challengeBond;     // native ZTPHY a challenger posts
    uint64 public immutable claimTtl;           // after this, an unclaimed request can be cancelled
    uint64 public immutable challengeWindow;
    uint64 public immutable responseWindow;
    uint64 public immutable minSats;

    Withdrawal[] internal ws;
    mapping(address => uint256) public bonded;       // native, per operator
    mapping(address => uint256) public lockedBond;   // part of bonded held by open claims
    mapping(address => uint256) public owedNative;   // pull payouts
    mapping(address => uint256) public owedToken;    // pull payouts
    mapping(bytes32 => bool) public paymentUsed;     // keccak256(txid, vout)
    uint256 public escrowed;                         // tokens held for open requests
    uint256 private unlocked = 1;

    event Requested(uint256 indexed id, address indexed holder, uint256 amount, uint64 sats, bytes btcScript);
    event Cancelled(uint256 indexed id);
    event Bonded(address indexed operator, uint256 amount);
    event Unbonded(address indexed operator, uint256 amount);
    event Claimed(uint256 indexed id, address indexed operator, bytes32 txid, uint32 vout, uint64 claimEnds);
    event Challenged(uint256 indexed id, address indexed challenger, uint64 respondBy);
    event Proven(uint256 indexed id, address indexed operator);
    event Reimbursed(uint256 indexed id, address indexed operator, uint256 amount);
    event Slashed(uint256 indexed id, address indexed operator, address indexed challenger, uint256 bond);
    event Withdrawn(address indexed who, uint256 native, uint256 tokens);

    error BadAmount();
    error BadScript();
    error BadState(State s);
    error NotHolder();
    error TooEarly(uint64 at);
    error TooLate(uint64 at);
    error NoBond(uint256 free);
    error BadBond();
    error PaymentUsed();
    error BadPayment(uint256 code); // 1 truncated 2 vout 3 wrong script 4 too little 5 no commitment 6 txid
    error TokenFailed();
    error PayFailed();
    error Reentrancy();
    error Nothing();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(IBitVMSpvClient client_, IBitVMToken token_, uint256 minConfirmations_, uint256 bondPerClaim_, uint256 challengeBond_,
        uint64 claimTtl_, uint64 challengeWindow_, uint64 responseWindow_, uint64 minSats_)
    {
        require(address(client_) != address(0) && address(token_) != address(0) && minConfirmations_ >= 1 && bondPerClaim_ > 0
            && challengeBond_ > 0 && claimTtl_ > 0 && challengeWindow_ >= 1 hours && responseWindow_ >= 1 hours && minSats_ > 0, "config");
        client = client_;
        token = token_;
        minConfirmations = minConfirmations_;
        bondPerClaim = bondPerClaim_;
        challengeBond = challengeBond_;
        claimTtl = claimTtl_;
        challengeWindow = challengeWindow_;
        responseWindow = responseWindow_;
        minSats = minSats_;
    }

    // ---------------------------------------------------------------- holders

    /// Escrows `amount` of the bridged BTC token (a whole number of sats) for BTC sent to `btcScript` on Bitcoin.
    function request(uint256 amount, bytes calldata btcScript) external nonReentrant returns (uint256 id) {
        if (amount == 0 || amount % SATS_TO_WEI != 0 || amount / SATS_TO_WEI < minSats || amount / SATS_TO_WEI > type(uint64).max) revert BadAmount();
        if (btcScript.length == 0 || btcScript.length > 80 || btcScript[0] == 0x6a) revert BadScript(); // never an OP_RETURN
        id = ws.length;
        ws.push(Withdrawal({ holder: msg.sender, sats: uint64(amount / SATS_TO_WEI), requestedAt: uint64(block.timestamp), state: State.Requested,
            operator: address(0), claimEnds: 0, respondBy: 0, vout: 0, challenger: address(0), scriptHash: keccak256(btcScript),
            txid: bytes32(0), amount: amount }));
        escrowed += amount;
        emit Requested(id, msg.sender, amount, uint64(amount / SATS_TO_WEI), btcScript);
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amount) || token.balanceOf(address(this)) - before != amount) revert TokenFailed();
    }

    /// The holder, when no operator claimed within claimTtl: the escrow comes back (withdraw()).
    function cancel(uint256 id) external {
        Withdrawal storage w = ws[id];
        if (w.holder != msg.sender) revert NotHolder();
        if (w.state != State.Requested) revert BadState(w.state);
        if (block.timestamp < uint256(w.requestedAt) + claimTtl) revert TooEarly(w.requestedAt + claimTtl);
        w.state = State.Cancelled;
        escrowed -= w.amount;
        owedToken[msg.sender] += w.amount;
        emit Cancelled(id);
    }

    // ---------------------------------------------------------------- operators

    function bond() external payable {
        if (msg.value == 0) revert BadBond();
        bonded[msg.sender] += msg.value;
        emit Bonded(msg.sender, msg.value);
    }

    /// Takes back bond that no open claim holds (to owedNative; withdraw()).
    function unbond(uint256 amount) external {
        uint256 free = bonded[msg.sender] - lockedBond[msg.sender];
        if (amount == 0 || amount > free) revert NoBond(free);
        bonded[msg.sender] -= amount;
        owedNative[msg.sender] += amount;
        emit Unbonded(msg.sender, amount);
    }

    /// The operator says it paid withdrawal `id` on Bitcoin in txid:vout (with the OP_RETURN commitment). Locks
    /// bondPerClaim of its bond and opens the challenge window.
    function claim(uint256 id, bytes32 txid, uint32 vout) external {
        Withdrawal storage w = ws[id];
        if (w.state != State.Requested) revert BadState(w.state);
        uint256 free = bonded[msg.sender] - lockedBond[msg.sender];
        if (free < bondPerClaim) revert NoBond(free);
        bytes32 p = keccak256(abi.encode(txid, vout));
        if (paymentUsed[p]) revert PaymentUsed();
        paymentUsed[p] = true;
        lockedBond[msg.sender] += bondPerClaim;
        w.state = State.Claimed;
        w.operator = msg.sender;
        w.txid = txid;
        w.vout = vout;
        w.claimEnds = uint64(block.timestamp) + challengeWindow;
        emit Claimed(id, msg.sender, txid, vout, w.claimEnds);
    }

    // ---------------------------------------------------------------- watchers

    /// Anyone, during the challenge window, posting exactly challengeBond.
    function challenge(uint256 id) external payable {
        Withdrawal storage w = ws[id];
        if (w.state != State.Claimed) revert BadState(w.state);
        if (block.timestamp >= w.claimEnds) revert TooLate(w.claimEnds);
        if (msg.value != challengeBond) revert BadBond();
        w.state = State.Challenged;
        w.challenger = msg.sender;
        w.respondBy = uint64(block.timestamp) + responseWindow;
        emit Challenged(id, msg.sender, w.respondBy);
    }

    /// Anyone (usually the operator): the payment, proven by SPV. Allowed while claimed (it settles at once) or
    /// challenged before respondBy. The operator is reimbursed; a challenger's bond goes to the operator.
    function prove(uint256 id, bytes calldata rawTx, bytes32 blockHash, uint256 index, bytes32[] calldata siblings) external {
        Withdrawal storage w = ws[id];
        if (w.state == State.Challenged) {
            if (block.timestamp > w.respondBy) revert TooLate(w.respondBy);
        } else if (w.state != State.Claimed) revert BadState(w.state);
        checkPayment(rawTx, w.vout, w.sats, w.scriptHash, id, w.operator);
        if (client.verifyTx(rawTx, blockHash, index, siblings, minConfirmations) != w.txid) revert BadPayment(6);
        address op = w.operator;
        if (w.state == State.Challenged) owedNative[op] += challengeBond;
        emit Proven(id, op);
        _reimburse(id, w);
    }

    /// Anyone, after the challenge window of an unchallenged claim: the operator is reimbursed.
    function finalize(uint256 id) external {
        Withdrawal storage w = ws[id];
        if (w.state != State.Claimed) revert BadState(w.state);
        if (block.timestamp < w.claimEnds) revert TooEarly(w.claimEnds);
        _reimburse(id, w);
    }

    /// Anyone, after an unanswered challenge: the operator loses bondPerClaim (half to the challenger, half to the
    /// holder), the challenger gets its bond back, the holder gets the escrow back.
    function slash(uint256 id) external {
        Withdrawal storage w = ws[id];
        if (w.state != State.Challenged) revert BadState(w.state);
        if (block.timestamp <= w.respondBy) revert TooEarly(w.respondBy);
        w.state = State.Slashed;
        address op = w.operator;
        uint256 b = bondPerClaim;
        lockedBond[op] -= b;
        bonded[op] -= b;
        escrowed -= w.amount;
        owedToken[w.holder] += w.amount;
        owedNative[w.holder] += b - b / 2;
        owedNative[w.challenger] += challengeBond + b / 2;
        emit Slashed(id, op, w.challenger, b);
    }

    function _reimburse(uint256 id, Withdrawal storage w) private {
        w.state = State.Paid;
        address op = w.operator;
        lockedBond[op] -= bondPerClaim;
        escrowed -= w.amount;
        owedToken[op] += w.amount;
        emit Reimbursed(id, op, w.amount);
    }

    /// Pays the caller everything it is owed (native and tokens).
    function withdraw() external nonReentrant {
        uint256 n = owedNative[msg.sender];
        uint256 t = owedToken[msg.sender];
        if (n == 0 && t == 0) revert Nothing();
        owedNative[msg.sender] = 0;
        owedToken[msg.sender] = 0;
        emit Withdrawn(msg.sender, n, t);
        if (t != 0 && !token.transfer(msg.sender, t)) revert TokenFailed();
        if (n != 0) {
            (bool ok, ) = msg.sender.call{value: n}("");
            if (!ok) revert PayFailed();
        }
    }

    // ---------------------------------------------------------------- views

    function count() external view returns (uint256) { return ws.length; }

    function withdrawal(uint256 id) external view returns (Withdrawal memory) { return ws[id]; }

    /// The OP_RETURN payload an operator's payment must carry for withdrawal `id`.
    function commitment(uint256 id, address operator) public pure returns (bytes memory) {
        return abi.encodePacked(TAG, uint64(id), operator);
    }

    /// Checks a raw (non-witness) Bitcoin transaction: output `vout` pays the script with keccak256 `scriptHash`
    /// at least `sats`, and some output is OP_RETURN <commitment(id, operator)> (34 bytes). Reverts with BadPayment.
    function checkPayment(bytes calldata t, uint32 vout, uint64 sats, bytes32 scriptHash, uint256 id, address operator) public pure {
        (uint64 value, bytes32 h, bool committed) = _scan(t, vout, keccak256(abi.encodePacked(bytes2(0x6a22), commitment(id, operator))));
        if (h != scriptHash) revert BadPayment(3);
        if (value < sats) revert BadPayment(4);
        if (!committed) revert BadPayment(5);
    }

    /// Output `vout`'s value and script hash, and whether another output's script hashes to `want`.
    function _scan(bytes calldata t, uint32 vout, bytes32 want) private pure returns (uint64 value, bytes32 h, bool committed) {
        uint256 p = _skipInputs(t);
        uint256 outs;
        (outs, p) = _varint(t, p);
        if (vout >= outs) revert BadPayment(2);
        for (uint256 i = 0; i < outs; i++) {
            (uint64 v, bytes32 sh, uint256 next) = _output(t, p);
            p = next;
            if (i == vout) { value = v; h = sh; }
            else if (sh == want) committed = true;
        }
        if (p + 4 != t.length) revert BadPayment(1);      // locktime, nothing after
    }

    /// Where the outputs start (after the version and the inputs).
    function _skipInputs(bytes calldata t) private pure returns (uint256 p) {
        uint256 n;
        (n, p) = _varint(t, 4);                           // version, then the input count
        for (uint256 i = 0; i < n; i++) {
            uint256 len;
            (len, p) = _varint(t, p + 36);                // outpoint, then the script length
            p += len + 4;                                 // script, sequence
        }
    }

    /// One output at `p`: its value, the keccak256 of its script, where the next output starts.
    function _output(bytes calldata t, uint256 p) private pure returns (uint64 value, bytes32 h, uint256 next) {
        if (p + 8 > t.length) revert BadPayment(1);
        value = _le64(t, p);
        uint256 len;
        (len, p) = _varint(t, p + 8);
        if (p + len > t.length) revert BadPayment(1);
        h = keccak256(t[p:p + len]);
        next = p + len;
    }

    function _varint(bytes calldata t, uint256 p) private pure returns (uint256 v, uint256 q) {
        if (p >= t.length) revert BadPayment(1);
        uint8 f = uint8(t[p]);
        if (f < 0xfd) return (f, p + 1);
        uint256 size = f == 0xfd ? 2 : f == 0xfe ? 4 : 8;
        if (p + 1 + size > t.length) revert BadPayment(1);
        for (uint256 i = 0; i < size; i++) v = v | (uint256(uint8(t[p + 1 + i])) << (8 * i));
        q = p + 1 + size;
    }

    function _le64(bytes calldata t, uint256 p) private pure returns (uint64 v) {
        for (uint256 i = 0; i < 8; i++) v = v | (uint64(uint8(t[p + i])) << uint64(8 * i));
    }
}
