// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Cross-chain vaccines from CONFIRMED exploits (docs/future/immune-score.md, SS5). TESTNET ONLY.
//
//   confirmed exploit  --vaccinate*-->  a vaccine: the vulnerable code's hash, its body hash (the code without the
//   (one of three on-chain facts)       compiler's metadata) and its distinctive dispatcher selectors, derived ON CHAIN
//                                       from the code itself (the same rule as Neuro's scanner, zetaphy-neuro/src/
//                                       bytecode.js scanBytecode + the honest-ERC-20 baseline of similarity.js)
//   checkMatch(id, contract)   -->      a contract on ZETAPHY with the same code / body is HELD in ThreatRegistry
//   (anyone; verified on chain)         pending review (reversible, bounded in time, never a flag); a contract that
//                                       only shares most of the selectors is recorded as a SUSPECT (no hold); the
//                                       owner() of every match is notified (event)
//   other chains                        the existing immune path: the off-chain `confirmed` detector (src/immune/
//                                       detectors.js) turns the vaccine into an ImmuneRegistry finding agreed by
//                                       NeuroJobs runners; ImmuneBroadcaster carries it (and the vaccine id) to every
//                                       ImmuneMirror; sentinels there scan new contracts with the vaccine (clones)
//
// The three confirmations this contract reads (it trusts nothing a caller says beyond pointers to them):
//   1. AuditNetwork: a finding the judges decided VALID with severity high or critical, no appeal open;
//   2. AuditCertificate: a revoked certificate (or a revoked code hash) of (chainId, target);
//   3. HackInsurance: an Approved or Paid claim on target (its cover's target key is addressKey(chainid, target)).
// A vaccine stays active while one of its confirmations still holds: anyone calls `retire` after an appeal or a
// dispute overturned them all, and `release` then lifts its holds. No owner key: governance (the ZetaphyTimelock)
// only sets the review window, inside fixed bounds. Holds go through ThreatRegistry.holdForReview, which accepts
// them only from this contract (set there by governance) and never for a protected key.

interface IIVNetwork {
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
    struct Request {
        address sponsor;
        uint64 chainId;
        uint64 createdAt;
        uint64 contestEnd;
        uint8 tier;
        bool naDeclared;
        bool settled;
        bool reclaimed;
        bool certified;
        address target;
        uint32 minContest;
        uint16 minAuditors;
        uint32 reports;
        uint32 rejected;
        uint32 undecided;
        uint32 critHigh;
        uint32 openAppeals;
        uint32 totalWeight;
        uint64 certExpiry;
        uint64 prev;
        bytes32 codeHash;
        bytes32 sourceHash;
        bytes32 naReason;
        uint128 pool;
        uint128 reserve;
        uint128 reportSlash;
        bytes32 uriHash;
    }
    function getFinding(uint256 fid) external view returns (Finding memory);
    function getRequest(uint256 id) external view returns (Request memory);
}

