// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RedBlueArena: an open red-vs-blue round for Neuro (testnet sandbox)
/// @notice TESTNET ONLY, and the "scams" never leave a sandbox: red entries are deployed
///         only on the runners' throwaway in-memory devnet, never on a public chain.
///
///         Red submits a scam token (a manifest: Solidity source + the owner's trap steps)
///         that should get past Neuro; blue submits a detector (a rule spec). Both commit
///         keccak256(arena, round, side, author, contentHash, salt) before `commitEnd`, so
///         neither side can tailor its entry to the other's, and reveal the content hash,
///         salt and a URI after it. Runners (governance-approved; e.g. NeuroJobs runners)
///         fetch every revealed entry, check its hash, and run zetaphy-neuro/ml/redteam/arena.js:
///         each red token is deployed and listed on an in-memory devnet, a victim buys,
///         the owner's trap steps run, the victim sells; the red entry is valid when the
///         victim gets back less than half of what the pool quoted, and it evades when Neuro
///         (rules + model) still shows it below "medium". Each blue detector scores
///         (valid reds it catches) - 2 x (benign reference tokens it flags).
///         `quorum` runners must post the same result; then, after `judgeEnd`, `settle` pays:
///           - red: every valid evading entry gets an equal share of the red pool; valid
///             entries get their bond back; invalid or unrevealed entries lose it;
///           - blue: entries with a positive score share the blue pool by score; revealed
///             entries get their bond back; unrevealed ones lose it.
///         Lost bonds and unpaid pools carry over to the next round. If no result reached
///         quorum by `judgeEnd`, the round is void: revealed entries get their bonds back.
contract RedBlueArena {
    uint256 public constant MAX_RED = 128;
    uint256 public constant MAX_BLUE = 32;
    uint256 public constant MAX_URI = 200;

    struct Round {
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 judgeEnd;
        bool judged;
        bool settled;
        uint128 redPool;
        uint128 bluePool;
        uint256 redValid;    // bit i: red entry i is a working scam
        uint256 redEvaded;   // bit i: ...and Neuro missed it
    }

    struct Entry {
        address author;
        bool revealed;
        bytes32 commitment;
        bytes32 contentHash;
        string uri;
    }

    address public governance;
    uint128 public redBond = 1 ether;
    uint128 public blueBond = 1 ether;
    uint8 public quorum = 1;
    uint256 public carry;          // lost bonds and unpaid pools, for the next round
    uint256 public roundCount;

    mapping(address => bool) public runners;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Entry[]) private _red;
    mapping(uint256 => Entry[]) private _blue;
    mapping(uint256 => int32[]) private _blueScore;
    mapping(uint256 => mapping(address => bool)) public posted;
    mapping(uint256 => mapping(bytes32 => uint8)) public votes;
    mapping(address => uint256) public owed;

    event RoundOpened(uint256 indexed round, uint64 commitEnd, uint64 revealEnd, uint64 judgeEnd, uint256 redPool, uint256 bluePool);
    event Committed(uint256 indexed round, uint8 side, uint256 index, address indexed author);
    event Revealed(uint256 indexed round, uint8 side, uint256 index, bytes32 contentHash, string uri);
    event ResultPosted(uint256 indexed round, address indexed runner, bytes32 key, uint8 votes);
    event Judged(uint256 indexed round, uint256 redValid, uint256 redEvaded, int32[] blueScore);
    event Settled(uint256 indexed round, bool void, uint256 redPaid, uint256 bluePaid, uint256 carried);
    event RunnerSet(address indexed runner, bool on);
    event ParamsSet(uint128 redBond, uint128 blueBond, uint8 quorum);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotRunner();
    error BadInput();
    error WrongPhase();
    error Full();
    error BadReveal();
    error AlreadyPosted();
    error NothingOwed();
    error SendFailed();

    constructor(address governance_) {
        governance = governance_;
    }

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    function setGovernance(address g) external onlyGov { governance = g; emit GovernanceSet(g); }
    function setRunner(address r, bool on) external onlyGov { runners[r] = on; emit RunnerSet(r, on); }
    function setParams(uint128 rb, uint128 bb, uint8 q) external onlyGov {
        if (q == 0) revert BadInput();
        (redBond, blueBond, quorum) = (rb, bb, q);
        emit ParamsSet(rb, bb, q);
    }

    /// Opens a round with msg.value (+ the carry) as bounties; redShareBps of it for red.
    function openRound(uint64 commitEnd, uint64 revealEnd, uint64 judgeEnd, uint16 redShareBps) external payable onlyGov returns (uint256 id) {
        if (commitEnd <= block.timestamp || revealEnd <= commitEnd || judgeEnd <= revealEnd || redShareBps > 10_000) revert BadInput();
        uint256 total = msg.value + carry;
        carry = 0;
        uint128 red = uint128((total * redShareBps) / 10_000);
        id = ++roundCount;
        rounds[id] = Round(commitEnd, revealEnd, judgeEnd, false, false, red, uint128(total - red), 0, 0);
        emit RoundOpened(id, commitEnd, revealEnd, judgeEnd, red, total - red);
    }

    // ------------------------------------------------------------------ entries

    function commitmentOf(uint256 round, uint8 side, address author, bytes32 contentHash, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), round, side, author, contentHash, salt));
    }

    /// side 0 = red (a scam token), 1 = blue (a detector). The bond is the side's bond.
    function commit(uint256 round, uint8 side, bytes32 commitment) external payable returns (uint256 index) {
        Round storage r = rounds[round];
        if (r.commitEnd == 0 || block.timestamp >= r.commitEnd) revert WrongPhase();
        if (side > 1 || commitment == bytes32(0) || msg.value != (side == 0 ? redBond : blueBond)) revert BadInput();
        Entry[] storage list = side == 0 ? _red[round] : _blue[round];
        if (list.length >= (side == 0 ? MAX_RED : MAX_BLUE)) revert Full();
        list.push(Entry(msg.sender, false, commitment, bytes32(0), ""));
        index = list.length - 1;
        emit Committed(round, side, index, msg.sender);
    }

    function reveal(uint256 round, uint8 side, uint256 index, bytes32 contentHash, bytes32 salt, string calldata uri) external {
        Round storage r = rounds[round];
        if (block.timestamp < r.commitEnd || block.timestamp >= r.revealEnd) revert WrongPhase();
        if (side > 1 || bytes(uri).length == 0 || bytes(uri).length > MAX_URI) revert BadInput();
        Entry storage e = (side == 0 ? _red[round] : _blue[round])[index];
        if (e.revealed || e.author != msg.sender || e.commitment != commitmentOf(round, side, msg.sender, contentHash, salt)) revert BadReveal();
        e.revealed = true;
        e.contentHash = contentHash;
        e.uri = uri;
        emit Revealed(round, side, index, contentHash, uri);
    }

    function counts(uint256 round) external view returns (uint256 red, uint256 blue) {
        return (_red[round].length, _blue[round].length);
    }

    function entry(uint256 round, uint8 side, uint256 index) external view returns (address author, bool revealed, bytes32 contentHash, string memory uri) {
        Entry storage e = (side == 0 ? _red[round] : _blue[round])[index];
        return (e.author, e.revealed, e.contentHash, e.uri);
    }

    function blueScores(uint256 round) external view returns (int32[] memory) {
        return _blueScore[round];
    }

    // ------------------------------------------------------------------ judging

    function resultKey(uint256 redValid, uint256 redEvaded, int32[] calldata blueScore) public pure returns (bytes32) {
        return keccak256(abi.encode(redValid, redEvaded, blueScore));
    }

    function postResult(uint256 round, uint256 redValid, uint256 redEvaded, int32[] calldata blueScore) external {
        if (!runners[msg.sender]) revert NotRunner();
        Round storage r = rounds[round];
        if (block.timestamp < r.revealEnd || block.timestamp >= r.judgeEnd || r.judged) revert WrongPhase();
        if (posted[round][msg.sender]) revert AlreadyPosted();
        Entry[] storage reds = _red[round];
        Entry[] storage blues = _blue[round];
        if (blueScore.length != blues.length || (redEvaded & ~redValid) != 0) revert BadInput();
        uint256 revealedMask;
        for (uint256 i; i < reds.length; i++) if (reds[i].revealed) revealedMask |= (uint256(1) << i);
        if ((redValid & ~revealedMask) != 0) revert BadInput();
        for (uint256 i; i < blues.length; i++) if (!blues[i].revealed && blueScore[i] > 0) revert BadInput();
        posted[round][msg.sender] = true;
        bytes32 key = resultKey(redValid, redEvaded, blueScore);
        uint8 v = ++votes[round][key];
        emit ResultPosted(round, msg.sender, key, v);
        if (v >= quorum) {
            r.judged = true;
            r.redValid = redValid;
            r.redEvaded = redEvaded;
            _blueScore[round] = blueScore;
            emit Judged(round, redValid, redEvaded, blueScore);
        }
    }

    function settle(uint256 round) external {
        Round storage r = rounds[round];
        if (r.commitEnd == 0 || r.settled || block.timestamp < r.judgeEnd) revert WrongPhase();
        r.settled = true;
        Entry[] storage reds = _red[round];
        Entry[] storage blues = _blue[round];
        uint256 left = uint256(r.redPool) + r.bluePool;
        uint256 redPaid;
        uint256 bluePaid;
        if (!r.judged) {
            for (uint256 i; i < reds.length; i++) _back(reds[i], redBond, reds[i].revealed);
            for (uint256 i; i < blues.length; i++) _back(blues[i], blueBond, blues[i].revealed);
        } else {
            uint256 evaders = _popcount(r.redEvaded);
            for (uint256 i; i < reds.length; i++) {
                bool valid = (r.redValid >> i) & 1 == 1;
                _back(reds[i], redBond, valid);
                if ((r.redEvaded >> i) & 1 == 1) {
                    uint256 share = r.redPool / evaders;
                    owed[reds[i].author] += share;
                    redPaid += share;
                }
            }
            int32[] storage sc = _blueScore[round];
            uint256 total;
            for (uint256 i; i < sc.length; i++) if (sc[i] > 0) total += uint256(int256(sc[i]));
            for (uint256 i; i < blues.length; i++) {
                _back(blues[i], blueBond, blues[i].revealed);
                if (total > 0 && sc[i] > 0) {
                    uint256 share = (uint256(r.bluePool) * uint256(int256(sc[i]))) / total;
                    owed[blues[i].author] += share;
                    bluePaid += share;
                }
            }
        }
        left -= redPaid + bluePaid;
        carry += left;
        emit Settled(round, !r.judged, redPaid, bluePaid, left);
    }

    function _back(Entry storage e, uint256 bond, bool ok) private {
        if (ok) owed[e.author] += bond;
        else carry += bond;
    }

    function _popcount(uint256 x) private pure returns (uint256 c) {
        for (; x != 0; x &= x - 1) c++;
    }

    function withdraw() external {
        uint256 a = owed[msg.sender];
        if (a == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert SendFailed();
    }
}
