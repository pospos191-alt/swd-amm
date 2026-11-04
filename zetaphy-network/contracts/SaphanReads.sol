// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan cross-chain reads: "what is value V on chain X at block B"
/// @notice Saphan PR 5 (docs/SAPHAN-PR5.md), testnet only, not audited. Three contracts and a library:
///
///   SaphanReads (ZETAPHY, one per source chain X) keeps the newest known answer to each question about X, with the
///     X block it is from. Answers come two ways, both without a new signer:
///       - lane answers: SaphanReadResponder on X runs a view call on X and sends the result, its block number and
///         time through X's Hyperlane Mailbox; the Mailbox on ZETAPHY checks the route's ISM (the Hyperlane
///         validators that already attest every transfer from X) before handle() records it;
///       - proven answers: a storage slot or account of X checked against X's state root at block B, given by a
///         light client of X (`stateRoots`), with the Merkle-Patricia proofs of eth_getProof (SaphanMpt). No light
///         client of an EVM chain runs on ZETAPHY yet: until one does, `stateRoots` is zero and only lane answers
///         are used (the verifier itself is complete and tested against an EVM's own proofs).
///     The caller pays: request*() posts a bounty in ZTPHY for an answer at block >= minBlock before a deadline;
///     whoever brought that answer collects it (pull). read*() refuses an answer older than the caller allows
///     (block below minBlock, or time older than maxAge): stale answers are never served.
///   SaphanReadResponder (source chain X): anyone asks it to answer a view call; the answerer pays the Mailbox fee.
///     It gives the call a fixed gas budget and checks it is there first, so nobody can make a call fail on purpose.
///   SaphanZetaphyReads (source chain X): the other way round, a storage slot of any ZETAPHY contract verified from
///     ZETAPHY's state at a height the STARK light client finalized (the SaphanReleaseVerifier pattern: IAVL path to
///     the evm store, multistore path to the app hash); a view a contract on X calls with the proof.

/// What a light client of chain X tells: X's state root (and block time) at a block it accepted. Zero: unknown.
interface IReadsStateRoots {
    function stateRootAt(uint64 blockNumber) external view returns (bytes32 stateRoot, uint64 timestamp);
}

interface IReadsMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256);
}

