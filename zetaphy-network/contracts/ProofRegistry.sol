// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// NeuroJobs' runner record (the bar AuditRunners uses).
interface IPRJobs {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IPRReputation {
    function record(address worker, uint8 kind, bytes32 ref) external;
}

/// AuditCertificate.certificate (AuditCertificate.Cert, same layout). Read only.
interface IPRCertificate {
    struct Cert {
        uint256 requestId;
        uint64 chainId;
        address target;
        bytes32 codeHash;
        bytes32 reportHash;
        bytes32 sourceHash;
        uint8 level;
        uint16 auditors;
        uint16 mutationBps;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint256 revokedBy;
    }

    function certificate(uint64 chainId, address target) external view returns (Cert memory c, bool valid);
}

/// A bounty's replay contract: deploys the bountied code afresh, replays `counterexample` (its own
/// encoding, published with the spec) and evaluates property number `property` of the spec.
/// True only when the property is violated. It may change state only inside a call that reverts.
interface IPropertyChecker {
    function replay(bytes32 codeHash, bytes32 specHash, uint32 property, bytes calldata counterexample) external returns (bool violated);
}

/// @title ProofRegistry: the "Proven" level and the proof market (SS6 / A3 / S9)
/// @notice Records, per code hash, that an approved spec (its hash) was PROVEN for that code: the
///         proof artifacts (generated Halmos / forge / SMTChecker files, by hash), the tool versions and
///         a reproducibility recipe (`node audit/spec/cli.js prove <spec>` with the pinned tools of
///         audit/tools/install.sh). A proof counts only when at least 2 of 3 bonded NeuroJobs runners
///         reproduced it and revealed the SAME outcome with every property proven
///             outcome = (resultHash, proven, counterexamples, unknown)
///             commitment = keccak256("zetaphy.proof.run", keccak256(abi.encode(outcome)), runner, salt, proofId)
///         (AuditRunners' commit-reveal and 2-of-3 rule). "Not installed", a timeout or an unknown
///         result is never "proven": a single one rejects the proof.
///
///         Submitting is commit-then-submit (the commitment, from an earlier block, binds the
///         artifacts to the prover), so nobody can copy a published proof and claim it first.
///
///         Proof market: anyone posts a bounty on (codeHash, specHash) with an optional replay
///         contract. It is claimed
///           - by proof: a proof submitted for the bounty and accepted as above (one in flight at a
///             time), paid to its prover; or
///           - by counterexample: commit, then (from the next block on) reveal a counterexample that
///             the bounty's replay contract confirms on-chain. The code's spec is then REFUTED for
///             good: no proof of it counts any more.
///         Unclaimed, the poster takes it back after the deadline. Every payout is pulled (`withdraw`).
///
///         `levelOf(chainId, target)` reports AuditCertificate's level and PROVEN (4) on top of a
///         valid Gold certificate whose code hash has an accepted, unrefuted proof. AuditCertificate
///         itself is unchanged. No owner: governance (the ZetaphyTimelock) only sets bounded windows
///         and the minimum fee. A proof says the code satisfies THAT spec; read the spec.
contract ProofRegistry {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    uint8 public constant GOLD = 3;          // AuditCertificate.GOLD
    uint8 public constant PROVEN = 4;        // reported on top of Gold

    uint8 public constant OPEN = 1;          // proofs and bounties
    uint8 public constant ACCEPTED = 2;      // proof: 2 of 3 runners reproduced "all proven"
    uint8 public constant REJECTED = 3;      // proof: anything else
    uint8 public constant PAID = 2;          // bounty: paid to a prover or a counterexample
    uint8 public constant RECLAIMED = 3;     // bounty: returned to its poster

    uint8 internal constant AGREED = 0;
    uint8 internal constant DISAGREED = 1;
    uint8 internal constant MISSED = 2;

    uint256 public constant MAX_ARTIFACTS = 32;
    uint256 public constant MAX_TEXT = 256;
    uint256 public constant MAX_COUNTEREXAMPLE = 16_384;

    struct Params {
        uint32 commitWindow;     // [1 hour, 30 days]: runners commit their outcome
        uint32 revealWindow;     // [1 hour, 7 days]: then reveal it
        uint128 minFee;          // [0, 1000 ether]: the runners' fee per proof
        uint32 minAgreed;        // [0, 10000]: a runner's agreed jobs on NeuroJobs
    }

    struct Submission {
        bytes32 codeHash;        // EXTCODEHASH of the proven code (as deployed)
        bytes32 specHash;        // the approved spec (audit/spec: keccak of its canonical approved part)
        bytes32 sourceHash;      // the source closure it was compiled from
        uint32 properties;       // approved properties in the spec
        bytes32[] artifacts;     // keccak256 of each generated artifact (proof.json "artifacts")
        string tools;            // e.g. "forge 1.2.3; halmos 0.3.3; solc 0.8.26"
        string recipe;           // where the recipe and the bundle are (https / ipfs)
        bytes32 recipeHash;      // keccak of the canonical recipe (proof.json "recipeHash")
        uint256 bountyId;        // 0: none
    }

    struct Outcome {
        bytes32 resultHash;      // keccak of the canonical proof result (proof.json "resultHash")
        uint32 proven;
        uint32 counterexamples;
        uint32 unknown;          // unknown, timed out or not installed
    }

    struct Proof {
        address prover;
        uint64 commitEnd;
        uint64 revealEnd;
        uint8 state;
        uint8 taken;
        uint8 revealed;
        uint32 properties;
        uint128 fee;
        bytes32 codeHash;
        bytes32 specHash;
        bytes32 sourceHash;
        bytes32 artifactsHash;   // keccak256(abi.encode(artifacts))
        bytes32 recipeHash;
        bytes32 resultHash;      // the agreed outcome's result hash (set at settle)
        uint256 bountyId;
    }

    struct Bounty {
        address poster;
        uint64 deadline;
        uint32 properties;
        uint8 state;
        uint128 amount;
        bytes32 codeHash;
        bytes32 specHash;
        address checker;         // zero: claimable by proof only
        uint256 inFlight;        // the proof being verified for it (0: none)
        address winner;
    }

    IPRJobs public immutable jobs;
    IPRReputation public immutable reputation;
    IPRCertificate public immutable certificates;
    address public governance;   // the ZetaphyTimelock
    Params public params;

    Proof[] internal _proofs;                                    // id = index + 1
    Bounty[] internal _bounties;                                 // id = index + 1
    mapping(uint256 => bytes32[]) internal _artifacts;
    mapping(uint256 => string) public toolsOf;
    mapping(uint256 => string) public recipeOf;
    mapping(uint256 => string) public specUriOf;                 // bounty -> where its spec and checker encoding are
    mapping(uint256 => address[]) internal _seats;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bytes32)) public revealedKey;
    mapping(bytes32 => Outcome) internal _outcomes;
    mapping(bytes32 => uint256) public submitCommits;            // commitment -> block number
    mapping(bytes32 => uint256) public cexCommits;               // commitment -> block number
    mapping(bytes32 => uint256) public latestProof;              // codeHash -> newest accepted proof id
    mapping(bytes32 => mapping(bytes32 => uint256)) public provenBy;   // codeHash -> specHash -> accepted proof id
    mapping(bytes32 => mapping(bytes32 => bool)) public refuted;       // codeHash -> specHash -> counterexample replayed
    mapping(address => uint256) public owed;
    mapping(address => address) public payoutOf;
    uint256 private _locked = 1;

    event Committed(bytes32 indexed commitment, address indexed by);
    event ProofSubmitted(uint256 indexed id, bytes32 indexed codeHash, bytes32 indexed specHash, address prover, bytes32 artifactsHash, uint32 properties, uint256 bountyId);
    event RunnerCommitted(uint256 indexed id, address indexed runner);
    event RunnerRevealed(uint256 indexed id, address indexed runner, bytes32 resultHash, uint32 proven, uint32 counterexamples, uint32 unknown);
    event ProofSettled(uint256 indexed id, bool accepted, bytes32 resultHash, uint256 agreedSeats, uint256 paidEach);
    event BountyPosted(uint256 indexed id, bytes32 indexed codeHash, bytes32 indexed specHash, address poster, uint256 amount, uint64 deadline, address checker);
    event BountyPaid(uint256 indexed id, address indexed winner, bool byCounterexample, uint256 amount);
    event BountyReclaimed(uint256 indexed id, uint256 amount);
    event Refuted(bytes32 indexed codeHash, bytes32 indexed specHash, uint256 indexed bountyId, uint32 property, address by);
    event Withdrawn(address indexed by, address indexed to, uint256 amount);
    event PayoutSet(address indexed by, address indexed to);
    event ParamsSet();
    event GovernanceSet(address indexed governance);

    error NotGovernance();
    error BadParams();
    error BadSubmission();
    error NoCommitment();
    error NoSuch();
    error Closed();
    error TooEarly();
    error NotRunner();
    error AlreadyIn();
    error BadReveal();
    error Busy();
    error NotViolated();
    error Nothing();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IPRJobs jobs_, IPRReputation reputation_, IPRCertificate certificates_, address governance_, Params memory p) {
        require(address(jobs_) != address(0) && governance_ != address(0), "zero");
        jobs = jobs_;
        reputation = reputation_;
        certificates = certificates_;
        governance = governance_;
        _setParams(p);
    }

    // ---------------------------------------------------------------- submit a proof

    function submitCommitment(bytes32 codeHash, bytes32 specHash, bytes32 artifactsHash, address prover, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.proof.submit", codeHash, specHash, artifactsHash, prover, salt));
    }

    /// Step 1 (any earlier block): commit to the proof you are about to submit.
    function commitSubmission(bytes32 commitment) external {
        if (commitment == bytes32(0) || submitCommits[commitment] != 0) revert AlreadyIn();
        submitCommits[commitment] = block.number;
        emit Committed(commitment, msg.sender);
    }

    /// Step 2: the proof, with the runners' fee. Three runners then reproduce it.
    function submit(Submission calldata s, bytes32 salt) external payable returns (uint256 id) {
        if (s.codeHash == bytes32(0) || s.specHash == bytes32(0) || s.sourceHash == bytes32(0) || s.recipeHash == bytes32(0) || s.properties == 0
            || s.artifacts.length == 0 || s.artifacts.length > MAX_ARTIFACTS || bytes(s.tools).length == 0 || bytes(s.tools).length > MAX_TEXT
            || bytes(s.recipe).length > MAX_TEXT || msg.value < params.minFee || msg.value > type(uint128).max) revert BadSubmission();
        bytes32 artifactsHash = keccak256(abi.encode(s.artifacts));
        bytes32 c = submitCommitment(s.codeHash, s.specHash, artifactsHash, msg.sender, salt);
        uint256 at = submitCommits[c];
        if (at == 0 || at >= block.number) revert NoCommitment();
        delete submitCommits[c];
        id = _proofs.length + 1;
        if (s.bountyId != 0) {
            Bounty storage b = _bounty(s.bountyId);
            if (b.state != OPEN || block.timestamp >= b.deadline) revert Closed();
            if (b.inFlight != 0) revert Busy();
            if (b.codeHash != s.codeHash || b.specHash != s.specHash || b.properties != s.properties) revert BadSubmission();
            b.inFlight = id;
        }
        uint64 commitEnd = uint64(block.timestamp) + params.commitWindow;
        _proofs.push(Proof({
            prover: msg.sender, commitEnd: commitEnd, revealEnd: commitEnd + params.revealWindow, state: OPEN, taken: 0, revealed: 0,
            properties: s.properties, fee: uint128(msg.value), codeHash: s.codeHash, specHash: s.specHash, sourceHash: s.sourceHash,
            artifactsHash: artifactsHash, recipeHash: s.recipeHash, resultHash: bytes32(0), bountyId: s.bountyId
        }));
        _artifacts[id] = s.artifacts;
        toolsOf[id] = s.tools;
        recipeOf[id] = s.recipe;
        emit ProofSubmitted(id, s.codeHash, s.specHash, msg.sender, artifactsHash, s.properties, s.bountyId);
    }

    // ---------------------------------------------------------------- runners: commit, reveal, settle

    function runCommitment(Outcome calldata o, address runner, bytes32 salt, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.proof.run", keccak256(abi.encode(o)), runner, salt, id));
    }

    function eligible(address runner) public view returns (bool) {
        // bonded, active, not leaving (no unbond requested), and with a clean enough record
        (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected) = jobs.workers(runner);
        return active && bond > 0 && unbondAt == 0 && agreed >= params.minAgreed && rejected <= agreed;
    }

    function commit(uint256 id, bytes32 commitment) external {
        Proof storage p = _proof(id);
        if (p.state != OPEN || p.taken >= SEATS || block.timestamp >= p.commitEnd) revert Closed();
        if (!eligible(msg.sender) || msg.sender == p.prover) revert NotRunner();
        if (commitment == bytes32(0) || commitments[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        commitments[id][msg.sender] = commitment;
        _seats[id].push(msg.sender);
        p.taken++;
        emit RunnerCommitted(id, msg.sender);
    }

    function reveal(uint256 id, Outcome calldata o, bytes32 salt) external {
        Proof storage p = _proof(id);
        if (block.timestamp < p.commitEnd) revert TooEarly();
        if (p.state != OPEN || block.timestamp >= p.revealEnd) revert Closed();
        bytes32 c = commitments[id][msg.sender];
        if (c == bytes32(0) || revealedKey[id][msg.sender] != bytes32(0)) revert AlreadyIn();
        if (o.resultHash == bytes32(0) || runCommitment(o, msg.sender, salt, id) != c) revert BadReveal();
        bytes32 k = keccak256(abi.encode(o));
        revealedKey[id][msg.sender] = k;
        _outcomes[k] = o;
        p.revealed++;
        emit RunnerRevealed(id, msg.sender, o.resultHash, o.proven, o.counterexamples, o.unknown);
    }

    /// Anyone, once all 3 seats revealed or the reveal window ended.
    function settle(uint256 id) external {
        Proof storage p = _proof(id);
        if (p.state != OPEN) revert Closed();
        bool allIn = p.taken == SEATS && p.revealed == SEATS && block.timestamp >= p.commitEnd;
        if (!allIn && block.timestamp < p.revealEnd) revert TooEarly();
        address[] memory seats = _seats[id];
        bytes32 k = _majority(id, seats);
        uint256 n = 0;
        for (uint256 i = 0; i < seats.length; i++) if (k != bytes32(0) && revealedKey[id][seats[i]] == k) n++;
        Outcome memory o = _outcomes[k];
        bool accepted = k != bytes32(0) && o.proven == p.properties && o.counterexamples == 0 && o.unknown == 0 && !refuted[p.codeHash][p.specHash];
        p.state = accepted ? ACCEPTED : REJECTED;
        p.resultHash = o.resultHash;
        uint256 each = 0;
        if (n > 0) each = p.fee / n;
        else owed[p.prover] += p.fee; // no agreement: the fee goes back
        if (accepted) {
            latestProof[p.codeHash] = id;
            provenBy[p.codeHash][p.specHash] = id;
        }
        if (p.bountyId != 0) {
            Bounty storage b = _bounties[p.bountyId - 1];
            if (b.inFlight == id) b.inFlight = 0;
            if (accepted && b.state == OPEN) {
                b.state = PAID;
                b.winner = p.prover;
                owed[p.prover] += b.amount;
                emit BountyPaid(p.bountyId, p.prover, false, b.amount);
            }
        }
        uint8[] memory kinds = new uint8[](seats.length);
        for (uint256 i = 0; i < seats.length; i++) {
            bytes32 v = revealedKey[id][seats[i]];
            kinds[i] = v == bytes32(0) ? MISSED : (k != bytes32(0) && v == k ? AGREED : DISAGREED);
            if (kinds[i] == AGREED) owed[seats[i]] += each;
        }
        emit ProofSettled(id, accepted, o.resultHash, n, each);
        // interactions last: the reputation reports
        for (uint256 i = 0; i < seats.length; i++) if (k != bytes32(0) || kinds[i] == MISSED) _rep(seats[i], kinds[i], id);
    }

    // ---------------------------------------------------------------- the proof market

    /// A bounty on proving (or refuting) spec `specHash` for code `codeHash` (`properties` approved
    /// properties). `checker` (optional) replays counterexamples on-chain; `specUri` says where the
    /// spec and the checker's counterexample encoding are published.
    function postBounty(bytes32 codeHash, bytes32 specHash, uint32 properties, uint64 deadline, address checker, string calldata specUri)
        external payable returns (uint256 id)
    {
        if (codeHash == bytes32(0) || specHash == bytes32(0) || properties == 0 || msg.value == 0 || msg.value > type(uint128).max
            || bytes(specUri).length > MAX_TEXT) revert BadParams();
        if (deadline < block.timestamp + uint256(params.commitWindow) + params.revealWindow || deadline > block.timestamp + 365 days) revert BadParams();
        if (checker != address(0) && checker.code.length == 0) revert BadParams();
        _bounties.push(Bounty({ poster: msg.sender, deadline: deadline, properties: properties, state: OPEN, amount: uint128(msg.value),
            codeHash: codeHash, specHash: specHash, checker: checker, inFlight: 0, winner: address(0) }));
        id = _bounties.length;
        specUriOf[id] = specUri;
        emit BountyPosted(id, codeHash, specHash, msg.sender, msg.value, deadline, checker);
    }

    function cexCommitment(uint256 bountyId, uint32 property, bytes calldata counterexample, address claimant, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.proof.cex", bountyId, property, keccak256(counterexample), claimant, salt));
    }

    /// Step 1 (any earlier block): commit to the counterexample.
    function commitCounterexample(bytes32 commitment) external {
        if (commitment == bytes32(0) || cexCommits[commitment] != 0) revert AlreadyIn();
        cexCommits[commitment] = block.number;
        emit Committed(commitment, msg.sender);
    }

    /// Step 2 (a later block, before the deadline): reveal it. The bounty's checker replays it on
    /// the bountied code; if the property is violated the claimant is paid and the spec is refuted
    /// for that code. Effects first, then the replay: a replay that does not confirm reverts all.
    function claimByCounterexample(uint256 bountyId, uint32 property, bytes calldata counterexample, bytes32 salt) external nonReentrant {
        Bounty storage b = _bounty(bountyId);
        if (b.state != OPEN || block.timestamp >= b.deadline || b.checker == address(0)) revert Closed();
        if (property >= b.properties || counterexample.length == 0 || counterexample.length > MAX_COUNTEREXAMPLE) revert BadParams();
        bytes32 c = cexCommitment(bountyId, property, counterexample, msg.sender, salt);
        uint256 at = cexCommits[c];
        if (at == 0 || at >= block.number) revert NoCommitment();
        delete cexCommits[c];
        b.state = PAID;
        b.winner = msg.sender;
        refuted[b.codeHash][b.specHash] = true;
        owed[msg.sender] += b.amount;
        emit Refuted(b.codeHash, b.specHash, bountyId, property, msg.sender);
        emit BountyPaid(bountyId, msg.sender, true, b.amount);
        if (!IPropertyChecker(b.checker).replay(b.codeHash, b.specHash, property, counterexample)) revert NotViolated();
    }

    /// The poster, after the deadline, when no proof is being verified for it.
    function reclaimBounty(uint256 bountyId) external {
        Bounty storage b = _bounty(bountyId);
        if (msg.sender != b.poster) revert NotGovernance();
        if (b.state != OPEN) revert Closed();
        if (block.timestamp < b.deadline) revert TooEarly();
        if (b.inFlight != 0) revert Busy();
        b.state = RECLAIMED;
        owed[b.poster] += b.amount;
        emit BountyReclaimed(bountyId, b.amount);
    }

    /// Where withdraw may also send the caller's credit (e.g. a cold wallet); zero: only to itself.
    function setPayout(address to) external {
        payoutOf[msg.sender] = to;
        emit PayoutSet(msg.sender, to);
    }

    /// Pull payment of the caller's credit to itself or to its payout address. The credit is zeroed
    /// before the transfer, and re-entry is refused.
    function withdraw(address to) external nonReentrant {
        if (to != msg.sender && (to == address(0) || to != payoutOf[msg.sender])) revert BadParams();
        uint256 a = owed[msg.sender];
        if (a == 0) revert Nothing();
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, to, a);
        (bool ok, ) = to.call{value: a}("");
        if (!ok) revert Nothing();
    }

    // ---------------------------------------------------------------- reads

    /// True while code `codeHash` has an accepted proof of some spec that was never refuted.
    function isProven(bytes32 codeHash) public view returns (bool) {
        uint256 id = latestProof[codeHash];
        return id != 0 && !refuted[codeHash][_proofs[id - 1].specHash];
    }

    /// True while spec `specHash` has an accepted, unrefuted proof for code `codeHash`.
    function isProvenSpec(bytes32 codeHash, bytes32 specHash) external view returns (bool) {
        return provenBy[codeHash][specHash] != 0 && !refuted[codeHash][specHash];
    }

    /// AuditCertificate's level of (chainId, target) right now (0: no valid certificate), and
    /// PROVEN (4) when it is a valid Gold certificate whose code hash is proven.
    function levelOf(uint64 chainId, address target) external view returns (uint8) {
        if (address(certificates) == address(0)) return 0;
        (IPRCertificate.Cert memory c, bool valid) = certificates.certificate(chainId, target);
        if (!valid) return 0;
        if (c.level == GOLD && isProven(c.codeHash)) return PROVEN;
        return c.level;
    }

    function proof(uint256 id) external view returns (Proof memory) {
        return _proof(id);
    }

    function artifactsOf(uint256 id) external view returns (bytes32[] memory) {
        return _artifacts[id];
    }

    function seatsOf(uint256 id) external view returns (address[] memory) {
        return _seats[id];
    }

    /// The agreed outcome of proof `id` (agreed = false: none, or not settled yet).
    function outcome(uint256 id) external view returns (bool agreed, Outcome memory o) {
        Proof storage p = _proof(id);
        if (p.state == OPEN) return (false, o);
        address[] memory seats = _seats[id];
        bytes32 k = _majority(id, seats);
        if (k == bytes32(0)) return (false, o);
        return (true, _outcomes[k]);
    }

    function bounty(uint256 id) external view returns (Bounty memory) {
        return _bounty(id);
    }

    function proofCount() external view returns (uint256) {
        return _proofs.length;
    }

    function bountyCount() external view returns (uint256) {
        return _bounties.length;
    }

    // ---------------------------------------------------------------- governance (the ZetaphyTimelock)

    function setParams(Params calldata p) external {
        if (msg.sender != governance) revert NotGovernance();
        _setParams(p);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    function _setParams(Params memory p) internal {
        if (p.commitWindow < 1 hours || p.commitWindow > 30 days || p.revealWindow < 1 hours || p.revealWindow > 7 days
            || p.minFee > 1000 ether || p.minAgreed > 10_000) revert BadParams();
        params = p;
        emit ParamsSet();
    }

    // ---------------------------------------------------------------- internals

    function _proof(uint256 id) internal view returns (Proof storage) {
        if (id == 0 || id > _proofs.length) revert NoSuch();
        return _proofs[id - 1];
    }

    function _bounty(uint256 id) internal view returns (Bounty storage) {
        if (id == 0 || id > _bounties.length) revert NoSuch();
        return _bounties[id - 1];
    }

    function _majority(uint256 id, address[] memory seats) internal view returns (bytes32) {
        for (uint256 i = 0; i < seats.length; i++) {
            bytes32 v = revealedKey[id][seats[i]];
            if (v == bytes32(0)) continue;
            uint256 n = 0;
            for (uint256 j = 0; j < seats.length; j++) if (revealedKey[id][seats[j]] == v) n++;
            if (n >= QUORUM) return v; // QUORUM > SEATS/2: at most one outcome reaches it
        }
        return bytes32(0);
    }

    function _rep(address w, uint8 kind, uint256 id) internal {
        if (address(reputation) == address(0)) return;
        try reputation.record(w, kind, keccak256(abi.encode("zetaphy.proof.run", id))) {} catch {}
    }
}
