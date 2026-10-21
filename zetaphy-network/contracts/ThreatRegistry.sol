// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

/// The parts of NeuroIdentity (ERC-8004 identity registry) this registry reads:
/// who has claimed the identity of a target ("eip155:<id>:0x<lowercase hex>").
interface IIdentityOwners {
    function agentOfTarget(bytes32 caip10Hash) external view returns (uint256);
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @title ThreatRegistry: Neuro's immune system (stage 4)
/// @notice A flag here states a reproducible fact about code, not guilt: what
///         the code can do, or did in a reproducible test (Reason), with the
///         evidence that shows it (a Neuro reportHash or the hash of another
///         reproducible report, plus a short URI). Active, bonded NeuroJobs
///         runners with a track record vote to flag a key. At QUORUM distinct
///         votes the key is flagged, and every Neuro instance that reads this
///         registry warns about it, on every chain. A flag is cleared the same
///         way (QUORUM votes to clear).
///
///         Keys:
///           - a code fingerprint (Neuro's fp1: sha256 of the code with
///             addresses/immutables masked), so every copy of the code is found
///           - codeKey(h):         EVM code with extcodehash h on ZETAPHY
///           - addressKey(id, a):  address a on the chain with EVM id `id`
///         voteBatch lets a runner vote on a fingerprint together with the code
///         hashes and addresses it found for it, in one tx (one evidence for the
///         batch); each key still needs its own quorum. BridgeAirlock / BridgeGuard
///         hold (and, once enforced, refuse) flagged sources and recipients, and
///         the ZETAPHY wallet refuses to sign calls to code with an enforced flag.
///
///         Evidence: every flag vote carries one (reportHash != 0, uri at most
///         MAX_URI bytes); every vote's evidence is in its Voted event, and the
///         evidence of the round's first flag vote (the one whose reason the flag
///         shows) is stored: evidenceOf(key).
///
///         Right of reply: the parties behind a key may post responses (at most
///         MAX_RESPONSE bytes each) that wallets show next to the flag, each with
///         its author's address. Responses are kept per (key, author): an author
///         changes or removes (empty text) only its own, never another's; at most
///         MAX_RESPONSES per key (a new author past that replaces the oldest one,
///         never the governance-assigned responder's). responseAt(key, i) lists
///         them: the governance-assigned responder's first, then newest first;
///         responseOf(key) is responseAt(key, 0).
///         Who may answer for a key (respond / appeal, `mayAnswer`):
///           - addressKey(block.chainid, a) for an address a on ZETAPHY: a itself or,
///             for a contract, its current owner();
///           - addressKey(id, a) on any EVM chain (and on ZETAPHY): the owner of
///             the claimed ERC-8004 identity of "eip155:<id>:<a>" in NeuroIdentity
///             (optional: `identity`, zero = off);
///           - codeKey(h) and fp1 keys: ONLY the responder governance assigned to
///             the key (`responder`). Anyone can deploy a contract with the same
///             code and an owner() of their choosing, so code and fingerprint keys
///             have no on-chain owner to ask;
///           - any key: once governance assigned a responder, only it may answer
///             for that key (setResponder(key, 0) gives address keys back to the
///             routes above). Others' existing responses stay until their authors
///             remove them.
///         A response never changes the flag.
///
///         Appeal: whoever may answer for a flagged key (mayAnswer: so for code and
///         fp1 keys only their assigned responder) may appeal(key), paying
///         `appealBond` (appeals are off until governance sets a community fund).
///         That opens an appeal round, voted with voteAppeal, by runners who
///         neither voted for the flag nor backed it (voted/backed of the round that
///         set it, `flagRound`): fresh eyes. The appellant cannot vote in it.
///           - QUORUM appeal votes to clear: the flag is cleared, the bond is
///             refunded, and each runner who set the flag gets a strike
///             (`strikes`, a public record only: see below).
///           - QUORUM appeal votes to keep: the flag stands; the bond goes to the
///             community fund (not to the voters, so reviewers gain nothing by
///             keeping a flag).
///           - Neither within `appealWindow`: anyone may expireAppeal; the bond is
///             refunded (nobody reviewed it: not the appellant's fault).
///           - The flag cleared otherwise meanwhile (the normal clear vote,
///             governance protecting the key): the bond is refunded.
///         Funds are never pushed inside these calls: refunds are credited
///         (`owed`, taken with withdraw) and the fund's share with payFund, so
///         a failing receiver cannot block a vote. payFund pays the last non-zero
///         community fund governance set (`fundPayee`), so turning appeals off
///         (fund = 0) never sends kept bonds to address(0). Strikes slash nothing: the
///         runners' bonds are in NeuroJobs, and an automatic penalty would let a
///         colluding appeal quorum silence honest runners; governance and the
///         runners' tools can read them.
///
///         Checks on the runners (a small quorum must not freeze bridges or wallets):
///           - Warning, hold and enforcement. isFlagged / is*Flagged answer at
///             once (Neuro warns, the wallet shows a warning). is*Held answer true
///             once a flag is `holdDelay` old (a governance knob, e.g. 10 minutes,
///             below enforceDelay), or at once when it is fast (below) or a guardian
///             or governance called holdNow(key). Things that only HOLD (reversible:
///             BridgeAirlock's release, BridgeGuard's inbound queue and outbound)
///             read those, so two runners alone cannot freeze anyone's bridging
///             at once: governance and guardians get holdDelay to look. is*Enforced
///             answer true only once a flag is `enforceDelay` old; everything that
///             REFUSES (BridgeAirlock's ThreatFlagged, NeuroLane watchers, the
///             wallet's refusal) reads those.
///             What ends a hold: the flag cleared (QUORUM clear votes, or an upheld
///             appeal) or governance protecting the key. Nothing else does: a
///             source-chain LockBox has no refund path, so a held transfer waits
///             in BridgeAirlock (and a held mint in BridgeGuard's queue) until then.
///           - Fast lane. A flag is enforced at once (no enforceDelay) when
///             `fastQuorum` distinct runners stand behind it (a supermajority,
///             governance's knob, default 2 x quorum; runners can still add
///             their vote to a flag that is already standing), or when
///             governance or a guardian calls enforceNow(key) (which holds at once
///             too). Clearing (same quorum) or protecting the key lifts it as before.
///           - Protected keys. Governance (the chain's gov module through
///             MsgEVMCall, or a multisig) can protect keys, e.g. the bridge's
///             own contracts and code hashes or a common token's code. A
///             protected key cannot be flagged; protecting a flagged key clears it.
contract ThreatRegistry {
    IRunners public immutable runners;
    uint8 public immutable quorum;
    uint32 public immutable minAgreed; // verdicts a runner must have had accepted to vote

    /// What the code does, or did in a reproducible test. Never a claim about intent.
    enum Reason {
        None,
        CannotSellInSimulation,   // a simulated buy worked, the sell failed or returned almost nothing
        UnlimitedMint,            // an address can mint new tokens without a cap
        OwnerCanBlockTransfers,   // an owner/admin can stop holders from transferring or selling
        OwnerCanMoveHolderFunds,  // an owner/admin can move or burn tokens or funds held by others
        SameNameAsKnownToken,     // same name/symbol as a known token, at a different address
        SweepsApprovedTokens,     // in a test, moved tokens approved to it to an address the holder did not choose
        Other                     // another code fact: see the evidence
    }

    struct Entry {
        bool flagged;
        Reason reason;
        uint64 updatedAt;
        uint32 round;        // bumps on every flag/clear so old votes stop counting
        uint8 votes;
        bool fast;           // enforced at once (fastQuorum or enforceNow)
        uint8 support;       // distinct runners behind the standing flag
        uint64 fastAt;       // when it went fast
    }

    struct Evidence {
        bytes32 reportHash;  // Neuro reportHash, or the hash of another reproducible report
        address by;          // the runner who gave it
        uint64 at;
        string uri;          // where the report can be read (at most MAX_URI bytes)
    }

    struct Response {
        address by;
        uint64 at;
        uint256 chainId;     // the subject answered for (0: a governance-assigned responder)
        address account;
        string text;         // at most MAX_RESPONSE bytes
    }

    struct Appeal {
        address appellant;   // zero: no appeal open
        uint64 openedAt;
        uint32 flagRound;    // the round that set the flag: its voters and backers may not vote
        uint8 clearVotes;
        uint8 keepVotes;
        uint128 bond;
    }

    bytes16 private constant HEX = "0123456789abcdef";
    uint256 public constant MAX_URI = 200;
    uint256 public constant MAX_RESPONSE = 500;
    uint256 public constant MAX_RESPONSES = 8;     // per key
    uint256 public constant MAX_APPEAL_BOND = 1000 ether;
    uint64 public constant MIN_APPEAL_WINDOW = 1 days;
    uint64 public constant MAX_APPEAL_WINDOW = 90 days;

    mapping(bytes32 => Entry) public entries;
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public voted;
    /// Runners who backed a standing flag after it was set (fast lane); kept apart
    /// from `voted`, which stays exactly the quorum that set it (ThreatReports pays those).
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public backed;
    bytes32[] public flaggedList;
    mapping(bytes32 => Evidence) private _evidence;
    /// Flag voters per round (at most quorum each): the runners an upheld appeal strikes.
    mapping(bytes32 => mapping(uint32 => address[])) private _flaggers;

    /// The chain's gov module (MsgEVMCall) or a multisig.
    address public governance;
    /// Seconds a flag waits before the is*Enforced views (which block) report it.
    uint64 public enforceDelay;
    uint64 public constant MAX_ENFORCE_DELAY = 30 days;
    /// Keys governance vouched for: never flagged.
    mapping(bytes32 => bool) public protectedKey;
    /// Distinct flag votes that enforce a standing flag at once (0: off).
    uint8 public fastQuorum;
    /// Guardians (set by governance) may enforceNow / holdNow; they cannot flag, clear or protect.
    mapping(address => bool) public guardian;
    /// Seconds a flag waits before the is*Held views (which hold bridging) report it.
    uint64 public holdDelay;
    /// A guardian's (or governance's) holdNow: the flag's round it holds at once, and when.
    struct HoldNow { uint32 round; uint64 at; }
    mapping(bytes32 => HoldNow) public heldNow;

    // ---- right of reply and appeal ----
    IIdentityOwners public identity;               // zero: the identity route is off
    mapping(bytes32 => address) public responder;  // governance-assigned; exclusive once set
    mapping(bytes32 => mapping(address => Response)) private _responses; // per (key, author)
    mapping(bytes32 => address[]) private _authors;                      // authors with a response, least recently updated first
    uint128 public appealBond;
    uint64 public appealWindow = 14 days;
    address public communityFund;                  // zero: appeals off
    address public fundPayee;                      // the last non-zero communityFund: where payFund sends
    mapping(bytes32 => Appeal) public appeals;
    mapping(bytes32 => uint32) public appealCount; // appeal ids per key, from 1
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public appealVoted;
    mapping(address => uint32) public strikes;
    mapping(address => uint256) public owed;       // refunds, taken with withdraw()
    uint256 public fundOwed;                       // the community fund's share, sent with payFund()

    event Voted(bytes32 indexed fingerprint, address indexed runner, bool flag, Reason reason, bytes32 reportHash, string uri);
    event Flagged(bytes32 indexed fingerprint, Reason reason);
    event Cleared(bytes32 indexed fingerprint);
    event Protected(bytes32 indexed key, bool on);
    event EnforceDelaySet(uint64 delay);
    event GovernanceSet(address governance);
    event Supported(bytes32 indexed key, address indexed runner, uint8 support, bytes32 reportHash);
    event FastEnforced(bytes32 indexed key, address indexed by);
    event FastQuorumSet(uint8 fastQuorum);
    event GuardianSet(address indexed who, bool on);
    event Responded(bytes32 indexed key, address indexed by, uint256 chainId, address account, string text);
    event ResponderSet(bytes32 indexed key, address responder);
    event IdentitySet(address identity);
    event AppealsSet(uint128 bond, uint64 window, address fund);
    event Appealed(bytes32 indexed key, uint32 indexed id, address indexed appellant, uint128 bond);
    event AppealVoted(bytes32 indexed key, uint32 indexed id, address indexed runner, bool clear, bytes32 reportHash, string uri);
    event AppealClosed(bytes32 indexed key, uint32 indexed id, uint8 outcome); // 1 cleared, 2 kept, 3 expired, 4 flag cleared otherwise
    event Struck(address indexed runner, bytes32 indexed key, uint32 strikes);
    event Paid(address indexed to, uint256 amount);
    event HoldDelaySet(uint64 delay);
    event HeldNow(bytes32 indexed key, address indexed by);

    error NotRunner();
    error AlreadyVoted();
    error NoChange();
    error NotGovernance();
    error ProtectedKey(bytes32 key);
    error NotGuardian();
    error NotFlagged();
    error NoEvidence();
    error TooLong();
    error NotResponder();
    error AppealsOff();
    error BadBond(uint256 bond);
    error AppealOpen();
    error NoAppeal();
    error AppealExpired();
    error NotYet();
    error NotFresh();
    error PayFailed();
    error NoFund();

    constructor(IRunners runners_, uint8 quorum_, uint32 minAgreed_, address governance_, uint64 enforceDelay_) {
        require(quorum_ >= 2, "quorum");
        require(governance_ != address(0), "governance");
        require(enforceDelay_ <= MAX_ENFORCE_DELAY, "delay");
        runners = runners_;
        quorum = quorum_;
        minAgreed = minAgreed_;
        governance = governance_;
        enforceDelay = enforceDelay_;
        fastQuorum = quorum_ > 127 ? 255 : quorum_ * 2;
        holdDelay = enforceDelay_ >= 20 minutes ? 10 minutes : enforceDelay_ / 2;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov {
        require(g != address(0), "governance");
        governance = g;
        emit GovernanceSet(g);
    }

    /// Applies to flags already standing too (they are measured from when they were set).
    function setEnforceDelay(uint64 d) external onlyGov {
        require(d <= MAX_ENFORCE_DELAY, "delay");
        require(holdDelay == 0 || d > holdDelay, "holdDelay"); // holds start before enforcement
        enforceDelay = d;
        emit EnforceDelaySet(d);
    }

    /// Seconds before a flag holds bridging (is*Held), unless fast or held now.
    /// Below enforceDelay (or 0: a flag holds at once). Applies to standing flags too.
    function setHoldDelay(uint64 d) external onlyGov {
        require(d == 0 || d < enforceDelay, "holdDelay");
        holdDelay = d;
        emit HoldDelaySet(d);
    }

    /// Fast lane: this many distinct runners behind a flag enforce it at once.
    /// Above quorum (a supermajority), or 0 to turn the fast lane off.
    function setFastQuorum(uint8 f) external onlyGov {
        require(f == 0 || f > quorum, "fastQuorum");
        fastQuorum = f;
        emit FastQuorumSet(f);
    }

    function setGuardian(address who, bool on) external onlyGov {
        guardian[who] = on;
        emit GuardianSet(who, on);
    }

    /// NeuroIdentity, for the identity route of the right of reply (zero: off).
    function setIdentity(IIdentityOwners i) external onlyGov {
        identity = i;
        emit IdentitySet(address(i));
    }

    /// The only party that may answer for `key` (zero: the on-chain routes again).
    function setResponder(bytes32 key, address who) external onlyGov {
        responder[key] = who;
        emit ResponderSet(key, who);
    }

    /// Appeal bond, window and the community fund that keeps bonds of appeals
    /// that confirmed the flag. A zero fund turns appeals off (open ones still
    /// close normally); a new bond applies to new appeals only.
    function setAppeals(uint128 bond, uint64 window, address fund) external onlyGov {
        require(bond <= MAX_APPEAL_BOND, "bond");
        require(window >= MIN_APPEAL_WINDOW && window <= MAX_APPEAL_WINDOW, "window");
        appealBond = bond;
        appealWindow = window;
        communityFund = fund;
        if (fund != address(0)) fundPayee = fund;
        emit AppealsSet(bond, window, fund);
    }

    /// Governance or a guardian enforces a standing flag at once (money moving
    /// now). Only a flag the runners' quorum already set; protected keys can
    /// never be flagged, so never enforced either.
    function enforceNow(bytes32 key) external {
        if (msg.sender != governance && !guardian[msg.sender]) revert NotGuardian();
        Entry storage e = entries[key];
        if (!e.flagged) revert NotFlagged();
        if (e.fast) revert NoChange();
        _fast(e, key);
    }

    /// Governance or a guardian holds a standing flag at once (no holdDelay):
    /// bridging of its party stops now, as reversible as any hold. Only a flag
    /// the runners' quorum already set; it ends with the flag (clear / protect).
    function holdNow(bytes32 key) external {
        if (msg.sender != governance && !guardian[msg.sender]) revert NotGuardian();
        Entry storage e = entries[key];
        if (!e.flagged) revert NotFlagged();
        if (e.fast || heldNow[key].round == e.round) revert NoChange();
        heldNow[key] = HoldNow(e.round, uint64(block.timestamp));
        emit HeldNow(key, msg.sender);
    }

    function _fast(Entry storage e, bytes32 key) private {
        e.fast = true;
        e.fastAt = uint64(block.timestamp);
        emit FastEnforced(key, msg.sender);
    }

    /// Protect (or unprotect) keys. Protecting clears a flag at once and drops
    /// any votes in progress; unprotecting does not flag anything back.
    function setProtected(bytes32[] calldata keys, bool on) external onlyGov {
        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 k = keys[i];
            protectedKey[k] = on;
            emit Protected(k, on);
            if (!on) continue;
            Entry storage e = entries[k];
            if (e.flagged || e.votes != 0) {
                bool was = e.flagged;
                _reset(e, k);
                e.round += 1;
                e.updatedAt = uint64(block.timestamp);
                if (was) emit Cleared(k);
            }
        }
    }

    /// keccak256 of empty code: every account without code has it, so it is never a threat.
    bytes32 public constant EMPTY_CODEHASH = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    /// The key under which EVM code with this extcodehash is flagged.
    function codeKey(bytes32 codeHash) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.threat.code", codeHash));
    }