interface IIVCertificate {
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

interface IIVInsurance {
    function claims(uint256 id) external view returns (uint256 coverId, address claimant, uint8 state, uint8 approvals, uint8 rejections,
        uint64 filedAt, uint64 decidedAt, uint128 loss, uint128 bond, bytes32 evidenceHash, bytes32 reportHash, address disputer, uint128 disputeBond);
    function covers(uint256 id) external view returns (address holder, bytes32 target, uint128 amount, uint64 startBlock, uint64 endBlock, uint64 end, bool claimed);
}

interface IIVThreats {
    function holdForReview(bytes32 key, bytes32 vaccine, uint64 duration) external returns (bool);
    function releaseReview(bytes32 key) external;
    function reviewHold(bytes32 key) external view returns (bytes32 vaccine, uint64 from, uint64 until);
}

/// @title ImmuneVaccines: vaccines derived from confirmed exploits, matched on chain, held pending review
contract ImmuneVaccines {
    // where a confirmation comes from (bit i+1 of a vaccine's `sources`)
    uint8 public constant SRC_AUDIT_FINDING = 1;
    uint8 public constant SRC_REVOKED_CERT = 2;
    uint8 public constant SRC_INSURANCE = 3;
    // match strength
    uint8 public constant MATCH_SELECTORS = 1; // >= MATCH_BPS of the vaccine's distinctive selectors: suspect, no hold
    uint8 public constant MATCH_BODY = 2;      // the same code but for the compiler's metadata: held
    uint8 public constant MATCH_EXACT = 3;     // the same EXTCODEHASH: held

    uint256 public constant MAX_SELECTORS = 64;
    uint256 public constant MIN_SELECTORS = 3; // fewer distinctive selectors: no selector matching (too generic)
    uint256 public constant MATCH_BPS = 8000;
    uint32 public constant MIN_REVIEW = 1 days;
    uint32 public constant MAX_REVIEW = 14 days;
    uint256 internal constant OWNER_GAS = 50_000;
    // AuditNetwork severities / finding status, HackInsurance claim states
    uint8 internal constant SEV_HIGH = 4;
    uint8 internal constant SEV_CRITICAL = 5;
    uint8 internal constant F_VALID = 3;
    uint8 internal constant CLAIM_APPROVED = 2;
    uint8 internal constant CLAIM_PAID = 6;
    bytes32 internal constant EMPTY = keccak256("");
    /// Neuro's honest-ERC-20 baseline selectors (zetaphy-neuro/src/threat-signatures.generated.js BASELINE.selectors,
    /// sorted): never distinctive. test/immune-vaccine.test.js checks this list against the generated file.
    bytes internal constant BASELINE =
        hex"01ffc9a706fdde03095ea7b3153b0d1e18160ddd23b872dd248a9ca32f2ff15d313ce567355274ea3644e51536568abe3f4ba83a40c10f19"
        hex"42966c685c975abb70a08231715018a679ba509779cc67907ecebe008456cb5984b0196e8da5cb5b91d1485495d89b41a217fddfa9059cbb"
        hex"d505accfd5391393d547741fdd62ed3ee30c3978f2fde38bfe575a87";

    struct Vaccine {
        uint64 chainId;        // where the vulnerable code runs (a vaccine of another chain's code is valid here too)
        address target;
        bytes32 codeHash;      // keccak256 of the vulnerable runtime code
        bytes32 bodyHash;      // keccak256 of it without the CBOR metadata (0: pattern not derived yet)
        uint8 severity;        // 3 high, 4 critical (the immune scale)
        uint8 sources;         // bit (1 << src) per confirmation that held when it was added
        bool active;
        uint64 createdAt;
        uint64 retiredAt;
        uint32 matches;
        bytes4[] selectors;    // distinctive dispatcher selectors, sorted (at most MAX_SELECTORS)
    }

    struct Match {
        bytes32 vaccine;
        uint8 strength;
        uint64 at;
        address owner;         // owner() of the contract when it matched (zero: none)
    }

    struct History {
        uint32 count;          // distinct vulnerable code hashes confirmed at (chainId, target)
        uint64 last;           // when the newest was confirmed
    }

    IIVNetwork public immutable network;       // zero: no audit-finding source
    IIVCertificate public immutable certificates; // zero: no revoked-certificate source
    IIVInsurance public immutable insurance;   // zero: no insurance source
    IIVThreats public immutable threats;       // ThreatRegistry (zero: matches are recorded, nothing is held)
    address public governance;                 // the ZetaphyTimelock
    uint32 public reviewWindow = 7 days;

    mapping(bytes32 => Vaccine) private _v;
    bytes32[] public ids;
    mapping(bytes32 => mapping(uint8 => uint256)) public sourceRef; // vaccine -> source -> ref + 1 (finding id, claim id; 1 for a cert)
    mapping(address => Match) private _match;                      // contracts on this chain
    mapping(bytes32 => address[]) private _matched;                // vaccine -> contracts it matched
    mapping(address => mapping(bytes32 => bool)) public heldOnce;  // a contract is held at most once per vaccine
    mapping(uint64 => mapping(address => History)) private _history;

    event VaccinePublished(bytes32 indexed id, uint64 indexed chainId, address indexed target, bytes32 codeHash, uint8 severity, uint8 source, uint256 ref);
    event Confirmed(bytes32 indexed id, uint8 source, uint256 ref);
    event PatternDerived(bytes32 indexed id, bytes32 bodyHash, bytes4[] selectors);
    event Matched(bytes32 indexed id, address indexed contractAddr, uint8 strength, bool held);
    event OwnerNotified(address indexed owner, address indexed contractAddr, bytes32 indexed id, uint8 strength);
    event Retired(bytes32 indexed id);
    event Released(bytes32 indexed id, address indexed contractAddr);
    event ReviewWindowSet(uint32 window);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NotConfirmed();
    error Unknown(bytes32 id);
    error Inactive(bytes32 id);
    error NoPattern(bytes32 id);
    error NoMatch();
    error NoChange();
    error BadCode();
    error BadParams();

    constructor(IIVNetwork network_, IIVCertificate certificates_, IIVInsurance insurance_, IIVThreats threats_, address governance_) {
        if (governance_ == address(0)) revert BadParams();
        network = network_;
        certificates = certificates_;
        insurance = insurance_;
        threats = threats_;
        governance = governance_;
    }

    // ---------------------------------------------------------------- keys

    function idOf(uint64 chainId, address target, bytes32 codeHash) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.vaccine.v1", chainId, target, codeHash));
    }

