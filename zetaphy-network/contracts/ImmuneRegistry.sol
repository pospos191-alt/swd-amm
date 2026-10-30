// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The Web3 immune system, ZETAPHY side (docs/future/immune-network.md).
//
//   sentinels (every chain) --finding + evidence bundle--> NeuroJobs job (chain "immune")
//   k-of-n bonded runners re-run the detector on the evidence, commit-reveal the finding's hash
//   ImmuneRegistry.attest(jobId, finding): flagged here once the quorum agreed (provisional while the job's
//       challenge window is open; a challenge that overturns it slashes the runners in NeuroJobs and lift() clears it)
//   ImmuneBroadcaster.broadcast(keys): one call, every chain's ImmuneMirror (Hyperlane), batched and gas-bounded;
//       pushIbc for the CosmWasm mirror on Osmosis (ibc-hooks)
//
// Nobody can flag without the runners' quorum: governance can only protect keys (never flag), and a flag ends by
// itself (ttl), by a NeuroJobs "immune-clear" job (appeal), by a challenge that overturns its verdict, or by
// governance protecting the key (on ThreatRegistry, read here, or here).

interface IIRJobs {
    function getJob(uint256 id) external view returns (address requester, uint64 created, uint8 status, bytes32 chain, string memory target,
        uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat);
    function assurance(uint256 id) external view returns (uint8 agreedBy, uint8 state, uint64 challengeUntil, bool settled);
}

interface IIRThreats {
    function protectedKey(bytes32 key) external view returns (bool);
}

interface IIRMailbox {
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256 fee);
}

interface IIRIcs20 {
    struct Height { uint64 revisionNumber; uint64 revisionHeight; }
    function transfer(string calldata sourcePort, string calldata sourceChannel, string calldata denom, uint256 amount, address sender,
        string calldata receiver, Height calldata timeoutHeight, uint64 timeoutTimestamp, string calldata memo) external returns (uint64 nextSequence);
}

/// What the runners agree on: its keccak256 (findingHash) is the NeuroJobs verdict.
struct ImmuneFinding {
    uint64 chainId;        // where it was seen: an EVM chain id, or the Hyperlane domain of a non-EVM chain
    bytes32 subject;       // EVM: the address, left-padded; Solana: the 32-byte account; Cosmos: the account bytes, left-padded
    bytes32 codeHash;      // EVM code (EXTCODEHASH) flagged on every chain too; 0: none
    uint8 kind;            // 1 exploit contract, 2 attacker, 3 drainer, 4 malicious spender, 5 scam clone, 6 compromised
    uint8 severity;        // 1 info, 2 suspicious, 3 high, 4 critical
    bool everyChain;       // an externally owned account: flagged on every EVM chain (the same key signs everywhere)
    uint32 ttl;            // seconds the flag holds unless renewed (MIN_TTL..MAX_TTL)
    bytes32 evidenceHash;  // sha256 of the evidence bundle (IPFS CIDv1 raw sha2-256)
    bytes32 vaccine;       // sha256 of the vaccine (the derived detector) shared with the flag; 0: none
}

/// One key as stored here and as mirrored.
struct ImmuneItem {
    bytes32 key;
    uint32 round;          // bumps on every flag, renewal and lift: the newest round wins on the mirrors
    bool flagged;
    uint8 keyType;         // 1 an account on chainId, 2 an EVM address on every chain (chainId 0), 3 code
    uint64 chainId;
    bytes32 subject;       // the account (keyType 1, 2) or the code hash (3)
    uint8 kind;
    uint8 severity;
    uint64 since;
    uint64 expiresAt;
    bytes32 evidenceHash;
    bytes32 vaccine;
}

