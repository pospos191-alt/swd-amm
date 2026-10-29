// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ModelEpochs: which Neuro model is in force at which block height (testnet)
/// @notice Binds a Neuro model version to chain state. Each version is the
///         sha256 of a manifest file (zetaphy-neuro/ml/manifest.json: the
///         model's and the federated head's file hashes), the height it takes
///         effect at, and where to fetch the manifest.
///
///         Rules that make the choice deterministic for every node and browser:
///           - activation heights strictly increase and sit on epoch
///             boundaries (activation % epochLength == 0);
///           - a version may only be scheduled at least minDelay (>= 1)
///             blocks ahead: activation >= block.number + minDelay;
///           - only a version still in the future may be cancelled, and only
///             the latest one (versions are never edited or reordered).
///         So the version in force at height h (the last one with
///         activation <= h, versionAt(h)) is fixed as soon as block h-1 is
///         committed: whoever reads the registry at any later state gets the
///         same answer for h.
///
///         Governance is the chain's gov module (a MsgEVMCall proposal) or a
///         timelock / SimpleMultisig. A guardian may cancel a pending version
///         (a veto that only ever keeps the version already in force), never
///         schedule one.
contract ModelEpochs {
    struct Version {
        bytes32 hash;
        uint64 activation;
        uint64 scheduledAt;
        string uri;
    }

    uint256 public constant MAX_URI = 256;
    uint64 public constant MAX_DELAY = 1_000_000;

    address public governance;
    mapping(address => bool) public guardian;
    uint64 public immutable epochLength;
    uint64 public minDelay;
    Version[] private _versions;

    event GovernanceChanged(address governance);
    event GuardianSet(address indexed who, bool allowed);
    event MinDelay(uint64 blocks);
    event Scheduled(uint256 indexed index, bytes32 indexed hash, uint64 activation, string uri);
    event Cancelled(uint256 indexed index, bytes32 indexed hash, address by);

    error NotGovernance();
    error NotGuardian();
    error BadValue();
    error TooSoon();
    error NotPending();

    constructor(address governance_, uint64 epochLength_, uint64 minDelay_) {
        if (governance_ == address(0) || epochLength_ == 0) revert BadValue();
        if (minDelay_ == 0 || minDelay_ > MAX_DELAY) revert BadValue();
        governance = governance_;
        epochLength = epochLength_;
        minDelay = minDelay_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadValue();
        governance = next;
        emit GovernanceChanged(next);
    }

    function setGuardian(address who, bool allowed) external onlyGovernance {
        guardian[who] = allowed;
        emit GuardianSet(who, allowed);
    }

    function setMinDelay(uint64 blocks) external onlyGovernance {
        if (blocks == 0 || blocks > MAX_DELAY) revert BadValue();
        minDelay = blocks;
        emit MinDelay(blocks);
    }

    /// Schedules a new version, in force from `activation` on.
    function schedule(bytes32 hash, uint64 activation, string calldata uri) external onlyGovernance returns (uint256 index) {
        if (hash == bytes32(0) || activation % epochLength != 0) revert BadValue();
        uint256 len = bytes(uri).length;
        if (len == 0 || len > MAX_URI) revert BadValue();
        if (uint256(activation) < block.number + minDelay) revert TooSoon();
        uint256 n = _versions.length;
        if (n > 0 && activation <= _versions[n - 1].activation) revert BadValue();
        _versions.push(Version(hash, activation, uint64(block.number), uri));
        emit Scheduled(n, hash, activation, uri);
        return n;
    }

    /// Cancels the latest version while it is still in the future.
    function cancelLast() external {
        if (msg.sender != governance && !guardian[msg.sender]) revert NotGuardian();
        uint256 n = _versions.length;
        if (n == 0 || _versions[n - 1].activation <= block.number) revert NotPending();
        Version storage v = _versions[n - 1];
        emit Cancelled(n - 1, v.hash, msg.sender);
        _versions.pop();
    }

    function count() external view returns (uint256) {
        return _versions.length;
    }

    function versionByIndex(uint256 i) external view returns (bytes32 hash, uint64 activation, uint64 scheduledAt, string memory uri) {
        Version storage v = _versions[i];
        return (v.hash, v.activation, v.scheduledAt, v.uri);
    }

    /// The version in force at `height`: the last one with activation <= height.
    /// found = false before the first version (Neuro then runs on its rules only).
    function versionAt(uint256 height) public view returns (bool found, uint256 index, bytes32 hash, uint64 activation, string memory uri) {
        uint256 lo = 0;
        uint256 hi = _versions.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_versions[mid].activation <= height) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return (false, 0, bytes32(0), 0, "");
        Version storage v = _versions[lo - 1];
        return (true, lo - 1, v.hash, v.activation, v.uri);
    }

    /// The version in force at the current block.
    function current() external view returns (bool found, uint256 index, bytes32 hash, uint64 activation, string memory uri) {
        return versionAt(block.number);
    }
}
