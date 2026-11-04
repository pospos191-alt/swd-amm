// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// A live security score per contract, 0..1000, readable by any DeFi contract (docs/future/immune-score.md, S10/SS7).
// TESTNET ONLY: an input to risk limits, never a guarantee that code is safe.
//
// NOBODY POSTS A SCORE. It is computed at every call from what other contracts already hold, each written by its own
// accountable process; this contract only reads them (sources are fixed at deploy, any may be zero = not used):
//   source                      read here                                   who writes it there
//   AuditCertificate            certificate(chainId, target): level, issue,  AuditCertificate.certify (all audit rules),
//                               expiry, revoked                              revokeFor (judged valid critical/high)
//   AuditNetwork                the certificate's post-certificate findings  bonded auditors (commit-reveal); judges
//                               revealed, undecided, claimed high/critical
//   CircuitBreaker              registered (monitored), tripped now, the     the protocol's own governance (register);
//                               last trip's start (unless proven false)      bonded runners / invariants (trips)
//   NeuroScore                  scoreOf(target): the model's risk level      governance-appointed feeders (vectors),
//                                                                            the active model (timelock)
//   ImmuneVaccines              exploitsOf(chainId, target), matchOf(target)  confirmed exploits only (audit, revoked
//                                                                            certificate, approved insurance claim)
//   ThreatRegistry              flagged / enforced / held pending review     a quorum of bonded runners; ImmuneVaccines
//   ImmuneRegistry/Mirror       isFlagged(chainId, target), isCodeFlagged    k-of-n NeuroJobs runner agreement
//
// The formula (fixed in code; governance cannot change it):
//   points  certificate  valid: Bronze 250 / Silver 325 / Gold 400, times (1/2 + 1/2 x remaining validity)   <= 400
//           neuro        known level 0: 200, 1: 150, 2: 60, 3: 0; unknown or another chain: 100              <= 200
//           monitoring   registered with the CircuitBreaker: 150                                              <= 150
//           history      250 - 125 per confirmed exploit (ImmuneVaccines) in the last 365 days, floor 0         <= 250
//   minus   open findings  100 per revealed, undecided post-certificate finding claiming high/critical (max 3)
//           breaker        300 while tripped; else 100 when the last trip began within 30 days (not proven false)
//           suspect        150 when the contract matches most selectors of an active vaccine
//   capped  0    ThreatRegistry enforces a flag, or the immune feed says critical (4)
//           100  ThreatRegistry flags it, the immune feed says high (3), or an active vaccine's exact/body match
//           150  an exploit confirmed within the last 30 days
//           200  its certificate (or the certified code) was revoked
//           300  held pending review in ThreatRegistry
//           400  the immune feed says suspicious (2)
//           500  a configured source could not be read (degraded: never better than average)
// Every read is gas-capped and caught: a source that reverts or runs out of gas lowers the score (degraded) instead of
// blocking a protocol. Sources are our own contracts, fixed at deploy (their return shapes are known).

interface ISSCertificate {
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
    function revokedCode(bytes32 codeHash) external view returns (uint256);
}

interface ISSNetwork {
    function findingsOf(uint256 id) external view returns (uint256[] memory);
    function getFinding(uint256 fid) external view returns (ISSFinding.Finding memory);
}

interface ISSFinding {
    struct Finding {
        uint64 req;
        uint64 committedAt;
        uint64 commitBlock;
        uint64 revealedAt;
        uint64 decidedAt;
        address auditor;
        uint8 status;
        uint8 claimed;
        uint8 sev;
        bool late;
        bool paid;
        bool appealOpen;
        uint64 group;
        uint128 slashed;
        bytes32 commitment;
        bytes32 findingHash;
        bytes32 evidenceHash;
    }
}

interface ISSBreaker {
    function policyGovernance(address protocol) external view returns (address);
    function isTripped(address protocol) external view returns (bool);
    function lastTrip(address protocol) external view returns (uint256);
    function tripOf(uint256 id) external view returns (ISSTrip.Trip memory);
}

