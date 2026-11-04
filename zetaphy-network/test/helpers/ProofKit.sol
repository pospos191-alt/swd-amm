// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: the stand-ins test/proofs.test.js uses around ProofRegistry. BuggyVault.sol is
// audit/spec/fixtures/BuggyVault.sol (the spec tool's deliberately broken demo), compiled with this file.
import {BuggyVault} from "./BuggyVault.sol";

/// AuditCertificate.certificate, set by the test.
contract MockCertificate {
    struct Cert {
        uint256 requestId;
        uint64 chainId;
        address target;
        bytes32 codeHash;
        bytes32 reportHash;
        bytes32 sourceHash;
        uint8 level;
        uint16 auditors;
        uint16 mutationBps;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revokedAt;
        uint256 revokedBy;
    }

    mapping(bytes32 => Cert) internal _c;
    mapping(bytes32 => bool) internal _valid;

    function set(uint64 chainId, address target, bytes32 codeHash, uint8 level, bool valid) external {
        bytes32 k = keccak256(abi.encode(chainId, target));
        _c[k] = Cert(1, chainId, target, codeHash, bytes32(0), bytes32(0), level, 8, 9000, 1, type(uint64).max, 0, 0);
        _valid[k] = valid;
    }

    function certificate(uint64 chainId, address target) external view returns (Cert memory, bool) {
        bytes32 k = keccak256(abi.encode(chainId, target));
        return (_c[k], _valid[k]);
    }
}

/// The on-chain replay of BuggyVault's spec property "backing-totalDeposits" (the vault always holds
/// at least totalDeposits in ETH). It deploys a fresh BuggyVault, replays the counterexample with
/// itself as the depositor, checks the property after every call, and reverts everything it did
/// (Result(violated)), so it keeps no state and spends no ETH. Counterexample encoding:
/// abi.encode(uint8[] ops, uint256[] args): 0 deposit(args[i] wei), 1 withdraw(args[i]), 2 emergencyWithdraw().
contract BuggyVaultChecker {
    bytes32 public immutable codeHash;     // BuggyVault's runtime code, as deployed by this checker
    bytes32 public immutable specHash;
    uint32 public immutable property;      // the index of backing-totalDeposits among the approved properties

    error Result(bool violated);

    constructor(bytes32 specHash_, uint32 property_) payable {
        codeHash = address(new BuggyVault(address(this))).codehash;
        specHash = specHash_;
        property = property_;
    }

    receive() external payable {}

    function replay(bytes32 codeHash_, bytes32 specHash_, uint32 property_, bytes calldata cex) external returns (bool) {
        if (codeHash_ != codeHash || specHash_ != specHash || property_ != property) return false;
        try this.run(cex) {
            return false;
        } catch (bytes memory r) {
            return keccak256(r) == keccak256(abi.encodeWithSelector(Result.selector, true));
        }
    }

    function run(bytes calldata cex) external {
        require(msg.sender == address(this), "self");
        BuggyVault v = new BuggyVault(address(this));
        require(address(v).codehash == codeHash, "code");
        (uint8[] memory ops, uint256[] memory args) = abi.decode(cex, (uint8[], uint256[]));
        require(ops.length == args.length && ops.length <= 16, "shape");
        bool violated;
        for (uint256 i = 0; i < ops.length && !violated; i++) {
            if (ops[i] == 0) { try v.deposit{value: args[i]}() {} catch {} }
            else if (ops[i] == 1) { try v.withdraw(args[i]) {} catch {} }
            else if (ops[i] == 2) { try v.emergencyWithdraw() {} catch {} }
            violated = address(v).balance < v.totalDeposits();
        }
        revert Result(violated);
    }
}

interface IProofMarket {
    function claimByCounterexample(uint256 bountyId, uint32 property, bytes calldata counterexample, bytes32 salt) external;
    function reclaimBounty(uint256 bountyId) external;
    function withdraw() external;
}

/// A checker that confirms everything and tries to re-enter the market during the replay.
contract ReentrantChecker {
    IProofMarket public market;
    uint256 public bountyId;
    bool public reentered;

    function arm(IProofMarket m, uint256 id) external { market = m; bountyId = id; }

    function replay(bytes32, bytes32, uint32 p, bytes calldata cex) external returns (bool) {
        try market.claimByCounterexample(bountyId, p, cex, bytes32(0)) { reentered = true; } catch {}
        try market.reclaimBounty(bountyId) { reentered = true; } catch {}
        return true;
    }
}

/// A checker that never confirms (a poster who will not pay out on counterexamples).
contract LyingChecker {
    function replay(bytes32, bytes32, uint32, bytes calldata) external pure returns (bool) { return false; }
}
