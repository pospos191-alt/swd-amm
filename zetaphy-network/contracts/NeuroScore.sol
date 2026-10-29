// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title NeuroScore: Neuro's learned risk model (gradient-boosted trees), evaluated on-chain
/// @notice The model is zetaphy-neuro/ml/model.json exported to integers by
///         zetaphy-neuro/ml/onchain/export.js (format "NSM1", see ml/onchain/fixed.js):
///         160 trees of depth <= 4 packed in 6 bytes per node, ~18.6 KB, stored as the
///         code of one or more data contracts (read with EXTCODECOPY).
///
///         Score = the calibrated logit times 1e7: p = sigmoid(score / 1e7). Levels
///         (1 low, 2 medium, 3 high) are thresholds on it, set with the model.
///
///         Who does what:
///           - anyone publishes model bytes (publishModel): checked for format, stored,
///             keyed by keccak256(bytes) = the model hash H. Publishing changes nothing.
///           - governance (the ZetaphyTimelock: every change waits its public delay)
///             activates a published model by its hash (activateModel), and appoints
///             feeders. This contract is the model registry: every activation is a
///             numbered version with its hash, model id and level thresholds.
///           - a feeder (a Neuro runner relay governance appointed) posts the feature
///             vector Neuro computed for a token (postFeatures); the contract runs the
///             model on it and stores the score with the vector's hash.
///           - anyone re-runs a stored vector under the current model (rescore) after
///             a model change; until then the old score reads as unknown (scoreOf).
///         What the chain proves: the stored score IS the active model applied to the
///         posted vector. It does not prove the vector is what Neuro would compute
///         for the token: a feeder is trusted for that (the zkML prototype in
///         ml/onchain/zk/ proves the model step off-chain; it has the same gap).
///         A score is a statistical estimate, not a finding about a project.
contract NeuroScore {
    /// The ZetaphyTimelock (or, on a devnet, a multisig): activates models, appoints feeders.
    address public immutable governance;

    /// Most bytes one data contract holds (EIP-170 limit minus the leading STOP byte).
    uint256 public constant CHUNK = 24_575;
    uint256 private constant HEADER = 24;
    uint256 private constant NODE_BYTES = 6;

    struct Model {
        bytes32 hash; // keccak256 of the packed bytes (the model hash H)
        bytes32 modelId; // e.g. "nml-b4c35477f7b1"
        uint16 nFeatures;
        int64 low;
        int64 medium;
        int64 high;
        uint64 activatedAt;
    }

    struct Score {
        int64 score;
        uint32 version;
        uint8 level;
        uint64 time;
        bytes32 featuresHash;
    }

    /// Published models: hash -> the data contracts holding its bytes, in order.
    mapping(bytes32 => address[]) private _chunks;
    mapping(bytes32 => uint256) public publishedSize;
    /// Activated models: version (1, 2, ...) -> model. version 0 = none yet.
    mapping(uint32 => Model) private _models;
    uint32 public version;
    mapping(address => bool) public feeder;
    mapping(address => Score) private _scores;

    event ModelPublished(bytes32 indexed hash, uint256 size, uint256 chunks);
    event ModelActivated(uint32 indexed version, bytes32 indexed hash, bytes32 modelId, int64 low, int64 medium, int64 high);
    event FeederSet(address indexed feeder, bool allowed);
    event Scored(address indexed token, uint32 indexed version, int64 score, uint8 level, bytes32 featuresHash, bytes features);

    error NotGovernance();
    error NotFeeder();
    error ZeroAddress();
    error BadModel(uint256 at);
    error NotPublished();
    error NoModel();
    error BadFeatures();
    error UnknownFeatures();
    error BadLevels();

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    // ---- models ----

    /// Stores model bytes (after checking the format) as data contracts. Anyone may
    /// call it; it activates nothing. Returns the model hash.
    function publishModel(bytes calldata data) external returns (bytes32 hash) {
        hash = keccak256(data);
        if (publishedSize[hash] != 0) return hash;
        _validate(data);
        address[] storage list = _chunks[hash];
        for (uint256 o = 0; o < data.length; o += CHUNK) {
            uint256 end = o + CHUNK < data.length ? o + CHUNK : data.length;
            list.push(_store(data[o:end]));
        }
        publishedSize[hash] = data.length;
        emit ModelPublished(hash, data.length, list.length);
    }

    /// Governance only (the timelock): makes a published model the active one.
    /// Levels are fixed calibrated logits (low <= medium <= high).
    function activateModel(bytes32 hash, bytes32 modelId, int64 low, int64 medium, int64 high) external onlyGov {
        if (publishedSize[hash] == 0) revert NotPublished();
        if (low > medium || medium > high) revert BadLevels();
        bytes memory m = _load(hash);
        uint16 nf;
        assembly { nf := and(shr(240, shl(32, mload(add(m, 32)))), 0xffff) }
        uint32 v = version + 1;
        _models[v] = Model(hash, modelId, nf, low, medium, high, uint64(block.timestamp));
        version = v;
        emit ModelActivated(v, hash, modelId, low, medium, high);
    }

    function setFeeder(address who, bool allowed) external onlyGov {
        if (who == address(0)) revert ZeroAddress();
        feeder[who] = allowed;
        emit FeederSet(who, allowed);
    }

    function model(uint32 v) external view returns (Model memory) {
        return _models[v];
    }

    function chunksOf(bytes32 hash) external view returns (address[] memory) {
        return _chunks[hash];
    }

    /// The packed bytes of a published model (for anyone checking them against the hash).
    function modelBytes(bytes32 hash) external view returns (bytes memory) {
        if (publishedSize[hash] == 0) revert NotPublished();
        return _load(hash);
    }

    // ---- scoring ----

    /// Runs the active model on a feature vector (nFeatures x uint32 big-endian, scale 1e7).
    function evaluate(bytes calldata features) public view returns (int256 score, uint8 level) {
        return evaluateAt(version, features);
    }

    /// Runs model `v` (any activated version) on a feature vector.
    function evaluateAt(uint32 v, bytes calldata features) public view returns (int256 score, uint8 level) {
        Model storage md = _models[v];
        if (md.hash == bytes32(0)) revert NoModel();
        if (features.length != uint256(md.nFeatures) * 4) revert BadFeatures();
        score = _eval(_load(md.hash), features);
        level = _level(md, score);
    }

    /// A feeder posts the features Neuro computed for `token`; the score is computed here.
    function postFeatures(address token, bytes calldata features) external returns (int256 score, uint8 level) {
        if (!feeder[msg.sender]) revert NotFeeder();
        return _score(token, features);
    }

    /// Anyone: re-runs the stored feature vector of `token` (its preimage, from the
    /// Scored event) under the active model, e.g. after a model change.
    function rescore(address token, bytes calldata features) external returns (int256 score, uint8 level) {
        if (_scores[token].featuresHash == bytes32(0) || keccak256(features) != _scores[token].featuresHash) revert UnknownFeatures();
        return _score(token, features);
    }

    /// The token's score under the ACTIVE model. known = false when it was never
    /// scored or only under an older model (rescore brings it up to date).
    function scoreOf(address token) external view returns (bool known, int256 score, uint8 level) {
        Score storage s = _scores[token];
        if (s.version == 0 || s.version != version) return (false, 0, 0);
        return (true, s.score, s.level);
    }

    /// The stored record, whatever model it was computed with.
    function scoreRecord(address token) external view returns (Score memory) {
        return _scores[token];
    }

    function _score(address token, bytes calldata features) private returns (int256 score, uint8 level) {
        uint32 v = version;
        (score, level) = evaluateAt(v, features);
        bytes32 fh = keccak256(features);
        _scores[token] = Score(int64(score), v, level, uint64(block.timestamp), fh);
        emit Scored(token, v, int64(score), level, fh, features);
    }

    function _level(Model storage md, int256 s) private view returns (uint8) {
        if (s >= md.high) return 3;
        if (s >= md.medium) return 2;
        if (s >= md.low) return 1;
        return 0;
    }

    /// Trees on integer features: a row goes left when x[f] <= threshold; leaves add up
    /// to the margin z; score = trunc(calibA * z / scale) + calibB.
    function _eval(bytes memory m, bytes calldata x) private pure returns (int256 s) {
        assembly {
            let p := add(m, 32)
            let w := mload(p)
            let nt := and(shr(192, w), 0xffff)
            let scale := and(shr(160, w), 0xffffffff)
            let z := signextend(3, and(shr(128, w), 0xffffffff))
            let a := signextend(3, and(shr(96, w), 0xffffffff))
            let b := signextend(3, and(shr(64, w), 0xffffffff))
            let sizes := add(p, 24)
            let node := add(sizes, nt)
            let xo := x.offset
            for { let k := 0 } lt(k, nt) { k := add(k, 1) } {
                let i := node
                for {} 1 {} {
                    let v := mload(i)
                    let f := shr(248, v)
                    if eq(f, 0xff) {
                        z := add(z, signextend(3, and(shr(216, v), 0xffffffff)))
                        break
                    }
                    switch gt(shr(224, calldataload(add(xo, shl(2, f)))), and(shr(216, v), 0xffffffff))
                    case 0 { i := add(i, 6) }
                    default { i := add(node, mul(6, and(shr(208, v), 0xff))) }
                }
                node := add(node, mul(6, byte(0, mload(add(sizes, k)))))
            }
            s := add(sdiv(mul(a, z), scale), b)
        }
    }

    /// Checks the NSM1 layout so evaluation stays inside the bytes and always ends:
    /// every feature index < nFeatures, every right child after its node and inside
    /// its tree, every path ending in a leaf, the sizes adding up to the length.
    function _validate(bytes calldata d) private pure {
        if (d.length < HEADER || bytes4(d[0:4]) != "NSM1") revert BadModel(0);
        uint256 nf = uint16(bytes2(d[4:6]));
        uint256 nt = uint16(bytes2(d[6:8]));
        if (nf == 0 || nt == 0 || uint32(bytes4(d[8:12])) == 0) revert BadModel(4);
        if (int32(uint32(bytes4(d[16:20]))) <= 0) revert BadModel(16);
        if (d.length < HEADER + nt) revert BadModel(24);
        uint256 o = HEADER + nt;
        for (uint256 k = 0; k < nt; k++) {
            uint256 n = uint8(d[HEADER + k]);
            if (n == 0 || d.length < o + n * NODE_BYTES) revert BadModel(HEADER + k);
            for (uint256 i = 0; i < n; i++) {
                uint256 at = o + i * NODE_BYTES;
                uint256 f = uint8(d[at]);
                if (f == 0xff) {
                    if (uint8(d[at + 5]) != 0) revert BadModel(at);
                    continue;
                }
                uint256 r = uint8(d[at + 5]);
                // pre-order: left child = i + 1, right child further on, both inside the tree
                if (f >= nf || i + 1 >= n || r <= i + 1 || r >= n) revert BadModel(at);
            }
            if (uint8(d[o + (n - 1) * NODE_BYTES]) != 0xff) revert BadModel(o);
            o += n * NODE_BYTES;
        }
        if (o != d.length) revert BadModel(o);
    }

    /// Deploys a data contract whose code is 0x00 ++ data (the STOP keeps it from running).
    function _store(bytes calldata data) private returns (address a) {
        bytes memory init = abi.encodePacked(hex"63", uint32(data.length + 1), hex"80600e6000396000f3", hex"00", data);
        assembly { a := create(0, add(init, 32), mload(init)) }
        if (a == address(0)) revert BadModel(0);
    }

    function _load(bytes32 hash) private view returns (bytes memory m) {
        address[] storage list = _chunks[hash];
        uint256 size = publishedSize[hash];
        m = new bytes(size);
        uint256 dst;
        assembly { dst := add(m, 32) }
        for (uint256 i = 0; i < list.length; i++) {
            address a = list[i];
            uint256 len = a.code.length - 1;
            assembly { extcodecopy(a, dst, 1, len) }
            dst += len;
        }
        // bytes past the end stay zero, so a 32-byte read of the last node is safe
    }
}
