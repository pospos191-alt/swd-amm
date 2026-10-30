// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The Web3 immune system's consumer side (docs/future/immune-network.md).
//
// IImmuneFeed is what every immune feed answers, on every EVM chain:
//   - ImmuneRegistry on ZETAPHY (where flags are made, by k-of-n bonded runner agreement in NeuroJobs);
//   - ImmuneMirror on every other EVM chain (written only by ZETAPHY's ImmuneBroadcaster through Hyperlane).
// A protocol on any chain adds `notFlagged(to)` (ImmuneGuard) to its router, withdrawal or bridge exit; a wallet or
// dapp calls isFlagged off-chain (zetaphy-network/src/immune/sdk.js); a circuit breaker (any chain, any vendor)
// watches the ThreatFlag event or polls isFlagged and decides for itself what to pause. The feed never pauses
// anything by itself.

/// @title IImmuneFeed: the interface every immune feed (registry or mirror) exposes
interface IImmuneFeed {
    /// A flag set (flagged = true) or lifted (cleared, expired, overturned on appeal) for (chainId, subject).
    /// chainId 0: the subject is an externally owned account flagged on EVERY EVM chain (the same key signs everywhere).
    event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    /// The same for a code hash (EXTCODEHASH): every copy of the code, on every EVM chain.
    event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);

    /// Is `subject` on the EVM chain `chainId` flagged now (unexpired)? Checks the chain's own key and the
    /// every-EVM-chain key of an externally owned account. severity: 1 info, 2 suspicious, 3 high, 4 critical
    /// (an active exploit or drainer). evidenceHash: sha256 of the evidence bundle (IPFS CIDv1 raw, see the docs).
    function isFlagged(uint256 chainId, address subject) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    /// Is code with this EXTCODEHASH flagged (every copy, every chain)?
    function isCodeFlagged(bytes32 codeHash) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
    /// False while the feed is paused or has never been written (consumers decide: fail open or closed).
    function live() external view returns (bool);
}

/// @title ImmuneCheck: a bounded, non-reverting read of an immune feed
library ImmuneCheck {
    /// Gas a single feed read may use (a broken or hostile feed cannot eat the caller's gas).
    uint256 internal constant READ_GAS = 60_000;

    /// The worst flag on `who` here: its address on this chain (and every EVM chain) and its code.
    /// ok = false when the feed could not be read (reverted, no code, out of gas, malformed answer).
    function worst(IImmuneFeed feed, address who) internal view returns (bool ok, bool flagged, uint8 severity, bytes32 evidenceHash) {
        (bool ok1, bool f1, uint8 s1, bytes32 e1) = _read(address(feed), abi.encodeCall(IImmuneFeed.isFlagged, (block.chainid, who)));
        ok = ok1;
        if (f1) { flagged = true; severity = s1; evidenceHash = e1; }
        bytes32 h = who.codehash;
        if (h != bytes32(0) && h != keccak256("")) {
            (bool ok2, bool f2, uint8 s2, bytes32 e2) = _read(address(feed), abi.encodeCall(IImmuneFeed.isCodeFlagged, (h)));
            ok = ok && ok2;
            if (f2 && s2 > severity) { flagged = true; severity = s2; evidenceHash = e2; }
        }
    }

    function live(IImmuneFeed feed) internal view returns (bool) {
        if (address(feed).code.length == 0) return false;
        (bool ok, bytes memory r) = address(feed).staticcall{gas: READ_GAS}(abi.encodeCall(IImmuneFeed.live, ()));
        return ok && r.length >= 32 && abi.decode(r, (bool));
    }

    function _read(address feed, bytes memory data) private view returns (bool ok, bool flagged, uint8 severity, bytes32 evidenceHash) {
        if (feed.code.length == 0) return (false, false, 0, 0);
        (bool s, bytes memory r) = feed.staticcall{gas: READ_GAS}(data);
        if (!s || r.length != 128) return (false, false, 0, 0);
        (uint256 f, uint256 sev, , bytes32 e) = abi.decode(r, (uint256, uint256, uint256, bytes32));
        if (f > 1 || sev > 255) return (false, false, 0, 0);
        return (true, f == 1, uint8(sev), e);
    }
}

/// @title ImmuneGuard: `notFlagged(to)` for routers, withdrawals and bridges on any EVM chain
/// @notice Inherit, pass the feed on this chain (ImmuneMirror, or ImmuneRegistry on ZETAPHY), the lowest severity
///         that refuses (3 = high is the suggested default: 1-2 are warnings for wallets), and whether a feed that
///         cannot be read refuses too (failClosed). Fail-open is the default: a paused or broken mirror must not
///         freeze a protocol; a protocol holding much value may choose fail-closed for its exits.
abstract contract ImmuneGuard {
    IImmuneFeed public immutable immuneFeed;
    uint8 public immutable immuneMinSeverity;
    bool public immutable immuneFailClosed;

    error ImmuneFlagged(address who, uint8 severity, bytes32 evidenceHash);
    error ImmuneFeedDown();

    constructor(IImmuneFeed feed, uint8 minSeverity, bool failClosed) {
        require(minSeverity >= 1 && minSeverity <= 4, "severity");
        immuneFeed = feed;
        immuneMinSeverity = minSeverity;
        immuneFailClosed = failClosed;
    }

    modifier notFlagged(address who) {
        _immuneCheck(who);
        _;
    }

    function _immuneCheck(address who) internal view {
        if (address(immuneFeed) == address(0)) return;
        (bool ok, bool flagged, uint8 severity, bytes32 evidenceHash) = ImmuneCheck.worst(immuneFeed, who);
        if (flagged && severity >= immuneMinSeverity) revert ImmuneFlagged(who, severity, evidenceHash);
        if (immuneFailClosed && (!ok || !ImmuneCheck.live(immuneFeed))) revert ImmuneFeedDown();
    }
}

/// @title ImmuneGuardedRouter: the reference integration (a payout router / withdrawal exit)
/// @notice Pays out native coin it holds to `to`, refusing destinations the immune feed flags at or above the
///         router's severity. A real router, vault or bridge adds the same modifier to its own exits.
contract ImmuneGuardedRouter is ImmuneGuard {
    address public immutable owner;
    event Sent(address indexed to, uint256 amount);

    constructor(IImmuneFeed feed, uint8 minSeverity, bool failClosed) ImmuneGuard(feed, minSeverity, failClosed) {
        owner = msg.sender;
    }

    receive() external payable {}

    function send(address payable to, uint256 amount) external notFlagged(to) {
        require(msg.sender == owner, "owner");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
        emit Sent(to, amount);
    }
}
