// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The request record AuditNetwork exposes (its sponsor and contest end).
interface IEBNetwork {
    function core(uint256 id) external view returns (address sponsor, uint64 contestEnd, uint256 revealEnd, uint256 judgeEnd, bool naDeclared, bool settled);
}

/// The certificate AuditCertificate stores (only the fields read here).
interface IEBCertificate {
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
    }
    function certificate(uint64 chainId, address target) external view returns (Cert memory c, bool valid);
}

/// NeuroJobs' runner record.
interface IEBJobs {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// @title EconomicBounds: an economic-security bound attached to an audit request (testnet only)
/// @notice docs/future/red-team.md (SS4). The sponsor of an AuditNetwork request attaches the result of the
///         economic attack simulation (src/redteam/economic.js): "the maximum extractable loss under the
///         scenario set S with seeds R is <= bound", as
///             claim = { reportHash, bound, scenariosHash }
///         reportHash = keccak256 of the canonical simulation report, which names the code hash, the scenario
///         set and the seeds, so anyone reruns it and gets the same bytes. Three bonded NeuroJobs runners rerun
///         it and commit keccak256("zetaphy.econ.bound", keccak256(abi.encode(reportHash, bound)), runner, salt,
///         requestId); after commitWindow they reveal. The claim is CONFIRMED when at least 2 of 3 revealed
///         exactly (reportHash, bound). Runners who confirmed share the sponsor's fee; otherwise it goes back.
///
///         This is a separate contract on purpose: AuditCertificate's rules and behaviour do not change. A
///         reader asks `boundFor(chainId, target)`: the bound holds only while the target's certificate holds AND
///         was issued for the same request the bound was confirmed for.
///         The bound is a statement about the simulated scenarios only, not a guarantee (red-team.md).
///         No admin key: windows are constants; nothing here holds money beyond the runners' fee.
contract EconomicBounds {
    uint8 public constant SEATS = 3;
    uint8 public constant QUORUM = 2;
    uint64 public constant COMMIT_WINDOW = 2 days;
    uint64 public constant REVEAL_WINDOW = 2 days;

    struct Claim {
        bytes32 reportHash;
        uint256 bound;          // max extractable loss under the scenario set, in wei of the native coin
        bytes32 scenariosHash;  // keccak256 of the canonical scenario set + seeds
    }

    struct Attachment {
        Claim claim;
        address sponsor;
        uint64 attachedAt;
        uint128 fee;
        uint8 taken;
        uint8 confirmations;
        bool settled;
        bool confirmed;
    }

    IEBNetwork public immutable network;
    IEBCertificate public immutable certificates;
    IEBJobs public immutable jobs;
    uint32 public immutable minAgreed;

    mapping(uint256 => Attachment) internal _att;           // request id => attachment
    mapping(uint256 => address[]) internal _seats;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;
    mapping(address => uint256) public owed;

    event Attached(uint256 indexed requestId, bytes32 reportHash, uint256 bound, bytes32 scenariosHash, uint256 fee);
    event Committed(uint256 indexed requestId, address indexed runner);
    event Revealed(uint256 indexed requestId, address indexed runner, bytes32 reportHash, uint256 bound, bool matches);
    event BoundSettled(uint256 indexed requestId, bool confirmed, uint256 confirmations, uint256 paidEach);
    event Withdrawn(address indexed to, uint256 amount);

    error NotSponsor();
    error BadValue();
    error Closed();
    error TooEarly();
    error NotRunner();
    error AlreadyIn();
    error BadReveal();
    error Nothing();

    constructor(IEBNetwork network_, IEBCertificate certificates_, IEBJobs jobs_, uint32 minAgreed_) {
        if (address(network_) == address(0) || address(certificates_) == address(0) || address(jobs_) == address(0)) revert BadValue();
        network = network_;
        certificates = certificates_;
        jobs = jobs_;
        minAgreed = minAgreed_;
    }

    /// The request's sponsor attaches the bound once (msg.value: the runners' fee).
    function attach(uint256 requestId, Claim calldata c) external payable {
        Attachment storage a = _att[requestId];
        if (a.attachedAt != 0) revert AlreadyIn();
        if (c.reportHash == bytes32(0) || c.scenariosHash == bytes32(0) || msg.value > type(uint128).max) revert BadValue();
        a.claim = c;
        a.sponsor = msg.sender;
        a.attachedAt = uint64(block.timestamp);
        a.fee = uint128(msg.value);
        emit Attached(requestId, c.reportHash, c.bound, c.scenariosHash, msg.value);
        // the sponsor read comes last (a view into AuditNetwork): a revert undoes the attachment
        (address sponsor, , , , , ) = network.core(requestId);
        if (msg.sender != sponsor) revert NotSponsor();
    }

    function commitmentOf(bytes32 reportHash, uint256 bound, address runner, bytes32 salt, uint256 requestId) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.econ.bound", keccak256(abi.encode(reportHash, bound)), runner, salt, requestId));
    }