/// @notice Ethereum Merkle-Patricia proofs (the `accountProof` / `storageProof` of eth_getProof), checked in memory.
///         Proofs of absence (a path that ends in an empty branch slot or a diverging leaf / extension) give an empty
///         value. Nodes shorter than 32 bytes embedded in their parent are refused: with keccak-hashed 32-byte keys
///         they do not occur in practice, and refusing them keeps the walk simple.
library SaphanMpt {
    bytes32 internal constant EMPTY_TRIE = 0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421; // keccak256(0x80)
    bytes32 internal constant EMPTY_CODE = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470; // keccak256("")

    error BadProof(uint256 step);

    /// The value at `key` (already hashed) under `root`; empty when the proof shows there is none.
    function get(bytes32 root, bytes32 key, bytes[] memory proof) internal pure returns (bytes memory) {
        bytes32 want = root;
        uint256 pos = 0;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes memory node = proof[i];
            if (keccak256(node) != want) revert BadProof(i);
            (bool done, bytes memory value, bytes32 next, uint256 npos) = _step(node, key, pos, i);
            if (done) {
                if (i + 1 != proof.length) revert BadProof(i); // an answer must end the proof
                return value;
            }
            (want, pos) = (next, npos);
        }
        revert BadProof(proof.length); // the proof stops before an answer
    }

    /// One node of the walk: the answer (done), or the next node's hash and the key position after this node.
    function _step(bytes memory node, bytes32 key, uint256 pos, uint256 i)
        private pure returns (bool done, bytes memory value, bytes32 next, uint256 npos)
    {
        (uint256[2][17] memory it, uint256 n) = _node(node);
        if (n == 17) { // branch
            if (pos >= 64) revert BadProof(i);
            uint256[2] memory child = it[_nibble(key, pos)];
            if (child[1] == 0) return (true, "", 0, 0);   // an empty slot: no value
            if (child[1] != 32) revert BadProof(i);
            return (false, "", _word(node, child[0]), pos + 1);
        }
        if (n != 2) revert BadProof(i);
        (bool matched, uint256 plen, bool leaf) = _path(node, it[0][0], it[0][1], key, pos, i);
        if (!matched) return (true, "", 0, 0);            // the path leaves the key: no value
        if (leaf) return (true, pos + plen == 64 ? _slice(node, it[1][0], it[1][1]) : bytes(""), 0, 0);
        if (it[1][1] != 32) revert BadProof(i);           // extension: a hash
        return (false, "", _word(node, it[1][0]), pos + plen);
    }

    /// A leaf / extension path (hex-prefix encoded at node[p..p+l]) against the key from nibble `pos`.
    function _path(bytes memory node, uint256 p, uint256 l, bytes32 key, uint256 pos, uint256 i)
        private pure returns (bool matched, uint256 plen, bool leaf)
    {
        if (l == 0) revert BadProof(i);
        uint8 flag = uint8(node[p]) >> 4;
        if (flag > 3) revert BadProof(i);
        leaf = flag >= 2;
        uint256 skip = flag & 1 == 1 ? 1 : 2;
        plen = l * 2 - skip;
        for (uint256 j = 0; j < plen; j++) {
            uint256 k = j + skip;
            uint8 pn = k % 2 == 0 ? uint8(node[p + k / 2]) >> 4 : uint8(node[p + k / 2]) & 0x0f;
            if (pos + j >= 64 || pn != _nibble(key, pos + j)) return (false, plen, leaf);
        }
        matched = true;
    }

    /// An account of the state trie: (exists, nonce, balance, storage root, code hash).
    function account(bytes32 stateRoot, address who, bytes[] memory proof)
        internal pure returns (bool exists, uint256 nonce, uint256 balance, bytes32 storageRoot, bytes32 codeHash)
    {
        bytes memory v = get(stateRoot, keccak256(abi.encodePacked(who)), proof);
        if (v.length == 0) return (false, 0, 0, EMPTY_TRIE, EMPTY_CODE);
        (uint256[2][17] memory it, uint256 n) = _node(v);
        if (n != 4 || it[2][1] != 32 || it[3][1] != 32 || it[0][1] > 32 || it[1][1] > 32) revert BadProof(100);
        return (true, _uint(v, it[0][0], it[0][1]), _uint(v, it[1][0], it[1][1]), _word(v, it[2][0]), _word(v, it[3][0]));
    }

    /// A storage slot under an account's storage root (zero when absent).
    function slot(bytes32 storageRoot, bytes32 key, bytes[] memory proof) internal pure returns (uint256) {
        if (storageRoot == EMPTY_TRIE) { if (proof.length != 0) revert BadProof(200); return 0; }
        bytes memory v = get(storageRoot, keccak256(abi.encode(key)), proof);
        if (v.length == 0) return 0;
        (uint256 p, uint256 l, bool list) = _item(v, 0);
        if (list || l > 32 || p + l != v.length) revert BadProof(201);
        return _uint(v, p, l);
    }

    // ---- RLP ----

    /// The items of the list that is the whole of `b`: (payload offset, payload length) each; lists inside are refused.
    function _node(bytes memory b) private pure returns (uint256[2][17] memory it, uint256 n) {
        (uint256 p, uint256 l, bool list) = _item(b, 0);
        if (!list || p + l != b.length) revert BadProof(300);
        uint256 end = p + l;
        while (p < end) {
            if (n == 17) revert BadProof(301);
            (uint256 ip, uint256 il, bool inner) = _item(b, p);
            if (inner) revert BadProof(302); // an embedded node
            it[n] = [ip, il];
            n += 1;
            p = ip + il;
        }
        if (p != end) revert BadProof(303);
    }

    function _item(bytes memory b, uint256 off) private pure returns (uint256 p, uint256 len, bool list) {
        if (off >= b.length) revert BadProof(400);
        uint8 x = uint8(b[off]);
        if (x < 0x80) return (off, 1, false);
        if (x < 0xb8) { len = x - 0x80; p = off + 1; }
        else if (x < 0xc0) { uint256 ll = x - 0xb7; len = _be(b, off + 1, ll); p = off + 1 + ll; }
        else if (x < 0xf8) { len = x - 0xc0; p = off + 1; list = true; }
        else { uint256 ll = x - 0xf7; len = _be(b, off + 1, ll); p = off + 1 + ll; list = true; }
        if (p + len > b.length) revert BadProof(401);
    }

    function _be(bytes memory b, uint256 off, uint256 n) private pure returns (uint256 v) {
        if (n > 4 || off + n > b.length) revert BadProof(402);
        for (uint256 i = 0; i < n; i++) v = (v << 8) | uint8(b[off + i]);
    }

    function _uint(bytes memory b, uint256 p, uint256 l) private pure returns (uint256 v) {
        for (uint256 i = 0; i < l; i++) v = (v << 8) | uint8(b[p + i]);
    }

    function _word(bytes memory b, uint256 p) private pure returns (bytes32 w) {
        assembly { w := mload(add(add(b, 0x20), p)) }
    }

    function _slice(bytes memory b, uint256 p, uint256 l) private pure returns (bytes memory out) {
        out = new bytes(l);
        for (uint256 i = 0; i < l; i++) out[i] = b[p + i];
    }

    function _nibble(bytes32 key, uint256 i) private pure returns (uint8) {
        uint8 byt = uint8(key[i / 2]);
        return i % 2 == 0 ? byt >> 4 : byt & 0x0f;
    }
}

