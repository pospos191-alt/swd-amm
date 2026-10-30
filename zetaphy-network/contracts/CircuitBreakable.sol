// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The parts of CircuitBreaker a protected protocol calls.
interface ICircuitBreaker {
    function isPaused(address protocol, bytes4 selector) external view returns (bool);
    function isTripped(address protocol) external view returns (bool);
    function recordOutflow(address asset, uint256 amount) external returns (bool payNow);
    function policyGovernance(address protocol) external view returns (address);
    function holdReviewOf(address protocol) external view returns (uint32);
}

/// @title CircuitBreakable: what a protocol adds to opt in to CircuitBreaker (docs/future/self-healing.md)
/// @notice Three things:
///           - `whenNotTripped(this.fn.selector)` on the functions the policy lists: they revert
///             with SelectorTripped while a live trip pauses that selector. Nothing else stops.
///           - `_outflow(asset, to, amount)` before every payment out of the protocol: it reports
///             the outflow to the breaker and returns whether to pay now. When it returns false
///             the payment is HELD here (`held`), the protocol keeps the funds, and the call goes
///             on (it must not revert, or the trip it may have caused would be undone).
///           - `_payOut(asset, to, amount)`: how the protocol pays (native or token), used to pay a
///             held outflow later.
///         A held outflow is paid by anyone with releaseHeld once the protocol is not tripped and
///         the policy's holdReview has passed since it was held (the payment is then accounted
///         like any other and may be held again if over the cap); the protocol's governance (its
///         policy's governance) may cancelHeld it instead: the funds stay in the protocol.
///         The breaker address is fixed at deployment; address(0) turns everything off.
abstract contract CircuitBreakable {
    ICircuitBreaker public immutable circuitBreaker;

    struct HeldOutflow {
        address asset;
        address to;
        uint256 amount;
        uint64 heldAt;
        uint8 state; // 0 held, 1 paid, 2 cancelled
    }

    HeldOutflow[] public held;

    event OutflowHeld(uint256 indexed id, address indexed asset, address indexed to, uint256 amount);
    event HeldPaid(uint256 indexed id);
    event HeldCancelled(uint256 indexed id);

    error SelectorTripped(bytes4 selector);
    error HeldNotReady();
    error NotPolicyGovernance();

    constructor(ICircuitBreaker breaker) {
        circuitBreaker = breaker;
    }

    modifier whenNotTripped(bytes4 selector) {
        if (address(circuitBreaker) != address(0) && circuitBreaker.isPaused(address(this), selector)) revert SelectorTripped(selector);
        _;
    }

    /// True: pay now. False: held (see `held`); the caller must not pay and must not revert.
    function _outflow(address asset, address to, uint256 amount) internal returns (bool) {
        if (address(circuitBreaker) == address(0) || amount == 0) return true;
        if (circuitBreaker.recordOutflow(asset, amount)) return true;
        held.push(HeldOutflow(asset, to, amount, uint64(block.timestamp), 0));
        emit OutflowHeld(held.length - 1, asset, to, amount);
        return false;
    }

    function _payOut(address asset, address to, uint256 amount) internal virtual;

    function heldCount() external view returns (uint256) {
        return held.length;
    }

    function releaseHeld(uint256 id) external {
        HeldOutflow storage h = held[id];
        if (h.state != 0 || circuitBreaker.isTripped(address(this))
            || block.timestamp < uint256(h.heldAt) + circuitBreaker.holdReviewOf(address(this))) revert HeldNotReady();
        if (!circuitBreaker.recordOutflow(h.asset, h.amount)) revert HeldNotReady();
        h.state = 1;
        emit HeldPaid(id);
        _payOut(h.asset, h.to, h.amount);
    }

    function cancelHeld(uint256 id) external {
        if (msg.sender != circuitBreaker.policyGovernance(address(this))) revert NotPolicyGovernance();
        HeldOutflow storage h = held[id];
        if (h.state != 0) revert HeldNotReady();
        h.state = 2;
        emit HeldCancelled(id);
    }
}
