// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The chain's security precompile (0x…0901, zetaphy-chain evmd/zetaphy_secprecompile.go).
interface IZetaphySecurity {
    function qday() external view returns (uint64 height, uint64 revealDelay, bool active);
    function migration(address account) external view
        returns (bool migrated, address controller, address pendingController, uint64 finalHeight, bool exposed);
}

interface IRescueERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title QuantumRescue: a pre-commitment today, a post-quantum rescue after Q-day (testnet)
/// @notice The chain's own Q-day rule (docs/SECURITY-CORE.md) freezes every secp256k1 account that is
///         neither quantum-locked nor "never used" once Q-day passes: a quantum computer could forge
///         its signatures, so the chain stops accepting them. This contract gives such accounts a way
///         out that they prepare TODAY, while their ECDSA key is still trustworthy:
///
///           1. today      commit(c) from the classical address, c = commitmentOf(address, keccak256(pqPublicKey), secret)
///                         (only a hash: nothing about the ML-DSA key or the secret is public)
///           2. after QDAY reveal(address, pqPublicKey, secret, mlDsaSignature) - anyone may relay it;
///                         the address is then "rescued" to the ML-DSA-44 account of that key
///                         (sha256("zetaphy/mldsa44\0" ‖ pk)[0:20], the chain's native PQ address)
///
///         A commitment only counts once it is `maturity` blocks old, and only if it matured before
///         Q-day: someone who breaks the key shortly before Q-day cannot displace an older commitment.
///         Q-day is the chain's (governance-set, read from 0x…0901 qday()), or this contract's own
///         governance-set height if that is earlier or the precompile does not exist (another EVM chain).
///
///         What a rescue gives today, on-chain:
///           - controllerOf(address): any contract can honour it (QDayGuard pattern, see classicalTrusted());
///           - an escrow: protocol payouts to a frozen address (airdrops, bridge releases, refunds) are
///             sent here with depositFor() and the rescued ML-DSA controller claims them;
///         and, as a governance-voted chain step (designed, docs/future/quantum-safe-settlement.md),
///         MsgQDayRescue turns a rescue into the chain's quantum lock (the whole account, its 0x address).
contract QuantumRescue {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint256 public constant PK_BYTES = 1312;   // ML-DSA-44 (native PQ accounts are ML-DSA-44)
    uint64 public constant MIN_NOTICE = 100;   // blocks, like gov.sh qday (QDAY_MIN_NOTICE)

    address public immutable security;         // 0x…0901 on ZETAPHY; anything without code elsewhere
    uint64 public immutable maturity;          // blocks before a (new) commitment counts
    address public governance;                 // a timelock
    uint64 public localQday;                   // 0 = none; the earlier of this and the chain's Q-day applies

    struct Slot {
        bytes32 active;    // the commitment in force
        bytes32 pending;   // a newer one (or 0 = cancel), in force from pendingAt + maturity
        uint64 pendingAt;  // 0 = no pending change
    }
    mapping(address => Slot) private slots;
    mapping(address => address) public controllerOf;   // rescued classical address -> ML-DSA-44 account
    mapping(address => bytes32) public rescueKeyHash;  // keccak256 of the revealed ML-DSA public key
    mapping(address => mapping(address => uint256)) public escrow; // classical => token (0 = native) => amount
    uint256 private locked = 1;

    event Committed(address indexed account, bytes32 commitment, uint64 countsFrom);
    event Rescued(address indexed account, address indexed controller, bytes32 keyHash);
    event Deposited(address indexed account, address indexed token, address indexed from, uint256 amount);
    event Claimed(address indexed account, address indexed token, address to, uint256 amount);
    event LocalQdaySet(uint64 height);
    event GovernanceSet(address governance);

    error QdayPassed();
    error QdayNotYet();
    error AlreadyRescued();
    error NoCommitment();
    error WrongReveal();
    error BadKey();
    error BadSignature();
    error NotAllowed();
    error OnlyGovernance();
    error TooSoon();
    error Insufficient();
    error TransferFailed();
    error Reentrant();
    error BadParams();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address security_, address governance_, uint64 maturity_) {
        if (governance_ == address(0) || maturity_ == 0) revert BadParams();
        security = security_;
        governance = governance_;
        maturity = maturity_;
    }

    // ------------------------------------------------------------------ Q-day

    /// The Q-day height in force: the earlier non-zero one of the chain's and this contract's (0 = none).
    function qdayHeight() public view returns (uint64 h) {
        h = localQday;
        if (security != address(0)) {
            // a precompile has no code; an address with neither code nor precompile answers empty
            (bool ok, bytes memory ret) = security.staticcall(abi.encodeWithSelector(IZetaphySecurity.qday.selector));
            if (ok && ret.length >= 96) {
                (uint64 chainH,,) = abi.decode(ret, (uint64, uint64, bool));
                if (chainH != 0 && (h == 0 || chainH < h)) h = chainH;
            }
        }
    }

    function qdayReached() public view returns (bool) {
        uint64 h = qdayHeight();
        return h != 0 && block.number >= h;
    }

    /// Contract-level Q-day for this contract (e.g. on a chain without the chain rule): at least
    /// MIN_NOTICE blocks ahead, or 0 to remove it. The chain's own Q-day still applies if earlier.
    function setLocalQday(uint64 h) external {
        if (msg.sender != governance) revert OnlyGovernance();
        if (h != 0 && h < block.number + MIN_NOTICE) revert TooSoon();
        localQday = h;
        emit LocalQdaySet(h);
    }

    function setGovernance(address g) external {
        if (msg.sender != governance) revert OnlyGovernance();
        if (g == address(0)) revert BadParams();
        governance = g;
        emit GovernanceSet(g);
    }

    /// QDayGuard: may a contract still trust `account`'s own (ECDSA) authority, i.e. msg.sender == account?
    /// Before Q-day yes. After it only if the chain says the account is quantum-locked / migrated (then the
    /// call can only come from its ML-DSA-44 controller through MsgEVMCall as_owner) - on any other chain no.
    function classicalTrusted(address account) public view returns (bool) {
        if (!qdayReached()) return true;
        return _chainMigrated(account);
    }

    function _chainMigrated(address account) private view returns (bool) {
        if (security == address(0)) return false;
        (bool ok, bytes memory ret) = security.staticcall(abi.encodeWithSelector(IZetaphySecurity.migration.selector, account));
        if (!ok || ret.length < 160) return false;
        (bool migrated,,,,) = abi.decode(ret, (bool, address, address, uint64, bool));
        return migrated;
    }

    // ------------------------------------------------------------------ commit (before Q-day)

    /// The commitment for `account`: hides the ML-DSA key and the secret until the reveal.
    function commitmentOf(address account, bytes32 pqKeyHash, bytes32 secret) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY QuantumRescue v1", block.chainid, address(this), account, pqKeyHash, secret));
    }

    /// Record (or replace, or with 0 cancel) the caller's commitment. A change counts `maturity` blocks later;
    /// until then the previous commitment stays in force.
    function commit(bytes32 c) external {
        if (qdayReached()) revert QdayPassed();
        if (controllerOf[msg.sender] != address(0)) revert AlreadyRescued();
        Slot storage s = slots[msg.sender];
        _promote(s);
        s.pending = c;
        s.pendingAt = uint64(block.number);
        emit Committed(msg.sender, c, uint64(block.number) + maturity);
    }

    function _promote(Slot storage s) private {
        if (s.pendingAt != 0 && block.number >= uint256(s.pendingAt) + maturity) {
            s.active = s.pending;
            s.pending = bytes32(0);
            s.pendingAt = 0;
        }
    }

    /// The commitment that counts for `account`: the newest one that matured before Q-day (or before now).
    function effectiveCommitment(address account) public view returns (bytes32) {
        Slot storage s = slots[account];
        uint256 bound = block.number;
        if (qdayReached()) bound = qdayHeight();
        if (s.pendingAt != 0 && uint256(s.pendingAt) + maturity <= bound) return s.pending;
        return s.active;
    }

    /// (active, pending, pendingAt) for wallets and the hub.
    function slotOf(address account) external view returns (bytes32, bytes32, uint64) {
        Slot storage s = slots[account];
        return (s.active, s.pending, s.pendingAt);
    }

    // ------------------------------------------------------------------ reveal (after Q-day)

    /// The chain's native ML-DSA-44 account of a public key.
    function pqAddress(bytes calldata pk) public pure returns (address) {
        return address(bytes20(sha256(abi.encodePacked("zetaphy/mldsa44\x00", pk))));
    }

    /// What the ML-DSA key signs to rescue `account` (when it does not send the reveal itself).
    function rescueDigest(address account, address controller) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY QuantumRescue reveal", block.chainid, address(this), account, controller));
    }

    /// After Q-day: prove the commitment and that the ML-DSA key is held (a signature, or the native PQ
    /// account sends this itself through MsgEVMCall). Anyone may relay: the controller follows from the key.
    function reveal(address account, bytes calldata pk, bytes32 secret, bytes calldata sig) external {
        if (!qdayReached()) revert QdayNotYet();
        if (controllerOf[account] != address(0)) revert AlreadyRescued();
        if (pk.length != PK_BYTES) revert BadKey();
        bytes32 c = effectiveCommitment(account);
        if (c == bytes32(0)) revert NoCommitment();
        bytes32 kh = keccak256(pk);
        if (c != commitmentOf(account, kh, secret)) revert WrongReveal();
        address ctrl = pqAddress(pk);
        if (msg.sender != ctrl && !_pqValid(rescueDigest(account, ctrl), pk, sig)) revert BadSignature();
        controllerOf[account] = ctrl;
        rescueKeyHash[account] = kh;
        delete slots[account];
        emit Rescued(account, ctrl, kh);
    }

    function _pqValid(bytes32 d, bytes calldata pk, bytes calldata sig) private view returns (bool) {
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(uint8(44), d, pk, sig));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    // ------------------------------------------------------------------ escrow for frozen / rescued accounts

    /// Pay native ZETAPHY to `account` through the rescue escrow (e.g. a payout after Q-day to a frozen address).
    function depositFor(address account) external payable {
        if (account == address(0) || msg.value == 0) revert BadParams();
        escrow[account][address(0)] += msg.value;
        emit Deposited(account, address(0), msg.sender, msg.value);
    }

    /// Pay an ERC-20 to `account` through the escrow (counts what actually arrived).
    function depositTokenFor(address token, address account, uint256 amount) external nonReentrant {
        if (account == address(0) || amount == 0 || token.code.length == 0) revert BadParams();
        uint256 before = IRescueERC20(token).balanceOf(address(this));
        _call(token, abi.encodeWithSelector(IRescueERC20.transferFrom.selector, msg.sender, address(this), amount));
        uint256 got = IRescueERC20(token).balanceOf(address(this)) - before;
        escrow[account][token] += got;
        emit Deposited(account, token, msg.sender, got);
    }

    /// Take escrowed funds out: the rescued ML-DSA controller, or the account itself while its key is still
    /// trusted (before Q-day, or after it when the chain says it is quantum-locked).
    function claim(address account, address token, uint256 amount, address to) external nonReentrant {
        address ctrl = controllerOf[account];
        bool ok = (ctrl != address(0) && msg.sender == ctrl) || (msg.sender == account && classicalTrusted(account));
        if (!ok) revert NotAllowed();
        if (to == address(0)) revert BadParams();
        uint256 bal = escrow[account][token];
        if (amount > bal) revert Insufficient();
        escrow[account][token] = bal - amount;
        emit Claimed(account, token, to, amount);
        if (token == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(IRescueERC20.transfer.selector, to, amount));
        }
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