/// @title SaphanReads: answers about source chain X on ZETAPHY, each with the X block it is from
contract SaphanReads {
    bytes32 public constant CALL_TAG = keccak256("saphan/reads/call/v1");
    bytes32 public constant SLOT_TAG = keccak256("saphan/reads/slot/v1");
    bytes32 public constant ACCOUNT_TAG = keccak256("saphan/reads/account/v1");
    /// An answer may be at most this far ahead of ZETAPHY's clock (clocks of two chains differ a little).
    uint64 public constant MAX_SKEW = 5 minutes;
    /// The longest a request waits for its answer.
    uint64 public constant MAX_TTL = 7 days;
    /// The longest result kept (SaphanReadResponder sends no longer one).
    uint256 public constant MAX_RESULT = 1024;

    struct Answer {
        uint64 blockNumber;  // the X block the answer is from
        uint64 timestamp;    // that block's time
        uint64 arrivedAt;    // when it reached ZETAPHY
        bool ok;             // a view call: it did not revert
        address by;          // who brought it (the answerer on X, or the prover here): collects bounties
        bytes result;        // a view call: its return data; a slot: abi.encode(value); an account: abi.encode(nonce, balance, storageRoot, codeHash)
    }

    struct Request {
        address requester;
        uint64 minBlock;
        uint64 expires;
        bool done;
        bytes32 query;
        uint256 bounty;
    }

    uint256 public immutable remoteChainId;     // X
    uint32 public immutable originDomain;       // X's Hyperlane domain
    address public immutable mailbox;           // the Mailbox on ZETAPHY
    /// Hyperlane reads it (ISpecifiesInterchainSecurityModule): the route's ISM of Hyperlane's validators for X.
    address public immutable interchainSecurityModule;
    IReadsStateRoots public immutable stateRoots; // a light client of X; zero: no proven answers yet
    address public immutable deployer;
    bytes32 public responder;                   // SaphanReadResponder on X (set once, then fixed)

    mapping(bytes32 => Answer) private _answers;
    mapping(uint256 => Request) public requests;
    uint256 public requestCount;
    mapping(address => uint256) public credit;  // bounties collected, taken with claim()
    uint256 private entered;

    event ResponderSet(bytes32 responder);
    event Answered(bytes32 indexed query, uint64 blockNumber, uint64 timestamp, bool ok, address by, bool proven);
    event Ignored(bytes32 indexed query, uint64 blockNumber);
    event Requested(uint256 indexed id, bytes32 indexed query, uint64 minBlock, uint64 expires, uint256 bounty, uint8 kind, address target, bytes data);
    event Collected(uint256 indexed id, address indexed by, uint256 bounty);
    event Cancelled(uint256 indexed id);
    event Claimed(address indexed who, uint256 amount);

    error NotMailbox();
    error NoValue();
    error WrongOrigin();
    error WrongSender();
    error NoLightClient();
    error UnknownBlock();
    error Older();
    error BadAnswer();
    error NoAnswer();
    error Stale(uint64 blockNumber, uint64 timestamp);
    error CallReverted();
    error BadRequest();
    error NotReady();
    error PayFailed();
    error Reentered();

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(uint256 remoteChainId_, address mailbox_, uint32 originDomain_, address ism_, IReadsStateRoots stateRoots_) {
        require(remoteChainId_ != 0 && mailbox_ != address(0), "config");
        remoteChainId = remoteChainId_;
        mailbox = mailbox_;
        originDomain = originDomain_;
        interchainSecurityModule = ism_;
        stateRoots = stateRoots_;
        deployer = msg.sender;
    }

    /// Once, by the deployer: the responder on X (deployed after this contract, it names this one).
    function setResponder(address r) external {
        require(msg.sender == deployer && responder == bytes32(0) && r != address(0), "responder");
        responder = bytes32(uint256(uint160(r)));
        emit ResponderSet(responder);
    }

    // ---- questions ----

    function callQuery(address target, bytes calldata data) public view returns (bytes32) { return _callQuery(target, keccak256(data)); }
    function slotQuery(address account, bytes32 slot_) public view returns (bytes32) { return keccak256(abi.encode(SLOT_TAG, remoteChainId, account, slot_)); }
    function accountQuery(address account) public view returns (bytes32) { return keccak256(abi.encode(ACCOUNT_TAG, remoteChainId, account)); }
    function _callQuery(address target, bytes32 dataHash) private view returns (bytes32) { return keccak256(abi.encode(CALL_TAG, remoteChainId, target, dataHash)); }

    // ---- answers ----

    /// The Mailbox, after the ISM checked the message: a view call answered on X by the responder.
    /// A message that cannot be used (older than what is known, too far in the future) is consumed and ignored,
    /// so it never blocks the Mailbox.
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != mailbox) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (origin != originDomain) revert WrongOrigin();
        if (sender != responder || sender == bytes32(0)) revert WrongSender();
        (address target, bytes32 dataHash, uint64 blockNumber, uint64 timestamp, bool ok, bytes memory result, address by) =
            abi.decode(body, (address, bytes32, uint64, uint64, bool, bytes, address));
        bytes32 q = _callQuery(target, dataHash);
        if (!_record(q, blockNumber, timestamp, ok, result, by, false)) emit Ignored(q, blockNumber);
    }

    /// Anyone: a storage slot of `account` on X at `blockNumber`, proven against the light client's state root.
    function proveSlot(uint64 blockNumber, address account, bytes32 slot_, bytes[] calldata accountProof, bytes[] calldata storageProof)
        external returns (uint256 value)
    {
        (bytes32 root, uint64 ts) = _root(blockNumber);
        (, , , bytes32 storageRoot, ) = SaphanMpt.account(root, account, accountProof);
        value = SaphanMpt.slot(storageRoot, slot_, storageProof);
        if (!_record(slotQuery(account, slot_), blockNumber, ts, true, abi.encode(value), msg.sender, true)) revert Older();
    }

    /// Anyone: an account of X (nonce, balance, storage root, code hash) at `blockNumber`, proven the same way.
    function proveAccount(uint64 blockNumber, address account, bytes[] calldata accountProof) external {
        (bytes32 root, uint64 ts) = _root(blockNumber);
        (, uint256 nonce, uint256 balance, bytes32 storageRoot, bytes32 codeHash) = SaphanMpt.account(root, account, accountProof);
        if (!_record(accountQuery(account), blockNumber, ts, true, abi.encode(nonce, balance, storageRoot, codeHash), msg.sender, true)) revert Older();
    }

    function _root(uint64 blockNumber) private view returns (bytes32 root, uint64 ts) {
        if (address(stateRoots) == address(0)) revert NoLightClient();
        (root, ts) = stateRoots.stateRootAt(blockNumber);
        if (root == bytes32(0)) revert UnknownBlock();
    }

    /// Keeps an answer when it is newer than the one known (answers never go back in time).
    function _record(bytes32 q, uint64 blockNumber, uint64 timestamp, bool ok, bytes memory result, address by, bool proven) private returns (bool) {
        Answer storage a = _answers[q];
        if (a.arrivedAt != 0 && blockNumber <= a.blockNumber) return false;
        if (timestamp > block.timestamp + MAX_SKEW || result.length > MAX_RESULT) return false;
        _answers[q] = Answer(blockNumber, timestamp, uint64(block.timestamp), ok, by, result);
        emit Answered(q, blockNumber, timestamp, ok, by, proven);
        return true;
    }

    // ---- reading (stale answers refused) ----

    /// The newest answer, if it is from block >= minBlock and its time is at most maxAge seconds old.
    function read(bytes32 query, uint64 minBlock, uint64 maxAge) public view returns (bool ok, bytes memory result, uint64 blockNumber, uint64 timestamp) {
        Answer storage a = _answers[query];
        if (a.arrivedAt == 0) revert NoAnswer();
        if (a.blockNumber < minBlock || uint256(a.timestamp) + maxAge < block.timestamp) revert Stale(a.blockNumber, a.timestamp);
        return (a.ok, a.result, a.blockNumber, a.timestamp);
    }

    /// A view call's return data (reverts CallReverted when the call reverted on X).
    function readCall(address target, bytes calldata data, uint64 minBlock, uint64 maxAge) external view returns (bytes memory result, uint64 blockNumber, uint64 timestamp) {
        bool ok;
        (ok, result, blockNumber, timestamp) = read(callQuery(target, data), minBlock, maxAge);
        if (!ok) revert CallReverted();
    }

    function readSlot(address account, bytes32 slot_, uint64 minBlock, uint64 maxAge) external view returns (uint256 value, uint64 blockNumber, uint64 timestamp) {
        bytes memory r;
        (, r, blockNumber, timestamp) = read(slotQuery(account, slot_), minBlock, maxAge);
        value = abi.decode(r, (uint256));
    }

    function readBalance(address account, uint64 minBlock, uint64 maxAge) external view returns (uint256 balance, uint64 blockNumber, uint64 timestamp) {
        bytes memory r;
        (, r, blockNumber, timestamp) = read(accountQuery(account), minBlock, maxAge);
        (, balance, , ) = abi.decode(r, (uint256, uint256, bytes32, bytes32));
    }

    /// The newest answer as stored (no age check), for explorers.
    function answerOf(bytes32 query) external view returns (Answer memory) { return _answers[query]; }

    // ---- requests: the caller pays ----

    uint8 internal constant KIND_CALL = 0;
    uint8 internal constant KIND_SLOT = 1;
    uint8 internal constant KIND_ACCOUNT = 2;

    /// A bounty (msg.value) for an answer of `target.call(data)` on X at block >= minBlock, within ttl seconds.
    function requestCall(address target, bytes calldata data, uint64 minBlock, uint64 ttl) external payable returns (uint256) {
        return _request(callQuery(target, data), minBlock, ttl, KIND_CALL, target, data);
    }

    function requestSlot(address account, bytes32 slot_, uint64 minBlock, uint64 ttl) external payable returns (uint256) {
        return _request(slotQuery(account, slot_), minBlock, ttl, KIND_SLOT, account, abi.encode(slot_));
    }

    function requestAccount(address account, uint64 minBlock, uint64 ttl) external payable returns (uint256) {
        return _request(accountQuery(account), minBlock, ttl, KIND_ACCOUNT, account, "");
    }

    function _request(bytes32 q, uint64 minBlock, uint64 ttl, uint8 kind, address target, bytes memory data) private returns (uint256 id) {
        if (msg.value == 0 || ttl == 0 || ttl > MAX_TTL) revert BadRequest();
        id = requestCount++;
        uint64 expires = uint64(block.timestamp) + ttl;
        requests[id] = Request(msg.sender, minBlock, expires, false, q, msg.value);
        emit Requested(id, q, minBlock, expires, msg.value, kind, target, data);
    }

    /// Anyone, once an answer from block >= minBlock arrived before the request expired: its bringer gets the bounty.
    function collect(uint256 id) external {
        Request storage r = requests[id];
        Answer storage a = _answers[r.query];
        if (r.requester == address(0) || r.done) revert BadRequest();
        if (a.arrivedAt == 0 || a.blockNumber < r.minBlock || a.arrivedAt > r.expires) revert NotReady();
        r.done = true;
        credit[a.by] += r.bounty;
        emit Collected(id, a.by, r.bounty);
    }

    /// The requester, after an unanswered request expired: the bounty back (credited, then claim()).
    function cancel(uint256 id) external {
        Request storage r = requests[id];
        if (r.requester != msg.sender || r.done) revert BadRequest();
        if (block.timestamp <= r.expires) revert NotReady();
        r.done = true;
        credit[msg.sender] += r.bounty;
        emit Cancelled(id);
    }

    /// What the caller collected or got back.
    function claim() external nonReentrant {
        uint256 v = credit[msg.sender];
        if (v == 0) revert NotReady();
        credit[msg.sender] = 0;
        emit Claimed(msg.sender, v);
        (bool ok, ) = msg.sender.call{value: v}("");
        if (!ok) revert PayFailed();
    }
}

