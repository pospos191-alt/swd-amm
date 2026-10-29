// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILabelWebAuthn {
    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    function verify(bytes32 challenge, Assertion calldata a, uint256 x, uint256 y, bytes32 rpIdHash, bool requireUV)
        external view returns (bool);
}

interface ILabelAgents {
    function activeAgentOf(address account) external view returns (uint256);
}

/// The read interface for hooks (faucets, DEX gates, ...).
interface ILabels {
    /// 0 = no label, 1 = human (passkey-verified), 2 = registered AI agent
    function labelOf(address account) external view returns (uint8);
}

/// @title LabelRegistry: "human" or "agent" labels for accounts (testnet)
/// @notice
///   AGENT: an account an active agent of AgentRegistry transacts from
///          (bonded, not unbonding). Read live from the registry, so it
///          follows registration, unbonding and slashing.
///   HUMAN: an account whose owner showed a passkey (WebAuthn) with user
///          verification (fingerprint, face or device PIN), in one of two ways:
///          - on chain: proveHumanP256 checks the assertion through
///            WebAuthnVerifier (the P-256 precompile 0x…0100); the passkey's
///            challenge commits to this account and its nonce;
///          - off chain: an attester governance approved (a volunteer runner)
///            verified the assertion and signs an EIP-712 HumanAttestation
///            that anyone submits with attestHuman.
///          One passkey (its public key hash) labels one account at a time;
///          moving it to another account drops the old one's label.
///   An agent account is labelled AGENT even if it once proved a passkey.
///
///   What a HUMAN label does NOT prove: that the person is unique. Anyone can
///   make many passkeys. It proves a person was present at a device when the
///   label was made (expires after humanTtl). Hooks must treat it as a
///   speed bump against simple bots, not as proof of personhood.
contract LabelRegistry is ILabels {
    uint8 public constant NONE = 0;
    uint8 public constant HUMAN = 1;
    uint8 public constant AGENT = 2;
    uint8 public constant BY_PASSKEY = 1;
    uint8 public constant BY_ATTESTER = 2;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "HumanAttestation(address account,bytes32 credentialHash,uint64 validUntil,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct Human {
        uint64 validUntil;
        uint8 method;
        bytes32 credentialHash;
        address attester; // 0 for an on-chain passkey proof
    }

    address public governance;
    ILabelAgents public agents;
    ILabelWebAuthn public webauthn;
    bytes32 public rpIdHash;  // sha256 of the hub's host name (0 = any site)
    uint64 public humanTtl;

    mapping(address => bool) public isAttester;
    mapping(address => Human) public humans;
    mapping(bytes32 => address) public credentialAccount;
    mapping(address => uint256) public nonces;

    event HumanLabelled(address indexed account, bytes32 indexed credentialHash, uint8 method, address attester, uint64 validUntil);
    event HumanRevoked(address indexed account, address by);
    event AttesterSet(address indexed attester, bool allowed);
    event ConfigSet(address agents, address webauthn, bytes32 rpIdHash, uint64 humanTtl);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotAttester();
    error BadPasskey();
    error BadSignature();
    error Expired();
    error BadTtl();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_, address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) {
        governance = governance_;
        _config(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    // ------------------------------------------------------------- reading

    function labelOf(address account) public view returns (uint8) {
        if (address(agents) != address(0) && agents.activeAgentOf(account) != 0) return AGENT;
        Human storage h = humans[account];
        if (h.validUntil >= block.timestamp && credentialAccount[h.credentialHash] == account) return HUMAN;
        return NONE;
    }

    function isHuman(address account) external view returns (bool) {
        return labelOf(account) == HUMAN;
    }

    function isAgent(address account) external view returns (bool) {
        return labelOf(account) == AGENT;
    }

    /// The 32-byte challenge the passkey must sign to label `account` now.
    function humanChallenge(address account) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY human label", block.chainid, address(this), account, nonces[account]));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ZETAPHY Labels"), keccak256("1"), block.chainid, address(this)));
    }

    function attestationDigest(address account, bytes32 credentialHash, uint64 validUntil, uint256 nonce, uint256 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(ATTESTATION_TYPEHASH, account, credentialHash, validUntil, nonce, deadline))));
    }

    // ------------------------------------------------------------- labelling

    /// On-chain path: msg.sender labels itself with a passkey assertion over humanChallenge(msg.sender).
    function proveHumanP256(uint256 x, uint256 y, ILabelWebAuthn.Assertion calldata assertion) external {
        if (!webauthn.verify(humanChallenge(msg.sender), assertion, x, y, rpIdHash, true)) revert BadPasskey();
        _label(msg.sender, keccak256(abi.encode(x, y)), BY_PASSKEY, address(0), uint64(block.timestamp) + humanTtl);
    }

    /// Off-chain path: an attester's EIP-712 HumanAttestation, submitted by anyone.
    function attestHuman(address account, bytes32 credentialHash, uint64 validUntil, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        if (validUntil > block.timestamp + humanTtl) revert BadTtl();
        address attester = _recover(attestationDigest(account, credentialHash, validUntil, nonces[account], deadline), sig);
        if (!isAttester[attester]) revert NotAttester();
        _label(account, credentialHash, BY_ATTESTER, attester, validUntil);
    }

    /// The account itself, governance or any attester can remove a human label.
    function revokeHuman(address account) external {
        if (msg.sender != account && msg.sender != governance && !isAttester[msg.sender]) revert NotAttester();
        Human storage h = humans[account];
        if (credentialAccount[h.credentialHash] == account) delete credentialAccount[h.credentialHash];
        delete humans[account];
        nonces[account]++;
        emit HumanRevoked(account, msg.sender);
    }

    // ------------------------------------------------------------- governance

    function setAttester(address a, bool allowed) external onlyGovernance {
        isAttester[a] = allowed;
        emit AttesterSet(a, allowed);
    }

    function setConfig(address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) external onlyGovernance {
        _config(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    function setGovernance(address g) external onlyGovernance {
        governance = g;
        emit GovernanceChanged(g);
    }

    // ------------------------------------------------------------- internals

    function _config(address agents_, address webauthn_, bytes32 rpIdHash_, uint64 humanTtl_) private {
        if (humanTtl_ == 0 || humanTtl_ > 400 days) revert BadTtl();
        agents = ILabelAgents(agents_);
        webauthn = ILabelWebAuthn(webauthn_);
        rpIdHash = rpIdHash_;
        humanTtl = humanTtl_;
        emit ConfigSet(agents_, webauthn_, rpIdHash_, humanTtl_);
    }

    function _label(address account, bytes32 cred, uint8 method, address attester, uint64 until) private {
        if (cred == bytes32(0)) revert BadPasskey();
        address prev = credentialAccount[cred];
        if (prev != address(0) && prev != account) delete humans[prev]; // one passkey, one account
        Human storage old = humans[account];
        if (old.credentialHash != bytes32(0) && old.credentialHash != cred && credentialAccount[old.credentialHash] == account) {
            delete credentialAccount[old.credentialHash];
        }
        credentialAccount[cred] = account;
        humans[account] = Human({validUntil: until, method: method, credentialHash: cred, attester: attester});
        nonces[account]++;
        emit HumanLabelled(account, cred, method, attester, until);
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(d, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }
}

/// @title VouchRegistry: an optional "vouched unique human" level on top of LabelRegistry (testnet)
/// @notice Levels (levelOf):
///           0 NONE           no HUMAN label (no label, or an AI agent);
///           1 PASSKEY_HUMAN  LabelRegistry's HUMAN: a person used a passkey. Says nothing about
///                            uniqueness: one person can make many passkeys;
///           2 VOUCHED_UNIQUE a passkey human that at least `vouchesNeeded` vouched-unique humans
///                            vouched for, each saying "I know this is one real person with one
///                            account here", and not suspended or banned.
///         A web of trust, free and without a server: no stake, no fee, no oracle. What
///         makes it Sybil-RESISTANT (not Sybil-proof):
///           - every vouch is rate-limited (one per `vouchCooldown` per voucher, at most
///             `maxActiveVouches` open at once) and only from accounts that have been unique
///             for `voucherMinAge`: a ring of k colluding real people can add at most
///             k·maxActiveVouches / vouchesNeeded fake identities, and those can vouch only
///             after voucherMinAge, so growth is slow and visible on chain;
///           - a vouch binds the vouchee's passkey (credential hash): moving the label to
///             another passkey voids it;
///           - accountability: `flagsToSuspend` distinct unique humans flagging an account
///             suspend it (level 1) until they withdraw or governance clears the flags;
///             governance bans an account it finds to be a duplicate (evidence hash on chain)
///             and every voucher of it gets a strike; `strikesToBan` strikes ban the voucher;
///           - the count is live: a vouch from an account that is banned, suspended, lost its
///             HUMAN label or its own unique status no longer counts.
///         Limits (docs/future/agents.md §25): a vouched account's own vouchers are read from
///         their stored status (one level deep; anyone can refresh() a stale one); the
///         bootstrap set is chosen by governance; collusion and bought vouches are not
///         prevented, only bounded and traceable. Full Sybil resistance is not solved here.
contract VouchRegistry {
    uint8 public constant NONE = 0;
    uint8 public constant PASSKEY_HUMAN = 1;
    uint8 public constant VOUCHED_UNIQUE = 2;
    uint256 public constant MAX_VOUCHERS = 32; // open vouches one account can hold (bounds the live count)

    LabelRegistry public immutable labels;
    address public governance;

    uint8 public vouchesNeeded;
    uint8 public maxActiveVouches;
    uint8 public flagsToSuspend;
    uint8 public strikesToBan;
    uint32 public vouchCooldown;
    uint32 public voucherMinAge;

    struct Person {
        bool genesis;       // the bootstrap set (governance)
        bool banned;
        uint8 activeGiven;  // open vouches this account gave
        uint8 strikes;      // vouched for accounts later banned
        uint64 uniqueSince; // 0 = not counted unique (refresh() sets and clears it)
        uint64 lastVouchAt;
        uint32 flagEpoch;   // clearFlags() starts a new epoch
        uint16 flags;       // distinct flaggers in this epoch
    }

    mapping(address => Person) public people;
    mapping(address => address[]) private vouchersOf_;                // vouchee -> its open vouchers
    mapping(address => mapping(address => bytes32)) public vouchCredential; // voucher => vouchee => passkey hash (0 = no vouch)
    mapping(address => mapping(uint256 => mapping(address => bool))) public flaggedBy; // account => epoch => flagger

    event Vouched(address indexed voucher, address indexed vouchee, bytes32 credentialHash);
    event Unvouched(address indexed voucher, address indexed vouchee);
    event Refreshed(address indexed account, uint8 level, uint256 vouches);
    event Flagged(address indexed account, address indexed by, uint256 flags);
    event Unflagged(address indexed account, address indexed by, uint256 flags);
    event FlagsCleared(address indexed account);
    event Banned(address indexed account, bytes32 evidenceHash);
    event Unbanned(address indexed account);
    event Struck(address indexed voucher, address indexed banned, uint256 strikes);
    event GenesisSet(address indexed account, bool on);
    event ParamsSet(uint8 vouchesNeeded, uint8 maxActiveVouches, uint32 vouchCooldown, uint32 voucherMinAge, uint8 flagsToSuspend, uint8 strikesToBan);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotUnique();
    error NotPasskeyHuman(address who);
    error TooSoon(uint256 next);
    error TooManyVouches();
    error AlreadyVouched();
    error NoVouch();
    error AlreadyFlagged();
    error NotFlagged();
    error Self();
    error IsBanned(address who);
    error BadParams();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(LabelRegistry labels_, address governance_) {
        labels = labels_;
        governance = governance_;
        _params(3, 5, 7 days, 30 days, 5, 2);
    }

    // ------------------------------------------------------------- reading

    /// 0 none (or an agent), 1 passkey human (not proven unique), 2 vouched unique human.
    function levelOf(address a) public view returns (uint8) {
        if (labels.labelOf(a) != 1) return NONE;
        Person storage p = people[a];
        if (p.banned || p.flags >= flagsToSuspend) return PASSKEY_HUMAN;
        if (p.genesis) return VOUCHED_UNIQUE;
        if (p.uniqueSince != 0 && validVouches(a) >= vouchesNeeded) return VOUCHED_UNIQUE;
        return PASSKEY_HUMAN;
    }

    /// Open vouches for `a` that count now: the voucher is not banned or suspended, still a passkey
    /// human, counted unique (stored status), and `a` still has the passkey it was vouched with.
    function validVouches(address a) public view returns (uint256 n) {
        (, , bytes32 cred,) = labels.humans(a);
        address[] storage vs = vouchersOf_[a];
        for (uint256 i = 0; i < vs.length; i++) {
            address v = vs[i];
            if (vouchCredential[v][a] != cred || !_countsAsVoucher(v)) continue;
            n++;
        }
    }

    function vouchersOf(address a) external view returns (address[] memory) {
        return vouchersOf_[a];
    }

    /// Everything the hub shows: level, valid vouches, vouches needed, unique since, flags, flags to
    /// suspend, banned, genesis, open vouches given, when this account may vouch next (0 = cannot).
    function status(address a) external view returns (uint256[10] memory s) {
        Person storage p = people[a];
        s[0] = levelOf(a);
        s[1] = validVouches(a);
        s[2] = vouchesNeeded;
        s[3] = p.uniqueSince;
        s[4] = p.flags;
        s[5] = flagsToSuspend;
        s[6] = p.banned ? 1 : 0;
        s[7] = p.genesis ? 1 : 0;
        s[8] = p.activeGiven;
        if (s[0] == VOUCHED_UNIQUE && p.activeGiven < maxActiveVouches) {
            uint256 next = _nextVouchAt(p);
            uint256 aged = p.genesis ? 0 : uint256(p.uniqueSince) + voucherMinAge;
            s[9] = next > aged ? next : aged;
        }
    }

    // ------------------------------------------------------------- vouching

    /// msg.sender, a vouched-unique human, vouches that `who` (a passkey human) is one real person
    /// with one account. Rate-limited; withdrawable with unvouch().
    function vouch(address who) external {
        if (who == msg.sender) revert Self();
        if (levelOf(msg.sender) != VOUCHED_UNIQUE) revert NotUnique();
        Person storage me = people[msg.sender];
        if (!me.genesis && block.timestamp < uint256(me.uniqueSince) + voucherMinAge) revert TooSoon(uint256(me.uniqueSince) + voucherMinAge);
        uint256 next = _nextVouchAt(me);
        if (block.timestamp < next) revert TooSoon(next);
        if (me.activeGiven >= maxActiveVouches) revert TooManyVouches();
        if (labels.labelOf(who) != 1) revert NotPasskeyHuman(who);
        if (people[who].banned) revert IsBanned(who);
        if (vouchCredential[msg.sender][who] != bytes32(0)) revert AlreadyVouched();
        if (vouchersOf_[who].length >= MAX_VOUCHERS) revert TooManyVouches();
        (, , bytes32 cred,) = labels.humans(who);
        vouchCredential[msg.sender][who] = cred;
        vouchersOf_[who].push(msg.sender);
        me.activeGiven++;
        me.lastVouchAt = uint64(block.timestamp);
        emit Vouched(msg.sender, who, cred);
    }

    function unvouch(address who) external {
        if (vouchCredential[msg.sender][who] == bytes32(0)) revert NoVouch();
        _dropVouch(msg.sender, who);
    }

    /// Recomputes `a`'s stored unique status from its live vouches (anyone may call; the vouchee calls
    /// it once it has enough vouches). Returns the level.
    function refresh(address a) public returns (uint8 level) {
        Person storage p = people[a];
        uint256 n = validVouches(a);
        bool unique = labels.labelOf(a) == 1 && !p.banned && (p.genesis || n >= vouchesNeeded);
        if (unique && p.uniqueSince == 0) p.uniqueSince = uint64(block.timestamp);
        if (!unique && !p.genesis) p.uniqueSince = 0;
        level = levelOf(a);
        emit Refreshed(a, level, n);
    }

    // ------------------------------------------------------------- accountability

    /// A vouched-unique human says `a` is not one real person with one account (a duplicate, a bot).
    function flag(address a) external {
        if (a == msg.sender) revert Self();
        if (levelOf(msg.sender) != VOUCHED_UNIQUE) revert NotUnique();
        Person storage p = people[a];
        if (flaggedBy[a][p.flagEpoch][msg.sender]) revert AlreadyFlagged();
        flaggedBy[a][p.flagEpoch][msg.sender] = true;
        p.flags++;
        emit Flagged(a, msg.sender, p.flags);
    }

    function unflag(address a) external {
        Person storage p = people[a];
        if (!flaggedBy[a][p.flagEpoch][msg.sender]) revert NotFlagged();
        flaggedBy[a][p.flagEpoch][msg.sender] = false;
        p.flags--;
        emit Unflagged(a, msg.sender, p.flags);
    }

    // ------------------------------------------------------------- governance

    /// The bootstrap set: accounts governance knows to be distinct people (a ceremony, a meetup).
    function setGenesis(address[] calldata accounts, bool on) external onlyGovernance {
        for (uint256 i = 0; i < accounts.length; i++) {
            Person storage p = people[accounts[i]];
            p.genesis = on;
            p.uniqueSince = on ? uint64(block.timestamp) : 0;
            emit GenesisSet(accounts[i], on);
        }
    }

    /// `a` was shown to be a duplicate or a bot (evidence published, its hash here): banned, and each
    /// of its open vouchers gets a strike (banned at strikesToBan).
    function ban(address a, bytes32 evidenceHash) external onlyGovernance {
        Person storage p = people[a];
        p.banned = true;
        p.uniqueSince = 0;
        address[] storage vs = vouchersOf_[a];
        for (uint256 i = 0; i < vs.length; i++) {
            Person storage v = people[vs[i]];
            if (v.strikes < type(uint8).max) v.strikes++;
            emit Struck(vs[i], a, v.strikes);
            if (v.strikes >= strikesToBan && !v.banned) {
                v.banned = true;
                v.uniqueSince = 0;
                emit Banned(vs[i], evidenceHash);
            }
        }
        emit Banned(a, evidenceHash);
    }

    function unban(address a) external onlyGovernance {
        people[a].banned = false;
        people[a].strikes = 0;
        emit Unbanned(a);
    }

    /// Ends a flagging campaign that governance found unfounded (a new epoch: old flags no longer count).
    function clearFlags(address a) external onlyGovernance {
        Person storage p = people[a];
        p.flagEpoch++;
        p.flags = 0;
        emit FlagsCleared(a);
    }

    function setParams(uint8 needed, uint8 maxActive, uint32 cooldown, uint32 minAge, uint8 suspendAt, uint8 banAt) external onlyGovernance {
        _params(needed, maxActive, cooldown, minAge, suspendAt, banAt);
    }

    function setGovernance(address g) external onlyGovernance {
        governance = g;
        emit GovernanceChanged(g);
    }

    // ------------------------------------------------------------- internals

    function _params(uint8 needed, uint8 maxActive, uint32 cooldown, uint32 minAge, uint8 suspendAt, uint8 banAt) private {
        if (needed < 2 || needed > 16 || maxActive == 0 || maxActive > 16 || suspendAt < 2 || banAt == 0 || minAge > 365 days || cooldown > 90 days) revert BadParams();
        vouchesNeeded = needed;
        maxActiveVouches = maxActive;
        vouchCooldown = cooldown;
        voucherMinAge = minAge;
        flagsToSuspend = suspendAt;
        strikesToBan = banAt;
        emit ParamsSet(needed, maxActive, cooldown, minAge, suspendAt, banAt);
    }

    function _countsAsVoucher(address v) private view returns (bool) {
        Person storage p = people[v];
        if (p.banned || p.flags >= flagsToSuspend || labels.labelOf(v) != 1) return false;
        return p.genesis || p.uniqueSince != 0;
    }

    function _nextVouchAt(Person storage p) private view returns (uint256) {
        return p.lastVouchAt == 0 ? block.timestamp : uint256(p.lastVouchAt) + vouchCooldown;
    }

    function _dropVouch(address voucher, address who) private {
        delete vouchCredential[voucher][who];
        address[] storage vs = vouchersOf_[who];
        for (uint256 i = 0; i < vs.length; i++) {
            if (vs[i] == voucher) {
                vs[i] = vs[vs.length - 1];
                vs.pop();
                break;
            }
        }
        if (people[voucher].activeGiven > 0) people[voucher].activeGiven--;
        emit Unvouched(voucher, who);
    }
}

/// @title LabelFaucet: a testnet faucet hook that reads labels
/// @notice Pays each label its own amount (e.g. humans 10, agents 1,
///         unlabelled 0) at most once per cooldown per account, and, for
///         humans, once per cooldown per passkey too, so moving one passkey
///         across accounts does not multiply the drip. Funded by anyone.
contract LabelFaucet {
    LabelRegistry public immutable labels;
    address public governance;
    uint256 public cooldown;
    uint256[3] public amountFor; // by label: NONE, HUMAN, AGENT
    mapping(address => uint256) public lastDrip;
    mapping(bytes32 => uint256) public lastDripCredential;

    event Dripped(address indexed to, uint8 label, uint256 amount);
    event ConfigSet(uint256 cooldown, uint256[3] amountFor);

    error NotGovernance();
    error NothingForLabel(uint8 label);
    error TooSoon();
    error TransferFailed();

    constructor(LabelRegistry labels_, address governance_, uint256 cooldown_, uint256[3] memory amountFor_) {
        labels = labels_;
        governance = governance_;
        cooldown = cooldown_;
        amountFor = amountFor_;
        emit ConfigSet(cooldown_, amountFor_);
    }

    receive() external payable {}

    function setConfig(uint256 cooldown_, uint256[3] calldata amountFor_) external {
        if (msg.sender != governance) revert NotGovernance();
        cooldown = cooldown_;
        amountFor = amountFor_;
        emit ConfigSet(cooldown_, amountFor_);
    }

    function drip() external returns (uint256 amount) {
        uint8 label = labels.labelOf(msg.sender);
        amount = amountFor[label];
        if (amount == 0) revert NothingForLabel(label);
        if (lastDrip[msg.sender] != 0 && block.timestamp < lastDrip[msg.sender] + cooldown) revert TooSoon();
        lastDrip[msg.sender] = block.timestamp;
        if (label == 1) {
            (,, bytes32 cred,) = labels.humans(msg.sender);
            if (lastDripCredential[cred] != 0 && block.timestamp < lastDripCredential[cred] + cooldown) revert TooSoon();
            lastDripCredential[cred] = block.timestamp;
        }
        if (amount > address(this).balance) amount = address(this).balance;
        emit Dripped(msg.sender, label, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

/// @title LabelSwapGate: a DEX-side hook that reads labels
/// @notice A router or pool calls check(trader, amountIn) before a swap.
///         Each label has its own cap per hour on the input amount (0 = no
///         swaps for that label, type(uint256).max = no cap). The default
///         testnet setting: humans uncapped, registered agents capped (they
///         can be held to account), unlabelled accounts capped lower.
contract LabelSwapGate {
    ILabels public immutable labels;
    address public governance;
    uint256[3] public hourlyCap;
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public usedInWindow;
    mapping(address => bool) public isCaller; // routers / pools allowed to count volume

    event CapsSet(uint256[3] hourlyCap);
    event CallerSet(address caller, bool allowed);

    error NotGovernance();
    error NotCaller();
    error OverCap(uint8 label, uint256 cap);

    constructor(ILabels labels_, address governance_, uint256[3] memory hourlyCap_) {
        labels = labels_;
        governance = governance_;
        hourlyCap = hourlyCap_;
        emit CapsSet(hourlyCap_);
    }

    function setCaps(uint256[3] calldata caps) external {
        if (msg.sender != governance) revert NotGovernance();
        hourlyCap = caps;
        emit CapsSet(caps);
    }

    function setCaller(address c, bool allowed) external {
        if (msg.sender != governance) revert NotGovernance();
        isCaller[c] = allowed;
        emit CallerSet(c, allowed);
    }

    /// Counts amountIn against the trader's hourly cap for its label; reverts when over.
    function check(address trader, uint256 amountIn) external returns (uint8 label) {
        if (!isCaller[msg.sender]) revert NotCaller();
        label = labels.labelOf(trader);
        uint256 cap = hourlyCap[label];
        if (cap == type(uint256).max) return label;
        if (block.timestamp >= windowStart[trader] + 1 hours) {
            windowStart[trader] = block.timestamp;
            usedInWindow[trader] = 0;
        }
        uint256 used = usedInWindow[trader] + amountIn;
        if (used > cap) revert OverCap(label, cap);
        usedInWindow[trader] = used;
    }
}
