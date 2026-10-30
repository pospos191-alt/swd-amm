// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFundable {
    function fund() external payable;
}

/// @title RewardVault: releases the ZETAPHY reward pool at 10% a year
/// @notice The 500,000,000 ZETAPHY set aside for runners and validators sit
///         here instead of in a key-holder's account. Every day, anyone can
///         call `release()`, which pays out the share of the remaining pool
///         that has vested: 10% of what is left per year, in daily steps
///         (0.9^(1/365) is kept each day), so the pool lasts for decades.
///
///         There is NO withdraw function. Governance can only choose who
///         receives the releases (e.g. NeuroJobs' reward pool, a validator
///         rewards contract), and a change only takes effect DELAY after it
///         is announced, so everyone can see it coming. Nobody can make the
///         vault pay faster than the schedule.
///
///         Money vests from when it arrives (RV-1): the vault keeps the balance
///         that has been vesting since the last checkpoint (`_vesting`) and what
///         has vested but is not paid yet (`_due`). Every deposit through
///         `receive()` and every release first moves what vested since the last
///         checkpoint into `_due`, then counts the new balance as vesting from
///         today. Coins that arrive without `receive()` (selfdestruct) start
///         vesting at the next checkpoint. Fund the vault with a call that
///         forwards gas (receive() does a checkpoint), not a 2300-gas transfer.
contract RewardVault {
    uint256 private constant RAY = 1e27;
    /// 0.9^(1/365) in RAY: keep^365 = 0.9 (to 1e-25)
    uint256 public constant DAILY_KEEP = 999711382710977687364396358;
    uint256 public constant DELAY = 7 days;
    uint256 public constant MAX_SHARES = 8;

    struct Share {
        address to;
        uint16 bps;      // out of 10,000
        bool callFund;   // pay through `fund()` (NeuroJobs, ComputeMarket) instead of a plain transfer
    }

    uint64 public immutable start;
    uint64 public releasedDays;
    address public governance;
    Share[] private _shares;
    Share[] private _pending;
    uint64 public pendingAt; // 0 = nothing pending
    uint256 private _vesting; // balance vesting since day `releasedDays` (excludes _due)
    uint256 private _due;     // vested, not paid out yet
    bool private _paying;     // inside release(): recipients are being called

    event Released(uint256 day, uint256 amount);
    event Paid(address indexed to, uint256 amount, bool ok);
    event SharesProposed(uint64 effectiveAt);
    event SharesApplied();
    event GovernanceChanged(address governance);

    error NotGovernance();
    error BadShares();
    error TooEarly();

    constructor(address governance_, Share[] memory shares_) {
        governance = governance_;
        start = uint64(block.timestamp);
        _check(shares_);
        for (uint256 i = 0; i < shares_.length; i++) _shares.push(shares_[i]);
    }

    /// Deposits start vesting today, not at the last release (RV-1).
    receive() external payable {
        if (!_paying) _checkpoint();
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ---- schedule ----

    function daysElapsed() public view returns (uint256) {
        return (block.timestamp - start) / 1 days;
    }

    /// What `release()` would pay right now.
    function releasable() public view returns (uint256) {
        if (_paying) return 0;
        uint256 n = daysElapsed() - releasedDays;
        return _due + (n == 0 ? 0 : _vested(_vesting, n));
    }

    /// Pays out everything vested since the last release. Anyone may call it.
    function release() public returns (uint256 amount) {
        if (_paying) return 0; // a recipient re-entering: nothing more
        _checkpoint();         // before any external call
        amount = _due;
        if (amount == 0) return 0;
        _due = 0;
        _paying = true;
        emit Released(releasedDays, amount);
        uint256 left = amount;
        for (uint256 i = 0; i < _shares.length; i++) {
            Share memory s = _shares[i];
            uint256 part = i + 1 == _shares.length ? left : (amount * s.bps) / 10_000;
            left -= part;
            bool ok;
            if (s.callFund) {
                (ok, ) = s.to.call{value: part}(abi.encodeCall(IFundable.fund, ()));
            } else {
                (ok, ) = s.to.call{value: part}("");
            }
            // A recipient that refuses keeps nothing: the amount stays in the
            // vault (and keeps vesting); a broken recipient cannot block others.
            emit Paid(s.to, ok ? part : 0, ok);
        }
        _paying = false;
        // what a recipient refused (or sent back) is still here: it vests again from today
        _vesting = address(this).balance;
    }

    // ---- recipients ----

    function shares() external view returns (Share[] memory) {
        return _shares;
    }

    function pendingShares() external view returns (Share[] memory) {
        return _pending;
    }

    /// Announces new recipients; they apply DELAY later.
    function proposeShares(Share[] calldata next) external onlyGovernance {
        _check(next);
        delete _pending;
        for (uint256 i = 0; i < next.length; i++) _pending.push(next[i]);
        pendingAt = uint64(block.timestamp + DELAY);
        emit SharesProposed(pendingAt);
    }

    function cancelShares() external onlyGovernance {
        delete _pending;
        pendingAt = 0;
    }

    /// After the delay, anyone may switch to the announced recipients.
    /// What vested before the switch is paid to the old ones first.
    function applyShares() external {
        // not from inside release() (a recipient): the list being paid never changes under it
        if (_paying || pendingAt == 0 || block.timestamp < pendingAt) revert TooEarly();
        // Take the pending list first: a recipient called during release()
        // must not be able to apply it a second time.
        Share[] memory next = _pending;
        delete _pending;
        pendingAt = 0;
        release();
        delete _shares;
        for (uint256 i = 0; i < next.length; i++) _shares.push(next[i]);
        emit SharesApplied();
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
        emit GovernanceChanged(next);
    }

    // ---- internals ----

    function _vested(uint256 bal, uint256 n) private pure returns (uint256) {
        return bal - (bal * _rpow(DAILY_KEEP, n)) / RAY;
    }

    /// Moves what vested since the last checkpoint into _due; everything else held (including money that
    /// just arrived) vests from today.
    function _checkpoint() private {
        uint256 today = daysElapsed();
        uint256 n = today - releasedDays;
        if (n != 0) {
            _due += _vested(_vesting, n);
            releasedDays = uint64(today);
        }
        _vesting = address(this).balance - _due;
    }

    function _check(Share[] memory s) private pure {
        if (s.length == 0 || s.length > MAX_SHARES) revert BadShares();
        uint256 total;
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i].to == address(0) || s[i].bps == 0) revert BadShares();
            total += s[i].bps;
        }
        if (total != 10_000) revert BadShares();
    }

    /// x^n in RAY fixed point (exponentiation by squaring, rounding half up).
    function _rpow(uint256 x, uint256 n) private pure returns (uint256 z) {
        z = n % 2 != 0 ? x : RAY;
        for (n /= 2; n != 0; n /= 2) {
            x = (x * x + RAY / 2) / RAY;
            if (n % 2 != 0) z = (z * x + RAY / 2) / RAY;
        }
    }
}
