// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The parts of the NeuroOracle mirror (NeuroOracle.sol) AuditVerified reads: ZETAPHY's audit certificates as
/// pushed over Hyperlane (message kind 3). isCertified re-checks EXTCODEHASH on THIS chain at every call.
interface IAVOracle {
    function isCertified(uint64 chainId, address target) external view returns (bool);
    function certs(bytes32 key) external view returns (uint64 chainId, address target, bytes32 codeHash, bytes32 reportHash, uint8 level,
        uint64 issuedAt, uint64 expiresAt, bool revoked, uint256 requestId);
}

/// What a proxy says it forwards to (beacon proxies' beacons and many UUPS/custom proxies expose it).
interface IAVImplementation {
    function implementation() external view returns (address);
}

/// @title AuditVerified: require a valid ZETAPHY audit certificate, on any EVM chain with a NeuroOracle mirror
/// @notice For routers, vaults, launchpads and lending markets that only want to list or call audited code:
///
///             using AuditVerified for IAVOracle;
///             IAVOracle immutable oracle;           // the NeuroOracle on this chain
///             function list(address pool) external {
///                 oracle.requireCertified(pool);    // reverts unless certified, unexpired, unrevoked, same code
///                 ...
///             }
///
///         "Valid" is exactly NeuroOracle.isCertified(block.chainid, target): a certificate ZETAPHY's
///         AuditCertificate issued for this chain and address, not expired, not revoked (also: the same code
///         revoked elsewhere), the mirror not paused, and the target's EXTCODEHASH on THIS chain still the
///         certified code hash (a redeploy or self-destruct fails at once). A mirror that cannot be read fails closed.
///
///         Proxies: the proxy's own code does not change when its implementation is swapped, so a proxy is
///         ordered as two certificates (proxy + implementation; zetaphy-network/src/aas/intake.js) and checked
///         with requireCertifiedProxy, which also requires the proxy's current implementation to be the
///         certified one. Contracts cannot read another contract's EIP-1967 slot, so this needs a proxy that
///         answers implementation() (or pass its beacon); for a transparent proxy that hides it, pin the
///         implementation you reviewed and re-check off-chain (the hub's certificate page reads the slot).
///
///         A certificate states that the code went through ZETAPHY's audit process; it is NOT a guarantee
///         that the code is safe (docs/future/audit-as-a-service.md).
library AuditVerified {
    error NotCertified(address target);
    error LevelTooLow(address target, uint8 level, uint8 minLevel);
    error ImplementationUnknown(address proxy);
    error ImplementationChanged(address proxy, address expected, address actual);

    /// Whether `target` (on this chain) holds a valid certificate now. False if the oracle reverts or is not a contract.
    function isVerified(IAVOracle oracle, address target) internal view returns (bool) {
        if (address(oracle).code.length == 0) return false;
        try oracle.isCertified(uint64(block.chainid), target) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// The level of a valid certificate (1 bronze, 2 silver, 3 gold), 0 when there is none valid now.
    function levelOf(IAVOracle oracle, address target) internal view returns (uint8) {
        if (!isVerified(oracle, target)) return 0;
        try oracle.certs(keccak256(abi.encode(uint64(block.chainid), target))) returns (uint64, address, bytes32, bytes32, uint8 level, uint64, uint64, bool, uint256) {
            return level;
        } catch {
            return 0;
        }
    }

    function requireCertified(IAVOracle oracle, address target) internal view {
        if (!isVerified(oracle, target)) revert NotCertified(target);
    }

    /// Certified at `minLevel` or above (1 bronze, 2 silver, 3 gold).
    function requireLevel(IAVOracle oracle, address target, uint8 minLevel) internal view {
        uint8 l = levelOf(oracle, target);
        if (l == 0) revert NotCertified(target);
        if (l < minLevel) revert LevelTooLow(target, l, minLevel);
    }

    /// The proxy and the implementation are both certified, and the proxy (or its beacon: pass the beacon as
    /// `reader`, else the proxy itself) reports that implementation right now.
    function requireCertifiedProxy(IAVOracle oracle, address proxy, address reader, address implementation) internal view {
        requireCertified(oracle, proxy);
        requireCertified(oracle, implementation);
        address r = reader == address(0) ? proxy : reader;
        if (r.code.length == 0) revert ImplementationUnknown(proxy); // a failed decode of empty return data is not caught
        address actual;
        try IAVImplementation(r).implementation() returns (address a) {
            actual = a;
        } catch {
            revert ImplementationUnknown(proxy);
        }
        if (actual != implementation) revert ImplementationChanged(proxy, implementation, actual);
    }
}