    /// The key under which an address on a given chain (EVM chain id) is flagged.
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.threat.address", chainId, who));
    }

    function _checkRunner() private view {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(msg.sender);
        if (!active || agreed < minAgreed || rejected > agreed) revert NotRunner();
    }

    function _checkEvidence(bool required, bytes32 reportHash, string calldata uri) private pure {
        if (required && reportHash == bytes32(0)) revert NoEvidence();
        if (bytes(uri).length > MAX_URI) revert TooLong();
    }

    /// Vote to flag (flag = true, with a reason and its evidence) or to clear
    /// (flag = false; evidence optional). `fingerprint` is any key: a fp1
    /// fingerprint, codeKey(..) or addressKey(..).
    function vote(bytes32 fingerprint, bool flag, Reason reason, bytes32 reportHash, string calldata uri) external {
        _checkRunner();
        _checkEvidence(flag, reportHash, uri);
        if (flag && protectedKey[fingerprint]) revert ProtectedKey(fingerprint);
        if (!_vote(fingerprint, flag, reason, reportHash, uri)) revert NoChange();
    }

    /// One runner's votes on several keys at once, e.g. a fingerprint plus the
    /// code hashes and addresses of its copies, with one evidence for the batch.
    /// Keys already in that state, or already voted on by this runner this
    /// round, are skipped (not an error), so the same list can be sent again as
    /// copies are found. Protected keys are skipped when flagging. On a key
    /// already flagged, a flag vote adds this runner's support (toward
    /// fastQuorum) once.
    function voteBatch(bytes32[] calldata keys, bool flag, Reason reason, bytes32 reportHash, string calldata uri) external returns (uint256 counted) {
        _checkRunner();
        _checkEvidence(flag, reportHash, uri);
        if (flag && reason == Reason.None) revert NoChange();
        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 k = keys[i];
            Entry storage e = entries[k];
            if (flag && protectedKey[k]) continue;
            if (flag && e.flagged) { if (_support(e, k, reportHash)) counted++; continue; }
            if (e.flagged == flag || voted[k][e.round][msg.sender]) continue;
            _vote(k, flag, reason, reportHash, uri);
            counted++;
        }
        if (counted == 0) revert NoChange();
    }

    /// A flag vote on a standing flag: one more runner behind it (once per
    /// runner, counting the quorum that set it). False when nothing changed.
    function _support(Entry storage e, bytes32 key, bytes32 reportHash) private returns (bool) {
        if (e.fast || e.support == type(uint8).max) return false;
        uint32 r = e.round - 1; // the round that set the flag
        if (voted[key][r][msg.sender] || backed[key][r][msg.sender]) return false;
        backed[key][r][msg.sender] = true;
        e.support += 1;
        emit Supported(key, msg.sender, e.support, reportHash);
        if (fastQuorum != 0 && e.support >= fastQuorum) _fast(e, key);
        return true;
    }

    /// The flag (or the votes in progress) is gone: an open appeal ends with its bond refunded.
    function _reset(Entry storage e, bytes32 key) private {
        e.flagged = false;
        e.reason = Reason.None;
        e.votes = 0;
        e.fast = false;
        e.support = 0;
        e.fastAt = 0;
        delete _evidence[key];
        if (appeals[key].appellant != address(0)) _closeAppeal(key, 4);
    }

    function _vote(bytes32 fingerprint, bool flag, Reason reason, bytes32 reportHash, string calldata uri) private returns (bool) {
        Entry storage e = entries[fingerprint];
        if (flag && reason == Reason.None) return false;
        if (flag && e.flagged) {
            if (voted[fingerprint][e.round - 1][msg.sender] || backed[fingerprint][e.round - 1][msg.sender]) revert AlreadyVoted();
            return _support(e, fingerprint, reportHash);
        }
        if (e.flagged == flag) return false;
        if (voted[fingerprint][e.round][msg.sender]) revert AlreadyVoted();
        voted[fingerprint][e.round][msg.sender] = true;
        e.votes += 1;
        if (flag) {
            _flaggers[fingerprint][e.round].push(msg.sender);
            if (e.reason == Reason.None) { // the round's first flag vote: its reason and evidence are what the flag shows
                e.reason = reason;
                _evidence[fingerprint] = Evidence(reportHash, msg.sender, uint64(block.timestamp), uri);
            }
        }
        emit Voted(fingerprint, msg.sender, flag, reason, reportHash, uri);
        if (e.votes >= quorum) {
            e.round += 1;
            e.updatedAt = uint64(block.timestamp);
            if (flag) {
                e.flagged = true;
                e.support = e.votes;
                e.votes = 0;
                flaggedList.push(fingerprint);
                emit Flagged(fingerprint, e.reason);
                if (fastQuorum != 0 && e.support >= fastQuorum) _fast(e, fingerprint);
            } else {
                _reset(e, fingerprint);
                emit Cleared(fingerprint);
            }
        }
        return true;
    }

    // ---- right of reply ----

    /// "eip155:<chainId>:0x<lowercase hex>", NeuroIdentity's spelling of an EVM target.
    function _caip10(uint256 chainId, address a) private pure returns (bytes memory out) {
        bytes memory digits = new bytes(78);
        uint256 n = 78;
        uint256 v = chainId;
        do { digits[--n] = bytes1(uint8(48 + v % 10)); v /= 10; } while (v != 0);
        bytes memory id = new bytes(78 - n);
        for (uint256 i = 0; i < id.length; i++) id[i] = digits[n + i];
        bytes memory hexa = new bytes(40);
        uint160 x = uint160(a);
        for (uint256 i = 40; i > 0; i--) { hexa[i - 1] = HEX[x & 15]; x >>= 4; }
        out = abi.encodePacked("eip155:", id, ":0x", hexa);
    }

    /// The claimed owner of the identity of `account` on chain `chainId` (zero: none, unclaimed or off).
    function _identityOwner(uint256 chainId, address account) private view returns (address) {
        IIdentityOwners idr = identity;
        if (address(idr) == address(0)) return address(0);
        try idr.agentOfTarget(keccak256(_caip10(chainId, account))) returns (uint256 agentId) {
            if (agentId == 0) return address(0);
            try idr.ownerOf(agentId) returns (address o) { return o == address(idr) ? address(0) : o; } catch { return address(0); }
        } catch { return address(0); }
    }

    /// The `owner()` of a contract on this chain (zero: none).
    function _ownerOf(address a) private view returns (address) {
        if (a.code.length == 0) return address(0);
        (bool ok, bytes memory r) = a.staticcall{gas: 50_000}(abi.encodeWithSignature("owner()"));
        if (!ok || r.length < 32) return address(0);
        uint256 w = abi.decode(r, (uint256));
        return w >> 160 == 0 ? address(uint160(w)) : address(0);
    }

    /// May `who` answer for `key` as the party behind (chainId, account)? (See the notice.)
    /// Code keys and fp1 keys: only their governance-assigned responder.
    function mayAnswer(bytes32 key, uint256 chainId, address account, address who) public view returns (bool) {
        address r = responder[key];
        if (r != address(0) || chainId == 0) return r != address(0) && who == r;
        if (who == address(0) || key != addressKey(chainId, account)) return false;
        if (chainId == block.chainid && (who == account || who == _ownerOf(account))) return true;
        return who == _identityOwner(chainId, account);
    }

    /// Post or replace msg.sender's own response to the flag on `key`, as the
    /// party behind (chainId, account) (see the notice). Empty text removes
    /// msg.sender's own response (always allowed to its author). Never changes the flag.
    function respond(bytes32 key, uint256 chainId, address account, string calldata text) external {
        if (bytes(text).length > MAX_RESPONSE) revert TooLong();
        Response storage cur = _responses[key][msg.sender];
        bool had = cur.by != address(0);
        if (bytes(text).length == 0) {
            if (!had) revert NoChange();
            emit Responded(key, msg.sender, cur.chainId, cur.account, text);
            delete _responses[key][msg.sender];
            _dropAuthor(key, msg.sender);
            return;
        }
        if (!mayAnswer(key, chainId, account, msg.sender)) revert NotResponder();
        if (had) _dropAuthor(key, msg.sender);
        else if (_authors[key].length >= MAX_RESPONSES) _evictOldest(key);
        _authors[key].push(msg.sender);
        _responses[key][msg.sender] = Response(msg.sender, uint64(block.timestamp), chainId, account, text);
        emit Responded(key, msg.sender, chainId, account, text);
    }

    function _dropAuthor(bytes32 key, address who) private {
        address[] storage a = _authors[key];
        uint256 n = a.length;
        for (uint256 i = 0; i < n; i++) {
            if (a[i] != who) continue;
            for (uint256 j = i + 1; j < n; j++) a[j - 1] = a[j]; // keep the order
            a.pop();
            return;
        }
    }

    /// Full: the least recently updated response goes, never the assigned responder's.
    function _evictOldest(bytes32 key) private {
        address[] storage a = _authors[key];
        address keep = responder[key];
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i] == keep) continue;
            address old = a[i];
            delete _responses[key][old];
            _dropAuthor(key, old);
            return;
        }
    }

    /// How many responses `key` has (at most MAX_RESPONSES, plus none).
    function responseCount(bytes32 key) external view returns (uint256) {
        return _authors[key].length;
    }

    /// The i-th response to `key`: the governance-assigned responder's first (if
    /// it posted one), then the others newest first. Past the end: all zero.
    function responseAt(bytes32 key, uint256 i) public view returns (string memory text, address by, uint64 at, uint256 chainId, address account) {
        address[] storage a = _authors[key];
        address r = responder[key];
        bool rFirst = r != address(0) && _responses[key][r].by != address(0);
        address who;
        if (rFirst && i == 0) who = r;
        else {
            uint256 k = rFirst ? i - 1 : i; // index among the others, newest first
            for (uint256 j = a.length; j > 0; j--) {
                if (rFirst && a[j - 1] == r) continue;
                if (k == 0) { who = a[j - 1]; break; }
                k--;
            }
        }
        if (who == address(0)) return ("", address(0), 0, 0, address(0));
        Response storage x = _responses[key][who];
        return (x.text, x.by, x.at, x.chainId, x.account);
    }

    /// The first response (responseAt(key, 0)): the assigned responder's, else the newest.
    function responseOf(bytes32 key) external view returns (string memory text, address by, uint64 at, uint256 chainId, address account) {
        return responseAt(key, 0);
    }

    /// `who`'s own response to `key` (empty: none).
    function responseBy(bytes32 key, address who) external view returns (string memory text, uint64 at, uint256 chainId, address account) {
        Response storage x = _responses[key][who];
        return (x.text, x.at, x.chainId, x.account);
    }

    /// The evidence of the flag on `key` (of the round's first flag vote; while
    /// a flag round is still open, that vote's). Zero when there is none.
    function evidenceOf(bytes32 key) external view returns (bytes32 reportHash, string memory uri, address by, uint64 at) {
        Evidence storage v = _evidence[key];
        return (v.reportHash, v.uri, v.by, v.at);
    }

    // ---- appeal ----

    /// Appeal the standing flag on `key` as the party behind (chainId, account),
    /// paying exactly appealBond. Opens an appeal round (voteAppeal).
    function appeal(bytes32 key, uint256 chainId, address account) external payable returns (uint32 id) {
        if (communityFund == address(0)) revert AppealsOff();
        Entry storage e = entries[key];
        if (!e.flagged) revert NotFlagged();
        if (appeals[key].appellant != address(0)) revert AppealOpen();
        if (msg.value != appealBond) revert BadBond(appealBond);
        if (!mayAnswer(key, chainId, account, msg.sender)) revert NotResponder();
        id = ++appealCount[key];
        appeals[key] = Appeal(msg.sender, uint64(block.timestamp), e.round - 1, 0, 0, uint128(msg.value));
        emit Appealed(key, id, msg.sender, uint128(msg.value));
    }

    /// A fresh runner's vote in the open appeal on `key`: clear the flag (clear =
    /// true) or keep it, with its own evidence (the reproduction it ran).
    /// Runners who voted for or backed the flag, and the appellant, cannot vote.
    function voteAppeal(bytes32 key, bool clear, bytes32 reportHash, string calldata uri) external {
        _checkRunner();
        _checkEvidence(true, reportHash, uri);
        Appeal storage a = appeals[key];
        if (a.appellant == address(0)) revert NoAppeal();
        if (block.timestamp >= uint256(a.openedAt) + appealWindow) revert AppealExpired();
        uint32 r = a.flagRound;
        if (voted[key][r][msg.sender] || backed[key][r][msg.sender] || msg.sender == a.appellant) revert NotFresh();
        uint32 id = appealCount[key];
        if (appealVoted[key][id][msg.sender]) revert AlreadyVoted();
        appealVoted[key][id][msg.sender] = true;
        emit AppealVoted(key, id, msg.sender, clear, reportHash, uri);
        if (clear) {
            if (++a.clearVotes < quorum) return;
            address[] storage fl = _flaggers[key][r];
            for (uint256 i = 0; i < fl.length; i++) emit Struck(fl[i], key, ++strikes[fl[i]]);
            _closeAppeal(key, 1);
            Entry storage e = entries[key];
            _reset(e, key);
            e.round += 1;
            e.updatedAt = uint64(block.timestamp);
            emit Cleared(key);
        } else if (++a.keepVotes >= quorum) {
            _closeAppeal(key, 2);
        }
    }

    /// Nobody decided within appealWindow: the bond is refunded, the flag stands.
    function expireAppeal(bytes32 key) external {
        Appeal storage a = appeals[key];
        if (a.appellant == address(0)) revert NoAppeal();
        if (block.timestamp < uint256(a.openedAt) + appealWindow) revert NotYet();
        _closeAppeal(key, 3);
    }

    /// outcome 2 (kept): the bond to the community fund; otherwise refunded.
    function _closeAppeal(bytes32 key, uint8 outcome) private {
        Appeal memory a = appeals[key];
        delete appeals[key];
        if (outcome == 2) fundOwed += a.bond;
        else owed[a.appellant] += a.bond;
        emit AppealClosed(key, appealCount[key], outcome);
    }

    /// Take refunded bonds.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        _pay(msg.sender, amount);
    }

    /// Send kept bonds to the community fund (anyone may call it): the last
    /// non-zero fund governance set, even after appeals were turned off.
    function payFund() external {
        uint256 amount = fundOwed;
        if (amount == 0) return;
        address to = fundPayee;
        if (to == address(0)) revert NoFund();
        fundOwed = 0;
        _pay(to, amount);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
        emit Paid(to, amount);
    }

    // ---- warning views: true as soon as the quorum flagged (Neuro warns on these) ----

    function isFlagged(bytes32 fingerprint) public view returns (bool, Reason) {
        Entry storage e = entries[fingerprint];
        return (e.flagged, e.reason);
    }

    /// EVM code with this code hash (extcodehash) is flagged. Empty code never is.
    function isCodeFlagged(bytes32 codeHash) public view returns (bool, Reason) {
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODEHASH) return (false, Reason.None);
        return isFlagged(codeKey(codeHash));
    }

    function isAddressFlagged(uint256 chainId, address who) public view returns (bool, Reason) {
        return isFlagged(addressKey(chainId, who));
    }

    /// For contracts on this chain: `who` itself is flagged, or the code at it is.
    function isContractFlagged(address who) external view returns (bool, Reason) {
        (bool f, Reason r) = isAddressFlagged(block.chainid, who);
        if (f) return (f, r);
        return isCodeFlagged(who.codehash);
    }

    // ---- hold views: true once the flag is holdDelay old, at once through the fast
    //      lane or holdNow (these hold bridging, reversibly) ----

    /// When a standing flag starts to hold (0: not flagged).
    function heldFrom(bytes32 key) public view returns (uint64 from) {
        Entry storage e = entries[key];
        if (!e.flagged) return 0;
        from = e.updatedAt + holdDelay;
        if (e.fast && e.fastAt < from) from = e.fastAt;
        HoldNow storage h = heldNow[key];
        if (h.round == e.round && h.at < from) from = h.at;
    }

    function isHeld(bytes32 key) public view returns (bool, Reason) {
        Entry storage e = entries[key];
        if (!e.flagged) return (false, Reason.None);
        if (e.fast || heldNow[key].round == e.round || block.timestamp >= uint256(e.updatedAt) + holdDelay) return (true, e.reason);
        return (false, Reason.None);
    }

    function isCodeHeld(bytes32 codeHash) public view returns (bool, Reason) {
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODEHASH) return (false, Reason.None);
        return isHeld(codeKey(codeHash));
    }

    function isAddressHeld(uint256 chainId, address who) public view returns (bool, Reason) {
        return isHeld(addressKey(chainId, who));
    }

    function isContractHeld(address who) external view returns (bool, Reason) {
        (bool f, Reason r) = isAddressHeld(block.chainid, who);
        if (f) return (f, r);
        return isCodeHeld(who.codehash);
    }

    // ---- enforcement views: true only once the flag is enforceDelay old, or at once
    //      through the fast lane (these block) ----

    /// When a standing flag starts to be enforced (0: not flagged).
    function enforcedFrom(bytes32 key) public view returns (uint64) {
        Entry storage e = entries[key];
        if (!e.flagged) return 0;
        uint64 normal = e.updatedAt + enforceDelay;
        return e.fast && e.fastAt < normal ? e.fastAt : normal;
    }

    function isEnforced(bytes32 key) public view returns (bool, Reason) {
        Entry storage e = entries[key];
        if (!e.flagged || (!e.fast && block.timestamp < uint256(e.updatedAt) + enforceDelay)) return (false, Reason.None);
        return (true, e.reason);
    }

    function isCodeEnforced(bytes32 codeHash) public view returns (bool, Reason) {
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODEHASH) return (false, Reason.None);
        return isEnforced(codeKey(codeHash));
    }

    function isAddressEnforced(uint256 chainId, address who) public view returns (bool, Reason) {
        return isEnforced(addressKey(chainId, who));
    }

    function isContractEnforced(address who) external view returns (bool, Reason) {
        (bool f, Reason r) = isAddressEnforced(block.chainid, who);
        if (f) return (f, r);
        return isCodeEnforced(who.codehash);
    }

    function flaggedCount() external view returns (uint256) {
        return flaggedList.length;
    }
}
