// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DataDAO: labelled data for Neuro's model, rewarded by measured improvement (testnet)
/// @notice Contributors register labelled data (its sha256/keccak hash + where to get it +
///         row count + licence). The weekly ML training job (GitHub Actions, no server) measures
///         how much each contributor's data improves the model on held-out rows
///         (zetaphy-neuro/ml/dao/attribute.js: leave-one-contributor-out or a Shapley estimate)
///         and turns that into a merkle root of (round, account, amount). The poster (a
///         governance-chosen address, e.g. a multisig that checked the job's report) posts the
///         root with the hash and URI of the job's report. Claims open after `vetoDelay`, during
///         which governance can veto a wrong root; what is not claimed before `claimPeriod`
///         ends goes back to the pool. Rewards are testnet ZETAPHY from `fund()`.
contract DataDAO {
    uint256 public constant MAX_URI = 200;
    uint256 public constant MAX_LICENSE = 32;

    struct Submission {
        address contributor;
        uint64 at;
        uint32 rows;
        bool excluded;       // governance: bad / copied / unlicensed data
        bytes32 dataHash;
        string uri;
        string license;      // SPDX id, e.g. "MIT", "CC0-1.0"
    }

    struct Round {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint64 postedAt;
        uint64 claimFrom;
        uint64 expires;
        bool vetoed;
        bool swept;
        bytes32 reportHash;  // hash of the attribution report (metrics per contributor)
        string reportUri;
    }

    address public governance;
    address public poster;
    uint64 public vetoDelay = 2 days;
    uint64 public claimPeriod = 60 days;
    uint256 public reserved;            // promised to posted, live rounds

    Submission[] private _subs;
    mapping(bytes32 => uint256) public idOfHash; // dataHash -> id (1-based)
    Round[] private _rounds;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Submitted(uint256 indexed id, address indexed contributor, bytes32 dataHash, uint32 rows, string uri, string license);
    event Excluded(uint256 indexed id, bool excluded);
    event RoundPosted(uint256 indexed round, bytes32 root, uint256 total, bytes32 reportHash, string reportUri);
    event RoundVetoed(uint256 indexed round);
    event Claimed(uint256 indexed round, address indexed account, uint256 amount);
    event Swept(uint256 indexed round, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event PosterSet(address poster);
    event GovernanceSet(address governance);
    event DelaysSet(uint64 vetoDelay, uint64 claimPeriod);

    error NotGovernance();
    error NotPoster();
    error BadInput();
    error Duplicate();
    error NotEnoughFunds();
    error BadRound();
    error NotOpen();
    error AlreadyClaimed();
    error BadProof();
    error SendFailed();

    constructor(address governance_, address poster_) {
        governance = governance_;
        poster = poster_;
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }
    function fund() external payable { emit Funded(msg.sender, msg.value); }

    function setGovernance(address g) external onlyGov { governance = g; emit GovernanceSet(g); }
    function setPoster(address p) external onlyGov { poster = p; emit PosterSet(p); }
    function setDelays(uint64 vetoFor, uint64 period) external onlyGov {
        if (vetoFor > 30 days || period < 7 days || period > 365 days) revert BadInput();
        (vetoDelay, claimPeriod) = (vetoFor, period);
        emit DelaysSet(vetoFor, period);
    }

    // ------------------------------------------------------------------ data

    function submit(bytes32 dataHash, string calldata uri, uint32 rows, string calldata license) external returns (uint256 id) {
        if (dataHash == bytes32(0) || rows == 0 || bytes(uri).length == 0 || bytes(uri).length > MAX_URI
            || bytes(license).length == 0 || bytes(license).length > MAX_LICENSE) revert BadInput();
        if (idOfHash[dataHash] != 0) revert Duplicate();
        _subs.push(Submission(msg.sender, uint64(block.timestamp), rows, false, dataHash, uri, license));
        id = _subs.length;
        idOfHash[dataHash] = id;
        emit Submitted(id, msg.sender, dataHash, rows, uri, license);
    }

    function exclude(uint256 id, bool on) external onlyGov {
        if (id == 0 || id > _subs.length) revert BadInput();
        _subs[id - 1].excluded = on;
        emit Excluded(id, on);
    }

    function submissionCount() external view returns (uint256) { return _subs.length; }

    function submission(uint256 id) external view returns (address contributor, uint64 at, uint32 rows, bool excluded, bytes32 dataHash, string memory uri, string memory license) {
        Submission storage s = _subs[id - 1];
        return (s.contributor, s.at, s.rows, s.excluded, s.dataHash, s.uri, s.license);
    }

    // ------------------------------------------------------------------ rewards

    function available() public view returns (uint256) {
        return address(this).balance - reserved;
    }

    function postRound(bytes32 root, uint128 total, bytes32 reportHash, string calldata reportUri) external returns (uint256 round) {
        if (msg.sender != poster) revert NotPoster();
        if (root == bytes32(0) || total == 0 || bytes(reportUri).length > MAX_URI) revert BadInput();
        if (total > available()) revert NotEnoughFunds();
        reserved += total;
        uint64 nowT = uint64(block.timestamp);
        _rounds.push(Round(root, total, 0, nowT, nowT + vetoDelay, nowT + vetoDelay + claimPeriod, false, false, reportHash, reportUri));
        round = _rounds.length;
        emit RoundPosted(round, root, total, reportHash, reportUri);
    }

    function veto(uint256 round) external onlyGov {
        Round storage r = _round(round);
        if (r.vetoed || block.timestamp >= r.claimFrom) revert NotOpen();
        r.vetoed = true;
        reserved -= r.total;
        emit RoundVetoed(round);
    }

    /// Leaf: keccak256(keccak256(abi.encode(this, chainid, round, account, amount))); pairs hashed sorted.
    function leafOf(uint256 round, address account, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(address(this), block.chainid, round, account, amount))));
    }

    /// Pays `account` its reward for `round` (anyone may send it; the coins go to the account).
    function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external {
        Round storage r = _round(round);
        if (r.vetoed || block.timestamp < r.claimFrom || block.timestamp >= r.expires) revert NotOpen();
        if (claimed[round][account]) revert AlreadyClaimed();
        bytes32 h = leafOf(round, account, amount);
        for (uint256 i; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        if (h != r.root) revert BadProof();
        if (uint256(r.claimed) + amount > r.total) revert NotEnoughFunds();
        claimed[round][account] = true;
        r.claimed += uint128(amount);
        reserved -= amount;
        (bool ok,) = account.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Claimed(round, account, amount);
    }

    /// After the claim period, what was not claimed goes back to the pool.
    function sweep(uint256 round) external {
        Round storage r = _round(round);
        if (r.vetoed || r.swept || block.timestamp < r.expires) revert NotOpen();
        r.swept = true;
        uint256 left = r.total - r.claimed;
        reserved -= left;
        emit Swept(round, left);
    }

    function roundCount() external view returns (uint256) { return _rounds.length; }

    function rounds(uint256 round) external view returns (bytes32 root, uint256 total, uint256 claimedAmount, uint64 postedAt, uint64 claimFrom, uint64 expires, bool vetoed, bytes32 reportHash, string memory reportUri) {
        Round storage r = _round(round);
        return (r.root, r.total, r.claimed, r.postedAt, r.claimFrom, r.expires, r.vetoed, r.reportHash, r.reportUri);
    }

    function _round(uint256 round) private view returns (Round storage) {
        if (round == 0 || round > _rounds.length) revert BadRound();
        return _rounds[round - 1];
    }
}
