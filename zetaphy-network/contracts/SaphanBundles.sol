// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan bundles: calls across several routes that all run, or are all refunded
/// @notice Saphan PR 5 (docs/SAPHAN-PR5.md), testnet only, not audited.
///
///         A bundle gathers money from several chains on ZETAPHY, then runs every step in ONE ZETAPHY transaction:
///           1. create(legs, plan, deadline): each leg is money the bundle waits for, from a source chain through its
///              ZetaphyGateway (depositAndCall with target = this contract, data = abi.encode(id, leg)), or on ZETAPHY
///              itself (fund). The plan is fixed now (its hash is stored): calls on ZETAPHY (tokens to a target, then
///              target.onSaphanBundle) and calls to other chains (ZetaphyGateway.withdrawAndCall). It must spend
///              exactly what the legs bring, token by token.
///           2. Each leg's delivery is proven by the route itself: a Gateway call is attested by the route's lanes
///              (its deposit address is the call's hash), and the tokens must really be here (balance check), so a
///              fake "gateway" cannot fund a leg.
///           3. execute(id, plan): anyone, once every leg is in and before the deadline. Every step runs or none does
///              (a failing step reverts the whole transaction; the bundle stays funded and can be run again).
///              Calls to other chains carry the Gateway's call hash (event OutSent): track or refund them there.
///           4. Past the deadline without execute: refund(id); each funded leg is owed back to its refundTo on
///              ZETAPHY (claim, a pull). A leg that arrives too late is refused, so the Gateway refunds it on its chain.
///         No signer, no admin: the escrow follows the bundle's own rules.

interface IBundleToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function approve(address spender, uint256 v) external returns (bool);
}

interface IBundleGateway {
    function token() external view returns (address);
    function withdrawAndCall(address target, bytes calldata data, uint256 amount, uint256 maxFee, uint64 gasLimit, address revertTo)
        external payable returns (bytes32);
}

/// What a contract on ZETAPHY implements to be a step of a bundle (it must check msg.sender is SaphanBundles).
interface ISaphanBundleTarget {
    function onSaphanBundle(bytes32 id, address creator, address token, uint256 amount, bytes calldata data) external;
}

