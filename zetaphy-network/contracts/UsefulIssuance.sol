// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A timelock (ZetaphyTimelock = OpenZeppelin TimelockController) reports its delay.
interface IMinDelay {
    function getMinDelay() external view returns (uint256);
}

/// @title UsefulIssuance: a share of new rewards goes to verified useful work
/// @notice "Security-backed issuance", testnet. It mints NOTHING: it is a RewardVault
///         recipient (`fund()`), so the share of new rewards it receives is set where every
///         other share is (RewardVault.proposeShares: governance + the vault's own 7-day delay).
///         What arrives is split into buckets, one per kind of verified work:
///           - each bucket names a sink contract (UsefulWork scan jobs, BugBounty, a future
///             model-evaluation market) and a share in basis points;
///           - a sink can only PULL (`draw`) what its bucket has accrued, and only when it pays
///             for work its own rules verified (agreement of independent workers, a runner
///             quorum on a bug). Nothing is pushed, so unverified work is never paid;
///           - each bucket has a cap. What would accrue beyond it, and the share no bucket
///             takes (10,000 - sum of bps), goes to `overflow` (e.g. the PoW faucet account
///             or the validators), so rewards are not hoarded when there is little useful work.
///         Every parameter (buckets, caps, overflow, governance itself) is set by `governance`,
///         which must be a timelock whose minimum delay is at least MIN_DELAY: changes are
///         public before they apply. There is no withdraw and no mint.
contract UsefulIssuance {
    uint256 public constant MIN_DELAY = 2 days;
    uint256 public constant MAX_BUCKETS = 6;

    struct Bucket {
        address sink;    // the market that pays verified work (calls draw)
        uint16 bps;      // share of each arrival, out of 10,000
        uint128 cap;     // most this bucket may hold unspent; the rest goes to overflow
        uint128 accrued; // received and not yet drawn
    }

    address public governance;
    address public overflow;
    uint256 public pendingOverflow;
    Bucket[] private _buckets;

    event Funded(address indexed from, uint256 amount);
    event Drawn(address indexed sink, uint256 amount);
    event OverflowPaid(address indexed to, uint256 amount, bool ok);
    event BucketsSet(uint256 count);
    event OverflowSet(address overflow);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotSink();
    error BadBuckets();
    error NotTimelock();
    error ZeroAddress();

    constructor(address governance_, address overflow_) {
        _checkTimelock(governance_);
        if (overflow_ == address(0)) revert ZeroAddress();
        governance = governance_;
        overflow = overflow_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ---------------------------------------------------------------- money in

    /// RewardVault pays here (Share.callFund = true); anyone may add more.
    function fund() public payable {
        uint256 amount = msg.value;
        if (amount == 0) return;
        uint256 left = amount;
        for (uint256 i = 0; i < _buckets.length; i++) {
            Bucket storage b = _buckets[i];
            uint256 part = (amount * b.bps) / 10_000;
            left -= part;
            uint256 room = b.cap > b.accrued ? b.cap - b.accrued : 0;
            uint256 keep = part < room ? part : room;
            b.accrued += uint128(keep);
            pendingOverflow += part - keep;
        }
        pendingOverflow += left;
        emit Funded(msg.sender, amount);
    }

    receive() external payable {
        fund();
    }

    // ---------------------------------------------------------------- money out

    /// A sink takes up to `amount` of its bucket to pay work it verified. Returns what it got.
    function draw(uint256 amount) external returns (uint256 paid) {
        uint256 i = _indexOf(msg.sender);
        Bucket storage b = _buckets[i];
        paid = amount < b.accrued ? amount : b.accrued;
        if (paid == 0) return 0;
        b.accrued -= uint128(paid);
        emit Drawn(msg.sender, paid);
        (bool ok, ) = msg.sender.call{value: paid}("");
        if (!ok) revert NotSink(); // a sink that cannot receive is misconfigured: undo
    }

    /// What a sink could draw now.
    function available(address sink) external view returns (uint256) {
        for (uint256 i = 0; i < _buckets.length; i++) if (_buckets[i].sink == sink) return _buckets[i].accrued;
        return 0;
    }

    /// Anyone: pays the overflow out. A recipient that refuses keeps nothing (it stays pending).
    function sweepOverflow() external returns (uint256 amount) {
        amount = pendingOverflow;
        if (amount == 0) return 0;
        pendingOverflow = 0;
        (bool ok, ) = overflow.call{value: amount}("");
        if (!ok) pendingOverflow = amount;
        emit OverflowPaid(overflow, ok ? amount : 0, ok);
    }

    // ---------------------------------------------------------------- governance (timelocked)

    function buckets() external view returns (Bucket[] memory) {
        return _buckets;
    }

    /// Replaces the bucket list. Unspent money of a sink that stays keeps its balance (capped
    /// by the new cap, the excess to overflow); a removed sink's unspent money goes to overflow.
    function setBuckets(Bucket[] calldata next) external onlyGovernance {
        if (next.length > MAX_BUCKETS) revert BadBuckets();
        uint256 total;
        for (uint256 i = 0; i < next.length; i++) {
            if (next[i].sink == address(0) || next[i].bps == 0) revert BadBuckets();
            for (uint256 k = 0; k < i; k++) if (next[k].sink == next[i].sink) revert BadBuckets();
            total += next[i].bps;
        }
        if (total > 10_000) revert BadBuckets();
        uint256 free;
        uint128[] memory carry = new uint128[](next.length);
        for (uint256 i = 0; i < _buckets.length; i++) {
            Bucket memory old = _buckets[i];
            bool kept;
            for (uint256 k = 0; k < next.length; k++) {
                if (next[k].sink == old.sink) {
                    uint128 c = old.accrued < next[k].cap ? old.accrued : next[k].cap;
                    carry[k] = c;
                    free += old.accrued - c;
                    kept = true;
                }
            }
            if (!kept) free += old.accrued;
        }
        delete _buckets;
        for (uint256 i = 0; i < next.length; i++) {
            _buckets.push(Bucket(next[i].sink, next[i].bps, next[i].cap, carry[i]));
        }
        pendingOverflow += free;
        emit BucketsSet(next.length);
    }

    function setOverflow(address next) external onlyGovernance {
        if (next == address(0)) revert ZeroAddress();
        overflow = next;
        emit OverflowSet(next);
    }

    /// The next governance must also be a timelock with at least MIN_DELAY.
    function setGovernance(address next) external onlyGovernance {
        _checkTimelock(next);
        governance = next;
        emit GovernanceChanged(next);
    }

    // ---------------------------------------------------------------- internals

    function _indexOf(address sink) internal view returns (uint256) {
        for (uint256 i = 0; i < _buckets.length; i++) if (_buckets[i].sink == sink) return i;
        revert NotSink();
    }

    function _checkTimelock(address t) internal view {
        if (t.code.length == 0) revert NotTimelock();
        try IMinDelay(t).getMinDelay() returns (uint256 d) {
            if (d < MIN_DELAY) revert NotTimelock();
        } catch {
            revert NotTimelock();
        }
    }
}
