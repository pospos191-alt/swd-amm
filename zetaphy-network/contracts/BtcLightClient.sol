// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BtcLightClient: Bitcoin headers and SPV proofs on ZETAPHY's EVM (prototype)
/// @notice For BTC -> ZETAPHY deposits: a contract on ZETAPHY learns Bitcoin's header chain from
///         anyone (permissionless relaying) and proves a transaction's inclusion. Checks per header,
///         as Bitcoin Core does for mainnet:
///           - double-SHA256 of the 80-byte header is at or below the target its `bits` encode,
///             and the target is at most the proof-of-work limit;
///           - it links to a known header (prev hash);
///           - difficulty: `bits` equals the parent's, except at heights divisible by 2016, where it
///             must equal the retarget (CalculateNextWorkRequired: parent target x actual timespan of
///             the period / two weeks, the timespan clamped to [1/4, 4] x two weeks, capped at the
///             limit, re-encoded compactly);
///           - timestamp above the median of the previous 11 (once 11 are known) and at most two
///             hours ahead of this chain's clock.
///         The best chain is the one with the most cumulative work (forks are kept; the tip moves to
///         the heavier branch). SPV: a transaction (its raw bytes, so 64-byte txs are refused) is
///         included in a block on the best chain with at least `minConfirmations` blocks on top.
///         Trust: the checkpoint (a recent header, its height, the period start time) is pinned at
///         deployment; after it, only Bitcoin's proof of work. An SPV light client accepts the chain
///         with the most work it was SHOWN: a relayer can withhold headers (liveness), and a miner
///         coalition can produce a fake branch at the cost of real work - deposits must wait for
///         enough confirmations for their value. Not checked: version rules (BIP 34/65/66/9),
///         transaction validity (only inclusion), and testnet's 20-minute rule (mainnet only).
///         Testnet prototype, not audited. See docs/future/trustless-bridge.md.
contract BtcLightClient {
    struct Header {
        bytes32 prev;
        bytes32 merkleRoot;
        uint64 height;
        uint32 time;
        uint32 bits;
        uint32 periodStart;   // time of the first block of this header's 2016-block period
        uint256 work;         // cumulative work from the checkpoint
    }

    uint256 public constant POW_LIMIT = 0x00000000ffff0000000000000000000000000000000000000000000000000000;
    uint256 public constant RETARGET = 2016;
    uint256 public constant TIMESPAN = 14 days;

    mapping(bytes32 => Header) private headers; // by block hash, internal byte order (as in `prev`)
    bytes32 public tip;
    bytes32 public immutable checkpoint;
    uint256 public immutable maxReorgWalk;

    event HeaderAdded(bytes32 indexed hash, uint64 height, uint256 work);
    event NewTip(bytes32 indexed hash, uint64 height);

    error BadHeader(uint256 code); // 1 length 2 unknown parent 3 bits 4 work 5 time 6 duplicate
    error BadProof(uint256 code);  // 1 unknown block 2 not on the best chain 3 confirmations 4 merkle 5 64-byte tx

    /// @param hash checkpoint block hash (internal order); @param periodStart time of block height - height % 2016
    constructor(bytes32 hash, uint64 height, uint32 time, uint32 bits, uint32 periodStart, uint256 maxReorgWalk_) {
        headers[hash] = Header(bytes32(0), bytes32(0), height, time, bits, periodStart, 1);
        tip = hash;
        checkpoint = hash;
        maxReorgWalk = maxReorgWalk_;
        emit NewTip(hash, height);
    }

    // ------------------------------------------------------------------ headers

    /// Adds consecutive raw headers (80 bytes each); each must link to a known header.
    function addHeaders(bytes calldata raw) external {
        if (raw.length == 0 || raw.length % 80 != 0) revert BadHeader(1);
        for (uint256 o = 0; o < raw.length; o += 80) _add(raw[o:o + 80]);
    }

    function _add(bytes calldata h) private {
        bytes32 hash = dsha(h);
        if (headers[hash].work != 0) revert BadHeader(6);
        bytes32 prev = bytes32(h[4:36]);
        Header storage p = headers[prev];
        if (p.work == 0) revert BadHeader(2);
        uint32 time = _le32(h, 68);
        uint32 bits = _le32(h, 72);
        uint64 height = p.height + 1;

        uint256 target = targetOf(bits);
        if (target == 0 || target > POW_LIMIT) revert BadHeader(3);
        if (_reverse(hash) > target) revert BadHeader(4);
        if (height % RETARGET == 0) {
            if (bits != nextBits(p.bits, p.periodStart, p.time)) revert BadHeader(3);
        } else if (bits != p.bits) revert BadHeader(3);
        if (time > block.timestamp + 2 hours || time <= _medianTimePast(prev)) revert BadHeader(5);

        uint256 work = p.work + workOf(target);
        headers[hash] = Header(prev, bytes32(h[36:68]), height, time, bits, height % RETARGET == 0 ? time : p.periodStart, work);
        emit HeaderAdded(hash, height, work);
        if (work > headers[tip].work) {
            tip = hash;
            emit NewTip(hash, height);
        }
    }

    /// Median of the last 11 block times ending at `h` (0 while fewer than 11 are known).
    function _medianTimePast(bytes32 h) private view returns (uint256) {
        uint256[11] memory t;
        for (uint256 i = 0; i < 11; i++) {
            Header storage x = headers[h];
            if (x.work == 0 || (x.prev == bytes32(0) && i < 10)) return 0;
            t[i] = x.time;
            h = x.prev;
        }
        for (uint256 i = 1; i < 11; i++) {
            uint256 v = t[i];
            uint256 j = i;
            while (j > 0 && t[j - 1] > v) { t[j] = t[j - 1]; j--; }
            t[j] = v;
        }
        return t[5];
    }

    // ------------------------------------------------------------------ SPV

    /// The txid (internal order) of a raw non-witness transaction included in block `blockHash`
    /// at `index` (siblings: the Merkle branch, bottom-up), with at least `minConfirmations` on the
    /// best chain (1 = the block itself is the tip).
    function verifyTx(bytes calldata rawTx, bytes32 blockHash, uint256 index, bytes32[] calldata siblings, uint256 minConfirmations)
        external view returns (bytes32 txid)
    {
        if (rawTx.length == 64) revert BadProof(5); // a 64-byte "tx" could be an inner Merkle node
        txid = dsha(rawTx);
        _included(txid, blockHash, index, siblings, minConfirmations);
    }

    /// Inclusion of a txid (internal order); the caller must know the tx is not 64 bytes long.
    function verifyTxid(bytes32 txid, bytes32 blockHash, uint256 index, bytes32[] calldata siblings, uint256 minConfirmations)
        external view returns (bool)
    {
        _included(txid, blockHash, index, siblings, minConfirmations);
        return true;
    }

    function _included(bytes32 txid, bytes32 blockHash, uint256 index, bytes32[] calldata siblings, uint256 minConfirmations) private view {
        Header storage b = headers[blockHash];
        if (b.work == 0 || blockHash == checkpoint) revert BadProof(1);
        Header storage t = headers[tip];
        if (t.height < b.height || t.height - b.height + 1 < minConfirmations) revert BadProof(3);
        if (!onBestChain(blockHash)) revert BadProof(2);
        bytes32 node = txid;
        uint256 i = index;
        for (uint256 k = 0; k < siblings.length; k++) {
            node = i & 1 == 1 ? dsha(abi.encodePacked(siblings[k], node)) : dsha(abi.encodePacked(node, siblings[k]));
            i >>= 1;
        }
        if (i != 0 || node != b.merkleRoot) revert BadProof(4);
    }

    /// Whether `hash` is an ancestor of (or is) the tip, within maxReorgWalk blocks.
    function onBestChain(bytes32 hash) public view returns (bool) {
        Header storage b = headers[hash];
        if (b.work == 0) return false;
        bytes32 h = tip;
        uint64 target = b.height;
        for (uint256 i = 0; i <= maxReorgWalk; i++) {
            Header storage x = headers[h];
            if (x.height == target) return h == hash;
            if (x.height < target || x.prev == bytes32(0)) return false;
            h = x.prev;
        }
        return false;
    }

    // ------------------------------------------------------------------ difficulty

    /// Bitcoin's compact target ("nBits") as an integer (0 for negative or overflowing encodings).
    function targetOf(uint32 bits) public pure returns (uint256) {
        uint256 exp = bits >> 24;
        uint256 mant = bits & 0x007fffff;
        if (bits & 0x00800000 != 0 || exp > 32) return 0;
        return exp <= 3 ? mant >> (8 * (3 - exp)) : mant << (8 * (exp - 3));
    }

    /// arith_uint256::GetCompact
    function compactOf(uint256 target) public pure returns (uint32) {
        uint256 size = 0;
        for (uint256 t = target; t > 0; t >>= 8) size++;
        uint256 c = size <= 3 ? target << (8 * (3 - size)) : target >> (8 * (size - 3));
        if (c & 0x00800000 != 0) { c >>= 8; size++; }
        return uint32(c | (size << 24));
    }

    /// CalculateNextWorkRequired (mainnet): bits of the first block of the next period.
    function nextBits(uint32 lastBits, uint256 firstTime, uint256 lastTime) public pure returns (uint32) {
        uint256 span = lastTime > firstTime ? lastTime - firstTime : 0;
        if (span < TIMESPAN / 4) span = TIMESPAN / 4;
        if (span > TIMESPAN * 4) span = TIMESPAN * 4;
        uint256 t = targetOf(lastBits) * span / TIMESPAN;
        if (t > POW_LIMIT) t = POW_LIMIT;
        return compactOf(t);
    }

    /// Expected hashes for a target: 2^256 / (target + 1).
    function workOf(uint256 target) public pure returns (uint256) {
        return (type(uint256).max - target) / (target + 1) + 1;
    }

    // ------------------------------------------------------------------ reading

    function header(bytes32 hash) external view returns (Header memory) {
        return headers[hash];
    }

    function tipHeight() external view returns (uint64) {
        return headers[tip].height;
    }

    function dsha(bytes memory b) public pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(b)));
    }

    function _le32(bytes calldata h, uint256 o) private pure returns (uint32) {
        return uint32(uint8(h[o])) | (uint32(uint8(h[o + 1])) << 8) | (uint32(uint8(h[o + 2])) << 16) | (uint32(uint8(h[o + 3])) << 24);
    }

    function _reverse(bytes32 x) private pure returns (uint256 v) {
        uint256 a = uint256(x);
        for (uint256 i = 0; i < 32; i++) { v = (v << 8) | (a & 0xff); a >>= 8; }
    }
}