    /// ThreatRegistry's key of an address on a chain (the key a hold is put on).
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.threat.address", chainId, who));
    }

    // ---------------------------------------------------------------- confirmations -> vaccines

    /// From an AuditNetwork finding the judges decided valid with severity high or critical (no appeal open).
    function vaccinateFromFinding(uint256 findingId) external returns (bytes32 id) {
        if (address(network) == address(0) || !_findingHolds(findingId, true)) revert NotConfirmed();
        IIVNetwork.Finding memory f = network.getFinding(findingId);
        IIVNetwork.Request memory r = network.getRequest(f.req);
        id = _confirm(r.chainId, r.target, r.codeHash, f.sev == SEV_CRITICAL ? 4 : 3, SRC_AUDIT_FINDING, findingId);
    }

    /// From a revoked AuditCertificate certificate (or its revoked code hash) of (chainId, target).
    function vaccinateFromRevocation(uint64 chainId, address target) external returns (bytes32 id) {
        if (address(certificates) == address(0)) revert NotConfirmed();
        (IIVCertificate.Cert memory c, ) = certificates.certificate(chainId, target);
        if (c.issuedAt == 0 || (c.revokedAt == 0 && certificates.revokedCode(c.codeHash) == 0)) revert NotConfirmed();
        id = _confirm(chainId, target, c.codeHash, 4, SRC_REVOKED_CERT, 0);
    }

    /// From a HackInsurance claim that was approved (or paid) on `target` (a contract on this chain: HackInsurance
    /// covers this chain only). The code hash is the target's code now: a contract that changed since is refused.
    function vaccinateFromClaim(uint256 claimId, address target) external returns (bytes32 id) {
        if (address(insurance) == address(0) || !_claimHolds(claimId, target)) revert NotConfirmed();
        bytes32 h = target.codehash;
        if (h == bytes32(0) || h == EMPTY) revert BadCode();
        id = _confirm(uint64(block.chainid), target, h, 4, SRC_INSURANCE, claimId);
    }

    /// Valid with severity high or critical. A new vaccine also needs no appeal open on it; an existing one is kept
    /// while an appeal runs (an appeal alone must not lift holds: only its outcome can).
    function _findingHolds(uint256 fid, bool settledOnly) internal view returns (bool) {
        try network.getFinding(fid) returns (IIVNetwork.Finding memory f) {
            return f.status == F_VALID && f.sev >= SEV_HIGH && !(settledOnly && f.appealOpen);
        } catch { return false; }
    }

    function _certHolds(uint64 chainId, address target, bytes32 codeHash) internal view returns (bool) {
        try certificates.certificate(chainId, target) returns (IIVCertificate.Cert memory c, bool) {
            if (c.codeHash == codeHash && c.issuedAt != 0 && c.revokedAt != 0) return true;
        } catch {}
        try certificates.revokedCode(codeHash) returns (uint256 r) { return r != 0; } catch { return false; }
    }

    function _claimHolds(uint256 claimId, address target) internal view returns (bool) {
        // claims(id) = (coverId, claimant, state, ...): 13 static words; covers(id) = (holder, target, ...): 7
        (bool ok, bytes memory r) = address(insurance).staticcall(abi.encodeCall(IIVInsurance.claims, (claimId)));
        if (!ok || r.length != 13 * 32) return false;
        (uint256 coverId, , uint256 state) = abi.decode(r, (uint256, address, uint256));
        if (state != CLAIM_APPROVED && state != CLAIM_PAID) return false;
        (ok, r) = address(insurance).staticcall(abi.encodeCall(IIVInsurance.covers, (coverId)));
        if (!ok || r.length != 7 * 32) return false;
        (, bytes32 t) = abi.decode(r, (address, bytes32));
        return t == addressKey(block.chainid, target);
    }

    function _confirm(uint64 chainId, address target, bytes32 codeHash, uint8 severity, uint8 src, uint256 ref) internal returns (bytes32 id) {
        if (target == address(0) || codeHash == bytes32(0) || codeHash == EMPTY || chainId == 0) revert BadCode();
        id = idOf(chainId, target, codeHash);
        Vaccine storage v = _v[id];
        uint8 bit = uint8(1 << src);
        if (v.createdAt == 0) {
            v.chainId = chainId;
            v.target = target;
            v.codeHash = codeHash;
            v.createdAt = uint64(block.timestamp);
            ids.push(id);
            emit VaccinePublished(id, chainId, target, codeHash, severity, src, ref);
        } else if ((v.sources & bit) != 0) revert NoChange();
        if (severity > v.severity) v.severity = severity;
        v.sources |= bit;
        if (!v.active) {
            v.active = true;
            v.retiredAt = 0;
            History storage hst = _history[chainId][target];
            hst.count += 1;
            hst.last = uint64(block.timestamp);
        }
        sourceRef[id][src] = ref + 1;
        emit Confirmed(id, src, ref);
        // the vulnerable code itself, when it is here and unchanged: its pattern now
        if (chainId == block.chainid && v.bodyHash == bytes32(0) && target.codehash == codeHash) _derive(id, v, target.code);
    }

    // ---------------------------------------------------------------- pattern

    /// The pattern of a vaccine whose code is not on this chain (or no longer is): anyone supplies the runtime code;
    /// it must hash to the vaccine's code hash. Derived once.
    function derivePattern(bytes32 id, bytes calldata code) external {
        Vaccine storage v = _known(id);
        if (v.bodyHash != bytes32(0)) revert NoChange();
        if (keccak256(code) != v.codeHash) revert BadCode();
        _derive(id, v, code);
    }

    function _derive(bytes32 id, Vaccine storage v, bytes memory code) internal {
        (bytes32 body, bytes4[] memory sels) = patternOf(code);
        v.bodyHash = body;
        delete v.selectors;
        for (uint256 i = 0; i < sels.length; ++i) v.selectors.push(sels[i]);
        emit PatternDerived(id, body, sels);
    }

    /// The length of runtime code without its CBOR metadata (Neuro's codeLengthWithoutMetadata).
    function bodyLength(bytes memory code) public pure returns (uint256) {
        uint256 n = code.length;
        if (n < 4) return n;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint8(code[n - 1]);
        if (metaLen == 0 || n < metaLen + 3) return n;
        uint256 start = n - 2 - metaLen;
        uint8 b = uint8(code[start]);
        return (b >= 0xa1 && b <= 0xa5) ? start : n;
    }

    /// keccak256 of the code without metadata, and its distinctive dispatcher selectors, sorted: every 4-byte
    /// PUSH4 followed by EQ (or DUP2 EQ) before the metadata, minus Neuro's honest baseline. The same selectors as
    /// zetaphy-network/src/immune/vaccines.js signatureOf(code).selectors (tested).
    function patternOf(bytes memory code) public pure returns (bytes32 body, bytes4[] memory sels) {
        uint256 end = bodyLength(code);
        assembly { body := keccak256(add(code, 32), end) }
        bytes4[] memory all = _dispatched(code, end);
        bytes memory base = BASELINE;
        uint256 n;
        sels = new bytes4[](all.length);
        for (uint256 i = 0; i < all.length; ++i) if (!_inList(base, all[i])) sels[n++] = all[i];
        if (n > MAX_SELECTORS) n = MAX_SELECTORS;
        assembly { mstore(sels, n) }
    }

    /// Every dispatcher selector of `code` (up to `end`), sorted, without duplicates.
    function _dispatched(bytes memory code, uint256 end) internal pure returns (bytes4[] memory out) {
        uint256 len = code.length;
        out = new bytes4[](len / 6 + 1);
        uint256 n;
        unchecked {
            for (uint256 at = 0; at < end; ++at) {
                uint256 op;
                assembly { op := byte(0, mload(add(add(code, 32), at))) }
                if (op < 0x60 || op > 0x7f) continue;
                uint256 w = op - 0x5f;
                if (w == 4 && at + 5 < len) {
                    uint256 next;
                    uint256 next2;
                    bytes4 sel;
                    assembly {
                        let p := add(add(code, 32), at)
                        sel := shl(224, shr(224, mload(add(p, 1))))
                        next := byte(0, mload(add(p, 5)))
                        next2 := byte(0, mload(add(p, 6)))
                    }
                    if (at + 6 >= len) next2 = 0;
                    if (next == 0x14 || (next == 0x81 && next2 == 0x14)) n = _insert(out, n, sel);
                }
                at += w;
            }
        }
        assembly { mstore(out, n) }
    }

    /// Sorted insert into out[0..n) (no duplicates); returns the new length.
    function _insert(bytes4[] memory out, uint256 n, bytes4 sel) internal pure returns (uint256) {
        uint256 i = n;
        unchecked {
            while (i > 0 && uint32(out[i - 1]) > uint32(sel)) --i;
            if (i > 0 && out[i - 1] == sel) return n;
            for (uint256 j = n; j > i; --j) out[j] = out[j - 1];
        }
        out[i] = sel;
        return n + 1;
    }

    function _inList(bytes memory list, bytes4 sel) internal pure returns (bool) {
        for (uint256 i = 0; i + 4 <= list.length; i += 4) {
            bytes4 x;
            assembly { x := mload(add(add(list, 32), i)) }
            if (x == sel) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- matching on this chain

    /// How strongly `code` (runtime) matches vaccine `id`: 3 exact, 2 body, 1 selectors (suspect), 0 none.
    function strengthOf(bytes32 id, bytes memory code) public view returns (uint8) {
        Vaccine storage v = _v[id];
        if (v.createdAt == 0 || code.length == 0) return 0;
        if (keccak256(code) == v.codeHash) return MATCH_EXACT;
        if (v.bodyHash == bytes32(0)) return 0;
        bytes32 body;
        uint256 end = bodyLength(code);
        assembly { body := keccak256(add(code, 32), end) }
        if (body == v.bodyHash) return MATCH_BODY;
        uint256 want = v.selectors.length;
        if (want < MIN_SELECTORS) return 0;
        bytes4[] memory have = _dispatched(code, end);
        uint256 hit;
        for (uint256 i = 0; i < want; ++i) if (_sortedHas(have, v.selectors[i])) ++hit;
        return hit * 10_000 >= want * MATCH_BPS ? MATCH_SELECTORS : 0;
    }

    function _sortedHas(bytes4[] memory a, bytes4 x) internal pure returns (bool) {
        uint256 lo;
        uint256 hi = a.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (a[mid] == x) return true;
            if (uint32(a[mid]) < uint32(x)) lo = mid + 1;
            else hi = mid;
        }
        return false;
    }

    /// Anyone: checks contract `c` on this chain against active vaccine `id`, on chain. A match is recorded (the
    /// strongest per contract), its owner() notified (event); an exact or body match is HELD in ThreatRegistry for
    /// `reviewWindow` (a hold only: reversible, never a flag; the runners' quorum, governance or a guardian decide).
    function checkMatch(bytes32 id, address c) external returns (uint8 strength) {
        Vaccine storage v = _known(id);
        if (!v.active) revert Inactive(id);
        strength = strengthOf(id, c.code);
        if (strength == 0) revert NoMatch();
        Match storage m = _match[c];
        if (m.vaccine != bytes32(0) && _v[m.vaccine].active && m.strength >= strength) revert NoChange(); // it stands
        if (m.vaccine != id) {
            _matched[id].push(c);
            v.matches += 1;
        }
        // a hold is put once per (contract, vaccine): after its window, or a release, only a flag can hold it again
        bool hold = strength >= MATCH_BODY && address(threats) != address(0) && !heldOnce[c][id];
        address owner_ = _ownerOf(c);
        _match[c] = Match(id, strength, uint64(block.timestamp), owner_);
        if (hold) heldOnce[c][id] = true;
        emit Matched(id, c, strength, hold);
        emit OwnerNotified(owner_, c, id, strength);
        // the interaction last: our own ThreatRegistry (set at deploy), which refuses protected keys
        if (hold) threats.holdForReview(addressKey(block.chainid, c), id, reviewWindow);
    }

    function _heldNow(address c, bytes32 id) internal view returns (bool) {
        if (address(threats) == address(0)) return false;
        try threats.reviewHold(addressKey(block.chainid, c)) returns (bytes32 vac, uint64, uint64 until) {
            return vac == id && until > block.timestamp;
        } catch { return false; }
    }

    function _ownerOf(address a) internal view returns (address) {
        if (a.code.length == 0) return address(0);
        (bool ok, bytes memory r) = a.staticcall{gas: OWNER_GAS}(abi.encodeWithSignature("owner()"));
        if (!ok || r.length < 32) return address(0);
        uint256 w = abi.decode(r, (uint256));
        return w >> 160 == 0 ? address(uint160(w)) : address(0);
    }

    // ---------------------------------------------------------------- retire / release

    /// Anyone: re-checks every confirmation of vaccine `id`; those overturned since (an appeal, a dispute) are
    /// dropped. When none is left the vaccine is retired (its holds can then be released).
    function retire(bytes32 id) external returns (bool retired) {
        Vaccine storage v = _known(id);
        if (!v.active) revert Inactive(id);
        uint8 s = v.sources;
        if (s & (1 << SRC_AUDIT_FINDING) != 0 && !_findingHolds(sourceRef[id][SRC_AUDIT_FINDING] - 1, false)) s &= ~uint8(1 << SRC_AUDIT_FINDING);
        if (s & (1 << SRC_REVOKED_CERT) != 0 && !_certHolds(v.chainId, v.target, v.codeHash)) s &= ~uint8(1 << SRC_REVOKED_CERT);
        if (s & (1 << SRC_INSURANCE) != 0 && !_claimHolds(sourceRef[id][SRC_INSURANCE] - 1, v.target)) s &= ~uint8(1 << SRC_INSURANCE);
        if (s == v.sources) revert NoChange();
        v.sources = s;
        if (s == 0) {
            v.active = false;
            v.retiredAt = uint64(block.timestamp);
            History storage hst = _history[v.chainId][v.target];
            if (hst.count > 0) hst.count -= 1;
            emit Retired(id);
            retired = true;
        }
    }

    /// Anyone: lifts the hold a retired vaccine put on contract `c`.
    function release(address c) external {
        bytes32 id = _match[c].vaccine;
        if (id == bytes32(0) || _v[id].active) revert NoChange();
        bool held = _heldNow(c, id);
        delete _match[c];
        emit Released(id, c);
        if (held) threats.releaseReview(addressKey(block.chainid, c));
    }

    // ---------------------------------------------------------------- governance

    function setReviewWindow(uint32 w) external {
        if (msg.sender != governance) revert NotGovernance();
        if (w < MIN_REVIEW || w > MAX_REVIEW) revert BadParams();
        reviewWindow = w;
        emit ReviewWindowSet(w);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert NotGovernance();
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    // ---------------------------------------------------------------- reads

    function _known(bytes32 id) internal view returns (Vaccine storage v) {
        v = _v[id];
        if (v.createdAt == 0) revert Unknown(id);
    }

    function count() external view returns (uint256) { return ids.length; }
    function vaccineOf(bytes32 id) external view returns (Vaccine memory) { return _v[id]; }
    function matchedOf(bytes32 id) external view returns (address[] memory) { return _matched[id]; }

    /// The strongest recorded match of contract `c` on this chain, and whether its vaccine is still active.
    function matchOf(address c) external view returns (bytes32 vaccine, uint8 strength, bool held, uint64 at, address owner, bool active) {
        Match storage m = _match[c];
        return (m.vaccine, m.strength, m.vaccine != bytes32(0) && _heldNow(c, m.vaccine), m.at, m.owner, m.vaccine != bytes32(0) && _v[m.vaccine].active);
    }

    /// Confirmed exploits of (chainId, target): distinct vulnerable code hashes with an active vaccine, and when
    /// the newest was confirmed.
    function exploitsOf(uint64 chainId, address target) external view returns (uint32 n, uint64 last) {
        History storage h = _history[chainId][target];
        return (h.count, h.last);
    }
}
