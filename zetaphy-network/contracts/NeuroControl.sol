// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title NeuroControl: the governance knobs of Neuro (testnet)
/// @notice One place where the vote steers Neuro, separate from the coin:
///           - paused(): the Neuro stop button. NeuroJobs takes no new
///             requests or commits and runners stop taking jobs. It never
///             touches coin transfers, staking, bridges or withdrawals.
///             A guardian may pull it at once; only governance releases it.
///           - skills: a skill id (sha256 of Neuro's code, `zetaphy neuro
///             skill-id`) must be approved by a vote before jobs use it;
///             new jobs record activeSkill().
///           - the defender roster: runners governance allows to sit in the
///             4 defender seats of NeuroJobs (filled by its regrow()).
///           - release(runner): lets a quarantined runner work again.
///           - maxBodies: the cap on elastic bodies; maxRegrowPerHour: the
///             cap on refilling defender seats after an attack.
///           - communityFund: receives 5% of every job fee. The burned 5%
///             goes to BURN, an address nobody has a key for: it is locked
///             forever (still counted in the bank supply, never spendable).
///           - chains: the chain keys ("bsc", "eth", ...) NeuroJobs takes
///             requests for. A request for any other chain reverts, so fake
///             requests for chains no runner reads cannot inflate the bodies.
///             `zetaphy deploy` seeds it with the chains the runner supports.
///         Governance is the chain's gov module (its EVM address, called
///         through a MsgEVMCall proposal: zetaphy-chain/gov.sh neuro ...) or
///         a SimpleMultisig.
///
///         Small read interface used by other contracts:
///           paused() returns (bool)
///           activeSkill() returns (bytes32)
///           defenderApproved(address) returns (bool)
///           releasedAt(address) returns (uint64)
///           maxBodies() / maxRegrowPerHour() returns (uint256)
///           communityFund() returns (address)
///           chainAllowed(bytes32) returns (bool)
contract NeuroControl {
    /// Locked forever: no key exists for it.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// Bodies never go below the four defender seats.
    uint256 public constant MIN_BODIES = 4;
    uint256 public constant MAX_BODIES = 1000;
    uint256 public constant MAX_ROSTER = 32;
    uint256 public constant MAX_CHAINS_PER_CALL = 64;

    address public governance;
    mapping(address => bool) public guardian;
    bool public paused;

    mapping(bytes32 => bool) public skillApproved;
    bytes32 public activeSkill;

    mapping(address => bool) public defenderApproved;
    address[] private _roster;

    /// When governance last released a runner from quarantine; a quarantine
    /// that started after this still holds.
    mapping(address => uint64) public releasedAt;

    uint256 public maxBodies;
    uint256 public maxRegrowPerHour;
    address public communityFund;

    /// Chain keys (bytes32 of e.g. "bsc") NeuroJobs accepts requests for.
    mapping(bytes32 => bool) public chainAllowed;

    event GovernanceChanged(address governance);
    event GuardianSet(address indexed who, bool allowed);
    event Paused(address indexed by);
    event Unpaused();
    event SkillApproved(bytes32 indexed id);
    event SkillRevoked(bytes32 indexed id);
    event ActiveSkill(bytes32 indexed id);
    event DefenderApproved(address indexed runner);
    event DefenderRemoved(address indexed runner);
    event Released(address indexed runner);
    event MaxBodies(uint256 value);
    event MaxRegrowPerHour(uint256 value);
    event CommunityFund(address fund);
    event ChainApproved(bytes32 indexed chain);
    event ChainRemoved(bytes32 indexed chain);

    error NotGovernance();
    error NotGuardian();
    error BadValue();
    error NotApproved();
    error SkillInUse();

    constructor(address governance_, address communityFund_, uint256 maxBodies_, uint256 maxRegrowPerHour_) {
        if (governance_ == address(0) || communityFund_ == address(0)) revert BadValue();
        if (maxBodies_ < MIN_BODIES || maxBodies_ > MAX_BODIES || maxRegrowPerHour_ == 0) revert BadValue();
        governance = governance_;
        communityFund = communityFund_;
        maxBodies = maxBodies_;
        maxRegrowPerHour = maxRegrowPerHour_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ---- stop button ----

    /// A guardian (or governance) stops Neuro at once.
    function pause() external {
        if (!guardian[msg.sender] && msg.sender != governance) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    /// Only a vote starts it again.
    function unpause() external onlyGovernance {
        paused = false;
        emit Unpaused();
    }

    function setGuardian(address who, bool allowed) external onlyGovernance {
        guardian[who] = allowed;
        emit GuardianSet(who, allowed);
    }

    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadValue();
        governance = next;
        emit GovernanceChanged(next);
    }

    // ---- skills ----

    function approveSkill(bytes32 id) external onlyGovernance {
        if (id == bytes32(0)) revert BadValue();
        skillApproved[id] = true;
        emit SkillApproved(id);
    }

    /// The active skill cannot be revoked: switch first (or pause).
    function revokeSkill(bytes32 id) external onlyGovernance {
        if (id == activeSkill) revert SkillInUse();
        skillApproved[id] = false;
        emit SkillRevoked(id);
    }

    function setActiveSkill(bytes32 id) external onlyGovernance {
        if (!skillApproved[id]) revert NotApproved();
        activeSkill = id;
        emit ActiveSkill(id);
    }

    // ---- defenders and quarantine ----

    function approveDefender(address runner) external onlyGovernance {
        if (runner == address(0) || defenderApproved[runner] || _roster.length == MAX_ROSTER) revert BadValue();
        defenderApproved[runner] = true;
        _roster.push(runner);
        emit DefenderApproved(runner);
    }

    /// Its seat (if any) is vacated by the next NeuroJobs.regrow().
    function removeDefender(address runner) external onlyGovernance {
        if (!defenderApproved[runner]) revert NotApproved();
        defenderApproved[runner] = false;
        for (uint256 i = 0; i < _roster.length; i++) {
            if (_roster[i] == runner) {
                _roster[i] = _roster[_roster.length - 1];
                _roster.pop();
                break;
            }
        }
        emit DefenderRemoved(runner);
    }

    function roster() external view returns (address[] memory) {
        return _roster;
    }

    function release(address runner) external onlyGovernance {
        releasedAt[runner] = uint64(block.timestamp);
        emit Released(runner);
    }

    // ---- sizes and money ----

    function setMaxBodies(uint256 n) external onlyGovernance {
        if (n < MIN_BODIES || n > MAX_BODIES) revert BadValue();
        maxBodies = n;
        emit MaxBodies(n);
    }

    function setMaxRegrowPerHour(uint256 n) external onlyGovernance {
        if (n == 0 || n > MAX_ROSTER) revert BadValue();
        maxRegrowPerHour = n;
        emit MaxRegrowPerHour(n);
    }

    function setCommunityFund(address fund) external onlyGovernance {
        if (fund == address(0)) revert BadValue();
        communityFund = fund;
        emit CommunityFund(fund);
    }

    // ---- chains NeuroJobs takes requests for ----

    function approveChain(bytes32 chain) public onlyGovernance {
        if (chain == bytes32(0)) revert BadValue();
        chainAllowed[chain] = true;
        emit ChainApproved(chain);
    }

    /// Several at once (used at deploy to seed the runner's chain list).
    function approveChains(bytes32[] calldata chains) external onlyGovernance {
        if (chains.length == 0 || chains.length > MAX_CHAINS_PER_CALL) revert BadValue();
        for (uint256 i = 0; i < chains.length; i++) approveChain(chains[i]);
    }

    /// Jobs already requested for it keep running; new requests are refused.
    function removeChain(bytes32 chain) external onlyGovernance {
        if (!chainAllowed[chain]) revert NotApproved();
        chainAllowed[chain] = false;
        emit ChainRemoved(chain);
    }
}
