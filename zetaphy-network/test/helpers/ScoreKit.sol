// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY (test/securityscore.test.js): stand-ins with the SAME read interface as NeuroScore.scoreOf,
// CircuitBreaker (policyGovernance / isTripped / lastTrip / tripOf) and an IImmuneFeed (ImmuneRegistry / ImmuneMirror);
// the test checks those ABIs against the real artifacts. Plus a source that always reverts (a broken source).

contract KitNeuro {
    struct S { bool known; int256 score; uint8 level; }
    mapping(address => S) private _s;
    function set(address t, bool known, uint8 level) external { _s[t] = S(known, int256(uint256(level)) * 1e7, level); }
    function scoreOf(address t) external view returns (bool known, int256 score, uint8 level) { S memory s = _s[t]; return (s.known, s.score, s.level); }
}

contract KitBreaker {
    enum Kind { Runners, Invariant }
    enum Claim { None, Open, ProvenFalse, Rejected, Expired }
    struct Trip {
        address protocol;
        Kind kind;
        Claim claim;
        uint16 mask;
        uint64 start;
        uint64 until;
        uint64 fromBlock;
        uint64 toBlock;
        uint64 claimedAt;
        bytes32 evidenceHash;
        bytes32 detectorId;
        uint256 claimBond;
        address[] runners;
    }
    mapping(address => address) public policyGovernance;
    mapping(address => uint256) public lastTrip;
    Trip[] private _trips;

    function register(address p, address gov) external { policyGovernance[p] = gov; }

    function trip(address p, uint64 duration) external {
        Trip storage t = _trips.push();
        t.protocol = p;
        t.start = uint64(block.timestamp);
        t.until = uint64(block.timestamp) + duration;
        t.runners.push(msg.sender);
        lastTrip[p] = _trips.length;
    }

    function provenFalse(address p) external { _trips[lastTrip[p] - 1].claim = Claim.ProvenFalse; }

    function isTripped(address p) external view returns (bool) {
        uint256 id = lastTrip[p];
        return id != 0 && block.timestamp < _trips[id - 1].until;
    }

    function tripOf(uint256 id) external view returns (Trip memory) { return _trips[id]; }
}

contract KitFeed {
    mapping(address => uint8) public sev;
    mapping(bytes32 => uint8) public codeSev;
    function set(address a, uint8 s) external { sev[a] = s; }
    function setCode(bytes32 h, uint8 s) external { codeSev[h] = s; }
    function isFlagged(uint256, address a) external view returns (bool, uint8, uint64, bytes32) { return (sev[a] != 0, sev[a], 1, bytes32(uint256(1))); }
    function isCodeFlagged(bytes32 h) external view returns (bool, uint8, uint64, bytes32) { return (codeSev[h] != 0, codeSev[h], 1, bytes32(uint256(1))); }
    function live() external pure returns (bool) { return true; }
}

/// A broken source: every call reverts.
contract KitBroken {
    fallback() external { revert("broken"); }
}
