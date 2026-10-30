// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Neuro cross-chain security oracle (docs/future/crosschain-assist.md, items 18 and 28).
//
//   ZETAPHY                                                       each EVM testnet (Sepolia, Base Sepolia, Arbitrum Sepolia)
//   ThreatRegistry (runner quorum) --read by--> NeuroOracleSender --Hyperlane message--> NeuroOracle (DEXes query it)
//   NeuroJobs (settled verdicts)    --read by--/                     verified by the ISM of OUR validators for origin ZETAPHY
//                                              \--ICS-20 + memo (ibc-hooks)--> a CosmWasm NeuroOracle on osmo-test-5
//
// The sender holds no key and decides nothing: it reads the registry's and NeuroJobs' own state at the
// moment of the call and sends exactly that. Anyone may call push (a runner, a GitHub Actions schedule,
// a user who just saw a flag), paying the Hyperlane fee; a wrong or stale message cannot be sent
// because the contents are not the caller's. The receiver keeps per key the newest state by the
// registry's round (it bumps on every flag and clear), so out-of-order or replayed deliveries cannot
// roll a key back.
//
// Local copies of the Hyperlane v3 interfaces (IMailbox dispatch / quoteDispatch, IMessageRecipient
// handle, ISpecifiesInterchainSecurityModule), as in HyperlaneLockBoxV2.sol; named apart (one unit).

interface INOMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256 fee);
}