interface ISSTrip {
    struct Trip {
        address protocol;
        uint8 kind;
        uint8 claim;
        uint16 mask;
        uint64 start;
        uint64 until;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 claimedAt;
        bytes32 evidenceHash;
        bytes32 detectorId;
        uint256 claimBond;
        address[] runners;
    }
}

interface ISSNeuro {
    function scoreOf(address token) external view returns (bool known, int256 score, uint8 level);
}

interface ISSVaccines {
    function exploitsOf(uint64 chainId, address target) external view returns (uint32 n, uint64 last);
    function matchOf(address c) external view returns (bytes32 vaccine, uint8 strength, bool held, uint64 at, address owner, bool active);
}

interface ISSThreats {
    function isAddressFlagged(uint256 chainId, address who) external view returns (bool, uint8);
    function isAddressEnforced(uint256 chainId, address who) external view returns (bool, uint8);
    function isCodeFlagged(bytes32 codeHash) external view returns (bool, uint8);
    function isCodeEnforced(bytes32 codeHash) external view returns (bool, uint8);
    function underReview(bytes32 key) external view returns (bool held, bytes32 vaccine, uint64 until);
}

interface ISSImmune {
    function isFlagged(uint256 chainId, address subject) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    function isCodeFlagged(bytes32 codeHash) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
}