/// @title ImmuneRegistry: flags made only by a quorum of bonded NeuroJobs runners
contract ImmuneRegistry {
    bytes32 public constant CHAIN_FLAG = "immune";
    bytes32 public constant CHAIN_CLEAR = "immune-clear";
    uint32 public constant MIN_TTL = 1 days;
    uint32 public constant MAX_TTL = 180 days;
    uint8 private constant DONE = 2;          // NeuroJobs Status.Done
    uint8 private constant CHALLENGE_OPEN = 1; // NeuroJobs ChallengeState.Open

    struct Entry {
        ImmuneItem item;
        uint256 jobId;     // the job whose verdict set it
        bytes32 verdict;   // that verdict (a challenge that changes it lifts the flag)
    }

    IIRJobs public immutable jobs;
    IIRThreats public immutable threats;     // ThreatRegistry: its protected keys are protected here too (zero: none)
    uint8 public immutable minAgreed;        // runners that must have revealed the same verdict
    address public governance;

    mapping(bytes32 => Entry) private _e;
    mapping(bytes32 => bool) public protectedKey;
    mapping(uint256 => bool) public usedJob;
    bytes32[] public history;                // every key flagged, renewed or lifted, in order (coverage, feed)
    uint256 public flaggedNow;

    event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event AccountThreatFlag(uint256 indexed chainId, bytes32 indexed account, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    event Attested(bytes32 indexed key, uint256 indexed jobId, uint32 round, uint8 kind, uint8 severity, uint64 expiresAt, bytes32 evidenceHash, bytes32 vaccine, bool provisional);
    event Lifted(bytes32 indexed key, uint32 round, uint8 why); // 1 appeal (clear job), 2 verdict overturned, 3 expired, 4 protected
    event ProtectedSet(bytes32 indexed key, bool on);
    event GovernanceSet(address governance);

    error NotGovernance();
    error JobUsed(uint256 jobId);
    error NotAgreed(uint256 jobId);
    error WrongJob(uint256 jobId);
    error BadFinding();
    error AllProtected();
    error NotFlagged(bytes32 key);
    error Stands(bytes32 key);

    constructor(IIRJobs jobs_, IIRThreats threats_, uint8 minAgreed_, address governance_) {
        require(address(jobs_) != address(0) && governance_ != address(0) && minAgreed_ >= 2, "bad");
        jobs = jobs_;
        threats = threats_;
        minAgreed = minAgreed_;
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }

    /// Governance vouches for keys (e.g. a bridge's own contracts): never flagged; protecting a flagged key lifts it.
    /// Governance cannot flag anything.
    function setProtected(bytes32[] calldata keys, bool on) external onlyGov {
        for (uint256 i = 0; i < keys.length; ++i) {
            protectedKey[keys[i]] = on;
            emit ProtectedSet(keys[i], on);
            if (on && _e[keys[i]].item.flagged) _lift(keys[i], 4);
        }
    }

    // ---------------------------------------------------------------- keys (ThreatRegistry's derivations)

    function codeKey(bytes32 codeHash) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.code", codeHash)); }
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.address", chainId, who)); }
    /// A non-EVM account (Solana, Cosmos): its bytes, left-padded to 32.
    function accountKey(uint256 chainId, bytes32 account) public pure returns (bytes32) {
        if (uint256(account) >> 160 == 0) return addressKey(chainId, address(uint160(uint256(account))));
        return keccak256(abi.encode("zetaphy.threat.account", chainId, account));
    }

    function isProtected(bytes32 key) public view returns (bool) {
        if (protectedKey[key]) return true;
        if (address(threats) == address(0)) return false;
        try threats.protectedKey(key) returns (bool p) { return p; } catch { return false; }
    }

    // ---------------------------------------------------------------- what the runners sign

    function findingHash(ImmuneFinding calldata f) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.immune.finding.v1", f));
    }

    /// The verdict a clear (appeal) job must reach for `key` at its current round.
    function clearHash(bytes32 key, uint32 round) public pure returns (bytes32) {
        return keccak256(abi.encode("zetaphy.immune.clear.v1", key, round));
    }

    /// The job's verdict, after checking it is an agreed one of chain `chain` with no challenge running.
    function _agreed(uint256 jobId, bytes32 chain) private view returns (bytes32 result, bool settled) {
        if (usedJob[jobId]) revert JobUsed(jobId);
        (, , uint8 status, bytes32 c, , , bytes32 r, , , ) = jobs.getJob(jobId);
        if (c != chain) revert WrongJob(jobId);
        (uint8 agreedBy, uint8 state, , bool s) = jobs.assurance(jobId);
        if (status != DONE || agreedBy < minAgreed || state == CHALLENGE_OPEN) revert NotAgreed(jobId);
        return (r, s);
    }

    // ---------------------------------------------------------------- flag, renew, lift

    /// Records a finding the runners agreed on (job `jobId`, chain "immune", verdict findingHash(f)). Anyone may call.
    /// Provisional while the job's challenge window is open (the flag already shows: the network warns at once).
    function attest(uint256 jobId, ImmuneFinding calldata f) external returns (uint256 keysSet) {
        (bytes32 result, bool settled) = _agreed(jobId, CHAIN_FLAG);
        if (result != findingHash(f)) revert WrongJob(jobId);
        if (f.kind == 0 || f.kind > 6 || f.severity == 0 || f.severity > 4 || f.ttl < MIN_TTL || f.ttl > MAX_TTL
            || f.evidenceHash == bytes32(0) || f.subject == bytes32(0) || f.chainId == 0) revert BadFinding();
        bool evm = uint256(f.subject) >> 160 == 0;
        if (f.everyChain && !evm) revert BadFinding();
        usedJob[jobId] = true;
        if (_flag(accountKey(f.chainId, f.subject), 1, f.chainId, f.subject, f, jobId, result, settled)) keysSet++;
        if (f.everyChain && _flag(addressKey(0, address(uint160(uint256(f.subject)))), 2, 0, f.subject, f, jobId, result, settled)) keysSet++;
        if (f.codeHash != bytes32(0) && f.codeHash != keccak256("") && _flag(codeKey(f.codeHash), 3, 0, f.codeHash, f, jobId, result, settled)) keysSet++;
        if (keysSet == 0) revert AllProtected();
    }

    function _flag(bytes32 key, uint8 keyType, uint64 chainId, bytes32 subject, ImmuneFinding calldata f, uint256 jobId, bytes32 verdict, bool settled) private returns (bool) {
        if (isProtected(key)) return false;
        Entry storage e = _e[key];
        ImmuneItem storage it = e.item;
        bool active = it.flagged && block.timestamp < it.expiresAt;
        if (!it.flagged) flaggedNow += 1;
        it.key = key;
        it.round += 1;
        it.flagged = true;
        it.keyType = keyType;
        it.chainId = chainId;
        it.subject = subject;
        it.kind = f.kind;
        it.severity = f.severity;
        if (!active) it.since = uint64(block.timestamp);
        it.expiresAt = uint64(block.timestamp) + f.ttl;
        it.evidenceHash = f.evidenceHash;
        it.vaccine = f.vaccine;
        e.jobId = jobId;
        e.verdict = verdict;
        history.push(key);
        emit Attested(key, jobId, it.round, f.kind, f.severity, it.expiresAt, f.evidenceHash, f.vaccine, !settled);
        _announce(it);
        return true;
    }

    /// Appeal: a NeuroJobs job of chain "immune-clear" whose runners agreed on clearHash(key, round) lifts the flag.
    function clear(uint256 jobId, bytes32 key) external {
        (bytes32 result, ) = _agreed(jobId, CHAIN_CLEAR);
        ImmuneItem storage it = _e[key].item;
        if (!it.flagged) revert NotFlagged(key);
        if (result != clearHash(key, it.round)) revert WrongJob(jobId);
        usedJob[jobId] = true;
        _lift(key, 1);
    }

    /// Lifts a flag that no longer stands: its verdict was overturned by a NeuroJobs challenge (the runners who
    /// gave it were slashed there), it expired, or the key is protected. Anyone may call (the broadcaster then
    /// carries the lift to every mirror). Returns why (2, 3, 4).
    function lift(bytes32 key) external returns (uint8 why) {
        Entry storage e = _e[key];
        if (!e.item.flagged) revert NotFlagged(key);
        (, , , , , , bytes32 r, , , ) = jobs.getJob(e.jobId);
        if (r != e.verdict) why = 2;
        else if (block.timestamp >= e.item.expiresAt) why = 3;
        else if (isProtected(key)) why = 4;
        else revert Stands(key);
        _lift(key, why);
    }

    function _lift(bytes32 key, uint8 why) private {
        ImmuneItem storage it = _e[key].item;
        it.flagged = false;
        it.round += 1;
        flaggedNow -= 1;
        history.push(key);
        emit Lifted(key, it.round, why);
        _announce(it);
    }

    function _announce(ImmuneItem storage it) private {
        bool f = it.flagged;
        if (it.keyType == 3) emit CodeThreatFlag(it.subject, f, it.severity, it.since, it.evidenceHash);
        else if (uint256(it.subject) >> 160 == 0) emit ThreatFlag(it.chainId, address(uint160(uint256(it.subject))), f, it.severity, it.since, it.evidenceHash);
        else emit AccountThreatFlag(it.chainId, it.subject, f, it.severity, it.since, it.evidenceHash);
    }

    // ---------------------------------------------------------------- views (IImmuneFeed, as on every mirror)

    function itemOf(bytes32 key) external view returns (ImmuneItem memory) { return _e[key].item; }
    function jobOf(bytes32 key) external view returns (uint256 jobId, bytes32 verdict) { return (_e[key].jobId, _e[key].verdict); }

    function _view(bytes32 key) private view returns (bool, uint8, uint64, bytes32) {
        ImmuneItem storage it = _e[key].item;
        if (!it.flagged || block.timestamp >= it.expiresAt) return (false, 0, 0, bytes32(0));
        return (true, it.severity, it.since, it.evidenceHash);
    }

    function isFlagged(uint256 chainId, address subject) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash) {
        (flagged, severity, since, evidenceHash) = _view(addressKey(chainId, subject));
        (bool f2, uint8 s2, uint64 t2, bytes32 e2) = _view(addressKey(0, subject));
        if (f2 && (!flagged || s2 > severity)) (flagged, severity, since, evidenceHash) = (f2, s2, t2, e2);
    }

    function isAccountFlagged(uint256 chainId, bytes32 account) external view returns (bool, uint8, uint64, bytes32) { return _view(accountKey(chainId, account)); }
    function isCodeFlagged(bytes32 codeHash) external view returns (bool, uint8, uint64, bytes32) { return _view(codeKey(codeHash)); }
    function live() external pure returns (bool) { return true; }
    /// True while the verdict behind the flag can still be challenged in NeuroJobs.
    function provisional(bytes32 key) external view returns (bool) {
        (, , , bool settled) = jobs.assurance(_e[key].jobId);
        return _e[key].item.flagged && !settled;
    }

    function historyCount() external view returns (uint256) { return history.length; }

    /// A page of the history with each key's current round and state (the coverage meter and the feed builder).
    function snapshot(uint256 start, uint256 n) external view returns (bytes32[] memory keys, uint32[] memory rounds, bool[] memory flagged) {
        uint256 total = history.length;
        uint256 end = start + n > total ? total : start + n;
        uint256 len = end > start ? end - start : 0;
        keys = new bytes32[](len);
        rounds = new uint32[](len);
        flagged = new bool[](len);
        for (uint256 i = 0; i < len; ++i) {
            ImmuneItem storage it = _e[history[start + i]].item;
            keys[i] = it.key;
            rounds[i] = it.round;
            flagged[i] = it.flagged;
        }
    }
}

