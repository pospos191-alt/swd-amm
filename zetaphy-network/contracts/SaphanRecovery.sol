// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRecoveryToken {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title SaphanRecoveryClaims: pay back what an incident owed, from a Merkle root of owed balances
/// @notice Saphan PR 6, item S10 (docs/SAPHAN-PR6.md). Testnet only, not audited.
///
///         The guided recovery after an incident (`node scripts/saphan.js recovery ...`):
///           1. pause      guardians pause the route (lockbox, guard), as today;
///           2. snapshot   who is owed what, rebuilt by anyone from public events (src/saphanrecovery.js: balances of
///                         token(X) at the incident block, releases queued and not paid, locks never minted, minus
///                         what the attacker took if governance decides so). The SAME leaf and tree as the lockbox's
///                         escape hatch (src/saphansafety.js exitTree): leaf = keccak256(keccak256(abi.encode(account,
///                         owed))), sorted-pair Merkle tree;
///           3. claims     governance (the ZetaphyTimelock: its delay gives everyone time to check the root against
///                         their own rebuild) deploys this contract and calls start(root, total) once; anyone funds it
///                         (insurance, treasury, recovered funds); each account claims its line once, in full when the
///                         pool covers the total, else pro rata; after `claimPeriod`, sweep() sends what is left to
///                         `sweepTo` (e.g. the HackInsurance pool);
///           4. resume     governance unpauses the route (the CLI checks that the root was set and lists the calls).
///
///         The pool is fixed at start(): coins that arrive later are swept, so the order of claims never changes
///         anyone's share. Pull payment to the caller only; nonReentrant; no admin besides the one start() call.
contract SaphanRecoveryClaims {
    address public immutable governance;   // ZetaphyTimelock
    address public immutable token;        // address(0): the native coin
    address public immutable sweepTo;
    uint64 public immutable claimPeriod;

    bytes32 public root;
    uint256 public total;                  // the sum the root owes
    uint256 public pool;                   // what this contract held at start()
    uint256 public paid;
    uint64 public deadline;
    bool public swept;
    mapping(address => bool) public claimed;
    uint256 private unlocked = 1;

    event Funded(address indexed from, uint256 amount);
    event Started(bytes32 root, uint256 total, uint256 pool, uint64 deadline);
    event Claimed(address indexed account, uint256 owed, uint256 paid);
    event Swept(address to, uint256 amount);

    error NotGovernance();
    error AlreadyStarted();
    error NotStarted();
    error BadRoot();
    error AlreadyClaimed();
    error BadProof();
    error Closed();
    error StillOpen(uint64 deadline);
    error PayFailed();
    error Reentrancy();
    error WrongAsset();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address governance_, address token_, address sweepTo_, uint64 claimPeriod_) {
        require(governance_ != address(0) && sweepTo_ != address(0) && claimPeriod_ >= 7 days, "config");
        governance = governance_;
        token = token_;
        sweepTo = sweepTo_;
        claimPeriod = claimPeriod_;
    }

    receive() external payable {
        if (token != address(0)) revert WrongAsset();
        emit Funded(msg.sender, msg.value);
    }

    /// Funds a token pool (approve first).
    function fund(uint256 amount) external nonReentrant {
        if (token == address(0)) revert WrongAsset();
        emit Funded(msg.sender, amount);
        if (!IRecoveryToken(token).transferFrom(msg.sender, address(this), amount)) revert PayFailed();
    }

    /// Governance, once: the root of what is owed and its total. The pool is what this contract holds now.
    function start(bytes32 root_, uint256 total_) external {
        if (msg.sender != governance) revert NotGovernance();
        if (root != bytes32(0)) revert AlreadyStarted();
        if (root_ == bytes32(0) || total_ == 0) revert BadRoot();
        root = root_;
        total = total_;
        pool = _held();
        deadline = uint64(block.timestamp) + claimPeriod;
        emit Started(root_, total_, pool, deadline);
    }

    /// What `owed` pays now: in full when the pool covers the total, else owed x pool / total.
    function payout(uint256 owed) public view returns (uint256) {
        return total <= pool ? owed : owed * pool / total;
    }

    /// The caller's line of the root, once, before the deadline.
    function claim(uint256 owed, bytes32[] calldata proof) external nonReentrant {
        if (root == bytes32(0)) revert NotStarted();
        if (block.timestamp > deadline || swept) revert Closed();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        bytes32 node = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, owed))));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encode(node, p)) : keccak256(abi.encode(p, node));
        }
        if (node != root) revert BadProof();
        claimed[msg.sender] = true;
        uint256 amount = payout(owed);
        paid += amount;
        emit Claimed(msg.sender, owed, amount);
        _pay(msg.sender, amount);
    }

    /// Anyone, after the deadline: what is left goes to sweepTo. Once.
    function sweep() external nonReentrant {
        if (root == bytes32(0)) revert NotStarted();
        if (block.timestamp <= deadline) revert StillOpen(deadline);
        if (swept) revert Closed();
        swept = true;
        uint256 left = _held();
        emit Swept(sweepTo, left);
        _pay(sweepTo, left);
    }

    function _held() private view returns (uint256) {
        return token == address(0) ? address(this).balance : IRecoveryToken(token).balanceOf(address(this));
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert PayFailed();
        } else if (!IRecoveryToken(token).transfer(to, amount)) revert PayFailed();
    }
}