/// @title SaphanReadResponder: on source chain X, answers view calls to SaphanReads on ZETAPHY through Hyperlane
contract SaphanReadResponder {
    /// The gas every view call gets (fixed, so an answerer cannot make a call fail by giving it less).
    uint256 public constant READ_GAS = 500_000;
    uint256 public constant MAX_RESULT = 1024;

    IReadsMailbox public immutable mailbox;   // X's Mailbox
    uint32 public immutable zetaphyDomain;
    bytes32 public immutable reads;           // SaphanReads(X) on ZETAPHY

    event Answer(bytes32 indexed messageId, address indexed target, bytes32 dataHash, uint64 blockNumber, address by);

    error Fee(uint256 needed);
    error LowGas();

    constructor(IReadsMailbox mailbox_, uint32 zetaphyDomain_, address reads_) {
        require(address(mailbox_) != address(0) && reads_ != address(0), "config");
        mailbox = mailbox_;
        zetaphyDomain = zetaphyDomain_;
        reads = bytes32(uint256(uint160(reads_)));
    }

    /// The message an answer of `target.call(data)` made now by `by` would carry (a result longer than MAX_RESULT
    /// counts as a failed call, so every answer fits).
    function body(address target, bytes calldata data, address by) public view returns (bytes memory) {
        if (gasleft() < READ_GAS + READ_GAS / 63 + 30_000) revert LowGas();
        (bool ok, bytes memory result) = target.staticcall{gas: READ_GAS}(data);
        if (result.length > MAX_RESULT) { ok = false; result = ""; }
        return abi.encode(target, keccak256(data), uint64(block.number), uint64(block.timestamp), ok, result, by);
    }

    function quote(address target, bytes calldata data) external view returns (uint256) {
        return mailbox.quoteDispatch(zetaphyDomain, reads, body(target, data, msg.sender));
    }

    /// Anyone: answers `target.call(data)` at this block. msg.value: exactly the Mailbox fee (quote).
    function answer(address target, bytes calldata data) external payable returns (bytes32 messageId) {
        bytes memory b = body(target, data, msg.sender);
        uint256 fee = mailbox.quoteDispatch(zetaphyDomain, reads, b);
        if (msg.value != fee) revert Fee(fee);
        messageId = mailbox.dispatch{value: fee}(zetaphyDomain, reads, b);
        emit Answer(messageId, target, keccak256(data), uint64(block.number), msg.sender);
    }
}