interface INOIsm {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

/// The parts of ThreatRegistry the sender reads.
interface INOThreats {
    function entries(bytes32 key) external view returns (bool flagged, uint8 reason, uint64 updatedAt, uint32 round, uint8 votes, bool fast, uint8 support, uint64 fastAt);
    function enforcedFrom(bytes32 key) external view returns (uint64);
    function heldFrom(bytes32 key) external view returns (uint64);
    function flaggedCount() external view returns (uint256);
    function flaggedList(uint256 i) external view returns (bytes32);
}

/// The parts of NeuroJobs the sender reads (settled verdicts).
interface INOJobs {
    function getJob(uint256 id) external view returns (address requester, uint64 created, uint8 status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat);
    function jobInfo(uint256 id) external view returns (bytes32 skill, uint256 bodies, uint256 drawn, uint64 settleAt, bytes32 rand);
    function assurance(uint256 id) external view returns (uint8 agreedBy, uint8 state, uint64 challengeUntil, bool settled);
}

/// cosmos/evm's ICS-20 precompile (0x…0802), as zetaphy-hub/chainlib.js encodes it.
interface INOIcs20 {
    struct Height { uint64 revisionNumber; uint64 revisionHeight; }
    function transfer(string calldata sourcePort, string calldata sourceChannel, string calldata denom, uint256 amount, address sender,
        string calldata receiver, Height calldata timeoutHeight, uint64 timeoutTimestamp, string calldata memo) external returns (uint64 nextSequence);
}

/// AuditCertificate's message body (kind 3): see AuditCertificate.certificateBody.
interface INOAudit {
    function certificateBody(uint64 chainId, address target) external view returns (bytes memory);
}

/// One audit certificate as mirrored (AuditCertificate.certificateBody after kind and source chain).
struct NOCert {
    uint64 chainId;
    address target;
    bytes32 codeHash;
    bytes32 reportHash;
    uint8 level;
    uint64 issuedAt;
    uint64 expiresAt;
    bool revoked;
    uint256 requestId;
}

/// One registry key as mirrored: the registry's own numbers at the time of the push.
struct NOItem {
    bytes32 key;
    uint32 round;        // ThreatRegistry Entry.round (bumps on every flag and clear)
    bool flagged;
    uint8 reason;        // ThreatRegistry.Reason
    uint64 enforcedFrom; // ZETAPHY time from which it is enforced (0: not flagged)
    uint64 heldFrom;     // ZETAPHY time from which it holds (0: not flagged)
}

/// One settled NeuroJobs verdict.
struct NOVerdict {
    uint256 jobId;
    bytes32 chain;       // NeuroJobs chain id string (bytes32), e.g. "eth"
    bytes32 target;      // keccak256 of the target string (lowercase as requested)
    bytes32 result;      // the verdict hash runners agreed on
    bytes32 skill;       // the skill the job ran under (model / rules version)
    uint8 agreedBy;
}

/// @title NeuroOracleSender: ZETAPHY side. Reads the registry and NeuroJobs, sends what they say.
contract NeuroOracleSender {
    uint8 public constant KIND_THREATS = 1;
    uint8 public constant KIND_VERDICT = 2;
    uint256 public constant MAX_ITEMS = 32;
    address public constant ICS20 = 0x0000000000000000000000000000000000000802;

    INOThreats public immutable threats;
    INOJobs public immutable jobs;      // zero: verdicts off
    INOMailbox public immutable mailbox;
    address public governance;          // the ZETAPHY timelock

    /// destination domain -> the NeuroOracle there (zero: no route)
    mapping(uint32 => bytes32) public receivers;
    uint32[] public domains;
    /// the round last pushed per destination and key, plus one (0: never)
    mapping(uint32 => mapping(bytes32 => uint32)) public sentRound;
    /// the enforcedFrom last pushed (a fast-lane enforcement keeps the round but moves it)
    mapping(uint32 => mapping(bytes32 => uint64)) public sentEnforcedFrom;

    /// AuditCertificate (docs/future/audit-network.md); zero: certificates off
    INOAudit public audit;

    // IBC (osmo-test-5): a channel and the CosmWasm contract there; empty: off
    string public ibcChannel;
    string public ibcContract;
    uint64 public ibcTimeout = 600;     // seconds

    event Pushed(uint32 indexed domain, bytes32 messageId, uint256 items);
    event VerdictPushed(uint32 indexed domain, uint256 indexed jobId, bytes32 messageId);
    event PushedIbc(string channel, uint64 sequence, uint256 items);
    event CertificatePushed(uint32 indexed domain, uint64 indexed chainId, address indexed target, bytes32 messageId);
    event AuditSet(address audit);
    event ReceiverSet(uint32 indexed domain, bytes32 receiver);
    event IbcRouteSet(string channel, string contractAddr, uint64 timeout);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NoRoute(uint32 domain);
    error TooMany();
    error NothingToSend();
    error NotSettled(uint256 jobId);
    error Fee(uint256 needed);
    error RefundFailed();
    error BadInput();

    constructor(INOThreats threats_, INOJobs jobs_, INOMailbox mailbox_, address governance_) {
        require(address(threats_) != address(0) && address(mailbox_) != address(0) && governance_ != address(0), "zero");
        threats = threats_;
        jobs = jobs_;
        mailbox = mailbox_;
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov {
        require(g != address(0), "zero");
        governance = g;
        emit GovernanceSet(g);
    }

    /// The NeuroOracle on `domain` (zero removes the route).
    function setReceiver(uint32 domain, bytes32 receiver) external onlyGov {
        if (receivers[domain] == bytes32(0) && receiver != bytes32(0)) domains.push(domain);
        receivers[domain] = receiver;
        emit ReceiverSet(domain, receiver);
    }

    function domainCount() external view returns (uint256) { return domains.length; }

    /// The AuditCertificate whose certificates pushCertificate sends (zero: off).
    function setAudit(INOAudit a) external onlyGov {
        audit = a;
        emit AuditSet(address(a));
    }

    /// An audit certificate (or its revocation), exactly as AuditCertificate states it now, to `domain`.
    function pushCertificate(uint32 domain, uint64 chainId, address target) external payable returns (bytes32 id) {
        bytes32 r = receivers[domain];
        if (r == bytes32(0)) revert NoRoute(domain);
        if (address(audit) == address(0)) revert NothingToSend();
        id = _dispatch(domain, r, audit.certificateBody(chainId, target));
        emit CertificatePushed(domain, chainId, target, id);
    }

    /// The IBC route: our channel to osmo-test-5 and the CosmWasm oracle's address (ibc-hooks calls it).
    function setIbcRoute(string calldata channel, string calldata contractAddr, uint64 timeout) external onlyGov {
        bytes memory c = bytes(channel);
        if (c.length > 0 && (c.length > 20 || !_plain(c) || !_plain(bytes(contractAddr)) || bytes(contractAddr).length > 100 || timeout < 60 || timeout > 1 days)) revert BadInput();
        ibcChannel = channel;
        ibcContract = contractAddr;
        ibcTimeout = timeout;
        emit IbcRouteSet(channel, contractAddr, timeout);
    }

    // ---------------------------------------------------------------- reading

    /// The registry's state of a key, as it would be sent now.
    function itemOf(bytes32 key) public view returns (NOItem memory it) {
        (bool flagged, uint8 reason, , uint32 round, , , , ) = threats.entries(key);
        it.key = key;
        it.round = round;
        it.flagged = flagged;
        it.reason = flagged ? reason : 0;
        if (flagged) {
            it.enforcedFrom = threats.enforcedFrom(key);
            it.heldFrom = threats.heldFrom(key);
        }
    }

    /// Whether `domain` still lacks the current state of each key (never flagged keys: false).
    function pending(uint32 domain, bytes32[] calldata keys) external view returns (bool[] memory out) {
        out = new bool[](keys.length);
        for (uint256 i = 0; i < keys.length; ++i) out[i] = _pending(domain, itemOf(keys[i]));
    }

    function _pending(uint32 domain, NOItem memory it) private view returns (bool) {
        if (it.round == 0) return false;
        uint32 s = sentRound[domain][it.key];
        return s != it.round + 1 || (it.flagged && it.enforcedFrom < sentEnforcedFrom[domain][it.key]);
    }

    /// A page of the registry's flag history (keys may repeat: a key flagged again is listed again),
    /// with each key's current round and state: what the hub's coverage meter compares.
    function snapshot(uint256 start, uint256 n) external view returns (bytes32[] memory keys, uint32[] memory rounds, bool[] memory flagged) {
        uint256 total = threats.flaggedCount();
        uint256 end = start + n > total ? total : start + n;
        uint256 len = end > start ? end - start : 0;
        keys = new bytes32[](len);
        rounds = new uint32[](len);
        flagged = new bool[](len);
        for (uint256 i = 0; i < len; ++i) {
            bytes32 k = threats.flaggedList(start + i);
            (bool f, , , uint32 r, , , , ) = threats.entries(k);
            keys[i] = k;
            rounds[i] = r;
            flagged[i] = f;
        }
    }

    // ---------------------------------------------------------------- Hyperlane

    /// The message body push(domain, keys) would send.
    function threatsBody(bytes32[] calldata keys) public view returns (bytes memory) {
        if (keys.length == 0) revert NothingToSend();
        if (keys.length > MAX_ITEMS) revert TooMany();
        NOItem[] memory items = new NOItem[](keys.length);
        for (uint256 i = 0; i < keys.length; ++i) items[i] = itemOf(keys[i]);
        return abi.encode(KIND_THREATS, block.chainid, items);
    }

    function quote(uint32 domain, bytes32[] calldata keys) external view returns (uint256) {
        bytes32 r = receivers[domain];
        if (r == bytes32(0)) revert NoRoute(domain);
        return mailbox.quoteDispatch(domain, r, threatsBody(keys));
    }

    /// Sends the registry's current state of `keys` (at most MAX_ITEMS) to the NeuroOracle on `domain`.
    /// msg.value pays the Hyperlane fee (quote); anything above it is sent back.
    function push(uint32 domain, bytes32[] calldata keys) external payable returns (bytes32 id) {
        bytes32 r = receivers[domain];
        if (r == bytes32(0)) revert NoRoute(domain);
        bytes memory b = threatsBody(keys);
        ( , , NOItem[] memory items) = abi.decode(b, (uint8, uint256, NOItem[]));
        for (uint256 i = 0; i < items.length; ++i) {
            sentRound[domain][items[i].key] = items[i].round + 1;
            sentEnforcedFrom[domain][items[i].key] = items[i].enforcedFrom;
        }
        id = _dispatch(domain, r, b);
        emit Pushed(domain, id, items.length);
    }

    /// A settled NeuroJobs verdict (no challenge open or possible any more), to `domain`.
    function pushVerdict(uint32 domain, uint256 jobId) external payable returns (bytes32 id) {
        bytes32 r = receivers[domain];
        if (r == bytes32(0)) revert NoRoute(domain);
        bytes memory b = verdictBody(jobId);
        id = _dispatch(domain, r, b);
        emit VerdictPushed(domain, jobId, id);
    }

    function verdictBody(uint256 jobId) public view returns (bytes memory) {
        if (address(jobs) == address(0)) revert NotSettled(jobId);
        (uint8 agreedBy, , , bool settled) = jobs.assurance(jobId);
        if (!settled) revert NotSettled(jobId);
        (, , , bytes32 chain, string memory target, , bytes32 result, , , ) = jobs.getJob(jobId);
        (bytes32 skill, , , , ) = jobs.jobInfo(jobId);
        return abi.encode(KIND_VERDICT, block.chainid, NOVerdict(jobId, chain, keccak256(bytes(target)), result, skill, agreedBy));
    }

    function _dispatch(uint32 domain, bytes32 r, bytes memory b) private returns (bytes32 id) {
        uint256 fee = mailbox.quoteDispatch(domain, r, b);
        if (msg.value < fee) revert Fee(fee);
        id = mailbox.dispatch{value: fee}(domain, r, b);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ---------------------------------------------------------------- IBC (osmo-test-5, ibc-hooks)

    /// The ICS-20 memo pushIbc sends: {"wasm":{"contract":C,"msg":{"mirror":{"src_chain":77390,"items":[…]}}}}.
    /// ibc-hooks on Osmosis executes `msg` on C with a sender derived from (channel, this contract's address),
    /// which C checks (zetaphy-network/cosmwasm/neuro-oracle-osmo).
    function ibcMemo(bytes32[] calldata keys) public view returns (string memory) {
        if (keys.length == 0) revert NothingToSend();
        if (keys.length > MAX_ITEMS) revert TooMany();
        bytes memory s = abi.encodePacked('{"wasm":{"contract":"', ibcContract, '","msg":{"mirror":{"src_chain":', _u(block.chainid), ',"items":[');
        for (uint256 i = 0; i < keys.length; ++i) {
            NOItem memory it = itemOf(keys[i]);
            s = abi.encodePacked(s, i == 0 ? "" : ",", '{"key":"', _hex(it.key), '","round":', _u(it.round), ',"flagged":', it.flagged ? "true" : "false",
                ',"reason":', _u(it.reason), ',"enforced_from":', _u(it.enforcedFrom), ',"held_from":', _u(it.heldFrom), "}");
        }
        return string(abi.encodePacked(s, "]}}}}"));
    }

    /// Sends the keys' state over IBC: an ICS-20 transfer of 1 azetaphy (msg.value, at least 1 wei) to the
    /// CosmWasm oracle with the memo above. The relayer carries it; Osmosis' light client of ZETAPHY verifies it.
    function pushIbc(bytes32[] calldata keys) external payable returns (uint64 seq) {
        if (bytes(ibcChannel).length == 0) revert NoRoute(0);
        if (msg.value == 0) revert Fee(1);
        string memory memo = ibcMemo(keys);
        seq = INOIcs20(ICS20).transfer("transfer", ibcChannel, "azetaphy", msg.value, address(this), ibcContract,
            INOIcs20.Height(0, 0), uint64(block.timestamp + ibcTimeout) * 1e9, memo);
        emit PushedIbc(ibcChannel, seq, keys.length);
    }

    // ---------------------------------------------------------------- text helpers

    function _plain(bytes memory b) private pure returns (bool) {
        for (uint256 i = 0; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }

    function _u(uint256 v) private pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 n;
        for (uint256 x = v; x != 0; x /= 10) ++n;
        out = new bytes(n);
        for (; v != 0; v /= 10) out[--n] = bytes1(uint8(48 + (v % 10)));
    }

    function _hex(bytes32 v) private pure returns (bytes memory out) {
        bytes16 h = "0123456789abcdef";
        out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            out[2 * i] = h[uint8(v[i]) >> 4];
            out[2 * i + 1] = h[uint8(v[i]) & 0x0f];
        }
    }
}

/// @title NeuroOracle: the mirror on another EVM chain, written only by ZETAPHY's NeuroOracleSender
/// @notice handle() takes a message only from the configured Mailbox, after the ISM this contract names
///         (a multisig ISM of OUR validators for origin ZETAPHY, as HyperlaneLockBoxV2), from origin
///         ZETAPHY and the one NeuroOracleSender. A key keeps the newest state by round; a delivery
///         that is older (or the same) changes nothing. While paused (guardians pause; governance
///         unpauses), handle reverts so messages wait at the Mailbox, and every view answers
///         "not flagged" (a DEX keeps working; `paused()` says the mirror is not current).
///
///         For DEXes: check(token) = the token's address on this chain or its code is flagged
///         (keys as ThreatRegistry.addressKey(block.chainid, token) / codeKey(token.codehash));
///         isFlagged(fp1) for Neuro's fingerprint (computed off-chain). Flags state reproducible
///         facts about code, not intent (docs/LEGAL.md); "enforced" means the registry's enforcement
///         delay passed, which is when ZETAPHY's own bridges and wallet refuse.
contract NeuroOracle {
    struct Mirror {
        uint32 round;
        bool flagged;
        uint8 reason;
        uint64 enforcedFrom;
        uint64 heldFrom;
        uint64 mirroredAt;   // this chain's time of the last update (0: never)
    }

    struct Verdict {
        uint256 jobId;
        bytes32 result;
        bytes32 skill;
        uint8 agreedBy;
        uint64 mirroredAt;
    }

    bytes32 private constant EMPTY_CODEHASH = keccak256("");
    address public immutable mailbox;
    uint32 public immutable zetaphyDomain;
    uint256 public immutable zetaphyChainId;
    bytes32 public immutable remoteSender;   // NeuroOracleSender on ZETAPHY
    INOIsm public interchainSecurityModule;
    address public governance;
    mapping(address => bool) public guardian;
    bool public paused;

    mapping(bytes32 => Mirror) public mirror;
    mapping(bytes32 => Verdict) public verdicts; // by keccak256(abi.encode(chain, targetHash))
    mapping(bytes32 => NOCert) public certs;     // audit certificates by keccak256(abi.encode(chainId, target))
    bytes32[] public keys;                       // every key ever mirrored, in first-seen order
    uint256 public flaggedNow;                   // keys whose mirrored state is flagged
    uint256 public messages;                     // messages handled
    uint64 public lastUpdate;

    event Mirrored(bytes32 indexed key, uint32 round, bool flagged, uint8 reason, uint64 enforcedFrom);
    event Stale(bytes32 indexed key, uint32 round, uint32 have);
    event VerdictMirrored(uint256 indexed jobId, bytes32 indexed chain, bytes32 indexed target, bytes32 result);
    event CertificateMirrored(uint64 indexed chainId, address indexed target, bytes32 codeHash, uint8 level, bool revoked);
    event Paused(address by);
    event Unpaused();
    event IsmSet(address ism);
    event GovernanceSet(address governance);
    event GuardianSet(address indexed who, bool on);

    error NotMailbox();
    error WrongOrigin(uint32 origin);
    error WrongSender(bytes32 sender);
    error WrongSource();
    error BadKind(uint8 kind);
    error IsPaused();
    error NoValue();
    error NotGovernance();
    error NotGuardian();

    constructor(address mailbox_, uint32 zetaphyDomain_, uint256 zetaphyChainId_, bytes32 remoteSender_, INOIsm ism_, address governance_, address guardian_) {
        require(mailbox_ != address(0) && remoteSender_ != bytes32(0) && address(ism_) != address(0) && governance_ != address(0) && zetaphyChainId_ != 0, "zero");
        mailbox = mailbox_;
        zetaphyDomain = zetaphyDomain_;
        zetaphyChainId = zetaphyChainId_;
        remoteSender = remoteSender_;
        interchainSecurityModule = ism_;
        governance = governance_;
        if (guardian_ != address(0)) { guardian[guardian_] = true; emit GuardianSet(guardian_, true); }
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    // ---------------------------------------------------------------- roles

    function setIsm(INOIsm ism) external onlyGov { require(address(ism) != address(0), "zero"); interchainSecurityModule = ism; emit IsmSet(address(ism)); }
    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }
    function setGuardian(address who, bool on) external onlyGov { guardian[who] = on; emit GuardianSet(who, on); }
    function pause() external { if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian(); paused = true; emit Paused(msg.sender); }
    function unpause() external onlyGov { paused = false; emit Unpaused(); }

    // ---------------------------------------------------------------- Hyperlane

    function handle(uint32 origin, bytes32 sender, bytes calldata b) external payable {
        if (msg.sender != mailbox) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (paused) revert IsPaused();
        if (origin != zetaphyDomain) revert WrongOrigin(origin);
        if (sender != remoteSender) revert WrongSender(sender);
        (uint8 kind, uint256 src) = abi.decode(b[:64], (uint8, uint256));
        if (src != zetaphyChainId) revert WrongSource();
        messages += 1;
        lastUpdate = uint64(block.timestamp);
        if (kind == 1) {
            ( , , NOItem[] memory items) = abi.decode(b, (uint8, uint256, NOItem[]));
            for (uint256 i = 0; i < items.length; ++i) _apply(items[i]);
        } else if (kind == 2) {
            ( , , NOVerdict memory v) = abi.decode(b, (uint8, uint256, NOVerdict));
            verdicts[keccak256(abi.encode(v.chain, v.target))] = Verdict(v.jobId, v.result, v.skill, v.agreedBy, uint64(block.timestamp));
            emit VerdictMirrored(v.jobId, v.chain, v.target, v.result);
        } else if (kind == 3) {
            ( , , NOCert memory c) = abi.decode(b, (uint8, uint256, NOCert));
            bytes32 k = keccak256(abi.encode(c.chainId, c.target));
            NOCert storage have = certs[k];
            // newest certificate wins; a revocation of the same one always applies; never un-revoke
            if (c.issuedAt > have.issuedAt || (c.issuedAt == have.issuedAt && c.revoked && !have.revoked)) {
                certs[k] = c;
                emit CertificateMirrored(c.chainId, c.target, c.codeHash, c.level, c.revoked);
            }
        } else revert BadKind(kind);
    }

    function _apply(NOItem memory it) private {
        Mirror storage m = mirror[it.key];
        bool newer = it.round > m.round || (it.round == m.round && m.mirroredAt != 0 && it.flagged && m.flagged
            && (it.enforcedFrom < m.enforcedFrom || it.heldFrom < m.heldFrom));
        if (it.round == 0 || !newer) { emit Stale(it.key, it.round, m.round); return; }
        if (m.mirroredAt == 0) keys.push(it.key);
        if (it.flagged && !m.flagged) flaggedNow += 1;
        else if (!it.flagged && m.flagged) flaggedNow -= 1;
        mirror[it.key] = Mirror(it.round, it.flagged, it.flagged ? it.reason : 0, it.flagged ? it.enforcedFrom : 0, it.flagged ? it.heldFrom : 0, uint64(block.timestamp));
        emit Mirrored(it.key, it.round, it.flagged, it.reason, it.enforcedFrom);
    }

    // ---------------------------------------------------------------- views (the same keys as ThreatRegistry)

    function codeKey(bytes32 codeHash) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.code", codeHash)); }
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.address", chainId, who)); }

    /// (flagged, reason): as soon as the runner quorum flagged it on ZETAPHY (warn).
    function isFlagged(bytes32 key) public view returns (bool, uint8) {
        Mirror storage m = mirror[key];
        if (paused || !m.flagged) return (false, 0);
        return (true, m.reason);
    }

    /// (enforced, reason): once the registry's enforcement time passed (refuse).
    function isEnforced(bytes32 key) public view returns (bool, uint8) {
        Mirror storage m = mirror[key];
        if (paused || !m.flagged || block.timestamp < m.enforcedFrom) return (false, 0);
        return (true, m.reason);
    }

    function isAddressFlagged(uint256 chainId, address who) external view returns (bool, uint8) { return isFlagged(addressKey(chainId, who)); }
    function isCodeFlagged(bytes32 codeHash) public view returns (bool, uint8) {
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODEHASH) return (false, 0);
        return isFlagged(codeKey(codeHash));
    }

    /// What a DEX asks about a token on this chain: its address (on this chain) or its code is flagged.
    function check(address token) external view returns (bool flagged, bool enforced, uint8 reason) {
        bytes32[2] memory ks = [addressKey(block.chainid, token), token.codehash == bytes32(0) || token.codehash == EMPTY_CODEHASH ? bytes32(0) : codeKey(token.codehash)];
        for (uint256 i = 0; i < 2; ++i) {
            if (ks[i] == bytes32(0)) continue;
            (bool f, uint8 r) = isFlagged(ks[i]);
            if (!f) continue;
            (bool e, ) = isEnforced(ks[i]);
            if (!flagged || (e && !enforced)) { flagged = true; enforced = e; reason = r; }
        }
    }

    /// A settled Neuro verdict for (chain, target): (jobId, result, skill, agreedBy); jobId 0 and result 0: none.
    function verdictOf(bytes32 chain, string calldata target) external view returns (uint256, bytes32, bytes32, uint8) {
        Verdict storage v = verdicts[keccak256(abi.encode(chain, keccak256(bytes(target))))];
        return (v.jobId, v.result, v.skill, v.agreedBy);
    }

    /// A ZETAPHY audit certificate as mirrored: unexpired, not revoked, and for a contract on THIS chain its
    /// EXTCODEHASH is still the certified codeHash (an upgrade or redeploy fails at once). Paused: false.
    function isCertified(uint64 chainId, address target) external view returns (bool) {
        NOCert storage c = certs[keccak256(abi.encode(chainId, target))];
        if (paused || c.issuedAt == 0 || c.revoked || block.timestamp >= c.expiresAt) return false;
        if (chainId == block.chainid && target.codehash != c.codeHash) return false;
        return true;
    }

    function keyCount() external view returns (uint256) { return keys.length; }

    /// The mirrored round of each key (0: never mirrored): the hub's coverage meter compares them with ZETAPHY's.
    function roundsOf(bytes32[] calldata ks) external view returns (uint32[] memory out) {
        out = new uint32[](ks.length);
        for (uint256 i = 0; i < ks.length; ++i) out[i] = mirror[ks[i]].round;
    }
}