    function eligible(address runner) public view returns (bool) {
        (uint128 bond, , bool active, uint32 agreed, uint32 rejected) = jobs.workers(runner);
        return active && bond > 0 && agreed >= minAgreed && rejected <= agreed;
    }

    function commit(uint256 requestId, bytes32 commitment) external {
        Attachment storage a = _att[requestId];
        if (a.attachedAt == 0 || a.settled || a.taken >= SEATS || block.timestamp >= uint256(a.attachedAt) + COMMIT_WINDOW) revert Closed();
        if (commitment == bytes32(0) || commitments[requestId][msg.sender] != bytes32(0)) revert AlreadyIn();
        commitments[requestId][msg.sender] = commitment;
        _seats[requestId].push(msg.sender);
        a.taken++;
        emit Committed(requestId, msg.sender);
        // external reads last (views into NeuroJobs and AuditNetwork): a revert undoes the seat
        (address sponsor, , , , , ) = network.core(requestId);
        if (msg.sender == sponsor || !eligible(msg.sender)) revert NotRunner();
    }

    /// Reveal what the runner's own rerun produced. Only a reveal equal to the claim counts as a confirmation.
    function reveal(uint256 requestId, bytes32 reportHash, uint256 bound, bytes32 salt) external {
        Attachment storage a = _att[requestId];
        uint256 commitEnd = uint256(a.attachedAt) + COMMIT_WINDOW;
        if (a.attachedAt == 0 || a.settled || block.timestamp >= commitEnd + REVEAL_WINDOW) revert Closed();
        if (block.timestamp < commitEnd && a.taken < SEATS) revert TooEarly();
        bytes32 c = commitments[requestId][msg.sender];
        if (c == bytes32(0)) revert NotRunner();
        if (commitmentOf(reportHash, bound, msg.sender, salt, requestId) != c) revert BadReveal();
        commitments[requestId][msg.sender] = bytes32(uint256(1)); // spent: no second reveal
        bool matches = reportHash == a.claim.reportHash && bound == a.claim.bound;
        if (matches) {
            confirmedBy[requestId][msg.sender] = true;
            a.confirmations++;
        }
        emit Revealed(requestId, msg.sender, reportHash, bound, matches);
    }

    /// Anyone, once 2 confirmations are in or the reveal window is over.
    function settle(uint256 requestId) external {
        Attachment storage a = _att[requestId];
        if (a.attachedAt == 0 || a.settled) revert Closed();
        if (a.confirmations < QUORUM && block.timestamp < uint256(a.attachedAt) + COMMIT_WINDOW + REVEAL_WINDOW) revert TooEarly();
        a.settled = true;
        a.confirmed = a.confirmations >= QUORUM;
        uint256 each = 0;
        address[] memory seats = _seats[requestId];
        if (a.confirmed) {
            each = a.fee / a.confirmations;
            for (uint256 i = 0; i < seats.length; i++) if (confirmedBy[requestId][seats[i]]) owed[seats[i]] += each;
        }
        uint256 rest = a.fee - each * (a.confirmed ? a.confirmations : 0);
        if (rest > 0) owed[a.sponsor] += rest; // the leftover fee goes back to the sponsor
        emit BoundSettled(requestId, a.confirmed, a.confirmations, each);
    }

    /// Pull payout; the credit is zeroed before the interaction and nothing is written after it (CEI, no lock
    /// needed). The recipient is msg.sender itself (its own, already-zeroed credit): no caller chooses it.
    function withdraw() external {
        uint256 v = owed[msg.sender];
        if (v == 0) revert Nothing();
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, v);
        (bool ok, ) = msg.sender.call{value: v}("");
        if (!ok) revert Nothing();
    }

    // ================================================================ views

    function attachment(uint256 requestId) external view returns (Attachment memory) {
        return _att[requestId];
    }

    function seatsOf(uint256 requestId) external view returns (address[] memory) {
        return _seats[requestId];
    }

    /// The confirmed bound of request `requestId` (confirmed = false: none, not settled, or not confirmed).
    function boundOf(uint256 requestId) public view returns (bool confirmed, Claim memory c) {
        Attachment storage a = _att[requestId];
        if (!a.settled || !a.confirmed) return (false, c);
        return (true, a.claim);
    }

    /// The bound that goes with the CURRENT certificate of (chainId, target): only while the certificate holds
    /// and was issued for the request whose bound was confirmed.
    function boundFor(uint64 chainId, address target) external view returns (bool holds, Claim memory c, uint256 requestId) {
        (IEBCertificate.Cert memory cert, bool valid) = certificates.certificate(chainId, target);
        if (!valid) return (false, c, cert.requestId);
        (bool confirmed, Claim memory cl) = boundOf(cert.requestId);
        return (confirmed, cl, cert.requestId);
    }
}
