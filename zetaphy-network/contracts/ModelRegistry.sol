// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ModelRegistry: which AI models, skills, prompts and rule sets ZETAPHY trusts (testnet)
/// @notice One record per (id, version): the sha256 of its manifest, the Merkle
///         root of its chunks (sha256 per chunk, see docs/future/browser-ai.md),
///         its size and chunk size, its license (SPDX id), its author and its
///         status. A browser or runner that downloads a model from ANY mirror
///         (this project's site, GitHub Releases, an IPFS gateway, another
///         browser over WebRTC) checks the manifest against manifestHash and
///         every chunk against chunkRoot, so a mirror can only refuse to serve,
///         never serve something else.
///
///         Who changes what (the same split as every other ZETAPHY contract,
///         see ZetaphyTimelock):
///           - governance (ZetaphyTimelock: every change waits its delay in
///             public, e.g. 48 h): publish a release, set any status
///             (Active, Suspended, Deprecated, Revoked), name guardians, hand
///             governance on;
///           - a guardian: suspend(id, version) only, at once. Suspending only
///             reduces risk (loaders stop using that release); only governance
///             makes it Active again.
///         Revoked is final: a revoked release can never be used again (a fixed
///         model is a new version).
///
///         Ids: idOf(kind, name) = keccak256("zetaphy.registry", kind, name),
///         e.g. idOf(Model, "neuro-ml-gbdt"). Versions of an id only go up.
contract ModelRegistry {
    enum Kind { None, Model, Skill, Prompt, Ruleset }
    enum Status { None, Active, Suspended, Deprecated, Revoked }

    struct Release {
        Kind kind;
        Status status;
        uint32 chunkSize;     // bytes per chunk (the last one may be shorter)
        uint64 size;          // bytes of the whole artifact
        uint64 publishedAt;
        uint64 updatedAt;
        bytes32 manifestHash; // sha256 of the manifest file's exact bytes
        bytes32 chunkRoot;    // Merkle root over the chunks' sha256 (leaf/node domain-separated)
        address author;
        string license;       // SPDX id, printable ASCII, 1..MAX_LICENSE bytes
    }

    uint256 public constant MAX_LICENSE = 64;
    uint32 public constant MIN_CHUNK = 1024;
    uint32 public constant MAX_CHUNK = 64 * 1024 * 1024;

    address public governance;
    mapping(address => bool) public guardian;

    mapping(bytes32 => Kind) public kindOf;
    mapping(bytes32 => uint32) public latestVersion;
    mapping(bytes32 => mapping(uint32 => Release)) private _releases;
    bytes32[] private _ids;

    event Published(bytes32 indexed id, uint32 indexed version, Kind kind, bytes32 manifestHash, bytes32 chunkRoot, uint64 size, uint32 chunkSize, address author, string license);
    event StatusChanged(bytes32 indexed id, uint32 indexed version, Status status, address indexed by);
    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);

    error NotGovernance();
    error NotGuardian();
    error BadValue();
    error BadVersion();
    error KindMismatch();
    error UnknownRelease();
    error Final();

    constructor(address governance_) {
        if (governance_ == address(0)) revert BadValue();
        governance = governance_;
        emit GovernanceSet(governance_);
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address g) external onlyGov {
        if (g == address(0)) revert BadValue();
        governance = g;
        emit GovernanceSet(g);
    }

    function setGuardian(address who, bool on) external onlyGov {
        if (who == address(0)) revert BadValue();
        guardian[who] = on;
        emit GuardianSet(who, on);
    }

    /// The id of a named entry of a kind.
    function idOf(Kind kind, string calldata name) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("zetaphy.registry", uint8(kind), name));
    }

    function _checkLicense(string calldata license) private pure {
        bytes calldata b = bytes(license);
        if (b.length == 0 || b.length > MAX_LICENSE) revert BadValue();
        for (uint256 i; i < b.length; i++) if (b[i] < 0x21 || b[i] > 0x7e) revert BadValue();
    }

    /// Governance (the timelock) publishes a new version of an id. It starts Active.
    function publish(
        bytes32 id, Kind kind, uint32 version, bytes32 manifestHash, bytes32 chunkRoot,
        uint64 size, uint32 chunkSize, address author, string calldata license
    ) external onlyGov {
        if (id == bytes32(0) || kind == Kind.None || manifestHash == bytes32(0) || chunkRoot == bytes32(0)) revert BadValue();
        if (size == 0 || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK || author == address(0)) revert BadValue();
        _checkLicense(license);
        Kind known = kindOf[id];
        if (known == Kind.None) { kindOf[id] = kind; _ids.push(id); }
        else if (known != kind) revert KindMismatch();
        if (version <= latestVersion[id]) revert BadVersion();
        latestVersion[id] = version;
        _releases[id][version] = Release(kind, Status.Active, chunkSize, size, uint64(block.timestamp), uint64(block.timestamp),
            manifestHash, chunkRoot, author, license);
        emit Published(id, version, kind, manifestHash, chunkRoot, size, chunkSize, author, license);
        emit StatusChanged(id, version, Status.Active, msg.sender);
    }

    /// Governance sets any status except None; Revoked is final.
    function setStatus(bytes32 id, uint32 version, Status status) external onlyGov {
        if (status == Status.None) revert BadValue();
        _setStatus(id, version, status);
    }

    /// A guardian (or governance) suspends an Active release at once.
    function suspend(bytes32 id, uint32 version) external {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
        if (_releases[id][version].status != Status.Active) revert BadValue();
        _setStatus(id, version, Status.Suspended);
    }

    function _setStatus(bytes32 id, uint32 version, Status status) private {
        Release storage r = _releases[id][version];
        if (r.status == Status.None) revert UnknownRelease();
        if (r.status == Status.Revoked) revert Final();
        r.status = status;
        r.updatedAt = uint64(block.timestamp);
        emit StatusChanged(id, version, status, msg.sender);
    }

    function release(bytes32 id, uint32 version) external view returns (Release memory) {
        return _releases[id][version];
    }

    /// The latest version of an id and its record (version 0 and an empty record: unknown id).
    function latest(bytes32 id) external view returns (uint32 version, Release memory r) {
        version = latestVersion[id];
        r = _releases[id][version];
    }

    /// True when (id, version) is Active and has exactly these hashes: what a loader asks.
    function isUsable(bytes32 id, uint32 version, bytes32 manifestHash, bytes32 chunkRoot) external view returns (bool) {
        Release storage r = _releases[id][version];
        return r.status == Status.Active && r.manifestHash == manifestHash && r.chunkRoot == chunkRoot;
    }

    function idCount() external view returns (uint256) {
        return _ids.length;
    }

    function idAt(uint256 i) external view returns (bytes32) {
        return _ids[i];
    }
}
