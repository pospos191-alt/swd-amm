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
///         salt and a URI after it.
///
///         Judging needs no single trusted runner:
///           - k-of-n: up to `seats` runners (governance-approved AND bonded with `runnerBond`)
///             take a seat by committing keccak256(arena, round, runner, resultKey, salt) before
///             `resultCommitEnd`, so nobody can copy another runner's result; they reveal the
///             full result (bitmaps + blue scores) before `judgeEnd`;
///           - the sandbox is pinned: the round names `sandbox`, the hash of the runner
///             environment (zetaphy-neuro/ml/redteam/sandbox.js: the EVM interpreter and solc
///             versions, the fixed block environment, Neuro's model, the benign reference set),
///             and every runner's result commits to it, so honest runners agree byte for byte;
///           - `finalize` (anyone, after judgeEnd): the result `quorum` (more than half the
///             seats) runners revealed is the round's result. Runners that revealed another
///             result or never revealed lose `slashBps` of their bond to the runners who agreed.
///             No quorum: the round is void (unrevealed seats are still slashed);
///           - a challenge window follows: anyone may `challenge` with `challengeBond`, naming the
///             result it says is right. Governance (the timelock) re-runs the deterministic sandbox
///             and decides: upheld -> the challenger's result replaces it, the runners who posted
///             the wrong one are slashed and the challenger gets its bond back plus half of that;
///             rejected -> the challenge bond goes to the round's agreeing runners. A challenge
///             governance never answers lapses after `appealWindow`: the bond comes back.
///         Then `settle` pays:
///           - red: every valid evading entry gets an equal share of the red pool; valid
///             entries get their bond back; invalid or unrevealed entries lose it;
///           - blue: entries with a positive score share the blue pool by score; revealed
///             entries get their bond back; unrevealed ones lose it;
///           - runners: `runnerFeeBps` of the pools, plus the slashed bonds, split among the
///             runners whose revealed result is the final one.
///         Lost bonds and unpaid pools carry over to the next round. If the round is void,
///         revealed entries get their bonds back.
contract RedBlueArena {
    uint256 public constant MAX_RED = 128;
    uint256 public constant MAX_BLUE = 32;
    uint256 public constant MAX_URI = 200;
    uint256 public constant MAX_SEATS = 9;

    struct Round {
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 judgeEnd;     // end of the runners' result reveals
        bool judged;
        bool settled;
        uint128 redPool;
        uint128 bluePool;
        uint256 redValid;    // bit i: red entry i is a working scam
        uint256 redEvaded;   // bit i: ...and Neuro missed it
    }

    /// The runners' side of a round (kept apart from Round so both getters stay small).
    struct Judging {
        uint64 resultCommitEnd;
        uint64 challengeEnd;
        bool finalized;
        bool challenged;
        bool challengeResolved;
        uint8 seated;
        address challenger;
        bytes32 sandbox;     // hash of the pinned runner environment
        bytes32 resultKey;   // the final result's key
        bytes32 challengeKey;
        uint128 slashPool;   // slashed runner bonds of this round, for the agreeing runners
    }

    struct Entry {
        address author;
        bool revealed;
        bytes32 commitment;
        bytes32 contentHash;
        string uri;
    }

    struct Result {
        bool known;
        uint256 redValid;
        uint256 redEvaded;
        int32[] blueScore;
    }

    struct RunnerStake {
        uint128 bond;
        uint64 unbondAt;     // 0: bonded; else when the bond can be withdrawn
    }

    address public governance;
    uint128 public redBond = 1 ether;
    uint128 public blueBond = 1 ether;
    uint8 public quorum = 2;               // k: agreeing runners needed (> seats / 2)
    uint8 public seats = 3;                // n: runner seats per round
    uint128 public runnerBond = 10 ether;
    uint16 public slashBps = 5_000;        // of runnerBond, per wrong / missing result
    uint16 public runnerFeeBps = 500;      // of the round's pools, for the agreeing runners
    uint128 public challengeBond = 5 ether;
    uint32 public challengeWindow = 1 days;
    uint32 public appealWindow = 7 days;
    uint32 public unbondDelay = 14 days;
    uint256 public carry;          // lost bonds and unpaid pools, for the next round
    uint256 public roundCount;

    mapping(address => bool) public runners;
    mapping(address => RunnerStake) public stakes;
    mapping(address => uint256) public activeSeats; // open rounds a runner sits in (cannot unbond meanwhile)
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Judging) public judging;
    mapping(uint256 => Entry[]) private _red;
    mapping(uint256 => Entry[]) private _blue;
    mapping(uint256 => int32[]) private _blueScore;
    mapping(uint256 => address[]) private _seats;
    mapping(uint256 => mapping(address => bytes32)) public resultCommitments;
    mapping(uint256 => mapping(address => bytes32)) public revealedKey;
    mapping(uint256 => mapping(bytes32 => uint8)) public votes;
    mapping(uint256 => mapping(bytes32 => Result)) private _results;
    mapping(address => uint256) public owed;

    event RoundOpened(uint256 indexed round, uint64 commitEnd, uint64 revealEnd, uint64 judgeEnd, uint256 redPool, uint256 bluePool);
    event RoundSandbox(uint256 indexed round, uint64 resultCommitEnd, bytes32 sandbox);
    event Committed(uint256 indexed round, uint8 side, uint256 index, address indexed author);
    event Revealed(uint256 indexed round, uint8 side, uint256 index, bytes32 contentHash, string uri);
    event ResultCommitted(uint256 indexed round, address indexed runner);
    event ResultRevealed(uint256 indexed round, address indexed runner, bytes32 key, uint8 votes);
    event Judged(uint256 indexed round, uint256 redValid, uint256 redEvaded, int32[] blueScore);
    event RunnerSlashed(uint256 indexed round, address indexed runner, uint256 amount, bool revealed);
    event Challenged(uint256 indexed round, address indexed challenger, bytes32 key);
    event ChallengeResolved(uint256 indexed round, bool upheld, bytes32 key);
    event Settled(uint256 indexed round, bool void, uint256 redPaid, uint256 bluePaid, uint256 carried);
    event RunnerSet(address indexed runner, bool on);
    event RunnerBonded(address indexed runner, uint256 bond);
    event RunnerUnbonding(address indexed runner, uint64 at);
    event ParamsSet(uint128 redBond, uint128 blueBond, uint8 quorum);
    event RunnerParamsSet(uint8 seats, uint128 runnerBond, uint16 slashBps, uint16 runnerFeeBps, uint128 challengeBond, uint32 challengeWindow, uint32 appealWindow);
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
    error LowBond();
    error Busy();

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
        if (q == 0 || uint256(q) * 2 <= seats || q > seats) revert BadInput();
        (redBond, blueBond, quorum) = (rb, bb, q);
        emit ParamsSet(rb, bb, q);
    }
    /// n seats, the runner bond, the slash, the runners' fee and the challenge rules. quorum must stay > n/2.
    function setRunnerParams(uint8 n, uint128 bond, uint16 slash, uint16 fee, uint128 cBond, uint32 cWindow, uint32 aWindow) external onlyGov {
        if (n == 0 || n > MAX_SEATS || uint256(quorum) * 2 <= n || quorum > n || slash > 10_000 || fee > 2_000 || cWindow == 0 || aWindow == 0) revert BadInput();
        (seats, runnerBond, slashBps, runnerFeeBps, challengeBond, challengeWindow, appealWindow) = (n, bond, slash, fee, cBond, cWindow, aWindow);
        emit RunnerParamsSet(n, bond, slash, fee, cBond, cWindow, aWindow);
    }

    /// Opens a round with msg.value (+ the carry) as bounties; redShareBps of it for red. `sandbox` is the
    /// hash of the runner environment every result must be computed in.
    function openRound(uint64 commitEnd, uint64 revealEnd, uint64 resultCommitEnd, uint64 judgeEnd, uint16 redShareBps, bytes32 sandbox)
        external payable onlyGov returns (uint256 id)
    {
        if (commitEnd <= block.timestamp || revealEnd <= commitEnd || resultCommitEnd <= revealEnd || judgeEnd <= resultCommitEnd || redShareBps > 10_000 || sandbox == bytes32(0)) revert BadInput();
        uint256 total = msg.value + carry;
        carry = 0;
        uint128 red = uint128((total * redShareBps) / 10_000);
        id = ++roundCount;
        Round storage r = rounds[id];
        (r.commitEnd, r.revealEnd, r.judgeEnd) = (commitEnd, revealEnd, judgeEnd);
        (r.redPool, r.bluePool) = (red, uint128(total - red));
        (judging[id].resultCommitEnd, judging[id].sandbox) = (resultCommitEnd, sandbox);
        emit RoundOpened(id, commitEnd, revealEnd, judgeEnd, red, total - red);
        emit RoundSandbox(id, resultCommitEnd, sandbox);
    }

    // ------------------------------------------------------------------ runner bonds

    function bondRunner() external payable {
        RunnerStake storage s = stakes[msg.sender];
        s.bond += uint128(msg.value);
        s.unbondAt = 0;
        emit RunnerBonded(msg.sender, s.bond);
    }

    function requestUnbond() external {
        if (activeSeats[msg.sender] != 0) revert Busy();
        uint64 at = uint64(block.timestamp) + unbondDelay;
        stakes[msg.sender].unbondAt = at;
        emit RunnerUnbonding(msg.sender, at);
    }

    function withdrawBond() external {
        RunnerStake storage s = stakes[msg.sender];
        if (s.unbondAt == 0 || block.timestamp < s.unbondAt || activeSeats[msg.sender] != 0) revert WrongPhase();
        uint256 a = s.bond;
        if (a == 0) revert NothingOwed();
        s.bond = 0;
        s.unbondAt = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        if (!ok) revert SendFailed();
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

    function seatsOf(uint256 round) external view returns (address[] memory) {
        return _seats[round];
    }

    function resultOf(uint256 round, bytes32 key) external view returns (bool known, uint256 redValid, uint256 redEvaded, int32[] memory blueScore) {
        Result storage x = _results[round][key];
        return (x.known, x.redValid, x.redEvaded, x.blueScore);
    }

    // ------------------------------------------------------------------ judging: k-of-n commit-reveal

    /// The key of a result: the sandbox it was computed in, the bitmaps and the blue scores.
    function resultKey(bytes32 sandbox, uint256 redValid, uint256 redEvaded, int32[] memory blueScore) public pure returns (bytes32) {
        return keccak256(abi.encode(sandbox, redValid, redEvaded, blueScore));
    }

    function resultCommitmentOf(uint256 round, address runner, bytes32 key, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), round, runner, key, salt));
    }

    /// A bonded, approved runner takes one of the round's seats with its sealed result.
    function commitResult(uint256 round, bytes32 commitment) external {
        if (!runners[msg.sender]) revert NotRunner();
        RunnerStake storage s = stakes[msg.sender];
        if (s.bond < runnerBond || s.unbondAt != 0) revert LowBond();
        Round storage r = rounds[round];
        if (r.commitEnd == 0 || block.timestamp < r.revealEnd || block.timestamp >= judging[round].resultCommitEnd) revert WrongPhase();
        if (resultCommitments[round][msg.sender] != bytes32(0)) revert AlreadyPosted();
        if (judging[round].seated >= seats) revert Full();
        if (commitment == bytes32(0)) revert BadInput();
        resultCommitments[round][msg.sender] = commitment;
        _seats[round].push(msg.sender);
        judging[round].seated++;
        activeSeats[msg.sender]++;
        emit ResultCommitted(round, msg.sender);
    }

    function revealResult(uint256 round, uint256 redValid, uint256 redEvaded, int32[] calldata blueScore, bytes32 salt) external {
        Round storage r = rounds[round];
        if (block.timestamp < judging[round].resultCommitEnd || block.timestamp >= r.judgeEnd) revert WrongPhase();
        bytes32 c = resultCommitments[round][msg.sender];
        if (c == bytes32(0) || revealedKey[round][msg.sender] != bytes32(0)) revert BadReveal();
        _checkResult(round, redValid, redEvaded, blueScore);
        bytes32 key = resultKey(judging[round].sandbox, redValid, redEvaded, blueScore);
        if (resultCommitmentOf(round, msg.sender, key, salt) != c) revert BadReveal();
        revealedKey[round][msg.sender] = key;
        Result storage x = _results[round][key];
        if (!x.known) (x.known, x.redValid, x.redEvaded, x.blueScore) = (true, redValid, redEvaded, blueScore);
        uint8 v = ++votes[round][key];
        emit ResultRevealed(round, msg.sender, key, v);
    }

    function _checkResult(uint256 round, uint256 redValid, uint256 redEvaded, int32[] calldata blueScore) private view {
        Entry[] storage reds = _red[round];
        Entry[] storage blues = _blue[round];
        if (blueScore.length != blues.length || (redEvaded & ~redValid) != 0) revert BadInput();
        uint256 revealedMask;
        for (uint256 i; i < reds.length; i++) if (reds[i].revealed) revealedMask |= (uint256(1) << i);
        if ((redValid & ~revealedMask) != 0) revert BadInput();
        for (uint256 i; i < blues.length; i++) if (!blues[i].revealed && blueScore[i] > 0) revert BadInput();
    }

    /// Anyone, after the reveals: the result `quorum` runners revealed wins; the others are slashed.
    function finalize(uint256 round) external {
        Round storage r = rounds[round];
        if (r.commitEnd == 0 || judging[round].finalized || block.timestamp < r.judgeEnd) revert WrongPhase();
        judging[round].finalized = true;
        address[] storage list = _seats[round];
        bytes32 best;
        uint8 bestVotes;
        for (uint256 i; i < list.length; i++) {
            bytes32 k = revealedKey[round][list[i]];
            if (k != bytes32(0) && votes[round][k] > bestVotes) (best, bestVotes) = (k, votes[round][k]);
        }
        bool judged = bestVotes >= quorum;
        for (uint256 i; i < list.length; i++) {
            address a = list[i];
            activeSeats[a]--;
            bytes32 k = revealedKey[round][a];
            // never revealed: always slashed; revealed another result: slashed only when a quorum agreed
            if (k == bytes32(0) || (judged && k != best)) _slash(round, a, k != bytes32(0));
        }
        if (judged) {
            _adopt(round, best);
            judging[round].challengeEnd = uint64(block.timestamp) + challengeWindow;
        }
    }

    function _adopt(uint256 round, bytes32 key) private {
        Round storage r = rounds[round];
        Result storage x = _results[round][key];
        (r.judged, judging[round].resultKey, r.redValid, r.redEvaded) = (true, key, x.redValid, x.redEvaded);
        _blueScore[round] = x.blueScore;
        emit Judged(round, x.redValid, x.redEvaded, x.blueScore);
    }

    function _slash(uint256 round, address runner, bool revealed) private {
        RunnerStake storage s = stakes[runner];
        uint256 cut = (uint256(runnerBond) * slashBps) / 10_000;
        if (cut > s.bond) cut = s.bond;
        s.bond -= uint128(cut);
        judging[round].slashPool += uint128(cut);
        emit RunnerSlashed(round, runner, cut, revealed);
    }

    // ------------------------------------------------------------------ the challenge path

    /// Anyone, during the challenge window: says the judged result is wrong and names the right one.
    function challenge(uint256 round, uint256 redValid, uint256 redEvaded, int32[] calldata blueScore) external payable {
        Round storage r = rounds[round];
        if (!r.judged || judging[round].challenged || block.timestamp >= judging[round].challengeEnd) revert WrongPhase();
        if (msg.value != challengeBond) revert BadInput();
        _checkResult(round, redValid, redEvaded, blueScore);
        bytes32 key = resultKey(judging[round].sandbox, redValid, redEvaded, blueScore);
        if (key == judging[round].resultKey) revert BadInput();
        Result storage x = _results[round][key];
        if (!x.known) (x.known, x.redValid, x.redEvaded, x.blueScore) = (true, redValid, redEvaded, blueScore);
        Judging storage j = judging[round];
        (j.challenged, j.challenger, j.challengeKey) = (true, msg.sender, key);
        emit Challenged(round, msg.sender, key);
    }

    /// Governance (the timelock), after re-running the pinned sandbox: upheld replaces the result.
    function resolveChallenge(uint256 round, bool upheld) external onlyGov {
        Round storage r = rounds[round];
        if (!judging[round].challenged || judging[round].challengeResolved || r.settled) revert WrongPhase();
        judging[round].challengeResolved = true;
        if (upheld) {
            bytes32 wrong = judging[round].resultKey;
            address[] storage list = _seats[round];
            uint256 before = judging[round].slashPool;
            for (uint256 i; i < list.length; i++) if (revealedKey[round][list[i]] == wrong) _slash(round, list[i], true);
            uint256 half = (judging[round].slashPool - before) / 2;
            judging[round].slashPool -= uint128(half);
            owed[judging[round].challenger] += challengeBond + half;
            _adopt(round, judging[round].challengeKey);
        } else {
            judging[round].slashPool += challengeBond;
        }
        emit ChallengeResolved(round, upheld, judging[round].resultKey);
    }

    /// A challenge governance did not answer within appealWindow lapses: the bond comes back, the result stands.
    function expireChallenge(uint256 round) external {
        if (!judging[round].challenged || judging[round].challengeResolved || block.timestamp < uint256(judging[round].challengeEnd) + appealWindow) revert WrongPhase();
        judging[round].challengeResolved = true;
        owed[judging[round].challenger] += challengeBond;
        emit ChallengeResolved(round, false, judging[round].resultKey);
    }

    // ------------------------------------------------------------------ payout

    function settle(uint256 round) external {
        Round storage r = rounds[round];
        Judging storage j = judging[round];
        if (!j.finalized || r.settled) revert WrongPhase();
        if (r.judged && (block.timestamp < j.challengeEnd || (j.challenged && !j.challengeResolved))) revert WrongPhase();
        r.settled = true;
        uint256 left = uint256(r.redPool) + r.bluePool;
        uint256 redPaid;
        uint256 bluePaid;
        if (!r.judged) {
            Entry[] storage reds = _red[round];
            Entry[] storage blues = _blue[round];
            for (uint256 i; i < reds.length; i++) _back(reds[i], redBond, reds[i].revealed);
            for (uint256 i; i < blues.length; i++) _back(blues[i], blueBond, blues[i].revealed);
            carry += j.slashPool;
        } else {
            // the agreeing runners' fee comes off the top of both pools
            uint256 feeRed = (uint256(r.redPool) * runnerFeeBps) / 10_000;
            uint256 feeBlue = (uint256(r.bluePool) * runnerFeeBps) / 10_000;
            redPaid = _payRed(round, r.redPool - feeRed);
            bluePaid = _payBlue(round, r.bluePool - feeBlue);
            _payRunners(round, feeRed + feeBlue + j.slashPool);
            left -= feeRed + feeBlue;
        }
        left -= redPaid + bluePaid;
        carry += left;
        emit Settled(round, !r.judged, redPaid, bluePaid, left);
    }

    function _payRed(uint256 round, uint256 pool) private returns (uint256 paid) {
        Round storage r = rounds[round];
        Entry[] storage reds = _red[round];
        uint256 evaders = _popcount(r.redEvaded);
        for (uint256 i; i < reds.length; i++) {
            _back(reds[i], redBond, (r.redValid >> i) & 1 == 1);
            if ((r.redEvaded >> i) & 1 == 1) {
                uint256 share = pool / evaders;
                owed[reds[i].author] += share;
                paid += share;
            }
        }
    }

    function _payBlue(uint256 round, uint256 pool) private returns (uint256 paid) {
        Entry[] storage blues = _blue[round];
        int32[] storage sc = _blueScore[round];
        uint256 total;
        for (uint256 i; i < sc.length; i++) if (sc[i] > 0) total += uint256(int256(sc[i]));
        for (uint256 i; i < blues.length; i++) {
            _back(blues[i], blueBond, blues[i].revealed);
            if (total > 0 && sc[i] > 0) {
                uint256 share = (pool * uint256(int256(sc[i]))) / total;
                owed[blues[i].author] += share;
                paid += share;
            }
        }
    }

    /// Splits `amount` (the runners' fee + the slashed bonds) among the runners whose revealed result is the
    /// final one; nobody agreeing: it carries over.
    function _payRunners(uint256 round, uint256 amount) private {
        address[] storage list = _seats[round];
        uint256 n;
        for (uint256 i; i < list.length; i++) if (revealedKey[round][list[i]] == judging[round].resultKey) n++;
        if (n == 0) { carry += amount; return; }
        uint256 each = amount / n;
        for (uint256 i; i < list.length; i++) if (revealedKey[round][list[i]] == judging[round].resultKey) owed[list[i]] += each;
        carry += amount - each * n;
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