interface IReadsLightClient {
    function appHashAt(uint64 height) external view returns (bytes32);
}

/// ZetaphyBridgeInbox's pure proof functions (any deployed instance).
interface IReadsZetaphyProofs {
    struct InnerOp { bytes prefix; bytes suffix; }
    function iavlRoot(bytes memory key, bytes32 value, bytes calldata leafPrefix, InnerOp[] calldata path) external pure returns (bytes32);
    function storeRoot(bytes memory name, bytes32 root, InnerOp[] calldata path) external pure returns (bytes32);
}

/// @title SaphanZetaphyReads: on a source chain, a storage slot of a ZETAPHY contract proven from ZETAPHY's state
/// @notice A view: a contract on this chain calls verify() inside its own transaction with the proof (nothing is
///         stored, so every reader checks its own proof and decides how recent it must be).
contract SaphanZetaphyReads {
    IReadsLightClient public immutable lightClient; // StarkLightClient: ZETAPHY finality on this chain
    IReadsZetaphyProofs public immutable proofs;

    error BadStateProof(uint256 step);
    error Stale(uint64 height, uint64 minHeight);

    constructor(IReadsLightClient lc, IReadsZetaphyProofs proofs_) {
        require(address(lc) != address(0) && address(proofs_) != address(0), "config");
        lightClient = lc;
        proofs = proofs_;
    }

    /// Returns `value` when `account`'s storage `slot` holds it at ZETAPHY height `height` (final in the light client)
    /// and height >= minHeight; reverts otherwise. An existence proof: a slot never written cannot be shown this way.
    function verify(uint64 height, uint64 minHeight, address account, bytes32 slot, bytes32 value, bytes calldata leafPrefix,
        IReadsZetaphyProofs.InnerOp[] calldata iavlPath, IReadsZetaphyProofs.InnerOp[] calldata storePath) external view returns (bytes32)
    {
        if (height < minHeight) revert Stale(height, minHeight);
        bytes32 app = lightClient.appHashAt(height);
        if (app == bytes32(0)) revert BadStateProof(0);
        bytes32 evmRoot = proofs.iavlRoot(abi.encodePacked(uint8(2), account, slot), value, leafPrefix, iavlPath);
        if (proofs.storeRoot("evm", evmRoot, storePath) != app) revert BadStateProof(1);
        return value;
    }
}