contract SaphanBundles {
    struct Leg {
        uint256 srcChainId;   // where the money comes from (block.chainid for a leg funded here)
        address gateway;      // ZetaphyGateway of that route; zero: funded here with fund()
        address token;        // what arrives on ZETAPHY (token(X) for a route)
        address sender;       // who must send it (on its chain; zero: anyone)
        uint256 amount;       // what the leg brings (more is owed back to refundTo)
        address refundTo;     // on ZETAPHY: who gets the leg back when the bundle does not run
    }

    /// A step on ZETAPHY: `amount` of `token` to `target`, then target.onSaphanBundle(id, creator, token, amount, data).
    struct Action {
        address target;
        address token;
        uint256 amount;
        uint64 gasLimit;
        bytes data;
    }

    /// A step to another chain: ZetaphyGateway.withdrawAndCall with data = abi.encode(id, creator, data).
    struct Out {
        address gateway;
        address token;        // must be the Gateway's token
        address target;
        uint256 amount;
        uint256 maxFee;
        uint64 gasLimit;
        address revertTo;     // on that chain: who gets the money when the call fails there
        bytes data;
    }

    struct Plan {
        Action[] actions;
        Out[] outs;
    }

    enum Status { None, Open, Funded, Executed, Refunded }

    struct Bundle {
        address creator;
        uint64 deadline;
        Status status;
        uint8 legCount;
        uint8 fundedCount;
        bytes32 planHash;
    }

    bytes32 public constant TAG = keccak256("saphan/bundle/v1");
    uint256 public constant MAX_LEGS = 8;
    uint256 public constant MAX_STEPS = 8;
    uint64 public constant MAX_DURATION = 30 days;

    mapping(bytes32 => Bundle) public bundles;
    mapping(bytes32 => mapping(uint256 => Leg)) public legs;
    mapping(bytes32 => mapping(uint256 => bool)) public legFunded;
    /// Tokens this contract holds for bundles and refunds (what arrives beyond it is a new leg's money).
    mapping(address => uint256) public accounted;
    /// token -> who -> refunds and excess, taken with claim(token).
    mapping(address => mapping(address => uint256)) public owed;
    uint256 public nonce;
    uint256 private entered;

    event Created(bytes32 indexed id, address indexed creator, uint64 deadline, Leg[] legs, Plan plan);
    event LegFunded(bytes32 indexed id, uint256 indexed leg, uint256 srcChainId, address sender, uint256 received);
    event Executed(bytes32 indexed id, address indexed executor);
    event OutSent(bytes32 indexed id, uint256 indexed step, bytes32 callHash);
    event Refunded(bytes32 indexed id);
    event Claimed(address indexed who, address indexed token, uint256 amount);

    error BadBundle(uint256 code);
    error NotOpen();
    error TooLate();
    error TooEarly();
    error WrongLeg();
    error Short(uint256 have, uint256 need);
    error WrongPlan();
    error Fee();
    error PayFailed();
    error Reentered();

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    function planHash(Plan calldata plan) public pure returns (bytes32) { return keccak256(abi.encode(TAG, plan)); }

    /// Opens a bundle. Every token the legs bring is spent exactly by the plan.
    function create(Leg[] calldata legs_, Plan calldata plan, uint64 deadline) external returns (bytes32 id) {
        if (legs_.length == 0 || legs_.length > MAX_LEGS) revert BadBundle(0);
        uint256 steps = plan.actions.length + plan.outs.length;
        if (steps == 0 || steps > MAX_STEPS) revert BadBundle(1);
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) revert BadBundle(2);
        for (uint256 i = 0; i < legs_.length; i++) {
            Leg calldata l = legs_[i];
            if (l.amount == 0 || l.token == address(0) || l.refundTo == address(0)) revert BadBundle(10 + i);
            if (l.gateway == address(0) && l.srcChainId != block.chainid) revert BadBundle(10 + i);
            _spentEqualsBrought(legs_, plan, l.token);
        }
        for (uint256 i = 0; i < plan.actions.length; i++) {
            Action calldata a = plan.actions[i];
            if (a.target == address(0) || a.target == address(this) || a.amount == 0) revert BadBundle(20 + i);
            _spentEqualsBrought(legs_, plan, a.token);
        }
        for (uint256 i = 0; i < plan.outs.length; i++) {
            Out calldata o = plan.outs[i];
            if (o.gateway == address(0) || o.target == address(0) || o.revertTo == address(0) || o.amount == 0 || o.maxFee > o.amount) revert BadBundle(30 + i);
            _spentEqualsBrought(legs_, plan, o.token);
        }
        id = keccak256(abi.encode(TAG, block.chainid, address(this), msg.sender, nonce++));
        bundles[id] = Bundle(msg.sender, deadline, Status.Open, uint8(legs_.length), 0, planHash(plan));
        for (uint256 i = 0; i < legs_.length; i++) legs[id][i] = legs_[i];
        emit Created(id, msg.sender, deadline, legs_, plan);
    }

    function _spentEqualsBrought(Leg[] calldata legs_, Plan calldata plan, address token) private pure {
        uint256 brought = 0;
        uint256 spent = 0;
        for (uint256 i = 0; i < legs_.length; i++) if (legs_[i].token == token) brought += legs_[i].amount;
        for (uint256 i = 0; i < plan.actions.length; i++) if (plan.actions[i].token == token) spent += plan.actions[i].amount;
        for (uint256 i = 0; i < plan.outs.length; i++) if (plan.outs[i].token == token) spent += plan.outs[i].amount;
        if (brought != spent) revert BadBundle(40);
    }

    /// A leg from another chain: called by that route's ZetaphyGateway, after it handed this contract the tokens.
    /// data = abi.encode(bundle id, leg index). Reverting (late, already funded, wrong leg) makes the Gateway refund it.
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256, bytes calldata data) external nonReentrant {
        (bytes32 id, uint256 i) = abi.decode(data, (bytes32, uint256));
        Leg storage l = _openLeg(id, i);
        if (l.gateway == address(0) || msg.sender != l.gateway || l.srcChainId != srcChainId || token != l.token
            || (l.sender != address(0) && l.sender != sender)) revert WrongLeg();
        // the tokens must be here: what this contract holds beyond what it owes is this leg's
        uint256 received = IBundleToken(token).balanceOf(address(this)) - accounted[token];
        _funded(id, i, l, received, srcChainId, sender);
    }

    /// A leg funded on ZETAPHY: its sender (or anyone, when the leg names none) pays it (approve this contract first).
    function fund(bytes32 id, uint256 i) external nonReentrant {
        Leg storage l = _openLeg(id, i);
        if (l.gateway != address(0) || (l.sender != address(0) && l.sender != msg.sender)) revert WrongLeg();
        IBundleToken t = IBundleToken(l.token);
        uint256 need = accounted[l.token] + l.amount;
        _funded(id, i, l, l.amount, block.chainid, msg.sender);
        if (!t.transferFrom(msg.sender, address(this), l.amount)) revert PayFailed();
        uint256 have = t.balanceOf(address(this));
        if (have < need) revert Short(have, need); // a token that delivers less than it says
    }

    function _openLeg(bytes32 id, uint256 i) private view returns (Leg storage) {
        Bundle storage b = bundles[id];
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp > b.deadline) revert TooLate();
        if (i >= b.legCount || legFunded[id][i]) revert WrongLeg();
        return legs[id][i];
    }

    function _funded(bytes32 id, uint256 i, Leg storage l, uint256 received, uint256 srcChainId, address sender) private {
        if (received < l.amount) revert Short(received, l.amount);
        legFunded[id][i] = true;
        accounted[l.token] += received;
        if (received > l.amount) owed[l.token][l.refundTo] += received - l.amount;
        Bundle storage b = bundles[id];
        b.fundedCount += 1;
        if (b.fundedCount == b.legCount) b.status = Status.Funded;
        emit LegFunded(id, i, srcChainId, sender, received);
    }

    /// Anyone, once every leg is in and before the deadline: runs the whole plan, all or nothing.
    /// msg.value: the Mailbox fees of the calls to other chains (fees[i] for outs[i], ZetaphyGateway.quoteWithdraw);
    /// what the Gateways give back comes back to the caller.
    function execute(bytes32 id, Plan calldata plan, uint256[] calldata fees) external payable nonReentrant {
        Bundle storage b = bundles[id];
        if (b.status != Status.Funded) revert NotOpen();
        if (block.timestamp > b.deadline) revert TooLate();
        if (planHash(plan) != b.planHash || fees.length != plan.outs.length) revert WrongPlan();
        uint256 total = 0;
        for (uint256 i = 0; i < fees.length; i++) total += fees[i];
        uint256 paid = msg.value;
        if (paid != total) revert Fee();
        // effects first: the bundle is spent
        b.status = Status.Executed;
        _spend(id, b.legCount);
        address creator = b.creator;
        uint256 before = address(this).balance - paid;
        _actions(id, creator, plan.actions);
        for (uint256 i = 0; i < plan.outs.length; i++) {
            Out calldata o = plan.outs[i];
            if (IBundleGateway(o.gateway).token() != o.token) revert WrongPlan();
            if (!IBundleToken(o.token).approve(o.gateway, o.amount)) revert PayFailed();
            // fees[i], written as its share of what the caller paid (paid == total): only the caller's own ether
            // ever goes to a Gateway; this contract holds none of its own
            bytes32 h = IBundleGateway(o.gateway).withdrawAndCall{value: paid * fees[i] / (total == 0 ? 1 : total)}(o.target,
                abi.encode(id, creator, o.data), o.amount, o.maxFee, o.gasLimit, o.revertTo);
            emit OutSent(id, i, h);
        }
        emit Executed(id, msg.sender);
        uint256 change = address(this).balance - before;
        if (change > 0) {
            (bool ok, ) = msg.sender.call{value: change}("");
            if (!ok) revert PayFailed();
        }
    }

    /// The legs' tokens leave the escrow (the plan spends exactly them).
    function _spend(bytes32 id, uint256 legCount) private {
        for (uint256 i = 0; i < legCount; i++) {
            Leg storage l = legs[id][i];
            accounted[l.token] -= l.amount;
        }
    }

    /// The steps on ZETAPHY: tokens to each target, then its call (a revert undoes the whole execute).
    function _actions(bytes32 id, address creator, Action[] calldata actions) private {
        for (uint256 i = 0; i < actions.length; i++) {
            Action calldata a = actions[i];
            if (!IBundleToken(a.token).transfer(a.target, a.amount)) revert PayFailed();
            ISaphanBundleTarget(a.target).onSaphanBundle{gas: a.gasLimit}(id, creator, a.token, a.amount, a.data);
        }
    }

    /// Anyone, after the deadline of a bundle that did not run: each funded leg is owed back to its refundTo.
    function refund(bytes32 id) external {
        Bundle storage b = bundles[id];
        if (b.status != Status.Open && b.status != Status.Funded) revert NotOpen();
        if (block.timestamp <= b.deadline) revert TooEarly();
        b.status = Status.Refunded;
        for (uint256 i = 0; i < b.legCount; i++) {
            if (!legFunded[id][i]) continue;
            Leg storage l = legs[id][i];
            owed[l.token][l.refundTo] += l.amount;
        }
        emit Refunded(id);
    }

    /// The caller's refunds and excess in `token`.
    function claim(address token) external nonReentrant {
        uint256 v = owed[token][msg.sender];
        if (v == 0) revert WrongLeg();
        owed[token][msg.sender] = 0;
        accounted[token] -= v;
        emit Claimed(msg.sender, token, v);
        if (!IBundleToken(token).transfer(msg.sender, v)) revert PayFailed();
    }

    /// The Gateways give back what the Mailbox did not take.
    receive() external payable {}
}
