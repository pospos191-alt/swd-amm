// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A deterministic policy checker: given an action an agent recorded, the
/// agent's constitution (the document whose keccak256 the agent registered)
/// and optional evidence, says whether the action broke the policy, who was
/// harmed and how much. It must be a pure function of its inputs.
interface IPolicyChecker {
    struct ActionView {
        uint256 agentId;
        address target;
        uint256 value;
        bytes32 dataHash;
        bytes32 modelHash;
        bytes32 promptHash;
        uint64 time;
    }

    function check(ActionView calldata action, bytes calldata constitution, bytes calldata evidence)
        external view returns (bool violated, address victim, uint256 damage);
}

/// @title AgentRegistry: AI agents with an identity, a bond and liability (testnet)
/// @notice An agent is registered by its operator (who answers for it) with:
///           - the EVM account it transacts from (for human/agent labels),
///           - an ML-DSA-44 public key (only its keccak256 is stored; the key
///             rides in calldata, as in QuantumWallet) that signs every action
///             it records, checked by ZETAPHY's precompile at 0x…0900,
///           - a bond in testnet ZETAPHY (at least minBond),
///           - a constitution: the keccak256 of its policy document, and an
///             optional deterministic checker contract for that policy.
///         Each recorded action carries provenance: the hash of the model
///         (weights or model id + version) and of the prompt that produced it.
///
///         Claims, when an action broke the policy:
///           - checker path: anyone shows the constitution document; the
///             agent's checker decides deterministically, and the damage (at
///             most the bond) is paid to the victim the checker names, at once;
///           - committee path: a claimant posts claimDeposit and an evidence
///             hash; governance's claims committee votes; threshold "yes"
///             pays the claimed amount (at most the bond) to the claimant and
///             returns the deposit; threshold "no", or no decision within
///             VOTE_PERIOD, rejects it and the deposit goes to the operator.
///         The operator can take the bond back only UNBOND_DELAY after asking,
///         with no open claim, and only once the CLAIM_WINDOW of its last
///         action is over (AR-1): claims on an action are open for CLAIM_WINDOW
///         and the bond must still be there for all of it.
contract AgentRegistry {
    address public constant MLDSA = 0x0000000000000000000000000000000000000900;
    uint8 public constant PQ_VARIANT = 44;
    uint256 public constant UNBOND_DELAY = 7 days;
    uint256 public constant CLAIM_WINDOW = 30 days;
    uint256 public constant VOTE_PERIOD = 7 days;
    uint256 public constant MAX_COMMITTEE = 32;

    struct Agent {
        address operator;
        address account;
        bytes32 pqKeyHash;
        bytes32 constitution;
        address checker;
        uint256 bond;
        uint64 unbondAt;   // 0 = not unbonding
        uint64 actions;    // per-agent sequence, in every action digest (no replay)
        uint32 openClaims;
    }

    /// agent id -> time of its last recorded action (the bond stays until its claim window is over)
    mapping(uint256 => uint64) public lastActionAt;

    struct Action {
        uint256 agentId;
        address target;
        uint256 value;
        bytes32 dataHash;
        bytes32 modelHash;
        bytes32 promptHash;
        bytes32 constitution; // the agent's constitution when it acted
        address checker;      // and its checker
        uint64 time;
        bool slashed;         // a checker claim was paid (one payout per action)
    }

    enum ClaimState { None, Open, Upheld, Rejected }

    struct Claim {
        uint256 actionId;
        address claimant;
        uint256 amount;
        uint256 deposit;
        bytes32 evidenceHash;
        uint64 opened;
        uint16 yes;
        uint16 no;
        ClaimState state;
    }

    address public governance;
    uint256 public minBond;
    uint256 public claimDeposit;

    uint256 public agentCount;
    mapping(uint256 => Agent) public agents;
    mapping(address => uint256) public agentOfAccount; // account -> agent id (0 = none)

    uint256 public actionCount;
    mapping(uint256 => Action) public actions;

    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => mapping(address => bool)) public voted;

    mapping(address => bool) public isCommittee;
    address[] private committee;
    uint256 public committeeThreshold;

    event AgentRegistered(uint256 indexed id, address indexed operator, address indexed account, bytes32 pqKeyHash, bytes32 constitution, address checker, uint256 bond);
    event AgentUpdated(uint256 indexed id, bytes32 pqKeyHash, bytes32 constitution, address checker);
    event BondAdded(uint256 indexed id, uint256 amount, uint256 bond);
    event UnbondRequested(uint256 indexed id, uint64 at);
    event BondWithdrawn(uint256 indexed id, uint256 amount);
    event ActionRecorded(uint256 indexed agentId, uint256 indexed actionId, ActionInput action);
    event Slashed(uint256 indexed agentId, uint256 indexed actionId, address indexed to, uint256 amount);
    event ClaimFiled(uint256 indexed claimId, uint256 indexed actionId, address indexed claimant, uint256 amount, bytes32 evidenceHash);
    event ClaimVoted(uint256 indexed claimId, address indexed member, bool uphold);
    event ClaimClosed(uint256 indexed claimId, ClaimState state, uint256 paid);
    event CommitteeSet(address[] members, uint256 threshold);
    event ParamsSet(uint256 minBond, uint256 claimDeposit);
    event GovernanceChanged(address governance);

    error NotGovernance();
    error NotOperator();
    error BondTooLow();
    error BadAccount();
    error AccountTaken();
    error NoAgent();
    error Inactive();
    error WrongKey();
    error BadPq();
    error Unbonding();
    error NotYet();
    error OpenClaims();
    error NoAction();
    error ClaimWindowOver();
    error BadConstitution();
    error NoChecker();
    error NotViolated();
    error AlreadySlashed();
    error BadDeposit();
    error NotCommittee();
    error AlreadyVoted();
    error ClaimNotOpen();
    error BadCommittee();
    error TransferFailed();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_, uint256 minBond_, uint256 claimDeposit_) {
        governance = governance_;
        minBond = minBond_;
        claimDeposit = claimDeposit_;
        emit ParamsSet(minBond_, claimDeposit_);
    }

    // ------------------------------------------------------------- agents

    function register(address account, bytes32 pqKeyHash, bytes32 constitution, address checker) external payable returns (uint256 id) {
        if (msg.value < minBond) revert BondTooLow();
        if (account == address(0) || pqKeyHash == bytes32(0)) revert BadAccount();
        if (agentOfAccount[account] != 0) revert AccountTaken();
        id = ++agentCount;
        agents[id] = Agent({operator: msg.sender, account: account, pqKeyHash: pqKeyHash, constitution: constitution,
            checker: checker, bond: msg.value, unbondAt: 0, actions: 0, openClaims: 0});
        agentOfAccount[account] = id;
        emit AgentRegistered(id, msg.sender, account, pqKeyHash, constitution, checker, msg.value);
    }

    /// New key, constitution or checker. Past actions keep the constitution
    /// and checker they were recorded under.
    function update(uint256 id, bytes32 pqKeyHash, bytes32 constitution, address checker) external {
        Agent storage a = _operated(id);
        if (pqKeyHash == bytes32(0)) revert BadAccount();
        a.pqKeyHash = pqKeyHash;
        a.constitution = constitution;
        a.checker = checker;
        emit AgentUpdated(id, pqKeyHash, constitution, checker);
    }

    function addBond(uint256 id) external payable {
        Agent storage a = agents[id];
        if (a.operator == address(0)) revert NoAgent();
        a.bond += msg.value;
        emit BondAdded(id, msg.value, a.bond);
    }

    /// Stops new actions; the bond can be withdrawn UNBOND_DELAY later.
    function requestUnbond(uint256 id) external {
        Agent storage a = _operated(id);
        if (a.unbondAt != 0) revert Unbonding();
        a.unbondAt = uint64(block.timestamp + UNBOND_DELAY);
        emit UnbondRequested(id, a.unbondAt);
    }

    /// When withdrawBond may run (0 = not unbonding): UNBOND_DELAY after the request, and after the claim
    /// window of the agent's last action.
    function withdrawableAt(uint256 id) public view returns (uint256) {
        Agent storage a = agents[id];
        if (a.unbondAt == 0) return 0;
        uint256 claimsOver = lastActionAt[id] == 0 ? 0 : uint256(lastActionAt[id]) + CLAIM_WINDOW + 1;
        return claimsOver > a.unbondAt ? claimsOver : a.unbondAt;
    }

    function withdrawBond(uint256 id) external {
        Agent storage a = _operated(id);
        if (a.unbondAt == 0 || block.timestamp < withdrawableAt(id)) revert NotYet();
        if (a.openClaims != 0) revert OpenClaims();
        uint256 amount = a.bond;
        a.bond = 0;
        delete agentOfAccount[a.account];
        emit BondWithdrawn(id, amount);
        _pay(a.operator, amount);
    }

    /// Active = bonded at least minBond and not unbonding.
    function isActive(uint256 id) public view returns (bool) {
        Agent storage a = agents[id];
        return a.operator != address(0) && a.unbondAt == 0 && a.bond >= minBond;
    }

    /// For label readers: the active agent an account belongs to (0 = none).
    function activeAgentOf(address account) external view returns (uint256) {
        uint256 id = agentOfAccount[account];
        return id != 0 && isActive(id) ? id : 0;
    }

    // ------------------------------------------------------------- actions

    /// What an agent did (or is about to do), with its provenance.
    struct ActionInput {
        address target;
        uint256 value;
        bytes32 dataHash;   // keccak256 of the calldata (or of an off-chain action's description)
        bytes32 modelHash;  // keccak256 of the model weights, or of "provider/model-id@version"
        bytes32 promptHash; // keccak256 of the full prompt (system + user) that produced the action
    }

    /// The 32 bytes the agent's ML-DSA-44 key signs for its next action.
    function actionDigest(uint256 id, ActionInput calldata x) public view returns (bytes32) {
        return keccak256(abi.encode("ZETAPHY AgentAction", block.chainid, address(this), id, agents[id].actions,
            x.target, x.value, x.dataHash, x.modelHash, x.promptHash));
    }

    /// Records one action with its provenance. Anyone may submit it (a relay);
    /// only the agent's ML-DSA key can have signed it.
    function recordAction(uint256 id, ActionInput calldata x, bytes calldata pqPublicKey, bytes calldata pqSig)
        external returns (uint256 actionId)
    {
        Agent storage a = agents[id];
        if (a.operator == address(0)) revert NoAgent();
        if (!isActive(id)) revert Inactive();
        if (keccak256(pqPublicKey) != a.pqKeyHash) revert WrongKey();
        (bool ok, bytes memory ret) = MLDSA.staticcall(abi.encodePacked(PQ_VARIANT, actionDigest(id, x), pqPublicKey, pqSig));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) != 1) revert BadPq();
        a.actions++;
        actionId = ++actionCount;
        Action storage r = actions[actionId];
        r.agentId = id;
        r.target = x.target;
        r.value = x.value;
        r.dataHash = x.dataHash;
        r.modelHash = x.modelHash;
        r.promptHash = x.promptHash;
        r.constitution = a.constitution;
        r.checker = a.checker;
        r.time = uint64(block.timestamp);
        lastActionAt[id] = uint64(block.timestamp);
        emit ActionRecorded(id, actionId, x);
    }

    // ------------------------------------------------------------- claims: deterministic checker

    /// Shows the constitution an action was recorded under; if the agent's
    /// checker finds a violation, the damage (at most the bond) goes to the
    /// victim the checker names. Anyone may call it; one payout per action.
    function claimByChecker(uint256 actionId, bytes calldata constitution, bytes calldata evidence) external returns (uint256 paid) {
        Action storage act = _claimable(actionId);
        if (act.checker == address(0)) revert NoChecker();
        if (act.slashed) revert AlreadySlashed();
        if (keccak256(constitution) != act.constitution) revert BadConstitution();
        IPolicyChecker.ActionView memory v = IPolicyChecker.ActionView({agentId: act.agentId, target: act.target,
            value: act.value, dataHash: act.dataHash, modelHash: act.modelHash, promptHash: act.promptHash, time: act.time});
        (bool violated, address victim, uint256 damage) = IPolicyChecker(act.checker).check(v, constitution, evidence);
        if (!violated || victim == address(0) || damage == 0) revert NotViolated();
        act.slashed = true;
        paid = _slash(act.agentId, actionId, victim, damage);
    }

    // ------------------------------------------------------------- claims: committee vote

    function fileClaim(uint256 actionId, uint256 amount, bytes32 evidenceHash) external payable returns (uint256 claimId) {
        Action storage act = _claimable(actionId);
        if (msg.value != claimDeposit) revert BadDeposit();
        claimId = ++claimCount;
        claims[claimId] = Claim({actionId: actionId, claimant: msg.sender, amount: amount, deposit: msg.value,
            evidenceHash: evidenceHash, opened: uint64(block.timestamp), yes: 0, no: 0, state: ClaimState.Open});
        agents[act.agentId].openClaims++;
        emit ClaimFiled(claimId, actionId, msg.sender, amount, evidenceHash);
    }

    function vote(uint256 claimId, bool uphold) external {
        if (!isCommittee[msg.sender]) revert NotCommittee();
        Claim storage c = claims[claimId];
        if (c.state != ClaimState.Open || block.timestamp > c.opened + VOTE_PERIOD) revert ClaimNotOpen();
        if (voted[claimId][msg.sender]) revert AlreadyVoted();
        voted[claimId][msg.sender] = true;
        if (uphold) c.yes++; else c.no++;
        emit ClaimVoted(claimId, msg.sender, uphold);
        if (c.yes >= committeeThreshold) _close(claimId, true);
        else if (c.no >= committeeThreshold) _close(claimId, false);
    }

    /// After VOTE_PERIOD without a decision, anyone may close the claim as rejected.
    function expireClaim(uint256 claimId) external {
        Claim storage c = claims[claimId];
        if (c.state != ClaimState.Open) revert ClaimNotOpen();
        if (block.timestamp <= c.opened + VOTE_PERIOD) revert NotYet();
        _close(claimId, false);
    }

    // ------------------------------------------------------------- governance

    function setCommittee(address[] calldata members, uint256 threshold) external onlyGovernance {
        if (members.length > MAX_COMMITTEE || threshold == 0 || threshold > members.length) revert BadCommittee();
        for (uint256 i = 0; i < committee.length; i++) isCommittee[committee[i]] = false;
        delete committee;
        for (uint256 i = 0; i < members.length; i++) {
            if (members[i] == address(0) || isCommittee[members[i]]) revert BadCommittee();
            isCommittee[members[i]] = true;
            committee.push(members[i]);
        }
        committeeThreshold = threshold;
        emit CommitteeSet(members, threshold);
    }

    function committeeMembers() external view returns (address[] memory) {
        return committee;
    }

    function setParams(uint256 minBond_, uint256 claimDeposit_) external onlyGovernance {
        minBond = minBond_;
        claimDeposit = claimDeposit_;
        emit ParamsSet(minBond_, claimDeposit_);
    }

    function setGovernance(address g) external onlyGovernance {
        governance = g;
        emit GovernanceChanged(g);
    }

    // ------------------------------------------------------------- internals

    function _operated(uint256 id) private view returns (Agent storage a) {
        a = agents[id];
        if (a.operator == address(0)) revert NoAgent();
        if (a.operator != msg.sender) revert NotOperator();
    }

    function _claimable(uint256 actionId) private view returns (Action storage act) {
        act = actions[actionId];
        if (act.agentId == 0) revert NoAction();
        if (block.timestamp > act.time + CLAIM_WINDOW) revert ClaimWindowOver();
        if (agents[act.agentId].bond == 0) revert Inactive(); // bond withdrawn or slashed away: nothing to claim
    }

    function _close(uint256 claimId, bool upheld) private {
        Claim storage c = claims[claimId];
        uint256 agentId = actions[c.actionId].agentId;
        Agent storage a = agents[agentId];
        a.openClaims--;
        uint256 paid;
        if (upheld) {
            c.state = ClaimState.Upheld;
            paid = _slash(agentId, c.actionId, c.claimant, c.amount);
            _pay(c.claimant, c.deposit);
        } else {
            c.state = ClaimState.Rejected;
            _pay(a.operator, c.deposit);
        }
        emit ClaimClosed(claimId, c.state, paid);
    }

    function _slash(uint256 agentId, uint256 actionId, address to, uint256 amount) private returns (uint256 paid) {
        Agent storage a = agents[agentId];
        paid = amount < a.bond ? amount : a.bond;
        a.bond -= paid;
        emit Slashed(agentId, actionId, to, paid);
        _pay(to, paid);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

/// @title ConstitutionChecker: a deterministic checker for simple agent policies
/// @notice The constitution document is
///           abi.encode(address principal, uint256 maxValuePerAction,
///                      address[] allowedTargets, bytes32[] allowedModels)
///         and an action violates it when its value is above the cap, its
///         target is not allowed (an empty list allows none), or its model is
///         not allowed (an empty list allows any). The victim is the
///         principal; the damage is the action's value (the part above the
///         cap, for a cap violation).
contract ConstitutionChecker is IPolicyChecker {
    function check(ActionView calldata action, bytes calldata constitution, bytes calldata)
        external pure returns (bool violated, address victim, uint256 damage)
    {
        (address principal, uint256 maxValue, address[] memory targets, bytes32[] memory models) =
            abi.decode(constitution, (address, uint256, address[], bytes32[]));
        if (!_allowed(action.target, action.modelHash, targets, models)) return (true, principal, action.value);
        if (action.value > maxValue) return (true, principal, action.value - maxValue);
        return (false, address(0), 0);
    }

    function _allowed(address target, bytes32 model, address[] memory targets, bytes32[] memory models) private pure returns (bool) {
        bool targetOk;
        for (uint256 i = 0; i < targets.length; i++) if (targets[i] == target) targetOk = true;
        bool modelOk = models.length == 0;
        for (uint256 i = 0; i < models.length; i++) if (models[i] == model) modelOk = true;
        return targetOk && modelOk;
    }
}
