// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BZTPHY: ZETAPHY testnet reward points
/// @notice People who run ZETAPHY validators and Neuro runners on the testnet earn BZTPHY.
///         When mainnet launches, BZTPHY balances at the freeze become ZETAPHY at mainnet genesis
///         (a share of a fixed pool; see zetaphy-chain/rewards/README.md).
///         BZTPHY cannot be transferred, approved or sold: it shows who did the work, not who bought it.
///         Wallets still show the balance (balanceOf, totalSupply, name, symbol, decimals, Transfer events).
contract ZetaphyPoints {
    string public constant name = "ZETAPHY Testnet Reward Points";
    string public constant symbol = "BZTPHY";
    uint8 public constant decimals = 18;

    address public owner;          // governance: sets the minter, the cap, revokes, freezes
    address public pendingOwner;
    address public minter;         // the daily award job
    uint256 public epochCap;       // most BZTPHY one epoch (UTC day) may award in total
    bool public frozen;            // after the freeze nothing changes: the balances are the snapshot

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(uint32 => uint256) public awardedInEpoch;
    mapping(uint32 => mapping(address => bool)) public awarded;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Awarded(uint32 indexed epoch, address indexed to, uint256 amount, bytes32 reason);
    event Revoked(address indexed from, uint256 amount, bytes32 reason);
    event MinterSet(address minter);
    event EpochCapSet(uint256 cap);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Frozen(uint256 totalSupply);

    error NotOwner();
    error NotMinter();
    error IsFrozen();
    error NonTransferable();
    error LengthMismatch();
    error AlreadyAwarded(uint32 epoch, address to);
    error OverEpochCap(uint32 epoch);
    error ZeroAddress();

    constructor(address owner_, address minter_, uint256 epochCap_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        minter = minter_;
        epochCap = epochCap_;
        emit OwnershipTransferred(address(0), owner_);
        emit MinterSet(minter_);
        emit EpochCapSet(epochCap_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier notFrozen() {
        if (frozen) revert IsFrozen();
        _;
    }

    /// @notice Awards one epoch's points. Each address gets at most one award per epoch, so a
    ///         job that runs twice cannot pay twice, and an epoch never exceeds epochCap (a stolen
    ///         minter key can mint at most one cap per day, and the owner can revoke it).
    function award(uint32 epoch, address[] calldata to, uint256[] calldata amounts, bytes32 reason) external notFrozen {
        if (msg.sender != minter) revert NotMinter();
        if (to.length != amounts.length) revert LengthMismatch();
        uint256 before = awardedInEpoch[epoch];
        uint256 total = before;
        for (uint256 i = 0; i < to.length; i++) {
            address a = to[i];
            if (a == address(0)) revert ZeroAddress();
            if (awarded[epoch][a]) revert AlreadyAwarded(epoch, a);
            awarded[epoch][a] = true;
            total += amounts[i];
            balanceOf[a] += amounts[i];
            emit Transfer(address(0), a, amounts[i]);
            emit Awarded(epoch, a, amounts[i], reason);
        }
        if (total > epochCap) revert OverEpochCap(epoch);
        awardedInEpoch[epoch] = total;
        totalSupply += total - before;
    }

    /// @notice Takes points back (cheating, e.g. one person running many fake validators).
    function revoke(address from, uint256 amount, bytes32 reason) external onlyOwner notFrozen {
        uint256 b = balanceOf[from];
        if (amount > b) amount = b;
        balanceOf[from] = b - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
        emit Revoked(from, amount, reason);
    }

    function setMinter(address m) external onlyOwner notFrozen {
        minter = m;
        emit MinterSet(m);
    }

    function setEpochCap(uint256 cap) external onlyOwner notFrozen {
        epochCap = cap;
        emit EpochCapSet(cap);
    }

    /// @notice Ends the program for good: the balances now are what mainnet genesis uses.
    function freeze() external onlyOwner notFrozen {
        frozen = true;
        minter = address(0);
        emit Frozen(totalSupply);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---- ERC-20 surface that refuses to move points --------------------------------------
    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }
}
