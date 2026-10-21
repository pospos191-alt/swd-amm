// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

/// @title ZetaphyTimelock: the one delay in front of every ZETAPHY admin role
/// @notice OpenZeppelin Contracts 5.4.0 TimelockController, unchanged, plus
///         AccessControlEnumerable (also OpenZeppelin 5.4.0) so anyone can list
///         who holds each role on-chain (the launch tool checks that no EOA does).
///         Nothing else is added: scheduling, delays, cancelling and executing
///         are OpenZeppelin's audited code (vendor/openzeppelin-contracts.json
///         pins the files by sha256).
///
///         How ZETAPHY uses it (zetaphy-launch, docs/LAUNCH.md):
///           - it is governance / owner / admin of BridgeGuard, BridgeAirlock,
///             ThreatRegistry (so ThreatReports too), NeuroControl, RewardVault,
///             StableGateway, NeuroIdentity, ZetaphyOracle, the DEX factory (so
///             the router's sweep too), the NFT marketplace and any HyperlaneLane;
///           - proposers and cancellers: the governance multisig(s) or the
///             chain's gov module; executor: anyone (address(0)), so a call
///             that waited its delay in public cannot be held hostage by the
///             proposers, and cancelling stays possible until it runs;
///           - admin: the timelock itself (no admin key), so new proposers or a
///             new delay also wait the delay (MinDelayChange, RoleGranted).
///         Emergency actions that only reduce risk (pause, lowering a cap,
///         holds, vetoes, removing a lane or a marker, pausing a price feed)
///         stay with guardians on each contract and never wait.
contract ZetaphyTimelock is TimelockController, AccessControlEnumerable {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}

    function supportsInterface(bytes4 interfaceId)
        public view override(TimelockController, AccessControlEnumerable) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _grantRole(bytes32 role, address account) internal override(AccessControl, AccessControlEnumerable) returns (bool) {
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account) internal override(AccessControl, AccessControlEnumerable) returns (bool) {
        return super._revokeRole(role, account);
    }
}