interface IIRRegistry {
    function itemOf(bytes32 key) external view returns (ImmuneItem memory);
}

/// @title ImmuneBroadcaster: one flag on ZETAPHY -> every mirror, batched and gas-bounded
/// @notice Holds no key and decides nothing: it sends the registry's own state of the keys at the time of the call.
///         Anyone may call broadcast (a sentinel, a runner, a GitHub Actions schedule), paying the Hyperlane fees.
///         One call sends at most MAX_ITEMS keys to each of at most MAX_DOMAINS routes, and to each route only the
///         keys it still lacks (by round), so a call's gas is bounded and nothing is sent twice.
contract ImmuneBroadcaster {
    uint8 public constant KIND_IMMUNE = 4;
    uint256 public constant MAX_ITEMS = 24;
    uint256 public constant MAX_DOMAINS = 16;
    address public constant ICS20 = 0x0000000000000000000000000000000000000802;

    IIRRegistry public immutable registry;
    IIRMailbox public immutable mailbox;
    address public governance;

    mapping(uint32 => bytes32) public receivers;
    uint32[] public domains;
    /// the round last sent per destination and key (0: never)
    mapping(uint32 => mapping(bytes32 => uint32)) public sentRound;

    string public ibcChannel;
    string public ibcContract;
    uint64 public ibcTimeout = 600;

    event Broadcast(uint32 indexed domain, bytes32 messageId, uint256 items);
    event PushedIbc(string channel, uint64 sequence, uint256 items);
    event ReceiverSet(uint32 indexed domain, bytes32 receiver);
    event IbcRouteSet(string channel, string contractAddr, uint64 timeout);
    event GovernanceSet(address governance);

    error NotGovernance();
    error NoRoute(uint32 domain);
    error TooMany();
    error NothingToSend();
    error Fee(uint256 needed);
    error RefundFailed();
    error BadInput();

    constructor(IIRRegistry registry_, IIRMailbox mailbox_, address governance_) {
        require(address(registry_) != address(0) && address(mailbox_) != address(0) && governance_ != address(0), "zero");
        registry = registry_;
        mailbox = mailbox_;
        governance = governance_;
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setGovernance(address g) external onlyGov { require(g != address(0), "zero"); governance = g; emit GovernanceSet(g); }

    /// The ImmuneMirror on `domain` (zero removes the route; at most MAX_DOMAINS routes).
    function setReceiver(uint32 domain, bytes32 receiver) external onlyGov {
        if (receiver != bytes32(0) && receivers[domain] == bytes32(0)) {
            bool known;
            for (uint256 i = 0; i < domains.length; ++i) if (domains[i] == domain) known = true;
            if (!known) {
                if (domains.length >= MAX_DOMAINS) revert TooMany();
                domains.push(domain);
            }
        }
        receivers[domain] = receiver;
        emit ReceiverSet(domain, receiver);
    }

    function domainCount() external view returns (uint256) { return domains.length; }

    function setIbcRoute(string calldata channel, string calldata contractAddr, uint64 timeout) external onlyGov {
        bytes memory c = bytes(channel);
        if (c.length > 0 && (c.length > 20 || !_plain(c) || !_plain(bytes(contractAddr)) || bytes(contractAddr).length > 100 || timeout < 60 || timeout > 1 days)) revert BadInput();
        ibcChannel = channel;
        ibcContract = contractAddr;
        ibcTimeout = timeout;
        emit IbcRouteSet(channel, contractAddr, timeout);
    }

    // ---------------------------------------------------------------- what would be sent

    function _items(uint32 domain, bytes32[] calldata keys) private view returns (ImmuneItem[] memory out) {
        if (keys.length > MAX_ITEMS) revert TooMany();
        ImmuneItem[] memory all = new ImmuneItem[](keys.length);
        uint256 n;
        for (uint256 i = 0; i < keys.length; ++i) {
            ImmuneItem memory it = registry.itemOf(keys[i]);
            if (it.round == 0 || sentRound[domain][keys[i]] >= it.round) continue;
            bool dup;
            for (uint256 j = 0; j < n; ++j) if (all[j].key == it.key) dup = true;
            if (!dup) all[n++] = it;
        }
        out = new ImmuneItem[](n);
        for (uint256 i = 0; i < n; ++i) out[i] = all[i];
    }

    /// Which of `keys` `domain` still lacks (never flagged keys: false).
    function pending(uint32 domain, bytes32[] calldata keys) external view returns (bool[] memory out) {
        out = new bool[](keys.length);
        for (uint256 i = 0; i < keys.length; ++i) {
            ImmuneItem memory it = registry.itemOf(keys[i]);
            out[i] = it.round != 0 && sentRound[domain][keys[i]] < it.round;
        }
    }

    function body(uint32 domain, bytes32[] calldata keys) public view returns (bytes memory) {
        ImmuneItem[] memory items = _items(domain, keys);
        if (items.length == 0) return "";
        return abi.encode(KIND_IMMUNE, block.chainid, items);
    }

    /// The fee broadcast(keys) needs: the sum over every route that lacks one of the keys.
    function quote(bytes32[] calldata keys) external view returns (uint256 total) {
        for (uint256 i = 0; i < domains.length; ++i) {
            uint32 d = domains[i];
            bytes32 r = receivers[d];
            if (r == bytes32(0)) continue;
            bytes memory b = body(d, keys);
            if (b.length != 0) total += mailbox.quoteDispatch(d, r, b);
        }
    }

    // ---------------------------------------------------------------- send

    /// The registry's current state of `keys` (at most MAX_ITEMS) to every route that lacks it, one message each.
    /// msg.value pays the fees (quote); the rest is sent back.
    function broadcast(bytes32[] calldata keys) external payable returns (uint256 messages) {
        uint256 left = msg.value;
        for (uint256 i = 0; i < domains.length; ++i) {
            uint32 d = domains[i];
            bytes32 r = receivers[d];
            if (r == bytes32(0)) continue;
            (uint256 fee, ) = _send(d, r, keys, left);
            if (fee == type(uint256).max) continue;
            left -= fee;
            messages++;
        }
        if (messages == 0) revert NothingToSend();
        if (left > 0) {
            (bool ok, ) = msg.sender.call{value: left}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// The same to one route.
    function pushTo(uint32 domain, bytes32[] calldata keys) external payable returns (bytes32 id) {
        bytes32 r = receivers[domain];
        if (r == bytes32(0)) revert NoRoute(domain);
        uint256 fee;
        (fee, id) = _send(domain, r, keys, msg.value);
        if (fee == type(uint256).max) revert NothingToSend();
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// Sends what `domain` lacks; returns the fee paid (max: nothing to send).
    function _send(uint32 d, bytes32 r, bytes32[] calldata keys, uint256 budget) private returns (uint256 fee, bytes32 id) {
        ImmuneItem[] memory items = _items(d, keys);
        if (items.length == 0) return (type(uint256).max, bytes32(0));
        bytes memory b = abi.encode(KIND_IMMUNE, block.chainid, items);
        fee = mailbox.quoteDispatch(d, r, b);
        if (budget < fee) revert Fee(fee);
        for (uint256 j = 0; j < items.length; ++j) sentRound[d][items[j].key] = items[j].round;
        id = mailbox.dispatch{value: fee}(d, r, b);
        emit Broadcast(d, id, items.length);
    }

    // ---------------------------------------------------------------- IBC (the CosmWasm mirror on Osmosis)

    /// The ICS-20 memo pushIbc sends, in the format of the CosmWasm NeuroOracle mirror (cosmwasm/neuro-oracle-osmo):
    /// one instance of it, whose hook sender is THIS contract's, is the immune mirror there. reason = severity;
    /// enforced_from = since for severity >= 3 (refuse), else expiresAt (warn only); held_from = since.
    function ibcMemo(bytes32[] calldata keys) public view returns (string memory) {
        if (keys.length == 0) revert NothingToSend();
        if (keys.length > MAX_ITEMS) revert TooMany();
        bytes memory s = abi.encodePacked('{"wasm":{"contract":"', ibcContract, '","msg":{"mirror":{"src_chain":', _u(block.chainid), ',"items":[');
        for (uint256 i = 0; i < keys.length; ++i) {
            ImmuneItem memory it = registry.itemOf(keys[i]);
            bool on = it.flagged && block.timestamp < it.expiresAt;
            s = abi.encodePacked(s, i == 0 ? "" : ",", '{"key":"', _hex(keys[i]), '","round":', _u(it.round), ',"flagged":', on ? "true" : "false",
                ',"reason":', _u(on ? it.severity : 0), ',"enforced_from":', _u(!on ? 0 : it.severity >= 3 ? it.since : it.expiresAt),
                ',"held_from":', _u(on ? it.since : 0), "}");
        }
        return string(abi.encodePacked(s, "]}}}}"));
    }

    function pushIbc(bytes32[] calldata keys) external payable returns (uint64 seq) {
        if (bytes(ibcChannel).length == 0) revert NoRoute(0);
        if (msg.value == 0) revert Fee(1);
        string memory memo = ibcMemo(keys);
        seq = IIRIcs20(ICS20).transfer("transfer", ibcChannel, "azetaphy", msg.value, address(this), ibcContract,
            IIRIcs20.Height(0, 0), uint64(block.timestamp + ibcTimeout) * 1e9, memo);
        emit PushedIbc(ibcChannel, seq, keys.length);
    }

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