/// @title SecurityScore: a live 0..1000 security score per contract, from on-chain facts only
contract SecurityScore {
    uint16 public constant MAX_SCORE = 1000;
    uint256 internal constant READ_GAS = 120_000;   // per source read (a hostile or broken source cannot eat the caller's gas)
    uint256 internal constant MAX_FINDINGS = 16;    // newest post-certificate findings looked at
    uint256 internal constant OPEN_COUNTED = 3;
    uint8 internal constant F_REVEALED = 2;
    uint8 internal constant SEV_HIGH = 4;
    uint8 internal constant CLAIM_PROVEN_FALSE = 2; // CircuitBreaker.Claim.ProvenFalse
    uint8 internal constant MATCH_SELECTORS = 1;
    uint8 internal constant MATCH_BODY = 2;

    struct Breakdown {
        uint16 score;
        uint16 certificate;   // points
        uint16 neuro;
        uint16 monitoring;
        uint16 history;
        uint16 penalty;       // subtracted
        uint16 cap;           // MAX_SCORE when nothing capped it
        uint8 level;          // certificate level (0 none)
        uint64 certExpires;
        uint8 openFindings;
        uint32 exploits;      // confirmed exploits in the last 365 days
        uint8 vaccineMatch;   // 0 none, 1 selectors (suspect), 2 body, 3 exact
        bool flagged;         // ThreatRegistry or the immune feed (severity >= 3)
        bool held;            // held pending review
        bool tripped;
        bool degraded;        // a configured source could not be read
    }

    ISSCertificate public immutable certificates;
    ISSNetwork public immutable network;
    ISSBreaker public immutable breaker;
    ISSNeuro public immutable neuro;
    ISSVaccines public immutable vaccines;
    ISSThreats public immutable threats;
    ISSImmune public immutable immune;

    struct Cached { uint16 score; uint64 at; }
    mapping(bytes32 => Cached) private _cached;

    event ScoreUpdated(uint64 indexed chainId, address indexed target, uint16 score, uint16 cap);

    constructor(ISSCertificate certificates_, ISSNetwork network_, ISSBreaker breaker_, ISSNeuro neuro_, ISSVaccines vaccines_,
        ISSThreats threats_, ISSImmune immune_) {
        certificates = certificates_;
        network = network_;
        breaker = breaker_;
        neuro = neuro_;
        vaccines = vaccines_;
        threats = threats_;
        immune = immune_;
    }

    /// The live score of contract `target` on chain `chainId` (this chain: block.chainid).
    function score(uint64 chainId, address target) external view returns (uint16) {
        return breakdown(chainId, target).score;
    }

    /// The live score with every part of it (what the explorer shows).
    function breakdown(uint64 chainId, address target) public view returns (Breakdown memory b) {
        b.cap = MAX_SCORE;
        bool local = chainId == block.chainid;
        _certificate(b, chainId, target);
        _neuro(b, local, target);
        _monitoring(b, local, target);
        _history(b, chainId, target);
        if (local) _match(b, target);
        _flags(b, chainId, target, local);
        if (b.degraded) _capAt(b, 500);
        uint256 pts = uint256(b.certificate) + b.neuro + b.monitoring + b.history;
        pts = pts > b.penalty ? pts - b.penalty : 0;
        if (pts > b.cap) pts = b.cap;
        b.score = uint16(pts);
    }

    /// Anyone: stores the live score (an event for indexers, a cheap read for protocols that accept its age).
    function refresh(uint64 chainId, address target) external returns (uint16 s) {
        Breakdown memory b = breakdown(chainId, target);
        s = b.score;
        _cached[keccak256(abi.encode(chainId, target))] = Cached(s, uint64(block.timestamp));
        emit ScoreUpdated(chainId, target, s, b.cap);
    }

    function cached(uint64 chainId, address target) external view returns (uint16 s, uint64 at) {
        Cached storage c = _cached[keccak256(abi.encode(chainId, target))];
        return (c.score, c.at);
    }

    // ---------------------------------------------------------------- parts

    function _capAt(Breakdown memory b, uint16 c) internal pure {
        if (c < b.cap) b.cap = c;
    }

    function _certificate(Breakdown memory b, uint64 chainId, address target) internal view {
        if (address(certificates) == address(0)) return;
        try certificates.certificate{gas: READ_GAS}(chainId, target) returns (ISSCertificate.Cert memory c, bool valid) {
            if (c.issuedAt == 0) return;
            if (c.revokedAt != 0) { _capAt(b, 200); return; }
            if (!valid) {
                // expired or the code changed: no points; a revoked code hash also caps
                try certificates.revokedCode{gas: READ_GAS}(c.codeHash) returns (uint256 r) { if (r != 0) _capAt(b, 200); } catch { b.degraded = true; }
                return;
            }
            b.level = c.level;
            b.certExpires = c.expiresAt;
            uint256 base = c.level >= 3 ? 400 : c.level == 2 ? 325 : 250;
            uint256 span = c.expiresAt > c.issuedAt ? c.expiresAt - c.issuedAt : 1;
            uint256 left = c.expiresAt > block.timestamp ? c.expiresAt - block.timestamp : 0;
            if (left > span) left = span;
            b.certificate = uint16(base / 2 + (base * left) / (2 * span));
            _openFindings(b, c.requestId);
        } catch { b.degraded = true; }
    }

    function _openFindings(Breakdown memory b, uint256 requestId) internal view {
        if (address(network) == address(0)) return;
        uint256[] memory fids;
        try network.findingsOf{gas: READ_GAS * 4}(requestId) returns (uint256[] memory f) { fids = f; } catch { b.degraded = true; return; }
        uint256 open;
        uint256 seen;
        for (uint256 i = fids.length; i > 0 && seen < MAX_FINDINGS && open < OPEN_COUNTED; --i) {
            ++seen;
            try network.getFinding{gas: READ_GAS}(fids[i - 1]) returns (ISSFinding.Finding memory f) {
                if (f.late && f.status == F_REVEALED && f.claimed >= SEV_HIGH) ++open;
            } catch { b.degraded = true; return; }
        }
        b.openFindings = uint8(open);
        b.penalty += uint16(100 * open);
    }

    function _neuro(Breakdown memory b, bool local, address target) internal view {
        b.neuro = 100;
        if (!local || address(neuro) == address(0)) return;
        try neuro.scoreOf{gas: READ_GAS}(target) returns (bool known, int256, uint8 level) {
            if (!known) return;
            b.neuro = level == 0 ? 200 : level == 1 ? 150 : level == 2 ? 60 : 0;
        } catch { b.degraded = true; }
    }

    function _monitoring(Breakdown memory b, bool local, address target) internal view {
        if (!local || address(breaker) == address(0)) return;
        try breaker.policyGovernance{gas: READ_GAS}(target) returns (address g) {
            if (g != address(0)) b.monitoring = 150;
        } catch { b.degraded = true; return; }
        try breaker.isTripped{gas: READ_GAS}(target) returns (bool t) {
            if (t) { b.tripped = true; b.penalty += 300; return; }
        } catch { b.degraded = true; return; }
        try breaker.lastTrip{gas: READ_GAS}(target) returns (uint256 id) {
            if (id == 0) return;
            try breaker.tripOf{gas: READ_GAS * 2}(id - 1) returns (ISSTrip.Trip memory t) {
                if (t.claim != CLAIM_PROVEN_FALSE && block.timestamp < uint256(t.start) + 30 days) b.penalty += 100;
            } catch { b.degraded = true; }
        } catch { b.degraded = true; }
    }

    function _history(Breakdown memory b, uint64 chainId, address target) internal view {
        b.history = 250;
        if (address(vaccines) == address(0)) return;
        try vaccines.exploitsOf{gas: READ_GAS}(chainId, target) returns (uint32 n, uint64 last) {
            if (n == 0 || block.timestamp >= uint256(last) + 365 days) return;
            b.exploits = n;
            b.history = n >= 2 ? 0 : 125;
            if (block.timestamp < uint256(last) + 30 days) _capAt(b, 150);
        } catch { b.degraded = true; }
    }

    function _match(Breakdown memory b, address target) internal view {
        if (address(vaccines) == address(0)) return;
        try vaccines.matchOf{gas: READ_GAS}(target) returns (bytes32, uint8 strength, bool, uint64, address, bool active) {
            if (!active || strength == 0) return;
            b.vaccineMatch = strength;
            if (strength >= MATCH_BODY) _capAt(b, 100);
            else if (strength == MATCH_SELECTORS) b.penalty += 150;
        } catch { b.degraded = true; }
    }

    function _flags(Breakdown memory b, uint64 chainId, address target, bool local) internal view {
        if (address(threats) != address(0)) {
            try threats.isAddressFlagged{gas: READ_GAS}(chainId, target) returns (bool f, uint8) { if (f) { b.flagged = true; _capAt(b, 100); } } catch { b.degraded = true; }
            try threats.isAddressEnforced{gas: READ_GAS}(chainId, target) returns (bool f, uint8) { if (f) _capAt(b, 0); } catch { b.degraded = true; }
            if (local) {
                bytes32 h = target.codehash;
                try threats.isCodeFlagged{gas: READ_GAS}(h) returns (bool f, uint8) { if (f) { b.flagged = true; _capAt(b, 100); } } catch { b.degraded = true; }
                try threats.isCodeEnforced{gas: READ_GAS}(h) returns (bool f, uint8) { if (f) _capAt(b, 0); } catch { b.degraded = true; }
            }
            try threats.underReview{gas: READ_GAS}(keccak256(abi.encode("zetaphy.threat.address", uint256(chainId), target))) returns (bool held, bytes32, uint64) {
                if (held) { b.held = true; _capAt(b, 300); }
            } catch { b.degraded = true; }
        }
        if (address(immune) != address(0)) {
            try immune.isFlagged{gas: READ_GAS}(chainId, target) returns (bool f, uint8 sev, uint64, bytes32) { _immuneCap(b, f, sev); } catch { b.degraded = true; }
            if (local) {
                try immune.isCodeFlagged{gas: READ_GAS}(target.codehash) returns (bool f, uint8 sev, uint64, bytes32) { _immuneCap(b, f, sev); } catch { b.degraded = true; }
            }
        }
    }

    function _immuneCap(Breakdown memory b, bool f, uint8 sev) internal pure {
        if (!f) return;
        if (sev >= 4) { b.flagged = true; _capAt(b, 0); }
        else if (sev == 3) { b.flagged = true; _capAt(b, 100); }
        else if (sev == 2) _capAt(b, 400);
    }
}

