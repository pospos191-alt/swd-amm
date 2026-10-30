// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZetaphyOfflineCash: bonded bearer notes passed hand to hand with no internet (testnet, not audited)
/// @notice Design and threat model: docs/future/offline-cash.md.
///
///  Notes. An issuer locks native ZETAPHY as notes (any denominations, `issue`) until `lockUntil`: before
///  then nobody but a holder can take a note's value out (the issuer cannot reclaim early). The issuer also
///  keeps an issuer bond of at least 150% of its outstanding notes, locked until every note's claim window
///  is over (bondIssuer); it pays the victims of the issuer's own double-spends.
///
///  Holding and passing on. Every holder is an ML-DSA-44 key (keccak256 of the 1312-byte public key). The
///  first holder is the issuer's key; a holder passes the note on by signing a Link (noteId, seq, prev, to,
///  cond) with its key, offline: `prev` is the hash of the previous link (or the note's root), `to` the next
///  holder's key. The note travels as its chain of links; the payee checks it with no network.
///
///  Cashing. Any holder signs a Terminal (prev, payout, fee): "pay this note to `payout`, `fee` to whoever
///  submits it". redeem(noteId, links, terminal) can be sent by anyone (a relayer earns the fee):
///   - the note is still live: the earliest valid chain to reach the chain wins; the note's value is paid;
///   - the note was already paid through another chain: the two chains split at some link: its holder
///     signed two different spends of the same `prev` (a double-spend). This chain's holder is the victim
///     and is paid the note's value from the cheater's bond: the ISSUER bond when the issuer double-spent
///     (split at seq 0), else the HOLDER bond of the key that split it (bondHolder). The victim bears what
///     the bond cannot cover (no bond, or bond already spent on other victims): payees check the bonds
///     of every key in the chain (the hub shows the covered amount). Claims are accepted until
///     lockUntil + CLAIM_WINDOW.
///  Every message spent is recorded (spentBy[prev] = the spending message), so a second claim, a replay,
///  or an old chain is refused, and further splits down a paid victim branch are still traced to whoever
///  split them.
///
///  Atomic swap ticket. Two holders swap two notes offline: a ticket fixes both legs (note, seq, prev, to,
///  payout) and a deadline; each holder signs its leg as a Link whose `cond` is the ticket id. A conditional
///  link only counts through settleSwap, which pays BOTH notes (A to its new holder's payout, B to its) in
///  one transaction, or neither. Until it is settled a ticket is only an offer: its legs are not spends.
///
///  ML-DSA-44 checks use ZETAPHY's precompile at 0x…0900 (FIPS 204, pure, empty context) over 32-byte
///  digests. Native coin only. No owner, no fee, no upgrade. Checks-effects-interactions, nonReentrant.
contract ZetaphyOfflineCash {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint8 public constant VARIANT = 44;
    uint256 public constant PK_BYTES = 1312;
    uint256 public constant BOND_BPS = 15_000;            // issuer bond >= 150% of outstanding notes
    uint256 public constant CLAIM_WINDOW = 30 days;       // fraud claims until lockUntil + CLAIM_WINDOW
    uint256 public constant MIN_LOCK = 1 days;
    uint256 public constant MAX_LOCK = 366 days;
    uint256 public constant MAX_NOTES_PER_ISSUE = 64;
    uint256 public constant MAX_LINKS = 64;

    bytes32 public constant NOTE_TAG = keccak256("ZetaphyCash.Note(uint256 id,uint256 value,uint256 lockUntil,bytes32 issuerKey)");
    bytes32 public constant LINK_TAG = keccak256("ZetaphyCash.Link(uint256 noteId,uint256 seq,bytes32 prev,bytes32 to,bytes32 cond)");
    bytes32 public constant TERMINAL_TAG = keccak256("ZetaphyCash.Terminal(bytes32 prev,address payout,uint256 fee)");
    bytes32 public constant SWAP_TAG = keccak256(
        "ZetaphyCash.Swap(uint256 noteA,uint256 seqA,bytes32 prevA,bytes32 toA,address payoutA,uint256 noteB,uint256 seqB,bytes32 prevB,bytes32 toB,address payoutB,uint256 deadline)"
    );
    bytes32 public constant SWAP_DONE_TAG = keccak256("ZetaphyCash.SwapDone(bytes32 ticket,uint256 leg)");
    bytes32 public immutable DOMAIN;

    struct Note {
        address issuer;
        uint96 value;
        uint64 lockUntil;
        bool done;          // paid out (redeemed, swapped) or reclaimed by the issuer
        bytes32 issuerKey;  // holder 0
    }
    struct Bond {
        address owner;
        uint64 until;       // no withdrawal before this
        uint256 amount;
    }
    struct Link {
        bytes32 to;
        bytes32 cond;       // 0, or the swap ticket id this leg belongs to
        bytes pk;           // the signer's ML-DSA-44 public key (the current holder)
        bytes sig;
    }
    struct Terminal {
        address payout;
        uint96 fee;         // to msg.sender (a relayer), out of what is paid
        bytes pk;
        bytes sig;
    }
    struct Ticket {
        uint256 noteA; uint256 seqA; bytes32 prevA; bytes32 toA; address payoutA;
        uint256 noteB; uint256 seqB; bytes32 prevB; bytes32 toB; address payoutB;
        uint256 deadline;
    }

    uint256 public noteCount;
    mapping(uint256 => Note) public notes;
    mapping(address => Bond) public issuerBonds;
    mapping(bytes32 => Bond) public holderBonds;
    mapping(address => uint256) public outstanding;     // issuer => value of its notes not done
    mapping(bytes32 => bytes32) public spentBy;         // prev => the paid message that spent it
    mapping(bytes32 => bool) public forkPaid;           // a victim's first diverging message, once compensated
    mapping(bytes32 => bool) public swapSettled;
    uint256 private locked = 1;

    event IssuerBonded(address indexed issuer, uint256 amount, uint64 until, uint256 outstanding);
    event HolderBonded(bytes32 indexed key, address indexed owner, uint256 amount, uint64 until);
    event BondWithdrawn(address indexed owner, bytes32 indexed key, uint256 amount);
    event NoteIssued(uint256 indexed id, address indexed issuer, bytes32 issuerKey, uint96 value, uint64 lockUntil);
    event Redeemed(uint256 indexed id, address indexed payout, uint256 amount, uint256 fee, uint256 links, address submitter);
    event FraudPaid(uint256 indexed id, bytes32 indexed cheater, address indexed victim, uint256 seq, uint256 paid, uint256 shortfall, bool issuerBond);
    event SwapSettled(bytes32 indexed ticket, uint256 noteA, uint256 noteB, address payoutA, address payoutB);
    event Reclaimed(uint256 indexed id, address indexed issuer, uint256 amount);

    error BadValue();
    error BadLock();
    error BadBond();
    error BondTooSmall();
    error BondLocked();
    error NotBondOwner();
    error BadNote();
    error NoteDone();
    error TooManyLinks();
    error WrongKey();
    error BadSignature();
    error UnsettledSwap();
    error AlreadyPaid();
    error NothingToClaim();
    error OwnDoubleSpend();
    error ClaimWindowOver();
    error BondEmpty();
    error BadFee();
    error BadTicket();
    error Expired();
    error NotIssuer();
    error NotUnlocked();
    error SendFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor() {
        DOMAIN = keccak256(abi.encode(keccak256("ZETAPHY Offline Cash v1"), block.chainid, address(this)));
    }

    // ------------------------------------------------------------------ bonds

    /// Adds to the caller's issuer bond and/or moves its lock later (never earlier).
    function bondIssuer(uint64 until) external payable nonReentrant {
        Bond storage b = issuerBonds[msg.sender];
        if (until < b.until || until > block.timestamp + MAX_LOCK + CLAIM_WINDOW) revert BadLock();
        if (msg.value == 0 && until == b.until) revert BadValue();
        b.owner = msg.sender;
        b.until = until;
        b.amount += msg.value;
        emit IssuerBonded(msg.sender, b.amount, until, outstanding[msg.sender]);
    }

    /// A bond that answers for double-spends signed by holder key `key`. The first bonder owns it;
    /// only the owner adds to it, extends it, and withdraws it (after `until`).
    function bondHolder(bytes32 key, uint64 until) external payable nonReentrant {
        Bond storage b = holderBonds[key];
        if (key == bytes32(0)) revert BadBond();
        if (b.owner != address(0) && b.owner != msg.sender) revert NotBondOwner();
        if (until < b.until || until > block.timestamp + MAX_LOCK + CLAIM_WINDOW) revert BadLock();
        if (msg.value == 0 && until == b.until) revert BadValue();
        b.owner = msg.sender;
        b.until = until;
        b.amount += msg.value;
        emit HolderBonded(key, msg.sender, b.amount, until);
    }

    function withdrawIssuerBond() external nonReentrant {
        Bond storage b = issuerBonds[msg.sender];
        if (block.timestamp <= b.until) revert BondLocked();
        uint256 amount = b.amount;
        if (amount == 0) revert BondEmpty();
        b.amount = 0;
        emit BondWithdrawn(msg.sender, bytes32(0), amount);
        _send(msg.sender, amount);
    }

    function withdrawHolderBond(bytes32 key) external nonReentrant {
        Bond storage b = holderBonds[key];
        if (b.owner != msg.sender) revert NotBondOwner();
        if (block.timestamp <= b.until) revert BondLocked();
        uint256 amount = b.amount;
        if (amount == 0) revert BondEmpty();
        b.amount = 0;
        emit BondWithdrawn(msg.sender, key, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------ notes

    /// Locks msg.value as notes of `values` held by the issuer's ML-DSA-44 key `issuerKey` until `lockUntil`.
    /// Needs an issuer bond >= 150% of all outstanding notes, locked until lockUntil + CLAIM_WINDOW at least.
    function issue(bytes32 issuerKey, uint64 lockUntil, uint96[] calldata values) external payable nonReentrant returns (uint256 firstId) {
        uint256 n = values.length;
        if (n == 0 || n > MAX_NOTES_PER_ISSUE || issuerKey == bytes32(0)) revert BadNote();
        if (lockUntil < block.timestamp + MIN_LOCK || lockUntil > block.timestamp + MAX_LOCK) revert BadLock();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (values[i] == 0) revert BadValue();
            sum += values[i];
        }
        if (msg.value != sum) revert BadValue();
        uint256 out = outstanding[msg.sender] + sum;
        Bond storage b = issuerBonds[msg.sender];
        if (b.amount * 10_000 < out * BOND_BPS) revert BondTooSmall();
        if (b.until < uint256(lockUntil) + CLAIM_WINDOW) revert BondLocked();
        outstanding[msg.sender] = out;
        firstId = noteCount + 1;
        for (uint256 i; i < n; ++i) {
            uint256 id = firstId + i;
            notes[id] = Note(msg.sender, values[i], lockUntil, false, issuerKey);
            emit NoteIssued(id, msg.sender, issuerKey, values[i], lockUntil);
        }
        noteCount = firstId + n - 1;
        emit IssuerBonded(msg.sender, b.amount, b.until, out); // the bond as it now stands (for offline proofs)
    }

    /// After lockUntil, the issuer takes back notes nobody cashed.
    function reclaim(uint256[] calldata ids) external nonReentrant {
        uint256 total;
        for (uint256 i; i < ids.length; ++i) {
            Note storage nt = notes[ids[i]];
            if (nt.issuer != msg.sender) revert NotIssuer();
            if (block.timestamp <= nt.lockUntil) revert NotUnlocked();
            if (nt.done) revert NoteDone();
            nt.done = true;
            total += nt.value;
            emit Reclaimed(ids[i], msg.sender, nt.value);
        }
        outstanding[msg.sender] -= total;
        _send(msg.sender, total);
    }

    /// Cashes a note through its chain of links and the last holder's terminal: pays the note if it is live,
    /// else compensates this (victim) chain from the bond of whoever double-spent it.
    function redeem(uint256 id, Link[] calldata links, Terminal calldata t) external nonReentrant {
        Note storage nt = notes[id];
        if (nt.issuer == address(0)) revert BadNote();
        (bytes32[] memory prevs, bytes32[] memory msgs, bytes32[] memory keys) = _walk(id, nt, links, false);
        uint256 n = links.length;
        bytes32 term = terminalHash(prevs[n], t.payout, t.fee);
        _check(keys[n], term, t.pk, t.sig);
        msgs[n] = term;

        if (!nt.done) {
            for (uint256 i; i <= n; ++i) spentBy[prevs[i]] = msgs[i];
            nt.done = true;
            outstanding[nt.issuer] -= nt.value;
            _payout(id, nt.value, t, n);
            return;
        }

        // The note was paid through another chain: find where this one split from the paid history.
        if (block.timestamp > uint256(nt.lockUntil) + CLAIM_WINDOW) revert ClaimWindowOver();
        uint256 f = type(uint256).max;
        for (uint256 i; i <= n; ++i) {
            bytes32 s = spentBy[prevs[i]];
            if (s == msgs[i] || (i < n && forkPaid[msgs[i]])) continue;
            if (s == bytes32(0)) revert NothingToClaim(); // reclaimed by the issuer, or never spent this way
            f = i;
            break;
        }
        if (f == type(uint256).max) revert AlreadyPaid();
        if (f == n) revert OwnDoubleSpend(); // the claimant itself spent the note another way
        forkPaid[msgs[f]] = true;
        for (uint256 i = f + 1; i <= n; ++i) spentBy[prevs[i]] = msgs[i];

        Bond storage b = f == 0 ? issuerBonds[nt.issuer] : holderBonds[keys[f]];
        uint256 pay = b.amount < nt.value ? b.amount : nt.value;
        if (pay == 0) revert BondEmpty();
        b.amount -= pay;
        emit FraudPaid(id, keys[f], t.payout, f, pay, nt.value - pay, f == 0);
        _payout(id, pay, t, n);
    }

    /// Settles a swap ticket: both legs (the last link of each chain, signed by the holders) pay together.
    function settleSwap(Ticket calldata tk, Link[] calldata linksA, Link[] calldata linksB) external nonReentrant {
        if (block.timestamp > tk.deadline) revert Expired();
        if (tk.noteA == tk.noteB || tk.payoutA == address(0) || tk.payoutB == address(0)) revert BadTicket();
        bytes32 tid = ticketId(tk);
        if (swapSettled[tid]) revert AlreadyPaid();
        Note storage na = notes[tk.noteA];
        Note storage nb = notes[tk.noteB];
        if (na.issuer == address(0) || nb.issuer == address(0)) revert BadNote();
        if (na.done || nb.done) revert NoteDone();
        _settleLeg(tk.noteA, na, linksA, tk.seqA, tk.prevA, tk.toA, tid, 0);
        _settleLeg(tk.noteB, nb, linksB, tk.seqB, tk.prevB, tk.toB, tid, 1);
        swapSettled[tid] = true;
        na.done = true;
        nb.done = true;
        outstanding[na.issuer] -= na.value;
        outstanding[nb.issuer] -= nb.value;
        emit SwapSettled(tid, tk.noteA, tk.noteB, tk.payoutA, tk.payoutB);
        emit Redeemed(tk.noteA, tk.payoutA, na.value, 0, linksA.length, msg.sender);
        emit Redeemed(tk.noteB, tk.payoutB, nb.value, 0, linksB.length, msg.sender);
        _send(tk.payoutA, na.value);
        _send(tk.payoutB, nb.value);
    }

    function _settleLeg(uint256 id, Note storage nt, Link[] calldata links, uint256 seq, bytes32 prev, bytes32 to, bytes32 tid, uint256 leg) private {
        uint256 n = links.length;
        if (n == 0 || n - 1 != seq) revert BadTicket();
        (bytes32[] memory prevs, bytes32[] memory msgs, ) = _walk(id, nt, links, true);
        Link calldata last = links[n - 1];
        if (prevs[n - 1] != prev || last.to != to || last.cond != tid) revert BadTicket();
        for (uint256 i; i < n; ++i) spentBy[prevs[i]] = msgs[i];
        spentBy[prevs[n]] = keccak256(abi.encode(SWAP_DONE_TAG, tid, leg));
    }

    // ------------------------------------------------------------------ hashes (the hub and CLI compute the same)

    function noteRoot(uint256 id) public view returns (bytes32) {
        Note storage nt = notes[id];
        return keccak256(abi.encode(NOTE_TAG, DOMAIN, id, uint256(nt.value), uint256(nt.lockUntil), nt.issuerKey));
    }

    function linkHash(uint256 id, uint256 seq, bytes32 prev, bytes32 to, bytes32 cond) public view returns (bytes32) {
        return keccak256(abi.encode(LINK_TAG, DOMAIN, id, seq, prev, to, cond));
    }

    function terminalHash(bytes32 prev, address payout, uint256 fee) public view returns (bytes32) {
        return keccak256(abi.encode(TERMINAL_TAG, DOMAIN, prev, payout, fee));
    }

    function ticketId(Ticket calldata tk) public view returns (bytes32) {
        return keccak256(bytes.concat(abi.encode(SWAP_TAG, DOMAIN, tk.noteA, tk.seqA, tk.prevA, tk.toA, tk.payoutA),
            abi.encode(tk.noteB, tk.seqB, tk.prevB, tk.toB, tk.payoutB, tk.deadline)));
    }

    /// What the issuer bond covers now: bond, outstanding, and whether it is still >= 150%.
    function issuerCover(address issuer) external view returns (uint256 bond, uint64 until, uint256 out, bool healthy) {
        Bond storage b = issuerBonds[issuer];
        out = outstanding[issuer];
        return (b.amount, b.until, out, b.amount * 10_000 >= out * BOND_BPS);
    }

    // ------------------------------------------------------------------ internals

    /// Checks every link's signature; returns prev[i] (what message i spends), msgs[i] (link i's hash) and
    /// keys[i] (holder i; keys[0] = the issuer key), with room for the terminal at index n.
    function _walk(uint256 id, Note storage nt, Link[] calldata links, bool swapLeg)
        private view returns (bytes32[] memory prevs, bytes32[] memory msgs, bytes32[] memory keys)
    {
        uint256 n = links.length;
        if (n > MAX_LINKS) revert TooManyLinks();
        prevs = new bytes32[](n + 1);
        msgs = new bytes32[](n + 1);
        keys = new bytes32[](n + 1);
        prevs[0] = noteRoot(id);
        keys[0] = nt.issuerKey;
        for (uint256 i; i < n; ++i) {
            Link calldata l = links[i];
            if (l.to == bytes32(0)) revert WrongKey();
            if (l.cond != bytes32(0) && !(swapLeg && i == n - 1) && !swapSettled[l.cond]) revert UnsettledSwap();
            bytes32 h = linkHash(id, i, prevs[i], l.to, l.cond);
            _check(keys[i], h, l.pk, l.sig);
            msgs[i] = h;
            prevs[i + 1] = h;
            keys[i + 1] = l.to;
        }
    }

    function _check(bytes32 key, bytes32 digest, bytes calldata pk, bytes calldata sig) private view {
        if (pk.length != PK_BYTES || keccak256(pk) != key) revert WrongKey();
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(VARIANT, digest, pk, sig));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) revert BadSignature();
    }

    function _payout(uint256 id, uint256 amount, Terminal calldata t, uint256 n) private {
        if (t.payout == address(0) || t.fee > amount) revert BadFee();
        emit Redeemed(id, t.payout, amount - t.fee, t.fee, n, msg.sender);
        if (t.fee > 0) _send(msg.sender, t.fee);
        _send(t.payout, amount - t.fee);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
