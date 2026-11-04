// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The parts of InvariantFirewall a protected protocol calls.
interface IInvariantFirewall {
    function register(address protocolGovernance) external;
    function enforce(address protocol) external view;
    function recordOutflow(address asset, uint256 amount) external;
}

/// @title Firewalled: what a protocol adds to opt in to InvariantFirewall (docs/future/invariant-firewall.md)
/// @notice Two things:
///           - `firewalled` on every function that changes state: when the OUTERMOST firewalled call
///             of the transaction into this contract returns, every registered invariant is checked on
///             the state it left, and the whole transaction reverts (InvariantViolated) if one does not
///             hold. Nested (re-entrant) firewalled calls are checked once, by the outermost one: an
///             invariant is a property of the state between calls, not of the middle of one.
///           - `_firewallOutflow(asset, amount)` before every payment out: the certificate rule (an
///             uncertified protocol that holds a lot pays out a capped share per day; it reverts above it).
///         `_firewallRegister(governance)` opts the contract in (call it once, e.g. from the constructor).
///         The firewall address is fixed at deployment; address(0) turns everything off.
///         Limit: only calls that enter this contract through a firewalled function are checked here. A
///         token that an approved spender pulls straight from the token contract never runs this code;
///         the chain layer (InvariantFirewall.chainCheck after every transaction) covers that case.
abstract contract Firewalled {
    IInvariantFirewall public immutable invariantFirewall;

    /// Transient (EIP-1153) slot with the depth of firewalled calls in this transaction:
    /// uint256(keccak256("zetaphy.invariant-firewall.depth")) - 1.
    uint256 private constant DEPTH_SLOT = 0x99382f4a8ebe781599140d985a5f5eb48e9ad02dbad2ac553b8122fcd28d5148;

    constructor(IInvariantFirewall firewall) {
        invariantFirewall = firewall;
    }

    modifier firewalled() {
        uint256 depth;
        assembly {
            depth := tload(DEPTH_SLOT)
            tstore(DEPTH_SLOT, add(depth, 1))
        }
        _;
        assembly {
            tstore(DEPTH_SLOT, depth)
        }
        if (depth == 0 && address(invariantFirewall) != address(0)) invariantFirewall.enforce(address(this));
    }

    function _firewallRegister(address protocolGovernance) internal {
        if (address(invariantFirewall) != address(0)) invariantFirewall.register(protocolGovernance);
    }

    /// Before paying `amount` of `asset` (address(0): the native coin) out of this contract.
    function _firewallOutflow(address asset, uint256 amount) internal {
        if (address(invariantFirewall) != address(0) && amount != 0) invariantFirewall.recordOutflow(asset, amount);
    }
}