/// @title ScoredCollateral: a collateral factor and a per-pool limit that follow SecurityScore
/// @notice The example DeFi integration (TESTNET ONLY). A lending market asks `collateralFactorBps(asset)` before it
///         values collateral, and `poolLimit(pool, baseLimit)` before it lets a pool (or a vault, a bridge route)
///         take more: both read the LIVE score, so a revoked certificate, a confirmed exploit, a vaccine match or a
///         flag lowers them in the same block. Tiers are governance's (the ZetaphyTimelock), inside fixed bounds:
///         at most 4 tiers, minimum scores strictly increasing and the lowest above 300 (so anything flagged, held,
///         recently exploited or revoked — all capped at 300 or below — is worth nothing as collateral), factors
///         non-decreasing and at most 8500 bps. No other key.
contract ScoredCollateral {
    uint256 public constant MAX_TIERS = 4;
    uint16 public constant MAX_FACTOR_BPS = 8500;
    uint16 public constant MIN_TIER_SCORE = 301;
    uint16 public constant LIMIT_FLOOR = 300; // poolLimit is 0 at or below this score

    struct Tier { uint16 minScore; uint16 factorBps; }

    SecurityScore public immutable scores;
    address public governance;
    Tier[] private _tiers;

    event TiersSet(Tier[] tiers);
    event GovernanceSet(address governance);

    error NotGovernance();
    error BadTiers();

    constructor(SecurityScore scores_, address governance_, Tier[] memory tiers_) {
        require(address(scores_) != address(0) && governance_ != address(0), "zero");
        scores = scores_;
        governance = governance_;
        _setTiers(tiers_);
    }

    function setTiers(Tier[] calldata t) external {
        if (msg.sender != governance) revert NotGovernance();
        _setTiers(t);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        if (g == address(0)) revert BadTiers();
        governance = g;
        emit GovernanceSet(g);
    }

    function _setTiers(Tier[] memory t) internal {
        if (t.length == 0 || t.length > MAX_TIERS) revert BadTiers();
        for (uint256 i = 0; i < t.length; ++i) {
            if (t[i].factorBps > MAX_FACTOR_BPS || t[i].minScore > 1000) revert BadTiers();
            if (i == 0 ? t[i].minScore < MIN_TIER_SCORE : (t[i].minScore <= t[i - 1].minScore || t[i].factorBps < t[i - 1].factorBps)) revert BadTiers();
        }
        delete _tiers;
        for (uint256 i = 0; i < t.length; ++i) _tiers.push(t[i]);
        emit TiersSet(t);
    }

    function tiers() external view returns (Tier[] memory) { return _tiers; }

    /// The collateral factor (bps of value) of `asset` (a token contract on this chain) right now.
    function collateralFactorBps(address asset) public view returns (uint16 bps) {
        return factorFor(scores.score(uint64(block.chainid), asset));
    }

    function factorFor(uint16 s) public view returns (uint16 bps) {
        for (uint256 i = 0; i < _tiers.length; ++i) if (s >= _tiers[i].minScore) bps = _tiers[i].factorBps;
    }

    /// How much may be borrowed against `value` of `asset` collateral.
    function maxBorrow(address asset, uint256 value) external view returns (uint256) {
        return (value * collateralFactorBps(asset)) / 10_000;
    }

    /// The limit a pool / vault / route `pool` gets: baseLimit scaled linearly from 0 (score <= 300) to all of it
    /// (score 1000).
    function poolLimit(address pool, uint256 baseLimit) external view returns (uint256) {
        uint16 s = scores.score(uint64(block.chainid), pool);
        if (s <= LIMIT_FLOOR) return 0;
        return (baseLimit * (s - LIMIT_FLOOR)) / (1000 - LIMIT_FLOOR);
    }
}
